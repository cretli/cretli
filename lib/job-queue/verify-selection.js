/**
 * Leaf verify selection: tests touched by the change (via the import graph)
 * plus a fixed control set. The full suite is an integration-time concern
 * (`mode: 'integration'`). The verify contract (baseline / preexisting
 * classification) lives in lib/review-verify-baseline.js and is not changed.
 */
import { buildImportIndex, collectDependencies } from './import-graph.js';

/**
 * @param {{
 *   root?: string,
 *   index?: Map<string, string[]>,
 *   tests: string[],
 *   changed: string[],
 *   control?: string[],
 *   mode?: 'leaf' | 'integration',
 * }} input `tests` and `changed` are repo-relative paths.
 * @returns {{ mode: string, selected: string[], affected: string[], control: string[], skipped: string[] }}
 */
export function selectVerifyTests(input) {
  const mode = input.mode === 'integration' ? 'integration' : 'leaf';
  const tests = [...new Set(input.tests)].sort();
  if (mode === 'integration') return { mode, selected: tests, affected: tests, control: [], skipped: [] };
  const index = input.index || buildImportIndex(/** @type {string} */ (input.root));
  const changed = new Set(input.changed);
  const affected = tests.filter((test) => collectDependencies(index, test).some((dep) => changed.has(dep)));
  const known = new Set(tests);
  const control = [...new Set(input.control || [])].filter((test) => known.has(test) && !affected.includes(test)).sort();
  const selected = [...affected, ...control].sort();
  const chosen = new Set(selected);
  return { mode, selected, affected, control, skipped: tests.filter((test) => !chosen.has(test)) };
}
