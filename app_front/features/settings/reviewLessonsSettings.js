/**
 * Settings → Delegations → Lessons.
 *
 * Candidates (approve / edit / reject), Active (injected, recurred, clean rate)
 * and Retired lessons of the active workspace, plus a small review-loop summary
 * from `GET /api/review-loop-stats`. Lesson text comes from the server already
 * scrubbed of private paths and is rendered only through `textContent`, never
 * as HTML. A stale write (409) reloads the list instead of overwriting.
 */

import { t, getCurrentLang } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getWatcherWorkspaceFolder, scopeWatcherRequestToWorkspace } from '../watcher/watcherWorkspaceScope.js';
import './review-lessons-settings.scss';

const LESSONS_PATH = '/api/review-lessons';
const STATS_WINDOWS = ['7d', '30d', '90d'];
const VIEWS = ['candidate', 'active', 'retired'];

/** @type {{ lessons: object[], view: string, window: string, stats: object | null, statsFailed: boolean, bound: boolean, openTodo: ((id: string) => Promise<boolean>) | null }} */
const state = { lessons: [], view: 'candidate', window: '30d', stats: null, statsFailed: false, bound: false, openTodo: null };

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<{ status: number, json: any }>}
 */
async function api(path, options = {}) {
  const scoped = scopeWatcherRequestToWorkspace(path, options, getWatcherWorkspaceFolder());
  const headers = { Accept: 'application/json', 'Accept-Language': getCurrentLang() };
  if (scoped.options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await cretliApiFetch(scoped.path, {
    method: scoped.options.method || 'GET',
    headers,
    credentials: 'include',
    body: scoped.options.body !== undefined ? JSON.stringify(scoped.options.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * Small DOM builder; text is always assigned through `textContent`.
 *
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

/**
 * @param {string} label
 * @param {string} action
 * @param {string} [variant]
 * @returns {HTMLElement}
 */
function button(label, action, variant = '') {
  const node = el('cr-bar-button', { 'data-lessons-action': action, ...(variant ? { variant } : {}) }, [label]);
  return node;
}

/**
 * @param {number | null | undefined} value 0..1 ratio
 * @returns {string}
 */
export function formatRate(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '–';
}

/**
 * Share of injections that were followed by a clean round, or null before any injection.
 *
 * @param {{ injected?: number, cleanAfterInjection?: number } | undefined} stats
 * @returns {number | null}
 */
export function cleanRate(stats) {
  const injected = Number(stats?.injected || 0);
  return injected > 0 ? Math.min(1, Number(stats?.cleanAfterInjection || 0) / injected) : null;
}

/**
 * @returns {HTMLElement | null}
 */
function getRoot() {
  return document.getElementById('settings-delegation-lessons-root');
}

/**
 * @param {string} text
 * @param {'error' | 'success' | ''} [tone]
 */
function setStatus(text, tone = '') {
  const node = getRoot()?.querySelector('[data-lessons-status]');
  if (!node) return;
  node.textContent = text;
  node.setAttribute('data-tone', tone);
}

/**
 * @param {object} lesson
 * @returns {HTMLElement}
 */
function renderEvidence(lesson) {
  const refs = Array.isArray(lesson.evidence) ? lesson.evidence : [];
  const box = el('div', { class: 'cr-lesson-evidence' }, [el('span', { class: 'cr-field-label' }, [t('settings.reviewLessonsEvidence')])]);
  if (!refs.length) {
    box.append(el('span', { class: 'cr-hint' }, [t('settings.reviewLessonsEvidenceNone')]));
    return box;
  }
  const list = el('div', { class: 'cr-lesson-evidence-list' });
  for (const ref of refs) {
    const leaf = String(ref.leafId || '');
    const label = `${String(ref.ledgerKey || '')}${ref.outcome ? ` · ${ref.outcome}` : ''}`;
    const link = el('button', { type: 'button', class: 'cr-lesson-evidence-link', 'data-lessons-evidence-leaf': leaf, title: t('settings.reviewLessonsEvidenceOpen', { leaf: leaf.slice(0, 8) }) }, [label]);
    list.append(link);
  }
  box.append(list);
  return box;
}

/**
 * @param {object} lesson
 * @returns {HTMLElement}
 */
function renderStats(lesson) {
  const stats = lesson.stats || {};
  if (!Number(stats.injected)) return el('p', { class: 'cr-hint' }, [t('settings.reviewLessonsNoStats')]);
  const rate = cleanRate(stats);
  const text = t('settings.reviewLessonsStats', { injected: stats.injected, recurred: stats.recurred || 0, clean: stats.cleanAfterInjection || 0 });
  return el('p', { class: 'cr-hint', 'data-lessons-stats': '1' }, [`${text} · ${t('settings.reviewLessonsCleanRate', { rate: formatRate(rate) })}`]);
}

/**
 * @param {object} lesson
 * @returns {HTMLElement}
 */
function renderActions(lesson) {
  const bar = el('div', { class: 'cr-row cr-lesson-actions' });
  if (lesson.status === 'candidate') {
    bar.append(button(t('settings.reviewLessonsApprove'), 'approve', 'primary'), button(t('settings.reviewLessonsEdit'), 'edit'), button(t('settings.reviewLessonsReject'), 'reject'));
  } else if (lesson.status === 'active') {
    bar.append(button(t('settings.reviewLessonsEdit'), 'edit'), button(t('settings.reviewLessonsRetire'), 'retire'));
  } else {
    bar.append(button(t('settings.reviewLessonsRestore'), 'restore'));
  }
  return bar;
}

/**
 * @param {object} lesson
 * @returns {HTMLElement}
 */
function renderLesson(lesson) {
  const badges = el('div', { class: 'cr-lesson-badges' }, [
    el('span', { class: 'cr-badge' }, [t(`settings.reviewLessonsAudience_${lesson.audience}`)]),
    el('span', { class: 'cr-badge' }, [t(`settings.reviewLessonsKind_${lesson.kind}`)]),
    el('span', { class: 'cr-badge' }, [String(lesson.category || '')]),
  ]);
  const card = el('div', { class: 'cr-card cr-lesson', 'data-lesson-id': String(lesson.id), 'data-lesson-status': String(lesson.status) }, [
    badges,
    el('p', { class: 'cr-lesson-text' }, [String(lesson.text || '')]),
  ]);
  const globs = Array.isArray(lesson.pathGlobs) ? lesson.pathGlobs : [];
  if (globs.length) card.append(el('p', { class: 'cr-hint' }, [globs.join(', ')]));
  card.append(el('p', { class: 'cr-hint' }, [t('settings.reviewLessonsOrigin', { origin: String(lesson.origin || 'manual') })]));
  if (lesson.status === 'retired' && (lesson.retiredReason || lesson.statusReason)) {
    card.append(el('p', { class: 'cr-hint' }, [t('settings.reviewLessonsRetiredReason', { reason: String(lesson.retiredReason || lesson.statusReason) })]));
  }
  if (lesson.status !== 'candidate') card.append(renderStats(lesson));
  card.append(renderEvidence(lesson), renderActions(lesson));
  return card;
}

/**
 * @param {object | null} stats API payload
 * @returns {HTMLElement}
 */
function renderStatsCard(stats) {
  const select = el('select', { 'data-lessons-window': '1', 'aria-label': t('settings.reviewLessonsStatsWindow') },
    STATS_WINDOWS.map((w) => {
      const option = el('option', { value: w }, [w]);
      if (w === state.window) option.setAttribute('selected', '');
      return option;
    }));
  const card = el('div', { class: 'cr-card cr-lessons-stats', 'data-lessons-stats-card': '1' }, [
    el('div', { class: 'cr-row' }, [el('strong', null, [t('settings.reviewLessonsStatsTitle')]), select]),
  ]);
  if (state.statsFailed) {
    card.append(el('p', { class: 'cr-hint', 'data-tone': 'error' }, [t('settings.reviewLessonsStatsLoadFailed')]));
    return card;
  }
  const win = stats?.workspaces?.[0]?.windows?.[state.window];
  const code = win?.codeReview;
  if (!code || !code.leaves) {
    card.append(el('p', { class: 'cr-hint' }, [t('settings.reviewLessonsStatsNoData')]));
    return card;
  }
  const rounds = code.roundsToPass || {};
  const rows = el('div', { class: 'cr-lessons-stats-grid' }, [
    metric(t('settings.reviewLessonsStatsFirstPass'), formatRate(code.firstPassRate)),
    metric(t('settings.reviewLessonsStatsRounds'), `${rounds.mean ?? '–'} / ${rounds.median ?? '–'}`),
    metric(t('settings.reviewLessonsStatsLeaves'), String(code.leaves)),
    metric(t('settings.reviewLessonsStatsFindings'), String(win.findings?.perReview ?? '–')),
  ]);
  card.append(rows);
  const weekly = (Array.isArray(win.weekly) ? win.weekly : []).filter((w) => Number(w?.leaves) > 0)
    .map((w) => ({ weekStart: w.weekStart, mean: Number(w.rounds) / Number(w.leaves) }));
  if (weekly.length) {
    const peak = Math.max(...weekly.map((w) => w.mean));
    const trend = el('div', { class: 'cr-lessons-trend', role: 'img', 'aria-label': t('settings.reviewLessonsStatsTrend') });
    for (const week of weekly) {
      const bar = el('span', { class: 'cr-lessons-trend-bar', title: `${week.weekStart}: ${Math.round(week.mean * 100) / 100}` });
      bar.style.height = `${Math.max(8, Math.round((week.mean / peak) * 100))}%`;
      trend.append(bar);
    }
    card.append(el('span', { class: 'cr-field-label' }, [t('settings.reviewLessonsStatsTrend')]), trend);
  }
  return card;
}

/**
 * @param {string} label
 * @param {string} value
 * @returns {HTMLElement}
 */
function metric(label, value) {
  return el('div', { class: 'cr-lessons-metric' }, [el('span', { class: 'cr-hint' }, [label]), el('strong', null, [value])]);
}

/** Repaint the whole panel from state. */
function render() {
  const root = getRoot();
  if (!root) return;
  const counts = Object.fromEntries(VIEWS.map((v) => [v, state.lessons.filter((l) => l.status === v).length]));
  const tabs = el('div', { class: 'cr-tabs cr-lessons-tabs', role: 'tablist' }, VIEWS.map((view) => {
    const tab = el('button', { type: 'button', class: 'cr-tab', role: 'tab', 'data-lessons-view': view, 'aria-selected': String(view === state.view) }, [`${t(`settings.reviewLessonsView_${view}`)} (${counts[view]})`]);
    if (view === state.view) tab.classList.add('active');
    return tab;
  }));
  const rows = state.lessons.filter((l) => l.status === state.view);
  const list = el('div', { class: 'cr-lessons-list' }, rows.length
    ? rows.map(renderLesson)
    : [el('p', { class: 'cr-hint', 'data-lessons-empty': '1' }, [t(`settings.reviewLessonsEmpty_${state.view}`)])]);
  const body = el('div', { class: 'cr-lessons-body' }, [
    el('p', { class: 'cr-hint' }, [t('settings.reviewLessonsHint')]),
    renderStatsCard(state.stats),
    el('div', { class: 'cr-row' }, [button(t('settings.reviewLessonsRefresh'), 'refresh'), button(t('settings.reviewLessonsDistill'), 'distill')]),
    tabs,
    list,
    el('p', { class: 'cr-status', 'data-lessons-status': '1', 'data-tone': '', 'aria-live': 'polite' }),
  ]);
  root.replaceChildren(body);
}

/** Load lessons and stats; the lessons list is the primary content. */
export async function refreshReviewLessonsSettings() {
  const root = getRoot();
  if (!root) return;
  if (!state.lessons.length) root.textContent = t('settings.reviewLessonsLoading');
  const [lessonsRes, statsRes] = await Promise.all([
    api(LESSONS_PATH),
    api('/api/review-loop-stats').catch(() => ({ status: 0, json: null })),
  ]);
  if (lessonsRes.status !== 200 || !lessonsRes.json?.ok) {
    root.textContent = `${t('settings.reviewLessonsLoadFailed')} (${lessonsRes.json?.error || `HTTP ${lessonsRes.status}`})`;
    return;
  }
  state.lessons = Array.isArray(lessonsRes.json.lessons) ? lessonsRes.json.lessons : [];
  state.statsFailed = statsRes.status !== 200 || !statsRes.json?.ok;
  state.stats = state.statsFailed ? null : statsRes.json;
  render();
}

/**
 * PATCH one lesson with its loaded revision. A stale revision reloads the list
 * and reports the conflict; nothing is overwritten.
 *
 * @param {object} lesson
 * @param {Record<string, unknown>} patch
 * @param {string} okKey i18n key of the success message
 * @returns {Promise<boolean>}
 */
async function patchLesson(lesson, patch, okKey) {
  const { status, json } = await api(`${LESSONS_PATH}/${encodeURIComponent(lesson.id)}`, {
    method: 'PATCH',
    body: { patch, expectedRevision: lesson.revision },
  });
  if (status === 200 && json?.ok) {
    await refreshReviewLessonsSettings();
    setStatus(t(okKey), 'success');
    return true;
  }
  const conflict = status === 409 || json?.code === 'CONFLICT';
  await refreshReviewLessonsSettings();
  setStatus(conflict ? t('settings.reviewLessonsConflict') : (json?.error || t('settings.reviewLessonsActionFailed')), 'error');
  return false;
}

/**
 * Open the edit dialog (`cr-dialog`) for one lesson.
 *
 * @param {object} lesson
 */
function openEditDialog(lesson) {
  const text = el('textarea', { rows: '3', maxlength: '300', 'data-lessons-edit-text': '1' });
  text.value = String(lesson.text || '');
  const globs = el('input', { type: 'text', 'data-lessons-edit-globs': '1' });
  globs.value = (Array.isArray(lesson.pathGlobs) ? lesson.pathGlobs : []).join(', ');
  const message = el('p', { class: 'cr-status', 'data-tone': '' });
  const save = el('cr-bar-button', { variant: 'primary' }, [t('settings.reviewLessonsSave')]);
  const cancel = el('cr-bar-button', null, [t('settings.reviewLessonsCancel')]);
  const dialog = el('cr-dialog', { heading: t('settings.reviewLessonsEditTitle') }, [
    el('div', { class: 'cr-field' }, [el('span', { class: 'cr-field-label' }, [t('settings.reviewLessonsFieldText')]), text]),
    el('div', { class: 'cr-field' }, [el('span', { class: 'cr-field-label' }, [t('settings.reviewLessonsFieldGlobs')]), globs]),
    message,
    el('div', { slot: 'actions', class: 'cr-row' }, [cancel, save]),
  ]);
  const close = () => { dialog.remove(); };
  dialog.addEventListener('cr-dialog-close', close);
  cancel.addEventListener('click', close);
  save.addEventListener('click', async () => {
    const value = text.value.trim();
    if (!value) {
      message.textContent = t('settings.reviewLessonsTextRequired');
      message.setAttribute('data-tone', 'error');
      return;
    }
    const pathGlobs = globs.value.split(',').map((g) => g.trim()).filter(Boolean);
    const { status, json } = await api(`${LESSONS_PATH}/${encodeURIComponent(lesson.id)}`, {
      method: 'PATCH',
      body: { patch: { text: value, pathGlobs }, expectedRevision: lesson.revision },
    });
    if (status === 200 && json?.ok) {
      close();
      await refreshReviewLessonsSettings();
      setStatus(t('settings.reviewLessonsSaved'), 'success');
      return;
    }
    if (status === 409 || json?.code === 'CONFLICT') {
      close();
      await refreshReviewLessonsSettings();
      setStatus(t('settings.reviewLessonsConflict'), 'error');
      return;
    }
    message.textContent = json?.error || t('settings.reviewLessonsActionFailed');
    message.setAttribute('data-tone', 'error');
  });
  document.body.append(dialog);
  dialog.setAttribute('open', '');
  if (typeof dialog.show === 'function') dialog.show();
}

/**
 * @param {string} action
 * @param {object | undefined} lesson
 */
async function runAction(action, lesson) {
  if (action === 'refresh') return refreshReviewLessonsSettings();
  if (action === 'distill') {
    const { status, json } = await api(`${LESSONS_PATH}/distill`, { method: 'POST', body: {} });
    if (status !== 200 || !json?.ok) return setStatus(json?.error || t('settings.reviewLessonsDistillFailed'), 'error');
    await refreshReviewLessonsSettings();
    const added = Array.isArray(json.candidates) ? json.candidates.length : 0;
    return setStatus(t('settings.reviewLessonsDistilled', { added }), 'success');
  }
  if (!lesson) return undefined;
  if (action === 'edit') return openEditDialog(lesson);
  if (action === 'approve') return patchLesson(lesson, { status: 'active' }, 'settings.reviewLessonsApproved');
  if (action === 'reject') return patchLesson(lesson, { status: 'retired', retiredReason: t('settings.reviewLessonsRejectReason') }, 'settings.reviewLessonsRejected');
  if (action === 'retire') return patchLesson(lesson, { status: 'retired', retiredReason: t('settings.reviewLessonsRetired') }, 'settings.reviewLessonsRetired');
  if (action === 'restore') return patchLesson(lesson, { status: 'candidate' }, 'settings.reviewLessonsRestored');
  return undefined;
}

/**
 * Wire the panel once.
 *
 * @param {{ openTodo?: (id: string) => Promise<boolean> }} [options]
 */
export function initReviewLessonsSettings(options = {}) {
  if (state.bound) return;
  const root = getRoot();
  if (!root) return;
  state.bound = true;
  state.openTodo = options.openTodo || null;
  root.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const viewTab = target.closest('[data-lessons-view]');
    if (viewTab) {
      state.view = viewTab.getAttribute('data-lessons-view') || 'candidate';
      render();
      return;
    }
    const evidence = target.closest('[data-lessons-evidence-leaf]');
    if (evidence) {
      const opened = state.openTodo ? await state.openTodo(evidence.getAttribute('data-lessons-evidence-leaf') || '') : false;
      if (!opened) setStatus(t('settings.reviewLessonsEvidenceOpenFailed'), 'error');
      return;
    }
    const actionButton = target.closest('[data-lessons-action]');
    if (!actionButton) return;
    const id = actionButton.closest('[data-lesson-id]')?.getAttribute('data-lesson-id');
    await runAction(actionButton.getAttribute('data-lessons-action') || '', state.lessons.find((l) => l.id === id));
  });
  root.addEventListener('change', (event) => {
    const select = event.target instanceof Element ? event.target.closest('[data-lessons-window]') : null;
    if (!select) return;
    state.window = /** @type {HTMLSelectElement} */ (select).value;
    render();
  });
  window.addEventListener('cr-lang-changed', () => { if (state.lessons.length) render(); });
}
