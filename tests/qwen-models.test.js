import assert from 'node:assert/strict';
import {
  DEFAULT_QWEN_MODEL,
  listFallbackQwenModels,
  remapQwenModelId,
  resolveDefaultQwenModel,
  resolveQwenRunModel,
} from '../lib/qwen/qwen-models.js';

assert.equal(DEFAULT_QWEN_MODEL, 'qwen3.8-max');
assert.equal(resolveDefaultQwenModel(), 'qwen3.8-max');

const tokenPlan = listFallbackQwenModels('token-plan');
assert.ok(tokenPlan.some((row) => row.value === 'qwen3.8-max'));
assert.ok(tokenPlan.some((row) => row.value === 'qwen3.7-plus'));
assert.ok(tokenPlan.some((row) => row.value === 'qwen3.8-flash'));
assert.equal(tokenPlan.some((row) => row.value === 'qwen-plus'), false);

const payg = listFallbackQwenModels('payg');
assert.ok(payg.some((row) => row.value === 'qwen-plus'));
assert.ok(payg.some((row) => row.value === 'qwen3-coder-plus'));

assert.equal(remapQwenModelId('qwen-plus', 'token-plan'), 'qwen3.7-plus');
assert.equal(remapQwenModelId('qwen3-coder-plus', 'token-plan'), 'qwen3.8-flash');
assert.equal(remapQwenModelId('qwen-plus', 'payg'), 'qwen-plus');
assert.equal(resolveQwenRunModel('qwen-plus', 'token-plan'), 'qwen3.7-plus');
assert.equal(resolveQwenRunModel('qwen3.7-plus', 'token-plan'), 'qwen3.7-plus');
assert.equal(resolveQwenRunModel('qwen-plus', 'payg'), 'qwen-plus');
assert.equal(resolveQwenRunModel(''), DEFAULT_QWEN_MODEL);
assert.equal(resolveQwenRunModel('   '), DEFAULT_QWEN_MODEL);

console.log('qwen-models.test.js OK');
