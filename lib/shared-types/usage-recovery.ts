/**
 * Usage ledger event and recovery run intent (lib/usage/usage-event.js,
 * lib/recovery/recovery-store.ts). Types only: erasable syntax, no runtime code.
 */

export type UsageEventType = 'delta' | 'run';
export type UsageOutcome = 'ok' | 'error' | 'limit' | 'aborted';
export type UsageRole = 'chat' | 'plan' | 'implement' | 'review' | 'fix';

/** Token counters of one usage event. */
export type UsageTokens = {
  input?: number;
  output?: number;
  textInput?: number;
  textOutput?: number;
  audioInput?: number;
  audioOutput?: number;
  cachedInput?: number;
  cacheWrite?: number;
  reasoning?: number;
  [key: string]: number | undefined;
};

/** Canonical usage event (output of `normalizeUsageEvent`). */
export type UsageEvent = {
  id: string;
  at: string;
  provider: string;
  feature: string;
  model: string;
  variant?: string;
  workspaceFile?: string;
  chatId?: string;
  cycleId?: string;
  harness: string;
  role: UsageRole | string;
  eventType: UsageEventType;
  outcome: UsageOutcome | string;
  errorCode?: string;
  latencyMs?: number;
  ttftMs?: number;
  delegationId?: string;
  attemptId?: string;
  runId?: string;
  sourceSessionId?: string;
  tokens: UsageTokens;
  characters: number;
  audioSeconds: number;
  usd: number | null;
  reportedUsd?: number | null;
  billingMode?: string;
  billingClass?: string;
  billingSource?: 'vibe_code' | 'api';
  accountId?: string;
  estimated: boolean;
  pricing?: Record<string, unknown>;
  source: 'client' | 'server';
  schemaVersion?: number;
  [key: string]: unknown;
};

/** Run intent written BEFORE launching a run (`writeRunIntent`). */
export type RecoveryIntent = {
  logicalRunId: string;
  attemptId: string;
  requestId: string;
  family: string;
  owner: string;
  generation: number;
  workspaceFolder: string;
  chatId: string;
  sessionId: string;
  harness: string;
  model: string;
  instanceToken: string;
  now: string | number;
  [key: string]: unknown;
};
