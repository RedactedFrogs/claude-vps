# Konteks untuk Claude (HP / Cloud session)

File ini dibaca otomatis setiap sesi baru. Owner: **Hermawan** (pemula, Bahasa Indonesia). Jawab singkat. Kerjakan sendiri via bridge VPS, jangan suruh user.

## BOOTSTRAP — WAJIB JALANKAN PERTAMA KALI
Sebelum apapun, jalankan ini di bash agar fungsi `vps` aktif. URL bridge dibaca dari `bridge_url.txt` di repo. Watchdog VPS2 (tiap 1 menit) otomatis restart tunnel yang mati dan publish URL barunya ke repo. Fungsi `vps` di bawah **self-healing**: kalau tunnel mati, dia `git pull` sendiri, ambil URL terbaru, lalu coba ulang.

```bash
git pull --quiet 2>/dev/null || true
export VPS_REPO_DIR=$(pwd)
export VPS_BRIDGE_URL=$(cat bridge_url.txt | tr -d '[:space:]')
echo "$VPS_BRIDGE_URL" > /tmp/vps_bridge_url
echo "Bridge URL = $VPS_BRIDGE_URL"
# Token disuplai dari Cloud env var VPS_BRIDGE_TOKEN

vps() {
  python3 - "$*" <<'PY'
import sys, os, json, time, socket, subprocess, urllib.request, urllib.error
cmd = sys.argv[1]
repo = os.environ.get("VPS_REPO_DIR", ".")
CACHE = "/tmp/vps_bridge_url"
def fresh_url():
    subprocess.run(["git", "-C", repo, "pull", "--quiet"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)
    try: u = open(os.path.join(repo, "bridge_url.txt")).read().strip()
    except Exception: u = ""
    if u: open(CACHE, "w").write(u)
    return u
try: url = open(CACHE).read().strip()
except Exception: url = ""
url = url or os.environ.get("VPS_BRIDGE_URL", "") or fresh_url()
TIMEOUT_MSG = "BRIDGE TIMEOUT: command mungkin MASIH JALAN di VPS. Cek hasilnya dulu sebelum mengulang (jangan dobel kirim transaksi)."
deadline = time.time() + 100  # tetap di bawah batas 2 menit tool Bash
attempt = 0
while True:
    attempt += 1
    req = urllib.request.Request(url + "/exec", data=json.dumps({"cmd": cmd, "timeout": 180}).encode(),
        headers={"X-Token": os.environ["VPS_BRIDGE_TOKEN"], "Content-Type": "application/json"}, method="POST")
    try:
        resp = json.load(urllib.request.urlopen(req, timeout=200)); break
    # Ulang HANYA kalau command pasti belum sampai ke VPS (tunnel mati / DNS / Cloudflare 502-530).
    except urllib.error.HTTPError as e:
        if e.code == 401: print("BRIDGE 401: token HP belum terdaftar, lihat bagian KALAU BRIDGE 401", file=sys.stderr); sys.exit(1)
        if e.code in (504, 524): print(TIMEOUT_MSG, file=sys.stderr); sys.exit(1)
        if e.code not in (502, 503, 520, 521, 522, 523, 530): print(f"BRIDGE ERROR HTTP {e.code}", file=sys.stderr); sys.exit(1)
        why = f"HTTP {e.code}"
    except (socket.timeout, TimeoutError):
        print(TIMEOUT_MSG, file=sys.stderr); sys.exit(1)
    except urllib.error.URLError as e:
        if isinstance(e.reason, (socket.timeout, TimeoutError)): print(TIMEOUT_MSG, file=sys.stderr); sys.exit(1)
        why = str(e.reason)
    if time.time() > deadline:
        print("BRIDGE DOWN: tunnel belum pulih. Tunggu 1 menit lalu ULANGI command yang sama (watchdog VPS2 restart tunnel otomatis, pulih maks ~5 menit).", file=sys.stderr); sys.exit(75)
    print(f"[bridge] tunnel tidak bisa dihubungi ({why}), ambil URL terbaru & coba lagi (#{attempt})...", file=sys.stderr)
    time.sleep(12)
    url = fresh_url() or url
sys.stdout.write(resp.get("stdout", ""))
if resp.get("stderr"): sys.stderr.write(resp["stderr"])
sys.exit(resp.get("exit", 0))
PY
}
export -f vps

# verify bridge alive (harus keluar: BRIDGE_OK + srv1597200)
vps "echo BRIDGE_OK && hostname"
```

Setelah bootstrap, **semua command VPS = `vps "<command bash>"`** (jalan sebagai root di VPS2). Contoh:
- `vps "systemctl is-active fomo-seller vps-bridge vps-tunnel"`
- `vps "tail -30 /home/boss/fomo-bot/seller.log"`

## VPS — INFO
- **VPS AKTIF = VPS2** Hostinger, hostname `srv1597200`, IP Tailscale `100.103.6.98` (IP Tailscale TIDAK bisa dijangkau dari Cloud — akses Cloud HANYA via bridge di atas).
- VPS Hostinger lama `187.127.110.187` (AWP miner 250 wallet + node Zcash) **SUDAH MATI sejak ~Juni 2026** — abaikan info lama soal itu.
- User Linux `boss` yang menjalankan agent/bot; bridge jalan sebagai root.

## SERVICES PENTING DI VPS2
- **Jarvis / OpenClaw**: `openclaw-gateway.service` (systemd --user, user boss). Cek: `runuser -u boss -- env XDG_RUNTIME_DIR=/run/user/1001 systemctl --user status openclaw-gateway`. Bot Telegram Jarvis = notifikasi ke owner.
- **AWP validator** (wallet `0x9C98…`): di-spawn otomatis oleh gateway OpenClaw. **JANGAN restart gateway sembarangan** (validator ikut putus). Penjaga: `awp-validator-watcher.timer`, `awp-api-monitor.timer`.
- **Fomoater auto-seller**: `fomo-seller.service` + `fomo-seller-watchdog.timer` — cek tiap 1 detik apakah Fomoater Pass (6 buah, soulbound) sudah bisa diperdagangkan; begitu bisa langsung terima offer OpenSea tertinggi **≥ $50**. **JANGAN dimatikan.** Log `/home/boss/fomo-bot/seller.log`, status `/home/boss/fomo-bot/seller_status.json`.
- **Monitor pass**: `fomopass-monitor.timer` (notif Telegram).
- **Bridge (akses HP)**: `vps-bridge.service` (Python :18790) + `vps-tunnel.service` (cloudflared quick tunnel) + `bridge-url-watchdog.timer` (tiap 1 menit: auto-restart bridge/tunnel yang mati + publish URL ke repo ini).
- Lihat semua: `vps "systemctl list-units --type=service --state=running --no-pager"`.

## WALLET & KUNCI (JANGAN PERNAH tampilkan isinya ke chat)
- Wallet utama `0xA10C742597B3639331903ed1c26208AF87fAcD95` → `/home/boss/.sniper_key`
- Wallet validator `0x9C98Cc106b01C0B9dAEA980aa36a5d731587bDa8` → `/home/boss/.lobster_seed`
- 80 wallet bot → `/home/boss/.pixelpals_wallets.json`
- Seed Phantom → `/home/boss/.phantom_seed`
- Seed UniSat (BTC) → `/home/boss/.unisat_seed`
- **Alamat BTC per akun X:**
  - `@boss_venture89` → `bc1p5g8grjjp6g906g8ezq2nar7krw6nffal0y82y8d6p8ryju55fn7qwx0xkh`
  - `@redacted_frogs` → `bc1p8sl6dlkg0r20hksa5pzpv870haamvzswz3zy2jzh4xg02ldcashq7c84rv`
  - `@mallardordinals` → `bc1pmvy6r6utckqnv7zwdpfe2x7eyeen0v0dnlt2krhee8qfvwls307q5xlfjf`
  - `@bossventure168` → `bc1phwgh2vsfq0avzmug9vkan8vvdv4l04nys02lztt5dx6w83dkd65qzjkdez`
  - `@gryfindor_bot` → `bc1p67h28r0re5azm0z9phukf79a22xefyze84n6pfc3pq7fgw7uryuqgn5620`
  - `@hendrawanipiro` → `bc1p9geqg3krnumgh2xawpve3l536tne6kmrg89qfenyk42zhzlckh4qfezq8z`
- Operasi massal (sweep/konsolidasi) **HANYA 80 wallet bot**; utama & validator jangan disentuh kecuali user sebut eksplisit.

## LOGS
- Bridge watchdog: `/var/log/bridge-watchdog.log`
- Fomo seller: `/home/boss/fomo-bot/seller.log`, watchdog `/var/log/fomo_seller_watchdog.log`
- Pass monitor: `/var/log/fomopass_monitor.log`
- AWP validator watcher: `/var/log/awp_validator_watcher.log`

## ATURAN PENTING
- **Jawaban singkat** — user pemula, hindari paragraf panjang & opsi teknis tanpa terjemahan. Tampilkan waktu dalam **WIB**.
- Solusi harus **gratis** (no extra cost untuk runtime/AI lain).
- **Jangan sebut jumlah wallet ke Discord/external** (Sybil discretion).
- Disk VPS2 pernah penuh 100% gara-gara log bot yang error-loop — bot baru WAJIB batasi ukuran log-nya.
- Untuk edit file di VPS: jangan minta user copy-paste; pakai `vps "cat > /path/file <<'EOF' ... EOF"` atau base64 transfer.

## KALAU BRIDGE 401 (token HP belum terdaftar di VPS2)
Minta **kode daftar** ke owner (owner minta ke Claude laptop; kode 8 huruf, sekali pakai, berlaku 1 jam). Lalu jalankan (ganti KODE), kemudian ulang `vps "echo BRIDGE_OK && hostname"`:

```bash
KODE="XXXX-XXXX"
python3 -c '
import os, sys, json, urllib.request
req = urllib.request.Request(open("/tmp/vps_bridge_url").read().strip() + "/enroll",
    data=json.dumps({"code": sys.argv[1], "token": os.environ["VPS_BRIDGE_TOKEN"]}).encode(),
    headers={"Content-Type": "application/json"}, method="POST")
try:
    print(urllib.request.urlopen(req, timeout=30).read().decode())
except Exception as e:
    print("ENROLL ERROR:", e, getattr(e, "read", lambda: b"")().decode())
' "$KODE"
```

## KALAU BRIDGE ERROR (JANGAN MENYERAH — pulihkan sendiri)
- `vps` sudah otomatis retry ±100 dtk + ambil URL baru dari repo. Kalau keluar **`BRIDGE DOWN`** (exit 75): tunggu ±60 dtk (`sleep 60`), lalu **ulangi command yang sama**. Ulangi sampai ~6x (±6 menit). Jangan bilang ke user "tidak bisa" sebelum itu.
- Di VPS2 watchdog (tiap 1 menit) otomatis: restart `vps-bridge` kalau bridge lokal mati, restart `vps-tunnel` kalau URL publik gagal 3x berturut-turut, lalu publish URL baru ke `bridge_url.txt`. Jadi pemulihan maks ~5 menit.
- **`BRIDGE TIMEOUT`** ≠ tunnel mati: command mungkin masih jalan di VPS. Cek hasilnya dulu (log/status/tx) sebelum mengulang — terutama untuk transaksi.
- Kalau tetap mati >10 menit: minta user buka Claude Code di laptop (terhubung Tailscale ke VPS2) untuk cek `systemctl status vps-bridge vps-tunnel` dan `tail /var/log/bridge-watchdog.log`.
