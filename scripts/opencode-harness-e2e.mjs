/**
 * Live OpenCode harness smoke test — requires a Zen or Z.AI API key and opencode binary.
 * Exit 0 = prompt returned assistant text without user echo.
 */
import assert from 'node:assert/strict';
import { getOrCreateOpenCodeInstance } from '../lib/opencode/opencode-server-manager.js';
import { OpenCodeMessageRegistry } from '../lib/agent-harness/opencode-message-registry.js';
import { processOpenCodeStreamEventForHarness } from '../lib/agent-harness/opencode-event-normalizer.js';
import { extractAssistantPlainText } from '../app_front/lib/sdk-chat-format.js';
import { hasOpenCodeCredentials } from '../lib/opencode/opencode-api-key.js';
import { resolveOpenCodeModelForPrompt } from '../lib/opencode/opencode-model-resolve.js';
import { buildOpenCodePermissionSdkEvent } from '../lib/opencode/opencode-permission.js';
import { isPlanModeMutatingSdkEvent } from '../lib/sdk/sdk-plan-guard.js';

assert.ok(typeof buildOpenCodePermissionSdkEvent === 'function');
assert.equal(isPlanModeMutatingSdkEvent({ type: 'tool_call', name: 'write', status: 'running' }), true);

const folder = process.argv[2] || process.cwd();
const prompt = process.argv[3] || 'Reply with exactly: OK harness';
const model = resolveOpenCodeModelForPrompt(process.argv[4] || 'opencode/x-preview-f-free');

if (!hasOpenCodeCredentials()) {
  console.error('SKIP: no OpenCode Zen or Z.AI API key');
  process.exit(2);
}

const slash = model.indexOf('/');
const providerID = model.slice(0, slash);
const modelID = model.slice(slash + 1);

/** @type {import('@opencode-ai/sdk').OpencodeClient | null} */
let client = null;
/** @type {(() => void) | null} */
let release = null;

try {
  const inst = await getOrCreateOpenCodeInstance({ workspaceFolder: folder });
  client = inst.client;
  release = inst.release;
  const created = await client.session.create({
    query: { directory: folder },
    body: { title: 'cretli harness e2e' },
  });
  const sessionId = created?.data?.id ?? created?.id;
  if (!sessionId) throw new Error('session.create returned no id');

  const registry = new OpenCodeMessageRegistry();
  /** @type {string[]} */
  const assistantChunks = [];
  let sawUserEchoInAssistant = false;

  const sub = await client.event.subscribe();
  const stream = sub?.stream || sub?.data?.stream;
  if (!stream) throw new Error('event subscription unavailable');

  const consume = (async () => {
    for await (const event of stream) {
      const sdkEvents = processOpenCodeStreamEventForHarness(event, {
        opencodeSessionId: sessionId,
        messageRegistry: registry,
        lastUserPromptText: prompt,
      });
      for (const sdkEvent of sdkEvents) {
        if (sdkEvent.type !== 'assistant') continue;
        const text = extractAssistantPlainText(sdkEvent);
        if (!text) continue;
        if (text.includes(prompt)) sawUserEchoInAssistant = true;
        assistantChunks.push(text);
      }
      if (event?.type === 'session.idle' || event?.type === 'session.error') break;
    }
  })();

  await client.session.promptAsync({
    path: { id: sessionId },
    query: { directory: folder },
    body: {
      parts: [{ type: 'text', text: prompt }],
      model: { providerID, modelID },
    },
  });

  await Promise.race([
    consume,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 90s')), 90000)),
  ]);

  const assistantText = assistantChunks.join('');
  console.log(JSON.stringify({
    ok: assistantText.length > 0 && !sawUserEchoInAssistant,
    assistantText: assistantText.slice(0, 500),
    sawUserEchoInAssistant,
    model,
  }, null, 2));

  if (!assistantText.trim()) {
    console.error('FAIL: empty assistant response');
    process.exit(1);
  }
  if (sawUserEchoInAssistant) {
    console.error('FAIL: assistant output echoed user prompt');
    process.exit(1);
  }
  console.log('opencode-harness-e2e OK');
} catch (err) {
  console.error('FAIL:', err?.message || err);
  process.exit(1);
} finally {
  release?.();
}
