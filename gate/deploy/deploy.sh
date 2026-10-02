#!/usr/bin/env bash
# Build on this Mac, ship to the mini PC, switch release, restart.
#   ./deploy/deploy.sh                   normal deploy (refused during arrival/dismissal)
#   FORCE=1 ./deploy/deploy.sh           deploy anyway
#   GATE_HOST=gate@10.0.0.5 ./deploy/deploy.sh
# While gate-scanner restarts (~1 s) the reader is not grabbed, so a card
# swiped in that second types into the kiosk browser instead of being
# recorded. That is why busy hours are refused.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${GATE_HOST:-gate@minipc}"
BUSY="${GATE_BUSY_HOURS:-0600-0830 1530-1800}"

now=$(ssh "$HOST" date +%H%M)
if [[ "${FORCE:-0}" != 1 ]]; then
  for window in $BUSY; do
    if (( 10#$now >= 10#${window%-*} && 10#$now < 10#${window#*-} )); then
      echo "refusing: it is $now at the gate, inside busy window $window (FORCE=1 to override)"
      exit 1
    fi
  done
fi

npm test
npm run build
version=$(cat dist/VERSION)
rsync -az --delete dist/ "$HOST:/opt/gate/releases/$version/"

ssh "$HOST" bash -s -- "$version" <<'EOF'
set -euo pipefail
v="$1"
prev=$(readlink /opt/gate/current || true)
switch() { ln -sfn "$1" /opt/gate/current.new && mv -T /opt/gate/current.new /opt/gate/current; }
switch "/opt/gate/releases/$v"
sudo systemctl restart gate-scanner
# "active" alone proves nothing: Restart=always brings a crash-looping
# release back to active every 2 s. Healthy means the service itself reports
# THIS version and has stayed up for 10 s.
healthy() {
  curl -sf --max-time 2 http://127.0.0.1:8080/control/status | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const j = JSON.parse(s); process.exit(j.version === process.argv[1] && j.uptimeS >= 10 ? 0 : 1); }
      catch { process.exit(1); }
    });' "$v"
}
sleep 15
if ! healthy; then
  echo "gate-scanner is not healthy on $v:"
  journalctl -u gate-scanner -n 30 --no-pager || true
  if [[ -n "$prev" ]]; then
    switch "$prev"
    sudo systemctl restart gate-scanner
    # Delete the failed release, or rollback.sh would pick it as "previous".
    if [[ "$prev" != "/opt/gate/releases/$v" ]]; then rm -rf -- "/opt/gate/releases/$v"; fi
    echo "rolled back to $(basename "$prev") and removed $v"
  fi
  exit 1
fi
cd /opt/gate/releases
# Keep the current release and the four newest others. grep finds nothing on
# the first deploy, which must not fail the script under pipefail.
{ ls -1t | grep -vx "$v" || true; } | tail -n +5 | xargs -r rm -rf --
echo "gate-scanner running $v"
EOF
