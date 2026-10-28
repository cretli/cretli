/**
 * Policy form: read, validate, reset, save and the manual actions.
 */

import { ws } from './store.js';
import { t } from '../../../i18n/index.js';
import { scoutRunResultText } from '../../watcher/scoutProfilesView.js';
import { watcherApi } from './api.js';
import { CLOCK_RE, DEFAULT_POLICY, PICK_ROLES } from './constants.js';
import { refreshWorkspaceWatcherSettingsPanel } from './refresh.js';
import { refreshScoutHistoryAndInbox } from './scoutFeed.js';
import { SCOUT_CATEGORIES } from './constants.js';
import { queryField, queryFields, formatCooldownLabel, readDurationMs } from './format.js';

/**
 * @param {HTMLElement} root
 * @returns {{ mode: string, policy: any }}
 */
export function readWatcherForm(root) {
  const roles = [...queryFields(root, '[data-pick-role]:checked')].map((el) => el.getAttribute('data-pick-role'));
  const harnesses = [...queryFields(root, '[data-harness]:checked')].map((el) => el.getAttribute('data-harness'));
  const scoutHarnesses = [...queryFields(root, '[data-scout-harness]:checked')].map((el) => el.getAttribute('data-scout-harness'));
  const scoutCats = [...queryFields(root, '[data-scout-category]:checked')].map((el) => el.getAttribute('data-scout-category'));
  const scoutMaxPerDay = Number(queryField(root, '#watcher-scout-max-per-day')?.value);
  const quietEnabled = queryField(root, '#watcher-quiet-enabled')?.checked === true;
  const quietStart = String(queryField(root, '#watcher-quiet-start')?.value || '').trim();
  const quietEnd = String(queryField(root, '#watcher-quiet-end')?.value || '').trim();
  return {
    mode: queryField(root, 'input[name="watcher-mode"]:checked')?.value || 'off',
    policy: {
      maxParallel: Number(queryField(root, '#watcher-max-parallel')?.value) || 1,
      // 0 means "no separate limit" for that execution folder.
      maxParallelWorktree: Number(queryField(root, '#watcher-max-parallel-worktree')?.value) || 0,
      maxParallelProject: Number(queryField(root, '#watcher-max-parallel-project')?.value) || 0,
      maxCyclesPerDay: Number(queryField(root, '#watcher-max-cycles')?.value) || 0,
      maxConsecutiveFailures: Number(queryField(root, '#watcher-max-failures')?.value) || 0,
      maxSameFindings: Number(queryField(root, '#watcher-max-findings')?.value) || 0,
      cooldownMs: Number(queryField(root, '#watcher-cooldown')?.value) || 0,
      backoffBaseMs: readDurationMs(root, 'watcher-backoff-base'),
      backoffCapMs: readDurationMs(root, 'watcher-backoff-cap'),
      requirePlanApproval: queryField(root, '#watcher-require-plan')?.checked !== false,
      planApprovalScope: queryField(root, 'input[name="watcher-plan-scope"]:checked')?.value === 'root' ? 'root' : 'leaf',
      requireReviewForDone: ['off', 'warn', 'enforce'].includes(queryField(root, '#watcher-review-gate-mode')?.value)
        ? queryField(root, '#watcher-review-gate-mode').value
        : DEFAULT_POLICY.requireReviewForDone,
      requireIndependentReview: queryField(root, '#watcher-review-gate-independent')?.checked === true,
      reviewGateMaxAttempts: Number(queryField(root, '#watcher-review-gate-attempts')?.value)
        || DEFAULT_POLICY.reviewGateMaxAttempts,
      phases: Object.fromEntries(['plan', 'review', 'implement', 'integrate'].map((phase) => [
        phase,
        queryField(root, `#watcher-phase-${phase}`)?.checked ?? DEFAULT_POLICY.phases[phase],
      ])),
      // With quiet hours off the pair is sent empty; the guardrails already read
      // an empty/invalid window as "no quiet hours", so no server `enabled` flag
      // is needed and the persisted default shape stays { start, end }.
      quietHours: quietEnabled ? { start: quietStart, end: quietEnd } : { start: '', end: '' },
      orchestrator: {
        harness: String(queryField(root, '#watcher-orch-harness')?.value || '').trim(),
        model: String(queryField(root, '#watcher-orch-model')?.value || '').trim(),
      },
      autoIntegrate: queryField(root, '#watcher-auto-integrate')?.checked === true,
      autoIntegrateMaxPerHour: Number(queryField(root, '#watcher-auto-integrate-per-hour')?.value)
        || DEFAULT_POLICY.autoIntegrateMaxPerHour,
      autoIntegrateMaxFailures: Number(queryField(root, '#watcher-auto-integrate-failures')?.value)
        || DEFAULT_POLICY.autoIntegrateMaxFailures,
      autoRestart: queryField(root, '#watcher-auto-restart')?.checked === true,
      allowedHarnesses: harnesses,
      pickRoles: roles.length ? roles : PICK_ROLES.slice(),
      scoutEnabled: queryField(root, '#watcher-scout-enabled')?.checked === true,
      feedbackTriage: ['propose', 'auto'].includes(queryField(root, '#watcher-feedback-triage')?.value)
        ? queryField(root, '#watcher-feedback-triage').value : 'off',
      feedbackTriageMaxPerCycle: Number(queryField(root, '#watcher-feedback-limit')?.value) || DEFAULT_POLICY.feedbackTriageMaxPerCycle,
      feedbackTriageCooldownMs: (Number(queryField(root, '#watcher-feedback-cooldown')?.value) || 60) * 60_000,
      scoutMaxParallel: Number(queryField(root, '#watcher-scout-max-parallel')?.value) || 1,
      scoutMaxPerDay: Number.isInteger(scoutMaxPerDay) && scoutMaxPerDay >= 0
        ? scoutMaxPerDay
        : DEFAULT_POLICY.scoutMaxPerDay,
      scoutIntervalHours: Number(queryField(root, '#watcher-scout-interval')?.value) || DEFAULT_POLICY.scoutIntervalHours,
      scoutAutoCreate: queryField(root, '#watcher-scout-autocreate')?.checked === true,
      scoutAllowedHarnesses: scoutHarnesses,
      // Unchecking every category would be a footgun (scout would never propose);
      // the server falls back to all categories for an empty list too.
      scoutCategories: scoutCats.length ? scoutCats : [...SCOUT_CATEGORIES],
    },
  };
}

/**
 * @param {HTMLElement} root
 * @param {string[] | null} messages
 */
export function showFormError(root, messages) {
  const el = queryField(root, '#watcher-form-error');
  if (!el) return;
  if (messages && messages.length) {
    el.textContent = messages.join(' · ');
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

/**
 * Client-side guardrails that mirror the server normalization, so an obviously
 * invalid edit is reported before a PATCH round-trip. Bounds here match what
 * `normalizeWorkspaceWatcherPolicy` clamps to (maxParallel 1..10).
 *
 * @param {HTMLElement} root
 * @returns {string[]}
 */
export function validateWatcherForm(root) {
  const errors = [];
  const maxParallel = Number(queryField(root, '#watcher-max-parallel')?.value);
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 10) {
    errors.push(t('settings.watcherValidationMaxParallel'));
  }
  for (const id of ['#watcher-max-parallel-worktree', '#watcher-max-parallel-project']) {
    const raw = queryField(root, id)?.value;
    const pool = raw === '' || raw == null ? 0 : Number(raw);
    if (!Number.isInteger(pool) || pool < 0 || pool > 10) {
      errors.push(t('settings.watcherValidationPoolParallel'));
      break;
    }
  }
  if (queryField(root, '#watcher-quiet-enabled')?.checked === true) {
    const start = String(queryField(root, '#watcher-quiet-start')?.value || '').trim();
    const end = String(queryField(root, '#watcher-quiet-end')?.value || '').trim();
    if (!CLOCK_RE.test(start) || !CLOCK_RE.test(end) || start === end) {
      errors.push(t('settings.watcherValidationQuiet'));
    }
  }
  if (queryField(root, '#watcher-scout-enabled')?.checked === true) {
    const scoutMaxParallel = Number(queryField(root, '#watcher-scout-max-parallel')?.value);
    if (!Number.isInteger(scoutMaxParallel) || scoutMaxParallel < 1 || scoutMaxParallel > 10) {
      errors.push(t('settings.watcherValidationMaxParallel'));
    }
    const interval = Number(queryField(root, '#watcher-scout-interval')?.value);
    if (!Number.isFinite(interval) || interval < 1 || interval > 24) {
      errors.push(t('settings.watcherValidationScoutInterval'));
    }
  }
  for (const id of ['#watcher-auto-integrate-per-hour', '#watcher-auto-integrate-failures']) {
    const value = Number(queryField(root, id)?.value);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      errors.push(t('settings.watcherValidationAutoIntegrateLimits'));
      break;
    }
  }
  const reviewAttempts = Number(queryField(root, '#watcher-review-gate-attempts')?.value);
  if (!Number.isInteger(reviewAttempts) || reviewAttempts < 1 || reviewAttempts > 5) {
    errors.push(t('settings.watcherValidationReviewGateAttempts'));
  }
  const scoutMaxPerDay = Number(queryField(root, '#watcher-scout-max-per-day')?.value);
  if (!Number.isInteger(scoutMaxPerDay) || scoutMaxPerDay < 0) {
    errors.push(t('settings.watcherValidationScoutMaxPerDay'));
  }
  return errors;
}

/**
 * Fill every editor control with the client mirror of the server defaults. This
 * is form-only: it does not PATCH, so an accidental click cannot silently flip a
 * live autopilot workspace. The operator presses Save to persist.
 *
 * @param {HTMLElement} root
 */
export function resetWatcherForm(root) {
  const set = (id, value) => {
    const el = queryField(root, `#${id}`);
    if (el) el.value = String(value);
  };
  const check = (id, on) => {
    const el = queryField(root, `#${id}`);
    if (el) el.checked = !!on;
  };
  const offRadio = queryField(root, 'input[name="watcher-mode"][value="off"]');
  if (offRadio) offRadio.checked = true;
  set('watcher-max-cycles', DEFAULT_POLICY.maxCyclesPerDay);
  set('watcher-max-parallel', DEFAULT_POLICY.maxParallel);
  set('watcher-max-parallel-worktree', DEFAULT_POLICY.maxParallelWorktree);
  set('watcher-max-parallel-project', DEFAULT_POLICY.maxParallelProject);
  set('watcher-max-failures', DEFAULT_POLICY.maxConsecutiveFailures);
  set('watcher-max-findings', DEFAULT_POLICY.maxSameFindings);
  [['watcher-backoff-base', DEFAULT_POLICY.backoffBaseMs], ['watcher-backoff-cap', DEFAULT_POLICY.backoffCapMs]].forEach(([id, rawMs]) => {
    const ms = Number(rawMs);
    set(id, ms / 60_000);
    const out = queryField(root, `[data-watcher-duration-out="${id}"]`);
    if (out) out.textContent = `≈ ${formatCooldownLabel(ms)}`;
  });
  set('watcher-cooldown', DEFAULT_POLICY.cooldownMs);
  const cooldownOut = queryField(root, '#watcher-cooldown-out');
  if (cooldownOut) cooldownOut.textContent = formatCooldownLabel(DEFAULT_POLICY.cooldownMs);
  check('watcher-require-plan', DEFAULT_POLICY.requirePlanApproval);
  set('watcher-review-gate-mode', DEFAULT_POLICY.requireReviewForDone);
  check('watcher-review-gate-independent', DEFAULT_POLICY.requireIndependentReview);
  set('watcher-review-gate-attempts', DEFAULT_POLICY.reviewGateMaxAttempts);
  for (const phase of ['plan', 'review', 'implement', 'integrate']) {
    check(`watcher-phase-${phase}`, DEFAULT_POLICY.phases[phase]);
  }
  const defaultScopeRadio = queryField(root, `input[name="watcher-plan-scope"][value="${DEFAULT_POLICY.planApprovalScope}"]`);
  if (defaultScopeRadio) defaultScopeRadio.checked = true;
  check('watcher-auto-integrate', DEFAULT_POLICY.autoIntegrate);
  set('watcher-auto-integrate-per-hour', DEFAULT_POLICY.autoIntegrateMaxPerHour);
  set('watcher-auto-integrate-failures', DEFAULT_POLICY.autoIntegrateMaxFailures);
  check('watcher-auto-restart', DEFAULT_POLICY.autoRestart);
  check('watcher-quiet-enabled', false);
  set('watcher-quiet-start', '');
  set('watcher-quiet-end', '');
  for (const id of ['#watcher-quiet-start', '#watcher-quiet-end']) {
    const field = queryField(root, id);
    if (field) field.disabled = true;
  }
  queryFields(root, '.watcher-quiet-fields').forEach((wrap) => wrap.classList.add('is-disabled'));
  for (const el of queryFields(root, '[data-harness]')) el.checked = false;
  for (const el of queryFields(root, '[data-scout-harness]')) el.checked = false;
  for (const el of queryFields(root, '[data-pick-role]')) {
    el.checked = DEFAULT_POLICY.pickRoles.includes(el.getAttribute('data-pick-role'));
  }
  check('watcher-scout-enabled', DEFAULT_POLICY.scoutEnabled);
  set('watcher-feedback-triage', DEFAULT_POLICY.feedbackTriage);
  set('watcher-feedback-limit', DEFAULT_POLICY.feedbackTriageMaxPerCycle);
  set('watcher-feedback-cooldown', DEFAULT_POLICY.feedbackTriageCooldownMs / 60_000);
  set('watcher-scout-max-parallel', DEFAULT_POLICY.scoutMaxParallel);
  set('watcher-scout-max-per-day', DEFAULT_POLICY.scoutMaxPerDay);
  check('watcher-scout-autocreate', DEFAULT_POLICY.scoutAutoCreate);
  set('watcher-scout-interval', DEFAULT_POLICY.scoutIntervalHours);
  const scoutOut = queryField(root, '#watcher-scout-interval-out');
  if (scoutOut) scoutOut.textContent = `${DEFAULT_POLICY.scoutIntervalHours} ${t('settings.watcherHourUnit')}`;
  for (const el of queryFields(root, '[data-scout-category]')) el.checked = true;
  set('watcher-orch-harness', '');
  set('watcher-orch-model', '');
  showFormError(root, []);
}

export const ACTION_ENDPOINTS = {
  tick: '/api/workspace-watcher/tick',
  run_cycle: '/api/workspace-watcher/run-cycle',
  claim_next: '/api/workspace-watcher/claim-next',
  reset_plan_requests: '/api/workspace-watcher/reset-plan-requests',
  record_findings: '/api/workspace-watcher/findings',
  clear_stop: '/api/workspace-watcher/clear-stop',
};

/**
 * Build the PATCH body for a save. A full save writes the editable form
 * (mode + policy); a targeted override — the pause toggle, emergency stop or
 * clear-stop — sends *only* the override keys. In particular stop/clear-stop
 * must never read or commit the unsaved mode radio or any dirty policy field.
 *
 * @param {{ [key: string]: unknown } | null} override
 * @param {{ mode: string, policy: any } | null} form
 * @returns {{ [key: string]: unknown }}
 */
export function buildWatcherPatchBody(override, form) {
  return override ? { ...override } : { mode: form.mode, policy: form.policy };
}

export async function saveWatcher(root, override = null) {
  // Targeted overrides must not touch the form at all: reading it here is what
  // let an emergency stop carry a dirty, unsaved mode into the PATCH.
  const form = override ? null : readWatcherForm(root);
  const body = buildWatcherPatchBody(override, form);
  // Full-form saves validate before the round-trip; overrides (pause/stop/clear)
  // carry no editable fields and go straight through.
  if (!override) {
    const errors = validateWatcherForm(root);
    if (errors.length) {
      showFormError(root, errors);
      return;
    }
    showFormError(root, []);
  }
  // Optimistic: reflect the new mode/policy in the cached view; only the regions
  // that read it re-render (never the form, which would drop edits). The
  // authoritative refresh after a successful PATCH corrects any divergence.
  const prevView = ws.lastView;
  const prevViewSeq = ws.viewSeq;
  let optimisticViewSeq = prevViewSeq;
  if (!override && ws.lastView) {
    ws.lastView = {
      ...ws.lastView,
      watcher: {
        ...ws.lastView.watcher,
        mode: form.mode,
        policy: { ...(ws.lastView.watcher?.policy || {}), ...form.policy },
      },
    };
    optimisticViewSeq = ++ws.viewSeq;
  }
  const saveBtn = queryField(root, '#watcher-save');
  if (saveBtn) saveBtn.setAttribute('disabled', 'true');
  setWatcherStatus(root, t('settings.watcherWorking'));
  let res;
  try {
    res = await watcherApi('/api/workspace-watcher', { method: 'PATCH', body });
  } catch {
    res = { json: null };
  } finally {
    if (saveBtn) saveBtn.removeAttribute('disabled');
  }
  if (!res.json?.ok) {
    // Only roll back the optimistic update while the cached view is still the
    // generation this save wrote. A refresh that resolved during the PATCH is
    // fresher and must not be replaced by our stale snapshot.
    if (ws.viewSeq === optimisticViewSeq) {
      ws.lastView = prevView;
      ws.viewSeq += 1;
    }
    const message = res.json?.error || t('settings.watcherSaveError');
    setWatcherStatus(root, message);
    if (!override) showFormError(root, [message]);
    return;
  }
  await refreshWorkspaceWatcherSettingsPanel();
}

export function setWatcherStatus(root, text) {
  for (const sel of ['#watcher-save-status', '#watcher-action-status']) {
    const node = queryField(root, sel);
    if (node) node.textContent = text;
  }
}

export async function watcherAction(root, action) {
  const path = ACTION_ENDPOINTS[action];
  if (!path) return;
  /** @type {Record<string, unknown>} */
  const body = {};
  if (action === 'claim_next') body.claimedByChatId = String(queryField(root, '#watcher-claim-chat')?.value || '').trim();
  if (action === 'record_findings') body.hash = String(queryField(root, '#watcher-findings-hash')?.value || '').trim();
  setWatcherStatus(root, t('settings.watcherWorking'));
  try {
    const res = await watcherApi(path, { method: 'POST', body });
    if (!res.json?.ok) {
      setWatcherStatus(root, res.json?.error || t('settings.watcherActionError'));
      return;
    }
    await refreshWorkspaceWatcherSettingsPanel();
  } catch {
    setWatcherStatus(root, t('settings.watcherActionError'));
  }
}

/**
 * Manual Scout trigger. The server bypasses the scan interval for an explicit
 * run but still respects the mode, quiet hours and the per-day budget, so a
 * blocked answer is reported as a reason (not an error). A non-full refresh
 * keeps the operator's unsaved policy edits and the status line intact.
 *
 * @param {HTMLElement} root
 */
export async function runScoutNow(root) {
  const button = queryField(root, '#watcher-scout-run');
  if (button) button.setAttribute('disabled', 'true');
  const status = queryField(root, '#watcher-scout-run-status');
  if (status) status.textContent = t('settings.watcherWorking');
  let res;
  try {
    res = await watcherApi('/api/workspace-watcher/scout', { method: 'POST', body: { action: 'run' } });
  } catch {
    res = { json: null };
  } finally {
    if (button) button.removeAttribute('disabled');
  }
  const json = res.json || null;
  const blockedReason = scoutRunResultText(json);
  if (!json?.ok || json.scanned === false) {
    // Refresh first: the schedule card may show a spent budget or a blocker.
    await refreshWorkspaceWatcherSettingsPanel({ full: false });
    const liveStatus = queryField(root, '#watcher-scout-run-status');
    if (liveStatus) liveStatus.textContent = blockedReason || json?.error || t('settings.watcherScoutRunError');
    return;
  }
  await refreshWorkspaceWatcherSettingsPanel({ full: false });
  await refreshScoutHistoryAndInbox(json?.scout);
  // A full re-render (workspace switch) replaces the node, so re-query it.
  const liveStatus = queryField(root, '#watcher-scout-run-status');
  if (liveStatus) liveStatus.textContent = t('settings.watcherScoutRunStarted', { n: Number(json.added) || 0 });
}
