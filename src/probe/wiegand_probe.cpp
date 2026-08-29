// Wiegand pin-finder. Temporary diagnostic firmware, NOT part of the gate.
//   pio run -e wiegand-probe -t upload
//
// A Wiegand reader has no identity to query: it is two open-collector lines
// that idle high and pulse low, D0 per 0-bit and D1 per 1-bit, ~40us wide and
// ~1ms apart. So we cannot ask "are you there" — we watch every pin we are
// allowed to touch and wait for a card to make one of them move.
//
// Every candidate pin is INPUT_PULLUP and never driven, so a wiring mistake
// cannot short anything from the MCU side.
#include <Arduino.h>

// ---------------------------------------------------------------------------
// Pins NOT probed, because touching them breaks the board rather than the test:
//   19, 20    native USB D-/D+ — this is the serial console itself
//   26..32    SPI flash
//   33..37    octal PSRAM
//
// Everything else is watched, including the ones a first wiring attempt is
// most likely to have used:
//   43, 44    silkscreened TX/RX — the obvious place to put two "data" wires
//   0, 3, 45, 46  strapping pins. Safe to READ after boot; the only hazard is
//                 a wire holding one low at power-on, and that hazard belongs
//                 to the wiring whether or not we watch the pin.
//   38, 48    on-board RGB LED, depending on board revision
// ---------------------------------------------------------------------------
static const uint8_t kPins[] = {0,  1,  2,  3,  4,  5,  6,  7,  8,  9,  10,
                                11, 12, 13, 14, 15, 16, 17, 18, 21, 38, 39,
                                40, 41, 42, 43, 44, 45, 46, 47, 48};
static constexpr size_t kPinCount = sizeof(kPins) / sizeof(kPins[0]);

static constexpr size_t kMaxEdges = 512;
static constexpr uint32_t kFrameGapUs = 50000;  // 50ms of quiet ends a card

struct Edge {
  uint8_t pin;
  uint8_t level;  // 0 = falling edge (a Wiegand data bit), 1 = rising
  uint32_t us;
};

static volatile Edge g_edges[kMaxEdges];
static volatile size_t g_count = 0;
static volatile uint32_t g_lastUs = 0;

// Per-pin edge totals, used to find a line that is oscillating rather than
// carrying a card. One noisy pin firing continuously starves loop() and the
// probe goes silent — which is indistinguishable from "no card", so we detect
// it and switch that pin off.
static volatile uint32_t g_perPin[64] = {0};
static bool g_detached[64] = {false};

// An ISR may only touch IRAM. digitalRead() is a flash-resident function, so
// calling it here panics the chip as soon as the cache is busy — read the GPIO
// input registers directly instead.
static inline uint8_t IRAM_ATTR fastRead(uint8_t pin) {
  return pin < 32 ? (uint8_t)((REG_READ(GPIO_IN_REG) >> pin) & 1)
                  : (uint8_t)((REG_READ(GPIO_IN1_REG) >> (pin - 32)) & 1);
}

static void IRAM_ATTR onEdge(void* arg) {
  const uint32_t now = micros();
  const uint8_t pin = (uint8_t)(uint32_t)arg;
  g_perPin[pin]++;
  const size_t n = g_count;
  if (n < kMaxEdges) {
    g_edges[n].pin = pin;
    g_edges[n].level = fastRead(pin);
    g_edges[n].us = now;
    g_count = n + 1;
  }
  g_lastUs = now;
}

// Wiegand-26: bit 0 is even parity over bits 1..12, bit 25 odd over 13..24.
static bool parity26Ok(const uint8_t* bits) {
  int even = 0, odd = 0;
  for (int i = 0; i <= 12; ++i) even += bits[i];
  for (int i = 13; i <= 25; ++i) odd += bits[i];
  return (even % 2 == 0) && (odd % 2 == 1);
}

// Try one D0/D1 assignment against the falling edges, in order.
static void tryDecode(const uint8_t* seq, size_t n, uint8_t d0, uint8_t d1) {
  uint8_t bits[kMaxEdges];
  for (size_t i = 0; i < n; ++i) {
    if (seq[i] == d1) bits[i] = 1;
    else if (seq[i] == d0) bits[i] = 0;
    else return;
  }

  uint64_t raw = 0;
  for (size_t i = 0; i < n && i < 64; ++i) raw = (raw << 1) | bits[i];

  Serial.printf("    D0=GPIO%-2u D1=GPIO%-2u -> raw 0x%llX", d0, d1,
                (unsigned long long)raw);

  if (n == 26) {
    const uint32_t body = (uint32_t)((raw >> 1) & 0xFFFFFF);
    const bool ok = parity26Ok(bits);
    Serial.printf("  facility=%u card=%u  parity %s", (unsigned)((body >> 16) & 0xFF),
                  (unsigned)(body & 0xFFFF), ok ? "OK" : "BAD");
    // Same form WiegandTagReader stores, so what you enrol matches what the
    // gate will later send.
    if (ok) Serial.printf("  uid=%06lX", (unsigned long)body);
  } else if (n == 34) {
    const uint32_t body = (uint32_t)((raw >> 1) & 0xFFFFFFFF);
    Serial.printf("  id=%lu  uid=%08lX", (unsigned long)body, (unsigned long)body);
  }
  Serial.println();
}

static void report() {
  const size_t total = g_count;

  uint16_t fall[kPinCount];
  uint16_t rise[kPinCount];
  for (size_t i = 0; i < kPinCount; ++i) { fall[i] = 0; rise[i] = 0; }

  // Only falling edges carry Wiegand bits; rising edges are the line letting
  // go afterwards. Counting them separately tells a real frame apart from a
  // noisy or inverted line.
  static uint8_t seq[kMaxEdges];
  size_t seqLen = 0;
  uint8_t seen[kPinCount];
  size_t distinct = 0;

  for (size_t i = 0; i < total; ++i) {
    for (size_t p = 0; p < kPinCount; ++p) {
      if (kPins[p] != g_edges[i].pin) continue;
      if (g_edges[i].level == 0) {
        if (fall[p]++ == 0) seen[distinct++] = kPins[p];
        if (seqLen < kMaxEdges) seq[seqLen++] = kPins[p];
      } else {
        rise[p]++;
      }
      break;
    }
  }

  Serial.printf("\n[wiegand] %u edge(s) total, %u falling:\n", (unsigned)total,
                (unsigned)seqLen);
  for (size_t p = 0; p < kPinCount; ++p) {
    if (fall[p] || rise[p]) {
      Serial.printf("    GPIO%-2u  %u falling, %u rising\n", kPins[p], fall[p],
                    rise[p]);
    }
  }

  if (distinct == 2) {
    Serial.printf("  %u bits — %s\n", (unsigned)seqLen,
                  seqLen == 26   ? "a standard Wiegand-26 frame"
                  : seqLen == 34 ? "a standard Wiegand-34 frame"
                                 : "NOT 26 or 34; a pulse was missed or a line is noisy");
    // D0/D1 cannot be told apart by counting, so decode both ways: for a
    // 26-bit frame the parity check picks the winner outright.
    tryDecode(seq, seqLen, seen[0], seen[1]);
    tryDecode(seq, seqLen, seen[1], seen[0]);
    Serial.println(
        "  -> put the assignment whose parity is OK into include/config.h as "
        "WIEGAND_D0 / WIEGAND_D1");
  } else if (distinct == 1) {
    Serial.println(
        "  Only ONE line pulsed. The other data wire is not connected, or the\n"
        "  reader and the ESP32 do not share a ground.");
  } else if (distinct > 2) {
    Serial.println(
        "  More than two pins moved — crosstalk from floating wires rather\n"
        "  than a card. Check the reader's ground is tied to the ESP32's.");
  }

  g_count = 0;
  Serial.println("[wiegand] ready — swipe again\n");
}

static void dumpLevels(const char* why) {
  Serial.printf("[probe] %s — idle levels:\n   ", why);
  for (size_t i = 0; i < kPinCount; ++i) {
    Serial.printf("%u=%c ", kPins[i], digitalRead(kPins[i]) ? 'H' : 'L');
    if ((i + 1) % 10 == 0) Serial.print("\n   ");
  }
  Serial.println();
  Serial.println(
      "   (H = idle, as a Wiegand line should sit. An L with nothing "
      "happening\n    means that wire is shorted low or the reader is off.)");
}

void setup() {
  Serial.begin(115200);
  const uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);

  // The board resets at the end of a flash and `pio device monitor` takes a
  // moment to attach, so the first thing printed is usually lost. Say it
  // repeatedly for a few seconds instead of once into a void.
  for (int i = 0; i < 6; ++i) {
    Serial.printf("\n=== Wiegand pin-finder v4 === (starting in %ds)\n", 3 - i / 2);
    delay(500);
  }

  for (size_t i = 0; i < kPinCount; ++i) pinMode(kPins[i], INPUT_PULLUP);
  delay(50);
  dumpLevels("before attaching anything");

  // Attach one pin at a time, announcing each. If a line is oscillating hard
  // enough to lock the chip up, the last pin printed is the culprit — that is
  // the one fact this ordering buys, and it cannot be got any other way.
  Serial.println("[probe] attaching interrupts one at a time:");
  for (size_t i = 0; i < kPinCount; ++i) {
    const uint8_t pin = kPins[i];
    Serial.printf("   GPIO%-2u ... ", pin);
    Serial.flush();
    g_perPin[pin] = 0;
    attachInterruptArg(digitalPinToInterrupt(pin), onEdge,
                       (void*)(uint32_t)pin, CHANGE);
    delay(120);
    const uint32_t noise = g_perPin[pin];
    if (noise > 200) {
      detachInterrupt(digitalPinToInterrupt(pin));
      g_detached[pin] = true;
      Serial.printf("NOISY (%lu edges in 120ms) — detached\n",
                    (unsigned long)noise);
    } else {
      Serial.printf("ok%s\n", noise ? " (a few edges)" : "");
    }
  }

  g_count = 0;  // discard settling edges from enabling the pullups
  Serial.println("[probe] ready — present a card to the reader");
}

void loop() {
  if (g_count > 0 && (micros() - g_lastUs) > kFrameGapUs) report();

  // Heartbeat. Without it, "nothing printed" is ambiguous between "no card
  // reached the pins" and "the probe is not running" — which is exactly the
  // question this firmware exists to answer.
  static uint32_t lastBeat = 0;
  if (millis() - lastBeat > 3000) {
    lastBeat = millis();

    // A pin that started oscillating after setup would silence the probe the
    // same way. Shut it off and name it rather than going quiet.
    for (size_t i = 0; i < kPinCount; ++i) {
      const uint8_t pin = kPins[i];
      if (g_detached[pin]) continue;
      if (g_perPin[pin] > 5000) {
        detachInterrupt(digitalPinToInterrupt(pin));
        g_detached[pin] = true;
        Serial.printf("[probe] GPIO%u is oscillating (%lu edges) — detached. "
                      "That line is floating or noisy, not a card.\n",
                      pin, (unsigned long)g_perPin[pin]);
        g_count = 0;
      }
      g_perPin[pin] = 0;
    }
    String low;
    for (size_t i = 0; i < kPinCount; ++i) {
      if (digitalRead(kPins[i]) == LOW) low += String(kPins[i]) + " ";
    }
    Serial.printf("[probe] alive %lus, edges=%u, low: %s\n",
                  (unsigned long)(millis() / 1000), (unsigned)g_count,
                  low.length() ? low.c_str() : "none");
  }
  delay(5);
}
