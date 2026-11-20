import { isIP } from 'node:net';

export const DEBUG_PORTS = [9222, 9229, 9230, 5858, 6006];

export function classifyIssues({ platform, networkingMode, listeners, portproxy, wslAddresses, availability }) {
  const issues = [];
  const add = (code, level, description, command = null, needsAdmin = false, needsWslRestart = false) =>
    issues.push({ code, level, description, command, needsAdmin, needsWslRestart });
  for (const listener of listeners) {
    if (['127.0.0.1', '::1'].includes(listener.address)) {
      add('loopback-only', 'info', `Port ${listener.port} listens only on loopback.`, `ss -ltnp 'sport = :${listener.port}'`);
    }
  }
  if (platform !== 'wsl2') return issues;
  const nat = networkingMode === 'nat';
  for (const rule of portproxy) {
    const remove = `netsh interface portproxy delete ${isIP(rule.listenAddress) === 6 ? 'v6' : 'v4'}to${isIP(rule.connectAddress) === 6 ? 'v6' : 'v4'} listenaddress=${rule.listenAddress} listenport=${rule.listenPort}`;
    if (rule.listenAddress === '0.0.0.0' && (DEBUG_PORTS.includes(rule.listenPort) || DEBUG_PORTS.includes(rule.connectPort))) {
      add('unsafe-debug-proxy', 'error', `Port ${rule.listenPort} exposes a debugger to the local network.`, remove, true);
    }
    // A foreign destination may belong to another host; only current WSL IPs
    // and stale NAT destinations can be checked against local listeners.
    const current = wslAddresses.includes(rule.connectAddress);
    if (nat && availability.wslAddresses && !current && !['127.0.0.1', '::1'].includes(rule.connectAddress)) {
      add('stale-wsl-address', 'warning', `Proxy port ${rule.listenPort} targets an address different from the current WSL addresses.`, remove, true);
    } else if ((current || ['127.0.0.1', '::1'].includes(rule.connectAddress)) && availability.listeners &&
      !listeners.some((l) => l.port === rule.connectPort && (l.address === rule.connectAddress || l.address === '0.0.0.0' || l.address === '::'))) {
      add('dead-proxy', 'warning', `Proxy port ${rule.listenPort} has no matching listener on destination port ${rule.connectPort}.`, remove, true);
    }
  }
  if (nat && availability.portproxy && availability.wslAddresses) {
    for (const l of listeners.filter((l) => l.address === '0.0.0.0')) {
      if (!portproxy.some((r) => r.connectPort === l.port && wslAddresses.includes(r.connectAddress) && !['127.0.0.1', '::1'].includes(r.listenAddress))) {
        add('missing-proxy', 'warning', `Port ${l.port} listens on all IPv4 addresses but has no current Windows forwarding rule; LAN reachability is not configured.`,
          DEBUG_PORTS.includes(l.port) ? `ss -ltnp 'sport = :${l.port}'` : `netsh interface portproxy add v4tov4 listenaddress=<WINDOWS_LAN_IP> listenport=${l.port} connectaddress=${wslAddresses.find((address) => isIP(address) === 4) || '<WSL_IPV4>'} connectport=${l.port}`, true);
      }
    }
  }
  if (nat) add('recommend-mirrored', 'info', 'Consider networkingMode=mirrored in [wsl2] in .wslconfig. Restarting with wsl --shutdown stops all distributions and may interrupt Docker. Check Windows/WSL support and firewall policy first.',
    'Set-NetFirewallHyperVVMSetting -Name "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}" -DefaultInboundAction Block\nNew-NetFirewallHyperVRule -Name "Cretli" -DisplayName "Cretli" -Direction Inbound -VMCreatorId "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}" -Protocol TCP -LocalPorts 3011\nwsl --shutdown', true, true);
  return issues;
}
