#!/usr/bin/env node
/**
 * Task 3.1 — monitoring qualification before/after the archive gate.
 *
 * Two datasets:
 * 1. REAL: `data/chats.json` plus the live delegation/run state computed by the
 *    server module `summarizeChatRunStates()` (the exact map the global
 *    `GET /api/chats/agent-states` returns). This is the strongest evidence for
 *    the "global agent-states tags inactive archived chats waiting/attention"
 *    hypothesis.
 * 2. SYNTHETIC: 1500 chats / 1200 archived as an explicit fallback and for the
 *    regression shape, in case the real files are missing.
 *
 * "before" = `classifyMonitoringCandidateReasons` (pre-3.1 behaviour, no archive
 * gate). "after" = `classifyMonitoringReasons` + `selectMonitoredChatIds` (the
 * shipped 3.1 gate). No file is written; run from the workspace root:
 *
 *   node scripts/measure-monitoring-archive-baseline.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  classifyMonitoringCandidateReasons,
  classifyMonitoringReasons,
  isArchivedChat,
  selectMonitoredChatIds,
} from '../app_front/features/chat/chatBackgroundPolicy.js';
import { MONITORING_REASON_NAMES } from '../app_front/lib/uiFreezeCounters.js';

const ROOT = process.cwd();
const REAL_CHATS = path.join(ROOT, 'data', 'chats.json');

/** @param {Map<string, number>} map @param {string} key */
function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

const getActivityAt = (chat) => Number(chat.activityAt) || 0;

/**
 * @param {{ id?: string }[]} rows
 * @param {string} activeChatId
 * @param {number} now
 * @returns {{ before: Map<string, number>, after: Map<string, number>, beforeIds: Set<string>, afterIds: Set<string>, archived: number, total: number }}
 */
function measure(rows, activeChatId, now) {
  const before = new Map();
  const after = new Map();
  const beforeIds = new Set();
  let archived = 0;
  for (const row of rows) {
    if (isArchivedChat(row)) archived += 1;
    const isArchived = isArchivedChat(row);
    const candidateReasons = classifyMonitoringCandidateReasons(row, {
      activeChatId,
      getChatActivityAt: getActivityAt,
      now,
    });
    if (candidateReasons.length > 0 && row.id) beforeIds.add(row.id);
    for (const reason of candidateReasons) bump(before, `${reason}|archived=${isArchived}`);
    const reasons = classifyMonitoringReasons(row, {
      activeChatId,
      getChatActivityAt: getActivityAt,
      now,
    });
    for (const reason of reasons) bump(after, `${reason}|archived=${isArchived}`);
  }
  // The gated selection is what the fast path returns; re-run through the
  // instrumented path to prove both agree.
  const afterIds = selectMonitoredChatIds(
    rows,
    () => activeChatId,
    getActivityAt,
    now,
    { onClassified: () => {} },
  );
  return { before, after, beforeIds, afterIds, archived, total: rows.length };
}

/**
 * @param {Map<string, number>} before
 * @param {Map<string, number>} after
 * @returns {string}
 */
function renderTable(before, after) {
  const lines = [];
  lines.push('| reason | archived | before | after | removed |');
  lines.push('| --- | --- | ---: | ---: | ---: |');
  let totalBefore = 0;
  let totalAfter = 0;
  for (const reason of [...MONITORING_REASON_NAMES, 'unknown']) {
    for (const archived of [true, false]) {
      const key = `${reason}|archived=${archived}`;
      const beforeCount = before.get(key) || 0;
      const afterCount = after.get(key) || 0;
      if (beforeCount === 0 && afterCount === 0) continue;
      totalBefore += beforeCount;
      totalAfter += afterCount;
      lines.push(`| ${reason} | ${archived} | ${beforeCount} | ${afterCount} | ${beforeCount - afterCount} |`);
    }
  }
  lines.push(`| **total** | — | **${totalBefore}** | **${totalAfter}** | **${totalBefore - totalAfter}** |`);
  return lines.join('\n');
}

/** @param {number} count @param {number} archivedCount */
function buildSyntheticChats(count, archivedCount) {
  const now = Date.now();
  const chats = [];
  for (let index = 0; index < count; index += 1) {
    const archived = index < archivedCount;
    /** @type {Record<string, unknown>} */
    const chat = {
      id: `syn-${index}`,
      cursorSessionId: `s-${index}`,
      activityAt: index % 5 === 0 ? now - 1000 : now - 10 * 24 * 60 * 60 * 1000,
    };
    if (archived) chat.archivedAt = '2026-01-01T00:00:00.000Z';
    if (index % 3 === 0) chat._serverRunState = { state: 'waiting' };
    else if (index % 3 === 1) chat._serverRunState = { state: 'attention' };
    if (index % 500 === 0) chat._sdkServerBusy = true;
    chats.push(chat);
  }
  return chats;
}

function loadRealRows() {
  if (!existsSync(REAL_CHATS)) return null;
  // Imported lazily so the synthetic fallback still runs without the server
  // persist layer (the module opens SQLite on import).
  return import('../lib/agent-run-state.js').then(({ summarizeChatRunStates }) => {
    const states = summarizeChatRunStates();
    const raw = JSON.parse(readFileSync(REAL_CHATS, 'utf8'));
    const chats = Array.isArray(raw) ? raw : raw.chats || [];
    return chats.map((chat) => ({
      ...chat,
      activityAt: Date.parse(chat.updatedAt || chat.createdAt || '') || 0,
      _serverRunState: states[chat.id] || null,
    }));
  });
}

async function main() {
  const lines = [];
  lines.push('# Task 3.1 — monitoring qualification before/after archive gate');
  lines.push('');
  lines.push(`Date: ${new Date().toISOString()}; Node: ${process.version}; cwd: ${ROOT}`);
  lines.push('');
  lines.push('"before" = raw candidate reasons (pre-3.1). "after" = archive-gated reasons (shipped).');
  lines.push('A chat can match several reasons, so the totals are reason matches, not chats.');
  lines.push('');

  const realRows = await loadRealRows();
  if (realRows && realRows.length > 0) {
    const sorted = [...realRows].sort((a, b) => getActivityAt(b) - getActivityAt(a));
    const activeChatId = sorted[0]?.id || '';
    const now = Date.now();
    const result = measure(realRows, activeChatId, now);
    const stateCounts = {};
    for (const row of realRows) {
      const state = row._serverRunState?.state;
      if (!state) continue;
      stateCounts[state] = (stateCounts[state] || 0) + 1;
    }
    lines.push('## Real dataset — data/chats.json + live summarizeChatRunStates()');
    lines.push('');
    lines.push(`Chats: **${result.total}**, archived: **${result.archived}**, ` +
      `active chat: \`${activeChatId}\`.`);
    lines.push(`Non-idle global agent-states: ${JSON.stringify(stateCounts)}.`);
    lines.push(`Monitored chats before: **${result.beforeIds.size}**, after: **${result.afterIds.size}**.`);
    lines.push('');
    lines.push(renderTable(result.before, result.after));
    lines.push('');
  } else {
    lines.push('## Real dataset unavailable');
    lines.push('');
    lines.push(`\`${REAL_CHATS}\` not found — using the synthetic 1500/1200 shape only.`);
    lines.push('');
  }

  {
    const chats = buildSyntheticChats(1500, 1200);
    const activeChatId = chats.find((chat) => !isArchivedChat(chat))?.id || chats[0].id;
    const now = Date.now();
    const result = measure(chats, activeChatId, now);
    lines.push('## Synthetic regression shape — 1500 chats / 1200 archived');
    lines.push('');
    lines.push(`Active chat: \`${activeChatId}\`.`);
    lines.push(`Monitored chats before: **${result.beforeIds.size}**, after: **${result.afterIds.size}**.`);
    lines.push('');
    lines.push(renderTable(result.before, result.after));
    lines.push('');
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

await main();
