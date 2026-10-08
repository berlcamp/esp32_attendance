#!/usr/bin/env bash
# One-time (and safely re-runnable) provisioning of the gate mini PC.
# Ubuntu Server 24.04, x86_64. From the Mac, after `npm run build`:
#   scp -r dist/deploy admin@minipc:/tmp/gate-deploy
#   ssh -t admin@minipc sudo bash /tmp/gate-deploy/setup-minipc.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

timedatectl set-timezone Asia/Manila
timedatectl set-ntp true

apt-get update
apt-get install -y ca-certificates curl evtest cage rsync ffmpeg v4l-utils

# Node 22 LTS (node:sqlite unflagged from 22.13).
if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Google Chrome from its .deb. Ubuntu's Chromium is a snap, and snap
# confinement fights cage for the seat.
if ! command -v google-chrome >/dev/null; then
  curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y /tmp/chrome.deb
fi

# gate: runs the scanner, may read input devices and the camera. kiosk: runs the browser and
# deliberately may NOT -- the page never needs the reader.
id gate >/dev/null 2>&1 || useradd --create-home --shell /bin/bash gate
usermod -aG input,video gate
id kiosk >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin kiosk
usermod -aG video,render kiosk

# Let the Mac deploy as gate@minipc with the admin's existing SSH key.
if [[ -n "${SUDO_USER:-}" && -f "/home/$SUDO_USER/.ssh/authorized_keys" ]]; then
  install -d -o gate -g gate -m 0700 /home/gate/.ssh
  install -o gate -g gate -m 0600 "/home/$SUDO_USER/.ssh/authorized_keys" /home/gate/.ssh/authorized_keys
fi

install -d -o gate -g gate /opt/gate /opt/gate/releases
install -d -m 0755 /etc/gate
if [[ ! -f /etc/gate/gate.env ]]; then
  install -m 0600 "$HERE/gate.env.example" /etc/gate/gate.env
  echo ">>> fill in /etc/gate/gate.env (anon key and GATE_TOKEN) before starting the gate"
fi

install -m 0644 "$HERE/cage.pam" /etc/pam.d/cage
cat > /etc/sudoers.d/gate <<'EOF'
gate ALL=(root) NOPASSWD: /usr/bin/systemctl restart gate-scanner, /usr/bin/systemctl restart gate-display
EOF
chmod 0440 /etc/sudoers.d/gate
visudo -cf /etc/sudoers.d/gate

install -m 0644 "$HERE/gate-scanner.service" "$HERE/gate-display.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable gate-scanner gate-display
systemctl set-default graphical.target

echo ">>> provisioning done. Remaining manual steps: BIOS 'restore on AC power loss',"
echo ">>> pin the display resolution, and the first ./deploy/deploy.sh from the Mac."
