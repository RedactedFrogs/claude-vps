#!/usr/bin/env python3
"""KenzoCoin game player v9 - continuous walk, slow on gold, proper physics."""
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
    try:
        out = subprocess.check_output(
            ['node', '/home/boss/kenzo_level_extract.js', str(seed), str(gate)],
            timeout=10, stderr=subprocess.DEVNULL
        )
        return json.loads(out)
    except Exception as e:
        print(f"[G] lvl err: {e}")
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
    ws.send_binary(struct.pack('<4h', int(x*64), int(max(-500,y)*64), int(z*64), flags))

def rx(timeout=3):
    ws.settimeout(timeout)
    try:
        d = ws.recv()
        if isinstance(d, bytes): return None
        return json.loads(d)
    except: return None

def handle_msg(m):
    global gates, pts, seed
    if not m: return None
    t = m.get("t")
    if t == "gate":
        me = m.get("me", {})
        gates = me.get("gate", gates)
        pts = me.get("pts", pts)
        print(f"[G] GATE! +{m.get('gain',0)} pts={pts} g={gates}")
        return "gate"
    elif t == "room":
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
    elif t == "nope":
        print(f"[G] NOPE: {m.get('why')}")
        return "nope"
    elif t == "epoch":
        ns = m.get("seed", seed)
        if ns != seed:
            print(f"[G] epoch {seed}->{ns}")
            seed = ns
        return "epoch"
    elif t == "hi":
        seed = m.get("seed", 0)
        print(f"[G] hi seed={seed}")
        return "hi"
    return t

def drain(t=0.5):
    end = time.time() + t
    while time.time() < end:
        m = rx(max(0.05, end - time.time()))
        r = handle_msg(m)
        if r == "gate": return "gate"
    return None

# Wait for game start
for _ in range(25):
    m = rx(5)
    if not m: continue
    r = handle_msg(m)
    if r == "go": break
    if r == "err" and m.get("m") == "auth":
        ws.close(); sys.exit(1)

if not seed:
    print("[G] no seed"); ws.close(); sys.exit(1)

print(f"[G] playing {TARGET_GATES} gates...")

def on_plat(plats, z, x):
    """Check if position (x, z) is on any non-fake platform. Returns (top, plat) or (None, None)."""
    for p in plats:
        pz = p["z"]
        pd = p["d"]
        pw = p["w"]
        px = p.get("x", 0)
        if abs(z - pz) <= pd/2 and abs(x - px) <= pw/2:
            if not p.get("fake"):
                return p.get("top", 0), p
    return None, None

for attempt in range(TARGET_GATES * 6):
    if gates >= TARGET_GATES:
        break

    level = get_level(gates, seed)
    if not level:
        print("[G] skip"); time.sleep(3); drain(1); continue

    finishZ = level["finishZ"]
    gold = level.get("gold", [{}])[0]
    goldZ = gold.get("z", finishZ + 5)
    goldTop = gold.get("top", 0)
    plats = level.get("platforms", [])
    cps = level.get("checkpoints", [])

    gold_z_start = goldZ - gold.get("d", 10) / 2
    gold_z_end = goldZ + gold.get("d", 10) / 2

    print(f"[G] g{gates+1} a{attempt+1}: fZ={finishZ} gZ={goldZ} top={goldTop}")

    gate_got = False
    DT = 0.08
    SPEED = 8.0
    GRAVITY = -25.0

    z = -2.0
    x = 0.0
    y = 0.5
    vy = 0.0
    grounded = True
    fin_sent = False
    fin_time = 0.0  # time with finished flag

    for step in range(2500):
        if gate_got or fin_sent: break

        # Determine speed: slow down once on gold
        if z >= gold_z_start:
            spd = 2.0 + random.random() * 0.5
        elif z >= finishZ - 5:
            spd = 4.0 + random.random() * 0.5
        else:
            spd = SPEED + (random.random() - 0.3) * 0.5

        # Advance z smoothly
        z += spd * DT

        # Keep x centered (near 0) to stay on platforms
        x += (random.random() - 0.5) * 0.4
        x *= 0.95  # drift toward center
        x = max(-3, min(3, x))

        # Check if on a platform
        ptop, plat = on_plat(plats, z, x)

        if ptop is not None:
            if grounded or y <= ptop + 0.6:
                y = ptop + 0.3 + random.random() * 0.2
                vy = 0
                grounded = True
            # Random jump sometimes (not near gold)
            if grounded and random.random() < 0.04 and z < finishZ - 10:
                vy = 8.0
                grounded = False
        else:
            # Over a gap - fall
            if grounded:
                grounded = False
                vy = 0

        # Gravity
        if not grounded:
            vy += GRAVITY * DT
            y += vy * DT

            # Check for landing
            ptop2, plat2 = on_plat(plats, z, x)
            if ptop2 is not None and y <= ptop2 + 0.5:
                y = ptop2 + 0.3 + random.random() * 0.1
                vy = 0
                grounded = True

            # Death from falling
            if y < -8:
                pos(x, -200, z, 1)  # dead flag
                time.sleep(0.3)
                for _ in range(5):
                    m = rx(0.2)
                    r = handle_msg(m)
                    if r == "gate": gate_got = True; break
                if gate_got: break
                # Respawn at last checkpoint
                rz = 1
                for cp in cps:
                    if cp["z"] <= z: rz = cp["z"]
                z = rz
                y = 0.5
                vy = 0
                grounded = True
                x = 0
                time.sleep(0.3)
                continue

        # Flags
        flags = 0
        if grounded: flags |= 4
        if z >= finishZ and grounded:
            flags |= 2  # finished
            fin_time += DT

        pos(x, y, z, flags)
        ping()
        time.sleep(DT + random.random() * 0.008)

        # Check messages
        m = rx(0.005)
        r = handle_msg(m)
        if r == "gate": gate_got = True; break
        if r in ("room", "epoch", "nope"): break

        # Send fin after 1.5s on gold with finished flag, while grounded
        if fin_time >= 1.5 and grounded and z >= gold_z_start:
            # Send a few more grounded+finished positions
            for _ in range(5):
                x2 = x + (random.random() - 0.5) * 0.3
                pos(x2, y, z, 4 | 2)
                time.sleep(DT)
                ping()
            ws.send(json.dumps({"t": "fin"}))
            print(f"[G] fin z={z:.1f} y={y:.1f} ft={fin_time:.1f}")
            fin_sent = True

        # Safety: stop if way past gold
        if z > gold_z_end + 3:
            if not fin_sent and fin_time > 0.5:
                ws.send(json.dumps({"t": "fin"}))
                print(f"[G] late fin z={z:.1f}")
                fin_sent = True
            break

    # Wait for gate response
    if fin_sent:
        for _ in range(30):
            m = rx(0.5)
            r = handle_msg(m)
            if r == "gate": gate_got = True; break
            if r in ("room", "go", "nope", "err", "epoch"): break
            ping()

    result = f"OK g={gates}" if gate_got else "no gate"
    print(f"[G] {result}")
    time.sleep(1.5 + random.random())
    ping()
    dr = drain(1)
    if dr == "gate":
        gate_got = True
        print(f"[G] late gate! g={gates}")

print(f"\n[G] DONE gates={gates} pts={pts}")
try:
    ws.send(json.dumps({"t": "out"}))
    time.sleep(0.3)
    ws.close()
except: pass
