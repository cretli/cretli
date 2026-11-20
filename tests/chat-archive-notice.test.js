import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveNoticeProgress,
  createChatArchiveNoticeController,
  renderChatArchiveNoticeHtml,
} from '../app_front/features/chat/chatArchiveNotice.js';

// The controller only accepts `Element` click targets; node has no DOM.
globalThis.Element ??= class {};

const t = (key, params = {}) => `${key}${params.time ? `:${params.time}` : ''}${params.error ? `:${params.error}` : ''}`;
const SOON = { remainingMs: 30_000, warnMs: 120_000, label: '<1m', tone: 'archive-imminent' };

// node has no DOMParser: the stub carries the parsed markup as the only body child.
globalThis.DOMParser ??= class {
  parseFromString(markup) {
    return { body: { childNodes: markup ? [markup] : [] } };
  }
};

/** Minimal host: mounted markup/hidden/dataset plus one captured click listener. */
function fakeHost() {
  return {
    mounted: '',
    replaceChildren(...nodes) { this.mounted = nodes.join(''); },
    hidden: true,
    dataset: {},
    /** @type {((event: any) => void) | null} */
    listener: null,
    addEventListener(_type, fn) { this.listener = fn; },
    /** @param {string} action */
    click(action) {
      const target = Object.assign(new Element(), { closest: () => ({ getAttribute: () => action }) });
      this.listener?.({ target });
    },
  };
}

test('progress is the share of the warning window left', () => {
  assert.equal(archiveNoticeProgress(SOON), 0.25);
  assert.equal(archiveNoticeProgress({ ...SOON, remainingMs: 999_999 }), 1);
  assert.equal(archiveNoticeProgress({ ...SOON, warnMs: 0 }), 0);
});

test('the notice renders the deadline, the bar and the postpone action', () => {
  const html = renderChatArchiveNoticeHtml(SOON, t);
  assert.match(html, /chat\.archiveNoticeText:&lt;1m/);
  assert.match(html, /width:25\.0%/);
  assert.match(html, /data-archive-notice-action="postpone"/);
  assert.equal(renderChatArchiveNoticeHtml(null, t), '');
  const pending = renderChatArchiveNoticeHtml(SOON, t, { pending: true, hint: 'boom' });
  assert.match(pending, /data-archive-notice-action="postpone" disabled/);
  assert.match(pending, /data-tone="error">boom/);
});

test('the controller shows, hides and repaints only on change', () => {
  const host = fakeHost();
  let countdown = SOON;
  const controller = createChatArchiveNoticeController({
    t,
    getHost: () => /** @type {any} */ (host),
    resolveCountdown: () => countdown,
    postpone: async () => ({ ok: true }),
  });
  const chat = { id: 'c1' };
  controller.sync(chat);
  assert.equal(host.hidden, false);
  assert.match(host.mounted, /chat-archive-notice/);
  countdown = null;
  controller.sync(chat);
  assert.equal(host.hidden, true);
  assert.equal(host.mounted, '');
});

test('postpone calls the API and a failure shows a hint', async () => {
  const host = fakeHost();
  let countdown = SOON;
  let calls = 0;
  let ok = false;
  const controller = createChatArchiveNoticeController({
    t,
    getHost: () => /** @type {any} */ (host),
    resolveCountdown: () => countdown,
    postpone: async () => {
      calls += 1;
      if (ok) countdown = null;
      return ok ? { ok: true } : { ok: false, error: 'nope' };
    },
  });
  const chat = { id: 'c1' };
  controller.sync(chat);
  host.click('postpone');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.match(host.mounted, /chat\.archiveNoticePostponeFailed:nope/);
  ok = true;
  host.click('postpone');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  assert.equal(host.hidden, true);
});

test('dismiss hides the notice until the countdown is gone', () => {
  const host = fakeHost();
  let countdown = SOON;
  const controller = createChatArchiveNoticeController({
    t,
    getHost: () => /** @type {any} */ (host),
    resolveCountdown: () => countdown,
    postpone: async () => ({ ok: true }),
  });
  const chat = { id: 'c1' };
  controller.sync(chat);
  host.click('dismiss');
  assert.equal(host.hidden, true);
  controller.sync(chat);
  assert.equal(host.hidden, true, 'stays closed while the same countdown runs');
  countdown = null;
  controller.sync(chat);
  countdown = SOON;
  controller.sync(chat);
  assert.equal(host.hidden, false, 'a new countdown shows it again');
});
