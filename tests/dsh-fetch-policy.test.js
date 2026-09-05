import assert from 'node:assert/strict';
import { isAllowedDshFetchIp } from '../lib/deepseek/dsh-fetch-policy.js';

assert.equal(isAllowedDshFetchIp('1.1.1.1'), true);
assert.equal(isAllowedDshFetchIp('192.168.33.33'), true);
assert.equal(isAllowedDshFetchIp('10.0.0.1'), true);
assert.equal(isAllowedDshFetchIp('172.16.0.1'), true);
assert.equal(isAllowedDshFetchIp('127.0.0.1'), true);
assert.equal(isAllowedDshFetchIp('169.254.169.254'), false);
assert.equal(isAllowedDshFetchIp('0.0.0.0'), false);
assert.equal(isAllowedDshFetchIp('224.0.0.1'), false);
assert.equal(isAllowedDshFetchIp('::1'), true);
assert.equal(isAllowedDshFetchIp('::'), false);
assert.equal(isAllowedDshFetchIp('fe80::1'), false);
assert.equal(isAllowedDshFetchIp('ff02::1'), false);
assert.equal(isAllowedDshFetchIp('2001:4860:4860::8888'), true);
assert.equal(isAllowedDshFetchIp('::ffff:192.168.1.1'), true);
assert.equal(isAllowedDshFetchIp('::ffff:169.254.169.254'), false);
assert.equal(isAllowedDshFetchIp('not-an-ip'), false);

console.log('dsh-fetch-policy.test.js OK');
