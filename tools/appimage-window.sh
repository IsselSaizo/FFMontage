#!/usr/bin/env bash
# Окно AppImage под xvfb (CI: .github/workflows/appimage.yml): программа открывает главное окно в отдельной папке
# (FFM_CONFIG), выполняет tools/appimage-selftest.js (FFM_SELFTEST) и закрывается. Скрипт проверяет, что WebKitGTK
# из образа играет <video> через GStreamer из образа: H.264 — сразу, HEVC — через прокси (ff.rs: на Linux needsProxy).
#   tools/appimage-window.sh FF-Montage-<версия>-linux-x86_64.AppImage [папка для файлов теста]
# Нужны xvfb-run и jq. Итоги — в аннотациях GitHub (::notice / ::error).
set -uo pipefail
A="$(readlink -f "$1")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mkdir -p "${2:-$ROOT/dist/appimage-test}" && cd "${2:-$ROOT/dist/appimage-test}" && pwd)"
FAILS=0
err() { echo "::error title=AppImage окно::$*"; FAILS=$((FAILS + 1)); }
note() { echo "::notice title=AppImage окно::$*"; }

rm -rf "$T/cache" "$T/home" "$T/result.json"
M="$T/cache/tmp/appimage-test"
mkdir -p "$M" "$T/out" "$T/proj" "$T/plugins" "$T/audio-plugins" "$T/home"

# Тестовые файлы — FFmpeg из образа (так заодно проверяется, что он запускается вне программы)
FF="$(cd "$T" && "$A" --appimage-extract 'usr/bin/ffmpeg/bin/*' >/dev/null 2>&1 && echo "$T/squashfs-root/usr/bin/ffmpeg/bin/ffmpeg")"
if [ ! -x "$FF" ]; then err "не удалось достать ffmpeg из образа"; exit 1; fi
gen() { "$FF" -hide_banner -loglevel error -y "$@" || err "ffmpeg не сделал тестовый файл: ${*: -1}"; }
SRC=(-f lavfi -i testsrc2=size=320x240:rate=25 -t 3)
TONE=(-f lavfi -i sine=frequency=440:sample_rate=48000 -t 3)
gen "${SRC[@]}" -c:v libx264 -pix_fmt yuv420p -preset veryfast -movflags +faststart "$M/h264.mp4"
gen "${SRC[@]}" "${TONE[@]}" -c:v libx264 -pix_fmt yuv420p -preset veryfast -c:a aac -shortest -movflags +faststart "$M/h264_aac.mp4"
gen "${SRC[@]}" -c:v libx265 -pix_fmt yuv420p -preset ultrafast -tag:v hvc1 -movflags +faststart "$M/hevc.mp4"
gen "${SRC[@]}" -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 300k "$M/vp9.webm"
rm -rf "$T/squashfs-root"

printf '{ "version": 1, "cacheDir": "%s", "outputDir": "%s", "projectsDir": "%s", "ffmpegDir": "" }\n' \
  "$T/cache" "$T/out" "$T/proj" >"$T/config.json"

start=$(date +%s)
(cd "$T" && env APPIMAGE_EXTRACT_AND_RUN=1 HOME="$T/home" FFM_NO_GPU=1 FFM_CONFIG="$T/config.json" \
  FFM_PLUGINS_DIR="$T/plugins" FFM_AUDIO_PLUGIN_PATH="$T/audio-plugins" \
  FFM_SELFTEST="$ROOT/tools/appimage-selftest.js" FFM_SHOT="$T/result.png" \
  timeout 300 xvfb-run -a -s '-screen 0 1600x1000x24' "$A" >"$T/stdout.log" 2>"$T/stderr.log")
code=$?
note "окно работало $(($(date +%s) - start)) с, код выхода $code"
[ "$code" = 124 ] && err "окно не закрылось за 5 мин (автотест не дошёл до конца)"

if [ ! -f "$T/result.json" ]; then
  err "автотест окна не записал результат. stderr: $(tail -n 6 "$T/stderr.log" | tr '\n' ' ' | cut -c1-900)"
  for f in "$T"/cache/app/logs/*.log; do [ -f "$f" ] && echo "::warning title=$(basename "$f")::$(tail -n 5 "$f" | tr '\n' ' ' | cut -c1-900)"; done
  exit 1
fi
jq -r '.log[]?' "$T/result.json" | while IFS= read -r l; do note "$l"; done
jq -r '.errors[]?, (.error // empty)' "$T/result.json" | while IFS= read -r l; do echo "::error title=AppImage окно::$l"; done
n=$(jq '([.errors[]?] | length) + (if .error then 1 else 0 end)' "$T/result.json")
FAILS=$((FAILS + n))
grep -iE 'gstreamer|gst_|EGL|crash' "$T/stderr.log" | sort -u | head -n 5 | while IFS= read -r l; do echo "::warning title=stderr окна::$(cut -c1-300 <<<"$l")"; done

if [ "$FAILS" -gt 0 ]; then
  echo "Ошибок: $FAILS"
  exit 1
fi
echo "Окно AppImage: <video> играет"
