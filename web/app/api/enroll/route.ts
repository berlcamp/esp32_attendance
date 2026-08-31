import { NextResponse } from "next/server";
import { serverClient, gateSchool, type RosterRow } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// UIDs are uppercase hex everywhere in this system — the device emits them
// that way, and pta.student_cards has a CHECK that says so. Normalising here
// means a hand-typed uid still matches the scans.
function normalizeUid(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const uid = raw.trim().toUpperCase();
  return /^[0-9A-F]{4,32}$/.test(uid) ? uid : null;
}

type ScanRow = { card_uid: string; scanned_at: string; student_id: string | null };
type CardRow = { card_uid: string; student_id: string; issued_at: string };

const EMPTY = { configured: false, error: null as string | null, school: null as string | null, unassigned: [], students: [] };

/** Cards seen at this gate that no student currently holds, plus the roster. */
export async function GET() {
  const sb = serverClient();
  if (!sb) {
    return NextResponse.json(
      { ...EMPTY, error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" },
      { status: 200 },
    );
  }

  const { school, error: schoolErr } = await gateSchool(sb);
  if (!school) {
    return NextResponse.json({ ...EMPTY, configured: true, error: schoolErr }, { status: 200 });
  }

  const [scansRes, rosterRes, cardsRes] = await Promise.all([
    sb.from("attendance_resolved")
      .select("card_uid, scanned_at, student_id")
      .eq("school_id", school.schoolId)
      .is("student_id", null)
      .order("scanned_at", { ascending: false })
      .limit(500),
    // The roster comes from PTA Collections. This app does not create students.
    sb.from("gate_roster")
      .select("student_id, full_name, student_no, grade_level, section_name")
      .eq("school_id", school.schoolId)
      .order("full_name"),
    sb.from("student_cards")
      .select("card_uid, student_id, issued_at")
      .eq("school_id", school.schoolId)
      .is("revoked_at", null),
  ]);

  const err = scansRes.error ?? rosterRes.error ?? cardsRes.error;
  if (err) {
    return NextResponse.json(
      { ...EMPTY, configured: true, school: school.schoolName, error: err.message },
      { status: 200 },
    );
  }

  const cards = (cardsRes.data ?? []) as CardRow[];
  const held = new Set(cards.map((c) => c.card_uid));

  // Collapse the scan history into one entry per unknown card. Newest first,
  // because the card you just tapped on the reader is the one you want to
  // assign — it should be at the top of the list.
  //
  // Two things get filtered out. A card scanned BEFORE it was issued resolves
  // to no student — correct for the history, but it is held right now and must
  // not show up as needing enrolment. And `burst n` on the device console mints
  // synthetic B0000001-style UIDs to load-test the queue; they are not cards
  // and no one will ever enrol them.
  const SYNTHETIC = /^B\d{7}$/;
  const byUid = new Map<string, { cardUid: string; lastSeenAt: string; scans: number }>();
  for (const r of (scansRes.data ?? []) as ScanRow[]) {
    if (held.has(r.card_uid) || SYNTHETIC.test(r.card_uid)) continue;
    const seen = byUid.get(r.card_uid);
    if (seen) seen.scans += 1;
    else byUid.set(r.card_uid, { cardUid: r.card_uid, lastSeenAt: r.scanned_at, scans: 1 });
  }

  const students = ((rosterRes.data ?? []) as RosterRow[]).map((s) => ({
    id: s.student_id,
    name: s.full_name,
    studentNo: s.student_no,
    gradeLevel: s.grade_level,
    section: s.section_name,
    cards: cards.filter((c) => c.student_id === s.student_id).map((c) => c.card_uid),
  }));

  return NextResponse.json({
    configured: true,
    error: null,
    school: school.schoolName,
    unassigned: [...byUid.values()],
    students,
  });
}

/**
 * Assign a card to a student already on the PTA roster.
 * Body: { cardUid, studentId }
 *
 * There is deliberately no "create a student" path here any more. A student
 * invented at the gate would have no enrolment row, so no school year, no
 * section and no student number — invisible in PTA Collections and unbillable.
 * Students are created there; this page only binds a piece of plastic to one.
 */
export async function POST(req: Request) {
  const sb = serverClient();
  if (!sb) return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 });

  const { school, error: schoolErr } = await gateSchool(sb);
  if (!school) return NextResponse.json({ error: schoolErr }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const cardUid = normalizeUid(body.cardUid);
  if (!cardUid) {
    return NextResponse.json(
      { error: "cardUid must be 4-32 hex characters" },
      { status: 400 },
    );
  }

  const studentId = typeof body.studentId === "string" ? body.studentId : null;
  if (!studentId) {
    return NextResponse.json(
      { error: "Pick a student from the roster. Add new students in PTA Collections." },
      { status: 400 },
    );
  }

  // Belt and braces: the composite FK on pta.student_cards already refuses a
  // student from another school, but a clear 404 beats a foreign key error.
  const onRoster = await sb
    .from("gate_roster")
    .select("student_id")
    .eq("school_id", school.schoolId)
    .eq("student_id", studentId)
    .maybeSingle();

  if (onRoster.error) {
    return NextResponse.json({ error: onRoster.error.message }, { status: 500 });
  }
  if (!onRoster.data) {
    return NextResponse.json(
      { error: "That student is not enrolled at this school in the active school year." },
      { status: 404 },
    );
  }

  // A card can only have one active holder (enforced by
  // student_cards_active_uid_idx). Retiring the old mapping rather than
  // updating it is what keeps past attendance pointing at whoever actually
  // held the card that day.
  const revoked = await sb
    .from("student_cards")
    .update({ revoked_at: new Date().toISOString() })
    .eq("school_id", school.schoolId)
    .eq("card_uid", cardUid)
    .is("revoked_at", null)
    .select("student_id");

  if (revoked.error) {
    return NextResponse.json({ error: revoked.error.message }, { status: 500 });
  }

  const issued = await sb
    .from("student_cards")
    .insert({ school_id: school.schoolId, student_id: studentId, card_uid: cardUid })
    .select("id")
    .single();

  if (issued.error) {
    return NextResponse.json({ error: issued.error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    cardUid,
    studentId,
    replaced: (revoked.data ?? []).length > 0,
  });
}

/** Retire a card — lost, broken, or student left. Body: { cardUid } */
export async function DELETE(req: Request) {
  const sb = serverClient();
  if (!sb) return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 });

  const { school, error: schoolErr } = await gateSchool(sb);
  if (!school) return NextResponse.json({ error: schoolErr }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const cardUid = normalizeUid(body.cardUid);
  if (!cardUid) return NextResponse.json({ error: "Bad cardUid" }, { status: 400 });

  const res = await sb
    .from("student_cards")
    .update({ revoked_at: new Date().toISOString() })
    .eq("school_id", school.schoolId)
    .eq("card_uid", cardUid)
    .is("revoked_at", null)
    .select("id");

  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, revoked: (res.data ?? []).length });
}
