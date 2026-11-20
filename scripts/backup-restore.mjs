import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { sha256 } from '../lib/backup/auto-backup.js';
import { assertWritersStopped, isSqliteMain } from '../lib/backup/offline/managed-files.js';

const args = process.argv.slice(2);
const dataDir = resolveDataPath();
const root = path.join(dataDir, 'backups', 'auto');
if (args[0] === '--list') {
  if (fs.existsSync(root)) for (const name of fs.readdirSync(root).sort().reverse()) {
    const file = path.join(root, name, 'manifest.json');
    if (fs.existsSync(file)) console.log(`${name}\t${JSON.parse(fs.readFileSync(file, 'utf8')).entries.length} files`);
  }
} else if (args[0] === '--restore' && args[1]) {
  const timestamp = args[1];
  if (!/^[\dTZ-]+$/.test(timestamp)) throw new Error('Invalid backup timestamp');
  const onlyAt = args.indexOf('--only');
  const only = onlyAt >= 0 ? args[onlyAt + 1] : null;
  const apply = args.includes('--apply');
  if (apply) assertWritersStopped(dataDir);
  const dir = path.join(root, timestamp);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const entries = manifest.entries.filter((entry) => !only || entry.path === only);
  for (const entry of entries) {
    if (path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..')) throw new Error(`Unsafe path ${entry.path}`);
    const src = path.join(dir, entry.path);
    const dest = path.join(dataDir, entry.path);
    if (await sha256(src) !== entry.sha256) throw new Error(`Digest mismatch: ${entry.path}`);
    console.log(`${apply ? 'restore' : 'would restore'} ${entry.path} (${entry.size} bytes)`);
    if (apply) {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      if (isSqliteMain(entry.path)) {
        for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${dest}${suffix}`, { force: true });
      }
      const tmp = `${dest}.${process.pid}.restore.tmp`;
      fs.copyFileSync(src, tmp);
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, dest);
    }
  }
  if (!apply) console.log('Dry run only. Stop the server, then add --apply to restore.');
} else {
  console.error('Usage: node scripts/backup-restore.mjs --list | --restore <timestamp> [--only file] [--apply]');
  process.exitCode = 2;
}
