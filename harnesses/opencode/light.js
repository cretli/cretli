/**
 * Light entry of the OpenCode plugin: backend (status, settings), MCP adapter and
 * the version-table row. Must not import room-kernel or the providers module; the
 * runtime lives in heavy.js and the process hook in lifecycle.js.
 */

import path from 'node:path';
import { isInsideDirectory } from '../../lib/harness-versions.js';
import { hasOpenCodeCredentials } from './opencode-api-key.js';
import { resolveOpenCodeExecutable, resolveOpenCodeHomeDirs } from './opencode-spawn-path.js';
import * as opencodeSettings from './opencode-settings.js';
import { opencodeMcpAdapter } from './opencode-adapter.js';

/**
 * OpenCode resolves an executable path (project node_modules, ~/.opencode/bin or
 * a configured binary). A path inside Cretli's own tree stays bundled.
 *
 * @param {any} context
 * @returns {{ source: string, bin: string }}
 */
function resolveOpenCodeCliSource(context) {
  const configuredBin = typeof context.settings?.opencodeBin === 'string'
    ? context.settings.opencodeBin.trim()
    : '';
  const homeDirs = Array.isArray(context.homeDirs)
    ? context.homeDirs
    : resolveOpenCodeHomeDirs(context.openCodeHomeDirs || {});
  const executable = resolveOpenCodeExecutable({
    configuredBin,
    homeDirs,
    projectRoot: context.projectRoot,
  });
  if (!executable) return { source: 'missing', bin: '' };
  if (configuredBin && path.resolve(executable) === path.resolve(configuredBin)) {
    return { source: 'settings', bin: executable };
  }
  if (isInsideDirectory(executable, path.join(context.projectRoot, 'node_modules'))) {
    return { source: 'bundled', bin: executable };
  }
  return { source: 'path', bin: executable };
}

export default {
  backend: {
    id: 'opencode',
    // Keeps its pre-plugin place in the list: before CodeBuddy / DeepSeek, else before Codex.
    insertBefore: ['codebuddy', 'deepseek', 'codex'],
    settings: opencodeSettings,
    enabledModelsKey: 'opencodeChatEnabledModels',
    credentialsReadySync: () => hasOpenCodeCredentials(),
    offlineCatalog: null,
    async status() {
      return { available: true, configured: hasOpenCodeCredentials() };
    },
    // OpenCode needs a live server instance bound to a workspace folder; the
    // shared catalog read path cannot hold that context.
    refreshModels: null,
    notRefreshableReason: 'requires a live OpenCode workspace',
    refreshIsNetworkInference: false,
  },
  mcpAdapter: opencodeMcpAdapter,
  versions: {
    insertBefore: ['codebuddy', 'deepseek', 'codex'],
    cliSource: resolveOpenCodeCliSource,
    spec: {
      harness: 'opencode',
      channel: 'npm',
      packages: [
        { name: '@opencode-ai/sdk', role: 'sdk' },
        { name: 'opencode-ai', role: 'cli', cli: true, bin: 'opencode' },
      ],
    },
  },
};
