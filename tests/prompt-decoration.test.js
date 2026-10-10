/**
 * Tests for the slim per-turn prompt decoration: pure decision core, the
 * stateful integration through `applyHarnessOutboundPrompt`, the session-reset
 * hook through the context-restart ledger, and the opt-in measurement log.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import test, { after } from 'node:test';
import {
  PROMPT_DECORATION_BLOCK,
  PROMPT_DECORATION_DELTA_HINT,
  PROMPT_DECORATION_STATIC_MODE,
  decidePromptDecoration,
  estimatePromptTokens,
  hashPromptContent,
  logPromptDecorationMeasurement,
  resetPromptDecorationStatesForTests,
} from '../lib/sdk/prompt-decoration.js';
import {
  applyHarnessOutboundPrompt,
  applySdkHarnessOutboundPrompt,
  decorateHarnessPrompt,
  HARNESS_ASK_MODE_HINT,
  HARNESS_PLAN_MODE_HINT,
} from '../lib/sdk/harness-plan-prompt.js';
import {
  getContextRestartForChat,
  resetContextRestartsForTests,
  recordContextRestart,
} from '../lib/usage/context-restarts.js';
import { noteQwenSessionIdentity } from '../lib/qwen/qwen-agent-ws.js';

const RULE_BODY = 'Keep workspace rules in mind for this test.';

after(() => {
  removeIsolatedDataDir();
});

/**
 * Temp workspace with one alwaysApply rule so the static block is non-empty.
 * @returns {{ root: string, writeRule: (body: string) => void, cleanup: () => void }}
 */
function makeRuleWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cr-prompt-decoration-'));
  mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
  const rulePath = path.join(root, '.cursor', 'rules', 'always.mdc');
  const writeRule = (body) => {
    writeFileSync(rulePath, `---\nalwaysApply: true\n---\n${body}\n`, 'utf8');
  };
  writeRule(RULE_BODY);
  return {
    root,
    writeRule,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('hashPromptContent is deterministic and empty-safe', () => {
  assert.equal(hashPromptContent(''), '0');
  assert.equal(hashPromptContent(null), '0');
  assert.equal(hashPromptContent('abc'), hashPromptContent('abc'));
  assert.notEqual(hashPromptContent('abc'), hashPromptContent('abd'));
  assert.ok(estimatePromptTokens('12345678') === 2);
  assert.equal(estimatePromptTokens(''), 0);
});

test('first turn of a session emits the full static block and live volatile blocks', () => {
  const decision = decidePromptDecoration(null, {
    sessionKey: 's1',
    staticBlock: 'STATIC-BLOCK',
    volatile: {
      [PROMPT_DECORATION_BLOCK.MODE_HINT]: 'PLAN-HINT',
      [PROMPT_DECORATION_BLOCK.DELEGATION_REPORTS]: 'REPORT-A',
    },
  });
  assert.equal(decision.staticIncluded, true);
  assert.equal(decision.staticDeltaIncluded, false);
  assert.ok(decision.parts.includes('STATIC-BLOCK'));
  assert.ok(decision.parts.includes('PLAN-HINT'));
  assert.ok(decision.parts.includes('REPORT-A'));
  assert.equal(decision.state.turns, 1);
  assert.ok(decision.measurement.omittedTokens === 0);
});

test('second turn with unchanged content carries only the short delta', () => {
  const bigStaticBlock = 'STATIC-RULE-LINE\n'.repeat(40);
  const first = decidePromptDecoration(null, {
    sessionKey: 's1',
    staticBlock: bigStaticBlock,
    volatile: { [PROMPT_DECORATION_BLOCK.CHAT_PLAN]: 'PLAN-BODY' },
  });
  const second = decidePromptDecoration(first.state, {
    sessionKey: 's1',
    staticBlock: bigStaticBlock,
    volatile: { [PROMPT_DECORATION_BLOCK.CHAT_PLAN]: 'PLAN-BODY' },
  });
  assert.equal(second.staticIncluded, false);
  assert.equal(second.staticDeltaIncluded, true);
  assert.deepEqual(second.parts, [PROMPT_DECORATION_DELTA_HINT]);
  assert.equal(second.measurement.omittedTokens > 0, true);
  assert.equal(second.state.turns, 2);
});

test('changed static hash re-sends the whole block', () => {
  const first = decidePromptDecoration(null, { sessionKey: 's1', staticBlock: 'STATIC-ONE' });
  const changed = decidePromptDecoration(first.state, { sessionKey: 's1', staticBlock: 'STATIC-TWO' });
  assert.equal(changed.staticIncluded, true);
  assert.ok(changed.parts.includes('STATIC-TWO'));
  assert.equal(changed.parts.includes(PROMPT_DECORATION_DELTA_HINT), false);
});

test('a new delegation report is included once and not repeated', () => {
  const first = decidePromptDecoration(null, {
    sessionKey: 's1',
    staticBlock: 'STATIC',
    volatile: { [PROMPT_DECORATION_BLOCK.MODE_HINT]: 'MODE' },
  });
  const withReport = decidePromptDecoration(first.state, {
    sessionKey: 's1',
    staticBlock: 'STATIC',
    volatile: {
      [PROMPT_DECORATION_BLOCK.MODE_HINT]: 'MODE',
      [PROMPT_DECORATION_BLOCK.DELEGATION_REPORTS]: 'REPORT-A',
    },
  });
  assert.ok(withReport.parts.includes('REPORT-A'));
  const repeated = decidePromptDecoration(withReport.state, {
    sessionKey: 's1',
    staticBlock: 'STATIC',
    volatile: {
      [PROMPT_DECORATION_BLOCK.MODE_HINT]: 'MODE',
      [PROMPT_DECORATION_BLOCK.DELEGATION_REPORTS]: 'REPORT-A',
    },
  });
  assert.equal(repeated.parts.includes('REPORT-A'), false);
});

test('a changed delegation report replaces the previous one', () => {
  const first = decidePromptDecoration(null, {
    sessionKey: 's1',
    volatile: { [PROMPT_DECORATION_BLOCK.DELEGATION_REPORTS]: 'REPORT-A' },
  });
  const changed = decidePromptDecoration(first.state, {
    sessionKey: 's1',
    volatile: { [PROMPT_DECORATION_BLOCK.DELEGATION_REPORTS]: 'REPORT-B' },
  });
  assert.equal(changed.parts.includes('REPORT-A'), false);
  assert.ok(changed.parts.includes('REPORT-B'));
});

test('a new session identity resets the state and re-sends the full block', () => {
  const first = decidePromptDecoration(null, { sessionKey: 'session-1', staticBlock: 'STATIC' });
  const same = decidePromptDecoration(first.state, { sessionKey: 'session-1', staticBlock: 'STATIC' });
  const reset = decidePromptDecoration(same.state, { sessionKey: 'session-2', staticBlock: 'STATIC' });
  assert.equal(reset.staticIncluded, true);
  assert.ok(reset.parts.includes('STATIC'));
  assert.equal(reset.state.turns, 1);
});

test('mode hints still follow Plan -> Agent -> Plan transitions', () => {
  const plan = decidePromptDecoration(null, {
    sessionKey: 'm1',
    staticBlock: 'STATIC',
    volatile: { [PROMPT_DECORATION_BLOCK.MODE_HINT]: 'PLAN-HINT' },
  });
  assert.ok(plan.parts.includes('PLAN-HINT'));
  const agent = decidePromptDecoration(plan.state, {
    sessionKey: 'm1',
    staticBlock: 'STATIC',
    volatile: { [PROMPT_DECORATION_BLOCK.MODE_HINT]: '' },
  });
  assert.equal(agent.parts.includes('PLAN-HINT'), false);
  const planAgain = decidePromptDecoration(agent.state, {
    sessionKey: 'm1',
    staticBlock: 'STATIC',
    volatile: { [PROMPT_DECORATION_BLOCK.MODE_HINT]: 'PLAN-HINT' },
  });
  assert.ok(planAgain.parts.includes('PLAN-HINT'));
});

test('an active plan-mode hint is re-emitted on every unchanged turn', () => {
  const first = decidePromptDecoration(null, {
    sessionKey: 'm-plan',
    staticBlock: 'STATIC',
    volatile: { [PROMPT_DECORATION_BLOCK.MODE_HINT]: 'PLAN-HINT' },
  });
  assert.ok(first.parts.includes('PLAN-HINT'));
  const second = decidePromptDecoration(first.state, {
    sessionKey: 'm-plan',
    staticBlock: 'STATIC',
    volatile: { [PROMPT_DECORATION_BLOCK.MODE_HINT]: 'PLAN-HINT' },
  });
  const third = decidePromptDecoration(second.state, {
    sessionKey: 'm-plan',
    staticBlock: 'STATIC',
    volatile: { [PROMPT_DECORATION_BLOCK.MODE_HINT]: 'PLAN-HINT' },
  });
  assert.ok(second.parts.includes('PLAN-HINT'));
  assert.ok(third.parts.includes('PLAN-HINT'));
  // Only the static block is deduped; the safety hint stays.
  assert.equal(second.staticIncluded, false);
  assert.deepEqual(second.parts, [PROMPT_DECORATION_DELTA_HINT, 'PLAN-HINT']);
});

test('an active ask-mode hint is re-emitted on every unchanged turn', () => {
  const first = decidePromptDecoration(null, {
    sessionKey: 'm-ask',
    staticBlock: 'STATIC',
    volatile: { [PROMPT_DECORATION_BLOCK.MODE_HINT]: 'ASK-HINT' },
  });
  const second = decidePromptDecoration(first.state, {
    sessionKey: 'm-ask',
    staticBlock: 'STATIC',
    volatile: { [PROMPT_DECORATION_BLOCK.MODE_HINT]: 'ASK-HINT' },
  });
  assert.ok(first.parts.includes('ASK-HINT'));
  assert.ok(second.parts.includes('ASK-HINT'));
});

test('staticMode always re-emits the full static block on an unchanged turn', () => {
  const first = decidePromptDecoration(null, {
    sessionKey: 'always-1',
    staticBlock: 'STATIC',
    staticMode: PROMPT_DECORATION_STATIC_MODE.ALWAYS,
  });
  const second = decidePromptDecoration(first.state, {
    sessionKey: 'always-1',
    staticBlock: 'STATIC',
    staticMode: PROMPT_DECORATION_STATIC_MODE.ALWAYS,
  });
  assert.equal(first.staticIncluded, true);
  assert.equal(second.staticIncluded, true);
  assert.equal(second.staticDeltaIncluded, false);
  assert.ok(second.parts.includes('STATIC'));
  assert.equal(second.measurement.staticMode, PROMPT_DECORATION_STATIC_MODE.ALWAYS);
});

test('decorateHarnessPrompt repeats plan/ask hints every turn while the mode is active', () => {
  const workspace = makeRuleWorkspace();
  resetContextRestartsForTests();
  resetPromptDecorationStatesForTests();
  try {
    const planRoom = {
      chatId: 'chat-plan-hint',
      sessionKey: 'chat-plan-hint-session',
      cwd: workspace.root,
      sdkMode: 'plan',
    };
    const planFirst = decorateHarnessPrompt(planRoom, 'one', 'codex');
    const planSecond = decorateHarnessPrompt(planRoom, 'two', 'codex');
    assert.ok(planFirst.includes(HARNESS_PLAN_MODE_HINT));
    assert.ok(planSecond.includes(HARNESS_PLAN_MODE_HINT));
    // The static block is still deduped, so only the hint is sticky.
    assert.equal(planSecond.includes('[WORKSPACE CURSOR RULES]'), false);

    const askRoom = {
      chatId: 'chat-ask-hint',
      sessionKey: 'chat-ask-hint-session',
      cwd: workspace.root,
      sdkMode: 'ask',
    };
    const askFirst = decorateHarnessPrompt(askRoom, 'one', 'codex');
    const askSecond = decorateHarnessPrompt(askRoom, 'two', 'codex');
    assert.ok(askFirst.includes(HARNESS_ASK_MODE_HINT));
    assert.ok(askSecond.includes(HARNESS_ASK_MODE_HINT));
  } finally {
    workspace.cleanup();
  }
});

test('qwen records a context restart when the CLI session identity changes', () => {
  resetContextRestartsForTests();
  const room = { chatId: 'chat-qwen-identity' };
  noteQwenSessionIdentity(room, 'qwen-session-a');
  assert.equal(getContextRestartForChat('chat-qwen-identity'), null);
  noteQwenSessionIdentity(room, 'qwen-session-a');
  assert.equal(getContextRestartForChat('chat-qwen-identity'), null);
  noteQwenSessionIdentity(room, 'qwen-session-b');
  const entry = getContextRestartForChat('chat-qwen-identity');
  assert.equal(entry.count, 1);
  assert.equal(entry.byReason.session_drop, 1);
});

test('qwen re-emits the full static block after a session identity change', () => {
  const workspace = makeRuleWorkspace();
  resetContextRestartsForTests();
  resetPromptDecorationStatesForTests();
  try {
    const room = {
      chatId: 'chat-qwen-deco',
      sessionKey: 'chat-qwen-deco-session',
      cwd: workspace.root,
      sdkMode: 'agent',
    };
    const first = decorateHarnessPrompt(room, 'one', 'qwen');
    assert.match(first, /WORKSPACE CURSOR RULES/);
    noteQwenSessionIdentity(room, 'qwen-a');
    const second = decorateHarnessPrompt(room, 'two', 'qwen');
    assert.equal(second.includes('[WORKSPACE CURSOR RULES]'), false);
    // A rebuilt CLI session drops the earlier copy, so the next turn re-sends it.
    noteQwenSessionIdentity(room, 'qwen-b');
    const third = decorateHarnessPrompt(room, 'three', 'qwen');
    assert.match(third, /WORKSPACE CURSOR RULES/);
  } finally {
    workspace.cleanup();
  }
});

test('openrouter and mistral re-emit the static block every turn (no session identity)', () => {
  const workspace = makeRuleWorkspace();
  resetContextRestartsForTests();
  resetPromptDecorationStatesForTests();
  try {
    for (const transport of ['openrouter', 'mistral']) {
      const room = {
        chatId: `chat-${transport}-always`,
        sessionKey: `chat-${transport}-always-session`,
        cwd: workspace.root,
        sdkMode: 'agent',
      };
      const first = decorateHarnessPrompt(room, 'one', transport);
      assert.match(first, /WORKSPACE CURSOR RULES/);
      // No observable session identity: even an unchanged turn keeps the block.
      const second = decorateHarnessPrompt(room, 'two', transport);
      assert.match(second, /WORKSPACE CURSOR RULES/);
      // A simulated restart also re-emits, so no saving is silently lost.
      recordContextRestart({ chatId: room.chatId, harness: transport, reason: 'session_drop' });
      const third = decorateHarnessPrompt(room, 'three', transport);
      assert.match(third, /WORKSPACE CURSOR RULES/);
    }
  } finally {
    workspace.cleanup();
  }
});

test('applyHarnessOutboundPrompt keeps the legacy full block without a session key', () => {
  const workspace = makeRuleWorkspace();
  try {
    const prompt = applyHarnessOutboundPrompt('hello', {
      cwd: workspace.root,
      mode: 'agent',
      transport: 'codex',
      skipPlanHint: true,
    });
    assert.match(prompt, /WORKSPACE CURSOR RULES/);
    assert.ok(prompt.endsWith('hello'));
  } finally {
    workspace.cleanup();
  }
});

test('applyHarnessOutboundPrompt slims the static block across a session', () => {
  const workspace = makeRuleWorkspace();
  resetPromptDecorationStatesForTests();
  try {
    const common = {
      cwd: workspace.root,
      chatId: 'chat-dedup',
      mode: 'agent',
      transport: 'codex',
      skipPlanHint: true,
      sessionKey: 'chat-dedup#g0',
    };
    const first = applyHarnessOutboundPrompt('first', common);
    assert.match(first, /WORKSPACE CURSOR RULES/);
    const second = applyHarnessOutboundPrompt('second', common);
    assert.equal(second.includes('[WORKSPACE CURSOR RULES]'), false);
    assert.ok(second.includes(PROMPT_DECORATION_DELTA_HINT));
    assert.ok(second.endsWith('second'));
    // A changed rules file must re-send the full block on the next turn.
    workspace.writeRule('Changed rule body for the hash test.');
    const third = applyHarnessOutboundPrompt('third', common);
    assert.match(third, /Changed rule body for the hash test/);
  } finally {
    workspace.cleanup();
  }
});

test('decorateHarnessPrompt re-sends the full block after a recorded restart', () => {
  const workspace = makeRuleWorkspace();
  resetContextRestartsForTests();
  resetPromptDecorationStatesForTests();
  try {
    const room = {
      chatId: 'chat-restart',
      sessionKey: 'chat-restart-session',
      cwd: workspace.root,
      sdkMode: 'agent',
    };
    const first = decorateHarnessPrompt(room, 'one', 'codex');
    assert.match(first, /WORKSPACE CURSOR RULES/);
    const second = decorateHarnessPrompt(room, 'two', 'codex');
    assert.equal(second.includes('[WORKSPACE CURSOR RULES]'), false);
    recordContextRestart({ chatId: room.chatId, harness: 'codex', reason: 'process_recreated' });
    const third = decorateHarnessPrompt(room, 'three', 'codex');
    assert.match(third, /WORKSPACE CURSOR RULES/);
  } finally {
    workspace.cleanup();
  }
});

test('applySdkHarnessOutboundPrompt slims skills and tracks page context per turn', () => {
  const workspace = makeRuleWorkspace();
  resetPromptDecorationStatesForTests();
  try {
    const common = {
      cwd: workspace.root,
      chatId: 'chat-sdk',
      mode: 'agent',
      sessionKey: 'chat-sdk#g0',
    };
    const first = applySdkHarnessOutboundPrompt('one', { ...common, pageContext: '[PAGE-ONE]' });
    // The SDK loads workspace rules via settingSources, so they are not injected.
    assert.equal(first.includes('[WORKSPACE CURSOR RULES]'), false);
    assert.match(first, /AVAILABLE AGENT SKILLS/);
    assert.ok(first.includes('[PAGE-ONE]'));
    const second = applySdkHarnessOutboundPrompt('two', { ...common, pageContext: '[PAGE-ONE]' });
    assert.equal(second.includes('[AVAILABLE AGENT SKILLS]'), false);
    assert.equal(second.includes('[PAGE-ONE]'), false);
    assert.ok(second.includes(PROMPT_DECORATION_DELTA_HINT));
    // Page context changed: it must be re-sent even though the static block is unchanged.
    const third = applySdkHarnessOutboundPrompt('three', { ...common, pageContext: '[PAGE-TWO]' });
    assert.ok(third.includes('[PAGE-TWO]'));
    assert.equal(third.includes('[PAGE-ONE]'), false);
  } finally {
    workspace.cleanup();
  }
});

test('debug measurement logging is opt-in and carries no prompt text', () => {
  const restoreTestDir = process.env.CRETLI_TEST_DATA_DIR;
  const restoreDebug = process.env.CRETLI_DEBUG_PROMPT_DECORATION;
  const restoreDebugFn = console.debug;
  const calls = [];
  try {
    delete process.env.CRETLI_TEST_DATA_DIR;
    process.env.CRETLI_DEBUG_PROMPT_DECORATION = '1';
    console.debug = (...args) => calls.push(args);
    logPromptDecorationMeasurement(
      {
        staticTokens: 100,
        fullTokens: 120,
        includedTokens: 20,
        omittedTokens: 100,
        staticIncluded: false,
        staticDeltaIncluded: true,
        volatileIncluded: ['chatPlan'],
      },
      { harness: 'codex', chatId: 'c1', sessionKey: 'c1#g0', turn: 2 },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '[prompt-decoration]');
    const payload = JSON.parse(calls[0][1]);
    assert.equal(payload.harness, 'codex');
    assert.equal(payload.turn, 2);
    assert.equal(payload.staticTokens, 100);
    assert.equal(payload.omittedTokens, 100);
    assert.equal('staticBlock' in payload, false);
    assert.equal('prompt' in payload, false);
  } finally {
    console.debug = restoreDebugFn;
    if (restoreTestDir !== undefined) process.env.CRETLI_TEST_DATA_DIR = restoreTestDir;
    if (restoreDebug === undefined) delete process.env.CRETLI_DEBUG_PROMPT_DECORATION;
    else process.env.CRETLI_DEBUG_PROMPT_DECORATION = restoreDebug;
  }
});
