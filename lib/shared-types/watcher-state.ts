/**
 * Workspace Watcher row, policy and cycle types (lib/persist/workspace-watchers-persist.js,
 * lib/workspace-watcher*.js). Types only: erasable syntax, no runtime code.
 */
import type { WatcherCycle } from './watcher-cycle.ts';

export type WatcherMode = 'off' | 'observe' | 'autopilot';

export type WatcherPhases = { plan: boolean; review: boolean; implement: boolean; integrate: boolean };

export type WatcherWorktreePolicy = Record<string, unknown>;

export type WatcherPolicy = {
  maxParallel: number;
  maxParallelWorktree: number;
  maxParallelProject: number;
  maxCyclesPerDay: number;
  maxConsecutiveFailures: number;
  maxSameFindings: number;
  cooldownMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  requirePlanApproval: boolean;
  requireReviewForDone: string;
  requireIndependentReview: boolean;
  reviewGateMaxAttempts: number;
  phases: WatcherPhases;
  planApprovalScope: 'leaf' | 'root';
  allowedHarnesses: string[];
  pickRoles: string[];
  executionMode: 'project' | 'worktree';
  worktree: WatcherWorktreePolicy;
  quietHours: { start: string; end: string };
  scoutEnabled: boolean;
  scoutIntervalHours: number;
  scoutAutoCreate: boolean;
  scoutAllowedHarnesses: string[];
  scoutCategories: string[];
  scoutMaxPerDay: number;
  scoutMaxPerScan: number;
  scoutMaxParallel: number;
  scoutTestProbe: boolean;
  scoutTestCommand: string[];
  orchestrator: { harness: string; model: string };
  recoverIdleOpenChat: boolean;
  unknownEscalationObservations: number;
  orphanDoingMinMs: number;
  [key: string]: unknown;
};

/** One bounded decision-log entry. */
export type WatcherDecision = {
  at: string;
  kind: string;
  reason: string;
  readyTodoCount: number;
  activeAgentCount: number;
  shouldNotify: boolean;
  nextTodoId: string;
  [key: string]: unknown;
};

/** Persisted watcher row for one workspace. */
export type WatcherState = {
  workspaceFolder: string;
  mode: WatcherMode;
  enabled: boolean;
  paused?: boolean;
  stopReason?: string;
  policy: WatcherPolicy;
  /** Live cycles, at most `policy.maxParallel` (hard cap 5). */
  activeCycles: WatcherCycle[];
  /** Slot 0 of `activeCycles`, kept for older readers. */
  activeCycle?: WatcherCycle | null;
  orchestratorChatId?: string;
  /** Loop-guard failure counters keyed by todo id. */
  failures?: Record<string, number>;
  decisions?: WatcherDecision[];
  updatedAt?: string;
  [key: string]: unknown;
};
