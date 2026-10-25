@echo off
setlocal
cd /d "%~dp0"
echo Starting website preview server...
call npm run dev:website
pause
