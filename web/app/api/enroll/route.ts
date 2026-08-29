import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// UIDs are uppercase hex everywhere in this system — the device emits them
// that way. Normalising here means a hand-typed uid still matches the scans.
function normalizeUid(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const uid = raw.trim().toUpperCase();
  return /^[0-9A-F]{4,32}$/.test(uid) ? uid : null;
}

type ScanRow = { card_uid: string; scanned_at: string; student_id: string | null };
type CardRow = { card_uid: string; student_id: string; issued_at: string };
type StudentRow = { id: string; full_name: string; student_no: string | null };

/** Cards seen at the gate that no student currently holds, plus the roster. */
export async function GET() {
  const sb = serverClient();
  if (!sb) {
    return NextResponse.json(
      { configured: false, error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY", unassigned: [], students: [] },
      { status: 200 },
    );
  }

  const [scansRes, studentsRes, cardsRes] = await Promise.all([
    sb.from("attendance_resolved")
      .select("card_uid, scanned_at, student_id")
      .is("student_id", null)
      .order("scanned_at", { ascending: false })
      .limit(500),
    sb.from("students").select("id, full_name, student_no").order("full_name"),
    sb.from("student_cards")
      .select("card_uid, student_id, issued_at")
      .is("revoked_at", null),
  ]);

  const err = scansRes.error ?? studentsRes.error ?? cardsRes.error;
  if (err) {
    return NextResponse.json(
      { configured: true, error: err.message, unassigned: [], students: [] },
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
  const students = ((studentsRes.data ?? []) as StudentRow[]).map((s) => ({
    id: s.id,
    name: s.full_name,
    studentNo: s.student_no,
    cards: cards.filter((c) => c.student_id === s.id).map((c) => c.card_uid),
  }));

  return NextResponse.json({
    configured: true,
    error: null,
    unassigned: [...byUid.values()],
    students,
  });
}

/**
 * Assign a card to a student, creating the student if needed.
 * Body: { cardUid, studentId } or { cardUid, fullName, studentNo? }
 */
export async function POST(req: Request) {
  const sb = serverClient();
  if (!sb) return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 });

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

  let studentId = typeof body.studentId === "string" ? body.studentId : null;

  if (!studentId) {
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    if (!fullName) {
      return NextResponse.json(
        { error: "Give either an existing studentId or a fullName for a new student" },
        { status: 400 },
      );
    }
    const studentNo =
      typeof body.studentNo === "string" && body.studentNo.trim()
        ? body.studentNo.trim()
        : null;

    const created = await sb
      .from("students")
      .insert({ full_name: fullName, student_no: studentNo })
      .select("id")
      .single();

    if (created.error) {
      // student_no is UNIQUE; a duplicate is a typo, not a server fault.
      const dup = created.error.code === "23505";
      return NextResponse.json(
        { error: dup ? `Student number ${studentNo} is already taken` : created.error.message },
        { status: dup ? 409 : 500 },
      );
    }
    studentId = created.data.id as string;
  }

  // A card can only have one active holder (enforced by
  // student_cards_active_uid_idx). Retiring the old mapping rather than
  // updating it is what keeps past attendance pointing at whoever actually
  // held the card that day.
  const revoked = await sb
    .from("student_cards")
    .update({ revoked_at: new Date().toISOString() })
    .eq("card_uid", cardUid)
    .is("revoked_at", null)
    .select("student_id");

  if (revoked.error) {
    return NextResponse.json({ error: revoked.error.message }, { status: 500 });
  }

  const issued = await sb
    .from("student_cards")
    .insert({ student_id: studentId, card_uid: cardUid })
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
    .eq("card_uid", cardUid)
    .is("revoked_at", null)
    .select("id");

  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, revoked: (res.data ?? []).length });
}
