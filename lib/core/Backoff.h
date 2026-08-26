#pragma once
#include <cstdint>

namespace core {

// Exponential backoff with a ceiling. Being offline is a normal state for a
// school gate, so the ceiling matters more than the growth rate: we want the
// device to retry forever at a calm interval, not to give up or to hammer.
class Backoff {
 public:
  Backoff(uint32_t baseMs = 1000, uint32_t maxMs = 60000)
      : base_(baseMs), max_(maxMs), cur_(baseMs), failures_(0) {}

  uint32_t delayMs() const { return cur_; }
  uint32_t failures() const { return failures_; }

  void onFailure() {
    ++failures_;
    uint64_t next = static_cast<uint64_t>(cur_) * 2;
    cur_ = next > max_ ? max_ : static_cast<uint32_t>(next);
  }

  void onSuccess() {
    cur_ = base_;
    failures_ = 0;
  }

 private:
  uint32_t base_;
  uint32_t max_;
  uint32_t cur_;
  uint32_t failures_;
};

}  // namespace core
