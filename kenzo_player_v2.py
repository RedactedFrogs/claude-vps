#!/usr/bin/env python3
"""KenzoCoin v14 - jumps, fin after goldZ center, zigzag."""
import json, struct, time, sys, ssl, os, random, subprocess, math
sys.stdout.reconfigure(line_buffering=True)

try:
    import websocket
except ImportError:
    os.system("pip3 install --break-system-packages websocket-client -q")
    import websocket

tok = sys.argv[1]
handle = sys.argv[2] if len(sys.argv) > 2 else "unknown"
start_gate = int(sys.argv[3]) if len(sys.argv) > 3 else 0
TARGET_GATES = 20
print(f"[G] v14 @{handle} start_gate={start_gate}")

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

gates = start_gate
seed = 0
pts = 0
last_ping = 0
current_lvl = start_gate

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
    global gates, pts, seed, current_lvl
    if not m: return None
    t = m.get("t")
    if t == "gate":
        me = m.get("me", {})
        gates = me.get("gate", gates)
        pts = me.get("pts", pts)
        print(f"[G] GATE! +{m.get('gain',0)} pts={pts} g={gates}")
        return "gate"
    elif t == "room":
        current_lvl = m.get("lvl", current_lvl)
        print(f"[G] room lvl={current_lvl}")
        return "room"
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

print(f"[G] playing gates {gates}->{TARGET_GATES}, lvl={current_lvl}")

def build_nav(plats):
    safe = [p for p in plats if not p.get("fake")]
    safe.sort(key=lambda p: p["z"])
    nav = []
    for i, p in enumerate(safe):
        e = {"z": p["z"], "x": p.get("x",0), "w": p["w"], "d": p["d"],
             "top": p.get("top",0), "z_end": p["z"] + p["d"]/2,
             "z_start": p["z"] - p["d"]/2}
        if i < len(safe)-1:
            nxt = safe[i+1]
            e["gap"] = (nxt["z"] - nxt["d"]/2) - e["z_end"]
        else:
            e["gap"] = 0
        nav.append(e)
    return nav

for attempt in range(TARGET_GATES * 8):
    if gates >= TARGET_GATES:
        break

    lvl_for_gen = current_lvl
    level = get_level(lvl_for_gen, seed)
    if not level:
        print(f"[G] skip lvl={lvl_for_gen}"); time.sleep(3); drain(1); continue

    finishZ = level["finishZ"]
    gold = level.get("gold", [{}])[0]
    goldZ = gold.get("z", finishZ + 5)
    goldTop = gold.get("top", 0)
    gold_d = gold.get("d", 10)
    gold_w = gold.get("w", 12)
    plats = level.get("platforms", [])
    cps = level.get("checkpoints", [])
    nav = build_nav(plats)
    gold_z_start = goldZ - gold_d/2
    gold_z_end = goldZ + gold_d/2

    print(f"[G] g{gates+1} a{attempt+1}: lvl={lvl_for_gen} fZ={finishZ} gZ={goldZ} ge={gold_z_end:.1f} p={len(nav)}")

    gate_got = False
    DT = 0.08
    SPEED = 8.0
    SLOW_SPEED = 3.5
    GRAVITY = -30.0
    JUMP_V = 10.0

    z = -2.0; x = 0.0; y = 0.5; vy = 0.0
    grounded = True; fin_sent = False
    reached_gold_center = False; gold_center_t = 0
    zigzag_dir = 1
    zigzag_timer = 0
    last_jump_z = -999
    jump_count = 0

    def cur_nav():
        for n in nav:
            if n["z_start"] - 0.3 <= z <= n["z_end"] + 0.3:
                if abs(x - n["x"]) <= n["w"]/2 + 0.3:
                    return n
        return None

    def on_gold_plat():
        if gold_z_start - 0.3 <= z <= gold_z_end + 0.3:
            if abs(x) <= gold_w/2 + 0.3:
                return True
        return False

    def should_jump():
        n = cur_nav()
        if not n: return False
        dist = n["z_end"] - z
        return 0 < dist < 1.2 and n["gap"] > 1.0

    for step in range(3000):
        if gate_got or fin_sent: break

        # Speed: full until goldZ, then slow
        if reached_gold_center:
            spd = SLOW_SPEED
        else:
            spd = SPEED

        z += spd * DT + (random.random() - 0.45) * 0.06

        # Zigzag
        zigzag_timer += DT
        if zigzag_timer > 0.7 + random.random() * 0.5:
            zigzag_dir *= -1
            zigzag_timer = 0

        cn = cur_nav()
        if cn:
            zz_off = zigzag_dir * min(cn["w"]/4, 1.8)
            tx = cn["x"] + zz_off
        elif on_gold_plat():
            zz_off = zigzag_dir * min(gold_w/5, 1.5)
            tx = zz_off
        else:
            tx = zigzag_dir * 1.2

        x += (tx - x) * 0.15 + (random.random() - 0.5) * 0.25
        x = max(-5, min(5, x))

        # Periodic random jumps (avoid "never-jumps")
        if grounded and z - last_jump_z > 12 + random.random() * 8 and z < goldZ - 3:
            vy = JUMP_V * (0.6 + random.random() * 0.4)
            grounded = False
            last_jump_z = z
            jump_count += 1

        # Gap jumps
        if grounded and should_jump():
            vy = JUMP_V; grounded = False
            last_jump_z = z
            jump_count += 1

        # Physics
        on = cur_nav()
        if on and grounded:
            y = on["top"] + 0.3 + random.random() * 0.08
            vy = 0
        elif on and not grounded and y <= on["top"] + 0.5:
            y = on["top"] + 0.3
            vy = 0; grounded = True
        elif not on and grounded:
            if on_gold_plat():
                y = goldTop + 0.3 + random.random() * 0.08
                vy = 0
            else:
                grounded = False; vy = 0

        if not grounded:
            vy += GRAVITY * DT
            y += vy * DT
            on2 = cur_nav()
            if on2 and y <= on2["top"] + 0.5:
                y = on2["top"] + 0.3; vy = 0; grounded = True
            elif on_gold_plat() and y <= goldTop + 0.5:
                y = goldTop + 0.3; vy = 0; grounded = True
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

        # Detect reaching gold center (goldZ)
        if z >= goldZ and grounded and on_gold_plat() and not reached_gold_center:
            reached_gold_center = True
            gold_center_t = time.time()
            print(f"[G] gold center z={z:.1f} jumps={jump_count}")

        pos(x, y, z, flags)
        ping()
        time.sleep(DT + random.random() * 0.004)

        r = handle_msg(rx(0.005))
        if r == "gate": gate_got = True; break
        if r in ("room", "epoch", "nope"): break

        # Send fin after 1s on gold center
        if reached_gold_center and grounded and on_gold_plat() and time.time() - gold_center_t >= 1.0:
            for _ in range(5):
                pos(x + (random.random()-0.5)*0.2, y, z + (random.random()-0.5)*0.15, 4|2)
                time.sleep(DT)
                ping()
            ws.send(json.dumps({"t": "fin"}))
            print(f"[G] fin z={z:.1f} y={y:.1f} x={x:.1f}")
            fin_sent = True

        # Safety: if past gold end
        if z > gold_z_end + 2 and not fin_sent:
            ws.send(json.dumps({"t": "fin"}))
            print(f"[G] late fin z={z:.1f}")
            fin_sent = True; break

    if fin_sent:
        for _ in range(30):
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
