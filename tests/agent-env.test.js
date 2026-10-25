import './helpers/agent-env-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildAgentEnvMask, buildAgentChildEnv, isAgentEnvAllowlistEnabled, HARNESS_PROVIDER_ENV } from '../lib/agent-env.js';
import { buildInteractivePtyEnv } from '../lib/pty-env.js';
import { buildDeepSeekProcessEnv } from '../harnesses/deepseek/deepseek-api-key.js';
import { buildClaudeProcessEnv } from '../lib/claude/claude-api-key.ts';
import { buildCodexProcessEnv } from '../lib/codex/codex-api-key.ts';

const PARENT = {
  PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', LC_ALL: 'C', TERM: 'xterm', TMPDIR: '/tmp',
  XDG_CONFIG_HOME: '/home/u/.config',
  GITHUB_TOKEN: 'gh', GH_TOKEN: 'gh2', CRETLI_SECRET: 's', CURSOR_REMOTE_X: 'x',
  ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', DEEPSEEK_API_KEY: 'd', DSH_BIN: '/dsh', ZAI_API_KEY: 'z',
  CODEBUDDY_API_KEY: 'cb', OPENROUTER_API_KEY: 'or', DASHSCOPE_API_KEY: 'q', CODEX_API_KEY: 'cx', MISTRAL_API_KEY: 'm',
  UNRELATED_SECRET: 'u',
};
const ON = { ...PARENT, CRETLI_AGENT_ENV_ALLOWLIST: '1' };
const OWN_KEY = {
  claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY', qwen: 'DASHSCOPE_API_KEY', codebuddy: 'CODEBUDDY_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY', zai: 'ZAI_API_KEY', opencode: 'ZAI_API_KEY',
};
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'CODEBUDDY_API_KEY',
  'OPENROUTER_API_KEY', 'DASHSCOPE_API_KEY', 'CODEX_API_KEY', 'MISTRAL_API_KEY'];

for (const [harness, own] of Object.entries(OWN_KEY)) {
  test(`${harness}: keeps basics + own key, drops foreign secrets`, () => {
    const env = buildAgentChildEnv(harness, { base: ON });
    for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', own]) assert.ok(env[k], k);
    for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'CRETLI_SECRET', 'CURSOR_REMOTE_X', 'UNRELATED_SECRET']) assert.equal(env[k], undefined, k);
    const opencodeShared = HARNESS_PROVIDER_ENV[harness].prefixes;
    for (const k of KEYS) {
      if (k === own) continue;
      if (opencodeShared.some((p) => k.startsWith(p))) continue;
      assert.equal(env[k], undefined, `${harness} leaked ${k}`);
    }
  });
}

test('tool env has no provider keys at all', () => {
  const env = buildAgentChildEnv('tool', { base: ON });
  for (const k of KEYS) assert.equal(env[k], undefined);
});

test('home and overrides apply; undefined override removes', () => {
  const env = buildAgentChildEnv('zai', { base: ON, home: '/iso', overrides: { ZAI_BASE_URL: 'u', ZAI_API_KEY: undefined } });
  assert.equal(env.HOME, '/iso');
  assert.equal(env.ZAI_BASE_URL, 'u');
  assert.equal(env.ZAI_API_KEY, undefined);
});

test('default (flag unset): identical to full inheritance, copy not alias', () => {
  const env = buildAgentChildEnv('deepseek', { base: PARENT });
  assert.deepEqual(env, PARENT);
  assert.notEqual(env, PARENT);
  assert.equal(env.GITHUB_TOKEN, 'gh');
  assert.equal(env.ANTHROPIC_API_KEY, 'a');
  assert.deepEqual(buildAgentEnvMask('qwen', PARENT), {});
  // Overrides/home still apply without the flag (same as the old spread + override).
  const o = buildAgentChildEnv('zai', { base: PARENT, home: '/iso', overrides: { ZAI_BASE_URL: 'u' } });
  assert.equal(o.HOME, '/iso');
  assert.equal(o.ZAI_BASE_URL, 'u');
  assert.equal(o.GITHUB_TOKEN, 'gh');
});

test('flag values: only truthy strings enable; PASSTHROUGH alias force-disables', () => {
  assert.equal(isAgentEnvAllowlistEnabled({ CRETLI_AGENT_ENV_ALLOWLIST: '0' }), false);
  assert.equal(isAgentEnvAllowlistEnabled({ CRETLI_AGENT_ENV_ALLOWLIST: 'true' }), true);
  const env = buildAgentChildEnv('deepseek', { base: { ...ON, CRETLI_AGENT_ENV_PASSTHROUGH: '1' } });
  assert.equal(env.GITHUB_TOKEN, 'gh');
  assert.equal(env.ANTHROPIC_API_KEY, 'a');
});

test('CRETLI_AGENT_ENV_EXTRA re-allows names and prefixes', () => {
  const env = buildAgentChildEnv('opencode', {
    base: { ...ON, CRETLI_AGENT_ENV_EXTRA: 'ANTHROPIC_API_KEY, UNRELATED_*' },
  });
  assert.equal(env.ANTHROPIC_API_KEY, 'a');
  assert.equal(env.UNRELATED_SECRET, 'u');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test('explicit CRETLI_* overrides (verify, MCP bridge) survive the deny list', () => {
  const env = buildAgentChildEnv('tool', { base: ON, overrides: { CRETLI_DATA_DIR: '/d', CRETLI_MCP_TOKEN: 't' } });
  assert.equal(env.CRETLI_DATA_DIR, '/d');
  assert.equal(env.CRETLI_MCP_TOKEN, 't');
  assert.equal(env.CRETLI_SECRET, undefined);
});

test('wired call sites: no leaks from process.env', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, PARENT);
    delete process.env.CRETLI_AGENT_ENV_PASSTHROUGH;
    process.env.CRETLI_AGENT_ENV_ALLOWLIST = '1';
    const pty = buildInteractivePtyEnv({ localRuntimeHome: '/tmp/h' });
    assert.equal(pty.GITHUB_TOKEN, undefined);
    assert.equal(pty.ANTHROPIC_API_KEY, undefined);
    assert.equal(pty.PATH, PARENT.PATH);
    const ds = buildDeepSeekProcessEnv();
    assert.equal(ds.GITHUB_TOKEN, undefined);
    assert.equal(ds.OPENAI_API_KEY, undefined);
    assert.ok(ds.DEEPSEEK_API_KEY);
    const cl = buildClaudeProcessEnv();
    assert.equal(cl.GITHUB_TOKEN, undefined);
    assert.equal(cl.DEEPSEEK_API_KEY, undefined);
    const cx = buildCodexProcessEnv();
    assert.equal(cx.GITHUB_TOKEN, undefined);
    assert.equal(cx.ANTHROPIC_API_KEY, undefined);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('qwen: SDK-style merge of process.env + overlay is masked', () => {
  const merge = (base, overlay) => {
    const merged = { ...base, ...overlay };
    // Node omits undefined values when spawning.
    return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
  };
  const overlay = { ...buildAgentEnvMask('qwen', ON), DASHSCOPE_API_KEY: 'q', OPENAI_API_KEY: 'q', HOME: '/qwen-home' };
  const env = merge(PARENT, overlay);
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'CRETLI_SECRET', 'CURSOR_REMOTE_X', 'UNRELATED_SECRET', 'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'CODEBUDDY_API_KEY', 'OPENROUTER_API_KEY', 'MISTRAL_API_KEY', 'CODEX_API_KEY']) {
    assert.equal(env[k], undefined, k);
  }
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR']) assert.equal(env[k], PARENT[k]);
  assert.equal(env.HOME, '/qwen-home');
  assert.equal(env.DASHSCOPE_API_KEY, 'q');
  // Passthrough alias: no masking.
  assert.deepEqual(buildAgentEnvMask('qwen', { ...ON, CRETLI_AGENT_ENV_PASSTHROUGH: '1' }), {});
});

test('buildQwenProcessEnv masks the live process.env', async () => {
  const { buildQwenProcessEnv } = await import('../harnesses/qwen/qwen-api-key.js');
  const saved = { ...process.env };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-qwen-'));
  try {
    process.env.CRETLI_TEST_DATA_DIR = dataDir;
    process.env.CRETLI_DATA_DIR = dataDir;
    delete process.env.CRETLI_AGENT_ENV_PASSTHROUGH;
    process.env.CRETLI_AGENT_ENV_ALLOWLIST = '1';
    process.env.GITHUB_TOKEN = 'gh';
    process.env.ANTHROPIC_API_KEY = 'a';
    const overlay = buildQwenProcessEnv({ model: 'm' });
    const merged = { ...process.env, ...overlay };
    assert.equal(merged.GITHUB_TOKEN, undefined);
    assert.equal(merged.ANTHROPIC_API_KEY, undefined);
    assert.ok('GITHUB_TOKEN' in overlay);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('wired call sites without the flag: process.env passes through unchanged', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, PARENT);
    delete process.env.CRETLI_AGENT_ENV_PASSTHROUGH;
    delete process.env.CRETLI_AGENT_ENV_ALLOWLIST;
    assert.equal(buildInteractivePtyEnv({ localRuntimeHome: '/tmp/h' }).GITHUB_TOKEN, 'gh');
    assert.equal(buildDeepSeekProcessEnv().OPENAI_API_KEY, 'o');
    assert.equal(buildClaudeProcessEnv().GITHUB_TOKEN, 'gh');
    assert.equal(buildCodexProcessEnv().GITHUB_TOKEN, 'gh');
    const { buildQwenProcessEnv } = await import('../harnesses/qwen/qwen-api-key.js');
    assert.equal('GITHUB_TOKEN' in buildQwenProcessEnv({ model: 'm' }), false);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('codebuddy SDK path: masks dropped keys, keeps explicit CodeBuddy env (flag on)', async () => {
  const { buildQueryEnv } = await import('../harnesses/codebuddy/codebuddy-agent-ws.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-cb-'));
  const saved = { ...process.env };
  try {
    process.env.CRETLI_TEST_DATA_DIR = dataDir;
    process.env.CRETLI_DATA_DIR = dataDir;
    process.env.GITHUB_TOKEN = 'gh';
    process.env.CRETLI_SECRET = 's';
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.CODEBUDDY_API_KEY = 'cb';
    process.env.CRETLI_AGENT_ENV_ALLOWLIST = '1';
    const overlay = buildQueryEnv();
    const merged = { ...process.env, ...overlay }; // SDK-style merge
    assert.equal(merged.GITHUB_TOKEN, undefined);
    assert.equal(merged.CRETLI_SECRET, undefined);
    assert.equal(merged.ANTHROPIC_API_KEY, undefined);
    assert.equal(merged.CODEBUDDY_API_KEY, 'cb');
    assert.ok(merged.PATH);
    assert.ok(merged.HOME);
    // Flag off: no masking, behaviour unchanged.
    delete process.env.CRETLI_AGENT_ENV_ALLOWLIST;
    const off = buildQueryEnv();
    assert.equal('GITHUB_TOKEN' in off, false);
    assert.equal({ ...process.env, ...off }.GITHUB_TOKEN, 'gh');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('base keeps python/git-identity vars but not git credential helpers', () => {
  const env = buildAgentChildEnv('tool', {
    base: { ...ON, PYTHONPATH: '/p', VIRTUAL_ENV: '/v', GIT_AUTHOR_NAME: 'n', GIT_COMMITTER_EMAIL: 'e', GIT_ASKPASS: '/x', PIP_INDEX_URL: 'u' },
  });
  assert.equal(env.PYTHONPATH, '/p');
  assert.equal(env.VIRTUAL_ENV, '/v');
  assert.equal(env.GIT_AUTHOR_NAME, 'n');
  assert.equal(env.GIT_COMMITTER_EMAIL, 'e');
  assert.equal(env.GIT_ASKPASS, undefined);
  assert.equal(env.PIP_INDEX_URL, undefined);
});
