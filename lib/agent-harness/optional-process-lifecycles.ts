/**
 * Light loader for the `lifecycle` entry of repo harness plugins.
 *
 * The boot loader (optional-harness-plugins.js) registers lifecycles for the
 * plugins it loads. A process that never loads the chat runtime — the memory
 * monitor CLI run by systemd — calls this instead: it reads the manifests of the
 * plugins selected by `CRETLI_OPTIONAL_HARNESSES` (or `defaultEnabled`), imports
 * only their `lifecycle` entry and registers it. Never throws.
 */

import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolveProjectPath } from '../runtime-paths.js';
import { registerProcessLifecycle } from './builtin-process-lifecycles.ts';
import { isOptionalHarnessSelectionExplicit, readEnabledOptionalHarnessIds } from './optional-harness-selection.ts';

/**
 * @returns Ids whose lifecycle was registered by this call.
 */
export async function loadOptionalProcessLifecycles(
  options: { env?: Record<string, string | undefined>, root?: string } = {},
): Promise<string[]> {
  const env = options.env || process.env;
  const root = options.root || resolveProjectPath('harnesses');
  const registered: string[] = [];
  const explicit = isOptionalHarnessSelectionExplicit(env);
  const requested = explicit ? readEnabledOptionalHarnessIds(env) : null;
  if (requested && requested.length === 0) return registered;
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return registered;
  }
  for (const dir of dirs) {
    try {
      const manifest = JSON.parse(await readFile(path.join(root, dir, 'harness-plugin.json'), 'utf8'));
      if (manifest?.origin !== 'builtin-optional' || manifest.id !== dir) continue;
      const selected = requested ? requested.includes(dir) : manifest.defaultEnabled === true;
      const relative = manifest?.entries?.lifecycle;
      if (!selected || typeof relative !== 'string') continue;
      const mod = await import(pathToFileURL(path.join(root, dir, relative)).href);
      if (mod?.default?.processLifecycle && registerProcessLifecycle(mod.default.processLifecycle)) registered.push(dir);
    } catch {
      // A broken plugin must not stop a monitor run.
    }
  }
  return registered;
}
