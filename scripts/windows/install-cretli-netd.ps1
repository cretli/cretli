# Installs, reinstalls or removes the Cretli Windows helper (cretli-netd).
#
# Run in PowerShell **as Administrator**:
#   .\install-cretli-netd.ps1                    install for the signed-in user
#   .\install-cretli-netd.ps1 -Distro Ubuntu     use a specific WSL distribution
#   .\install-cretli-netd.ps1 -User DOMAIN\name  trust another account (asks for confirmation)
#   .\install-cretli-netd.ps1 -Reinstall         replace scripts, task and configuration
#   .\install-cretli-netd.ps1 -Uninstall         remove the helper and the rules it created
#
# What it does: copies the scripts and config.json to %ProgramData%\Cretli\netd
# (writable only by Administrators and SYSTEM) and registers a Scheduled Task that
# runs cretli-netd.ps1 as SYSTEM at startup and at logon of that user.

param(
    [string]$User,
    [string]$Distro,
    [ValidateSet('auto', 'nat', 'mirrored')][string]$Mode = 'auto',
    [int]$MinPort = 3000,
    [int]$MaxPort = 9999,
    [int[]]$ExtraDeny = @(),
    [switch]$Reinstall,
    [switch]$Uninstall,
    [switch]$Yes
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'cretli-netd-common.ps1', 'cretli-netd-rule-spec.json')

$TaskName = 'Cretli netd'
$InstallDir = Join-Path $env:ProgramData 'Cretli\netd'
$Files = @('cretli-netd.ps1', 'cretli-netctl.ps1', 'cretli-netd-common.ps1', 'cretli-netd-rule-spec.json')

function Assert-Admin {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this script from an elevated PowerShell (Run as administrator).'
    }
}

function Confirm-Action {
    param([string]$Message)
    if ($Yes) { return }
    $answer = Read-Host "$Message Type 'yes' to continue"
    if ($answer -ne 'yes') { throw 'Cancelled.' }
}

function Get-InteractiveUserSid {
    # The owner of explorer.exe is the signed-in desktop user, not the account that elevated.
    $explorer = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Select-Object -First 1
    if (-not $explorer) { throw 'No interactive session found (explorer.exe is not running). Use -User.' }
    return (Invoke-CimMethod -InputObject $explorer -MethodName GetOwnerSid).Sid
}

function Resolve-UserSid {
    param([string]$Name)
    return (New-Object Security.Principal.NTAccount($Name)).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Resolve-Mode {
    param([string]$UserSid)
    if ($Mode -ne 'auto') { return $Mode }
    $profilePath = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $UserSid } | Select-Object -First 1).LocalPath
    $wslConfig = if ($profilePath) { Join-Path $profilePath '.wslconfig' } else { $null }
    if ($wslConfig -and (Test-Path $wslConfig) -and ((Get-Content -Raw $wslConfig) -match '(?im)^\s*networkingMode\s*=\s*mirrored\s*$')) { return 'mirrored' }
    return 'nat'
}

function Set-InstallDirAcl {
    # Read for everyone who must run the client, write only for Administrators and SYSTEM.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $none = [Security.AccessControl.PropagationFlags]::None
    foreach ($entry in @(@($script:SidSystem, 'FullControl'), @($script:SidAdministrators, 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'))) {
        $sid = New-Object Security.Principal.SecurityIdentifier($entry[0])
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $entry[1], $inherit, $none, 'Allow')))
    }
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($script:SidAdministrators)))
    Set-Acl -Path $InstallDir -AclObject $acl
}

function Remove-Task {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
}

function Invoke-Uninstall {
    $statePath = Join-Path $InstallDir 'state.json'
    $state = if (Test-Path $statePath) { Get-Content -Raw $statePath | ConvertFrom-Json } else { [pscustomobject]@{ rules = @() } }
    if ($null -eq $state.rules) { $state | Add-Member -NotePropertyName rules -NotePropertyValue @() -Force }
    # Live facts for every recorded rule and every "Cretli*" rule, so ownership is judged on the
    # live spec and not on the Name alone.
    $names = @($state.rules | ForEach-Object { if (Test-NetdEntryHasField $_ 'firewallName') { $_.firewallName } }) +
        @(Get-NetFirewallRule -DisplayName 'Cretli*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    $existing = @($names | Where-Object { $_ } | Sort-Object -Unique | ForEach-Object { Get-NetdFirewallFacts -Name $_ } | Where-Object { $_ })
    $existingHyperV = @($state.rules | ForEach-Object { if (Test-NetdEntryHasField $_ 'hyperVName') { Get-NetdHyperVFacts -Name $_.hyperVName } } | Where-Object { $_ })
    $observed = @()
    foreach ($line in (& netsh.exe interface portproxy show v4tov4)) {
        if ($line -match '^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$') {
            $observed += @{ listenAddress = $Matches[1]; listenPort = [int]$Matches[2]; connectAddress = $Matches[3]; connectPort = [int]$Matches[4] }
        }
    }
    $plan = Get-NetdUninstallPlan -State $state -ObservedProxies $observed -ExistingRules $existing -ExistingHyperVRules $existingHyperV
    Remove-Task
    # Only objects recorded in state.json that still match their record are removed.
    foreach ($port in $plan.proxyPorts) { & netsh.exe interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 | Out-Null }
    foreach ($name in $plan.hyperV) { Remove-NetFirewallHyperVRule -Name $name -ErrorAction SilentlyContinue }
    foreach ($name in $plan.remove) { Remove-NetFirewallRule -Name $name }
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    Write-Host "Removed the helper and $(@($plan.proxyPorts).Count + @($plan.remove).Count + @($plan.hyperV).Count) object(s) it created." -ForegroundColor Green
    if (@($plan.keep).Count) {
        Write-Host 'Left in place (not created by the helper):' -ForegroundColor Yellow
        $plan.keep | ForEach-Object { Write-Host "  $_" }
    }
}

Assert-Admin

if ($Uninstall) { Invoke-Uninstall; return }

if ((Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) -and -not $Reinstall) {
    throw "The helper is already installed. Use -Reinstall to replace it or -Uninstall to remove it."
}
if ($MinPort -lt 1 -or $MaxPort -gt 65535 -or $MinPort -gt $MaxPort) { throw 'Invalid port range.' }

if ($User) {
    $userSid = Resolve-UserSid $User
    $label = $User
    Confirm-Action "Cretli will trust the account $label ($userSid) to open ports on this PC."
} else {
    $userSid = Get-InteractiveUserSid
    $label = (New-Object Security.Principal.SecurityIdentifier($userSid)).Translate([Security.Principal.NTAccount]).Value
    Confirm-Action "Cretli will trust the signed-in user $label ($userSid) to open ports on this PC. Detected from the desktop session, not from the elevated account."
}

if (-not $Distro) {
    $Distro = ((& wsl.exe --list --quiet) -join "`n" -replace "`0", '') -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1
    if ($Distro) { $Distro = $Distro.Trim() }
}
if ($Distro -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw 'Could not determine a valid WSL distribution name. Use -Distro.' }

if ($Reinstall) { Remove-Task }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Set-InstallDirAcl

foreach ($file in $Files) { Copy-Item -Force (Join-Path $PSScriptRoot $file) (Join-Path $InstallDir $file) }
$config = [ordered]@{
    v       = 1
    userSid = $userSid
    distro  = $Distro
    mode    = Resolve-Mode $userSid
    range   = [ordered]@{ min = $MinPort; max = $MaxPort }
    denylist = @($script:NetdBuiltinDenylist + $ExtraDeny | Sort-Object -Unique)
}
$config | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $InstallDir 'config.json') -Encoding UTF8
# Re-apply the ACL so files created above inherit the protected entries.
Set-InstallDirAcl

$script = Join-Path $InstallDir 'cretli-netd.ps1'
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""
$triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $label))
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed to $InstallDir for $label ($($config.mode) mode, distro $Distro)." -ForegroundColor Green
Write-Host 'Check it from a normal (non-elevated) PowerShell:'
Write-Host "  powershell.exe -NoProfile -File `"$InstallDir\cretli-netctl.ps1`" -Op status"
