/**
 * Complete delegation record (executor, verify result, workflow state) as stored
 * by lib/persist/delegations-persist.js and lib/delegation-service.js. Types
 * only: erasable syntax, no runtime code.
 */
import type { Delegation } from './delegation.ts';

/** Executor selection of a delegated child (`harness` + `model`). */
export type DelegationExecutor = {
  harness?: string;
  model?: string;
  baseModel?: string;
  [key: string]: unknown;
};

/** Host verify result persisted on an implement/fix/review delegation. */
export type DelegationVerifyResult = {
  status: 'passed' | 'failed' | string;
  exitCode: number;
  verdict: string;
  source: string;
  dataDir: string;
  recordedAt: string;
  attemptId: string;
  materialRevision: string;
  ids: string[];
  outputTail: string;
  implementDelegationId: string;
  stale: boolean;
  manifest?: Record<string, unknown>;
  manifestEvidence?: { usable: boolean; reason: string };
  results?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

/** Per-leaf parent-loop state (`workflow_update`). */
export type DelegationWorkflow = {
  role?: string;
  round?: number;
  maxRounds?: number;
  lastImplementer?: string;
  lastReviewer?: string;
  lastModel?: string;
  lastVerdict?: string;
  stopReason?: string;
  findingsHash?: string;
  materialRevision?: string;
  deadlineAt?: string;
  [key: string]: unknown;
};

export type DelegationRecord = Delegation & {
  assignment?: string;
  requestedRole?: string;
  reviewSubject?: string;
  harness?: string;
  model?: string;
  executor?: DelegationExecutor;
  verifyResult?: DelegationVerifyResult;
  verifyPending?: Record<string, unknown> | null;
  workflow?: DelegationWorkflow;
  createdAt?: string;
  updatedAt?: string;
  report?: string;
  pickId?: string;
  pickReason?: string;
};
