#pragma once
// Wiegand 26/34 reader.
//
// Wiegand is one-way and dumb: the reader pulses D0 low for a 0-bit and D1 low
// for a 1-bit, ~40us wide, ~1ms apart, then goes quiet. There is nothing to
// query and no acknowledgement — a missed edge means that card read is simply
// gone. So both lines are interrupt-driven, and the decode happens in read(),
// off the ISR.
//
// Wire D0/D1 through a level shifter. These readers idle their data lines at
// their own supply rail (5V or 12V) and this chip is 3.3V-tolerant only.
//
// The ISRs live in WiegandTagReader.cpp, not here: IRAM_ATTR functions defined
// in a header make the Xtensa linker fail with "dangerous relocation: l32r:
// literal placed after use".
#include <Arduino.h>

#include <string>

#include "TagReader.h"

class WiegandTagReader : public ITagReader {
 public:
  WiegandTagReader(int8_t d0, int8_t d1) : d0_(d0), d1_(d1) {}

  void begin() override;

 protected:
  bool read(std::string& uid) override;

 private:
  static void isrD0();
  static void isrD1();
  void pushBit(uint8_t b);

  static bool parity26Ok(uint64_t raw);

  static WiegandTagReader* self_;  // one reader per gate; the ISRs need a target

  const int8_t d0_;
  const int8_t d1_;
  volatile uint64_t raw_ = 0;
  volatile uint8_t bitCount_ = 0;
  volatile uint32_t lastBitUs_ = 0;
};
