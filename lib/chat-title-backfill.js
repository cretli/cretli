/**
 * One-off backfill of titles for chats that still carry a placeholder name (titleSource === 'default').
 *
 * Modes (explicit, safest first):
 *  - dry-run (default): lists the candidates and why others are skipped. No model call, no write.
 *  - propose: also asks the title model for a proposal per candidate (costs tokens), still no write.
 *  - apply: generates and stores the titles through the shared title service (same budget,
 *    CAS and history as live auto-titles). Never reached unless `apply === true` is passed.
 *
 * A cost cap (`limit` generation calls per run, hard maximum MAX_BACKFILL_LIMIT) and a sequential
 * queue keep the run cheap; it also stops on the first "no generator" and after repeated errors.
 */

import { loadChats } from './persist/chats-persist.js';
import { loadAllChatHistoryEvents } from './context-compression-source.js';
import { getAutoTitleSkipReason } from './chat-title-dispatcher.js';
import { createChatTitleService, findFirstUserMessage, getChatTitleService } from './chat-title-service.js';

export const DEFAULT_BACKFILL_LIMIT = 25;
export const MAX_BACKFILL_LIMIT = 200;
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function normalizeBackfillLimit(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BACKFILL_LIMIT;
  return Math.min(n, MAX_BACKFILL_LIMIT);
}

/**
 * @param {{
 *   apply?: boolean,
 *   propose?: boolean,
 *   limit?: number,
 *   service?: { requestTitle: Function },
 *   generate?: Parameters<typeof createChatTitleService>[0]['generate'], // propose mode only (tests)
 *   loadAllChats?: () => object[],
 *   loadEvents?: (id: string) => Array<object>,
 *   log?: (msg: string) => void,
 * }} [options]
 * @returns {Promise<{
 *   mode: 'dry-run' | 'propose' | 'apply',
 *   limit: number,
 *   candidates: Array<{ chatId: string, title: string, harness: string }>,
 *   skipped: Record<string, number>,
 *   results: Array<{ chatId: string, status: string, title?: string, reason?: string }>,
 *   stoppedEarly?: string,
 * }>}
 */
export async function runChatTitleBackfill(options = {}) {
  const apply = options.apply === true;
  const mode = apply ? 'apply' : (options.propose === true ? 'propose' : 'dry-run');
  const limit = normalizeBackfillLimit(options.limit);
  const loadAllChats = options.loadAllChats || loadChats;
  const loadEvents = options.loadEvents || loadAllChatHistoryEvents;
  const log = options.log || ((m) => console.log(`[chat-title-backfill] ${m}`));

  const skipped = {};
  const bump = (reason) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
  };
  const candidates = [];
  const rows = [...loadAllChats()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  for (const chat of rows) {
    const reason = getAutoTitleSkipReason(chat);
    if (reason) {
      // 'not_default' covers manual and auto titles — the bulk of the list; keep it out of the noise.
      if (reason !== 'not_default') bump(reason);
      continue;
    }
    if (!findFirstUserMessage(loadEvents(chat.id))) {
      bump('no_content');
      continue;
    }
    candidates.push({ chatId: chat.id, title: chat.title || '', harness: chat.agentTransport || 'sdk' });
  }

  const report = { mode, limit, candidates, skipped, results: [] };
  if (mode === 'dry-run') return report;

  // Proposals never write: a throwaway service whose "apply" step only echoes the title.
  const service = options.service || (apply
    ? getChatTitleService()
    : createChatTitleService({
      generate: options.generate,
      applyTitle: (id, title) => ({ applied: true, chat: { id, title } }),
      budget: { minIntervalMs: 0, perChatPerDay: 1000 },
      log: () => {},
    }));

  let generated = 0;
  let consecutiveErrors = 0;
  for (const candidate of candidates) {
    if (generated >= limit) {
      report.stoppedEarly = 'limit';
      break;
    }
    const result = await service.requestTitle(candidate.chatId, { reason: 'backfill' });
    if (result.status === 'skipped' && result.reason === 'no_generator') {
      report.stoppedEarly = 'no_generator';
      break;
    }
    if (result.status === 'skipped' && (result.reason === 'global_daily_limit' || result.reason === 'disabled')) {
      report.stoppedEarly = result.reason;
      break;
    }
    // Only real generation attempts count against the cost cap.
    if (result.status === 'applied' || result.reason === 'rejected_output' || result.status === 'error') {
      generated += 1;
    }
    consecutiveErrors = result.status === 'error' ? consecutiveErrors + 1 : 0;
    report.results.push({
      chatId: candidate.chatId,
      status: result.status,
      ...(result.title ? { title: result.title } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    });
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      report.stoppedEarly = 'errors';
      break;
    }
  }
  log(`${mode} done: candidates=${candidates.length} processed=${report.results.length} stoppedEarly=${report.stoppedEarly || 'no'}`);
  return report;
}
