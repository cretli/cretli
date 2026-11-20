#!/usr/bin/env node
/**
 * Offline full backup / restore of Cretli JSON + SQLite data (server MUST be stopped).
 *
 *   status                         show control state and any pending restore
 *   backup  --dest DIR             write a verified backup directory under DIR
 *   backup  --dest DIR --encrypt [--include-secrets]
 *                                  write an encrypted single-file backup (.cretlibak); --include-secrets
 *                                  adds Cretli-managed secret documents (encrypted backups only)
 *   verify  --backup DIR|FILE      verify a backup (digests, SQLite integrity/foreign keys)
 *   restore --backup DIR|FILE --yes
 *                                  verified pre-restore copy, then journaled managed-path restore
 *   list    --dest DIR             list encrypted backups (date, profile, size, status; no password)
 *   recover                        roll an interrupted restore forward
 *   rollback --yes-lossy           restore the previous files (loses writes made after the restore)
 *   finalize                       discard retained previous files + journal
 *   resume                         clear the post-restore pause flag
 *
 * Encrypted backups read the passphrase from --passphrase-file PATH (owner-only file) or the
 * CRETLI_BACKUP_PASSPHRASE environment variable; never from an argument. It is not stored anywhere.
 * Options: --data-dir DIR, --control-dir DIR (default <data-dir>/.cretli-control),
 * --high-water N (external fence high-water). Spawns no processes and sends no push.
 * See docs/backup/offline-data-recovery.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { readControlState, resolveControlDir } from '../lib/backup/offline/control-dir.js';
import { createOfflineBackup, verifyOfflineBackup } from '../lib/backup/offline/offline-backup.js';
import {
  createEncryptedBackup, listEncryptedBackups, recoverPendingEncryptedRestore, restoreEncryptedBackup, verifyEncryptedBackup,
} from '../lib/backup/encryption/encrypted-backup.js';
import {
  finalizeRestore, readRestoreJournal, recoverPendingRestore, restoreOfflineBackup, resumeAfterRestore, rollbackRestore,
} from '../lib/backup/offline/offline-restore.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'data-dir': { type: 'string' }, 'control-dir': { type: 'string' }, dest: { type: 'string' }, backup: { type: 'string' },
    'high-water': { type: 'string' }, encrypt: { type: 'boolean' }, 'include-secrets': { type: 'boolean' }, 'passphrase-file': { type: 'string' }, yes: { type: 'boolean' }, 'yes-lossy': { type: 'boolean' },
  },
});
const command = positionals[0] || 'status';
const dataDir = path.resolve(values['data-dir'] || resolveDataPath());
const controlDir = resolveControlDir(dataDir, values['control-dir']);

/** @param {string} msg */
function need(msg) {
  console.error(msg);
  process.exit(2);
}

/** @param {string} p */
const isEncryptedFile = (p) => p.endsWith('.cretlibak');

/**
 * Passphrase from an owner-only file or the environment (never argv, so it stays out of ps/history).
 *
 * @returns {string}
 */
function readPassphrase() {
  const file = values['passphrase-file'];
  if (file) {
    const st = fs.statSync(String(file));
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) need(`passphrase file ${file} must not be readable by group/others (chmod 600)`);
    return fs.readFileSync(String(file), 'utf8').replace(/\r?\n$/, '');
  }
  const env = process.env.CRETLI_BACKUP_PASSPHRASE;
  if (env) return env;
  need('encrypted backups need --passphrase-file PATH or CRETLI_BACKUP_PASSPHRASE');
  return '';
}

try {
  switch (command) {
    case 'status': {
      const journal = readRestoreJournal(controlDir);
      console.log(JSON.stringify({ dataDir, controlDir, state: readControlState(controlDir), restore: journal ? { id: journal.id, status: journal.status } : null }, null, 2));
      break;
    }
    case 'backup': {
      if (!values.dest) need('backup requires --dest DIR');
      if (values['include-secrets'] && !values.encrypt) need('--include-secrets is only allowed with --encrypt');
      if (values.encrypt) {
        const r = await createEncryptedBackup({
          dataDir, controlDir, destRoot: String(values.dest), password: readPassphrase(), includeCredentials: values['include-secrets'] === true,
        });
        console.log(`encrypted backup ok: ${r.file} (profile ${r.profile}, ${r.bytes} bytes). Keep the passphrase: without it the backup cannot be restored.`);
        break;
      }
      const { backupDir, manifest } = await createOfflineBackup({ dataDir, controlDir, destRoot: String(values.dest) });
      console.log(`backup ok: ${backupDir} (${/** @type {any} */ (manifest).entries.length} files)`);
      break;
    }
    case 'verify': {
      if (!values.backup) need('verify requires --backup DIR');
      if (isEncryptedFile(String(values.backup))) {
        const { manifest } = await verifyEncryptedBackup(path.resolve(String(values.backup)), readPassphrase(), { controlDir });
        console.log(`encrypted backup ok: ${manifest.id} (${manifest.entries.length} files)`);
        break;
      }
      const { manifest } = verifyOfflineBackup(path.resolve(String(values.backup)));
      console.log(`backup ok: ${manifest.id} (${manifest.entries.length} files)`);
      break;
    }
    case 'restore': {
      if (!values.backup) need('restore requires --backup DIR');
      if (!values.yes) need('restore replaces managed data; re-run with --yes to confirm');
      const result = isEncryptedFile(String(values.backup))
        ? await restoreEncryptedBackup({
          dataDir, controlDir, file: path.resolve(String(values.backup)), password: readPassphrase(), externalHighWater: Number(values['high-water']) || 0,
        })
        : await restoreOfflineBackup({
          dataDir, controlDir, backupDir: String(values.backup), externalHighWater: Number(values['high-water']) || 0,
        });
      console.log(`restore ok: ${JSON.stringify(result)}\nDataset is paused; review, then run \`finalize\` and \`resume\`.`);
      break;
    }
    case 'list':
      if (!values.dest) need('list requires --dest DIR');
      console.log(JSON.stringify(listEncryptedBackups(path.resolve(String(values.dest))), null, 2));
      break;
    case 'recover':
      console.log(JSON.stringify(await recoverPendingEncryptedRestore({
        dataDir, controlDir, password: values['passphrase-file'] || process.env.CRETLI_BACKUP_PASSPHRASE ? readPassphrase() : undefined,
      })));
      break;
    case 'rollback':
      console.log(JSON.stringify(rollbackRestore({ dataDir, controlDir, acknowledgeLossy: values['yes-lossy'] === true })));
      break;
    case 'finalize':
      console.log(JSON.stringify(finalizeRestore({ dataDir, controlDir })));
      break;
    case 'resume':
      console.log(JSON.stringify(resumeAfterRestore(controlDir)));
      break;
    default:
      need(`unknown command: ${command}`);
  }
} catch (err) {
  console.error(`${/** @type {any} */ (err)?.code || 'error'}: ${/** @type {Error} */ (err)?.message || err}`);
  process.exit(1);
}
