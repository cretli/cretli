/** Test-only fault seams around the real todos registry (loaded inside the storage worker). */
import { commands, queries, setMidMoveHookForTests } from '../../lib/storage/todos-store.js';
import { RECEIPT_HANDLER_MARK } from '../../lib/storage/command-receipts.js';

/** @type {{ commandId: string, mode: string } | null} */
let armed = null;
/** @type {string | null} */
let pendingExit = null;

/** @param {string} requestId @returns {string} */
const transactionId = (requestId) => requestId.split(':')[0];

/** @param {Function} handler @returns {Function} */
function wrap(handler) {
  const wrapped = (ctx, envelope) => {
    if (armed && armed.commandId === ctx.commandId) {
      const fault = armed;
      armed = null;
      if (fault.mode === 'midMoveThrow') {
        setMidMoveHookForTests(() => {
          setMidMoveHookForTests(null);
          throw new Error('injected failure in the middle of moveTodo');
        });
      }
      if (fault.mode === 'afterCommitExit') pendingExit = transactionId(ctx.requestId);
    }
    return handler(ctx, envelope);
  };
  Object.defineProperty(wrapped, RECEIPT_HANDLER_MARK, { value: true });
  return wrapped;
}

export default {
  commands: {
    ...Object.fromEntries(Object.entries(commands).map(([name, handler]) => [name, wrap(handler)])),
    'test.arm'(_ctx, payload) {
      armed = payload;
      return null;
    },
  },
  queries: { ...queries },
  faultInjection: {
    afterCommit(ctx) {
      if (pendingExit !== null && pendingExit === transactionId(ctx.requestId)) process.exit(1);
    },
  },
};
