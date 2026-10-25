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

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackChildProcess } from '../child-process-registry.js';
import { assertExecutorLaunchAllowed } from '../executor-launch-gate.js';
import { buildAgentChildEnv } from '../agent-env.js';

type ReviewVerifyInput = {
  ids?: string[];
  projectRoot?: string;
  catalog?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  materialRevision?: string;
  /** Ids that must bypass the job-queue result cache; the direct runner always runs everything. */
  freshIds?: string[];
};

type ReviewVerifyRunResult = {
  ok: boolean;
  notApplicable?: boolean;
  output: string;
  error?: string;
  dataDir: string;
  results?: Array<ReviewVerifyStepResult>;
  /** Wall-clock timeline of the whole run (per-step timing lives on `results`). */
  timing?: { startedAt: string; finishedAt: string; durationMs: number; concurrency: number; sumStepMs: number };
};

type ReviewVerifyStepResult = {
  id: string;
  ok: boolean;
  durationMs: number;
  outputTail: string;
  /** ISO start of the step; absent for steps refused before spawn. */
  startedAt?: string;
  /** True when the per-step time limit killed the step. */
  timedOut?: boolean;
};

export const REVIEW_VERIFY_SCRIPT = 'scripts/review-verify.js';
export const REVIEW_VERIFY_TIMEOUT_MS = 60000;
/** Catalog tests run in parallel up to this bound (override: CRETLI_REVIEW_VERIFY_CONCURRENCY, 1..8). */
export const REVIEW_VERIFY_DEFAULT_CONCURRENCY = 4;

export function resolveReviewVerifyConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(String(env.CRETLI_REVIEW_VERIFY_CONCURRENCY || ''), 10);
  if (!Number.isFinite(raw) || raw < 1) return REVIEW_VERIFY_DEFAULT_CONCURRENCY;
  return Math.min(raw, 8);
}

/**
 * Audited directories a generated manifest may add ids from. Only files named
 * `<id>.test.js` directly inside one of these repo-relative dirs are eligible.
 * The curated `REVIEW_VERIFY_CATALOG` stays authoritative and always wins a
 * name collision, so a human-audited entry can never be shadowed by a new file.
 */
export const REVIEW_VERIFY_AUDIT_DIRS: readonly string[] = Object.freeze(['tests']);

/** Manifest files are written under the OS temp dir, never the project `data/`. */
export const REVIEW_VERIFY_MANIFEST_DIR = 'cretli-review-verify';

/**
 * Audited catalog: incident unit tests that only assert in-memory helpers.
 * Keys are the only ids an agent may pass. Values are repo-relative files.
 */
export const REVIEW_VERIFY_CATALOG: Readonly<Record<string, string>> = Object.freeze({
  'mcp-chat-history-format': 'tests/mcp-chat-history-format.test.js',
  'sdk-history-stream-coalesce': 'tests/sdk-history-stream-coalesce.test.js',
  'sdk-assistant-block-reuse': 'tests/sdk-assistant-block-reuse.test.js',
  'delegation-contract': 'tests/delegation-contract.test.js',
  'delegation-wait': 'tests/delegation-wait.test.js',
  'delegation-executor': 'tests/delegation-executor.test.js',
  'delegation-report-integrity': 'tests/delegation-report-integrity.test.js',
  'delegation-report-reuse': 'tests/delegation-report-reuse.test.js',
  'mcp-reply-provenance-token': 'tests/mcp-reply-provenance-token.test.js',
  'mcp-bridge-reuse-keys': 'tests/mcp-bridge-reuse-keys.test.js',
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
  'workspace-watcher-scheduler': 'tests/workspace-watcher-scheduler.test.js',
  'recovery-boot': 'tests/recovery-boot.test.js',
  'recovery-shutdown': 'tests/recovery-shutdown.test.js',
  'recovery-family': 'tests/recovery-family.test.js',
  'recovery-store': 'tests/recovery-store.test.js',
  'recovery-lifecycle': 'tests/recovery-lifecycle.test.js',
  'recovery-queue': 'tests/recovery-queue.test.js',
  'recovery-resume': 'tests/recovery-resume.test.js',
  'recovery-scheduler': 'tests/recovery-scheduler.test.js',
  'recovery-automatic-rollout': 'tests/recovery-automatic-rollout.test.js',
  'recovery-policy': 'tests/recovery-policy.test.js',
  'recovery-contract': 'tests/recovery-contract.test.js',
  'chat-run-recovery-wiring': 'tests/chat-run-recovery-wiring.test.js',
  'recovery-chat-run-crash': 'tests/recovery-chat-run-crash.test.js',
  'workspace-watcher-crash': 'tests/workspace-watcher-crash.test.js',
  'workspace-watcher-restart-interrupt': 'tests/workspace-watcher-restart-interrupt.test.js',
  'workspace-watcher-history-repair': 'tests/workspace-watcher-history-repair.test.js',
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
  'storage-runtime-check': 'tests/storage-runtime-check.test.js',
  'storage-db-lifecycle': 'tests/storage-db-lifecycle.test.js',
  'storage-worker-queue': 'tests/storage-worker-queue.test.js',
  'storage-worker-host': 'tests/storage-worker-host.test.js',
  'storage-command-receipts': 'tests/storage-command-receipts.test.js',
  'storage-group-commit': 'tests/storage-group-commit.test.js',
  'storage-coordinator': 'tests/storage-coordinator.test.js',
  'storage-migration-runner': 'tests/storage-migration-runner.test.js',
  'storage-callers-contract': 'tests/storage-callers-contract.test.js',
  'storage-chat-history-store': 'tests/storage-chat-history-store.test.js',
  // Read-only repo checks (audited 2026-10-24: no writes, no spawn; the baseline
  // script writes only when run directly with --write).
  'front-size-ratchet': 'tests/front-size-ratchet.test.js',
  'i18n-harness-packs': 'tests/i18n-harness-packs.test.js',
  'architecture-acceptance': 'tests/architecture-acceptance.test.js',
});

export const REVIEW_VERIFY_IDS = Object.freeze(Object.keys(REVIEW_VERIFY_CATALOG));

/** Error text of a run in a project that has nothing to verify. */
export const REVIEW_VERIFY_NOT_APPLICABLE = 'No review-verify tests are configured for this project';

/**
 * The curated catalog lists Cretli's own tests, so it applies only to a Cretli
 * checkout (or one of its worktrees): a project that ships the runner script.
 * Any other workspace gets only the tests it has in its own audited dirs.
 *
 */
export function isCretliReviewVerifyProject(projectRoot: unknown): boolean {
  return fs.existsSync(path.join(resolveReviewVerifyProjectRoot(projectRoot), REVIEW_VERIFY_SCRIPT));
}

/**
 * Ids a run without explicit ids covers: the curated set in a Cretli checkout,
 * nothing elsewhere (generated ids stay opt-in by id).
 */
export function resolveDefaultReviewVerifyIds(projectRoot: unknown): string[] {
  return isCretliReviewVerifyProject(projectRoot) ? [...REVIEW_VERIFY_IDS] : [];
}

function auditDirSignature(projectRoot: string): string {
  const parts: string[] = [];
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

function reviewVerifyManifestPath(projectRoot: string): string {
  const hash = createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), REVIEW_VERIFY_MANIFEST_DIR, `${hash}.json`);
}

/**
 * Scan the audited directories for `<id>.test.js` files. Pure filesystem read,
 * no cache; callers that need the merged view use `resolveReviewVerifyCatalog`.
 */
export function generateReviewVerifyManifest(input: { projectRoot?: string } = {}): {
  generatedAt: string;
  projectRoot: string;
  auditDirs: string[];
  entries: Record<string, string>;
} {
  const projectRoot = resolveReviewVerifyProjectRoot(input.projectRoot);
  const entries: Record<string, string> = {};
  for (const rel of REVIEW_VERIFY_AUDIT_DIRS) {
    let names: string[] = [];
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

let reviewVerifyCatalogCache: {
  key: string;
  signature: string;
  catalog: Record<string, string> | null;
  meta: object | null;
} = { key: '', signature: '', catalog: null, meta: null };

/**
 * Merged catalog: generated audited entries plus the curated catalog, which
 * wins id collisions. Regenerated when an audited dir mtime/size changes, so a
 * test file added during a flow becomes a valid id without a server restart.
 */
export function resolveReviewVerifyCatalog(projectRoot?: unknown, options: { refresh?: boolean } = {}): Record<string, string> {
  const root = resolveReviewVerifyProjectRoot(projectRoot);
  const isCretliProject = isCretliReviewVerifyProject(root);
  const signature = `${auditDirSignature(root)}|cretli:${isCretliProject}`;
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
  const catalog = { ...manifest.entries, ...(isCretliProject ? REVIEW_VERIFY_CATALOG : {}) };
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
      curatedCount: isCretliProject ? REVIEW_VERIFY_IDS.length : 0,
      generatedCount: Object.keys(manifest.entries).length,
      manifestPath,
    },
  };
  return catalog;
}

/**
 * Metadata for the last resolved dynamic catalog (audit/debug surface).
 */
export function describeReviewVerifyCatalog(projectRoot?: unknown): object | null {
  resolveReviewVerifyCatalog(projectRoot);
  return reviewVerifyCatalogCache.meta ? { ...reviewVerifyCatalogCache.meta } : null;
}

/**
 * Repo-relative path globs → catalog ids (integration 8.2). Reviewers run
 * `node scripts/review-verify.js <id>` when diffs touch matching paths.
 */
export const REVIEW_VERIFY_PATH_SELECTORS: ReadonlyArray<{ pattern: string; ids: readonly string[] }> = Object.freeze([
  {
    pattern: 'lib/storage/chat-history-store.js',
    ids: ['storage-chat-history-store'],
  },
  {
    pattern: 'lib/storage/chat-history-store.md',
    ids: ['storage-chat-history-store'],
  },
  {
    pattern: 'tests/fixtures/storage-chat-history-*.js',
    ids: ['storage-chat-history-store'],
  },
  {
    pattern: 'lib/storage/runtime-check.js',
    ids: ['storage-runtime-check', 'storage-db-lifecycle'],
  },
  {
    pattern: 'lib/storage/errors.js',
    ids: ['storage-runtime-check', 'storage-db-lifecycle', 'storage-worker-queue', 'storage-worker-host', 'storage-command-receipts', 'storage-group-commit'],
  },
  {
    pattern: 'lib/storage/fair-queue.js',
    ids: ['storage-worker-queue', 'storage-worker-host'],
  },
  {
    pattern: 'lib/storage/worker-host.js',
    ids: ['storage-worker-host', 'storage-command-receipts', 'storage-group-commit', 'storage-coordinator'],
  },
  {
    pattern: 'lib/storage/sqlite-worker.js',
    ids: ['storage-worker-host', 'storage-command-receipts', 'storage-group-commit', 'storage-coordinator'],
  },
  {
    pattern: 'lib/storage/coordinator.js',
    ids: ['storage-coordinator', 'storage-worker-host', 'storage-group-commit'],
  },
  {
    pattern: 'lib/storage/worker-wire.js',
    ids: ['storage-worker-host', 'storage-command-receipts', 'storage-group-commit'],
  },
  {
    pattern: 'tests/fixtures/storage-worker-*.js',
    ids: ['storage-worker-host'],
  },
  {
    pattern: 'lib/storage/command-receipts.js',
    ids: ['storage-command-receipts', 'storage-group-commit'],
  },
  {
    pattern: 'lib/storage/handler-sql-guard.js',
    ids: ['storage-command-receipts', 'storage-worker-host', 'storage-group-commit'],
  },
  {
    pattern: 'lib/storage/group-commit.js',
    ids: ['storage-group-commit'],
  },
  {
    pattern: 'tests/fixtures/storage-group-*.js',
    ids: ['storage-group-commit'],
  },
  {
    pattern: 'tests/fixtures/storage-receipt-*.js',
    ids: ['storage-command-receipts'],
  },
  {
    pattern: 'lib/storage/db-lifecycle.js',
    ids: ['storage-db-lifecycle', 'storage-worker-host', 'storage-command-receipts'],
  },
  {
    pattern: 'lib/storage/migrations.js',
    ids: ['storage-db-lifecycle', 'storage-worker-host', 'storage-command-receipts', 'storage-migration-runner', 'storage-chat-history-store'],
  },
  {
    pattern: 'lib/storage/migration-runner.js',
    ids: ['storage-migration-runner'],
  },
  {
    pattern: 'docs/storage-callers.md',
    ids: ['storage-callers-contract'],
  },
  {
    pattern: 'docs/storage-registry.json',
    ids: ['storage-callers-contract'],
  },
  {
    pattern: 'lib/storage/sqlite-errors.js',
    ids: ['storage-db-lifecycle', 'storage-worker-host', 'storage-command-receipts'],
  },
  {
    pattern: 'lib/storage/schema/*.js',
    ids: ['storage-db-lifecycle', 'storage-worker-host', 'storage-command-receipts', 'storage-coordinator', 'storage-chat-history-store'],
  },
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
    pattern: 'lib/sdk/sdk-plan-text.ts',
    ids: ['sdk-plan-text'],
  },
  {
    pattern: 'lib/sdk/sdk-history-stream-coalesce.ts',
    ids: ['sdk-history-stream-coalesce'],
  },
  {
    pattern: 'lib/sdk/sdk-history-turn-window.ts',
    ids: ['sdk-history-turn-window', 'sdk-history-long-turn-window'],
  },
  // Any front change can grow a file past the ratchet or move a manifest entry.
  {
    pattern: 'app_front/*',
    ids: ['front-size-ratchet', 'architecture-acceptance'],
  },
  {
    pattern: 'app_front/i18n/*',
    ids: ['i18n-harness-packs'],
  },
  {
    pattern: 'tests/fixtures/i18n-snapshot-*',
    ids: ['i18n-harness-packs'],
  },
  {
    pattern: 'docs/architecture-*',
    ids: ['architecture-acceptance'],
  },
]);

export function resolveReviewVerifyIdsForPath(repoRelativePath: string): string[] {
  const normalized = String(repoRelativePath || '').replace(/\\/g, '/');
  if (!normalized) return [];
  const ids = new Set<string>();
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
  'Command substitution (`$(...)`, backticks) and variable assignment (`name=value ...`) are not allowed in review shell calls; run searches and reads as separate calls (e.g. `rg -l <pattern> <dir>`, then `rg -n` or `cat` on the listed files) instead of capturing output into a variable.',
  'Run project tests only through the host-owned review-verify catalog; direct test-file execution is denied because tests are not isolated from filesystem access. For lint without fixes or cache writes, use `node scripts/review-lint.js <source-file> [...files]` with explicit relative files under lib, app_front, tests, or scripts; no flags.',
  'In DeepSeek review, the DSH read-only filesystem sandbox permits read-only analysis commands, including Python via the sandboxed `bash` tool. It blocks filesystem writes but does not isolate reads or disable network access: inspect only assigned workspace artifacts, do not read secrets, and do not send data over the network. Other harnesses may deny opaque interpreters (`python`/`python3`, `node -e`, `perl`, `ruby`, heredoc or `-c` scripts); there use `jq`, `grep`/`rg`, `sed -n`, `find`, `awk` programs that do not call `system(` or redirect output, and `git log/diff/show` instead.',
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


function stripWrappingQuotes(text: unknown): string {
  const value = String(text || '').trim();
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
    return value.slice(1, -1);
  }
  return value;
}

function isReviewVerifyScriptPath(token: string): boolean {
  const raw = stripWrappingQuotes(token);
  if (!raw || raw.includes('..') || raw.includes('\\')) return false;
  return raw === REVIEW_VERIFY_SCRIPT || raw === `./${REVIEW_VERIFY_SCRIPT}`;
}

export function tokenizeReviewVerifyCommand(value: unknown): string[] {
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
 */
export function parseReviewVerifyNodeArgs(
  args: string[],
  options: { catalog?: Readonly<Record<string, string>>; projectRoot?: string } = {},
): { ok: true; ids: string[] } | { ok: false } {
  const explicitCatalog = options.catalog;
  const catalog = explicitCatalog || resolveReviewVerifyCatalog(options.projectRoot);
  if (!Array.isArray(args) || args.length === 0) return { ok: false };
  const script = stripWrappingQuotes(args[0]);
  if (!isReviewVerifyScriptPath(script)) return { ok: false };
  const ids: string[] = [];
  for (const token of args.slice(1)) {
    const id = stripWrappingQuotes(token);
    if (!id || id.startsWith('-') || id.includes('/') || id.includes('\\') || id.includes('..')) {
      return { ok: false };
    }
    if (!Object.prototype.hasOwnProperty.call(catalog, id)) return { ok: false };
    ids.push(id);
  }
  if (ids.length > 0) return { ok: true, ids };
  return { ok: true, ids: explicitCatalog ? Object.keys(explicitCatalog) : resolveDefaultReviewVerifyIds(options.projectRoot) };
}

/**
 * True when argv is exactly `node scripts/review-verify.js` plus catalog ids.
 */
export function isReviewVerifyInvocation(
  command: unknown,
  options: { catalog?: Readonly<Record<string, string>> } = {},
): boolean {
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
 */
export function isOpaqueExecPayload(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const rec = args as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (OPAQUE_EXEC_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

export function resolveReviewVerifyProjectRoot(projectRoot: unknown): string {
  const raw = String(projectRoot || '').trim();
  if (raw) return path.resolve(raw);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * In-flight runs keyed by resolved project root + sorted resolved ids.
 * Notes on the key:
 * - `timeoutMs` is not part of it; no production caller passes it.
 * - `[a, b]` and `[b, a]` share a run (output order may differ).
 * - An optional `materialRevision` is part of the key, so a call made after a
 *   fix never joins a run that started on older material. Callers that pass
 *   none (delegation_verify) keep the legacy shared key.
 * - `[]` expands to `resolveDefaultReviewVerifyIds` (the curated ids in a
 *   Cretli checkout, nothing elsewhere).
 * Both call paths (delegation_verify and the harness runner) run in the server
 * process, so one module-level map covers them. Completed results are not
 * cached; an explicit `catalog` override bypasses the map.
 */
const inFlightReviewVerifyRuns = new Map<string, Promise<ReviewVerifyRunResult>>();

/**
 * @returns true while a verify run is in flight for that root
 */
export function isReviewVerifyInFlight(
  { projectRoot, materialRevision }: { projectRoot?: unknown; materialRevision?: unknown } = {},
): boolean {
  const root = resolveReviewVerifyProjectRoot(projectRoot);
  const prefix = `${root}\n`;
  const revision = String(materialRevision || '').trim();
  for (const key of inFlightReviewVerifyRuns.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (revision && !key.endsWith(`\n${revision}`)) continue;
    return true;
  }
  return false;
}

/**
 * Concurrent calls with the same resolved root and ids await one execution and
 * receive the same result. A dropped client connection does not cancel the run,
 * and a shared run shares one `dataDir` (the runner removes only its workDir).
 */
export function runReviewVerify(input: ReviewVerifyInput = {}): Promise<ReviewVerifyRunResult> {
  if (input.catalog) return executeReviewVerify(input);
  const ids = Array.isArray(input.ids) && input.ids.length > 0
    ? input.ids
    : resolveDefaultReviewVerifyIds(input.projectRoot);
  const revision = String(input.materialRevision || '').trim();
  const key = `${resolveReviewVerifyProjectRoot(input.projectRoot)}\n${[...new Set(ids)].sort().join(',')}\n${revision}`;
  const existing = inFlightReviewVerifyRuns.get(key);
  if (existing) return existing.then((result) => ({ ...result }));
  const run = executeReviewVerify(input).finally(() => {
    if (inFlightReviewVerifyRuns.get(key) === run) inFlightReviewVerifyRuns.delete(key);
  });
  inFlightReviewVerifyRuns.set(key, run);
  return run.then((result) => ({ ...result }));
}

/**
 * Runs EVERY selected id (no stop on the first failure) so one failing test
 * never hides the rest; `results[]` carries the per-id outcome. `ok` is true
 * only when every id passed; `error` names the first failing id.
 */
async function executeReviewVerify(input: ReviewVerifyInput = {}): Promise<ReviewVerifyRunResult> {
  const explicitCatalog = input.catalog;
  const catalog = explicitCatalog || resolveReviewVerifyCatalog(input.projectRoot);
  const ids = Array.isArray(input.ids) && input.ids.length > 0
    ? input.ids
    : (explicitCatalog ? Object.keys(explicitCatalog) : resolveDefaultReviewVerifyIds(input.projectRoot));
  if (ids.length === 0) {
    return { ok: false, notApplicable: true, output: '', error: REVIEW_VERIFY_NOT_APPLICABLE, dataDir: '' };
  }
  const projectRoot = resolveReviewVerifyProjectRoot(input.projectRoot);
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Number(input.timeoutMs) : REVIEW_VERIFY_TIMEOUT_MS;
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(catalog, id)) {
      return { ok: false, output: '', error: `Unknown review verify id: ${id}`, dataDir: '' };
    }
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-review-verify-data-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-review-verify-cwd-'));
  // Per-run TMPDIR: whatever the suites mkdtemp inside it is removed with it,
  // so leaking tests cannot fill the host temp dir across repeated verifies.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-review-verify-tmp-'));
  const runStartedAt = Date.now();
  const concurrency = Math.min(resolveReviewVerifyConcurrency(), ids.length);
  // Slots keep catalog order in `results`/`output` regardless of finish order.
  const slots: Array<{ step: ReviewVerifyStepResult; output: string; error?: string }> = new Array(ids.length);
  const runStep = async (index: number) => {
    const id = ids[index];
    const relative = catalog[id];
    const fail = (error: string) => {
      slots[index] = { step: { id, ok: false, durationMs: 0, outputTail: buildOutputTail(error, false) }, output: '', error };
    };
    const filePath = path.resolve(projectRoot, relative);
    const relPosix = relative.replace(/\\/g, '/');
    if (!relPosix.startsWith('tests/') || relPosix.includes('..')) return fail(`Refusing catalog path ${relative}`);
    if (!fs.existsSync(filePath)) return fail(`Missing catalog file ${relative}`);
    const startedAt = Date.now();
    const result = await spawnReviewVerifyFile({ filePath, workDir, dataDir, tmpDir, timeoutMs });
    const durationMs = Date.now() - startedAt;
    const timedOut = result.timedOut === true;
    const error = timedOut ? `${id} timed out after ${timeoutMs} ms (per-step limit)` : result.error;
    slots[index] = {
      step: {
        id,
        ok: result.ok,
        durationMs,
        outputTail: buildOutputTail(String(result.output || error || ''), result.ok),
        startedAt: new Date(startedAt).toISOString(),
        ...(timedOut ? { timedOut: true } : {}),
      },
      output: `==> ${id}\n${result.output}`.trim(),
      error,
    };
  };
  try {
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const index = next;
        next += 1;
        await runStep(index);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const results = slots.map((slot) => slot.step);
    const outputs = slots.map((slot) => slot.output).filter(Boolean);
    const firstFailed = slots.find((slot) => !slot.step.ok);
    const ok = !firstFailed;
    const finishedAt = Date.now();
    const timing = {
      startedAt: new Date(runStartedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - runStartedAt,
      concurrency,
      sumStepMs: results.reduce((sum, row) => sum + row.durationMs, 0),
    };
    const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3)
      .map((row) => `${row.id}=${row.durationMs}ms`).join(' ');
    console.log(`[review-verify] ${ids.length} steps in ${timing.durationMs}ms (sum ${timing.sumStepMs}ms, concurrency ${concurrency}, timed_out=${results.filter((r) => r.timedOut).length}) slowest: ${slowest}`);
    return {
      ok,
      output: outputs.join('\n\n') || (ok ? '(no output)' : ''),
      ...(ok ? {} : { error: firstFailed?.error || `${firstFailed?.step.id} failed` }),
      dataDir,
      results,
      timing,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function runReviewVerifyCli(
  argv: string[],
  options: { projectRoot?: string } = {},
): Promise<{ ok: boolean; output: string; error?: string }> {
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

/** Grace between SIGTERM and SIGKILL, and drain window after `exit`. */
export const REVIEW_VERIFY_KILL_GRACE_MS = 5000;
export const REVIEW_VERIFY_DRAIN_MS = 1000;
const RESULT_OUTPUT_TAIL_MAX = 4096;
const RESULT_FAILED_LINES_MAX = 1024;
const FAILED_LINE_PATTERN = /^\s*(?:not ok\b|# fail\s+[1-9])/;

/**
 * Bounded output for a result. A failing run whose output overflows the tail
 * keeps its `not ok` lines (capped) ahead of the tail, so the failing subtest
 * name survives truncation. Passing or short output is the plain tail.
 */
export function buildOutputTail(text: string, ok: boolean): string {
  if (text.length <= RESULT_OUTPUT_TAIL_MAX) return text;
  const tail = text.slice(-RESULT_OUTPUT_TAIL_MAX + RESULT_FAILED_LINES_MAX);
  if (ok) return text.slice(-RESULT_OUTPUT_TAIL_MAX);
  const dropped = text.slice(0, text.length - tail.length);
  const failed: string[] = [];
  let size = 0;
  for (const line of dropped.split('\n')) {
    if (!FAILED_LINE_PATTERN.test(line)) continue;
    const clipped = line.trim().slice(0, 200);
    if (size + clipped.length + 1 > RESULT_FAILED_LINES_MAX) break;
    failed.push(clipped);
    size += clipped.length + 1;
  }
  if (!failed.length) return text.slice(-RESULT_OUTPUT_TAIL_MAX);
  return `[failed lines before tail]\n${failed.join('\n')}\n[tail]\n${tail}`;
}

function signalReviewVerifyChild(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch { /* fall back to the direct child */ }
  try { child.kill(signal); } catch { /* already gone */ }
}

/**
 * Spawns one test file. The child leads its own process group so a timeout
 * kills grandchildren too, and the promise settles on `exit` + a short drain
 * (a grandchild holding the stdio pipes must not keep the run open).
 */
export function spawnReviewVerifyFile(input: {
  filePath: string;
  workDir: string;
  dataDir: string;
  /** Optional per-run temp dir exported as TMPDIR/TMP/TEMP to the child. */
  tmpDir?: string;
  timeoutMs: number;
  cwd?: string;
  graceMs?: number;
  drainMs?: number;
}): Promise<{ ok: boolean; output: string; error?: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    try {
      assertExecutorLaunchAllowed({ type: 'review-verify', label: path.basename(input.filePath) });
    } catch (error) {
      resolve({ ok: false, output: '', error: `Review verify launch refused: ${(error as Error).message}` });
      return;
    }
    const child = spawn(process.execPath, [input.filePath], {
      cwd: input.cwd || input.workDir,
      env: {
        ...buildAgentChildEnv('tool'),
        CRETLI_DATA_DIR: input.dataDir,
        CRETLI_TEST_DATA_DIR: input.dataDir,
        CURSOR_REMOTE_DATA_DIR: input.dataDir,
        CURSOR_REMOTE_TEST_DATA_DIR: input.dataDir,
        ...(input.tmpDir ? { TMPDIR: input.tmpDir, TMP: input.tmpDir, TEMP: input.tmpDir } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    let drainTimer: NodeJS.Timeout | undefined;
    // `stdin: 'ignore'` means a parent SIGKILL leaves this runner alive (the
    // observed 2026-10-08 orphans); the registry sweep reclaims it.
    trackChildProcess(child, { type: 'review-verify', label: path.basename(input.filePath) });
    const graceMs = Number.isFinite(input.graceMs) ? Number(input.graceMs) : REVIEW_VERIFY_KILL_GRACE_MS;
    const drainMs = Number.isFinite(input.drainMs) ? Number(input.drainMs) : REVIEW_VERIFY_DRAIN_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalReviewVerifyChild(child, 'SIGTERM');
      const kill = setTimeout(() => signalReviewVerifyChild(child, 'SIGKILL'), graceMs);
      killTimer = kill;
      kill.unref();
    }, input.timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const finish = (payload: { ok: boolean; output: string; error?: string; timedOut?: boolean }) => {
      if (settled) return;
      settled = true;
      if (timedOut) payload = { ...payload, ok: false, timedOut: true };
      clearTimeout(timer);
      // killTimer is intentionally kept: once termination started, the group
      // SIGKILL must still fire (bounded by graceMs) to reap grandchildren
      // that ignored SIGTERM, even after the direct child exited. It is
      // unref()'d so it never holds the event loop after the run settles; a
      // long-lived host (the server) keeps the loop alive and still fires it.
      clearTimeout(drainTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(payload);
    };
    const settleWithCode = (code: number | null) => {
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      if (code === 0) finish({ ok: true, output: output || '(no output)' });
      else finish({ ok: false, output, error: `Command exited with code ${code ?? 'unknown'}` });
    };
    child.on('exit', (code) => {
      clearTimeout(timer);
      drainTimer = setTimeout(() => settleWithCode(code), drainMs);
    });
    child.on('close', (code) => {
      settleWithCode(code);
    });
    child.on('error', (err) => {
      finish({ ok: false, output: '', error: err.message });
    });
  });
}
