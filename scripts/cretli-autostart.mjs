#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAutostart } from '../lib/autostart/index.js';

const [action, ...flags] = process.argv.slice(2);
try {
  if (!['install', 'uninstall', 'status'].includes(action) || flags.some((flag) => !['--apply', '--start', '--linger'].includes(flag)) || (action !== 'install' && flags.some((flag) => flag !== '--apply'))) {
    throw new Error('Usage: node scripts/cretli-autostart.mjs install|uninstall|status [--apply] [--start] [--linger]');
  }
  const adapter = createAutostart({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
  const result = await adapter[action]({ apply: flags.includes('--apply'), start: flags.includes('--start'), linger: flags.includes('--linger') });
  console.log(JSON.stringify(result, null, 2));
  if (!result.supported) process.exitCode = 2;
} catch (error) {
  // Adapter command errors contain only the command name and exit code, never output.
  console.error(error.code ? `Autostart failed (${error.code}); no sudo or automatic retry.` : error.message);
  process.exitCode = 1;
}
