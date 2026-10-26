#!/usr/bin/env bash
# Установка зависимостей FF Montage для Linux: скачивает Electron и FFmpeg в папку vendor/.
# Node.js и npm НЕ нужны. Нужны: curl (или wget), unzip (или python3), tar с xz.
#   ./setup.sh               — всё
#   ./setup.sh --skip-ffmpeg — без FFmpeg (возьмётся системный: sudo apt install ffmpeg)
#   ./setup.sh --official    — сразу с официальных сайтов, минуя релиз репозитория
set -euo pipefail

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
VENDOR="$DIR/vendor"
DL="$VENDOR/_download"
SKIP_FFMPEG=0
OFFICIAL=0
for a in "$@"; do
  case "$a" in
    --skip-ffmpeg) SKIP_FFMPEG=1 ;;
    --official) OFFICIAL=1 ;;
    *) echo "Неизвестный параметр: $a"; exit 2 ;;
  esac
done

if [ "$(uname -m)" != "x86_64" ]; then
  echo "Поддерживается только x86_64 (у вас $(uname -m))."; exit 1
fi

# Значение ключа из vendor.json (каждый ключ на своей строке)
get() { sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$DIR/vendor.json" | head -n1; }

download() { # url file
  if command -v curl >/dev/null 2>&1; then curl -L --fail --progress-bar -o "$2" "$1"
  else wget -q --show-progress -O "$2" "$1"; fi
}

fetch() { # name fallback_url -> печатает путь к файлу
  local name="$1" fallback="$2" out="$DL/$1"
  if [ -f "$out" ]; then echo "  уже скачан: $name" >&2; echo "$out"; return 0; fi
  local urls=()
  [ "$OFFICIAL" = 1 ] || urls+=("$(get release_base)/$name")
  urls+=("$fallback")
  for u in "${urls[@]}"; do
    echo "  скачиваю $u" >&2
    if download "$u" "$out.part"; then mv -f "$out.part" "$out"; echo "$out"; return 0; fi
    echo "  не получилось: $u" >&2
  done
  rm -f "$out.part"
  echo "Не удалось скачать $name" >&2; exit 1
}

unzip_to() { # zip dir
  rm -rf "$2"; mkdir -p "$2"
  if command -v unzip >/dev/null 2>&1; then unzip -q "$1" -d "$2"
  elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$1" "$2"
  else echo "Нужен unzip или python3: sudo apt install unzip" >&2; exit 1; fi
}

mkdir -p "$DL"

echo; echo "[1/2] Electron $(get electron_version)"
zip="$(fetch "$(get linux_electron)" "$(get fallback_linux_electron)")"
unzip_to "$zip" "$VENDOR/electron"
chmod +x "$VENDOR/electron/electron" "$VENDOR/electron/chrome_crashpad_handler" 2>/dev/null || true
[ -x "$VENDOR/electron/electron" ] || { echo "В архиве Electron нет файла electron" >&2; exit 1; }

# Песочница Chromium: chrome-sandbox должен принадлежать root и иметь бит SUID.
# Без этого запуск идёт с --no-sandbox (ff-montage.sh решает сам). Можно настроить сейчас:
SB="$VENDOR/electron/chrome-sandbox"
if [ -f "$SB" ] && command -v sudo >/dev/null 2>&1; then
  echo
  read -r -p "Настроить песочницу Chromium (нужен sudo: chown root + chmod 4755 на chrome-sandbox)? [y/N] " ans || ans=n
  if [ "${ans,,}" = "y" ]; then sudo chown root:root "$SB" && sudo chmod 4755 "$SB" && echo "  песочница настроена"; fi
fi

if [ "$SKIP_FFMPEG" = 0 ]; then
  echo; echo "[2/2] FFmpeg"
  arc="$(fetch "$(get linux_ffmpeg)" "$(get fallback_linux_ffmpeg)")"
  tmp="$DL/ffmpeg-unpacked"
  rm -rf "$tmp"; mkdir -p "$tmp"
  tar -xJf "$arc" -C "$tmp"
  ff="$(find "$tmp" -type f -name ffmpeg -path '*/bin/*' | head -n1)"
  [ -n "$ff" ] || { echo "В архиве FFmpeg нет bin/ffmpeg" >&2; exit 1; }
  rm -rf "$VENDOR/ffmpeg"; mkdir -p "$VENDOR/ffmpeg/bin"
  cp "$(dirname "$ff")/ffmpeg" "$(dirname "$ff")/ffprobe" "$VENDOR/ffmpeg/bin/"
  chmod +x "$VENDOR/ffmpeg/bin/ffmpeg" "$VENDOR/ffmpeg/bin/ffprobe"
  lic="$(find "$tmp" -maxdepth 2 -name 'LICENSE*' | head -n1)"; [ -n "$lic" ] && cp "$lic" "$VENDOR/ffmpeg/" || true
  rm -rf "$tmp"
  "$VENDOR/ffmpeg/bin/ffmpeg" -hide_banner -version | head -n1
else
  echo; echo "[2/2] FFmpeg пропущен (--skip-ffmpeg)"
fi

chmod +x "$DIR/ff-montage.sh" 2>/dev/null || true
echo; echo "Готово. Архивы в vendor/_download можно удалить."
echo "Запуск: ./ff-montage.sh  (при первом запуске программа спросит, где хранить файлы)"
