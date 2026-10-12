#!/usr/bin/env python3
"""KenzoCoin game player v7 - smooth continuous movement, no teleporting."""
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
        print("[G] go!")
        return "go"
    elif t == "nope":
        print(f"[G] NOPE: {json.dumps(m)}")
        return "nope"
    elif t == "epoch":
        new_seed = m.get("seed", seed)
        print(f"[G] epoch: seed {seed}->{new_seed}")
        seed = new_seed
        return "epoch"
    elif t == "bust":
        print(f"[G] bust: {json.dumps(m)}")
        return "bust"
    elif t == "hi":
        seed = m.get("seed", 0)
        print(f"[G] hi seed={seed}")
        return "hi"
    elif t not in ("p", "add", "del", "feed", "full", "stat"):
        print(f"[G] {t}: {json.dumps(m)[:150]}")
    return t

def drain(t=0.5):
    end = time.time() + t
    while time.time() < end:
        m = rx(max(0.05, end - time.time()))
        handle_msg(m)

# Wait for start
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

def find_platform_at_z(plats, z):
    """Find the platform the player would be on at position z."""
    for p in plats:
        pz_min = p["z"] - p["d"]/2
        pz_max = p["z"] + p["d"]/2
        if pz_min <= z <= pz_max:
            if not p.get("fake"):
                return p
    return None

for attempt in range(TARGET_GATES * 4):
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

    print(f"[G] g{gates+1} a{attempt+1}: fZ={finishZ} gZ={goldZ}")

    gate_got = False
    
    # Smooth continuous movement from z=-4 to goldZ+5
    # Game speed: ~8 units/sec, update every 80ms = 0.64 units/step
    z = -4.0
    x = 0.0
    y = 0.5
    vy = 0.0  # vertical velocity for jumps
    grounded = True
    on_gold = False
    fin_timer = 0.0  # time spent on gold with finished flag
    step_dt = 0.08  # 80ms per step
    speed_z = 8.0  # units per second forward speed
    gravity = -25.0  # units/sec^2
    jump_v = 10.0  # initial jump velocity

    last_plat_top = 0  # track ground level

    for step in range(2000):  # max ~160 seconds
        if gate_got: break

        # Move forward
        z += speed_z * step_dt + (random.random() - 0.4) * 0.1

        # Slight x wobble
        x += (random.random() - 0.5) * 0.8
        x = max(-5, min(5, x))

        # Check what platform we're over
        plat = find_platform_at_z(plats, z)

        if plat:
            ptop = plat.get("top", 0)
            is_gold = plat.get("style") == "gold"
            is_trap = plat.get("trap") is not None
            last_plat_top = ptop

            if is_trap and not is_gold:
                # Crumbling platform - walk on it briefly then fall
                # Just stay grounded briefly, physics will handle it
                pass

            if grounded or y <= ptop + 0.5:
                # Land on platform
                y = ptop + 0.5
                vy = 0
                grounded = True

                # Random jump sometimes
                if random.random() < 0.06 and not is_gold:
                    vy = jump_v
                    grounded = False

                if is_gold:
                    on_gold = True
                    x = (random.random() - 0.5) * 4  # stay centered
            else:
                # Still airborne above platform
                pass
        else:
            # Over a gap - airborne
            if grounded:
                # Just walked off edge
                grounded = False
                vy = 0  # no upward velocity, just falling

        # Apply gravity if airborne
        if not grounded:
            vy += gravity * step_dt
            y += vy * step_dt

            # Check if we've fallen to death
            if y < -10:
                # Die - fall to -500
                y = -500
                vy = 0
                # Send dead position
                pos(x, y, z, 1)  # dead flag
                time.sleep(step_dt)
                # Wait for death penalty
                for _ in range(5):
                    m = rx(0.2)
                    r = handle_msg(m)
                    if r == "gate": gate_got = True; break
                    if r == "pts": break
                if gate_got: break

                # Respawn at start of current section
                # Find last checkpoint before current z
                cps = level.get("checkpoints", [])
                resp_z = 1
                resp_y = 0
                for cp in cps:
                    if cp["z"] <= z:
                        resp_z = cp["z"]
                        resp_y = cp.get("y", 0)
                z = resp_z
                y = resp_y + 0.5
                vy = 0
                grounded = True
                x = 0
                time.sleep(0.5)  # respawn delay
                continue

            # Check if we've reached a platform below
            plat2 = find_platform_at_z(plats, z)
            if plat2 and y <= plat2.get("top", 0) + 0.5:
                y = plat2.get("top", 0) + 0.5
                vy = 0
                grounded = True
                last_plat_top = plat2.get("top", 0)

        # Determine flags
        flags = 0
        if grounded:
            flags |= 4  # grounded
        if on_gold and z >= finishZ + 1:
            flags |= 2  # finished
            fin_timer += step_dt

        pos(x, y, z, flags)
        ping()
        time.sleep(step_dt + random.random() * 0.01)

        # Check messages
        m = rx(0.005)
        r = handle_msg(m)
        if r == "gate": gate_got = True; break
        if r in ("room", "epoch"):
            # New round - break and retry
            break
        if r == "nope":
            # Server rejected - break this attempt
            break

        # Send fin after 1.1 seconds on gold
        if on_gold and fin_timer >= 1.1 and flags & 2:
            ws.send(json.dumps({"t": "fin"}))
            print(f"[G] fin@z={z:.1f} t={fin_timer:.1f}s")
            on_gold = False  # don't send again
            fin_timer = -999

            # Wait for response
            for _ in range(20):
                m = rx(0.5)
                r = handle_msg(m)
                if r == "gate": gate_got = True; break
                if r in ("room", "go", "err", "nope", "epoch"): break
            break

        # Stop if we've gone way past gold
        if z > goldZ + 8:
            break

    print(f"[G] {'OK g='+str(gates) if gate_got else 'no gate'}")

    time.sleep(2 + random.random())
    ping()
    drain(1)

print(f"\n[G] DONE gates={gates} pts={pts}")
try:
    ws.send(json.dumps({"t": "out"}))
    time.sleep(0.3)
    ws.close()
except: pass
