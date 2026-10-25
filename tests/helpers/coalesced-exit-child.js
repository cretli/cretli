import { flushCoalescedWrites, writeJsonCoalesced } from '../../lib/persist/atomic-write.js';

const [file, mode] = process.argv.slice(2);
process.on('exit', () => flushCoalescedWrites());
process.on('SIGTERM', () => {
  flushCoalescedWrites();
  process.exit(0);
});
writeJsonCoalesced(file, { mode }, 'utf8', { maxDelayMs: 10000 });
if (mode === 'direct') process.exit(7);
if (mode === 'signal') setInterval(() => {}, 1000);

