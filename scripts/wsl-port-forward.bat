@echo off
REM Uruchom jako Administrator (prawy klik -> Uruchom jako administrator).
REM Ustawia przekierowanie portu z Windows na WSL (LAN).

powershell -ExecutionPolicy Bypass -File "%~dp0wsl-port-forward.ps1" %*
pause
