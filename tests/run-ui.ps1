# Запуск автотеста интерфейса в отдельной папке кэша (ваш проект и автосохранение не трогаются).
#   powershell -ExecutionPolicy Bypass -File tests\run-ui.ps1 ui-selftest3
# Нужны тестовые файлы: сначала node tests\engine-test.js
param([string]$Test = 'ui-selftest3', [int]$TimeoutSec = 240, [switch]$KeepAutosave)
$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $PSScriptRoot
$cfg = Get-Content (Join-Path $App 'config.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
$src = if ($cfg) { Join-Path $cfg.cacheDir 'tmp\engine-test' } else { Join-Path $App '.test-cache\tmp\engine-test' }
$T = Join-Path $env:TEMP 'ffmontage-uitest'
if ($cfg) { $T = Join-Path $cfg.cacheDir 'tmp\uitest' }
New-Item -ItemType Directory -Force "$T\cache\tmp\engine-test", "$T\out", "$T\proj" | Out-Null
foreach ($f in 'a_av1_1440p60.mp4', 'b_h264_1080p30.mp4', 'c_music.mp3', 'd_old.avi') {
  $p = Join-Path $src $f
  if (Test-Path $p) { Copy-Item $p "$T\cache\tmp\engine-test\" -Force }
}
$json = @{ version = 1; cacheDir = "$T\cache"; outputDir = "$T\out"; projectsDir = "$T\proj"; ffmpegDir = '' } | ConvertTo-Json
[System.IO.File]::WriteAllText("$T\config.json", $json, (New-Object System.Text.UTF8Encoding $false))
if (-not $KeepAutosave) { Remove-Item "$T\cache\app\autosave.ffproj" -ErrorAction SilentlyContinue }
Remove-Item "$T\$Test.json" -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:FFM_CONFIG = "$T\config.json"
$env:FFM_SELFTEST = Join-Path $App "tests\$Test.js"
$env:FFM_SHOT = "$T\$Test.png"
$el = Join-Path $App 'vendor\electron\electron.exe'
if (-not (Test-Path $el)) { $el = Join-Path $App 'node_modules\electron\dist\electron.exe' }
$p = Start-Process -FilePath $el -ArgumentList "`"$App`"" -PassThru
if (-not $p.WaitForExit($TimeoutSec * 1000)) { $p.Kill(); Write-Output 'TIMEOUT' }
$r = Get-Content "$T\$Test.json" -Encoding UTF8 -Raw | ConvertFrom-Json
$r.log
if ($r.errors) { Write-Output ('ERRORS: ' + ($r.errors -join ' ;; ')) }
if ($r.error) { Write-Output ('ERROR: ' + $r.error) }
Write-Output "Снимки: $T"
