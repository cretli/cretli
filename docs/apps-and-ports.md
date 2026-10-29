# Apps and ports

## Diagnostics

`GET /api/net-env` returns a read-only snapshot of the Cretli host's network
configuration. A Cretli login session is required (401 without authentication).
No administrator privileges are needed for collection. No configuration, firewall
rule, forwarding rule or running application is changed. Suggestions are text
for an operator to review and execute manually.

The server caches the report for 15 seconds. `?refresh=1` bypasses that cache;
concurrent collection requests share the in-flight snapshot. Responses use
`Cache-Control: no-store` because they contain host addresses and process names.
Each external command has a 1500 ms timeout, including Windows interop commands.
A failed or timed-out probe produces a partial report with a reason instead of
failing the request. Sequential probe stages can each consume their timeout.

### Response schema (version 1)

The response is the report object itself:

| Field | Type / meaning |
| --- | --- |
| `schemaVersion` | Integer, currently `1` |
| `collectedAt` | ISO 8601 UTC timestamp |
| `platform` | `linux`, `wsl2`, `windows`, `macos`, or `unknown` |
| `partial` | Boolean; true if any probe failed or is unsupported |
| `reasons` | Array of `{ source, code, description }` strings; e.g. `interop` / `ENOENT` or `ETIMEDOUT` |
| `availability` | Boolean fields: `listeners`, `portproxy`, `wslAddresses`, `wslConfig`, `interop`. False also means not applicable on this platform. |
| `networkingMode` | `nat`, `mirrored`, `virtioproxy`, `none`, or null when unknown / not WSL |
| `wslAddresses` | Array of current IP address strings from `hostname -I` |
| `wslConfig` | Null if absent/unreadable/not applicable; otherwise object with optional `networkingMode` (string), `localhostForwarding` and `firewall` (boolean or null for invalid values) |
| `listeners` | Array of `{ address: string, port: number, pid: number or null, command: string or null }` |
| `portproxy` | Array of `{ listenAddress: string, listenPort: number, connectAddress: string, connectPort: number }` |
| `cretli` | `{ lanHost: string or null, bind: string, lanExposed: boolean }`, using the existing LAN host, bind and auth configuration helpers |
| `issues` | Array of `{ code, level, description, command, needsAdmin, needsWslRestart }`; level is `info`, `warning`, or `error`; command is a suggested command/template or null; flags are booleans |

Linux listeners come from `ss -ltnpH`. If ownership is omitted, a best-effort
read of `/proc/net/tcp` and accessible `/proc/<pid>/fd` entries resolves socket
owners. Permissions and process exits can leave `pid` and `command` null. Process command lines and arguments
are not collected.

WSL2 is identified from the Linux kernel release. Its live networking mode comes
from `wslinfo --networking-mode`; `.wslconfig` is reported separately because a
saved setting may not yet be active. The Windows profile path is read using
`cmd.exe /d /c echo %USERPROFILE%`, converted using `wslpath`, then the optional
`.wslconfig` is read. `powershell.exe` checks interop availability;
`netsh.exe interface portproxy show all` supplies forwarding rules. Missing
interop leaves Linux diagnostics available, with an explicit partial reason.
Native Linux never invokes Windows tools. Windows and macOS hosts are identified,
but listener collection on those hosts is currently unsupported and reported as
partial; they are not mistaken for empty, healthy Linux snapshots.

### Findings and suggestions

- `dead-proxy`: a current local destination has no matching listener. Remove the
  obsolete forwarding rule or start the intended application.
- `stale-wsl-address`: a NAT forwarding destination differs from all current WSL
  addresses. This is a suspected stale rule; it may intentionally target another
  host. Review before removing it.
- `missing-proxy`: an IPv4 wildcard listener in NAT mode has no rule targeting its
  current WSL address. Review a forwarding rule bound to a specific Windows LAN
  address. This is a configuration heuristic, not an end-to-end reachability
  test; external routers, firewalls and other forwarding mechanisms are unknown.
- `loopback-only`: informational finding for `127.0.0.1` / `::1` listeners.
- `unsafe-debug-proxy`: a wildcard Windows forwarding rule exposes a known debug
  source or destination port (9222, 9229, 9230, 5858 or 6006). The suggestion removes that rule. Debug
  ports must remain restricted to loopback; no wildcard forwarding is suggested.
- `recommend-mirrored`: in NAT mode, consider `networkingMode=mirrored` in the
  `[wsl2]` section of `.wslconfig` on supported Windows/WSL versions. The suggested
  Hyper-V commands keep default inbound traffic blocked and add a TCP exception
  for Cretli's default port 3011; adjust that port to your configuration. These
  commands need an administrator PowerShell. `wsl --shutdown` applies the WSL
  setting but stops all distributions and can interrupt Docker workloads.

Unavailable probes suppress findings that need their evidence. Mirrored mode
does not produce NAT missing-rule or migration suggestions. Firewall reachability
is not tested, and the report does not claim that a port is reachable from LAN.
For example, fixture addresses `192.0.2.2` (WSL) and `198.51.100.2` (Windows LAN)
are documentation addresses, not values to use on a real host.
