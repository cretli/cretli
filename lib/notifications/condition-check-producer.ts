/** Notification-center entries for settled `condition_check` rows. */
import { publishNotification } from './notification-store.ts';
import { broadcastPush } from '../push.js';

/** Settled states that produce a notification (`armed` and `cancelled` never do). */
export const CONDITION_CHECK_NOTIFIED_STATES: readonly string[] = Object.freeze(['resumed', 'blocked', 'expired']);

/** Settled `condition_check` row as read by this producer. */
export interface ConditionCheckRecord {
  id: string;
  state: string;
  title?: string;
  subjectId?: string;
  action?: { todoId?: string } | null;
  reason?: string;
  startedChatId?: string;
}

type PublishFn = (input: Record<string, unknown>) => Promise<{ created?: boolean } | undefined | null>;
type PushFn = (payload: Record<string, unknown>) => Promise<unknown>;

/**
 * One fingerprint per check and state: a replayed scheduler event or a second
 * tick over the same row cannot publish twice.
 *
 */
export function fingerprintConditionCheck(record: { id: string; state: string }): string {
  return `condition-check:${record.id}:${record.state}`;
}

function describe(record: ConditionCheckRecord): { severity: string; title: string; body: string } {
  const title = String(record.title || 'Scheduled check');
  if (record.state === 'resumed') {
    return {
      severity: 'info',
      title: 'Scheduled check met: started a chat',
      body: `${title} (todo ${record.action?.todoId || record.subjectId || ''}).`,
    };
  }
  if (record.state === 'expired') {
    return { severity: 'info', title: 'Scheduled check expired without firing', body: `${title}: the condition was not met in time.` };
  }
  return { severity: 'warning', title: 'Scheduled check blocked', body: `${title}: ${record.reason || 'unknown'}.` };
}

function actionUrlFor(record: ConditionCheckRecord): string {
  return record.startedChatId
    ? `/?panel=chat&chat=${encodeURIComponent(record.startedChatId)}`
    : '/?panel=settings&tab=wakeups';
}

/**
 * Publishes one `system` notification for a settled check. Never throws.
 *
 */
export async function publishConditionCheckNotification(
  input: { record?: ConditionCheckRecord } | null | undefined,
  options: { publish?: PublishFn; push?: PushFn } = {},
): Promise<{ published: boolean; reason?: string }> {
  const record = input?.record;
  if (!record || !CONDITION_CHECK_NOTIFIED_STATES.includes(record.state)) return { published: false, reason: 'not_notified_state' };
  const publish = options.publish || publishNotification;
  const push = options.push || broadcastPush;
  const { severity, title, body } = describe(record);
  const fingerprint = fingerprintConditionCheck(record);
  const actionUrl = actionUrlFor(record);
  let result: Awaited<ReturnType<PublishFn>>;
  try {
    result = await publish({ category: 'system', severity, title, body, actionUrl, fingerprint });
  } catch (error) {
    console.warn('[notifications] condition-check publish failed:', (error as Error | undefined)?.message || error);
    return { published: false, reason: 'publish_failed' };
  }
  if (!result?.created) return { published: false, reason: 'duplicate' };
  try {
    await push({ title, body, tag: fingerprint, data: { type: 'condition-check', eventId: fingerprint, url: actionUrl } });
  } catch (error) {
    console.warn('[notifications] condition-check push failed:', (error as Error | undefined)?.message || error);
  }
  return { published: true };
}
