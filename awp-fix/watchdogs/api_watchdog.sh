#!/bin/bash
# API watchdog: detect AWP API downtime, auto-restart miner.
# Probes /api/public/v1/stats (no auth required, lightweight).
LOG=/var/log/awp/api-watchdog.log
STATE=/root/.awp-mining/state/api_down_count
ALERT=/root/.awp-mining/state/API_DOWN_ALERT
mkdir -p $(dirname $STATE)

code=$(curl -s -m 25 -o /dev/null -w '%{http_code}' https://api.minework.net/api/public/v1/stats 2>/dev/null)
count=$(cat $STATE 2>/dev/null || echo 0)

if [ "$code" = "200" ]; then
    if [ "$count" != "0" ]; then
        echo "[$(date -u +%FT%TZ)] API recovered (was $count consecutive down)" >> $LOG
    fi
    echo 0 > $STATE
    rm -f $ALERT 2>/dev/null
    exit 0
fi

count=$((count+1))
echo $count > $STATE
echo "[$(date -u +%FT%TZ)] API DOWN code=$code consecutive=$count" >> $LOG

if [ $count -ge 5 ]; then
    # API down 9+ min — restart miner (clears stuck HTTP connections)
    echo "[$(date -u +%FT%TZ)] consecutive=$count >= 3, restarting awp-miner.service" >> $LOG
    touch $ALERT
    systemctl restart awp-miner.service
    echo 0 > $STATE
fi
