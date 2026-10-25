import fs from 'fs';
import type { AgentModeOption } from '@cursor/sdk';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { getEffectiveCursorApiKey } from './cursor-api-key.ts';
import { loadCursorSdk } from './cursor-sdk.ts';
import { isSdkAuthenticationError } from './sdk-auth-recovery.ts';
import { extractSdkStreamStatusError, isSdkRunFailureStatus } from './sdk-run-outcome.ts';
import { normalizeSdkMode } from './sdk-mode.ts';
import { normalizeCatalogModelValue, resolveModelSelection } from '../model-catalog.js';
import { readSdkRunStreamStep } from './sdk-run-idle-guard.ts';
import {
  buildContextPressureAssessment,
  collectChatHistoryContextStats,
  collectSdkLocalStoreStats,
} from './sdk-context-stats.ts';
import { resolveDataPath } from '../runtime-paths.js';
import {
  applyCursorSdkIsolationConfig,
  prepareSdkWorkspaceHistoryIsolation,
  reloadSdkAgentForIgnore,
} from './sdk-history-isolation.ts';

const SDK_LOCAL_STORE_ROOT = resolveDataPath('sdk-agent-store');
const DEFAULT_PROBE_PROMPT = '[CRETLI_PROBE] Reply with exactly: PROBE_OK';
const DEFAULT_PROBE_TIMEOUT_MS = 120000;
const STREAM_POLL_MS = 5000;

function readErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message || '');
  }
  return String(err || '');
}

export async function probeSdkAgentMessages(agentId: unknown, limit = 200): Promise<Record<string, unknown>> {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) {
    return { ok: false, skipped: true, reason: 'missing_agent_id' };
  }
  const apiKey = getEffectiveCursorApiKey();
  if (!apiKey) {
    return { ok: false, error: 'missing_api_key' };
  }
  const startedAt = Date.now();
  try {
    const { Agent } = await loadCursorSdk();
    const rows = await Agent.messages.list(normalizedAgentId, {
      limit: Math.min(Math.max(Number(limit) || 200, 1), 500),
      offset: 0,
    });
    return {
      ok: true,
      agentId: normalizedAgentId,
      messageCount: Array.isArray(rows) ? rows.length : 0,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = readErrorMessage(err);
    return {
      ok: false,
      agentId: normalizedAgentId,
      error: message,
      isAuthenticationError: isSdkAuthenticationError(message),
      durationMs: Date.now() - startedAt,
    };
  }
}

export async function probeSdkAgentRun(input: {
  chat: Record<string, unknown>;
  cwd: string;
  mode: 'resume' | 'create';
  probePrompt?: string;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const chat = input.chat;
  const cwd = String(input.cwd || '').trim();
  const mode = input.mode === 'create' ? 'create' : 'resume';
  const probePrompt = String(input.probePrompt || DEFAULT_PROBE_PROMPT).trim();
  const timeoutMs = Number.isFinite(Number(input.timeoutMs))
    ? Math.max(10000, Number(input.timeoutMs))
    : DEFAULT_PROBE_TIMEOUT_MS;
  const apiKey = getEffectiveCursorApiKey();
  if (!apiKey) {
    return { ok: false, mode, error: 'missing_api_key' };
  }
  if (!cwd) {
    return { ok: false, mode, error: 'missing_cwd' };
  }
  const sdkAgentId = typeof chat.sdkAgentId === 'string' ? chat.sdkAgentId.trim() : '';
  if (mode === 'resume' && !sdkAgentId) {
    return { ok: false, mode, skipped: true, reason: 'missing_sdk_agent_id' };
  }
  const modelValue = normalizeCatalogModelValue(chat.model) || 'auto';
  const modelSelection = resolveModelSelection(modelValue, 'auto');
  const sdkMode = normalizeSdkMode(chat.sdkMode);
  const startedAt = Date.now();
  let agent = null;
  let run = null;
  let agentId = '';
  let firstAssistantText = '';
  let statusError = '';
  let eventCount = 0;
  let runStatus = '';
  try {
    const sdkModule = await loadCursorSdk();
    applyCursorSdkIsolationConfig(sdkModule);
    const { Agent, JsonlLocalAgentStore } = sdkModule;
    const probeSessionKey =
      mode === 'create' ? `probe-${randomUUID()}` : String(chat.cursorSessionId || '').trim();
    const safeSessionKey = probeSessionKey.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storeDir = path.join(SDK_LOCAL_STORE_ROOT, safeSessionKey);
    fs.mkdirSync(storeDir, { recursive: true });
    prepareSdkWorkspaceHistoryIsolation([cwd]);
    const localOptions = {
      cwd,
      settingSources: ['project' as const],
      store: new JsonlLocalAgentStore(storeDir),
    };
    const connectOpts = {
      apiKey,
      model: modelSelection,
      local: localOptions,
      // The SDK type has no 'ask'; the runtime accepts every SdkConversationMode (tsc: TS2322).
      mode: sdkMode as AgentModeOption,
    };
    if (mode === 'resume') {
      agent = await Agent.resume(sdkAgentId, connectOpts);
    } else {
      agent = await Agent.create(connectOpts);
    }
    await reloadSdkAgentForIgnore(agent);
    agentId = typeof agent?.agentId === 'string' ? agent.agentId : '';
    run = await agent.send(probePrompt, { mode: sdkMode as AgentModeOption });
    const streamIterator = run.stream()[Symbol.asyncIterator]();
    while (Date.now() - startedAt < timeoutMs) {
      const step = await readSdkRunStreamStep(streamIterator, STREAM_POLL_MS);
      if (step.timedOut) continue;
      const streamStep = step.step as IteratorResult<unknown> | null | undefined;
      if (!streamStep || streamStep.done) break;
      const event = streamStep.value as { type?: unknown; message?: { content?: unknown } } | null;
      eventCount += 1;
      const statusMessage = extractSdkStreamStatusError(event);
      if (statusMessage) statusError = statusMessage;
      if (event && typeof event === 'object' && event.type === 'assistant') {
        const message = event.message;
        if (message && typeof message.content === 'string') {
          firstAssistantText = message.content.slice(0, 240);
        } else if (Array.isArray(message?.content)) {
          firstAssistantText = (message.content as Array<{ text?: unknown } | null>)
            .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
            .join('')
            .slice(0, 240);
        }
        if (firstAssistantText.trim()) break;
      }
    }
    runStatus = typeof run?.status === 'string' ? run.status : '';
    const resolvedResult = typeof run?.result === 'string' ? run.result.trim() : '';
    const failureMessage = statusError || resolvedResult || readErrorMessage(null);
    const timedOutWithoutReply =
      !firstAssistantText.trim() &&
      !statusError &&
      Date.now() - startedAt >= timeoutMs - STREAM_POLL_MS;
    const hungRunning =
      !firstAssistantText.trim() &&
      !statusError &&
      (runStatus === 'running' || runStatus === 'started') &&
      Date.now() - startedAt >= Math.min(timeoutMs, 30000);
    const failed =
      isSdkRunFailureStatus(runStatus) || !!statusError || timedOutWithoutReply || hungRunning;
    return {
      ok: !failed,
      mode,
      agentId,
      runId: typeof run?.id === 'string' ? run.id : null,
      runStatus: runStatus || null,
      eventCount,
      firstAssistantText: firstAssistantText || null,
      statusError: statusError || null,
      runResult: resolvedResult || null,
      isAuthenticationError: isSdkAuthenticationError(statusError || resolvedResult || failureMessage),
      timedOutWithoutReply,
      hungRunning,
      durationMs: Date.now() - startedAt,
      probePrompt,
      storeDir: mode === 'create' ? storeDir : null,
    };
  } catch (err) {
    const message = readErrorMessage(err);
    return {
      ok: false,
      mode,
      agentId: agentId || sdkAgentId || null,
      error: message,
      statusError: statusError || null,
      isAuthenticationError: isSdkAuthenticationError(message || statusError),
      durationMs: Date.now() - startedAt,
      probePrompt,
    };
  } finally {
    if (run && typeof run.cancel === 'function' && runStatus !== 'finished') {
      try {
        await run.cancel();
      } catch {
        // ignore probe cleanup errors
      }
    }
    if (agent && typeof agent.close === 'function') {
      try {
        agent.close();
      } catch {
        // ignore probe cleanup errors
      }
    }
  }
}

type ProbeRunResult = { ok?: boolean; firstAssistantText?: unknown; isAuthenticationError?: unknown };

/** Shape of the probe payload read by the signal/recommendation helpers. */
type SdkProbeShape = {
  chat?: { sdkAgentId?: unknown } | null;
  resume?: ProbeRunResult | null;
  create?: ProbeRunResult | null;
  contextPressure?: { likelyContextPressure?: unknown; contextFillPercent?: unknown } | null;
  localStore?: { agents?: Array<{ agentId?: unknown; status?: unknown } | null | undefined> } | null;
  messages?: { ok?: boolean; messageCount?: unknown } | null;
};

export function inferProbeSignals(probe: SdkProbeShape): string[] {
  const signals: string[] = [];
  const resumeOk = probe?.resume?.ok === true && !!probe?.resume?.firstAssistantText;
  const createOk = probe?.create?.ok === true && !!probe?.create?.firstAssistantText;
  if (probe?.resume?.ok === false && createOk) {
    signals.push('resume_failed_create_ok');
  }
  if (!resumeOk && createOk) {
    signals.push('resume_unresponsive_create_ok');
  }
  if (probe?.resume?.isAuthenticationError && createOk) {
    signals.push('misleading_auth_on_resume');
  }
  if (probe?.resume?.isAuthenticationError && probe?.create?.isAuthenticationError) {
    signals.push('global_auth_failure');
  }
  if (probe?.contextPressure?.likelyContextPressure && !resumeOk) {
    signals.push('likely_oversized_context');
  }
  if (Number(probe?.contextPressure?.contextFillPercent) > 100) {
    signals.push('context_over_model_window');
  }
  const boundAgent = Array.isArray(probe?.localStore?.agents)
    ? probe.localStore.agents.find((row) => row?.agentId === probe?.chat?.sdkAgentId)
    : null;
  if (boundAgent?.status === 'error') {
    signals.push('local_store_agent_error');
  }
  if (probe?.messages?.ok === true && Number(probe.messages.messageCount) === 0) {
    signals.push('cloud_messages_empty');
  }
  return signals;
}

export function buildProbeRecommendation(probe: SdkProbeShape): string {
  const signals = inferProbeSignals(probe);
  if (signals.includes('global_auth_failure')) {
    return 'Refresh Cursor API key in Settings → Cursor API, then retry.';
  }
  if (
    signals.includes('likely_oversized_context') ||
    signals.includes('context_over_model_window') ||
    signals.includes('resume_unresponsive_create_ok')
  ) {
    return 'Context/local store is too large for Agent.resume. Run intentional summary, reset agent context, then continue with a seeded prompt.';
  }
  if (signals.includes('misleading_auth_on_resume') || signals.includes('resume_failed_create_ok')) {
    return 'Stale resumed SDK agent session. Use “Reset agent context” (keeps chat history) or run intentional summary + reset.';
  }
  if (probe?.resume?.ok === true && probe?.resume?.firstAssistantText) {
    return 'Resume probe succeeded — the agent session looks healthy.';
  }
  return 'Inspect probe details and server logs; try reset agent context if failures persist.';
}

export async function runSdkChatProbe(
  chat: Record<string, unknown>,
  options: {
    cwd: string;
    includeCreateProbe?: boolean;
    probePrompt?: string;
    timeoutMs?: number;
  } = {} as { cwd: string },
): Promise<Record<string, unknown>> {
  if (!chat || typeof chat !== 'object') {
    return { ok: false, error: 'missing_chat' };
  }
  const chatId = typeof chat.id === 'string' ? chat.id : '';
  const sessionKey = typeof chat.cursorSessionId === 'string' ? chat.cursorSessionId : '';
  const history = await collectChatHistoryContextStats(chatId);
  const localStore = await collectSdkLocalStoreStats(sessionKey);
  const contextPressure = buildContextPressureAssessment({
    modelId: chat.model,
    lastUsageInputTokens:
      history?.lastEffectiveUsageInputTokens ?? history?.lastUsageInputTokens,
    maxUsageInputTokens: history?.maxEffectiveUsageInputTokens ?? history?.maxUsageInputTokens,
    rawLastUsageInputTokens: history?.lastUsageInputTokens,
    rawMaxUsageInputTokens: history?.maxUsageInputTokens,
    localStoreTotalBytes: localStore?.totalBytes,
    headSeq: history?.headSeq,
  });
  const messages = await probeSdkAgentMessages(chat.sdkAgentId);
  const resume = await probeSdkAgentRun({
    chat,
    cwd: options.cwd,
    mode: 'resume',
    probePrompt: options.probePrompt,
    timeoutMs: options.timeoutMs,
  });
  const includeCreateProbe = options.includeCreateProbe !== false;
  const create = includeCreateProbe
    ? await probeSdkAgentRun({
        chat,
        cwd: options.cwd,
        mode: 'create',
        probePrompt: options.probePrompt,
        timeoutMs: options.timeoutMs,
      })
    : null;
  const payload = {
    ok: true,
    chat: {
      id: chatId,
      title: chat.title || null,
      sdkAgentId: chat.sdkAgentId || null,
      cursorSessionId: sessionKey || null,
      model: chat.model || null,
    },
    history,
    localStore,
    contextPressure,
    messages,
    resume,
    create,
    signals: [] as string[],
    recommendation: '',
    probedAt: new Date().toISOString(),
  };
  payload.signals = inferProbeSignals(payload);
  payload.recommendation = buildProbeRecommendation(payload);
  return payload;
}
