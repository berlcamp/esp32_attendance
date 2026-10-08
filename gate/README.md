# gate

The school-gate service for the Linux mini PC: reads the USB card reader,
shows the student on the kiosk monitor, and queues every scan to
`pta.record_attendance()`. Design: `docs/superpowers/specs/2026-09-19-linux-gate-migration-design.md`.

## Develop on the Mac

    npm install
    npm test
    cp deploy/gate.env.example .env.local   # then set READER=keyboard, DB_PATH=./gate-dev.db
    npm run dev                             # swipe cards into this terminal
    open -na "Google Chrome" --args --kiosk --user-data-dir=/tmp/gate-kiosk http://127.0.0.1:8080

## Control (replaces the ESP32 serial console)

    curl -s localhost:8080/control/status
    curl -s -X POST localhost:8080/control/scan   -d '{"uid":"0002008108"}'
    curl -s -X POST localhost:8080/control/burst  -d '{"n":200}'
    curl -s -X POST localhost:8080/control/net    -d '{"on":false}'
    curl -s -X POST localhost:8080/control/reader -d '{"on":false}'   # persists
    curl -s 'localhost:8080/control/queue?dump=20'
    curl -s -X POST localhost:8080/control/roster/sync

On the mini PC, prefix with `ssh gate@minipc`.

## Device token

The gate reads its school's roster with a per-device secret. In the Supabase
SQL Editor, as an admin of the school:

    select set_config('request.jwt.claims',
      json_build_object('sub', '<your auth.users id>', 'role', 'authenticated')::text, true);
    select pta.issue_gate_device_token('gate-01-pc');

Put the `gt_...` result in `/etc/gate/gate.env` as `GATE_TOKEN`. It is shown
once; running it again issues a new token and invalidates the old one, which
is also how a stolen mini PC is locked out.

## Camera

A USB (UVC) webcam photographs every tap. The photo replaces the placeholder
on the kiosk at once, and goes to the parent's Telegram message in place of
the sample image.

    tap -> newest camera frame -> kiosk
                               -> gate-capture (checks GATE_TOKEN) -> gate-captures bucket
                               -> record_attendance(image_path) -> notify-guardian -> sendPhoto

ffmpeg streams the camera at 1280x720 and the gate keeps only the newest
frame (at most ~200 ms old), so taking a photo takes no time. Every frame
comes in two sizes: a sharp 720p one for the kiosk, kept in memory only, and
a 640-wide one for upload, which keeps the upload and Telegram fast. Each tap
wakes the uploader at once. Each photo is
uploaded *before* its scan, because the Telegram message goes out on the
INSERT. A photo never holds a scan back for long: offline, both wait;
on 5xx the photo is retried 3 times; on 4xx (function not deployed, bad
token) the scan goes at once, without it. A photo is deleted from the
mini PC once it is uploaded, and from Supabase once the parents' Telegram
messages are sent.

Set `CAMERA_DEVICE` in `/etc/gate/gate.env` (`ls /dev/v4l/by-id/`, the one
ending `-video-index0`) and deploy the function once:

    supabase functions deploy gate-capture --no-verify-jwt

On the Mac: `brew install ffmpeg`, then `CAMERA_DEVICE="CyberTrack H3"` in
`.env.local` (names from `ffmpeg -f avfoundation -list_devices true -i ""`).
Check it with `curl -s localhost:8080/control/status`: `cameraOnline`,
`photosSent`, `photosSkipped`.

## Mini PC

First time: `npm run build`, then follow the header of `deploy/setup-minipc.sh`.

Every update: commit, then `./deploy/deploy.sh` (refused 06:00-08:30 and
15:30-18:00 gate time unless `FORCE=1`). Undo: `./deploy/rollback.sh`.

Logs: `ssh gate@minipc journalctl -u gate-scanner -f`
