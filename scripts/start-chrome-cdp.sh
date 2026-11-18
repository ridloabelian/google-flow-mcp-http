#!/usr/bin/env bash
set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
PROFILE_DIR="${FLOW_CHROME_PROFILE_DIR:-$HOME/.google-flow-mcp/chrome-profile}"
FLOW_URL="${FLOW_BASE_URL:-https://flow.google.com}"

mkdir -p "$PROFILE_DIR"

if curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  echo "[start-chrome-cdp] Chrome sudah aktif di 127.0.0.1:${CDP_PORT}"
  exit 0
fi

detect_chrome() {
  if [[ -n "${CHROME_BIN:-}" && -x "${CHROME_BIN}" ]]; then
    echo "$CHROME_BIN"
    return
  fi
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/usr/bin/google-chrome-stable" \
    "/usr/bin/google-chrome" \
    "/usr/bin/chromium-browser" \
    "/usr/bin/chromium"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  echo ""
}

CHROME_EXEC="$(detect_chrome)"
if [[ -z "$CHROME_EXEC" ]]; then
  echo "[ERROR] Google Chrome / Chromium tidak ditemukan. Set variabel CHROME_BIN." >&2
  exit 1
fi

echo "[start-chrome-cdp] Meluncurkan Chrome pada 127.0.0.1:${CDP_PORT} dengan profil ${PROFILE_DIR}"
nohup "$CHROME_EXEC" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  "$FLOW_URL" >/tmp/google-flow-chrome.log 2>&1 &

for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    echo "[start-chrome-cdp] CDP siap! Silakan login ke akun Google di jendela Chrome bila ini pertama kali."
    exit 0
  fi
  sleep 0.5
done

echo "[ERROR] Chrome gagal membuka port CDP ${CDP_PORT}. Cek /tmp/google-flow-chrome.log" >&2
exit 1
