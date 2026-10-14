/**
 * Guard: every use of the historical `parentChatId` in lib/ and server.js must
 * be classified, so control decisions go through `delegationController(row)`.
 *
 * Scope: lib/**\/*.js and server.js. Out of scope (by design): scripts/,
 * app_front/ and dynamic access such as `row[key]` — the scanner only sees
 * literal property names.
 *
 * Scanner: tests/helpers/delegation-controller-scan.js — comments and string
 * literals are blanked, braces are tracked, and every hit is attributed to the
 * innermost named enclosing function (`outer.inner`, `#2` for repeats, MCP
 * handlers as `handler[tool]`, Express callbacks as `route[METHOD /path]`).
 *
 * Allowlist: config/delegation-controller-allowlist.json, entries of
 * `file:function:class:reason` with class control|identity|scope.
 *   control  — the function decides who may steer/own a delegation; it must
 *              really call `delegationController(` or `canChatControlDelegation(`
 *              in code (a mention in a comment or string does not count).
 *   identity — history/identity of the starter (records, prompts, tree links).
 *   scope    — workspace/widget scope gate; resolved through the accessor
 *              helpers, never decided by the raw field.
 * A function listed as identity/scope must not call the accessor: a mixed
 * function is split instead.
 *
 * Run `node tests/delegation-controller-guard.test.js --print-inventory` to
 * print the full inventory for review.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource } from './helpers/delegation-controller-scan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = path.join(ROOT, 'config', 'delegation-controller-allowlist.json');
const CLASSES = new Set(['control', 'identity', 'scope']);
const CONTROL_CALLS = ['delegationController', 'canChatControlDelegation'];

function walkJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Scan lib/**\/*.js and server.js. */
export function scanControllerUsage() {
  const files = [...walkJsFiles(path.join(ROOT, 'lib')), path.join(ROOT, 'server.js')];
  const usage = new Map();
  const oldNames = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const scanned = scanSource(rel, fs.readFileSync(file, 'utf8'));
    for (const [key, entry] of scanned.functions) usage.set(key, entry);
    oldNames.push(...scanned.oldNames);
  }
  return { usage, oldNames };
}

function parseAllowlist() {
  const doc = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  assert.ok(Array.isArray(doc.entries), 'allowlist.entries must be an array');
  const map = new Map();
  for (const raw of doc.entries) {
    const [file, fn, klass, ...reasonParts] = String(raw).split(':');
    const reason = reasonParts.join(':').trim();
    assert.ok(file && fn && klass, `malformed allowlist entry: ${raw}`);
    assert.ok(CLASSES.has(klass), `unknown class "${klass}" in: ${raw}`);
    assert.ok(reason, `allowlist entry needs a reason: ${raw}`);
    const key = `${file}:${fn}`;
    assert.ok(!map.has(key), `duplicate allowlist entry (one reason per function, split mixed functions): ${key}`);
    map.set(key, { klass, reason });
  }
  return map;
}

const callsControl = (entry) => entry.accessorCalls.some((call) => CONTROL_CALLS.some((name) => call.endsWith(name)));

// --- scanner self-test on fixtures ------------------------------------------
{
  const fixture = [
    '// parentChatId only in a comment, delegationController( too',
    'const note = "delegationController( in a string";',
    'const tpl = `${a} text ${delegationController(row)}`;',
    'export function same(row) {',
    '  return row.parentChatId;',
    '}',
    'const holder = {',
    '  same(row) {',
    '    return delegationController(row);',
    '  },',
    '  async multi(',
    '    a,',
    '    b,',
    '  ) {',
    '    items.map((x) => {',
    '      return x.parentChatId;',
    '    });',
    '    function inner() {',
    '      return canChatControlDelegation(a, b);',
    '    }',
    '    /* parentChatId in a block comment */',
    '    return inner();',
    '  },',
    '};',
    'const arrow = async ({ a }) => {',
    '  const re = /delegationController\\(/;',
    '  return a.parentChatId;',
    '};',
  ].join('\n');
  const { functions } = scanSource('fixture.js', fixture);
  assert.deepEqual([...functions.keys()].sort(), ['fixture.js:arrow', 'fixture.js:multi', 'fixture.js:same']);
  assert.equal(functions.get('fixture.js:same').hits.length, 1, 'same-named bodies are not merged');
  assert.ok(!functions.has('fixture.js:<module>'), 'comments are not hits');
  assert.equal(callsControl(functions.get('fixture.js:same')), false, 'method of the same name keeps its own body');
  assert.equal(functions.get('fixture.js:multi').hits.length, 1, 'callback hit goes to the named method');
  assert.equal(functions.get('fixture.js:arrow').hits.length, 1);
  assert.equal(callsControl(functions.get('fixture.js:arrow')), false, 'a regex literal is not a call');
  assert.equal(callsControl(functions.get('fixture.js:multi')), false, 'nested inner() call belongs to inner, not multi');
  const noHitSame = scanSource('fixture.js', 'function f() {\n  // delegationController(row)\n  const s = "canChatControlDelegation(";\n  return row.parentChatId;\n}\n');
  assert.equal(callsControl(noHitSame.functions.get('fixture.js:f')), false, 'accessor text in comments/strings is not a call');
  const real = scanSource('fixture.js', 'function g(row) {\n  return delegationController(row) + row.parentChatId;\n}\n');
  assert.equal(callsControl(real.functions.get('fixture.js:g')), true);
  const twice = scanSource('fixture.js', 'const o = {\n  a() { return x.parentChatId; },\n};\nconst p = {\n  a() { return y.parentChatId; },\n};\n');
  assert.deepEqual([...twice.functions.keys()].sort(), ['fixture.js:a', 'fixture.js:a#2']);
}

const { usage, oldNames } = scanControllerUsage();

if (process.argv.includes('--print-inventory')) {
  const allow = parseAllowlist();
  for (const [key, entry] of [...usage].sort((a, b) => a[0].localeCompare(b[0]))) {
    const item = allow.get(key);
    const calls = [...new Set(entry.accessorCalls.map((call) => call.split(': ')[1]))].join(',');
    console.log(`${key} [${item ? item.klass : 'UNCLASSIFIED'}] ${item ? item.reason : ''}${calls ? ` (calls ${calls})` : ''}`);
    for (const hit of entry.hits) console.log(`    ${hit}`);
  }
  process.exit(0);
}

const allowlist = parseAllowlist();

// (2) removed helper names must not come back.
assert.deepEqual(oldNames, [], `old *ForParent helper names found:\n${oldNames.join('\n')}`);

// (1) every hit lives in a classified function.
const unclassified = [...usage.keys()].filter((key) => !allowlist.has(key));
assert.deepEqual(unclassified, [], `unclassified parentChatId usage (add to the allowlist or use delegationController):\n${unclassified.join('\n')}`);

// (3) no stale entries.
const stale = [...allowlist.keys()].filter((key) => !usage.has(key));
assert.deepEqual(stale, [], `stale allowlist entries:\n${stale.join('\n')}`);

const classProblems = [];
for (const [key, { klass }] of allowlist) {
  // The accessor module defines the fallback; it is the one place allowed to mix both.
  if (key.startsWith('lib/delegation-control.js:')) continue;
  const entry = usage.get(key);
  if (klass === 'control') {
    // (5) a control function must really call the accessor in code.
    if (!callsControl(entry)) classProblems.push(`${key}: class control requires a literal ${CONTROL_CALLS.join('( or ')}( call in code`);
  } else if (callsControl(entry)) {
    // (6) identity/scope functions must not also take control decisions.
    classProblems.push(`${key}: class ${klass} must not call the controller accessor; split the function`);
  }
}
assert.deepEqual(classProblems, [], classProblems.join('\n'));

console.log('delegation-controller-guard: ok', `(${usage.size} functions classified)`);
