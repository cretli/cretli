/** Pure helpers for scripts/load-test-background.mjs (unit-tested). */

/** Nearest-rank percentile (q in 0..1); null for an empty sample. */
export function percentile(values, q) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const v = s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  return Math.round(v * 100) / 100;
}

/**
 * Only 2xx counts as success. A 3xx counts only when `allowRedirect` is set AND
 * the response carries a non-empty Location header (304 and bare 3xx are errors).
 */
export function isSuccessStatus(status, allowRedirect = false, location = '') {
  if (status >= 200 && status < 300) return true;
  return allowRedirect && status >= 300 && status < 400 && status !== 304 && String(location || '').trim() !== '';
}

/**
 * Classifies a chat attempt from its status and body chunks. Redirects (e.g. to
 * login) are errors, and at least one non-empty chunk is required.
 * `chunks` is an array of { atMs, bytes } in arrival order.
 */
export function classifyChatResponse(status, chunks) {
  if (status < 200 || status >= 300) return { ok: false };
  const first = chunks.find((c) => c.bytes > 0);
  if (!first) return { ok: false };
  const last = chunks.filter((c) => c.bytes > 0).at(-1);
  return { ok: true, startMs: first.atMs, streamMs: last.atMs };
}

/** Per-route stats: only successful samples feed latency percentiles. */
export function summarizeRoute({ ok = [], errors = 0 }) {
  const total = ok.length + errors;
  return {
    ok: ok.length,
    errors,
    errorRate: total ? Math.round((errors / total) * 1000) / 1000 : 0,
    p50: percentile(ok, 0.5),
    p95: percentile(ok, 0.95),
  };
}

/** Synthetic todo tree: `size` items, a third of them ready leaves, grouped under sections. */
export function buildSyntheticTodos(size = 300) {
  const items = [{ id: 'lt-root', status: 'idea', title: 'root' }];
  const sections = Math.max(1, Math.floor(size / 20));
  for (let s = 0; s < sections; s += 1) {
    items.push({ id: `lt-s${s}`, status: 'idea', title: `section ${s}`, parent_id: 'lt-root', parentId: 'lt-root' });
  }
  for (let i = items.length; i < size; i += 1) {
    const parent = `lt-s${i % sections}`;
    const status = i % 3 === 0 ? 'ready' : i % 3 === 1 ? 'done' : 'idea';
    items.push({ id: `lt-${i}`, status, title: `leaf ${i}`, parent_id: parent, parentId: parent });
  }
  return items;
}

/** Exit code policy: 0 ok, 1 when any route or background error rate exceeds the threshold. */
export function exitCodeFor(rates, threshold) {
  return rates.some((r) => r > threshold) ? 1 : 0;
}
