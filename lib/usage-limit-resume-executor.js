/**
 * Wake-up kind `usage_limit_resume`: the chat/delegation-specific half of the
 * generic scheduler (`lib/wakeup-scheduler.js`). It supplies the read-only
 * preflight (`prepare`), the policy call (`decide`), the single provider
 * action (`execute`) and the tri-state crash resolution (`resolveCrash`).
 *
 * Hard rules: a resume is never replayed from the original prompt; an
 * ambiguous provider result is never refunded or re-sent; after a crash only
 * proof (`accepted:true`, a different delegation `attemptId`, a busy run)
 * counts as success, and an unknown or idle chat becomes `start_uncertain`.
 */

import { decodeModelValue } from './model-catalog.js';
import { USAGE_LIMIT_RESUME_KIND, normalizePauseRecord } from './usage-limit-paused.js';
import { USAGE_LIMIT_RESUME_SETTINGS_SCHEMA, readUsageLimitResumeSettings } from './usage-limit-resume-settings.js';
import {
  decideResumeAction,
  resolvePauseDueAt,
  selectResumeCandidates,
} from './usage-limit-resume-policy.js';
import { PREMIUM_COST_TIER } from './model-pick-cost-policy.js';

export const RESUME_CHAT_PROMPT = '[AUTO-RESUME] The previous turn stopped because the provider usage limit was reached; '
  + 'the limit has reset. Continue the task from where it stopped and do not repeat steps that already completed successfully.';

/** Definitive refusals: no run started, so the attempt is refunded. */
const REFUND_CODES = new Set([
  'adapter_unavailable', 'recipient_busy', 'still_active', 'update_in_progress',
  'runtime_not_ready', 'chat_archived', 'delegation_archived', 'parent_archived',
]);
const isRefundCode = (code) => REFUND_CODES.has(code) || code.startsWith('slot_');
const BLOCK_CODES = new Set(['chat_not_found', 'start_failed']);

const codeOf = (err) => String(err && typeof err === 'object' && 'code' in err ? err.code : '').trim();

/**
 * Real collaborators are loaded lazily so unit tests (and tools that only need
 * the policy) never pull the chat-run or delegation graph.
 *
 * @param {object} [overrides]
 * @returns {Promise<object>} the resolved dependency set
 */
export async function loadDefaultResumeDeps(overrides = {}) {
  const [limits, chatRun, chats, delegations, meta, transport] = await Promise.all([
    import('./harness-usage-limits.js'),
    import('./chat-run-service.js'),
    import('./persist/chats-persist.js'),
    import('./persist/delegations-persist.js'),
    import('./model-catalog-meta.js'),
    import('./agent-transport.js'),
  ]);
  return {
    getLimit: (input) => limits.getHarnessUsageLimit({ ...input, latest: true }),
    estimateCostTier: (modelId, params) => meta.estimateModelCostTier(modelId, params),
    loadChat: (id) => chats.loadChats().find((row) => row.id === id) || null,
    getTransport: (chat) => transport.getChatAgentTransport(chat),
    hasChatRunAdapter: (t) => chatRun.hasChatRunAdapter(t),
    startChatRun: (input) => chatRun.startChatRun(input),
    lookupChatRunRequest: (input) => chatRun.lookupChatRunRequest(input),
    probeChatRunLiveness: (input) => chatRun.probeChatRunLiveness(input),
    getDelegation: (id) => delegations.getDelegationById(id),
    ...overrides,
  };
}

/**
 * @param {{
 *   getLimit: Function, estimateCostTier: Function, loadChat: Function, getTransport: Function,
 *   hasChatRunAdapter: Function, startChatRun: Function, lookupChatRunRequest: Function,
 *   probeChatRunLiveness: Function, getDelegation: Function, retryDelegation: Function,
 *   readSettings?: Function, dataDir?: string,
 * }} deps
 * @returns {object} a kind for `createWakeupScheduler().registerKind`
 */
export function createUsageLimitResumeKind(deps) {
  const readSettings = deps.readSettings || (() => readUsageLimitResumeSettings());

  function priceSubject(subjectModel) {
    const raw = String(subjectModel || '').trim();
    const { modelId, params } = decodeModelValue(raw);
    // Empty/unknown is premium: an account-wide lockout hides the model.
    if (!raw || modelId === 'auto') return PREMIUM_COST_TIER;
    const tier = deps.estimateCostTier(modelId, params);
    return Number.isFinite(tier) ? tier : PREMIUM_COST_TIER;
  }

  function prepare(record) {
    const lockout = deps.getLimit({ harness: record.harness, model: record.model, dataDir: deps.dataDir }) || null;
    const costTier = priceSubject(record.subjectModel);
    if (record.subjectType === 'delegation') {
      const row = deps.getDelegation(record.subjectId);
      return {
        lockout,
        costTier,
        parentBusy: false,
        sessionResumable: true,
        subjectMissing: !row,
        subjectMoved: Boolean(row)
          && (row.status !== 'failed' || String(row.attemptId || '') !== record.subjectAttemptId),
      };
    }
    const chat = deps.loadChat(record.subjectId);
    const live = chat ? deps.probeChatRunLiveness({ chatId: record.subjectId }) : null;
    return {
      lockout,
      costTier,
      // Unknown liveness may hide a still-running turn, so only a known idle proceeds.
      parentBusy: Boolean(chat) && !(live?.known === true && live.busy === false),
      sessionResumable: Boolean(chat) && deps.hasChatRunAdapter(deps.getTransport(chat)),
    };
  }

  async function executeChat(record) {
    try {
      const started = await deps.startChatRun({
        chatId: record.subjectId,
        prompt: RESUME_CHAT_PROMPT,
        requestId: record.resumeRequestId,
        mode: 'agent',
      });
      if (started?.accepted === true) return { outcome: 'resumed', reason: '' };
      if (started?.accepted === false) return { outcome: 'refund', reason: 'not_accepted' };
      return { outcome: 'ambiguous', reason: 'acceptance_unconfirmed' };
    } catch (err) {
      const code = codeOf(err);
      if (isRefundCode(code)) return { outcome: 'refund', reason: code };
      if (BLOCK_CODES.has(code)) return { outcome: 'blocked', reason: code };
      return { outcome: 'ambiguous', reason: code || 'start_error' };
    }
  }

  async function executeDelegation(record) {
    let result;
    try {
      result = await deps.retryDelegation(record.subjectId);
    } catch (err) {
      return { outcome: 'ambiguous', reason: codeOf(err) || 'retry_error' };
    }
    if (result?.ok === true) return { outcome: 'resumed', reason: '' };
    const code = String(result?.code || '').trim();
    if (isRefundCode(code)) return { outcome: 'refund', reason: code };
    if (code === 'not_found') return { outcome: 'blocked', reason: 'session_not_resumable' };
    // retry() assigns a fresh attemptId before starting, so a failed start
    // carries a new id too; only ok:true proves acceptance.
    if (code === 'start_failed') return { outcome: 'blocked', reason: 'start_failed' };
    return { outcome: 'blocked', reason: 'retry_refused' };
  }

  function resolveDelegationCrash(record) {
    const row = deps.getDelegation(record.subjectId);
    if (!row) return { outcome: 'blocked', reason: 'session_not_resumable' };
    const attemptId = String(row.attemptId || '');
    if (attemptId && attemptId !== record.subjectAttemptId) {
      // A new attempt that already failed may be our own failed start: never claim resumed.
      if (row.status === 'failed') return { outcome: 'blocked', reason: 'start_uncertain' };
      return { outcome: 'resumed', reason: '' };
    }
    return { outcome: 'refund', reason: 'retry_not_started' };
  }

  function resolveChatCrash(record) {
    let lookup = null;
    try {
      lookup = deps.lookupChatRunRequest({ chatId: record.subjectId, requestId: record.resumeRequestId });
    } catch {
      lookup = null;
    }
    if (lookup?.accepted === true) return { outcome: 'resumed', reason: '' };
    if (lookup?.accepted === false) return { outcome: 'refund', reason: 'not_accepted' };
    // `null` means "no answer" (most transports have no `lookupRequest`).
    // Only a busy run is proof; idle or unknown must never trigger a second turn.
    const live = deps.probeChatRunLiveness({ chatId: record.subjectId });
    if (live?.known === true && live.busy === true) return { outcome: 'resumed', reason: '' };
    return { outcome: 'blocked', reason: 'start_uncertain' };
  }

  return {
    kind: USAGE_LIMIT_RESUME_KIND,
    label: 'Usage-limit resume',
    description: 'Automatically resumes work after a provider usage limit resets.',
    settingsSchema: USAGE_LIMIT_RESUME_SETTINGS_SCHEMA,
    getSettings: readSettings,
    normalize: normalizePauseRecord,
    resolveDueAt: resolvePauseDueAt,
    describeRow: (record, ctx) => {
      const dueMs = resolvePauseDueAt(record, ctx.settings);
      return { dueAt: Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : null };
    },
    selectCandidates: selectResumeCandidates,
    buildRequestId: (record, attempt) => `ulresume:${record.id}:${attempt}`,
    prepare,
    decide: ({ record, now, dueAt, settings, prepared }) => decideResumeAction({
      record, now, dueAt, settings, ...prepared,
    }),
    execute: (record) => (record.subjectType === 'delegation' ? executeDelegation(record) : executeChat(record)),
    resolveCrash: (record) => (record.subjectType === 'delegation'
      ? resolveDelegationCrash(record)
      : resolveChatCrash(record)),
  };
}
