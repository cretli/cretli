/**
 * Durable plan-reviewer cooperation sessions (parallel plan review rounds).
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import {
  PLAN_REVIEWER_COOPERATION_SCHEMA_VERSION,
  normalizePlanReviewerCooperationMode,
} from '../plan-reviewer-cooperation.js';

const DATA_FILE = resolveDataPath('plan-reviewer-sessions.json');
const SCHEMA_VERSION = PLAN_REVIEWER_COOPERATION_SCHEMA_VERSION;

export class PlanReviewerSessionsCorruptError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'PlanReviewerSessionsCorruptError';
    this.code = 'PLAN_REVIEWER_SESSIONS_CORRUPT';
  }
}

/**
 * @returns {void}
 */
function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * @returns {string}
 */
export function getPlanReviewerSessionsDataPath() {
  return DATA_FILE;
}

/**
 * @returns {{ v: number, items: Record<string, any>[] }}
 */
function loadDocument() {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) return { v: SCHEMA_VERSION, items: [] };
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (err) {
    throw new PlanReviewerSessionsCorruptError(
      `Could not read plan reviewer sessions (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PlanReviewerSessionsCorruptError(
      `Plan reviewer sessions file is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PlanReviewerSessionsCorruptError('Plan reviewer sessions file is not an object');
  }
  const version = Number(parsed.v) || SCHEMA_VERSION;
  const items = Array.isArray(parsed.items)
    ? parsed.items.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    : [];
  return { v: version, items };
}

/**
 * @param {Record<string, any>[]} items
 */
function saveItems(items) {
  ensureDir();
  writeJsonAtomic(DATA_FILE, { v: SCHEMA_VERSION, items });
}

/**
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
export function normalizePlanReviewerSessionRow(row) {
  const now = new Date().toISOString();
  return {
    id: String(row?.id || '').trim() || randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    todoId: String(row?.todoId || '').trim().toLowerCase(),
    workspaceFolder: String(row?.workspaceFolder || '').trim(),
    coordinatorChatId: String(row?.coordinatorChatId || '').trim(),
    cooperationMode: normalizePlanReviewerCooperationMode(row?.cooperationMode),
    planRevisionKey: String(row?.planRevisionKey || '').trim(),
    phase: String(row?.phase || 'independent').trim() || 'independent',
    exchangeRoundUsed: row?.exchangeRoundUsed === true,
    reviewers: Array.isArray(row?.reviewers)
      ? row.reviewers.map((r) => ({
        delegationId: String(r?.delegationId || '').trim(),
        slotIndex: Number.isFinite(Number(r?.slotIndex)) ? Math.max(0, Math.floor(Number(r.slotIndex))) : 0,
        phase: String(r?.phase || 'independent').trim() || 'independent',
        verdict: String(r?.verdict || '').trim(),
        reportSummary: String(r?.reportSummary || '').trim(),
        exchangeVerdict: String(r?.exchangeVerdict || '').trim(),
        exchangeDelegationId: String(r?.exchangeDelegationId || '').trim(),
        exchangeUsed: r?.exchangeUsed === true,
        independentFinished: r?.independentFinished === true,
        finishedAt: String(r?.finishedAt || '').trim(),
      })).filter((r) => r.delegationId)
      : [],
    messages: Array.isArray(row?.messages)
      ? row.messages.map((m) => ({
        id: String(m?.id || '').trim() || randomUUID(),
        fromDelegationId: String(m?.fromDelegationId || '').trim(),
        text: String(m?.text || ''),
        planRevisionKey: String(m?.planRevisionKey || '').trim(),
        createdAt: String(m?.createdAt || '').trim() || now,
      })).filter((m) => m.fromDelegationId && m.text)
      : [],
    aggregatedVerdict: String(row?.aggregatedVerdict || '').trim(),
    divergenceSummary: String(row?.divergenceSummary || '').trim(),
    staleReason: String(row?.staleReason || '').trim(),
    createdAt: String(row?.createdAt || '').trim() || now,
    updatedAt: String(row?.updatedAt || '').trim() || now,
  };
}

/**
 * @returns {Record<string, any>[]}
 */
export function loadPlanReviewerSessions() {
  return loadDocument().items.map((row) => normalizePlanReviewerSessionRow(row));
}

/**
 * @param {string} sessionId
 * @returns {Record<string, any> | null}
 */
export function getPlanReviewerSessionById(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  return loadPlanReviewerSessions().find((row) => row.id === id) || null;
}

/**
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
export function upsertPlanReviewerSession(input) {
  const normalized = normalizePlanReviewerSessionRow(input);
  const items = loadPlanReviewerSessions();
  const index = items.findIndex((row) => row.id === normalized.id);
  normalized.updatedAt = new Date().toISOString();
  if (index >= 0) {
    items[index] = { ...items[index], ...normalized, createdAt: items[index].createdAt || normalized.createdAt };
  } else {
    items.push(normalized);
  }
  saveItems(items);
  return normalized;
}

/**
 * @param {string} todoId
 * @param {string} workspaceFolder
 * @returns {Record<string, any>[]}
 */
export function listPlanReviewerSessionsForTodo(todoId, workspaceFolder) {
  const todo = String(todoId || '').trim().toLowerCase();
  const workspace = String(workspaceFolder || '').trim();
  return loadPlanReviewerSessions().filter((row) => {
    if (todo && row.todoId !== todo) return false;
    if (workspace && row.workspaceFolder !== workspace) return false;
    return true;
  });
}
