import { createClient } from "@supabase/supabase-js";

// Server-only. The device's anon key is insert-only by design, so reading the
// board needs the service_role key — which must never reach the browser.
export function serverClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    db: { schema: "mvts_esp32" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type FeedRow = {
  event_id: string;
  card_uid: string;
  device_id: string;
  scanned_at: string;
  received_at: string;
  clock_synced: boolean;
  direction: string;
  queued: boolean;
  student_id: string | null;
  full_name: string | null;
  student_no: string | null;
};
