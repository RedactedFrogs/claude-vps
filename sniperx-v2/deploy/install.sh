#!/bin/bash
# SniperX v2 — Install script untuk VPS2
# Jalankan sebagai root: bash install.sh

set -e

echo "=== SniperX v2 Installer ==="

# 1. Copy repo ke /home/boss
if [ ! -d /home/boss/sniperx-v2 ]; then
  echo "[1/6] Cloning repo..."
  cd /home/boss
  git clone https://github.com/RedactedFrogs/claude-vps.git _tmp_clone
  cp -r _tmp_clone/sniperx-v2 /home/boss/sniperx-v2
  rm -rf _tmp_clone
  chown -R boss:boss /home/boss/sniperx-v2
else
  echo "[1/6] Directory exists, pulling updates..."
  cd /home/boss/sniperx-v2 && git pull 2>/dev/null || true
fi

# 2. Install dependencies
echo "[2/6] Installing npm dependencies..."
cd /home/boss/sniperx-v2
runuser -u boss -- npm install --production

# 3. Setup .env
if [ ! -f /home/boss/sniperx-v2/.env ]; then
  echo "[3/6] Creating .env from template..."
  cp .env.example .env
  # Auto-fill wallet paths
  sed -i 's|your_alchemy_api_key_here||' .env
  sed -i 's|change_this_password|'$(openssl rand -hex 8)'|' .env
  echo ">>> EDIT .env dan masukkan ALCHEMY_API_KEY & TELEGRAM credentials <<<"
else
  echo "[3/6] .env already exists, skipping"
fi

# 4. Create log directory
echo "[4/6] Setting up logs..."
mkdir -p /home/boss/sniperx-v2/logs
chown boss:boss /home/boss/sniperx-v2/logs

# 5. Install systemd services
echo "[5/6] Installing systemd services..."
cp /home/boss/sniperx-v2/deploy/sniperx.service /etc/systemd/system/
cp /home/boss/sniperx-v2/deploy/sniperx-tunnel.service /etc/systemd/system/
cp /home/boss/sniperx-v2/deploy/sniperx-logrotate.conf /etc/logrotate.d/sniperx
systemctl daemon-reload
systemctl enable sniperx sniperx-tunnel

# 6. Start
echo "[6/6] Starting services..."
systemctl start sniperx
sleep 2
systemctl start sniperx-tunnel

echo ""
echo "=== SniperX v2 Installed! ==="
echo "Bot:       systemctl status sniperx"
echo "Tunnel:    systemctl status sniperx-tunnel"
echo "Logs:      tail -f /home/boss/sniperx-v2/logs/sniperx.log"
echo "Dashboard: check tunnel log for public URL"
echo ""
echo "PENTING: Edit /home/boss/sniperx-v2/.env dulu!"
echo "  - ALCHEMY_API_KEY"
echo "  - TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID"
echo "  - DASHBOARD_PASSWORD (auto-generated, catat!)"
