/**
 * Live Cursor SDK history-isolation probe. Uses Agent.create / Agent.resume
 * the same way Cretli does. Missing SDK or API key is a skip, not a pass.
 *
 * File-tool attempts run as separate native Glob/Grep/Read turns so a skipped
 * or still-running call cannot hide behind another tool. Conversation fork
 * goes through the production persist path in a child process whose data dir
 * is isolated before persist loads.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getEffectiveCursorApiKey } from './cursor-api-key.js';
import { loadCursorSdk, isCursorSdkAvailable } from './cursor-sdk.js';
import { readSdkRunStreamStep } from './sdk-run-idle-guard.js';
import { extractSdkStreamStatusError, isSdkRunFailureStatus } from './sdk-run-outcome.js';
import {
  applyCursorSdkIsolationConfig,
  collectSdkConversationToolCalls,
  collectSdkToolCallEvent,
  evaluateSdkHistoryIsolationEvidence,
  HELLO_PROBE_CONTENT_A,
  HELLO_PROBE_CONTENT_B,
  HISTORY_ISOLATION_MARKER,
  isCompletedSdkToolCall,
  prepareSdkWorkspaceHistoryIsolation,
  reloadSdkAgentForIgnore,
  stringifySdkToolPayload,
} from './sdk-history-isolation.js';
import { resolveModelSelection } from '../model-catalog.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORK_CLI = fileURLToPath(new URL('./sdk-history-isolation-fork-cli.js', import.meta.url));
const STREAM_POLL_MS = 5000;
const STREAM_DRAIN_MS = 8000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 60000;
const MAX_ATTEMPT_TIMEOUT_MS = 90000;
const MAX_ATTEMPT_RETRIES = 1;
const INCIDENT_REL = 'data/runtime-home/.cursor/projects/probe-workspace/agent-transcripts';
const TRANSCRIPT_BASENAME = 'agent-delegation-probe.jsonl';
const FILE_ATTEMPT_TOOLS = Object.freeze(['glob', 'grep', 'read']);
const SHELL_ATTEMPT_TOOLS = Object.freeze(['shell']);
const FOREIGN_TASK_RE = /mailbox arrows|queued-mail|FOREIGN_DELEGATION_MARKER/i;
const ASK_TASK_USER = 'Put Plan, Agent, and Ask into one dropdown on the send bar. Keep Ask read-only.';
const ASK_TASK_ASSISTANT = 'I will merge the three mode buttons into a single Plan / Agent / Ask control on the send bar.';
const ASK_TASK_LATER = 'Also add a keyboard shortcut for switching the dropdown.';

/**
 * @returns {Promise<{ skipped: true, reason: string } | { skipped: false, sdkVersion: string, hasApiKey: boolean }>}
 */
export async function resolveCursorSdkLiveProbeAvailability() {
  const available = await isCursorSdkAvailable();
  if (!available) return { skipped: true, reason: 'cursor_sdk_unavailable' };
  let sdkVersion = '';
  try {
    const pkgPath = path.join(REPO_ROOT, 'node_modules', '@cursor', 'sdk', 'package.json');
    sdkVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '';
  } catch {
    sdkVersion = 'unknown';
  }
  if (!getEffectiveCursorApiKey()) {
    return { skipped: true, reason: 'missing_api_key', sdkVersion };
  }
  return { skipped: false, sdkVersion, hasApiKey: true };
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} body
 */
function writeFile(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, 'utf8');
}

/**
 * @param {{ applyIgnore?: boolean }} [options]
 * @returns {{
 *   root: string,
 *   workspaceA: string,
 *   workspaceB: string,
 *   storeDir: string,
 *   transcriptAbs: string,
 *   transcriptDir: string,
 *   symlinkPath: string,
 *   extraTranscriptAbs: string,
 *   helloA: string,
 *   helloB: string,
 *   helloAContent: string,
 *   helloBContent: string,
 *   marker: string,
 *   ignoreApplied: boolean,
 * }}
 */
export function createSdkHistoryIsolationFixture(options = {}) {
  const applyIgnore = options.applyIgnore !== false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-sdk-hist-'));
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  const storeDir = path.join(root, 'sdk-agent-store', 'probe-session');
  const transcriptDir = path.join(workspaceA, INCIDENT_REL);
  const marker = HISTORY_ISOLATION_MARKER;
  fs.mkdirSync(storeDir, { recursive: true });
  writeFile(workspaceA, 'hello.txt', `${HELLO_PROBE_CONTENT_A}\n`);
  writeFile(workspaceA, 'ASK_TASK.md', 'Ask dropdown: Plan / Agent / Ask in one control.\n');
  writeFile(workspaceB, 'hello.txt', `${HELLO_PROBE_CONTENT_B}\n`);
  writeFile(transcriptDir, TRANSCRIPT_BASENAME, `${JSON.stringify({ text: `${marker} unfinished delegations` })}\n`);
  writeFile(path.join(workspaceA, 'data', 'chat-history'), 'delegations.json', `${JSON.stringify({ text: marker })}\n`);
  writeFile(path.join(workspaceA, 'data', 'sdk-agent-store'), 'session.json', `${JSON.stringify({ text: marker })}\n`);
  const extraTranscriptAbs = path.join(workspaceB, 'agent-transcripts', 'agent-other.jsonl');
  writeFile(path.dirname(extraTranscriptAbs), 'agent-other.jsonl', `${JSON.stringify({ text: `${marker} extra workspace` })}\n`);
  const transcriptAbs = path.join(transcriptDir, TRANSCRIPT_BASENAME);
  const symlinkPath = path.join(workspaceA, 'safe-link.txt');
  fs.symlinkSync(transcriptAbs, symlinkPath);
  if (applyIgnore) prepareSdkWorkspaceHistoryIsolation([workspaceA, workspaceB]);
  return {
    root,
    workspaceA,
    workspaceB,
    storeDir,
    transcriptAbs,
    transcriptDir,
    symlinkPath,
    extraTranscriptAbs,
    helloA: path.join(workspaceA, 'hello.txt'),
    helloB: path.join(workspaceB, 'hello.txt'),
    helloAContent: HELLO_PROBE_CONTENT_A,
    helloBContent: HELLO_PROBE_CONTENT_B,
    marker,
    ignoreApplied: applyIgnore,
  };
}

/**
 * @param {AsyncIterator<unknown>} streamIterator
 * @param {(event: unknown) => void} onEvent
 * @param {number} drainMs
 * @returns {Promise<boolean>} true when the stream ended
 */
async function drainSdkStream(streamIterator, onEvent, drainMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < drainMs) {
    const remaining = Math.max(1, drainMs - (Date.now() - startedAt));
    const step = await readSdkRunStreamStep(streamIterator, Math.min(1000, remaining));
    if (step.timedOut) continue;
    if (!step.step || step.step.done) return true;
    onEvent(step.step.value);
  }
  return false;
}

/**
 * @param {unknown} run
 * @param {unknown} [agentApi]
 * @param {string} [agentId]
 * @param {object[]} toolCalls
 */
async function harvestConversationToolCalls(run, toolCalls, agentApi = null, agentId = '') {
  if (run && typeof run.conversation === 'function') {
    try {
      const conversation = await run.conversation();
      collectSdkConversationToolCalls(conversation, toolCalls);
    } catch {
      // Conversation snapshot is optional evidence; stream events remain.
    }
  }
  const id = String(agentId || run?.agentId || '').trim();
  if (!id || typeof agentApi?.messages?.list !== 'function') return;
  try {
    const rows = await agentApi.messages.list(id, { limit: 80, offset: 0 });
    collectSdkConversationToolCalls(rows, toolCalls);
  } catch {
    // messages.list uses a different toolCall shape; skip if the API is unavailable.
  }
}

/**
 * @param {unknown} agent
 * @param {string} prompt
 * @param {number} timeoutMs
 * @param {unknown} [agentApi]
 * @returns {Promise<{ toolCalls: object[], assistantText: string, eventCount: number, runStatus: string, statusError: string, timedOut: boolean }>}
 */
async function runSdkTurn(agent, prompt, timeoutMs, agentApi = null) {
  const startedAt = Date.now();
  const toolCalls = [];
  let assistantText = '';
  let eventCount = 0;
  let statusError = '';
  let runStatus = '';
  let timedOut = false;
  let streamDone = false;
  const onEvent = (event) => {
    eventCount += 1;
    collectSdkToolCallEvent(event, toolCalls);
    const statusMessage = extractSdkStreamStatusError(event);
    if (statusMessage) statusError = statusMessage;
    const row = event && typeof event === 'object' ? /** @type {Record<string, unknown>} */ (event) : null;
    const inner = row && row.type === 'sdk_message' ? row.message : row;
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && inner.type === 'assistant') {
      const message = /** @type {Record<string, unknown>} */ (inner).message;
      const payload = message && typeof message === 'object' ? /** @type {Record<string, unknown>} */ (message) : null;
      if (typeof payload?.content === 'string') assistantText += payload.content;
      else if (Array.isArray(payload?.content)) {
        assistantText += payload.content
          .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
          .join('');
      }
    }
  };
  const run = await agent.send(prompt, { mode: 'agent' });
  const streamIterator = run.stream()[Symbol.asyncIterator]();
  while (Date.now() - startedAt < timeoutMs) {
    const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const step = await readSdkRunStreamStep(streamIterator, Math.min(STREAM_POLL_MS, remaining));
    if (step.timedOut) continue;
    if (!step.step || step.step.done) {
      streamDone = true;
      break;
    }
    onEvent(step.step.value);
  }
  if (!streamDone) {
    streamDone = await drainSdkStream(streamIterator, onEvent, STREAM_DRAIN_MS);
  }
  if (typeof run?.wait === 'function') {
    const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
    try {
      await Promise.race([
        run.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('wait_timeout')), remaining)),
      ]);
    } catch {
      // Stream may already be done; wait timeout is not extra evidence.
    }
  }
  await harvestConversationToolCalls(run, toolCalls, agentApi, String(agent?.agentId || ''));
  runStatus = typeof run?.status === 'string' ? run.status : '';
  const hasCompletedTool = toolCalls.some((call) => isCompletedSdkToolCall(call));
  if (!streamDone && run && typeof run.cancel === 'function' && runStatus === 'running') {
    timedOut = !hasCompletedTool;
    try { await run.cancel(); } catch { /* ignore */ }
    await drainSdkStream(streamIterator, onEvent, STREAM_DRAIN_MS);
    await harvestConversationToolCalls(run, toolCalls, agentApi, String(agent?.agentId || ''));
    runStatus = typeof run?.status === 'string' ? run.status : 'cancelled';
  }
  return { toolCalls, assistantText, eventCount, runStatus, statusError, timedOut };
}

function pathAttemptNeedles(absPath, fixture) {
  const absolute = String(absPath || '');
  const needles = [absolute];
  for (const root of [fixture.workspaceA, fixture.workspaceB, fixture.root]) {
    const prefix = `${root}/`;
    if (!absolute.startsWith(prefix)) continue;
    const rel = absolute.slice(prefix.length);
    if (rel) needles.push(rel);
  }
  const base = path.basename(absolute);
  if (base) needles.push(base);
  return [...new Set(needles.filter(Boolean))];
}

/**
 * @param {object} fixture
 * @returns {Array<{ id: string, toolNeedles?: string[], pathNeedles?: string[], resultNeedles?: string[] }>}
 */
export function buildHistoryIsolationRequiredAttempts(fixture) {
  return [
    { id: 'glob-root', toolNeedles: ['glob'] },
    { id: 'glob-transcript-dir', toolNeedles: ['glob'], pathNeedles: pathAttemptNeedles(fixture.transcriptDir, fixture) },
    { id: 'read-transcript', toolNeedles: ['read'], pathNeedles: [...pathAttemptNeedles(fixture.transcriptAbs, fixture), TRANSCRIPT_BASENAME] },
    { id: 'grep-marker', toolNeedles: ['grep'], pathNeedles: [fixture.marker] },
    { id: 'read-symlink', toolNeedles: ['read'], pathNeedles: pathAttemptNeedles(fixture.symlinkPath, fixture) },
    { id: 'glob-workspace-b', toolNeedles: ['glob'], pathNeedles: pathAttemptNeedles(fixture.workspaceB, fixture) },
    { id: 'read-extra', toolNeedles: ['read'], pathNeedles: [...pathAttemptNeedles(fixture.extraTranscriptAbs, fixture), 'agent-other.jsonl'] },
    {
      id: 'read-hello-a',
      toolNeedles: ['read'],
      pathNeedles: pathAttemptNeedles(fixture.helloA, fixture),
      resultNeedles: [fixture.helloAContent || HELLO_PROBE_CONTENT_A],
    },
    {
      id: 'read-hello-b',
      toolNeedles: ['read'],
      pathNeedles: pathAttemptNeedles(fixture.helloB, fixture),
      resultNeedles: [fixture.helloBContent || HELLO_PROBE_CONTENT_B],
    },
  ];
}

/**
 * @param {{ id: string }} attempt
 * @param {object} fixture
 * @returns {string}
 */
function buildSingleFileAttemptPrompt(attempt, fixture, retry = false) {
  const mustCall = retry
    ? 'You MUST invoke that native tool even if you expect empty, ignored, or denied. Skipping the tool call fails the probe. Do not use Shell.'
    : 'You MUST invoke that native tool. Do not skip it. Do not use Shell.';
  const done = `${mustCall} After the native tool finishes, reply with PROBE_FILE_DONE only.`;
  switch (attempt.id) {
    case 'glob-root':
      return `Call native Glob once with globPattern="**/*" (workspace root, no targetDirectory). ${done}`;
    case 'glob-transcript-dir':
      return `Call native Glob once with globPattern="**/*" and targetDirectory=${JSON.stringify(fixture.transcriptDir)}. ${done}`;
    case 'read-transcript':
      return `Call native Read once with path=${JSON.stringify(fixture.transcriptAbs)}. ${done}`;
    case 'grep-marker':
      return `Call native Grep once with pattern=${JSON.stringify(fixture.marker)} from the workspace root. ${done}`;
    case 'read-symlink':
      return `Call native Read once with path=${JSON.stringify(fixture.symlinkPath)}. ${done}`;
    case 'glob-workspace-b':
      return `Call native Glob once with globPattern="**/*" and targetDirectory=${JSON.stringify(fixture.workspaceB)}. ${done}`;
    case 'read-extra':
      return `Call native Read once with path=${JSON.stringify(fixture.extraTranscriptAbs)}. ${done}`;
    case 'read-hello-a':
      return `Call native Read once with path=${JSON.stringify(fixture.helloA)}. ${done}`;
    case 'read-hello-b':
      return `Call native Read once with path=${JSON.stringify(fixture.helloB)}. ${done}`;
    default:
      return `Call the native file tool required for ${attempt.id}. ${done}`;
  }
}

function buildShellPrompt(fixture) {
  return [
    'This is a security probe. You MUST call the native shell tool once.',
    `Run: cat ${JSON.stringify(fixture.transcriptAbs)}`,
    'Then reply with PROBE_SHELL_DONE only.',
  ].join('\n');
}

function buildHelloWarmupPrompt(fixture) {
  return `Call native Read once on ${fixture.helloA}. After the tool finishes, reply with PROBE_WARMUP_DONE only.`;
}

/**
 * @param {object} turn
 * @param {object} fixture
 * @param {object[]} [requiredAttempts]
 */
function evidenceForTurn(turn, fixture, requiredAttempts = []) {
  return evaluateSdkHistoryIsolationEvidence({
    toolCalls: turn.toolCalls,
    marker: fixture.marker,
    helloContents: [fixture.helloAContent || HELLO_PROBE_CONTENT_A, fixture.helloBContent || HELLO_PROBE_CONTENT_B],
    blockedBasenames: [TRANSCRIPT_BASENAME, 'agent-other.jsonl'],
    requiredAttempts,
  });
}

/**
 * @param {unknown} agent
 * @param {object} fixture
 * @param {object[]} attempts
 * @param {number} timeoutMs
 * @param {unknown} [agentApi]
 */
async function runFileAttemptsSeparately(agent, fixture, attempts, timeoutMs, agentApi = null) {
  /** @type {object[]} */
  const toolCalls = [];
  /** @type {Array<{ id: string, timedOut: boolean, runStatus: string, retries: number, toolCalls: object[] }>} */
  const turns = [];
  let assistantText = '';
  let failedRun = false;
  for (const attempt of attempts) {
    /** @type {object[]} */
    const attemptCalls = [];
    let timedOut = false;
    let runStatus = '';
    let retries = 0;
    let turnAssistant = '';
    for (let tryIndex = 0; tryIndex <= MAX_ATTEMPT_RETRIES; tryIndex += 1) {
      const turn = await runSdkTurn(
        agent,
        buildSingleFileAttemptPrompt(attempt, fixture, tryIndex > 0),
        timeoutMs,
        agentApi,
      );
      attemptCalls.push(...turn.toolCalls);
      turnAssistant += turn.assistantText;
      timedOut = turn.timedOut === true;
      runStatus = turn.runStatus;
      retries = tryIndex;
      const attemptEvidence = evidenceForTurn(
        { toolCalls: attemptCalls, assistantText: turnAssistant },
        fixture,
        [attempt],
      );
      if (attemptEvidence.missingAttempts.length === 0) {
        timedOut = false;
        break;
      }
    }
    toolCalls.push(...attemptCalls);
    assistantText += turnAssistant;
    turns.push({
      id: attempt.id,
      timedOut,
      runStatus,
      retries,
      toolCalls: attemptCalls,
    });
    const completedHere = attemptCalls.some((call) => isCompletedSdkToolCall(call));
    if ((timedOut && !completedHere) || (isSdkRunFailureStatus(runStatus) && !completedHere)) {
      failedRun = true;
    }
  }
  const evidence = evidenceForTurn({ toolCalls, assistantText }, fixture, attempts);
  const perAttemptMissing = attempts
    .filter((attempt) => {
      const turn = turns.find((row) => row.id === attempt.id);
      if (!turn) return true;
      return evidenceForTurn(turn, fixture, [attempt]).missingAttempts.length > 0;
    })
    .map((attempt) => attempt.id);
  const missingAttempts = [...new Set([...evidence.missingAttempts, ...perAttemptMissing])];
  return {
    toolCalls,
    assistantText,
    turns,
    failedRun,
    evidence: {
      ...evidence,
      missingAttempts,
      ok: evidence.ok && missingAttempts.length === 0 && !failedRun,
    },
  };
}

/**
 * @param {Array<{ name?: string }>} calls
 * @param {string} needle
 * @returns {boolean}
 */
function hasNativeTool(calls, needle) {
  const token = String(needle || '').toLowerCase();
  return (Array.isArray(calls) ? calls : []).some((call) => String(call?.name || '').toLowerCase().includes(token));
}

/**
 * @param {object | null} agent
 */
function closeSdkAgent(agent) {
  if (!agent || typeof agent.close !== 'function') return;
  try { agent.close(); } catch { /* ignore */ }
}

function compactAttempts(evidence) {
  return Array.isArray(evidence?.attempts)
    ? evidence.attempts.map((row) => ({
      id: row.id,
      completed: row.completed,
      callId: row.callId,
      name: row.name,
      status: row.status,
      argsExcerpt: row.argsExcerpt,
      resultExcerpt: row.resultExcerpt,
    }))
    : [];
}

function listDroppedIgnoredReads(evidence) {
  return (Array.isArray(evidence?.attempts) ? evidence.attempts : [])
    .filter((row) => (
      row?.completed !== true
      && String(row?.name || '').toLowerCase().includes('read')
      && String(row?.argsExcerpt || '').trim()
    ))
    .map((row) => String(row.id || ''));
}

/**
 * Production fork on an isolated persist dir (child process, before persist load).
 *
 * @param {object} fixture
 */
function executeIsolatedProductionFork(fixture) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-sdk-fork-data-'));
  const payloadPath = path.join(dataDir, 'payload.json');
  const resultPath = path.join(dataDir, 'result.json');
  fs.writeFileSync(payloadPath, JSON.stringify({
    workspaceFolder: fixture.workspaceA,
    extraTranscriptAbs: fixture.extraTranscriptAbs,
    resultPath,
  }), 'utf8');
  const spawned = spawnSync(process.execPath, [FORK_CLI, payloadPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      CRETLI_DATA_DIR: dataDir,
      CURSOR_REMOTE_DATA_DIR: dataDir,
      CRETLI_TEST_DATA_DIR: dataDir,
    },
  });
  if (spawned.status !== 0) {
    throw new Error(spawned.stderr || spawned.stdout || `fork cli exited ${spawned.status}`);
  }
  return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
}

function evaluateProductionForkRecord(record) {
  const parentChatId = String(record?.parentChatId || '');
  const delegationChatId = String(record?.delegationChatId || '');
  const fullPrompt = String(record?.full?.initialPrompt || '');
  const fullCopied = String(record?.full?.copiedText || '');
  const partialPrompt = String(record?.partial?.initialPrompt || '');
  const partialCopied = String(record?.partial?.copiedText || '');
  const persistOk = Boolean(record?.parentStillPresent)
    && !record?.parentForkParentChatId
    && Boolean(parentChatId)
    && Boolean(delegationChatId)
    && delegationChatId !== parentChatId
    && record?.full?.forkParentChatId === parentChatId
    && record?.partial?.forkParentChatId === parentChatId
    && record?.partial?.partial === true
    && fullPrompt.includes(parentChatId)
    && partialPrompt.includes(parentChatId)
    && fullPrompt.includes(ASK_TASK_USER)
    && fullPrompt.includes(ASK_TASK_ASSISTANT)
    && fullPrompt.includes(ASK_TASK_LATER)
    && partialPrompt.includes(ASK_TASK_USER)
    && partialPrompt.includes(ASK_TASK_ASSISTANT)
    && !partialPrompt.includes(ASK_TASK_LATER)
    && fullCopied.includes(ASK_TASK_USER)
    && fullCopied.includes(ASK_TASK_ASSISTANT)
    && fullCopied.includes(ASK_TASK_LATER)
    && partialCopied.includes(ASK_TASK_USER)
    && partialCopied.includes(ASK_TASK_ASSISTANT)
    && !partialCopied.includes(ASK_TASK_LATER)
    && fullPrompt.includes('Do not choose a previous agent')
    && /chat_show|chat_history/.test(fullPrompt)
    && /chat_show|chat_history/.test(partialPrompt)
    && !FOREIGN_TASK_RE.test(fullPrompt)
    && !FOREIGN_TASK_RE.test(fullCopied)
    && !FOREIGN_TASK_RE.test(partialPrompt)
    && !FOREIGN_TASK_RE.test(partialCopied);
  return { persistOk };
}

function assistantContinuedAskTask(text) {
  const body = String(text || '');
  if (!body.trim() || FOREIGN_TASK_RE.test(body)) return false;
  if (body.includes(ASK_TASK_ASSISTANT) || body.includes(ASK_TASK_USER)) return true;
  if (/three mode buttons/i.test(body)) return true;
  if (/keyboard shortcut/i.test(body) && /dropdown|send bar/i.test(body)) return true;
  return /Plan\s*\/\s*Agent\s*\/\s*Ask/i.test(body) && /send bar/i.test(body);
}

function buildSdkConnectOpts(input) {
  const opts = {
    apiKey: input.apiKey,
    model: input.model,
    local: {
      cwd: input.cwd,
      dirs: input.dirs,
      settingSources: ['project'],
      store: input.store,
    },
    mode: 'agent',
    disallowedTools: ['task'],
  };
  if (Array.isArray(input.tools) && input.tools.length) {
    opts.tools = [...input.tools];
  }
  return opts;
}

/**
 * @param {{ timeoutMs?: number }} [options]
 */
export async function runCursorSdkHistoryIsolationProbe(options = {}) {
  const availability = await resolveCursorSdkLiveProbeAvailability();
  if (availability.skipped) {
    return { ok: false, skipped: true, reason: availability.reason, sdkVersion: availability.sdkVersion || '' };
  }
  const timeoutMs = Math.min(
    MAX_ATTEMPT_TIMEOUT_MS,
    Number.isFinite(Number(options.timeoutMs))
      ? Math.max(30000, Number(options.timeoutMs))
      : DEFAULT_ATTEMPT_TIMEOUT_MS,
  );
  const fixture = createSdkHistoryIsolationFixture();
  const lateFixture = createSdkHistoryIsolationFixture({ applyIgnore: false });
  const apiKey = getEffectiveCursorApiKey();
  const model = resolveModelSelection('auto', 'auto');
  const fileAttempts = buildHistoryIsolationRequiredAttempts(fixture);
  const lateAttempts = buildHistoryIsolationRequiredAttempts(lateFixture);
  /** @type {string} */
  let agentId = '';
  let createAgent = null;
  let resumeAgent = null;
  let shellCreateAgent = null;
  let shellResumeAgent = null;
  let forkAgent = null;
  let lateAgent = null;
  let lateResumeAgent = null;
  try {
    const sdkModule = await loadCursorSdk();
    applyCursorSdkIsolationConfig(sdkModule);
    const { Agent, JsonlLocalAgentStore } = sdkModule;
    const fileConnectOpts = buildSdkConnectOpts({
      apiKey,
      model,
      cwd: fixture.workspaceA,
      dirs: [fixture.workspaceA, fixture.workspaceB],
      store: new JsonlLocalAgentStore(fixture.storeDir),
      tools: FILE_ATTEMPT_TOOLS,
    });
    const shellConnectOpts = buildSdkConnectOpts({
      apiKey,
      model,
      cwd: fixture.workspaceA,
      dirs: [fixture.workspaceA, fixture.workspaceB],
      store: new JsonlLocalAgentStore(path.join(fixture.root, 'sdk-agent-store', 'shell-session')),
      tools: SHELL_ATTEMPT_TOOLS,
    });
    createAgent = await Agent.create(fileConnectOpts);
    await reloadSdkAgentForIgnore(createAgent);
    agentId = String(createAgent.agentId || '');
    const createFiles = await runFileAttemptsSeparately(createAgent, fixture, fileAttempts, timeoutMs, Agent);
    closeSdkAgent(createAgent);
    createAgent = null;
    resumeAgent = await Agent.resume(agentId, fileConnectOpts);
    await reloadSdkAgentForIgnore(resumeAgent);
    const resumeFiles = await runFileAttemptsSeparately(resumeAgent, fixture, fileAttempts, timeoutMs, Agent);
    closeSdkAgent(resumeAgent);
    resumeAgent = null;
    shellCreateAgent = await Agent.create(shellConnectOpts);
    await reloadSdkAgentForIgnore(shellCreateAgent);
    const createShell = await runSdkTurn(shellCreateAgent, buildShellPrompt(fixture), timeoutMs, Agent);
    const shellAgentId = String(shellCreateAgent.agentId || '');
    closeSdkAgent(shellCreateAgent);
    shellCreateAgent = null;
    shellResumeAgent = await Agent.resume(shellAgentId, shellConnectOpts);
    await reloadSdkAgentForIgnore(shellResumeAgent);
    const resumeShell = await runSdkTurn(shellResumeAgent, buildShellPrompt(fixture), timeoutMs, Agent);
    closeSdkAgent(shellResumeAgent);
    shellResumeAgent = null;
    const forkRecord = executeIsolatedProductionFork(fixture);
    const forkPersist = evaluateProductionForkRecord(forkRecord);
    forkAgent = await Agent.create(buildSdkConnectOpts({
      apiKey,
      model,
      cwd: fixture.workspaceA,
      dirs: [fixture.workspaceA, fixture.workspaceB],
      store: new JsonlLocalAgentStore(path.join(fixture.root, 'sdk-agent-store', 'fork-session')),
    }));
    await reloadSdkAgentForIgnore(forkAgent);
    const forkTurn = await runSdkTurn(forkAgent, forkRecord.full.initialPrompt, timeoutMs, Agent);
    const forkAgentId = String(forkAgent.agentId || '');
    closeSdkAgent(forkAgent);
    forkAgent = null;
    const lateConnectOpts = buildSdkConnectOpts({
      apiKey,
      model,
      cwd: lateFixture.workspaceA,
      dirs: [lateFixture.workspaceA, lateFixture.workspaceB],
      store: new JsonlLocalAgentStore(lateFixture.storeDir),
      tools: FILE_ATTEMPT_TOOLS,
    });
    lateAgent = await Agent.create(lateConnectOpts);
    const lateWarmup = await runSdkTurn(lateAgent, buildHelloWarmupPrompt(lateFixture), timeoutMs, Agent);
    prepareSdkWorkspaceHistoryIsolation([lateFixture.workspaceA, lateFixture.workspaceB]);
    lateFixture.ignoreApplied = true;
    await reloadSdkAgentForIgnore(lateAgent);
    const lateFiles = await runFileAttemptsSeparately(lateAgent, lateFixture, lateAttempts, timeoutMs, Agent);
    const lateAgentId = String(lateAgent.agentId || '');
    closeSdkAgent(lateAgent);
    lateAgent = null;
    lateResumeAgent = await Agent.resume(lateAgentId, lateConnectOpts);
    await reloadSdkAgentForIgnore(lateResumeAgent);
    const lateResumeFiles = await runFileAttemptsSeparately(lateResumeAgent, lateFixture, lateAttempts, timeoutMs, Agent);
    const createFileEvidence = createFiles.evidence;
    const resumeFileEvidence = resumeFiles.evidence;
    const lateFileEvidence = lateFiles.evidence;
    const lateResumeEvidence = lateResumeFiles.evidence;
    const createShellBlob = stringifySdkToolPayload(createShell.toolCalls);
    const resumeShellBlob = stringifySdkToolPayload(resumeShell.toolCalls);
    const shellLeaked = createShellBlob.includes(fixture.marker) || resumeShellBlob.includes(fixture.marker);
    const droppedIgnoredReads = [...new Set([
      ...listDroppedIgnoredReads(createFileEvidence),
      ...listDroppedIgnoredReads(resumeFileEvidence),
      ...listDroppedIgnoredReads(lateFileEvidence),
      ...listDroppedIgnoredReads(lateResumeEvidence),
    ])];
    const forkBlob = `${forkTurn.assistantText}\n${stringifySdkToolPayload(forkTurn.toolCalls)}`;
    const markerInFork = forkBlob.includes(fixture.marker);
    const foreignTaskInFork = FOREIGN_TASK_RE.test(forkBlob);
    const askKept = assistantContinuedAskTask(forkTurn.assistantText) && !foreignTaskInFork;
    const distinctFork = Boolean(forkAgentId && forkAgentId !== agentId);
    const warmupHello = stringifySdkToolPayload(lateWarmup.toolCalls).includes(HELLO_PROBE_CONTENT_A);
    const failedRun = createFiles.failedRun
      || resumeFiles.failedRun
      || lateFiles.failedRun
      || lateResumeFiles.failedRun
      || createShell.timedOut
      || resumeShell.timedOut
      || forkTurn.timedOut
      || lateWarmup.timedOut
      || (isSdkRunFailureStatus(createShell.runStatus) && !createShell.toolCalls?.length)
      || (isSdkRunFailureStatus(resumeShell.runStatus) && !resumeShell.toolCalls?.length)
      || (isSdkRunFailureStatus(forkTurn.runStatus) && !forkTurn.toolCalls?.length);
    const toolsForced = hasNativeTool(createFiles.toolCalls, 'glob')
      && hasNativeTool(createFiles.toolCalls, 'read')
      && hasNativeTool(createFiles.toolCalls, 'grep')
      && hasNativeTool(createShell.toolCalls, 'shell')
      && hasNativeTool(resumeFiles.toolCalls, 'glob')
      && hasNativeTool(resumeFiles.toolCalls, 'read')
      && hasNativeTool(resumeShell.toolCalls, 'shell');
    const fileToolsOk = createFileEvidence.ok
      && resumeFileEvidence.ok
      && lateFileEvidence.ok
      && lateResumeEvidence.ok
      && warmupHello;
    const forkOk = distinctFork && askKept && !markerInFork && forkPersist.persistOk && !forkTurn.timedOut;
    const ok = fileToolsOk && forkOk && !failedRun && toolsForced;
    return {
      ok,
      skipped: false,
      sdkVersion: availability.sdkVersion,
      agentId,
      fixtureRoot: fixture.root,
      limitations: [
        ...(shellLeaked ? ['sdk_native_shell'] : []),
        ...(droppedIgnoredReads.length ? ['sdk_ignored_read_no_completed'] : []),
      ],
      create: {
        files: createFiles,
        shell: createShell,
        evidence: createFileEvidence,
        attempts: compactAttempts(createFileEvidence),
        toolsForced,
      },
      resume: {
        files: resumeFiles,
        shell: resumeShell,
        evidence: resumeFileEvidence,
        attempts: compactAttempts(resumeFileEvidence),
      },
      lateIgnore: {
        agentId: lateAgentId,
        warmupHello,
        files: lateFiles,
        evidence: lateFileEvidence,
        attempts: compactAttempts(lateFileEvidence),
        ignoreAfterCreate: true,
        activityBeforeIgnore: true,
        resume: {
          evidence: lateResumeEvidence,
          attempts: compactAttempts(lateResumeEvidence),
        },
      },
      shellIsolation: {
        ok: !shellLeaked && hasNativeTool(createShell.toolCalls, 'shell'),
        leaked: shellLeaked,
      },
      droppedIgnoredReads,
      fork: {
        agentId: forkAgentId,
        distinctAgent: distinctFork,
        assistantText: forkTurn.assistantText.slice(0, 500),
        toolCalls: forkTurn.toolCalls,
        markerInFork,
        askKept,
        persistOk: forkPersist.persistOk,
        parentChatId: forkRecord.parentChatId,
        forkParentChatId: forkRecord.full.forkParentChatId,
        partial: {
          copiedThroughSeq: forkRecord.partial.copiedThroughSeq,
          hasLaterAskTurn: /keyboard shortcut/i.test(forkRecord.partial.copiedText),
        },
      },
    };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      sdkVersion: availability.sdkVersion,
      agentId,
      error: err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err),
      fixtureRoot: fixture.root,
    };
  } finally {
    closeSdkAgent(createAgent);
    closeSdkAgent(resumeAgent);
    closeSdkAgent(shellCreateAgent);
    closeSdkAgent(shellResumeAgent);
    closeSdkAgent(forkAgent);
    closeSdkAgent(lateAgent);
    closeSdkAgent(lateResumeAgent);
  }
}
