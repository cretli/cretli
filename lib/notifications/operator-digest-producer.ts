/**
 * Daily "waiting for you" digest: plans to approve, failed reviews to act on,
 * needs_human items and blocked trees, gathered from todo and watcher state.
 *
 * The text is a pure function of the collected state (stable ordering, no
 * clock inside), an empty digest is never published, and the date-keyed
 * fingerprint makes the notification store the once-a-day guard.
 */
import { isTodoWaitingForPlan } from '../todo-plan-gate.js';
import { resolveDataPath } from '../runtime-paths.js';
import { listTodos } from '../persist/todos-store.js';
import { loadWorkspaceWatchers } from '../persist/workspace-watchers-persist.js';
import { publishNotification } from './notification-store.ts';

export interface OperatorDigestItem { id: string; title: string }

export interface OperatorDigestState {
  plansToApprove: OperatorDigestItem[];
  reviewsToAccept: OperatorDigestItem[];
  needsHuman: OperatorDigestItem[];
  blockedTrees: OperatorDigestItem[];
  stoppedWatchers: string[];
}

type PublishFn = (input: Record<string, unknown>, options?: Record<string, unknown>) => Promise<{ created?: boolean } | undefined | null>;

/** Items listed per section before the rest collapses into "+N more". */
export const DIGEST_ITEMS_PER_SECTION = 5;
/** Local hour from which the daily digest may be sent. */
export const DIGEST_HOUR = 9;
export const DIGEST_INTERVAL_MS = 60 * 60 * 1000;

const text = (value: unknown): string => String(value ?? '').trim();

/** Replace absolute paths embedded in free text (titles, stop reasons) with their last segment. */
export function scrubPaths(value: string): string {
  // A path starts at a word boundary with `/`, `~/`, `C:\` or `C:/` (never inside "and/or" or after `scheme:`).
  // Inner segments may hold spaces (C:\Users\Jane Doe\work) as long as another separator follows; the last
  // segment stops at whitespace. Privacy wins over fidelity: the whole path collapses to its last segment.
  // `file://` links are local paths too; a path right after a label colon (`path:/home/...`) counts, `scheme://` does not.
  return value.replace(/\bfile:\/\/[^/\s]*(?=\/)/gi, '').replace(/(?:(?<![\w.:~/-])|(?<=:)(?!\/\/))(?:~|[A-Za-z]:)?[\\/](?:[^\\/\n,;:]*[\\/])*[^\\/\s,;:]*/g, (match) => {
    const parts = match.split(/[\\/]+/).filter((part) => part && part !== '~' && !/^[A-Za-z]:$/.test(part));
    return parts[parts.length - 1] || '';
  });
}

/** Display label for a workspace: its folder name only, never the absolute path. */
export function workspaceLabel(workspaceFolder: string): string {
  const parts = text(workspaceFolder).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || 'workspace';
}

export function emptyOperatorDigestState(): OperatorDigestState {
  return { plansToApprove: [], reviewsToAccept: [], needsHuman: [], blockedTrees: [], stoppedWatchers: [] };
}

function byId(a: OperatorDigestItem, b: OperatorDigestItem): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Local calendar day (YYYY-MM-DD) of a timestamp; the digest fingerprint key. */
export function digestDayKey(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Reduce one workspace's todos and watcher row into digest items.
 */
export function collectOperatorDigestForWorkspace(
  items: Record<string, any>[],
  watcher: Record<string, any> | null,
  workspaceFolder = '',
): OperatorDigestState {
  const state = emptyOperatorDigestState();
  const index = new Map(items.map((item) => [text(item.id), item]));
  const open = items.filter((item) => text(item.status) !== 'done');
  const rootOf = (item: Record<string, any>): Record<string, any> => {
    const seen = new Set<string>();
    let cur = item;
    while (text(cur.parentId) && index.has(text(cur.parentId)) && !seen.has(text(cur.id))) {
      seen.add(text(cur.id));
      cur = index.get(text(cur.parentId))!;
    }
    return cur;
  };
  const lastBlockedHuman = watcher?.lastBlocked?.reasonCode === 'needs_human' ? text(watcher.lastBlocked.todoId) : '';
  const blockedRoots = new Map<string, OperatorDigestItem>();
  for (const item of open) {
    const ref = { id: text(item.id), title: scrubPaths(text(item.title)) };
    // The shared plan gate decides what really waits: ready leaves only, honouring
    // the Watcher policy and the feedback-derived exception.
    if (isTodoWaitingForPlan(items, item, watcher?.policy)) state.plansToApprove.push(ref);
    if (text(item.review?.code?.state) === 'failed') state.reviewsToAccept.push(ref);
    if (text(item.blockedReason)) {
      if (text(item.blockedReason).includes('needs_human') || text(item.id) === lastBlockedHuman) state.needsHuman.push(ref);
      const root = rootOf(item);
      blockedRoots.set(text(root.id), { id: text(root.id), title: scrubPaths(text(root.title)) });
    } else if (text(item.id) === lastBlockedHuman) {
      state.needsHuman.push(ref);
    }
  }
  state.blockedTrees = [...blockedRoots.values()];
  if (text(watcher?.stopReason)) state.stoppedWatchers.push(`${workspaceLabel(workspaceFolder)}: ${scrubPaths(text(watcher?.stopReason))}`);
  return state;
}

export function mergeOperatorDigestStates(states: OperatorDigestState[]): OperatorDigestState {
  const merged = emptyOperatorDigestState();
  for (const s of states) {
    merged.plansToApprove.push(...s.plansToApprove);
    merged.reviewsToAccept.push(...s.reviewsToAccept);
    merged.needsHuman.push(...s.needsHuman);
    merged.blockedTrees.push(...s.blockedTrees);
    merged.stoppedWatchers.push(...s.stoppedWatchers);
  }
  for (const key of ['plansToApprove', 'reviewsToAccept', 'needsHuman', 'blockedTrees'] as const) {
    merged[key] = merged[key].sort(byId);
  }
  merged.stoppedWatchers.sort();
  return merged;
}

function section(label: string, items: OperatorDigestItem[]): string[] {
  if (!items.length) return [];
  const shown = items.slice(0, DIGEST_ITEMS_PER_SECTION).map((item) => `- ${item.title || '(untitled)'} [${item.id.slice(0, 8)}]`);
  if (items.length > shown.length) shown.push(`- +${items.length - shown.length} more`);
  return [`${label}: ${items.length}`, ...shown];
}

/**
 * Pure and deterministic: the same state always yields the same title and body.
 * Returns null for an empty digest, which is never sent.
 */
export function buildOperatorDigest(state: OperatorDigestState): { title: string; body: string; total: number } | null {
  const total = state.plansToApprove.length + state.reviewsToAccept.length + state.needsHuman.length
    + state.blockedTrees.length + state.stoppedWatchers.length;
  if (total === 0) return null;
  const lines = [
    ...section('Plans to approve', state.plansToApprove),
    ...section('Failed reviews to handle', state.reviewsToAccept),
    ...section('Needs a human decision', state.needsHuman),
    ...section('Blocked trees', state.blockedTrees),
    ...(state.stoppedWatchers.length ? [`Stopped watchers: ${state.stoppedWatchers.length}`, ...state.stoppedWatchers.slice(0, DIGEST_ITEMS_PER_SECTION).map((w) => `- ${w}`)] : []),
  ];
  return { title: `Waiting for you: ${total} item${total === 1 ? '' : 's'}`, body: lines.join('\n'), total };
}

/** Read every watched workspace's todos and watcher row into one digest state. */
export async function collectOperatorDigestState(dataDir?: string): Promise<OperatorDigestState> {
  const dir = dataDir || resolveDataPath();
  const options = { dataDir: dir };
  const states: OperatorDigestState[] = [];
  for (const watcher of loadWorkspaceWatchers(options)) {
    const folder = text(watcher.workspaceFolder);
    if (!folder) continue;
    try {
      const doc = await listTodos(dir, folder);
      states.push(collectOperatorDigestForWorkspace(Array.isArray(doc?.items) ? doc.items : [], watcher, folder));
    } catch (error) {
      console.warn('[notifications] operator digest skipped a workspace:', (error as Error | undefined)?.message || error);
    }
  }
  return mergeOperatorDigestStates(states);
}

/**
 * Publish today's digest when due. The fingerprint carries the local day, so a
 * second call the same day (or after a restart) is a store-level duplicate.
 */
export async function publishOperatorDigest(
  options: { now?: number; dataDir?: string; collect?: () => Promise<OperatorDigestState>; publish?: PublishFn; storePath?: string; hour?: number } = {},
): Promise<{ published: boolean; reason?: string; fingerprint?: string }> {
  const now = options.now ?? Date.now();
  if (new Date(now).getHours() < (options.hour ?? DIGEST_HOUR)) return { published: false, reason: 'too_early' };
  const digest = buildOperatorDigest(await (options.collect || (() => collectOperatorDigestState(options.dataDir)))());
  if (!digest) return { published: false, reason: 'empty' };
  const fingerprint = `operator-digest:${digestDayKey(now)}`;
  const publish = options.publish || publishNotification;
  try {
    const result = await publish(
      { category: 'system', severity: 'important', title: digest.title, body: digest.body, actionUrl: '/?panel=todo', fingerprint },
      { ...(options.storePath ? { storePath: options.storePath } : {}), now: () => now },
    );
    return result?.created ? { published: true, fingerprint } : { published: false, reason: 'duplicate', fingerprint };
  } catch (error) {
    console.warn('[notifications] operator digest publish failed:', (error as Error | undefined)?.message || error);
    return { published: false, reason: 'publish_failed', fingerprint };
  }
}

/** Periodic job for the shared runner (`lib/periodic-job-runner.js`). */
export function createOperatorDigestJob(deps: { dataDir?: string; now?: () => number; publish?: typeof publishOperatorDigest } = {}) {
  const publish = deps.publish || publishOperatorDigest;
  return Object.freeze({
    id: 'operator_digest',
    label: 'Operator daily digest',
    settingKey: 'operatorDigest',
    intervalMs: DIGEST_INTERVAL_MS,
    runOnStart: true,
    jitterMs: 15000,
    isEnabled: () => true,
    run: async () => publish({ now: (deps.now || Date.now)(), dataDir: deps.dataDir }),
  });
}
