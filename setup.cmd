@echo off
chcp 65001 >nul
rem Установка зависимостей FF Montage (Electron + FFmpeg) без Node.js
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
