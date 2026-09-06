#!/usr/bin/env node
/**
 * Cretli chat management CLI.
 *
 * Talks to the running Cretli server over its HTTP API (never edits data/
 * files directly). Authentication reuses POST /api/login; the password comes
 * from CRETLI_CLI_PASSWORD (or CRETLI_PASSWORD) or an interactive prompt.
 *
 * Usage:
 *   npm run chat -- <command> [args]
 *
 * Commands:
 *   workspaces                        List workspace folders with chat counts
 *   list    [filters]                 List chats (active by default)
 *             [--all] [--archived] [--workspace <substr>] [--limit <n>] [--json]
 *   show    <ref> [--tail <n>] [--json]
 *                                     Chat metadata + conversation tail
 *                                     (<ref> = id prefix or title substring)
 *   archive <ref...>                   Archive chats
 *   restore <ref...>                   Unarchive chats
 *   rename  <ref> <new title...>       Rename a chat
 *   delete  <ref...> [--confirm]       Delete chats (requires --confirm)
 *
 * Environment:
 *   CRETLI_URL           Base URL (default https://127.0.0.1:3011)
 *   CRETLI_CLI_PASSWORD  Login password (falls back to CRETLI_PASSWORD, then prompt)
 *   CRETLI_INSECURE_TLS  Set to 0 to enforce TLS verification (loopback is
 *                        relaxed by default because of the self-signed cert)
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import process from 'node:process';
import {
  CretliApiClient,
  CretliApiError,
  findChatByRef,
  isLoopbackUrl,
} from '../lib/remote-api-client.js';

function printHelp() {
  console.log(`Cretli chat CLI — manage chats through the running server API.

Usage: npm run chat -- <command> [args]

Commands:
  workspaces                     Workspace folders with chat counts
  list    [--all] [--archived] [--workspace <substr>] [--limit <n>] [--json]
  show    <ref> [--tail <n>] [--json]
  archive <ref...>
  restore <ref...>
  rename  <ref> <new title...>
  delete  <ref...> [--confirm]

<ref> is a chat id (prefix ok) or a unique title substring.

Environment:
  CRETLI_URL (default ${'https://127.0.0.1:3011'}), CRETLI_CLI_PASSWORD / CRETLI_PASSWORD,
  CRETLI_INSECURE_TLS=0 to enforce TLS verification.`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, 'true');
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function readPassword() {
  if (process.env.CRETLI_CLI_PASSWORD) return process.env.CRETLI_CLI_PASSWORD;
  if (process.env.CRETLI_PASSWORD) return process.env.CRETLI_PASSWORD;
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question('Cretli password: ');
  } finally {
    rl.close();
  }
}

function createClient() {
  return new CretliApiClient({
    baseUrl: process.env.CRETLI_URL,
    password: undefined,
    insecureTls: process.env.CRETLI_INSECURE_TLS !== '0' && isLoopbackUrl(process.env.CRETLI_URL || 'https://127.0.0.1:3011'),
  });
}

function formatDay(iso) {
  return String(iso || '').slice(0, 10);
}

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

function printChatRow(chat) {
  const badge = chat.archivedAt ? ' [ARCHIVED]' : '';
  console.log(
    `${formatDay(chat.updatedAt || chat.createdAt)}  ${pad(chat.agentTransport || 'sdk', 10)}  ` +
      `${pad(chat.title || '(untitled)', 60)}  ${String(chat.id).slice(0, 8)}${badge}`,
  );
}

function extractAssistantText(event) {
  const content = event?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
}

/**
 * Render a history tail as a compact conversation: user messages, final
 * assistant answers, and a per-command summary of tool activity.
 */
function formatHistoryTail(history) {
  const events = Array.isArray(history?.events) ? history.events : [];
  const lines = [];
  const toolCalls = new Map();
  let lastAssistant = '';
  for (const entry of events) {
    const rec = entry?.rec;
    if (!rec || typeof rec !== 'object') continue;
    if (rec.kind === 'localUser' && typeof rec.text === 'string') {
      lastAssistant = '';
      if (rec.text.trim()) lines.push(`\n> ${rec.text.trim()}`);
      continue;
    }
    if (rec.kind !== 'sdk' || !rec.event || typeof rec.event !== 'object') continue;
    const event = rec.event;
    if (event.type === 'assistant') {
      const text = extractAssistantText(event);
      if (!text) continue;
      if (lastAssistant && text.startsWith(lastAssistant)) {
        if (text.length > lastAssistant.length && lines.length > 0) lines.pop();
        else continue;
      }
      lastAssistant = text;
      lines.push(`\n${text}`);
    } else if (event.type === 'tool_call' && event.call_id) {
      toolCalls.set(event.call_id, { name: event.name, status: event.status });
    }
  }
  if (toolCalls.size > 0) {
    const byKey = new Map();
    for (const call of toolCalls.values()) {
      const key = `${call.name}:${call.status}`;
      byKey.set(key, (byKey.get(key) || 0) + 1);
    }
    const summary = [...byKey.entries()].map(([key, count]) => `${key}×${count}`).join(', ');
    lines.push(`\n[tool calls: ${toolCalls.size} — ${summary}]`);
  }
  return lines.join('\n').trim();
}

async function resolveRefsOrFail(client, refs) {
  const chats = await client.listChats({ includeArchived: true });
  const resolved = [];
  const missing = [];
  for (const ref of refs) {
    const result = findChatByRef(chats, ref);
    if (result.chat) resolved.push(result.chat);
    else missing.push({ ref, matches: result.matches || [] });
  }
  for (const { ref, matches } of missing) {
    console.error(`No unique chat for "${ref}"${matches.length ? ` — ${matches.length} candidates:` : ''}`);
    for (const chat of matches.slice(0, 10)) printChatRow(chat);
  }
  return resolved;
}

async function cmdList(client, flags) {
  const archivedMode = flags.get('all') ? 'any' : flags.has('archived') ? 'only' : 'active';
  const includeArchived = archivedMode !== 'active';
  let chats = await client.listChats({ includeArchived });
  const workspace = flags.get('workspace');
  if (workspace) {
    const needle = String(workspace).toLowerCase();
    chats = chats.filter((chat) =>
      `${chat.workspaceFolder || ''} ${chat.workspaceFile || ''}`.toLowerCase().includes(needle));
  }
  chats.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  if (archivedMode === 'only') chats = chats.filter((chat) => chat.archivedAt);
  const limit = Number.parseInt(String(flags.get('limit') ?? '0'), 10);
  if (limit > 0) chats = chats.slice(0, limit);
  if (flags.has('json')) {
    console.log(JSON.stringify(chats, null, 2));
    return;
  }
  console.log(`${chats.length} chat(s)${archivedMode === 'active' ? ' (active)' : ''}`);
  for (const chat of chats) printChatRow(chat);
}

async function cmdWorkspaces(client, flags) {
  const chats = await client.listChats({ includeArchived: true });
  const counts = new Map();
  for (const chat of chats) {
    const key = chat.workspaceFolder || chat.workspaceFile || '(none)';
    const entry = counts.get(key) || { total: 0, archived: 0 };
    entry.total += 1;
    if (chat.archivedAt) entry.archived += 1;
    counts.set(key, entry);
  }
  const rows = [...counts.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([workspace, entry]) => ({ workspace, ...entry }));
  if (flags.has('json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const row of rows) {
    console.log(`${pad(row.total, 5)} chats (${row.archived} archived)  ${row.workspace}`);
  }
}

async function cmdShow(client, refs, flags) {
  const chats = await client.listChats({ includeArchived: true });
  const result = findChatByRef(chats, refs[0] || '');
  if (!result.chat) {
    console.error('No unique chat for the given reference.');
    for (const chat of (result.matches || []).slice(0, 10)) printChatRow(chat);
    process.exitCode = 1;
    return;
  }
  const chat = result.chat;
  const tail = Math.max(1, Number.parseInt(String(flags.get('tail') ?? '80'), 10) || 80);
  const history = await client.getChatHistory(chat.id, { tail });
  if (flags.has('json')) {
    console.log(JSON.stringify({ chat, history }, null, 2));
    return;
  }
  console.log(`# ${chat.title || '(untitled)'} (${chat.id})`);
  console.log(`workspace: ${chat.workspaceFolder || chat.workspaceFile || '(none)'}`);
  console.log(`harness: ${chat.agentTransport || 'sdk'}  model: ${chat.model || '-'}  archived: ${chat.archivedAt ? 'yes' : 'no'}`);
  console.log(`created: ${formatDay(chat.createdAt)}  updated: ${formatDay(chat.updatedAt)}`);
  console.log(`\n--- history tail (headSeq ${history?.headSeq ?? '?'}) ---`);
  console.log(formatHistoryTail(history) || '(no renderable events)');
}

async function cmdArchiveOrRestore(client, refs, archived) {
  const resolved = await resolveRefsOrFail(client, refs);
  for (const chat of resolved) {
    const updated = await client.archiveChat(chat.id, archived);
    console.log(`${archived ? 'archived' : 'restored'}: ${updated?.title || chat.title} (${chat.id.slice(0, 8)})`);
  }
}

async function cmdRename(client, refs, titleParts) {
  const title = titleParts.join(' ').trim();
  if (!title) throw new Error('rename requires a new title');
  const [resolved] = await resolveRefsOrFail(client, refs);
  if (!resolved) {
    console.error('No unique chat for the given reference.');
    process.exitCode = 1;
    return;
  }
  const updated = await client.renameChat(resolved.id, title);
  console.log(`renamed: ${updated?.title} (${resolved.id.slice(0, 8)})`);
}

async function cmdDelete(client, refs, flags) {
  if (!flags.has('confirm')) {
    console.error('delete requires --confirm (this permanently removes chats and their history).');
    process.exitCode = 1;
    return;
  }
  const resolved = await resolveRefsOrFail(client, refs);
  for (const chat of resolved) {
    await client.deleteChat(chat.id);
    console.log(`deleted: ${chat.title || chat.id}`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    printHelp();
    return;
  }
  const client = createClient();
  client.password = await readPassword();
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case 'list': return cmdList(client, flags);
    case 'workspaces': return cmdWorkspaces(client, flags);
    case 'show': return cmdShow(client, positional, flags);
    case 'archive': return cmdArchiveOrRestore(client, positional, true);
    case 'restore': return cmdArchiveOrRestore(client, positional, false);
    case 'rename': {
      const [ref, ...titleParts] = positional;
      return cmdRename(client, [ref], titleParts);
    }
    case 'delete': return cmdDelete(client, positional, flags);
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  const message = err instanceof CretliApiError
    ? `Cretli API error (HTTP ${err.status}): ${err.message}`
    : String(err?.message || err);
  console.error(message);
  process.exit(1);
});
