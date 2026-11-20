/**
 * Constructor / thread options for @openai/codex-sdk.
 */

import { getCodexAuthMode } from './codex-auth-mode.ts';
import { buildCodexProcessEnv } from './codex-api-key.ts';
import { isCodexCliFound, resolveCodexCli } from './codex-cli.ts';
import { buildCodexConfigObject, resolveCodexCompactionConfig } from './codex-compaction-config.ts';
import { ensureCodexHomeDir } from './codex-home.ts';
import { resolveCodexModelSelection, type CodexReasoningEffort } from './codex-models.ts';
import { isCodexReviewSandboxEnabled } from './codex-review-sandbox.ts';

/**
 * Linux workspace-write uses bwrap and always carves out cwd/.git. When cwd is
 * not a git repo (typical Cretli workspace folder), bwrap fails with
 * `Can't mkdir <cwd>/.git: Permission denied` and every command (ls, rg) dies
 * before it starts. Headless Cretli already uses approvalPolicy never; Plan mode
 * still has the prompt hint plus sdk-plan-guard.
 *
 * `read-only` does not hit that carve-out: on codex-cli 0.160 it reads and
 * blocks writes in a git repo, a git worktree and a plain directory alike. It
 * is used for Scout scans, plan mode and review delegations, where it is the hard write
 * block that certifies Codex reviews (`sandboxReadOnly` in
 * lib/delegation-adapter-capabilities.js). It also blocks /tmp, so a Codex
 * reviewer cannot run `node scripts/review-verify.js`; the parent verifies.
 *
 * @see https://github.com/openai/codex/issues/37318
 */
const CODEX_SANDBOX_MODE = 'danger-full-access';
const CODEX_READ_ONLY_SANDBOX_MODE = 'read-only';

export interface CodexClientOptions {
  apiKey?: string;
  env: Record<string, string>;
  codexPathOverride?: string;
  config?: Record<string, number>;
  threadOptions: {
    workingDirectory: string;
    skipGitRepoCheck: true;
    model: string;
    modelReasoningEffort?: CodexReasoningEffort;
    sandboxMode: 'danger-full-access' | 'read-only';
    approvalPolicy: 'never';
  };
}

export function buildCodexClientOptions(input: {
  cwd: string;
  model?: string;
  sdkMode?: string;
  scoutReadOnly?: boolean;
  reviewReadOnly?: boolean;
  env?: Record<string, string | undefined>;
}): CodexClientOptions {
  // `input.env` is the resolved delegation env (workspace-scoped); process.env when omitted.
  const cwd = String(input?.cwd || '').trim();
  const selection = resolveCodexModelSelection(input?.model);
  const env = buildCodexProcessEnv();
  env.CODEX_HOME = ensureCodexHomeDir();
  const options: CodexClientOptions = {
    env,
    threadOptions: {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      model: selection.model,
      sandboxMode: input?.scoutReadOnly === true
        || input?.sdkMode === 'plan'
        || (input?.reviewReadOnly === true && isCodexReviewSandboxEnabled(input.env))
        ? CODEX_READ_ONLY_SANDBOX_MODE
        : CODEX_SANDBOX_MODE,
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
  // Opt-in Codex `--config` compaction overrides. Empty by default, so Codex
  // keeps its model-derived trigger.
  const codexConfig = buildCodexConfigObject(resolveCodexCompactionConfig());
  if (Object.keys(codexConfig).length > 0) {
    options.config = codexConfig;
  }
  return options;
}
