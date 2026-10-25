/**
 * Settings → Delegations: unsaved subtab edits survive tab switches and refreshes.
 * Runs the real renderer/state of delegationSettings.js against a minimal fake DOM
 * (no jsdom dependency): roots keep their controls, innerHTML writes are counted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DELEGATION_SETTING_FIELDS } from '../lib/delegation-settings-schema.js';

const TABS = ['limits', 'review', 'sessions', 'models'];

/** Fake subtab root: parses data-delegation-field controls out of rendered HTML. */
class FakeRoot {
  constructor(tab) {
    this.tab = tab;
    this.hidden = true;
    this.controls = [];
    this.text = '';
    this.renders = 0;
    this.listeners = {};
    this._html = '';
  }
  set innerHTML(html) {
    this._html = html;
    this.renders += 1;
    this.text = '';
    this.controls = [...html.matchAll(/<(cr-bar-input|cr-bar-select|input)\b[^>]*data-delegation-field="([^"]+)"[^>]*>/g)].map((m) => {
      const value = /\svalue="([^"]*)"/.exec(m[0]);
      return { localName: m[1], dataset: { delegationField: m[2] }, value: value ? value[1] : '', checked: /\schecked/.test(m[0]), dataOptionsSet: false };
    });
  }
  get innerHTML() { return this._html; }
  set textContent(text) { this.text = text; this._html = ''; this.controls = []; }
  get textContent() { return this.text; }
  querySelector(selector) {
    const m = /^\[data-delegation-field="([^"]+)"\]$/.exec(selector);
    return m ? this.controls.find((c) => c.dataset.delegationField === m[1]) || null : null;
  }
  querySelectorAll() { return []; }
  closest() { return this.hidden ? {} : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ target: null }); }
  control(field) { return this.querySelector(`[data-delegation-field="${field}"]`); }
}

const roots = Object.fromEntries(TABS.map((tab) => [tab, new FakeRoot(tab)]));
const status = { textContent: '', dataset: {} };
let saveHandler = null;
globalThis.Element = class {};
globalThis.window = { addEventListener() {}, location: { origin: 'http://localhost' } };
globalThis.document = {
  getElementById(id) {
    const m = /^settings-delegation-(\w+)-root$/.exec(id);
    if (m) return roots[m[1]] || null;
    if (id === 'settings-delegation-status') return status;
    if (id === 'settings-delegation-save') return { addEventListener: (_t, fn) => { saveHandler = fn; } };
    return null;
  },
  querySelector: () => null,
  addEventListener() {},
};

/** Controllable server. */
const server = { settings: null, settingsGate: null, failSettings: false, catalogGate: null, catalogStarts: 0, onCatalogStart: null, patches: [], gets: 0 };
function makePayload(overrides = {}) {
  const effective = Object.fromEntries(DELEGATION_SETTING_FIELDS.map((f) => [f, 1]));
  Object.assign(effective, { max_depth: 3, review_fanout: 1, review_allow_uncertified: true, codex_review_sandbox: true, code_review_phase: true, ...overrides });
  return { ok: true, effective, scope: {}, source: {}, envDefault: {}, reviewerPolicy: {}, recovery: {} };
}
const reply = (status, json) => ({ status, ok: status < 400, headers: { get: () => null }, json: async () => json });
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.includes('/api/harness-catalog/harnesses')) {
    server.catalogStarts += 1;
    server.onCatalogStart?.();
    if (server.catalogGate) await server.catalogGate;
    return reply(200, { items: [{ id: 'h1' }] });
  }
  if (href.includes('/api/harness-catalog/models')) return reply(200, { items: [{ id: 'm1', label: 'M1' }] });
  if (init.method === 'PATCH') {
    const body = JSON.parse(init.body);
    server.patches.push(body);
    server.settings = makePayload({ ...server.settings.effective, ...body });
    return reply(200, server.settings);
  }
  server.gets += 1;
  if (server.settingsGate) await server.settingsGate;
  if (server.failSettings) return reply(500, { ok: false, error: 'boom' });
  return reply(200, server.settings);
};

const mod = await import('../app_front/features/settings/delegationSettings.js');
mod.initDelegationSettings();

/** Simulates the App.js subtab switch: show one root, refresh like entering the tab. */
async function switchTo(tab) {
  for (const t of TABS) roots[t].hidden = t !== tab;
  await mod.refreshDelegationSettings();
}
const edit = (tab, field, value) => {
  roots[tab].control(field).value = value;
  roots[tab].fire('input');
};

test('dirty Review edit survives Review → Sessions → Review without Loading', async () => {
  server.settings = makePayload();
  await switchTo('review');
  const control = roots.review.control('review_fanout');
  assert.ok(control, 'review control rendered');
  edit('review', 'review_fanout', '2');
  const renders = roots.review.renders;
  await switchTo('sessions');
  assert.equal(roots.review.control('review_fanout'), control, 'same control instance kept');
  assert.equal(roots.review.control('review_fanout').value, '2');
  assert.equal(roots.review.renders, renders, 'dirty root not repainted');
  assert.notEqual(roots.review.text, 'Loading');
  await switchTo('review');
  assert.equal(roots.review.control('review_fanout'), control);
  assert.equal(roots.review.control('review_fanout').value, '2');
  assert.equal(server.patches.length, 0, 'switching never saves');
});

test('slow refresh does not show Loading on the dirty tab', async () => {
  let release;
  server.settingsGate = new Promise((resolve) => { release = resolve; });
  const pending = mod.refreshDelegationSettings();
  await new Promise((r) => setImmediate(r));
  assert.ok(roots.review.control('review_fanout'), 'controls visible while fetching');
  assert.equal(roots.review.control('review_fanout').value, '2');
  release();
  await pending;
  server.settingsGate = null;
  assert.equal(roots.review.control('review_fanout').value, '2');
});

test('API failure keeps dirty tab, clean tabs show the error', async () => {
  server.failSettings = true;
  await mod.refreshDelegationSettings();
  server.failSettings = false;
  assert.equal(roots.review.control('review_fanout').value, '2');
  assert.match(roots.limits.text, /boom/, 'clean tab reports the load failure');
  assert.equal(roots.limits.controls.length, 0);
  await mod.refreshDelegationSettings();
  assert.ok(roots.limits.control('max_depth'), 'clean tab recovers on the next refresh');
});

test('delayed favorites repaint clean tabs but leave the dirty one untouched', async () => {
  let release;
  let catalogStarted;
  const started = new Promise((resolve) => { catalogStarted = resolve; });
  server.catalogGate = new Promise((resolve) => { release = resolve; });
  server.onCatalogStart = catalogStarted;
  const control = roots.review.control('review_fanout');
  const reviewRenders = roots.review.renders;
  const limitsRenders = roots.limits.renders;
  const startsBefore = server.catalogStarts;
  // Controlled clock: every read jumps a century ahead, so any favorites TTL has expired
  // without depending on the production TTL value.
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => (clock += 100 * 365 * 24 * 3600 * 1000);
  let pending;
  let startTimer;
  try {
    pending = mod.refreshDelegationSettings();
    // Fails (timeout) if the favorites fetch never starts, instead of passing vacuously.
    await Promise.race([started, new Promise((_, reject) => { startTimer = setTimeout(() => reject(new Error('favorites catalog request never started')), 2000); })]);
    assert.equal(server.catalogStarts, startsBefore + 1, 'exactly one catalog request started');
    await new Promise((r) => setImmediate(r));
    assert.equal(server.catalogStarts, startsBefore + 1, 'catalog request is de-duplicated while in flight');
    assert.equal(roots.review.control('review_fanout'), control, 'dirty control kept before favorites arrive');
    assert.equal(roots.review.control('review_fanout').value, '2', 'dirty value kept before favorites arrive');
    assert.ok(roots.limits.renders > limitsRenders, 'clean tab painted before favorites');
    const afterFirstPaint = roots.limits.renders;
    release();
    await pending;
    assert.ok(roots.limits.renders > afterFirstPaint, 'clean tab repainted once favorites arrived');
  } finally {
    // Cleanup must also run when an assertion throws: clear the race timer (an armed 2s timer
    // keeps the process alive), release the gate so the in-flight fetch can finish, and await
    // the pending refresh so no handle outlives the test.
    clearTimeout(startTimer);
    release();
    if (pending) await pending.catch(() => {});
    Date.now = realNow;
    server.catalogGate = null;
    server.onCatalogStart = null;
  }
  assert.equal(roots.review.control('review_fanout'), control, 'dirty control instance survives favorites');
  assert.equal(roots.review.control('review_fanout').value, '2');
  assert.equal(roots.review.renders, reviewRenders, 'dirty root never repainted');
});

test('clean tabs still refresh from the server', async () => {
  server.settings = makePayload({ max_depth: 5 });
  await mod.refreshDelegationSettings();
  assert.equal(roots.limits.control('max_depth').value, '5');
  assert.equal(roots.review.control('review_fanout').value, '2', 'dirty tab keeps the edit');
});

test('Save sends only changed fields and clears dirty so the tab refreshes again', async () => {
  roots.review.hidden = false;
  roots.limits.hidden = true;
  server.patches.length = 0;
  await saveHandler();
  assert.equal(server.patches.length, 1);
  assert.deepEqual(server.patches[0], { review_fanout: 2 });
  // Saved tab is clean now: a server-side change shows up on refresh.
  server.settings = makePayload({ review_fanout: 1 });
  await mod.refreshDelegationSettings();
  assert.equal(roots.review.control('review_fanout').value, '1');
  assert.equal(server.patches.length, 1, 'refresh never saves');
});
