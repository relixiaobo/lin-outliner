#!/usr/bin/env bash
#
# Regenerate the macOS app-icon assets from the single source of truth,
# assets/brand/tenon-icon-master.svg (a 1024 canvas with an 824 squircle on a
# 100px transparent gutter — Apple's macOS icon grid; macOS does not auto-mask).
#
# Produces:
#   build/icon.png   — 1024 PNG; dev Dock icon (app.dock.setIcon) + linux/extra.
#   build/icon.icns  — full 16→1024 ladder for the packaged bundle.
#
# macOS-only (uses qlmanage + sips + iconutil). Run after editing the master,
# then commit both build/ artifacts. Caches are aggressive — a packaged rebuild
# (bun run app:build) picks up the new shape.
set -euo pipefail

cd "$(dirname "$0")/.."
MASTER="assets/brand/tenon-icon-master.svg"
OUT_PNG="build/icon.png"
OUT_ICNS="build/icon.icns"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1. Rasterize the SVG master to a 1024 PNG (qlmanage preserves the alpha gutter).
qlmanage -t -s 1024 -o "$work" "$MASTER" >/dev/null 2>&1
master_png="$work/$(basename "$MASTER").png"
[ -f "$master_png" ] || { echo "gen-icon: qlmanage failed to render $MASTER" >&2; exit 1; }

# 2. The 1024 PNG is the dev Dock icon / linux icon.
cp "$master_png" "$OUT_PNG"

# 3. Build the iconset ladder and pack it into .icns.
iconset="$work/icon.iconset"
mkdir -p "$iconset"
emit() { sips -z "$1" "$1" "$master_png" --out "$iconset/$2" >/dev/null; }
emit 16   icon_16x16.png
emit 32   icon_16x16@2x.png
emit 32   icon_32x32.png
emit 64   icon_32x32@2x.png
emit 128  icon_128x128.png
emit 256  icon_128x128@2x.png
emit 256  icon_256x256.png
emit 512  icon_256x256@2x.png
emit 512  icon_512x512.png
emit 1024 icon_512x512@2x.png
iconutil -c icns "$iconset" -o "$OUT_ICNS"

echo "gen-icon: wrote $OUT_PNG (1024) + $OUT_ICNS"
