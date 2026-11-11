@echo off
cd /d "%~dp0"
node node_modules\vite\bin\vite.js --force --host 127.0.0.1 --port 4173
