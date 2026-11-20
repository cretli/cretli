import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app_front');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Names listed in `static properties = { ... }` (top-level keys only). */
function reactiveNames(src) {
  const m = /static\s+properties\s*(?::[^=]+)?=\s*\{/.exec(src);
  if (!m) return [];
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  const body = src.slice(start, i - 1);
  const names = [];
  depth = 0;
  let top = '';
  for (const ch of body) {
    if (ch === '{') depth++;
    if (depth === 0) top += ch;
    if (ch === '}') depth--;
  }
  const re = /(?:^|,)\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:/g;
  let k;
  while ((k = re.exec(top))) names.push(k[1]);
  return names;
}

/** Returns `name` of each reactive property that is a class field without `declare`. */
export function findOffenders(src) {
  const bad = [];
  for (const name of reactiveNames(src)) {
    const field = new RegExp(`^[ \\t]+(?!declare\\b)(?:(?:public|private|protected|readonly|override)\\s+)*${name}\\s*(?:[?!]?\\s*:[^;=\\n]+)?(?:=[^\\n]*)?;`, 'm');
    if (field.test(src)) bad.push(name);
  }
  return bad;
}

test('fixture: instance field shadowing a static property without declare is detected', () => {
  const bad = `class A extends LitElement {
  static properties = { open: { type: Boolean }, label: { type: String } };
  open = false;
  label: string = '';
}`;
  assert.deepEqual(findOffenders(bad).sort(), ['label', 'open']);
});

test('fixture: declare + constructor init is accepted', () => {
  const good = `class A extends LitElement {
  static properties = { open: { type: Boolean } };
  declare open: boolean;
  constructor() { super(); this.open = false; }
}`;
  assert.deepEqual(findOffenders(good), []);
});

test('app_front/**/*.ts Lit reactive properties use declare', () => {
  const offenders = [];
  for (const file of walk(root)) {
    const names = findOffenders(fs.readFileSync(file, 'utf8'));
    if (names.length) offenders.push(`${path.relative(root, file)}: ${names.join(', ')}`);
  }
  assert.deepEqual(offenders, []);
});
