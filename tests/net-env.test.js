import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createNetEnvService, execute, resolveProcOwners } from '../lib/net-env/index.js';
import { parseSs, parsePortproxy, parseWslConfig, parseNetworkingMode } from '../lib/net-env/parsers.js';

const ss = `LISTEN 0 511 0.0.0.0:3011 0.0.0.0:* users:(("node",pid=42,fd=10))
LISTEN 0 128 127.0.0.1:9222 0.0.0.0:*
LISTEN 0 128 [::1]:8080 [::]:*`;
const rules = `Listen on ipv4:             Connect to ipv4:
Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         9222        192.0.2.2       9222
198.51.100.2    9000        192.0.2.1       9000
198.51.100.2    8081        192.0.2.2       8081`;
const config = '[wsl2]\nnetworkingMode=mirrored\nlocalhostForwarding=false\nfirewall=true\n[other]\nfirewall=false';
function service(overrides = {}) {
  const calls = [];
  const values = { ss, wslinfo: 'nat\r\n', hostname: '192.0.2.2\n', 'powershell.exe': '7.0', 'netsh.exe': rules,
    'cmd.exe': 'C:\\Users\\example\r\n', wslpath: '/mnt/c/Users/example/.wslconfig\n' };
  const instance = createNetEnvService({ platform: 'linux', release: '6.6-microsoft-standard-WSL2', procOwners: async () => {},
    executor: async (file, args, options) => { calls.push({ file, args, options }); return values[file]; },
    read: async () => config, ...overrides });
  return { ...instance, calls };
}

test('fixture parsers handle ss, localized netsh headers, wslinfo and wslconfig', () => {
  assert.deepEqual(parseSs(ss), [
    { address: '0.0.0.0', port: 3011, pid: 42, command: 'node' },
    { address: '127.0.0.1', port: 9222, pid: null, command: null },
    { address: '::1', port: 8080, pid: null, command: null },
  ]);
  assert.equal(parsePortproxy(rules).length, 3);
  assert.equal(parsePortproxy('invalid 123 nope 456\n192.0.2.1 99999 192.0.2.2 80').length, 0);
  assert.deepEqual(parseWslConfig(config), { networkingMode: 'mirrored', localhostForwarding: false, firewall: true });
  assert.equal(parseNetworkingMode('mirrored\r\n'), 'mirrored');
  assert.equal(parseNetworkingMode('unknown'), null);
});

test('NAT fixture covers every issue class and safe, actionable metadata', async () => {
  const svc = service();
  const report = await svc.getReport();
  assert.equal(report.partial, false);
  assert.deepEqual(new Set(report.issues.map((i) => i.code)), new Set([
    'loopback-only', 'unsafe-debug-proxy', 'stale-wsl-address', 'dead-proxy', 'missing-proxy', 'recommend-mirrored',
  ]));
  for (const issue of report.issues) {
    assert.ok(['info', 'warning', 'error'].includes(issue.level));
    assert.ok(issue.description && issue.command);
    assert.equal(typeof issue.needsAdmin, 'boolean');
    assert.equal(typeof issue.needsWslRestart, 'boolean');
  }
  const recommendation = report.issues.find((i) => i.code === 'recommend-mirrored');
  assert.match(recommendation.description, /Docker/);
  assert.match(recommendation.command, /Set-NetFirewallHyperVVMSetting/);
  assert.match(recommendation.command, /New-NetFirewallHyperVRule/);
  assert.ok(svc.calls.every((c) => c.options.timeout === 1500));
  assert.deepEqual(svc.calls.find((c) => c.file === 'wslpath').args, ['-u', 'C:\\Users\\example\\.wslconfig']);
});

test('mirrored mode avoids NAT forwarding and restart recommendations', async () => {
  const svc = service({ executor: async (file) => ({ ss, wslinfo: 'mirrored', hostname: '192.0.2.2', 'powershell.exe': '7', 'netsh.exe': '', 'cmd.exe': '%USERPROFILE%' }[file]) });
  const r = await svc.getReport();
  assert.equal(r.networkingMode, 'mirrored');
  assert.ok(!r.issues.some((i) => ['missing-proxy', 'recommend-mirrored'].includes(i.code)));
});

test('missing interop yields partial report, without false missing-rule warnings', async () => {
  const svc = service({ executor: async (file) => {
    if (file === 'powershell.exe') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { ss, wslinfo: 'nat', hostname: '192.0.2.2' }[file];
  } });
  const report = await svc.getReport();
  assert.ok(report.partial);
  assert.equal(report.availability.interop, false);
  assert.ok(report.reasons.some((r) => r.source === 'interop' && r.code === 'ENOENT'));
  assert.ok(!report.issues.some((i) => i.code === 'missing-proxy'));
});

test('hung injected powershell is bounded by timeout', async () => {
  const start = Date.now();
  const report = await service({ timeout: 25, executor: async (file) => file === 'powershell.exe' ? new Promise(() => {}) : ({ ss, wslinfo: 'nat', hostname: '192.0.2.2' }[file]) }).getReport();
  assert.ok(Date.now() - start < 1000);
  assert.ok(report.reasons.some((r) => r.code === 'ETIMEDOUT'));
});

test('real executor terminates a hanging process', async () => {
  await assert.rejects(execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 30 }), (error) => error.killed === true);
});

test('native Linux does not invoke Windows commands', async () => {
  const svc = service({ release: '6.6-generic' });
  const report = await svc.getReport();
  assert.equal(report.platform, 'linux');
  assert.equal(report.partial, false);
  assert.deepEqual(svc.calls.map((c) => c.file), ['ss']);
  assert.equal(report.networkingMode, null);
});

test('Windows and macOS are recognized with explicit unsupported listener reason', async () => {
  for (const [platform, expected] of [['win32', 'windows'], ['darwin', 'macos']]) {
    const svc = service({ platform });
    const r = await svc.getReport();
    assert.equal(r.platform, expected);
    assert.equal(r.partial, true);
    assert.equal(r.reasons[0].code, 'UNSUPPORTED');
    assert.equal(svc.calls.length, 0);
  }
});

test('failed ss and missing config are explicit, without false dead-proxy findings', async () => {
  const report = await service({ executor: async (file) => {
    if (file === 'ss') throw Object.assign(new Error(), { code: 'ENOENT' });
    return { wslinfo: 'nat', hostname: '192.0.2.2', 'powershell.exe': '7', 'netsh.exe': rules, 'cmd.exe': 'C:\\Users\\example', wslpath: '/config' }[file];
  }, read: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }).getReport();
  assert.equal(report.partial, true);
  assert.equal(report.wslConfig, null);
  assert.ok(!report.issues.some((i) => i.code === 'dead-proxy'));
});

test('TTL, forced refresh and concurrent requests', async () => {
  let time = 0;
  const svc = service({ now: () => time, ttl: 100 });
  const [a, b] = await Promise.all([svc.getReport(), svc.getReport()]);
  assert.equal(a, b);
  const calls = svc.calls.length;
  assert.equal(await svc.getReport(), a);
  assert.equal(svc.calls.length, calls);
  assert.notEqual(await svc.getReport({ refresh: true }), a);
  time = 101;
  const before = svc.calls.length;
  await svc.getReport();
  assert.ok(svc.calls.length > before);
});

test('/proc fallback resolves exact socket owner and tolerates inaccessible processes', async () => {
  const listeners = parseSs('LISTEN 0 1 127.0.0.1:9222 *:*');
  await resolveProcOwners(listeners, {
    readFile: async (p) => p.endsWith('/comm') ? 'chrome\n' : p.endsWith('tcp6') ? 'header\n' : 'header\n0: 0100007F:2406 00000000:0000 0A 0:0 0:0 0 0 0 123\n',
    readdir: async (p) => p === '/proc' ? ['42', '43', 'self'] : p.includes('43') ? Promise.reject(new Error()) : ['1'],
    readlink: async () => 'socket:[123]',
  });
  assert.equal(listeners[0].pid, 42);
  assert.equal(listeners[0].command, 'chrome');
});

test('debug forwarding is unsafe even when its public port is different', async () => {
  const report = await service({ executor: async (file) => ({ ss, wslinfo: 'nat', hostname: '192.0.2.2', 'powershell.exe': '7',
    'netsh.exe': '0.0.0.0 8088 192.0.2.2 9222', 'cmd.exe': '%USERPROFILE%' }[file]) }).getReport();
  assert.ok(report.issues.some((i) => i.code === 'unsafe-debug-proxy'));
});

test('/proc fallback resolves IPv6 loopback ownership', async () => {
  const listeners = parseSs('LISTEN 0 1 [::1]:9222 [::]:*');
  const hex = os.endianness() === 'LE' ? '00000000000000000000000001000000' : '00000000000000000000000000000001';
  await resolveProcOwners(listeners, {
    readFile: async (p) => p.endsWith('/comm') ? 'chrome\n' : p.endsWith('tcp6') ? `header\n0: ${hex}:2406 0:0 0A 0:0 0:0 0 0 0 123\n` : 'header\n',
    readdir: async (p) => p === '/proc' ? ['42'] : ['1'], readlink: async () => 'socket:[123]',
  });
  assert.equal(listeners[0].pid, 42);
});

test('loopback-only Windows forwarding does not count as LAN exposure', async () => {
  const report = await service({ executor: async (file) => ({ ss, wslinfo: 'nat', hostname: '192.0.2.2', 'powershell.exe': '7',
    'netsh.exe': '127.0.0.1 3011 192.0.2.2 3011', 'cmd.exe': '%USERPROFILE%' }[file]) }).getReport();
  assert.ok(report.issues.some((i) => i.code === 'missing-proxy'));
});
