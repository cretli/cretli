/**
 * Pure view model for Settings → Harness benchmark sources (display-only).
 */

/**
 * @param {string} value
 * @returns {string}
 */
function h(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {boolean} value
 * @param {(key: string) => string} t
 * @returns {string}
 */
function yesNo(value, t) {
  return value ? t('harnessBenchmarkSources.yes') : t('harnessBenchmarkSources.no');
}

/**
 * @param {string} prefix
 * @param {string} code
 * @param {(key: string) => string} t
 * @returns {string}
 */
function enumLabel(prefix, code, t) {
  const key = `${prefix}.${code}`;
  const label = t(key);
  return label === key ? code : label;
}

/**
 * @param {object|null} payload GET /api/harness-benchmark-sources
 * @param {(key: string, values?: object) => string} t
 * @returns {object}
 */
export function buildHarnessBenchmarkSourcesViewModel(payload, t) {
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  return {
    state: String(payload?.state || 'missing'),
    storeError: String(payload?.error || '').trim(),
    etag: String(payload?.etag || ''),
    localMode: payload?.localMode || { fetchEnabled: false, outgoingMetadata: 'none' },
    sources: sources.map((row) => ({
      id: String(row.id || ''),
      provider: String(row.provider || ''),
      officialTermsUrl: String(row.officialTermsUrl || ''),
      endpointPurpose: String(row.endpointPurpose || ''),
      enabled: Boolean(row.enabled),
      health: String(row.health || 'unknown'),
      networkAttemptStatus: String(row.networkAttemptStatus || row.localMode?.networkAttemptStatus || 'unknown'),
      outgoingMetadata: String(row.outgoingMetadata || 'none'),
      keyRequired: Boolean(row.keyRequired),
      pricingNote: String(row.pricingNote || ''),
      cacheTtlDays: Math.round((Number(row.cacheTtlMs) || 0) / (24 * 60 * 60 * 1000)),
      lastAttemptAt: row.lastAttemptAt ? String(row.lastAttemptAt) : null,
      lastSuccessAt: row.lastSuccessAt ? String(row.lastSuccessAt) : null,
      termsVerification: row.termsVerification || null,
      latestSnapshot: row.latestSnapshot || null,
    })),
    unknownTopLevelKeys: Array.isArray(payload?.unknownTopLevelKeys) ? payload.unknownTopLevelKeys : [],
  };
}

/**
 * @param {object} model
 * @param {(key: string, values?: object) => string} t
 * @returns {string}
 */
export function renderHarnessBenchmarkSourcesHtml(model, t) {
  const parts = ['<div class="harness-benchmark-sources">'];
  parts.push(`<p class="harness-model-role-hint">${h(t('harnessBenchmarkSources.localMode'))}</p>`);
  if (model.state === 'invalid') {
    parts.push(`<p class="harness-benchmark-store-invalid" data-tone="error">${h(t('harnessBenchmarkSources.storeInvalid'))}${model.storeError ? `: ${h(model.storeError)}` : ''}</p>`);
  }
  if (model.unknownTopLevelKeys.length) {
    parts.push(`<p class="harness-model-role-hint">${h(t('harnessModelRole.unknownKeys', { keys: model.unknownTopLevelKeys.join(', ') }))}</p>`);
  }
  for (const source of model.sources) {
    parts.push('<article class="cr-card harness-benchmark-source-card">');
    parts.push(`<h4>${h(source.provider)} <span class="harness-model-role-sub">(${h(source.id)})</span></h4>`);
    parts.push(`<p class="harness-model-role-hint">${h(source.endpointPurpose)}</p>`);
    parts.push('<dl class="harness-benchmark-meta">');
    parts.push(`<dt>${h(t('harnessBenchmarkSources.termsUrl'))}</dt><dd><a href="${h(source.officialTermsUrl)}" target="_blank" rel="noopener noreferrer">${h(source.officialTermsUrl)}</a></dd>`);
    parts.push(`<dt>${h(t('harnessBenchmarkSources.outgoingMetadataLabel'))}</dt><dd>${h(enumLabel('harnessBenchmarkSources.outgoingMetadata', source.outgoingMetadata, t))}</dd>`);
    parts.push(`<dt>${h(t('harnessBenchmarkSources.keyRequired'))}</dt><dd>${h(yesNo(source.keyRequired, t))}</dd>`);
    parts.push(`<dt>${h(t('harnessBenchmarkSources.pricing'))}</dt><dd>${h(source.pricingNote)}</dd>`);
    parts.push(`<dt>${h(t('harnessBenchmarkSources.cacheTtl'))}</dt><dd>${h(String(source.cacheTtlDays))}</dd>`);
    parts.push(`<dt>${h(t('harnessBenchmarkSources.enabled'))}</dt><dd>${h(yesNo(source.enabled, t))}</dd>`);
    parts.push(`<dt>${h(t('harnessBenchmarkSources.healthLabel'))}</dt><dd>${h(enumLabel('harnessBenchmarkSources.health', source.health, t))}</dd>`);
    if (source.lastAttemptAt) {
      parts.push(`<dt>${h(t('harnessBenchmarkSources.lastAttempt'))}</dt><dd>${h(source.lastAttemptAt)}</dd>`);
    }
    if (source.lastSuccessAt) {
      parts.push(`<dt>${h(t('harnessBenchmarkSources.lastSuccess'))}</dt><dd>${h(source.lastSuccessAt)}</dd>`);
    }
    parts.push('</dl>');
    if (source.termsVerification) {
      const terms = source.termsVerification;
      parts.push(`<p class="harness-model-role-hint">${h(t('harnessBenchmarkSources.termsVerified'))}: ${h(terms.verifiedAt)} · ${h(t('harnessBenchmarkSources.termsVersion'))}: ${h(terms.version || '—')}</p>`);
      parts.push(`<p class="harness-model-role-hint">${h(t('harnessBenchmarkSources.verifiedTermsUrl'))}: ${h(terms.officialTermsUrl)}</p>`);
      parts.push(`<p class="harness-model-role-hint">${h(t('harnessBenchmarkSources.licenseScope'))}: ${h(terms.scopeOfConsent)}</p>`);
      if (terms.licenseNotes) {
        parts.push(`<p class="harness-model-role-hint">${h(t('harnessBenchmarkSources.licenseNotes'))}: ${h(terms.licenseNotes)}</p>`);
      }
      parts.push(`<p class="harness-model-role-hint">${h(t('harnessBenchmarkSources.redistributionAllowed'))}: ${h(yesNo(terms.redistributionAllowed === true, t))}</p>`);
      if (terms.attributionRequired) {
        parts.push(`<p class="harness-model-role-hint">${h(t('harnessBenchmarkSources.attribution'))}</p>`);
      }
    } else if (source.id !== 'local-fixture') {
      parts.push(`<p class="harness-model-role-hint" data-tone="error">${h(t('harnessBenchmarkSources.termsMissing'))}</p>`);
    }
    const snap = source.latestSnapshot;
    if (snap) {
      const stale = snap.freshness?.stale === true;
      parts.push(`<p class="harness-model-role-hint">${h(stale ? t('harnessBenchmarkSources.freshnessStale') : t('harnessBenchmarkSources.freshnessFresh'))} · ${h(t('harnessBenchmarkSources.entryCount', { count: snap.payload?.entries?.length ?? 0 }))}</p>`);
      const kindCode = String(snap.kind || 'real');
      parts.push(`<p class="harness-model-role-sub">${h(t('harnessBenchmarkSources.snapshotKindLabel'))}: ${h(enumLabel('harnessBenchmarkSources.snapshotKind', kindCode, t))} · ${h(t('harnessBenchmarkSources.capturedAt'))}: ${h(snap.capturedAt)} · ${h(t('harnessBenchmarkSources.importedAt'))}: ${h(snap.importedAt)}</p>`);
      if (snap.mappingSummary) {
        parts.push(`<p class="harness-model-role-sub">${h(t('harnessBenchmarkSources.mappingSummary', snap.mappingSummary))}</p>`);
      }
    } else {
      parts.push(`<p class="harness-model-role-hint">${h(t('harnessBenchmarkSources.noSnapshot'))}</p>`);
    }
    if (source.id === 'local-fixture') {
      parts.push(`<cr-bar-button type="button" data-benchmark-import="${h(source.id)}">${h(t('harnessBenchmarkSources.importFixture'))}</cr-bar-button>`);
    }
    parts.push('</article>');
  }
  parts.push('</div>');
  return parts.join('');
}

/**
 * Default fixture payload for the local-fixture source (no network).
 *
 * @returns {object}
 */
export function buildLocalFixtureImportBody() {
  return {
    sourceId: 'local-fixture',
    capturedAt: new Date().toISOString(),
    payload: {
      entries: [
        {
          modelKey: 'example/acme-model',
          releaseTier: 3,
          mappingStatus: 'mapped',
          mappingDimension: 'release',
        },
        {
          modelKey: 'example/acme-base',
          baseScore: 0.42,
          mappingDimension: 'base',
        },
      ],
    },
  };
}
