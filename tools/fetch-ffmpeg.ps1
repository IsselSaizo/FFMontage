# Скачивает FFmpeg (сборка BtbN, GPL) в папку <Dest>\bin (по умолчанию — ffmpeg\ в папке программы).
#   powershell -ExecutionPolicy Bypass -File tools\fetch-ffmpeg.ps1 [-Dest <папка>]
param([string]$Dest = (Join-Path (Split-Path -Parent $PSScriptRoot) 'ffmpeg'),
      [string]$Url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-9.0.zip')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (Test-Path (Join-Path $Dest 'bin\ffmpeg.exe')) { Write-Host "FFmpeg уже есть: $Dest"; exit 0 }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ffm-ffmpeg-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'ffmpeg.zip'
  Write-Host "Скачиваю FFmpeg: $Url"
  & curl.exe -L --fail --progress-bar -o $zip $Url
  if ($LASTEXITCODE -ne 0) { throw "Не удалось скачать $Url" }
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
