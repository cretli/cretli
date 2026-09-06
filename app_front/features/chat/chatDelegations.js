/**
 * Client helpers for plan-execution delegations.
 */

import * as api from '../../api.js';
import { parseDelegationCommand } from '../../../lib/delegation-command.js';
import { readLocalStorageSafe, writeLocalStorageSafe } from './chatLocalStorage.js';
import { t } from '../../i18n/index.js';

export { parseDelegationCommand };

export const LAST_DELEGATION_EXECUTOR_KEY = 'cretli-last-delegation-executor';

/** @type {Map<string, string>} */
const idempotencyKeys = new Map();

/** @type {{ chatId: string, revision: number }} */
let approvedPlanPreview = { chatId: '', revision: 0 };

/**
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function hashTextSha256(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  if (!globalThis.crypto?.subtle) return '';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * @returns {number}
 */
export function getDelegationApprovedPlanRevision() {
  return approvedPlanPreview.revision > 0 ? approvedPlanPreview.revision : 0;
}

export function clearDelegationPlanPreview() {
  approvedPlanPreview = { chatId: '', revision: 0 };
  const box = document.getElementById('chat-new-plan-preview');
  if (box) box.hidden = true;
  const extra = document.getElementById('chat-new-plan-preview-extra');
  if (extra instanceof HTMLTextAreaElement) extra.value = '';
}

/**
 * @returns {string}
 */
export function readDelegationPreviewExtra() {
  const extra = document.getElementById('chat-new-plan-preview-extra');
  if (extra instanceof HTMLTextAreaElement) return extra.value.trim();
  return '';
}

/**
 * @returns {HTMLElement | null}
 */
function ensurePlanPreviewElements() {
  let box = document.getElementById('chat-new-plan-preview');
  if (box) return box;
  const form = document.querySelector('#chat-new-modal .chat-settings-form');
  if (!(form instanceof HTMLElement)) return null;
  box = document.createElement('div');
  box.id = 'chat-new-plan-preview';
  box.className = 'chat-new-plan-preview';
  box.hidden = true;
  const meta = document.createElement('p');
  meta.id = 'chat-new-plan-preview-meta';
  meta.className = 'chat-settings-hint-inline';
  const body = document.createElement('pre');
  body.id = 'chat-new-plan-preview-body';
  body.className = 'chat-new-plan-preview-body';
  const extraLabel = document.createElement('label');
  extraLabel.className = 'chat-settings-hint-inline';
  extraLabel.id = 'chat-new-plan-preview-extra-label';
  extraLabel.textContent = t('chat.delegationExtraInstructions');
  extraLabel.setAttribute('for', 'chat-new-plan-preview-extra');
  const extra = document.createElement('textarea');
  extra.id = 'chat-new-plan-preview-extra';
  extra.className = 'chat-new-plan-preview-extra';
  extra.rows = 3;
  const childAgent = document.createElement('label');
  childAgent.className = 'chat-settings-hint-inline';
  childAgent.id = 'chat-new-plan-preview-child-agent-label';
  childAgent.hidden = true;
  const childAgentCheck = document.createElement('input');
  childAgentCheck.type = 'checkbox';
  childAgentCheck.id = 'chat-new-plan-preview-child-agent';
  childAgent.append(childAgentCheck, document.createTextNode(` ${t('chat.delegationRunChildInAgent')}`));
  box.append(meta, body, extraLabel, extra, childAgent);
  form.appendChild(box);
  return box;
}

/**
 * @param {string[]} transports
 */
function filterHarnessSelectToExecutors(transports) {
  const sel = document.getElementById('chat-new-harness-select');
  if (!(sel instanceof HTMLSelectElement)) return;
  const allowed = new Set(transports.map((id) => String(id || '').trim()).filter(Boolean));
  if (allowed.size === 0) return;
  const current = sel.value;
  for (const option of [...sel.options]) {
    if (!allowed.has(option.value)) option.remove();
  }
  if (allowed.has(current) && [...sel.options].some((row) => row.value === current)) {
    sel.value = current;
    return;
  }
  if (sel.options.length) sel.value = sel.options[0].value;
}

/**
 * @param {object} parentChat
 */
function syncChildAgentCheckbox(parentChat) {
  const label = document.getElementById('chat-new-plan-preview-child-agent-label');
  const check = document.getElementById('chat-new-plan-preview-child-agent');
  if (!(label instanceof HTMLElement) || !(check instanceof HTMLInputElement)) return;
  const parentMode = String(parentChat?.sdkMode || '').trim();
  const show = parentMode === 'plan';
  label.hidden = !show;
  if (!show) check.checked = false;
}

/**
 * @returns {'plan' | 'agent' | ''}
 */
export function readDelegationExecutionMode(parentChat) {
  const parentMode = String(parentChat?.sdkMode || '').trim();
  const check = document.getElementById('chat-new-plan-preview-child-agent');
  if (parentMode === 'plan' && check instanceof HTMLInputElement && check.checked) return 'agent';
  if (parentMode === 'plan') return 'plan';
  if (parentMode === 'agent') return 'agent';
  return '';
}

/**
 * @param {object} parentChat
 */
export async function prepareBuildPlanModal(parentChat) {
  const chatId = String(parentChat?.id || '').trim();
  const box = ensurePlanPreviewElements();
  const meta = document.getElementById('chat-new-plan-preview-meta');
  const body = document.getElementById('chat-new-plan-preview-body');
  approvedPlanPreview = { chatId, revision: 0 };
  syncChildAgentCheckbox(parentChat);
  try {
    const executors = await api.getDelegationExecutors();
    const transports = Array.isArray(executors?.transports) ? executors.transports : [];
    filterHarnessSelectToExecutors(transports);
  } catch {
    // Keep the current harness list if the executor catalog cannot be loaded.
  }
  if (!chatId || !box || !(meta instanceof HTMLElement) || !(body instanceof HTMLElement)) {
    return;
  }
  box.hidden = false;
  try {
    const planData = await api.getChatPlan(chatId);
    const plan = planData?.plan;
    const revision = Number(plan?.revision) || 0;
    const planBody = String(plan?.body || '').trim();
    if (!planData?.ok || !planBody) {
      meta.textContent = t('chat.delegationNoPlan');
      body.textContent = '';
      return;
    }
    approvedPlanPreview = { chatId, revision };
    const workspace = String(planData.workspaceFolder || parentChat.workspaceFolder || '').trim();
    meta.textContent = t('chat.delegationPlanPreviewMeta', {
      revision: String(revision),
      workspace: workspace || '—',
    });
    body.textContent = planBody;
  } catch {
    meta.textContent = t('chat.serverConnectionError');
    body.textContent = '';
  }
}

/**
 * @param {object} parentChat
 * @param {{ text?: string, historySeq?: number, createdAt?: string }} source
 */
export async function prepareMessageDelegationModal(parentChat, source = {}) {
  const chatId = String(parentChat?.id || '').trim();
  const box = ensurePlanPreviewElements();
  const meta = document.getElementById('chat-new-plan-preview-meta');
  const body = document.getElementById('chat-new-plan-preview-body');
  const extra = document.getElementById('chat-new-plan-preview-extra');
  approvedPlanPreview = { chatId, revision: 0 };
  try {
    const executors = await api.getDelegationExecutors();
    const transports = Array.isArray(executors?.transports) ? executors.transports : [];
    filterHarnessSelectToExecutors(transports);
  } catch {
    // Keep the current harness list if the executor catalog cannot be loaded.
  }
  if (!chatId || !box || !(meta instanceof HTMLElement) || !(body instanceof HTMLElement)) {
    return;
  }
  box.hidden = false;
  syncChildAgentCheckbox(parentChat);
  meta.textContent = t('chat.delegationMessagePreviewMeta');
  body.textContent = String(source.text || '').trim();
  if (extra instanceof HTMLTextAreaElement) extra.value = '';
}

/**
 * @returns {{ harness: string, model: string }}
 */
export function readLastDelegationExecutor() {
  try {
    const raw = readLocalStorageSafe(LAST_DELEGATION_EXECUTOR_KEY, '');
    if (!raw) return { harness: '', model: '' };
    const parsed = JSON.parse(raw);
    return {
      harness: typeof parsed?.harness === 'string' ? parsed.harness : '',
      model: typeof parsed?.model === 'string' ? parsed.model : '',
    };
  } catch {
    return { harness: '', model: '' };
  }
}

/**
 * @param {string} harness
 * @param {string} model
 */
export function saveLastDelegationExecutor(harness, model) {
  writeLocalStorageSafe(
    LAST_DELEGATION_EXECUTOR_KEY,
    JSON.stringify({ harness: String(harness || ''), model: String(model || '') }),
    'saveLastDelegationExecutor'
  );
}

/**
 * @param {string} parentChatId
 * @returns {string}
 */
export function peekDelegationIdempotencyKey(parentChatId) {
  const id = String(parentChatId || '').trim();
  if (!id) return '';
  const existing = idempotencyKeys.get(id);
  if (existing) return existing;
  const key = `${id}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  idempotencyKeys.set(id, key);
  return key;
}

/**
 * @param {string} parentChatId
 */
export function clearDelegationIdempotencyKey(parentChatId) {
  idempotencyKeys.delete(String(parentChatId || '').trim());
}

/**
 * @param {object} payload
 * @returns {object | null}
 */
export function parseDelegationHistoryPayload(payload) {
  if (payload && typeof payload === 'object') return payload;
  if (typeof payload !== 'string' || !payload.trim()) return null;
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {object} parentChat
 * @param {{
 *   title: string,
 *   harness: string,
 *   model: string,
 *   extraInstructions?: string,
 *   planRevision?: number,
 * }} values
 */
export async function startDelegationFromParent(parentChat, values) {
  if (!parentChat?.id) {
    return { ok: false, error: t('chat.unknownError') };
  }
  const sourceKind = String(values.sourceKind || '').trim() === 'message' ? 'message' : 'plan';
  const executionMode = String(values.executionMode || '').trim();
  let planRevision = Number(values.planRevision);
  if (sourceKind !== 'message' && (!Number.isFinite(planRevision) || planRevision <= 0)) {
    try {
      const planData = await api.getChatPlan(parentChat.id);
      planRevision = Number(planData?.plan?.revision) || 0;
      if (!planData?.ok || !planData?.plan?.body) {
        return { ok: false, error: planData?.error || t('chat.delegationNoPlan'), code: 'plan_missing' };
      }
    } catch {
      return { ok: false, error: t('chat.serverConnectionError') };
    }
  }
  const idempotencyKey = peekDelegationIdempotencyKey(
    sourceKind === 'message'
      ? `${parentChat.id}:msg:${values.historySeq || values.createdAt || 'snap'}`
      : parentChat.id
  );
  let data;
  try {
    data = await api.postChatDelegation(parentChat.id, {
      executor: { transport: values.harness, model: values.model },
      planRevision: sourceKind === 'message' ? undefined : planRevision,
      idempotencyKey,
      extraInstructions: values.extraInstructions || '',
      title: values.title || '',
      sourceKind,
      historySeq: values.historySeq,
      contentHash: values.contentHash || (values.textSnapshot
        ? await hashTextSha256(values.textSnapshot)
        : ''),
      executionMode,
    });
  } catch {
    return { ok: false, error: t('chat.serverConnectionError') };
  }
  if (data?.ok && data.delegation) {
    saveLastDelegationExecutor(values.harness, values.model);
    if (!data.replayed) {
      clearDelegationIdempotencyKey(parentChat.id);
      clearDelegationIdempotencyKey(`${parentChat.id}:msg:${values.historySeq || values.createdAt || 'snap'}`);
    }
  }
  return data;
}

/**
 * @param {string} status
 * @returns {string}
 */
export function delegationStatusLabel(status) {
  const key = `chat.delegationStatus.${String(status || '').trim()}`;
  const label = t(key);
  return label === key ? String(status || '') : label;
}
