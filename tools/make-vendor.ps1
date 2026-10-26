# Собирает архивы Electron и FFmpeg для релиза репозитория (их потом качают setup.cmd / setup.sh).
# Результат: dist\vendor-1\ — 4 файла + SHA256SUMS.txt. Загрузите их в GitHub → Releases → тег vendor-1.
#   -FFmpegDir <папка>  откуда взять ffmpeg.exe/ffprobe.exe для Windows (по умолчанию — найти рядом с программой)
param([string]$FFmpegDir, [string]$Tag = 'vendor-1')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$App = Split-Path $PSScriptRoot -Parent
$cfg = Get-Content (Join-Path $App 'vendor.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Out = Join-Path $App "dist\$Tag"
New-Item -ItemType Directory -Force $Out | Out-Null

function Download([string]$url, [string]$file) {
  if (Test-Path $file) { Write-Host "  уже есть: $(Split-Path $file -Leaf)"; return }
  Write-Host "  скачиваю $url"
  & curl.exe -L --fail --progress-bar -o "$file.part" $url
  if ($LASTEXITCODE -ne 0) { throw "Не удалось скачать $url" }
  Move-Item "$file.part" $file -Force
}

# 1. Electron для Windows: берём из кэша npm-установки, если есть, иначе качаем
Write-Host "[1/4] $($cfg.win_electron)" -ForegroundColor Cyan
$winEl = Join-Path $Out $cfg.win_electron
if (-not (Test-Path $winEl)) {
  $cacheDirs = @($env:electron_config_cache)
  $conf = Join-Path $App 'config.json'
  if (Test-Path $conf) { $cacheDirs += Join-Path (Get-Content $conf -Raw -Encoding UTF8 | ConvertFrom-Json).cacheDir 'electron' }
  $cached = $cacheDirs | Where-Object { $_ -and (Test-Path $_) } |
    ForEach-Object { Get-ChildItem $_ -Recurse -Filter $cfg.win_electron -ErrorAction SilentlyContinue } | Select-Object -First 1
  if ($cached) { Write-Host "  из кэша: $($cached.FullName)"; Copy-Item $cached.FullName $winEl }
  else { Download $cfg.fallback_win_electron $winEl }
}

# 2. Electron для Linux
Write-Host "[2/4] $($cfg.linux_electron)" -ForegroundColor Cyan
Download $cfg.fallback_linux_electron (Join-Path $Out $cfg.linux_electron)

# 3. FFmpeg для Windows: упаковываем тот, что уже стоит
Write-Host "[3/4] $($cfg.win_ffmpeg)" -ForegroundColor Cyan
$winFf = Join-Path $Out $cfg.win_ffmpeg
if (-not (Test-Path $winFf)) {
  if (-not $FFmpegDir) {
    $cands = @((Join-Path $App 'vendor\ffmpeg\bin')) + (Get-ChildItem (Split-Path $App -Parent) -Directory -Filter 'ffmpeg*' | ForEach-Object { Join-Path $_.FullName 'bin' })
    $FFmpegDir = $cands | Where-Object { Test-Path (Join-Path $_ 'ffmpeg.exe') } | Select-Object -First 1
  }
  if (-not $FFmpegDir) { throw 'Не найден ffmpeg.exe — укажите -FFmpegDir' }
  Write-Host "  из $FFmpegDir"
  $stage = Join-Path $Out '_stage'
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force (Join-Path $stage 'bin') | Out-Null
  Copy-Item (Join-Path $FFmpegDir 'ffmpeg.exe'), (Join-Path $FFmpegDir 'ffprobe.exe') (Join-Path $stage 'bin')
  $lic = Get-ChildItem (Split-Path $FFmpegDir -Parent) -Filter 'LICENSE*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($lic) { Copy-Item $lic.FullName $stage }
  Push-Location $stage
  & tar.exe -a -c -f $winFf *
  Pop-Location
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось упаковать FFmpeg' }
  Remove-Item $stage -Recurse -Force
}

# 4. FFmpeg для Linux: статическая сборка BtbN как есть (tar.xz сохраняет права на запуск)
Write-Host "[4/4] $($cfg.linux_ffmpeg)" -ForegroundColor Cyan
Download $cfg.fallback_linux_ffmpeg (Join-Path $Out $cfg.linux_ffmpeg)

$names = @($cfg.win_electron, $cfg.linux_electron, $cfg.win_ffmpeg, $cfg.linux_ffmpeg)
$sums = foreach ($n in $names) { '{0}  {1}' -f (Get-FileHash (Join-Path $Out $n) -Algorithm SHA256).Hash.ToLower(), $n }
$sums | Set-Content (Join-Path $Out 'SHA256SUMS.txt') -Encoding ASCII

Write-Host "`nГотово: $Out" -ForegroundColor Green
Get-ChildItem $Out | ForEach-Object { '  {0,-40} {1,8:N1} МБ' -f $_.Name, ($_.Length / 1MB) }
Write-Host "`nЗагрузите эти файлы в GitHub: Releases → Draft a new release → тег $Tag → прикрепить файлы → Publish."
