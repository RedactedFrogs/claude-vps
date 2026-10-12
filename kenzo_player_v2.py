#!/usr/bin/env python3
"""KenzoCoin game player v4 - uses level extractor for exact positions."""
import json, struct, time, sys, ssl, os, random, subprocess
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

def get_level(gate, seed):
    """Run the JS level extractor to get exact level layout."""
    try:
        out = subprocess.check_output(
            ['node', '/home/boss/kenzo_level_extract.js', str(seed), str(gate)],
            timeout=10, stderr=subprocess.DEVNULL
        )
        return json.loads(out)
    except Exception as e:
        print(f"[G] level extract failed: {e}")
        return None

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
seed = 0
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
        print(f"[G] GATE! +{m.get('gain',0)} pts={pts} g={gates}")
        return "gate"
    elif t == "room":
        lvl = m.get("lvl", lvl)
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
        return "go"
    return t

# Wait for hi + room + go
for _ in range(20):
    m = rx(5)
    if not m: continue
    t = m.get("t")
    if t == "hi":
        seed = m.get("seed", 0)
        print(f"[G] hi seed={seed} dur={m.get('dur')} online={m.get('online')}")
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

if not seed:
    print("[G] no seed received")
    ws.close(); sys.exit(1)

print(f"[G] playing {TARGET_GATES} gates...")

for attempt in range(TARGET_GATES * 3):
    if gates >= TARGET_GATES:
        break

    # Get exact level layout
    level = get_level(gates, seed)
    if not level:
        print(f"[G] no level data, using fallback")
        finishZ = 85.0
        goldZ = 90.0
        checkpoints = [1, 30, 60]
        platforms = []
    else:
        finishZ = level.get("finishZ", 85)
        gold = level.get("gold", [{}])[0]
        goldZ = gold.get("z", finishZ + 5)
        goldTop = gold.get("top", 0)
        checkpoints = [cp["z"] for cp in level.get("checkpoints", [])]
        platforms = level.get("platforms", [])
        print(f"[G] gate {gates+1}: finishZ={finishZ} goldZ={goldZ} cps={checkpoints}")

    gate_got = False

    # Navigate through the level following actual platforms
    z = 0.0
    target_z = goldZ + 3
    step_size = 0.55 + random.uniform(0, 0.15)  # ~7 units/sec at 80ms interval

    for step in range(500):
        z += step_size + (random.random() - 0.3) * 0.1
        if z > target_z:
            break

        # Find which platform we should be on
        on_plat = None
        for p in platforms:
            pz_min = p["z"] - p["d"]/2
            pz_max = p["z"] + p["d"]/2
            px_min = p["x"] - p["w"]/2
            px_max = p["x"] + p["w"]/2
            if pz_min <= z <= pz_max:
                on_plat = p
                break

        if on_plat:
            # On a platform - stay within its bounds
            px = on_plat["x"] + (random.random() - 0.5) * max(1, on_plat["w"] - 2)
            py = on_plat.get("top", 0) + 0.5 + random.random() * 0.3
            flags = 4  # grounded

            # Occasionally jump
            if random.random() < 0.06:
                py += 2 + random.random() * 3
                flags = 0  # airborne
        else:
            # Between platforms or in a gap - jumping/airborne
            px = (random.random() - 0.5) * 6
            py = 1.0 + random.random() * 4
            flags = 0  # airborne

        # At finish area, set finished flag
        if z >= finishZ:
            px = 0 + (random.random() - 0.5) * 4  # stay centered on gold
            py = goldTop + 0.5 + random.random() * 0.3
            flags = 4 | 2  # grounded + finished

        pos(px, py, z, flags)
        ping()
        time.sleep(0.08 + random.random() * 0.015)

        # Check for messages
        m = rx(0.01)
        r = handle_msg(m)
        if r == "gate":
            gate_got = True
            break
        if r == "room" or r == "go":
            break

    if not gate_got and z >= goldZ - 2:
        # Stay on gold platform and send fin
        for _ in range(20):
            pos(
                (random.random() - 0.5) * 4,
                goldTop + 0.5 + random.random() * 0.2,
                goldZ + random.random() * 3,
                4 | 2  # grounded + finished
            )
            ping()
            time.sleep(0.08)
            m = rx(0.01)
            if handle_msg(m) == "gate":
                gate_got = True
                break

        if not gate_got:
            ws.send(json.dumps({"t": "fin"}))
            print(f"[G] fin@z={goldZ:.1f}")

            # Wait for response
            for _ in range(20):
                m = rx(1)
                r = handle_msg(m)
                if r == "gate":
                    gate_got = True
                    break
                if r in ("room", "go", "err"):
                    break

    if gate_got:
        print(f"[G] gate {gates}/{TARGET_GATES} cleared!")
    else:
        print(f"[G] no gate after z={z:.1f}")

    time.sleep(1.5 + random.random())
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
