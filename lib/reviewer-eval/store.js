/**
 * File storage for the reviewer eval under `<dataDir>/reviewer-eval/`.
 * The data dir is always passed in; this module never resolves it itself.
 */

import fs from 'node:fs';
import path from 'node:path';

/** @param {string} dataDir @returns {string} */
export function casesPath(dataDir) {
  return path.join(dataDir, 'reviewer-eval', 'cases.json');
}

/** @param {string} dataDir @param {string} date YYYY-MM-DD @returns {string} */
export function resultsPath(dataDir, date) {
  return path.join(dataDir, 'reviewer-eval', 'results', `${date}.json`);
}

/** @param {string} dataDir @returns {Array<Record<string, any>>} */
export function readCases(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(casesPath(dataDir), 'utf8'));
    return Array.isArray(parsed?.cases) ? parsed.cases : [];
  } catch {
    return [];
  }
}

/** @param {string} dataDir @param {Array<Record<string, any>>} cases @returns {string} */
export function writeCases(dataDir, cases) {
  const file = casesPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ cases }, null, 2)}\n`);
  return file;
}

/** @param {string} value @returns {string} */
function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
}

/**
 * One file per day and harness+model, so two runs on the same day never overwrite each other.
 *
 * @param {string} dataDir
 * @param {string} date
 * @param {{ harness: string, model: string }} who
 * @param {unknown} payload
 * @returns {string}
 */
export function writeResults(dataDir, date, who, payload) {
  const file = path.join(path.dirname(resultsPath(dataDir, date)), `${date}-${slug(who.harness)}-${slug(who.model)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

/**
 * @param {string} dataDir
 * @param {string} date
 * @returns {Array<Record<string, any>>} every result of that date across all result files
 */
export function readResultsForDate(dataDir, date) {
  const dir = path.dirname(resultsPath(dataDir, date));
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(`${date}-`) && n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      return Array.isArray(parsed?.results) ? parsed.results : [];
    } catch {
      return [];
    }
  });
}
