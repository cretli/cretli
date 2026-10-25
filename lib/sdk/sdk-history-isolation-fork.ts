/**
 * Isolated Ask vs Delegations seed used by the production fork path.
 * Import only after CRETLI_DATA_DIR points at a scratch directory.
 */

import fs from 'fs';
import path from 'path';
import { formatChatHistoryEventsToText } from '../context-compression.js';
import { executeConversationFork } from '../conversation-fork-execute.js';
import { appendChatHistoryEvents, loadChatHistory } from '../persist/chat-history-service.js';
import { addChat, loadChats } from '../persist/chats-persist.js';
import { HISTORY_ISOLATION_MARKER } from './sdk-history-isolation.ts';

export const ASK_TASK_USER =
  'Put Plan, Agent, and Ask into one dropdown on the send bar. Keep Ask read-only.';
export const ASK_TASK_ASSISTANT =
  'I will merge the three mode buttons into a single Plan / Agent / Ask control on the send bar.';
export const ASK_TASK_LATER = 'Also add a keyboard shortcut for switching the dropdown.';
export const DELEGATION_TASK_USER =
  'Finish mailbox delegation replies and the parent inbox queue.';
export const DELEGATION_TASK_ASSISTANT =
  'Delegation stage 1 is unfinished: mailbox arrows still need the queued-mail path.';

export const ASK_FORK_CUTOFF_AT = '2026-09-06T10:00:02.000Z';
const ASK_T1 = '2026-09-06T10:00:01.000Z';
const ASK_T3 = '2026-09-06T10:00:03.000Z';
const DEL_T1 = '2026-09-06T10:00:04.000Z';
const DEL_T2 = '2026-09-06T10:00:05.000Z';

// The JSDoc of executeConversationFork types `chat` as a bare `object`, and addChat's
// `extras` omits `agentTransport`; narrow both locally (tsc: TS2339 / TS2353).
type ForkChat = { id: string; forkParentChatId?: string };
type ConversationFork = Omit<Awaited<ReturnType<typeof executeConversationFork>>, 'chat'> & { chat: ForkChat };
type AddChatExtras = NonNullable<Parameters<typeof addChat>[5]> & { agentTransport?: string };
const executeConversationForkLoose = executeConversationFork as unknown as (
  input: Parameters<typeof executeConversationFork>[0],
) => Promise<ConversationFork>;
type SeededChat = ReturnType<typeof addChat>;
const addChatLoose = addChat as unknown as (
  cursorSessionId: string,
  title: string,
  workspaceFile: string | undefined,
  workspaceFolder: string,
  model: string,
  extras: AddChatExtras,
) => SeededChat;

export async function seedAndExecuteAskDelegationFork(input: {
  workspaceFolder: string;
  extraTranscriptAbs?: string;
}): Promise<{
  ask: SeededChat;
  delegation: SeededChat;
  askSourceText: string;
  fullFork: ConversationFork;
  partialFork: ConversationFork;
  parentAfter: (ReturnType<typeof loadChats>[number] & { forkParentChatId?: string }) | undefined;
  fullCopiedText: string;
  partialCopiedText: string;
}> {
  const workspaceFolder = String(input?.workspaceFolder || '').trim();
  if (!workspaceFolder) throw new TypeError('workspaceFolder is required');
  const ask = addChatLoose('sess-ask-iso', 'Ask', undefined, workspaceFolder, 'auto', { agentTransport: 'sdk' });
  const delegation = addChatLoose('sess-del-iso', 'Delegations', undefined, workspaceFolder, 'auto', {
    agentTransport: 'sdk',
  });
  await appendChatHistoryEvents(ask.id, ask.cursorSessionId, [
    { rec: { kind: 'localUser', text: ASK_TASK_USER, createdAt: ASK_T1 } },
    {
      rec: {
        kind: 'sdk',
        event: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: ASK_TASK_ASSISTANT }] },
        },
        createdAt: ASK_FORK_CUTOFF_AT,
      },
    },
    { rec: { kind: 'localUser', text: ASK_TASK_LATER, createdAt: ASK_T3 } },
  ]);
  await appendChatHistoryEvents(delegation.id, delegation.cursorSessionId, [
    { rec: { kind: 'localUser', text: DELEGATION_TASK_USER, createdAt: DEL_T1 } },
    {
      rec: {
        kind: 'sdk',
        event: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: DELEGATION_TASK_ASSISTANT }] },
        },
        createdAt: DEL_T2,
      },
    },
  ]);
  const extraTranscriptAbs = String(input?.extraTranscriptAbs || '').trim();
  if (extraTranscriptAbs) {
    fs.mkdirSync(path.dirname(extraTranscriptAbs), { recursive: true });
    fs.writeFileSync(
      extraTranscriptAbs,
      `${JSON.stringify({ text: `${HISTORY_ISOLATION_MARKER} ${DELEGATION_TASK_ASSISTANT}` })}\n`,
      'utf8',
    );
    const later = Date.now() + 60_000;
    fs.utimesSync(extraTranscriptAbs, later / 1000, later / 1000);
  }
  const askSourceText = formatChatHistoryEventsToText((await loadChatHistory(ask.id))?.events || []);
  const fullFork = await executeConversationForkLoose({
    parentChat: ask,
    sourceText: askSourceText,
  });
  const partialFork = await executeConversationForkLoose({
    parentChat: ask,
    upToCreatedAt: ASK_FORK_CUTOFF_AT,
  });
  const parentAfter = loadChats().find((entry) => entry.id === ask.id);
  return {
    ask,
    delegation,
    askSourceText,
    fullFork,
    partialFork,
    parentAfter,
    fullCopiedText: formatChatHistoryEventsToText((await loadChatHistory(fullFork.chat.id))?.events || []),
    partialCopiedText: formatChatHistoryEventsToText((await loadChatHistory(partialFork.chat.id))?.events || []),
  };
}
