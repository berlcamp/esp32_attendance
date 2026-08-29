#include "WiegandTagReader.h"

// Bits arrive ~1ms apart, so this much quiet means the reader has finished.
// Decoding earlier would truncate the card number.
static constexpr uint32_t kFrameGapUs = 25000;

WiegandTagReader* WiegandTagReader::self_ = nullptr;

void IRAM_ATTR WiegandTagReader::isrD0() {
  if (self_) self_->pushBit(0);
}

void IRAM_ATTR WiegandTagReader::isrD1() {
  if (self_) self_->pushBit(1);
}

void IRAM_ATTR WiegandTagReader::pushBit(uint8_t b) {
  if (bitCount_ < 64) {
    raw_ = (raw_ << 1) | b;
    bitCount_++;
  }
  lastBitUs_ = micros();
}

// Bit 0 is even parity over bits 1..12, bit 25 odd over bits 13..24. A frame
// failing this is a misread, not a card, and must never become attendance.
bool WiegandTagReader::parity26Ok(uint64_t raw) {
  int even = 0, odd = 0;
  for (int i = 0; i <= 12; ++i) even += (raw >> (25 - i)) & 1;
  for (int i = 13; i <= 25; ++i) odd += (raw >> (25 - i)) & 1;
  return (even % 2 == 0) && (odd % 2 == 1);
}

void WiegandTagReader::begin() {
  if (d0_ < 0 || d1_ < 0) {
    Serial.println(
        "[reader] FATAL: WIEGAND_D0/WIEGAND_D1 are unset in config.h. Run the "
        "pin-finder (pio run -e wiegand-probe -t upload), swipe a card, and "
        "put the pins it reports into config.h.");
    return;
  }
  self_ = this;
  pinMode(d0_, INPUT_PULLUP);
  pinMode(d1_, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(d0_), isrD0, FALLING);
  attachInterrupt(digitalPinToInterrupt(d1_), isrD1, FALLING);
  Serial.printf("[reader] Wiegand on D0=GPIO%d D1=GPIO%d\n", d0_, d1_);
}

bool WiegandTagReader::read(std::string& uid) {
  if (bitCount_ == 0) return false;
  if ((micros() - lastBitUs_) < kFrameGapUs) return false;  // still mid-frame

  const uint8_t bits = bitCount_;
  const uint64_t raw = raw_;
  bitCount_ = 0;
  raw_ = 0;

  char buf[24];
  if (bits == 26) {
    // Strip the two parity bits; what remains is facility + card number, which
    // is what is printed on the card and what a Wiegand panel would report.
    const uint32_t body = (uint32_t)((raw >> 1) & 0xFFFFFF);
    if (!parity26Ok(raw)) {
      Serial.printf(
          "[reader] 26-bit frame with BAD parity (0x%06lX) — ignored; check "
          "D0/D1 are not swapped or noisy\n",
          (unsigned long)body);
      return false;
    }
    snprintf(buf, sizeof(buf), "%06lX", (unsigned long)body);
    Serial.printf("[reader] card %s (facility %u, number %u)\n", buf,
                  (unsigned)((body >> 16) & 0xFF), (unsigned)(body & 0xFFFF));
  } else if (bits == 34) {
    const uint32_t body = (uint32_t)((raw >> 1) & 0xFFFFFFFF);
    snprintf(buf, sizeof(buf), "%08lX", (unsigned long)body);
    Serial.printf("[reader] card %s (34-bit)\n", buf);
  } else {
    Serial.printf(
        "[reader] discarded a %u-bit frame (expected 26 or 34) — a pulse was "
        "missed or a data line is noisy\n",
        (unsigned)bits);
    return false;
  }

  uid = buf;
  return true;
}
