@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found on PATH.
  echo Install Node.js LTS, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo ERROR: Required project files are missing.
  echo Check that node_modules has not been deleted.
  pause
  exit /b 1
)

start "Pinfall Lab Server" /min cmd.exe /d /c call "%~dp0Run_Pinfall_Server.cmd"
ping 127.0.0.1 -n 3 >nul
start "" "http://127.0.0.1:4173"

echo Pinfall Lab was opened in your browser.
echo Close the minimized Pinfall Lab Server window to stop it.
exit /b 0
