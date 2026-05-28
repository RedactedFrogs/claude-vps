#!/bin/bash
# Bulk export private keys to /root/.awp-mining/wallet_keys.json
# Used by native Python signer (avoid awp-wallet subprocess cold start)
OUT=/root/.awp-mining/wallet_keys.json
TMP=/tmp/keys_partial.json
echo '{}' > $TMP
for d in $(ls -1 /root/.awp-mining/state/ | grep '^wallet-' | sort); do
  res=$(HOME=/root AWP_AGENT_ID=$d WORKER_STATE_ROOT=/root/.awp-mining/state/$d awp-wallet export-private-key 2>/dev/null)
  pk=$(echo "$res" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("privateKey",""))' 2>/dev/null)
  addr=$(echo "$res" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("address",""))' 2>/dev/null)
  if [ -n "$pk" ] && [ -n "$addr" ]; then
    python3 -c "import json; d=json.load(open('$TMP')); d['$d']={'pk':'$pk','addr':'$addr'}; json.dump(d,open('$TMP','w'))"
    echo "$d -> ok"
  else
    echo "$d -> FAIL"
  fi
done
mv $TMP $OUT
chmod 600 $OUT
echo done: $(python3 -c 'import json; print(len(json.load(open("'$OUT'"))))')
