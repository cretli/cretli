/**
 * Complete chat row as stored by lib/persist/chats-persist.js and served by the
 * chat list API. Types only: erasable syntax, no runtime code.
 */
import type { Chat } from './chat.ts';

export type ChatRow = Chat & {
  /** SDK run mode (`agent`, `plan`, ...). */
  sdkMode?: string;
  deleted?: boolean;
  archived?: boolean;
  /** Parent chat when this chat is a fork. */
  forkedFromChatId?: string;
  linkedTodoIds?: string[];
  lastMessageAt?: string;
  messageCount?: number;
};
