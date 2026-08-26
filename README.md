# RFID Attendance Gate — ESP32-S3 simulation

Firmware for a school-gate attendance reader. The RFID reader is currently
**simulated** (one student every 10 seconds); everything downstream of it —
WiFi, TLS, the durable offline queue, Supabase inserts — is real.

Hardware in use: **ESP32-S3** (rev 0.2), 16MB flash, 8MB octal PSRAM, native
USB-Serial/JTAG on `/dev/cu.usbmodem101`.

---

## Before it can send anything

1. **Expose the schema.** Supabase Dashboard → **Settings → API → Exposed
   schemas** → add `mvts_esp32`. Until you do, every POST returns
   `406 PGRST106` and the device just keeps queueing.
2. **Run the SQL.** SQL Editor → paste `sql/schema.sql`, run it. Then
   `sql/seed.sql` for the nine simulated students.
3. Copy `include/secrets.h.example` → `include/secrets.h` and fill it in.
   `secrets.h` is gitignored.

## Build / flash / watch

```bash
pio run -e esp32s3 -t upload     # build + flash
pio device monitor               # 115200, native USB
pio test -e native               # queue + timestamp tests, on the Mac, no board
```

## Serial commands

| command | effect |
|---|---|
| `status` | wifi / clock / queue depth / counters |
| `net off` \| `net on` | simulate the internet dropping. WiFi stays connected, so this is reproducible in one keystroke |
| `queue depth` \| `queue dump` \| `queue clear` | inspect or wipe the pending queue |
| `scan <uid>` | inject one scan |
| `burst <n>` | inject n scans with unique UIDs — the catch-up test |
| `wifi` | force reconnect |
| `reboot` | restart |

### Testing the offline path

```
queue clear
net off
burst 200        # 200 scans pile up on flash
queue depth
net on           # watch it drain in batches of 50
```
Pull the USB cable while offline and plug it back in — the queue is still there.

---

## How it works

```
 SimulatedTagReader ──► reader task (core 0) ──► LittleFS queue ──► uploader task (core 1) ──► Supabase
      (ITagReader)          appends only         /queue.jsonl          drains, batches of 50
                                                 /queue.cur
```

**Two tasks, on purpose.** A TLS handshake on a bad network can block for
seconds. If scanning and uploading shared a thread, a student walking through
during that window would simply not be recorded — the failure mode that makes
an attendance system quietly untrustworthy. The reader only ever appends; the
uploader only ever drains; the HTTP call happens outside the queue mutex.

**Nothing is deleted until Supabase says yes.** The queue advances a persisted
cursor only after a 2xx. A crash between "Postgres inserted" and "cursor saved"
re-sends the batch, which is harmless: `event_id` is a client-generated UUID
and the primary key, and inserts use `Prefer: resolution=ignore-duplicates`
(`ON CONFLICT DO NOTHING`). Retries can never create a duplicate attendance row.

**Timestamps are honest about themselves.** The S3 has no battery-backed RTC,
so after a power cut it boots believing it is 1970. Scans taken before NTP
lands are stored against uptime and reconstructed at flush time from
`boot_epoch + uptime`; those rows carry `clock_synced = false` so the web app
can tell an inferred time from a measured one. Every row also has `received_at`
(server `now()`) and `queued` (true if it arrived more than 15s late), so a
three-hour outage doesn't make a morning's students all look like they arrived
at once.

**Certificates are verified.** Against the full ESP-IDF root CA bundle, not a
pinned root (which would brick the device when Supabase rotates certs) and not
`setInsecure()` (which would let anyone on the gate's network inject fake
attendance). Because cert validation needs a plausible clock, HTTPS stays gated
until SNTP produces a time past 2025-01-01. Before that, scans keep queueing.

**Being offline is normal, not an error.** The device sits there queueing for
days with backoff capped at 60s. It does not reboot its way through an outage.
The watchdog is for genuine wedges only.

**Overflow drops the newest.** Cap is 20,000 events (~weeks). On overflow the
*new* scan is refused and logged loudly — the oldest events are the ones you'll
be asked about later, so they are never silently discarded.

## Layout

```
lib/core/         pure C++, no Arduino — EventQueue, ScanEvent, Backoff, Storage
                  (this is what `pio test -e native` exercises)
src/              firmware — tasks, WiFi, TLS, LittleFS backend, console, LED
include/config.h  cadence, roster, batch size, caps, thresholds
sql/              schema + seed
test/test_queue/  host tests: FIFO, restart, replay-after-crash, overflow,
                  compaction, interrupted compaction, clock reconstruction
```

## Status LED

green = online and drained · amber = queueing · red = no WiFi · blue = booting

## Known limits (deliberate)

- **One reader means one direction.** A row records *"a card passed the gate"*,
  not *"a student was present"*. `direction` is reserved and always `'in'`;
  deriving attendance from first-scan-of-day is a rule your app applies.
- The anon key is in the firmware image and flash is readable over USB. That is
  acceptable only because RLS limits that key to `INSERT` on one table. Moving
  to an Edge Function with a per-device secret is the next hardening step.
- No OTA yet — but the partition slot is reserved, because repartitioning later
  would erase the filesystem, and the filesystem is the queue.

## Swapping in a real RFID reader

Implement `ITagReader` for the MFRC522 and construct it instead of
`SimulatedTagReader` in `src/main.cpp`. Nothing else changes — the queue,
uploader, dedupe, and timestamps have no idea where UIDs come from.
