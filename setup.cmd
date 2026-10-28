@echo off
chcp 65001 >nul
rem Сборка FF Montage из исходников: FFmpeg + Rust + сборка. Готовая программа без сборки — в Releases на GitHub.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup.ps1" %*
echo.
pause
