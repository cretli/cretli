#!/usr/bin/env node

/**
 * Runs an SDK agent probe for a chat (resume vs fresh create) and prints JSON.
 *
 * Usage:
 *   node scripts/sdk-chat-probe.js --chat-id <uuid> [--resume-only] [--timeout-ms 120000]
 */

import path from 'path';
import { loadChats } from '../lib/persist/chats-persist.js';
import { runSdkChatProbe } from '../lib/sdk/sdk-agent-probe.js';
import { resolveSdkCwdForChat } from '../lib/workspace.js';

/**
 * @param {string[]} argv
 * @returns {{ chatId: string, resumeOnly: boolean, timeoutMs: number }}
 */
function parseArgs(argv) {
  const out = { chatId: '', resumeOnly: false, timeoutMs: 120000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] || '';
    if (arg === '--chat-id') out.chatId = argv[i + 1] || '';
    if (arg === '--resume-only') out.resumeOnly = true;
    if (arg === '--timeout-ms') out.timeoutMs = Number.parseInt(argv[i + 1] || '120000', 10) || 120000;
    if (arg.startsWith('--chat-id=')) out.chatId = arg.slice('--chat-id='.length);
    if (arg.startsWith('--timeout-ms=')) {
      out.timeoutMs = Number.parseInt(arg.slice('--timeout-ms='.length), 10) || 120000;
    }
  }
  return out;
}

/**
 * @param {string | null | undefined} workspacePath
 * @returns {string}
 */
function workspaceDirForAgent(workspacePath) {
  if (!workspacePath) return process.cwd();
  return path.extname(workspacePath) === '.code-workspace'
    ? path.dirname(path.resolve(workspacePath))
    : path.resolve(workspacePath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.chatId) {
    console.error('Usage: node scripts/sdk-chat-probe.js --chat-id <uuid> [--resume-only] [--timeout-ms 120000]');
    process.exit(2);
  }
  const chats = loadChats();
  const chat = chats.find((entry) => entry.id === args.chatId);
  if (!chat) {
    console.error(`Chat not found: ${args.chatId}`);
    process.exit(1);
  }
  const cwd = resolveSdkCwdForChat(chat, workspaceDirForAgent);
  if (!cwd) {
    console.error('Missing workspace folder for chat');
    process.exit(1);
  }
  const probe = await runSdkChatProbe(chat, {
    cwd,
    includeCreateProbe: !args.resumeOnly,
    timeoutMs: args.timeoutMs,
  });
  console.log(JSON.stringify(probe, null, 2));
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
