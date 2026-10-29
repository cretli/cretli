/**
 * Node mirror of the pure rules in scripts/windows/cretli-netd-common.ps1.
 *
 * The PowerShell side is the enforcement point; this module pins the same
 * constants and decisions so CI (which has no Windows, no netsh and no pipe) can
 * test them, and so the adapter rejects a bad request before it spawns anything.
 * tests/netd-helper.test.js compares both sides.
 */

import { FIREWALL_PROFILE, FIREWALL_REMOTE, WSL_VM_CREATOR_ID } from './commands.js';
import { DEFAULT_DENYLIST } from './policy.js';

export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 4096;
export const PIPE_PATH = '\\\\.\\pipe\\cretli-netd';
export const OPS = Object.freeze(['status', 'list', 'expose', 'close', 'reconcile']);
export const PORT_OPS = Object.freeze(['expose', 'close']);
export const ALLOWED_FIELDS = Object.freeze(['v', 'id', 'op', 'port']);

export const SID_SYSTEM = 'S-1-5-18';
export const SID_ADMINISTRATORS = 'S-1-5-32-544';
export const SID_NETWORK = 'S-1-5-2';

/** FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE. */
export const PIPE_USER_ACCESS = 0x00120083;
export const FILE_APPEND_DATA = 0x4;
export const WRITE_DAC = 0x40000;
export const WRITE_OWNER = 0x80000;
export const GENERIC_BITS = 0xF0000000;

/** Ports the helper refuses whatever the configuration says. */
export const BUILTIN_DENYLIST = Object.freeze([...DEFAULT_DENYLIST].sort((a, b) => a - b));

export const RULE_PREFIX = 'Cretli netd';
export const RULE_TOKEN_PATTERN = /^cretli-netd:(\d+):[0-9a-f]{32}$/;
export const RULE_SPEC = Object.freeze({
  firewall: Object.freeze({ Enabled: 'True', Direction: 'Inbound', Action: 'Allow', Protocol: 'TCP',
    RemotePort: 'Any', LocalAddress: 'Any', RemoteAddress: 'LocalSubnet', Profile: 'Private,Domain',
    InterfaceType: 'Any', InterfaceAlias: 'Any', EdgeTraversalPolicy: 'Block', Program: 'Any', Service: 'Any',
    Package: '', Owner: '', PolicyStoreSource: 'PersistentStore', PolicyStoreSourceType: 'Local' }),
  hyperV: Object.freeze({ Enabled: 'True', Direction: 'Inbound', Action: 'Allow', Protocol: 'TCP',
    RemotePorts: 'Any', LocalAddresses: 'Any', RemoteAddresses: 'LocalSubnet', Profiles: 'Private,Domain',
    PolicyStoreSourceType: 'Local', VMCreatorId: WSL_VM_CREATOR_ID }),
});
export const HELPER_FIREWALL_PROFILE = FIREWALL_PROFILE;
export const HELPER_FIREWALL_REMOTE = FIREWALL_REMOTE;

/** Codes that make Cretli fall back to `manual`; every failure does, these are the named ones. */
export const FALLBACK_CODES = Object.freeze([
  'timeout', 'helper_missing', 'helper_unavailable', 'helper_busy', 'server_untrusted',
  'client_untrusted', 'no_user_session', 'validation', 'bad_response',
]);

const hex8 = (n) => n.toString(16).toUpperCase().padStart(8, '0');

/** @param {string} userSid */
export function buildPipeSddl(userSid) {
  return `O:SYD:P(D;;0x001F01FF;;;NU)(A;;0x001F01FF;;;SY)(A;;0x${hex8(PIPE_USER_ACCESS)};;;${userSid})`;
}

/**
 * Parses the SDDL produced by `buildPipeSddl` (owner plus a flat ACE list).
 * @param {string} sddl
 */
export function parseSddl(sddl) {
  const owner = /^O:([A-Z0-9-]+?)D:/.exec(sddl)?.[1] || null;
  const aces = [...sddl.matchAll(/\(([AD]);;(0x[0-9A-Fa-f]+);;;([A-Z0-9-]+)\)/g)]
    .map((m) => ({ type: m[1] === 'A' ? 'allow' : 'deny', mask: Number(m[2]), trustee: m[3] }));
  return { owner, protectedDacl: /D:P/.test(sddl), aces };
}

/**
 * @param {any} port
 * @param {{ range: { min: number, max: number }, denylist?: number[] }} config
 * @returns {string|null} stable error code or null
 */
export function checkPort(port, config) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'bad_port';
  if (BUILTIN_DENYLIST.includes(port) || (config.denylist || []).includes(port)) return 'port_denylisted';
  if (port < config.range.min || port > config.range.max) return 'port_out_of_range';
  return null;
}

/**
 * Strict request validation, equal to `Test-NetdRequest`.
 * @param {string} text
 * @param {{ range: { min: number, max: number }, denylist?: number[] }} config
 * @returns {{ ok: boolean, code: string|null, request: any }}
 */
export function validateRequest(text, config) {
  const fail = (code) => ({ ok: false, code, request: null });
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) return fail('too_large');
  let req;
  try { req = JSON.parse(text); } catch { return fail('bad_json'); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return fail('bad_json');
  const names = Object.keys(req);
  if (names.some((n) => !ALLOWED_FIELDS.includes(n))) return fail('unknown_field');
  if (['v', 'id', 'op'].some((n) => !names.includes(n))) return fail('bad_request');
  if (!Number.isInteger(req.v) || req.v !== PROTOCOL_VERSION) return fail('bad_version');
  if (typeof req.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(req.id)) return fail('bad_request');
  if (typeof req.op !== 'string' || !OPS.includes(req.op)) return fail('unknown_op');
  if (PORT_OPS.includes(req.op)) {
    if (!names.includes('port')) return fail('bad_port');
    const code = checkPort(req.port, config);
    if (code) return fail(code);
  } else if (names.includes('port')) return fail('unknown_field');
  return { ok: true, code: null, request: req };
}

/**
 * Client-side trust decision about the pipe server (`Test-NetdServerIdentity`).
 * The owner is the trust boundary; the image path is an additional hint.
 * @param {{ ownerSid?: string|null, imagePath?: string|null, systemRoot?: string|null, error?: string|null }} input
 */
export function isServerTrusted({ ownerSid, imagePath, systemRoot, error }) {
  if (error) return false;
  if (ownerSid !== SID_SYSTEM && ownerSid !== SID_ADMINISTRATORS) return false;
  if (!imagePath || !systemRoot) return false;
  const expected = `${systemRoot.replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return imagePath.toLowerCase() === expected.toLowerCase();
}

const valueSet = (value) => [...new Set([].concat(value ?? []).flatMap((v) => String(v).split(/[,\s]+/)).filter(Boolean).map((v) => v.toLowerCase()))].sort().join(',');
const eqi = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Ownership of a firewall rule is judged on the live rule, not on its recorded Name alone
 * (`Test-NetdFirewallRuleOwned`): Inbound, Allow, TCP, the port, Private+Domain only,
 * LocalSubnet, and the recorded name and display name.
 * @param {{ Name: string, DisplayName: string, Direction: string, Action: string, Protocol: string, LocalPort: any, Profile: any, RemoteAddress: any } | null | undefined} facts
 * @param {number} port
 * @param {string} name
 */
function isRuleOwned(facts, port, name, token, kind) {
  if (!facts || typeof token !== 'string' || !RULE_TOKEN_PATTERN.test(token)
    || Number(RULE_TOKEN_PATTERN.exec(token)[1]) !== port) return false;
  const expected = { ...RULE_SPEC[kind], Name: name, DisplayName: `${RULE_PREFIX} ${port}`,
    Description: token, LocalPort: String(port) };
  if (kind === 'hyperV') {
    delete expected.Description;
    if (name !== `Cretli-netd-${port}-${token.split(':').at(-1)}`) return false;
  }
  if (Object.keys(facts).length !== Object.keys(expected).length) return false;
  return Object.entries(expected).every(([key, value]) => Object.hasOwn(facts, key)
    && (['Name', 'DisplayName', 'Description'].includes(key)
      ? facts[key] === value : valueSet(facts[key]) === valueSet(value)));
}

export function isFirewallRuleOwned(facts, port, name, token) {
  return isRuleOwned(facts, port, name, token, 'firewall');
}

export function isHyperVRuleOwned(facts, port, name, token) {
  return isRuleOwned(facts, port, name, token, 'hyperV');
}

/**
 * A portproxy endpoint is ours only while its current values equal the ledger
 * record (`Test-NetdProxyOwned`). No record or different values means foreign.
 * @param {{ proxy?: { connectAddress: string, connectPort: number } }} entry
 * @param {{ listenAddress: string, connectAddress: string, connectPort: number } | null | undefined} observed
 */
export function isProxyOwned(entry, observed) {
  if (!observed || !entry?.proxy) return false;
  return observed.listenAddress === '0.0.0.0'
    && observed.connectAddress === entry.proxy.connectAddress
    && observed.connectPort === entry.proxy.connectPort;
}

/**
 * Whether `expose` must refuse with `port_in_use_foreign` (`Test-NetdForeignConflict`, NAT mode):
 * an endpoint on 0.0.0.0:port the ledger does not prove, a firewall rule with the shared display
 * name whose Name the ledger does not record, or a rule under the recorded Name whose live spec differs.
 * @param {{ port?: number, proxy?: any, firewallName?: string, firewallToken?: string } | null} entry
 * @param {{ proxy: any, firewallRuleNames: string[], recordedRule?: any }} observed `recordedRule` = live facts of the recorded Name
 */
export function hasForeignConflict(entry, observed) {
  if (observed.proxy && !isProxyOwned(entry || {}, observed.proxy)) return true;
  if (observed.firewallRuleNames.some((name) => name !== (entry?.firewallName || ''))) return true;
  return Boolean(entry?.firewallName && observed.recordedRule && !isFirewallRuleOwned(observed.recordedRule, /** @type {number} */ (entry.port), entry.firewallName, entry.firewallToken));
}

/**
 * What `-Uninstall` removes: only objects the ledger records, and only while the live object
 * still matches its record. Everything else is reported in `keep`.
 * @param {{ rules: { port: number, proxy?: any, firewallName?: string, firewallToken?: string, hyperVName?: string, hyperVToken?: string }[] }} state
 * @param {any[]} existingRules firewall rule facts
 * @param {any[]} [observedProxies]
 * @param {any[]} [existingHyperVRules] Hyper-V rule facts
 */
export function planUninstall(state, existingRules, observedProxies = [], existingHyperVRules = []) {
  const find = (list, name) => list.find((r) => r.Name === name);
  const remove = state.rules.filter((r) => r.firewallName && isFirewallRuleOwned(find(existingRules, r.firewallName), r.port, r.firewallName, r.firewallToken)).map((r) => r.firewallName);
  const hyperV = state.rules.filter((r) => r.hyperVName && isHyperVRuleOwned(find(existingHyperVRules, r.hyperVName), r.port, r.hyperVName, r.hyperVToken)).map((r) => r.hyperVName);
  return {
    ports: state.rules.map((r) => r.port),
    proxyPorts: state.rules
      .filter((r) => isProxyOwned(r, observedProxies.find((o) => o.listenPort === r.port && o.listenAddress === '0.0.0.0')))
      .map((r) => r.port),
    hyperV,
    remove,
    keep: [...existingRules, ...existingHyperVRules].map((r) => r.Name).filter((n) => !remove.includes(n) && !hyperV.includes(n)),
  };
}
