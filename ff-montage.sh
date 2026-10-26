#!/usr/bin/env bash
# Запуск FF Montage на Linux. Electron берётся из vendor/ (./setup.sh) или из node_modules/ (npm install).
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
EL="$DIR/vendor/electron/electron"
[ -x "$EL" ] || EL="$DIR/node_modules/electron/dist/electron"
if [ ! -x "$EL" ]; then
  echo "Electron не найден. Сначала запустите ./setup.sh" >&2
  exit 1
fi
unset ELECTRON_RUN_AS_NODE

FLAGS=()
# Если песочница Chromium не настроена (chrome-sandbox не root+SUID) — запускаемся без неё,
# иначе Electron просто упадёт. Программа открывает только локальные файлы.
SB="$(dirname "$EL")/chrome-sandbox"
if [ ! -u "$SB" ] || [ "$(stat -c %u "$SB" 2>/dev/null)" != "0" ]; then
  FLAGS+=(--no-sandbox)
fi
exec "$EL" "$DIR" "${FLAGS[@]}" "$@"
