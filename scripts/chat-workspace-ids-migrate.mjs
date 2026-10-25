#!/usr/bin/env node
/**
 * Fill `workspaceId` on existing chats whose folder belongs to exactly one SQL
 * registry workspace. Dry-run by default; pass --apply to write chats.json.
 * Never removes or rewrites existing fields. Honors CRETLI_DATA_DIR like the server.
 *
 * Usage: node scripts/chat-workspace-ids-migrate.mjs [--apply]
 */
import { loadSettings } from '../lib/persist/settings.js';
import { migrateChatWorkspaceIds } from '../lib/persist/chats-persist.js';

const apply = process.argv.includes('--apply');
const report = migrateChatWorkspaceIds(loadSettings(), { dryRun: !apply });
console.log(JSON.stringify(report, null, 2));
if (!apply) console.log('Dry run: no changes written. Re-run with --apply to save.');
