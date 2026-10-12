#!/usr/bin/env python3
"""KenzoCoin game player v2 - play via WebSocket with realistic position simulation."""
import json, struct, time, sys, ssl, os, random

try:
    import websocket
except ImportError:
    os.system("pip3 install --break-system-packages websocket-client -q")
    import websocket

tok = sys.argv[1]
handle = sys.argv[2] if len(sys.argv) > 2 else "unknown"
TARGET_GATES = 20

print(f"[GAME] @{handle}, tok={tok[:12]}...")

ws = websocket.create_connection(
    "wss://kenzocoin.meme/play/ws",
    timeout=30,
    sslopt={"cert_reqs": ssl.CERT_NONE},
    header={"Origin": "https://kenzocoin.meme"},
)
print("[GAME] Connected")

ws.send(json.dumps({"t": "join", "tok": tok}))

# State
gates_cleared = 0
total_pts = 0
current_lvl = -1
game_started = False
last_ping = 0

def ping():
    global last_ping
    now = time.time()
    if now - last_ping >= 4:
        ws.send(json.dumps({"t": "p", "c": int(now * 1000)}))
        last_ping = now

def send_pos(x, y, z):
    ix = max(-511, min(511, x))
    iy = max(-500, min(511, y))
    iz = max(-511, min(511, z))
    buf = struct.pack('<3h', int(ix * 64), int(iy * 64), int(iz * 64))
    ws.send_binary(buf)

def recv_msg(timeout=3):
    ws.settimeout(timeout)
    try:
        data = ws.recv()
        if isinstance(data, bytes):
            return None
        return json.loads(data)
    except websocket.WebSocketTimeoutException:
        return None
    except Exception as e:
        print(f"[GAME] recv error: {e}")
        return None

def drain_msgs(duration=2):
    msgs = []
    end = time.time() + duration
    while time.time() < end:
        m = recv_msg(timeout=max(0.5, end - time.time()))
        if m:
            msgs.append(m)
    return msgs

print("[GAME] Waiting for server hello...")
for _ in range(30):
    m = recv_msg(timeout=5)
    if not m:
        continue
    t = m.get("t")
    if t == "hi":
        print(f"[GAME] hi: seed={m.get('seed')}, online={m.get('online')}")
        ping()
    elif t == "room":
        current_lvl = m.get("lvl", 0)
        print(f"[GAME] room: lvl={current_lvl}")
        game_started = True
    elif t == "go":
        print(f"[GAME] go signal received")
        game_started = True
    elif t == "gate":
        gates_cleared = m.get("me", {}).get("gate", gates_cleared)
        total_pts = m.get("me", {}).get("pts", total_pts)
        print(f"[GAME] gate! cleared={gates_cleared}, pts={total_pts}")
    elif t == "err":
        print(f"[GAME] error: {m.get('m')}")
        if m.get("m") == "auth":
            ws.close()
            sys.exit(1)
    elif t in ("add", "del", "feed", "p", "full", "bust"):
        pass
    else:
        print(f"[GAME] other: t={t}")
    if game_started:
        break

if not game_started:
    print("[GAME] Failed to join game")
    ws.close()
    sys.exit(1)

print(f"[GAME] Game started! lvl={current_lvl}, playing {TARGET_GATES} gates...")

for gate_attempt in range(TARGET_GATES * 2):
    if gates_cleared >= TARGET_GATES:
        break

    print(f"\n[GAME] --- Gate attempt {gate_attempt+1} (cleared={gates_cleared}/{TARGET_GATES}) ---")

    z = 0.0
    speed = 30.0 + random.uniform(-3, 3)
    y_base = 1.0
    start_t = time.time()
    update_interval = 0.08

    while z < 480:
        dt = update_interval
        z += speed * dt + random.uniform(-0.5, 1.5)
        x = random.uniform(-3, 3)
        elapsed = time.time() - start_t
        jump_phase = (elapsed * 2.5) % 1.0
        if jump_phase < 0.4:
            y = y_base + jump_phase * 8
        elif jump_phase < 0.6:
            y = y_base + (0.8 - jump_phase) * 8
        else:
            y = y_base + random.uniform(-0.2, 0.2)

        send_pos(x, y, z)
        ping()
        time.sleep(update_interval + random.uniform(0, 0.02))

        m = recv_msg(timeout=0.01)
        if m:
            t = m.get("t")
            if t == "gate":
                gates_cleared = m.get("me", {}).get("gate", gates_cleared)
                total_pts = m.get("me", {}).get("pts", total_pts)
                gain = m.get("gain", 0)
                print(f"[GAME] GATE CLEAR! +{gain}, total={total_pts}, cleared={gates_cleared}")
            elif t == "room":
                current_lvl = m.get("lvl", current_lvl)
                print(f"[GAME] New room: lvl={current_lvl}")
                break
            elif t == "pts":
                total_pts = m.get("pts", total_pts)
                lost = m.get("lost", 0)
                if lost:
                    print(f"[GAME] death penalty: -{lost}")
            elif t == "err":
                print(f"[GAME] error: {m.get('m')}")
            elif t == "go":
                print(f"[GAME] go!")

    print(f"[GAME] At z={z:.0f}, sending fin...")
    ws.send(json.dumps({"t": "fin"}))

    fin_ok = False
    for _ in range(30):
        m = recv_msg(timeout=2)
        if not m:
            continue
        t = m.get("t")
        if t == "gate":
            gates_cleared = m.get("me", {}).get("gate", gates_cleared)
            total_pts = m.get("me", {}).get("pts", total_pts)
            gain = m.get("gain", 0)
            print(f"[GAME] GATE CLEAR! +{gain}, total={total_pts}, cleared={gates_cleared}")
            fin_ok = True
        elif t == "room":
            current_lvl = m.get("lvl", current_lvl)
            print(f"[GAME] New room: lvl={current_lvl}")
            fin_ok = True
            break
        elif t == "pts":
            total_pts = m.get("pts", total_pts)
        elif t == "err":
            print(f"[GAME] err: {m.get('m')}")
            break
        elif t == "go":
            print(f"[GAME] go - new round")
            break
        elif t in ("add", "del", "feed", "p", "full"):
            pass
        if fin_ok:
            break

    if not fin_ok:
        print(f"[GAME] No gate response, trying to continue...")

    time.sleep(1 + random.uniform(0, 0.5))
    ping()

    for m in drain_msgs(1):
        t = m.get("t")
        if t == "gate":
            gates_cleared = m.get("me", {}).get("gate", gates_cleared)
            total_pts = m.get("me", {}).get("pts", total_pts)
            print(f"[GAME] Late gate: cleared={gates_cleared}, pts={total_pts}")
        elif t == "room":
            current_lvl = m.get("lvl", current_lvl)
        elif t == "go":
            pass

print(f"\n[GAME] === DONE ===")
print(f"[GAME] gates_cleared={gates_cleared}, pts={total_pts}")

try:
    ws.send(json.dumps({"t": "out"}))
    time.sleep(0.5)
    ws.close()
except:
    pass
