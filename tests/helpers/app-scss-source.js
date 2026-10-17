/**
 * Source-level reader for the app stylesheet: `app.scss` is a pure `@use` index,
 * so contract tests need the index plus every partial. Partials are joined in
 * `@use` order (= original source order), so slice-from-marker checks keep their
 * meaning. Reads SCSS source text, not compiled CSS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cssDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app_front/css');

/** @param {string} spec `@use` target such as `./features/chat/sdk` @returns {string} */
function resolvePartial(spec) {
  const rel = spec.replace(/^\.\//, '');
  const dir = path.dirname(rel);
  const base = path.basename(rel);
  const candidates = [path.join(dir, `_${base}.scss`), path.join(dir, `${base}.scss`)];
  const found = candidates.map((c) => path.join(cssDir, c)).find((c) => fs.existsSync(c));
  if (!found) throw new Error(`app.scss @use target not found: ${spec}`);
  return found;
}

/** @returns {string[]} absolute paths of the partials, in `@use` order */
export function listAppScssPartials() {
  const index = fs.readFileSync(path.join(cssDir, 'app.scss'), 'utf8');
  return [...index.matchAll(/^@use\s+'([^']+)';/gm)].map((m) => resolvePartial(m[1]));
}

/** @returns {string} app.scss index followed by all partials joined in `@use` order */
export function readAppScssSource() {
  const index = fs.readFileSync(path.join(cssDir, 'app.scss'), 'utf8');
  return [index, ...listAppScssPartials().map((p) => fs.readFileSync(p, 'utf8'))].join('\n');
}
