#!/usr/bin/env python3
"""KenzoCoin game player v3 - correct 8-byte binary, multi-z fin attempts."""
import json, struct, time, sys, ssl, os, random
sys.stdout.reconfigure(line_buffering=True)

try:
    import websocket
except ImportError:
    os.system("pip3 install --break-system-packages websocket-client -q")
    import websocket

tok = sys.argv[1]
handle = sys.argv[2] if len(sys.argv) > 2 else "unknown"
TARGET_GATES = 20

print(f"[G] @{handle}")

ws = websocket.create_connection(
    "wss://kenzocoin.meme/play/ws",
    timeout=15,
    sslopt={"cert_reqs": ssl.CERT_NONE},
    header={"Origin": "https://kenzocoin.meme"},
)
ws.send(json.dumps({"t": "join", "tok": tok}))
print("[G] joined")

gates = 0
pts = 0
lvl = -1
last_ping = 0

def ping():
    global last_ping
    now = time.time()
    if now - last_ping >= 4:
        ws.send(json.dumps({"t": "p", "c": int(now * 1000)}))
        last_ping = now

def pos(x, y, z, flags=4):
    x = max(-511, min(511, x))
    y = max(-500, min(511, y))
    z = max(-511, min(511, z))
    ws.send_binary(struct.pack('<4h', int(x*64), int(y*64), int(z*64), flags))

def rx(timeout=3):
    ws.settimeout(timeout)
    try:
        d = ws.recv()
        if isinstance(d, bytes): return None
        return json.loads(d)
    except: return None

def handle_msg(m):
    global gates, pts, lvl
    if not m: return None
    t = m.get("t")
    if t == "gate":
        me = m.get("me", {})
        gates = me.get("gate", gates)
        pts = me.get("pts", pts)
        gain = m.get("gain", 0)
        print(f"[G] GATE! +{gain} pts={pts} g={gates}")
        return "gate"
    elif t == "room":
        lvl = m.get("lvl", lvl)
        print(f"[G] room lvl={lvl}")
        return "room"
    elif t == "pts":
        pts = m.get("pts", pts)
        lost = m.get("lost", 0)
        if lost: print(f"[G] death -{lost} pts={pts}")
        return "pts"
    elif t == "err":
        print(f"[G] err: {m.get('m')}")
        return "err"
    elif t == "go":
        print("[G] go!")
        return "go"
    elif t == "feed":
        # Show other players clearing gates for debugging
        if m.get("k") == "pass":
            print(f"[G] feed: {m.get('h')} gate {m.get('g')} +{m.get('v')}")
    return t

# Wait for hi + room + go
for _ in range(20):
    m = rx(5)
    if not m: continue
    t = m.get("t")
    if t == "hi":
        print(f"[G] hi seed={m.get('seed')} dur={m.get('dur')} online={m.get('online')}")
        ping()
    elif t == "room":
        lvl = m.get("lvl", 0)
        print(f"[G] room lvl={lvl} players={len(m.get('players',[]))}")
    elif t == "go":
        print("[G] go!")
        break
    elif t == "err":
        print(f"[G] err: {m.get('m')}")
        if m.get("m") == "auth":
            ws.close(); sys.exit(1)

print(f"[G] playing {TARGET_GATES} gates...")

# Try z positions for fin at these thresholds
FIN_Z_TRIES = [55, 65, 75, 85, 95, 105]

for attempt in range(TARGET_GATES * 3):
    if gates >= TARGET_GATES:
        break

    print(f"\n[G] gate {gates+1}/{TARGET_GATES} attempt {attempt+1}")

    z = 0.0
    fin_try_idx = 0
    gate_got = False

    # Move from z=0 to z=120 slowly (~20 seconds)
    for step in range(300):
        z += 0.4 + random.uniform(0, 0.15)
        x = random.uniform(-3, 3)
        # Realistic y: mostly grounded with occasional jumps
        jump_r = random.random()
        if jump_r < 0.12:
            y = 1.0 + random.uniform(2, 7)
            flags = 0  # airborne
        else:
            y = 0.5 + random.uniform(0, 0.5)
            flags = 4  # grounded

        # At each fin threshold, try sending fin with finished flag
        if fin_try_idx < len(FIN_Z_TRIES) and z >= FIN_Z_TRIES[fin_try_idx]:
            target_z = FIN_Z_TRIES[fin_try_idx]
            fin_try_idx += 1
            # Send grounded+finished at center x
            for _ in range(10):
                pos(0, 0.5, target_z + random.uniform(0, 3), 4 | 2)
                time.sleep(0.08)
            ws.send(json.dumps({"t": "fin"}))
            print(f"[G] fin@z={target_z}")
            # Check for response
            for _ in range(10):
                m = rx(0.3)
                r = handle_msg(m)
                if r == "gate":
                    gate_got = True
                    break
                elif r == "room":
                    break
            if gate_got:
                break
            # Continue moving if no gate response
            continue

        pos(x, y, z, flags)
        ping()
        time.sleep(0.07 + random.uniform(0, 0.01))

        m = rx(0.01)
        r = handle_msg(m)
        if r == "gate":
            gate_got = True
            break
        elif r == "room":
            break

    if not gate_got:
        # Final wait for delayed response
        for _ in range(10):
            m = rx(1)
            r = handle_msg(m)
            if r in ("gate", "room", "err", "go"):
                if r == "gate": gate_got = True
                break

    if not gate_got:
        print(f"[G] no gate after z={z:.0f}")

    time.sleep(1.5 + random.uniform(0, 1))
    ping()

    # Drain
    for _ in range(5):
        m = rx(0.3)
        handle_msg(m)

print(f"\n[G] DONE gates={gates} pts={pts}")
try:
    ws.send(json.dumps({"t": "out"}))
    time.sleep(0.3)
    ws.close()
except: pass
