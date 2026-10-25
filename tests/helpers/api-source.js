import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Concatenated source of the API barrel and every core/api domain module. */
export function readApiSource() {
  const dir = path.join(root, 'app_front/core/api');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  return [
    fs.readFileSync(path.join(root, 'app_front/core/api/index.js'), 'utf8'),
    ...files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')),
  ].join('\n');
}
