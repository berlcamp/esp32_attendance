import { NextResponse } from "next/server";
import { serverClient, type FeedRow } from "@/lib/supabase";
import { startOfSchoolDay, SCHOOL_TZ } from "@/lib/tz";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Student = { id: string; full_name: string; student_no: string | null };

// Shared envelope so every response — success or failure — has the same shape.
const EMPTY = {
  configured: false,
  error: null as string | null,
  hint: null as string | null,
  now: new Date(0).toISOString(),
  tz: SCHOOL_TZ,
  gate: { deviceId: "gate-01", lastSeen: null, secondsSince: null },
  stats: {
    present: 0, enrolled: 0, scansToday: 0, unknownScans: 0,
    unknownCards: [] as string[], lateSync: 0, inferredTime: 0,
  },
  feed: [],
  roster: [],
};

export async function GET() {
  const sb = serverClient();
  if (!sb) {
    return NextResponse.json(
      {
        ...EMPTY,
        configured: false,
        error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY",
      },
      { status: 200 },
    );
  }

  const dayStart = startOfSchoolDay().toISOString();

  const [feedRes, todayRes, studentsRes] = await Promise.all([
    sb.from("attendance_resolved")
      .select("*").order("scanned_at", { ascending: false }).limit(60),
    sb.from("attendance_resolved")
      .select("*").gte("scanned_at", dayStart)
      .order("scanned_at", { ascending: true }),
    sb.from("students").select("id, full_name, student_no").order("full_name"),
  ]);

  const err = feedRes.error ?? todayRes.error ?? studentsRes.error;
  if (err) {
    return NextResponse.json(
      {
        ...EMPTY,
        configured: true,
        error: err.message,
        hint: (err as { hint?: string }).hint ?? null,
      },
      { status: 200 },
    );
  }

  const feed = (feedRes.data ?? []) as FeedRow[];
  const today = (todayRes.data ?? []) as FeedRow[];
  const students = (studentsRes.data ?? []) as Student[];

  // First scan of the day per student == arrival. With one reader at one gate
  // this is a RULE we apply, not something the hardware measured.
  const firstScan = new Map<string, FeedRow>();
  for (const r of today) {
    if (r.student_id && !firstScan.has(r.student_id)) firstScan.set(r.student_id, r);
  }

  const unknownToday = today.filter((r) => !r.student_id);
  const unknownCards = [...new Set(unknownToday.map((r) => r.card_uid))];

  const last = feed[0] ?? null;

  return NextResponse.json({
    configured: true,
    error: null,
    now: new Date().toISOString(),
    tz: SCHOOL_TZ,
    gate: {
      deviceId: last?.device_id ?? "gate-01",
      lastSeen: last?.received_at ?? null,
      secondsSince: last ? (Date.now() - Date.parse(last.received_at)) / 1000 : null,
    },
    stats: {
      present: firstScan.size,
      enrolled: students.length,
      scansToday: today.length,
      unknownScans: unknownToday.length,
      unknownCards,
      lateSync: today.filter((r) => r.queued).length,
      inferredTime: today.filter((r) => !r.clock_synced).length,
    },
    feed,
    roster: students
      .map((s) => {
        const f = firstScan.get(s.id);
        return {
          id: s.id,
          name: s.full_name,
          studentNo: s.student_no,
          arrivedAt: f?.scanned_at ?? null,
          estimated: f ? !f.clock_synced : false,
          late: f ? f.queued : false,
        };
      })
      .sort((a, b) => {
        if (!!a.arrivedAt === !!b.arrivedAt) {
          if (a.arrivedAt && b.arrivedAt) return a.arrivedAt.localeCompare(b.arrivedAt);
          return a.name.localeCompare(b.name);
        }
        return a.arrivedAt ? -1 : 1;
      }),
  });
}
