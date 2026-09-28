/**
 * Node-only loader for optional data/model-score-heuristics.json.
 * Keep filesystem imports out of the webpack UI graph.
 */

import fs from 'node:fs';
import { DEFAULT_MODEL_SCORE_ROWS, normalizeModelScoreRows } from './model-score-heuristics.js';
import { resolveDataPath } from './runtime-paths.js';

/**
 * @param {{ filePath?: string }} [input]
 * @returns {import('./model-score-heuristics.js').ModelScoreRow[]}
 */
export function loadModelScoreRows(input = {}) {
  const filePath = String(input.filePath || '').trim() || resolveDataPath('model-score-heuristics.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return normalizeModelScoreRows(JSON.parse(raw));
  } catch {
    return [...DEFAULT_MODEL_SCORE_ROWS];
  }
}
