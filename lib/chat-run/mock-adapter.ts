/**
 * In-process chat-run adapter for tests and local dry-runs.
 */

import { randomUUID } from 'crypto';
import { registerChatRunAdapter, unregisterChatRunAdapter } from '../chat-run-service.js';

interface MockRun {
  runId: string;
  busy: boolean;
  cancelled: boolean;
  waitingForInput: boolean;
  prompt: string;
  hold: boolean;
  mode?: string;
  requestId: string;
  displayText?: string;
  attemptId?: string;
  delegationId?: string;
  assignment?: string;
}

const runs = new Map<string, MockRun>();
const requests = new Map<string, { runId: string, chatId: string, accepted: boolean }>();

let onEvent: (event: Record<string, any>) => void = () => {};
let failNextCancel = false;
let failNextStart = 0;
let failStartMessage = 'executor would not start';
let startCount = 0;
let hangOnce: null | Promise<void> = null;
let hangCancelOnce: null | Promise<void> = null;

export function resetMockChatRuns() {
  runs.clear();
  requests.clear();
  onEvent = () => {};
  failNextCancel = false;
  failNextStart = 0;
  failStartMessage = 'executor would not start';
  startCount = 0;
  hangOnce = null;
  hangCancelOnce = null;
}

export function getMockChatRunStartCount(): number {
  return startCount;
}

export function listMockChatRunChatIds(): string[] {
  return [...runs.keys()];
}

export function setMockChatRunListener(listener: (event: Record<string, any>) => void): void {
  onEvent = typeof listener === 'function' ? listener : () => {};
}

export function setMockChatRunFailCancel(value: boolean): void {
  failNextCancel = value === true;
}

/**
 * @param value Number of upcoming starts to fail.
 */
export function setMockChatRunFailStart(value: boolean | number, message: string = 'executor would not start'): void {
  failNextStart = typeof value === 'number' ? Math.max(0, value) : (value === true ? 1 : 0);
  failStartMessage = String(message);
}

/**
 * Next start() waits until the returned release function is called.
 */
export function hangNextMockChatRunStart(): () => void {
  let release: () => void = () => {};
  hangOnce = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    hangOnce = null;
    release();
  };
}

/**
 * Next cancel() waits until the returned release function is called.
 */
export function hangNextMockChatRunCancel(): () => void {
  let release: () => void = () => {};
  hangCancelOnce = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    hangCancelOnce = null;
    release();
  };
}

export function getMockChatRun(chatId: string): MockRun | null {
  return runs.get(chatId) || null;
}

export function getMockChatRunByRequestId(requestId: string) {
  return requests.get(String(requestId || '').trim()) || null;
}

export function patchMockChatRun(chatId: string, patch: Record<string, unknown>): MockRun | null {
  const current = runs.get(chatId);
  if (!current) return null;
  Object.assign(current, patch);
  return current;
}

export function seedMockChatRun(chatId: string, input: { runId?: string, busy?: boolean, waitingForInput?: boolean } = {}): MockRun | null {
  const id = String(chatId || '').trim();
  if (!id) return null;
  const runId = String(input.runId || randomUUID()).trim();
  runs.set(id, {
    runId,
    busy: input.busy !== false,
    cancelled: false,
    waitingForInput: input.waitingForInput === true,
    prompt: '',
    hold: false,
    mode: 'agent',
    requestId: '',
    displayText: '',
    attemptId: '',
    delegationId: '',
    assignment: '',
  });
  return runs.get(id) || null;
}

export function registerMockChatRunAdapter(transport = 'mock'): void {
  const id = String(transport || 'mock').trim() || 'mock';
  unregisterChatRunAdapter(id);
  registerChatRunAdapter({
    transport: id,
    capabilities: {
      canLookupRequest: true,
      canCancel: true,
      canReconstructSession: false,
      canReadFiles: true,
      canSearch: true,
      deniesMutation: false,
    },
    lookupRequest({ requestId }: { requestId: string }) {
      const key = String(requestId || '').trim();
      if (!key) return null;
      return requests.get(key) || null;
    },
    async start({ chat, prompt, requestId, mode, displayText, deps }: { chat: Record<string, any>, prompt: string, requestId?: string, mode?: string, displayText?: string, deps?: Record<string, any> }) {
      const key = String(requestId || '').trim();
      if (key && requests.has(key)) {
        const existing = requests.get(key);
        return { runId: (existing as NonNullable<typeof existing>).runId, accepted: (existing as NonNullable<typeof existing>).accepted !== false };
      }
      const gate = hangOnce;
      hangOnce = null;
      if (gate) await gate;
      if (failNextStart > 0) {
        failNextStart -= 1;
        throw Object.assign(new Error(failStartMessage), { code: 'start_failed' });
      }
      const current = runs.get(chat.id);
      if (current?.busy || current?.waitingForInput) {
        const error: Error & { code?: string } = new Error('Recipient is busy');
        error.code = 'recipient_busy';
        throw error;
      }
      startCount += 1;
      const runId = randomUUID();
      runs.set(chat.id, {
        runId,
        busy: true,
        cancelled: false,
        waitingForInput: false,
        prompt,
        hold: true,
        mode: String(mode || 'agent'),
        requestId: key,
        displayText: String(displayText || ''),
        attemptId: String(deps?.attemptId || '').trim(),
        delegationId: String(deps?.delegationId || '').trim(),
        assignment: String(deps?.assignment || '').trim(),
      });
      if (key) requests.set(key, { runId, chatId: chat.id, accepted: true });
      onEvent({ type: 'started', chatId: chat.id, runId, prompt });
      return { runId, accepted: true };
    },
    async cancel({ chat, runId }: { chat: Record<string, any>, runId?: string }) {
      if (failNextCancel) {
        failNextCancel = false;
        throw new Error('cancel failed');
      }
      const gate = hangCancelOnce;
      hangCancelOnce = null;
      if (gate) await gate;
      const current = runs.get(chat.id);
      if (!current) return;
      if (runId && current.runId !== runId) return;
      current.cancelled = true;
      current.busy = false;
      current.waitingForInput = false;
      onEvent({ type: 'cancelled', chatId: chat.id, runId: current.runId });
    },
    getState({ chat, runId }: { chat: Record<string, any>, runId?: string }) {
      const current = runs.get(chat.id);
      if (!current) return null;
      if (runId && current.runId !== runId) return null;
      return {
        runId: current.runId,
        busy: current.busy,
        waitingForInput: current.waitingForInput,
        attemptId: current.attemptId || '',
      };
    },
  });
}
