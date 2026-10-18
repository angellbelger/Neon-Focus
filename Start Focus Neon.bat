@echo off
rem Windows launcher: double-click to start Focus Neon.
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Download the LTS version from https://nodejs.org, install it, then double-click this file again.
  pause
  exit /b 1
)

if not exist "node_modules\electron\" (
  echo First run: installing Focus Neon ^(this takes a minute^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo Installation failed. See the messages above.
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 pause
