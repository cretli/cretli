#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export const DEMO_TITLES = [
  'Fix failing login test', 'Add dark mode toggle', 'Document the REST endpoints',
  'Speed up product search', 'Review checkout flow',
];
export const DEMO_CHAT_IDS = DEMO_TITLES.map((_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);

/** Seed only through the supported persistence APIs, before the server starts. */
export async function seedDemoStores({ workspaceFile, workspaceFolder }) {
  if (!process.env.CRETLI_DATA_DIR) throw new Error('CRETLI_DATA_DIR is required for demo isolation');
  const { addChat } = await import('../../lib/persist/chats-persist.js');
  const { appendChatHistoryEvents, loadChatHistory } = await import('../../lib/persist/chat-history-persist.js');
  const { createDelegationRecord, loadDelegationsReadonly, updateDelegationRecord } = await import('../../lib/persist/delegations-persist.js');
  const { appendUsageEvent, readUsageEvents } = await import('../../lib/persist/usage-persist.js');
  const { createUsageEvent } = await import('../../lib/usage/usage-event.js');
  for (const [i, title] of DEMO_TITLES.entries()) {
    const id = DEMO_CHAT_IDS[i];
    const session = '';
    addChat(session, title, workspaceFile, workspaceFolder, 'demo-model', { id, agentTransport: 'codex' });
    const records = [
      { kind: 'localUser', text: `Please help with this task: ${title}. Keep the change small and run the focused tests.` },
      { kind: 'sdk', event: { type: 'tool_call', name: 'Read', status: 'completed', arguments: { path: 'src/login.js' }, result: 'Read the application source and the related tests.' } },
      { kind: 'sdk', event: { type: 'assistant', message: { content: [{ type: 'text', text: `## ${title}\n\nI checked the implementation and updated the focused test.\n\n- The change follows the existing patterns.\n- All 12 focused tests passed.\n\nThe update is ready for review.` }] } } },
      { kind: 'meta', variant: 'runFinished' },
    ];
    if (loadChatHistory(id)?.headSeq >= records.length) continue;
    const result = appendChatHistoryEvents(id, session, records.map((rec, n) => ({ rec, clientSeq: n + 1 })));
    if (!result.ok) throw new Error(`Demo history failed: ${JSON.stringify(result)}`);
  }
  const delegationId = '00000000-0000-4000-8000-000000000010';
  if (!loadDelegationsReadonly().some((row) => row.id === delegationId)) {
    createDelegationRecord({ id: delegationId, parentChatId: DEMO_CHAT_IDS[4], childChatId: DEMO_CHAT_IDS[0], workspaceFolder, assignment: 'implement', status: 'completed' });
    updateDelegationRecord(delegationId, { report: 'Updated the login test. All 12 focused tests passed.', reportSummary: 'Login test updated', finishedAt: new Date().toISOString() });
  }
  const dataDir = process.env.CRETLI_DATA_DIR;
  const existing = new Set(readUsageEvents({ dataDir, from: '2020-01-01T00:00:00.000Z' }).map((row) => row.id));
  for (let i = 0; i < 8; i += 1) {
    const id = `demo-usage-${i}`;
    if (existing.has(id)) continue;
    appendUsageEvent(createUsageEvent({ id, at: new Date(Date.now() - i * 20 * 3600000).toISOString(), provider: 'openai', feature: 'chat', harness: 'codex', model: 'demo-model', chatId: DEMO_CHAT_IDS[i % 5], workspaceFile, tokens: { textInput: 1200 + i * 150, textOutput: 450 + i * 80 }, reportedUsd: 0.012 + i * 0.002 }), { dataDir });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seedDemoStores({ workspaceFile: process.argv[2], workspaceFolder: process.argv[3] });
}
