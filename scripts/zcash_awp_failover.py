#!/usr/bin/env python3
"""Auto-revert zcashd tuning when AWP PoW endpoint stabilizes.

Decision (defaults):
  Read tail of /var/log/awp/miner-v4.log; consider entries in last 30 min.
  If total entries >= MIN_EVENTS AND zero "PoW endpoint DOWN" entries
  -> revert zcashd to baseline.

Idempotent: writes /var/lib/zcash-awp-failover/reverted.flag once acted.

Disable: systemctl disable --now zcash-awp-failover.timer
Re-arm (after manual re-tune): rm /var/lib/zcash-awp-failover/reverted.flag
"""
from __future__ import annotations
import os, sys, re, subprocess, time, datetime, pathlib, argparse

WINDOW_MIN  = 30
MIN_EVENTS  = 8
AWP_LOG     = pathlib.Path("/var/log/awp/miner-v4.log")
ZCASH_CONF  = pathlib.Path("/zcash/zcash.conf")
LOG_FILE    = pathlib.Path("/var/log/awp/zcash-failover.log")
MARKER      = pathlib.Path("/var/lib/zcash-awp-failover/reverted.flag")
DROPIN_DIR  = pathlib.Path("/etc/systemd/system/zcashd.service.d")

TS_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),\d+")

def jlog(msg: str) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a") as f:
        f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')} {msg}\n")

def run(cmd: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=timeout)

def already_baseline() -> bool:
    try:
        txt = ZCASH_CONF.read_text()
    except Exception:
        return False
    if re.search(r"^dbcache=800\b", txt, re.M) and not re.search(r"^par=2\b", txt, re.M):
        return True
    return False

def analyze_log() -> tuple[int, int]:
    cutoff = time.time() - WINDOW_MIN * 60
    total = 0
    down = 0
    with AWP_LOG.open("rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - 524288))  # tail 512KB
        f.readline()                   # drop partial line
        for raw in f:
            line = raw.decode("utf-8", errors="replace")
            m = TS_RE.match(line)
            if not m:
                continue
            y, mo, d, hh, mm, ss = (int(x) for x in m.groups())
            ts = time.mktime((y, mo, d, hh, mm, ss, 0, 0, -1))
            if ts < cutoff:
                continue
            total += 1
            if "PoW endpoint DOWN" in line:
                down += 1
    return total, down

def revert(dry_run: bool) -> int:
    if dry_run:
        jlog("DRY_RUN: would revert now")
        print("DRY_RUN: would revert", flush=True)
        return 0

    DROPIN_DIR.mkdir(parents=True, exist_ok=True)
    (DROPIN_DIR / "55-speedup.conf").write_text("[Service]\nCPUQuota=100%\nIOWeight=20\n")
    (DROPIN_DIR / "60-accelerate.conf").write_text("[Service]\nNice=15\n")

    r = run(["systemctl", "daemon-reload"])
    if r.returncode != 0:
        jlog(f"WARN daemon-reload: {r.stderr.strip()}")

    r = run(["systemctl", "set-property", "--runtime", "zcashd", "CPUQuota=100%"])
    if r.returncode != 0:
        jlog(f"WARN set-property: {r.stderr.strip()}")

    try:
        txt = ZCASH_CONF.read_text()
        new = re.sub(r"^dbcache=.*$", "dbcache=800", txt, flags=re.M)
        new = re.sub(r"^par=2\s*\n?", "", new, flags=re.M)
        if new != txt:
            ZCASH_CONF.write_text(new)
            jlog("zcash.conf reverted (dbcache=800, par removed)")
    except Exception as e:
        jlog(f"ERROR editing zcash.conf: {e}")
        return 2

    r = run(["systemctl", "restart", "zcashd"], timeout=120)
    if r.returncode != 0:
        jlog(f"ERROR restart zcashd: {r.stderr.strip()}")
        return 3
    jlog("zcashd restart issued; waiting for RPC")

    rpc_ok = False
    for _ in range(60):
        time.sleep(2)
        rr = run(["zcash-cli", "-conf=/zcash/zcash.conf",
                  "-datadir=/zcash/data", "getblockcount"])
        if rr.returncode == 0 and rr.stdout.strip().isdigit():
            jlog(f"zcashd RPC up, block={rr.stdout.strip()}")
            rpc_ok = True
            break
    if not rpc_ok:
        jlog("WARN: RPC not ready after 120s (zcashd may still be loading)")

    MARKER.parent.mkdir(parents=True, exist_ok=True)
    MARKER.touch()
    jlog(f"MARKER set: {MARKER}")
    return 0

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if MARKER.exists():
        return 0

    if already_baseline():
        jlog("baseline detected; marking and exiting (no work)")
        if not args.dry_run:
            MARKER.parent.mkdir(parents=True, exist_ok=True)
            MARKER.touch()
        return 0

    if not AWP_LOG.exists():
        jlog("SKIP: AWP log missing")
        return 0

    try:
        total, down = analyze_log()
    except Exception as e:
        jlog(f"ERROR analyzing log: {e}")
        return 1

    jlog(f"check window={WINDOW_MIN}m total={total} pow_down={down}")

    if total < MIN_EVENTS:
        jlog(f"SKIP: too few events ({total} < {MIN_EVENTS}); AWP miner may be idle/dead")
        return 0
    if down > 0:
        return 0  # still flapping

    jlog(f"DECISION: AWP stable {WINDOW_MIN}m — reverting")
    return revert(args.dry_run)

if __name__ == "__main__":
    sys.exit(main())
