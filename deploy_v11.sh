#!/bin/bash
# Deploy and run v11 on VPS
set -e
cd /home/boss/claude-vps
export HOME=/root
git config --global --add safe.directory /home/boss/claude-vps 2>/dev/null
git pull origin claude/nifty-maxwell-q8f69n --quiet

# Stop previous
pkill -f 'claim_elysium' 2>/dev/null || true
sleep 1

# Start v11 with Xvfb display
export DISPLAY=:99
nohup python3 -u /home/boss/claude-vps/claim_elysium_v11.py > /tmp/faucet_v11.log 2>&1 &
echo "pid=$!"
echo "started OK"
