/**
 * Host-owned review verification.
 *
 * Trust model: review does not run arbitrary tests or node flags. The only
 * allowed verification is this runner, with a frozen catalog of audited
 * files. The runner isolates Cretli data dirs and uses a temp cwd so a
 * catalog file cannot write onto the live project `data/` tree. Adding a
 * catalog id requires a human audit that the file does not mutate the
 * workspace. Unknown ids, reporter flags, and extra paths are rejected
 * before spawn.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REVIEW_VERIFY_SCRIPT = 'scripts/review-verify.js';
export const REVIEW_VERIFY_TIMEOUT_MS = 60000;

/**
 * Audited directories a generated manifest may add ids from. Only files named
 * `<id>.test.js` directly inside one of these repo-relative dirs are eligible.
 * The curated `REVIEW_VERIFY_CATALOG` stays authoritative and always wins a
 * name collision, so a human-audited entry can never be shadowed by a new file.
 *
 * @type {readonly string[]}
 */
export const REVIEW_VERIFY_AUDIT_DIRS = Object.freeze(['tests']);

/** Manifest files are written under the OS temp dir, never the project `data/`. */
export const REVIEW_VERIFY_MANIFEST_DIR = 'cretli-review-verify';

/**
 * Audited catalog: incident unit tests that only assert in-memory helpers.
 * Keys are the only ids an agent may pass. Values are repo-relative files.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const REVIEW_VERIFY_CATALOG = Object.freeze({
  'mcp-chat-history-format': 'tests/mcp-chat-history-format.test.js',
  'sdk-history-stream-coalesce': 'tests/sdk-history-stream-coalesce.test.js',
  'sdk-assistant-block-reuse': 'tests/sdk-assistant-block-reuse.test.js',
  'delegation-contract': 'tests/delegation-contract.test.js',
  'delegation-wait': 'tests/delegation-wait.test.js',
  'delegation-executor': 'tests/delegation-executor.test.js',
  'model-role-profiles': 'tests/model-role-profiles.test.js',
  'model-pick-rotation': 'tests/model-pick-rotation.test.js',
  'model-pick-observed': 'tests/model-pick-observed.test.js',
  'model-stats': 'tests/model-stats.test.js',
  'harness-diagnostics-ui': 'tests/harness-diagnostics-ui.test.js',
  'timeout-progress-series': 'tests/timeout-progress-series.test.js',
  'notices': 'tests/notices.test.js',
  'claude-event-normalizer': 'tests/claude-event-normalizer.test.js',
  'chat-list-load-scope-guard': 'tests/chat-list-load-scope-guard.test.js',
  'chat-local-boot-sync': 'tests/chat-local-boot-sync.test.js',
  'chat-metadata-cross-tab': 'tests/chat-metadata-cross-tab.test.js',
  'chat-metadata-idb': 'tests/chat-metadata-idb.test.js',
  'chat-pending-remote-history': 'tests/chat-pending-remote-history.test.js',
  'chat-history-replay-lifecycle': 'tests/chat-history-replay-lifecycle.test.js',
  'chat-history-replay-async-loop': 'tests/chat-history-replay-async-loop.test.js',
  'chat-history-replay-integration': 'tests/chat-history-replay-integration.test.js',
  'chat-history-replay-cancel': 'tests/chat-history-replay-cancel.test.js',
  'chat-history-replay-coverage': 'tests/chat-history-replay-coverage.test.js',
  'chat-history-replay-time-budget': 'tests/chat-history-replay-time-budget.test.js',
  'chat-history-replay-viewport-geometry': 'tests/chat-history-replay-viewport-geometry.test.js',
  'chat-history-hydration-live': 'tests/chat-history-hydration-live.test.js',
  'chat-history-view-apply': 'tests/chat-history-view-apply.test.js',
  'sdk-history-turn-window': 'tests/sdk-history-turn-window.test.js',
  'sdk-history-long-turn-window': 'tests/sdk-history-long-turn-window.test.js',
  'sdk-plan-text': 'tests/sdk-plan-text.test.js',
  'delegation-report-e2e-legacy-payload': 'tests/delegation-report-e2e-legacy-payload.test.js',
  'ui-freeze-render-budgets': 'tests/ui-freeze-render-budgets.test.js',
  'chat-session-boundary': 'tests/chat-session-boundary.test.js',
  'monitoring-archive-qualification': 'tests/monitoring-archive-qualification.test.js',
  'sidebar-archive-virtual-a11y': 'tests/sidebar-archive-virtual-a11y.test.js',
  'sidebar-archive-virtualizer': 'tests/sidebar-archive-virtualizer.test.js',
  'sidebar-chat-drag-block': 'tests/sidebar-chat-drag-block.test.js',
  'sidebar-lit-migration-contract': 'tests/sidebar-lit-migration-contract.test.js',
  'sidebar-swipe': 'tests/sidebar-swipe.test.js',
  'chat-list-resume-sync': 'tests/chat-list-resume-sync.test.js',
  'chat-resume-policy': 'tests/chat-resume-policy.test.js',
  'todos-persist': 'tests/todos-persist.test.js',
  'todo-source-chat': 'tests/todo-source-chat.test.js',
  'todo-tools': 'tests/todo-tools.test.js',
  'todo-ref': 'tests/todo-ref.test.js',
  'todo-tree-view': 'tests/todo-tree-view.test.js',
  'todo-claims': 'tests/todo-claims.test.js',
  'todos-routes': 'tests/todos-routes.test.js',
  'workspace-memory': 'tests/workspace-memory.test.js',
  'workspace-watcher': 'tests/workspace-watcher.test.js',
  'workspace-watcher-events': 'tests/workspace-watcher-events.test.js',
  'workspace-watcher-routes': 'tests/workspace-watcher-routes.test.js',
  'workspace-watcher-live': 'tests/workspace-watcher-live.test.js',
  'workspace-watcher-stats': 'tests/workspace-watcher-stats.test.js',
  'workspace-watcher-panel-ui': 'tests/workspace-watcher-panel-ui.test.js',
  'workspace-watcher-dashboard-ui': 'tests/workspace-watcher-dashboard-ui.test.js',
  'workspace-watcher-pinned-chat': 'tests/workspace-watcher-pinned-chat.test.js',
  'watcher-pinned-chat-ui': 'tests/watcher-pinned-chat-ui.test.js',
  'workspace-watcher-badge-ui': 'tests/workspace-watcher-badge-ui.test.js',
  'workspace-watcher-scout': 'tests/workspace-watcher-scout.test.js',
  'agent-presence-bus': 'tests/agent-presence-bus.test.js',
  'ui-freeze-counters': 'tests/ui-freeze-counters.test.js',
});

export const REVIEW_VERIFY_IDS = Object.freeze(Object.keys(REVIEW_VERIFY_CATALOG));

/**
 * @param {unknown} projectRoot
 * @returns {string}
 */
function auditDirSignature(projectRoot) {
  const parts = [];
  for (const rel of REVIEW_VERIFY_AUDIT_DIRS) {
    try {
      const stat = fs.statSync(path.join(projectRoot, rel));
      parts.push(`${rel}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${rel}:-`);
    }
  }
  return parts.join('|');
}

/**
 * @param {unknown} projectRoot
 * @returns {string}
 */
function reviewVerifyManifestPath(projectRoot) {
  const hash = createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), REVIEW_VERIFY_MANIFEST_DIR, `${hash}.json`);
}

/**
 * Scan the audited directories for `<id>.test.js` files. Pure filesystem read,
 * no cache; callers that need the merged view use `resolveReviewVerifyCatalog`.
 *
 * @param {{ projectRoot?: string }} [input]
 * @returns {{
 *   generatedAt: string,
 *   projectRoot: string,
 *   auditDirs: string[],
 *   entries: Record<string, string>,
 * }}
 */
export function generateReviewVerifyManifest(input = {}) {
  const projectRoot = resolveReviewVerifyProjectRoot(input.projectRoot);
  /** @type {Record<string, string>} */
  const entries = {};
  for (const rel of REVIEW_VERIFY_AUDIT_DIRS) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(projectRoot, rel));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.test.js')) continue;
      const id = name.slice(0, -'.test.js'.length);
      if (!id || id.includes('/') || id.includes('\\')) continue;
      entries[id] = `${rel}/${name}`;
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    projectRoot,
    auditDirs: [...REVIEW_VERIFY_AUDIT_DIRS],
    entries,
  };
}

/** @type {{ key: string, signature: string, catalog: Record<string, string> | null, meta: object | null }} */
let reviewVerifyCatalogCache = { key: '', signature: '', catalog: null, meta: null };

/**
 * Merged catalog: generated audited entries plus the curated catalog, which
 * wins id collisions. Regenerated when an audited dir mtime/size changes, so a
 * test file added during a flow becomes a valid id without a server restart.
 *
 * @param {unknown} [projectRoot]
 * @param {{ refresh?: boolean }} [options]
 * @returns {Record<string, string>}
 */
export function resolveReviewVerifyCatalog(projectRoot, options = {}) {
  const root = resolveReviewVerifyProjectRoot(projectRoot);
  const signature = auditDirSignature(root);
  if (
    options.refresh !== true
    && reviewVerifyCatalogCache.key === root
    && reviewVerifyCatalogCache.signature === signature
    && reviewVerifyCatalogCache.catalog
  ) {
    return reviewVerifyCatalogCache.catalog;
  }
  const manifest = generateReviewVerifyManifest({ projectRoot: root });
  /** Curated entries win: a human audit is never shadowed by a new file. */
  const catalog = { ...manifest.entries, ...REVIEW_VERIFY_CATALOG };
  let manifestPath = '';
  try {
    manifestPath = reviewVerifyManifestPath(root);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch {
    // Best effort: the manifest is an audit artifact, not a runtime dependency.
    manifestPath = '';
  }
  reviewVerifyCatalogCache = {
    key: root,
    signature,
    catalog,
    meta: {
      generatedAt: manifest.generatedAt,
      projectRoot: root,
      auditDirs: manifest.auditDirs,
      curatedCount: REVIEW_VERIFY_IDS.length,
      generatedCount: Object.keys(manifest.entries).length,
      manifestPath,
    },
  };
  return catalog;
}

/**
 * Metadata for the last resolved dynamic catalog (audit/debug surface).
 *
 * @param {unknown} [projectRoot]
 * @returns {object | null}
 */
export function describeReviewVerifyCatalog(projectRoot) {
  resolveReviewVerifyCatalog(projectRoot);
  return reviewVerifyCatalogCache.meta ? { ...reviewVerifyCatalogCache.meta } : null;
}

/**
 * Repo-relative path globs → catalog ids (integration 8.2). Reviewers run
 * `node scripts/review-verify.js <id>` when diffs touch matching paths.
 *
 * @type {ReadonlyArray<{ pattern: string, ids: readonly string[] }>}
 */
export const REVIEW_VERIFY_PATH_SELECTORS = Object.freeze([
  {
    pattern: 'app_front/features/chat/chatMetadataIdb*.js',
    ids: ['chat-metadata-idb', 'chat-metadata-cross-tab', 'chat-session-boundary'],
  },
  {
    pattern: 'app_front/features/chat/chatMetadataCrossTab.js',
    ids: ['chat-metadata-cross-tab'],
  },
  {
    pattern: 'app_front/features/chat/chatSessionBoundary.js',
    ids: ['chat-session-boundary', 'chat-metadata-cross-tab'],
  },
  {
    pattern: 'app_front/features/chat/chatLocalBootLegacyMigration.js',
    ids: ['chat-local-boot-sync'],
  },
  {
    pattern: 'app_front/features/chat/chatLocalBoot*.js',
    ids: ['chat-local-boot-sync', 'ui-freeze-counters'],
  },
  {
    pattern: 'app_front/features/chat/chatResumePolicy.js',
    ids: ['chat-resume-policy'],
  },
  {
    pattern: 'app_front/features/chat/chatListResumeSync.js',
    ids: ['chat-list-resume-sync', 'chat-resume-policy'],
  },
  {
    pattern: 'app_front/lib/pageResumeCleanup.js',
    ids: ['chat-resume-policy', 'chat-list-resume-sync'],
  },
  {
    pattern: 'app_front/features/chat/chatListLoadFreshness.js',
    ids: ['chat-list-load-scope-guard'],
  },
  {
    pattern: 'app_front/features/chat/chatController.js',
    ids: ['chat-list-load-scope-guard', 'chat-pending-remote-history'],
  },
  {
    pattern: 'app_front/features/chat/chatPendingRemoteHistoryFlag.js',
    ids: ['chat-pending-remote-history', 'ui-freeze-counters'],
  },
  {
    pattern: 'app_front/features/chat/chatHistorySyncPoll.js',
    ids: ['chat-pending-remote-history', 'ui-freeze-counters'],
  },
  {
    pattern: 'app_front/features/chat/chatBackgroundPolicy.js',
    ids: ['monitoring-archive-qualification', 'ui-freeze-counters'],
  },
  {
    pattern: 'app_front/features/sidebar/sidebarArchive*.js',
    ids: ['sidebar-archive-virtualizer', 'sidebar-archive-virtual-a11y', 'sidebar-lit-migration-contract'],
  },
  {
    pattern: 'app_front/features/sidebar/sidebarSwipe.js',
    ids: ['sidebar-swipe'],
  },
  {
    pattern: 'app_front/features/sidebar/sidebarChatDragBlock.js',
    ids: ['sidebar-chat-drag-block', 'sidebar-lit-migration-contract'],
  },
  {
    pattern: 'app_front/features/sidebar/cr-sidebar-*.js',
    ids: ['sidebar-lit-migration-contract'],
  },
  {
    pattern: 'app_front/features/sidebar/sidebarLitMigrationContract.js',
    ids: ['sidebar-lit-migration-contract'],
  },
  {
    pattern: 'app_front/lib/chatHistoryReplayLifecycle.js',
    ids: ['chat-history-replay-lifecycle', 'chat-history-replay-integration'],
  },
  {
    pattern: 'app_front/lib/chatHistoryReplayApplySlice.js',
    ids: ['chat-history-replay-integration', 'chat-history-replay-time-budget'],
  },
  {
    pattern: 'app_front/lib/chatHistoryReplayFinalizeSlice.js',
    ids: ['chat-history-replay-integration'],
  },
  {
    pattern: 'app_front/lib/chatHistoryReplayAsyncLoop.js',
    ids: [
      'chat-history-replay-async-loop',
      'chat-history-replay-cancel',
      'chat-history-replay-coverage',
      'chat-history-hydration-live',
    ],
  },
  {
    pattern: 'app_front/lib/chatHistoryReplayGenerationGate.js',
    ids: ['chat-history-replay-coverage', 'chat-history-hydration-live'],
  },
  {
    pattern: 'app_front/lib/chatHistoryReplayResult.js',
    ids: ['chat-history-replay-coverage', 'chat-history-view-apply'],
  },
  {
    pattern: 'app_front/lib/sdkRichViewViewportBatch.js',
    ids: ['chat-history-replay-viewport-geometry'],
  },
  {
    pattern: 'app_front/features/chat/chatHistoryViewApply.js',
    ids: ['chat-history-view-apply', 'chat-history-replay-coverage'],
  },
  {
    pattern: 'app_front/features/chat/chatHistoryHydrationLive.js',
    ids: ['chat-history-hydration-live', 'chat-history-replay-integration'],
  },
  {
    pattern: 'app_front/features/chat/chatHistoryHttpMerge.js',
    ids: ['chat-history-hydration-live'],
  },
  {
    pattern: 'app_front/lib/sdkHistoryMountedWindow.js',
    ids: ['sdk-history-turn-window', 'sdk-history-long-turn-window'],
  },
  {
    pattern: 'app_front/lib/delegationHistoryCardReport.js',
    ids: ['delegation-report-e2e-legacy-payload'],
  },
  {
    pattern: 'app_front/lib/uiFreezeRenderBudgets.js',
    ids: ['ui-freeze-render-budgets', 'chat-history-replay-viewport-geometry'],
  },
  {
    pattern: 'app_front/lib/uiFreezeCounters.js',
    ids: ['ui-freeze-counters'],
  },
  {
    pattern: 'lib/sdk/sdk-plan-text.js',
    ids: ['sdk-plan-text'],
  },
  {
    pattern: 'lib/sdk/sdk-history-stream-coalesce.js',
    ids: ['sdk-history-stream-coalesce'],
  },
  {
    pattern: 'lib/sdk/sdk-history-turn-window.js',
    ids: ['sdk-history-turn-window', 'sdk-history-long-turn-window'],
  },
]);

/**
 * @param {string} repoRelativePath
 * @returns {string[]}
 */
export function resolveReviewVerifyIdsForPath(repoRelativePath) {
  const normalized = String(repoRelativePath || '').replace(/\\/g, '/');
  if (!normalized) return [];
  /** @type {Set<string>} */
  const ids = new Set();
  for (const row of REVIEW_VERIFY_PATH_SELECTORS) {
    const tail = row.pattern.replace(/^\*\//, '');
    if (normalized === tail || normalized.endsWith(`/${tail}`)) {
      for (const id of row.ids) ids.add(id);
      continue;
    }
    if (row.pattern.includes('*')) {
      const prefix = row.pattern.slice(0, row.pattern.indexOf('*'));
      if (normalized.startsWith(prefix) || normalized.includes(`/${prefix}`)) {
        for (const id of row.ids) ids.add(id);
      }
      continue;
    }
    if (normalized === row.pattern || normalized.endsWith(`/${row.pattern}`)) {
      for (const id of row.ids) ids.add(id);
    }
  }
  return [...ids].filter((id) => Object.prototype.hasOwnProperty.call(REVIEW_VERIFY_CATALOG, id));
}

export const REVIEW_VERIFY_PROMPT_HINT = [
  'Read-only tools are allowed, including native shell for explorers and the host-owned runner.',
  `Run relevant project tests through \`node ${REVIEW_VERIFY_SCRIPT}\` or \`node ${REVIEW_VERIFY_SCRIPT} <id>\`; audited test ids include: ${REVIEW_VERIFY_IDS.join(', ')}.`,
  'Use only catalog ids as runner arguments. Read-only shell composition (including cd, 2>&1, and output pipes to head or tail) is supported. Do not add node flags, reporters, npm, or shell mutations.',
  'Plain project tests are also allowed: `node --test tests/<file>.test.js` or `node tests/<file>.test.js`, with an optional pipe only to head or tail. Absolute test paths inside the assigned workspace tests directory are also allowed. No other node flags. For lint without fixes or cache writes, use `node scripts/review-lint.js <source-file> [...files]` with explicit relative files under lib, app_front, tests, or scripts; no flags.',
  'In DeepSeek review, the DSH read-only filesystem sandbox permits read-only analysis commands, including Python via the sandboxed `bash` tool. It blocks filesystem writes but does not isolate reads or disable network access: inspect only assigned workspace artifacts, do not read secrets, and do not send data over the network. Other harnesses may deny opaque interpreters (`python`/`python3`, `node -e`, `perl`, `ruby`, heredoc or `-c` scripts); there use `jq`, `grep`/`rg`, `sed -n`, `find`, `awk` programs that do not call `system(` or redirect output, and `git log/diff/show` instead.',
  'If a shell command is denied, the review remains active. Do not retry it with different quoting, a pipe, or another interpreter; switch to native read tools or one standalone allowed explorer command. If that cannot establish a finding, state the limitation and finish the report rather than looping.',
  'DeepSeek relies on the DSH read-only filesystem sandbox to reject writes; other harnesses keep the host-side mutation guard. Edit and delete tools remain denied, and a denied command does not finish the review.',
].join(' ');

const REVIEW_NODE_BINARIES = new Set(['node', 'nodejs']);
const OPAQUE_EXEC_KEYS = new Set([
  'code',
  'javascript',
  'script',
  'source',
  'program',
  'expression',
]);


/**
 * @param {unknown} text
 * @returns {string}
 */
function stripWrappingQuotes(text) {
  const value = String(text || '').trim();
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isReviewVerifyScriptPath(token) {
  const raw = stripWrappingQuotes(token);
  if (!raw || raw.includes('..') || raw.includes('\\')) return false;
  return raw === REVIEW_VERIFY_SCRIPT || raw === `./${REVIEW_VERIFY_SCRIPT}`;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function tokenizeReviewVerifyCommand(value) {
  if (Array.isArray(value)) {
    return value.map((part) => String(part ?? '').trim()).filter(Boolean);
  }
  const text = String(value || '').trim();
  if (!text) return [];
  return text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
}

/**
 * Parse argv after the node binary. Rejects flags, unknown ids, and extra paths.
 *
 * `options.catalog` (audited, curated) takes precedence; otherwise the merged
 * dynamic catalog for `options.projectRoot` is used so a test added during the
 * flow is a valid id without a restart. A no-id invocation still defaults to the
 * curated set, not every generated id, so a bare runner call cannot balloon.
 *
 * @param {string[]} args
 * @param {{ catalog?: Readonly<Record<string, string>>, projectRoot?: string }} [options]
 * @returns {{ ok: true, ids: string[] } | { ok: false }}
 */
export function parseReviewVerifyNodeArgs(args, options = {}) {
  const explicitCatalog = options.catalog;
  const catalog = explicitCatalog || resolveReviewVerifyCatalog(options.projectRoot);
  if (!Array.isArray(args) || args.length === 0) return { ok: false };
  const script = stripWrappingQuotes(args[0]);
  if (!isReviewVerifyScriptPath(script)) return { ok: false };
  const ids = [];
  for (const token of args.slice(1)) {
    const id = stripWrappingQuotes(token);
    if (!id || id.startsWith('-') || id.includes('/') || id.includes('\\') || id.includes('..')) {
      return { ok: false };
    }
    if (!Object.prototype.hasOwnProperty.call(catalog, id)) return { ok: false };
    ids.push(id);
  }
  if (ids.length > 0) return { ok: true, ids };
  return { ok: true, ids: explicitCatalog ? Object.keys(explicitCatalog) : [...REVIEW_VERIFY_IDS] };
}

/**
 * True when argv is exactly `node scripts/review-verify.js` plus catalog ids.
 *
 * @param {unknown} command
 * @param {{ catalog?: Readonly<Record<string, string>> }} [options]
 * @returns {boolean}
 */
export function isReviewVerifyInvocation(command, options = {}) {
  const tokens = tokenizeReviewVerifyCommand(command);
  if (tokens.length < 2) return false;
  let index = 0;
  const firstRaw = stripWrappingQuotes(tokens[0]);
  if (firstRaw.includes('/') || firstRaw.includes('\\')) return false;
  if (firstRaw === 'env' || firstRaw === 'command' || firstRaw === 'time') {
    index = 1;
  }
  if (index >= tokens.length) return false;
  const binRaw = stripWrappingQuotes(tokens[index]);
  if (binRaw.includes('/') || binRaw.includes('\\')) return false;
  if (!REVIEW_NODE_BINARIES.has(binRaw)) return false;
  return parseReviewVerifyNodeArgs(tokens.slice(index + 1), options).ok === true;
}

/**
 * functions.exec-style payloads that carry JS instead of a structured command.
 * Do not regex-parse that JS; treat it as mutating.
 *
 * @param {unknown} args
 * @returns {boolean}
 */
export function isOpaqueExecPayload(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const rec = /** @type {Record<string, unknown>} */ (args);
  for (const key of Object.keys(rec)) {
    if (OPAQUE_EXEC_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

/**
 * @param {unknown} projectRoot
 * @returns {string}
 */
export function resolveReviewVerifyProjectRoot(projectRoot) {
  const raw = String(projectRoot || '').trim();
  if (raw) return path.resolve(raw);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * @param {{
 *   ids?: string[],
 *   projectRoot?: string,
 *   catalog?: Readonly<Record<string, string>>,
 *   timeoutMs?: number,
 * }} [input]
 * @returns {Promise<{ ok: boolean, output: string, error?: string, dataDir: string }>}
 */
export async function runReviewVerify(input = {}) {
  const explicitCatalog = input.catalog;
  const catalog = explicitCatalog || resolveReviewVerifyCatalog(input.projectRoot);
  const ids = Array.isArray(input.ids) && input.ids.length > 0
    ? input.ids
    : (explicitCatalog ? Object.keys(explicitCatalog) : [...REVIEW_VERIFY_IDS]);
  const projectRoot = resolveReviewVerifyProjectRoot(input.projectRoot);
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Number(input.timeoutMs) : REVIEW_VERIFY_TIMEOUT_MS;
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(catalog, id)) {
      return { ok: false, output: '', error: `Unknown review verify id: ${id}`, dataDir: '' };
    }
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-review-verify-data-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-review-verify-cwd-'));
  const outputs = [];
  try {
    for (const id of ids) {
      const relative = catalog[id];
      const filePath = path.resolve(projectRoot, relative);
      const relPosix = relative.replace(/\\/g, '/');
      if (!relPosix.startsWith('tests/') || relPosix.includes('..')) {
        return { ok: false, output: outputs.join('\n'), error: `Refusing catalog path ${relative}`, dataDir };
      }
      if (!fs.existsSync(filePath)) {
        return { ok: false, output: outputs.join('\n'), error: `Missing catalog file ${relative}`, dataDir };
      }
      const result = await spawnReviewVerifyFile({
        filePath,
        workDir,
        dataDir,
        timeoutMs,
      });
      outputs.push(`==> ${id}\n${result.output}`.trim());
      if (!result.ok) {
        return {
          ok: false,
          output: outputs.join('\n\n'),
          error: result.error || `${id} failed`,
          dataDir,
        };
      }
    }
    return { ok: true, output: outputs.join('\n\n') || '(no output)', dataDir };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * @param {string[]} argv
 * @param {{ projectRoot?: string }} [options]
 * @returns {Promise<{ ok: boolean, output: string, error?: string }>}
 */
export async function runReviewVerifyCli(argv, options = {}) {
  const parsed = parseReviewVerifyNodeArgs([REVIEW_VERIFY_SCRIPT, ...argv], {
    projectRoot: options.projectRoot,
  });
  if (!parsed.ok) {
    return {
      ok: false,
      output: '',
      error: `Rejected review verify arguments. Allowed: node ${REVIEW_VERIFY_SCRIPT} [${REVIEW_VERIFY_IDS.join('|')}...]`,
    };
  }
  return runReviewVerify({ ids: parsed.ids, projectRoot: options.projectRoot });
}

/**
 * @param {{ filePath: string, workDir: string, dataDir: string, timeoutMs: number }} input
 * @returns {Promise<{ ok: boolean, output: string, error?: string }>}
 */
function spawnReviewVerifyFile(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [input.filePath], {
      cwd: input.workDir,
      env: {
        ...process.env,
        CRETLI_DATA_DIR: input.dataDir,
        CRETLI_TEST_DATA_DIR: input.dataDir,
        CURSOR_REMOTE_DATA_DIR: input.dataDir,
        CURSOR_REMOTE_TEST_DATA_DIR: input.dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), input.timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      if (code === 0) {
        resolve({ ok: true, output: output || '(no output)' });
        return;
      }
      resolve({
        ok: false,
        output,
        error: `Command exited with code ${code ?? 'unknown'}`,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: '', error: err.message });
    });
  });
}
