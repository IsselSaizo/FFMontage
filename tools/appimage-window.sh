#!/usr/bin/env bash
# Окно программы под xvfb (CI: .github/workflows/appimage.yml): программа открывает главное окно в отдельной папке
# (FFM_CONFIG), выполняет tools/appimage-selftest.js (FFM_SELFTEST) и закрывается. Скрипт проверяет, что WebKitGTK
# играет <video> через GStreamer: H.264 и VP9 — напрямую, HEVC — через прокси (ff.rs: на Linux needsProxy).
#   tools/appimage-window.sh FF-Montage-<версия>-linux-x86_64.AppImage [папка для файлов теста]
#   tools/appimage-window.sh src-tauri/target/release/ff-montage [папка]   — то же без AppImage (системный GStreamer;
#                                                                            FFmpeg — $FFMPEG или из PATH)
# Нужны xvfb-run и jq. Итоги — в аннотациях GitHub (::notice / ::error). Журнал GStreamer (GST_DEBUG=2) — gst.log.
set -uo pipefail
A="$(readlink -f "$1")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mkdir -p "${2:-$ROOT/dist/appimage-test}" && cd "${2:-$ROOT/dist/appimage-test}" && pwd)"
IS_IMG=0
[[ "$A" == *.AppImage ]] && IS_IMG=1
LABEL="$([ $IS_IMG = 1 ] && echo 'AppImage окно' || echo 'Окно без AppImage')"
FAILS=0
err() { echo "::error title=$LABEL::$*"; FAILS=$((FAILS + 1)); }
note() { echo "::notice title=$LABEL::$*"; }
# GitHub показывает не больше 10 аннотаций каждого вида на шаг — строки склеиваются по N в одну (через « ¦ »)
chunks() { # chunks <вид> <заголовок> <N> — строки из stdin
  local kind="$1" title="$2" n="$3" buf="" i=0 l
  while IFS= read -r l; do
    buf="${buf:+$buf ¦ }$l"; i=$((i + 1))
    if [ "$i" -ge "$n" ]; then echo "::$kind title=$title::$buf"; buf=""; i=0; fi
  done
  [ -n "$buf" ] && echo "::$kind title=$title::$buf"
  return 0
}

rm -rf "$T/cache" "$T/home" "$T/result.json" "$T/gst.log"
M="$T/cache/tmp/appimage-test"
mkdir -p "$M" "$T/out" "$T/proj" "$T/plugins" "$T/audio-plugins" "$T/home"

# Тестовые файлы. AppImage — FFmpeg из образа (так заодно проверяется, что он запускается вне программы)
if [ $IS_IMG = 1 ]; then
  FF="$(cd "$T" && "$A" --appimage-extract 'usr/bin/ffmpeg/bin/*' >/dev/null 2>&1 && echo "$T/squashfs-root/usr/bin/ffmpeg/bin/ffmpeg")"
else
  FF="$(readlink -f "${FFMPEG:-$(command -v ffmpeg)}")"
fi
if [ ! -x "$FF" ]; then err "нет ffmpeg для тестовых файлов"; exit 1; fi
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
extra=(APPIMAGE_EXTRACT_AND_RUN=1)
[ $IS_IMG = 0 ] && extra=(FFMONTAGE_FFMPEG_DIR="$(dirname "$FF")")

start=$(date +%s)
(cd "$T" && env "${extra[@]}" HOME="$T/home" FFM_NO_GPU=1 FFM_CONFIG="$T/config.json" \
  FFM_PLUGINS_DIR="$T/plugins" FFM_AUDIO_PLUGIN_PATH="$T/audio-plugins" \
  FFM_SELFTEST="$ROOT/tools/appimage-selftest.js" FFM_SHOT="$T/result.png" \
  GST_DEBUG='*:2' GST_DEBUG_NO_COLOR=1 GST_DEBUG_FILE="$T/gst.log" \
  timeout 300 xvfb-run -a -s '-screen 0 1600x1000x24' "$A" >"$T/stdout.log" 2>"$T/stderr.log")
code=$?
note "окно работало $(($(date +%s) - start)) с, код выхода $code"
[ "$code" = 124 ] && err "окно не закрылось за 5 мин (автотест не дошёл до конца)"

# Ошибки и предупреждения GStreamer (без времени и pid — одинаковые сообщения схлопываются)
if [ -f "$T/gst.log" ]; then
  note "gst.log: $(grep -c ' ERROR ' "$T/gst.log") ошибок, $(grep -c ' WARN ' "$T/gst.log") предупреждений"
  grep -E ' (ERROR|WARN) ' "$T/gst.log" | sed -E 's/^[0-9:.]+ +[0-9]+ +0x[0-9a-f]+ +//' | cut -c1-300 | sort | uniq -c | sort -rn | head -n 18 |
    chunks warning "GStreamer ($LABEL)" 3
fi
grep -iE 'gstreamer|gst_|EGL|crash|error' "$T/stderr.log" | sort -u | head -n 8 | cut -c1-300 | chunks warning "stderr ($LABEL)" 8
[ -f "$T/cache/app/logs/renderer.log" ] && grep -iE 'warn|error' "$T/cache/app/logs/renderer.log" | tail -n 6 | cut -c1-300 |
  chunks warning "renderer.log ($LABEL)" 6

if [ ! -f "$T/result.json" ]; then
  err "автотест окна не записал результат. stderr: $(tail -n 6 "$T/stderr.log" | tr '\n' ' ' | cut -c1-900)"
  exit 1
fi
jq -r '.log[]?' "$T/result.json" | chunks notice "$LABEL" 3
jq -r '.errors[]?, (.error // empty)' "$T/result.json" | chunks error "$LABEL" 3
n=$(jq '([.errors[]?] | length) + (if .error then 1 else 0 end)' "$T/result.json")
FAILS=$((FAILS + n))

if [ "$FAILS" -gt 0 ]; then
  echo "Ошибок: $FAILS"
  exit 1
fi
echo "$LABEL: <video> играет"
