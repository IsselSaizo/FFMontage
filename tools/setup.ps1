# Сборка FF Montage из исходников (Windows). Запускается из setup.cmd.
#   1) FFmpeg → папка ffmpeg\     2) Rust (если нет — ставит rustup)     3) сборка → «FF Montage.exe»
# Проще всего НЕ собирать, а скачать готовый ZIP: https://github.com/IsselSaizo/FFMontage/releases/latest
param([switch]$SkipFFmpeg, [switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Dir = Split-Path -Parent $PSScriptRoot
function Step($t) { Write-Host "`n$t" -ForegroundColor Cyan }

Step '[1/3] FFmpeg'
if ($SkipFFmpeg) { Write-Host 'пропущен (-SkipFFmpeg): укажете папку при первом запуске' }
else { & (Join-Path $PSScriptRoot 'fetch-ffmpeg.ps1') -Dest (Join-Path $Dir 'ffmpeg') }

Step '[2/3] Rust'
function Find-Cargo {
  $c = Get-Command cargo -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($d in @($env:CARGO_HOME, (Join-Path $env:USERPROFILE '.cargo'))) {
    if ($d -and (Test-Path (Join-Path $d 'bin\cargo.exe'))) { return (Join-Path $d 'bin\cargo.exe') }
  }
  return $null
}
# Компилятору Rust нужен C++ компоновщик Microsoft (Build Tools)
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasVc = (Test-Path $vswhere) -and (& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if (-not $hasVc) {
  Write-Host 'Нужны Visual Studio Build Tools (C++). Ставлю через winget (~2-4 ГБ, несколько минут)…' -ForegroundColor Yellow
  & winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-package-agreements --accept-source-agreements `
    --override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось поставить Build Tools. Поставьте вручную: https://visualstudio.microsoft.com/visual-cpp-build-tools/ (нагрузка «Разработка классических приложений на C++»)' }
}
$cargo = Find-Cargo
if (-not $cargo) {
  Write-Host 'Rust не найден — ставлю rustup…'
  $init = Join-Path ([IO.Path]::GetTempPath()) 'rustup-init.exe'
  & curl.exe -L --fail --progress-bar -o $init https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe
  & $init -y --profile minimal --default-toolchain stable
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить Rust' }
  $cargo = Find-Cargo
}
& $cargo -V

Step '[3/3] Сборка (первый раз 3-6 минут)'
Push-Location (Join-Path $Dir 'src-tauri')
try {
  & $cargo build --release
  if ($LASTEXITCODE -ne 0) { throw 'Сборка не удалась' }
} finally { Pop-Location }
$exe = Join-Path $Dir 'FF Montage.exe'
Copy-Item (Join-Path $Dir 'src-tauri\target\release\ff-montage.exe') $exe -Force

if (-not $NoShortcut) {
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'FF Montage.lnk'
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($lnk); $s.TargetPath = $exe; $s.WorkingDirectory = $Dir; $s.Save()
  Write-Host "Ярлык на рабочем столе: $lnk"
}
Write-Host "`nГотово! Запуск: «FF Montage.exe» в папке программы." -ForegroundColor Green
Write-Host 'Обновление: меню ☰ → «Проверить обновления…» (git pull + пересборка).'
