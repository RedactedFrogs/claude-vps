#!/bin/bash
# Setup GoCollect Farm di VPS2
# Jalankan: bash /home/boss/claude-vps/gocollect/setup.sh

set -e
cd "$(dirname "$0")"

echo "=== Setup GoCollect Farm ==="

# Install dependencies
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js belum terinstall"
  exit 1
fi

echo "Node.js: $(node -v)"
echo "Install npm dependencies..."
npm install --production 2>&1 | tail -5

# Copy .env kalau belum ada
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "PENTING: Edit .env dulu sebelum jalankan!"
  echo "  nano $(pwd)/.env"
  echo ""
  echo "Yang WAJIB diisi:"
  echo "  - CAPTCHA_API_KEY (dari 2captcha.com)"
  echo "  - GC_SITEKEY (jalankan: node gc-farm.mjs --update-keys)"
  echo "  - PROXY_URL"
  echo "  - WALLETS_FILE"
  echo ""
fi

# Update keys dari bundle
echo "Download HMAC keys dari bundle..."
node gc-farm.mjs --update-keys || echo "WARN: update keys gagal (mungkin perlu proxy di .env)"

echo ""
echo "=== Setup selesai ==="
echo ""
echo "Langkah selanjutnya:"
echo "  1. Edit .env: nano $(pwd)/.env"
echo "  2. Diagnose:  node gc-farm.mjs --diagnose"
echo "  3. Test 1 wallet: node gc-farm.mjs --wallet 0"
echo "  4. Farm semua: node gc-farm.mjs"
