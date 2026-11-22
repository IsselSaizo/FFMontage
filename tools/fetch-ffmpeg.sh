#!/usr/bin/env bash
# Скачивает FFmpeg (сборка BtbN, GPL) в <папка>/bin (по умолчанию — ffmpeg/ в папке программы).
#   tools/fetch-ffmpeg.sh [папка]
# Сборка закреплена по версии и SHA-256 (M0.12): обновлять — вместе с fetch-ffmpeg.ps1, хэш брать из
# https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/<тег> (поле digest) или посчитать: sha256sum.
# Своя сборка: FFMPEG_URL=<ссылка> FFMPEG_SHA256=<хэш> (или FFMPEG_SHA256=skip — без проверки, на свой риск).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$DIR/ffmpeg}"

# BtbN хранит ежедневные autobuild ~2 недели, а сборки последнего дня месяца — годами: закреплять только
# месячную (иначе CI и Release падают с 404, как с autobuild-2026-11-04-12-51).
# BtbN autobuild от 31.10.2026, ветка release/9.0 (n9.0.2-39-g7adfbe40dc), linux64 gpl
PIN_TAG="autobuild-2026-10-31-12-59"
PIN_FILE="ffmpeg-n9.0.2-39-g7adfbe40dc-linux64-gpl-9.0.tar.xz"
PIN_SHA256="73e29a56974ae5a651133a04584c7483b21afe941e17dc91d79814a758b608d3"

if [ -n "${FFMPEG_URL:-}" ]; then
  URL="$FFMPEG_URL"
  SHA="${FFMPEG_SHA256:-}"
  if [ -z "$SHA" ]; then echo "Для своей FFMPEG_URL задайте FFMPEG_SHA256 (или FFMPEG_SHA256=skip)" >&2; exit 1; fi
else
  URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/$PIN_TAG/$PIN_FILE"
  SHA="${FFMPEG_SHA256:-$PIN_SHA256}"
fi
if [ -x "$DEST/bin/ffmpeg" ]; then echo "FFmpeg уже есть: $DEST"; exit 0; fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Скачиваю FFmpeg: $URL"
if command -v curl >/dev/null; then curl -L --fail --progress-bar -o "$TMP/ff.tar.xz" "$URL"; else wget -O "$TMP/ff.tar.xz" "$URL"; fi
if [ "$SHA" != "skip" ]; then
  GOT="$(sha256sum "$TMP/ff.tar.xz" | cut -d' ' -f1)"
  if [ "$GOT" != "$(echo "$SHA" | tr 'A-F' 'a-f')" ]; then echo "SHA-256 не совпадает: ожидался $SHA, получен $GOT" >&2; exit 1; fi
  echo "SHA-256 верен: $GOT"
else
  echo "Внимание: SHA-256 не проверяется (FFMPEG_SHA256=skip)" >&2
fi
tar -xJf "$TMP/ff.tar.xz" -C "$TMP"
BIN="$(dirname "$(find "$TMP" -type f -name ffmpeg -path '*/bin/*' | head -n1)")"
mkdir -p "$DEST/bin"
cp "$BIN/ffmpeg" "$BIN/ffprobe" "$DEST/bin/"
chmod +x "$DEST/bin/ffmpeg" "$DEST/bin/ffprobe"
LIC="$(find "$TMP" -maxdepth 2 -name 'LICENSE*' | head -n1 || true)"
[ -n "$LIC" ] && cp "$LIC" "$DEST/" || true
"$DEST/bin/ffmpeg" -hide_banner -version | head -n1
