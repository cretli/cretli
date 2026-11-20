import { OPERATOR_RUN_PICK_PURPOSE } from '../../lib/operator/operator-constants.js';

/**
 * Chat row of an operator run, as stage 2b/2c create it (pickPurpose is set at
 * row creation, not by startChatRun).
 *
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
export function operatorRunChatRow(overrides = {}) {
  return {
    id: overrides.id || 'operator-run-chat-1',
    title: 'Operator run',
    harness: 'claude',
    pickPurpose: OPERATOR_RUN_PICK_PURPOSE,
    operatorRunId: overrides.operatorRunId || 'operator-run-1',
    workspaceFolder: overrides.workspaceFolder || '',
    ...overrides,
  };
}
