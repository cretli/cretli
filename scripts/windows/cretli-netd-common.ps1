# Shared constants and pure helpers of the Cretli Windows helper (cretli-netd).
# Dot-sourced by cretli-netd.ps1 (server), cretli-netctl.ps1 (client) and the
# installer. Everything here is side-effect free so it can be reviewed and
# mirrored in lib/port-exposure/netd-protocol.js (the Node tests pin both).

Set-StrictMode -Version 2.0

$script:NetdPipeName = 'cretli-netd'
$script:NetdPipePath = '\\.\pipe\cretli-netd'
$script:NetdProtocolVersion = 1
$script:NetdMaxRequestBytes = 4096
$script:NetdOps = @('status', 'list', 'expose', 'close', 'reconcile')
$script:NetdPortOps = @('expose', 'close')
$script:NetdAllowedFields = @('v', 'id', 'op', 'port')

$script:SidSystem = 'S-1-5-18'
$script:SidAdministrators = 'S-1-5-32-544'
$script:SidNetwork = 'S-1-5-2'

# The one access mask a regular user gets on the pipe: FILE_READ_DATA (0x1) |
# FILE_WRITE_DATA (0x2) | FILE_READ_ATTRIBUTES (0x80) | READ_CONTROL (0x20000) |
# SYNCHRONIZE (0x100000). No FILE_APPEND_DATA (0x4, which is also
# FILE_CREATE_PIPE_INSTANCE), no WRITE_DAC, no WRITE_OWNER, no generic bits.
# The server DACL and the client's CreateFile both use this single constant.
$script:PipeUserAccess = 0x00120083

# Host-level rule names. The state file is the ledger; nothing else is touched.
$script:NetdRulePrefix = 'Cretli netd'
$script:NetdHyperVRulePrefix = 'Cretli-netd-'
$script:WslVmCreatorId = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'

# Never exposed, whatever the configuration says (debug and control ports).
$script:NetdBuiltinDenylist = @(2375, 2376, 5037, 5858, 9222, 9229, 9230)

function Get-NetdPipeSddl {
    # Owner SYSTEM, protected DACL: deny NETWORK, SYSTEM full control, the
    # configured user the minimal mask. No Everyone, no Users.
    param([Parameter(Mandatory)][string]$UserSid)
    return ('O:SYD:P(D;;0x001F01FF;;;NU)(A;;0x001F01FF;;;SY)(A;;0x{0:X8};;;{1})' -f $script:PipeUserAccess, $UserSid)
}

function Test-NetdPortAllowed {
    # Returns $null when allowed, otherwise a stable error code.
    param($Port, $Config)
    if (($Port -isnot [int]) -and ($Port -isnot [long])) { return 'bad_port' }
    if ($Port -lt 1 -or $Port -gt 65535) { return 'bad_port' }
    if ($script:NetdBuiltinDenylist -contains [int]$Port) { return 'port_denylisted' }
    if (@($Config.denylist) -contains [int]$Port) { return 'port_denylisted' }
    if ($Port -lt [int]$Config.range.min -or $Port -gt [int]$Config.range.max) { return 'port_out_of_range' }
    return $null
}

function Test-NetdRequest {
    # Strict request validation. Returns @{ ok; code; request }.
    param([string]$Text, $Config)
    $fail = { param($c) return @{ ok = $false; code = $c; request = $null } }
    if ($null -eq $Text -or [Text.Encoding]::UTF8.GetByteCount($Text) -gt $script:NetdMaxRequestBytes) { return (& $fail 'too_large') }
    $req = $null
    try { $req = $Text | ConvertFrom-Json -ErrorAction Stop } catch { return (& $fail 'bad_json') }
    if ($null -eq $req -or $req -isnot [System.Management.Automation.PSCustomObject]) { return (& $fail 'bad_json') }
    $names = @($req.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($name in $names) {
        # Any field outside the whitelist (an address, a command, ...) is an error.
        if ($script:NetdAllowedFields -cnotcontains $name) { return (& $fail 'unknown_field') }
    }
    foreach ($required in @('v', 'id', 'op')) { if ($names -cnotcontains $required) { return (& $fail 'bad_request') } }
    $v = $req.v
    if ((($v -isnot [int]) -and ($v -isnot [long])) -or $v -ne $script:NetdProtocolVersion) { return (& $fail 'bad_version') }
    if ($req.id -isnot [string] -or $req.id -notmatch '^[A-Za-z0-9-]{1,64}$') { return (& $fail 'bad_request') }
    if ($req.op -isnot [string] -or $script:NetdOps -cnotcontains $req.op) { return (& $fail 'unknown_op') }
    $hasPort = $names -ccontains 'port'
    if ($script:NetdPortOps -ccontains $req.op) {
        if (-not $hasPort) { return (& $fail 'bad_port') }
        $portCode = Test-NetdPortAllowed -Port $req.port -Config $Config
        if ($portCode) { return (& $fail $portCode) }
    } elseif ($hasPort) { return (& $fail 'unknown_field') }
    return @{ ok = $true; code = $null; request = $req }
}

function Test-NetdServerIdentity {
    # Fail-closed trust decision of the client about the pipe server. Inputs are
    # plain results of GetSecurityInfo / QueryFullProcessImageName so the
    # decision is testable without a pipe. The owner check is the trust
    # boundary; the image check is an additional hint only.
    param([string]$OwnerSid, [string]$ImagePath, [string]$SystemRoot, [string]$ErrorText)
    if ($ErrorText) { return $false }
    if (($OwnerSid -cne $script:SidSystem) -and ($OwnerSid -cne $script:SidAdministrators)) { return $false }
    if (-not $ImagePath -or -not $SystemRoot) { return $false }
    $expected = Join-Path $SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    return ($ImagePath -ieq $expected)
}

function New-NetdFirewallRuleName {
    # Unique id recorded in the ledger. Ownership of a firewall rule is proven by
    # this Name, never by the shared display name.
    param([Parameter(Mandatory)][int]$Port)
    return ('Cretli-netd-{0}-{1}' -f $Port, [guid]::NewGuid().ToString('N').Substring(0, 12))
}

function Test-NetdEntryHasField {
    param($Entry, [string]$Field)
    return ($null -ne $Entry) -and ($null -ne $Entry.PSObject.Properties[$Field]) -and ($null -ne $Entry.$Field) -and ($Entry.$Field -ne '')
}

function Test-NetdProxyOwned {
    # A portproxy endpoint is ours only while its current values equal what the
    # ledger recorded. Anything else (no record, other target) is foreign.
    param($Entry, $Observed)
    if ($null -eq $Observed -or -not (Test-NetdEntryHasField $Entry 'proxy')) { return $false }
    return ($Observed.listenAddress -ceq '0.0.0.0') -and
        ($Observed.connectAddress -ceq $Entry.proxy.connectAddress) -and
        ([int]$Observed.connectPort -eq [int]$Entry.proxy.connectPort)
}

$script:NetdRuleSpec = Get-Content -Raw (Join-Path $PSScriptRoot 'cretli-netd-rule-spec.json') | ConvertFrom-Json

function New-NetdRuleToken {
    param([int]$Port)
    return ('cretli-netd:{0}:{1}' -f $Port, [guid]::NewGuid().ToString('N'))
}

function Get-NetdFirewallSpec {
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Token)
    return @{ Name = $Name; DisplayName = "$($script:NetdRulePrefix) $Port"; Description = $Token;
        Direction = 'Inbound'; Action = 'Allow'; Enabled = 'True'; Protocol = 'TCP'; LocalPort = $Port;
        RemotePort = 'Any'; LocalAddress = 'Any'; RemoteAddress = 'LocalSubnet'; Profile = 'Private,Domain';
        InterfaceType = 'Any'; EdgeTraversalPolicy = 'Block'; Program = 'Any'; Service = 'Any'; PolicyStore = 'PersistentStore' }
}

function Get-NetdHyperVFirewallSpec {
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$Token)
    $id = $Token.Split(':')[-1]
    return @{ Name = "$($script:NetdHyperVRulePrefix)${Port}-$id"; DisplayName = "$($script:NetdRulePrefix) $Port";
        Direction = 'Inbound'; Enabled = 'True'; VMCreatorId = $script:WslVmCreatorId;
        Protocol = 'TCP'; LocalPorts = $Port; RemotePorts = 'Any'; LocalAddresses = 'Any';
        RemoteAddresses = 'LocalSubnet'; Action = 'Allow'; Profiles = 'Private,Domain' }
}

function ConvertTo-NetdValueSet {
    param($Value)
    $items = @(@($Value) | ForEach-Object { "$_" -split '[,\s]+' } | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object -Unique)
    return ($items -join ',')
}

function Get-NetdFirewallFacts {
    param([Parameter(Mandatory)][string]$Name)
    $rules = @(Get-NetFirewallRule -Name $Name -PolicyStore PersistentStore -ErrorAction SilentlyContinue)
    if ($rules.Count -ne 1) { return $null }
    $rule = $rules[0]
    $port = @($rule | Get-NetFirewallPortFilter); $address = @($rule | Get-NetFirewallAddressFilter)
    $app = @($rule | Get-NetFirewallApplicationFilter); $service = @($rule | Get-NetFirewallServiceFilter)
    $interface = @($rule | Get-NetFirewallInterfaceFilter); $type = @($rule | Get-NetFirewallInterfaceTypeFilter)
    $security = @($rule | Get-NetFirewallSecurityFilter)
    if ($null -eq $rule.PSObject.Properties['PolicyStoreSource'] -or
        $null -eq $rule.PSObject.Properties['PolicyStoreSourceType']) { return $null }
    if ($port.Count -ne 1 -or $address.Count -ne 1 -or $app.Count -ne 1 -or $service.Count -ne 1 -or
        $interface.Count -ne 1 -or $type.Count -ne 1 -or $security.Count -ne 1) { return $null }
    return @{ Name = [string]$rule.Name; DisplayName = [string]$rule.DisplayName; Description = [string]$rule.Description;
        Enabled = [string]$rule.Enabled; Direction = [string]$rule.Direction; Action = [string]$rule.Action;
        Profile = [string]$rule.Profile; InterfaceType = [string]$type[0].InterfaceType;
        InterfaceAlias = [string]$interface[0].InterfaceAlias; EdgeTraversalPolicy = [string]$rule.EdgeTraversalPolicy;
        Program = [string]$app[0].Program; Service = [string]$service[0].Service; Package = [string]$app[0].Package;
        Owner = [string]$security[0].Owner; PolicyStoreSource = [string]$rule.PolicyStoreSource;
        PolicyStoreSourceType = [string]$rule.PolicyStoreSourceType;
        Protocol = [string]$port[0].Protocol; LocalPort = @($port[0].LocalPort); RemotePort = @($port[0].RemotePort);
        LocalAddress = @($address[0].LocalAddress); RemoteAddress = @($address[0].RemoteAddress) }
}

function Get-NetdHyperVFacts {
    param([Parameter(Mandatory)][string]$Name)
    $rules = @(Get-NetFirewallHyperVRule -Name $Name -ErrorAction SilentlyContinue)
    if ($rules.Count -ne 1) { return $null }
    $rule = $rules[0]
    $facts = @{}
    foreach ($key in @('Name','DisplayName','Enabled','Direction','Action','Protocol','LocalPorts','RemotePorts',
        'LocalAddresses','RemoteAddresses','Profiles','PolicyStoreSourceType','VMCreatorId')) {
        if ($null -eq $rule.PSObject.Properties[$key]) { return $null }
        $facts[$key] = $rule.$key
    }
    $facts.PolicyStoreSourceType = [string]$facts.PolicyStoreSourceType
    $facts.LocalPort = $facts.LocalPorts; [void]$facts.Remove('LocalPorts')
    return $facts
}

function Test-NetdRuleOwned {
    param($Facts, [int]$Port, [string]$Name, [string]$Token, [string]$Kind)
    if ($null -eq $Facts -or $Token -cnotmatch ('^cretli-netd:{0}:[0-9a-f]{{32}}$' -f $Port)) { return $false }
    $expected = @{ Name = $Name; DisplayName = "$($script:NetdRulePrefix) $Port"; Description = $Token; LocalPort = "$Port" }
    foreach ($property in $script:NetdRuleSpec.$Kind.PSObject.Properties) { $expected[$property.Name] = [string]$property.Value }
    if ($Kind -eq 'hyperV') {
        [void]$expected.Remove('Description')
        if ($Name -cne ("$($script:NetdHyperVRulePrefix)${Port}-$($Token.Split(':')[-1])")) { return $false }
    }
    if ($Facts.Count -ne $expected.Count) { return $false }
    foreach ($key in $expected.Keys) {
        if (-not $Facts.ContainsKey($key)) { return $false }
        if ($key -in @('Name','DisplayName','Description')) {
            if ([string]$Facts[$key] -cne $expected[$key]) { return $false }
        } elseif ((ConvertTo-NetdValueSet $Facts[$key]) -cne (ConvertTo-NetdValueSet $expected[$key])) { return $false }
    }
    return $true
}

function Test-NetdFirewallRuleOwned {
    param($Facts, [int]$Port, [string]$Name, [string]$Token)
    return Test-NetdRuleOwned -Facts $Facts -Port $Port -Name $Name -Token $Token -Kind 'firewall'
}

function Test-NetdHyperVRuleOwned {
    param($Facts, [int]$Port, [string]$Name, [string]$Token)
    return Test-NetdRuleOwned -Facts $Facts -Port $Port -Name $Name -Token $Token -Kind 'hyperV'
}

function Get-NetdUninstallPlan {
    # Only objects the ledger recorded, and only while the live object still
    # matches its record, are removed: a portproxy whose values changed and any
    # firewall rule (Hyper-V included) whose Name is not recorded or whose live spec
    # differs land in `keep` and are never changed. `ExistingRules` and
    # `ExistingHyperVRules` are fact hashtables (see Get-NetdFirewallFacts).
    param($State, $ObservedProxies, $ExistingRules, $ExistingHyperVRules)
    $entries = @($State.rules)
    $proxyPorts = @()
    $remove = @()
    $hyperV = @()
    $removedNames = @()
    foreach ($e in $entries) {
        $port = [int]$e.port
        $observed = @($ObservedProxies) | Where-Object { $_ -and $_.listenPort -eq $port -and $_.listenAddress -eq '0.0.0.0' } | Select-Object -First 1
        if (Test-NetdProxyOwned -Entry $e -Observed $observed) { $proxyPorts += $port }
        if (Test-NetdEntryHasField $e 'firewallName') {
            $facts = @($ExistingRules) | Where-Object { $_ -and $_.Name -ceq [string]$e.firewallName } | Select-Object -First 1
            if (Test-NetdFirewallRuleOwned -Facts $facts -Port $port -Name ([string]$e.firewallName) -Token ([string]$e.firewallToken)) { $remove += [string]$e.firewallName }
        }
        if (Test-NetdEntryHasField $e 'hyperVName') {
            $facts = @($ExistingHyperVRules) | Where-Object { $_ -and $_.Name -ceq [string]$e.hyperVName } | Select-Object -First 1
            if (Test-NetdHyperVRuleOwned -Facts $facts -Port $port -Name ([string]$e.hyperVName) -Token ([string]$e.hyperVToken)) { $hyperV += [string]$e.hyperVName }
        }
    }
    $all = @(@($ExistingRules) + @($ExistingHyperVRules) | Where-Object { $_ } | ForEach-Object { [string]$_.Name })
    return @{
        ports      = @($entries | ForEach-Object { [int]$_.port })
        proxyPorts = $proxyPorts
        hyperV     = $hyperV
        remove     = $remove
        keep       = @($all | Where-Object { ($remove -cnotcontains $_) -and ($hyperV -cnotcontains $_) })
    }
}
