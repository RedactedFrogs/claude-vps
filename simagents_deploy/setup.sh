#!/bin/bash
# Deploy multi-wallet miner to ~/simagents
# Usage: bash setup.sh
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DST="$HOME/simagents"

echo "=== Deploying multi-wallet miner ==="
cp "$SRC/multi_miner.py" "$DST/multi_miner.py"
cp "$SRC/derive_wallets.py" "$DST/derive_wallets.py"
echo "Files copied to $DST"

echo ""
echo "=== Step 1: Derive wallets ==="
SEED="$HOME/.phantom_seed"
if [ ! -f "$SEED" ]; then
    echo "ERROR: $SEED not found!"
    exit 1
fi

if [ -f "$DST/mining_wallets.json" ]; then
    echo "mining_wallets.json already exists, skipping."
else
    cd "$DST"
    ./venv/bin/python derive_wallets.py "$SEED" 100 "$DST/mining_wallets.json"
fi

echo ""
echo "=== Step 2: Systemd service ==="
SVCDIR="$HOME/.config/systemd/user"
mkdir -p "$SVCDIR"

cat > "$SVCDIR/simagents-multi.service" << 'SVC'
[Unit]
Description=simagents.si multi-wallet miner
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/simagents
ExecStart=%h/simagents/venv/bin/python -u %h/simagents/multi_miner.py
Restart=on-failure
RestartSec=30
Environment=SIM_TIER=3
Environment=SIM_MAX_WALLETS=100
Nice=10

[Install]
WantedBy=default.target
SVC

echo ""
echo "=== Step 3: Stop old, start new ==="
systemctl --user stop simagents-miner.service 2>/dev/null || true
systemctl --user stop simagents-register.service 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now simagents-multi.service
sleep 2
systemctl --user status simagents-multi.service --no-pager -l || true

echo ""
echo "=== DONE ==="
echo "Log: tail -f ~/simagents/multi_miner.log"
