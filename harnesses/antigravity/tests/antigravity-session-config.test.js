import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureAntigravitySession } from '../antigravity-session-config.js';

function session() {
  return { configOptions: [
    { id: 'model', category: 'model', type: 'select', currentValue: 'gemini-flash', options: [{ group: 'google', options: [{ value: 'gemini-flash', name: 'Flash' }, { value: 'gemini-pro', name: 'Pro' }] }] },
    { id: 'thinking', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'high' }, { value: 'medium' }] },
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default' }, { value: 'plan' }] },
  ] };
}

test('CLI variant selects the advertised base model and reasoning independently', async () => {
  const state = session();
  const requests = [];
  const connection = { async request(method, params) {
    requests.push([method, params]);
    state.configOptions.find((item) => item.id === params.configId).currentValue = params.value;
    return { configOptions: state.configOptions };
  } };
  const config = await configureAntigravitySession(connection, 'saved', state, { model: 'gemini-flash-medium', mode: 'agent' });
  assert.deepEqual(requests.map(([, params]) => [params.configId, params.value]), [['model', 'gemini-flash'], ['thinking', 'medium']]);
  assert.deepEqual(config, { modelId: 'gemini-flash', thinkingLevel: 'medium', mode: 'default' });
});

test('mode-only config supports Plan and switches back to default Agent', async () => {
  const state = session();
  const requests = [];
  const connection = { async request(_method, params) {
    requests.push(params);
    state.configOptions.find((item) => item.id === params.configId).currentValue = params.value;
    return { configOptions: state.configOptions };
  } };
  await configureAntigravitySession(connection, 'saved', state, { model: 'default', mode: 'ask' });
  await configureAntigravitySession(connection, 'saved', state, { model: 'default', mode: 'agent' });
  assert.deepEqual(requests.map((params) => params.value), ['plan', 'default']);
});

test('unadvertised model never reaches the agent', async () => {
  const requests = [];
  await assert.rejects(configureAntigravitySession({ request: async (...args) => requests.push(args) }, 'saved', session(), { model: 'invented-model-medium', mode: 'agent' }), /does not advertise model/);
  assert.deepEqual(requests, []);
});

test('dependent reasoning options are rechecked after switching model', async () => {
  const state = session();
  const connection = { async request() {
    state.configOptions[1].options = [{ value: 'high' }];
    return state;
  } };
  await assert.rejects(configureAntigravitySession(connection, 'saved', state, { model: 'gemini-pro-medium', mode: 'agent' }), /thinking level/);
});
