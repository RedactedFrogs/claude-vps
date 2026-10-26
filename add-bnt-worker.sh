#!/usr/bin/env bash
# Jalankan 1 worker BNT (Seine) di mesin Bohrium Claw.
# TIDAK butuh root / systemd. Semua worker -> WALLET yang SAMA; beda cuma nama (--pool-worker).
# Pakai:  bash add-bnt-worker.sh <nama-worker>
#   contoh: bash add-bnt-worker.sh bohr6
set -u

# ===== KONFIG =====
WORKER="${1:-bohr6}"          # nama worker UNIK per Claw: bohr6, bohr7, bohr8, ...
ADDR="ZKE7kxdDJdEzLLfcx1GWaWZCR6aUobXsi8eDiksm3N21cSEagMt2FKbVYcQkXha6tari1CgQoUnxU8jGxg5d3LotAt9g4"
POOL="stratum+tcp://bntpool.com:3333"
THREADS="${THREADS:-1}"        # 1 thread ~1.5 H/s, butuh ~2GB RAM. Naikkan hanya kalau RAM banyak.
VER="v0.2.24"                  # versi yang terbukti jalan di bohr1-4
# ==================

DIR="$HOME/bnt"; mkdir -p "$DIR/data"; cd "$DIR" || exit 1
echo "== Worker $WORKER | threads $THREADS | arch $(uname -m) =="
awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{printf "RAM total %d MB, tersedia %d MB (1 thread butuh ~2048 MB)\n",t/1024,a/1024}' /proc/meminfo

# --- pilih aset sesuai arsitektur ---
case "$(uname -m)" in
  x86_64|amd64)  ASSET=seine-linux-x86_64.tar.gz ;;
  aarch64|arm64) ASSET=seine-linux-aarch64.tar.gz ;;
  *) echo "GAGAL: arsitektur $(uname -m) tidak didukung Seine (butuh x86_64/aarch64)"; exit 1 ;;
esac

# --- unduh Seine kalau belum ada ---
if [ ! -x "$DIR/seine" ]; then
  URL="https://github.com/zpalmtree/seine/releases/download/$VER/$ASSET"
  echo "Unduh: $URL"
  curl -fL --retry 3 -o s.tgz "$URL" || { echo "GAGAL download Seine (cek internet Claw)"; exit 1; }
  tar -xzf s.tgz || { echo "GAGAL ekstrak arsip"; exit 1; }
  rm -f s.tgz
  BIN=$(find . -maxdepth 2 -type f -name 'seine*' ! -name '*.tar*' ! -name '*.tgz' ! -name '*.sh' | head -1)
  [ -n "$BIN" ] || { echo "GAGAL: binary seine tak ketemu di arsip"; ls -la; exit 1; }
  [ "$BIN" = "./seine" ] || mv "$BIN" "$DIR/seine"
  chmod +x "$DIR/seine"
fi
"$DIR/seine" --version || { echo "GAGAL: Seine tak bisa jalan (arch/lib salah?)"; exit 1; }

# --- matikan worker nama sama kalau sudah ada, lalu start baru ---
pkill -f "seine .*--pool-worker $WORKER" 2>/dev/null; sleep 1

cat > "$DIR/run-$WORKER.sh" <<EOF
#!/usr/bin/env bash
cd "$DIR"
while true; do
  "$DIR/seine" --mode pool --backend cpu --threads $THREADS --allow-oversubscribe \\
    --data-dir "$DIR/data" --pool-url "$POOL" --pool-worker "$WORKER" --address "$ADDR" \\
    >> "$DIR/$WORKER.log" 2>&1
  echo "[\$(date '+%F %T')] seine berhenti, restart 30 dtk..." >> "$DIR/$WORKER.log"
  sleep 30
done
EOF
chmod +x "$DIR/run-$WORKER.sh"
: > "$DIR/$WORKER.log"
setsid "$DIR/run-$WORKER.sh" >/dev/null 2>&1 &
echo "Worker '$WORKER' start. Log: $DIR/$WORKER.log"

sleep 12
echo "================= 30 baris pertama log ================="
head -30 "$DIR/$WORKER.log"
echo "========================================================"
echo "- Kalau ada tulisan 'accepted' / 'share' / hashrate -> BERHASIL."
echo "- Kalau ada ERROR/panic -> COPY semua teks di atas, kirim ke Claude HP."
echo "- Cek dari HP:  vps \"bnt-status\"  -> worker '$WORKER' muncul ~1-2 menit lagi."
