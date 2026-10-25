import { t } from '../../../../i18n/index.js';

/**
 * OpenCode permission advisor metadata, highlight and panel rendering.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installOpenCodeAdvisor(rv) {
  rv.rememberResolvedOpenCodePermissionRequestId = rememberResolvedOpenCodePermissionRequestId;
  rv.isOpenCodePermissionRequestClosed = isOpenCodePermissionRequestClosed;
  rv.clearAdvisorPermissionPick = clearAdvisorPermissionPick;
  rv.markOpenCodePermissionAdvisor = markOpenCodePermissionAdvisor;
  rv.markOpenCodePermissionDecision = markOpenCodePermissionDecision;
  rv.mergeOpenCodePermissionAdvisorMeta = mergeOpenCodePermissionAdvisorMeta;
  rv.markOpenCodePermissionAdvisorStatus = markOpenCodePermissionAdvisorStatus;
  rv.clearOpenCodeInteractiveMaps = clearOpenCodeInteractiveMaps;
  /** @type {Map<string, HTMLElement>} */
  const openCodeQuestionByRequestId = new Map();
  rv.openCodeQuestionByRequestId = openCodeQuestionByRequestId;
  /** @type {Map<string, HTMLElement>} */
  const openCodePermissionByRequestId = new Map();
  rv.openCodePermissionByRequestId = openCodePermissionByRequestId;
  /** @type {Map<string, ReturnType<typeof setInterval>>} */
  const openCodeAdvisorPickTimers = new Map();
  rv.openCodeAdvisorPickTimers = openCodeAdvisorPickTimers;
  /** @type {Map<string, Record<string, unknown>>} */
  const openCodePermissionAdvisorMetaByRequestId = new Map();
  rv.openCodePermissionAdvisorMetaByRequestId = openCodePermissionAdvisorMetaByRequestId;
  /** @type {Set<string>} Resolved permissions — blocks late advisor status from re-buffering meta. */
  const openCodeResolvedPermissionRequestIds = new Set();
  rv.openCodeResolvedPermissionRequestIds = openCodeResolvedPermissionRequestIds;
  const OPENCODE_PERMISSION_ADVISOR_META_MAX = 100;
  const OPENCODE_RESOLVED_PERMISSION_REQUEST_IDS_MAX = 128;

  const OPENCODE_ADVISOR_STATUS_RANK = Object.freeze({
    checking: 1,
    skipped: 2,
    error: 3,
    decided: 4,
  });

  /**
   * @param {string} current
   * @param {string} incoming
   * @returns {boolean}
   */
  function shouldApplyOpenCodeAdvisorStatus(current, incoming) {
    const cur = OPENCODE_ADVISOR_STATUS_RANK[current] || 0;
    const next = OPENCODE_ADVISOR_STATUS_RANK[incoming] || 0;
    if (!current) return true;
    if (next > cur) return true;
    if (next === cur) return true;
    return false;
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function normalizeAdvisorRiskLabel(value) {
    const key = String(value || '').trim().toLowerCase();
    if (key === 'low' || key === 'medium' || key === 'high' || key === 'unknown') {
      return t(`sdkView.openCodePermissionAdvisorRisk.${key}`);
    }
    return t('sdkView.openCodePermissionAdvisorRisk.unknown');
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function normalizeAdvisorRecommendedLabel(value) {
    const key = String(value || '').trim().toLowerCase();
    if (key === 'once' || key === 'always' || key === 'reject') {
      return t(`sdkView.openCodePermissionAdvisorRecommended.${key}`);
    }
    return t('sdkView.openCodePermissionAdvisorRecommended.none');
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function normalizeAdvisorSkipReason(value) {
    const key = String(value || '').trim();
    if (!key) return t('sdkView.openCodePermissionAdvisorPanel.skippedUnknown');
    const i18nKey = `sdkView.openCodePermissionAdvisorSkipReason.${key}`;
    const translated = t(i18nKey);
    if (translated !== i18nKey) return translated;
    return key;
  }

  function trimOpenCodePermissionAdvisorMetaMap() {
    while (openCodePermissionAdvisorMetaByRequestId.size > OPENCODE_PERMISSION_ADVISOR_META_MAX) {
      const firstKey = openCodePermissionAdvisorMetaByRequestId.keys().next().value;
      if (firstKey === undefined) break;
      openCodePermissionAdvisorMetaByRequestId.delete(firstKey);
    }
  }

  /**
   * @param {string} requestId
   */
  function rememberResolvedOpenCodePermissionRequestId(requestId) {
    const id = String(requestId || '').trim();
    if (!id) return;
    openCodeResolvedPermissionRequestIds.add(id);
    while (openCodeResolvedPermissionRequestIds.size > OPENCODE_RESOLVED_PERMISSION_REQUEST_IDS_MAX) {
      const first = openCodeResolvedPermissionRequestIds.values().next().value;
      if (first === undefined) break;
      openCodeResolvedPermissionRequestIds.delete(first);
    }
  }

  /**
   * @param {string} requestId
   * @returns {boolean}
   */
  function isOpenCodePermissionRequestClosed(requestId) {
    const id = String(requestId || '').trim();
    if (!id) return true;
    return openCodeResolvedPermissionRequestIds.has(id);
  }

  function clearAdvisorRecommendationHighlight(block) {
    if (!(block instanceof HTMLElement)) return;
    block.querySelectorAll('.sdk-rich-opencode-permission-actions button.is-advisor-recommend').forEach((el) => {
      el.classList.remove('is-advisor-recommend');
      el.removeAttribute('aria-description');
    });
  }

  /**
   * @param {HTMLElement} block
   * @param {Record<string, unknown>} meta
   */
  function applyAdvisorRecommendationHighlight(block, meta) {
    if (!(block instanceof HTMLElement)) return;
    if (block.classList.contains('sdk-rich-opencode-permission--answered')) return;
    if (block.classList.contains('sdk-rich-opencode-permission--resolved')) return;
    clearAdvisorRecommendationHighlight(block);
    const assessment = meta.advisoryAssessment && typeof meta.advisoryAssessment === 'object'
      ? /** @type {Record<string, unknown>} */ (meta.advisoryAssessment)
      : null;
    const recommended = assessment?.recommended != null
      ? String(assessment.recommended).trim().toLowerCase()
      : '';
    if (!recommended) return;
    const alwaysAvailable = meta.alwaysAvailable === true;
    if (recommended === 'always' && !alwaysAvailable) return;
    const className = recommended === 'reject'
      ? 'sdk-rich-opencode-permission-reject'
      : recommended === 'always'
        ? 'sdk-rich-opencode-permission-always'
        : 'sdk-rich-opencode-permission-once';
    const button = block.querySelector(`.${className}`);
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    button.classList.add('is-advisor-recommend');
    button.setAttribute(
      'aria-description',
      t('sdkView.openCodePermissionAdvisorRecommendAria', { action: normalizeAdvisorRecommendedLabel(recommended) }),
    );
  }

  /**
   * @param {HTMLElement} block
   * @param {string} requestId
   * @param {Record<string, unknown>} meta
   */
  function renderOpenCodePermissionAdvisorPanel(block, requestId, meta) {
    if (!(block instanceof HTMLElement)) return;
    const body = block.querySelector('.sdk-rich-opencode-permission-body');
    if (!body) return;
    let panel = block.querySelector('.sdk-rich-opencode-permission-advisor-panel');
    if (!panel) {
      panel = document.createElement('section');
      panel.className = 'sdk-rich-opencode-permission-advisor-panel';
      panel.setAttribute('role', 'status');
      panel.setAttribute('aria-live', 'polite');
      const actions = block.querySelector('.sdk-rich-opencode-permission-actions');
      if (actions) body.insertBefore(panel, actions);
      else body.appendChild(panel);
    }
    const status = String(meta.status || '').trim() || 'unknown';
    const advisorName = String(meta.advisorName || '').trim() || t('sdkView.openCodePermissionAdvisorDefaultName');
    const advisorProtocol = String(meta.advisorProtocol || '').trim();
    const localRisk = normalizeAdvisorRiskLabel(meta.localRisk);
    const localCategories = Array.isArray(meta.localCategories)
      ? meta.localCategories.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    const assessment = meta.advisoryAssessment && typeof meta.advisoryAssessment === 'object'
      ? /** @type {Record<string, unknown>} */ (meta.advisoryAssessment)
      : null;
    const externalRisk = assessment ? normalizeAdvisorRiskLabel(assessment.risk) : '';
    const recommendedLabel = assessment
      ? normalizeAdvisorRecommendedLabel(assessment.recommended)
      : t('sdkView.openCodePermissionAdvisorRecommended.none');
    const reason = assessment?.reason != null ? String(assessment.reason) : String(meta.reason || '');
    const assessmentLimited = assessment?.assessmentLimited === true;
    const skipReasonLabel = normalizeAdvisorSkipReason(meta.reason);
    const statusLine = t(`sdkView.openCodePermissionAdvisorStatus.${status}`, {
      advisor: advisorName,
      decision: String(meta.advisorDecision || '').trim(),
      finalDecision: String(meta.finalDecision || '').trim(),
      reason: skipReasonLabel,
    });
    panel.replaceChildren();
    const heading = document.createElement('h4');
    heading.className = 'sdk-rich-opencode-permission-advisor-heading';
    heading.textContent = t('sdkView.openCodePermissionAdvisorPanel.heading');
    panel.appendChild(heading);
    const advisorLine = document.createElement('p');
    advisorLine.className = 'sdk-rich-opencode-permission-advisor-line';
    advisorLine.textContent = advisorProtocol
      ? t('sdkView.openCodePermissionAdvisorPanel.advisorLine', { name: advisorName, protocol: advisorProtocol })
      : advisorName;
    panel.appendChild(advisorLine);
    const statusEl = document.createElement('p');
    statusEl.className = 'sdk-rich-opencode-permission-advisor-status-line';
    statusEl.textContent = statusLine;
    panel.appendChild(statusEl);
    const localHeading = document.createElement('p');
    localHeading.className = 'sdk-rich-opencode-permission-advisor-subheading';
    localHeading.textContent = t('sdkView.openCodePermissionAdvisorPanel.localHeading');
    panel.appendChild(localHeading);
    const localRiskEl = document.createElement('p');
    localRiskEl.className = 'sdk-rich-opencode-permission-advisor-line';
    localRiskEl.textContent = t('sdkView.openCodePermissionAdvisorPanel.localRisk', { risk: localRisk });
    panel.appendChild(localRiskEl);
    const localCategoriesEl = document.createElement('p');
    localCategoriesEl.className = 'sdk-rich-opencode-permission-advisor-line';
    localCategoriesEl.textContent = localCategories.length
      ? t('sdkView.openCodePermissionAdvisorPanel.localCategories', { categories: localCategories.join(', ') })
      : t('sdkView.openCodePermissionAdvisorPanel.localCategoriesNone');
    panel.appendChild(localCategoriesEl);
    if (assessment || status === 'decided' || status === 'error') {
      const externalHeading = document.createElement('p');
      externalHeading.className = 'sdk-rich-opencode-permission-advisor-subheading';
      externalHeading.textContent = t('sdkView.openCodePermissionAdvisorPanel.externalHeading');
      panel.appendChild(externalHeading);
      if (externalRisk) {
        const externalRiskEl = document.createElement('p');
        externalRiskEl.className = 'sdk-rich-opencode-permission-advisor-line';
        externalRiskEl.textContent = t('sdkView.openCodePermissionAdvisorPanel.externalRisk', { risk: externalRisk });
        panel.appendChild(externalRiskEl);
      }
      const recommendedEl = document.createElement('p');
      recommendedEl.className = 'sdk-rich-opencode-permission-advisor-line sdk-rich-opencode-permission-advisor-recommended';
      recommendedEl.textContent = t('sdkView.openCodePermissionAdvisorPanel.externalRecommended', { action: recommendedLabel });
      panel.appendChild(recommendedEl);
      if (reason) {
        const reasonEl = document.createElement('p');
        reasonEl.className = 'sdk-rich-opencode-permission-advisor-line sdk-rich-opencode-permission-advisor-reason';
        reasonEl.textContent = t('sdkView.openCodePermissionAdvisorPanel.externalReason', { reason });
        panel.appendChild(reasonEl);
      }
      if (assessmentLimited) {
        const limitedEl = document.createElement('p');
        limitedEl.className = 'sdk-rich-opencode-permission-advisor-note';
        limitedEl.textContent = t('sdkView.openCodePermissionAdvisorPanel.assessmentLimited');
        panel.appendChild(limitedEl);
      }
      if (assessment?.risk === 'unknown') {
        const unknownEl = document.createElement('p');
        unknownEl.className = 'sdk-rich-opencode-permission-advisor-note';
        unknownEl.textContent = t('sdkView.openCodePermissionAdvisorPanel.assessmentUnknown');
        panel.appendChild(unknownEl);
      }
    }
    if (status === 'skipped') {
      const skippedEl = document.createElement('p');
      skippedEl.className = 'sdk-rich-opencode-permission-advisor-note';
      skippedEl.textContent = t('sdkView.openCodePermissionAdvisorPanel.skippedNote', {
        reason: skipReasonLabel,
      });
      panel.appendChild(skippedEl);
    }
    const id = String(requestId || '').trim().slice(0, 64);
    if (id) panel.title = t('sdkView.openCodePermissionAdvisorTooltip', { requestId: id });
    applyAdvisorRecommendationHighlight(block, meta);
  }

  function clearAdvisorPermissionPick(requestId) {
    const id = String(requestId || '').trim();
    if (!id) return;
    const timer = openCodeAdvisorPickTimers.get(id);
    if (timer) clearInterval(timer);
    openCodeAdvisorPickTimers.delete(id);
  }

  /**
   * Stamp the advisor's decision onto the permission card. This is separate
   * from the `Once` highlight on purpose: the highlight is a countdown that
   * ends with the apply window (or a human click), while the badge is the
   * durable record that an external model — not the human — picked `allow`.
   * It stays visible even when the human answered first, because the advisor
   * decision and the final decision are different facts.
   *
   * @param {HTMLElement} block
   * @param {string} requestId
   * @param {string} decision
   */
  function markOpenCodePermissionAdvisor(block, requestId, decision) {
    if (!(block instanceof HTMLElement)) return;
    const label = String(decision || '').trim().slice(0, 24) || 'allow';
    let badge = block.querySelector('.sdk-rich-opencode-permission-advisor');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'sdk-rich-badge sdk-rich-badge--ok sdk-rich-opencode-permission-advisor';
      const body = block.querySelector('.sdk-rich-opencode-permission-body');
      if (!body) return;
      body.insertBefore(badge, body.firstChild);
    }
    badge.textContent = t('sdkView.openCodePermissionAdvisorBadge', { decision: label });
    // The id is the correlation key for `data/approvals/approval-audit.jsonl`;
    // it is a server-generated `perm_*` token, never user content.
    const id = String(requestId || '').trim().slice(0, 64);
    if (id) badge.title = t('sdkView.openCodePermissionAdvisorTooltip', { requestId: id });
  }

  /**
   * Stamp who made the final permission decision (advisor / local policy /
   * human) onto the card. Works on resolved cards too: the live card is looked
   * up in the stream by request id, so a history replay can mark it as well.
   *
   * @param {string} requestId
   * @param {Record<string, unknown>} meta
   * @returns {boolean} whether a card was found and marked
   */
  function markOpenCodePermissionDecision(requestId, meta = {}) {
    const id = String(requestId || '').trim().slice(0, 64);
    const decidedBy = String(meta.decidedBy || '').trim();
    if (!id || (decidedBy !== 'advisor' && decidedBy !== 'local' && decidedBy !== 'user')) return false;
    const block = Array.from(rv.stream.querySelectorAll('.sdk-rich-opencode-permission'))
      .find((el) => el instanceof HTMLElement && el.dataset.requestId === id);
    if (!(block instanceof HTMLElement)) return false;
    const body = block.querySelector('.sdk-rich-opencode-permission-body');
    if (!body) return false;
    let chip = block.querySelector('.sdk-rich-opencode-permission-decided-by');
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'sdk-rich-badge sdk-rich-opencode-permission-decided-by';
      body.insertBefore(chip, body.firstChild);
    }
    chip.dataset.decidedBy = decidedBy;
    const percent = Number.isFinite(meta.confidence) ? Math.round(Number(meta.confidence) * 100) : null;
    const latency = Number.isFinite(meta.latencyMs) ? Math.round(Number(meta.latencyMs)) : null;
    const parts = [];
    if (decidedBy === 'advisor') {
      const name = String(meta.advisorName || '').trim() || t('sdkView.openCodePermissionAdvisorDefaultName');
      parts.push(t('sdkView.openCodePermissionDecidedBy.advisor', { name }));
      if (percent != null) parts.push(`${percent}%`);
      if (latency != null) parts.push(`${latency} ms`);
    } else if (decidedBy === 'user' && meta.reply === 'reject') {
      parts.push(t('sdkView.openCodePermissionDecidedBy.userReject'));
    } else {
      parts.push(t(`sdkView.openCodePermissionDecidedBy.${decidedBy}`));
    }
    chip.textContent = parts.join(' · ');
    const tooltip = [];
    if (decidedBy === 'advisor') {
      if (meta.reason) tooltip.push(String(meta.reason));
      if (meta.localReason) tooltip.push(t('sdkView.openCodePermissionDecidedBy.localReason', { reason: String(meta.localReason) }));
      const via = [meta.provider, meta.model].map((v) => String(v || '').trim()).filter(Boolean).join(' / ');
      if (via) tooltip.push(via);
    }
    chip.title = tooltip.join('\n');
    return true;
  }

  /**
   * @param {string} requestId
   * @param {Record<string, unknown>} meta
   */
  function mergeOpenCodePermissionAdvisorMeta(requestId, meta = {}) {
    const id = String(requestId || '').trim();
    if (!id) return null;
    const incomingStatus = String(meta.status || '').trim();
    const prev = openCodePermissionAdvisorMetaByRequestId.get(id);
    const prevStatus = prev ? String(prev.status || '').trim() : '';
    if (prev && incomingStatus && !shouldApplyOpenCodeAdvisorStatus(prevStatus, incomingStatus)) {
      return prev;
    }
    const merged = prev && typeof prev === 'object' ? { ...prev, ...meta } : { ...meta };
    if (incomingStatus) merged.status = incomingStatus;
    openCodePermissionAdvisorMetaByRequestId.set(id, merged);
    trimOpenCodePermissionAdvisorMetaMap();
    return merged;
  }

  function markOpenCodePermissionAdvisorStatus(block, requestId, meta = {}) {
    if (!(block instanceof HTMLElement)) return;
    const merged = mergeOpenCodePermissionAdvisorMeta(requestId, meta);
    if (!merged) return;
    renderOpenCodePermissionAdvisorPanel(block, requestId, merged);
  }

  function clearOpenCodeInteractiveMaps() {
    openCodeQuestionByRequestId.clear();
    openCodePermissionByRequestId.clear();
    openCodePermissionAdvisorMetaByRequestId.clear();
    openCodeResolvedPermissionRequestIds.clear();
    openCodeAdvisorPickTimers.forEach((timer) => clearInterval(timer));
    openCodeAdvisorPickTimers.clear();
  }
}
