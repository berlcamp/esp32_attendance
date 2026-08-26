#include "ScanEvent.h"

#include <cstdio>
#include <ctime>

namespace core {

std::string isoUtc(int64_t epoch) {
  time_t t = static_cast<time_t>(epoch);
  struct tm tmv;
#if defined(_WIN32)
  gmtime_s(&tmv, &t);
#else
  gmtime_r(&t, &tmv);
#endif
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmv);
  return std::string(buf);
}

std::string buildQueueLine(const ScanEvent& ev) {
  // scanned_at is left empty when the clock was not synced; finalizeForUpload
  // fills it in. It is never sent empty.
  std::string scannedAt = ev.stamp > 0 ? isoUtc(ev.stamp) : std::string();

  char stampBuf[24];
  snprintf(stampBuf, sizeof(stampBuf), "%lld",
           static_cast<long long>(ev.stamp));

  std::string json;
  json.reserve(256);
  json += "{\"event_id\":\"";
  json += ev.eventId;
  json += "\",\"card_uid\":\"";
  json += ev.cardUid;
  json += "\",\"device_id\":\"";
  json += ev.deviceId;
  json += "\",\"scanned_at\":\"";
  json += scannedAt;
  json += "\",\"clock_synced\":";
  json += ev.clockSynced ? "true" : "false";
  json += ",\"direction\":\"in\",\"queued\":false}";

  return std::string(stampBuf) + "\t" + json + "\n";
}

bool parseQueueLine(const std::string& line, int64_t& stamp,
                    std::string& json) {
  size_t tab = line.find('\t');
  if (tab == std::string::npos || tab == 0) return false;
  size_t end = line.size();
  while (end > tab && (line[end - 1] == '\n' || line[end - 1] == '\r')) --end;
  if (end <= tab + 1) return false;

  try {
    stamp = static_cast<int64_t>(std::stoll(line.substr(0, tab)));
  } catch (...) {
    return false;
  }
  json = line.substr(tab + 1, end - tab - 1);
  return json.size() > 1 && json.front() == '{' && json.back() == '}';
}

static bool replaceFirst(std::string& s, const std::string& from,
                         const std::string& to) {
  size_t p = s.find(from);
  if (p == std::string::npos) return false;
  s.replace(p, from.size(), to);
  return true;
}

std::string finalizeForUpload(const std::string& line, int64_t nowEpoch,
                              int64_t bootEpoch, int lateAfterS) {
  int64_t stamp = 0;
  std::string json;
  if (!parseQueueLine(line, stamp, json)) return std::string();

  int64_t real;
  if (stamp > 0) {
    real = stamp;
  } else {
    // Reconstructed from uptime. clock_synced stays false in the payload so the
    // web app can see this timestamp is inferred, not measured.
    real = bootEpoch + (-stamp);
    replaceFirst(json, "\"scanned_at\":\"\"",
                 "\"scanned_at\":\"" + isoUtc(real) + "\"");
  }

  if (nowEpoch - real > static_cast<int64_t>(lateAfterS)) {
    replaceFirst(json, "\"queued\":false", "\"queued\":true");
  }
  return json;
}

}  // namespace core
