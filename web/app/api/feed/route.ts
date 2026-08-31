import { NextResponse } from "next/server";
import {
  serverClient,
  gateSchool,
  GATE_DEVICE_ID,
  type FeedRow,
  type RosterRow,
} from "@/lib/supabase";
import { startOfSchoolDay, SCHOOL_TZ } from "@/lib/tz";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Shared envelope so every response — success or failure — has the same shape.
const EMPTY = {
  configured: false,
  error: null as string | null,
  hint: null as string | null,
  now: new Date(0).toISOString(),
  tz: SCHOOL_TZ,
  school: null as string | null,
  gate: { deviceId: GATE_DEVICE_ID, lastSeen: null, secondsSince: null },
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

  // Which school this gate belongs to. service_role bypasses RLS, so this is
  // the ONLY thing keeping another school's students off this board.
  const { school, error: schoolErr } = await gateSchool(sb);
  if (!school) {
    return NextResponse.json(
      { ...EMPTY, configured: true, error: schoolErr }, { status: 200 },
    );
  }

  const dayStart = startOfSchoolDay().toISOString();

  const [feedRes, todayRes, rosterRes] = await Promise.all([
    sb.from("attendance_resolved")
      .select("*").eq("school_id", school.schoolId)
      .order("scanned_at", { ascending: false }).limit(60),
    sb.from("attendance_resolved")
      .select("*").eq("school_id", school.schoolId).gte("scanned_at", dayStart)
      .order("scanned_at", { ascending: true }),
    // The roster is PTA's, not ours: students actively enrolled in this
    // school's active school year.
    sb.from("gate_roster")
      .select("student_id, full_name, student_no, grade_level, section_name")
      .eq("school_id", school.schoolId)
      .order("full_name"),
  ]);

  const err = feedRes.error ?? todayRes.error ?? rosterRes.error;
  if (err) {
    return NextResponse.json(
      {
        ...EMPTY,
        configured: true,
        school: school.schoolName,
        error: err.message,
        hint: (err as { hint?: string }).hint ?? null,
      },
      { status: 200 },
    );
  }

  const feed = (feedRes.data ?? []) as FeedRow[];
  const today = (todayRes.data ?? []) as FeedRow[];
  const roster = (rosterRes.data ?? []) as RosterRow[];

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
    school: school.schoolName,
    gate: {
      deviceId: last?.device_id ?? GATE_DEVICE_ID,
      lastSeen: last?.received_at ?? null,
      secondsSince: last ? (Date.now() - Date.parse(last.received_at)) / 1000 : null,
    },
    stats: {
      present: firstScan.size,
      enrolled: roster.length,
      scansToday: today.length,
      unknownScans: unknownToday.length,
      unknownCards,
      lateSync: today.filter((r) => r.queued).length,
      inferredTime: today.filter((r) => !r.clock_synced).length,
    },
    feed,
    roster: roster
      .map((s) => {
        const f = firstScan.get(s.student_id);
        return {
          id: s.student_id,
          name: s.full_name,
          studentNo: s.student_no,
          gradeLevel: s.grade_level,
          section: s.section_name,
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
