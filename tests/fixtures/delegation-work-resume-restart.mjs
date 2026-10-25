import { randomUUID } from 'node:crypto';
import { listChatHistoryHeadSeqs } from '../../lib/persist/chat-history-service.js';
import { seedChatHistoryRevisionsFromIndex } from '../../lib/persist/chat-history-revisions.js';
import { createDelegationService, finishDelegation } from '../../lib/delegation-service.js';
import { registerMockChatRunAdapter, patchMockChatRun } from '../../lib/chat-run/mock-adapter.ts';
import { stopDelegationRuntimeWorker } from '../../lib/delegation-runtime-worker.js';

const [parentChatId, leafId, workspace] = process.argv.slice(2);
seedChatHistoryRevisionsFromIndex(await listChatHistoryHeadSeqs());
registerMockChatRunAdapter('opencode');
stopDelegationRuntimeWorker();
const service = createDelegationService({ workspaceDirForAgent: () => workspace, dataDir: workspace, isModelAvailable: () => true });
const result = await service.createAndStart({
  parentChatId,
  sourceKind: 'text',
  taskText: `Restart probe ${randomUUID()}`,
  executor: { transport: 'opencode', model: 'opencode/test' },
  idempotencyKey: randomUUID(),
  leafId,
  resumeRounds: true,
  returnWhenStarting: false,
  assignment: 'implement',
  executionMode: 'agent',
});
const output = { ok: result.ok, childChatId: result.delegation?.childChatId, sessionResume: result.delegation?.sessionResume };
if (result.delegation) {
  patchMockChatRun(result.delegation.childChatId, { busy: false });
  finishDelegation(result.delegation, { status: 'completed', report: 'TASK: implement\nVERDICT: PASS\nRestart probe.' });
}
process.stdout.write(JSON.stringify(output));
