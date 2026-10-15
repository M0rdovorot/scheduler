#!/bin/sh
# One-time setup of the browser for `make e2e` on this server.
#
# - cdn.playwright.dev answers 403 here (region block), so Chromium is fetched from
#   the npmmirror mirror of the same Playwright builds (approved by the project owner).
# - The server has no root and lacks some shared libraries Chromium needs, so they
#   are unpacked from the distribution's own .deb files into ~/.local/share/chromium-libs
#   (playwright.config.ts adds that directory to LD_LIBRARY_PATH).
set -eu
cd "$(dirname "$0")/.."

PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium

libs="$HOME/.local/share/chromium-libs"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$libs"
(
  cd "$tmp"
  apt-get download libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libxdamage1 libasound2t64 libatspi2.0-0t64 libxres1
  for deb in ./*.deb; do dpkg -x "$deb" "$libs"; done
)
echo "Done. Run: make e2e"
