@echo off
REM Run as Administrator (right click -> Run as administrator).
REM Forwards a port from Windows to WSL (LAN). Arguments are passed to the .ps1 script,
REM for example: wsl-port-forward.bat -Port 3010,3011
REM Prefer the Network panel in Cretli; this is the manual fallback.

powershell -ExecutionPolicy Bypass -File "%~dp0wsl-port-forward.ps1" %*
pause
