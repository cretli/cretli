/**
 * Frontend size ratchet (docs/frontend-architecture.md): files over 1000 lines
 * may only shrink, smaller files may grow up to 1000; innerHTML counts may only
 * shrink; new files must be <= 1000 lines and contain no innerHTML.
 * Lock gains in with `node scripts/front-size-baseline.js --write`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { measureFront, baselinePath, tightenFrontBaseline, countInnerHtml } from '../scripts/front-size-baseline.js';

const MAX_NEW_LINES = 1000;

// Only property access counts; the word in a comment ("built without innerHTML") does not.
assert.equal(countInnerHtml('el.innerHTML = x; y?.innerHTML'), 2);
assert.equal(countInnerHtml('// rendered with Lit (no innerHTML)'), 0);

// Rewriting the baseline can only tighten it: a moved file that keeps innerHTML
// must not get recorded, and a grown file keeps its old (lower) value.
{
  const prev = { 'app_front/a.js': { lines: 100, innerHTML: 2 }, 'app_front/gone.js': { lines: 5, innerHTML: 0 } };
  const now = {
    'app_front/a.js': { lines: 120, innerHTML: 3 },
    'app_front/features/x/moved.js': { lines: 290, innerHTML: 8 },
    'app_front/features/x/clean.js': { lines: 40, innerHTML: 0 },
  };
  assert.deepEqual(tightenFrontBaseline(prev, now), {
    'app_front/a.js': { lines: 100, innerHTML: 2 },
    'app_front/features/x/clean.js': { lines: 40, innerHTML: 0 },
  });
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).files;
const current = measureFront();
const problems = [];

for (const [file, now] of Object.entries(current)) {
  const was = baseline[file];
  if (!was) {
    if (now.lines > MAX_NEW_LINES) problems.push(`${file}: new file has ${now.lines} lines (max ${MAX_NEW_LINES})`);
    if (now.innerHTML > 0) problems.push(`${file}: new file uses innerHTML (${now.innerHTML}x)`);
    continue;
  }
  if (now.lines > was.lines && now.lines > MAX_NEW_LINES) problems.push(`${file}: grew ${was.lines} -> ${now.lines} lines`);
  if (now.innerHTML > was.innerHTML) problems.push(`${file}: innerHTML ${was.innerHTML} -> ${now.innerHTML}`);
}

assert.deepEqual(problems, [], `front size ratchet violated:\n${problems.join('\n')}`);
console.log('front-size-ratchet: ok');
