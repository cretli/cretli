import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sidebarDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../app_front/features/sidebar');

/**
 * Read the sidebar composition root and its extracted modules as one source
 * bundle for source-level contracts that permit function relocation.
 * @returns {string}
 */
export function readSidebarViewSource() {
  const parts = [readFileSync(resolve(sidebarDir, 'sidebarView.js'), 'utf8')];
  for (const dir of ['views', 'state', 'services']) {
    for (const name of readdirSync(resolve(sidebarDir, dir)).sort()) {
      if (name.endsWith('.js') && name !== 'index.js') {
        parts.push(readFileSync(resolve(sidebarDir, dir, name), 'utf8'));
      }
    }
  }
  return parts.join('\n');
}
