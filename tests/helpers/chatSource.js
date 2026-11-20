import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPLIT_DIRS = ['services', 'state', 'views'].map((dir) => path.join(root, 'app_front/features/chat', dir));

/**
 * Source of the chat panel: `app_front/features/chat/views/chatPanel.js` followed by the modules split out of it
 * (`features/chat/{services,state,views}`). Source-scan tests assert wiring that now lives
 * in either place, so they read the whole panel instead of one file.
 */
export function readChatSource() {
  const entry = path.join(root, 'app_front/features/chat/views/chatPanel.js');
  const parts = [fs.readFileSync(entry, 'utf8')];
  for (const dir of SPLIT_DIRS) {
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort()) {
      if (path.join(dir, file) === entry) continue;
      parts.push(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
  }
  return parts.join('\n');
}
