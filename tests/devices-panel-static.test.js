import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const dir = new URL('../app_front/features/devices/', import.meta.url);
// Every file in the feature folder is scanned; a new file is covered without touching this test.
const FILES = fs.readdirSync(dir).filter((f) => /\.(js|scss)$/.test(f));
const read = (f) => fs.readFileSync(new URL(f, dir), 'utf8');

const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const ATTR_TEXT = /\b(?:placeholder|title|aria-label|heading|label|alt)=(["'])[^"']*[A-Za-z]{2,}[^"']*\1/;
const NODE_TEXT = />[^<>]*[A-Za-z]{2,}[^<>]*</;
/** Lowercase identifier-like tokens (state values, css classes, i18n keys, mdi icons) are not UI text; prose starts uppercase or has spaces. */
const TOKEN_ALLOWED = (text) => /^[a-z][A-Za-z0-9_.:-]*$/.test(text) || /^mdi(-[a-z-]+)?( |$)/.test(text);
/** Removes comments (line and block) while leaving string and template contents alone. */
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; out += ' '; continue; }
    if (c === '/' && n === '/' && src[i - 1] !== ':') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e - 1; continue; }
    if (c === '\'' || c === '"') { let j = i + 1; while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1; out += src.slice(i, j + 1); i = j; continue; }
    if (c === '`') { const j = skipTemplate(src, i); out += src.slice(i, j); i = j - 1; continue; }
    out += c;
  }
  return out;
}

/** Index just past the template literal starting at `start` (a backtick), expressions included. */
function skipTemplate(src, start) {
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') { i = skipExpression(src, i + 2); continue; }
    i += 1;
  }
  return i;
}
/** Index just past the `}` closing an expression whose body starts at `start`. */
function skipExpression(src, start) {
  let depth = 1, i = start;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '\'' || c === '"') { i += 1; while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1; i += 1; continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '{') depth += 1;
    if (c === '}') depth -= 1;
    i += 1;
  }
  return i;
}

/**
 * Walks a template literal body: returns its static markup (expressions blanked) and the
 * source of each expression. Nested templates live inside the expressions and are walked by the caller.
 */
function splitTemplate(src, start) {
  let markup = '', i = start + 1;
  const exprs = [];
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') { markup += src.slice(i, i + 2); i += 2; continue; }
    if (src[i] === '$' && src[i + 1] === '{') { const end = skipExpression(src, i + 2); exprs.push(src.slice(i + 2, end - 1)); markup += '\u0000'; i = end; continue; }
    markup += src[i]; i += 1;
  }
  return { markup, exprs, end: i + 1 };
}

/** Finds every tagged html`...` template at any nesting depth (recursing through expressions). */
function htmlTemplates(src, out = []) {
  const re = /\bhtml`/g;
  let m;
  while ((m = re.exec(src))) {
    const t = splitTemplate(src, m.index + 4);
    out.push(t);
    for (const e of t.exprs) htmlTemplates(e, out);
    re.lastIndex = t.end;
  }
  return out;
}

/** Removes balanced `t(...)` calls so their key arguments are not read as literals. */
function dropTranslateCalls(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const m = /(?<![\w.$])t\(/.exec(src.slice(i));
    if (!m) { out += src.slice(i); break; }
    const open = i + m.index + 1;
    out += src.slice(i, i + m.index);
    let depth = 1, j = open + 1;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (c === '\'' || c === '"') { j += 1; while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1; }
      else if (c === '`') { j = skipTemplate(src, j) - 1; }
      else if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      j += 1;
    }
    out += ' '; i = j;
  }
  return out;
}

/** String literals (no interpolation) left in `src` after dropping t() calls and html templates. */
function literalsOf(src) {
  let rest = dropTranslateCalls(src);
  for (;;) {
    const m = /\bhtml`/.exec(rest);
    if (!m) break;
    rest = rest.slice(0, m.index) + ' ' + rest.slice(skipTemplate(rest, m.index + 4));
  }
  const found = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m;
  while ((m = re.exec(rest))) if (!m[2].includes('${')) found.push(m[2]);
  return found;
}

/** Returns violations found in one source text. */
export function scan(name, source) {
  const found = [];
  const src = stripComments(source);
  src.split('\n').forEach((line, i) => { if (COLOR.test(line)) found.push(`${name}:${i + 1} colour literal`); });
  if (!name.endsWith('.js')) return found;
  for (const tpl of htmlTemplates(src)) {
    if (ATTR_TEXT.test(tpl.markup)) found.push(`${name} literal attribute text`);
    if (NODE_TEXT.test(tpl.markup)) found.push(`${name} literal text node`);
    for (const expr of tpl.exprs) {
      for (const lit of literalsOf(expr)) {
        if (/[A-Za-z]{2,}/.test(lit) && !TOKEN_ALLOWED(lit)) found.push(`${name} literal "${lit}" in template expression`);
      }
    }
  }
  // Calls that surface messages must pass a key, never prose.
  for (const m of src.matchAll(/\b(?:setMessage|setStatus)\(\s*(['"`][^'"`]*)/g)) found.push(`${name} literal message ${m[1]}`);
  // Prose assigned or returned outside templates: capitalised or multi-word strings are UI text.
  for (const lit of literalsOf(src.replace(/^\s*import .*$/gm, ''))) {
    if (/^[A-Z][a-z]+|[A-Za-z]+ [A-Za-z]+/.test(lit) && !/^[A-Z][A-Z_]+$/.test(lit) && !/^(?:application|text)\//.test(lit) && !/^[A-Z][a-z]+(-[A-Z][a-z]+)+$/.test(lit)) found.push(`${name} prose literal "${lit}"`);
  }
  return [...new Set(found)];
}

test('negative fixtures are caught', () => {
  assert.ok(scan('x.scss', '.a { color: #fff; }').length);
  assert.ok(scan('x.scss', '.a { color: rgb(1, 2, 3); }').length);
  assert.ok(scan('x.js', 'const v = html`<p>Hello there</p>`;').length);
  assert.ok(scan('x.js', 'html`<cr-bar-input placeholder="Type here">`').length);
  assert.ok(scan('x.js', "setMessage('Saved', 'success');").length);
  assert.ok(scan('x.js', "html`<p>${'Hello'}</p>`").length);
  assert.ok(scan('x.js', "html`<cr-dialog .heading=${'Hello'}></cr-dialog>`").length);
  assert.ok(scan('x.js', "html`<p>${a.map((x) => html`<b title=${'Delete item'}>${x}</b>`)}</p>`").length);
  assert.ok(scan('x.js', "html`<p>${a ? html`<i>${'Nested text'}</i>` : ''}</p>`").length);
  assert.ok(scan('x.js', "html`<p>${ok ? t('devices.a') : 'Failed'}</p>`").length);
  assert.ok(scan('x.js', "state.message = 'Something went wrong';").length);
  assert.deepEqual(scan('x.js', "html`<p>${t('devices.empty')}</p>`;\n// #fff"), []);
  assert.deepEqual(scan('x.js', "html`<td>${a.map((k) => html`<b>${k}</b>`)}</td>`"), []);
  assert.deepEqual(scan('x.js', "html`<span class=${on ? 'active' : 'idle'}>${t(`devices.k.${v}`)}</span>`"), []);
  assert.deepEqual(scan('x.scss', '.a { color: var(--cr-text); }'), []);
});

test('every file in the Devices feature folder uses tokens and t() only', () => {
  assert.ok(FILES.includes('devicesPanel.js') && FILES.includes('devices-panel.scss'));
  assert.deepEqual(FILES.flatMap((f) => scan(f, read(f))), []);
});

const lookup = (dict, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict);

/** Resolves `NAME` or an inline array literal to its string members. */
function arrayMembers(src, ref) {
  let body = ref;
  if (/^[A-Z_]+$/.test(ref)) {
    const m = new RegExp(`const ${ref} = Object\\.freeze\\((\\[[^\\]]*\\])\\)`).exec(src);
    assert.ok(m, `cannot resolve array ${ref}`);
    body = m[1];
  }
  return [...body.matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

/** Every concrete key the code can ask for: literal keys plus each expansion of `.map((v) => t(`a.${v}`))`. */
function usedKeys() {
  const keys = new Set();
  for (const f of FILES.filter((x) => x.endsWith('.js'))) {
    const src = stripComments(read(f));
    for (const m of src.matchAll(/['"`](devices\.[A-Za-z0-9_.-]+)['"`]/g)) keys.add(m[1]);
    const handled = new Set();
    for (const m of src.matchAll(/(\[[^\]]*\]|[A-Z_]{3,})\.map\(\(?(\w+)\)?\s*=>[\s\S]{0,600}?`(devices\.[A-Za-z0-9_.-]*)\$\{\2\}([A-Za-z0-9_.-]*)`/g)) {
      for (const v of arrayMembers(src, m[1])) keys.add(`${m[3]}${v}${m[4]}`);
      handled.add(m[3]);
    }
    for (const m of src.matchAll(/`(devices\.[A-Za-z0-9_.-]*)\$\{[^}]+\}([A-Za-z0-9_.-]*)`/g)) {
      assert.ok(handled.has(m[1]), `${f}: dynamic key ${m[0]} is not generated by a resolvable array .map; make the domain explicit`);
    }
  }
  return keys;
}

test('every generated devices.* key exists in pl and en as a string', () => {
  const keys = usedKeys();
  assert.ok(keys.size > 40);
  for (const needed of ['devices.platform.android', 'devices.platform.ios', 'devices.kind.adb-wifi', 'devices.kind.chrome-cdp', 'devices.run.col.screenshots', 'devices.compare.col.delta']) assert.ok(keys.has(needed), `expected expansion ${needed}`);
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    for (const key of keys) assert.equal(typeof lookup(dict, key), 'string', `${lang} missing ${key}`);
  }
  assert.equal(typeof en.tabs.devices, 'string');
  assert.equal(typeof pl.tabs.devices, 'string');
});

test('en and pl devices dictionaries share the same keys', () => {
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`])).sort();
  assert.deepEqual(flat(pl.devices), flat(en.devices));
});
