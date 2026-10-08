import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pushSource = readFileSync(path.join(root, 'lib', 'push.js'), 'utf8');
const wsRouterSource = readFileSync(path.join(root, 'lib', 'ws', 'ws-router.js'), 'utf8');
const agentFinishedSource = readFileSync(path.join(root, 'lib', 'agent-finished-push.js'), 'utf8');

assert.match(pushSource, /TTL: 3600/);
assert.match(pushSource, /urgency: 'high'/);
assert.match(pushSource, /stripPushPreferences\(sub\)/);
assert.match(pushSource, /sendNotification\(webPushSub, notificationPayload, sendOptions\)/);
assert.doesNotMatch(pushSource, /sendNotification\(sub,/);
assert.match(pushSource, /trimWebPushNotificationPayload/);
// The agent-finished payload is built by the shared module used by every harness.
assert.match(agentFinishedSource, /buildAgentFinishedPushData/);
assert.match(agentFinishedSource, /extractLatestAssistantTextFromHistoryStore/);
assert.match(wsRouterSource, /notifyAgentFinished/);
assert.doesNotMatch(wsRouterSource, /extractLatestAssistantTextFromChatHistory\(safeChatId\)/);

console.log('push-broadcast.test.js: ok');
