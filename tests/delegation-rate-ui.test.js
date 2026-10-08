/**
 * TODO 4 — delegation rating UI wiring + front-end request transport.
 *
 * The card rating block lives in `app_front/lib/sdk-rich-view.js` (real DOM, no
 * jsdom in this suite), so its contract is asserted from the sources the same
 * way `delegation-stats-ui.test.js` does. The transport itself
 * (`postDelegationRate` in `app_front/api.js`) is behaviour-tested with a
 * stubbed `fetch`: the URL, method and body are pinned and the body must never
 * carry a `rater` (the server fixes it to `user` from the channel).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postDelegationRate } from '../app_front/api.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { DELEGATION_RATING_TAGS } from '../lib/delegation-rating-constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const apiSource = read('app_front/api.js');
const chatSource = read('app_front/chat.js');
const richViewSource = read('app_front/lib/sdk-rich-view.js');
const cardModelSource = read('lib/delegation-card-model.js');

/**
 * Replaces globalThis.fetch with a stub whose responses resolve on demand.
 * Returns the recorded requests plus a restore() for the finally block.
 *
 * @returns {{ requests: Array<{url: string, init: object, respond: Function}>, restore: () => void }}
 */
function stubFetch() {
  const previous = globalThis.fetch;
  /** @type {Array<{url: string, init: object, respond: Function}>} */
  const requests = [];
  globalThis.fetch = (url, init = {}) => {
    let respond;
    const responsePromise = new Promise((resolve) => {
      respond = resolve;
    });
    requests.push({
      url: String(url),
      init,
      respond: (payload) => respond({ status: 200, json: async () => payload }),
    });
    return responsePromise;
  };
  return { requests, restore: () => { globalThis.fetch = previous; } };
}

test('postDelegationRate posts the payload to the user rate endpoint', async () => {
  const { requests, restore } = stubFetch();
  try {
    const pending = postDelegationRate('job-1', {
      score: 4,
      tags: ['great'],
      note: 'solid',
    });
    assert.equal(requests.length, 1);
    const url = new URL(requests[0].url, 'http://localhost');
    assert.equal(url.pathname, '/api/delegations/job-1/rate');
    assert.equal(String(requests[0].init.method || '').toUpperCase(), 'POST');
    const body = JSON.parse(String(requests[0].init.body));
    assert.deepEqual(body, { score: 4, tags: ['great'], note: 'solid' });
    assert.equal('rater' in body, false, 'the rater is never sent by the client');

    requests[0].respond({ ok: true, replayed: false, rating: { score: 4, tags: ['great'], note: 'solid' } });
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.rating.score, 4);
  } finally {
    restore();
  }
});

test('postDelegationRate short-circuits without an id', async () => {
  const { requests, restore } = stubFetch();
  try {
    const result = await postDelegationRate('', { score: 3 });
    assert.equal(result.ok, false);
    assert.equal(requests.length, 0, 'no request is sent without a delegation id');
  } finally {
    restore();
  }
  // The transport stays pinned to the user channel endpoint.
  assert.match(apiSource, /export async function postDelegationRate\(/);
  assert.match(apiSource, /\/api\/delegations\/\$\{encodeURIComponent\(id\)\}\/rate/);
});

test('chat.js wires the card rating hook to the transport', () => {
  assert.match(chatSource, /onRateDelegation:\s*\(delegationId, payload\)/);
  assert.match(chatSource, /api\.postDelegationRate\(delegationId, payload\)/);
  // A published rating is pulled back into the stream, like the ack hook.
  assert.match(chatSource, /syncSdkHistoryOnResume\(chat, \{ reason: 'delegation_rate' \}\)/);
});

test('the delegation card renders a rating block with safe states', () => {
  assert.match(richViewSource, /function renderDelegationRating\(/);
  assert.match(richViewSource, /renderDelegationRating\(card, content, id, model\)/);
  // Never raw HTML: notes/tags are written through textContent only.
  assert.match(richViewSource, /noteEl\.textContent = note/);
  assert.match(richViewSource, /chip\.textContent = t\(`chat\.delegationRateTags\.\$\{tag\}`\)/);
  assert.doesNotMatch(richViewSource, /innerHTML\s*=\s*[^;]*rated\.(note|tags)/);
  // Busy (loading), error and read-only-after-rating branches.
  assert.match(richViewSource, /card\.dataset\.ratingBusy = '1'/);
  assert.match(richViewSource, /card\.dataset\.ratingError/);
  assert.match(richViewSource, /ratingCode === 'contradictory_rating'/);
  assert.match(richViewSource, /submit\.disabled = busy \|\| !draft\.score/);
  assert.match(richViewSource, /if \(!model\.canRate && !model\.userRating\) return;/);
  // Only the allow-listed tags are offered.
  assert.match(richViewSource, /for \(const tag of DELEGATION_RATING_TAGS\)/);
  assert.match(cardModelSource, /canRate = isTerminalDelegationStatus\(status\) && !userRating/);
});

test('rating i18n keys exist in both dictionaries', () => {
  const keys = [
    'delegationRateTitle',
    'delegationRateStarAria',
    'delegationRateNotePlaceholder',
    'delegationRateSubmit',
    'delegationRateBusy',
    'delegationRateFailed',
    'delegationRatedLabel',
  ];
  for (const key of keys) {
    assert.ok(en.chat?.[key], `en.chat.${key} is missing`);
    assert.ok(pl.chat?.[key], `pl.chat.${key} is missing`);
  }
  for (const tag of DELEGATION_RATING_TAGS) {
    const enLabel = en.chat?.delegationRateTags?.[tag];
    const plLabel = pl.chat?.delegationRateTags?.[tag];
    const missingKey = `chat.delegationRateTags.${tag}`;
    assert.ok(enLabel, `en.${missingKey} is missing`);
    assert.ok(plLabel, `pl.${missingKey} is missing`);
    assert.notEqual(String(enLabel).trim(), missingKey, `en.${missingKey} falls back to the raw key`);
    assert.notEqual(String(plLabel).trim(), missingKey, `pl.${missingKey} falls back to the raw key`);
    assert.notEqual(String(enLabel).trim(), tag, `en.${missingKey} must not echo the tag slug`);
    assert.notEqual(String(plLabel).trim(), tag, `pl.${missingKey} must not echo the tag slug`);
  }
  // The note placeholder advertises the same cap the server enforces.
  assert.match(String(en.chat.delegationRateNotePlaceholder), /500/);
  assert.match(String(pl.chat.delegationRateNotePlaceholder), /500/);
});

test('the stats panel shows the star average', () => {
  assert.ok(en.delegationStats?.colRating, 'en delegationStats.colRating is missing');
  assert.ok(pl.delegationStats?.colRating, 'pl delegationStats.colRating is missing');
  const statsView = read('app_front/features/usage/delegationStatsView.js');
  assert.match(statsView, /rating_avg/);
  assert.match(statsView, /rating_n/);
});
