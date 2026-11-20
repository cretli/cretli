import assert from 'node:assert/strict';
import { isMobileLikeClient, isStandalonePwa } from '../app_front/lib/mobileClient.js';

assert.equal(typeof isMobileLikeClient(), 'boolean');
assert.equal(typeof isStandalonePwa(), 'boolean');

console.log('mobile-client.test.js: ok');
