/**
 * Per-leaf cost/token budget measurement for the parent-loop workflow.
 *
 * The gate itself lives in `delegation-workflow.js`; this module only answers
 * "how much has this leaf already spent". It is deliberately conservative: it
 * reports `measured: false` when there is no usable measurement, so a missing
 * ledger never turns into a false `workflow_budget_exhausted` block.
 */

import { readUsageEvents } from './persist/usage-persist.js';
import { listDelegationsForParent } from './persist/delegations-persist.js';
import { billedTotalTokens } from './usage/usage-contract.js';
import {
  delegationRowMatchesWorkflowLeaf,
  normalizeDelegationWorkflowLeafId,
} from './delegation-workflow-leaf.js';

const BUDGET_LOOKBACK_FALLBACK_MS = 30 * 24 * 60 * 60 * 1000;
const BUDGET_LOOKBACK_PAD_MS = 60 * 60 * 1000;

/**
 * @param {object} row
 * @returns {number}
 */
function readJobCreatedMs(row) {
  const stamp = Date.parse(String(row?.createdAt || row?.queuedAt || ''));
  return Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
}

/**
 * @typedef {{
 *   measured: boolean,
 *   tokens: number,
 *   usd: number,
 *   eventCount: number,
 *   delegationIds: string[],
 * }} DelegationWorkflowUsageSummary
 */

/**
 * Sum the usage ledger for every delegation attributed to one workflow leaf.
 *
 * Matching uses the same explicit leaf attribution as the round inference:
 * a job counts only when its `cretli-ref todo=`/`leafId` matches. Because the
 * ledger has no per-delegation index, callers must only invoke this when a
 * budget is actually configured.
 *
 * @param {{ parentChatId?: unknown, leafId?: unknown, now?: unknown }} [input]
 * @returns {DelegationWorkflowUsageSummary}
 */
export function summarizeDelegationWorkflowUsage(input = {}) {
  const parentChatId = String(input.parentChatId || '').trim();
  const leafId = normalizeDelegationWorkflowLeafId({ leafId: input.leafId });
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const empty = { measured: false, tokens: 0, usd: 0, eventCount: 0, delegationIds: [] };
  if (!parentChatId || !leafId) return empty;
  const jobs = listDelegationsForParent(parentChatId)
    .filter((row) => delegationRowMatchesWorkflowLeaf(row, leafId));
  if (jobs.length === 0) return empty;
  const delegationIds = new Set(
    jobs.map((row) => String(row?.id || '').trim()).filter(Boolean),
  );
  const childChatIds = new Set(
    jobs.map((row) => String(row?.childChatId || '').trim()).filter(Boolean),
  );
  const created = jobs.map(readJobCreatedMs).filter((value) => value > 0);
  const fromMs = created.length > 0
    ? Math.min(...created) - BUDGET_LOOKBACK_PAD_MS
    : now - BUDGET_LOOKBACK_FALLBACK_MS;
  let events = [];
  try {
    events = readUsageEvents({
      from: new Date(fromMs).toISOString(),
      to: new Date(now).toISOString(),
    });
  } catch {
    return empty;
  }
  let tokens = 0;
  let usd = 0;
  let eventCount = 0;
  let measured = false;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (String(event.eventType || '') === 'run') continue;
    const delegationId = String(event.delegationId || '').trim();
    const chatId = String(event.chatId || '').trim();
    const matches = (delegationId && delegationIds.has(delegationId))
      || (chatId && childChatIds.has(chatId));
    if (!matches) continue;
    const tokenBag = event.tokens && typeof event.tokens === 'object' ? event.tokens : {};
    const tokenTotal = Number(billedTotalTokens(tokenBag, event.harness)) || 0;
    const usdValue = Number(event.usd);
    const hasUsd = Number.isFinite(usdValue) && usdValue > 0;
    const hasMeasurement = tokenTotal > 0 || hasUsd || event.measurementPresent === true;
    if (!hasMeasurement) continue;
    measured = true;
    eventCount += 1;
    if (tokenTotal > 0) tokens += tokenTotal;
    if (hasUsd) usd += usdValue;
  }
  return {
    measured,
    tokens: Math.round(tokens),
    usd: Number(usd.toFixed(6)),
    eventCount,
    delegationIds: [...delegationIds],
  };
}
