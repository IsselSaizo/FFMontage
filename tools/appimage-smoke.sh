#!/usr/bin/env bash
# Дымовой тест AppImage (CI: .github/workflows/appimage.yml; можно и на Linux / Steam Deck вручную):
#   tools/appimage-smoke.sh FF-Montage-<версия>-linux-x86_64.AppImage
# Проверяет: имя файла, FFmpeg и ffprobe внутри образа, плагины GStreamer (звук и видео для окна), что движок
# (ff-montage --engine …) запускается из образа, берёт FFmpeg ИЗ образа (а не подложенный в PATH), хранит данные
# в папках XDG (режим system, D7) и видит себя как AppImage (самообновление заменит именно этот файл).
# Итоги — в аннотациях GitHub (::notice / ::error), код выхода 1 — если что-то не так.
set -uo pipefail
A="$(readlink -f "$1")"
FAILS=0
W="$(mktemp -d)"
err() { echo "::error title=AppImage::$*"; FAILS=$((FAILS + 1)); }
# Заметки копятся и в конце выводятся по 2 в аннотации: GitHub показывает не больше 10 аннотаций одного вида на шаг
note() { echo "$*" >>"$W/notes"; echo "$*"; }
flush_notes() {
  [ -f "$W/notes" ] || return 0
  local buf="" i=0 l
  while IFS= read -r l; do
    buf="${buf:+$buf ¦ }$l"; i=$((i + 1))
    if [ "$i" -ge 2 ]; then echo "::notice title=AppImage::$buf"; buf=""; i=0; fi
  done <"$W/notes"
  [ -n "$buf" ] && echo "::notice title=AppImage::$buf"
  rm -f "$W/notes"
}
trap 'flush_notes; rm -rf "$W"' EXIT

[ -f "$A" ] || { err "нет файла $1"; exit 1; }
[ -x "$A" ] || err "файл не исполняемый (chmod +x)"
NAME="$(basename "$A")"
[[ "$NAME" =~ ^FF-Montage-[0-9]+\.[0-9]+\.[0-9]+-linux-x86_64\.AppImage$ ]] || err "имя «$NAME» не FF-Montage-<версия>-linux-x86_64.AppImage (update.rs его не найдёт)"
note "$NAME: $(du -h "$A" | cut -f1), $(file -b "$A" | cut -c1-80)"

# --- 1. Содержимое образа ---------------------------------------------------------------------------
(cd "$W" && "$A" --appimage-extract >/dev/null 2>&1) || err "--appimage-extract не сработал"
R="$W/squashfs-root"
for b in ffmpeg ffprobe; do
  f="$R/usr/bin/ffmpeg/bin/$b"
  if [ -x "$f" ]; then
    note "$b в образе: $("$f" -hide_banner -version 2>&1 | head -n1)"
  else
    err "в образе нет usr/bin/ffmpeg/bin/$b"
  fi
done
if [ -x "$R/usr/bin/ffmpeg/bin/ffmpeg" ]; then
  enc="$("$R/usr/bin/ffmpeg/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | awk '{print $2}' | grep -E '^(libx264|libx265|h264_vaapi|hevc_vaapi|libsvtav1|aac|libopus)$' | tr '\n' ' ')"
  note "кодировщики FFmpeg: $enc"
  for e in libx264 aac h264_vaapi hevc_vaapi; do
    grep -qw "$e" <<<"$enc" || err "в FFmpeg образа нет кодировщика $e"
  done
fi
G="$R/usr/lib/gstreamer-1.0"
if [ -d "$G" ]; then
  note "плагинов GStreamer в образе: $(find "$G" -name 'libgst*.so' | wc -l)"
  # autodetect — autoaudiosink (без него окно падает при звуке); libav — декодер H.264/AAC; isomp4/matroska — контейнеры
  for p in coreelements autodetect playback typefindfunctions app isomp4 matroska libav audioconvert audioresample volume pulseaudio; do
    [ -f "$G/libgst$p.so" ] || err "в образе нет плагина GStreamer libgst$p.so"
  done
  have=""
  for p in alsa opus vorbis vpx dav1d videoparsersbad vaapi; do [ -f "$G/libgst$p.so" ] && have="$have $p"; done
  note "дополнительные плагины GStreamer:${have:- нет}"
else
  err "в образе нет usr/lib/gstreamer-1.0 (bundleMediaFramework не сработал)"
fi
[ -n "$(find "$R" -name gst-plugin-scanner -type f 2>/dev/null | head -n1)" ] || err "в образе нет gst-plugin-scanner"
grep -rqs GST_PLUGIN_SYSTEM_PATH "$R/apprun-hooks" || err "нет apprun-hooks с GST_PLUGIN_SYSTEM_PATH — GStreamer возьмётся из системы"
[ -n "$(find "$R" -name 'WebKitWebProcess' -type f 2>/dev/null | head -n1)" ] || err "в образе нет WebKitWebProcess"
for d in "$R"/*.desktop; do [ -f "$d" ] && note "ярлык: $(basename "$d"): $(grep -E '^(Name|Exec|Icon)=' "$d" | tr '\n' ' ')"; done

# --- 2. Движок из образа --------------------------------------------------------------------------------
# Подставной ffmpeg в PATH и пустой HOME: программа должна взять FFmpeg из образа и папки XDG из нового HOME
mkdir -p "$W/decoy" "$W/home"
for b in ffmpeg ffprobe; do printf '#!/bin/sh\necho decoy-%s\nexit 3\n' "$b" >"$W/decoy/$b"; chmod +x "$W/decoy/$b"; done
engine() { # engine <команда> [режим: extract|fuse]
  local mode="${2:-extract}" extra=()
  [ "$mode" = extract ] && extra=(APPIMAGE_EXTRACT_AND_RUN=1)
  (cd "$W" && env "${extra[@]}" HOME="$W/home" XDG_CONFIG_HOME= XDG_DATA_HOME= XDG_CACHE_HOME= PATH="$W/decoy:$PATH" \
    FFM_NO_GPU=1 timeout 180 "$A" --engine "$1" </dev/null 2>"$W/engine-$1-$mode.err")
}
check_json() { # check_json <имя> <json> <jq-условие> <сообщение>
  if ! jq -e "$3" >/dev/null 2>&1 <<<"$2"; then err "$1: $4 — $(head -c 600 <<<"$2")"; fi
}

out="$(engine version)"
note "engine version: $(jq -c '.result | {ffmpeg, missing, version}' <<<"$out" 2>/dev/null || head -c 300 <<<"$out")"
check_json version "$out" '.ok == true and .result.missing == false' "движок не нашёл FFmpeg ($(tail -n 3 "$W/engine-version-extract.err" | tr '\n' ' '))"
check_json version "$out" '.result.ffmpeg | test("/usr/bin/ffmpeg/bin/ffmpeg$")' "FFmpeg взят не из образа"
check_json version "$out" '(.result.ffmpeg | startswith("/usr/bin/")) | not' "FFmpeg взят из системы"

out="$(engine paths)"
note "engine paths: $(jq -c '.result | {mode, mode_reason, app_dir, config_dir, cache_dir: .default_cache}' <<<"$out" 2>/dev/null || head -c 300 <<<"$out")"
check_json paths "$out" '.ok == true and .result.mode == "system"' "режим путей не system (XDG)"
check_json paths "$out" ".result.config_dir == \"$W/home/.config/ff-montage\"" "настройки не в ~/.config/ff-montage"
check_json paths "$out" ".result.default_cache == \"$W/home/.cache/ff-montage\"" "кэш не в ~/.cache/ff-montage"

out="$(engine info)"
if jq -e '.ok == true' >/dev/null 2>&1 <<<"$out"; then
  note "engine info: $(jq -c '.result | {appimage, ffmpeg: .ffmpeg.path, bundled: .ffmpeg.bundled, gst: .gst.missing, update: .update.asset}' <<<"$out")"
  check_json info "$out" ".result.appimage.file == \"$A\"" "программа не видит свой \$APPIMAGE (самообновление не заменит файл)"
  check_json info "$out" '.result.ffmpeg.bundled == true' "FFmpeg не из образа"
  check_json info "$out" '.result.gst.missing | length == 0' "GStreamer: не найдены плагины окна"
  check_json info "$out" '.result.gst.audioSinkMissing == false' "GStreamer: нет autoaudiosink"
  check_json info "$out" '.result.update.asset | test("^FF-Montage-.*-linux-x86_64\\.AppImage$")' "обновление выберет не AppImage"
else
  err "engine info не ответил: $(head -c 300 <<<"$out") $(tail -n 3 "$W/engine-info-extract.err" | tr '\n' ' ')"
fi

out="$(engine encoders)"
check_json encoders "$out" '.ok == true' "проверка кодировщиков упала"
note "engine encoders: $(jq -c '.result' <<<"$out" 2>/dev/null | head -c 400)"

# Обычный запуск через FUSE (как на Steam Deck). На раннере FUSE бывает недоступен — тогда только предупреждение.
if out="$(engine version fuse)" && jq -e '.ok == true' >/dev/null 2>&1 <<<"$out"; then
  note "запуск через FUSE: ок"
else
  echo "::warning title=AppImage::запуск через FUSE не удался (на раннере это бывает): $(tail -n 2 "$W/engine-version-fuse.err" | tr '\n' ' ')"
fi

if [ "$FAILS" -gt 0 ]; then
  echo "Ошибок: $FAILS"
  exit 1
fi
echo "AppImage: все проверки пройдены"
