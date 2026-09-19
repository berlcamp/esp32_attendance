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
#include "WiegandTagReader.h"
#include "TimeSync.h"
#include "config.h"
#include "secrets.h"

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
static LittleFsStorage g_storage;
static core::EventQueue* g_queue = nullptr;
#if USE_WIEGAND_READER
static WiegandTagReader g_reader(WIEGAND_D0, WIEGAND_D1);
#else
static SimulatedTagReader g_reader;
#endif
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
static volatile uint32_t g_duplicates = 0;  // re-sends the server ignored
// Times this device has had to format its filesystem. Non-zero means queued
// scans were discarded at some boot, which must not be inferable only from a
// log line that has long since scrolled away.
static uint32_t g_fsFormats = 0;
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
      // record_attendance() returns how many rows were NEW. A shortfall means
      // duplicates were ignored, i.e. a previous batch had in fact landed and
      // we only re-sent it because the response never came back.
      const long inserted = resp.empty() ? -1 : atol(resp.c_str());
      if (inserted >= 0 && (size_t)inserted < payload.size()) {
        const unsigned dup = (unsigned)(payload.size() - inserted);
        g_duplicates += dup;
        Serial.printf(
            "[upload] %u sent, %ld inserted, %u duplicate(s) ignored, "
            "%u still queued\n",
            (unsigned)payload.size(), inserted, dup, (unsigned)depth);
      } else {
        Serial.printf("[upload] %u accepted (http %d), %u still queued\n",
                      (unsigned)payload.size(), code, (unsigned)depth);
      }
    } else {
      g_failed++;
      backoff.onFailure();
      Serial.printf("[upload] FAILED http=%d attempt=%u retry_in=%ums %s\n",
                    code, (unsigned)backoff.failures(),
                    (unsigned)backoff.delayMs(),
                    resp.empty() ? "" : resp.substr(0, 200).c_str());
      if (resp.find("PGRST106") != std::string::npos) {
        Serial.println(
            "[upload] hint: schema '" SUPABASE_SCHEMA "' is not exposed. "
            "Dashboard -> Settings -> API -> Exposed schemas -> add it.");
      } else if (resp.find("PGRST202") != std::string::npos) {
        Serial.println(
            "[upload] hint: function " SUPABASE_SCHEMA "." SUPABASE_RPC
            "() not found. Apply 0013_gate_attendance.sql in the SQL editor.");
      } else if (resp.find("unregistered or inactive gate device") !=
                 std::string::npos) {
        // Not a permissions problem despite the SQLSTATE: this device is not
        // in pta.gate_devices, so the server does not know which school its
        // scans belong to. Refusing is deliberate — the events stay on flash.
        Serial.println(
            "[upload] hint: device '" DEVICE_ID "' is not registered. Add it: "
            "insert into pta.gate_devices (device_id, school_id) values "
            "('" DEVICE_ID "', '<school uuid>');");
      } else if (resp.find("42501") != std::string::npos) {
        Serial.println(
            "[upload] hint: anon lacks EXECUTE on " SUPABASE_RPC
            "(). Re-run the grants at the bottom of 0013_gate_attendance.sql.");
      }
      if (code >= 400 && code < 500) {
        Serial.println(
            "[upload] (4xx is a config problem, not an outage — events stay "
            "queued and will flush once it is fixed.)");
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
  const size_t bytesOnFlash = g_queue->dataBytes();
  UNLOCK_QUEUE();
  Serial.printf(
      "[status] reader=%s wifi=%s ip=%s rssi=%d net=%s clock=%s queue=%u "
      "(%ub) sent=%u failed=%u dropped=%u dup=%u corrupt=%u fswipes=%u "
      "heap=%uKB up=%llds\n",
      g_reader.enabled() ? "on" : "OFF",
      WiFi.status() == WL_CONNECTED ? "up" : "down",
      WiFi.localIP().toString().c_str(), (int)WiFi.RSSI(),
      g_netEnabled ? "on" : "off", g_time.synced() ? "synced" : "UNSYNCED",
      (unsigned)depth, (unsigned)bytesOnFlash, (unsigned)g_sent,
      (unsigned)g_failed, (unsigned)g_dropped, (unsigned)g_duplicates,
      (unsigned)g_corrupt, (unsigned)g_fsFormats,
      (unsigned)(ESP.getFreeHeap() / 1024),
      (long long)TimeSync::uptimeSeconds());
}

static void printHelp() {
  Serial.println(
      "commands:\n"
      "  status            current state\n"
      "  reader off        STOP accepting scans (persists across reboot)\n"
      "  reader on         resume accepting scans\n"
      "                    aliases: sim on|off, start, stop\n"
      "  net on|off        simulate internet up/down (WiFi stays connected)\n"
      "  queue depth       pending event count\n"
      "  queue dump        print up to 20 pending events\n"
      "  queue clear       erase the queue (destructive)\n"
      "  scan <uid>        inject one scan\n"
      "  burst <n>         inject n scans (catch-up test)\n"
      "  wifi              reconnect WiFi\n"
      "  wifi scan         list nearby 2.4GHz networks (SSID bytes in hex)\n"
      "  reboot            restart the device");
}

static void handleCommand(std::string cmd) {
  while (!cmd.empty() && (cmd.back() == '\r' || cmd.back() == ' ')) cmd.pop_back();
  if (cmd.empty()) return;

  if (cmd == "help" || cmd == "?") {
    printHelp();
  } else if (cmd == "status") {
    printStatus();
  } else if (cmd == "reader off" || cmd == "sim off" || cmd == "stop") {
    // NVS key stays "sim" so an existing device keeps its saved setting.
    g_reader.setEnabled(false);
    g_prefs.putBool("sim", false);
    Serial.println(
        "[reader] STOPPED — no scans are accepted, from a real card or the "
        "simulator. Survives reboot. Resume with 'reader on'.");
  } else if (cmd == "reader on" || cmd == "sim on" || cmd == "start") {
    g_reader.setEnabled(true);
    g_prefs.putBool("sim", true);
    Serial.printf("[reader] RUNNING — %s\n",
                  USE_WIEGAND_READER ? "waiting for cards"
                                     : "one simulated scan every 10s");
  } else if (cmd == "reader" || cmd == "sim") {
    Serial.printf("[reader] %s\n", g_reader.enabled() ? "running" : "stopped");
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
  } else if (cmd == "wifi scan") {
    // The S3 radio is 2.4GHz only, so this list *is* what the device can join.
    // SSIDs print with their bytes because a curly apostrophe from an iPhone
    // name looks identical to a straight one in secrets.h and never matches.
    Serial.printf("[wifi] radio mac=%s status=%d, scanning...\n",
                  WiFi.macAddress().c_str(), (int)WiFi.status());
    // A failing WiFi.begin() leaves the radio in a permanent internal scan for
    // the configured SSID, and that rejects ours with WIFI_SCAN_FAILED. Drop
    // the connect attempt first, then restore it below.
    WiFi.disconnect(false, true);
    delay(200);
    const int n = WiFi.scanNetworks(false, true);
    if (n == WIFI_SCAN_FAILED) {
      Serial.println("[wifi] scan FAILED (-2) — radio did not start");
    } else if (n == WIFI_SCAN_RUNNING) {
      Serial.println("[wifi] scan still running (-1)");
    } else if (n == 0) {
      Serial.println("[wifi] 0 networks in range — check the antenna");
    } else {
      Serial.printf("[wifi] %d network(s), looking for \"%s\"\n", n, WIFI_SSID);
      for (int i = 0; i < n; i++) {
        const String ssid = WiFi.SSID(i);
        Serial.printf("  %-32s ch=%-3d rssi=%-4d enc=%d %s bytes=", ssid.c_str(),
                      WiFi.channel(i), WiFi.RSSI(i), (int)WiFi.encryptionType(i),
                      ssid == WIFI_SSID ? "<== MATCH" : "         ");
        for (size_t b = 0; b < ssid.length(); b++)
          Serial.printf("%02x ", (uint8_t)ssid[b]);
        Serial.println();
      }
    }
    WiFi.scanDelete();
    wifiConnect();
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

  // NOT begin(true). formatOnFail wipes the pending queue without a word,
  // so a filesystem hiccup looks identical to "there was nothing queued" —
  // which is how a backlog can vanish unnoticed. A gate still has to come up,
  // so we do format, but only after saying so, and the count is persisted so
  // the loss stays visible in `status` long after the boot log has scrolled.
  if (!LittleFS.begin(false)) {
    g_fsFormats = g_prefs.getUInt("fsfmt", 0) + 1;
    g_prefs.putUInt("fsfmt", g_fsFormats);
    // A first boot on a virgin partition lands here too, where nothing is
    // lost. We cannot tell that apart from corruption, so say what is true of
    // both rather than crying wolf or under-reporting a real wipe.
    Serial.println(
        "[fs] *** MOUNT FAILED. Anything queued on flash is unreadable and "
        "will be discarded. On a first boot that is nothing; otherwise it is "
        "your pending scans. ***");
    Serial.printf("[fs] *** formatting (this is wipe #%u on this device) ***\n",
                  (unsigned)g_fsFormats);
    if (!LittleFS.begin(true)) {
      Serial.println("[fs] FATAL: format failed too");
      delay(5000);
      ESP.restart();
    }
  } else {
    g_fsFormats = g_prefs.getUInt("fsfmt", 0);
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
  Serial.printf(
      "[queue] recovered %u pending event(s), %u byte(s) on flash, cursor=%u\n",
      (unsigned)g_queue->pending(), (unsigned)g_queue->dataBytes(),
      (unsigned)g_queue->cursor());

  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  const bool simOn = g_prefs.getBool("sim", true);
  g_reader.setEnabled(simOn);
  Serial.printf("[reader] %s (change with 'reader on' / 'reader off')\n",
                simOn ? (USE_WIEGAND_READER ? "LIVE — waiting for cards"
                                           : "SIMULATED — one scan every 10s")
                      : "STOPPED — no scans accepted");

  wifiConnect();
  g_time.begin();

  xTaskCreatePinnedToCore(readerTask, "reader", 6144, nullptr, 2, nullptr, 0);
  xTaskCreatePinnedToCore(uploaderTask, "uploader", 12288, nullptr, 1, nullptr, 1);

  printHelp();
  Serial.print("> ");
}

void loop() {
  esp_task_wdt_reset();

  // Echo typed characters back: a USB serial terminal shows nothing at all
  // otherwise, so you cannot see what you are typing or whether it landed.
  static std::string line;
  while (Serial.available()) {
    const char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (!line.empty()) {
        Serial.println();
        handleCommand(line);
        Serial.print("> ");
      }
      line.clear();
    } else if (c == 8 || c == 127) {  // backspace / delete
      if (!line.empty()) {
        line.pop_back();
        Serial.print("\b \b");
      }
    } else if (c >= 32 && line.size() < 128) {
      line += c;
      Serial.write(c);
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
