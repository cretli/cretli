/**
 * Child process for the history import crash test: runs the real import and
 * SIGKILLs itself after N committed chats (no cleanup handlers run).
 * argv[2] = JSON of applyLegacyImport options plus `killAfterChats`.
 */
import { applyLegacyImport } from '../../lib/storage/history-import.js';

const { killAfterChats, ...options } = JSON.parse(process.argv[2]);
let committed = 0;
applyLegacyImport({
  ...options,
  faultHook(point) {
    if (point === 'chat-committed') {
      committed += 1;
      if (committed >= killAfterChats) process.kill(process.pid, 'SIGKILL');
    }
  },
});
