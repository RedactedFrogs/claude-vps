#!/usr/bin/env python3
"""KenzoCoin game player v5 - realistic platform-by-platform navigation."""
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
        print(f"[G] level extract err: {e}")
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
    global gates, pts
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
    elif t == "bust":
        print(f"[G] bust")
        return "bust"
    elif t not in ("p", "add", "del", "feed", "full"):
        print(f"[G] msg: t={t} keys={list(m.keys())}")
    return t

def drain(t=0.5):
    results = []
    end = time.time() + t
    while time.time() < end:
        m = rx(max(0.05, end - time.time()))
        r = handle_msg(m)
        if r: results.append(r)
    return results

# Wait for hi + room + go
for _ in range(25):
    m = rx(5)
    if not m: continue
    t = m.get("t")
    if t == "hi":
        seed = m.get("seed", 0)
        print(f"[G] hi seed={seed}")
        ping()
    elif t == "room":
        print(f"[G] room lvl={m.get('lvl')}")
    elif t == "go":
        print("[G] go!")
        break
    elif t == "err":
        print(f"[G] err: {m.get('m')}")
        if m.get("m") == "auth":
            ws.close(); sys.exit(1)

if not seed:
    print("[G] no seed"); ws.close(); sys.exit(1)

print(f"[G] playing {TARGET_GATES} gates...")

for attempt in range(TARGET_GATES * 3):
    if gates >= TARGET_GATES:
        break

    level = get_level(gates, seed)
    if not level:
        print("[G] skip - no level data")
        time.sleep(2); continue

    finishZ = level["finishZ"]
    gold = level.get("gold", [{}])[0]
    goldZ = gold.get("z", finishZ + 5)
    goldW = gold.get("w", 12)
    goldD = gold.get("d", 10)
    goldTop = gold.get("top", 0)
    cps = level.get("checkpoints", [])
    plats = sorted(level.get("platforms", []), key=lambda p: p["z"])

    print(f"[G] g{gates+1} a{attempt+1}: fZ={finishZ} gZ={goldZ} cps={[c['z'] for c in cps]} plats={len(plats)}")

    gate_got = False

    # Navigate platform by platform
    for pi, plat in enumerate(plats):
        if gate_got:
            break

        pz = plat["z"]
        pw = plat["w"]
        pd = plat["d"]
        ptop = plat.get("top", 0)
        pstyle = plat.get("style", "floor")
        is_gold = pstyle == "gold"
        is_trap = plat.get("trap") is not None

        # Skip trap platforms (they crumble)
        if is_trap and not is_gold:
            # Touch briefly then fall
            for _ in range(3):
                pos(0, ptop + 0.5, pz, 4)
                time.sleep(0.08)
            # Fall to death
            for fy in range(5):
                pos(0, ptop - fy * 5, pz, 0 if fy < 3 else 1)
                time.sleep(0.08)
            drain(0.5)
            continue

        # Calculate time to spend on this platform (slower = more natural)
        pz_start = pz - pd/2
        pz_end = pz + pd/2
        steps_on = max(8, int(pd / 0.4))  # ~0.4 units per step

        z_cur = pz_start
        for step in range(steps_on):
            z_cur = pz_start + (pz_end - pz_start) * step / max(1, steps_on - 1)
            x_cur = (random.random() - 0.5) * min(pw - 1, 6)

            # Y position: on platform surface
            y_cur = ptop + 0.5 + random.random() * 0.2
            flags = 4  # grounded

            # Occasional jump
            if random.random() < 0.08 and not is_gold:
                y_cur = ptop + 2 + random.random() * 3
                flags = 0  # airborne

            if is_gold:
                flags = 4 | 2  # grounded + finished
                x_cur = (random.random() - 0.5) * 4

            pos(x_cur, y_cur, z_cur, flags)
            ping()
            time.sleep(0.08 + random.random() * 0.01)

            m = rx(0.005)
            r = handle_msg(m)
            if r == "gate":
                gate_got = True; break
            if r == "room" or r == "go":
                break

        if gate_got:
            break

        # Gap between this platform and next
        if pi < len(plats) - 1:
            next_plat = plats[pi + 1]
            gap_start = pz_end
            gap_end = next_plat["z"] - next_plat["d"]/2
            gap = gap_end - gap_start

            if gap > 1:
                # Jump across the gap
                jump_steps = max(4, int(gap / 0.8))
                for js_i in range(jump_steps):
                    frac = js_i / max(1, jump_steps - 1)
                    jz = gap_start + gap * frac
                    # Parabolic y trajectory
                    jy = ptop + 0.5 + 4 * (frac - frac*frac) * 4
                    jx = (random.random() - 0.5) * 3
                    pos(jx, jy, jz, 0)  # airborne
                    time.sleep(0.08)

    # After all platforms, if not gate yet, send fin on gold
    if not gate_got:
        # Stay on gold platform sending finished+grounded
        print(f"[G] on gold z={goldZ}")
        for _ in range(25):
            pos(
                (random.random() - 0.5) * 4,
                goldTop + 0.5 + random.random() * 0.2,
                goldZ + (random.random() - 0.5) * 3,
                4 | 2
            )
            ping()
            time.sleep(0.08)
            m = rx(0.005)
            if handle_msg(m) == "gate":
                gate_got = True; break

        if not gate_got:
            # Wait 1.1 seconds like real client before sending fin
            time.sleep(1.1)
            ws.send(json.dumps({"t": "fin"}))
            print(f"[G] fin sent")

            for _ in range(25):
                m = rx(1)
                r = handle_msg(m)
                if r == "gate":
                    gate_got = True; break
                if r in ("room", "go", "err", "bust"):
                    break

    if gate_got:
        print(f"[G] cleared {gates}/{TARGET_GATES}")
    else:
        print(f"[G] no gate")

    time.sleep(1.5 + random.random())
    ping()
    drain(0.5)

print(f"\n[G] DONE gates={gates} pts={pts}")
try:
    ws.send(json.dumps({"t": "out"}))
    time.sleep(0.3)
    ws.close()
except: pass
