// ESP32-S3 RFID Attendance Gate — simulated reader, real network path.
//
// Two FreeRTOS tasks share a durable on-flash queue:
//   reader   (core 0)  appends scans. Never blocks on the network.
//   uploader (core 1)  drains to Supabase. May block for seconds on TLS.
//
// The split exists so a student is never missed because the uploader happened
// to be mid-handshake — the failure mode that makes an attendance system
// quietly untrustworthy.
#include <Arduino.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_random.h>
#include <esp_system.h>
#include <esp_task_wdt.h>

#include <map>
#include <string>
#include <vector>

#include "Backoff.h"
#include "EventQueue.h"
#include "LittleFsStorage.h"
#include "ScanEvent.h"
#include "StatusLed.h"
#include "SupabaseClient.h"
#include "TagReader.h"
#include "TimeSync.h"
#include "config.h"
#include "secrets.h"

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
static LittleFsStorage g_storage;
static core::EventQueue* g_queue = nullptr;
static SimulatedTagReader g_reader;
static TimeSync g_time;
static SupabaseClient g_supa;
static Preferences g_prefs;

static SemaphoreHandle_t g_queueMutex = nullptr;

// The Q6 kill-switch: gates HTTP only, leaving WiFi up, so "internet down" is
// reproducible in one serial command instead of a trip to the router.
static volatile bool g_netEnabled = true;

static volatile uint32_t g_sent = 0;
static volatile uint32_t g_failed = 0;
static volatile uint32_t g_dropped = 0;   // queue-full rejections
static volatile uint32_t g_corrupt = 0;   // unparseable queue lines
static volatile bool g_online = false;

#define LOCK_QUEUE() xSemaphoreTake(g_queueMutex, portMAX_DELAY)
#define UNLOCK_QUEUE() xSemaphoreGive(g_queueMutex)

// ---------------------------------------------------------------------------
static std::string uuid4() {
  uint8_t b[16];
  esp_fill_random(b, sizeof(b));
  b[6] = (b[6] & 0x0F) | 0x40;  // version 4
  b[8] = (b[8] & 0x3F) | 0x80;  // variant 1
  char out[37];
  snprintf(out, sizeof(out),
           "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
           b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10],
           b[11], b[12], b[13], b[14], b[15]);
  return std::string(out);
}

static void wifiConnect() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// ---------------------------------------------------------------------------
// Reader task — core 0
// ---------------------------------------------------------------------------
static void readerTask(void*) {
  esp_task_wdt_add(NULL);
  std::map<std::string, uint32_t> lastSeen;
  g_reader.begin();

  for (;;) {
    esp_task_wdt_reset();

    std::string uid;
    if (g_reader.poll(uid)) {
      const uint32_t now = millis();
      auto it = lastSeen.find(uid);
      if (it != lastSeen.end() && (now - it->second) < CARD_COOLDOWN_MS) {
        // Same human, two swipes. Dropped at the reader, never queued.
        Serial.printf("[scan] %s ignored (cooldown)\n", uid.c_str());
      } else {
        lastSeen[uid] = now;

        core::ScanEvent ev;
        ev.eventId = uuid4();
        ev.cardUid = uid;
        ev.deviceId = DEVICE_ID;
        ev.clockSynced = g_time.synced();
        // Unsynced clock -> store negated uptime; rebuilt at flush time.
        ev.stamp = ev.clockSynced ? TimeSync::nowEpoch()
                                  : -TimeSync::uptimeSeconds();

        const std::string line = core::buildQueueLine(ev);
        LOCK_QUEUE();
        const bool ok = g_queue->push(line);
        const size_t depth = g_queue->pending();
        UNLOCK_QUEUE();

        if (ok) {
          ledBlip();
          Serial.printf("[scan] %s queued (depth=%u)\n", uid.c_str(),
                        (unsigned)depth);
        } else {
          g_dropped++;
          Serial.printf(
              "[scan] *** QUEUE FULL (%u events) — DROPPED scan %s. "
              "Oldest events are kept; newest are refused. ***\n",
              (unsigned)depth, uid.c_str());
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

// ---------------------------------------------------------------------------
// Uploader task — core 1
// ---------------------------------------------------------------------------
static void uploaderTask(void*) {
  esp_task_wdt_add(NULL);
  core::Backoff backoff(BACKOFF_BASE_MS, BACKOFF_MAX_MS);
  uint32_t lastWifiTry = 0;
  g_supa.begin();

  for (;;) {
    esp_task_wdt_reset();

    if (WiFi.status() != WL_CONNECTED) {
      g_online = false;
      if (millis() - lastWifiTry > WIFI_RETRY_MS) {
        lastWifiTry = millis();
        WiFi.reconnect();
      }
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }

    // Offline is a NORMAL state for a school gate. We sit here queueing
    // happily; we do not reboot our way through it.
    if (!g_netEnabled) {
      g_online = false;
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }

    // No trustworthy clock -> no TLS validation -> keep queueing, don't fall
    // back to an unverified connection.
    if (!g_time.synced()) {
      g_online = false;
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }
    g_online = true;

    size_t consumed = 0;
    LOCK_QUEUE();
    std::vector<std::string> batch = g_queue->peek(UPLOAD_BATCH_SIZE, consumed);
    UNLOCK_QUEUE();

    if (batch.empty()) {
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }

    const int64_t now = TimeSync::nowEpoch();
    std::vector<std::string> payload;
    payload.reserve(batch.size());
    for (const std::string& line : batch) {
      std::string obj =
          core::finalizeForUpload(line, now, g_time.bootEpoch(), LATE_AFTER_S);
      if (obj.empty()) {
        g_corrupt++;  // consumed anyway, or the queue would wedge forever
        continue;
      }
      payload.push_back(obj);
    }

    if (payload.empty()) {
      Serial.printf("[upload] dropping %u unparseable line(s)\n",
                    (unsigned)batch.size());
      LOCK_QUEUE();
      g_queue->commit(consumed, batch.size());
      UNLOCK_QUEUE();
      continue;
    }

    // HTTP happens OUTSIDE the mutex: the reader must keep accepting scans
    // while this blocks. Appends do not disturb the cursor we already read.
    std::string resp;
    const int code = g_supa.postBatch(payload, resp);

    if (code >= 200 && code < 300) {
      LOCK_QUEUE();
      g_queue->commit(consumed, batch.size());
      const size_t depth = g_queue->pending();
      UNLOCK_QUEUE();
      g_sent += payload.size();
      backoff.onSuccess();
      Serial.printf("[upload] %u accepted (http %d), %u still queued\n",
                    (unsigned)payload.size(), code, (unsigned)depth);
    } else {
      g_failed++;
      backoff.onFailure();
      Serial.printf("[upload] FAILED http=%d attempt=%u retry_in=%ums %s\n",
                    code, (unsigned)backoff.failures(),
                    (unsigned)backoff.delayMs(),
                    resp.empty() ? "" : resp.substr(0, 200).c_str());
      if (resp.find("PGRST106") != std::string::npos || code == 404 ||
          code == 406) {
        Serial.println(
            "[upload] hint: schema '" SUPABASE_SCHEMA "' is not exposed. "
            "Supabase Dashboard -> Settings -> API -> Exposed schemas -> add it, "
            "then run sql/schema.sql. Queued events will flush automatically.");
      }
      vTaskDelay(pdMS_TO_TICKS(backoff.delayMs()));
    }
  }
}

// ---------------------------------------------------------------------------
// Serial console
// ---------------------------------------------------------------------------
static void printStatus() {
  LOCK_QUEUE();
  const size_t depth = g_queue->pending();
  UNLOCK_QUEUE();
  Serial.printf(
      "[status] wifi=%s ip=%s rssi=%d net=%s clock=%s queue=%u sent=%u "
      "failed=%u dropped=%u corrupt=%u heap=%uKB up=%llds\n",
      WiFi.status() == WL_CONNECTED ? "up" : "down",
      WiFi.localIP().toString().c_str(), (int)WiFi.RSSI(),
      g_netEnabled ? "on" : "off", g_time.synced() ? "synced" : "UNSYNCED",
      (unsigned)depth, (unsigned)g_sent, (unsigned)g_failed,
      (unsigned)g_dropped, (unsigned)g_corrupt,
      (unsigned)(ESP.getFreeHeap() / 1024),
      (long long)TimeSync::uptimeSeconds());
}

static void printHelp() {
  Serial.println(
      "commands:\n"
      "  status            current state\n"
      "  net on|off        simulate internet up/down (WiFi stays connected)\n"
      "  queue depth       pending event count\n"
      "  queue dump        print up to 20 pending events\n"
      "  queue clear       erase the queue (destructive)\n"
      "  scan <uid>        inject one scan\n"
      "  burst <n>         inject n scans (catch-up test)\n"
      "  wifi              reconnect WiFi\n"
      "  reboot            restart the device");
}

static void handleCommand(std::string cmd) {
  while (!cmd.empty() && (cmd.back() == '\r' || cmd.back() == ' ')) cmd.pop_back();
  if (cmd.empty()) return;

  if (cmd == "help" || cmd == "?") {
    printHelp();
  } else if (cmd == "status") {
    printStatus();
  } else if (cmd == "net off") {
    g_netEnabled = false;
    Serial.println("[net] OFF — scans will queue to flash");
  } else if (cmd == "net on") {
    g_netEnabled = true;
    Serial.println("[net] ON — uploader will drain the queue");
  } else if (cmd == "queue depth") {
    LOCK_QUEUE();
    Serial.printf("[queue] pending=%u cursor=%u\n", (unsigned)g_queue->pending(),
                  (unsigned)g_queue->cursor());
    UNLOCK_QUEUE();
  } else if (cmd == "queue dump") {
    size_t consumed = 0;
    LOCK_QUEUE();
    std::vector<std::string> lines = g_queue->peek(20, consumed);
    UNLOCK_QUEUE();
    for (const std::string& l : lines) Serial.println(l.c_str());
    Serial.printf("[queue] %u shown\n", (unsigned)lines.size());
  } else if (cmd == "queue clear") {
    LOCK_QUEUE();
    g_queue->clear();
    UNLOCK_QUEUE();
    Serial.println("[queue] cleared");
  } else if (cmd.rfind("scan ", 0) == 0) {
    g_reader.inject(cmd.substr(5));
    Serial.printf("[scan] injected %s\n", cmd.substr(5).c_str());
  } else if (cmd.rfind("burst ", 0) == 0) {
    const int n = atoi(cmd.substr(6).c_str());
    g_reader.injectBurst(n > 0 ? n : 0);
    Serial.printf("[scan] injected burst of %d\n", n);
  } else if (cmd == "wifi") {
    wifiConnect();
    Serial.println("[wifi] reconnecting");
  } else if (cmd == "reboot") {
    Serial.println("[sys] rebooting");
    delay(100);
    ESP.restart();
  } else {
    Serial.printf("unknown command: %s (try 'help')\n", cmd.c_str());
  }
}

// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  const uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);

  statusLed(GateState::Boot);
  Serial.println("\n=== RFID Attendance Gate (" DEVICE_ID ") ===");

  g_prefs.begin("gate", false);
  const uint32_t boots = g_prefs.getUInt("boots", 0) + 1;
  g_prefs.putUInt("boots", boots);
  Serial.printf("[sys] boot #%u, last reset reason=%d, flash=%uMB, psram=%uKB\n",
                (unsigned)boots, (int)esp_reset_reason(),
                (unsigned)(ESP.getFlashChipSize() / (1024 * 1024)),
                (unsigned)(ESP.getPsramSize() / 1024));

  if (!LittleFS.begin(true)) {
    Serial.println("[fs] FATAL: LittleFS mount failed");
    delay(5000);
    ESP.restart();
  }
  Serial.printf("[fs] littlefs %uKB used of %uKB\n",
                (unsigned)(LittleFS.usedBytes() / 1024),
                (unsigned)(LittleFS.totalBytes() / 1024));

  g_queueMutex = xSemaphoreCreateMutex();

  core::QueueConfig qcfg;
  qcfg.maxEvents = QUEUE_MAX_EVENTS;
  qcfg.compactAfterBytes = QUEUE_COMPACT_BYTES;
  static core::EventQueue queue(g_storage, qcfg);
  g_queue = &queue;
  g_queue->begin();
  Serial.printf("[queue] recovered %u pending event(s) from flash\n",
                (unsigned)g_queue->pending());

  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  wifiConnect();
  g_time.begin();

  xTaskCreatePinnedToCore(readerTask, "reader", 6144, nullptr, 2, nullptr, 0);
  xTaskCreatePinnedToCore(uploaderTask, "uploader", 12288, nullptr, 1, nullptr, 1);

  printHelp();
}

void loop() {
  esp_task_wdt_reset();

  static std::string line;
  while (Serial.available()) {
    const char c = (char)Serial.read();
    if (c == '\n') {
      handleCommand(line);
      line.clear();
    } else if (line.size() < 128) {
      line += c;
    }
  }

  static uint32_t lastStatus = 0;
  static uint8_t lowHeapTicks = 0;
  if (millis() - lastStatus > STATUS_PERIOD_MS) {
    lastStatus = millis();
    printStatus();

    LOCK_QUEUE();
    const size_t depth = g_queue->pending();
    UNLOCK_QUEUE();
    if (WiFi.status() != WL_CONNECTED) {
      statusLed(GateState::NoWifi);
    } else if (!g_online || depth > 0) {
      statusLed(GateState::Queueing);
    } else {
      statusLed(GateState::Online);
    }

    if (ESP.getFreeHeap() < MIN_FREE_HEAP) {
      if (++lowHeapTicks >= 3) {
        Serial.println("[sys] heap exhausted — restarting");
        delay(100);
        ESP.restart();
      }
    } else {
      lowHeapTicks = 0;
    }
  }

  delay(20);
}
