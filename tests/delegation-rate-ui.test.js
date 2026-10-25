/**
 * Delegation rating UI: ratings are recorded by the orchestrator (MCP
 * `delegation_rate`), so the card only renders an existing rating read-only and
 * the front end has no manual rating form or transport.
 */
import test from 'node:test';
import { readRichViewSource } from './helpers/rich-view-source.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { DELEGATION_RATING_TAGS } from '../lib/delegation-rating-constants.js';
import { readChatSource } from './helpers/chatSource.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
import { readApiSource } from './helpers/api-source.js';
const apiSource = readApiSource();
const chatSource = readChatSource();
const richViewSource = readRichViewSource();
const cardModelSource = read('lib/delegation-card-model.js');

test('the manual rating form and its transport are gone', () => {
  assert.doesNotMatch(apiSource, /postDelegationRate/);
  assert.doesNotMatch(chatSource, /onRateDelegation/);
  assert.doesNotMatch(richViewSource, /onRateDelegation|sdk-rich-delegation-star|ratingDraft/);
  assert.doesNotMatch(cardModelSource, /canRate/);
});

test('the delegation card renders an existing rating read-only', () => {
  assert.match(richViewSource, /function renderDelegationRating\(/);
  assert.match(richViewSource, /renderDelegationRating\(card, content, id, model\)/);
  // Never raw HTML: notes/tags are written through textContent only.
  assert.match(richViewSource, /noteEl\.textContent = note/);
  assert.match(richViewSource, /chip\.textContent = t\(`chat\.delegationRateTags\.\$\{tag\}`\)/);
  assert.doesNotMatch(richViewSource, /innerHTML\s*=\s*[^;]*rated\.(note|tags)/);
});

test('rating i18n keys exist in both dictionaries', () => {
  assert.ok(en.chat?.delegationRatedLabel, 'en.chat.delegationRatedLabel is missing');
  assert.ok(pl.chat?.delegationRatedLabel, 'pl.chat.delegationRatedLabel is missing');
  for (const tag of DELEGATION_RATING_TAGS) {
    const missingKey = `chat.delegationRateTags.${tag}`;
    assert.ok(en.chat?.delegationRateTags?.[tag], `en.${missingKey} is missing`);
    assert.ok(pl.chat?.delegationRateTags?.[tag], `pl.${missingKey} is missing`);
  }
});

test('the stats panel shows the star average', () => {
  assert.ok(en.delegationStats?.colRating, 'en delegationStats.colRating is missing');
  assert.ok(pl.delegationStats?.colRating, 'pl delegationStats.colRating is missing');
  const statsView = read('app_front/features/usage/delegationStatsView.js');
  assert.match(statsView, /rating_avg/);
  assert.match(statsView, /rating_n/);
});
