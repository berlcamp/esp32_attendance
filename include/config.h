#pragma once
#include <stddef.h>
#include <stdint.h>

// ---- Identity ------------------------------------------------------------
#define DEVICE_ID "gate-01"

// ---- Supabase ------------------------------------------------------------
// NOTE: mvts_esp32 must be added to Settings -> API -> "Exposed schemas" in the
// Supabase dashboard, or every POST returns 404 PGRST106.
#define SUPABASE_SCHEMA "mvts_esp32"
#define SUPABASE_TABLE "attendance"
// The device calls this function instead of writing the table directly, so
// the anon key carries no table privileges at all. See sql/rpc.sql.
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

// Nine of these should exist in mvts_esp32.student_cards.
// kUnknownCardUid deliberately does NOT — it exercises the unknown-card path
// in your Next.js app before a real student turns up with an unregistered card.
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
