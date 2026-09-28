/** Shared provider usage-limit state for harness model selection. */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from './runtime-paths.js';
import { writeJsonAtomic } from './persist/atomic-write.js';
import { decodeModelValue } from './model-catalog.js';

const FILE = resolveDataPath('harness-usage-limits.json');
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** @type {Map<string, object>} */
const limits = new Map();
let loaded = false;

const key = (harness, model) => `${String(harness || '').trim().toLowerCase()}:${String(model || '').trim().toLowerCase() || '*'}`;
const baseModel = (model) => decodeModelValue(String(model || '').trim()).modelId.toLowerCase();

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.harness && new Date(row.resetAt).getTime() > Date.now()) limits.set(key(row.harness, row.model), row);
    }
  } catch { /* optional cache */ }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    writeJsonAtomic(FILE, [...limits.values()]);
  } catch (error) {
    console.warn('[harness-usage-limits] persist failed:', error?.message || error);
  }
}

export function isUsageLimitMessage(message) {
  const text = String(message || '').toLowerCase();
  return /usage\s+limit|quota\s+(?:has\s+been\s+)?exhausted|rate\s+limit|too many requests|resource[_ ]exhausted/.test(text)
    || /\b429\b/.test(text);
}

function readResetAt(message) {
  const match = String(message || '').match(/(?:reset|resets|reset at|reset on)\s*(?:at|on)?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}(?:[ T][0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:\s*(?:UTC|Z))?)?)/i);
  const timestamp = match ? new Date(match[1].replace(' ', 'T')).getTime() : NaN;
  return Number.isFinite(timestamp) && timestamp > Date.now()
    ? new Date(timestamp).toISOString()
    : new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
}

export function noteHarnessUsageLimit(input = {}) {
  const harness = String(input.harness || '').trim().toLowerCase();
  const model = String(input.model || '').trim();
  const message = String(input.message || '').trim();
  if (!harness || !isUsageLimitMessage(message)) return false;
  limits.set(key(harness, model), {
    harness, model, message: message.slice(0, 1000),
    resetAt: readResetAt(message), detectedAt: new Date().toISOString(),
  });
  save();
  return true;
}

export function getHarnessUsageLimit(input = {}) {
  load();
  const harness = String(input.harness || '').trim().toLowerCase();
  const model = String(input.model || '').trim();
  const wantedBase = baseModel(model);
  const matches = [...limits.values()].filter((row) => {
    if (row.harness !== harness || new Date(row.resetAt).getTime() <= Date.now()) return false;
    if (!row.model || !model) return true;
    return row.model.toLowerCase() === model.toLowerCase() || baseModel(row.model) === wantedBase;
  });
  matches.sort((a, b) => new Date(a.resetAt) - new Date(b.resetAt));
  return matches[0] || null;
}

export function listHarnessUsageLimits() {
  load();
  for (const [id, row] of limits) if (new Date(row.resetAt).getTime() <= Date.now()) limits.delete(id);
  return [...limits.values()];
}
