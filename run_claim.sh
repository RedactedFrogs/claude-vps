#!/bin/bash
# Runner script for Elysium faucet claimer
# Usage: bash run_claim.sh [--discover-only]
set -e

cd /home/boss

# 1. Pull latest scripts
if [ -d claude-vps ]; then
  cd claude-vps && git pull --quiet && cd ..
else
  git clone https://github.com/RedactedFrogs/claude-vps.git
  cd claude-vps && cd ..
fi

# 2. Check Chrome
CHROME=$(which google-chrome 2>/dev/null || which chromium-browser 2>/dev/null || echo '')
if [ -z "$CHROME" ]; then
  echo '[!] Chrome not found. Installing...'
  apt-get update -qq && apt-get install -y -qq chromium-browser 2>/dev/null || \
  apt-get install -y -qq google-chrome-stable 2>/dev/null || \
  (echo 'FAIL: Cannot install Chrome. Install manually.' && exit 1)
  CHROME=$(which google-chrome 2>/dev/null || which chromium-browser 2>/dev/null)
fi
echo "Chrome: $CHROME"
export CHROME_PATH="$CHROME"

# 3. Check Node + puppeteer
if ! command -v node &>/dev/null; then
  echo '[!] Node.js not found. Installing...'
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
fi
echo "Node: $(node -v)"

# 4. Install puppeteer-core if needed
if ! node -e 'require("puppeteer-core")' 2>/dev/null; then
  echo 'Installing puppeteer-core...'
  npm install -g puppeteer-core 2>/dev/null || npm install puppeteer-core 2>/dev/null
fi

# 5. Check proxy file
if [ ! -f /home/boss/proxies.txt ]; then
  echo ''
  echo '=== PROXY FILE TIDAK ADA ==='
  echo 'Buat file /home/boss/proxies.txt dengan 1 proxy per baris.'
  echo 'Format: host:port atau host:port:user:pass'
  echo 'Contoh:'
  echo '  123.45.67.89:8080'
  echo '  proxy1.example.com:3128:myuser:mypass'
  echo ''
  echo 'Minimal 9 proxy (1 per wallet).'
  echo '================================'
  exit 1
fi
echo "Proxies: $(wc -l < /home/boss/proxies.txt) loaded"

# 6. Run
echo ''
echo 'Starting Elysium faucet claimer...'
node claude-vps/claim_elysium_v2.mjs "$@"
