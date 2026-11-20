/**
 * Todo record shared by the server (lib/persist/todos-persist.js) and app_front.
 * Types only: erasable syntax, no runtime code. Mirrors the TodoRecord typedef in
 * persist-records.js, which stays for JSDoc consumers.
 */

export type TodoStatus = 'idea' | 'ready' | 'doing' | 'done' | 'deferred';

export type TodoAssignee = { harness: string; model?: string; role: string };

/** One todo after normalization. Optional fields are only present when set. */
export type Todo = {
  id: string;
  title: string;
  body: string;
  status: TodoStatus;
  /** Optional ISO date a deferred todo is meant to come back at (informational). */
  deferredUntil?: string;
  /** Optional free-text reason for deferring (max 500 chars). */
  deferredReason?: string;
  createdAt: string;
  updatedAt: string;
  chatId?: string;
  createdByChatId?: string;
  parentId?: string;
  siblingIndex?: number;
  assignee?: TodoAssignee;
  runMode?: 'sequential' | 'parallel';
  /** Opt-in: an `idea` sibling does not hold back later siblings in a sequential tree. */
  nonBlocking?: boolean;
  executionMode?: 'inherit' | 'worktree' | 'project';
  linkedChatIds?: string[];
  [key: string]: unknown;
};
