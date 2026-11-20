/** Check registrations in each frontend entry's actual module graph. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app_front');

function inspect(source) {
  const imports = new Set();
  const used = new Set();
  const registered = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source
      && node.importKind !== 'type' && node.exportKind !== 'type') imports.add(node.source.value);
    if (node.type === 'ImportExpression' && node.source.type === 'StringLiteral') imports.add(node.source.value);
    if (node.type === 'CallExpression') {
      const name = node.callee?.property?.name;
      const value = node.arguments[0]?.value;
      if ((name === 'define' && node.callee.object?.name === 'customElements'
        || node.callee?.name === 'defineWatcherRegion') && /^cr-/.test(value)) registered.add(value);
      if (name === 'createElement' && /^cr-/.test(value)) used.add(value);
    }
    const text = node.type === 'StringLiteral' ? node.value : node.type === 'TemplateElement' ? node.value.raw : '';
    for (const match of text.matchAll(/<\s*(cr-[a-z0-9-]+)(?=[\s/>])/g)) used.add(match[1]);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parse(source, { sourceType: 'module', plugins: ['typescript'] }).program);
  return { imports, used, registered };
}

function missing(modules, entry, reached = new Set()) {
  const seen = new Set();
  const used = new Set();
  const registered = new Set();
  function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    reached.add(file);
    const info = modules.get(file);
    if (!info) return;
    info.used.forEach((tag) => used.add(tag));
    info.registered.forEach((tag) => registered.add(tag));
    for (const specifier of info.imports) {
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      walk([target, `${target}.js`, `${target}.ts`, `${target}/index.js`].find((candidate) => modules.has(candidate)) || target);
    }
  }
  walk(entry);
  return [...used].filter((tag) => !registered.has(tag)).sort();
}

// Regression: an orphan registration file or another entry cannot repair a lost import.
const fixture = new Map([
  ['app.js', inspect("import './barrel.js'; document.createElement('cr-example')")],
  ['barrel.js', inspect("export * from './element.js'")],
  ['element.js', inspect("customElements.define('cr-example', Example)")],
]);
assert.deepEqual(missing(fixture, 'app.js'), []);
fixture.set('barrel.js', inspect(''));
assert.deepEqual(missing(fixture, 'app.js'), ['cr-example']);
assert.deepEqual([...inspect('// <cr-comment>\nconst x = html`<cr-real></cr-real>`').used], ['cr-real']);
fixture.set('app.js', inspect("import type { Example } from './element.js'; const x = html`<cr-example />`"));
assert.deepEqual(missing(fixture, 'app.js'), ['cr-example']);
fixture.set('app.js', inspect("await import('./element.js'); const x = '<cr-example></cr-example>'"));
assert.deepEqual(missing(fixture, 'app.js'), []);

const modules = new Map();
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(js|ts)$/.test(file)) modules.set(path.relative(root, file).split(path.sep).join('/'), inspect(fs.readFileSync(file, 'utf8')));
  }
}
walk(root);
// Read webpack's declared entries without executing its plugins.
const config = parse(fs.readFileSync(path.join(root, 'webpack.common.js'), 'utf8'), { sourceType: 'module' });
const base = config.program.body.find((node) => node.type === 'ExportNamedDeclaration'
  && node.declaration?.declarations?.some((item) => item.id.name === 'baseConfig'));
const entries = base.declaration.declarations[0].init.properties.find((node) => node.key.name === 'entry')
  .value.properties.map((node) => node.value.value.replace(/^\.\//, ''));
assert.ok(entries.length, 'Webpack entries must be checked');
// Static shell tags are instantiated by the browser before the app entry runs.
const appEntry = modules.get(entries[0]);
assert.ok(appEntry, `app entry ${entries[0]} must exist`);
for (const match of fs.readFileSync(path.join(root, '../public/index.html'), 'utf8').matchAll(/<\s*(cr-[a-z0-9-]+)(?=[\s/>])/g)) {
  appEntry.used.add(match[1]);
}
const reached = new Set();
for (const entry of entries) assert.deepEqual(missing(modules, entry, reached), [], `${entry}: custom elements without imported registration`);
for (const [file, info] of modules) {
  if (!reached.has(file) && info.used.size) assert.deepEqual(missing(modules, file), [], `${file}: orphan consumer without imported registration`);
}
console.log('custom-elements-imported.test.js: ok');
