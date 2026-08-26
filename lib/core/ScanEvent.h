#pragma once
// Queue line format:
//
//   <stamp>\t<json>\n
//
// <json> is byte-for-byte what gets POSTed to PostgREST. <stamp> is device-only
// metadata stripped before upload:
//     stamp > 0  -> real unix epoch seconds (clock was synced when scanned)
//     stamp < 0  -> negated uptime seconds (clock was NOT synced when scanned)
//
// The negative case is the whole point of Q4: a gate that loses power boots
// believing it is 1970. We still record the scan, and reconstruct a real
// timestamp at flush time from (boot_epoch + uptime) once NTP has landed.
#include <cstdint>
#include <string>

namespace core {

struct ScanEvent {
  std::string eventId;    // uuid v4 — idempotency key, PK in Postgres
  std::string cardUid;    // raw RFID UID, uppercase hex
  std::string deviceId;   // e.g. "gate-01"
  int64_t stamp = 0;      // see above
  bool clockSynced = false;
};

// Format a unix epoch as ISO-8601 UTC, e.g. "2026-08-26T13:33:20Z".
std::string isoUtc(int64_t epoch);

// Build the full queue line (including trailing '\n').
std::string buildQueueLine(const ScanEvent& ev);

// Split "<stamp>\t<json>" -> stamp, json. Returns false on a malformed line.
bool parseQueueLine(const std::string& line, int64_t& stamp, std::string& json);

// Turn a stored queue line into the JSON actually sent to Supabase.
//   nowEpoch  : current wall-clock (must be valid)
//   bootEpoch : nowEpoch - uptimeSeconds, used to rebuild unsynced timestamps
//   lateAfterS: age beyond which the row is flagged queued=true
std::string finalizeForUpload(const std::string& line, int64_t nowEpoch,
                              int64_t bootEpoch, int lateAfterS);

}  // namespace core
