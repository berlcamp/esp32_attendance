# Moving the gate from an ESP32 to a Linux mini PC

**Date:** 2026-09-19
**Status:** Approved, not yet implemented

## Why

The gate needs a monitor that shows a student's details the moment their card
is scanned. The ESP32-S3 has no video output, so that requirement alone decides
the hardware: a small SPI TFT is not a monitor. Once a mini PC is at the gate
for the screen, keeping a separate microcontroller to read cards is pure
overhead.

Three things follow for free:

- A USB RFID reader is an HID keyboard, so `src/WiegandTagReader.cpp` and the
  `wiegand-probe` environment stop existing. No pulse counting, no parity
  stripping, no pin hunting.
- The gate camera that `notify-guardian` was already written for
  (`CAPTURE_BUCKET`, `SAMPLE_PHOTO`, signed URLs) becomes a USB webcam and a few
  lines, rather than a second board.
- Development moves to a real OS: SQLite, systemd, `journalctl`, SSH.

**The server side does not change.** The device's entire contract is "POST a
batch of event objects to `record_attendance()`", keyed by a UUID `event_id`
for idempotency. Supabase, the edge functions, the Telegram path and the
Next.js dashboard are untouched by this migration, with one exception recorded
under *Server-side change required* below.

## Decisions

| Question | Decision |
|---|---|
| Platform | Mini PC, Ubuntu Server |
| Display stack | `cage` (Wayland kiosk compositor) + Chromium, no desktop |
| Display app | A plain HTML page served by the gate service over SSE |
| Screen content | Text only: name, student number, grade, section, time, known/unknown |
| Offline behaviour | Full details, served from a local roster mirror |
| Language | TypeScript on Node, with `node:sqlite` |
| Code location | A new `gate/` directory in this repo, beside `web/` and `supabase/` |
| Packaging | Plain systemd, no Docker. Evdev hotplug, the exclusive grab and `cage`'s seat access all fight a container, and a single dependency-free JS bundle already gives most of what an image would. Revisit only for a fleet of gates |

## Non-goals

- **Student ID photos.** `pta.gate_roster` exposes only `full_name`,
  `student_no`, `grade_level` and `section_name`, and no photo column exists on
  `pta.students` anywhere in migrations 0001-0024. Putting photos on the screen
  is a feature of PTA Collections, not of this project.
- **The gate camera.** The mini PC makes it easy, which is a reason to build it
  next, not now.
- **Retiring the ESP32 firmware.** `src/` and `platformio.ini` stay as the
  rollback until the mini PC has run unattended for a week.
- **Multiple gates.** The design is per-device and would extend, but one gate
  is what is being built.

## Architecture

Two systemd units:

- `gate-scanner.service` - one Node process, running as a user in the `input`
  group.
- `gate-display.service` - `cage -- chromium --kiosk http://127.0.0.1:8080`.

The display unit is deliberately dumb. If Chromium dies, systemd restarts it
and the page reconnects; scanning never depended on it.

The firmware splits reader and uploader across two FreeRTOS cores so that a
student is never missed while the uploader sits in a TLS handshake. Node's
event loop provides that property without the split: a pending HTTPS request
cannot block an incoming keystroke. One process is correct here, not a
compromise. SQLite writes are synchronous but are a single row.

### Modules

| Module | Responsibility | Notes |
|---|---|---|
| `reader/` | Emits card UIDs | `EvdevReader`, `KeyboardReader`, `SimulatedReader` behind one interface |
| `queue/` | Durable scan queue | `enqueue` / `take(n)` / `ack(ids)` / `depth()` |
| `uploader/` | Drains batches to `record_attendance()` | Backoff, `net off` kill switch |
| `roster/` | Local mirror of students and cards | `lookup(uid) -> student \| null` |
| `display/` | Serves the page, pushes scans over SSE | Reads only the local mirror |
| `control/` | `status`, `scan`, `burst`, `net`, `queue` over localhost HTTP | Replaces the serial console |

`reader/` keeps the shape of `src/TagReader.h`: one `read()` to implement, with
`inject()` and `injectBurst()` non-virtual on the interface so `scan <uid>` and
`burst <n>` work identically against real hardware. Those commands are how the
upload path is tested without cards, and they must survive the port.

### Flow on a scan

```
keystrokes -> uid -> cooldown (10s) -> roster.lookup() -> SSE push -> SCREEN (~50ms)
                                                       |
                                     queue.enqueue(uuid) -> uploader -> record_attendance()
                                                         -> pg_net -> notify-guardian -> Telegram
```

The screen updates **before** the queue, from the local mirror. That is what
makes it behave identically during an outage, and it means a slow network can
never make the monitor lag behind the turnstile.

## Server-side change required

Today the device is write-only. The anon key "carries no table privileges at
all - not even SELECT" (`include/config.h`), and one RPC is the whole attack
surface. Resolving a card to a name locally requires the gate to read the
roster and the card table, which breaks that property.

**A new `gate_roster_snapshot()` RPC** in the `pta-collections` repo, as
`supabase/migrations/0025_gate_roster_snapshot.sql`. It returns names, student
numbers, grade levels, sections and card UIDs for the calling device's school
only, authorised through `pta.gate_devices` exactly as `record_attendance()`
already is. The anon key stays SELECT-less, and a stolen mini PC leaks one
school's roster rather than a database shared with two other apps.

The rejected alternative is putting the `service_role` key on the mini PC. It
bypasses RLS for every school in the shared project, and the box sits at a gate.

Apply it through the Supabase SQL Editor. Never `supabase db push` - the
project is shared, and a push proposes dropping the other apps' objects.

This is the only work outside this repo, and it blocks the display.

## Card identity

`WiegandTagReader` strips parity from a 26-bit frame and formats the 24-bit
body as `%06lX` - six uppercase hex digits. That is the format of every card
enrolled through the ESP32.

**Prerequisite test, run 2026-10-02.** The USB reader is a Sycreader
"SYC ID&IC USB Reader", `08ff:0009`, a standard HID boot keyboard. On the Mac:

- The card supplied with the reader typed `0002008108` then Enter: ten decimal
  digits, the usual output for a 125 kHz EM4100 card.
- An enrolled card did not register at all. The USB reader cannot read the
  existing cards, so no `normalizeUid()` mapping can rescue them.

**Decision: re-enrol on new cards.** The project has not started
implementation and only five test cards are in `pta.student_cards`, so the
cost is buying cards, not disrupting a school. The mapping is the identity:
the card UID is the ten digits the reader types, leading zeros kept, Enter
stripped. That is usually the number printed on an EM card, so a guard can
read a damaged card's number off its face.

`normalizeUid()` stays as a pure function in `reader/`. Its job is now only to
accept exactly ten digits and reject anything else as a misread, so a partial
keystroke burst never becomes attendance.

Enrolment uses the existing machinery: unknown cards surface on `/enroll` as
unassigned, exactly as `sql/cutover.sql` step 5 describes. The five
ESP32-format rows (`E5AC02`, `EA1612`, `EFA2D2`, `F36B72`, `F5A4F2`) are
deleted once their students hold new cards.

## Data model

One SQLite database at `/var/lib/gate/gate.db`, WAL, `synchronous=FULL`.

- `scans(event_id PK, card_uid, device_id, scanned_at, clock_synced, queued, sent_at)`
- `roster(student_id PK, full_name, student_no, grade_level, section_name)`
- `cards(card_uid PK, student_id)`
- `meta(key PK, value)` - holds `roster_synced_at` and the counters.

SQLite deletes what the LittleFS append log had to compact, so
`QUEUE_COMPACT_BYTES` disappears. Everything else carries over: batches of 50,
backoff 1s to 60s, and `LATE_AFTER_S = 15` still setting `queued=true` so
`message.ts` keeps telling parents that a message was delayed. A 100k row cap
and a `dropped` counter stay, so a wedged uploader cannot fill the disk. Sent
rows are pruned daily but kept long enough for `queue dump` to be useful.

`clock_synced` stays even though NTP makes it nearly always true. If
`timedatectl` reports unsynchronised, record `false` rather than dropping the
scan, so the parent-facing caveat survives.

The ten-second `CARD_COOLDOWN_MS` double-swipe guard stays, in memory, per
reader. It resets on restart, which is acceptable.

## The roster mirror

Both mirror tables are replaced wholesale inside a transaction, at startup and
every five minutes. A few thousand rows; diffing would be complexity for
nothing. Two behaviours matter:

- **An unknown card triggers an immediate resync**, rate-limited to once a
  minute. That shrinks the window in which a card enrolled at 07:05 reads as
  UNKNOWN from five minutes to a few seconds.
- **The screen is advisory; the database is truth.** A card the mirror has not
  seen still queues and uploads correctly, and `attendance_resolved` resolves it
  server-side. The guard sees "unknown" briefly; the parent still gets the right
  message.

A failed sync **keeps the last good mirror** and marks it stale; the display
shows a quiet marker when it is over an hour old. The mirror is never wiped on
a failed sync - blanking the screen during an outage is the exact bug this
design exists to avoid.

## Failure handling

Degrade visibly, never silently.

| Failure | Behaviour |
|---|---|
| Internet down | Scans queue; screen unaffected; Telegram arrives late with the `queued=true` caveat |
| Reader unplugged | Device node vanishes; reopen on hotplug; screen shows a READER OFFLINE banner |
| Chromium crashes | systemd restarts it; scanning never stopped |
| Scanner crashes | systemd restarts it; SQLite is durable; at most the in-flight scan is lost |
| Power cut | WAL and `synchronous=FULL`; committed scans survive. Needs a UPS and the BIOS set to restore on AC power loss |
| Roster sync fails | Last good mirror is kept and marked stale |
| Disk filling | 100k cap, daily prune, free space reported by `status` |
| Duplicate submission | `event_id` primary key server-side; counted, not errored |

The READER OFFLINE banner is not decoration. A dead USB reader and a quiet
morning look identical on a screen that only shows the last scan, and the
README already describes this failure class: a stopped reader "looking for all
the world like a wiring fault."

## Configuration

`/etc/gate/gate.env`, mode 0600, root-owned, loaded by systemd's
`EnvironmentFile=`. It replaces `include/secrets.h`. It holds the Supabase URL
and anon key, `DEVICE_ID`, and the reader device path. Use the stable
`/dev/input/by-id/usb-Sycreader_RFID_Technology_Co.__Ltd_SYC_ID_IC_USB_Reader_08FF20140315-event-kbd`
path, not `eventN`, which can renumber on replug.

## Deployment

Build on the Mac, ship a bundle, run it under systemd.

- **Build:** esbuild the service into a single JS file. `node:sqlite` is used
  instead of `better-sqlite3` specifically to avoid cross-compiling a native
  module for the mini PC's architecture.
- **Ship:** `rsync -az dist/ gate@minipc:/opt/gate/` then
  `ssh gate@minipc 'sudo systemctl restart gate-scanner'`.
- **Watch:** `ssh gate@minipc journalctl -u gate-scanner -f`. This replaces
  `pio device monitor`, and is better: remote, and it survives reboots.
- **Control:** `curl` against the localhost control endpoint over SSH, instead
  of typing at a serial console.

**Hardware check before buying:** confirm the mini PC physically has VGA. Most
machines made since roughly 2020 are HDMI or DisplayPort only, and there is no
passive HDMI-to-VGA cable, because HDMI is digital - an active converter is
required. Pin the output resolution explicitly, or a boot with the monitor off
can leave the framebuffer at 640x480.

## Testing

On the Mac, under `node:test`: `normalizeUid` accepting `0002008108` and
rejecting short, long and non-digit input, queue
enqueue/take/ack, backoff, the ten-second cooldown, roster lookup, and the SSE
payload shape.

Integration on the Mac: `SimulatedReader` against the real Supabase project,
plus the catch-up test the firmware already relies on - `burst 200`, `net off`,
`net on`, and confirm every row lands exactly once.

Only two things must be tested on the mini PC:

1. Hotplug recovery after unplugging and replugging the reader.
2. **That the exclusive grab works.** Focus a terminal, swipe a card, and
   confirm nothing is typed into it. If characters appear, the grab failed -
   and that is a bug that would otherwise be found in production, with card
   numbers typed into whatever the kiosk browser has focused.

Acceptance, on the mini PC: swipe a real card, the screen shows the student in
under a second, the parent's Telegram message arrives, and the row is in
`pta.attendance`.

## Cutover

Each step is reversible.

1. ~~The prerequisite card-format test on the Mac.~~ Done 2026-10-02: the
   USB reader cannot read the existing cards, so students re-enrol on new
   125 kHz cards (see *Card identity*).
2. Apply `0025_gate_roster_snapshot.sql` through the Supabase SQL Editor.
3. Register a second device, `gate-01-pc`, against the same school. Tenancy is
   per-device, so the mini PC is a legitimate gate the moment the row exists -
   there is no flag day.
4. Deploy and run with `SimulatedReader`. Confirm rows land and Telegram fires
   before a real card is ever swiped.
5. Enrol the new cards through `/enroll`, then swipe them at a quiet hour.
6. Leave the ESP32 installed and powered with `reader off` for a week. That
   setting survives reboot and reflash, so rollback is one serial command.
   Rollback only helps if the ESP32's Wiegand reader can read the new cards,
   so check that with one new card during step 5. If it can't, the ESP32
   can only be a rollback for the old cards, and new cards need the mini PC.

Do not run both readers against the same cards at once: two devices means two
`event_id`s and two attendance rows for one child.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| USB reader cannot read the existing cards | Realised | Confirmed 2026-10-02; re-enrol on new 125 kHz cards |
| HID reader types into the focused window | High | Exclusive `EVIOCGRAB`, verified by the terminal-focus test |
| Unclean power loss at a school gate | Medium | UPS, WAL with `synchronous=FULL`, BIOS restore on AC loss |
| Mini PC has no VGA port | Low | Check before buying; active HDMI-to-VGA converter otherwise |
| Roster RPC blocks the display | Medium | It is one migration; write it first, in step 2 |
