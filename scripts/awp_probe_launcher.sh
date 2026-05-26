#!/bin/bash
set -e
DURATION=${1:-3600}
POLL=${2:-60}
PROXIES=/root/.awp-mining/proxies.txt
PY=/root/.claude/skills/mine/.venv/bin/python

# Clean previous metrics
rm -f /root/.awp-mining/repeat-crawl-probe-*.json

mapfile -t WALLETS < <(echo -e "default\nwallet-002\nwallet-003\nwallet-004\nwallet-005")
mapfile -t IDX < <(echo -e "1\n2\n3\n4\n5")

for i in 0 1 2 3 4; do
    W=${WALLETS[$i]}
    LINE_NUM=${IDX[$i]}
    LINE=$(sed -n "${LINE_NUM}p" "$PROXIES")
    H=$(echo "$LINE" | cut -d: -f1)
    P=$(echo "$LINE" | cut -d: -f2)
    U=$(echo "$LINE" | cut -d: -f3)
    PW=$(echo "$LINE" | cut -d: -f4)
    PROXY="http://$U:$PW@$H:$P"
    nohup "$PY" /root/.awp-mining/scripts/probe_one_wallet.py "$W" "$DURATION" "$PROXY" "$POLL" \
        > "/var/log/awp/probe-$W.log" 2>&1 &
    echo "started $W (PID $!) via $H:$P"
    sleep 3  # stagger
done

echo
echo "5 wallets probing for ${DURATION}s, poll every ${POLL}s"
echo "Monitor: tail -f /var/log/awp/repeat-crawl-probe.log"
echo "Metrics will be at: /root/.awp-mining/repeat-crawl-probe-*.json"
