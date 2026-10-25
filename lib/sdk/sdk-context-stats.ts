/**
 * Server-side SDK context stats (filesystem). Browser helpers live in
 * sdk-context-advisory.ts — import that from the frontend.
 */

import fsp from 'fs/promises';
import path from 'path';
import { getChatHistoryBackendKind, getChatHistoryUsage, loadChatHistory } from '../persist/chat-history-service.js';
import { resolveDataPath } from '../runtime-paths.js';
import { assessContextOccupancy } from '../usage/usage-contract.js';
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
} from './sdk-context-advisory.ts';

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

type FileStats = { bytes: number; lines: number | null };

/** Per-file cache keyed by path; an entry is valid while mtime and size are unchanged. */
const fileStatsCache = new Map<string, { mtimeMs: number; size: number; stats: FileStats; text: string | null }>();
const FILE_CACHE_MAX = 512;

async function readFileStats(filePath: string, wantText = false): Promise<{ stats: FileStats; text: string | null } | null> {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const cached = fileStatsCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && (!wantText || cached.text !== null)) {
    return { stats: cached.stats, text: cached.text };
  }
  let lines: number | null = null;
  let text: string | null = null;
  if (stat.size <= LINE_COUNT_MAX_BYTES || wantText) {
    try {
      text = await fsp.readFile(filePath, 'utf8');
    } catch {
      text = null;
    }
  }
  if (stat.size <= LINE_COUNT_MAX_BYTES) {
    lines = text ? text.split('\n').filter((line) => line.trim()).length : 0;
  }
  const stats = { bytes: stat.size, lines };
  if (fileStatsCache.size >= FILE_CACHE_MAX) fileStatsCache.clear();
  fileStatsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, stats, text });
  return { stats, text };
}

export async function collectSdkLocalStoreStats(sessionKey: string): Promise<Record<string, unknown> | null> {
  const normalized = String(sessionKey || '').trim();
  if (!normalized) return null;
  const safeSessionKey = normalized.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storeDir = path.join(SDK_LOCAL_STORE_ROOT, safeSessionKey);
  let names: string[];
  try {
    names = await fsp.readdir(storeDir);
  } catch {
    return { storeDir, exists: false, totalBytes: 0, files: {}, agents: [] };
  }
  const files: Record<string, FileStats> = {};
  let totalBytes = 0;
  const agents: object[] = [];
  const results = await Promise.all(names.map(async (name) => {
    const read = await readFileStats(path.join(storeDir, name), name === 'agents.ndjson');
    return [name, read] as const;
  }));
  for (const [name, read] of results) {
    if (!read) continue;
    files[name] = read.stats;
    totalBytes += read.stats.bytes;
    if (name === 'agents.ndjson' && read.text) {
      for (const row of read.text.split('\n').filter((line) => line.trim())) {
        try {
          const parsed = JSON.parse(row);
          if (parsed && typeof parsed === 'object') agents.push(parsed);
        } catch {
          // Skip malformed rows.
        }
      }
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
 * Re-assesses the stored current-prompt snapshot at read time (freshness depends
 * on `now`). Returns `null` when history holds no eligible snapshot, so a reader
 * never sees a percent derived from run totals or legacy events.
 */
export function assessHistoryCurrentPrompt(usageMeta: any, options: { now?: number, transport?: 'live' | 'closed' | 'unknown' } = {}) {
  const current = usageMeta?.currentPrompt;
  if (!current || typeof current !== 'object') return null;
  return assessContextOccupancy({
    promptTokens: current.promptTokens,
    contract: current.harness,
    scope: 'current_prompt',
    granularity: current.granularity,
    measurementKind: current.measurementKind,
    provenance: current.provenance,
    accountingScope: current.accountingScope,
    completeness: current.completeness,
    observedAt: current.observedAt,
    now: options.now ?? Date.now(),
    transport: options.transport ?? 'unknown',
    contextEpoch: current.contextEpoch,
    currentContextEpoch: usageMeta.latestContextEpoch ?? null,
    limitTokens: current.limitTokens,
  });
}

export async function collectChatHistoryContextStats(chatId: string): Promise<Record<string, unknown> | null> {
  const normalizedChatId = String(chatId || '').trim();
  if (!normalizedChatId) return null;
  let doc;
  let storedEvents = null;
  // Read model first: counts and usage come from SQL, so the full history is never loaded.
  const usage: any = await getChatHistoryUsage(normalizedChatId);
  if (usage && typeof usage.eventCount === 'number') {
    const missing = usage.eventCount === 0 && !usage.headSeq && !usage.updatedAt;
    doc = missing ? null : { headSeq: usage.headSeq ?? 0, usageSummary: usage.usageSummary, updatedAt: usage.updatedAt };
    storedEvents = usage.eventCount;
  } else {
    try {
      doc = await loadChatHistory(normalizedChatId);
      storedEvents = doc ? doc.events.length : 0;
    } catch (error) {
      // A chat above the full-load cap is still summarised from the bounded usage query (no event count then).
      if ((error as { code?: unknown } | null)?.code !== 'history_load_too_large') throw error;
      doc = { headSeq: usage?.headSeq ?? 0, events: [], usageSummary: usage?.usageSummary };
    }
  }
  // The legacy file size is meaningful only for the legacy backend; a SQLite-backed chat has no per-chat file.
  const historyPath = path.join(HISTORY_DIR, `${normalizedChatId}.json`);
  let historyFileBytes = 0;
  if (getChatHistoryBackendKind() === 'legacy') {
    try {
      historyFileBytes = (await fsp.stat(historyPath)).size;
    } catch {
      historyFileBytes = 0;
    }
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
      lastContextUsage: null,
      lastCallContextTokens: null,
      lastCallModel: null,
      lastCallContextWindowTokens: null,
      lastStatusError: null,
      usageMeta: null,
      currentPromptOccupancy: null,
    };
  }
  const summary = doc.usageSummary && typeof doc.usageSummary === 'object' ? doc.usageSummary : {};
  return {
    chatId: normalizedChatId,
    headSeq: doc.headSeq,
    storedEvents,
    historyFileBytes,
    localUserCount: summary.localUserCount || 0,
    sdkEventCount: summary.sdkEventCount || 0,
    lastUsageInputTokens: summary.lastUsageInputTokens ?? null,
    maxUsageInputTokens: summary.maxUsageInputTokens ?? null,
    lastEffectiveUsageInputTokens: summary.lastEffectiveUsageInputTokens ?? null,
    maxEffectiveUsageInputTokens: summary.maxEffectiveUsageInputTokens ?? null,
    lastUsageOutputTokens: summary.lastUsageOutputTokens ?? null,
    lastUsageTotalTokens: summary.lastUsageTotalTokens ?? null,
    lastContextUsage: summary.lastContextUsage ?? null,
    lastCallContextTokens: summary.lastCallContextTokens ?? null,
    lastCallModel: summary.lastCallModel ?? null,
    lastCallContextWindowTokens: summary.lastCallContextWindowTokens ?? null,
    lastStatusError: summary.lastStatusError ?? null,
    usageMeta: summary.usageMeta ?? null,
    currentPromptOccupancy: assessHistoryCurrentPrompt(summary.usageMeta),
    updatedAt: doc.updatedAt,
  };
}
