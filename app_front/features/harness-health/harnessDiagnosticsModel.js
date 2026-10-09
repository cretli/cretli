/**
 * Settings → Harness: read-only model diagnostics view model and renderer.
 *
 * DOM-free so the unit tests can import it under Node. The caller owns
 * translation: the renderer receives a `t()` function. Nothing here computes a
 * pick — the selected model and candidate order are displayed exactly as
 * `lib/model-diagnostics.js` returned them from the selector.
 */

import { escapeHtml, formatInteger, formatPercent } from '../usage/usageCharts.js';

/** Bound the canonical cohort table so a large history cannot balloon the DOM. */
export const MAX_CANONICAL_COHORTS = 50;

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finite(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value == null ? '' : value);
}

/**
 * Percentage text for a nullable rate: an absent rate is `unknownLabel`, never
 * `0%`.
 *
 * @param {unknown} value
 * @param {string} lang
 * @param {string} unknownLabel
 * @returns {string}
 */
function percentText(value, lang, unknownLabel) {
  const num = finite(value);
  return num == null ? unknownLabel : formatPercent(num, lang);
}

/**
 * Cycle denominators for the canonical view model. All counts are known when
 * the backend returned a cycles block; a missing block stays `null`.
 *
 * @param {object|null} cycles
 * @returns {object|null}
 */
function canonicalCycles(cycles) {
  if (!cycles) return null;
  return {
    closed: finite(cycles.closed_cycles),
    reviewed: finite(cycles.reviewed_cycles),
    accepted: finite(cycles.accepted_by_review),
    manualAccepted: finite(cycles.manual_accepted),
    rejected: finite(cycles.rejected_by_review),
    undecided: finite(cycles.undecided),
    unreviewed: finite(cycles.unreviewed),
    open: finite(cycles.open_cycles),
    acceptedRate: finite(cycles.accepted_rate),
  };
}

/**
 * Cost denominators for the canonical view model. `known` is false when the
 * ledger has no priced event, so the renderer shows the unknown label instead
 * of `$0`.
 *
 * @param {object|null|undefined} cost
 * @returns {object}
 */
function canonicalCost(cost) {
  return {
    known: cost?.known === true,
    usd: finite(cost?.usd),
    effectivePerAccepted: finite(cost?.effective_cost_per_accepted_usd),
    pricedEvents: finite(cost?.priced_events),
    totalEvents: finite(cost?.total_events),
    unknownEvents: finite(cost?.unknown_events),
    subscriptionEvents: finite(cost?.subscription_events),
    truncated: cost?.truncated === true,
  };
}

/**
 * Build the DOM-free view model of the canonical stats block. Every denominator
 * group stays separate; missing values stay `null` so the renderer prints the
 * unknown label.
 *
 * @param {object|null} canonical
 * @param {string} lang
 * @param {string} unknownLabel
 * @returns {object|null}
 */
export function buildCanonicalViewModel(canonical, lang = 'en', unknownLabel = 'unknown') {
  if (!canonical || typeof canonical !== 'object') return null;
  const window = canonical.window && typeof canonical.window === 'object' ? canonical.window : {};
  const versions = canonical.versions && typeof canonical.versions === 'object' ? canonical.versions : {};
  const allCohorts = Array.isArray(canonical.cohorts) ? canonical.cohorts : [];
  const shown = allCohorts.slice(0, MAX_CANONICAL_COHORTS);
  const total = finite(canonical.cohorts_total) ?? allCohorts.length;
  return {
    contractVersion: text(canonical.contract_version),
    displayOnly: canonical.display_only === true,
    affectsRanking: canonical.affects_ranking === true,
    policyVersion: text(versions.policy_version),
    // The contract's current protocol; a cohort carries its own recorded value.
    reviewProtocolVersion: text(versions.review_protocol_version),
    windowMs: finite(window.window_ms),
    windowFrom: text(window.from),
    windowTo: text(window.to),
    totals: {
      cycles: canonicalCycles(canonical.totals?.cycles),
      cost: canonicalCost(canonical.totals?.cost),
    },
    notMeasured: Array.isArray(canonical.unknowns?.not_measured)
      ? canonical.unknowns.not_measured.map(text)
      : [],
    missingFields: Array.isArray(canonical.missing_fields) ? canonical.missing_fields.map(text) : [],
    truncated: canonical.cohorts_truncated === true || allCohorts.length > shown.length,
    total,
    cohorts: shown.map((row) => ({
      key: text(row.cohort_key),
      role: text(row.role),
      harness: text(row.harness),
      baseModel: text(row.base_model),
      sharesImplement: row.shares_implement_aggregate === true,
      recordedReviewProtocol: row.versions?.review_protocol_version == null
        ? null
        : text(row.versions.review_protocol_version),
      jobs: row.jobs
        ? {
          terminal: finite(row.jobs.terminal_jobs),
          nonInfra: finite(row.jobs.non_infra_jobs),
          infraFails: finite(row.jobs.infra_fails),
          infraRateText: percentText(row.jobs.infra_fail_rate, lang, unknownLabel),
          decided: finite(row.jobs.decided),
          passRateText: percentText(row.jobs.pass_rate, lang, unknownLabel),
        }
        : null,
      cycles: canonicalCycles(row.cycles),
      cost: canonicalCost(row.cost),
      latency: {
        durationN: finite(row.latency?.duration?.sample_n),
        medianMin: finite(row.latency?.duration?.median_min),
        p95Min: finite(row.latency?.duration?.p95_min),
        tokensN: finite(row.latency?.tokens_per_sec?.sample_n),
        tokensMedian: finite(row.latency?.tokens_per_sec?.median),
        toolsN: finite(row.latency?.tool_calls?.sample_n),
        toolsMedian: finite(row.latency?.tool_calls?.median),
        filesN: finite(row.latency?.files_changed?.sample_n),
        filesMedian: finite(row.latency?.files_changed?.median),
      },
      uncertainty: {
        n: finite(row.uncertainty?.n),
        priorText: percentText(row.uncertainty?.prior?.infra_fail_rate, lang, unknownLabel),
        weightText: finite(row.uncertainty?.shrink?.weight) == null
          ? unknownLabel
          : Number(row.uncertainty.shrink.weight).toFixed(2),
        lowSample: row.uncertainty?.low_sample === true,
        displayOnly: row.uncertainty?.display_only === true,
        affectsRanking: row.uncertainty?.affects_ranking === true,
      },
      missingFields: Array.isArray(row.missing_fields) ? row.missing_fields.map(text) : [],
    })),
  };
}

/**
 * @param {number|null} usd
 * @param {string} lang
 * @param {string} unknownLabel
 * @returns {string}
 */
function formatUsd(usd, lang, unknownLabel) {
  if (usd == null) return unknownLabel;
  const locale = lang === 'pl' ? 'pl-PL' : 'en-US';
  return `$${usd.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

/**
 * @param {object|null} cost
 * @param {string} lang
 * @param {string} unknownLabel
 * @returns {string}
 */
function costText(cost, lang, unknownLabel) {
  if (!cost || cost.known !== true) return unknownLabel;
  const usd = formatUsd(finite(cost.usd), lang, unknownLabel);
  const estimated = finite(cost.estimatedUsd);
  if (estimated != null && estimated > 0) return `${usd} (+${formatUsd(estimated, lang, unknownLabel)} est.)`;
  return usd;
}

/**
 * @param {object} report
 * @param {string} lang
 * @param {string} unknownLabel
 * @returns {object}
 */
export function buildDiagnosticsViewModel(report, lang = 'en', unknownLabel = 'unknown') {
  const config = report?.config || null;
  const alerts = [];
  if (config?.state === 'missing') alerts.push({ tone: 'warning', key: 'configMissing' });
  if (config?.state === 'invalid') alerts.push({ tone: 'error', key: 'configInvalid', detail: text(config.error) });

  const selectionRows = Array.isArray(report?.selection?.candidates) ? report.selection.candidates : [];
  const pick = report?.selection?.pick || null;
  const candidates = selectionRows.map((row, index) => ({
    index,
    key: `${text(row.harness)}/${text(row.model)}`,
    score: finite(row.score),
    scoreText: finite(row.score) == null ? unknownLabel : Number(row.score).toFixed(3),
    inBand: row.in_band === true,
    selected: pick != null && row.harness === pick.harness && row.model === pick.model,
    reason: text(row.reason),
    // A hard filter reason is never mixed with a score penalty or an
    // out-of-band position: the three are shown separately.
    filterReasons: Array.isArray(row.filter_reasons) ? row.filter_reasons.map(text) : [],
    penalties: Array.isArray(row.penalties) ? row.penalties.map(text) : [],
    outOfBand: row.explore_out_of_band === true,
    keepWinner: row.keep_winner === true,
    rankingNote: text(row.ranking_note),
    eligible: row.eligible !== false,
    technical: {
      score: finite(row.score),
      heuristic_score: finite(row.heuristic_score),
      rotation_score: finite(row.rotation_score),
      cost_tier: finite(row.cost_tier),
      quality_tier: finite(row.quality_tier),
      speed_tier: finite(row.speed_tier),
      plan_limit_penalty: finite(row.plan_limit_penalty),
      observed_penalty: finite(row.observed_penalty),
      high_infra_risk: row.high_infra_risk === true,
    },
  }));

  const models = (Array.isArray(report?.models) ? report.models : []).map((row) => {
    const reasons = Array.isArray(row?.eligibility?.reasons) ? row.eligibility.reasons : [];
    const matchers = row?.role_matchers && typeof row.role_matchers === 'object' ? row.role_matchers : {};
    const roleSources = [];
    for (const [role, value] of Object.entries(matchers)) {
      if (value?.eligible !== true) continue;
      const sources = [...new Set((value.matched || [])
        .filter((rule) => rule.deny !== true)
        .map((rule) => `${rule.pattern}:${rule.source}`))];
      roleSources.push(`${role}${sources.length ? ` (${sources.join(', ')})` : ''}`);
    }
    const stats = row?.stats?.by_role?.implement || row?.stats?.by_role?.[report?.role] || null;
    return {
      key: `${text(row.harness)}/${text(row.model)}`,
      harness: text(row.harness),
      model: text(row.model),
      label: text(row.label || row.model),
      favorite: row.favorite === true,
      enabled: row.enabled === true,
      available: row?.availability?.available !== false,
      usageLimited: row?.availability?.usage_limited === true,
      lockedOut: row?.availability?.locked_out === true,
      eligible: row?.eligibility?.eligible === true,
      reasons: reasons.map(text),
      reasonsText: reasons.length ? reasons.join(', ') : '',
      penalties: Array.isArray(row?.eligibility?.penalties) ? row.eligibility.penalties.map(text) : [],
      rolesText: roleSources.join(' · '),
      lastUseText: row?.last_use?.unknown === true ? unknownLabel : text(row?.last_use?.at),
      lastUseSource: text(row?.last_use?.source),
      lastUseAgeMs: finite(row?.last_use?.age_ms),
      availabilityKnownAt: row?.availability?.last_known_at || '',
      availabilityKnownSource: text(row?.availability?.last_known_source),
      costText: costText(row?.cost, lang, unknownLabel),
      qualityText: stats?.quality?.pass_rate == null
        ? unknownLabel
        : formatPercent(stats.quality.pass_rate, lang),
      reliabilityText: stats?.reliability?.infra_fail_rate == null
        ? unknownLabel
        : formatPercent(stats.reliability.infra_fail_rate, lang),
      sampleText: stats?.sample ? `${formatInteger(stats.sample.n, lang)}/${formatInteger(stats.sample.decided, lang)}` : unknownLabel,
      lowSample: stats?.sample?.low_sample === true,
    };
  });

  const cohorts = (Array.isArray(report?.stats?.cohorts) ? report.stats.cohorts : []).map((row) => ({
    key: `${text(row.role)}:${text(row.harness)}/${text(row.model)}`,
    role: text(row.role),
    harness: text(row.harness),
    model: text(row.model),
    n: finite(row?.sample?.n) ?? 0,
    decided: finite(row?.sample?.decided) ?? 0,
    lowSample: row?.sample?.low_sample === true,
    qualityText: row?.quality?.pass_rate == null ? unknownLabel : formatPercent(row.quality.pass_rate, lang),
    reliabilityText: row?.reliability?.infra_fail_rate == null
      ? unknownLabel
      : formatPercent(row.reliability.infra_fail_rate, lang),
    timesText: row?.times?.median_min == null
      ? unknownLabel
      : `${formatInteger(Math.round(row.times.median_min), lang)} / ${row.times.p95_min == null ? unknownLabel : formatInteger(Math.round(row.times.p95_min), lang)} min`,
    costText: costText(row?.cost, lang, unknownLabel),
  }));

  return {
    role: text(report?.role),
    policyVersion: text(report?.policy_version),
    eligibilityCohort: text(report?.eligibility_cohort),
    generatedAt: text(report?.generated_at),
    config,
    alerts,
    selection: {
      ok: report?.selection?.ok === true,
      error: text(report?.selection?.error),
      pickKey: pick ? `${text(pick.harness)}/${text(pick.model)}` : '',
      pickReason: text(pick?.reason),
      rotation: report?.selection?.rotation || null,
      candidates,
      // The last persisted proposal explains how an actually started executor
      // was linked (originDetail), including the legacy / unknown-link case.
      persisted: report?.persisted
        ? {
          pickId: text(report.persisted.pick_id),
          policyVersion: text(report.persisted.policy_version),
          role: text(report.persisted.role),
          createdAt: text(report.persisted.created_at),
          picks: (Array.isArray(report.persisted.picks) ? report.persisted.picks : []).map((row) => ({
            key: `${text(row.harness)}/${text(row.model)}`,
            originDetail: text(row.originDetailHint || row.origin_detail_hint),
            selectionSlot: finite(row.selectionSlot ?? row.selection_slot),
          })),
        }
        : null,
    },
    models,
    cohorts,
    canonical: buildCanonicalViewModel(report?.stats?.canonical, lang, unknownLabel),
    usageLink: report?.stats?.usage_link || { settings_tab: 'usage', group_by: 'harness' },
    unknowns: Array.isArray(report?.unknowns) ? report.unknowns.map(text) : [],
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function h(value) {
  return escapeHtml(text(value));
}

/**
 * @param {number|null} value
 * @param {string} unknownLabel
 * @returns {string}
 */
function cellCount(value, unknownLabel) {
  return value == null ? unknownLabel : formatInteger(value, 'en');
}

/**
 * @param {number|null} value
 * @param {string} unknownLabel
 * @returns {string}
 */
function cellNumber(value, unknownLabel) {
  return value == null ? unknownLabel : String(value);
}

/**
 * @param {number|null} usd
 * @param {string} unknownLabel
 * @returns {string}
 */
function cellUsd(usd, unknownLabel) {
  return usd == null ? unknownLabel : `$${Number(usd).toFixed(2)}`;
}

/**
 * Read-only canonical stats section: window/version metadata, the global cycle
 * and cost denominators, then one row per cohort with the four denominator
 * groups kept apart and the uncertainty notes attached.
 *
 * @param {object} canonical
 * @param {(key: string, values?: object) => string} t
 * @returns {string}
 */
function renderCanonicalHtml(canonical, t) {
  const unknown = t('harnessDiagnostics.unknown');
  const parts = [];
  parts.push('<h4 class="harness-diagnostics-heading">'
    + h(t('harnessDiagnostics.canonicalHeading'))
    + '</h4>');
  parts.push(`<p class="harness-diagnostics-hint">${h(t('harnessDiagnostics.canonicalHint'))}</p>`);
  parts.push('<div class="harness-diagnostics-meta">'
    + `<span class="harness-diagnostics-badge">${h(t('harnessDiagnostics.canonicalDisplayOnly'))}</span>`
    + `<span class="harness-diagnostics-badge">${h(t('harnessDiagnostics.canonicalWindowBadge', {
      from: canonical.windowFrom || unknown,
      to: canonical.windowTo || unknown,
    }))}</span>`
    + `<span class="harness-diagnostics-badge">${h(t('harnessDiagnostics.canonicalVersionsBadge', {
      policy: canonical.policyVersion || unknown,
      protocol: canonical.reviewProtocolVersion || unknown,
    }))}</span>`
    + (canonical.missingFields.includes('review_protocol_version')
      ? `<span class="harness-diagnostics-badge" data-tone="warning">${h(t('harnessDiagnostics.canonicalReviewProtocolUnknown'))}</span>`
      : '')
    + '</div>');

  const cycles = canonical.totals?.cycles;
  if (cycles) {
    parts.push(`<p class="harness-diagnostics-canonical-totals">${h(t('harnessDiagnostics.canonicalCyclesTotals', {
      closed: cellCount(cycles.closed, unknown),
      reviewed: cellCount(cycles.reviewed, unknown),
      accepted: cellCount(cycles.accepted, unknown),
      manual: cellCount(cycles.manualAccepted, unknown),
      rejected: cellCount(cycles.rejected, unknown),
      undecided: cellCount(cycles.undecided, unknown),
      unreviewed: cellCount(cycles.unreviewed, unknown),
      open: cellCount(cycles.open, unknown),
    }))}</p>`);
  }
  const cost = canonical.totals?.cost;
  if (cost) {
    parts.push(`<p class="harness-diagnostics-canonical-totals">${h(t('harnessDiagnostics.canonicalCostTotals', {
      priced: cellCount(cost.pricedEvents, unknown),
      total: cellCount(cost.totalEvents, unknown),
      usd: cost.known ? cellUsd(cost.usd, unknown) : unknown,
      perAccepted: cost.known ? cellUsd(cost.effectivePerAccepted, unknown) : unknown,
    }))}</p>`);
  }

  parts.push('<h4 class="harness-diagnostics-heading">'
    + h(t('harnessDiagnostics.canonicalCohortsHeading'))
    + '</h4>');
  if (canonical.cohorts.length === 0) {
    parts.push(`<p class="harness-diagnostics-empty">${h(t('harnessDiagnostics.canonicalNoCohorts'))}</p>`);
  } else {
    parts.push('<div class="harness-diagnostics-table-wrap"><table class="harness-diagnostics-table">');
    parts.push('<thead><tr>'
      + `<th>${h(t('harnessDiagnostics.canonicalColCohort'))}</th>`
      + `<th>${h(t('harnessDiagnostics.canonicalColJobs'))}</th>`
      + `<th>${h(t('harnessDiagnostics.canonicalColCycles'))}</th>`
      + `<th>${h(t('harnessDiagnostics.canonicalColCost'))}</th>`
      + `<th>${h(t('harnessDiagnostics.canonicalColLatency'))}</th>`
      + `<th>${h(t('harnessDiagnostics.canonicalColUncertainty'))}</th>`
      + '</tr></thead><tbody>');
    for (const row of canonical.cohorts) {
      const jobs = row.jobs
        ? t('harnessDiagnostics.canonicalJobsCell', {
          terminal: cellCount(row.jobs.terminal, unknown),
          nonInfra: cellCount(row.jobs.nonInfra, unknown),
          infra: cellCount(row.jobs.infraFails, unknown),
          decided: cellCount(row.jobs.decided, unknown),
          pass: row.jobs.passRateText,
        })
        : unknown;
      const cycleCell = row.cycles
        ? t('harnessDiagnostics.canonicalCyclesCell', {
          closed: cellCount(row.cycles.closed, unknown),
          reviewed: cellCount(row.cycles.reviewed, unknown),
          accepted: cellCount(row.cycles.accepted, unknown),
          manual: cellCount(row.cycles.manualAccepted, unknown),
          rejected: cellCount(row.cycles.rejected, unknown),
          undecided: cellCount(row.cycles.undecided, unknown),
          unreviewed: cellCount(row.cycles.unreviewed, unknown),
          open: cellCount(row.cycles.open, unknown),
        })
        : unknown;
      const costCell = row.cost.known
        ? t('harnessDiagnostics.canonicalCostCell', {
          usd: cellUsd(row.cost.usd, unknown),
          perAccepted: cellUsd(row.cost.effectivePerAccepted, unknown),
        })
        : t('harnessDiagnostics.canonicalCostUnknown');
      const latencyCell = t('harnessDiagnostics.canonicalLatencyCell', {
        median: cellNumber(row.latency.medianMin, unknown),
        p95: cellNumber(row.latency.p95Min, unknown),
        durationN: cellCount(row.latency.durationN, unknown),
        tokens: cellNumber(row.latency.tokensMedian, unknown),
        tokensN: cellCount(row.latency.tokensN, unknown),
        tools: cellNumber(row.latency.toolsMedian, unknown),
        toolsN: cellCount(row.latency.toolsN, unknown),
        files: cellNumber(row.latency.filesMedian, unknown),
        filesN: cellCount(row.latency.filesN, unknown),
      });
      const uncertaintyCell = t('harnessDiagnostics.canonicalUncertaintyCell', {
        n: cellCount(row.uncertainty.n, unknown),
        prior: row.uncertainty.priorText,
        weight: row.uncertainty.weightText,
      }) + (row.uncertainty.lowSample
        ? ` <span class="harness-diagnostics-badge" data-tone="warning">${h(t('harnessDiagnostics.canonicalLowSample'))}</span>`
        : '');
      parts.push('<tr>'
        + `<td>${h(row.key)}</td>`
        + `<td>${h(jobs)}</td>`
        + `<td>${h(cycleCell)}</td>`
        + `<td>${h(costCell)}</td>`
        + `<td>${h(latencyCell)}</td>`
        + `<td>${h(uncertaintyCell)}${row.missingFields.length ? ` <span class="harness-diagnostics-sub">${h(t('harnessDiagnostics.canonicalMissing', { fields: row.missingFields.join(', ') }))}</span>` : ''}</td>`
        + '</tr>');
    }
    parts.push('</tbody></table></div>');
    if (canonical.truncated) {
      parts.push(`<p class="harness-diagnostics-sub">${h(t('harnessDiagnostics.canonicalTruncated', {
        shown: cellCount(canonical.cohorts.length, unknown),
        total: cellCount(canonical.total, unknown),
      }))}</p>`);
    }
  }
  if (canonical.notMeasured.length > 0) {
    parts.push(`<p class="harness-diagnostics-sub">${h(t('harnessDiagnostics.canonicalNotMeasured', {
      fields: canonical.notMeasured.join(', '),
    }))}</p>`);
  }
  return parts.join('');
}

/**
 * @param {object} model
 * @param {(key: string, values?: object) => string} t
 * @returns {string}
 */
export function renderDiagnosticsHtml(model, t) {
  const parts = [];
  parts.push('<div class="harness-diagnostics">');
  parts.push('<div class="harness-diagnostics-meta">'
    + `<span class="harness-diagnostics-badge">${h(t('harnessDiagnostics.roleBadge', { role: model.role }))}</span>`
    + `<span class="harness-diagnostics-badge">${h(t('harnessDiagnostics.policyBadge', { version: model.policyVersion }))}</span>`
    + `<span class="harness-diagnostics-badge">${h(t('harnessDiagnostics.cohortBadge', { cohort: model.eligibilityCohort }))}</span>`
    + `<span class="harness-diagnostics-badge" data-tone="${h(model.config?.state || 'missing')}">${h(t('harnessDiagnostics.configBadge', { state: model.config?.state || 'missing' }))}</span>`
    + '</div>');

  for (const alert of model.alerts) {
    const detail = alert.detail ? ` — ${h(alert.detail)}` : '';
    parts.push(`<p class="harness-diagnostics-alert" data-tone="${h(alert.tone)}">${h(t(`harnessDiagnostics.${alert.key}`))}${detail}</p>`);
  }

  parts.push('<h4 class="harness-diagnostics-heading">'
    + h(t('harnessDiagnostics.selectionHeading'))
    + '</h4>');
  if (!model.selection.ok) {
    parts.push(`<p class="harness-diagnostics-alert" data-tone="error">${h(model.selection.error || t('harnessDiagnostics.selectionNone'))}</p>`);
  } else {
    parts.push('<ol class="harness-diagnostics-candidates">');
    for (const row of model.selection.candidates) {
      const bits = [
        `<span class="harness-diagnostics-candidate-key">${h(row.key)}</span>`,
        `<span class="harness-diagnostics-candidate-score">${h(t('harnessDiagnostics.score', { score: row.scoreText }))}</span>`,
      ];
      if (row.selected) bits.push(`<span class="harness-diagnostics-badge" data-tone="selected">${h(t('harnessDiagnostics.selected'))}</span>`);
      if (row.inBand) bits.push(`<span class="harness-diagnostics-badge">${h(t('harnessDiagnostics.inBand'))}</span>`);
      if (row.outOfBand) bits.push(`<span class="harness-diagnostics-badge" data-tone="warning">${h(t('harnessDiagnostics.outOfBand'))}</span>`);
      if (row.keepWinner) bits.push(`<span class="harness-diagnostics-badge">${h(t('harnessDiagnostics.keepWinner'))}</span>`);
      for (const reason of row.filterReasons) {
        bits.push(`<span class="harness-diagnostics-badge" data-tone="error">${h(t('harnessDiagnostics.filterReason', { reason }))}</span>`);
      }
      for (const penalty of row.penalties) {
        bits.push(`<span class="harness-diagnostics-badge" data-tone="warning">${h(t('harnessDiagnostics.penalty', { reason: penalty }))}</span>`);
      }
      parts.push(`<li>${bits.join(' ')}<span class="harness-diagnostics-candidate-reason">${h(row.reason)}</span>`);
      parts.push(`<details class="harness-diagnostics-technical"><summary>${h(t('harnessDiagnostics.technical'))}</summary><dl>`);
      parts.push(`<div><dt>${h(t('harnessDiagnostics.colEligibility'))}</dt><dd>${h(row.eligible ? t('harnessDiagnostics.eligible') : (row.filterReasons.join(', ') || t('harnessDiagnostics.notEligible')))}</dd></div>`);
      if (row.penalties.length) parts.push(`<div><dt>${h(t('harnessDiagnostics.penaltiesLabel'))}</dt><dd>${h(row.penalties.join(', '))}</dd></div>`);
      if (row.rankingNote) parts.push(`<div><dt>${h(t('harnessDiagnostics.rankingNote'))}</dt><dd>${h(row.rankingNote)}</dd></div>`);
      parts.push(`<div><dt>${h(t('harnessDiagnostics.technicalTiers'))}</dt><dd>${h(`cost ${row.technical.cost_tier ?? '—'} · quality ${row.technical.quality_tier ?? '—'} · speed ${row.technical.speed_tier ?? '—'}`)}</dd></div>`);
      parts.push('</dl></details></li>');
    }
    parts.push('</ol>');
    if (model.selection.pickReason) {
      parts.push(`<p class="harness-diagnostics-pick-reason">${h(model.selection.pickReason)}</p>`);
    }
    if (model.selection.persisted) {
      const persisted = model.selection.persisted;
      const originBits = persisted.picks.length
        ? persisted.picks.map((row) => `${row.key}: ${row.originDetail || t('harnessDiagnostics.originUnknown')}`).join(' · ')
        : t('harnessDiagnostics.originUnknown');
      parts.push(`<p class="harness-diagnostics-persisted">${h(t('harnessDiagnostics.persisted', {
        pickId: persisted.pickId || '—',
        role: persisted.role || '—',
        origin: originBits,
      }))}</p>`);
    }
  }

  parts.push('<h4 class="harness-diagnostics-heading">'
    + h(t('harnessDiagnostics.modelsHeading'))
    + '</h4>');
  parts.push('<div class="harness-diagnostics-table-wrap"><table class="harness-diagnostics-table">');
  parts.push('<thead><tr>'
    + `<th>${h(t('harnessDiagnostics.colModel'))}</th>`
    + `<th>${h(t('harnessDiagnostics.colState'))}</th>`
    + `<th>${h(t('harnessDiagnostics.colRoles'))}</th>`
    + `<th>${h(t('harnessDiagnostics.colEligibility'))}</th>`
    + `<th>${h(t('harnessDiagnostics.colStats'))}</th>`
    + `<th>${h(t('harnessDiagnostics.colLastUse'))}</th>`
    + `<th>${h(t('harnessDiagnostics.colCost'))}</th>`
    + '</tr></thead><tbody>');
  for (const row of model.models) {
    const state = [
      row.favorite ? t('harnessDiagnostics.favorite') : t('harnessDiagnostics.notFavorite'),
      row.enabled ? t('harnessDiagnostics.enabled') : t('harnessDiagnostics.disabled'),
      row.available ? '' : t('harnessDiagnostics.unavailable'),
      row.usageLimited ? t('harnessDiagnostics.usageLimited') : '',
      row.lockedOut ? t('harnessDiagnostics.lockedOut') : '',
    ].filter(Boolean).join(' · ');
    const reasons = row.eligible
      ? `<span class="harness-diagnostics-ok">${h(t('harnessDiagnostics.eligible'))}</span>`
      : `<span class="harness-diagnostics-reject">${h(row.reasonsText || t('harnessDiagnostics.notEligible'))}</span>`;
    // A penalty (or an out-of-band position) never removes a model; it is shown
    // as a separate warning, not as a filter reason.
    const penalties = row.penalties.length
      ? ` <span class="harness-diagnostics-badge" data-tone="warning">${h(t('harnessDiagnostics.penalty', { reason: row.penalties.join(', ') }))}</span>`
      : '';
    const lastUse = row.lastUseAgeMs == null
      ? h(row.lastUseText)
      : `${h(row.lastUseText)} <span class="harness-diagnostics-sub">${h(t('harnessDiagnostics.ageHours', { hours: formatInteger(Math.round(row.lastUseAgeMs / 3_600_000), 'en') }))}</span>`;
    const source = row.lastUseSource
      ? ` <span class="harness-diagnostics-sub">${h(t('harnessDiagnostics.sourceLabel', { source: row.lastUseSource }))}</span>`
      : '';
    parts.push('<tr>'
      + `<td><strong>${h(row.label)}</strong><span class="harness-diagnostics-sub">${h(row.key)}</span></td>`
      + `<td>${h(state)}</td>`
      + `<td>${h(row.rolesText)}</td>`
      + `<td>${reasons}${penalties}</td>`
      + `<td>${h(row.qualityText)} / ${h(row.reliabilityText)} <span class="harness-diagnostics-sub">(${h(row.sampleText)})</span>${row.lowSample ? ` <span class="harness-diagnostics-badge" data-tone="warning">${h(t('harnessDiagnostics.lowSample'))}</span>` : ''}</td>`
      + `<td>${lastUse}${source}</td>`
      + `<td>${h(row.costText)}</td>`
      + '</tr>');
  }
  parts.push('</tbody></table></div>');

  parts.push('<h4 class="harness-diagnostics-heading">'
    + h(t('harnessDiagnostics.cohortsHeading'))
    + '</h4>');
  if (model.cohorts.length === 0) {
    parts.push(`<p class="harness-diagnostics-empty">${h(t('harnessDiagnostics.noCohorts'))}</p>`);
  } else {
    parts.push('<div class="harness-diagnostics-table-wrap"><table class="harness-diagnostics-table">');
    parts.push('<thead><tr>'
      + `<th>${h(t('harnessDiagnostics.colRole'))}</th>`
      + `<th>${h(t('harnessDiagnostics.colModel'))}</th>`
      + `<th>${h(t('harnessDiagnostics.colRuns'))}</th>`
      + `<th>${h(t('harnessDiagnostics.colCycles'))}</th>`
      + `<th>${h(t('harnessDiagnostics.colQuality'))}</th>`
      + `<th>${h(t('harnessDiagnostics.colReliability'))}</th>`
      + `<th>${h(t('harnessDiagnostics.colTimes'))}</th>`
      + `<th>${h(t('harnessDiagnostics.colCost'))}</th>`
      + '</tr></thead><tbody>');
    for (const row of model.cohorts) {
      parts.push('<tr>'
        + `<td>${h(row.role)}</td>`
        + `<td>${h(`${row.harness}/${row.model}`)}</td>`
        + `<td>${h(formatInteger(row.n, 'en'))}</td>`
        + `<td>${h(formatInteger(row.decided, 'en'))}</td>`
        + `<td>${h(row.qualityText)}</td>`
        + `<td>${h(row.reliabilityText)}</td>`
        + `<td>${h(row.timesText)}</td>`
        + `<td>${h(row.costText)}</td>`
        + '</tr>');
    }
    parts.push('</tbody></table></div>');
  }

  if (model.canonical) {
    parts.push(renderCanonicalHtml(model.canonical, t));
  }

  if (model.unknowns.length > 0) {
    parts.push('<h4 class="harness-diagnostics-heading">'
      + h(t('harnessDiagnostics.unknownsHeading'))
      + '</h4>');
    parts.push('<ul class="harness-diagnostics-unknowns">');
    for (const line of model.unknowns) parts.push(`<li>${h(line)}</li>`);
    parts.push('</ul>');
  }

  parts.push(`<div class="harness-diagnostics-actions">`
    + `<button type="button" class="harness-diagnostics-usage-link" data-action="details">${h(t('harnessDiagnostics.openUsage'))}</button>`
    + '</div>');
  parts.push('</div>');
  return parts.join('');
}
