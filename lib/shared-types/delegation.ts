/**
 * Delegation row shared by the server (lib/persist/delegations-persist.js) and
 * app_front. Types only: erasable syntax, no runtime code. Only the fields that
 * the index and tick helpers read are declared; the full row carries many more.
 */

/** One undelivered report to the parent chat. */
export type DelegationOutboxItem = {
  deliveredAt?: string;
  [key: string]: unknown;
};

export type Delegation = {
  id: string;
  status: string;
  parentChatId: string;
  childChatId?: string;
  rootChatId?: string;
  rootDelegationId?: string;
  controllerChatId?: string;
  leafId?: string;
  revision?: number;
  runStoppingAt?: string;
  outbox?: DelegationOutboxItem[];
  attempts?: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
