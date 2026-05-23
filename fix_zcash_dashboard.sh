#!/usr/bin/env bash
# Patch teks "Launch Bonus" di zcash_dashboard.html supaya tidak menyesatkan.
# Aturan benar (per DePINZcash): register node -> jaga online 24 jam -> ~$40 $ZePIN.
# Aman dijalankan berulang (idempotent).

set -euo pipefail

echo "=== fix_zcash_dashboard.sh ==="

# 1. Cari file dashboard HTML
DASH="$(find /var /root /opt /srv /usr/local -name 'zcash_dashboard.html' 2>/dev/null | head -1 || true)"
if [ -z "$DASH" ]; then
  echo "[!] zcash_dashboard.html tidak ditemukan di /var /root /opt /srv /usr/local" >&2
  exit 1
fi
echo "[+] HTML : $DASH"

# 2. Cari script generator (biar fix tahan dari cron regenerate)
mapfile -t GENS < <(grep -rIln 'zcash_dashboard' /root /etc /usr/local /opt 2>/dev/null \
  | grep -vE '\.(html|bak|log|gz)$' || true)
for g in "${GENS[@]}"; do echo "[+] GEN  : $g"; done

FILES=("$DASH" "${GENS[@]}")

# 3. Backup
TS="$(date +%Y%m%d_%H%M%S)"
for f in "${FILES[@]}"; do
  cp -a "$f" "${f}.bak.${TS}"
done
echo "[+] Backup suffix: .bak.${TS}"

# 4. Tampilkan baris yang kemungkinan salah (BEFORE)
echo ""
echo "[i] BEFORE (baris terkait launch bonus / 24 jam / sync):"
for f in "${FILES[@]}"; do
  grep -niE 'launch.bonus|24.?(jam|hour)|sinkron|sync.*regist|regist.*sync|zepin' "$f" 2>/dev/null \
    | sed "s|^|    $(basename "$f"): |" || true
done

# 5. Patch teks salah -> teks benar
#    Beberapa varian phrasing umum yang mungkin ada di dashboard / generator.
REPL='Register node dulu, lalu jaga uptime 24 jam → reward ~$40 $ZePIN'
for f in "${FILES[@]}"; do
  sed -i -E \
    -e "s|[Ss]inkronisasi[^<.]{0,60}24[^<.]{0,10}(jam\|hours?)[^<.]{0,60}(daftar\|register\|masuk)[^<.]*|${REPL}|g" \
    -e "s|[Ss]ync[^<.]{0,60}24[^<.]{0,10}(jam\|hours?)[^<.]{0,60}(daftar\|register\|masuk)[^<.]*|${REPL}|g" \
    -e "s|24[^<.]{0,5}(jam\|hours?)[^<.]{0,40}(sinkron\|sync)[^<.]*(daftar\|register\|masuk)[^<.]*|${REPL}|g" \
    -e "s|[Bb]aru bisa daftar setelah[^<.]{0,40}sync[^<.]*|${REPL}|g" \
    "$f"
done

# 6. Inject banner penjelasan di atas <body> dashboard HTML (kalau belum ada)
if ! grep -q 'data-bonus-fix=' "$DASH"; then
  TMP="$(mktemp)"
  awk '
    BEGIN { done = 0 }
    {
      print
      if (!done && tolower($0) ~ /<body/) {
        print "<div data-bonus-fix=\"v1\" style=\"background:#1e293b;color:#fef3c7;padding:12px 16px;border-left:4px solid #f59e0b;margin:0 0 16px;font:14px system-ui,sans-serif;line-height:1.5\">"
        print "  <strong style=\"color:#fbbf24\">Launch Bonus DePINZcash:</strong>"
        print "  ~$40 $ZePIN untuk <em>register node</em> + <em>jaga online 24 jam</em>."
        print "  <br><small style=\"opacity:.85\">Initial sync (~1&ndash;2 hari) BUKAN bagian dari 24 jam tsb. Jam reward mulai dihitung SETELAH node ter-register.</small>"
        print "</div>"
        done = 1
      }
    }
  ' "$DASH" > "$TMP" && mv "$TMP" "$DASH"
  # Pertahankan owner/permission
  chmod --reference="${DASH}.bak.${TS}" "$DASH"
  chown --reference="${DASH}.bak.${TS}" "$DASH"
  echo "[+] Banner ditambahkan di atas <body>"
else
  echo "[=] Banner sudah ada, skip inject"
fi

# 7. AFTER
echo ""
echo "[i] AFTER (baris hasil fix):"
for f in "${FILES[@]}"; do
  grep -niE 'register node dulu|uptime 24 jam|data-bonus-fix|launch.bonus' "$f" 2>/dev/null \
    | sed "s|^|    $(basename "$f"): |" || true
done

echo ""
echo "[✓] Selesai."
echo "    Reload  : http://187.127.110.187:8080/zcash_dashboard.html"
echo "    Rollback: untuk tiap file di atas, jalankan: cp <file>.bak.${TS} <file>"
[ ${#GENS[@]} -gt 0 ] && echo "    Catatan : script generator juga sudah di-patch -> fix akan tetap setelah cron next run."
