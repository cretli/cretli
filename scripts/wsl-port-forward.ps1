# Przekierowanie portow z Windows na WSL (strona w WSL dostepna w sieci LAN).
# Uruchom w PowerShell **jako Administrator** (prawy klik -> Uruchom jako administrator).
#
# Jesli "running scripts is disabled": uruchom wsl-port-forward.bat (jako Admin)
# albo: powershell -ExecutionPolicy Bypass -File ".\wsl-port-forward.ps1"
#
# Domyslnie przekierowuje 3011. Wiecej portow: .\wsl-port-forward.ps1 -Port 3010,3011

param(
    [int[]] $Port = @(3011)
)

$ErrorActionPreference = "Stop"

# Adres IP WSL (pierwszy z hostname -I)
$wslIp = (wsl hostname -I 2>$null).ToString().Trim().Split()[0]
if (-not $wslIp) {
    Write-Host "Nie udalo sie pobrac IP WSL. Upewnij sie, ze WSL jest uruchomiony." -ForegroundColor Red
    exit 1
}

Write-Host "WSL IP: $wslIp, porty: $($Port -join ', ')" -ForegroundColor Cyan

foreach ($p in $Port) {
    netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 2>$null
    netsh advfirewall firewall delete rule name="Cretli $p" 2>$null

    netsh interface portproxy add v4tov4 listenport=$p listenaddress=0.0.0.0 connectport=$p connectaddress=$wslIp
    if ($LASTEXITCODE -ne 0) { exit 1 }

    netsh advfirewall firewall add rule name="Cretli $p" dir=in action=allow protocol=TCP localport=$p
    if ($LASTEXITCODE -ne 0) { exit 1 }
    Write-Host "  port $p OK" -ForegroundColor Green
}

Write-Host "OK. Z LAN otworz: http://<IP-tego-PC>:3011" -ForegroundColor Green
Write-Host "Po restarcie WSL uruchom skrypt ponownie (IP WSL moze sie zmienic)." -ForegroundColor Yellow
