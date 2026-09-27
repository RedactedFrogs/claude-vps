# Konteks untuk Claude (HP / Cloud session)

File ini dibaca otomatis setiap sesi baru. Owner: **Hermawan** (pemula, Bahasa Indonesia). Jawab singkat. Kerjakan sendiri via bridge VPS, jangan suruh user.

## BOOTSTRAP — WAJIB JALANKAN PERTAMA KALI
Sebelum apapun, jalankan ini di bash agar fungsi `vps` aktif. URL bridge dibaca dari `bridge_url.txt` di repo (VPS2 auto-publish tiap 2 menit saat URL rotate, jadi selalu fresh — `git pull` dulu agar dapat versi terbaru):

```bash
git pull --quiet 2>/dev/null || true
export VPS_BRIDGE_URL=$(cat bridge_url.txt | tr -d '[:space:]')
echo "Bridge URL = $VPS_BRIDGE_URL"
# Token disuplai dari Cloud env var VPS_BRIDGE_TOKEN

vps() {
  python3 -c '
import sys, os, json, urllib.request
cmd = sys.argv[1]
req = urllib.request.Request(
    os.environ["VPS_BRIDGE_URL"] + "/exec",
    data=json.dumps({"cmd": cmd, "timeout": 180}).encode(),
    headers={"X-Token": os.environ["VPS_BRIDGE_TOKEN"], "Content-Type": "application/json"},
    method="POST",
)
try:
    resp = json.load(urllib.request.urlopen(req, timeout=200))
except Exception as e:
    print(f"BRIDGE ERROR: {e}", file=sys.stderr); sys.exit(1)
sys.stdout.write(resp.get("stdout",""))
if resp.get("stderr"): sys.stderr.write(resp["stderr"])
sys.exit(resp.get("exit", 0))
' "$*"
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
- **Bridge (akses HP)**: `vps-bridge.service` (Python :18790) + `vps-tunnel.service` (cloudflared quick tunnel) + `bridge-url-watchdog.timer` (publish URL ke repo ini).
- Lihat semua: `vps "systemctl list-units --type=service --state=running --no-pager"`.

## WALLET & KUNCI (JANGAN PERNAH tampilkan isinya ke chat)
- Wallet utama `0xA10C742597B3639331903ed1c26208AF87fAcD95` → `/home/boss/.sniper_key`
- Wallet validator `0x9C98Cc106b01C0B9dAEA980aa36a5d731587bDa8` → `/home/boss/.lobster_seed`
- 80 wallet bot → `/home/boss/.pixelpals_wallets.json`
- Seed Phantom → `/home/boss/.phantom_seed`
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
req = urllib.request.Request(os.environ["VPS_BRIDGE_URL"] + "/enroll",
    data=json.dumps({"code": sys.argv[1], "token": os.environ["VPS_BRIDGE_TOKEN"]}).encode(),
    headers={"Content-Type": "application/json"}, method="POST")
try:
    print(urllib.request.urlopen(req, timeout=30).read().decode())
except Exception as e:
    print("ENROLL ERROR:", e, getattr(e, "read", lambda: b"")().decode())
' "$KODE"
```

## KALAU BRIDGE ERROR
1. Re-run bootstrap (`git pull` dulu) — watchdog VPS2 publish URL baru maks ~2 menit setelah tunnel rotate.
2. Kalau masih error >5 menit: tunnel/bridge mungkin mati. Minta user buka Claude Code di laptop (terhubung Tailscale ke VPS2) untuk cek `systemctl status vps-bridge vps-tunnel` dan `tail /var/log/bridge-watchdog.log`.
