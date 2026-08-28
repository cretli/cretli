import assert from 'node:assert/strict';
import {
  STICKY_INSTANCE_COOKIE_NAME,
  ensureStickyInstanceCookie,
  readCookieValue,
} from '../lib/sdk/sdk-sticky-session.js';

assert.equal(
  readCookieValue('foo=1; cretli-instance=abc%2F123; bar=2', STICKY_INSTANCE_COOKIE_NAME),
  'abc/123'
);
assert.equal(readCookieValue('', STICKY_INSTANCE_COOKIE_NAME), '');

const headers = [];
const res = {
  append(name, value) {
    headers.push({ name, value });
  },
};
const req = { headers: {} };
const assigned = ensureStickyInstanceCookie(req, res, 'instance-xyz', { secure: false });
assert.equal(assigned, 'instance-xyz');
assert.equal(headers.length, 1);
assert.match(headers[0].value, /cretli-instance=instance-xyz/);

const reqWithCookie = {
  headers: { cookie: `${STICKY_INSTANCE_COOKIE_NAME}=existing-id` },
};
const headersAgain = [];
const resAgain = {
  append(name, value) {
    headersAgain.push({ name, value });
  },
};
const kept = ensureStickyInstanceCookie(reqWithCookie, resAgain, 'other-id');
assert.equal(kept, 'existing-id');
assert.equal(headersAgain.length, 0);

console.log('All sdk-sticky-session tests passed.');
