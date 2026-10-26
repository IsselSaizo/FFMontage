@echo off
chcp 65001 >nul
rem Запуск FF Montage. Electron берётся из vendor\ (setup.cmd) или из node_modules\ (npm install).
set ELECTRON_RUN_AS_NODE=
set "EL=%~dp0vendor\electron\electron.exe"
if not exist "%EL%" set "EL=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%EL%" (
  echo Electron не найден. Сначала запустите setup.cmd
  pause
  exit /b 1
)
start "" "%EL%" "%~dp0."
