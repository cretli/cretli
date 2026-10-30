/**
 * Builtin Cretli MCP tools for apps and ports: `app_*`, `port_*` and `net_env`.
 *
 * They are thin adapters over the stage 2 apps service (lib/apps) and the stage 3
 * port exposure service (lib/port-exposure); policy, hard blocks and ownership
 * live in those services, so an agent gets the same answers as the UI:
 * - `app_start` / `app_stop` act only on apps from `.cretli/apps.json`; there is
 *   deliberately no tool that ends a foreign process;
 * - `port_expose` owns the exposure as `chat:<id>`; with policy `ask` it parks on
 *   a chat consent card (lib/port-exposure/expose-consent.js);
 * - `port_close` is authorized by the service per chat, so only own exposures close.
 */

import { getAppsService } from '../../apps/runtime.js';
import {
  getExposeConsentRegistry,
  getNetEnvReport,
  getPortExposureService,
} from '../../port-exposure/runtime.js';
import { loadPortExposurePolicy } from '../../port-exposure/policy.js';
import { EXPOSE_CONSENT_TIMEOUT_MS } from '../../port-exposure/expose-consent.js';
import { MCP_APPS_TOOL_NAMES as N } from '../mcp-tool-names.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

const isLoopback = (addr) => /^127\./.test(addr) || addr === '::1' || addr === '[::1]';

/**
 * Overridable collaborators (tests). Defaults are the process-wide runtimes.
 * @type {{
 *   apps: () => any, exposure: () => any, consent: () => any,
 *   report: (opts?: { refresh?: boolean }) => Promise<any>, policy: () => any,
 * }}
 */
const defaultDeps = {
  apps: () => getAppsService(),
  exposure: () => getPortExposureService(),
  consent: () => getExposeConsentRegistry(),
  report: (opts) => getNetEnvReport(opts),
  policy: () => loadPortExposurePolicy(),
};
let deps = { ...defaultDeps };

/** @param {Partial<typeof defaultDeps> | null} [overrides] */
export function setAppsToolsDeps(overrides) {
  deps = { ...defaultDeps, ...(overrides || {}) };
}

const REFUSAL_HINTS = Object.freeze({
  'expose-denied-policy': 'The policy never lets agents expose ports. Ask the user to change it in Settings -> Network.',
  'expose-denied-user': 'The user declined this exposure. Do not retry unless they ask.',
  'expose-consent-timeout': 'The user did not answer in time. Tell the user and retry only if they ask.',
  'consent-limit': 'This chat already has the maximum number of open exposure cards. Wait for the user to answer them.',
  'port-denylisted': 'This port is on the exposure denylist and can never be exposed.',
  'port-out-of-range': 'This port is outside the allowed range. Use port_status to read the range.',
  'port-loopback-only': 'The application listens only on 127.0.0.1. Change its bind address (for example 0.0.0.0) and restart it, then retry.',
});

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, any>} [extra]
 */
function refusal(status, code, message, extra = {}) {
  const hint = REFUSAL_HINTS[code] || '';
  const text = `${code}: ${message}${hint && !message.includes(hint) ? ` ${hint}` : ''}`;
  return mcpToolResult(text, { ok: false, error: code, status, message, ...(hint ? { hint } : {}), ...extra }, true);
}

/** Maps a failed service result to a refusal, keeping its machine code. */
function fromService(result) {
  const { status, error, message, ...rest } = result;
  return refusal(status || 500, error || 'internal-error', message || 'Request failed.', rest);
}

/**
 * @param {any} service
 * @param {string} name
 */
function requireService(service, name) {
  if (!service) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.HARNESS_UNAVAILABLE, `The ${name} service is not running in this process.`);
  }
  return service;
}

/** @param {Record<string, any>} session */
function requireChatId(session) {
  const chatId = String(session?.chatId || '').trim();
  if (!chatId) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'This tool needs a calling chat (it owns the exposure).');
  }
  return chatId;
}

/** @param {unknown} value @param {string} field */
function requirePort(value, field = 'port') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `${field} must be an integer between 1 and 65535.`);
  }
  return port;
}

/** @param {unknown} value */
function requireAppId(value) {
  const id = String(value || '').trim();
  if (!id) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'id is required (an app id from app_list).');
  return id;
}

/** @param {any} entry @param {string} chatId */
function describeEntry(entry, chatId) {
  if (!entry) return null;
  return {
    state: entry.state,
    owner: entry.owner,
    ownedByCaller: entry.owner === `chat:${chatId}`,
    expiresAt: entry.expiresAt || null,
    reason: entry.reason || '',
    ...(entry.commands?.length ? { commands: entry.commands } : {}),
    ...(entry.lastError ? { lastError: entry.lastError } : {}),
  };
}

/** URLs for a port given the report and the ledger entry. LAN is null with a reason when it is not reachable. */
function buildUrls(port, listeners, entry, report) {
  const localUrl = `http://127.0.0.1:${port}`;
  const lanHost = report?.cretli?.lanHost || null;
  const reachable = entry?.state === 'active'
    || (listeners.length > 0 && listeners.some((l) => !isLoopback(l.address)) && report?.platform !== 'wsl2');
  if (!lanHost) return { localUrl, lanUrl: null, lanReason: 'lan-host-unknown' };
  if (!reachable) return { localUrl, lanUrl: null, lanReason: entry ? `exposure-${entry.state}` : 'not-exposed' };
  return { localUrl, lanUrl: `http://${lanHost}:${port}`, lanReason: null };
}

const portSchema = { type: 'integer', minimum: 1, maximum: 65535, description: 'TCP port.' };

/** @type {Array<Record<string, any>>} */
export const APPS_MCP_TOOLS = [
  {
    name: N.appList,
    readOnly: true,
    description: 'List the apps defined in the workspace registry (.cretli/apps.json): id, name, start command, ports and exposure. Use app_status for live state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const result = requireService(deps.apps(), 'apps').list();
      if (!result.ok) return fromService(result);
      return mcpToolResult(`${result.apps.length} app(s) in the registry.`, { ok: true, exists: result.exists, apps: result.apps });
    },
  },
  {
    name: N.appStatus,
    readOnly: true,
    description: 'Live state of registry apps: running or stopped, declared ports with listener and health, and unregistered listeners (orphans, read-only). Optional id narrows to one app.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'App id from app_list.' },
        refresh: { type: 'boolean', description: 'Take a fresh listener snapshot first.' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const report = await requireService(deps.apps(), 'apps').status({ refresh: args?.refresh === true });
      if (!report.ok) return fromService(report);
      const id = String(args?.id || '').trim();
      const apps = id ? report.apps.filter((a) => a.id === id) : report.apps;
      if (id && !apps.length) return refusal(404, 'app-not-found', `No app "${id}" in .cretli/apps.json.`);
      return mcpToolResult(`${apps.length} app(s).`, { ok: true, valid: report.valid, errors: report.errors, apps, orphans: id ? [] : report.orphans });
    },
  },
  {
    name: N.appStart,
    readOnly: false,
    description: 'Start a registry app through its configured task or command (a Cretli task run). Refuses when a declared port is already used by another process.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'App id from app_list.' } },
      required: ['id'],
      additionalProperties: false,
    },
    async handler(args) {
      const result = await requireService(deps.apps(), 'apps').start(requireAppId(args?.id));
      if (!result.ok) return fromService(result);
      return mcpToolResult(`App started (run ${result.runId}).`, { ok: true, runId: result.runId, pid: result.pid, conflictCheck: result.conflictCheck });
    },
  },
  {
    name: N.appStop,
    readOnly: false,
    description: 'Stop a registry app that Cretli started (its own task run). It never ends a foreign process, and it closes the app\'s port exposures.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'App id from app_list.' } },
      required: ['id'],
      additionalProperties: false,
    },
    async handler(args) {
      const result = await requireService(deps.apps(), 'apps').stop(requireAppId(args?.id));
      if (!result.ok) return fromService(result);
      return mcpToolResult('App stopped.', { ok: true, runId: result.runId, pid: result.pid });
    },
  },
  {
    name: N.portStatus,
    readOnly: true,
    description: 'Truth about one port before you give the user a link: is something listening, on which bind, is it exposed to the LAN (and by whom), the local and LAN URL, and the block code if it cannot be exposed. Call this before quoting a LAN URL.',
    inputSchema: { type: 'object', properties: { port: portSchema }, required: ['port'], additionalProperties: false },
    async handler(args, { session }) {
      const port = requirePort(args?.port);
      const chatId = String(session?.chatId || '').trim();
      const svc = requireService(deps.exposure(), 'port exposure');
      const [report, blocked, listing] = await Promise.all([
        deps.report({ refresh: true }).catch(() => null),
        svc.precheck(port),
        svc.list(),
      ]);
      const listeners = (report?.listeners || []).filter((l) => l.port === port);
      const entry = (listing.exposures || []).find((e) => e.port === port) || null;
      const urls = buildUrls(port, listeners, entry, report);
      const policy = deps.policy();
      const structured = {
        ok: true,
        port,
        listening: listeners.length > 0,
        binds: [...new Set(listeners.map((l) => l.address))],
        loopbackOnly: listeners.length > 0 && listeners.every((l) => isLoopback(l.address)),
        exposure: describeEntry(entry, chatId),
        ...urls,
        blockCode: blocked?.error || null,
        blockMessage: blocked?.message || null,
        policy: { agentMode: policy.agentMode, range: policy.range },
      };
      const where = urls.lanUrl ? `LAN ${urls.lanUrl}` : `no LAN URL (${urls.lanReason})`;
      return mcpToolResult(`Port ${port}: ${structured.listening ? 'listening' : 'not listening'}, ${where}${structured.blockCode ? `, blocked: ${structured.blockCode}` : ''}.`, structured);
    },
  },
  {
    name: N.portExpose,
    readOnly: false,
    description: 'Expose a listening port to the LAN for a limited time, owned by this chat. Depending on policy it is allowed, refused, or the user is asked on a card in this chat. On "consent-pending" wait for the user to answer, then call it again. Check port_status first.',
    inputSchema: {
      type: 'object',
      properties: {
        port: portSchema,
        ttl_ms: { type: 'integer', minimum: 60000, description: 'Lifetime in ms; clamped to the policy maximum.' },
        reason: { type: 'string', maxLength: 300, description: 'Why the user needs this port in the LAN.' },
      },
      required: ['port'],
      additionalProperties: false,
    },
    async handler(args, { session }) {
      const port = requirePort(args?.port);
      const chatId = requireChatId(session);
      const svc = requireService(deps.exposure(), 'port exposure');
      const policy = deps.policy();
      if (policy.agentMode === 'never') {
        return refusal(403, 'expose-denied-policy', 'Policy does not let agents expose ports.');
      }
      // Hard blocks come first so the user is never asked about a port that can never be exposed.
      const blocked = await svc.precheck(port);
      if (blocked) return fromService(blocked);
      const ttlMs = args?.ttl_ms === undefined ? undefined : Number(args.ttl_ms);
      const reason = String(args?.reason || '').slice(0, 300);
      if (policy.agentMode === 'ask') {
        const outcome = await deps.consent().request({ chatId, port, ttlMs, reason });
        if (outcome === 'deny') return refusal(403, 'expose-denied-user', `The user declined exposing port ${port}.`);
        if (outcome === 'timeout') return refusal(408, 'expose-consent-timeout', `The user did not answer within ${Math.round(EXPOSE_CONSENT_TIMEOUT_MS / 60000)} minutes.`);
        if (outcome === 'limit') return refusal(429, 'consent-limit', 'Too many exposure cards are waiting in this chat.');
        if (outcome === 'pending') {
          return refusal(409, 'consent-pending', `Waiting for the user to answer the card in this chat. Call port_expose for port ${port} again after they decide.`, { retry: true });
        }
      }
      const result = await svc.expose({ port, ttlMs, reason }, { kind: 'agent', chatId }, { consented: policy.agentMode === 'ask' });
      if (!result.ok) return fromService(result);
      const report = await deps.report().catch(() => null);
      const urls = buildUrls(port, [], result.entry, report);
      const manual = result.entry.state !== 'active';
      return mcpToolResult(
        manual
          ? `Port ${port} exposure recorded but not active yet (${result.entry.state}); the user must run the listed commands.`
          : `Port ${port} exposed${urls.lanUrl ? `: ${urls.lanUrl}` : ''}.`,
        { ok: true, port, exposure: describeEntry(result.entry, chatId), ...urls, commands: result.commands || [] },
      );
    },
  },
  {
    name: N.portClose,
    readOnly: false,
    description: 'Close a port exposure that this chat created. Exposures owned by the user, an app or another chat are refused.',
    inputSchema: { type: 'object', properties: { port: portSchema }, required: ['port'], additionalProperties: false },
    async handler(args, { session }) {
      const port = requirePort(args?.port);
      const chatId = requireChatId(session);
      const result = await requireService(deps.exposure(), 'port exposure').close(port, { kind: 'agent', chatId });
      if (!result.ok) return fromService(result);
      return mcpToolResult(`Port ${port} ${result.closeState === 'closed' ? 'closed' : 'close requested (manual step pending)'}.`, {
        ok: true, port, closeState: result.closeState, commands: result.commands || [],
      });
    },
  },
  {
    name: N.netEnv,
    readOnly: true,
    description: 'Short network environment summary: platform, WSL networking mode, LAN host, bind address, helper state, listener count and detected issues.',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean' } }, additionalProperties: false },
    async handler(args) {
      const report = await deps.report({ refresh: args?.refresh === true });
      const summary = {
        ok: true,
        platform: report.platform,
        networkingMode: report.networkingMode,
        lanHost: report.cretli?.lanHost || null,
        bind: report.cretli?.bind || null,
        lanExposed: Boolean(report.cretli?.lanExposed),
        wslAddresses: report.wslAddresses || [],
        helper: report.helper ? { state: report.helper.state, installed: report.helper.installed } : null,
        listenerCount: (report.listeners || []).length,
        portproxyRules: (report.portproxy || []).length,
        issues: report.issues || [],
        partial: Boolean(report.partial),
      };
      return mcpToolResult(`${summary.platform}${summary.networkingMode ? `/${summary.networkingMode}` : ''}, ${summary.listenerCount} listener(s), ${summary.issues.length} issue(s).`, summary);
    },
  },
];
