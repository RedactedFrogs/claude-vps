#!/usr/bin/env python3
"""KenzoCoin game player v6 - log nope/epoch messages for debugging."""
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
        print(f"[G] epoch: seed={seed}->{new_seed} start={m.get('start')}")
        seed = new_seed
        return "epoch"
    elif t == "bust":
        print(f"[G] bust: {json.dumps(m)}")
        return "bust"
    elif t == "stat":
        return "stat"
    elif t == "hi":
        seed = m.get("seed", 0)
        print(f"[G] hi seed={seed} dur={m.get('dur')} online={m.get('online')}")
        return "hi"
    elif t not in ("p", "add", "del", "feed", "full"):
        print(f"[G] other: {json.dumps(m)[:200]}")
    return t

def drain(t=0.5):
    end = time.time() + t
    while time.time() < end:
        m = rx(max(0.05, end - time.time()))
        handle_msg(m)

# Wait for hi + room + go
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

for attempt in range(TARGET_GATES * 3):
    if gates >= TARGET_GATES:
        break

    level = get_level(gates, seed)
    if not level:
        print("[G] skip"); time.sleep(2); continue

    finishZ = level["finishZ"]
    gold = level.get("gold", [{}])[0]
    goldZ = gold.get("z", finishZ + 5)
    goldTop = gold.get("top", 0)
    cps = level.get("checkpoints", [])
    plats = sorted(level.get("platforms", []), key=lambda p: p["z"])

    print(f"[G] g{gates+1} a{attempt+1}: fZ={finishZ} gZ={goldZ} cps={[c['z'] for c in cps]}")

    gate_got = False

    # Navigate platform by platform
    for pi, plat in enumerate(plats):
        if gate_got: break

        pz = plat["z"]
        pw = plat["w"]
        pd = plat["d"]
        ptop = plat.get("top", 0)
        pstyle = plat.get("style", "floor")
        is_gold = pstyle == "gold"
        is_trap = plat.get("trap") is not None
        is_fake = plat.get("fake")

        # Skip fake/trap platforms (touch briefly, may die)
        if (is_trap and not is_gold) or is_fake:
            for _ in range(3):
                pos(plat["x"], ptop + 0.5, pz, 4)
                time.sleep(0.08)
            # Fall
            for fy in range(4):
                pos(plat["x"], ptop - fy * 8, pz, 0 if fy < 2 else 1)
                time.sleep(0.08)
            drain(0.3)
            continue

        pz_start = pz - pd/2
        pz_end = pz + pd/2
        steps_on = max(10, int(pd / 0.35))

        for step in range(steps_on):
            z_cur = pz_start + (pz_end - pz_start) * step / max(1, steps_on - 1)
            x_cur = plat["x"] + (random.random() - 0.5) * min(pw - 1, 6)
            y_cur = ptop + 0.5 + random.random() * 0.2
            flags = 4  # grounded

            if random.random() < 0.07 and not is_gold:
                y_cur = ptop + 2 + random.random() * 3
                flags = 0

            if is_gold:
                flags = 4 | 2
                x_cur = (random.random() - 0.5) * 4

            pos(x_cur, y_cur, z_cur, flags)
            ping()
            time.sleep(0.08 + random.random() * 0.01)

            m = rx(0.005)
            r = handle_msg(m)
            if r == "gate": gate_got = True; break
            if r in ("room", "go", "epoch"): break

        if gate_got: break

        # Jump to next platform
        if pi < len(plats) - 1:
            nxt = plats[pi + 1]
            gap_s = pz_end
            gap_e = nxt["z"] - nxt["d"]/2
            gap = gap_e - gap_s
            if gap > 0.5:
                jsteps = max(3, int(gap / 0.6))
                for ji in range(jsteps):
                    f = ji / max(1, jsteps - 1)
                    jz = gap_s + gap * f
                    jy = ptop + 0.5 + 4 * 4 * f * (1 - f)
                    pos((random.random()-0.5)*3, jy, jz, 0)
                    time.sleep(0.08)

    # Send fin on gold platform
    if not gate_got:
        print(f"[G] on gold z={goldZ}")
        for _ in range(30):
            pos(
                (random.random()-0.5)*4,
                goldTop + 0.5 + random.random()*0.2,
                goldZ + (random.random()-0.5)*3,
                4 | 2
            )
            ping()
            time.sleep(0.08)
            m = rx(0.005)
            if handle_msg(m) == "gate": gate_got = True; break

        if not gate_got:
            time.sleep(1.1)
            ws.send(json.dumps({"t": "fin"}))
            print("[G] fin sent")

            for _ in range(30):
                m = rx(0.5)
                r = handle_msg(m)
                if r == "gate": gate_got = True; break
                if r in ("room", "go", "err", "nope", "epoch"): break

    print(f"[G] {'OK g='+str(gates) if gate_got else 'no gate'}")

    # Wait for next round
    time.sleep(1.5 + random.random())
    ping()
    drain(1)

print(f"\n[G] DONE gates={gates} pts={pts}")
try:
    ws.send(json.dumps({"t": "out"}))
    time.sleep(0.3)
    ws.close()
except: pass
