# cretli-netd: the elevated Windows side of Cretli's port exposure.
#
# Runs as a Scheduled Task under SYSTEM (see install-cretli-netd.ps1). It owns a
# single named pipe and performs a closed list of operations (status, list,
# expose, close, reconcile). Arguments for netsh and the firewall cmdlets are
# built only from a validated integer port; the target address comes from
# `wsl.exe hostname -I` run in the signed-in user's session, never from a client.
# There is no network listener: the pipe is the only channel.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'cretli-netd-common.ps1')

$script:Dir = $PSScriptRoot
$script:ConfigPath = Join-Path $script:Dir 'config.json'
$script:StatePath = Join-Path $script:Dir 'state.json'
$script:AuditPath = Join-Path $script:Dir 'audit.log'
$script:AuditMaxBytes = 262144
$script:ReadTimeoutMs = 5000
$script:ReconcileIntervalMs = 60000
$script:ReconcileRetryMs = 5000
$script:RateWindowMs = 60000
$script:RateMax = 60
$script:RateTimes = New-Object System.Collections.Generic.List[long]

# PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE: nobody else can create an instance first.
$PIPE_ACCESS_DUPLEX = 0x00000003
$FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000
# Byte stream in both directions; the protocol is newline-delimited JSON.
$PIPE_TYPE_BYTE = 0x00000000
$PIPE_READMODE_BYTE = 0x00000000
$PIPE_WAIT = 0x00000000
$PIPE_REJECT_REMOTE_CLIENTS = 0x00000008
$NETD_MAX_INSTANCES = 1

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Security.Principal;

public static class NetdNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuf, uint inBuf, uint defTimeout, ref SECURITY_ATTRIBUTES sa);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ConnectNamedPipe(IntPtr h, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool DisconnectNamedPipe(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeClientProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CancelIoEx(IntPtr h, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FlushFileBuffers(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ReadFile(IntPtr h, byte[] buf, int n, out int read, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool WriteFile(IntPtr h, byte[] buf, int n, out int written, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQueryUserToken(uint session, out IntPtr token);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, uint size);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("userenv.dll", SetLastError = true)] public static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
    [DllImport("userenv.dll", SetLastError = true)] public static extern bool DestroyEnvironmentBlock(IntPtr env);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    static volatile bool waiting;

    /// 0 = client connected, 1 = tick (nothing connected), 2 = error.
    public static int Connect(IntPtr pipe, int tickMs)
    {
        Timer timer = new Timer(delegate(object o) { if (waiting) CancelIoEx(pipe, IntPtr.Zero); }, null, tickMs, Timeout.Infinite);
        waiting = true;
        try
        {
            if (ConnectNamedPipe(pipe, IntPtr.Zero)) return 0;
            int err = Marshal.GetLastWin32Error();
            if (err == 535) return 0;      // ERROR_PIPE_CONNECTED: the client was faster than us.
            if (err == 995) return 1;      // ERROR_OPERATION_ABORTED: our own tick.
            return 2;
        }
        finally { waiting = false; timer.Dispose(); }
    }

    /// Reads one line (up to maxBytes). 0 = ok, 1 = too large, 2 = timeout or I/O error.
    public static int ReadLine(IntPtr pipe, int maxBytes, int timeoutMs, out string line)
    {
        line = null;
        bool active = true;
        Timer timer = new Timer(delegate(object o) { if (active) CancelIoEx(pipe, IntPtr.Zero); }, null, timeoutMs, Timeout.Infinite);
        MemoryStream data = new MemoryStream();
        byte[] buf = new byte[512];
        try
        {
            while (true)
            {
                int n;
                if (!ReadFile(pipe, buf, buf.Length, out n, IntPtr.Zero) || n == 0) return 2;
                int nl = Array.IndexOf(buf, (byte)10, 0, n);
                int take = nl >= 0 ? nl : n;
                data.Write(buf, 0, take);
                if (data.Length > maxBytes) return 1;
                if (nl >= 0) { line = Encoding.UTF8.GetString(data.ToArray()).TrimEnd('\r'); return 0; }
            }
        }
        finally { active = false; timer.Dispose(); }
    }

    public static bool WriteLine(IntPtr pipe, string text)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(text + "\n");
        int written;
        return WriteFile(pipe, bytes, bytes.Length, out written, IntPtr.Zero) && written == bytes.Length;
    }

    /// SID of the process on the other end of the pipe, or null.
    public static string ClientSid(IntPtr pipe)
    {
        uint pid;
        if (!GetNamedPipeClientProcessId(pipe, out pid)) return null;
        IntPtr proc = OpenProcess(0x1000, false, pid);          // PROCESS_QUERY_LIMITED_INFORMATION
        if (proc == IntPtr.Zero) return null;
        try
        {
            IntPtr token;
            if (!OpenProcessToken(proc, 0x0008, out token)) return null;   // TOKEN_QUERY
            try { return new WindowsIdentity(token).User.Value; } finally { CloseHandle(token); }
        }
        finally { CloseHandle(proc); }
    }

    /// Runs a command line in the active console session as the signed-in user.
    /// 0 = ok, 1 = no user session, 2 = session belongs to another SID, 3 = failed or timed out.
    public static int RunInUserSession(string cmd, string expectedSid, int timeoutMs, out string output)
    {
        output = "";
        uint session = WTSGetActiveConsoleSessionId();
        if (session == 0xFFFFFFFF) return 1;
        IntPtr token;
        if (!WTSQueryUserToken(session, out token)) return 1;
        IntPtr env = IntPtr.Zero, rd = IntPtr.Zero, wr = IntPtr.Zero, nul = new IntPtr(-1);
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        try
        {
            if (new WindowsIdentity(token).User.Value != expectedSid) return 2;
            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            sa.bInheritHandle = 1;
            if (!CreatePipe(out rd, out wr, ref sa, 0)) return 3;
            SetHandleInformation(rd, 1, 0);                     // The read end is not inherited.
            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.dwFlags = 0x101;                                 // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
            // STARTF_USESTDHANDLES needs three valid inheritable handles: NUL for stdin, the pipe for stdout and stderr.
            nul = CreateFile("NUL", 0x80000000 /* GENERIC_READ */, 3 /* FILE_SHARE_READ | FILE_SHARE_WRITE */, ref sa, 3 /* OPEN_EXISTING */, 0, IntPtr.Zero);
            if (nul == new IntPtr(-1)) return 3;
            si.hStdInput = nul; si.hStdOutput = wr; si.hStdError = wr;
            si.lpDesktop = "winsta0\\default";
            // Fail closed: without the user's environment wsl.exe may resolve a different profile.
            if (!CreateEnvironmentBlock(out env, token, false)) { env = IntPtr.Zero; return 3; }
            // CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
            if (!CreateProcessAsUser(token, null, cmd, IntPtr.Zero, IntPtr.Zero, true, 0x08000400, env, null, ref si, out pi)) return 3;
            CloseHandle(wr); wr = IntPtr.Zero;
            // Reads on a worker thread so a hung child cannot block the helper.
            MemoryStream data = new MemoryStream();
            IntPtr reader = rd;
            Thread t = new Thread(delegate() {
                byte[] buf = new byte[512]; int n;
                while (ReadFile(reader, buf, buf.Length, out n, IntPtr.Zero) && n > 0) { lock (data) { if (data.Length < 4096) data.Write(buf, 0, n); } }
            });
            t.IsBackground = true; t.Start();
            if (WaitForSingleObject(pi.hProcess, (uint)timeoutMs) != 0) { TerminateProcess(pi.hProcess, 1); return 3; }
            t.Join(1000);
            lock (data) { output = Encoding.UTF8.GetString(data.ToArray()).Replace("\0", ""); }
            return 0;
        }
        finally
        {
            if (wr != IntPtr.Zero) CloseHandle(wr);
            if (rd != IntPtr.Zero) CloseHandle(rd);
            if (nul != new IntPtr(-1)) CloseHandle(nul);
            if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            CloseHandle(token);
        }
    }
}
'@

function Write-NetdAudit {
    param([string]$Op, $Port, [string]$Result)
    try {
        if ((Test-Path $script:AuditPath) -and ((Get-Item $script:AuditPath).Length -gt $script:AuditMaxBytes)) {
            Move-Item -Force $script:AuditPath ($script:AuditPath + '.1')
        }
        $line = '{0} op={1} port={2} result={3}' -f (Get-Date).ToUniversalTime().ToString('o'), $Op, $Port, $Result
        Add-Content -Path $script:AuditPath -Value $line -Encoding UTF8
    } catch { }
}

function Read-NetdConfig {
    $cfg = Get-Content -Raw -Path $script:ConfigPath | ConvertFrom-Json
    if ($cfg.distro -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw 'invalid distro in config' }
    if ($cfg.userSid -notmatch '^S-1-[0-9-]{1,120}$') { throw 'invalid userSid in config' }
    return $cfg
}

function Read-NetdState {
    if (-not (Test-Path $script:StatePath)) { return [pscustomobject]@{ v = 1; rules = @() } }
    $state = Get-Content -Raw -Path $script:StatePath | ConvertFrom-Json
    if ($null -eq $state.rules) { $state | Add-Member -NotePropertyName rules -NotePropertyValue @() -Force }
    $state.rules = @($state.rules)
    return $state
}

function Save-NetdState {
    param($State)
    $tmp = $script:StatePath + '.tmp'
    ($State | ConvertTo-Json -Depth 5) | Set-Content -Path $tmp -Encoding UTF8
    Move-Item -Force $tmp $script:StatePath
}

function Test-NetdRateLimit {
    $now = [long]([DateTime]::UtcNow.Ticks / 10000)
    $script:RateTimes.RemoveAll([Predicate[long]]{ param($t) $t -lt ($now - $script:RateWindowMs) }) | Out-Null
    if ($script:RateTimes.Count -ge $script:RateMax) { return $false }
    $script:RateTimes.Add($now)
    return $true
}

function Get-NetdWslIp {
    # Returns @{ code; ip }. Runs wsl.exe as the signed-in user; the distro comes from the config.
    param($Config)
    $cmd = '"{0}\System32\wsl.exe" -d "{1}" hostname -I' -f $env:SystemRoot, $Config.distro
    $out = ''
    $status = [NetdNative]::RunInUserSession($cmd, $Config.userSid, 8000, [ref]$out)
    if ($status -eq 1 -or $status -eq 2) { return @{ code = 'no_user_session'; ip = $null } }
    if ($status -ne 0) { return @{ code = 'wsl_unavailable'; ip = $null } }
    foreach ($token in ($out -split '\s+')) {
        if ($token -match '^(\d{1,3})(\.\d{1,3}){3}$') {
            $ip = $null
            if ([System.Net.IPAddress]::TryParse($token, [ref]$ip) -and $token -notmatch '^(127\.|0\.)') { return @{ code = $null; ip = $token } }
        }
    }
    return @{ code = 'wsl_unavailable'; ip = $null }
}

function Get-NetdPortproxy {
    $rows = @()
    foreach ($line in (& netsh.exe interface portproxy show v4tov4)) {
        if ($line -match '^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$') {
            $rows += @{ listenAddress = $Matches[1]; listenPort = [int]$Matches[2]; connectAddress = $Matches[3]; connectPort = [int]$Matches[4] }
        }
    }
    return $rows
}

function Find-NetdEntry {
    param($State, [int]$Port)
    return @($State.rules) | Where-Object { [int]$_.port -eq $Port } | Select-Object -First 1
}

function Get-NetdObservedProxy {
    param([int]$Port)
    return Get-NetdPortproxy | Where-Object { $_.listenPort -eq $Port -and $_.listenAddress -eq '0.0.0.0' } | Select-Object -First 1
}

function Test-NetdForeignConflict {
    # True when an object we would create or replace exists but the ledger does
    # not prove it is ours. Such objects are never deleted or overwritten.
    param([int]$Port, $Config, $Entry)
    if ($Config.mode -eq 'mirrored') {
        $name = if (Test-NetdEntryHasField $Entry 'hyperVName') { [string]$Entry.hyperVName } else { '' }
        $sameDisplay = @(Get-NetFirewallHyperVRule -DisplayName "$($script:NetdRulePrefix) $Port" -ErrorAction SilentlyContinue)
        foreach ($rule in $sameDisplay) { if ($rule.Name -cne $name) { return $true } }
        if (-not $name) { return $false }
        $facts = Get-NetdHyperVFacts -Name $name
        if (-not $facts) { return [bool](Get-NetFirewallHyperVRule -Name $name -ErrorAction SilentlyContinue) }
        # An existing rule is ours only if it is recorded and its live spec still matches.
        return -not ((Test-NetdEntryHasField $Entry 'hyperVName') -and $Entry.hyperVName -ceq $name -and (Test-NetdHyperVRuleOwned -Facts $facts -Port $Port -Name $name -Token ([string]$Entry.hyperVToken)))
    }
    $proxy = Get-NetdObservedProxy -Port $Port
    if ($proxy -and -not (Test-NetdProxyOwned -Entry $Entry -Observed $proxy)) { return $true }
    $recorded = if (Test-NetdEntryHasField $Entry 'firewallName') { [string]$Entry.firewallName } else { '' }
    $sameDisplay = @(Get-NetFirewallRule -DisplayName "$($script:NetdRulePrefix) $Port" -ErrorAction SilentlyContinue)
    foreach ($rule in $sameDisplay) { if ($rule.Name -cne $recorded) { return $true } }
    # The recorded Name alone is not proof: the live rule must still match the recorded spec.
    if ($recorded) {
        $facts = Get-NetdFirewallFacts -Name $recorded
        if ((Get-NetFirewallRule -Name $recorded -ErrorAction SilentlyContinue) -and
            -not (Test-NetdFirewallRuleOwned -Facts $facts -Port $Port -Name $recorded -Token ([string]$Entry.firewallToken))) { return $true }
    }
    return $false
}

function Remove-NetdOwnedObjects {
    # Removes only what the ledger entry records, and a portproxy only while it still matches it.
    # Returns the names of recorded objects that were left in place.
    param($Entry, $Config)
    $kept = @()
    $port = [int]$Entry.port
    if (Test-NetdEntryHasField $Entry 'hyperVName') {
        $facts = Get-NetdHyperVFacts -Name $Entry.hyperVName
        if (Test-NetdHyperVRuleOwned -Facts $facts -Port $port -Name $Entry.hyperVName -Token ([string]$Entry.hyperVToken)) { Remove-NetFirewallHyperVRule -Name $Entry.hyperVName -ErrorAction SilentlyContinue }
        elseif ($facts) { $kept += 'hyperv-rule' }
    }
    if (Test-NetdEntryHasField $Entry 'firewallName') {
        $facts = Get-NetdFirewallFacts -Name $Entry.firewallName
        if (Test-NetdFirewallRuleOwned -Facts $facts -Port $port -Name $Entry.firewallName -Token ([string]$Entry.firewallToken)) { Remove-NetFirewallRule -Name $Entry.firewallName -ErrorAction SilentlyContinue }
        elseif ($facts) { $kept += 'firewall-rule' }
    }
    if (Test-NetdEntryHasField $Entry 'proxy') {
        $observed = Get-NetdObservedProxy -Port ([int]$Entry.port)
        if ($observed -and (Test-NetdProxyOwned -Entry $Entry -Observed $observed)) {
            & netsh.exe interface portproxy delete v4tov4 listenport=$([int]$Entry.port) listenaddress=0.0.0.0 | Out-Null
        } elseif ($observed) { $kept += 'portproxy' }
    }
    return $kept
}

function New-NetdPortObjects {
    # Creates the rules for a port and returns the ledger entry that proves ownership.
    # The caller has already ruled out foreign conflicts.
    param([int]$Port, $Config, [string]$Ip, $Previous)
    if ($null -ne $Previous) { Remove-NetdOwnedObjects -Entry $Previous -Config $Config | Out-Null }
    $created = (Get-Date).ToUniversalTime().ToString('o')
    if ($Config.mode -eq 'mirrored') {
        $token = New-NetdRuleToken -Port $Port
        $spec = Get-NetdHyperVFirewallSpec -Port $Port -Token $token
        New-NetFirewallHyperVRule @spec | Out-Null
        return [pscustomobject]@{ port = $Port; mode = 'mirrored'; createdAt = $created; hyperVName = $spec.Name; hyperVToken = $token }
    }
    & netsh.exe interface portproxy add v4tov4 listenport=$Port listenaddress=0.0.0.0 connectport=$Port connectaddress=$Ip | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'portproxy add failed' }
    $token = New-NetdRuleToken -Port $Port
    $fw = Get-NetdFirewallSpec -Port $Port -Name (New-NetdFirewallRuleName -Port $Port) -Token $token
    try { New-NetFirewallRule @fw | Out-Null }
    catch {
        & netsh.exe interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 | Out-Null
        throw
    }
    return [pscustomobject]@{
        port = $Port; mode = 'nat'; createdAt = $created
        proxy = [pscustomobject]@{ listenAddress = '0.0.0.0'; connectAddress = $Ip; connectPort = $Port }
        firewallName = $fw.Name; firewallToken = $token
    }
}

function Set-NetdEntry {
    param($State, $Entry)
    $State.rules = @(@($State.rules) | Where-Object { [int]$_.port -ne [int]$Entry.port }) + $Entry
    Save-NetdState $State
}

function Invoke-NetdReconcile {
    # Touches only ports present in the state file, and only objects the entry still
    # matches. Returns an error code or $null.
    param($Config)
    $state = Read-NetdState
    if (-not @($state.rules).Count) { return $null }
    $ip = $null
    if ($Config.mode -ne 'mirrored') {
        $target = Get-NetdWslIp -Config $Config
        if ($target.code) { return $target.code }
        $ip = $target.ip
    }
    foreach ($entry in @($state.rules)) {
        $port = [int]$entry.port
        if (Test-NetdPortAllowed -Port $port -Config $Config) { continue }
        if ($Config.mode -eq 'mirrored') {
            if (-not (Test-NetdEntryHasField $entry 'hyperVName')) { continue }
            $hv = Get-NetdHyperVFacts -Name $entry.hyperVName
            if ($hv -and -not (Test-NetdHyperVRuleOwned -Facts $hv -Port $port -Name $entry.hyperVName -Token ([string]$entry.hyperVToken)) {
                Write-NetdAudit -Op 'reconcile' -Port $port -Result 'port_in_use_foreign'
                continue
            }
            if (-not $hv) {
                Set-NetdEntry $state (New-NetdPortObjects -Port $port -Config $Config -Ip $null -Previous $null)
            }
            continue
        }
        if (-not (Test-NetdEntryHasField $entry 'proxy')) { continue }
        $observed = Get-NetdObservedProxy -Port $port
        # A proxy on this port that no longer matches the ledger belongs to someone else now.
        if ($observed -and -not (Test-NetdProxyOwned -Entry $entry -Observed $observed)) {
            Write-NetdAudit -Op 'reconcile' -Port $port -Result 'port_in_use_foreign'
            continue
        }
        $fwFacts = if (Test-NetdEntryHasField $entry 'firewallName') { Get-NetdFirewallFacts -Name $entry.firewallName } else { $null }
        # A rule under the recorded Name whose live spec differs is foreign: leave it alone.
        if ($fwFacts -and -not (Test-NetdFirewallRuleOwned -Facts $fwFacts -Port $port -Name $entry.firewallName -Token ([string]$entry.firewallToken)) {
            Write-NetdAudit -Op 'reconcile' -Port $port -Result 'port_in_use_foreign'
            continue
        }
        $fwPresent = [bool]$fwFacts
        if (-not $observed -or $observed.connectAddress -ne $ip -or -not $fwPresent) {
            Set-NetdEntry $state (New-NetdPortObjects -Port $port -Config $Config -Ip $ip -Previous $entry)
        }
    }
    return $null
}

function Invoke-NetdOp {
    param($Request, $Config)
    $fail = { param($c) return @{ ok = $false; code = $c } }
    switch ($Request.op) {
        'status' {
            $state = Read-NetdState
            return @{ ok = $true; data = @{ version = 1; mode = $Config.mode; rules = @($state.rules).Count; userSid = $Config.userSid } }
        }
        'list' {
            $state = Read-NetdState
            $proxy = @()
            $firewall = @()
            foreach ($e in @($state.rules)) {
                $p = [int]$e.port
                if ($Config.mode -ne 'mirrored') {
                    $observed = Get-NetdObservedProxy -Port $p
                    if ($observed -and (Test-NetdProxyOwned -Entry $e -Observed $observed)) { $proxy += $observed }
                }
                $present = if (Test-NetdEntryHasField $e 'hyperVName') { Get-NetFirewallHyperVRule -Name $e.hyperVName -ErrorAction SilentlyContinue }
                    elseif (Test-NetdEntryHasField $e 'firewallName') { Get-NetFirewallRule -Name $e.firewallName -ErrorAction SilentlyContinue }
                    else { $null }
                if ($present) { $firewall += $p }
            }
            return @{ ok = $true; data = @{ portproxy = $proxy; firewall = $firewall } }
        }
        'expose' {
            $port = [int]$Request.port
            $state = Read-NetdState
            $previous = Find-NetdEntry -State $state -Port $port
            # Refuse instead of overwriting anything the ledger does not prove is ours.
            if (Test-NetdForeignConflict -Port $port -Config $Config -Entry $previous) { return (& $fail 'port_in_use_foreign') }
            $ip = $null
            if ($Config.mode -ne 'mirrored') {
                $target = Get-NetdWslIp -Config $Config
                if ($target.code) { return (& $fail $target.code) }
                $ip = $target.ip
            }
            $entry = New-NetdPortObjects -Port $port -Config $Config -Ip $ip -Previous $previous
            try { Set-NetdEntry $state $entry }
            catch {
                Remove-NetdOwnedObjects -Entry $entry -Config $Config | Out-Null
                throw
            }
            return @{ ok = $true; data = @{ port = $port; targetIp = $ip } }
        }
        'close' {
            $port = [int]$Request.port
            $state = Read-NetdState
            # Only rules recorded in the state file may be removed.
            $entry = Find-NetdEntry -State $state -Port $port
            if (-not $entry) { return (& $fail 'not_in_state') }
            $kept = @(Remove-NetdOwnedObjects -Entry $entry -Config $Config)
            $state.rules = @(@($state.rules) | Where-Object { [int]$_.port -ne $port })
            Save-NetdState $state
            return @{ ok = $true; data = @{ port = $port; kept = $kept } }
        }
        'reconcile' {
            $code = Invoke-NetdReconcile -Config $Config
            if ($code) { return (& $fail $code) }
            return @{ ok = $true; data = @{} }
        }
    }
    return (& $fail 'unknown_op')
}

function Handle-NetdConnection {
    param([IntPtr]$Pipe, $Config)
    $id = $null
    $op = '-'
    $port = '-'
    $reply = $null
    try {
        $sid = [NetdNative]::ClientSid($Pipe)
        if (-not $sid -or $sid -cne $Config.userSid) {
            $reply = @{ v = 1; id = $null; ok = $false; code = 'client_untrusted' }
            Write-NetdAudit -Op $op -Port $port -Result 'client_untrusted'
            return
        }
        $line = $null
        $read = [NetdNative]::ReadLine($Pipe, $script:NetdMaxRequestBytes, $script:ReadTimeoutMs, [ref]$line)
        if ($read -eq 1) { $reply = @{ v = 1; id = $null; ok = $false; code = 'too_large' }; return }
        if ($read -ne 0) { $reply = @{ v = 1; id = $null; ok = $false; code = 'read_timeout' }; return }
        $checked = Test-NetdRequest -Text $line -Config $Config
        if (-not $checked.ok) { $reply = @{ v = 1; id = $null; ok = $false; code = $checked.code }; Write-NetdAudit -Op $op -Port $port -Result $checked.code; return }
        $request = $checked.request
        $id = $request.id
        $op = $request.op
        if ($request.PSObject.Properties['port']) { $port = $request.port }
        if (-not (Test-NetdRateLimit)) { $reply = @{ v = 1; id = $id; ok = $false; code = 'rate_limited' }; return }
        $result = Invoke-NetdOp -Request $request -Config $Config
        $reply = @{ v = 1; id = $id; ok = [bool]$result.ok }
        if ($result.ok) { $reply.data = $result.data } else { $reply.code = $result.code }
        Write-NetdAudit -Op $op -Port $port -Result $(if ($result.ok) { 'ok' } else { $result.code })
    } catch {
        $reply = @{ v = 1; id = $id; ok = $false; code = 'internal' }
        Write-NetdAudit -Op $op -Port $port -Result 'internal'
    } finally {
        if ($reply) { [NetdNative]::WriteLine($Pipe, ($reply | ConvertTo-Json -Compress -Depth 6)) | Out-Null }
        [NetdNative]::FlushFileBuffers($Pipe) | Out-Null
        [NetdNative]::DisconnectNamedPipe($Pipe) | Out-Null
    }
}

function Start-NetdServer {
    $config = Read-NetdConfig
    $sddl = Get-NetdPipeSddl -UserSid $config.userSid
    $rsd = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)
    $sdBytes = New-Object byte[] $rsd.BinaryLength
    $rsd.GetBinaryForm($sdBytes, 0)
    $sdPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($sdBytes.Length)
    [System.Runtime.InteropServices.Marshal]::Copy($sdBytes, 0, $sdPtr, $sdBytes.Length)
    $sa = New-Object NetdNative+SECURITY_ATTRIBUTES
    $sa.nLength = [System.Runtime.InteropServices.Marshal]::SizeOf($sa)
    $sa.lpSecurityDescriptor = $sdPtr
    $sa.bInheritHandle = 0
    $pipeMode = $PIPE_TYPE_BYTE -bor $PIPE_READMODE_BYTE -bor $PIPE_WAIT -bor $PIPE_REJECT_REMOTE_CLIENTS
    $pipe = [NetdNative]::CreateNamedPipe($script:NetdPipePath, ($PIPE_ACCESS_DUPLEX -bor $FILE_FLAG_FIRST_PIPE_INSTANCE),
        $pipeMode, $NETD_MAX_INSTANCES, 4096, 4096, 0, [ref]$sa)
    if ($pipe.ToInt64() -eq -1) {
        Write-NetdAudit -Op 'start' -Port '-' -Result ('pipe_create_failed_' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
        exit 1
    }
    Write-NetdAudit -Op 'start' -Port '-' -Result 'ok'
    $tickMs = $script:ReconcileIntervalMs
    while ($true) {
        $status = [NetdNative]::Connect($pipe, $tickMs)
        if ($status -eq 0) { Handle-NetdConnection -Pipe $pipe -Config $config; continue }
        if ($status -eq 2) { Start-Sleep -Milliseconds 500; continue }
        try {
            $code = Invoke-NetdReconcile -Config $config
            # Retry quickly while nobody is signed in so rules heal soon after logon.
            $tickMs = if ($code -eq 'no_user_session') { $script:ReconcileRetryMs } else { $script:ReconcileIntervalMs }
            if ($code -and $code -ne 'no_user_session') { Write-NetdAudit -Op 'reconcile' -Port '-' -Result $code }
        } catch { Write-NetdAudit -Op 'reconcile' -Port '-' -Result 'internal' }
    }
}

# Dot-sourcing (tests, review) loads the functions without starting the server.
if ($MyInvocation.InvocationName -ne '.') { Start-NetdServer }
