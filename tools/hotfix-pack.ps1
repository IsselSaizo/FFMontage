# FF Montage hotfix package for the Google Drive folder (0.5.0, src-tauri/src/update.rs: DRIVE_FOLDER).
#
#   pwsh tools/hotfix-pack.ps1 [-KeyFile F:\FFmpeg\FFMontage-keys\update-signing.key] [-NoBuild]
#
# 1. Bump the version first (Cargo.toml, tauri.conf.json, package.json; node tools/check-version.mjs) - a hotfix is
#    the next patch version (0.5.1, 0.5.2 ...): the app offers it only if it is newer than the installed one.
# 2. cargo build --release (skip with -NoBuild).
# 3. dist/hotfix/<version>/FF-Montage-<version>-windows-x64.zip - the program without FFmpeg (the update copies the files
#    over the installed ones, the ffmpeg folder stays), plus SHA256SUMS and SHA256SUMS.sig (tools/sign-release.mjs).
# 4. Upload the three files to the Drive folder (root or a subfolder named after the version), sharing "anyone with the link".
param(
  [string]$KeyFile = 'F:\FFmpeg\FFMontage-keys\update-signing.key',
  [switch]$NoBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if (-not (Test-Path $KeyFile)) { throw "Signing key not found: $KeyFile" }
node (Join-Path $root 'tools/check-version.mjs') "v$version"
if ($LASTEXITCODE) { throw 'Version mismatch (tools/check-version.mjs)' }
if (-not $NoBuild) {
  Push-Location (Join-Path $root 'src-tauri')
  try { cargo build --release --locked; if ($LASTEXITCODE) { throw 'cargo build failed' } } finally { Pop-Location }
}
$name = "FF-Montage-$version-windows-x64"
$out = Join-Path $root "dist/hotfix/$version"
$stage = Join-Path $root "dist/hotfix/stage/$name"
Remove-Item -Recurse -Force $out, (Join-Path $root 'dist/hotfix/stage') -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $out, $stage | Out-Null
Copy-Item (Join-Path $root 'src-tauri/target/release/ff-montage.exe') (Join-Path $stage 'FF Montage.exe')
Copy-Item (Join-Path $root 'LICENSE'), (Join-Path $root 'README.md'), (Join-Path $root 'CHANGELOG.md') $stage
Compress-Archive -Path $stage -DestinationPath (Join-Path $out "$name.zip")
Remove-Item -Recurse -Force (Join-Path $root 'dist/hotfix/stage')
$env:FFM_SIGNING_KEY_FILE = $KeyFile
node (Join-Path $root 'tools/sign-release.mjs') sign $out
if ($LASTEXITCODE) { throw 'Signing failed' }
Write-Host "`nUpload to https://drive.google.com/drive/folders/1hFr83UOv7CpgD20gP1M6euudI2qyHngY :"
Get-ChildItem $out | ForEach-Object { Write-Host "  $($_.FullName)" }
