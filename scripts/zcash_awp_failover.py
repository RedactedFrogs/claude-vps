#!/usr/bin/env python3
"""Bidirectional flipper based on the LATEST AWP signal (timestamp-based).

Scans tail of /var/log/awp/miner-v4.log for the most recent DOWN vs HEALTHY
signal. Whichever is more recent wins (provided it's within MAX_AGE_MIN).

Down signal:     "PoW endpoint DOWN"
Healthy signals: "PoW endpoint OK", "round X START",
                 "round X DONE -- accepted=N" with N>0

Flips zcashd live (CPUQuota/IOWeight/Nice via renice) — no restart.
"""
from __future__ import annotations
import os, sys, re, subprocess, time, datetime, pathlib, argparse

MAX_AGE_MIN = 30      # stale signals (>30 min old) are ignored
AWP_LOG     = pathlib.Path("/var/log/awp/miner-v4.log")
LOG_FILE    = pathlib.Path("/var/log/awp/zcash-failover.log")
DROPIN_DIR  = pathlib.Path("/etc/systemd/system/zcashd.service.d")

ACCEL = dict(CPUQuota="200%", IOWeight="200", Nice="0")
BASE  = dict(CPUQuota="100%", IOWeight="20",  Nice="15")

TS_RE    = re.compile(r"^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),\d+")
DONE_RE  = re.compile(r"round\s+\d+\s+DONE.*accepted=(\d+)")
START_RE = re.compile(r"round\s+\d+\s+START")

def jlog(msg: str) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a") as f:
        f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')} {msg}\n")

def run(cmd: list[str], timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=timeout)

def analyze_log() -> tuple[str, dict]:
    now = time.time()
    cutoff = now - MAX_AGE_MIN * 60
    last_down = None
    last_healthy = None
    counts = dict(down=0, ok=0, start=0, done_ok=0)
    with AWP_LOG.open("rb") as f:
        f.seek(0, 2); size = f.tell()
        f.seek(max(0, size - 1048576))   # tail 1MB
        f.readline()
        for raw in f:
            line = raw.decode("utf-8", errors="replace")
            m = TS_RE.match(line)
            if not m:
                continue
            y, mo, d, hh, mm, ss = (int(x) for x in m.groups())
            ts = time.mktime((y, mo, d, hh, mm, ss, 0, 0, -1))
            if "PoW endpoint DOWN" in line:
                counts["down"] += 1
                last_down = ts
            elif "PoW endpoint OK" in line:
                counts["ok"] += 1
                last_healthy = ts
            elif START_RE.search(line):
                counts["start"] += 1
                last_healthy = ts
            else:
                dm = DONE_RE.search(line)
                if dm and int(dm.group(1)) > 0:
                    counts["done_ok"] += 1
                    last_healthy = ts
    # Filter by MAX_AGE
    d_recent = last_down is not None and last_down >= cutoff
    h_recent = last_healthy is not None and last_healthy >= cutoff
    counts["age_down_min"] = round((now - last_down) / 60, 1) if last_down else None
    counts["age_healthy_min"] = round((now - last_healthy) / 60, 1) if last_healthy else None
    if not d_recent and not h_recent:
        return "no_signal", counts
    if d_recent and h_recent:
        return ("healthy" if last_healthy > last_down else "down"), counts
    return ("healthy" if h_recent else "down"), counts

def zcash_state() -> str:
    r = run(["systemctl", "show", "zcashd", "-p", "CPUQuotaPerSecUSec"])
    m = re.search(r"=([\d.]+)s", r.stdout)
    if not m:
        return "unknown"
    return "accelerated" if float(m.group(1)) >= 1.5 else "baseline"

def apply(mode: str, dry: bool) -> None:
    cfg = ACCEL if mode == "accelerate" else BASE
    if dry:
        jlog(f"DRY_RUN: would {mode} -> {cfg}")
        return
    r = run(["systemctl", "set-property", "--runtime", "zcashd",
             f"CPUQuota={cfg['CPUQuota']}", f"IOWeight={cfg['IOWeight']}"])
    if r.returncode != 0:
        jlog(f"WARN set-property: {r.stderr.strip()}")
    pids = run(["pgrep", "zcashd"]).stdout.strip().splitlines()
    if pids:
        r = run(["renice", "-n", cfg["Nice"], "-p", pids[0]])
        if r.returncode != 0:
            jlog(f"WARN renice: {r.stderr.strip()}")
    DROPIN_DIR.mkdir(parents=True, exist_ok=True)
    (DROPIN_DIR / "55-speedup.conf").write_text(
        f"[Service]\nCPUQuota={cfg['CPUQuota']}\nIOWeight={cfg['IOWeight']}\n")
    (DROPIN_DIR / "60-accelerate.conf").write_text(
        f"[Service]\nNice={cfg['Nice']}\n")
    run(["systemctl", "daemon-reload"])
    jlog(f"APPLIED {mode}: {cfg}")

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not AWP_LOG.exists():
        jlog("SKIP: AWP log missing")
        return 0
    try:
        awp, sig = analyze_log()
    except Exception as e:
        jlog(f"ERROR analyze: {e}")
        return 1
    zcash = zcash_state()
    jlog(f"check awp={awp} zcash={zcash} sig={sig}")
    if awp == "no_signal":
        return 0
    if awp == "healthy" and zcash == "accelerated":
        apply("revert", args.dry_run)
    elif awp == "down" and zcash == "baseline":
        apply("accelerate", args.dry_run)
    return 0

if __name__ == "__main__":
    sys.exit(main())
