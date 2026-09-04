/**
 * Constructor / thread options for @openai/codex-sdk.
 */

import { getCodexAuthMode } from './codex-auth-mode.js';
import { buildCodexProcessEnv } from './codex-api-key.js';
import { isCodexCliFound, resolveCodexCli } from './codex-cli.js';
import { ensureCodexHomeDir } from './codex-home.js';
import { resolveCodexModelSelection } from './codex-models.js';

/**
 * Linux workspace-write/read-only uses bwrap and always carves out cwd/.git.
 * When cwd is not a git repo (typical Cretli workspace folder), bwrap fails with
 * `Can't mkdir <cwd>/.git: Permission denied` and every command (ls, rg) dies
 * before it starts. Headless Cretli already uses approvalPolicy never; Plan mode
 * still has the prompt hint plus sdk-plan-guard.
 *
 * @see https://github.com/openai/codex/issues/37318
 */
const CODEX_SANDBOX_MODE = 'danger-full-access';

/**
 * @param {{ cwd: string, model?: string, sdkMode?: string }} input
 * @returns {{
 *   apiKey?: string,
 *   env: Record<string, string>,
 *   codexPathOverride?: string,
 *   threadOptions: {
 *     workingDirectory: string,
 *     skipGitRepoCheck: true,
 *     model: string,
 *     modelReasoningEffort?: string,
 *     sandboxMode: 'danger-full-access',
 *     approvalPolicy: 'never',
 *   },
 * }}
 */
export function buildCodexClientOptions(input) {
  const cwd = String(input?.cwd || '').trim();
  const selection = resolveCodexModelSelection(input?.model);
  const env = buildCodexProcessEnv();
  env.CODEX_HOME = ensureCodexHomeDir();
  /** @type {{ apiKey?: string, env: Record<string, string>, codexPathOverride?: string, threadOptions: { workingDirectory: string, skipGitRepoCheck: true, model: string, modelReasoningEffort?: string, sandboxMode: 'danger-full-access', approvalPolicy: 'never' } }} */
  const options = {
    env,
    threadOptions: {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      model: selection.model,
      sandboxMode: CODEX_SANDBOX_MODE,
      approvalPolicy: 'never',
    },
  };
  if (getCodexAuthMode() === 'api-key' && env.CODEX_API_KEY) {
    options.apiKey = env.CODEX_API_KEY;
  }
  if (selection.modelReasoningEffort) {
    options.threadOptions.modelReasoningEffort = selection.modelReasoningEffort;
  }
  const cli = resolveCodexCli();
  if (isCodexCliFound() && cli && cli !== 'codex') {
    options.codexPathOverride = cli;
  }
  return options;
}
