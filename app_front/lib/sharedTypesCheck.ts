/**
 * Compile-time proof that app_front can import the shared domain types
 * (lib/shared-types). Type-only imports are erased, so webpack never loads it.
 */
import type { Todo, Chat, Delegation, WatcherCycle, HarnessEvent } from '../../lib/shared-types/index.ts';

export type SharedDomainTypes = {
  todo: Todo;
  chat: Chat;
  delegation: Delegation;
  watcherCycle: WatcherCycle;
  harnessEvent: HarnessEvent;
};
