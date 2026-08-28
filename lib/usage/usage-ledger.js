/**
 * Records priced usage events and builds summaries.
 */

import { appendUsageEvent, readUsageEvents } from '../persist/usage-persist.js';
import { createUsageEvent, emptyUsageTokens } from './usage-event.js';
import { priceUsage } from './usage-rates.js';

/**
 * @param {object} [partial]
 * @param {{ dataDir?: string }} [ctx]
 * @returns {object}
 */
export function recordUsage(partial = {}, ctx = {}) {
  const priced = priceUsage(createUsageEvent(partial));
  appendUsageEvent(priced, ctx);
  return priced;
}

/**
 * Ledger writes must never break the user-facing request.
 *
 * @param {object} [partial]
 * @param {{ dataDir?: string }} [ctx]
 * @returns {object|null}
 */
export function safeRecordUsage(partial = {}, ctx = {}) {
  try {
    return recordUsage(partial, ctx);
  } catch (error) {
    console.error('[usage] record failed', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * @param {object[]} events
 * @returns {object}
 */
export function summarizeUsage(events) {
  const summary = {
    totalUsd: 0,
    estimatedUsd: 0,
    unpricedEvents: 0,
    tokens: emptyUsageTokens(),
    byProvider: {},
    byFeature: {},
    byDay: {},
  };
  const list = Array.isArray(events) ? events : [];
  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    if (Number.isFinite(event.usd)) {
      summary.totalUsd += event.usd;
      if (event.estimated) summary.estimatedUsd += event.usd;
    } else {
      summary.unpricedEvents += 1;
    }
    const tokens = event.tokens && typeof event.tokens === 'object' ? event.tokens : {};
    for (const key of Object.keys(summary.tokens)) {
      summary.tokens[key] += Number(tokens[key]) > 0 ? Number(tokens[key]) : 0;
    }
    const provider = String(event.provider || 'other');
    const feature = String(event.feature || 'other');
    const day = String(event.at || '').slice(0, 10) || 'unknown';
    addGroup(summary.byProvider, provider, event);
    addGroup(summary.byFeature, feature, event);
    addGroup(summary.byDay, day, event);
  }
  summary.totalUsd = Number(summary.totalUsd.toFixed(6));
  summary.estimatedUsd = Number(summary.estimatedUsd.toFixed(6));
  return summary;
}

/**
 * @param {Record<string, object>} groups
 * @param {string} key
 * @param {object} event
 * @returns {void}
 */
function addGroup(groups, key, event) {
  if (!groups[key]) {
    groups[key] = { usd: 0, unpricedEvents: 0, tokens: emptyUsageTokens(), events: 0 };
  }
  const row = groups[key];
  row.events += 1;
  if (Number.isFinite(event.usd)) row.usd += event.usd;
  else row.unpricedEvents += 1;
  const tokens = event.tokens && typeof event.tokens === 'object' ? event.tokens : {};
  for (const name of Object.keys(row.tokens)) {
    row.tokens[name] += Number(tokens[name]) > 0 ? Number(tokens[name]) : 0;
  }
  row.usd = Number(row.usd.toFixed(6));
}

/**
 * @param {{ from?: string, to?: string, dataDir?: string }} [query]
 * @returns {object}
 */
export function loadUsageSummary(query = {}) {
  return summarizeUsage(readUsageEvents(query));
}
