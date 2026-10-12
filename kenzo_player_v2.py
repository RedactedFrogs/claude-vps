#!/usr/bin/env python3
"""KenzoCoin game player v2 - play via WebSocket."""
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

def pos(x, y, z):
    x = max(-511, min(511, x))
    y = max(-500, min(511, y))
    z = max(-511, min(511, z))
    ws.send_binary(struct.pack('<3h', int(x*64), int(y*64), int(z*64)))

def rx(timeout=3):
    ws.settimeout(timeout)
    try:
        d = ws.recv()
        if isinstance(d, bytes): return None
        return json.loads(d)
    except: return None

# Wait for hi + room + go
for _ in range(20):
    m = rx(5)
    if not m: continue
    t = m.get("t")
    if t == "hi":
        print(f"[G] hi seed={m.get('seed')}")
        ping()
    elif t == "room":
        lvl = m.get("lvl", 0)
        print(f"[G] room lvl={lvl}")
    elif t == "go":
        print("[G] go!")
        break
    elif t == "err":
        print(f"[G] err: {m.get('m')}")
        if m.get("m") == "auth":
            ws.close(); sys.exit(1)

print(f"[G] playing {TARGET_GATES} gates...")

for attempt in range(TARGET_GATES * 3):
    if gates >= TARGET_GATES:
        break

    print(f"\n[G] gate {gates+1}/{TARGET_GATES} attempt {attempt+1}")

    # Move from z=0 to z=120 over ~10s
    # Levels are ~80-100 units, finishZ around z=55-85
    z = 0.0
    for step in range(140):
        z += 0.85 + random.uniform(0, 0.3)
        x = random.uniform(-2.5, 2.5)
        jump = random.random()
        if jump < 0.25:
            y = 1.0 + random.uniform(1, 5)
        else:
            y = 1.0 + random.uniform(-0.3, 0.5)

        pos(x, y, z)
        ping()
        time.sleep(0.08 + random.uniform(0, 0.02))

        m = rx(0.01)
        if m:
            t = m.get("t")
            if t == "gate":
                me = m.get("me", {})
                gates = me.get("gate", gates)
                pts = me.get("pts", pts)
                gain = m.get("gain", 0)
                print(f"[G] GATE! +{gain} pts={pts} g={gates}")
            elif t == "room":
                lvl = m.get("lvl", lvl)
                print(f"[G] room lvl={lvl}")
                break
            elif t == "pts":
                pts = m.get("pts", pts)
                lost = m.get("lost", 0)
                if lost: print(f"[G] death -{lost}")
            elif t == "err":
                print(f"[G] err: {m.get('m')}")
            elif t == "go":
                print("[G] go!")

    # Send fin
    print(f"[G] z={z:.0f} fin")
    ws.send(json.dumps({"t": "fin"}))

    # Wait for gate response
    got = False
    for _ in range(20):
        m = rx(2)
        if not m: continue
        t = m.get("t")
        if t == "gate":
            me = m.get("me", {})
            gates = me.get("gate", gates)
            pts = me.get("pts", pts)
            gain = m.get("gain", 0)
            print(f"[G] GATE! +{gain} pts={pts} g={gates}")
            got = True
            break
        elif t == "room":
            lvl = m.get("lvl", lvl)
            print(f"[G] room lvl={lvl}")
            got = True
            break
        elif t == "err":
            print(f"[G] err: {m.get('m')}")
            break
        elif t == "go":
            print("[G] go!")
            break
        elif t in ("pts",):
            pts = m.get("pts", pts)

    if not got:
        print("[G] no gate resp")

    time.sleep(1 + random.uniform(0, 0.5))
    ping()

    # Drain
    for _ in range(5):
        m = rx(0.5)
        if not m: break
        t = m.get("t")
        if t == "gate":
            me = m.get("me", {})
            gates = me.get("gate", gates)
            pts = me.get("pts", pts)
            print(f"[G] late gate g={gates} pts={pts}")
        elif t == "room":
            lvl = m.get("lvl", lvl)

print(f"\n[G] DONE gates={gates} pts={pts}")
try:
    ws.send(json.dumps({"t": "out"}))
    time.sleep(0.3)
    ws.close()
except: pass
