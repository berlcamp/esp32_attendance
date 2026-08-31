#pragma once
#include <stddef.h>
#include <stdint.h>

// ---- Identity ------------------------------------------------------------
// This is the tenancy key. The device sends this string and nothing else about
// where it is; pta.gate_devices maps it to a school, and record_attendance()
// stamps school_id from there. So the device cannot claim to be somewhere it is
// not, and an UNREGISTERED id is refused outright -- the batch stays queued on
// flash rather than being written where nobody can attribute it.
#define DEVICE_ID "gate-01"

// ---- Supabase ------------------------------------------------------------
// The gate shares the `pta` schema with PTA Collections: one roster, one
// guardian list. `pta` is already listed under Settings -> API -> "Exposed
// schemas" for that app; without it every POST returns 404 PGRST106.
#define SUPABASE_SCHEMA "pta"
#define SUPABASE_TABLE "attendance"
// The device calls this function instead of writing the table directly, so the
// anon key carries no table privileges at all -- not even SELECT. Defined in
// pta-collections/supabase/migrations/0013_gate_attendance.sql.
#define SUPABASE_RPC "record_attendance"

// ---- Reader --------------------------------------------------------------
// 0 = simulated roster below, 1 = the real Wiegand reader on the pins below.
// Find the pins with: pio run -e wiegand-probe -t upload, then swipe a card.
#define USE_WIEGAND_READER 1
#define WIEGAND_D0 4
#define WIEGAND_D1 5

// ---- Simulation ----------------------------------------------------------
// Deterministic on purpose: a gap in Supabase is then a bug, not randomness.
static constexpr uint32_t SCAN_INTERVAL_MS = 10000;   // one student per 10s
static constexpr uint32_t CARD_COOLDOWN_MS = 10000;   // human double-swipe guard

// Only used when USE_WIEGAND_READER is 0. Cards are enrolled against the PTA
// roster on /enroll now, so none of these resolve to a student unless you
// deliberately assign them — which is the point: they exercise the unknown-card
// path in the dashboard before a real student turns up with an unregistered one.
static const char* const kRoster[] = {
    "04A1B2C3", "04B2C3D4", "04C3D4E5", "04D4E5F6", "04E5F607",
    "04F60718", "04071829", "0418293A", "04293A4B", "DEADC0DE",
};
static constexpr size_t kRosterSize = sizeof(kRoster) / sizeof(kRoster[0]);
#define kUnknownCardUid "DEADC0DE"

// ---- Queue ---------------------------------------------------------------
static constexpr size_t QUEUE_MAX_EVENTS = 20000;      // ~weeks of outage
static constexpr size_t QUEUE_COMPACT_BYTES = 65536;
static constexpr size_t UPLOAD_BATCH_SIZE = 50;
static constexpr int LATE_AFTER_S = 15;                // -> queued=true

// ---- Network -------------------------------------------------------------
static constexpr uint32_t BACKOFF_BASE_MS = 1000;
static constexpr uint32_t BACKOFF_MAX_MS = 60000;
static constexpr uint16_t HTTP_TIMEOUT_MS = 15000;
static constexpr uint32_t WIFI_RETRY_MS = 5000;

// ---- Clock ---------------------------------------------------------------
// TLS certificate validation needs a plausible clock, so HTTPS stays gated
// until SNTP produces a time past this. Until then we keep queueing.
static constexpr int64_t MIN_VALID_EPOCH = 1735689600;  // 2025-01-01Z
#define NTP_SERVER_1 "pool.ntp.org"
#define NTP_SERVER_2 "time.google.com"

// ---- Health --------------------------------------------------------------
static constexpr uint32_t WDT_TIMEOUT_S = 60;
static constexpr uint32_t MIN_FREE_HEAP = 20000;
static constexpr uint32_t STATUS_PERIOD_MS = 10000;
