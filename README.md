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
2. **Run the SQL**, in order: `sql/schema.sql`, then `sql/rpc.sql`, then
   `sql/seed.sql` for the nine simulated students. Add `sql/notify.sql` if you
   want the Telegram notifications described below.
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
| `status` | sim / wifi / clock / queue depth / counters |
| `sim off` (or `stop`) | **stop generating scans.** Persists across reboot and power cycles |
| `sim on` (or `start`) | resume, one scan every 10s |
| `net off` \| `net on` | simulate the internet dropping. WiFi stays connected, so this is reproducible in one keystroke |
| `queue depth` \| `queue dump` \| `queue clear` | inspect or wipe the pending queue |
| `scan <uid>` | inject one scan |
| `burst <n>` | inject n scans with unique UIDs — the catch-up test |
| `wifi` | force reconnect |
| `reboot` | restart |

### Stopping and starting the simulation

`sim off` is the real off-switch: no new scans are created at all, and the
choice is stored in NVS so a reboot or power cycle does not silently restart
it. `net off` is a different thing — it simulates an *outage*, so scans keep
being generated and pile up on flash to be flushed later.

`scan <uid>` and `burst <n>` still work while stopped, so you can hand-feed
individual events without the 10s generator running.

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
and the primary key, and `mvts_esp32.record_attendance()` inserts with
`ON CONFLICT (event_id) DO NOTHING`. Retries can never create a duplicate row.

**The device has no table privileges.** It posts batches to the SECURITY
DEFINER function `record_attendance()` and holds `EXECUTE` on that alone — no
`INSERT`, no `SELECT`, on any table. Going through PostgREST's upsert directly
would have required `GRANT SELECT ON attendance TO anon` (Postgres needs SELECT
to infer an `ON CONFLICT` target), which would put every student's movement
history one accidental policy away from the public anon key.

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

## Telling parents

`sql/notify.sql` plus `supabase/functions/` send a guardian a photo and a
timestamp when their child passes the gate. The device is not involved and
holds no new credentials.

```
tap -> capture -> queue -> Supabase Storage + record_attendance()
                                     |
                        Database Webhook on INSERT
                                     |
                         notify-guardian Edge Function
                                     |
                        claim_notifications() -> Telegram
```

**The bot token never goes near the device.** Flash is readable over USB. The
anon key survives that because RLS limits it to one append-only RPC; a bot
token has no such containment — whoever reads it can message every parent as
the school, and read every reply. So the fan-out runs server-side, and the
firmware's credentials do not change at all.

**A replayed webhook must not re-message anyone.** `notifications` is keyed on
`(event_id, guardian_id)` and `claim_notifications()` returns only the rows it
newly inserted, so a webhook that fires twice hands the sender nothing the
second time. It is the same `ON CONFLICT DO NOTHING` trick as
`record_attendance()`, moved from *rows written* to *messages sent*. A
duplicate attendance row is invisible; a duplicate "Ana arrived at school" at
11pm is how parents stop trusting the system.

**A three-hour outage must not page 200 parents at 4pm.** The device is built
to queue through an outage and flush, which means a naive notifier announces a
morning's arrivals at dinner time. `notify_config` holds the rule, in SQL,
in one place: under 15 minutes late it sends normally, under two hours it
sends and says it was delayed, beyond that it records the notification as
`suppressed` and sends nothing. The sweeper re-measures too, so a message
stuck failing for four hours is dropped rather than finally going out claiming
the gate was "20 minutes late".

**A guardian can only be reached if they made contact first.** Telegram bots
cannot start a conversation — the API answers `Forbidden: bot can't initiate
conversation with a user`. `issue_enroll_token()` mints a single-use token for
a `https://t.me/<bot>?start=<token>` QR on the enrolment slip;
`telegram-webhook` redeems it and stores the `chat_id`. Expect roughly 70% of
parents to complete it, so plan for an unlinked-guardian list in the dashboard.

**Photographs of minors are not kept forever.** Attendance rows are; captures
are not. `notify_config.capture_retention_days` (default 30) drives
`expired_captures()`. Collect written consent at enrolment — `/stop` in the bot
sets `student_guardians.notify = false`, so the opt-out you promise on paper
does something real.

### Deploying it

```bash
./scripts/setup-telegram.sh
```

Eight stages: install and link the Supabase CLI, create the bot with
@BotFather, generate the shared secrets, deploy both functions, register the
Telegram webhook, add the Database Webhook, link yourself as a test guardian,
then fire a fake scan and wait for your phone to buzz. It is re-runnable —
secrets are kept in a gitignored `.env.notify` rather than rotated.

The wizard exists because two secrets each have to match in two places
(`WEBHOOK_SECRET` in Supabase *and* the webhook header; `TELEGRAM_WEBHOOK_SECRET`
in Supabase *and* `setWebhook`), and a mismatch surfaces as a silent 403 in the
function logs rather than an error anywhere you are looking.

By hand instead:

```bash
supabase functions deploy notify-guardian  --no-verify-jwt
supabase functions deploy telegram-webhook --no-verify-jwt
supabase secrets set TELEGRAM_BOT_TOKEN=... WEBHOOK_SECRET=... \
                     TELEGRAM_WEBHOOK_SECRET=... SCHOOL_NAME="..."
```

Then point Telegram at the bot webhook:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://<ref>.supabase.co/functions/v1/telegram-webhook",
       "secret_token":"<TELEGRAM_WEBHOOK_SECRET>",
       "allowed_updates":["message"]}'
```

and add a Database Webhook (Dashboard → Integrations → Database Webhooks) on
INSERT into `mvts_esp32.attendance`, POSTing to `notify-guardian` with header
`x-webhook-secret` — a custom header, not `Authorization`, which Studio has a
known bug about silently dropping on save. The `pg_cron` sweeper for failed sends is in the comment
above `retry_notifications()`.

### Testing it without a board or a bot

```bash
docker run -d --rm --name gatepg -e POSTGRES_PASSWORD=pw -p 55433:5432 postgres:16
PGPASSWORD=pw psql -h localhost -p 55433 -U postgres -v ON_ERROR_STOP=1 \
  -f sql/test_bootstrap.sql -f sql/schema.sql -f sql/rpc.sql \
  -f sql/seed.sql -f sql/notify.sql -f sql/test_notify.sql
docker stop gatepg
```

15 checks covering dedupe, the staleness thresholds, opt-out, retry with
`FOR UPDATE SKIP LOCKED`, the attempt ceiling, token single-use, and retention.

## Layout

```
lib/core/         pure C++, no Arduino — EventQueue, ScanEvent, Backoff, Storage
                  (this is what `pio test -e native` exercises)
src/              firmware — tasks, WiFi, TLS, LittleFS backend, console, LED
include/config.h  cadence, roster, batch size, caps, thresholds
sql/              schema + seed + guardian notifications (notify.sql) and
                  their Postgres tests (test_notify.sql)
supabase/functions/
                  notify-guardian  — fans one scan out to Telegram
                  telegram-webhook — guardian enrolment via /start deep link
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

The gate ships reading a simulated roster. Going live is three steps: find the
pins, flip a switch, enrol the cards.

### 1. Find which pins the reader is on

Wiegand is one-way and has no identity to query — the reader just pulses two
lines when a card passes. So you find the pins by watching all of them:

```bash
pio run -e wiegand-probe -t upload
pio device monitor
```

Swipe a card. The probe watches every GPIO that is safe to touch on this board
(USB, flash, PSRAM and strapping pins are excluded) and reports which two moved:

```
[wiegand] 26 pulse(s) across 2 pin(s):
    GPIO4   9 pulse(s)
    GPIO5  17 pulse(s)
  26 bits — a standard Wiegand-26 frame
    D0=GPIO4  D1=GPIO5  -> raw 0x2004A1B  facility=4 card=41243  parity OK  uid=04A1B2
```

D0 and D1 cannot be told apart by counting pulses, so the probe decodes both
ways round; for a 26-bit frame the parity check picks the correct one.

**Wire D0/D1 through a level shifter.** These readers are usually 12V parts that
idle their data lines at 5V, and the ESP32-S3 is 3.3V-tolerant only. Reader
ground must be tied to the ESP32's, or the pulses have no reference.

### 2. Flip the switch

In `include/config.h`, using the pins the probe reported:

```c
#define USE_WIEGAND_READER 1
#define WIEGAND_D0 4
#define WIEGAND_D1 5
```

```bash
pio run -e esp32s3 -t upload
```

`WiegandTagReader` decodes 26- and 34-bit frames, rejects any frame that fails
its parity check, and emits the card's facility+number as uppercase hex — the
same UID the probe printed. Nothing downstream changes: the queue, the uploader,
the notifications and the dashboard only ever see a UID string.

`sim on` / `sim off` still gate the reader, and `scan <uid>` still injects one by
hand, which is how you exercise the upload path with no card present.

### 3. Enrol the cards

Open **/enroll** on the dashboard. Tap a card on the gate; it appears under
*Unassigned cards* within a few seconds, because the gate records every scan
whether it recognises the card or not. Pick an existing student or type a new
name, and press *Assign card*.

Reassigning a card that someone else held retires the old mapping rather than
overwriting it, so last term's attendance still resolves to whoever actually
carried that card that day. The `×` next to a card retires it — for a card that
is lost or broken.

When you are finished with the simulator, `sql/reset_demo.sql` clears the nine
seeded students and every simulated scan. It is destructive; read it first.
