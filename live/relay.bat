@echo off
rem w2live relay on this PC (README.txt): viewers on the LAN open http://THIS-PC:8080/
cd /d "%~dp0"
node relay.mjs --port 8080 --viewer .. %*
pause
