#!/usr/bin/env bash
# Point the gate back at the previous release and restart. Seconds, no
# rebuild. A release that refuses to open gate.db ("schema version") was
# rolled back past a schema change: deploy the newer release again instead.
set -euo pipefail
HOST="${GATE_HOST:-gate@minipc}"
ssh "$HOST" bash -s <<'EOF'
set -euo pipefail
cur=$(basename "$(readlink /opt/gate/current)")
prev=$(cd /opt/gate/releases && ls -1t | grep -vx "$cur" | head -n 1 || true)
[[ -n "$prev" ]] || { echo "no earlier release to roll back to"; exit 1; }
ln -sfn "/opt/gate/releases/$prev" /opt/gate/current.new && mv -T /opt/gate/current.new /opt/gate/current
sudo systemctl restart gate-scanner
echo "rolled back $cur -> $prev"
EOF
