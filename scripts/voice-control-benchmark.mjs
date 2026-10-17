#!/usr/bin/env node
/**
 * Voice control measurement harness (see docs/voice-control-coverage.md).
 *
 *   node scripts/voice-control-benchmark.mjs --validate   check corpus vs current tools (offline)
 *   node scripts/voice-control-benchmark.mjs --tokens     schema+instruction token baseline (offline)
 *   node scripts/voice-control-benchmark.mjs --live openai-mini|openai-flagship|gemini
 *       text-input replay against a real session. PAID: needs
 *       VOICE_BENCH_APPROVE_PAID=1 and a key in OPENAI_API_KEY / GEMINI_API_KEY.
 *
 * Paid-run budget knobs (all optional):
 *   VOICE_BENCH_CAP_USD    per-run cap in USD, default $5, hard maximum $25.
 *   VOICE_BENCH_REPEATS    replays per utterance, integer 1..20, default 5.
 *   VOICE_BENCH_OUTPUT     file that receives the result JSON (partial on abort).
 *
 * A run is refused up front when `utterances x repeats x per-turn estimate`
 * exceeds the cap, and it stops as soon as the running provider cost reaches it.
 * The cost helpers are pure so the paid path stays unit-testable without a call.
 *
 * The harness only reads lib/voice config; it changes no runtime behavior.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REALTIME_TOOLS,
  REALTIME_FLAGSHIP_MODEL,
  REALTIME_MINI_MODEL,
  buildRealtimeInstructions,
} from '../lib/voice/realtime-session-config.js';
import { toGeminiFunctionDeclarations, DEFAULT_GEMINI_LIVE_MODEL } from '../lib/voice/gemini-live-config.js';
import { TOKEN_RATES } from '../lib/usage/usage-rates.js';
import { percentile } from '../lib/voice/voice-session-diagnose.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS_PATH = path.join(here, '..', 'tests', 'fixtures', 'voice-control-corpus.json');
/** Default per-run budget for paid replay sessions. */
export const SESSION_CAP_USD = 5;
/** Hard ceiling for `VOICE_BENCH_CAP_USD`; no env value may raise the cap above it. */
export const MAX_SESSION_CAP_USD = 25;
export const MIN_REPEATS = 1;
export const MAX_REPEATS = 20;
export const DEFAULT_REPEATS = 5;
/** Below this many repeats p95 latency is too noisy to compare with the baseline. */
export const P95_MIN_REPEATS = 5;
/** Rough chars-per-token ratio; live runs replace it with provider usage numbers. */
export const CHARS_PER_TOKEN = 4;
export const SCENARIO_TURNS = 20;
/** Expected size of a spoken tool call in tokens; used by the up-front estimate. */
export const ASSUMED_OUTPUT_TOKENS = 40;
/** Backends `--live` accepts; each needs its own pricing row and credential. */
export const LIVE_BACKENDS = ['openai-mini', 'openai-flagship', 'gemini'];
/** Provider credential required before a paid run may start. */
export const LIVE_API_KEY_ENV = {
  'openai-mini': 'OPENAI_API_KEY',
  'openai-flagship': 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export function loadCorpus() {
  return JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')).utterances;
}

const toolParameters = new Map(REALTIME_TOOLS.map((tool) => [tool.name, tool.parameters || {}]));

/**
 * Checks the expected arguments of one corpus entry against the live tool
 * schema: unknown keys and out-of-enum values would make a replay score
 * impossible targets, so they fail `--validate` instead of a paid run.
 *
 * @param {string} id corpus entry id, used in the problem text
 * @param {string} toolName tool the entry expects
 * @param {Record<string, unknown>} args expected arguments
 * @param {string[]} problems collector
 * @returns {void}
 */
function checkExpectedArgs(id, toolName, args, problems) {
  const schema = toolParameters.get(toolName);
  if (!schema) return;
  const properties = schema.properties || {};
  for (const [key, value] of Object.entries(args || {})) {
    const property = properties[key];
    if (!property) {
      problems.push(`${id}: arg "${key}" is not in ${toolName}'s schema`);
      continue;
    }
    if (Array.isArray(property.enum) && !property.enum.includes(value)) {
      problems.push(`${id}: ${toolName}.${key}=${JSON.stringify(value)} is not one of ${property.enum.join('|')}`);
    }
  }
  for (const required of schema.required || []) {
    if (!(required in (args || {}))) problems.push(`${id}: missing required arg "${required}" for ${toolName}`);
  }
}

/** @returns {string[]} problems; empty when the corpus is consistent with REALTIME_TOOLS */
export function validateCorpus(utterances = loadCorpus()) {
  const names = new Set(REALTIME_TOOLS.map((tool) => tool.name));
  const problems = [];
  const ids = new Set();
  for (const item of utterances) {
    if (ids.has(item.id)) problems.push(`duplicate id ${item.id}`);
    ids.add(item.id);
    if (!['pl', 'en'].includes(item.lang)) problems.push(`${item.id}: bad lang`);
    if (!item.text) problems.push(`${item.id}: empty text`);
    if (!item.target || !('action' in item.target)) problems.push(`${item.id}: missing target`);
    if (item.tool && !names.has(item.tool)) {
      problems.push(`${item.id}: unknown tool ${item.tool}`);
      continue;
    }
    if (!item.tool) continue;
    const alternatives = Array.isArray(item.argsAny) && item.argsAny.length ? item.argsAny : null;
    if (alternatives) {
      for (const alternative of alternatives) checkExpectedArgs(item.id, item.tool, alternative, problems);
    } else {
      checkExpectedArgs(item.id, item.tool, item.args || {}, problems);
    }
  }
  if (utterances.length < 40) problems.push(`corpus has ${utterances.length} utterances, need >= 40`);
  return problems;
}

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Offline schema+instruction token estimates per backend. */
export function measureSchemaTokens() {
  const rows = [];
  for (const lang of ['en', 'pl']) {
    const instructions = estimateTokens(buildRealtimeInstructions({ lang }));
    const openaiTools = estimateTokens(REALTIME_TOOLS);
    const geminiTools = estimateTokens(toGeminiFunctionDeclarations());
    rows.push({ lang, backend: 'openai-mini', model: REALTIME_MINI_MODEL, tools: openaiTools, instructions });
    rows.push({ lang, backend: 'openai-flagship', model: REALTIME_FLAGSHIP_MODEL, tools: openaiTools, instructions });
    rows.push({ lang, backend: 'gemini', model: DEFAULT_GEMINI_LIVE_MODEL, tools: geminiTools, instructions });
  }
  return rows.map((row) => ({ ...row, total: row.tools + row.instructions }));
}

/** @type {Map<string, number>|null} */
let schemaTokenCache = null;

/**
 * @param {string} backend
 * @param {string} [lang]
 * @returns {number|null} fixed prompt tokens (tools + instructions) for a backend
 */
function schemaTotalTokens(backend, lang = 'en') {
  if (!schemaTokenCache) {
    schemaTokenCache = new Map();
    for (const row of measureSchemaTokens()) schemaTokenCache.set(`${row.backend}:${row.lang}`, row.total);
  }
  return schemaTokenCache.get(`${backend}:${lang}`)
    ?? schemaTokenCache.get(`${backend}:en`)
    ?? null;
}

/** Prompt-side cost of the fixed prefix over a scenario: 1 uncached turn + (n-1) cached turns. */
export function estimateScenarioPrefixUsd(totalTokens, rates, turns = SCENARIO_TURNS) {
  if (!rates) return null;
  return (totalTokens * (rates.textInput + (turns - 1) * rates.cachedInput)) / 1e6;
}

/**
 * Token rates of a live backend. The flagship has no row of its own in
 * `TOKEN_RATES`, so it falls back to the closest flagship rate there.
 *
 * @param {string} backend
 * @returns {{textInput: number, cachedInput: number, textOutput: number}|null}
 */
export function ratesForBackend(backend) {
  if (backend === 'gemini') return TOKEN_RATES.gemini ?? null;
  if (backend === 'openai-flagship') {
    return TOKEN_RATES[REALTIME_FLAGSHIP_MODEL] || TOKEN_RATES['gpt-realtime'] || null;
  }
  return TOKEN_RATES[REALTIME_MINI_MODEL] || null;
}

/**
 * Text-only estimate of one replay turn: the fixed prefix, the utterance and a
 * short tool-call JSON answer.
 *
 * @param {{ promptTokens: number, outputTokens?: number, rates: object }} options
 * @returns {number|null}
 */
export function estimateTurnUsd({ promptTokens, outputTokens = ASSUMED_OUTPUT_TOKENS, rates }) {
  if (!rates || !Number.isFinite(promptTokens)) return null;
  return (promptTokens * rates.textInput + outputTokens * rates.textOutput) / 1e6;
}

/**
 * @param {string} backend
 * @param {{ lang?: string, text?: string }} item corpus entry
 * @returns {number|null} estimated USD for one replay of that utterance
 */
export function estimateTurnUsdForItem(backend, item) {
  const rates = ratesForBackend(backend);
  const schemaTokens = schemaTotalTokens(backend, item.lang);
  if (!rates || schemaTokens == null) return null;
  return estimateTurnUsd({ promptTokens: schemaTokens + estimateTokens(item.text || ''), rates });
}

/**
 * @param {{ backend: string, utterances?: Array<object> }} options
 * @returns {number|null} mean per-turn estimate over the corpus
 */
export function estimateCorpusPerTurnUsd({ backend, utterances = loadCorpus() }) {
  const values = utterances.map((item) => estimateTurnUsdForItem(backend, item)).filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * @param {{ utteranceCount: number, repeats: number, perTurnUsd: number|null, capUsd: number }} options
 * @returns {{ allowed: boolean, sessions: number, estimatedUsd: number|null, capUsd: number, reason: string|null }}
 */
export function planLiveRun({ utteranceCount, repeats, perTurnUsd, capUsd }) {
  const sessions = utteranceCount * repeats;
  if (!Number.isFinite(perTurnUsd)) {
    return { allowed: false, sessions, estimatedUsd: null, capUsd, reason: 'no token rates for this backend' };
  }
  const estimatedUsd = sessions * perTurnUsd;
  const allowed = estimatedUsd <= capUsd;
  return {
    allowed,
    sessions,
    estimatedUsd,
    capUsd,
    reason: allowed
      ? null
      : `estimated $${estimatedUsd.toFixed(4)} for ${sessions} sessions exceeds the $${capUsd} cap`,
  };
}

/**
 * Accumulates the provider cost of finished sessions and reports when the cap
 * has been reached. Pure in-memory state, so it is unit-testable.
 *
 * @param {number} capUsd
 * @returns {{ capUsd: number, totalUsd: number, exceeded: boolean, add: (usd: number) => number }}
 */
export function createCostTracker(capUsd) {
  let totalUsd = 0;
  return {
    capUsd,
    get totalUsd() {
      return totalUsd;
    },
    get exceeded() {
      return totalUsd >= capUsd;
    },
    /** Adds a measured (or fallback-estimated) session cost and returns the new total. */
    add(usd) {
      const value = Number(usd);
      if (Number.isFinite(value) && value > 0) totalUsd += value;
      return totalUsd;
    },
  };
}

/**
 * Prices the provider's own usage report. Text replay never bills audio, so
 * only the text input/cached/output rates apply.
 *
 * @param {string} backend
 * @param {object|null} usage provider usage object
 * @returns {number} USD; 0 when the usage report is missing
 */
export function providerUsageUsd(backend, usage) {
  const rates = ratesForBackend(backend);
  if (!rates || !usage) return 0;
  if (backend === 'gemini') {
    const prompt = Number(usage.promptTokenCount) || 0;
    const cached = Number(usage.cachedContentTokenCount) || 0;
    const output = Number(usage.candidatesTokenCount) || 0;
    return (Math.max(0, prompt - cached) * rates.textInput + cached * rates.cachedInput + output * rates.textOutput) / 1e6;
  }
  const input = Number(usage.input_tokens) || 0;
  const cached = Number(usage.input_token_details?.cached_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  return (Math.max(0, input - cached) * rates.textInput + cached * rates.cachedInput + output * rates.textOutput) / 1e6;
}

/**
 * @param {string} backend
 * @param {Record<string, string|undefined>} env
 * @returns {{ ok: boolean, envVar: string|null, key: string, problem: string|null }}
 */
export function resolveLiveCredential(backend, env = process.env) {
  const envVar = LIVE_API_KEY_ENV[backend] || null;
  if (!envVar) {
    return { ok: false, envVar: null, key: '', problem: `unknown backend ${JSON.stringify(backend)}; use ${LIVE_BACKENDS.join('|')}` };
  }
  const key = String(env[envVar] ?? '').trim();
  if (!key) return { ok: false, envVar, key: '', problem: `missing ${envVar} for a ${backend} run` };
  return { ok: true, envVar, key, problem: null };
}

/**
 * @param {unknown} raw `VOICE_BENCH_REPEATS`
 * @returns {{ ok: boolean, repeats: number, problem: string|null }}
 */
export function validateRepeats(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, repeats: DEFAULT_REPEATS, problem: null };
  const repeats = Number(text);
  if (!Number.isInteger(repeats) || repeats < MIN_REPEATS || repeats > MAX_REPEATS) {
    return {
      ok: false,
      repeats: DEFAULT_REPEATS,
      problem: `VOICE_BENCH_REPEATS must be an integer ${MIN_REPEATS}..${MAX_REPEATS} (got ${JSON.stringify(raw)})`,
    };
  }
  return { ok: true, repeats, problem: null };
}

/**
 * @param {unknown} raw `VOICE_BENCH_CAP_USD`
 * @returns {{ ok: boolean, capUsd: number, source: 'default'|'env', problem: string|null }}
 */
export function resolveCapUsd(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, capUsd: SESSION_CAP_USD, source: 'default', problem: null };
  const capUsd = Number(text);
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    return { ok: false, capUsd: SESSION_CAP_USD, source: 'env', problem: `VOICE_BENCH_CAP_USD must be a positive number (got ${JSON.stringify(raw)})` };
  }
  if (capUsd > MAX_SESSION_CAP_USD) {
    return {
      ok: false,
      capUsd: SESSION_CAP_USD,
      source: 'env',
      problem: `VOICE_BENCH_CAP_USD must stay at or below the hard maximum $${MAX_SESSION_CAP_USD} (got ${JSON.stringify(raw)})`,
    };
  }
  return { ok: true, capUsd, source: 'env', problem: null };
}

/**
 * Writes the result JSON to `VOICE_BENCH_OUTPUT` when set and always prints it,
 * so an aborted run still leaves its partial results behind.
 *
 * @param {object} result
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} file path, or null when only stdout was written
 */
export function writeResults(result, env = process.env) {
  const text = JSON.stringify(result, null, 2);
  console.log(text);
  const target = String(env.VOICE_BENCH_OUTPUT ?? '').trim();
  if (!target) return null;
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${text}\n`);
  return resolved;
}

/**
 * Runs one replay per utterance/repeat and stops as soon as the running cost
 * reaches the cap. `replay` is injectable so the abort path is covered without
 * any provider call.
 *
 * @param {{
 *   items: Array<{ id: string }>,
 *   repeats: number,
 *   replay: (item: { id: string }) => Promise<{ id: string, correct: boolean|null, latencyMs: number, costUsd: number }>,
 *   tracker: ReturnType<typeof createCostTracker>,
 * }} options
 * @returns {Promise<{ runs: Array<object>, aborted: boolean }>}
 */
export async function runReplaySessions({ items, repeats, replay, tracker }) {
  const runs = [];
  for (const item of items) {
    for (let i = 0; i < repeats; i += 1) {
      const run = await replay(item);
      runs.push(run);
      tracker.add(run.costUsd);
      if (tracker.exceeded) return { runs, aborted: true };
    }
  }
  return { runs, aborted: false };
}

function printTokens() {
  const rates = {
    'openai-mini': TOKEN_RATES[REALTIME_MINI_MODEL],
    'openai-flagship': TOKEN_RATES[REALTIME_FLAGSHIP_MODEL] || TOKEN_RATES['gpt-realtime'],
    gemini: null,
  };
  const rows = measureSchemaTokens().map((row) => ({
    ...row,
    prefixUsd20Turns: estimateScenarioPrefixUsd(row.total, rates[row.backend]),
  }));
  console.log(JSON.stringify({ charsPerToken: CHARS_PER_TOKEN, turns: SCENARIO_TURNS, rows }, null, 2));
}

const normalise = (value) => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ł/g, 'l');

/**
 * @param {Record<string, unknown>|undefined} actualArgs
 * @param {Record<string, unknown>|undefined} expectedArgs
 * @returns {boolean}
 */
function matchArgs(actualArgs, expectedArgs) {
  return Object.entries(expectedArgs || {}).every(([key, want]) => normalise(actualArgs?.[key]).includes(normalise(want)));
}

/**
 * Scores one tool call against a corpus entry.
 *
 * Matching rule: the tool name must match, then either the single `args` object
 * or one of the `argsAny` alternatives must match. Matching compares only the
 * listed keys, case- and diacritic-insensitively, by substring; a missing key
 * in the model call fails that alternative. An entry with neither `args` nor
 * `argsAny` scores on the tool name alone.
 */
export function scoreCall(item, call) {
  if (!item.tool) return null;
  if (!call || call.name !== item.tool) return false;
  const alternatives = Array.isArray(item.argsAny) && item.argsAny.length ? item.argsAny : [item.args || {}];
  return alternatives.some((expected) => matchArgs(call.args, expected));
}

export function summarizeRuns(runs) {
  const scored = runs.filter((run) => run.correct !== null);
  const latencies = runs.map((run) => run.latencyMs).filter(Number.isFinite);
  return {
    runs: runs.length,
    accuracy: scored.length ? scored.filter((run) => run.correct).length / scored.length : null,
    p95LatencyMs: percentile([...latencies].sort((a, b) => a - b), 95),
  };
}

async function runLive(backend) {
  if (process.env.VOICE_BENCH_APPROVE_PAID !== '1') {
    console.error('Refusing paid run: set VOICE_BENCH_APPROVE_PAID=1 after a human approved the budget (cap $5/session).');
    process.exit(2);
  }
  const credential = resolveLiveCredential(backend, process.env);
  if (!credential.ok) {
    console.error(`Refusing paid run: ${credential.problem}.`);
    process.exit(2);
  }
  const repeatsResult = validateRepeats(process.env.VOICE_BENCH_REPEATS);
  if (!repeatsResult.ok) {
    console.error(`Refusing paid run: ${repeatsResult.problem}.`);
    process.exit(2);
  }
  const capResult = resolveCapUsd(process.env.VOICE_BENCH_CAP_USD);
  if (!capResult.ok) {
    console.error(`Refusing paid run: ${capResult.problem}.`);
    process.exit(2);
  }
  const repeats = repeatsResult.repeats;
  const corpus = loadCorpus();
  const perTurnUsd = estimateCorpusPerTurnUsd({ backend, utterances: corpus });
  const plan = planLiveRun({ utteranceCount: corpus.length, repeats, perTurnUsd, capUsd: capResult.capUsd });
  if (!plan.allowed) {
    console.error(`Refusing paid run: ${plan.reason}. Lower VOICE_BENCH_REPEATS or raise VOICE_BENCH_CAP_USD (hard maximum $${MAX_SESSION_CAP_USD}).`);
    process.exit(2);
  }
  if (repeats < P95_MIN_REPEATS) {
    console.error(`Warning: VOICE_BENCH_REPEATS=${repeats} < ${P95_MIN_REPEATS}; p95 latency is not comparable with the baseline.`);
  }
  console.error(`Paid run plan: ${plan.sessions} sessions, estimated $${plan.estimatedUsd.toFixed(4)} against a $${capResult.capUsd} cap.`);
  const { default: WebSocket } = await import('ws');
  const tracker = createCostTracker(capResult.capUsd);
  const { runs, aborted } = await runReplaySessions({
    items: corpus,
    repeats,
    tracker,
    replay: (item) => replayOnce(WebSocket, backend, item, {
      apiKey: credential.key,
      fallbackUsd: estimateTurnUsdForItem(backend, item) ?? 0,
    }),
  });
  const result = {
    backend,
    repeats,
    plannedSessions: plan.sessions,
    estimatedUsd: plan.estimatedUsd,
    capUsd: capResult.capUsd,
    spentUsd: tracker.totalUsd,
    usageMissingSessions: runs.filter((run) => run.usageMissing).length,
    aborted,
    partial: aborted,
    ...summarizeRuns(runs),
  };
  const outputPath = writeResults(result);
  if (aborted) {
    console.error(`Aborted at the $${capResult.capUsd} cap after ${runs.length} session(s); partial results ${outputPath ? `written to ${outputPath}` : 'printed above'}.`);
    process.exit(3);
  }
}

/**
 * One fresh session per run: text turn in, first function call out. When the
 * provider never reports usage, the planned per-turn estimate stands in so the
 * running cap cannot silently undercount.
 */
function replayOnce(WebSocket, backend, item, options = {}) {
  const { apiKey = '', fallbackUsd = 0 } = options;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let usage = null;
    let call = null;
    let callLatencyMs = NaN;
    let settled = false;
    let graceTimer = null;
    let ws;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      try { ws?.close(); } catch { /* already closed */ }
      resolve({
        id: item.id,
        correct: scoreCall(item, call),
        latencyMs: call ? callLatencyMs : NaN,
        costUsd: usage ? providerUsageUsd(backend, usage) : fallbackUsd,
        usageMissing: !usage,
      });
    };
    const hardTimer = setTimeout(settle, 20000);
    const noteCall = (observed) => {
      if (settled || call) return;
      call = observed;
      callLatencyMs = Date.now() - startedAt;
      // Give the provider a moment to report usage before closing the socket.
      graceTimer = setTimeout(settle, 3000);
    };
    const lang = item.lang;
    if (backend === 'gemini') {
      ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`);
      ws.on('open', () => ws.send(JSON.stringify({ setup: {
        model: `models/${DEFAULT_GEMINI_LIVE_MODEL}`,
        generationConfig: { responseModalities: ['AUDIO'] },
        systemInstruction: { parts: [{ text: buildRealtimeInstructions({ lang }) }] },
        tools: [{ functionDeclarations: toGeminiFunctionDeclarations() }],
      } })));
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.usageMetadata) usage = msg.usageMetadata;
        if (msg.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text: item.text } }));
        const fc = msg.toolCall?.functionCalls?.[0];
        if (fc) noteCall({ name: fc.name, args: fc.args });
        if (msg.serverContent?.turnComplete) settle();
      });
    } else {
      const model = backend === 'openai-flagship' ? REALTIME_FLAGSHIP_MODEL : REALTIME_MINI_MODEL;
      ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', instructions: buildRealtimeInstructions({ lang }), tools: REALTIME_TOOLS, tool_choice: 'auto', output_modalities: ['text'] } }));
        ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: item.text }] } }));
        ws.send(JSON.stringify({ type: 'response.create' }));
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.response?.usage) usage = msg.response.usage;
        if (msg.type === 'response.function_call_arguments.done') {
          let args = {};
          try { args = JSON.parse(msg.arguments || '{}'); } catch { /* keep empty */ }
          noteCall({ name: msg.name, args });
        }
        if (msg.type === 'response.done') settle();
      });
    }
    ws.on('error', settle);
  });
}

const entry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entry) {
  const args = process.argv.slice(2);
  if (args.includes('--validate')) {
    const problems = validateCorpus();
    console.log(problems.length ? problems.join('\n') : `corpus ok (${loadCorpus().length} utterances)`);
    process.exit(problems.length ? 1 : 0);
  } else if (args.includes('--tokens')) {
    printTokens();
  } else if (args.includes('--live')) {
    await runLive(args[args.indexOf('--live') + 1]);
  } else {
    console.error('usage: --validate | --tokens | --live openai-mini|openai-flagship|gemini');
    process.exit(1);
  }
}
