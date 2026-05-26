#!/bin/bash
# Heartbeat watchdog: detect if heartbeat_all cron stops working.
# Action:
#  - last DONE > 30 min: try running heartbeat_all once (recover from missed cron)
#  - last DONE > 90 min: emergency — restart miner with heartbeat re-enabled (fallback miner_v4.py.bak-with-hb)
#  - if /root/.awp-mining/state/HB_EMERGENCY exists, miner runs with HB ON (manual override)
LOG=/var/log/awp/heartbeat-watchdog.log
HBLOG=/var/log/awp/heartbeat.log
ALERT=/root/.awp-mining/state/HB_STALE_ALERT
EMERG=/root/.awp-mining/state/HB_EMERGENCY
mkdir -p $(dirname $ALERT)
echo "[$(date -u +%FT%TZ)] watchdog tick" >> $LOG

last_done=$(grep 'DONE ok=' $HBLOG 2>/dev/null | tail -1 | grep -oE '\[2[0-9-]+T[0-9:]+Z\]' | tr -d '[]')
if [ -z "$last_done" ]; then
    echo "[$(date -u +%FT%TZ)] WARN: no heartbeat DONE found in log" >> $LOG
    exit 0
fi

age=$(( $(date +%s) - $(date -d "$last_done" +%s) ))
echo "[$(date -u +%FT%TZ)] last DONE = $last_done, age = ${age}s" >> $LOG

if [ $age -gt 5400 ]; then  # 90 min
    echo "[$(date -u +%FT%TZ)] CRITICAL: ${age}s since last hb DONE — emergency mode" >> $LOG
    touch $EMERG
    touch $ALERT
    # restart miner with HB-on variant if backup exists
    if [ -f /root/.awp-mining/awp_miner_v4.py.bak-pre-hb-skip-145232 ]; then
        cp /root/.awp-mining/awp_miner_v4.py.bak-pre-hb-skip-145232 /root/.awp-mining/awp_miner_v4.py
        systemctl restart awp-miner.service
        echo "[$(date -u +%FT%TZ)] reverted miner to HB-ON variant + restarted" >> $LOG
    fi
    # also force a heartbeat run now
    nohup /root/.awp-mining/scripts/heartbeat_all.sh >/dev/null 2>&1 &
elif [ $age -gt 1800 ]; then  # 30 min
    echo "[$(date -u +%FT%TZ)] WARN: ${age}s since last hb DONE — kicking heartbeat_all" >> $LOG
    touch $ALERT
    nohup /root/.awp-mining/scripts/heartbeat_all.sh >/dev/null 2>&1 &
else
    rm -f $ALERT 2>/dev/null
fi
