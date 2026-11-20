/**
 * Scheduler hooks for the `condition_check` kind. A check has no subject chat
 * (it starts a new one), so `announceChat` is a deliberate no-op: the started
 * chat's own first message is the brief. A disabled feature publishes nothing.
 */

import { CONDITION_CHECK_KIND } from './wakeup-condition-check.js';

/**
 * @param {{ readSettings: () => { enabled: boolean }, publish: (payload: object) => Promise<unknown> }} deps
 * @returns {{ notify: Function, announceChat: Function }}
 */
export function createConditionCheckAnnouncers(deps) {
  const isOurs = (payload) => payload?.record?.kind === CONDITION_CHECK_KIND;
  return {
    notify: async (payload) => {
      if (!isOurs(payload) || deps.readSettings().enabled === false) return;
      await deps.publish(payload);
    },
    announceChat: async () => {},
  };
}
