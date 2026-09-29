/**
 * Installs the Claude Agent SDK in its own tree.
 * A failed install leaves the rest of Cretli usable; the Claude harness
 * stays unavailable until this script succeeds.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const prefix = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'optional-packages',
  'claude-agent-sdk',
);
const result = spawnSync(
  'npm',
  ['install', '--ignore-scripts', '--prefix', prefix],
  { stdio: 'inherit' },
);
if (result.status !== 0) {
  console.warn('Optional Claude Agent SDK was not installed. The Claude harness stays unavailable.');
}
