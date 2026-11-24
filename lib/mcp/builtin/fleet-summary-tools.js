/** Read-only, allowlisted instance counters for external fleet coordinators. */

import { getWorkspaceWatcher, getWorkspaceWatcherActiveCycles } from '../../persist/workspace-watchers-persist.js';
import { listTodos } from '../../persist/todos-store.js';
import { readHarnessPlanLimits } from '../../usage/harness-health.ts';
import { getBuiltinMcpRuntimeDeps } from './runtime-deps.js';
import { resolveDataPath } from '../../runtime-paths.js';
import { mcpToolResult } from './result.js';

function dataDir() {
  return String(getBuiltinMcpRuntimeDeps().dataDir || '').trim() || resolveDataPath();
}

function providerUsage(rows) {
  const latest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const provider = String(row?.harness || '').trim();
    const percent = Number(row?.utilization);
    if (provider && Number.isFinite(percent) && percent >= 0 && percent <= 100 && !latest.has(provider)) {
      latest.set(provider, percent);
    }
  }
  return Object.fromEntries([...latest.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, utilizationPercent]) => [provider, { utilizationPercent, limitPercent: 100 }]));
}

function countBlockedBackoff(blockedBackoff, now = Date.now()) {
  if (!blockedBackoff || typeof blockedBackoff !== 'object' || Array.isArray(blockedBackoff)) return 0;
  return Object.values(blockedBackoff).filter((entry) => {
    const until = Date.parse(String(entry?.until ?? ''));
    return Number.isFinite(until) && until > now;
  }).length;
}

export const FLEET_SUMMARY_MCP_TOOLS = Object.freeze([{
  name: 'fleet_summary',
  readOnly: true,
  description: 'Return an allowlisted, counters-only summary of this Cretli instance: online state, active Workspace Watcher cycles, blocked todos, plans awaiting approval, and provider usage percentages. No titles, paths, chat content, hostnames, or identifiers are returned.',
  inputSchema: { type: 'object', properties: {} },
  async handler(_args, { session }) {
    const folder = String(session?.workspaceFolder || '').trim();
    const dir = dataDir();
    const [watcher, todos] = await Promise.all([
      Promise.resolve(getWorkspaceWatcher(folder, { dataDir: dir })),
      listTodos(dir, folder),
    ]);
    const items = Array.isArray(todos?.items) ? todos.items : [];
    const activeCycles = getWorkspaceWatcherActiveCycles(watcher || {});
    const limits = readHarnessPlanLimits('', { dataDir: dir });
    const result = {
      schemaVersion: 1,
      instance: { online: true },
      activeWatcherCycles: Array.isArray(activeCycles) ? activeCycles.length : 0,
      blockedTodos: countBlockedBackoff(watcher?.blockedBackoff),
      plansAwaitingApproval: items.filter((item) => item?.plan?.markdown && !item?.plan?.approvedAt).length,
      providerUsage: providerUsage(limits),
    };
    return mcpToolResult(JSON.stringify(result, null, 2), result);
  },
}]);
