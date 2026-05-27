#!/bin/bash
# DePINZcash auto-register orchestrator.
# Runs every 5 min via cron. Workflow:
#   1. Sentinel REGISTRATION_REOPENED exists? (set by watcher.py when 403 -> real-response)
#   2. State file PROCESSING_STARTED exists? (idempotency lock)
#   3. Smoke test 1 wallet (register_one) — must get 200 OK
#   4. If smoke OK -> launch register_batch.py --execute in background
#   5. Write PROCESSING_STARTED so we don't re-run
LOG=/root/depinz/logs/orchestrator.log
SENT=/root/depinz/state/REGISTRATION_REOPENED
LOCK=/root/depinz/state/PROCESSING_STARTED
BATCH_LOG=/root/depinz/logs/batch.out

mkdir -p /root/depinz/logs /root/depinz/state

log() { echo "[$(date -u +%FT%TZ)] $*" >> $LOG; }

# 1. Sentinel exists?
if [ ! -f $SENT ]; then
    exit 0   # not open yet, silent exit
fi

# 2. Already processing?
if [ -f $LOCK ]; then
    log "already processing (lock exists)"
    exit 0
fi

log "=== sentinel detected, starting workflow ==="
log "sentinel content: $(cat $SENT)"

# Verify sentinel is REAL (response 200/422, not -1)
sent_status=$(grep -oE '"to_status":[[:space:]]*-?[0-9]+' $SENT | grep -oE '\-?[0-9]+')
if echo "$sent_status" | grep -qE '^(-1|0)$'; then
    log "WARN: sentinel has fake to_status=$sent_status (network err) — removing"
    rm $SENT
    exit 0
fi

# 3. Smoke test wallet-999 (label probe, separate from production wallets)
log "smoke test register_one wallet-999..."
SMOKE_OUT=$(HOME=/root python3 /root/depinz/register_one.py 999 --label orchestrator-probe 2>&1)
log "smoke result: $SMOKE_OUT"

if ! echo "$SMOKE_OUT" | grep -qE '"status":[[:space:]]*200'; then
    log "SMOKE FAILED — abort. Will retry next cron."
    exit 1
fi

log "SMOKE OK. Launching batch register in background..."
touch $LOCK

# 4. Launch batch in nohup background (with low priority to coexist with AWP miner)
nohup nice -n 19 ionice -c3 python3 /root/depinz/register_batch.py --execute >> $BATCH_LOG 2>&1 &
disown
log "=== batch launched (PID $!) — see batch.out ==="
