#!/usr/bin/env node
/**
 * Minimal acceptance-evidence validator.
 *
 * Compares hashes and numbers quoted in a brief/report against the canonical
 * artifact (a verify manifest + metrics JSON). The canonical artifact always
 * wins: a wrong value in a brief is reported and never replaces it.
 *
 * Usage: node scripts/validate-evidence.mjs <canonical.json> <brief.json>
 *   canonical: { manifest: { entries: [{ id, sha256 }] }, metrics: { name: number } }
 *   brief:     { hashes: { id: sha256 }, numbers: { name: number } }
 *
 * Table pattern: `renderEvidenceTable(canonical)` emits a markdown table from
 * the canonical data so docs/briefs paste generated rows, not typed values.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @param {{ manifest?: { entries?: Array<{ id: string, sha256: string }> }, metrics?: Record<string, number> }} canonical
 * @param {{ hashes?: Record<string, string>, numbers?: Record<string, number> }} brief
 * @returns {{ ok: boolean, mismatches: Array<{ kind: string, key: string, canonical: unknown, brief: unknown }> }}
 */
export function validateEvidence(canonical, brief) {
  const mismatches = [];
  const entries = new Map((canonical?.manifest?.entries || []).map((e) => [e.id, e.sha256]));
  for (const [id, hash] of Object.entries(brief?.hashes || {})) {
    if (!entries.has(id)) mismatches.push({ kind: 'hash_unknown_id', key: id, canonical: null, brief: hash });
    else if (entries.get(id) !== hash) mismatches.push({ kind: 'hash', key: id, canonical: entries.get(id), brief: hash });
  }
  const metrics = canonical?.metrics || {};
  for (const [name, value] of Object.entries(brief?.numbers || {})) {
    if (!Object.prototype.hasOwnProperty.call(metrics, name)) mismatches.push({ kind: 'number_unknown', key: name, canonical: null, brief: value });
    else if (metrics[name] !== value) mismatches.push({ kind: 'number', key: name, canonical: metrics[name], brief: value });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * @param {{ manifest?: { entries?: Array<{ id: string, path?: string, sha256: string }> }, metrics?: Record<string, number> }} canonical
 * @returns {string} markdown tables generated from the canonical artifact
 */
export function renderEvidenceTable(canonical) {
  const rows = (canonical?.manifest?.entries || []).map((e) => `| ${e.id} | ${e.path || ''} | ${e.sha256} |`);
  const metrics = Object.entries(canonical?.metrics || {}).map(([k, v]) => `| ${k} | ${v} |`);
  return [
    '| id | path | sha256 |', '|---|---|---|', ...rows, '',
    '| metric | value |', '|---|---|', ...metrics,
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [canonicalPath, briefPath] = process.argv.slice(2);
  if (!canonicalPath || !briefPath) {
    console.error('usage: validate-evidence.mjs <canonical.json> <brief.json>');
    process.exit(2);
  }
  let canonical;
  let brief;
  try {
    canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
    brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  } catch (err) {
    // Exit 2 = unreadable input, distinct from exit 1 = real mismatches.
    console.error(`invalid input: ${err.message}`);
    process.exit(2);
  }
  const result = validateEvidence(canonical, brief);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
