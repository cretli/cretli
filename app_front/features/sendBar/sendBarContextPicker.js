/**
 * Skille, komendy i agenci w panelu chevron (^) — ten sam popup co ESC/Enter/Stop.
 */
import { getCursorContext } from '../../core/api/index.js';
import { CONTEXT_PICKER_RECENT_SECTION_MAX } from '../../config.js';
import { t } from '../../i18n/index.js';
import { escapeHtml } from '../chat/chatHtmlUtils.js';
import {
  buildRecentRankMap,
  loadRecentEntries,
  pickRecentItems,
  sortItemsByRecent,
  touchRecentEntry,
} from './contextPickerRecent.js';

/**
 * @param {string} fileName
 * @returns {string}
 */
function commandBaseName(fileName) {
  return String(fileName || '').replace(/\.(md|mdc)$/i, '');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
/**
 * @param {string} text
 * @param {HTMLInputElement|HTMLTextAreaElement|null} input
 * @returns {void}
 */
function insertIntoInput(text, input) {
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
    return;
  }
  const snippet = String(text ?? '');
  if (snippet === '') {
    return;
  }
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  input.value = before + snippet + after;
  const caret = before.length + snippet.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

/**
 * @returns {void}
 */
export function closeExtraBar() {
  const wrap = document.getElementById('chat-extra-bar-wrap');
  if (!wrap) {
    return;
  }
  wrap.classList.remove('is-visible');
  wrap.setAttribute('aria-hidden', 'true');
  wrap.querySelectorAll('.send-bar-options-row').forEach((row) => {
    row.hidden = true;
  });
  const specialBar = document.getElementById('special-chars-bar');
  if (specialBar) {
    specialBar.style.display = 'none';
  }
  document.querySelectorAll('.send-keys-toggle-extra-btn').forEach((btn) => {
    btn.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
  });
}

/**
 * @param {{
 *   getInputElement: () => HTMLInputElement|HTMLTextAreaElement|null,
 * }} options
 * @returns {void}
 */
export function initExtraBarContextPicker({ getInputElement }) {
  const container = document.getElementById('extra-bar-context-picker');
  const wrap = document.getElementById('chat-extra-bar-wrap');
  if (!(container instanceof HTMLElement) || !(wrap instanceof HTMLElement)) {
    return;
  }

  container.innerHTML = `
    <div class="extra-bar-context-picker-head">
      <input type="search" class="extra-bar-context-picker-search input" placeholder="${escapeHtml(t('sendBar.contextPickerSearch'))}" autocomplete="off" aria-label="${escapeHtml(t('sendBar.contextPickerSearch'))}">
    </div>
    <div class="extra-bar-context-picker-body"></div>
  `;

  const searchInput = container.querySelector('.extra-bar-context-picker-search');
  const bodyEl = container.querySelector('.extra-bar-context-picker-body');

  /** @type {object|null} */
  let cachedContext = null;
  /** @type {Promise<object|null>|null} */
  let loadPromise = null;

  /**
   * @returns {Promise<object|null>}
   */
  async function loadContext() {
    if (cachedContext) {
      return cachedContext;
    }
    if (loadPromise) {
      return loadPromise;
    }
    loadPromise = getCursorContext()
      .then((data) => {
        if (!data?.ok) {
          return { __loadError: data?.error || t('sendBar.contextPickerLoadError') };
        }
        cachedContext = data;
        return data;
      })
      .catch((error) => ({
        __loadError: error instanceof Error ? error.message : t('sendBar.contextPickerLoadError'),
      }))
      .finally(() => {
        loadPromise = null;
      });
    return loadPromise;
  }

  /**
   * @param {Array<{ id: string, label: string, hint?: string, insert: string }>} items
   * @param {string} query
   * @returns {Array<object>}
   */
  function filterItems(items, query) {
    const q = String(query || '').trim().toLowerCase();
    if (q === '') {
      return items;
    }
    return items.filter((item) => {
      const hay = `${item.label} ${item.hint ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  /**
   * @param {Array<object>} items
   * @returns {string}
   */
  function renderItemButtons(items) {
    return items.map((item) => `
      <button type="button" class="quick-cmd-btn extra-bar-context-picker-item" data-id="${escapeHtml(item.id)}" data-insert="${escapeHtml(item.insert)}" title="${escapeHtml(item.hint ? `${item.label} (${item.hint})` : item.label)}">
        ${escapeHtml(item.label)}
      </button>
    `).join('');
  }

  /**
   * @param {object|null} ctx
   * @param {string} query
   * @returns {void}
   */
  function renderItems(ctx, query = '') {
    if (!(bodyEl instanceof HTMLElement)) {
      return;
    }
    if (!ctx || ctx.__loadError) {
      const message = ctx?.__loadError || t('sendBar.contextPickerLoadError');
      bodyEl.innerHTML = `<p class="extra-bar-context-picker-empty">${escapeHtml(message)}</p>`;
      return;
    }

    const normalizedQuery = String(query || '').trim();
    const recentEntries = loadRecentEntries();
    const recentRank = buildRecentRankMap(recentEntries);

    /** @type {Array<{ id: string, label: string, hint?: string, insert: string }>} */
    const allItems = [];

    const projectCommands = (ctx.projectCommands ?? []).map((item) => ({
      id: `cmd:${item.name}`,
      label: commandBaseName(item.name),
      hint: t('sendBar.contextPickerCommand'),
      insert: `@${commandBaseName(item.name)} `,
    }));
    const sharedCommands = (ctx.sharedCommands ?? []).map((item) => ({
      id: `scmd:${item.name}`,
      label: commandBaseName(item.name),
      hint: t('sendBar.contextPickerCommandShared'),
      insert: `@${commandBaseName(item.name)} `,
    }));
    const commands = [...projectCommands, ...sharedCommands];
    allItems.push(...commands);

    const projectSkills = (ctx.projectSkills ?? []).map((item) => ({
      id: `pskill:${item.name}`,
      label: item.name,
      hint: t('sendBar.contextPickerSkillProject'),
      insert: `${t('sendBar.contextPickerUseSkill')} ${item.name}. `,
    }));
    allItems.push(...projectSkills);

    const sharedSkills = (ctx.sharedSkills ?? []).map((item) => ({
      id: `sskill:${item.name}`,
      label: item.name,
      hint: t('sendBar.contextPickerSkillShared'),
      insert: `${t('sendBar.contextPickerUseSkill')} ${item.name}. `,
    }));
    allItems.push(...sharedSkills);

    const userSkills = (ctx.userSkills ?? []).map((item) => ({
      id: `uskill:${item.name}`,
      label: item.name,
      hint: t('sendBar.contextPickerSkillUser'),
      insert: `${t('sendBar.contextPickerUseSkill')} ${item.name}. `,
    }));
    allItems.push(...userSkills);

    const projectAgents = (ctx.projectAgents ?? []).map((item) => ({
      id: `pagent:${item.name}`,
      label: item.name,
      hint: t('sendBar.contextPickerAgentProject'),
      insert: `${t('sendBar.contextPickerRunAgent')} ${item.name}. ${t('sendBar.contextPickerTask')}: `,
    }));
    allItems.push(...projectAgents);

    const sharedAgents = (ctx.sharedAgents ?? []).map((item) => ({
      id: `sagent:${item.name}`,
      label: item.name,
      hint: t('sendBar.contextPickerAgentShared'),
      insert: `${t('sendBar.contextPickerRunAgent')} ${item.name}. ${t('sendBar.contextPickerTask')}: `,
    }));
    allItems.push(...sharedAgents);

    const userAgents = (ctx.userAgents ?? []).map((item) => ({
      id: `uagent:${item.name}`,
      label: item.name,
      hint: t('sendBar.contextPickerAgentUser'),
      insert: `${t('sendBar.contextPickerRunAgent')} ${item.name}. ${t('sendBar.contextPickerTask')}: `,
    }));
    allItems.push(...userAgents);

    /** @type {Array<{ section: string, items: object[] }>} */
    const sections = [];
    /** @type {Set<string>} */
    let recentIds = new Set();

    if (normalizedQuery === '') {
      const recentItems = pickRecentItems(allItems, recentEntries, CONTEXT_PICKER_RECENT_SECTION_MAX);
      if (recentItems.length > 0) {
        recentIds = new Set(recentItems.map((item) => item.id));
        sections.push({
          section: t('sendBar.contextPickerRecent'),
          items: recentItems,
        });
      }
    }

    const filteredCommands = sortItemsByRecent(
      filterItems(commands, query).filter((item) => !recentIds.has(item.id)),
      recentRank,
    );
    if (filteredCommands.length > 0) {
      sections.push({ section: t('sendBar.contextPickerCommands'), items: filteredCommands });
    }

    const filteredProjectSkills = sortItemsByRecent(
      filterItems(projectSkills, query).filter((item) => !recentIds.has(item.id)),
      recentRank,
    );
    if (filteredProjectSkills.length > 0) {
      sections.push({ section: t('sendBar.contextPickerSkillsProject'), items: filteredProjectSkills });
    }

    const filteredSharedSkills = sortItemsByRecent(
      filterItems(sharedSkills, query).filter((item) => !recentIds.has(item.id)),
      recentRank,
    );
    if (filteredSharedSkills.length > 0) {
      sections.push({ section: t('sendBar.contextPickerSkillsShared'), items: filteredSharedSkills });
    }

    const filteredUserSkills = sortItemsByRecent(
      filterItems(userSkills, query).filter((item) => !recentIds.has(item.id)),
      recentRank,
    );
    if (filteredUserSkills.length > 0) {
      sections.push({ section: t('sendBar.contextPickerSkillsUser'), items: filteredUserSkills });
    }

    const filteredProjectAgents = sortItemsByRecent(
      filterItems(projectAgents, query).filter((item) => !recentIds.has(item.id)),
      recentRank,
    );
    if (filteredProjectAgents.length > 0) {
      sections.push({ section: t('sendBar.contextPickerAgentsProject'), items: filteredProjectAgents });
    }

    const filteredSharedAgents = sortItemsByRecent(
      filterItems(sharedAgents, query).filter((item) => !recentIds.has(item.id)),
      recentRank,
    );
    if (filteredSharedAgents.length > 0) {
      sections.push({ section: t('sendBar.contextPickerAgentsShared'), items: filteredSharedAgents });
    }

    const filteredUserAgents = sortItemsByRecent(
      filterItems(userAgents, query).filter((item) => !recentIds.has(item.id)),
      recentRank,
    );
    if (filteredUserAgents.length > 0) {
      sections.push({ section: t('sendBar.contextPickerAgentsUser'), items: filteredUserAgents });
    }

    if (sections.length === 0) {
      bodyEl.innerHTML = `<p class="extra-bar-context-picker-empty">${escapeHtml(t('sendBar.contextPickerEmpty'))}</p>`;
      return;
    }

    bodyEl.innerHTML = sections.map((section) => `
      <section class="extra-bar-context-picker-section">
        <h4 class="extra-bar-context-picker-section-title">${escapeHtml(section.section)}</h4>
        <div class="extra-bar-context-picker-row">
          ${renderItemButtons(section.items)}
        </div>
      </section>
    `).join('');
  }

  async function refreshPanel() {
    if (!(bodyEl instanceof HTMLElement)) {
      return;
    }
    bodyEl.innerHTML = `<p class="extra-bar-context-picker-empty">${escapeHtml(t('common.loading'))}</p>`;
    const ctx = await loadContext();
    const query = searchInput instanceof HTMLInputElement ? searchInput.value : '';
    renderItems(ctx, query);
  }

  container.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const itemBtn = target.closest('.extra-bar-context-picker-item');
    if (!(itemBtn instanceof HTMLButtonElement)) {
      return;
    }
    const insert = itemBtn.dataset.insert ?? '';
    const itemId = itemBtn.dataset.id ?? '';
    if (itemId !== '') {
      touchRecentEntry(itemId);
    }
    insertIntoInput(insert, getInputElement());
    closeExtraBar();
  });

  searchInput?.addEventListener('input', () => {
    renderItems(cachedContext, searchInput instanceof HTMLInputElement ? searchInput.value : '');
  });

  const observer = new MutationObserver(() => {
    if (!wrap.classList.contains('is-visible')) {
      return;
    }
    cachedContext = null;
    void refreshPanel();
  });
  observer.observe(wrap, { attributes: true, attributeFilter: ['class'] });
}
