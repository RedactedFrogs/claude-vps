#!/usr/bin/env python3
"""Print one-line status of the 5-wallet repeat-crawl probe on the VPS."""
import os, json, urllib.request, ssl, sys
ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
cmd = (
    "echo -n \"T+$(date +%H:%M) probes=$(pgrep -fc probe_one_wallet) \"; "
    "echo -n \"tasks=$(grep -c 'TASK ds=' /var/log/awp/repeat-crawl-probe.log 2>/dev/null) \"; "
    "echo -n \"errors=$(grep -c 'claim ERR' /var/log/awp/repeat-crawl-probe.log 2>/dev/null) \"; "
    "echo \"datasets:$(grep -oP 'ds=\\K[a-z_]+' /var/log/awp/repeat-crawl-probe.log 2>/dev/null | sort | uniq -c | tr -d '\\n' | tr -s ' ')\""
)
data = json.dumps({"cmd": cmd, "timeout": 10}).encode()
req = urllib.request.Request(os.environ["VPS_BRIDGE_URL"]+"/exec", data=data,
    headers={"X-Token": os.environ["VPS_BRIDGE_TOKEN"], "Content-Type": "application/json"}, method="POST")
print(json.load(urllib.request.urlopen(req, timeout=20, context=ctx)).get("stdout","").strip())
