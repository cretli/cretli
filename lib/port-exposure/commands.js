/**
 * Copyable commands for the `manual` path. Every Windows firewall rule is scoped
 * to TCP, one port, the Private and Domain profiles (never Public) and the local
 * subnet. Cretli shows these; it does not run them without the stage-4 helper.
 */

export const FIREWALL_PROFILE = 'Private,Domain';
export const FIREWALL_REMOTE = 'LocalSubnet';
// Well-known creator id of the WSL Hyper-V firewall VM.
export const WSL_VM_CREATOR_ID = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}';

const ruleName = (port) => `Cretli ${port}`;

/** @param {number} port @param {string} wslIp */
export function natExposeCommands(port, wslIp) {
  return [
    `netsh interface portproxy add v4tov4 listenport=${port} listenaddress=0.0.0.0 connectport=${port} connectaddress=${wslIp}`,
    `New-NetFirewallRule -DisplayName "${ruleName(port)}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile ${FIREWALL_PROFILE} -RemoteAddress ${FIREWALL_REMOTE}`,
  ];
}

/** @param {number} port */
export function natCloseCommands(port) {
  return [
    `netsh interface portproxy delete v4tov4 listenport=${port} listenaddress=0.0.0.0`,
    `Remove-NetFirewallRule -DisplayName "${ruleName(port)}"`,
  ];
}

/** @param {number} port */
export function mirroredExposeCommands(port) {
  return [
    `New-NetFirewallHyperVRule -Name "Cretli-${port}" -DisplayName "${ruleName(port)}" -Direction Inbound -VMCreatorId '${WSL_VM_CREATOR_ID}' -Protocol TCP -LocalPorts ${port} -Action Allow -Profiles ${FIREWALL_PROFILE} -RemoteAddresses ${FIREWALL_REMOTE}`,
  ];
}

/** @param {number} port */
export function mirroredCloseCommands(port) {
  return [`Remove-NetFirewallHyperVRule -Name "Cretli-${port}"`];
}

/** The broad switch is only offered as an alternative and flagged; it opens every port. */
export const MIRRORED_BROADER_ALTERNATIVE = Object.freeze({
  command: `Set-NetFirewallHyperVVMSetting -Name '${WSL_VM_CREATOR_ID}' -DefaultInboundAction Allow`,
  broader: true,
  note: 'Allows all inbound traffic to WSL, not just this port. Prefer the per-port rule above.',
});

/** @param {number} port @param {'ufw'|'firewalld'} firewall */
export function linuxExposeCommands(port, firewall) {
  return firewall === 'ufw'
    ? [`sudo ufw allow from <your-lan-cidr> to any port ${port} proto tcp`]
    : [`sudo firewall-cmd --add-rich-rule='rule family="ipv4" source address="<your-lan-cidr>" port port="${port}" protocol="tcp" accept'`];
}

/** @param {number} port @param {'ufw'|'firewalld'} firewall */
export function linuxCloseCommands(port, firewall) {
  return firewall === 'ufw'
    ? [`sudo ufw delete allow from <your-lan-cidr> to any port ${port} proto tcp`]
    : [`sudo firewall-cmd --remove-rich-rule='rule family="ipv4" source address="<your-lan-cidr>" port port="${port}" protocol="tcp" accept'`];
}

/** Warning command for a foreign 0.0.0.0 portproxy rule on a denylisted port. Shown, never run. */
export function foreignProxyRemoveCommand(port) {
  return `netsh interface portproxy delete v4tov4 listenport=${port} listenaddress=0.0.0.0`;
}
