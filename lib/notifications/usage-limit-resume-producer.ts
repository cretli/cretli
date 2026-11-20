/** Notification-center entries for usage-limit auto-resume episodes. */
import { getNotificationCenterPreferences } from './notification-preferences.ts';
import { publishNotification } from './notification-store.ts';
import { broadcastPush } from '../push.js';

/** Settled usage-limit pause row as read by this producer. */
export interface UsageLimitResumeRecord {
  id: string;
  state: string;
  harness: string;
  model?: string;
  subjectType: string;
  subjectId?: string;
  parentChatId?: string;
  reason?: string;
}

type PublishFn = (input: Record<string, unknown>) => Promise<{ created?: boolean } | undefined | null>;
type PushFn = (payload: Record<string, unknown>) => Promise<unknown>;

/** Settled states that produce a notification (`cancelled` is operator-initiated). */
export const NOTIFIED_STATES: readonly string[] = Object.freeze(['resumed', 'blocked', 'expired']);

/**
 * One fingerprint per pause and state: a replayed scheduler event or a second
 * tick over the same row cannot publish twice.
 *
 */
export function fingerprintResumeEpisode(record: { id: string; state: string }): string {
  return `usage-limit-resume:${record.id}:${record.state}`;
}

function describe(record: UsageLimitResumeRecord): { severity: string; title: string; body: string } {
  const label = record.model ? `${record.harness} (${record.model})` : record.harness;
  if (record.state === 'resumed') {
    return { severity: 'important', title: 'Run resumed after the usage limit reset', body: `${label}: the ${record.subjectType} was resumed automatically.` };
  }
  if (record.state === 'expired') {
    return { severity: 'warning', title: 'Usage limit reset was missed', body: `${label}: the reset happened while the server was offline, so the ${record.subjectType} was not resumed automatically.` };
  }
  const reason = record.reason || 'unknown';
  const body = reason === 'start_uncertain'
    ? `${label}: automatic resume may have started before a restart; it was not repeated. Check the ${record.subjectType} before continuing.`
    : `${label}: automatic resume was blocked (${reason}).`;
  return { severity: 'warning', title: 'Automatic resume blocked', body };
}

function actionUrlFor(record: UsageLimitResumeRecord): string {
  const chatId = record.subjectType === 'chat' ? record.subjectId : record.parentChatId;
  return chatId ? `/?panel=chat&chat=${encodeURIComponent(chatId)}` : '/?panel=settings&tab=usage';
}

/**
 * Publishes one notification for a settled pause. Never throws: a failed push
 * is logged, a failed publish is reported to the caller as `published: false`.
 *
 */
export async function publishUsageLimitResumeNotification(
  input: { record?: UsageLimitResumeRecord } | null | undefined,
  options: { preferences?: { usageLimitResume?: boolean }; publish?: PublishFn; push?: PushFn } = {},
): Promise<{ published: boolean; reason?: string }> {
  const record = input?.record;
  if (!record || !NOTIFIED_STATES.includes(record.state)) return { published: false, reason: 'not_notified_state' };
  const preferences = options.preferences || getNotificationCenterPreferences();
  if (preferences.usageLimitResume === false) return { published: false, reason: 'disabled' };
  const publish = options.publish || publishNotification;
  const push = options.push || broadcastPush;
  const { severity, title, body } = describe(record);
  const fingerprint = fingerprintResumeEpisode(record);
  const actionUrl = actionUrlFor(record);
  let result: Awaited<ReturnType<PublishFn>>;
  try {
    result = await publish({ category: 'system', severity, title, body, actionUrl, fingerprint });
  } catch (error) {
    // A notification failure must never interrupt the scheduler tick.
    console.warn('[notifications] usage-limit resume publish failed:', (error as Error | undefined)?.message || error);
    return { published: false, reason: 'publish_failed' };
  }
  if (!result?.created) return { published: false, reason: 'duplicate' };
  try {
    await push({ title, body, tag: fingerprint, data: { type: 'usage-limit-resume', eventId: fingerprint, url: actionUrl } });
  } catch (error) {
    console.warn('[notifications] usage-limit resume push failed:', (error as Error | undefined)?.message || error);
  }
  return { published: true };
}
