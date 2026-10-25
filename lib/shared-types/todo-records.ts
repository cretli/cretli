/**
 * Full todo record shapes (plan, review, integration) shared by the server
 * (lib/persist/todos-persist.js, lib/todo-*.js) and app_front. Types only:
 * erasable syntax, no runtime code. Records stay open (`unknown` index
 * signature) because newer versions and feature flags add keys.
 */
import type { Todo } from './todo.ts';

/** Draft or approved plan of a todo (`normalizePlan` in todos-persist.js). */
export type TodoPlan = {
  markdown: string;
  updatedAt: string;
  markdownUpdatedAt?: string;
  sourceChatId?: string;
  /** Set only by a human (UI or operator MCP client), never by an agent. */
  approvedAt?: string;
  /** Who approved: set only by the operator MCP tool; UI approvals leave it unset. */
  approvedBy?: TodoPlanApprover;
};

/** Identity of an external MCP operator client that approved a plan. */
export type TodoPlanApprover = {
  kind: 'mcp-operator';
  clientId: string;
  clientName: string;
};

export type TodoChangelogEntry = {
  at: string;
  kind: string;
  text: string;
  chatId?: string;
};

/** Durable integration pointer of a worktree-backed leaf. */
export type TodoIntegration = {
  state?: string;
  cycleId?: string;
  resultPath?: string;
  baseCommit?: string;
  branch?: string;
  worktreePath?: string;
  appliedAt?: string;
  materialRevision?: string;
  reviewOutcome?: string;
  testOutcome?: string;
  reason?: string;
  recordedAt?: string;
  mergeMode?: string;
  targetBranch?: string;
  /** Target-branch proof recorded by `todo_integration confirm`. */
  evidence?: TodoIntegrationEvidence;
  [key: string]: unknown;
};

export type TodoIntegrationEvidence = {
  targetBranch?: string;
  targetCommit?: string;
  sourceCommit?: string;
  materialRevision?: string;
  cycleId?: string;
  source?: string;
  confirmedAt?: string;
  confirmedBy?: string;
  changeRef?: string;
  verification?: string;
  todoMaterialFingerprint?: string;
  treeMaterialFingerprint?: string;
  scope?: string;
  [key: string]: unknown;
};

export type TodoReviewState = 'none' | 'pending' | 'passed' | 'failed' | 'manual' | 'stale' | 'unknown';
export type TodoReviewSubject = 'code' | 'plan';

/** Per-subject block of the server-written `review` read model. */
export type TodoReviewSubjectBlock = {
  state: TodoReviewState | string;
  subject: TodoReviewSubject | string;
  stateReason?: string;
  reviewers: Array<Record<string, unknown>>;
  reviewerCount: number;
  truncated?: boolean;
  updatedAt?: string;
  [key: string]: unknown;
};

/** Server-written review read model (docs/todo-review-contract.md). */
export type TodoReview = {
  schemaVersion: number;
  generation?: number;
  code: TodoReviewSubjectBlock;
  plan: TodoReviewSubjectBlock;
  computedAt?: string;
  decisionKey?: string;
  [key: string]: unknown;
};

export type TodoReviewerPair = {
  enabled?: boolean;
  members?: Array<{ harness: string; model: string }>;
};

export type TodoWatcherPhases = Partial<Record<'plan' | 'review' | 'implement' | 'integrate', boolean>>;

/** Checkpointed material of a finished leaf (`todo.leafMaterial`). */
export type TodoLeafMaterial = Record<string, unknown>;

/** Complete todo as stored and served: `Todo` plus plan, review, integration. */
export type TodoItem = Todo & {
  plan?: TodoPlan;
  review?: TodoReview;
  integration?: TodoIntegration;
  leafMaterial?: TodoLeafMaterial;
  changelog?: TodoChangelogEntry[];
  orchestratorChatId?: string;
  sourceTodoId?: string;
  claimedByChatId?: string;
  claimedAt?: string;
  claimLeaseUntil?: string;
  reviewerPair?: TodoReviewerPair;
  watcherPhases?: TodoWatcherPhases;
};
