# Forwards ports from Windows to WSL so a web app inside WSL is reachable on the LAN.
# This is the manual fallback. Prefer the Network panel in Cretli: it records every
# exposure in a ledger, expires it after a TTL and repairs it when the WSL IP changes.
#
# Run in PowerShell **as Administrator** (right click -> Run as administrator).
#
# If you see "running scripts is disabled", run wsl-port-forward.bat (as Administrator)
# or: powershell -ExecutionPolicy Bypass -File ".\wsl-port-forward.ps1"
#
# Forwards 3011 by default. More ports: .\wsl-port-forward.ps1 -Port 3010,3011
#
# The firewall rule is limited to TCP, the given port, the Private and Domain
# profiles (never Public) and the local subnet. Debug ports are refused.

param(
    [int[]] $Port = @(3011)
)

$ErrorActionPreference = "Stop"

# Ports that must never be exposed to the LAN (debug and control ports).
$denyPorts = @(9222, 9229, 9230, 5858, 5037, 2375, 2376)

foreach ($p in $Port) {
    if ($denyPorts -contains $p) {
        Write-Host "Refusing port $p: it is on the exposure denylist (debug/control port)." -ForegroundColor Red
        exit 1
    }
}

# WSL IP address (first entry of hostname -I)
$wslIp = (wsl hostname -I 2>$null).ToString().Trim().Split()[0]
if (-not $wslIp) {
    Write-Host "Could not read the WSL IP. Make sure WSL is running." -ForegroundColor Red
    exit 1
}

Write-Host "WSL IP: $wslIp, ports: $($Port -join ', ')" -ForegroundColor Cyan

foreach ($p in $Port) {
    netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 2>$null
    netsh advfirewall firewall delete rule name="Cretli $p" 2>$null

    netsh interface portproxy add v4tov4 listenport=$p listenaddress=0.0.0.0 connectport=$p connectaddress=$wslIp
    if ($LASTEXITCODE -ne 0) { exit 1 }

    netsh advfirewall firewall add rule name="Cretli $p" dir=in action=allow protocol=TCP localport=$p profile=private,domain remoteip=localsubnet
    if ($LASTEXITCODE -ne 0) { exit 1 }
    Write-Host "  port $p OK" -ForegroundColor Green
}

Write-Host "Done. From the LAN open: http://<this-PC-IP>:3011" -ForegroundColor Green
Write-Host "Run this script again after restarting WSL (the WSL IP may change)." -ForegroundColor Yellow
