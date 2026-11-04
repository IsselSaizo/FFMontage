# Запуск автотеста интерфейса в отдельной папке кэша (ваш проект и автосохранение не трогаются).
#   powershell -ExecutionPolicy Bypass -File tests\run-ui.ps1 ui-selftest3
# Нужны тестовые файлы: сначала node tests\engine-test.js
#   -Lang en — интерфейс на английском (settings.lang в тестовом config.json)
#   -Plugins — положить тестовый плагин (tests\fixtures\plugins) в папку плагинов; для ui-selftest13 включено всегда.
#   Папка плагинов теста — <T>\plugins (FFM_PLUGINS_DIR), очищается при каждом запуске: без -Plugins она пустая,
#   чтобы вкладки и клавиши плагина не мешали остальным тестам (ui-selftest5 считает вкладки справа).
param([string]$Test = 'ui-selftest3', [int]$TimeoutSec = 240, [switch]$KeepAutosave, [string]$Lang = '', [switch]$Plugins)
$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $PSScriptRoot
# Всё — в .test-cache проекта: кэш пользователя из config.json не трогаем
$src = Join-Path $App '.test-cache\tmp\engine-test'
$T = Join-Path $App '.test-cache\tmp\uitest'
New-Item -ItemType Directory -Force "$T\cache\tmp\engine-test", "$T\out", "$T\proj" | Out-Null
foreach ($f in 'a_av1_1440p60.mp4', 'b_h264_1080p30.mp4', 'c_music.mp3', 'd_old.avi', 'e_2audio.mp4', 'f_photo.png', 'g_anim.gif', 's_sprite.png') {
  $p = Join-Path $src $f
  if (Test-Path $p) { Copy-Item $p "$T\cache\tmp\engine-test\" -Force }
}
# ui-selftest18 (контейнеры): файлы MKV из node tests\container-test.js
if ($Test -eq 'ui-selftest18') {
  foreach ($f in 'in_h264_aac.mkv', 'in_h264_flac.mkv', 'in_h264_aac.ts') {
    $p = Join-Path $App ".test-cache\tmp\container-test\$f"
    if (Test-Path $p) { Copy-Item $p "$T\cache\tmp\engine-test\" -Force }
  }
}
$cfg = @{ version = 1; cacheDir = "$T\cache"; outputDir = "$T\out"; projectsDir = "$T\proj"; ffmpegDir = '' }
if ($Lang) { $cfg.settings = @{ lang = $Lang } }
$json = $cfg | ConvertTo-Json
[System.IO.File]::WriteAllText("$T\config.json", $json, (New-Object System.Text.UTF8Encoding $false))
# Настройки интерфейса (M0.6) — в settings.json рядом с config.json: каждый тест начинает с чистых
# (settings.lang из config.json программа перенесёт туда сама)
Remove-Item "$T\settings.json" -ErrorAction SilentlyContinue
if (-not $KeepAutosave) { Remove-Item "$T\cache\app\autosave.ffproj" -ErrorAction SilentlyContinue }
Remove-Item "$T\$Test.json" -ErrorAction SilentlyContinue
# Плагины: <App>\.test-cache\tmp\uitest\plugins — заново при каждом запуске (вместе с .data — storage плагинов)
$plg = Join-Path $T 'plugins'
if ((Split-Path -Leaf $plg) -eq 'plugins' -and $plg.StartsWith((Join-Path $App '.test-cache')) -and (Test-Path $plg)) { Remove-Item $plg -Recurse -Force }
New-Item -ItemType Directory -Force $plg | Out-Null
if ($Plugins -or $Test -eq 'ui-selftest13') {
  Copy-Item (Join-Path $App 'tests\fixtures\plugins\*') $plg -Recurse -Force
}
# ui-selftest14 проверяет пример-плагин «Раскладки кадра» (M4.6)
if ($Test -eq 'ui-selftest14') {
  Copy-Item (Join-Path $App 'examples\plugins\layouts') $plg -Recurse -Force
}
# Аудиоплагины VST3/CLAP: только тестовые (FFM_AUDIO_PLUGIN_PATH отключает системные папки), для ui-selftest17 —
# собранные примеры (cargo build --profile fast --example vst3_test_gain --example clap_test_gain)
$aplg = Join-Path $T 'audio-plugins'
if ((Test-Path $aplg) -and $aplg.StartsWith((Join-Path $App '.test-cache'))) { Remove-Item $aplg -Recurse -Force }
New-Item -ItemType Directory -Force $aplg | Out-Null
Remove-Item "$T\audio-plugins.json" -ErrorAction SilentlyContinue
if ($Test -eq 'ui-selftest17') {
  foreach ($n in @(@('vst3_test_gain', 'FFM Test Gain.vst3'), @('clap_test_gain', 'FFM Test Gain.clap'))) {
    $dll = @('fast', 'release', 'debug') | ForEach-Object { Join-Path $App "src-tauri\target\$_\examples\$($n[0]).dll" } | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($dll) { Copy-Item $dll (Join-Path $aplg $n[1]) -Force }
  }
}
$env:FFM_AUDIO_PLUGIN_PATH = $aplg
$env:FFM_PLUGINS_DIR = $plg
$env:FFM_CONFIG = "$T\config.json"
$env:FFM_SELFTEST = Join-Path $App "tests\$Test.js"
$env:FFM_SHOT = "$T\$Test.png"
$exe = if ($env:FFM_EXE) { $env:FFM_EXE } else { Join-Path $App 'src-tauri\target\release\ff-montage.exe' }
if (-not (Test-Path $exe)) { $exe = Join-Path $App 'FF Montage.exe' }
$p = Start-Process -FilePath $exe -WorkingDirectory $App -PassThru
if (-not $p.WaitForExit($TimeoutSec * 1000)) { $p.Kill(); Write-Output 'TIMEOUT' }
$r = Get-Content "$T\$Test.json" -Encoding UTF8 -Raw | ConvertFrom-Json
$r.log
if ($r.errors) { Write-Output ('ERRORS: ' + ($r.errors -join ' ;; ')) }
if ($r.error) { Write-Output ('ERROR: ' + $r.error) }
Write-Output "Снимки: $T"
