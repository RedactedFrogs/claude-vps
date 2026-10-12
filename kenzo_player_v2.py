#!/usr/bin/env python3
"""KenzoCoin v22 - fix double y-update in jumps + tuned gap gravity."""
import json, struct, time, sys, ssl, os, random, subprocess
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
MAX_DEATHS = 8
print(f"[G] v22 @{handle} start_gate={start_gate}")

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

def make_ws():
    ws = websocket.create_connection(
        "wss://kenzocoin.meme/play/ws",
        timeout=15,
        sslopt={"cert_reqs": ssl.CERT_NONE},
        header={"Origin": "https://kenzocoin.meme"},
    )
    ws.send(json.dumps({"t": "join", "tok": tok}))
    return ws

ws = make_ws()
print("[G] joined")

gates = start_gate
seed = 0
pts = 0
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
    elif t == "room":
        print(f"[G] room lvl={m.get('lvl')}")
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

def drain_check(t=1.0):
    end = time.time() + t
    while time.time() < end:
        r = handle_msg(rx(max(0.05, end - time.time())))
        if r in ("gate", "nope"): return r
    return None

def wait_for_go():
    for _ in range(25):
        m = rx(5)
        if not m: continue
        r = handle_msg(m)
        if r == "go": return True
        if r == "err" and m.get("m") == "auth":
            return False
    return seed != 0

wait_for_go()
if not seed:
    print("[G] no seed"); ws.close(); sys.exit(1)

print(f"[G] playing from gate={gates}")

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
            e["next_x"] = nxt.get("x", 0)
            e["next_top"] = nxt.get("top", 0)
        else:
            e["gap"] = 0
            e["next_x"] = 0
            e["next_top"] = 0
        nav.append(e)
    return nav

def reconnect():
    global ws, seed
    try: ws.close()
    except: pass
    time.sleep(1.5 + random.random() * 1.5)
    ws = make_ws()
    seed = 0
    if wait_for_go() and seed:
        print(f"[G] reconnected seed={seed}")
        return True
    print("[G] reconnect failed")
    return False

for attempt in range(TARGET_GATES * 10):
    if gates >= TARGET_GATES:
        break

    level = get_level(gates, seed)
    if not level:
        print(f"[G] skip gate={gates}"); time.sleep(3); drain_check(1); continue

    finishZ = level["finishZ"]
    gold = level.get("gold", [{}])[0]
    goldZ = gold.get("z", finishZ + 5)
    goldTop = gold.get("top", 0)
    gold_d = gold.get("d", 10)
    gold_w = gold.get("w", 12)
    plats = level.get("platforms", [])
    cps = level.get("checkpoints", [])
    nav = build_nav(plats)
    gold_z_end = goldZ + gold_d/2

    print(f"[G] g{gates+1} a{attempt+1}: gate={gates} fZ={finishZ} gZ={goldZ} p={len(nav)} cp={len(cps)}")

    gate_got = False
    noped = False
    deaths = 0
    DT = 0.08
    SPEED = 8.0
    SPEED_AIR = 9.0
    GRAVITY_NORMAL = -30.0
    GRAVITY_GAP = -16.0
    JUMP_V = 10.0

    z = -2.0; x = 0.0; y = 0.5; vy = 0.0
    grounded = True; fin_sent = False
    in_gap_jump = False
    finished_flag_t = 0
    zigzag_dir = 1
    zigzag_timer = 0
    last_jump_z = -10
    jump_count = 0
    start_time = time.time()

    def cur_nav():
        for n in nav:
            if n["z_start"] - 0.3 <= z <= n["z_end"] + 0.3:
                if abs(x - n["x"]) <= n["w"]/2 + 0.3:
                    return n
        return None

    def on_gold_plat():
        gz_start = goldZ - gold_d/2
        if gz_start - 0.3 <= z <= gold_z_end + 0.3:
            if abs(x) <= gold_w/2 + 0.3:
                return True
        return False

    def approaching_gap():
        n = cur_nav()
        if not n: return False, 0
        dist = n["z_end"] - z
        if 0 < dist < 3.0 and n["gap"] > 1.0:
            return True, n["gap"]
        return False, 0

    def next_plat_for(zpos):
        for n in nav:
            if n["z_start"] > zpos:
                return n
        return None

    for step in range(5000):
        if gate_got or fin_sent or deaths >= MAX_DEATHS: break

        spd = SPEED_AIR if in_gap_jump else SPEED
        z += spd * DT + (random.random() - 0.45) * 0.06

        # Zigzag
        zigzag_timer += DT
        if zigzag_timer > 0.5 + random.random() * 0.4:
            zigzag_dir *= -1
            zigzag_timer = 0

        cn = cur_nav()
        if cn:
            dist_to_edge = cn["z_end"] - z
            if dist_to_edge < 4 and cn["gap"] > 1.0:
                tx = cn.get("next_x", cn["x"])
            else:
                zz_off = zigzag_dir * min(cn["w"]/4, 1.8)
                tx = cn["x"] + zz_off
        elif on_gold_plat():
            zz_off = zigzag_dir * min(gold_w/5, 1.5)
            tx = zz_off
        else:
            nxt = next_plat_for(z)
            if nxt:
                tx = nxt["x"]
            else:
                tx = zigzag_dir * 1.0

        x += (tx - x) * 0.15 + (random.random() - 0.5) * 0.2
        x = max(-5, min(5, x))

        # Gap jumps (no initial y += vy*DT — let physics handle it)
        if grounded:
            at_gap, gap_w = approaching_gap()
            if at_gap:
                vy = JUMP_V
                grounded = False
                in_gap_jump = True
                last_jump_z = z
                jump_count += 1
            elif z - last_jump_z > 5 + random.random() * 2 and z < goldZ - 2:
                vy = JUMP_V
                grounded = False
                in_gap_jump = False
                last_jump_z = z
                jump_count += 1

        # Physics
        gravity = GRAVITY_GAP if in_gap_jump else GRAVITY_NORMAL

        if grounded:
            on = cur_nav()
            if on:
                y = on["top"] + 0.3 + random.random() * 0.08
                vy = 0
            elif on_gold_plat():
                y = goldTop + 0.3 + random.random() * 0.08
                vy = 0
            else:
                # Fell off edge: coyote jump
                grounded = False
                vy = JUMP_V * 0.7
                in_gap_jump = True
                jump_count += 1
        else:
            vy += gravity * DT
            y += vy * DT
            if vy <= 0:
                on = cur_nav()
                if on and y <= on["top"] + 0.5:
                    y = on["top"] + 0.3
                    vy = 0
                    grounded = True
                    in_gap_jump = False
                elif on_gold_plat() and y <= goldTop + 0.5:
                    y = goldTop + 0.3
                    vy = 0
                    grounded = True
                    in_gap_jump = False

            if y < -10:
                deaths += 1
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
                in_gap_jump = False
                time.sleep(0.2)
                continue

        flags = 0
        if grounded: flags |= 4
        if z >= finishZ + 1 and grounded:
            flags |= 2
            if finished_flag_t == 0:
                finished_flag_t = time.time()

        pos(x, y, z, flags)
        ping()
        time.sleep(DT + random.random() * 0.004)

        r = handle_msg(rx(0.005))
        if r == "gate": gate_got = True; break
        if r == "nope": noped = True; break
        if r == "room": break

        if finished_flag_t > 0 and grounded and time.time() - finished_flag_t >= 1.0:
            if on_gold_plat() or z >= goldZ:
                for _ in range(3):
                    pos(x + (random.random()-0.5)*0.2, y, z, 4|2)
                    time.sleep(DT)
                ws.send(json.dumps({"t": "fin"}))
                print(f"[G] fin z={z:.1f} y={y:.1f} j={jump_count} d={deaths} t={time.time()-start_time:.1f}s")
                fin_sent = True
            elif z > gold_z_end:
                ws.send(json.dumps({"t": "fin"}))
                print(f"[G] late fin z={z:.1f}")
                fin_sent = True; break

    if deaths >= MAX_DEATHS and not gate_got and not fin_sent:
        print(f"[G] death cap ({deaths}) -> reconnect")
        if not reconnect():
            break
        continue

    if fin_sent and not gate_got and not noped:
        for _ in range(40):
            r = handle_msg(rx(0.4))
            if r == "gate": gate_got = True; break
            if r == "nope": noped = True; break
            if r in ("room", "go", "err"): break
            ping()

    if not gate_got and not noped:
        r = drain_check(2.0)
        if r == "gate": gate_got = True
        elif r == "nope": noped = True

    if noped:
        print(f"[G] nope -> reconnect")
        if not reconnect():
            break
        continue

    print(f"[G] {'OK g='+str(gates) if gate_got else 'no gate'}")
    time.sleep(1.0 + random.random())
    ping()
    r = drain_check(1.0)
    if r == "gate": print(f"[G] late gate g={gates}")
    elif r == "nope":
        print(f"[G] late nope -> reconnect")
        if not reconnect():
            break

print(f"\n[G] DONE gates={gates} pts={pts}")
try:
    ws.send(json.dumps({"t": "out"}))
    time.sleep(0.3)
    ws.close()
except: pass
