/**
 * chatTransport — opencodePermissionAdvisorStatus forwards full advisor payload.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transportSource = fs.readFileSync(
  path.join(projectRoot, 'app_front/features/chat/chatTransport.js'),
  'utf8',
);

const handlerStart = transportSource.indexOf("msg.type === 'opencodePermissionAdvisorStatus'");
assert.ok(handlerStart >= 0, 'advisor status handler missing');
const handlerSlice = transportSource.slice(handlerStart, handlerStart + 1200);

assert.match(handlerSlice, /showOpenCodePermissionAdvisorStatus/);
assert.match(handlerSlice, /advisoryAssessment/);
assert.match(handlerSlice, /alwaysAvailable/);
assert.match(handlerSlice, /advisorName/);
assert.match(handlerSlice, /advisorProtocol/);
assert.match(handlerSlice, /localRisk/);
assert.doesNotMatch(handlerSlice, /innerHTML/);

const pickStart = transportSource.indexOf("msg.type === 'opencodePermissionAdvisorPick'");
assert.ok(pickStart >= 0);
const pickSlice = transportSource.slice(pickStart, pickStart + 600);
assert.match(pickSlice, /showOpenCodePermissionAdvisorPick/);
assert.match(pickSlice, /applyAfterMs/);

const richView = fs.readFileSync(path.join(projectRoot, 'app_front/lib/sdk-rich-view.js'), 'utf8');
assert.match(richView, /openCodePermissionAdvisorMetaByRequestId\.delete\(id\)/);
assert.match(richView, /clearOpenCodeInteractiveMaps[\s\S]{0,120}openCodePermissionAdvisorMetaByRequestId\.clear/);

console.log('chat-transport-permission-advisor.test.js OK');
