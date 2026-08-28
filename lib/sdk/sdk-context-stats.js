/**
 * Server-side SDK context stats (filesystem). Browser helpers live in
 * sdk-context-advisory.js — import that from the frontend.
 */

import fs from 'fs';
import path from 'path';
import { loadChatHistory } from '../persist/chat-history-persist.js';
import { resolveDataPath } from '../runtime-paths.js';
import {
  CONTEXT_ADVISORY_CRITICAL_PERCENT,
  CONTEXT_ADVISORY_DANGER_PERCENT,
  CONTEXT_ADVISORY_WARN_PERCENT,
  buildContextPressureAssessment,
  estimateContextFillPercent,
  estimateEffectiveUsageInputTokens,
  findLastUsageEventPayload,
  formatContextTokenCount,
  formatContextUsageLabel,
  getContextMeterFillPercent,
  getContextPressureLevel,
  getModelContextWindowTokens,
  isContextAdvisoryEnabled,
  normalizeContextAdvisoryWarnPercent,
  readReportedTokenCount,
  resolveExactTotalTokens,
  resolveLiveContextUsageInputTokens,
  shouldSuggestContextMaintenance,
} from './sdk-context-advisory.js';

export {
  CONTEXT_ADVISORY_CRITICAL_PERCENT,
  CONTEXT_ADVISORY_DANGER_PERCENT,
  CONTEXT_ADVISORY_WARN_PERCENT,
  buildContextPressureAssessment,
  estimateContextFillPercent,
  estimateEffectiveUsageInputTokens,
  findLastUsageEventPayload,
  formatContextTokenCount,
  formatContextUsageLabel,
  getContextMeterFillPercent,
  getContextPressureLevel,
  getModelContextWindowTokens,
  isContextAdvisoryEnabled,
  readReportedTokenCount,
  resolveExactTotalTokens,
  normalizeContextAdvisoryWarnPercent,
  resolveLiveContextUsageInputTokens,
  shouldSuggestContextMaintenance,
};

const SDK_LOCAL_STORE_ROOT = resolveDataPath('sdk-agent-store');
const HISTORY_DIR = resolveDataPath('chat-history');

/**
 * @param {string} filePath
 * @returns {{ bytes: number, lines: number } | null}
 */
function readFileStats(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  let lines = 0;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.length > 0) {
      lines = content.split('\n').filter((line) => line.trim()).length;
    }
  } catch {
    lines = 0;
  }
  return { bytes: stat.size, lines };
}

/**
 * @param {string} sessionKey
 * @returns {Record<string, unknown> | null}
 */
export function collectSdkLocalStoreStats(sessionKey) {
  const normalized = String(sessionKey || '').trim();
  if (!normalized) return null;
  const safeSessionKey = normalized.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storeDir = path.join(SDK_LOCAL_STORE_ROOT, safeSessionKey);
  if (!fs.existsSync(storeDir)) {
    return { storeDir, exists: false, totalBytes: 0, files: {}, agents: [] };
  }
  const files = {};
  let totalBytes = 0;
  for (const name of fs.readdirSync(storeDir)) {
    const filePath = path.join(storeDir, name);
    if (!fs.statSync(filePath).isFile()) continue;
    const stats = readFileStats(filePath);
    if (!stats) continue;
    files[name] = stats;
    totalBytes += stats.bytes;
  }
  const agents = [];
  const agentsPath = path.join(storeDir, 'agents.ndjson');
  if (fs.existsSync(agentsPath)) {
    try {
      const rows = fs.readFileSync(agentsPath, 'utf8').split('\n').filter((line) => line.trim());
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row);
          if (parsed && typeof parsed === 'object') agents.push(parsed);
        } catch {
          // Skip malformed rows.
        }
      }
    } catch {
      // Ignore unreadable agents file.
    }
  }
  return {
    storeDir,
    exists: true,
    totalBytes,
    files,
    agents,
  };
}

/**
 * @param {string} chatId
 * @returns {Record<string, unknown> | null}
 */
export function collectChatHistoryContextStats(chatId) {
  const normalizedChatId = String(chatId || '').trim();
  if (!normalizedChatId) return null;
  const doc = loadChatHistory(normalizedChatId);
  const historyPath = path.join(HISTORY_DIR, `${normalizedChatId}.json`);
  let historyFileBytes = 0;
  if (fs.existsSync(historyPath)) {
    historyFileBytes = fs.statSync(historyPath).size;
  }
  if (!doc) {
    return {
      chatId: normalizedChatId,
      headSeq: 0,
      storedEvents: 0,
      historyFileBytes,
      localUserCount: 0,
      sdkEventCount: 0,
      lastUsageInputTokens: null,
      maxUsageInputTokens: null,
      lastEffectiveUsageInputTokens: null,
      maxEffectiveUsageInputTokens: null,
      lastUsageOutputTokens: null,
      lastUsageTotalTokens: null,
      lastStatusError: null,
    };
  }
  let localUserCount = 0;
  let sdkEventCount = 0;
  let lastUsageInputTokens = null;
  let maxUsageInputTokens = null;
  let lastEffectiveUsageInputTokens = null;
  let maxEffectiveUsageInputTokens = null;
  let lastUsageOutputTokens = null;
  let lastUsageTotalTokens = null;
  let lastStatusError = null;
  for (const entry of doc.events) {
    const rec = entry?.rec;
    if (!rec || typeof rec !== 'object') continue;
    if (rec.kind === 'localUser') localUserCount += 1;
    if (rec.kind === 'sdk') {
      sdkEventCount += 1;
      const event = rec.event;
      if (event && typeof event === 'object') {
        if (event.type === 'usage' && event.usage && typeof event.usage === 'object') {
          const inputTokens = Number(event.usage.inputTokens);
          const outputTokens = Number(event.usage.outputTokens);
          const totalTokens = Number(event.usage.totalTokens);
          const cacheReadTokens = Number(event.usage.cacheReadTokens);
          const effectiveInputTokens = estimateEffectiveUsageInputTokens(inputTokens, cacheReadTokens);
          if (Number.isFinite(inputTokens)) {
            lastUsageInputTokens = inputTokens;
            if (!Number.isFinite(maxUsageInputTokens) || inputTokens > maxUsageInputTokens) {
              maxUsageInputTokens = inputTokens;
            }
          }
          if (Number.isFinite(effectiveInputTokens)) {
            lastEffectiveUsageInputTokens = effectiveInputTokens;
            if (
              !Number.isFinite(maxEffectiveUsageInputTokens) ||
              effectiveInputTokens > maxEffectiveUsageInputTokens
            ) {
              maxEffectiveUsageInputTokens = effectiveInputTokens;
            }
          }
          if (Number.isFinite(outputTokens)) lastUsageOutputTokens = outputTokens;
          if (Number.isFinite(totalTokens)) lastUsageTotalTokens = totalTokens;
        }
        if (event.type === 'status' && String(event.status || '').toUpperCase() === 'ERROR') {
          lastStatusError = typeof event.message === 'string' ? event.message : null;
        }
      }
    }
  }
  return {
    chatId: normalizedChatId,
    headSeq: doc.headSeq,
    storedEvents: doc.events.length,
    historyFileBytes,
    localUserCount,
    sdkEventCount,
    lastUsageInputTokens,
    maxUsageInputTokens,
    lastEffectiveUsageInputTokens,
    maxEffectiveUsageInputTokens,
    lastUsageOutputTokens,
    lastUsageTotalTokens,
    lastStatusError,
    updatedAt: doc.updatedAt,
  };
}
