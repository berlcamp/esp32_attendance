#pragma once
// Glanceable state on the on-board RGB LED:
//   green  online, queue empty
//   amber  queueing (offline, or catching up)
//   red    no WiFi
//   blue   booting / waiting for clock
#include <Arduino.h>

#ifndef RGB_BUILTIN
#define RGB_BUILTIN 48  // ESP32-S3-DevKitC-1 default; harmless if unpopulated
#endif

enum class GateState { Boot, NoWifi, Queueing, Online };

inline void statusLed(GateState s) {
  switch (s) {
    case GateState::Boot:     neopixelWrite(RGB_BUILTIN, 0, 0, 24); break;
    case GateState::NoWifi:   neopixelWrite(RGB_BUILTIN, 24, 0, 0); break;
    case GateState::Queueing: neopixelWrite(RGB_BUILTIN, 24, 12, 0); break;
    case GateState::Online:   neopixelWrite(RGB_BUILTIN, 0, 20, 0); break;
  }
}

inline void ledBlip() { neopixelWrite(RGB_BUILTIN, 30, 30, 30); }
