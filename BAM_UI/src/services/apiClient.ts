/**
 * Centralized API client.
 *
 * Features:
 * - Environment-based base URL (Vite: VITE_API_URL)
 * - Type-safe methods for core endpoints (bookings, sessions, images, microscope)
 * - JWT access token injection + automatic refresh on 401
 * - Request/response interceptors (pre/post hooks)
 * - Loading state tracking (subscribe via onLoading / useApiLoading hook)
 * - Friendly error messages (ProblemDetails aware, JSON fallback)
 */

import { useEffect, useState } from "react";
import type { Booking } from "@/types/booking";

// ---------- Config ----------

export const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  `${window.location.origin}`; // goes to default


const REFRESH_ENDPOINT = "/api/auth/refresh";



// ---------- Store Tokens (localStorage) ----------

export const ACCESS_TOKEN_KEY = "auth_access";
export const REFRESH_TOKEN_KEY = "auth_refresh";

function getAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}
function getRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}
export function setTokens(access?: string | null, refresh?: string | null) {
  if (access !== undefined) {
    if (access) localStorage.setItem(ACCESS_TOKEN_KEY, access);
    else localStorage.removeItem(ACCESS_TOKEN_KEY);
  }
  if (refresh !== undefined) {
    if (refresh) localStorage.setItem(REFRESH_TOKEN_KEY, refresh);
    else localStorage.removeItem(REFRESH_TOKEN_KEY);
  }
}
export function clearTokens() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

type BookingDto = {
  id: string;
  microscope_id: string;
  date: string;
  slot_start: number;
  slot_end: number;
  title: string;
  group_name: string | null;
  attendees: number | null;
  requester_id: string;
  requester_name: string;
  status: string;
  approved_by: string | null;
  created_at: string;
};

function toBooking(dto: BookingDto): Booking {
  return {
    id: dto.id,
    bioscopeId: dto.microscope_id,
    date: dto.date,
    slotStart: dto.slot_start,
    slotEnd: dto.slot_end,
    title: dto.title,
    groupName: dto.group_name ?? undefined,
    attendees: dto.attendees ?? undefined,
    requesterId: dto.requester_id,
    requesterName: dto.requester_name,
    status: dto.status.toLowerCase() as Booking["status"],
    createdAt: dto.created_at,
  };
}

// ---------- Loading State ----------

type LoadingListener = (activeCount: number) => void;
const listeners = new Set<LoadingListener>();
let activeRequests = 0;

function notify() {
  for (const fn of listeners) fn(activeRequests);
}
function beginRequest() {
  activeRequests += 1;
  notify();
}
function endRequest() {
  activeRequests = Math.max(0, activeRequests - 1);
  notify();
}

/** Subscribe to loading counter changes. Returns unsubscribe. */
export function onLoading(listener: LoadingListener) {
  listeners.add(listener);
  // initial notify for immediate state
  listener(activeRequests);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook for easy loading state consumption */
export function useApiLoading() {
  const [count, setCount] = useState(activeRequests);
  useEffect(() => onLoading(setCount), []);
  return count > 0;
}

// ---------- Error Handling ----------

export class ApiError extends Error {
  status?: number;
  code?: string;
  details?: unknown;
  constructor(message: string, opts?: { status?: number; code?: string; details?: unknown }) {
    super(message);
    this.name = "ApiError";
    this.status = opts?.status;
    this.code = opts?.code;
    this.details = opts?.details;
  }
}

/** Turn response body into a message. */
async function parseErrorMessage(res: Response): Promise<{ message: string; code?: string; details?: any }> {
  const ct = res.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const data = await res.json();
      // ProblemDetails (RFC 7807) fields or generic JSON
      const title = data.title ?? data.error ?? "Request failed";
      const detail = data.detail ?? data.message ?? "";
      const message = [title, detail].filter(Boolean).join(": ");
      return { message: message || `HTTP ${res.status}`, code: data.code, details: data };
    }
    const text = await res.text();
    return { message: text || `HTTP ${res.status}` };
  } catch {
    return { message: `HTTP ${res.status}` };
  }
}

// ---------- Fetch Wrapper (with interceptors, auth, retry, refresh) ----------

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type RequestInitExt = RequestInit & { retry?: number; retryDelayMs?: number };

type PreInterceptor = (input: RequestInfo, init: RequestInit) => Promise<{ input: RequestInfo; init: RequestInit }> | { input: RequestInfo; init: RequestInit };
type PostInterceptor = (response: Response, cloned: Response) => Promise<void> | void;

const preInterceptors: PreInterceptor[] = [];
const postInterceptors: PostInterceptor[] = [];

export function addRequestInterceptor(fn: PreInterceptor) {
  preInterceptors.push(fn);
}
export function addResponseInterceptor(fn: PostInterceptor) {
  postInterceptors.push(fn);
}

/** Core request function used by all endpoint helpers. */
async function request<T>(path: string, method: HttpMethod, body?: any, init?: RequestInitExt): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  let headers: HeadersInit = {
    Accept: "application/json",
  };

  if (body !== undefined && !(body instanceof FormData)) {
    headers = { ...headers, "Content-Type": "application/json" };
  }

  const auth = getAccessToken();
  if (auth) headers = { ...headers, Authorization: `Bearer ${auth}` };

  let reqInit: RequestInitExt = {
    method,
    headers,
    credentials: "omit",
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  };

  // Run pre-interceptors
  for (const pre of preInterceptors) {
    const res = await pre(url, reqInit);
    url; // no change to url in this design
    reqInit = res.init as RequestInitExt;
  }

  const maxRetry = init?.retry ?? 2;
  const baseDelay = init?.retryDelayMs ?? 300;

  let attempt = 0;
  let lastErr: unknown;

  beginRequest();
  try {
    while (attempt <= maxRetry) {
      try {
        const res = await fetch(url, reqInit);

        // Clone for post-interceptors so body can still be read outside
        const clone = res.clone();
        for (const post of postInterceptors) {
          await post(res, clone);
        }

        // 401 -> try refresh once then retry original
        if (res.status === 401 && attempt <= maxRetry) {
          const refreshed = await tryRefreshToken();
          if (refreshed) {
            // inject new token and retry immediately
            const newAccess = getAccessToken();
            if (newAccess) {
              (reqInit.headers as Record<string, string>) = {
                ...(reqInit.headers as Record<string, string>),
                Authorization: `Bearer ${newAccess}`,
              };
            }
            attempt++;
            continue;
          }
          // refresh failed -> clear and throw
          clearTokens();
          const { message } = await parseErrorMessage(res);
          throw new ApiError(message || "Unauthorised", { status: 401 });
        }

        // Success path
        if (res.ok) {
          // No content
          if (res.status === 204) return undefined as T;
          const ct = res.headers.get("content-type") ?? "";
          
          if (ct.includes("application/json")) {
            const parsed = await res.json();

            // Auto-unwrap ApiResponse<T> shape from backend
            if (parsed && typeof parsed === "object" && "success" in parsed) {
              if (parsed.success) {
                return (parsed.data ?? undefined) as T;
              }
              throw new ApiError(parsed.error || "Request failed", {
                status: res.status,
                details: parsed,
              });
            }

            return parsed as T;
          }
          
          // Non-JSON (e.g. images/blob). 
          // @ts-expect-error (caller should know the expected type)
          return await res.blob();
        }

        // 5xx -> retry with backoff
        if (res.status >= 500 && res.status <= 599 && attempt < maxRetry) {
          await delay(expBackoff(attempt, baseDelay));
          attempt++;
          continue;
        }

        // Other errors (4xx etc.)
        const { message, code, details } = await parseErrorMessage(res);
        throw new ApiError(message || `HTTP ${res.status}`, { status: res.status, code, details });
      } catch (err: any) {
        lastErr = err;
        // Network / CORS / aborted -> retry
        const transient =
          err instanceof TypeError ||
          (err?.name === "AbortError") ||
          (err?.message && /network|fetch|failed|offline/i.test(String(err.message)));

        if (transient && attempt < maxRetry) {
          await delay(expBackoff(attempt, baseDelay));
          attempt++;
          continue;
        }
        throw err;
      }
    }
    // If we exit the loop, throw the last error
    throw lastErr instanceof Error ? lastErr : new Error("Unknown request error");
  } finally {
    endRequest();
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function expBackoff(attempt: number, base: number) {
  // attempt: 0,1,2 -> 1x,2x,4x jitters
  const factor = 2 ** attempt;
  const jitter = Math.random() * 0.25 + 0.875; // 0.875..1.125
  return Math.round(base * factor * jitter);
}

// ---------- JWT Refresh ----------

/**
 * Try to refresh the access token using the refresh token.
 */
async function tryRefreshToken(): Promise<boolean> {
  const rt = getRefreshToken();
  if (!rt) return false;

  try {
    const res = await fetch(`${API_BASE}${REFRESH_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ refreshToken: rt }),
    });

    if (!res.ok) return false;

    const parsed = await res.json().catch(() => ({}));
    const payload = parsed?.data ?? parsed; // unwrap if present
    const access  = payload.accessToken ?? payload.token ?? payload.access_token;
    const refresh = payload.refreshToken ?? payload.refresh_token;

    if (access) {
      setTokens(access, refresh ?? undefined);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------- Public API: typed endpoint helpers ----------

// Bookings
export const BookingsAPI = {
  async list(): Promise<Booking[]> {
    const result = await request<BookingDto[]>("/api/bookings", "GET");
    return (result ?? []).map(toBooking);
  },
  async get(id: string): Promise<Booking> {
    const dto = await request<BookingDto>(`/api/bookings/${encodeURIComponent(id)}`, "GET");
    return toBooking(dto);
  },
  async create(payload: unknown): Promise<Booking> {
    const dto = await request<BookingDto>("/api/bookings", "POST", payload);
    return toBooking(dto);
  },
  async update(id: string, payload: Partial<Booking>): Promise<Booking> {
    const body: Record<string, unknown> = {};
    if (payload.title !== undefined) body.title = payload.title;
    if (payload.groupName !== undefined) body.group_name = payload.groupName;
    if (payload.attendees !== undefined) body.attendees = payload.attendees;
    if (payload.status) {
      const statusMap: Record<Booking["status"], string> = {
        pending: "Pending",
        approved: "Approved",
        rejected: "Rejected",
      };
      body.status = statusMap[payload.status];
    }
    const dto = await request<BookingDto>(`/api/bookings/${encodeURIComponent(id)}`, "PUT", body);
    return toBooking(dto);
  },
  remove(id: string): Promise<void> {
    return request<void>(`/api/bookings/${encodeURIComponent(id)}`, "DELETE");
  },
};

// Sessions (active usage tracking)
export const SessionsAPI = {
  list(): Promise<any[]> {
    return request<any[]>("/api/sessions", "GET");
  },
  get(id: string): Promise<any> {
    return request<any>(`/api/sessions/${encodeURIComponent(id)}`, "GET");
  },
};

// Define a type that matches backend Image model
type ImageMeta = {
  id: string;
  // alternative names the backend might return
  image_id?: string;
  imageId?: string;
  // Add any other fields your backend exposes in the Image model:
  filename?: string;
  file_path?: string;
  content_type?: string;
  // owner and timestamps
  owner_id?: string;
  created_at?: string;
};

// ---------- Images ----------
export const ImagesAPI = {
  getImage(id: string): Promise<ImageMeta> {
    return request<ImageMeta>(`/api/images/${encodeURIComponent(id)}`, "GET");
  },
  getLatestForSession(sessionId: string): Promise<ImageMeta> {
    return request<ImageMeta>(
      `/api/sessions/${encodeURIComponent(sessionId)}/images/latest`,
      "GET"
    );
  },
  /**
   * Fetch raw image file for an image id and return a Blob.
   * Note: this performs an authenticated request so callers can create an object URL for <img>.
   */
  async getFile(id: string): Promise<Blob> {
    // request wrapper will return a Blob for non-JSON responses
    return await request<Blob>(`/api/images/${encodeURIComponent(id)}/file`, "GET");
  },
};

// ---------- Microscope ----------
export const MicroscopeAPI = {
  command(
    microscopeId: string,
    command: string,
    params?: Record<string, unknown>
  ): Promise<any> {
    return request<any>(
      `/api/microscope/${encodeURIComponent(microscopeId)}/command`,
      "POST",
      { command, params }
    );
  },
  /**
   * Capture an image for the given microscope. The backend requires a session_id
   * so callers should supply it in the payload. The payload shape mirrors the
   * backend `CaptureRequest` (session_id required, other fields optional).
   */
  capture(
    microscopeId: string,
    payload: { session_id: string; auto_focus?: boolean; quality?: string; format?: string }
  ): Promise<ImageMeta> {
    return request<ImageMeta>(
      `/api/microscope/${encodeURIComponent(microscopeId)}/capture`,
      "POST",
      payload
    );
  },
  status(microscopeId: string): Promise<any> {
    return request<any>(
      `/api/microscope/${encodeURIComponent(microscopeId)}/status`,
      "GET"
    );
  },
};
