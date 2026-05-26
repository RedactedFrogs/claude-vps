#!/bin/bash
# Serial heartbeat for all 250 wallets — works around awp-wallet concurrency race.
# Run hourly via cron. Each invocation takes ~15-18 min for 250 wallets.
LOG=/var/log/awp/heartbeat.log
LIST=/root/.awp-mining/state
exec >> $LOG 2>&1
echo "[$(date -u +%FT%TZ)] heartbeat_all START"
ok=0; fail=0
for d in $(ls -1 $LIST/ | grep '^wallet-' | sort); do
  out=$(HOME=/root PYTHONPATH=/root/.claude/skills/mine:/root/.claude/skills/mine/scripts:/root/.awp-mining /root/.claude/skills/mine/.venv/bin/python /root/.awp-mining/scripts/hb_one.py "$d" 2>/dev/null)
  echo "$out" | grep -q '"ok": true' && ok=$((ok+1)) || fail=$((fail+1))
done
echo "[$(date -u +%FT%TZ)] heartbeat_all DONE ok=$ok fail=$fail"
