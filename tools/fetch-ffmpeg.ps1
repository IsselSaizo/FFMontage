# Скачивает FFmpeg (сборка BtbN, GPL) в папку <Dest>\bin (по умолчанию — ffmpeg\ в папке программы).
#   powershell -ExecutionPolicy Bypass -File tools\fetch-ffmpeg.ps1 [-Dest <папка>]
# Сборка закреплена по версии и SHA-256 (M0.12): обновлять — вместе с fetch-ffmpeg.sh, хэш брать из
# https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/<тег> (поле digest) или посчитать: Get-FileHash.
# Своя сборка: -Url <ссылка> -Sha256 <хэш> (или -NoVerify, если хэша нет — на свой риск).
param([string]$Dest = (Join-Path (Split-Path -Parent $PSScriptRoot) 'ffmpeg'),
      [string]$Url = '',
      [string]$Sha256 = '',
      [switch]$NoVerify)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# BtbN autobuild от 04.11.2026, ветка release/9.0 (n9.0.2-47-gb204e94e90), win64 gpl
$PinTag = 'autobuild-2026-11-04-12-51'
$PinFile = 'ffmpeg-n9.0.2-47-gb204e94e90-win64-gpl-9.0.zip'
$PinSha256 = 'db2867364898bf8b68f5404b998165dfd8d31c9bfabc2a35d6e0c941bf33c1ea'

if (-not $Url) {
  $Url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$PinTag/$PinFile"
  if (-not $Sha256) { $Sha256 = $PinSha256 }
} elseif (-not $Sha256 -and -not $NoVerify) {
  throw 'Для своей ссылки -Url укажите -Sha256 <хэш> (или -NoVerify)'
}
if (Test-Path (Join-Path $Dest 'bin\ffmpeg.exe')) { Write-Host "FFmpeg уже есть: $Dest"; exit 0 }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ffm-ffmpeg-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'ffmpeg.zip'
  Write-Host "Скачиваю FFmpeg: $Url"
  & curl.exe -L --fail --progress-bar -o $zip $Url
  if ($LASTEXITCODE -ne 0) { throw "Не удалось скачать $Url" }
  if ($Sha256) {
    $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
    if ($got -ne $Sha256.ToLowerInvariant()) { throw "SHA-256 не совпадает: ожидался $Sha256, получен $got" }
    Write-Host "SHA-256 верен: $got"
  } else {
    Write-Warning 'SHA-256 не проверяется (-NoVerify)'
  }
  & tar.exe -xf $zip -C $tmp
  if ($LASTEXITCODE -ne 0) { Expand-Archive -Path $zip -DestinationPath $tmp -Force }
  $exe = Get-ChildItem $tmp -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
  if (-not $exe) { throw 'В архиве нет ffmpeg.exe' }
  $bin = Join-Path $Dest 'bin'
  New-Item -ItemType Directory -Force $bin | Out-Null
  Copy-Item (Join-Path $exe.DirectoryName 'ffmpeg.exe'), (Join-Path $exe.DirectoryName 'ffprobe.exe') $bin -Force
  Get-ChildItem $tmp -Recurse -Filter 'LICENSE*' | Select-Object -First 1 | Copy-Item -Destination $Dest -Force
  & (Join-Path $bin 'ffmpeg.exe') -hide_banner -version | Select-Object -First 1
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
