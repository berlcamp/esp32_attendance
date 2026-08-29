#pragma once
// Where UIDs come from. Everything downstream — the queue, the uploader, the
// dashboard — only ever sees a UID string, so swapping the simulator for real
// hardware is a one-line change in main.cpp and nothing else moves.
#include <Arduino.h>

#include <string>
#include <vector>

#include "config.h"

class ITagReader {
 public:
  virtual ~ITagReader() {}
  virtual void begin() = 0;

  // Non-virtual on purpose: manual injection and the enable switch behave
  // identically for every reader, and `scan <uid>` must keep working against
  // real hardware — it is how you test the upload path without a card.
  bool poll(std::string& uid) {
    if (!injected_.empty()) {
      uid = injected_.front();
      injected_.erase(injected_.begin());
      return true;
    }
    if (!enabled_) return false;
    return read(uid);
  }

  void inject(const std::string& uid) { injected_.push_back(uid); }

  // Synthetic unique UIDs: reusing real UIDs would just trip the cooldown and
  // queue a fraction of what you asked for.
  void injectBurst(size_t n) {
    for (size_t i = 0; i < n; ++i) {
      char uid[16];
      snprintf(uid, sizeof(uid), "B%07u", (unsigned)(burstSeq_++));
      injected_.push_back(uid);
    }
  }

  bool enabled() const { return enabled_; }
  void setEnabled(bool on) {
    enabled_ = on;
    onEnabled(on);
  }

 protected:
  // Hardware read. Returns true and fills uid when a card has been presented.
  virtual bool read(std::string& uid) = 0;
  virtual void onEnabled(bool) {}

 private:
  bool enabled_ = true;
  uint32_t burstSeq_ = 1;
  std::vector<std::string> injected_;
};

// ---------------------------------------------------------------------------
// Deterministic fake roster. Kept after the real reader lands: it is the only
// way to exercise the queue and upload path with no cards and no hardware.
// ---------------------------------------------------------------------------
class SimulatedTagReader : public ITagReader {
 public:
  void begin() override { lastScanMs_ = millis(); }

 protected:
  bool read(std::string& uid) override {
    uint32_t now = millis();
    if (now - lastScanMs_ < SCAN_INTERVAL_MS) return false;
    lastScanMs_ = now;
    uid = kRoster[next_];
    next_ = (next_ + 1) % kRosterSize;
    return true;
  }

  // A full interval before the next scan, rather than one the instant you
  // type `sim on`.
  void onEnabled(bool on) override {
    if (on) lastScanMs_ = millis();
  }

 private:
  uint32_t lastScanMs_ = 0;
  size_t next_ = 0;
};
