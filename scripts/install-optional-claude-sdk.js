/**
 * Installs the Claude Agent SDK in its own tree.
 *
 * `npm ci` is used whenever the isolated tree ships a `package-lock.json` so
 * the install is reproducible; otherwise it falls back to `npm install`.
 * A failed install leaves the rest of Cretli usable; the Claude harness
 * stays unavailable until this script succeeds.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const prefix = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'optional-packages',
  'claude-agent-sdk',
);
const hasLockfile = fs.existsSync(path.join(prefix, 'package-lock.json'));
const command = hasLockfile ? 'ci' : 'install';
const result = spawnSync(
  'npm',
  [command, '--ignore-scripts', '--prefix', prefix],
  { stdio: 'inherit' },
);
if (result.status !== 0) {
  console.warn('Optional Claude Agent SDK was not installed. The Claude harness stays unavailable.');
}
