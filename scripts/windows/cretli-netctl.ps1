# cretli-netctl: unprivileged client of the cretli-netd pipe.
#
# Called from WSL through interop:
#   powershell.exe -NoProfile -NonInteractive -File <netd dir>\cretli-netctl.ps1 -Op <op> [-Port <n>]
# Validates its arguments, builds the JSON request itself, verifies that the pipe
# server really is the SYSTEM helper on the very handle it sends the request on,
# and prints exactly one JSON line: { v, id, ok, code?, data? }.

param(
    [Parameter(Mandatory)][string]$Op,
    [int]$Port = 0
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'cretli-netd-common.ps1')

$script:ConnectTimeoutMs = 5000
$script:ResponseTimeoutMs = 30000
$script:MaxResponseBytes = 65536

# Requested rights come from the one shared constant (the same mask the server DACL grants).
# GENERIC_READ | GENERIC_WRITE would expand to rights the DACL withholds and fail with access denied.
$PIPE_DESIRED_ACCESS = $script:PipeUserAccess
$OPEN_EXISTING = 3
# Anonymous-level identification only: the server cannot impersonate this client.
$SECURITY_SQOS_PRESENT = 0x00100000
$SECURITY_IDENTIFICATION = 0x00010000

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class NetctlNative
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool WaitNamedPipe(string name, uint timeoutMs);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ReadFile(IntPtr h, byte[] buf, int n, out int read, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool WriteFile(IntPtr h, byte[] buf, int n, out int written, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CancelIoEx(IntPtr h, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeServerProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool QueryFullProcessImageName(IntPtr proc, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern uint GetSecurityInfo(IntPtr h, int objectType, uint info, out IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr sd);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ConvertSidToStringSid(IntPtr sid, out string text);

    public const int ERROR_FILE_NOT_FOUND = 2;
    public const int ERROR_ACCESS_DENIED = 5;
    public const int ERROR_PIPE_BUSY = 231;

    /// Owner SID of the pipe object, read from the open handle. Null and an error text on failure.
    public static string OwnerSid(IntPtr h, out string error)
    {
        error = null;
        IntPtr owner, sd;
        uint rc = GetSecurityInfo(h, 6 /* SE_KERNEL_OBJECT */, 1 /* OWNER_SECURITY_INFORMATION */, out owner, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);
        if (rc != 0) { error = "GetSecurityInfo " + rc; return null; }
        try
        {
            string sid;
            if (!ConvertSidToStringSid(owner, out sid)) { error = "ConvertSidToStringSid"; return null; }
            return sid;
        }
        finally { if (sd != IntPtr.Zero) LocalFree(sd); }
    }

    /// Image path of the process serving the pipe. Null and an error text on failure.
    public static string ServerImage(IntPtr h, out string error)
    {
        error = null;
        uint pid;
        if (!GetNamedPipeServerProcessId(h, out pid)) { error = "GetNamedPipeServerProcessId"; return null; }
        IntPtr proc = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (proc == IntPtr.Zero) { error = "OpenProcess"; return null; }
        try
        {
            StringBuilder sb = new StringBuilder(1024);
            uint size = (uint)sb.Capacity;
            if (!QueryFullProcessImageName(proc, 0, sb, ref size)) { error = "QueryFullProcessImageName"; return null; }
            return sb.ToString();
        }
        finally { CloseHandle(proc); }
    }

    public static bool WriteAll(IntPtr h, string text)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        int written;
        return WriteFile(h, bytes, bytes.Length, out written, IntPtr.Zero) && written == bytes.Length;
    }

    /// Reads one response line. Null on timeout, I/O error or oversize.
    public static string ReadLine(IntPtr h, int maxBytes, int timeoutMs)
    {
        bool active = true;
        Timer timer = new Timer(delegate(object o) { if (active) CancelIoEx(h, IntPtr.Zero); }, null, timeoutMs, Timeout.Infinite);
        MemoryStream data = new MemoryStream();
        byte[] buf = new byte[1024];
        try
        {
            while (true)
            {
                int n;
                if (!ReadFile(h, buf, buf.Length, out n, IntPtr.Zero) || n == 0) return data.Length > 0 ? Encoding.UTF8.GetString(data.ToArray()).TrimEnd('\r', '\n') : null;
                int nl = Array.IndexOf(buf, (byte)10, 0, n);
                data.Write(buf, 0, nl >= 0 ? nl : n);
                if (data.Length > maxBytes) return null;
                if (nl >= 0) return Encoding.UTF8.GetString(data.ToArray()).TrimEnd('\r');
            }
        }
        finally { active = false; timer.Dispose(); }
    }
}
'@

function Write-NetctlResult {
    param([bool]$Ok, [string]$Code, $Data, [string]$Id)
    $obj = [ordered]@{ v = 1; id = $Id; ok = $Ok }
    if ($Code) { $obj.code = $Code }
    if ($null -ne $Data) { $obj.data = $Data }
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
}

function Invoke-Netctl {
    $id = [guid]::NewGuid().ToString()
    if ($script:NetdOps -cnotcontains $Op) { Write-NetctlResult $false 'unknown_op' $null $id; return 2 }
    $request = [ordered]@{ v = $script:NetdProtocolVersion; id = $id; op = $Op }
    $needsPort = $script:NetdPortOps -ccontains $Op
    if ($needsPort) {
        if ($Port -lt 1 -or $Port -gt 65535) { Write-NetctlResult $false 'bad_port' $null $id; return 2 }
        $request.port = $Port
    } elseif ($PSBoundParameters.ContainsKey('Port')) { Write-NetctlResult $false 'unknown_field' $null $id; return 2 }
    $json = $request | ConvertTo-Json -Compress

    # Connect: ERROR_PIPE_BUSY means the single instance serves someone else; wait and retry
    # inside the overall connection budget, then report helper_busy.
    $deadline = [DateTime]::UtcNow.AddMilliseconds($script:ConnectTimeoutMs)
    $handle = [IntPtr](-1)
    while ($true) {
        $handle = [NetctlNative]::CreateFile($script:NetdPipePath, $PIPE_DESIRED_ACCESS, 0, [IntPtr]::Zero, $OPEN_EXISTING,
            ($SECURITY_SQOS_PRESENT -bor $SECURITY_IDENTIFICATION), [IntPtr]::Zero)
        if ($handle.ToInt64() -ne -1) { break }
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($err -eq [NetctlNative]::ERROR_FILE_NOT_FOUND) { Write-NetctlResult $false 'helper_unavailable' $null $id; return 1 }
        if ($err -eq [NetctlNative]::ERROR_ACCESS_DENIED) { Write-NetctlResult $false 'client_untrusted' $null $id; return 1 }
        if ($err -ne [NetctlNative]::ERROR_PIPE_BUSY) { Write-NetctlResult $false 'helper_unavailable' $null $id; return 1 }
        $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
        if ($remaining -le 0) { Write-NetctlResult $false 'helper_busy' $null $id; return 1 }
        [NetctlNative]::WaitNamedPipe($script:NetdPipePath, [uint32]$remaining) | Out-Null
    }
    try {
        # Verify the server on this very handle, before anything is sent (no TOCTOU).
        $ownerError = $null
        $imageError = $null
        $owner = [NetctlNative]::OwnerSid($handle, [ref]$ownerError)
        $image = [NetctlNative]::ServerImage($handle, [ref]$imageError)
        $errorText = if ($ownerError) { $ownerError } elseif ($imageError) { $imageError } else { $null }
        if (-not (Test-NetdServerIdentity -OwnerSid $owner -ImagePath $image -SystemRoot $env:SystemRoot -ErrorText $errorText)) {
            Write-NetctlResult $false 'server_untrusted' $null $id
            return 1
        }
        if (-not [NetctlNative]::WriteAll($handle, $json + "`n")) { Write-NetctlResult $false 'helper_unavailable' $null $id; return 1 }
        $line = [NetctlNative]::ReadLine($handle, $script:MaxResponseBytes, $script:ResponseTimeoutMs)
        if (-not $line) { Write-NetctlResult $false 'response_timeout' $null $id; return 1 }
        [Console]::Out.WriteLine($line)
        $parsed = $null
        try { $parsed = $line | ConvertFrom-Json } catch { }
        return $(if ($parsed -and $parsed.ok) { 0 } else { 1 })
    } finally { [NetctlNative]::CloseHandle($handle) | Out-Null }
}

exit (Invoke-Netctl)
