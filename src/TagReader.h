#pragma once
// The only seam that changes when the real MFRC522 arrives: construct
// Mfrc522TagReader instead of SimulatedTagReader in main.cpp. Nothing else
// in the system knows where UIDs come from.
#include <Arduino.h>

#include <string>
#include <vector>

#include "config.h"

class ITagReader {
 public:
  virtual ~ITagReader() {}
  virtual void begin() = 0;
  // Returns true and fills uid when a card has been presented.
  virtual bool poll(std::string& uid) = 0;
};

class SimulatedTagReader : public ITagReader {
 public:
  void begin() override { lastScanMs_ = millis(); }

  bool poll(std::string& uid) override {
    // Manual `scan <uid>` / `burst n` always works, even while paused — the
    // pause is only on the automatic every-10s generator.
    if (!injected_.empty()) {
      uid = injected_.front();
      injected_.erase(injected_.begin());
      return true;
    }
    if (!enabled_) return false;
    uint32_t now = millis();
    if (now - lastScanMs_ < SCAN_INTERVAL_MS) return false;
    lastScanMs_ = now;
    uid = kRoster[next_];
    next_ = (next_ + 1) % kRosterSize;
    return true;
  }

  void inject(const std::string& uid) { injected_.push_back(uid); }

  bool enabled() const { return enabled_; }
  void setEnabled(bool on) {
    enabled_ = on;
    if (on) lastScanMs_ = millis();  // full interval before the next scan
  }
  // Synthetic unique UIDs: reusing roster UIDs would just trip the 10s
  // cooldown and queue a tenth of what you asked for.
  void injectBurst(size_t n) {
    for (size_t i = 0; i < n; ++i) {
      char uid[16];
      snprintf(uid, sizeof(uid), "B%07u", (unsigned)(burstSeq_++));
      injected_.push_back(uid);
    }
  }

 private:
  bool enabled_ = true;
  uint32_t lastScanMs_ = 0;
  size_t next_ = 0;
  uint32_t burstSeq_ = 1;
  std::vector<std::string> injected_;
};
