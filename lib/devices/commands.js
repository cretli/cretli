/**
 * Connection assistant: pure text generators. Cretli never executes these
 * commands; the user runs them on the device or its host. Placeholders such as
 * <device-ip> stand in for values the user fills in.
 */

import { isValidHostSyntax, isValidPort } from './endpoint-guard.js';

const PITFALLS = Object.freeze({
  chrome136: 'Chrome 136 and newer ignore --remote-debugging-port on the default profile, so a separate --user-data-dir is required.',
  pairWindow: 'The pairing window closes when you switch apps; keep Settings > Wireless debugging > Pair device open until `adb pair` finishes.',
  mdns: 'mDNS discovery does not work through WSL; enter the IP and port shown on the device by hand.',
  wslAdb: 'A forward created by Windows adb.exe is not visible inside WSL; use one adb binary (set the adb path in Devices settings) for pair, connect and forward.',
  jsonNew: 'Android Chrome does not support /json/new; open pages with `adb shell am start` or through the DevTools protocol instead.',
  portScan: 'If the wireless debugging port is hidden, scan the device IP for open ports (for example `nmap -p 30000-45000 <device-ip>`) and try the one that answers.',
});

/** @param {unknown} value @param {string} fallback */
const safe = (value, fallback) => {
  const v = String(value ?? '').trim();
  return v && isValidHostSyntax(v) ? v : fallback;
};
/** @param {unknown} value @param {number} fallback */
const safePort = (value, fallback) => (isValidPort(value) ? Number(value) : fallback);

/**
 * @param {{ platform: string, host?: string, port?: number, cdpPort?: number, adbPath?: string }} input
 * @returns {{ platform: string, connect: string, cleanup: string, hints: string[] }}
 */
export function generateConnectHelp(input) {
  const platform = String(input?.platform || '');
  const host = safe(input?.host, '<device-ip>');
  const cdp = safePort(input?.cdpPort ?? input?.port, 9222);
  const adbPort = safePort(input?.port, 0) || '<connect-port>';
  const adb = /^[A-Za-z0-9._/\\:-]{1,200}$/.test(String(input?.adbPath || '')) ? String(input.adbPath) : 'adb';

  if (platform === 'macos') {
    return {
      platform,
      connect: [
        '# 1. Quit Chrome, then start it with a separate profile and the debug port.',
        `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=${cdp} --user-data-dir="$HOME/.cretli-chrome-profile"`,
        '# 2. Chrome listens on loopback only. Forward it to the LAN address of this Mac:',
        `socat TCP-LISTEN:${cdp + 1},fork,bind=<mac-lan-ip> TCP:127.0.0.1:${cdp}`,
        `# 3. Register this Mac in Cretli with host <mac-lan-ip> and port ${cdp + 1}.`,
      ].join('\n'),
      cleanup: [
        '# Stop the forwarder (Ctrl+C in its terminal, or):',
        `pkill -f "socat TCP-LISTEN:${cdp + 1}"`,
        '# Quit the debug Chrome and optionally delete its profile:',
        'rm -rf "$HOME/.cretli-chrome-profile"',
      ].join('\n'),
      hints: [PITFALLS.chrome136],
    };
  }
  if (platform === 'windows') {
    return {
      platform,
      connect: [
        '# 1. Start Chrome with a separate profile and the debug port (PowerShell):',
        `& "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=${cdp} --user-data-dir="$env:USERPROFILE\\.cretli-chrome-profile"`,
        '# 2. Forward the LAN address to loopback (elevated PowerShell):',
        `netsh interface portproxy add v4tov4 listenaddress=<windows-lan-ip> listenport=${cdp + 1} connectaddress=127.0.0.1 connectport=${cdp}`,
        `New-NetFirewallRule -DisplayName "Cretli CDP" -Direction Inbound -Protocol TCP -LocalPort ${cdp + 1} -RemoteAddress LocalSubnet -Action Allow`,
        `# 3. Register this PC in Cretli with host <windows-lan-ip> and port ${cdp + 1}.`,
      ].join('\n'),
      cleanup: [
        `netsh interface portproxy delete v4tov4 listenaddress=<windows-lan-ip> listenport=${cdp + 1}`,
        'Remove-NetFirewallRule -DisplayName "Cretli CDP"',
        '# Close the debug Chrome and optionally delete the profile folder.',
      ].join('\n'),
      hints: [PITFALLS.chrome136],
    };
  }
  if (platform === 'android') {
    return {
      platform,
      connect: [
        '# 1. On the phone: Developer options > Wireless debugging > Pair device with pairing code.',
        `${adb} pair ${host}:<pairing-port>`,
        '# Enter the pairing code when asked; Cretli never stores it.',
        '# 2. Connect using the port on the main Wireless debugging screen:',
        `${adb} connect ${host}:${adbPort}`,
        '# 3. Forward Chrome DevTools to this machine:',
        `${adb} -s ${host}:${adbPort} forward tcp:${cdp} localabstract:chrome_devtools_remote`,
        `# 4. Open Chrome on the phone, then register the device in Cretli (CDP port ${cdp}).`,
      ].join('\n'),
      cleanup: [
        `${adb} -s ${host}:${adbPort} forward --remove tcp:${cdp}`,
        `${adb} disconnect ${host}:${adbPort}`,
        '# Turn Wireless debugging off on the phone when finished.',
      ].join('\n'),
      hints: [PITFALLS.pairWindow, PITFALLS.mdns, PITFALLS.wslAdb, PITFALLS.portScan, PITFALLS.jsonNew],
    };
  }
  return { platform, connect: '', cleanup: '', hints: ['No connection recipe exists for this platform (iOS is registry-only for now).'] };
}
