#!/bin/bash
# Pool watchdog: refresh article pool when unconsumed buffer runs low.
# Triggers bulk_fetch_wiki if unconsumed < threshold.
LOG=/var/log/awp/pool-refresh.log
POOL=/root/.awp-mining/article_pool_v2.jsonl
USED=/root/.awp-mining/used_articles.txt
LOCK=/root/.awp-mining/state/pool_refresh.lock
THRESHOLD=6000      # trigger refresh when unconsumed < this
FETCH_BATCH=4000    # how many new articles to fetch per refresh

p=$(wc -l < $POOL 2>/dev/null || echo 0)
u=$(wc -l < $USED 2>/dev/null || echo 0)
left=$((p - u))
echo "[$(date -u +%FT%TZ)] pool=$p used=$u unconsumed=$left threshold=$THRESHOLD" >> $LOG

if [ $left -ge $THRESHOLD ]; then
    exit 0
fi

# acquire lock — don't double-refresh
if [ -f $LOCK ]; then
    age=$(( $(date +%s) - $(stat -c %Y $LOCK 2>/dev/null || echo 0) ))
    if [ $age -lt 3600 ]; then
        echo "[$(date -u +%FT%TZ)] refresh already in progress (${age}s old lock)" >> $LOG
        exit 0
    fi
fi
touch $LOCK
new_target=$((p + FETCH_BATCH))
echo "[$(date -u +%FT%TZ)] REFRESH START → target=$new_target" >> $LOG

# fetch new articles directly into POOL (not v3 — we use v2 as single pool now)
nohup nice -n 19 ionice -c3 bash -c "
POOL_OUT=$POOL HOME=/root python3 /root/.awp-mining/bulk_fetch_wiki.py $new_target >> $LOG 2>&1
rm -f $LOCK
echo '[$(date -u +%FT%TZ)] REFRESH DONE pool=$(wc -l < $POOL)' >> $LOG
" </dev/null >/dev/null 2>&1 &
disown
