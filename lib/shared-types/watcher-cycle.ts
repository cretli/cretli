/**
 * One live Workspace Watcher cycle slot (`activeCycles` entry, see
 * lib/workspace-watcher-cycle.js). Types only: erasable syntax, no runtime code.
 */

export type WatcherCyclePhase = 'starting' | 'running';

export type WatcherCycle = {
  cycleId: string;
  todoIds: string[];
  startedAt: string;
  /** Orchestrator chat that owns the cycle and may report its outcome. */
  chatId: string;
  runId: string;
  phase: WatcherCyclePhase;
  startDeadlineAt: string;
  planOnly: boolean;
  instanceId: string;
  mode: 'plan' | 'implement';
  executionMode?: 'project' | 'worktree';
  planTargetId: string;
  requestedHarness: string | null;
  requestedModel: string | null;
  requestedSource: 'policy' | 'implement_pick' | null;
  reportedOutcome: 'success' | 'blocked' | 'failure' | '';
  reportedAt: string;
  reportId: string;
  harness: string;
  /** First observation of a missing orchestrator room, when one exists. */
  roomGoneSince?: string;
  [key: string]: unknown;
};
