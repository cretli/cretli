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
/** Line counts are diagnostic only. Larger session files stay a stat. */
const LINE_COUNT_MAX_BYTES = 256 * 1024;

/**
 * @param {string} filePath
 * @returns {{ bytes: number, lines: number | null } | null}
 */
function readFileStats(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size > LINE_COUNT_MAX_BYTES) return { bytes: stat.size, lines: null };
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
  const summary = doc.usageSummary && typeof doc.usageSummary === 'object' ? doc.usageSummary : {};
  return {
    chatId: normalizedChatId,
    headSeq: doc.headSeq,
    storedEvents: doc.events.length,
    historyFileBytes,
    localUserCount: summary.localUserCount || 0,
    sdkEventCount: summary.sdkEventCount || 0,
    lastUsageInputTokens: summary.lastUsageInputTokens ?? null,
    maxUsageInputTokens: summary.maxUsageInputTokens ?? null,
    lastEffectiveUsageInputTokens: summary.lastEffectiveUsageInputTokens ?? null,
    maxEffectiveUsageInputTokens: summary.maxEffectiveUsageInputTokens ?? null,
    lastUsageOutputTokens: summary.lastUsageOutputTokens ?? null,
    lastUsageTotalTokens: summary.lastUsageTotalTokens ?? null,
    lastStatusError: summary.lastStatusError ?? null,
    updatedAt: doc.updatedAt,
  };
}
