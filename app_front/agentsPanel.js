/**
 * Panel rules/commands/skills: toggle, GET /api/cursor-context, render lists.
 */
import * as api from './core/api/index.js';
import { t } from './i18n/index.js';
import { escapeHtml } from './features/chat/chatHtmlUtils.js';

/**
 * @param {HTMLElement | null} el
 * @param {Array<{ name?: string, path?: string, source?: string }> | undefined} items
 * @param {{ showPath?: boolean, emptyLabel?: string }} [options]
 */
function renderNamedList(el, items, options = {}) {
  if (!el) return;
  const showPath = options.showPath !== false;
  const emptyLabel = options.emptyLabel || t('agents.emptyList');
  if (!items?.length) {
    el.innerHTML = `<li>${emptyLabel}</li>`;
    return;
  }
  el.innerHTML = items
    .map((item) => {
      const name = escapeHtml(item.name || '');
      const path = showPath && item.path
        ? ` <span style="color:#6a9955">${escapeHtml(item.path)}</span>`
        : '';
      const source = item.source
        ? ` <span style="color:#858585">(${escapeHtml(item.source)})</span>`
        : '';
      return `<li><code>${name}</code>${path}${source}</li>`;
    })
    .join('');
}

/**
 * Initializes the agents panel: toggle shows/hides the panel and loads /api/cursor-context.
 */
export function initAgentsPanel() {
  const toggle = document.getElementById('agents-toggle');
  const panel = document.getElementById('agents-rules-panel');
  if (!toggle || !panel) return;

  toggle.addEventListener('click', () => {
    if (panel.style.display === 'none' || !panel.style.display) {
      panel.style.display = 'block';
      toggle.innerHTML =
        '<span class="mdi mdi-chevron-up" aria-hidden="true"></span> ' + escapeHtml(t('agents.rulesAndAgentsTitle'));
      api.getCursorContext().then((data) => {
        if (!data.ok) return;
        renderNamedList(document.getElementById('agents-rules'), data.projectRules);
        renderNamedList(document.getElementById('agents-shared-rules'), data.sharedRules);
        renderNamedList(document.getElementById('agents-commands'), [
          ...(data.projectCommands || []),
          ...(data.sharedCommands || []),
        ], { showPath: false });
        renderNamedList(document.getElementById('agents-shared-skills'), data.sharedSkills);
        renderNamedList(document.getElementById('agents-skills'), data.userSkills, {
          showPath: false,
        });
      });
      return;
    }
    panel.style.display = 'none';
    toggle.innerHTML =
      '<span class="mdi mdi-chevron-down" aria-hidden="true"></span> ' + escapeHtml(t('agents.rulesAndAgentsTitle'));
  });
}
