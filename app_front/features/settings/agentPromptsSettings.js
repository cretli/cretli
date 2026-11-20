/**
 * Settings → Delegations → Prompts.
 *
 * Lists the agent prompt registry blocks (hard safety rules read-only, editable
 * blocks with save / reset) and the rendered prompts with their size against the
 * length budget. All text is assigned through `textContent`, never as HTML.
 */

import { t, getCurrentLang } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import './agent-prompts-settings.scss';

const API = '/api/prompt-registry';

/** @type {{ blocks: any[], prompts: any[], budget: number, bound: boolean }} */
const state = { blocks: [], prompts: [], budget: 0, bound: false };

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<{ status: number, json: any }>}
 */
async function api(path, options = {}) {
  const headers = { Accept: 'application/json', 'Accept-Language': getCurrentLang() };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await cretliApiFetch(path, {
    method: options.method || 'GET',
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/**
 * @param {string} tag
 * @param {Record<string, string> | null} [attrs]
 * @param {Array<Node | string | null>} [children]
 * @returns {HTMLElement}
 */
function el(tag, attrs = null, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** @returns {HTMLElement | null} */
function getRoot() {
  return document.getElementById('settings-agent-prompts-root');
}

/**
 * @param {string} text
 * @param {'error' | 'success' | ''} [tone]
 */
function setStatus(text, tone = '') {
  const node = getRoot()?.querySelector('[data-prompts-status]');
  if (!node) return;
  node.textContent = text;
  node.setAttribute('data-tone', tone);
}

/**
 * @param {any} block
 * @returns {HTMLElement}
 */
function renderBlock(block) {
  const title = t(`settings.agentPrompts.block_${block.key}`);
  const badges = el('div', { class: 'cr-prompts-badges' }, [
    el('span', { class: 'cr-hint' }, [block.hard ? t('settings.agentPrompts.hard') : t('settings.agentPrompts.editable')]),
    block.overridden ? el('span', { class: 'cr-hint' }, [t('settings.agentPrompts.overridden')]) : null,
  ]);
  const area = el('textarea', {
    class: 'cr-prompts-text',
    rows: block.hard ? '3' : '4',
    'data-prompts-text': block.key,
    ...(block.hard ? { readonly: '', 'aria-readonly': 'true' } : {}),
  });
  /** @type {HTMLTextAreaElement} */ (area).value = block.text;
  const children = [el('span', { class: 'cr-field-label' }, [title]), badges, area];
  if (!block.hard) {
    children.push(el('div', { class: 'cr-row' }, [
      el('cr-bar-button', { variant: 'primary', 'data-prompts-action': 'save', 'data-prompts-key': block.key }, [t('settings.agentPrompts.save')]),
      el('cr-bar-button', { 'data-prompts-action': 'reset', 'data-prompts-key': block.key, ...(block.overridden ? {} : { disabled: '' }) }, [t('settings.agentPrompts.reset')]),
    ]));
  }
  return el('div', { class: 'cr-card cr-prompts-block' }, children);
}

/**
 * @param {any} prompt
 * @returns {HTMLElement}
 */
function renderPreview(prompt) {
  const size = t('settings.agentPrompts.size', { chars: String(prompt.chars), budget: String(prompt.budget) });
  const details = el('details', { class: 'cr-card cr-prompts-preview' }, [
    el('summary', null, [`${t(`settings.agentPrompts.prompt_${prompt.id}`)} — ${size}`]),
    prompt.overBudget ? el('p', { class: 'cr-status', 'data-tone': 'error', role: 'alert' }, [t('settings.agentPrompts.overBudget')]) : null,
    el('pre', { class: 'cr-prompts-pre' }, [prompt.text]),
  ]);
  return details;
}

function render() {
  const root = getRoot();
  if (!root) return;
  root.replaceChildren(el('div', { class: 'cr-page-body' }, [
    el('p', { class: 'cr-hint' }, [t('settings.agentPrompts.hint')]),
    el('h3', { class: 'cr-section-title' }, [t('settings.agentPrompts.blocksTitle')]),
    ...state.blocks.map(renderBlock),
    el('h3', { class: 'cr-section-title' }, [t('settings.agentPrompts.previewTitle')]),
    ...state.prompts.map(renderPreview),
    el('p', { class: 'cr-status', 'data-prompts-status': '1', 'data-tone': '', 'aria-live': 'polite' }),
  ]));
}

/** Load blocks and rendered previews. */
export async function refreshAgentPromptsSettings() {
  const root = getRoot();
  if (!root) return;
  if (!state.blocks.length) root.textContent = t('settings.agentPrompts.loading');
  const [blocksRes, previewRes] = await Promise.all([api(API), api(`${API}/preview`)]);
  if (blocksRes.status !== 200 || !blocksRes.json?.ok) {
    root.textContent = `${t('settings.agentPrompts.loadFailed')} (${blocksRes.json?.error || `HTTP ${blocksRes.status}`})`;
    return;
  }
  state.blocks = blocksRes.json.blocks || [];
  state.budget = blocksRes.json.budget || 0;
  state.prompts = previewRes.status === 200 && previewRes.json?.ok ? previewRes.json.prompts || [] : [];
  render();
}

/**
 * @param {string} action
 * @param {string} key
 */
async function runAction(action, key) {
  const root = getRoot();
  if (action === 'save') {
    const text = /** @type {HTMLTextAreaElement | null} */ (root?.querySelector(`[data-prompts-text="${key}"]`))?.value || '';
    const { status, json } = await api(`${API}/blocks/${encodeURIComponent(key)}`, { method: 'PUT', body: { text } });
    if (status !== 200 || !json?.ok) return setStatus(`${t('settings.agentPrompts.saveFailed')} (${json?.error || `HTTP ${status}`})`, 'error');
    await refreshAgentPromptsSettings();
    return setStatus(t('settings.agentPrompts.saved'), 'success');
  }
  if (action === 'reset') {
    const { status, json } = await api(`${API}/blocks/${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (status !== 200 || !json?.ok) return setStatus(`${t('settings.agentPrompts.saveFailed')} (${json?.error || `HTTP ${status}`})`, 'error');
    await refreshAgentPromptsSettings();
    return setStatus(t('settings.agentPrompts.resetDone'), 'success');
  }
  return undefined;
}

export function initAgentPromptsSettings() {
  const root = getRoot();
  if (!root || state.bound) return;
  state.bound = true;
  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-prompts-action]') : null;
    if (!target || target.hasAttribute('disabled')) return;
    void runAction(target.getAttribute('data-prompts-action') || '', target.getAttribute('data-prompts-key') || '');
  });
  window.addEventListener('cr-lang-changed', () => { if (state.blocks.length) render(); });
}
