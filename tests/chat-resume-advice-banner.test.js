import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildForkInitialPrompt, resolvePendingInheritedSend } from '../lib/conversation-fork.js';
import { createSendBarContextStack } from '../app_front/features/sendBar/sendBarContextStack.js';
import { createReferenceChat } from '../app_front/features/chat/chatReferenceFork.js';
import {
  createResumeAdviceController,
  createResumeAdviceScheduler,
  createResumeAdviceDismissals,
  renderResumeAdviceHtml,
} from '../app_front/features/chat/chatResumeAdviceBanner.js';
import { readChatSource } from './helpers/chatSource.js';

const t = (key, params = {}) => `${key}${Object.keys(params).length ? JSON.stringify(params) : ''}`;
const formatUsd = (usd) => `$${usd.toFixed(2)}`;
const advice = (over = {}) => ({ show: true, enabled: true, contextTokens: 250_000, lastCachedTurnAt: 1000, estimatedRewriteUsd: 1.25, ...over });

function fakeStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
}

function fakeHost() {
  const listeners = [];
  return {
    hidden: true, innerHTML: '',
    addEventListener: (_n, fn) => listeners.push(fn),
    click(action) {
      const button = { getAttribute: () => action };
      for (const fn of listeners) fn({ target: { closest: () => button } });
    },
  };
}

function setup({ res = { ok: true, advice: advice() }, onReference = async () => ({ ok: true }), storage = fakeStorage() } = {}) {
  const host = fakeHost();
  const calls = { reference: 0 };
  const api = { getUsageResumeAdvice: async () => { if (res instanceof Error) throw res; return res; } };
  const controller = createResumeAdviceController({
    api, storage, t, formatUsd, getHost: () => host,
    onReference: async (chat, options) => { calls.reference += 1; return onReference(chat, options); },
  });
  return { host, controller, calls, api, storage };
}

test('renders priced and unpriced variants', () => {
  const priced = renderResumeAdviceHtml(advice(), t, formatUsd);
  assert.match(priced, /250k/);
  assert.match(priced, /chat\.resumeAdviceCost/);
  const unpriced = renderResumeAdviceHtml(advice({ estimatedRewriteUsd: null }), t, formatUsd);
  assert.doesNotMatch(unpriced, /resumeAdviceCost/);
  assert.equal(renderResumeAdviceHtml(advice({ enabled: false }), t, formatUsd), '');
  assert.equal(renderResumeAdviceHtml(advice({ show: false }), t, formatUsd), '');
});

test('dismissal survives re-render and a new cached turn shows it again', async () => {
  const { host, controller } = setup();
  const chat = { id: 'c1' };
  await controller.check(chat);
  assert.equal(host.hidden, false);
  host.click('send');
  assert.equal(host.hidden, true);
  await controller.check(chat);
  assert.equal(host.hidden, true);
  const next = setup({ res: { ok: true, advice: advice({ lastCachedTurnAt: 2000 }) }, storage: fakeStorage() });
  const dismissals = createResumeAdviceDismissals(next.storage);
  dismissals.dismiss('c1', 1000);
  await next.controller.check(chat);
  assert.equal(next.host.hidden, false);
});

test('reference action calls onReference and dismisses on success', async () => {
  const { host, controller, calls } = setup();
  await controller.check({ id: 'c1' });
  host.click('reference');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.reference, 1);
  assert.equal(host.hidden, true);
});

test('409 shows an inline hint and keeps the banner', async () => {
  const { host, controller } = setup({ onReference: async () => ({ ok: false, code: 'reference_requires_saved_history' }) });
  await controller.check({ id: 'c1' });
  host.click('reference');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.hidden, false);
  assert.match(host.innerHTML, /chat\.resumeAdviceNoHistory/);
});

test('disabled, 403 and network errors render nothing', async () => {
  for (const res of [{ ok: true, advice: advice({ show: false, enabled: false }) }, { ok: false, error: 'Forbidden' }, new Error('network')]) {
    const { host, controller } = setup({ res });
    await controller.check({ id: 'c1' });
    assert.equal(host.hidden, true);
    assert.equal(host.innerHTML, '');
  }
});

test('actions use cr-bar-button primitives', () => {
  const html = renderResumeAdviceHtml(advice(), t, formatUsd);
  assert.match(html, /<cr-bar-button variant="primary" data-resume-advice-action="reference">/);
  assert.doesNotMatch(html, /<button/);
});

test('a second reference click while the fork is pending is ignored', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { host, controller, calls } = setup({ onReference: () => gate.then(() => ({ ok: true })) });
  await controller.check({ id: 'c1' });
  host.click('reference');
  host.click('reference');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.reference, 1);
});

test('non-409 failures show a generic hint; sync failure shows the sync hint', async () => {
  for (const [code, key] of [['fork_failed', 'chat.resumeAdviceForkFailed'], ['sync_failed', 'sendBar.forkSyncFailed']]) {
    const { host, controller } = setup({ onReference: async () => ({ ok: false, code }) });
    await controller.check({ id: 'c1' });
    host.click('reference');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.hidden, false);
    assert.match(host.innerHTML, new RegExp(key.replace('.', '\\.')));
  }
});

test('a response that arrives after hide() does not repaint the banner', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const host = fakeHost();
  const controller = createResumeAdviceController({
    api: { getUsageResumeAdvice: () => gate }, storage: fakeStorage(), t, formatUsd,
    getHost: () => host, onReference: async () => ({ ok: true }),
  });
  const chat = { id: 'c1' };
  const pending = controller.check(chat);
  controller.hide(chat);
  release({ ok: true, advice: advice() });
  await pending;
  assert.equal(host.hidden, true);
  assert.equal(host.innerHTML, '');
});

test('hide() drops a stale banner without dismissing the episode', async () => {
  const { host, controller } = setup();
  const chat = { id: 'c1' };
  await controller.check(chat);
  controller.hide(chat);
  assert.equal(host.hidden, true);
  assert.equal(controller.isDismissed('c1', 1000), false);
});

test('createReferenceChat flushes pending push before forking with mode reference and moves the draft', async () => {
  const order = [];
  const opened = [];
  const base = {
    flushPendingPush: async () => { order.push('flush'); return true; },
    postChatFork: async (id, payload) => { order.push(`fork:${payload.mode}:${payload.message || ''}`); return { ok: true, chat: { id: 'n1' }, initialPrompt: 'P' }; },
    pinCreatedChat: async () => { order.push('pin'); },
    fillMissingContext: () => {},
    readDraft: () => '  my draft ',
    clearDraft: () => { order.push('clear'); },
    openForkChat: (chat, prompt, display, options) => { opened.push([chat.id, prompt, display, options.carriedDraft]); },
    defaultDisplayText: 'DEFAULT',
  };
  const parent = { id: 'p1', cursorSessionId: 's1' };
  assert.deepEqual(await createReferenceChat(parent, base), { ok: true });
  assert.deepEqual(order, ['flush', 'fork:reference:', 'pin', 'clear']);
  assert.deepEqual(opened, [['n1', 'P', 'my draft', true]]);
  // Empty draft falls back to the default text.
  opened.length = 0;
  await createReferenceChat(parent, { ...base, readDraft: () => '' });
  assert.equal(opened[0][2], 'DEFAULT');
  assert.equal(opened[0][3], false);
});

test('a carried draft reaches the first payload exactly once, edited or not', () => {
  const initialPrompt = buildForkInitialPrompt({
    fromHarness: 'claude', toHarness: 'claude', sourceChatId: 'p1', historyPointer: true,
  });
  // chat.js clears the default display text when a draft is carried over.
  const unchanged = resolvePendingInheritedSend(initialPrompt, '', 'my draft');
  assert.equal(unchanged.payloadText.match(/my draft/g).length, 1);
  assert.match(unchanged.payloadText, /chat_history/);
  const edited = resolvePendingInheritedSend(initialPrompt, '', 'my edited draft');
  assert.equal(edited.payloadText.match(/New user message/g).length, 1);
  assert.doesNotMatch(edited.payloadText, /my draft/);
  // Without a draft the default display text keeps the plain inherited prompt.
  assert.equal(resolvePendingInheritedSend(initialPrompt, 'DEFAULT', 'DEFAULT').payloadText, initialPrompt.trim());
});

test('createReferenceChat keeps the parent draft on failures', async () => {
  let cleared = false;
  const deps = {
    flushPendingPush: async () => true,
    postChatFork: async () => ({ ok: false, code: 'reference_requires_saved_history' }),
    pinCreatedChat: async () => {}, fillMissingContext: () => {}, readDraft: () => 'draft',
    clearDraft: () => { cleared = true; }, openForkChat: () => {}, defaultDisplayText: 'D',
  };
  assert.deepEqual(await createReferenceChat({ id: 'p' }, deps), { ok: false, code: 'reference_requires_saved_history' });
  assert.deepEqual(await createReferenceChat({ id: 'p' }, { ...deps, flushPendingPush: async () => false }), { ok: false, code: 'sync_failed' });
  assert.equal((await createReferenceChat({ id: 'p' }, { ...deps, postChatFork: async () => { throw new Error('x'); } })).code, 'network_error');
  assert.equal(cleared, false);
});

test('chat.js wires inline advice outside the composer and replayed stream', () => {
  const source = readChatSource();
  assert.match(source, /container\.appendChild\(resumeAdviceHost\)/);
  assert.ok(source.indexOf('container.appendChild(resumeAdviceHost)') > source.indexOf('chat._sdkRichView = createSdkRichView'));
  assert.doesNotMatch(source, /sendBar\.addContextItem\(resumeAdviceHost\)/);
  assert.match(source, /hideChatResumeAdvice\(chat\);[\s\S]{0,600}?sendTextToAgent\(chat, payloadText/);
  assert.doesNotMatch(source, /RESUME_ADVICE_HARNESSES/);
  assert.match(source, /hasProtocolAgentRun\(chat\) \|\| getChatAgentState\(chat\) === 'active'/);
  assert.match(source, /createReferenceChat\(parentChat, \{/);
  assert.match(source, /getChatResumeAdviceScheduler\(\)\.reset\(chat\)/);
  assert.match(source, /syncContextStack\?\.\(\)/);
  const bar = fs.readFileSync(new URL('../app_front/features/sendBar/views/sendBar.js', import.meta.url), 'utf8');
  assert.match(bar, /addItem;/);
});

test('context stack: empty stack shows with the banner, hides on dismissal, coexists with chip and attachments', () => {
  const stack = { hidden: true, prepend() {} };
  const chip = { hidden: true };
  const attachments = { hidden: true };
  let layoutChanges = 0;
  const state = createSendBarContextStack({ stack, members: [chip, attachments], onChange: () => { layoutChanges += 1; } });
  const banner = { hidden: true };
  state.addItem(banner);
  assert.equal(stack.hidden, true);
  banner.hidden = false;
  state.sync();
  assert.equal(stack.hidden, false);
  banner.hidden = true;
  state.sync();
  assert.equal(stack.hidden, true);
  // Coexistence: attachments keep the stack visible when the banner goes away.
  attachments.hidden = false;
  banner.hidden = false;
  state.sync();
  banner.hidden = true;
  state.sync();
  assert.equal(stack.hidden, false);
  attachments.hidden = true;
  chip.hidden = false;
  state.sync();
  assert.equal(stack.hidden, false);
  assert.ok(layoutChanges >= 6);
});

test('painting the banner notifies the layout owner so the stack can be re-evaluated', async () => {
  const seen = [];
  const host = fakeHost();
  const controller = createResumeAdviceController({
    api: { getUsageResumeAdvice: async () => ({ ok: true, advice: advice() }) }, storage: fakeStorage(), t, formatUsd,
    getHost: () => host, onLayoutChange: (h) => seen.push([h === host, h.hidden]), onReference: async () => ({ ok: true }),
  });
  await controller.check({ id: 'c1' });
  host.click('send');
  assert.deepEqual(seen, [[true, false], [true, true]]);
});

test('scheduler request counts: idle select/focus, repeats, generation, recheck, reset', async () => {
  let time = 1_000_000;
  let busy = false;
  let reason = 'cache_warm';
  let show = false;
  let requests = 0;
  const chat = { id: 'c1' };
  const scheduler = createResumeAdviceScheduler({
    now: () => time, isBusy: () => busy,
    check: async () => { requests += 1; return { reason, show }; },
  });
  busy = true;
  assert.equal(await scheduler.request(chat), false);
  assert.equal(requests, 0, 'nothing is requested while generating');
  busy = false;
  assert.equal(await scheduler.request(chat), true);
  assert.equal(await scheduler.request(chat), false, 'repeat focus right after select');
  assert.equal(requests, 1);
  time += 31_000;
  assert.equal(await scheduler.request(chat), true, 'warm result is re-checked after 30 s');
  reason = 'below_threshold';
  time += 31_000;
  await scheduler.request(chat);
  time += 60_000;
  assert.equal(await scheduler.request(chat), false, 'other no-show results wait 5 minutes');
  time += 5 * 60_000;
  assert.equal(await scheduler.request(chat), true);
  show = true;
  time += 5 * 60_000;
  await scheduler.request(chat);
  time += 60 * 60_000;
  assert.equal(await scheduler.request(chat), false, 'visible banner is not re-requested');
  scheduler.reset(chat);
  assert.equal(await scheduler.request(chat), true, 'send resets the gate');
  reason = 'ttl_unknown';
  show = false;
  scheduler.reset(chat);
  await scheduler.request(chat);
  time += 24 * 60 * 60_000;
  assert.equal(await scheduler.request(chat), false, 'unsupported chats are never asked again');
});

test('scheduler does not stamp a result without a host and ignores results from before reset', async () => {
  let time = 0;
  let result = null;
  const chat = {};
  const scheduler = createResumeAdviceScheduler({ now: () => time, isBusy: () => false, check: async () => result });
  assert.equal(await scheduler.request(chat), true);
  assert.equal(await scheduler.request(chat), true, 'no host: not throttled');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = createResumeAdviceScheduler({ now: () => time, isBusy: () => false, check: () => gate });
  const pending = slow.request(chat);
  slow.reset(chat);
  release({ reason: 'ttl_unknown', show: false });
  await pending;
  assert.equal(await slow.request(chat), true, 'stale result does not stamp');
});

test('close dismisses this cache episode without forking or sending', async () => {
  const { host, controller, calls } = setup();
  const chat = { id: 'c1' };
  await controller.check(chat);
  assert.match(host.innerHTML, /<cr-icon-button[^>]+data-resume-advice-action="dismiss"[^>]+aria-label="chat\.resumeAdviceDismiss"/);
  host.click('dismiss');
  assert.equal(host.hidden, true);
  assert.equal(calls.reference, 0);
  await controller.check(chat);
  assert.equal(host.hidden, true);
  assert.equal(controller.isDismissed(chat.id, 1000), true);
});

test('an in-flight check cannot reopen advice after it was closed', async () => {
  const { host, controller, api } = setup();
  const chat = { id: 'c1' };
  await controller.check(chat);
  let release;
  api.getUsageResumeAdvice = () => new Promise((resolve) => { release = resolve; });
  const checking = controller.check(chat);
  host.click('dismiss');
  release({ ok: true, advice: advice({ lastCachedTurnAt: 2000 }) });
  await checking;
  assert.equal(host.hidden, true);
});

test('inline advice follows the bottom but preserves reading older messages', async () => {
  const { host, controller } = setup();
  const chat = { id: 'c1' };
  const scrollContainer = { clientHeight: 500, scrollTop: 500 };
  Object.defineProperty(scrollContainer, 'scrollHeight', { get: () => host.hidden ? 1000 : 1200 });
  host.parentElement = scrollContainer;
  await controller.check(chat);
  assert.equal(scrollContainer.scrollTop, 1200);
  controller.hide(chat);
  scrollContainer.scrollTop = 100;
  await controller.check(chat);
  assert.equal(scrollContainer.scrollTop, 100);
});

test('summary action shows its estimated cost and calls the model path only on click', async () => {
  const summaryAdvice = advice({ estimatedSummaryTokens: 12_000, estimatedSummaryUsd: 0.0123 });
  const html = renderResumeAdviceHtml(summaryAdvice, t, formatUsd);
  assert.match(html, /data-resume-advice-action="summary"/);
  assert.match(html, /chat\.resumeAdviceSummary\b/);
  assert.match(html, /chat\.resumeAdviceSummaryCost\{&quot;tokens&quot;:&quot;12k&quot;,&quot;cost&quot;:&quot;\$0\.01&quot;\}/);
  const unpriced = renderResumeAdviceHtml(advice({ estimatedSummaryTokens: 12_000, estimatedSummaryUsd: null }), t, formatUsd);
  assert.match(unpriced, /resumeAdviceSummaryCostUnpriced/);
  assert.doesNotMatch(renderResumeAdviceHtml(advice(), t, formatUsd), /action="summary"/);

  const seen = [];
  const { host, controller } = setup({
    res: { ok: true, advice: summaryAdvice },
    onReference: async (_chat, options) => { seen.push(options); return { ok: true }; },
  });
  await controller.check({ id: 'c1' });
  assert.deepEqual(seen, [], 'rendering the banner calls nothing');
  host.click('summary');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [{ withSummary: true }]);
});

test('createReferenceChat with summary posts to the summary route and surfaces a fallback error', async () => {
  const calls = { plain: 0, summary: 0, fallback: [] };
  const deps = {
    flushPendingPush: async () => true,
    postChatFork: async () => { calls.plain += 1; return { ok: true, chat: { id: 'n' }, initialPrompt: 'p' }; },
    postChatForkWithSummary: async () => {
      calls.summary += 1;
      return { ok: true, chat: { id: 'n' }, initialPrompt: 'p', summaryFallback: { code: 'summary_provider_error', error: 'provider down' } };
    },
    onSummaryFallback: (info) => calls.fallback.push(info),
    pinCreatedChat: async () => {},
    fillMissingContext: () => {},
    readDraft: () => '',
    clearDraft: () => {},
    openForkChat: () => {},
    defaultDisplayText: 'x',
  };
  const result = await createReferenceChat({ id: 'p1' }, deps, { withSummary: true });
  assert.equal(result.ok, true);
  assert.deepEqual([calls.plain, calls.summary], [0, 1]);
  assert.deepEqual(calls.fallback, [{ code: 'summary_provider_error', error: 'provider down' }]);
  await createReferenceChat({ id: 'p1' }, deps);
  assert.equal(calls.plain, 1, 'plain reference path is unchanged');
});
