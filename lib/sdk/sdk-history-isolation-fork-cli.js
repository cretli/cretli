#!/usr/bin/env node
/**
 * Run the production Ask-fork path in a child process whose CRETLI_DATA_DIR
 * is already a scratch directory (set by the parent). Never import this from
 * a process that already loaded persist against production data/.
 */

import fs from 'fs';
import { seedAndExecuteAskDelegationFork } from './sdk-history-isolation-fork.js';

const payloadPath = process.argv[2];
if (!payloadPath) {
  console.error('usage: sdk-history-isolation-fork-cli.js <payload.json>');
  process.exit(2);
}
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
const seeded = await seedAndExecuteAskDelegationFork({
  workspaceFolder: payload.workspaceFolder,
  extraTranscriptAbs: payload.extraTranscriptAbs,
});
const result = {
  parentChatId: seeded.ask.id,
  parentTitle: seeded.ask.title,
  parentStillPresent: Boolean(seeded.parentAfter),
  parentForkParentChatId: seeded.parentAfter?.forkParentChatId || null,
  delegationChatId: seeded.delegation.id,
  full: {
    chatId: seeded.fullFork.chat.id,
    forkParentChatId: seeded.fullFork.chat.forkParentChatId,
    copiedThroughSeq: seeded.fullFork.copiedThroughSeq,
    partial: seeded.fullFork.partial,
    initialPrompt: seeded.fullFork.initialPrompt,
    copiedText: seeded.fullCopiedText,
  },
  partial: {
    chatId: seeded.partialFork.chat.id,
    forkParentChatId: seeded.partialFork.chat.forkParentChatId,
    copiedThroughSeq: seeded.partialFork.copiedThroughSeq,
    partial: seeded.partialFork.partial,
    initialPrompt: seeded.partialFork.initialPrompt,
    copiedText: seeded.partialCopiedText,
  },
  askSourceText: seeded.askSourceText,
};
const resultPath = String(payload.resultPath || '');
if (!resultPath) {
  console.error('payload.resultPath is required');
  process.exit(2);
}
fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
