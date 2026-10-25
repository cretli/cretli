/**
 * Caps the catalog sent back to the Live model. A full SDK list is too large
 * for a spoken turn and delays the next function call.
 */

import { matchModelBySpokenName } from './voiceModelMatch.js';

export const VOICE_MODEL_LIST_LIMIT = 16;

/**
 * @param {{ id?: string, value?: string }} model
 * @returns {string}
 */
function modelId(model) {
  return String(model?.id || model?.value || '').trim();
}

/**
 * @param {Array<{ id?: string, value?: string, label?: string, active?: boolean }>} models
 * @param {{ query?: unknown, current?: unknown, limit?: number }} [options]
 * @returns {{ models: Array<{ id: string, label: string, active: boolean }>, total: number, truncated: boolean }}
 */
export function compactVoiceModelList(models, options = {}) {
  const items = Array.isArray(models) ? models.filter((model) => modelId(model)) : [];
  const query = String(options.query || '').trim();
  const current = String(options.current || '').trim();
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.min(40, Math.floor(Number(options.limit)))
    : VOICE_MODEL_LIST_LIMIT;
  let filtered = items;
  if (query) {
    const matched = matchModelBySpokenName(items, query);
    if (matched.match) {
      filtered = [matched.match];
    } else if (matched.ambiguous && Array.isArray(matched.candidates)) {
      const wanted = new Set(matched.candidates);
      filtered = items.filter((model) => wanted.has(modelId(model)));
    } else {
      const needle = query.toLowerCase();
      filtered = items.filter((model) => {
        const id = modelId(model).toLowerCase();
        const label = String(model.label || '').toLowerCase();
        return id.includes(needle) || label.includes(needle);
      });
    }
  }
  /** @type {typeof items} */
  const picked = [];
  const seen = new Set();
  const pushModel = (model) => {
    const id = modelId(model);
    if (!id || seen.has(id) || picked.length >= limit) return;
    seen.add(id);
    picked.push(model);
  };
  if (current && !query) {
    const active = items.find((model) => modelId(model) === current);
    if (active) pushModel(active);
  }
  for (const model of filtered) pushModel(model);
  return {
    models: picked.map((model) => {
      const id = modelId(model);
      return {
        id,
        label: String(model.label || id).trim() || id,
        active: id === current || model.active === true,
      };
    }),
    total: items.length,
    truncated: items.length > picked.length,
  };
}
