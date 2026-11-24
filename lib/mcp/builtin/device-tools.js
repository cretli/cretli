/** Device registry and consent-gated host measurement tools. */
import { getDevicesService } from '../../devices/service.js';
import { MCP_DEVICE_TOOL_NAMES as N } from '../mcp-tool-names.js';
import { mcpToolResult } from './result.js';

import { getDeviceRunsService } from '../../devices/runs.js';

let runsOverride;
export function setDeviceRunsToolsService(service) { runsOverride = service; }
const runsSvc = () => runsOverride || getDeviceRunsService();
const retries = new Map();

let serviceOverride = null;
/** @param {any} [service] test override; null restores the shared service. */
export function setDeviceToolsService(service) { serviceOverride = service || null; }
const svc = () => serviceOverride || getDevicesService();

const scopeOf = (ctx) => String(ctx?.workspaceFolder || ctx?.session?.workspaceFolder || '').trim() || undefined;

/** @type {Array<Record<string, any>>} */
export const DEVICE_MCP_TOOLS = [
  {
    name: N.deviceList,
    readOnly: true,
    description: 'List registered test devices (phones and computers): id, name, platform, connection kind, host and port, notes and last known hardware facts. Global devices plus those of this workspace.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const { devices } = svc().list({ workspace: scopeOf(ctx) });
      return mcpToolResult(`${devices.length} device(s) registered.`, { ok: true, devices });
    },
  },
  {
    name: N.deviceStatus,
    readOnly: true,
    description: 'Live status of one device: reachable, asleep, chrome-down, unreachable, adb-missing or timeout, with detail and hardware facts. Read-only; it never launches or changes anything.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Device id from device_list.' } },
      required: ['id'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const id = String(args?.id || '').trim();
      const result = await svc().status(id, { workspace: scopeOf(ctx) });
      if (!result.ok) return mcpToolResult(`${result.error}: ${result.message}`, { ok: false, error: result.error, message: result.message }, true);
      return mcpToolResult(`Device ${id}: ${result.status}.`, result);
    },
  },
];

DEVICE_MCP_TOOLS.push(
  {
    name: N.deviceRun, readOnly: false,
    description: 'Run a trusted workspace .mjs/.cjs measurement script unsandboxed on the host against a private device tab. Requires explicit hash/device consent. Returns consent-pending; retry after answering the chat card. Use id=all for sequential devices.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, scriptPath: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, required: ['id', 'scriptPath'], additionalProperties: false },
    async handler(args, ctx) {
      const workspace = scopeOf(ctx), chatId = String(ctx?.chatId || ctx?.session?.chatId || '');
      if (!chatId) return mcpToolResult('A chat is required for run consent.', { ok: false, error: 'chat-required' }, true);
      const key = JSON.stringify([chatId, workspace, args]);
      let job = retries.get(key);
      if (!job) {
        job = { result: null, error: null };
        const service = runsSvc();
        job.promise = (async () => {
          if (args.id === 'all') return service.all(args, { workspace, chatId });
          const started = await service.start(args.id, args, { workspace, chatId });
          if (started.completion) await started.completion;
          return { ok: started.ok && started.run.status === 'success', run: started.run, error: started.run?.error || started.error };
        })().then((r) => { job.result = r; }, (e) => { job.error = e.message; });
        retries.set(key, job);
      }
      let timer;
      await Promise.race([job.promise, new Promise((resolve) => { timer = setTimeout(resolve, 25000); })]);
      clearTimeout(timer);
      if (job.result || job.error) {
        retries.delete(key);
        const result = job.result || { ok: false, error: job.error };
        return mcpToolResult(result.ok ? 'Measurement finished.' : 'Measurement failed.', result, !result.ok);
      }
      return mcpToolResult('Consent or measurement pending. Answer the card then retry.', { ok: false, error: 'consent-pending', prompts: runsSvc().consent.list(chatId) });
    },
  },
  {
    name: N.deviceRuns, readOnly: true,
    description: 'List workspace measurement history or compare two run ids with per-metric deltas.',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } }, additionalProperties: false },
    async handler(args, ctx) {
      const history = runsSvc().history, workspace = scopeOf(ctx);
      const result = args.before && args.after ? history.compare(args.before, args.after, workspace) : { ok: true, runs: history.list({ workspace, deviceId: args.deviceId }) };
      return mcpToolResult('Device measurement history.', result, !result.ok);
    },
  },
);
