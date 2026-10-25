#!/usr/bin/env node

/**
 * Fetches the latest tail of an active chat session and prints a flow scenario template.
 * Usage:
 *   node scripts/capture-status-flow-from-chat.js --chat-id <uuid> [--limit 4000] [--base-url http://127.0.0.1:3011]
 */

function parseArgs(argv) {
  const out = { chatId: '', limit: 4000, baseUrl: process.env.CURSOR_REMOTE_BASE_URL || 'http://127.0.0.1:3011' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] || '';
    if (arg === '--chat-id') out.chatId = argv[i + 1] || '';
    if (arg === '--limit') out.limit = Number.parseInt(argv[i + 1] || '4000', 10) || 4000;
    if (arg === '--base-url') out.baseUrl = argv[i + 1] || out.baseUrl;
    if (arg.startsWith('--chat-id=')) out.chatId = arg.slice('--chat-id='.length);
    if (arg.startsWith('--limit=')) out.limit = Number.parseInt(arg.slice('--limit='.length), 10) || 4000;
    if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice('--base-url='.length);
  }
  return out;
}

function usage() {
  console.error(
    'Usage: node scripts/capture-status-flow-from-chat.js --chat-id <uuid> [--limit 4000] [--base-url http://127.0.0.1:3011]'
  );
}

function buildScenarioTemplate(chatId, tail) {
  const now = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return {
    group: 'Status detection: captures from real chunks',
    id: `captured-${now}`,
    name: `Captured tail chat ${chatId.slice(0, 8)}`,
    steps: [
      {
        name: 'captured tail',
        mode: 'replace',
        agent: 'idle',
        recentOutput: false,
        input: tail,
        ensures: [
          { path: 'state.tone', equals: 'textarea' }
        ],
      },
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.chatId) {
    usage();
    process.exit(2);
  }
  if (!args.baseUrl) {
    console.error('Missing base URL');
    process.exit(2);
  }
  const baseUrl = args.baseUrl.replace(/\/$/, '');
  const url = `${baseUrl}/api/chats/${encodeURIComponent(args.chatId)}/status-tail?limit=${encodeURIComponent(String(args.limit))}`;

  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok || !data?.ok) {
    console.error('Failed to fetch the tail:', data?.error || resp.statusText);
    process.exit(1);
  }
  if (!data.hasActiveSession) {
    console.error('No active session for this chat (empty tail).');
    process.exit(1);
  }

  const tail = typeof data.tail === 'string' ? data.tail : '';
  if (!tail) {
    console.error('The tail is empty.');
    process.exit(1);
  }

  const scenario = buildScenarioTemplate(args.chatId, tail);
  console.log('--- Captured tail (JSON escaped) ---');
  console.log(JSON.stringify(tail));
  console.log('\n--- Suggested flow scenario ---');
  console.log(JSON.stringify(scenario, null, 2));
  console.log('\n--- Parsed preview ---');
  console.log(JSON.stringify({ state: data.state, parsed: data.parsed }, null, 2));
}

main().catch((err) => {
  console.error('Error:', err?.message || String(err));
  process.exit(1);
});

