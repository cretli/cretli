/**
 * Isolated CODEX_HOME for the Codex CLI (never ~/.codex).
 */

import fs from 'fs';
import path from 'path';
import { ensureWritableDir } from '../ensure-writable-dir.js';
import { resolveDataPath } from '../runtime-paths.js';

const FILE_CREDENTIALS_LINE = 'cli_auth_credentials_store = "file"';

export function resolveCodexHomeDir(): string {
  return resolveDataPath('codex-home');
}

/**
 * Isolated home must persist ChatGPT tokens in auth.json, not the OS keyring.
 */
function ensureFileCredentialsStore(homeDir: string): void {
  const file = path.join(homeDir, 'config.toml');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${FILE_CREDENTIALS_LINE}\n`, 'utf8');
    return;
  }
  const current = fs.readFileSync(file, 'utf8');
  if (/cli_auth_credentials_store\s*=/.test(current)) return;
  fs.writeFileSync(file, `${FILE_CREDENTIALS_LINE}\n${current}`, 'utf8');
}

export function ensureCodexHomeDir(): string {
  const dir = ensureWritableDir(resolveCodexHomeDir());
  ensureFileCredentialsStore(dir);
  return dir;
}
