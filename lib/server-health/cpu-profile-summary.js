// Pure helpers that turn a V8 .cpuprofile (Profiler.stop result) into a compact
// summary, a stable signature and a todo body. No threads, no I/O: unit-testable.
import { createHash } from 'node:crypto';

const IDLE_NAMES = new Set(['(idle)', '(program)', '(root)']);

/** Convert a profile frame url into a repo-relative path (or the raw url). */
export function normalizeFrameUrl(url, repoRoot) {
  let p = String(url || '');
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      p = p.slice('file://'.length);
    }
  }
  if (repoRoot) {
    const root = String(repoRoot).replace(/\/+$/, '') + '/';
    if (p.startsWith(root)) p = p.slice(root.length);
  }
  return p;
}

/**
 * Aggregate self time per function. Returns
 * { totalMs, lib: [...], top: [...] } where each row is
 * { functionName, file, line, selfMs, percent, isLib }.
 * `lib` holds only frames under lib/ (preferred section); `top` is all frames.
 */
export function summarizeProfile(profile, { repoRoot = '', topN = 10 } = {}) {
  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const selfUs = new Map();
  const samples = profile?.samples || [];
  const deltas = profile?.timeDeltas || [];
  if (samples.length) {
    for (let i = 0; i < samples.length; i += 1) {
      selfUs.set(samples[i], (selfUs.get(samples[i]) || 0) + (deltas[i] || 0));
    }
  } else {
    // Fallback for synthetic profiles: hitCount * 1ms.
    for (const n of nodes) if (n.hitCount) selfUs.set(n.id, n.hitCount * 1000);
  }

  const rows = new Map();
  let totalUs = 0;
  for (const [id, us] of selfUs) {
    const node = byId.get(id);
    if (!node) continue;
    const cf = node.callFrame || {};
    const name = cf.functionName || '(anonymous)';
    if (IDLE_NAMES.has(name)) continue;
    totalUs += us;
    const file = normalizeFrameUrl(cf.url, repoRoot) || '(native)';
    const line = (cf.lineNumber ?? -1) + 1;
    const key = `${file}:${line}:${name}`;
    const row = rows.get(key) || {
      functionName: name,
      file,
      line,
      selfMs: 0,
      percent: 0,
      isLib: file.startsWith('lib/'),
    };
    row.selfMs += us / 1000;
    rows.set(key, row);
  }
  const totalMs = totalUs / 1000;
  const all = [...rows.values()]
    .map((r) => ({
      ...r,
      selfMs: Math.round(r.selfMs * 10) / 10,
      percent: totalMs > 0 ? Math.round((r.selfMs / totalMs) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.selfMs - a.selfMs);
  return {
    totalMs: Math.round(totalMs * 10) / 10,
    lib: all.filter((r) => r.isLib).slice(0, topN),
    top: all.slice(0, topN),
  };
}

/** Stable short hash of the top 3 lib/ frames (falls back to top 3 overall). */
export function computeSignature(summary) {
  const frames = summary?.lib?.length ? summary.lib : summary?.top || [];
  const basis = frames
    .slice(0, 3)
    .map((f) => `${f.file}#${f.functionName}`)
    .join('|');
  return createHash('sha1').update(basis || 'no-frames').digest('hex').slice(0, 12);
}

export function signatureMarker(signature) {
  return `stall-signature: ${signature}`;
}

function formatRow(r) {
  return `- \`${r.functionName}\` — ${r.file}:${r.line} — ${r.selfMs} ms (${r.percent}%)`;
}

/** Markdown body for the todo; contains the signature marker for dedupe. */
export function buildTodoBody({ summary, signature, stalledForMs, reason, profileMs, detectedAt }) {
  const lines = [
    `Event-loop stall detected by the stall watchdog (${reason || 'heartbeat'}).`,
    '',
    `- Detected at: ${detectedAt || new Date().toISOString()}`,
    `- Main thread unresponsive for: ${stalledForMs ?? '?'} ms`,
    `- CPU profile window: ${profileMs ?? '?'} ms (total sampled self time ${summary?.totalMs ?? 0} ms)`,
    '',
    '## Top functions under lib/ (self time)',
    ...(summary?.lib?.length ? summary.lib.map(formatRow) : ['- (no frames under lib/)']),
    '',
    '## Top functions overall (self time)',
    ...(summary?.top?.length ? summary.top.map(formatRow) : ['- (no samples)']),
    '',
    signatureMarker(signature),
  ];
  return lines.join('\n');
}
