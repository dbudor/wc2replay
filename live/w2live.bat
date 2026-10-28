@echo off
rem w2live: records the games played on this PC, live (README.txt). Close this window to stop.
cd /d "%~dp0"
node w2live.mjs %*
pause
