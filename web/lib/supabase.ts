import { createClient } from "@supabase/supabase-js";

// Server-only. The device's anon key is insert-only by design, so reading the
// board needs the service_role key — which must never reach the browser.
//
// service_role BYPASSES RLS. On this project that matters more than it used to:
// `pta` is multi-tenant and holds every school's roster, so nothing here is
// scoped for us. Every query in this app goes through gateSchool() and
// filters on it. See the header of 0013_gate_attendance.sql.
export function serverClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    db: { schema: "pta" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// serverClient() pins the schema to `pta`, and SupabaseClient's default
// generic is "public" — so take the client's type from the factory rather than
// annotating it, or every caller fails to typecheck.
export type GateClient = NonNullable<ReturnType<typeof serverClient>>;

/** The device whose scans this dashboard shows. One board, one gate. */
export const GATE_DEVICE_ID = process.env.GATE_DEVICE_ID ?? "gate-01";

export type GateSchool = { schoolId: string; schoolName: string };

// The device→school binding changes about once ever, and this runs on every
// poll of a board that refreshes every few seconds, so it is worth not asking
// Postgres each time. A miss is cached as null so a misconfigured deployment
// does not hammer the database either.
let cached: { at: number; value: GateSchool | null } | null = null;
const TTL_MS = 60_000;

/**
 * Resolve GATE_DEVICE_ID to its school. Returns null when the device is not
 * registered — which is a setup error, not an empty board, and is reported as
 * such rather than silently showing zero students.
 */
export async function gateSchool(
  sb: GateClient,
): Promise<{ school: GateSchool | null; error: string | null }> {
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { school: cached.value, error: null };
  }

  const { data, error } = await sb
    .from("gate_devices")
    .select("school_id, active, schools(name)")
    .eq("device_id", GATE_DEVICE_ID)
    .maybeSingle();

  if (error) return { school: null, error: error.message };

  if (!data) {
    cached = { at: Date.now(), value: null };
    return {
      school: null,
      error:
        `Gate device "${GATE_DEVICE_ID}" is not registered in pta.gate_devices. ` +
        `Run sql/cutover.sql, or insert the row by hand.`,
    };
  }

  if (!data.active) {
    return { school: null, error: `Gate device "${GATE_DEVICE_ID}" is marked inactive.` };
  }

  const rel = data.schools as unknown as { name: string } | { name: string }[] | null;
  const value: GateSchool = {
    schoolId: data.school_id as string,
    schoolName: (Array.isArray(rel) ? rel[0]?.name : rel?.name) ?? "this school",
  };
  cached = { at: Date.now(), value };
  return { school: value, error: null };
}

export type FeedRow = {
  event_id: string;
  school_id: string;
  card_uid: string;
  device_id: string;
  scanned_at: string;
  received_at: string;
  clock_synced: boolean;
  direction: string;
  queued: boolean;
  image_path: string | null;
  student_id: string | null;
  full_name: string | null;
  student_no: string | null;
  grade_level: string | null;
  section_name: string | null;
};

/** A student on the PTA roster for the gate's school, in the active year. */
export type RosterRow = {
  student_id: string;
  full_name: string;
  student_no: string | null;
  grade_level: string | null;
  section_name: string | null;
};
