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

## Mini PC

First time: `npm run build`, then follow the header of `deploy/setup-minipc.sh`.

Every update: commit, then `./deploy/deploy.sh` (refused 06:00-08:30 and
15:30-18:00 gate time unless `FORCE=1`). Undo: `./deploy/rollback.sh`.

Logs: `ssh gate@minipc journalctl -u gate-scanner -f`
