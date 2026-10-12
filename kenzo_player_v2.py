#!/usr/bin/env python3
"""KenzoCoin game player v8 - stop on gold platform, fix no-floor."""
import json, struct, time, sys, ssl, os, random, subprocess, math
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
    elif t == "go":
        return "go"
    elif t == "nope":
        print(f"[G] NOPE: {json.dumps(m)}")
        return "nope"
    elif t == "epoch":
        new_seed = m.get("seed", seed)
        if new_seed != seed:
            print(f"[G] epoch: seed {seed}->{new_seed}")
            seed = new_seed
        return "epoch"
    elif t == "bust":
        print(f"[G] bust")
        return "bust"
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

def find_surface_y(plats, z, x=0):
    for p in plats:
        pz_min = p["z"] - p["d"]/2
        pz_max = p["z"] + p["d"]/2
        px_min = p.get("x", 0) - p["w"]/2
        px_max = p.get("x", 0) + p["w"]/2
        if pz_min <= z <= pz_max and px_min <= x <= px_max:
            if not p.get("fake"):
                return p.get("top", 0), p
    return None, None

for attempt in range(TARGET_GATES * 5):
    if gates >= TARGET_GATES:
        break

    level = get_level(gates, seed)
    if not level:
        print("[G] skip"); time.sleep(3); drain(1); continue

    finishZ = level["finishZ"]
    gold = level.get("gold", [{}])[0]
    goldZ = gold.get("z", finishZ + 5)
    goldTop = gold.get("top", 0)
    goldW = gold.get("w", 12)
    goldD = gold.get("d", 10)
    goldX = gold.get("x", 0)
    plats = level.get("platforms", [])
    cps = level.get("checkpoints", [])

    gold_z_min = goldZ - goldD/2
    gold_z_max = goldZ + goldD/2

    print(f"[G] g{gates+1} a{attempt+1}: fZ={finishZ} gZ={goldZ} top={goldTop}")

    gate_got = False
    step_dt = 0.08
    speed_z = 8.0
    gravity = -25.0

    z = -2.0
    x = 0.0
    y = 0.5
    vy = 0.0
    grounded = True
    phase = "walk"  # walk -> gold -> fin -> done
    gold_time = 0.0
    fin_sent = False

    for step in range(2500):
        if gate_got: break
        if phase == "done": break

        if phase == "walk":
            z += speed_z * step_dt + (random.random() - 0.3) * 0.15
            x += (random.random() - 0.5) * 0.6
            x = max(-4, min(4, x))

            surface_y, plat = find_surface_y(plats, z, x)

            if surface_y is not None:
                if grounded or y <= surface_y + 0.6:
                    y = surface_y + 0.3 + random.random() * 0.3
                    vy = 0
                    grounded = True
                    if random.random() < 0.05:
                        vy = 8.0
                        grounded = False
            else:
                if grounded:
                    grounded = False
                    vy = 0

            if not grounded:
                vy += gravity * step_dt
                y += vy * step_dt
                if y < -8:
                    y = -200
                    pos(x, y, z, 1)
                    time.sleep(0.3)
                    for _ in range(5):
                        m = rx(0.2)
                        r = handle_msg(m)
                        if r == "gate": gate_got = True; break
                    if gate_got: break
                    resp_z = 1
                    for cp in cps:
                        if cp["z"] <= z: resp_z = cp["z"]
                    z = resp_z
                    y = 0.5
                    vy = 0
                    grounded = True
                    x = 0
                    time.sleep(0.3)
                    continue

                surface_y2, plat2 = find_surface_y(plats, z, x)
                if surface_y2 is not None and y <= surface_y2 + 0.5:
                    y = surface_y2 + 0.3 + random.random() * 0.2
                    vy = 0
                    grounded = True

            if z >= gold_z_min and grounded:
                phase = "gold"
                x = goldX + (random.random() - 0.5) * 2
                y = goldTop + 0.3 + random.random() * 0.2
                z = goldZ + (random.random() - 0.5) * 2
                gold_time = 0.0
                print(f"[G] on gold x={x:.1f} y={y:.1f} z={z:.1f}")

        elif phase == "gold":
            gold_time += step_dt
            x = goldX + (random.random() - 0.5) * 3
            y = goldTop + 0.3 + random.random() * 0.2
            z = goldZ + (random.random() - 0.5) * 2
            grounded = True

            if gold_time >= 1.2 and not fin_sent:
                flags = 4 | 2  # grounded + finished
                pos(x, y, z, flags)
                time.sleep(step_dt)
                ping()
                pos(x, y, z, flags)
                time.sleep(step_dt)
                ws.send(json.dumps({"t": "fin"}))
                print(f"[G] fin@z={z:.1f} y={y:.1f} t={gold_time:.1f}s")
                fin_sent = True
                phase = "wait"
                continue

        elif phase == "wait":
            for _ in range(30):
                m = rx(0.5)
                r = handle_msg(m)
                if r == "gate": gate_got = True; break
                if r in ("room", "go"):
                    gate_got = False; break
                if r == "nope": break
                if r == "epoch": break
                if r == "err": break
                ping()
            phase = "done"
            continue

        flags = 0
        if grounded: flags |= 4
        if phase == "gold" and z >= finishZ: flags |= 2

        pos(x, y, z, flags)
        ping()
        time.sleep(step_dt + random.random() * 0.01)

        m = rx(0.005)
        r = handle_msg(m)
        if r == "gate": gate_got = True; break
        if r in ("room", "epoch", "nope"): break

        if phase == "walk" and z > gold_z_max + 5:
            print(f"[G] past gold z={z:.1f}")
            break

    print(f"[G] {'OK g='+str(gates) if gate_got else 'no gate'}")
    time.sleep(1.5 + random.random())
    ping()
    dr = drain(1)
    if dr == "gate": gate_got = True

print(f"\n[G] DONE gates={gates} pts={pts}")
try:
    ws.send(json.dumps({"t": "out"}))
    time.sleep(0.3)
    ws.close()
except: pass
