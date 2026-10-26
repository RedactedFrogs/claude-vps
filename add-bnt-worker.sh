#!/usr/bin/env bash
# Tambah 1 worker BNT (Seine) di mesin Bohrium Claw baru.
# Semua worker konek ke WALLET yang SAMA; yang beda cuma nama (--pool-worker).
# Pakai: sudo bash add-bnt-worker.sh <nama-worker>
#   contoh: sudo bash add-bnt-worker.sh bohr6
set -euo pipefail

# ===== KONFIG (biasanya tidak perlu diubah) =====
WORKER="${1:-bohr6}"   # nama worker UNIK per Claw: bohr6, bohr7, bohr8, ...
ADDR="ZKE7kxdDJdEzLLfcx1GWaWZCR6aUobXsi8eDiksm3N21cSEagMt2FKbVYcQkXha6tari1CgQoUnxU8jGxg5d3LotAt9g4"
POOL="stratum+tcp://bntpool.com:3333"
THREADS="${THREADS:-1}"  # 1 thread ~1.5 H/s, butuh ~2GB RAM. Naikkan hanya kalau RAM Claw >= 4GB.
DIR=/opt/bnt
# ================================================

echo "== Setup worker BNT: $WORKER (threads=$THREADS) =="
mkdir -p "$DIR" "$DIR/data"; cd "$DIR"

# --- Unduh Seine linux x86_64 terbaru dari GitHub (kalau belum ada) ---
if [ ! -x "$DIR/seine" ]; then
  echo "Mengambil rilis Seine terbaru dari GitHub..."
  JSON=$(curl -fsSL https://api.github.com/repos/zpalmtree/seine/releases/latest)
  URLS=$(printf '%s' "$JSON" | grep -oE '"browser_download_url"[^,]*' | cut -d'"' -f4)
  URL=$(printf '%s\n' "$URLS" | grep -iE 'linux' | grep -iE 'x86_64|amd64|x64' | grep -iE '\.tar\.gz$|\.tgz$|\.zip$' | grep -iv musl | head -1)
  [ -n "$URL" ] || URL=$(printf '%s\n' "$URLS" | grep -iE 'linux' | grep -iE 'x86_64|amd64|x64' | head -1)
  if [ -z "$URL" ]; then echo "GAGAL cari aset linux x86_64. Aset tersedia:"; printf '%s\n' "$URLS"; exit 1; fi
  echo "Download: $URL"
  curl -fsSL "$URL" -o seine-pkg
  case "$URL" in
    *.zip) command -v unzip >/dev/null || { apt-get update -y && apt-get install -y unzip; }; unzip -o seine-pkg ;;
    *)     tar -xzf seine-pkg ;;
  esac
  BIN=$(find . -maxdepth 3 -type f -name 'seine*' ! -name '*.tar*' ! -name '*.tgz' ! -name '*.zip' ! -name 'seine-pkg' | head -1)
  [ -n "$BIN" ] || { echo "Binary seine tidak ketemu setelah ekstrak."; exit 1; }
  [ "$BIN" = "./seine" ] || cp "$BIN" "$DIR/seine"
  chmod +x "$DIR/seine"; rm -f seine-pkg
fi
"$DIR/seine" --version || true

CMD="$DIR/seine --backend cpu --threads $THREADS --ui plain --data-dir $DIR/data --pool-url $POOL --pool-worker $WORKER --address $ADDR"

# --- Jalankan sebagai service systemd kalau tersedia, kalau tidak loop background ---
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/bnt-miner.service <<EOF
[Unit]
Description=BNT miner (Seine) worker $WORKER -> bntpool.com
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=$CMD
Restart=on-failure
RestartSec=30
Nice=19
MemoryMax=2700M
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now bnt-miner
  echo "OK: service bnt-miner aktif (worker=$WORKER)."
  sleep 4; systemctl --no-pager -l status bnt-miner | head -15
else
  cat > "$DIR/run-$WORKER.sh" <<EOF
#!/usr/bin/env bash
while true; do
  $CMD >> "$DIR/$WORKER.log" 2>&1
  echo "[\$(date)] seine stop, restart 30s..." >> "$DIR/$WORKER.log"
  sleep 30
done
EOF
  chmod +x "$DIR/run-$WORKER.sh"
  setsid "$DIR/run-$WORKER.sh" >/dev/null 2>&1 &
  echo "OK: worker $WORKER jalan di background (log: $DIR/$WORKER.log)."
fi

echo
echo "Cek dari HP/VPS: jalankan  vps \"bnt-status\"  -> worker '$WORKER' muncul ~1-2 menit lagi."
