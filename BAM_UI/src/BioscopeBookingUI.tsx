import { useCallback, useEffect, useMemo, useState } from "react";
import { Filter } from "lucide-react";
import { Card, CardContent } from "@components/ui/card";
import { Input } from "@components/ui/input";
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

function toISODate(d: Date) {
  const z = new Date(d.getTime());
  z.setHours(0, 0, 0, 0);
  return z.toISOString().slice(0, 10);
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

// Types are declared in @types

export default function BioscopeBookingUI() {
  const { user } = useAuthContext();
  const currentUser = user;
  const userRole = (currentUser?.role ?? "student") as Role;
  const [viewRole, setViewRole] = useState<Role>(userRole);

  const [selectedDate, setSelectedDate] = useState<string>(toISODate(new Date()));
  const [selectedBioscope, setSelectedBioscope] = useState<string>(BIOSCOPES[0].id);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<BookingFilters>({
    showApproved: true,
    showPending: true,
  });

  const slotsForDay = useMemo<Slot[]>(() => DAY_SLOTS.map((s) => ({ start: s, end: s + SLOT_MINUTES })), []);

  const dayBookings = useMemo(() => {
    return bookings.filter((b) => b.date === selectedDate && b.bioscopeId === selectedBioscope);
  }, [bookings, selectedDate, selectedBioscope]);

  const occupiedKey = (b: Booking) => `${b.slotStart}-${b.slotEnd}`;

  const occupied = useMemo(() => new Set(dayBookings.map(occupiedKey)), [dayBookings]);

  const openSlots = useMemo(
    () => slotsForDay.filter((s) => !Array.from(occupied).includes(`${s.start}-${s.end}`)),
    [slotsForDay, occupied]
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
    [bookings, ensuredUser.id],
  );

  const [draft, setDraft] = useState<BookingDraft>({ title: "", groupName: "", attendees: 1, slot: "" });
  const [isGroup, setIsGroup] = useState(false);

  const loadBookings = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await BookingsAPI.list();
      setBookings(data);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to load bookings.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBookings();
  }, [loadBookings]);

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
      group_name: isGroup ? draft.groupName.trim() || undefined : undefined,
      attendees: isGroup ? Math.max(1, Number(draft.attendees) || 1) : undefined,
    };
    try {
      const created = await BookingsAPI.create(payload);
      setBookings((prev) => [...prev, created]);
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
      const updated = await BookingsAPI.update(id, { status });
      setBookings((prev) => prev.map((b) => (b.id === id ? updated : b)));
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
      utilizationByBioscope[b.bioscopeId] =
        (utilizationByBioscope[b.bioscopeId] || 0) + (b.slotEnd - b.slotStart);
    });

    const daySeries = Object.entries(byDay)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, mins]) => ({ date, utilization: Math.round((mins / minutesPerDay) * 100) }));

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

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <Header role={viewRole} setRole={setViewRole} user={currentUser} />

        <div className="flex justify-end">
          <LogoutButton />
        </div>

        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        ) : null}
        {isLoading ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Loading bookings…
          </div>
        ) : null}

        <Card className="border-0 shadow-sm">
          <CardContent className="p-4 md:p-6">
            <div className="flex flex-col md:flex-row gap-4 md:items-end">
              <div className="flex-1">
                <Label className="text-slate-600">Date</Label>
                <Input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="mt-1" />
              </div>
              <div className="w-full md:w-[240px]">
                <Label className="text-slate-600">Bioscope</Label>
                <Select value={selectedBioscope} onValueChange={(v: string) => setSelectedBioscope(v)}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BIOSCOPES.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-3 rounded-2xl bg-slate-50 p-3">
                <Filter className="w-4 h-4 text-slate-500" />
                <div className="flex items-center gap-2">
                  <Switch checked={filters.showApproved} onCheckedChange={(v: boolean) => setFilters((f) => ({ ...f, showApproved: v }))} />
                  <span className="text-sm text-slate-600">Approved</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={filters.showPending} onCheckedChange={(v: boolean) => setFilters((f) => ({ ...f, showPending: v }))} />
                  <span className="text-sm text-slate-600">Pending</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Tabs
          value={viewRole}
          onValueChange={(v: string) => setViewRole(v as Role)}
          className="space-y-6"
        >
          <TabsList className="grid grid-cols-3 gap-2 bg-slate-100 p-1 rounded-2xl">
            <TabsTrigger value="student" className="rounded-xl data-[state=active]:bg-white data-[state=active]:shadow">Student</TabsTrigger>
            <TabsTrigger value="teacher" className="rounded-xl data-[state=active]:bg-white data-[state=active]:shadow">Teacher</TabsTrigger>
            <TabsTrigger value="admin" className="rounded-xl data-[state=active]:bg-white data-[state=active]:shadow">Admin</TabsTrigger>
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
              <ApprovalQueue bookings={bookings} bioscopes={BIOSCOPES} fmtTime={fmtTime} setStatus={setStatus} />
              <DayAtAGlance slotsForDay={slotsForDay} dayBookings={dayBookings} fmtTime={fmtTime} />
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
