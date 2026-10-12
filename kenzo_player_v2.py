#!/usr/bin/env python3
"""KenzoCoin game player v2 - play via WebSocket with correct binary format."""
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
    """Send 8-byte position packet: x, y, z (scaled by 64) + status flags.
    Flags: 1=dead, 2=finished, 4=grounded, 8=stunned"""
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

    # Move from z=0 to z=100 over ~10s
    # Levels are ~80-100 units, finishZ around z=55-85
    z = 0.0
    finished_sent = False
    for step in range(180):
        z += 0.65 + random.uniform(0, 0.2)
        x = random.uniform(-3, 3)
        # Simulate jumping
        jump = random.random()
        if jump < 0.15:
            y = 1.0 + random.uniform(2, 6)  # jumping
            grounded = 0
        else:
            y = 1.0 + random.uniform(-0.1, 0.3)  # on ground
            grounded = 4

        # At z > 55 start trying finish (finishZ range 55-85)
        if z > 55 and not finished_sent:
            # Send grounded+finished position
            pos(0, 1.0, z, 4 | 2)  # grounded + finished
            time.sleep(0.08)
            # Send fin message
            ws.send(json.dumps({"t": "fin"}))
            finished_sent = True
            print(f"[G] fin at z={z:.0f}")
            # Keep sending finished+grounded for a bit
            for _ in range(15):
                pos(0, 1.0, z + random.uniform(0, 2), 4 | 2)
                time.sleep(0.08)
                m = rx(0.01)
                if m:
                    t2 = m.get("t")
                    if t2 == "gate":
                        me = m.get("me", {})
                        gates = me.get("gate", gates)
                        pts = me.get("pts", pts)
                        gain = m.get("gain", 0)
                        print(f"[G] GATE! +{gain} pts={pts} g={gates}")
                    elif t2 == "room":
                        lvl = m.get("lvl", lvl)
                        print(f"[G] room lvl={lvl}")
                    elif t2 == "pts":
                        pts = m.get("pts", pts)
                        lost = m.get("lost", 0)
                        if lost: print(f"[G] death -{lost}")
                    elif t2 == "err":
                        print(f"[G] err: {m.get('m')}")
                    elif t2 == "go":
                        print("[G] go!")
            break

        pos(x, y, z, grounded)
        ping()
        time.sleep(0.08 + random.uniform(0, 0.02))

        m = rx(0.01)
        if m:
            t2 = m.get("t")
            if t2 == "gate":
                me = m.get("me", {})
                gates = me.get("gate", gates)
                pts = me.get("pts", pts)
                gain = m.get("gain", 0)
                print(f"[G] GATE! +{gain} pts={pts} g={gates}")
            elif t2 == "room":
                lvl = m.get("lvl", lvl)
                print(f"[G] room lvl={lvl}")
                break
            elif t2 == "pts":
                pts = m.get("pts", pts)
                lost = m.get("lost", 0)
                if lost: print(f"[G] death -{lost}")
            elif t2 == "err":
                print(f"[G] err: {m.get('m')}")
            elif t2 == "go":
                print("[G] go!")

    # If fin sent, wait for gate response
    if finished_sent:
        for _ in range(25):
            m = rx(2)
            if not m: continue
            t2 = m.get("t")
            if t2 == "gate":
                me = m.get("me", {})
                gates = me.get("gate", gates)
                pts = me.get("pts", pts)
                gain = m.get("gain", 0)
                print(f"[G] GATE! +{gain} pts={pts} g={gates}")
                break
            elif t2 == "room":
                lvl = m.get("lvl", lvl)
                print(f"[G] room lvl={lvl}")
                break
            elif t2 == "err":
                print(f"[G] err: {m.get('m')}")
                break
            elif t2 == "go":
                print("[G] go!")
                break
    else:
        print("[G] never reached fin z")

    time.sleep(1 + random.uniform(0, 0.5))
    ping()

    # Drain
    for _ in range(5):
        m = rx(0.5)
        if not m: break
        t2 = m.get("t")
        if t2 == "gate":
            me = m.get("me", {})
            gates = me.get("gate", gates)
            pts = me.get("pts", pts)
            print(f"[G] late gate g={gates} pts={pts}")
        elif t2 == "room":
            lvl = m.get("lvl", lvl)

print(f"\n[G] DONE gates={gates} pts={pts}")
try:
    ws.send(json.dumps({"t": "out"}))
    time.sleep(0.3)
    ws.close()
except: pass
