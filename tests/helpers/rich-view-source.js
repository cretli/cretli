import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @param {string} dir */
function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

/**
 * Source text of the rich chat view: the `sdk-rich-view.js` facade plus every
 * module under `app_front/features/chat/history/`. Source-contract tests read
 * this instead of the facade alone, so the assertions survive module splits.
 */
export function readRichViewSource() {
  const facade = path.join(projectRoot, 'app_front/lib/sdk-rich-view.js');
  const historyDir = path.join(projectRoot, 'app_front/features/chat/history');
  return [facade, ...listJs(historyDir)].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}
