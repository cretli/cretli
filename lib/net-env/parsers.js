import { isIP } from 'node:net';

export function parseSs(text) {
  return String(text).split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== 'LISTEN') return [];
    const match = fields[3]?.match(/^(.*):(\d+)$/);
    if (!match) return [];
    return [{ address: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]),
      pid: Number(line.match(/pid=(\d+)/)?.[1]) || null,
      command: line.match(/users:\(\("([^"]+)"/)?.[1] || null }];
  });
}

export function parsePortproxy(text) {
  return String(text).split(/\r?\n/).flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4 || !isIP(parts[0]) || !isIP(parts[2]) || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[3])) return [];
    const [listenAddress, listenPort, connectAddress, connectPort] = parts;
    if (+listenPort < 1 || +listenPort > 65535 || +connectPort < 1 || +connectPort > 65535) return [];
    return [{ listenAddress, listenPort: +listenPort, connectAddress, connectPort: +connectPort }];
  });
}

export function parseWslConfig(text) {
  const result = {};
  let section = '';
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, '').trim();
    if (line.startsWith('[')) { section = line.toLowerCase(); continue; }
    if (section !== '[wsl2]') continue;
    const match = line.match(/^(networkingMode|localhostForwarding|firewall)\s*=\s*(.*?)\s*$/i);
    if (!match) continue;
    const key = { networkingmode: 'networkingMode', localhostforwarding: 'localhostForwarding', firewall: 'firewall' }[match[1].toLowerCase()];
    result[key] = key === 'networkingMode' ? match[2].toLowerCase() : /^(true|false)$/i.test(match[2]) ? match[2].toLowerCase() === 'true' : null;
  }
  return result;
}

export function parseNetworkingMode(text) {
  const mode = String(text).trim().toLowerCase();
  return ['nat', 'mirrored', 'virtioproxy', 'none'].includes(mode) ? mode : null;
}
