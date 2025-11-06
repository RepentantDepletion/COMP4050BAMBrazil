import { useCallback, useEffect, useMemo, useRef, useState } from "react"; 
import { Filter } from "lucide-react";
import { Card, CardContent } from "@components/ui/card";
import { Label } from "@components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@components/ui/select";
import { Switch } from "@components/ui/switch";
import type { Booking, Bioscope, Slot, Role, BookingFilters, BookingDraft } from "@types";

import Header from "@components/layout/Header";
import BookingCalendar from "@components/booking/BookingCalendar";
import BookingForm from "@components/booking/BookingForm";
import BookingList from "@components/booking/BookingList";
import BookingSchedule from "@components/booking/BookingSchedule";
import ApprovalQueue from "@components/teacher/ApprovalQueue";
import DayAtAGlance from "@components/teacher/DayAtAGlance";
import AnalyticsDashboard from "@components/dashboard/AnalyticsDashboard";
import StudentView from "@components/microscope/StudentView";
import { ApiError, BookingsAPI } from "@/services/apiClient";
import { useAuthContext } from "@context/auth-context";
import LogoutButton from "./LoginOut/LogoutButton";

import { useCalendarNav } from "@/calendar/useCalendarNav";
import { CalendarNav } from "@/calendar/calendarNav";
import type { ViewMode } from "@/calendar/state";
import { getCalendarConflicts } from "@/tools/getCalendarConflicts";

/* ------------------------ Local Date Helpers ------------------------ */
function toLocalYMD(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function ymdToLocalDate(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}
function startOfDayLocal(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function fmtDate(d: Date, opts?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    ...opts,
  }).format(d);
}
function fmtRangeInclusive(start: Date, end: Date) {
  const s = startOfDayLocal(start);
  const e = startOfDayLocal(end);
  if (s.getTime() === e.getTime()) return fmtDate(s);
  const sameYear = s.getFullYear() === e.getFullYear();
  const sameMonth = sameYear && s.getMonth() === e.getMonth();
  if (sameYear && sameMonth) {
    const month = new Intl.DateTimeFormat(undefined, { month: "short" }).format(s);
    const sd = new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(s);
    const ed = new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(e);
    const yr = s.getFullYear();
    return `${month} ${sd}–${ed}, ${yr}`;
  }
  const left = fmtDate(s);
  const right = fmtDate(e);
  return `${left} – ${right}`;
}

/** Helpers for range batching */
function ymd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysBetween(start: Date, end: Date) {
  const out: string[] = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const stop = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur <= stop) {
    out.push(ymd(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}
/* -------------------------------------------------------------------- */

const BIOSCOPES: Bioscope[] = [
  { id: "bio-1", name: "Bioscope A" },
  { id: "bio-2", name: "Bioscope B" },
  { id: "bio-3", name: "Bioscope C" },
];

const SCHOOL_HOURS = { start: 8, end: 17 };
const SLOT_MINUTES = 30;

function* range(start: number, end: number, step: number) {
  for (let v = start; v < end; v += step) yield v;
}

function fmtTime(minutesFromMidnight: number) {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function makeDaySlots() {
  const start = SCHOOL_HOURS.start * 60;
  const end = SCHOOL_HOURS.end * 60;
  return Array.from(range(start, end, SLOT_MINUTES));
}

const DAY_SLOTS: number[] = makeDaySlots();

const RANGE_CACHE = new Map<string, Booking[]>();

/* ---------- Cross-tab invalidation ---------- */
const INVALIDATION_KEY = "bookings:invalidate";

function broadcastInvalidation(payload: {
  bioscopeId: string;
  startYMD: string;
  endYMD: string;
}) {
  try {
    localStorage.setItem(INVALIDATION_KEY, JSON.stringify({ ...payload, t: Date.now() }));
    localStorage.removeItem(INVALIDATION_KEY); // trigger storage event
  } catch {
    /* ignore */
  }
}

function invalidateRange(bioscopeId: string, start: Date, end: Date) {
  const dates = daysBetween(start, end);
  const cacheKey = `${bioscopeId}|${dates.join(",")}`;
  RANGE_CACHE.delete(cacheKey);
}

function dedupeById(list: Booking[]): Booking[] {
  const seen = new Set<string>();
  const out: Booking[] = [];
  for (const b of list) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b);
  }
  return out;
}

export default function BioscopeBookingUI() {
  const { user } = useAuthContext();
  const currentUser = user;
  const userRole = (currentUser?.role ?? "student") as Role;
  const [viewRole, setViewRole] = useState<Role>(userRole);

  const [selectedBioscope, setSelectedBioscope] = useState<string>(BIOSCOPES[0].id);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<BookingFilters>({
    showApproved: true,
    showPending: true,
  });

  /* ----------------------- Calendar Navigation ---------------------- */
  const nav = useCalendarNav({
    initialMode: "week",
    weekStartsOn: 1,
    onRangeChange: ({ start, end }) => {
      void loadBookings({
        showBanner: false,
        start: startOfDayLocal(start),
        end: startOfDayLocal(end),
        bioscopeId: selectedBioscope,
      });
    },
  });

  const [jumpYMD, setJumpYMD] = useState<string>(() => toLocalYMD(new Date()));
  useEffect(() => setJumpYMD(toLocalYMD(nav.anchor)), [nav.anchor]);
  const handleJumpYMDChange = useCallback(
    (v: string) => {
      setJumpYMD(v);
      const [y, m, d] = v.split("-").map(Number);
      if (!y || !m || !d) return;
      nav.jumpTo(new Date(y, m - 1, d));
    },
    [nav]
  );
  const handleJumpCommit = useCallback(() => {}, []);

  const viewStart = useMemo(() => startOfDayLocal(nav.visibleStart), [nav.visibleStart]);
  const viewEnd = useMemo(() => startOfDayLocal(nav.visibleEnd), [nav.visibleEnd]);
  const rangeLabel = useMemo(() => fmtRangeInclusive(viewStart, viewEnd), [viewStart, viewEnd]);
  const selectedDate = useMemo(() => toLocalYMD(nav.anchor), [nav.anchor]);

  const slotsForDay = useMemo<Slot[]>(() => DAY_SLOTS.map((s) => ({ start: s, end: s + SLOT_MINUTES })), []);

  const viewBookings = useMemo(() => {
    const startMs = viewStart.getTime();
    const endMs = viewEnd.getTime();
    return bookings.filter((b) => {
      if (b.bioscopeId !== selectedBioscope) return false;
      const dt = ymdToLocalDate(b.date).getTime();
      return dt >= startMs && dt <= endMs;
    });
  }, [bookings, viewStart, viewEnd, selectedBioscope]);

  const dayBookings = useMemo(
    () => bookings.filter((b) => b.date === selectedDate && b.bioscopeId === selectedBioscope),
    [bookings, selectedDate, selectedBioscope]
  );

  const conflictGroups = useMemo(() => {
    const visible = nav.mode === "day" ? dayBookings : viewBookings;
    return getCalendarConflicts(visible);
  }, [nav.mode, dayBookings, viewBookings]);

  // derive bands for calendar visualization
  const approvedBands = useMemo(
    () => dayBookings.filter(b => b.status === "approved").map(b => ({ start: b.slotStart, end: b.slotEnd })),
    [dayBookings]
  );
  const pendingBands = useMemo(
    () => dayBookings.filter(b => b.status === "pending").map(b => ({ start: b.slotStart, end: b.slotEnd })),
    [dayBookings]
  );

  useEffect(() => {
    if (currentUser) setViewRole(currentUser.role as Role);
  }, [currentUser]);

  if (!currentUser) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-600">
        <span className="animate-pulse">Loading…</span>
      </div>
    );
  }

  const ensuredUser = currentUser;
  const myBookings = useMemo(
    () => bookings.filter((b) => b.requesterId === ensuredUser.id),
    [bookings, ensuredUser.id]
  );
  const [draft, setDraft] = useState<BookingDraft>({ title: "", groupName: "", attendees: 1, slot: "" });
  const [isGroup, setIsGroup] = useState(false);

  // guards to prevent stale application of results
  const activeKeyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadBookings = useCallback(
    async (opts?: { showBanner?: boolean; start?: Date; end?: Date; bioscopeId?: string }) => {
      const showBanner = opts?.showBanner ?? true;
      const start = opts?.start ?? viewStart;
      const end = opts?.end ?? viewEnd;
      const bioscopeId = opts?.bioscopeId ?? selectedBioscope;
      const dates = daysBetween(start, end);
      const cacheKey = `${bioscopeId}|${dates.join(",")}`;
      activeKeyRef.current = cacheKey;

      // cancel any in-flight request
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (showBanner) setIsLoading(true);
      setError(null);
      try {
        if (RANGE_CACHE.has(cacheKey)) {
          if (activeKeyRef.current === cacheKey) {
            setBookings(RANGE_CACHE.get(cacheKey)!);
          }
          return;
        }
        const fetched = await BookingsAPI.listRange({ dates, bioscopeId, signal: controller.signal });
        if (controller.signal.aborted) {
          if (abortRef.current === controller) abortRef.current = null;
          return;
        }
        const deduped = dedupeById(fetched);
        RANGE_CACHE.set(cacheKey, deduped);

        if (activeKeyRef.current === cacheKey) {
          setBookings(deduped);
        }
      } catch (err: any) {
        if (err?.name === "AbortError") {
          // clear ref after abort
          if (abortRef.current === controller) abortRef.current = null;
          return;
        }
        const message = err instanceof ApiError ? err.message : "Failed to load bookings.";
        if (activeKeyRef.current === cacheKey) {
          setError(message);
        }
      } finally {
        if (showBanner && activeKeyRef.current === cacheKey) {
          setIsLoading(false);
        }
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [viewStart, viewEnd, selectedBioscope]
  );

  useEffect(() => {
    void loadBookings({ showBanner: true, start: viewStart, end: viewEnd, bioscopeId: selectedBioscope });
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    void loadBookings({ showBanner: false, start: viewStart, end: viewEnd, bioscopeId: selectedBioscope });
  }, [selectedBioscope]);

  /* Clear cache when switching accounts */
  useEffect(() => {
    RANGE_CACHE.clear();
  }, [currentUser?.id]);

  /* Listen for cross-tab invalidations and refetch */
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== INVALIDATION_KEY || !e.newValue) return;
      try {
        const msg = JSON.parse(e.newValue) as { bioscopeId: string; startYMD: string; endYMD: string };
        if (msg.bioscopeId !== selectedBioscope) return;
        RANGE_CACHE.clear();
        void loadBookings({ showBanner: false, start: viewStart, end: viewEnd, bioscopeId: selectedBioscope });
      } catch {
        /* ignore */
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [selectedBioscope, viewStart, viewEnd, loadBookings]);

  async function submitBooking() {
    if (!draft.title || !draft.slot) return;
    setError(null);
    const [startStr, endStr] = draft.slot.split("-");
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);

    const conflict = bookings.some(
      (b) =>
        b.bioscopeId === selectedBioscope &&
        b.date === selectedDate &&
        b.status !== "rejected" &&
        !(end <= b.slotStart || start >= b.slotEnd)
    );
    if (conflict) {
      alert("This time overlaps an existing booking.");
      return;
    }

    const payload = {
      microscope_id: selectedBioscope,
      date: selectedDate,
      slot_start: start,
      slot_end: end,
      title: draft.title.trim(),
      group_name: isGroup ? (draft.groupName.trim() || undefined) : undefined,
      attendees: isGroup ? Math.max(1, Number(draft.attendees) || 1) : undefined,
    } as const;

    try {
      const created = await BookingsAPI.create(payload as any);
      setBookings((prev) => dedupeById([...prev, created]));
      // Invalidate + broadcast for other tabs
      invalidateRange(selectedBioscope, viewStart, viewEnd);
      broadcastInvalidation({ bioscopeId: selectedBioscope, startYMD: toLocalYMD(viewStart), endYMD: toLocalYMD(viewEnd) });
      void loadBookings({ showBanner: false, start: viewStart, end: viewEnd, bioscopeId: selectedBioscope });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to create booking.";
      setError(message);
      return;
    }
    setDraft({ title: "", groupName: "", attendees: 1, slot: "" });
  }

  async function setStatus(id: string, status: Booking["status"]) {
    setError(null);
    try {
      const updated =
        status === "approved"
          ? await BookingsAPI.approve(id)
          : status === "rejected"
          ? await BookingsAPI.reject(id)
          : await BookingsAPI.update(id, {});

      setBookings((prev) => prev.map((b) => (b.id === id ? updated : b)));
      // Invalidate + broadcast so student’s tab updates immediately
      invalidateRange(selectedBioscope, viewStart, viewEnd);
      broadcastInvalidation({ bioscopeId: selectedBioscope, startYMD: toLocalYMD(viewStart), endYMD: toLocalYMD(viewEnd) });
      void loadBookings({ showBanner: false, start: viewStart, end: viewEnd, bioscopeId: selectedBioscope });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to update booking.";
      setError(message);
    }
  }

  async function removeBooking(id: string) {
    setError(null);
    try {
      await BookingsAPI.remove(id);
      setBookings((prev) => prev.filter((b) => b.id !== id));
      // Invalidate + broadcast so other tabs reflect deletion
      invalidateRange(selectedBioscope, viewStart, viewEnd);
      broadcastInvalidation({ bioscopeId: selectedBioscope, startYMD: toLocalYMD(viewStart), endYMD: toLocalYMD(viewEnd) });
      void loadBookings({ showBanner: false, start: viewStart, end: viewEnd, bioscopeId: selectedBioscope });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to delete booking.";
      setError(message);
    }
  }

  const analytics = useMemo(() => {
    const byDay: Record<string, number> = {};
    const byHour: Record<number, number> = {};
    const byUser: Record<string, number> = {};
    const utilizationByBioscope: Record<string, number> = {};
    const minutesPerDay = (SCHOOL_HOURS.end - SCHOOL_HOURS.start) * 60;
    bookings.forEach((b) => {
      byDay[b.date] = (byDay[b.date] || 0) + (b.slotEnd - b.slotStart);
      const hour = Math.floor(b.slotStart / 60);
      byHour[hour] = (byHour[hour] || 0) + 1;
      byUser[b.requesterName] = (byUser[b.requesterName] || 0) + 1;
      utilizationByBioscope[b.bioscopeId] = (utilizationByBioscope[b.bioscopeId] || 0) + (b.slotEnd - b.slotStart);
    });
    const minutesDay = (SCHOOL_HOURS.end - SCHOOL_HOURS.start) * 60;
    const daySeries = Object.entries(byDay)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, mins]) => ({ date, utilization: Math.round((mins / minutesDay) * 100) }));
    const hourSeries = Array.from(range(SCHOOL_HOURS.start, SCHOOL_HOURS.end, 1)).map((h) => ({
      hour: `${h}:00`,
      bookings: byHour[h] || 0,
    }));
    const userSeries = Object.entries(byUser)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));
    const bioscopeSeries = BIOSCOPES.map((b) => ({
      name: b.name,
      utilization: Math.round(((utilizationByBioscope[b.id] || 0) / minutesPerDay) * 100),
    }));
    return { daySeries, hourSeries, userSeries, bioscopeSeries };
  }, [bookings]);

  const filteredDayBookings = useMemo(
    () =>
      dayBookings.filter(
        (b) =>
          (b.status === "approved" && filters.showApproved) ||
          (b.status === "pending" && filters.showPending)
      ),
    [dayBookings, filters.showApproved, filters.showPending]
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white p-6">
      <div className="mx-auto max-w-7xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <Header role={viewRole} setRole={setViewRole} user={currentUser} />
          </div>
          <div className="self-start [&>button]:h-10 [&>button]:px-4 [&>button]:text-sm">
            <LogoutButton />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl space-y-4 mt-2">
        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : null}

        <div className="min-h-[24px]">
          {isLoading ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              Loading bookings…
            </div>
          ) : null}
        </div>

        <Card className="border border-slate-200 shadow-xs rounded-xl">
          <CardContent className="px-3 py-2 md:px-3 md:py-2">
            <div className="grid grid-cols-1 md:grid-cols-[minmax(680px,1fr)_240px_auto] md:items-center gap-3">
              <div className="min-w-0">
                <Label className="text-slate-600 block mb-0.5">View</Label>
                <div className="mt-1">
                  <CalendarNav
                    mode={nav.mode}
                    onModeChange={(m: ViewMode) => nav.setMode(m)}
                    onPrev={nav.goPrev}
                    onNext={nav.goNext}
                    onToday={nav.goToday}
                    rangeLabel={rangeLabel}
                    jumpYMD={jumpYMD}
                    onJumpYMDChange={handleJumpYMDChange}
                    onJumpCommit={handleJumpCommit}
                  />
                </div>
              </div>

              <div className="w-full md:w-[240px]">
                <Label className="text-slate-600 block mb-1">Bioscope</Label>
                <Select value={selectedBioscope} onValueChange={(v: string) => setSelectedBioscope(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BIOSCOPES.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="justify-self-end">
                <div className="flex items-center gap-3 rounded-2xl bg-slate-50 px-3 py-2">
                  <Filter className="w-4 h-4 text-slate-500" />
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={filters.showApproved}
                      onCheckedChange={(v: boolean) => setFilters((f) => ({ ...f, showApproved: v }))}
                    />
                    <span className="text-sm text-slate-600">Approved</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={filters.showPending}
                      onCheckedChange={(v: boolean) => setFilters((f) => ({ ...f, showPending: v }))}
                    />
                    <span className="text-sm text-slate-600">Pending</span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Tabs value={viewRole} onValueChange={(v: string) => setViewRole(v as Role)} className="space-y-4">
          <TabsList className="grid grid-cols-3 gap-2 bg-slate-100 p-1 rounded-2xl">
            <TabsTrigger value="student" className="rounded-xl data-[state=active]:bg-white data-[state=active]:shadow">
              Student
            </TabsTrigger>
            <TabsTrigger value="teacher" className="rounded-xl data-[state=active]:bg-white data-[state=active]:shadow">
              Teacher
            </TabsTrigger>
            <TabsTrigger value="admin" className="rounded-xl data-[state=active]:bg-white data-[state=active]:shadow">
              Admin
            </TabsTrigger>
          </TabsList>

          <TabsContent value="student" className="space-y-6">
            <Tabs defaultValue="bookings" className="space-y-4">
              <TabsList className="grid grid-cols-2 gap-2 bg-slate-100 p-1 rounded-2xl w-[360px]">
                <TabsTrigger value="bookings" className="rounded-xl data-[state=active]:bg-white data-[state=active]:shadow">Bookings</TabsTrigger>
                <TabsTrigger value="microscope" className="rounded-xl data-[state=active]:bg-white data-[state=active]:shadow">Microscope</TabsTrigger>
              </TabsList>

              <TabsContent value="bookings" className="space-y-6">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <BookingCalendar
                    openSlots={openSlots}
                    slotMinutes={SLOT_MINUTES}
                    selectedSlot={draft.slot}
                    onSelectSlot={(slotKey) => setDraft((d) => ({ ...d, slot: slotKey }))}
                    fmtTime={fmtTime}
                  />
                  <BookingForm
                    draft={draft}
                    setDraft={setDraft}
                    isGroup={isGroup}
                    setIsGroup={setIsGroup}
                    onSubmit={submitBooking}
                    fmtTime={fmtTime}
                  />
                </div>

                <BookingSchedule
                  title={`Schedule for ${selectedDate} · ${BIOSCOPES.find(b => b.id === selectedBioscope)?.name ?? ""}`}
                  bookings={dayBookings
                    .filter((b) => (b.status === "approved" && filters.showApproved) || (b.status === "pending" && filters.showPending))
                    .sort((a, b) => a.slotStart - b.slotStart)}
                  fmtTime={fmtTime}
                />

                <BookingList
                  title="My requests"
                  bookings={[...myBookings].sort((a, b) => a.date.localeCompare(b.date) || a.slotStart - b.slotStart)}
                  bioscopes={BIOSCOPES}
                  onCancel={removeBooking}
                  fmtTime={fmtTime}
                />
              </TabsContent>

              <TabsContent value="microscope" className="space-y-6">
                <StudentView selectedBioscope={selectedBioscope} onSelectBioscope={(id: string) => setSelectedBioscope(id)} />
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="teacher" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <ApprovalQueue
                bookings={bookings}
                bioscopes={BIOSCOPES}
                fmtTime={fmtTime}
                setStatus={setStatus}
                onDelete={removeBooking}
              />
              <DayAtAGlance slotsForDay={slotsForDay} dayBookings={filteredDayBookings} fmtTime={fmtTime} onDelete={removeBooking} />
            </div>
          </TabsContent>

          <TabsContent value="admin" className="space-y-6">
            <AnalyticsDashboard analytics={analytics} />
          </TabsContent>
        </Tabs>

        <p className="text-xs text-slate-500 text-center">
          This is a demo UI. Connect additional endpoints to extend persistence, enforce policies, and sync across users.
        </p>
      </div>
    </div>
  );
}
