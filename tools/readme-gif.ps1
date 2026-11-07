# docs/media/demo.gif для README: синтетические клипы (без чужих материалов) → кадры окна (tests/readme-demo.js,
# английский интерфейс) → GIF не больше ~1 МБ.
#   powershell -ExecutionPolicy Bypass -File tools\readme-gif.ps1 [-Width 960] [-Fps 10] [-Colors 96] [-Dither none|bayer:bayer_scale=5] [-SkipCapture — только пересобрать GIF]
# Нужны собранный src-tauri\target\release\ff-montage.exe и ffmpeg (папка ffmpeg\ рядом, соседняя ffmpeg-* или PATH).
param([int]$Width = 960, [int]$Fps = 10, [int]$Colors = 96, [string]$Dither = 'none', [switch]$SkipCapture)
$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $PSScriptRoot
$T = Join-Path $App '.test-cache\tmp\uitest'
$ff = @((Get-Command ffmpeg -ErrorAction SilentlyContinue | ForEach-Object Source), (Join-Path $App 'ffmpeg\ffmpeg.exe')) +
  @(Get-ChildItem (Split-Path -Parent $App) -Filter ffmpeg.exe -Recurse -Depth 3 -ErrorAction SilentlyContinue | ForEach-Object FullName) |
  Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $ff) { throw 'ffmpeg не найден' }

if (-not $SkipCapture) {
  # Клипы: радиальный и спиральный градиенты, фрактал и аккорд с пульсацией — всё рисует сам FFmpeg
  $d = "$T\cache\tmp\demo"
  New-Item -ItemType Directory -Force $d | Out-Null
  $enc = @('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30')
  if (-not (Test-Path "$d\Aurora.mp4")) {
    & $ff -v error -y -f lavfi -i 'gradients=s=1920x1080:r=30:d=6:c0=0x7c5cff:c1=0xff5c8a:c2=0x22d3ee:c3=0x1b1036:n=4:speed=0.025:type=radial' @enc "$d\Aurora.mp4"
  }
  if (-not (Test-Path "$d\Fractal.mp4")) {
    & $ff -v error -y -f lavfi -i 'mandelbrot=s=1280x720:rate=30:maxiter=600:start_scale=2.5:end_scale=0.15:end_pts=200:outer=normalized_iteration_count,trim=duration=6,scale=1920:1080' @enc "$d\Fractal.mp4"
  }
  if (-not (Test-Path "$d\Spiral.mp4")) {
    & $ff -v error -y -f lavfi -i 'gradients=s=1920x1080:r=30:d=6:c0=0xffd166:c1=0xef476f:c2=0x7c5cff:c3=0x06d6a0:n=4:speed=0.04:type=spiral' @enc "$d\Spiral.mp4"
  }
  if (-not (Test-Path "$d\Music.mp3")) {
    $ch = '(0.22*sin(2*PI*220*t)+0.14*sin(2*PI*277.2*t)+0.12*sin(2*PI*329.6*t))*(0.35+0.65*exp(-6*mod(t,0.5)))'
    & $ff -v error -y -f lavfi -i "aevalsrc='$ch|$ch':s=48000:d=16" -c:a libmp3lame -b:a 160k "$d\Music.mp3"
  }
  Get-ChildItem $T -Filter 'demo_*.png' | Remove-Item
  & (Join-Path $PSScriptRoot '..\tests\run-ui.ps1') readme-demo -Lang en -TimeoutSec 300 | Out-Null
}

$r = Get-Content "$T\readme-demo.json" -Encoding UTF8 -Raw | ConvertFrom-Json
if ($r.errors) { Write-Output ('ERRORS: ' + ($r.errors -join ' ;; ')) }
$frames = @($r.log | Where-Object { $_ -match '^demo_\d+\.png ' })
if (-not $frames.Count) { throw 'кадров нет' }
# Список для concat: у каждого кадра своя длительность, последний повторяется (так concat учитывает его длительность)
$lines = foreach ($f in $frames) { $n, $dur = $f -split ' '; "file '$n'"; "duration $dur" }
$lines += "file '$(($frames[-1] -split ' ')[0])'"
[IO.File]::WriteAllLines("$T\demo-list.txt", $lines)
$out = Join-Path $App 'docs\media\demo.gif'
$vf = "fps=$Fps,scale=${Width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${Colors}:stats_mode=diff[p];[b][p]paletteuse=dither=${Dither}:diff_mode=rectangle"
Push-Location $T
try { & $ff -v error -y -f concat -safe 0 -i demo-list.txt -vf $vf -loop 0 $out } finally { Pop-Location }
$kb = [math]::Round((Get-Item $out).Length / 1KB)
Write-Output "demo.gif: $($frames.Count) кадров, $kb КБ"
