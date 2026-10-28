/**
 * Markup of the whole Watcher settings panel (form + region hosts).
 */

import { ws } from './store.js';
import { t } from '../../../i18n/index.js';

import { COOLDOWN_MAX_MS, COOLDOWN_MIN_MS, COOLDOWN_STEP_MS, DEFAULT_POLICY, MODES, PICK_ROLES, SCOUT_CATEGORIES } from './constants.js';
import { escapeAttr, escapeHtml, formatCooldownLabel, renderDurationField } from './format.js';

import { activeWatcherTab, syncWatcherTabFromSettings, watcherPanelAttrs } from './runtime.js';
import { renderWorkspaceOverridesHtml } from './views.js';
import { quietHoursActive } from './format.js';

/**
 * Build the panel markup for one watcher view. The result is mounted through
 * `watcherFragment`; the live regions inside it are custom elements that render
 * themselves from the store.
 *
 * @param {any} data
 * @returns {string}
 */
export function renderWatcherPanel(data) {
  const watcher = data.watcher || {};
  const policy = watcher.policy || {};
  const quiet = policy.quietHours || {};
  const orchestrator = policy.orchestrator || {};
  const quietEnabled = quietHoursActive(quiet);
  const roleChecks = PICK_ROLES.map((role) => (
    `<label class="cr-check"><input type="checkbox" data-pick-role="${role}"${(policy.pickRoles || []).includes(role) ? ' checked' : ''}> ${escapeHtml(role)}</label>`
  )).join('');
  const modeRadios = MODES.map((mode) => (
    `<label class="cr-check watcher-mode-radio"><input type="radio" name="watcher-mode" value="${mode}"${watcher.mode === mode ? ' checked' : ''}> ${escapeHtml(t(`settings.watcherMode_${mode}`))}</label>`
  )).join('');
  // Cooldown slider: extend the max so an unusually large saved value never
  // gets silently lowered when the operator saves without touching the control.
  const cooldownMs = Number(policy.cooldownMs) || 0;
  const cooldownMax = Math.max(COOLDOWN_MAX_MS, Math.ceil(cooldownMs / COOLDOWN_STEP_MS) * COOLDOWN_STEP_MS);
  // Harness checkboxes come from the catalog, with any already-allowed id the
  // catalog no longer lists appended so a save can never silently drop it.
  const allowedHarnesses = Array.isArray(policy.allowedHarnesses) ? policy.allowedHarnesses.map(String) : [];
  const scoutAllowedHarnesses = Array.isArray(policy.scoutAllowedHarnesses) && policy.scoutAllowedHarnesses.length
    ? policy.scoutAllowedHarnesses.map(String)
    : allowedHarnesses;
  const seenHarness = new Set();
  const harnessRows = [];
  for (const opt of ws.harnessOptions) {
    if (!opt.id || seenHarness.has(opt.id)) continue;
    seenHarness.add(opt.id);
    harnessRows.push({ id: opt.id, label: opt.label || opt.id });
  }
  for (const id of [...allowedHarnesses, ...scoutAllowedHarnesses]) {
    if (!id || seenHarness.has(id)) continue;
    seenHarness.add(id);
    harnessRows.push({ id, label: id });
  }
  const harnessChecks = harnessRows.length
    ? harnessRows.map((row) => (
      `<label class="cr-check"><input type="checkbox" data-harness="${escapeAttr(row.id)}"${allowedHarnesses.includes(row.id) ? ' checked' : ''}> ${escapeHtml(row.label)}</label>`
    )).join('')
    : `<span class="cr-hint">${escapeHtml(t('settings.watcherNoHarnesses'))}</span>`;
  const scoutHarnessChecks = harnessRows.length
    ? harnessRows.map((row) => (
      `<label class="cr-check"><input type="checkbox" data-scout-harness="${escapeAttr(row.id)}"${scoutAllowedHarnesses.includes(row.id) ? ' checked' : ''}> ${escapeHtml(row.label)}</label>`
    )).join('')
    : `<span class="cr-hint">${escapeHtml(t('settings.watcherNoHarnesses'))}</span>`;
  const scoutCats = Array.isArray(policy.scoutCategories) && policy.scoutCategories.length
    ? policy.scoutCategories.map(String)
    : SCOUT_CATEGORIES;
  const scoutCatChecks = SCOUT_CATEGORIES.map((cat) => (
    `<label class="cr-check"><input type="checkbox" data-scout-category="${cat}"${scoutCats.includes(cat) ? ' checked' : ''}> ${escapeHtml(t(`settings.watcherCat_${cat}`))}</label>`
  )).join('');
  const scoutInterval = Math.min(24, Math.max(1, Math.round(Number(policy.scoutIntervalHours) || DEFAULT_POLICY.scoutIntervalHours)));
  const feedbackProposals = (Array.isArray(watcher.feedbackTriageProposals) ? watcher.feedbackTriageProposals : [])
    .filter((proposal) => proposal.status === 'pending').slice(-20).reverse();
  const feedbackRows = feedbackProposals.map((proposal) => `<li class="cr-card">
    <strong>${escapeHtml(proposal.title || proposal.action)}</strong>
    <p>${escapeHtml(proposal.reason || '')}</p>
    ${proposal.planMarkdown ? `<pre class="cr-hint">${escapeHtml(proposal.planMarkdown)}</pre>` : ''}
    <p class="cr-hint">${escapeHtml(proposal.action)} · ${escapeHtml(proposal.severity)} · ${escapeHtml(proposal.reportId)}</p>
    <div class="cr-row"><cr-bar-button data-feedback-decision="accept" data-feedback-id="${escapeAttr(proposal.id)}">${escapeHtml(t('settings.watcherFeedbackAccept'))}</cr-bar-button>
    <cr-bar-button data-feedback-decision="reject" data-feedback-id="${escapeAttr(proposal.id)}">${escapeHtml(t('settings.watcherFeedbackDismiss'))}</cr-bar-button></div>
  </li>`).join('');
  const decisions = Array.isArray(watcher.decisions) ? watcher.decisions.slice(-10).reverse() : [];
  const decisionRows = decisions.length === 0
    ? `<li class="settings-hint">${escapeHtml(t('settings.watcherNoDecisions'))}</li>`
    : decisions.map((d) => (
      `<li><code>${escapeHtml(d.at || '')}</code> <strong>${escapeHtml(d.kind || '')}</strong> · ${escapeHtml(d.reason || '')} · ready=${Number(d.readyTodoCount) || 0} active=${Number(d.activeAgentCount) || 0}</li>`
    )).join('');
  const failures = watcher.failures && Object.keys(watcher.failures).length
    ? Object.entries(watcher.failures).map(([id, n]) => `<li>${escapeHtml(String(id).slice(0, 8))}: ${Number(n) || 0}</li>`).join('')
    : `<li class="settings-hint">${escapeHtml(t('settings.watcherNone'))}</li>`;
  const planRequests = Object.entries(watcher.planRequests || {})
    .map(([id, at]) => `<li>${escapeHtml(String(id).slice(0, 8))} · ${escapeHtml(String(at))}</li>`).join('')
    || `<li class="settings-hint">${escapeHtml(t('settings.watcherNone'))}</li>`;
  const workspaceFolder = String(data.workspaceFolder || data.cwd || watcher.workspaceFolder || '').trim();

  syncWatcherTabFromSettings();
  const savebarHidden = activeWatcherTab() === 'settings' || activeWatcherTab() === 'scout' ? '' : ' hidden';
  return `
    <div ${watcherPanelAttrs('status')}>
      <cr-watcher-runtime-control id="watcher-runtime-control" class="cr-card watcher-status-card"></cr-watcher-runtime-control>
      <cr-watcher-load-metrics id="watcher-load-metrics" class="cr-card watcher-status-card"></cr-watcher-load-metrics>
      <cr-watcher-status-card id="watcher-status-card" class="cr-card watcher-status-card"></cr-watcher-status-card>
    </div>

    <div ${watcherPanelAttrs('monitor')}>
      <cr-watcher-dashboard id="watcher-dashboard" class="watcher-dashboard"></cr-watcher-dashboard>
    </div>

    <div ${watcherPanelAttrs('settings')}>
    <div class="cr-card watcher-status-card">
      <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherScheduleTitle'))}</h4>
      <p class="cr-hint">${escapeHtml(t('settings.watcherScheduleHint'))}</p>
      <cr-watcher-schedule id="watcher-schedule-info"></cr-watcher-schedule>
    </div>
    <div class="cr-card watcher-form">
      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherGeneral'))}</h4>
        <div class="cr-field">
          <span class="cr-field-label">${escapeHtml(t('settings.watcherMode'))}</span>
          <div class="watcher-mode-list">${modeRadios}</div>
        </div>
        <div class="cr-field">
          <span class="cr-field-label">${escapeHtml(t('settings.watcherWorkspaceFolder'))}</span>
          <code class="watcher-folder">${escapeHtml(workspaceFolder || '-')}</code>
        </div>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherLimits'))}</h4>
        <div class="watcher-grid">
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherMaxCyclesPerDay'))}</span><input id="watcher-max-cycles" type="number" min="0" value="${Number(policy.maxCyclesPerDay) || 0}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherMaxParallel'))}</span><input id="watcher-max-parallel" type="number" min="1" max="10" value="${Number(policy.maxParallel) || 1}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherMaxParallelWorktree'))}</span><input id="watcher-max-parallel-worktree" type="number" min="0" max="10" value="${Number(policy.maxParallelWorktree) || 0}"><span class="cr-hint">${escapeHtml(t('settings.watcherMaxParallelWorktreeHint'))}</span></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherMaxParallelProject'))}</span><input id="watcher-max-parallel-project" type="number" min="0" max="10" value="${Number(policy.maxParallelProject) || 0}"><span class="cr-hint">${escapeHtml(t('settings.watcherMaxParallelProjectHint'))}</span></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherMaxFailures'))}</span><input id="watcher-max-failures" type="number" min="0" value="${Number(policy.maxConsecutiveFailures) || 0}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherMaxSameFindings'))}</span><input id="watcher-max-findings" type="number" min="0" value="${Number(policy.maxSameFindings) || 0}"></label>
          ${renderDurationField({ id: 'watcher-backoff-base', labelKey: 'settings.watcherBackoffBase', ms: policy.backoffBaseMs })}
          ${renderDurationField({ id: 'watcher-backoff-cap', labelKey: 'settings.watcherBackoffCap', ms: policy.backoffCapMs })}
          <label class="cr-field watcher-wide"><span class="cr-field-label">${escapeHtml(t('settings.watcherCooldown'))} · <span id="watcher-cooldown-out" class="watcher-slider-out">${escapeHtml(formatCooldownLabel(cooldownMs))}</span></span><input id="watcher-cooldown" type="range" min="${COOLDOWN_MIN_MS}" max="${cooldownMax}" step="${COOLDOWN_STEP_MS}" value="${cooldownMs}"></label>
        </div>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherAutomation'))}</h4>
        <p class="cr-hint">${escapeHtml(t('settings.watcherAutomationHint'))}</p>
        <label class="cr-check"><input type="checkbox" id="watcher-auto-integrate"${policy.autoIntegrate === true ? ' checked' : ''}> ${escapeHtml(t('settings.watcherAutoIntegrate'))}</label>
        <p class="cr-hint">${escapeHtml(t('settings.watcherAutoIntegrateHint'))}</p>
        <div class="watcher-grid">
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherAutoIntegratePerHour'))}</span><input id="watcher-auto-integrate-per-hour" type="number" min="1" max="100" value="${Number(policy.autoIntegrateMaxPerHour) || DEFAULT_POLICY.autoIntegrateMaxPerHour}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherAutoIntegrateFailures'))}</span><input id="watcher-auto-integrate-failures" type="number" min="1" max="100" value="${Number(policy.autoIntegrateMaxFailures) || DEFAULT_POLICY.autoIntegrateMaxFailures}"></label>
        </div>
        <label class="cr-check"><input type="checkbox" id="watcher-auto-restart"${policy.autoRestart === true ? ' checked' : ''}> ${escapeHtml(t('settings.watcherAutoRestart'))}</label>
        <p class="cr-hint">${escapeHtml(t('settings.watcherAutoRestartHint'))}</p>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherQuietHours'))}</h4>
        <label class="cr-check"><input type="checkbox" id="watcher-quiet-enabled"${quietEnabled ? ' checked' : ''}> ${escapeHtml(t('settings.watcherQuietEnabled'))}</label>
        <div class="watcher-grid watcher-quiet-fields">
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherQuietStart'))}</span><input id="watcher-quiet-start" type="time" step="60" value="${escapeAttr(quiet.start || '')}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherQuietEnd'))}</span><input id="watcher-quiet-end" type="time" step="60" value="${escapeAttr(quiet.end || '')}"></label>
        </div>
        <p class="cr-hint">${escapeHtml(t('settings.watcherQuietWrapHint'))}</p>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherPhases'))}</h4>
        ${['plan', 'review', 'implement', 'integrate'].map((phase) => `<label class="cr-check"><input type="checkbox" id="watcher-phase-${phase}"${(policy.phases?.[phase] ?? DEFAULT_POLICY.phases[phase]) ? ' checked' : ''}> ${escapeHtml(t(`settings.watcherPhase_${phase}`))}</label>`).join('\n        ')}
        <p class="cr-hint">${escapeHtml(t('settings.watcherPhasesHint'))}</p>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherPlanGate'))}</h4>
        <label class="cr-check"><input type="checkbox" id="watcher-require-plan"${policy.requirePlanApproval !== false ? ' checked' : ''}> ${escapeHtml(t('settings.watcherRequirePlan'))}</label>
        <div class="watcher-plan-scope-row${policy.requirePlanApproval === false ? ' is-disabled' : ''}">
          <label class="cr-radio"><input type="radio" name="watcher-plan-scope" value="leaf"${policy.planApprovalScope !== 'root' ? ' checked' : ''}> ${escapeHtml(t('settings.watcherPlanScopeLeaf'))}</label>
          <label class="cr-radio"><input type="radio" name="watcher-plan-scope" value="root"${policy.planApprovalScope === 'root' ? ' checked' : ''}> ${escapeHtml(t('settings.watcherPlanScopeRoot'))}</label>
        </div>
        <p class="cr-hint${policy.requirePlanApproval === false ? ' is-disabled' : ''}">${escapeHtml(t(policy.planApprovalScope === 'root' ? 'settings.watcherPlanScopeRootHint' : 'settings.watcherPlanScopeLeafHint'))}</p>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherReviewGate'))}</h4>
        <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherRequireReviewForDone'))}</span>
          <select id="watcher-review-gate-mode">
            ${['off', 'warn', 'enforce'].map((mode) => `<option value="${mode}"${(policy.requireReviewForDone || 'off') === mode ? ' selected' : ''}>${escapeHtml(t(`settings.watcherReviewGate_${mode}`))}</option>`).join('')}
          </select>
        </label>
        <label class="cr-check"><input type="checkbox" id="watcher-review-gate-independent"${policy.requireIndependentReview === true ? ' checked' : ''}> ${escapeHtml(t('settings.watcherRequireIndependentReview'))}</label>
        <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherReviewGateMaxAttempts'))}</span><input id="watcher-review-gate-attempts" type="number" min="1" max="5" value="${Number(policy.reviewGateMaxAttempts) || DEFAULT_POLICY.reviewGateMaxAttempts}"></label>
        <p class="cr-hint">${escapeHtml(t('settings.watcherReviewGateHint'))}</p>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherAllowedHarnesses'))}</h4>
        <p class="cr-hint">${escapeHtml(t('settings.watcherAllowedHarnessesHint'))}</p>
        <div class="watcher-check-list">${harnessChecks}</div>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherOrchestrator'))}</h4>
        <div class="watcher-grid">
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherOrchestratorHarness'))}</span><input id="watcher-orch-harness" type="text" placeholder="(auto cheap implement pick)" value="${escapeAttr(orchestrator.harness || '')}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherOrchestratorModel'))}</span><input id="watcher-orch-model" type="text" value="${escapeAttr(orchestrator.model || '')}"></label>
        </div>
        <div class="cr-field">
          <span class="cr-field-label">${escapeHtml(t('settings.watcherPickRoles'))}</span>
          <div class="watcher-role-list">${roleChecks}</div>
        </div>
      </section>
      ${renderWorkspaceOverridesHtml(t)}
    </div>
    </div>

    <div ${watcherPanelAttrs('scout')}>
    <cr-watcher-scout-editor id="watcher-scout-editor"></cr-watcher-scout-editor>
    <cr-watcher-scout-templates id="watcher-scout-templates"></cr-watcher-scout-templates>
    <cr-watcher-scout-profiles id="watcher-scout-profiles"></cr-watcher-scout-profiles>
    <cr-watcher-scout-history id="watcher-scout-history"></cr-watcher-scout-history>
    <cr-watcher-scout-inbox id="watcher-scout-inbox"></cr-watcher-scout-inbox>
    <cr-watcher-scout-preview id="watcher-scout-preview"></cr-watcher-scout-preview>
    <cr-watcher-scout-restore id="watcher-scout-restore"></cr-watcher-scout-restore>
    <div class="cr-card watcher-form">
      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherScoutScheduleTitle'))}</h4>
        <cr-watcher-scout-schedule id="watcher-scout-schedule-info"></cr-watcher-scout-schedule>
        <div class="cr-row watcher-actions watcher-scout-run-row">
          <cr-bar-button id="watcher-scout-run"${data.scout?.enabled === true ? '' : ' disabled'}>${escapeHtml(t('settings.watcherScoutRunNow'))}</cr-bar-button>
          <span id="watcher-scout-run-status" class="cr-status"></span>
        </div>
        <p class="cr-hint">${escapeHtml(t('settings.watcherScoutRunHint'))}</p>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherFeedbackTriage'))}</h4>
        <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherFeedbackTriage'))}</span><cr-bar-select id="watcher-feedback-triage" value="${escapeAttr(policy.feedbackTriage || 'off')}"></cr-bar-select></label>
        <p class="cr-hint">${escapeHtml(t('settings.watcherFeedbackTriageHint'))}</p>
        <div class="watcher-grid">
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherFeedbackLimit'))}</span><cr-bar-input id="watcher-feedback-limit" type="number" min="1" max="20" value="${Number(policy.feedbackTriageMaxPerCycle) || DEFAULT_POLICY.feedbackTriageMaxPerCycle}"></cr-bar-input></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherFeedbackCooldown'))}</span><cr-bar-input id="watcher-feedback-cooldown" type="number" min="1" max="1440" value="${Math.floor((Number(policy.feedbackTriageCooldownMs) || DEFAULT_POLICY.feedbackTriageCooldownMs) / 60_000)}"></cr-bar-input></label>
        </div>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherScoutSection'))}</h4>
        <label class="cr-check"><input type="checkbox" id="watcher-scout-enabled"${policy.scoutEnabled === true ? ' checked' : ''}> ${escapeHtml(t('settings.watcherScoutEnabled'))}</label>
        <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherScoutMaxParallel'))}</span><input id="watcher-scout-max-parallel" type="number" min="1" max="10" value="${Number(policy.scoutMaxParallel) || 1}"></label>
        <p class="cr-hint">${escapeHtml(t('settings.watcherScoutMaxParallelHint'))}</p>
        <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherScoutMaxPerDay'))}</span><input id="watcher-scout-max-per-day" type="number" min="0" step="1" value="${Number.isFinite(Number(policy.scoutMaxPerDay)) ? Math.floor(Number(policy.scoutMaxPerDay)) : DEFAULT_POLICY.scoutMaxPerDay}"></label>
        <p class="cr-hint">${escapeHtml(t('settings.watcherScoutMaxPerDayHint'))}</p>
        <label class="cr-check"><input type="checkbox" id="watcher-scout-autocreate"${policy.scoutAutoCreate === true ? ' checked' : ''}> ${escapeHtml(t('settings.watcherScoutAutoCreate'))}</label>
        <div class="cr-field">
          <span class="cr-field-label">${escapeHtml(t('settings.watcherScoutHarnesses'))}</span>
          <p class="cr-hint">${escapeHtml(t('settings.watcherScoutHarnessesHint'))}</p>
          <div class="watcher-check-list">${scoutHarnessChecks}</div>
        </div>
        <label class="cr-field watcher-scout-interval"><span class="cr-field-label">${escapeHtml(t('settings.watcherScoutInterval'))} · <span id="watcher-scout-interval-out" class="watcher-slider-out">${scoutInterval} ${escapeHtml(t('settings.watcherHourUnit'))}</span></span><input id="watcher-scout-interval" type="range" min="1" max="24" step="1" value="${scoutInterval}"></label>
        <div class="cr-field">
          <span class="cr-field-label">${escapeHtml(t('settings.watcherScoutCategories'))}</span>
          <div class="watcher-check-list">${scoutCatChecks}</div>
        </div>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherFeedbackProposals'))}</h4>
        <ul id="watcher-feedback-proposals" class="watcher-list">${feedbackRows || `<li>${escapeHtml(t('settings.watcherFeedbackEmpty'))}</li>`}</ul>
      </section>

    </div>
    </div>

    <div id="watcher-savebar" class="cr-card watcher-form watcher-savebar"${savebarHidden}>
      <p id="watcher-form-error" class="message watcher-form-error" data-tone="error" hidden></p>
      <div class="cr-row watcher-actions">
        <cr-bar-button variant="primary" id="watcher-save">${escapeHtml(t('settings.watcherSave'))}</cr-bar-button>
        <cr-bar-button id="watcher-reset">${escapeHtml(t('settings.watcherResetDefaults'))}</cr-bar-button>
        <span id="watcher-save-status" class="cr-status"></span>
      </div>
    </div>

    <div ${watcherPanelAttrs('actions')}>
    <div class="cr-card watcher-form">
      <div class="cr-row watcher-actions">
        <cr-bar-button id="watcher-stop">${escapeHtml(t('settings.watcherStop'))}</cr-bar-button>
        <cr-bar-button id="watcher-tick">${escapeHtml(t('settings.watcherTick'))}</cr-bar-button>
        <cr-bar-button id="watcher-run-cycle">${escapeHtml(t('settings.watcherRunCycle'))}</cr-bar-button>
        <cr-bar-button id="watcher-pause">${escapeHtml(watcher.paused ? t('settings.watcherResume') : t('settings.watcherPause'))}</cr-bar-button>
        <cr-bar-button id="watcher-clear-stop">${escapeHtml(t('settings.watcherClearStop'))}</cr-bar-button>
        <cr-bar-button id="watcher-clear-backoff">${escapeHtml(t('settings.watcherClearBackoff'))}</cr-bar-button>
      </div>
      <div class="cr-row watcher-actions">
        <input id="watcher-claim-chat" type="text" placeholder="${escapeAttr(t('settings.watcherClaimChatPlaceholder'))}">
        <cr-bar-button id="watcher-claim">${escapeHtml(t('settings.watcherClaim'))}</cr-bar-button>
        <cr-bar-button id="watcher-reset-plan">${escapeHtml(t('settings.watcherResetPlan'))}</cr-bar-button>
        <input id="watcher-findings-hash" type="text" placeholder="${escapeAttr(t('settings.watcherFindingsPlaceholder'))}">
        <cr-bar-button id="watcher-record-findings">${escapeHtml(t('settings.watcherRecordFindings'))}</cr-bar-button>
        <span id="watcher-action-status" class="cr-status"></span>
      </div>
    </div>

    <div class="watcher-lists">
      <div class="cr-card"><h4>${escapeHtml(t('settings.watcherFailures'))}</h4><ul class="watcher-list">${failures}</ul></div>
      <div class="cr-card"><h4>${escapeHtml(t('settings.watcherPlanRequests'))}</h4><ul class="watcher-list">${planRequests}</ul></div>
      <div class="cr-card watcher-wide"><h4>${escapeHtml(t('settings.watcherDecisions'))}</h4><ul class="watcher-list watcher-decisions">${decisionRows}</ul></div>
    </div>
    </div>
  `;
}
