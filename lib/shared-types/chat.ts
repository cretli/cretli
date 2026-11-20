/**
 * Chat record shared by the server (lib/persist/chats-persist.js) and app_front.
 * Types only: erasable syntax, no runtime code.
 */

/**
 * One chat. `agentTransport` is the string form of AgentTransport
 * (lib/agent-transport.js) so the record can carry values from older or
 * optional harnesses.
 */
export type Chat = {
  id: string;
  title: string;
  cursorSessionId: string;
  createdAt: string;
  updatedAt?: string;
  agentTransport?: string;
  workspaceFile?: string;
  workspaceFolder?: string;
  executionFolder?: string;
  model?: string;
  [key: string]: unknown;
};
