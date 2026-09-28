import assert from 'node:assert/strict';
import test from 'node:test';

import { readBarInputLiveValue } from '../app_front/components/ui/read-bar-input-live-value.js';

test('prefers the inner control value over a stale host property', () => {
  const host = {
    value: '',
    shadowRoot: {
      querySelector() {
        return { value: 'typed-password' };
      },
    },
  };
  assert.equal(readBarInputLiveValue(host), 'typed-password');
});

test('falls back to the host value when there is no inner control', () => {
  const host = { value: 'host-only', shadowRoot: { querySelector() { return null; } } };
  assert.equal(readBarInputLiveValue(host), 'host-only');
});

test('returns empty string for a missing host', () => {
  assert.equal(readBarInputLiveValue(null), '');
  assert.equal(readBarInputLiveValue(undefined), '');
});
