import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PIPE_USER_ACCESS, FILE_APPEND_DATA, WRITE_DAC, WRITE_OWNER, GENERIC_BITS, SID_SYSTEM, SID_ADMINISTRATORS, SID_NETWORK,
  MAX_REQUEST_BYTES, BUILTIN_DENYLIST, buildPipeSddl, parseSddl, validateRequest, isServerTrusted, planUninstall, isProxyOwned, hasForeignConflict, isFirewallRuleOwned, isHyperVRuleOwned,
  HELPER_FIREWALL_PROFILE, HELPER_FIREWALL_REMOTE, RULE_PREFIX, RULE_SPEC, RULE_TOKEN_PATTERN,
} from '../lib/port-exposure/netd-protocol.js';
import { createNetdClient } from '../lib/port-exposure/netd-client.js';
import { createBackend } from '../lib/port-exposure/backends.js';
import { mirroredExposeCommands, natExposeCommands, WSL_VM_CREATOR_ID } from '../lib/port-exposure/commands.js';

const dir = new URL('../scripts/windows/', import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, dir), 'utf8');
const common = read('cretli-netd-common.ps1');
const server = read('cretli-netd.ps1');
const client = read('cretli-netctl.ps1');
const installer = read('install-cretli-netd.ps1');
/** Source without comment lines, so assertions about code are not satisfied by prose. */
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const POLISH = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;

const USER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const config = { range: { min: 3000, max: 9999 }, denylist: [4500] };
const req = (over = {}) => JSON.stringify({ v: 1, id: 'abc-123', op: 'expose', port: 3000, ...over });

test('helper scripts exist, are English-only and contain no private environment details', () => {
  for (const text of [common, server, client, installer]) {
    assert.doesNotMatch(text, POLISH);
    assert.doesNotMatch(text, /192\.168\.|\b10\.\d+\.\d+\.\d+|C:\\Users\\/);
  }
});

// ---- Request validation (Node mirror, pinned against the .ps1 by static checks below) ----

test('validation rejects out-of-range and denylisted ports', () => {
  assert.equal(validateRequest(req({ port: 80 }), config).code, 'port_out_of_range');
  assert.equal(validateRequest(req({ port: 10000 }), config).code, 'port_out_of_range');
  assert.equal(validateRequest(req({ port: 9222 }), config).code, 'port_denylisted');
  assert.equal(validateRequest(req({ port: 4500 }), config).code, 'port_denylisted');
  // The built-in list wins even when the configured range or denylist would allow the port.
  assert.equal(validateRequest(req({ port: 2375 }), { range: { min: 1, max: 65535 }, denylist: [] }).code, 'port_denylisted');
  for (const bad of ['3000', 3000.5, 0, -1, null, true]) assert.equal(validateRequest(req({ port: bad }), config).code, 'bad_port', String(bad));
  assert.equal(validateRequest(req({ port: undefined }), config).code, 'bad_port');
  assert.ok(validateRequest(req({ port: 3000 }), config).ok);
});

test('validation rejects unknown ops, address fields, extra fields, oversized input and a bad version', () => {
  assert.equal(validateRequest(req({ op: 'shell' }), config).code, 'unknown_op');
  assert.equal(validateRequest(req({ op: 'EXPOSE' }), config).code, 'unknown_op');
  assert.equal(validateRequest(req({ address: '0.0.0.0' }), config).code, 'unknown_field');
  assert.equal(validateRequest(req({ connectAddress: '10.0.0.1' }), config).code, 'unknown_field');
  assert.equal(validateRequest(req({ extra: 1 }), config).code, 'unknown_field');
  assert.equal(validateRequest(JSON.stringify({ v: 1, id: 'a', op: 'status', port: 3000 }), config).code, 'unknown_field');
  assert.equal(validateRequest(req({ v: 2 }), config).code, 'bad_version');
  assert.equal(validateRequest(req({ v: '1' }), config).code, 'bad_version');
  assert.equal(validateRequest(req({ id: 'x'.repeat(65) }), config).code, 'bad_request');
  assert.equal(validateRequest(JSON.stringify({ v: 1, op: 'status' }), config).code, 'bad_request');
  assert.equal(validateRequest('x'.repeat(MAX_REQUEST_BYTES + 1), config).code, 'too_large');
  assert.equal(validateRequest(req({ id: 'a'.repeat(MAX_REQUEST_BYTES) }), config).code, 'too_large');
  assert.equal(validateRequest('[1]', config).code, 'bad_json');
  assert.equal(validateRequest('{nope', config).code, 'bad_json');
  assert.ok(validateRequest(JSON.stringify({ v: 1, id: 'a', op: 'status' }), config).ok);
});

test('server rejects a foreign SID and close of a rule outside the state (static checks on the .ps1)', () => {
  const body = code(server);
  // Foreign client SID: compared with the configured SID before anything is read.
  assert.match(body, /\$sid -cne \$Config\.userSid/);
  assert.match(body, /code = 'client_untrusted'/);
  assert.ok(body.indexOf('client_untrusted') < body.indexOf('ReadLine($Pipe'), 'client is checked before reading the request');
  // close: refused unless the port is recorded in state.json.
  const closeBlock = body.slice(body.indexOf("'close' {"), body.indexOf("'reconcile' {"));
  assert.match(closeBlock, /not_in_state/);
  assert.ok(closeBlock.indexOf('not_in_state') < closeBlock.indexOf('Remove-NetdOwnedObjects'));
});

test('ps1 validator matches the Node mirror (fields, ops, size, codes)', () => {
  assert.match(common, /\$script:NetdMaxRequestBytes = 4096/);
  assert.match(common, /\$script:NetdOps = @\('status', 'list', 'expose', 'close', 'reconcile'\)/);
  assert.match(common, /\$script:NetdAllowedFields = @\('v', 'id', 'op', 'port'\)/);
  for (const c of ['too_large', 'bad_json', 'unknown_field', 'bad_version', 'unknown_op', 'bad_port', 'port_denylisted', 'port_out_of_range']) {
    assert.match(common, new RegExp(`'${c}'`), c);
  }
  const deny = /NetdBuiltinDenylist = @\(([^)]*)\)/.exec(common)[1].split(',').map((n) => Number(n.trim()));
  assert.deepEqual(deny.sort((a, b) => a - b), [...BUILTIN_DENYLIST]);
});

// ---- Pipe DACL ----

test('pipe DACL: user mask is exactly 0x00120083, NETWORK denied, no Everyone/Users, owner SYSTEM', () => {
  assert.equal(PIPE_USER_ACCESS, 0x00120083);
  assert.equal(PIPE_USER_ACCESS & FILE_APPEND_DATA, 0);
  assert.equal(PIPE_USER_ACCESS & WRITE_DAC, 0);
  assert.equal(PIPE_USER_ACCESS & WRITE_OWNER, 0);
  assert.equal((PIPE_USER_ACCESS & GENERIC_BITS) >>> 0, 0);
  const sddl = parseSddl(buildPipeSddl(USER_SID));
  assert.equal(sddl.owner, 'SY'); // SY = S-1-5-18
  assert.ok(sddl.protectedDacl);
  const user = sddl.aces.filter((a) => a.trustee === USER_SID);
  assert.deepEqual(user, [{ type: 'allow', mask: 0x00120083, trustee: USER_SID }]);
  assert.ok(sddl.aces.some((a) => a.type === 'deny' && a.trustee === 'NU'), 'NETWORK (S-1-5-2) is denied');
  assert.equal(sddl.aces[0].type, 'deny', 'deny ACEs come first');
  assert.deepEqual(sddl.aces.map((a) => a.trustee).sort(), ['NU', 'SY', USER_SID].sort());
  assert.ok(!sddl.aces.some((a) => ['WD', 'BU', 'S-1-1-0', 'S-1-5-32-545', 'AU'].includes(a.trustee)), 'no Everyone, Users or Authenticated Users');
  assert.equal(SID_NETWORK, 'S-1-5-2');
});

test('ps1 builds the same SDDL from the one shared mask constant', () => {
  assert.match(common, /\$script:PipeUserAccess = 0x00120083/);
  assert.match(common, /'O:SYD:P\(D;;0x001F01FF;;;NU\)\(A;;0x001F01FF;;;SY\)\(A;;0x\{0:X8\};;;\{1\}\)' -f \$script:PipeUserAccess, \$UserSid/);
  assert.equal(buildPipeSddl('S-1-5-21-1'), 'O:SYD:P(D;;0x001F01FF;;;NU)(A;;0x001F01FF;;;SY)(A;;0x00120083;;;S-1-5-21-1)');
  assert.match(common, /\$script:SidSystem = 'S-1-5-18'/);
});

test('server creates the pipe single-instance, first-instance, remote-rejecting, in byte mode', () => {
  const body = code(server);
  assert.match(body, /\$PIPE_TYPE_BYTE = 0x00000000/);
  assert.match(body, /\$PIPE_READMODE_BYTE = 0x00000000/);
  assert.match(body, /\$PIPE_TYPE_BYTE -bor \$PIPE_READMODE_BYTE/);
  assert.match(body, /\$PIPE_REJECT_REMOTE_CLIENTS = 0x00000008/);
  assert.match(body, /\$FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000/);
  assert.match(body, /\$NETD_MAX_INSTANCES = 1/);
  assert.doesNotMatch(body, /PIPE_TYPE_MESSAGE|PIPE_READMODE_MESSAGE/);
  assert.doesNotMatch(body, /NamedPipeServerStream/);
  assert.match(body, /GetNamedPipeClientProcessId/);
});

// ---- Client ----

test('client requests exactly the shared mask and never changes the pipe handle state', () => {
  const body = code(client);
  assert.match(body, /\$PIPE_DESIRED_ACCESS = \$script:PipeUserAccess/);
  assert.doesNotMatch(body, /GENERIC_READ|GENERIC_WRITE|0x80000000|0x40000000/);
  assert.doesNotMatch(body, /SetNamedPipeHandleState/);
  // requested & ~granted == 0 and no generic bits.
  const granted = parseSddl(buildPipeSddl(USER_SID)).aces.find((a) => a.trustee === USER_SID).mask;
  assert.equal((PIPE_USER_ACCESS & ~granted) >>> 0, 0);
  assert.equal((PIPE_USER_ACCESS & GENERIC_BITS) >>> 0, 0);
});

test('client retries ERROR_PIPE_BUSY through WaitNamedPipe within 5 s, then reports helper_busy', () => {
  const body = code(client);
  assert.match(body, /ConnectTimeoutMs = 5000/);
  assert.match(body, /ResponseTimeoutMs = 30000/);
  assert.match(body, /ERROR_PIPE_BUSY = 231/);
  const loop = body.slice(body.indexOf('while ($true)'), body.indexOf('try {', body.indexOf('while ($true)')));
  assert.match(loop, /-ne \[NetctlNative\]::ERROR_PIPE_BUSY/);
  assert.match(loop, /WaitNamedPipe\(\$script:NetdPipePath, \[uint32\]\$remaining\)/);
  assert.match(loop, /\$remaining -le 0\) \{ Write-NetctlResult \$false 'helper_busy'/);
});

test('client verifies the server on the sending handle, before the request is written (fail-closed)', () => {
  const body = code(client);
  const verify = body.indexOf('Test-NetdServerIdentity');
  const write = body.indexOf('WriteAll($handle');
  assert.ok(verify > 0 && write > verify, 'identity check precedes the write');
  assert.match(body, /OwnerSid\(\$handle/);
  assert.match(body, /GetSecurityInfo\(h, 6 \/\* SE_KERNEL_OBJECT \*\/, 1 \/\* OWNER_SECURITY_INFORMATION \*\//);
  assert.match(body, /QueryFullProcessImageName/);
  assert.match(body.slice(verify, write), /server_untrusted/);
});

test('server verification: SYSTEM and Administrators owners pass, everything else is untrusted', () => {
  const systemRoot = 'C:\\Windows';
  const image = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  assert.ok(isServerTrusted({ ownerSid: SID_SYSTEM, imagePath: image, systemRoot }));
  assert.ok(isServerTrusted({ ownerSid: SID_ADMINISTRATORS, imagePath: image.toUpperCase(), systemRoot }));
  assert.ok(!isServerTrusted({ ownerSid: USER_SID, imagePath: image, systemRoot }), 'a user-owned pipe');
  assert.ok(!isServerTrusted({ ownerSid: SID_SYSTEM, imagePath: 'C:\\Users\\x\\evil.exe', systemRoot }), 'another image');
  assert.ok(!isServerTrusted({ ownerSid: null, imagePath: image, systemRoot, error: 'GetSecurityInfo 5' }), 'GetSecurityInfo failed');
  assert.ok(!isServerTrusted({ ownerSid: SID_SYSTEM, imagePath: null, systemRoot, error: 'OpenProcess' }));
  assert.ok(!isServerTrusted({ ownerSid: SID_SYSTEM, imagePath: image, systemRoot: null }));
  assert.match(common, /\(\$OwnerSid -cne \$script:SidSystem\) -and \(\$OwnerSid -cne \$script:SidAdministrators\)/);
  assert.match(common, /if \(\$ErrorText\) \{ return \$false \}/);
  assert.equal(SID_ADMINISTRATORS, 'S-1-5-32-544');
});

// ---- Firewall rule and uninstall ----

test('firewall rules are Private,Domain (never Public) and limited to LocalSubnet', () => {
  assert.equal(HELPER_FIREWALL_PROFILE, 'Private,Domain');
  assert.equal(HELPER_FIREWALL_REMOTE, 'LocalSubnet');
  assert.match(common, /Profile\s*=\s*'Private,Domain'/);
  assert.match(common, /RemoteAddress\s*=\s*'LocalSubnet'/);
  assert.match(common, /Profiles\s*=\s*'Private,Domain'/);
  assert.match(common, /RemoteAddresses\s*=\s*'LocalSubnet'/);
  assert.match(common, /Protocol\s*=\s*'TCP'/);
  for (const text of [common, server, installer]) assert.doesNotMatch(code(text), /\bPublic\b|Profile\s+Any|-RemoteAddress\s+Any/);
  assert.ok(mirroredExposeCommands(3000)[0].includes(WSL_VM_CREATOR_ID));
  assert.ok(common.includes(WSL_VM_CREATOR_ID));
  assert.ok(natExposeCommands(3000, '172.20.0.2')[1].includes('Private,Domain'));
  // Ledger rule names differ from the manual script's "Cretli <port>".
  assert.match(common, /NetdRulePrefix = 'Cretli netd'/);
  assert.equal(RULE_PREFIX, 'Cretli netd');
});

const token = (port) => `cretli-netd:${port}:${'a'.repeat(32)}`;
const hyperVName = (port) => `Cretli-netd-${port}-${'a'.repeat(32)}`;
const ledgerEntry = (port, ip = '172.20.0.2') => ({
  port, proxy: { listenAddress: '0.0.0.0', connectAddress: ip, connectPort: port },
  firewallName: `Cretli-netd-${port}-abc`, firewallToken: token(port),
});
const proxyRow = (port, ip = '172.20.0.2') => ({ listenAddress: '0.0.0.0', listenPort: port, connectAddress: ip, connectPort: port });
const liveRule = (port, over = {}) => ({ ...RULE_SPEC.firewall,
  Name: `Cretli-netd-${port}-abc`, DisplayName: `Cretli netd ${port}`, Description: token(port),
  LocalPort: [String(port)], Profile: 'Domain, Private', RemoteAddress: ['LocalSubnet'], ...over,
});
const liveHyperV = (port, over = {}) => ({ ...RULE_SPEC.hyperV,
  Name: hyperVName(port), DisplayName: `Cretli netd ${port}`,
  LocalPort: String(port), ...over,
});

const foreignCases = {
  edge: { EdgeTraversalPolicy: 'Allow' }, interface: { InterfaceType: 'Wireless' },
  program: { Program: 'C:\\other.exe' }, service: { Service: 'Other' },
  token: { Description: 'cretli-netd:3000:00000000000000000000000000000000' },
  missingToken: { Description: '' }, store: { PolicyStoreSource: 'GroupPolicy' },
  extra: { NewCondition: 'Any' },
};

test('shared rule specs and description token match PowerShell', () => {
  assert.deepEqual(JSON.parse(read('cretli-netd-rule-spec.json')), RULE_SPEC);
  assert.match(common, /cretli-netd:\{0\}:\{1\}/);
  assert.ok(RULE_TOKEN_PATTERN.test(token(3000)));
  assert.match(installer, /cretli-netd-rule-spec\.json/);
  assert.match(common, /Get-NetFirewallApplicationFilter/);
  assert.match(common, /Get-NetFirewallInterfaceTypeFilter/);
  assert.match(common, /Get-NetFirewallServiceFilter/);
  assert.match(common, /Get-NetFirewallSecurityFilter/);
  assert.match(common, /PolicyStoreSource = \[string\]\$rule\.PolicyStoreSource/);
  assert.match(common, /PolicyStoreSourceType = \[string\]\$rule\.PolicyStoreSourceType/);
});

test('R3-F1: full live spec and token determine ownership for both rule kinds', () => {
  assert.ok(isFirewallRuleOwned(liveRule(3000), 3000, ledgerEntry(3000).firewallName, token(3000)));
  assert.ok(isHyperVRuleOwned(liveHyperV(3000), 3000, hyperVName(3000), token(3000)));
  for (const [label, change] of Object.entries(foreignCases)) {
    assert.ok(!isFirewallRuleOwned(liveRule(3000, change), 3000, ledgerEntry(3000).firewallName, token(3000)), label);
    if (Object.hasOwn(RULE_SPEC.hyperV, Object.keys(change)[0]) || label === 'extra')
      assert.ok(!isHyperVRuleOwned(liveHyperV(3000, change), 3000, hyperVName(3000), token(3000)), label);
  }
  assert.ok(!isFirewallRuleOwned(liveRule(3000), 3000, ledgerEntry(3000).firewallName, undefined));
});

test('R4-F1: persistent local store facts match; foreign or missing store facts fail closed', () => {
  const name = ledgerEntry(3000).firewallName;
  const owned = liveRule(3000, { PolicyStoreSource: 'PersistentStore', PolicyStoreSourceType: 'Local' });
  assert.ok(isFirewallRuleOwned(owned, 3000, name, token(3000)));
  assert.ok(!isFirewallRuleOwned({ ...owned, PolicyStoreSourceType: 'GroupPolicy' }, 3000, name, token(3000)));
  const missingSource = { ...owned }; delete missingSource.PolicyStoreSource;
  assert.ok(!isFirewallRuleOwned(missingSource, 3000, name, token(3000)));
  const missingType = { ...owned }; delete missingType.PolicyStoreSourceType;
  assert.ok(!isFirewallRuleOwned(missingType, 3000, name, token(3000)));
  assert.match(common, /PSObject\.Properties\['PolicyStoreSource'\]/);
  assert.match(common, /PSObject\.Properties\['PolicyStoreSourceType'\]/);
});

test('R4-F1: Hyper-V uses only available properties and name-bound token', () => {
  const name = hyperVName(3000);
  assert.ok(isHyperVRuleOwned(liveHyperV(3000), 3000, name, token(3000)));
  assert.ok(!isHyperVRuleOwned(liveHyperV(3000, { PolicyStoreSourceType: 'GroupPolicy' }), 3000, name, token(3000)));
  assert.ok(!isHyperVRuleOwned(liveHyperV(3000), 3000, name, `cretli-netd:3000:${'b'.repeat(32)}`));
  for (const unsupported of ['Description', 'InterfaceType', 'InterfaceAlias', 'EdgeTraversalPolicy', 'Program', 'Service', 'Package', 'Owner', 'PolicyStoreSource']) {
    assert.ok(!Object.hasOwn(RULE_SPEC.hyperV, unsupported), unsupported);
  }
});

test('R3-F1: close, expose, reconcile and uninstall use the token-aware predicate', () => {
  const body = code(server);
  for (const section of ['function Test-NetdForeignConflict', 'function Remove-NetdOwnedObjects', 'function Invoke-NetdReconcile']) {
    assert.match(body.slice(body.indexOf(section)), /Test-NetdFirewallRuleOwned[^\n]*-Token/);
    assert.match(body.slice(body.indexOf(section)), /Test-NetdHyperVRuleOwned[^\n]*-Token/);
  }
  assert.match(common, /Get-NetdUninstallPlan[\s\S]*Test-NetdFirewallRuleOwned[^\n]*-Token/);
  assert.match(common, /Get-NetdUninstallPlan[\s\S]*Test-NetdHyperVRuleOwned[^\n]*-Token/);
  assert.match(body, /firewallToken = \$token/);
  assert.match(body, /hyperVToken = \$token/);
});

test('R3-F1: foreign rule variants are refused by expose and uninstall planning', () => {
  const entry = ledgerEntry(3000);
  const clean = { proxy: proxyRow(3000), firewallRuleNames: [entry.firewallName], recordedRule: liveRule(3000) };
  assert.ok(!hasForeignConflict(entry, clean));
  assert.deepEqual(planUninstall({ rules: [entry] }, [liveRule(3000)]).remove, [entry.firewallName]);
  for (const [label, change] of Object.entries(foreignCases)) {
    const foreign = liveRule(3000, change);
    assert.ok(hasForeignConflict(entry, { ...clean, recordedRule: foreign }), label);
    const plan = planUninstall({ rules: [entry] }, [foreign]);
    assert.deepEqual(plan.remove, [], label);
    assert.deepEqual(plan.keep, [entry.firewallName], label);
  }
});

test('R3-F1: foreign Hyper-V rule variants are retained by uninstall planning', () => {
  const entry = { port: 3000, hyperVName: hyperVName(3000), hyperVToken: token(3000) };
  assert.deepEqual(planUninstall({ rules: [entry] }, [], [], [liveHyperV(3000)]).hyperV, [entry.hyperVName]);
  for (const [label, change] of Object.entries(foreignCases)) {
    const plan = planUninstall({ rules: [entry] }, [], [], [liveHyperV(3000, change)]);
    if (Object.hasOwn(RULE_SPEC.hyperV, Object.keys(change)[0]) || label === 'extra')
      assert.deepEqual(plan.hyperV, [], label);
  }
});

test('expose refuses pre-existing foreign endpoints and rules instead of deleting them', () => {
  assert.ok(isProxyOwned(ledgerEntry(3000), proxyRow(3000)));
  assert.ok(!isProxyOwned(ledgerEntry(3000), proxyRow(3000, '10.9.9.9')), 'target changed since the record');
  assert.ok(!isProxyOwned({}, proxyRow(3000)), 'no ledger record');
  assert.ok(!isProxyOwned(ledgerEntry(3000), null));
  // Foreign portproxy with no ledger entry.
  assert.ok(hasForeignConflict(null, { proxy: proxyRow(3000), firewallRuleNames: [] }));
  // Foreign rule that only shares the display name.
  assert.ok(hasForeignConflict(ledgerEntry(3000), { proxy: proxyRow(3000), firewallRuleNames: ['Cretli-netd-3000-abc', 'manual-rule'] }));
  assert.ok(hasForeignConflict(null, { proxy: null, firewallRuleNames: ['Cretli netd 3000'] }));
  // Our own objects are not a conflict (re-expose / refresh), nor is a clean port.
  assert.ok(!hasForeignConflict(ledgerEntry(3000), { proxy: proxyRow(3000), firewallRuleNames: ['Cretli-netd-3000-abc'] }));
  assert.ok(!hasForeignConflict(null, { proxy: null, firewallRuleNames: [] }));

  const body = code(server);
  assert.match(body, /port_in_use_foreign/);
  const expose = body.slice(body.indexOf("'expose' {"), body.indexOf("'close' {"));
  assert.ok(expose.indexOf('Test-NetdForeignConflict') > 0 && expose.indexOf('Test-NetdForeignConflict') < expose.indexOf('New-NetdPortObjects'), 'conflict check precedes any change');
  // Deletions are by recorded Name or by a proxy that matches the record - never by port or display name alone.
  assert.doesNotMatch(body, /Remove-NetFirewallRule\s+-DisplayName/);
  const remove = body.slice(body.indexOf('function Remove-NetdOwnedObjects'), body.indexOf('function New-NetdPortObjects'));
  assert.match(remove, /Test-NetdProxyOwned -Entry \$Entry -Observed \$observed\)\)\s*\{\s*&\s*netsh\.exe interface portproxy delete/);
  assert.match(remove, /Remove-NetFirewallRule -Name \$Entry\.firewallName/);
  // Only Remove-NetdOwnedObjects may delete a portproxy (plus the rollback right after our own add).
  assert.equal((body.match(/portproxy delete/g) || []).length, 2);
  // The ledger stores exact ids.
  const created = body.slice(body.indexOf('function New-NetdPortObjects'), body.indexOf('function Set-NetdEntry'));
  assert.match(created, /proxy = \[pscustomobject\]@\{ listenAddress = '0\.0\.0\.0'; connectAddress = \$Ip; connectPort = \$Port \}/);
  assert.match(created, /firewallName = \$fw\.Name/);
  assert.match(common, /Name\s*=\s*\$Name/);
  // Reconcile skips a proxy that no longer matches the ledger.
  const reconcile = body.slice(body.indexOf('function Invoke-NetdReconcile'), body.indexOf('function Invoke-NetdOp'));
  assert.match(reconcile, /-not \(Test-NetdProxyOwned -Entry \$entry -Observed \$observed\)[\s\S]*port_in_use_foreign[\s\S]*continue/);
});

test('WSL address lookup: valid std handles, environment block checked, handles released', () => {
  const body = code(server);
  const run = body.slice(body.indexOf('public static int RunInUserSession'), body.indexOf('function Write-NetdAudit'));
  assert.match(run, /CreateFile\("NUL"/);
  assert.match(run, /si\.hStdInput = nul; si\.hStdOutput = wr; si\.hStdError = wr;/);
  assert.doesNotMatch(run, /hStdInput = IntPtr\.Zero/);
  assert.match(run, /if \(!CreateEnvironmentBlock\(out env, token, false\)\) \{ env = IntPtr\.Zero; return 3; \}/);
  assert.match(run, /if \(nul != new IntPtr\(-1\)\) CloseHandle\(nul\)/);
  for (const handle of ['wr', 'rd', 'token', 'pi.hProcess', 'pi.hThread']) assert.match(run, new RegExp(`CloseHandle\\(${handle.replace('.', '\\.')}\\)`), handle);
  assert.match(run, /DestroyEnvironmentBlock\(env\)/);
  // The inheritable attributes used for NUL and the pipe are the same bInheritHandle = 1 structure.
  assert.match(run, /sa\.bInheritHandle = 1/);
});

test('installer: SID of the desktop user, protected ACL, SYSTEM task with restart policy', () => {
  const body = code(installer);
  assert.match(body, /explorer\.exe/);
  assert.match(body, /Confirm-Action/);
  assert.match(body, /-UserId 'SYSTEM'[^\n]*-RunLevel Highest/);
  assert.match(body, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(body, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(body, /-RestartCount 3 -RestartInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(body, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(body, /'S-1-5-32-545', 'ReadAndExecute'/);
  assert.doesNotMatch(body, /Everyone|S-1-1-0/);
});

// ---- Adapter on a fake powershell.exe ----

/** Writes an executable fake `powershell.exe` and returns its path. */
function fakePowershell(script) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-fake-ps-')), 'powershell.exe');
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}
const jsonReply = (obj) => `printf '%s\\n' '${JSON.stringify(obj)}'`;

test('adapter passes a closed argument list to powershell.exe -File', async () => {
  const calls = [];
  const netd = createNetdClient({
    run: async (file, args) => { calls.push({ file, args }); return { stdout: '{"v":1,"id":"x","ok":true,"data":{"port":3000}}\n', code: 0 }; },
    clientPath: 'C:\\ProgramData\\Cretli\\netd\\cretli-netctl.ps1',
  });
  assert.equal((await netd.executor.run({ op: 'firewall-add', port: 3000 })).ok, true);
  assert.deepEqual(calls[0], { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-File', 'C:\\ProgramData\\Cretli\\netd\\cretli-netctl.ps1', '-Op', 'expose', '-Port', '3000'] });
});

test('adapter maps every helper failure to a coded failure', async () => {
  const cases = [
    ['helper_busy', jsonReply({ v: 1, id: 'x', ok: false, code: 'helper_busy' }), 'helper_busy'],
    ['server_untrusted', jsonReply({ v: 1, id: 'x', ok: false, code: 'server_untrusted' }), 'server_untrusted'],
    ['no_user_session', jsonReply({ v: 1, id: 'x', ok: false, code: 'no_user_session' }), 'no_user_session'],
    ['validation error', jsonReply({ v: 1, id: 'x', ok: false, code: 'port_denylisted' }), 'port_denylisted'],
    ['script missing', 'echo "The argument ... does not exist. Provide the path to an existing .ps1 file." >&2; exit 64', 'helper_missing'],
    ['garbage', 'echo not-json', 'bad_response'],
  ];
  for (const [label, script, expected] of cases) {
    const netd = createNetdClient({ powershell: fakePowershell(script), timeoutMs: 3000 });
    const result = await netd.executor.run({ op: 'firewall-add', port: 3000 });
    assert.deepEqual(result, { ok: false, error: expected }, label);
  }
  const missing = createNetdClient({ powershell: '/nonexistent/powershell.exe' });
  assert.deepEqual(await missing.executor.run({ op: 'firewall-add', port: 3000 }), { ok: false, error: 'helper_missing' });
});

test('adapter times out a hanging helper', async () => {
  const netd = createNetdClient({ powershell: fakePowershell('sleep 5'), timeoutMs: 200 });
  const started = Date.now();
  assert.deepEqual(await netd.executor.run({ op: 'firewall-add', port: 3000 }), { ok: false, error: 'timeout' });
  assert.ok(Date.now() - started < 3000);
});

test('adapter validates before spawning anything', async () => {
  let spawned = 0;
  const netd = createNetdClient({ run: async () => { spawned += 1; return { stdout: '', code: 0 }; } });
  assert.equal((await netd.call('rm -rf')).code, 'validation');
  assert.equal((await netd.call('expose')).code, 'validation');
  assert.equal((await netd.call('expose', 70000)).code, 'validation');
  assert.equal((await netd.call('expose', 3000.5)).code, 'validation');
  assert.equal((await netd.call('status', 3000)).code, 'validation');
  assert.equal(spawned, 0);
});

test('every helper failure makes the WSL backends fall back to manual (pending_manual with commands)', async () => {
  const codes = ['timeout', 'helper_missing', 'helper_busy', 'server_untrusted', 'no_user_session', 'port_denylisted'];
  for (const code of codes) {
    const failing = createNetdClient({ run: async () => ({ stdout: JSON.stringify({ v: 1, id: 'x', ok: false, code }) + '\n', code: 1 }) });
    const nat = createBackend('wsl-nat', { executor: failing.executor, getWslIp: () => '172.20.0.2' });
    const exposed = await nat.expose(3000);
    assert.equal(exposed.state, 'pending_manual', code);
    assert.equal(exposed.error, code);
    assert.ok(exposed.commands.length > 0);
    const mirrored = await createBackend('wsl-mirrored', { executor: failing.executor }).expose(3000);
    assert.equal(mirrored.state, 'pending_manual', code);
    assert.equal(mirrored.error, code);
  }
  const timedOut = createNetdClient({ run: async () => ({ stdout: '', code: 1, timedOut: true }) });
  assert.equal((await createBackend('wsl-nat', { executor: timedOut.executor, getWslIp: () => '172.20.0.2' }).expose(3000)).state, 'pending_manual');
});

test('successful helper calls make the backends active; close treats not_in_state as already gone', async () => {
  const seen = [];
  const netd = createNetdClient({
    run: async (_f, args) => {
      seen.push(args.slice(4).join(' '));
      if (args.includes('close')) return { stdout: '{"v":1,"id":"x","ok":false,"code":"not_in_state"}\n', code: 1 };
      return { stdout: '{"v":1,"id":"x","ok":true,"data":{}}\n', code: 0 };
    },
  });
  const nat = createBackend('wsl-nat', { executor: netd.executor, getWslIp: () => '172.20.0.2' });
  assert.equal((await nat.expose(3000)).state, 'active');
  assert.deepEqual(seen, ['-Op expose -Port 3000'], 'portproxy-add and firewall-add collapse into one expose call');
  assert.equal((await nat.close(3000)).state, 'closed');
});

test('helper status is cached and reports the fallback reason', async () => {
  let calls = 0;
  let t = 1000;
  const netd = createNetdClient({
    now: () => t,
    run: async () => { calls += 1; return { stdout: JSON.stringify({ v: 1, id: 'x', ok: true, data: { version: 1, mode: 'nat', rules: 2 } }) + '\n', code: 0 }; },
  });
  assert.deepEqual(await netd.status(), { state: 'ready', installed: true, version: 1, mode: 'nat', rules: 2 });
  await netd.status();
  assert.equal(calls, 1);
  t += 31_000;
  await netd.status();
  assert.equal(calls, 2);
  const missing = createNetdClient({ run: async () => ({ stdout: '', stderr: 'file does not exist', code: 1 }) });
  assert.deepEqual(await missing.status(), { state: 'helper_missing', installed: false, version: null, mode: null, rules: null });
});

test('net-env report carries the helper status only when a provider is wired on WSL2', async () => {
  const { createNetEnvService } = await import('../lib/net-env/index.js');
  const base = { platform: 'linux', release: '6.6-microsoft-standard-WSL2', procOwners: async () => {}, executor: async () => '' };
  const withHelper = createNetEnvService({ ...base, getHelper: async () => ({ state: 'helper_missing', installed: false }) });
  assert.deepEqual((await withHelper.getReport()).helper, { state: 'helper_missing', installed: false });
  const throwing = createNetEnvService({ ...base, getHelper: async () => { throw new Error('boom'); } });
  assert.equal((await throwing.getReport()).helper.state, 'unavailable');
  assert.equal('helper' in (await createNetEnvService(base).getReport()), false);
  const native = createNetEnvService({ ...base, release: '6.1.0-generic', getHelper: async () => ({ state: 'ready' }) });
  assert.equal('helper' in (await native.getReport()), false);
});
