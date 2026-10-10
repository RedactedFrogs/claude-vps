#!/bin/bash
# Runner untuk orc_cdp.js di VPS2
# Jalankan: bash orc_run.sh <index 0-5>
# Index: 0=boss_venture89, 1=redacted_frogs, 2=mallardordinals,
#        3=bossventure168, 4=gryfindor_bot, 5=hendrawanipiro

set -e
IDX=${1:-0}

echo "=== ORC MINER RUNNER - Account $IDX ==="

# Pastikan Xvfb jalan
if ! pgrep -x Xvfb > /dev/null; then
  echo "Starting Xvfb..."
  Xvfb :99 -screen 0 1280x720x24 &
  sleep 1
fi
export DISPLAY=:99

# Copy script ke /tmp
mkdir -p /tmp/orc-miner
cp "$(dirname "$0")/orc_cdp.js" /tmp/orc-miner/orc_cdp.js

echo "Running miner for account $IDX..."
node /tmp/orc-miner/orc_cdp.js "$IDX"
