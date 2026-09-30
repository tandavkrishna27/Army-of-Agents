#!/usr/bin/env bash
# Fetch the Playwright chromium browser + headless-shell from Google's
# Chrome-for-Testing storage and place them into Playwright's browser cache,
# bypassing cdn.playwright.dev.
#
# Why: cdn.playwright.dev intermittently stalls on the Chrome-for-Testing
# archives (multi-minute hangs that exhaust the e2e job's timeout before any
# test runs). Google serves the byte-identical binaries at a sibling URL
# (.../chrome-for-testing-public/<ver>/linux64/... vs the CDN's
# .../builds/cft/<ver>/linux64/...). Playwright only re-downloads when the
# executable is missing, so placing the binaries here lets `playwright test`
# launch them directly.
#
# Linux x64 only — this hardens the required Linux e2e gate. The advisory
# cross-platform lanes are out of scope.
set -euo pipefail

DRY="$(npx playwright install --dry-run chromium 2>&1)"

# Chrome-for-Testing version, e.g. "147.0.7727.15".
VER="$(printf '%s\n' "$DRY" | grep -oiE 'Chrome for Testing [0-9][0-9.]+' | head -1 | grep -oE '[0-9][0-9.]+')"
# Cache install dirs, e.g. ".../ms-playwright/chromium-1217" and
# ".../ms-playwright/chromium_headless_shell-1217". Take the first
# "Install location" line after each browser header.
CHROMIUM_DIR="$(printf '%s\n' "$DRY" | awk '/Chrome for Testing/{f=1} f&&/Install location/{print $NF; exit}')"
SHELL_DIR="$(printf '%s\n' "$DRY" | awk '/Chrome Headless Shell/{f=1} f&&/Install location/{print $NF; exit}')"

if [ -z "$VER" ] || [ -z "$CHROMIUM_DIR" ] || [ -z "$SHELL_DIR" ]; then
  echo "install-chromium-from-google: could not parse 'playwright install --dry-run' output:" >&2
  printf '%s\n' "$DRY" >&2
  exit 1
fi

BASE="https://storage.googleapis.com/chrome-for-testing-public/${VER}/linux64"
echo "Installing Chrome for Testing ${VER} from Google CfT storage (${BASE})"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fSL --retry 5 --retry-all-errors -o "$tmp/chrome.zip" "${BASE}/chrome-linux64.zip"
mkdir -p "$CHROMIUM_DIR"
unzip -q -o "$tmp/chrome.zip" -d "$CHROMIUM_DIR"
chmod +x "$CHROMIUM_DIR/chrome-linux64/chrome"
touch "$CHROMIUM_DIR/INSTALLATION_COMPLETE"

curl -fSL --retry 5 --retry-all-errors -o "$tmp/shell.zip" "${BASE}/chrome-headless-shell-linux64.zip"
mkdir -p "$SHELL_DIR"
unzip -q -o "$tmp/shell.zip" -d "$SHELL_DIR"
chmod +x "$SHELL_DIR/chrome-headless-shell-linux64/chrome-headless-shell"
touch "$SHELL_DIR/INSTALLATION_COMPLETE"

echo "Installed:"
echo "  $CHROMIUM_DIR/chrome-linux64/chrome"
echo "  $SHELL_DIR/chrome-headless-shell-linux64/chrome-headless-shell"
