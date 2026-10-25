/**
 * Pure view model for Settings → Harness "Model prices and statistics".
 *
 * Display-only: the numbers come from GET /api/delegations/stats
 * (`priced_stats.by_level`). Money (`usd`) is shown only when the server marked
 * the value `is_money`; an RCU proxy is always labelled a proxy.
 */

const LEVEL_ORDER = Object.freeze({ trivial: 0, standard: 1, demanding: 2, unknown: 3 });

/**
 * Only http(s) URLs may become an anchor `href`; anything else (javascript:,
 * data:, malformed) is rendered as plain escaped text.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    const { protocol } = new URL(String(value));
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
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
 * @param {unknown} value
 * @returns {number|null}
 */
function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {number|null} value
 * @param {number} digits
 * @returns {string}
 */
function fixed(value, digits) {
  return value == null ? '—' : value.toFixed(digits);
}

/**
 * @param {number|null} value
 * @returns {string}
 */
function percent(value) {
  return value == null ? '—' : `${Math.round(value * 100)}%`;
}

/**
 * @param {unknown} iso
 * @returns {string} Date part only, or an em dash.
 */
function dateOnly(iso) {
  const text = String(iso || '').trim();
  return text ? text.slice(0, 10) : '—';
}

/**
 * Money is `$1.23`; a proxy is `1.23 RCU` and is never given a currency sign.
 *
 * @param {{ unit?: string, is_money?: boolean }|null|undefined} block
 * @param {number|null} value
 * @param {number} digits
 * @returns {string}
 */
export function formatPricedValue(block, value, digits = 3) {
  if (value == null) return '—';
  if (block?.is_money === true && block.unit === 'usd') return `$${value.toFixed(digits)}`;
  return `${value.toFixed(digits)} RCU`;
}

/**
 * @param {object|null} payload GET /api/delegations/stats
 * @returns {{ rows: object[], attribution: { text: string, url: string }|null, truncated: boolean, hasData: boolean }}
 */
export function buildHarnessModelStatsViewModel(payload) {
  const priced = payload?.priced_stats && typeof payload.priced_stats === 'object' ? payload.priced_stats : null;
  const source = Array.isArray(priced?.by_level) ? priced.by_level : [];
  const rows = source.map((row) => ({
    harness: String(row.harness || ''),
    model: String(row.model || ''),
    role: String(row.role || ''),
    level: String(row.level || 'unknown'),
    billingClass: String(row.billing_class || 'unknown'),
    n: num(row.n) ?? 0,
    usableRate: num(row.usable_rate),
    infraFailRate: num(row.infra_fail_rate),
    medianMin: num(row.median_min),
    tokensIn: num(row.median_tokens_in),
    tokensOut: num(row.median_tokens_out),
    price: row.price_per_1m || null,
    costPerPass: row.cost_per_pass || null,
    benchmark: row.benchmark || null,
  }));
  rows.sort((a, b) => (b.n - a.n)
    || a.model.localeCompare(b.model)
    || a.role.localeCompare(b.role)
    || ((LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9)));
  const attribution = priced?.attribution?.text
    ? { text: String(priced.attribution.text), url: String(priced.attribution.url || 'https://artificialanalysis.ai/') }
    : null;
  return { rows, attribution, truncated: priced?.truncated === true, hasData: rows.length > 0 };
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
 * @param {object|null} price
 * @param {(key: string) => string} t
 * @returns {string}
 */
function renderPrice(price, t) {
  if (!price || price.input == null || price.output == null) return '—';
  const money = price.is_money === true;
  const input = fixed(num(price.input), 2);
  const output = fixed(num(price.output), 2);
  const unit = money ? '$' : '';
  const suffix = money ? '' : ` ${t('harnessModelStats.proxyUnit')}`;
  const meta = `${enumLabel('harnessModelStats.priceSource', String(price.source || 'none'), t)} · ${dateOnly(price.captured_at)}`;
  const flag = price.estimated ? ` · ${t('harnessModelStats.estimate')}` : '';
  return `<span class="harness-model-stats-price">${h(unit)}${h(input)} / ${h(unit)}${h(output)}${h(suffix)}</span>`
    + `<span class="harness-model-stats-meta">${h(meta)}${h(flag)}</span>`;
}

/**
 * @param {object|null} cost
 * @param {(key: string) => string} t
 * @returns {string}
 */
function renderCostPerPass(cost, t) {
  if (!cost || cost.value == null) return '—';
  const value = formatPricedValue(cost, num(cost.value), 4);
  const label = cost.is_money === true
    ? enumLabel('harnessModelStats.costSource', String(cost.source || ''), t)
    : t('harnessModelStats.proxyLabel');
  return `<span class="harness-model-stats-price">${h(value)}</span>`
    + `<span class="harness-model-stats-meta">${h(label)} · ${h(dateOnly(cost.captured_at))}</span>`;
}

/**
 * @param {object|null} benchmark
 * @param {(key: string) => string} t
 * @returns {string}
 */
function renderBenchmark(benchmark, t) {
  if (!benchmark || benchmark.benchmark_score == null) {
    return `<span class="harness-model-stats-meta">${h(enumLabel('harnessModelStats.benchmarkStatus', String(benchmark?.status || 'no_source'), t))}</span>`;
  }
  const stale = benchmark.stale === true ? ` · ${t('harnessModelStats.stale')}` : '';
  return `<span class="harness-model-stats-price">${h(fixed(num(benchmark.benchmark_score), 2))}</span>`
    + `<span class="harness-model-stats-meta">${h(String(benchmark.source || ''))} · ${h(dateOnly(benchmark.captured_at))}${h(stale)}</span>`;
}

/**
 * @param {ReturnType<typeof buildHarnessModelStatsViewModel>} model
 * @param {(key: string, values?: object) => string} t
 * @returns {string}
 */
export function renderHarnessModelStatsHtml(model, t) {
  if (!model.hasData) {
    return `<p class="settings-hint">${h(t('harnessModelStats.empty'))}</p>`;
  }
  const parts = ['<div class="harness-model-stats">'];
  parts.push(`<p class="settings-hint">${h(t('harnessModelStats.proxyNote'))}</p>`);
  parts.push('<div class="harness-model-stats-scroll"><table class="harness-model-stats-table">');
  parts.push('<thead><tr>');
  for (const key of ['model', 'role', 'level', 'n', 'usable', 'infra', 'price', 'costPerPass', 'benchmark']) {
    parts.push(`<th scope="col">${h(t(`harnessModelStats.col.${key}`))}</th>`);
  }
  parts.push('</tr></thead><tbody>');
  for (const row of model.rows) {
    parts.push('<tr>');
    parts.push(`<td>${h(row.harness)}/${h(row.model)}<span class="harness-model-stats-meta">${h(enumLabel('harnessModelStats.billingClass', row.billingClass, t))}</span></td>`);
    parts.push(`<td>${h(enumLabel('harnessModelStats.role', row.role, t))}</td>`);
    parts.push(`<td>${h(enumLabel('harnessModelStats.level', row.level, t))}</td>`);
    parts.push(`<td>${h(String(row.n))}</td>`);
    parts.push(`<td>${h(percent(row.usableRate))}</td>`);
    parts.push(`<td>${h(percent(row.infraFailRate))}</td>`);
    parts.push(`<td>${renderPrice(row.price, t)}</td>`);
    parts.push(`<td>${renderCostPerPass(row.costPerPass, t)}</td>`);
    parts.push(`<td>${renderBenchmark(row.benchmark, t)}</td>`);
    parts.push('</tr>');
  }
  parts.push('</tbody></table></div>');
  if (model.truncated) parts.push(`<p class="settings-hint">${h(t('harnessModelStats.truncated'))}</p>`);
  if (model.attribution) {
    const url = model.attribution.url;
    const link = isHttpUrl(url)
      ? `<a href="${h(url)}" target="_blank" rel="noopener noreferrer">Artificial Analysis</a> `
      : 'Artificial Analysis ';
    parts.push(`<p class="harness-model-stats-attribution">${h(t('harnessModelStats.attributionPrefix'))} `
      + `${link}(${h(url)})</p>`);
  }
  parts.push('</div>');
  return parts.join('');
}
