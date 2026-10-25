/**
 * Maps harness/chat events to in-app notification centre rows.
 */

import { createHash } from 'node:crypto';

import { publishNotification } from './notification-store.ts';

/**
 * Fingerprint for a catalog change. Hashes the resulting sorted id set (short,
 * stable, bounded) so a retry after a failed snapshot write reuses the same
 * fingerprint and stays deduped, while a later, different id set hashes
 * differently and becomes a new occurrence.
 *
 * @param modelIds sorted unique ids
 */
export function fingerprintModelsCatalogChange(harness: string, modelIds: string[]): string {
  const id = String(harness || '').trim().toLowerCase();
  const joined = [...modelIds].map((value) => String(value)).sort().join('\u0001');
  const hash = createHash('sha256').update(joined).digest('hex').slice(0, 32);
  return `models:catalog:${id}:${hash}`;
}

/**
 * Stable fingerprint for a recurring producer that models discrete episodes
 * (server self-check, unclassified-errors, ...). The producer keeps an episode
 * counter/version that advances when a genuinely new episode starts, so a
 * replayed episode stays deduped while the next episode becomes a new item.
 *
 */
export function notificationFingerprintWithEpisode(baseFingerprint: string, episode: string | number): string {
  const base = String(baseFingerprint || '').trim();
  const value = episode == null ? '' : String(episode).trim();
  if (!base) return '';
  return value ? `${base}#episode:${value}` : base;
}

/**
 * @param kind finished|question|permission|newChat
 */
export function fingerprintChatNotification(kind: string, ids: { chatId?: string; runId?: string; requestId?: string } = {}): string {
  const chatId = String(ids.chatId || '').trim();
  const runId = String(ids.runId ?? '').trim();
  const requestId = String(ids.requestId ?? '').trim();
  if (kind === 'finished') return `chat:finished:${chatId}:${runId}`;
  if (kind === 'question') return `chat:question:${chatId}:${requestId}`;
  if (kind === 'permission') return `chat:permission:${chatId}:${requestId}`;
  if (kind === 'newChat') return `chat:newChat:${chatId}`;
  return `chat:${kind}:${chatId}:${runId || requestId}`;
}

/** Room state mutated to track which run id a finished notification consumed. */
interface NotificationRoomState {
  _notificationConsumedRunId?: string;
  _notificationFinishDiscriminator?: string;
  _notificationFinishSeq?: number;
}

export async function publishAgentFinishedNotification(input: {
  chatId?: string;
  chatTitle?: string;
  status?: string;
  runId?: unknown;
  roomRunId?: unknown;
  room?: object | null;
} = {}): Promise<void> {
  const chatId = String(input.chatId || '').trim();
  const status = String(input.status || 'done').trim() || 'done';
  const runId = String(input.runId ?? '').trim();
  const roomRunId = String(input.roomRunId ?? '').trim();
  const room = input.room && typeof input.room === 'object' ? (input.room as NotificationRoomState) : null;
  // Fall back to the room's durable per-run id (minted by `beginHarnessRun` or
  // the local socket watcher) when the harness event carries no `runId`. It is
  // identical for a replay of the same finish and different for a new run.
  let occurrenceId = runId || roomRunId;
  if (!occurrenceId) {
    // Without a per-run discriminator we cannot tell a replay from a new run;
    // collapsing to `chat:finished:<chatId>:` would hide a new run behind a
    // dismissed notice. Skip instead of mis-attributing the occurrence.
    console.warn('[notifications] agent-finished publish skipped: no run discriminator', { chatId });
    return;
  }
  if (room) {
    const consumed = String(room._notificationConsumedRunId || '');
    if (runId || consumed !== roomRunId) {
      // This finish owns a run id, or the room's id was not consumed yet: it
      // becomes the occurrence for this run.
      room._notificationConsumedRunId = occurrenceId;
      room._notificationFinishDiscriminator = '';
    } else {
      // The finish carries no run id of its own and the room's durable id was
      // already used by an earlier finished notification. This is a
      // finish-before-start (e.g. a setup failure emitted before its own
      // `sdkPromptStarted`), which inherits the PREVIOUS run's room id; reusing
      // it would dedupe the new failure away. Mint a deterministic distinct
      // discriminator for this failure episode and reuse it for a replay of the
      // same failure until a new run is consumed.
      if (!room._notificationFinishDiscriminator) {
        room._notificationFinishSeq = (Number(room._notificationFinishSeq) || 0) + 1;
        room._notificationFinishDiscriminator = `${roomRunId}:finish:${room._notificationFinishSeq}`;
      }
      occurrenceId = room._notificationFinishDiscriminator;
    }
  }
  const title = 'Agent finished';
  const chatLabel = String(input.chatTitle || '').trim() || chatId || 'chat';
  const body = `Chat "${chatLabel}" — run ended (${status}).`;
  const actionUrl = chatId
    ? `/?panel=chat&chat=${encodeURIComponent(chatId)}`
    : '/?panel=chat';
  await publishNotification({
    category: 'chat',
    severity: status === 'error' ? 'error' : 'info',
    title,
    body,
    actionUrl,
    fingerprint: fingerprintChatNotification('finished', { chatId, runId: occurrenceId }),
  });
}

export async function publishChatCreatedNotification(input: { chatId?: string; chatTitle?: string } = {}): Promise<void> {
  const chatId = String(input.chatId || '').trim();
  if (!chatId) return;
  const chatLabel = String(input.chatTitle || '').trim() || chatId;
  await publishNotification({
    category: 'chat',
    severity: 'info',
    title: 'New chat',
    body: `New chat "${chatLabel}" was created.`,
    actionUrl: `/?panel=chat&chat=${encodeURIComponent(chatId)}`,
    fingerprint: fingerprintChatNotification('newChat', { chatId }),
  });
}

export async function publishAgentNeedsInputNotification(input: {
  chatId?: string;
  chatTitle?: string;
  kind?: 'question' | 'permission';
  requestId?: unknown;
  detail?: string;
} = {}): Promise<void> {
  const kind = input.kind === 'permission' ? 'permission' : input.kind === 'question' ? 'question' : '';
  if (!kind) return;
  const chatId = String(input.chatId || '').trim();
  const chatLabel = String(input.chatTitle || '').trim() || chatId || 'chat';
  const detail = String(input.detail || '').trim();
  const isPermission = kind === 'permission';
  const title = isPermission ? 'Permission required' : 'Question from agent';
  const body = detail
    ? `Chat "${chatLabel}": ${detail}`
    : (isPermission
      ? `Chat "${chatLabel}" is waiting for a permission.`
      : `Chat "${chatLabel}" is waiting for an answer.`);
  await publishNotification({
    category: 'chat',
    severity: isPermission ? 'important' : 'info',
    title,
    body,
    actionUrl: chatId ? `/?panel=chat&chat=${encodeURIComponent(chatId)}` : '/?panel=chat',
    fingerprint: fingerprintChatNotification(kind, {
      chatId,
      requestId: String(input.requestId ?? ''),
    }),
  });
}

export async function publishModelsCatalogChangedNotification(harness: string, previousIds: string[], nextIds: string[]): Promise<void> {
  if (!previousIds.length) return;
  const prev = new Set(previousIds);
  const next = new Set(nextIds);
  const added = nextIds.filter((id) => !prev.has(id));
  const removed = previousIds.filter((id) => !next.has(id));
  if (added.length === 0 && removed.length === 0) return;
  const id = String(harness || '').trim().toLowerCase();
  const summary = [
    added.length ? `${added.length} added` : '',
    removed.length ? `${removed.length} removed` : '',
  ].filter(Boolean).join(', ');
  await publishNotification({
    category: 'models',
    severity: 'info',
    title: 'Model catalog updated',
    body: summary ? `Harness "${id}": ${summary}.` : `Harness "${id}" model list changed.`,
    actionUrl: '/?panel=settings&tab=harness',
    fingerprint: fingerprintModelsCatalogChange(id, nextIds),
  });
}

/**
 * Archive / restore / delete of a chat from the UI or API. Archive and restore
 * carry an `undo` action (the inverse operation); delete is permanent, so none.
 *
 */
export async function publishChatLifecycleNotification(
  input: { chatId?: string; chatTitle?: string; action?: 'archived' | 'restored' | 'deleted' } = {},
): Promise<void> {
  const chatId = String(input.chatId || '').trim();
  const action = String(input.action || '').trim() as 'archived' | 'restored' | 'deleted';
  if (!chatId || !['archived', 'restored', 'deleted'].includes(action)) return;
  const label = String(input.chatTitle || '').trim() || chatId;
  const titles = { archived: 'Chat archived', restored: 'Chat restored', deleted: 'Chat deleted' };
  const undoKinds: Partial<Record<'archived' | 'restored' | 'deleted', string>> = { archived: 'restoreChat', restored: 'archiveChat' };
  await publishNotification({
    category: 'chat',
    severity: 'info',
    title: titles[action],
    body: `"${label}" was ${action}.`,
    actionUrl: action === 'deleted' ? '' : `/?panel=chat&chat=${encodeURIComponent(chatId)}`,
    fingerprint: `chat:${action}:${chatId}:${Date.now()}`,
    ...(undoKinds[action] ? { undo: { kind: undoKinds[action], chatId } } : {}),
  });
}

/** Rate limit for unclassified-error notifications: at most this many per window. */
export const UNCLASSIFIED_ERROR_NOTIFY_MAX = 5;
export const UNCLASSIFIED_ERROR_NOTIFY_WINDOW_MS = 10 * 60 * 1000;

const unclassifiedNotifyTimes: number[] = [];

/** Test hook: forget the in-memory rate-limit window. */
export function resetUnclassifiedErrorNotifyRateLimit(): void {
  unclassifiedNotifyTimes.length = 0;
}

/**
 * Notification for an "unclassified-errors" episode: a new failure signature, or the
 * first occurrence after the signature was acknowledged. Occurrences inside an open
 * episode never reach this producer. The fingerprint carries the episode and its
 * reopen count, so a replay of the same episode stays deduped in the store.
 *
 * A process-wide window caps bursts; a throttled episode stays visible in the health
 * card (the registry state is not affected), it just does not ring a second bell.
 *
 * `message` must already be redacted by the caller; it is sanitised again by the store.
 */
export async function publishUnclassifiedErrorNotification(
  input: {
    harness?: string;
    model?: string;
    signatureId?: string;
    category?: 'unclassified' | 'tool_not_found';
    message?: string;
    episode?: number;
    reopens?: number;
    reopened?: boolean;
  } = {},
  options: { now?: () => number; publish?: (item: Record<string, unknown>) => Promise<unknown> } = {},
): Promise<'published' | 'rate_limited' | 'invalid'> {
  const harness = String(input.harness || '').trim().toLowerCase();
  const signatureId = String(input.signatureId || '').trim();
  if (!harness || !signatureId) return 'invalid';
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  while (unclassifiedNotifyTimes.length && now - unclassifiedNotifyTimes[0] >= UNCLASSIFIED_ERROR_NOTIFY_WINDOW_MS) {
    unclassifiedNotifyTimes.shift();
  }
  if (unclassifiedNotifyTimes.length >= UNCLASSIFIED_ERROR_NOTIFY_MAX) return 'rate_limited';
  unclassifiedNotifyTimes.push(now);
  const compat = input.category === 'tool_not_found';
  const model = String(input.model || '').trim();
  const where = model ? `${harness} / ${model}` : harness;
  const publish = options.publish || ((item: Record<string, unknown>) => publishNotification(item, { now: () => now }));
  await publish({
    category: 'system',
    severity: 'warning',
    title: compat
      ? (input.reopened ? 'Tool compatibility problem recurred' : 'Tool compatibility problem')
      : (input.reopened ? 'Unclassified provider error recurred' : 'Unclassified provider error'),
    body: `${where}: ${String(input.message || '').trim() || 'no details'}`,
    actionUrl: '/?panel=settings&tab=harness',
    fingerprint: notificationFingerprintWithEpisode(
      `unclassified-errors:${harness}:${signatureId}`,
      `${Number(input.episode) || 1}r${Number(input.reopens) || 0}`,
    ),
  });
  return 'published';
}
