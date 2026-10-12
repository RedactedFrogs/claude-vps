#!/usr/bin/env python3
"""KenzoCoin v11 - full speed through gold, jump gaps, proper physics."""
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
    ws.send_binary(struct.pack('<4h',
        int(max(-511,min(511,x))*64),
        int(max(-500,min(511,y))*64),
        int(max(-511,min(511,z))*64),
        flags))

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
    elif t == "room": return "room"
    elif t == "pts":
        pts = m.get("pts", pts)
        lost = m.get("lost", 0)
        if lost: print(f"[G] death -{lost} pts={pts}")
        return "pts"
    elif t == "err":
        print(f"[G] err: {m.get('m')}")
        return "err"
    elif t == "go": return "go"
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
        r = handle_msg(rx(max(0.05, end - time.time())))
        if r == "gate": return "gate"
    return None

for _ in range(25):
    m = rx(5)
    if not m: continue
    r = handle_msg(m)
    if r == "go": break
    if r == "err" and m.get("m") == "auth":
        ws.close(); sys.exit(1)

if not seed:
    print("[G] no seed"); ws.close(); sys.exit(1)

print(f"[G] playing {TARGET_GATES} gates")

def build_nav(plats, gold):
    """Build navigation: sorted platforms with gap info."""
    safe = [p for p in plats if not p.get("fake")]
    safe.sort(key=lambda p: p["z"])
    nav = []
    for i, p in enumerate(safe):
        entry = {
            "z": p["z"], "x": p.get("x", 0),
            "w": p["w"], "d": p["d"],
            "top": p.get("top", 0),
            "z_start": p["z"] - p["d"]/2,
            "z_end": p["z"] + p["d"]/2,
            "is_gold": p.get("style") == "gold",
        }
        if i < len(safe) - 1:
            nxt = safe[i+1]
            nxt_start = nxt["z"] - nxt["d"]/2
            entry["gap"] = nxt_start - entry["z_end"]
            entry["next_top"] = nxt.get("top", 0)
        else:
            entry["gap"] = 0
            entry["next_top"] = 0
        nav.append(entry)
    return nav

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
    nav = build_nav(plats, gold)

    print(f"[G] g{gates+1} a{attempt+1}: fZ={finishZ} gZ={goldZ} plats={len(nav)}")

    gate_got = False
    DT = 0.08
    SPEED = 8.0
    GRAVITY = -30.0
    JUMP_V = 10.0

    z = -2.0
    x = 0.0
    y = 0.5
    vy = 0.0
    grounded = True
    fin_sent = False
    passed_gold = False
    gold_enter_time = 0

    def cur_nav():
        """Find which nav platform we're on."""
        for n in nav:
            if n["z_start"] - 0.5 <= z <= n["z_end"] + 0.5:
                if abs(x - n["x"]) <= n["w"]/2 + 0.5:
                    return n
        return None

    def should_jump():
        """Check if near platform edge with gap ahead."""
        n = cur_nav()
        if not n: return False
        dist_to_edge = n["z_end"] - z
        if 0 < dist_to_edge < 1.5 and n["gap"] > 1.0:
            return True
        return False

    for step in range(3000):
        if gate_got or fin_sent: break

        # Forward movement
        z += SPEED * DT + (random.random() - 0.4) * 0.08

        # Keep x near center of current platform or 0
        cn = cur_nav()
        target_x = cn["x"] if cn else 0
        x += (target_x - x) * 0.1 + (random.random() - 0.5) * 0.3
        x = max(-4, min(4, x))

        # Jump at platform edges
        if grounded and should_jump():
            vy = JUMP_V
            grounded = False

        # Platform check
        on = cur_nav()
        if on and grounded:
            y = on["top"] + 0.3 + random.random() * 0.15
            vy = 0
        elif on and not grounded and y <= on["top"] + 0.5:
            y = on["top"] + 0.3 + random.random() * 0.1
            vy = 0
            grounded = True
        elif not on and grounded:
            grounded = False
            vy = 0

        # Gravity when airborne
        if not grounded:
            vy += GRAVITY * DT
            y += vy * DT
            # Re-check landing
            on2 = cur_nav()
            if on2 and y <= on2["top"] + 0.5:
                y = on2["top"] + 0.3
                vy = 0
                grounded = True
            # Death
            if y < -10:
                pos(x, -300, z, 1)
                time.sleep(0.2)
                for _ in range(5):
                    r = handle_msg(rx(0.15))
                    if r == "gate": gate_got = True; break
                if gate_got: break
                rz = 1
                for cp in cps:
                    if cp["z"] <= z: rz = cp["z"]
                z = rz; y = 0.5; vy = 0; grounded = True; x = 0
                time.sleep(0.2)
                continue

        # Flags
        flags = 0
        if grounded: flags |= 4
        if z >= finishZ and grounded: flags |= 2

        # Track gold time
        if z >= goldZ and grounded:
            if not passed_gold:
                passed_gold = True
                gold_enter_time = time.time()

        pos(x, y, z, flags)
        ping()
        time.sleep(DT + random.random() * 0.006)

        # Messages
        r = handle_msg(rx(0.005))
        if r == "gate": gate_got = True; break
        if r in ("room", "epoch", "nope"): break

        # Fin: past goldZ for > 1s, grounded
        if passed_gold and grounded and time.time() - gold_enter_time >= 1.0:
            for _ in range(4):
                pos(x, y, z, 4|2)
                time.sleep(DT)
                ping()
            ws.send(json.dumps({"t": "fin"}))
            print(f"[G] fin z={z:.1f} y={y:.1f}")
            fin_sent = True

        # Safety cutoff
        gz_end = goldZ + gold.get("d", 10)/2
        if z > gz_end + 3 and not fin_sent:
            ws.send(json.dumps({"t": "fin"}))
            print(f"[G] late fin z={z:.1f}")
            fin_sent = True
            break

    if fin_sent:
        for _ in range(25):
            r = handle_msg(rx(0.5))
            if r == "gate": gate_got = True; break
            if r in ("room", "go", "nope", "err", "epoch"): break
            ping()

    print(f"[G] {'OK g='+str(gates) if gate_got else 'no gate'}")
    time.sleep(1.5 + random.random())
    ping()
    if drain(1) == "gate": print(f"[G] late gate g={gates}")

print(f"\n[G] DONE gates={gates} pts={pts}")
try:
    ws.send(json.dumps({"t": "out"}))
    time.sleep(0.3)
    ws.close()
except: pass
