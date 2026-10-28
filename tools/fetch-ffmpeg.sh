#!/usr/bin/env bash
# Скачивает FFmpeg (сборка BtbN, GPL) в <папка>/bin (по умолчанию — ffmpeg/ в папке программы).
#   tools/fetch-ffmpeg.sh [папка]
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$DIR/ffmpeg}"
URL="${FFMPEG_URL:-https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz}"
if [ -x "$DEST/bin/ffmpeg" ]; then echo "FFmpeg уже есть: $DEST"; exit 0; fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Скачиваю FFmpeg: $URL"
if command -v curl >/dev/null; then curl -L --fail --progress-bar -o "$TMP/ff.tar.xz" "$URL"; else wget -O "$TMP/ff.tar.xz" "$URL"; fi
tar -xJf "$TMP/ff.tar.xz" -C "$TMP"
BIN="$(dirname "$(find "$TMP" -type f -name ffmpeg -path '*/bin/*' | head -n1)")"
mkdir -p "$DEST/bin"
cp "$BIN/ffmpeg" "$BIN/ffprobe" "$DEST/bin/"
chmod +x "$DEST/bin/ffmpeg" "$DEST/bin/ffprobe"
LIC="$(find "$TMP" -maxdepth 2 -name 'LICENSE*' | head -n1 || true)"
[ -n "$LIC" ] && cp "$LIC" "$DEST/" || true
"$DEST/bin/ffmpeg" -hide_banner -version | head -n1
