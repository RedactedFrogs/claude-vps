#!/usr/bin/env bash
# Aggressive registration loop: tries every 60s, logs concisely, stops on success.
set -euo pipefail
STATE=/var/cache/awp/zcash-rewards.json
LOG=/var/log/awp/depinzcash-register.log
REG=/root/.depinzcash/register.py

# Already registered? Exit.
if [ -f "$STATE" ] && python3 -c "import json; exit(0 if json.load(open('$STATE')).get('registered') else 1)" 2>/dev/null; then
    exit 0
fi

# Run register and capture full output
{
    echo "--- $(date -u +%Y-%m-%dT%H:%M:%SZ) attempt ---"
    OUT=$("$REG" 2>&1) || true
    RC=$?
    echo "$OUT"
    echo "exit=$RC"
} >> "$LOG"
