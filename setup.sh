#!/usr/bin/env bash
# Сборка FF Montage из исходников (Linux x86_64): FFmpeg → ffmpeg/, Rust (если нет — rustup), сборка → ./ff-montage
# Проще: готовая сборка — https://github.com/IsselSaizo/FFMontage/releases/latest
#   ./setup.sh               — всё
#   ./setup.sh --skip-ffmpeg — без FFmpeg (возьмётся системный: sudo apt install ffmpeg)
set -euo pipefail
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SKIP_FFMPEG=0
for a in "$@"; do
  case "$a" in
    --skip-ffmpeg) SKIP_FFMPEG=1 ;;
    *) echo "Неизвестный параметр: $a"; exit 2 ;;
  esac
done

echo; echo "[1/3] FFmpeg"
if [ "$SKIP_FFMPEG" = 0 ]; then bash "$DIR/tools/fetch-ffmpeg.sh" "$DIR/ffmpeg"; else echo "пропущен"; fi

echo; echo "[2/3] Rust и библиотеки окна"
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  echo "Нужны библиотеки WebKitGTK. Ubuntu/Debian:"
  echo "  sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev build-essential pkg-config"
  echo "Fedora: sudo dnf install webkit2gtk4.1-devel gtk3-devel librsvg2-devel gcc"
  read -r -p "Поставить сейчас через apt (нужен sudo)? [y/N] " ans || ans=n
  if [ "${ans,,}" = "y" ]; then
    sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev build-essential pkg-config curl
  fi
fi
CARGO="$(command -v cargo || echo "$HOME/.cargo/bin/cargo")"
if [ ! -x "$CARGO" ]; then
  echo "Rust не найден — ставлю rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  CARGO="$HOME/.cargo/bin/cargo"
fi
"$CARGO" -V

echo; echo "[3/3] Сборка (первый раз 3-6 минут)"
(cd "$DIR/src-tauri" && "$CARGO" build --release)
cp "$DIR/src-tauri/target/release/ff-montage" "$DIR/ff-montage"
chmod +x "$DIR/ff-montage"
echo; echo "Готово! Запуск: ./ff-montage"
