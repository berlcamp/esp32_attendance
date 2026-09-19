# RFID Attendance Gate — ESP32-S3

Firmware for a school-gate attendance reader, plus the board that shows it.

The roster is **not this project's**. Students, guardians and school years come
from **PTA Collections** (`~/Documents/GithubBuilds/pta-collections`), which
shares the same Supabase project. The gate adds cards and taps to that database
and owns nothing about who a student is. A student enrolled in PTA Collections
is at the gate immediately; there is no second list to keep in step.

Hardware in use: **ESP32-S3** (rev 0.2), 16MB flash, 8MB octal PSRAM, native
USB-Serial/JTAG on `/dev/cu.usbmodem101`.

---

## Before it can send anything

1. **Apply the schema.** The gate's tables live in the `pta` schema and are
   defined in one migration, in the other repo:
   `../../pta-collections/supabase/migrations/0013_gate_attendance.sql`.
   Paste it into the Supabase SQL Editor. Never `supabase db push` — the
   project is shared with two other apps and a push proposes dropping their
   objects.
2. **Register the gate.** Edit the school code at the top of `sql/cutover.sql`
   and run it. That inserts the `pta.gate_devices` row which maps `DEVICE_ID`
   to a school; without it `record_attendance()` refuses every batch and the
   device just keeps queueing.
3. Copy `include/secrets.h.example` → `include/secrets.h` and fill it in.
   `secrets.h` is gitignored.
4. For the dashboard, copy `web/.env.local.example` → `web/.env.local`.

`pta` is already listed under **Settings → API → Exposed schemas** for PTA
Collections. If it ever is not, every POST returns `404 PGRST106`.

## Build / flash / watch

```bash
pio run -e esp32s3 -t upload     # build + flash
pio device monitor               # 115200, native USB
pio test -e native               # queue + timestamp tests, on the Mac, no board
```

## Serial commands

| command | effect |
|---|---|
| `status` | reader / wifi / clock / queue depth / counters |
| `reader off` | **stop accepting scans.** Persists across reboot and power cycles |
| `reader on` | resume |
| `net off` \| `net on` | simulate the internet dropping. WiFi stays connected, so this is reproducible in one keystroke |
| `queue depth` \| `queue dump` \| `queue clear` | inspect or wipe the pending queue |
| `scan <uid>` | inject one scan |
| `burst <n>` | inject n scans with unique UIDs — the catch-up test |
| `wifi` | force reconnect |
| `reboot` | restart |

### Stopping and starting the reader

`reader off` is the real off-switch: no scans are accepted at all — from a real
card or from the simulator — and the choice is stored in NVS so a reboot, a
power cycle, *or a reflash* does not silently restart it.

That persistence bites if you forget it. A device left on `reader off` will
ignore real cards after you fit the hardware and reflash, looking for all the
world like a wiring fault. `status` shows `reader=OFF` when this is why.

`sim on` / `sim off` / `start` / `stop` are kept as aliases, since the switch
was called that back when the only scan source was the simulator.

`net off` is a different thing — it simulates an *outage*, so scans keep being
generated and pile up on flash to be flushed later.

`scan <uid>` and `burst <n>` still work while stopped, so you can hand-feed
individual events without the generator running.

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
and the primary key, and `pta.record_attendance()` inserts with
`ON CONFLICT (event_id) DO NOTHING`. Retries can never create a duplicate row.

**The device has no table privileges.** It posts batches to the SECURITY
DEFINER function `record_attendance()` and holds `EXECUTE` on that alone — no
`INSERT`, no `SELECT`, on any table. Going through PostgREST's upsert directly
would have required `GRANT SELECT ON attendance TO anon` (Postgres needs SELECT
to infer an `ON CONFLICT` target), which would put every student's movement
history one accidental policy away from the public anon key.

**The device cannot say which school it is at.** It sends `DEVICE_ID` and
nothing else about where it is; `pta.gate_devices` maps that to a school and
`record_attendance()` stamps `school_id` from there. The database is now
multi-tenant, so "trust the device's claim" would mean a stolen anon key could
write attendance into any school in the system. An unregistered device is
refused outright rather than skipped — refusing leaves the events safe on flash,
whereas skipping would destroy them while reporting success.

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

`supabase/functions/` plus the trigger in `sql/webhook.sql` send a guardian a
photo and a timestamp when their child passes the gate. Guardians are PTA
Collections' `parents_guardians` rows; the gate only adds a `telegram_chat_id`
to them. The device is not involved and holds no new credentials.

```
tap -> capture -> queue -> Supabase Storage + record_attendance()
                                     |
                        pg_net trigger on INSERT
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

**The camera is not wired up yet, and the notifier already knows it.** A scan
with no `image_path` is sent as text — the designed path, and the only one a
live school should see. To *preview* the photo message before the hardware
exists, set `SAMPLE_PHOTO` to a URL Telegram can fetch, or to an object path in
the capture bucket:

```bash
supabase secrets set SAMPLE_PHOTO="https://placehold.co/640x480.jpg?text=Gate+Camera+Sample"
```

Every photo-less scan then arrives as a picture, captioned with the same
arrival line plus *"Sample image — the gate camera is not installed yet"*. The
label is not optional and is not a setting: a parent opening a photo of a child
assumes it is theirs, and an unlabelled placeholder is worse than no photo.
Unset it (`SAMPLE_PHOTO=`) before real parents are on the bot, and delete the
constant the day a real capture lands.

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
Telegram webhook, install the attendance trigger, link yourself as a test
guardian, then fire a fake scan and wait for your phone to buzz. It is
re-runnable — secrets are kept in a gitignored `.env.notify` rather than
rotated.

The wizard exists because two secrets each have to match in two places
(`WEBHOOK_SECRET` in Supabase *and* the trigger in `sql/webhook.sql`;
`TELEGRAM_WEBHOOK_SECRET` in Supabase *and* `setWebhook`), and a mismatch
surfaces as a silent 403 in the function logs rather than an error anywhere you
are looking.

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

then paste `sql/webhook.sql` into the SQL editor with `WEBHOOK_SECRET` filled
in. That installs a `pg_net` trigger on INSERT into `pta.attendance` — async, so
a slow Telegram can never block a student walking through the gate. The
`pg_cron` sweeper for failed sends is in the comment above
`retry_notifications()`.

### Testing it without a board or a bot

```bash
docker run -d --rm --name gatepg -e POSTGRES_PASSWORD=pw -p 55433:5432 postgres:16
export PGPASSWORD=pw PTA=../../pta-collections/supabase/migrations
psql -h localhost -p 55433 -U postgres -v ON_ERROR_STOP=1 \
     -f sql/test_bootstrap.sql $(for f in $PTA/0*.sql; do echo -n "-f $f "; done) \
     -f sql/test_notify.sql
docker stop gatepg
```

21 checks covering dedupe, the staleness thresholds, opt-out, retry with
`FOR UPDATE SKIP LOCKED`, the attempt ceiling, token single-use, retention,
unregistered devices, the `anon` and `service_role` grant surfaces, and
tenancy — the same card UID issued at two schools must resolve to two different
children and notify only one set of parents.

The real `pta` migrations are loaded rather than a hand-copied fixture, so these
tests fail if that schema drifts. That is the point of running them.

## Layout

```
lib/core/         pure C++, no Arduino — EventQueue, ScanEvent, Backoff, Storage
                  (this is what `pio test -e native` exercises)
src/              firmware — tasks, WiFi, TLS, LittleFS backend, console, LED
include/config.h  device id, schema, cadence, batch size, caps, thresholds
sql/              cutover.sql (one-time move onto pta), webhook.sql (the
                  notify trigger), and the Postgres test suite. The schema
                  ITSELF lives in the pta-collections repo — see sql/README.md
web/              the gate board and /enroll (Next.js, service_role, one school)
supabase/functions/
                  notify-guardian  — fans one scan out to Telegram
                  telegram-webhook — guardian enrolment via /start deep link
test/test_queue/  host tests: FIFO, restart, replay-after-crash, overflow,
                  compaction, interrupted compaction, clock reconstruction
```

The schema is in the other repo on purpose. `pta`'s version history belongs to
PTA Collections, and a second copy here would be a second thing to keep in step
— one that would lose the argument the moment they disagreed.

## Status LED

green = online and drained · amber = queueing · red = no WiFi · blue = booting

## Known limits (deliberate)

- **One reader means one direction.** A row records *"a card passed the gate"*,
  not *"a student was present"*. `direction` is reserved and always `'in'`;
  deriving attendance from first-scan-of-day is a rule your app applies.
- The anon key is in the firmware image and flash is readable over USB. That is
  acceptable only because that key can do exactly one thing: `EXECUTE`
  `pta.record_attendance()`, for a device that is registered. Moving to an Edge
  Function with a per-device secret is the next hardening step.
- **The dashboard has no auth and reads with `service_role`, which bypasses
  RLS.** It is scoped to one school by resolving `GATE_DEVICE_ID` through
  `pta.gate_devices` and filtering every query on the result — in application
  code, not in the database. That is thinner than it should be for a
  multi-tenant database. Giving the board real staff auth, and dropping the
  `service_role` read grant added by `0013_gate_attendance.sql`, is the
  follow-up.
- No OTA yet — but the partition slot is reserved, because repartitioning later
  would erase the filesystem, and the filesystem is the queue.

## Swapping in a real RFID reader

`USE_WIEGAND_READER` is already `1`. If you are starting from a bare board,
going live is three steps: find the pins, flip a switch, enrol the cards.

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

`reader on` / `reader off` gate the real reader exactly as they gated the
simulator, and `scan <uid>` still injects one by hand, which is how you
exercise the upload path with no card present.

### 3. Enrol the cards

Open **/enroll** on the dashboard. Tap a card on the gate; it appears under
*Unassigned cards* within a few seconds, because the gate records every scan
whether it recognises the card or not. Search the roster, pick the student, and
press *Assign card*.

**The roster is PTA Collections'.** This page binds plastic to people; it does
not create people. A student invented at the gate would have no enrolment row —
no school year, no section, no student number — and would be invisible in the
app that actually bills their parents. If someone is missing, add them there.

Reassigning a card that someone else held retires the old mapping rather than
overwriting it, so last term's attendance still resolves to whoever actually
carried that card that day. The `×` next to a card retires it — for a card that
is lost or broken.
