#!/usr/bin/env python3
"""Staggered registration orchestrator for 250 wallets.

Polls registration status every cycle. If wallet-NNN not yet registered, tries.
Sleeps STAGGER_SEC between attempts. Stops when all 250 done.
"""
import os, sys, time, subprocess, random

STAGGER_MIN = 30
STAGGER_MAX = 60
WALLETS_DIR = "/root/.depinzcash-multi/wallets"
STATE_DIR = "/root/.depinzcash-multi/state"
LOG = "/var/log/awp/depinzcash-multi.log"
REGISTER = "/root/.depinzcash-multi/scripts/register_one.py"

def log(msg):
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} ORCHESTRATOR: {msg}\n")

def list_unregistered():
    todo = []
    for i in range(1, 251):
        state_file = f"{STATE_DIR}/wallet-{i:03d}.state.json"
        if os.path.exists(state_file):
            continue
        todo.append(i)
    return todo

def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    log("orchestrator started")
    
    while True:
        todo = list_unregistered()
        if not todo:
            log("all 250 wallets registered — exiting")
            break
        
        # Shuffle order so we don't always start from wallet-001
        random.shuffle(todo)
        i = todo[0]
        
        try:
            r = subprocess.run([REGISTER, str(i)], capture_output=True, text=True, timeout=60)
            if r.returncode == 0:
                log(f"wallet-{i:03d} OK: {r.stdout.strip()}")
            else:
                # Don't log every 403 — only every 20th
                stamp = int(time.time())
                if stamp % 20 == 0:
                    log(f"wallet-{i:03d} fail rc={r.returncode}: {(r.stderr or r.stdout).strip()[:120]}")
        except subprocess.TimeoutExpired:
            log(f"wallet-{i:03d} TIMEOUT")
        except Exception as e:
            log(f"wallet-{i:03d} EXC: {e}")
        
        sleep_s = random.randint(STAGGER_MIN, STAGGER_MAX)
        time.sleep(sleep_s)

if __name__ == "__main__":
    main()
