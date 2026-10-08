import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHarnessOutboundPrompt } from '../lib/sdk/harness-plan-prompt.js';
import { resolveProjectPath } from '../lib/runtime-paths.js';

test('non-SDK harness prompt includes cretli-browser skill and alwaysApply rule', () => {
  const cwd = resolveProjectPath();
  const prompt = applyHarnessOutboundPrompt('inspect the page', {
    cwd,
    mode: 'agent',
    transport: 'codex',
    skipPlanHint: true,
  });
  assert.match(prompt, /\[AVAILABLE AGENT SKILLS\]/);
  assert.match(prompt, /cretli-browser/);
  assert.match(prompt, /\[WORKSPACE CURSOR RULES\]/);
  assert.match(prompt, /browser_\*/);
  assert.equal(prompt.endsWith('inspect the page'), true);
});

test('opencode transport gets the same workspace rule injection as codex', () => {
  const cwd = resolveProjectPath();
  const codexPrompt = applyHarnessOutboundPrompt('x', {
    cwd,
    transport: 'codex',
    skipPlanHint: true,
  });
  const opencodePrompt = applyHarnessOutboundPrompt('x', {
    cwd,
    transport: 'opencode',
    skipPlanHint: true,
  });
  assert.equal(
    codexPrompt.includes('[WORKSPACE CURSOR RULES]'),
    opencodePrompt.includes('[WORKSPACE CURSOR RULES]'),
  );
  assert.match(opencodePrompt, /browser_\*/);
});
