#!/usr/bin/env node
/**
 * Rollback export of `store.workspaces` (backup contract B1).
 *
 * Prints `config.json` merged with the workspace sections from SQL in the shape older
 * builds read (`workspaces`, `workspaceSidebarConfig`, `workspaceRouteKeys`,
 * `additionalCursorContextDirs`). With `--write` the result replaces `config.json`
 * (the previous file is kept as `config.json.pre-workspaces-export`). Stop the server
 * before `--write`; the data directory follows CRETLI_DATA_DIR like the server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { exportConfigWithWorkspaces } from '../lib/persist/settings.js';
import { writeJsonAtomic } from '../lib/persist/atomic-write.js';

const exported = exportConfigWithWorkspaces();
if (!process.argv.includes('--write')) {
  process.stdout.write(`${JSON.stringify(exported, null, 2)}\n`);
} else {
  const configFile = path.join(resolveDataPath(), 'config.json');
  if (fs.existsSync(configFile)) fs.copyFileSync(configFile, `${configFile}.pre-workspaces-export`);
  writeJsonAtomic(configFile, exported, 'utf8');
  process.stdout.write(`Wrote ${configFile} with ${(exported.workspaces || []).length} workspace(s).\n`);
}
