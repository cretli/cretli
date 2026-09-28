/**
 * Live OpenCode harness smoke test — requires an API key for a configured
 * provider and the opencode binary. Exit 0 = assistant text returned and the
 * reported provider/model matches the requested model when metadata is present.
 */
import assert from 'node:assert/strict';
import {
  disposeAllOpenCodeInstances,
  getOrCreateOpenCodeInstance,
} from '../lib/opencode/opencode-server-manager.js';
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
  console.error('SKIP: no OpenCode Zen, Z.AI, or MiMo API key');
  process.exitCode = 2;
  process.exit();
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
  const observedToolCalls = [];
  let sawUserEchoInAssistant = false;
  let observedModel = '';

  const sub = await client.event.subscribe();
  const stream = sub?.stream || sub?.data?.stream;
  if (!stream) throw new Error('event subscription unavailable');

  const consume = (async () => {
    for await (const event of stream) {
      if (event?.type === 'message.updated') {
        const info = event?.properties?.info;
        if (info?.role === 'assistant' && info.providerID && info.modelID) {
          observedModel = `${info.providerID}/${info.modelID}`;
        }
      }
      const sdkEvents = processOpenCodeStreamEventForHarness(event, {
        opencodeSessionId: sessionId,
        messageRegistry: registry,
        lastUserPromptText: prompt,
      });
      for (const sdkEvent of sdkEvents) {
        if (sdkEvent.type === 'tool_call') {
          observedToolCalls.push({ name: sdkEvent.name, status: sdkEvent.status });
          continue;
        }
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

  let timeoutHandle;
  try {
    await Promise.race([
      consume,
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('timeout 90s')), 90000);
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!observedModel) {
    const messagesResult = await client.session.messages({
      path: { id: sessionId },
      query: { directory: folder },
    });
    const messagesPayload = messagesResult?.data ?? messagesResult;
    const messages = Array.isArray(messagesPayload)
      ? messagesPayload
      : (Array.isArray(messagesPayload?.messages) ? messagesPayload.messages : []);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = messages[index]?.info;
      if (info?.role === 'assistant' && info.providerID && info.modelID) {
        observedModel = `${info.providerID}/${info.modelID}`;
        break;
      }
    }
  }

  const assistantText = assistantChunks.join('');
  console.log(JSON.stringify({
    ok: assistantText.length > 0 && !sawUserEchoInAssistant,
    assistantText: assistantText.slice(0, 500),
    sawUserEchoInAssistant,
    model,
    observedModel: observedModel || null,
    observedToolCalls,
  }, null, 2));

  if (!assistantText.trim()) {
    throw new Error('empty assistant response');
  }
  if (sawUserEchoInAssistant) {
    throw new Error('assistant output echoed user prompt');
  }
  if (providerID === 'cretli-mimo' && !observedModel) {
    throw new Error('OpenCode did not report the assistant provider/model; MiMo endpoint use could not be verified');
  }
  if (observedModel && observedModel !== model) {
    throw new Error(`OpenCode used ${observedModel}, expected ${model}`);
  }
  if (process.env.CRETLI_OPENCODE_REQUIRE_TOOL === '1'
    && !observedToolCalls.some((row) => row.status === 'completed')) {
    throw new Error('expected at least one completed tool call but observed none');
  }
  console.log('opencode-harness-e2e OK');
} catch (err) {
  console.error('FAIL:', err?.message || err);
  process.exitCode = 1;
} finally {
  release?.();
  // The manager keeps chat servers warm; a one-shot test should close its instance.
  disposeAllOpenCodeInstances();
}
