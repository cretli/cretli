import { getOrCreateOpenCodeInstance } from '../lib/opencode/opencode-server-manager.js';
import { parseOpenCodeModel } from '../lib/agent-harness/opencode-event-normalizer.js';

const folder = process.argv[2] || process.cwd();
const modelString = process.argv[3] || 'opencode/x-preview-f-free';

const inst = await getOrCreateOpenCodeInstance({ workspaceFolder: folder });
try {
  const created = await inst.client.session.create({
    query: { directory: folder },
    body: { title: 'cretli test' },
  });
  const sessionId = created?.data?.id ?? created?.id;
  console.log('session', sessionId, 'model', modelString);
  const parsed = parseOpenCodeModel(modelString);
  await inst.client.session.promptAsync({
    path: { id: sessionId },
    query: { directory: folder },
    body: {
      parts: [{ type: 'text', text: 'Say hi in one word' }],
      ...(parsed ? { model: { providerID: parsed.providerID, modelID: parsed.modelID } } : {}),
    },
  });
  const sub = await inst.client.event.subscribe();
  const stream = sub?.stream || sub?.data?.stream;
  const deadline = Date.now() + 60000;
  for await (const event of stream) {
    if (Date.now() > deadline) break;
    const t = event?.type;
    if (t === 'session.error') {
      console.log('ERROR', JSON.stringify(event));
      break;
    }
    if (t === 'message.part.updated') {
      const delta = event?.properties?.delta;
      if (delta) process.stdout.write(delta);
    }
    if (t === 'session.idle') {
      console.log('\nidle');
      break;
    }
  }
} finally {
  inst.release();
}
