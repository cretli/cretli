/**
 * Test-only child process: opens the storage database, takes the write lock
 * (BEGIN IMMEDIATE), reports "locked" on stdout and holds it until stdin
 * closes (then rolls back). Used by tests/storage-sqlite-busy-contention.test.js.
 */
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2], { timeout: 0 });
db.exec('BEGIN IMMEDIATE');
process.stdout.write('locked\n');
process.stdin.resume();
process.stdin.on('close', () => {
  try {
    db.exec('ROLLBACK');
    db.close();
  } finally {
    process.exit(0);
  }
});
