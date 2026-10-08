import assert from 'node:assert/strict';
import {
  browserToolAnnotations,
  chatHostToolAnnotations,
  hasSdkToolAnnotations,
  normalizeSdkToolAnnotations,
  pageToolAnnotations,
} from '../lib/sdk/sdk-tool-annotations.js';
import { BROWSER_AGENT_MUTATION_TOOLS, BROWSER_AGENT_READ_TOOLS } from '../lib/browser/agent-tools.js';

const normalized = normalizeSdkToolAnnotations({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  title: 'Sample',
  bogus: 'drop-me',
});
assert.equal(normalized?.readOnlyHint, true);
assert.equal(normalized?.destructiveHint, false);
assert.equal(normalized?.idempotentHint, true);
assert.equal(normalized?.openWorldHint, false);

const pageRead = pageToolAnnotations('page_dom', 'dom', 'DOM snapshot');
assert.equal(pageRead?.readOnlyHint, true);
assert.equal(pageRead?.destructiveHint, false);

const pageNav = pageToolAnnotations('page_navigate', 'navigate', 'Navigate');
assert.equal(pageNav?.destructiveHint, true);
assert.equal(pageNav?.openWorldHint, true);

const pin = chatHostToolAnnotations('chat_pin_url', 'Pin chat');
assert.equal(pin?.idempotentHint, true);
assert.equal(pin?.openWorldHint, true);

const browserRead = browserToolAnnotations(
  'browser_screenshot',
  BROWSER_AGENT_READ_TOOLS,
  BROWSER_AGENT_MUTATION_TOOLS,
  'Screenshot'
);
assert.equal(browserRead?.readOnlyHint, true);

const browserNav = browserToolAnnotations(
  'browser_navigate',
  BROWSER_AGENT_READ_TOOLS,
  BROWSER_AGENT_MUTATION_TOOLS,
  'Navigate'
);
assert.equal(browserNav?.openWorldHint, true);
assert.equal(browserNav?.readOnlyHint, false);

assert.equal(hasSdkToolAnnotations(undefined), false);
assert.equal(hasSdkToolAnnotations({ readOnlyHint: true }), true);

console.log('sdk-tool-annotations.test.js: ok');
