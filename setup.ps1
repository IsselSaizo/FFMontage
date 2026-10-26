# Установка зависимостей FF Montage для Windows: скачивает Electron и FFmpeg в папку vendor\.
# Node.js и npm НЕ нужны. Запуск: двойной щелчок по setup.cmd
#   -SkipFFmpeg   не качать FFmpeg (если он уже есть — укажете папку в окне первого запуска)
#   -Official     качать сразу с официальных сайтов, минуя релиз репозитория
#   -From <папка> взять архивы из локальной папки (например, dist\vendor-1 после tools\make-vendor.ps1)
param([switch]$SkipFFmpeg, [switch]$Official, [string]$From)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Dir = $PSScriptRoot
$cfg = Get-Content (Join-Path $Dir 'vendor.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Vendor = Join-Path $Dir 'vendor'
$Dl = Join-Path $Vendor '_download'
New-Item -ItemType Directory -Force $Dl | Out-Null

function Get-File([string]$name, [string]$fallback) {
  $out = Join-Path $Dl $name
  if (Test-Path $out) { Write-Host "  уже скачан: $name"; return $out }
  if ($From) {
    $local = Join-Path $From $name
    if (-not (Test-Path $local)) { throw "Нет файла $local" }
    Write-Host "  копирую $local"
    Copy-Item $local $out
    return $out
  }
  $urls = @()
  if (-not $Official) { $urls += "$($cfg.release_base)/$name" }
  $urls += $fallback
  foreach ($u in $urls) {
    Write-Host "  скачиваю $u"
    & curl.exe -L --fail --progress-bar -o "$out.part" $u
    if ($LASTEXITCODE -eq 0) { Move-Item "$out.part" $out -Force; return $out }
    Write-Warning "  не получилось: $u"
  }
  Remove-Item "$out.part" -ErrorAction SilentlyContinue
  throw "Не удалось скачать $name"
}

function Expand-To([string]$archive, [string]$dest) {
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Force $dest | Out-Null
  & tar.exe -xf $archive -C $dest
  if ($LASTEXITCODE -ne 0) { Expand-Archive -Path $archive -DestinationPath $dest -Force }
}

Write-Host "`n[1/2] Electron $($cfg.electron_version)" -ForegroundColor Cyan
$zip = Get-File $cfg.win_electron $cfg.fallback_win_electron
Expand-To $zip (Join-Path $Vendor 'electron')
if (-not (Test-Path (Join-Path $Vendor 'electron\electron.exe'))) { throw 'В архиве Electron нет electron.exe' }

if (-not $SkipFFmpeg) {
  Write-Host "`n[2/2] FFmpeg" -ForegroundColor Cyan
  $zip = Get-File $cfg.win_ffmpeg $cfg.fallback_win_ffmpeg
  $tmp = Join-Path $Dl 'ffmpeg-unpacked'
  Expand-To $zip $tmp
  $exe = Get-ChildItem $tmp -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
  if (-not $exe) { throw 'В архиве FFmpeg нет ffmpeg.exe' }
  $bin = Join-Path $Vendor 'ffmpeg\bin'
  if (Test-Path (Join-Path $Vendor 'ffmpeg')) { Remove-Item (Join-Path $Vendor 'ffmpeg') -Recurse -Force }
  New-Item -ItemType Directory -Force $bin | Out-Null
  Copy-Item (Join-Path $exe.DirectoryName 'ffmpeg.exe'), (Join-Path $exe.DirectoryName 'ffprobe.exe') $bin
  Get-ChildItem $tmp -Recurse -Filter 'LICENSE*' | Select-Object -First 1 | Copy-Item -Destination (Join-Path $Vendor 'ffmpeg')
  Remove-Item $tmp -Recurse -Force
  & (Join-Path $bin 'ffmpeg.exe') -hide_banner -version | Select-Object -First 1
} else {
  Write-Host "`n[2/2] FFmpeg пропущен (-SkipFFmpeg)" -ForegroundColor Yellow
}

Write-Host "`nГотово. Архивы в vendor\_download можно удалить." -ForegroundColor Green
Write-Host "Запуск: «FF Montage.cmd». При первом запуске программа спросит, где хранить файлы."
