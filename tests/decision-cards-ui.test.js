import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const component = await readFile(new URL('../app_front/features/decisions/cr-decision-stack.js', import.meta.url), 'utf8');

test('needs-human card UI exposes the self-contained question, durable draft, continuation and paginated journey', () => {
  assert.match(component, /card\.projectName/);
  assert.match(component, /card\.question/);
  assert.match(component, /card\.options\.map\(\(option\).*option\.effect/s);
  assert.match(component, /localStorage\.setItem\(this\.draftKey\(card\), value\)/);
  assert.match(component, /continuation\/retry/);
  assert.match(component, /events\?\$\{query\}/);
  assert.match(component, /body\.items/);
  assert.match(component, /ref\.missing/);
  assert.match(component, /taskNotCompleted/);
});

test('decision journey UI strings are present in both supported dictionaries', () => {
  for (const dictionary of [en, pl]) {
    assert.ok(dictionary.decisions.journey);
    assert.ok(dictionary.decisions.unavailable);
    assert.ok(dictionary.decisions.continuationStatus.resumed);
    assert.ok(dictionary.decisions.event.superseded);
    assert.ok(dictionary.decisions.taskNotCompleted);
  }
});
