#pragma once
// Boot order matters: WiFi -> SNTP -> plausible clock -> only then HTTPS.
// TLS certificate validation fails outright when the device thinks it is 1970,
// so this gate is what stops a fresh boot from looking like a network fault.
#include <Arduino.h>
#include <esp_timer.h>
#include <time.h>

#include "config.h"

class TimeSync {
 public:
  void begin() {
    configTzTime("UTC0", NTP_SERVER_1, NTP_SERVER_2);
  }

  // Monotonic, 64-bit — unlike millis(), this does not wrap at 49 days.
  static int64_t uptimeSeconds() { return esp_timer_get_time() / 1000000LL; }

  static int64_t nowEpoch() { return static_cast<int64_t>(time(nullptr)); }

  bool synced() {
    if (synced_) return true;
    if (nowEpoch() >= MIN_VALID_EPOCH) {
      synced_ = true;
      bootEpoch_ = nowEpoch() - uptimeSeconds();
    }
    return synced_;
  }

  // Epoch at which the device booted; used to rebuild timestamps for scans
  // recorded before SNTP landed.
  int64_t bootEpoch() const { return bootEpoch_; }

 private:
  bool synced_ = false;
  int64_t bootEpoch_ = 0;
};
