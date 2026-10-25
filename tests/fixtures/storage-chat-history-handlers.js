/** Test-only fault seams around the real chat history registry. */
import { DatabaseSync } from 'node:sqlite';
import { commands, queries } from '../../lib/storage/chat-history-store.js';
import { RECEIPT_HANDLER_MARK } from '../../lib/storage/command-receipts.js';

/** @type {{commandId:string,mode:string,dbPath?:string}|null} */
let armed = null;
/** @type {{requestId:string,mode:string}|null} */
let pendingCommit = null;
/** @type {Array<{commandId:string,producerId:unknown}>} */
const attempts = [];
/** @type {Array<{events:number,receipts:number}>} */
const observations = [];

/** @param {string} requestId @returns {string} */
function transactionId(requestId) {
  return requestId.split(':')[0];
}

/** @param {string} dbPath */
function observeCommitted(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    observations.push({
      events: Number(db.prepare('SELECT count(*) AS n FROM chat_history_events').get().n),
      receipts: Number(db.prepare('SELECT count(*) AS n FROM command_receipts').get().n),
    });
  } finally {
    db.close();
  }
}

/** @param {Function} handler @returns {Function} */
function wrapCommand(handler) {
  const wrapped = (ctx, envelope) => {
    attempts.push({ commandId: ctx.commandId, producerId: envelope?.payload?.producerId });
    const result = handler(ctx, envelope);
    if (!armed || armed.commandId !== ctx.commandId) return result;
    const fault = armed;
    armed = null;
    if (fault.mode === 'beforeCommitExit') process.exit(1);
    if (fault.mode === 'observeBeforeCommit') observeCommitted(fault.dbPath);
    if (fault.mode === 'afterCommitExit' || fault.mode === 'busyCommit') {
      pendingCommit = { requestId: transactionId(ctx.requestId), mode: fault.mode };
    }
    return result;
  };
  if (handler[RECEIPT_HANDLER_MARK]) Object.defineProperty(wrapped, RECEIPT_HANDLER_MARK, { value: true });
  return wrapped;
}

export default {
  commands: {
    ...Object.fromEntries(Object.entries(commands).map(([name, handler]) => [name, wrapCommand(handler)])),
    'test.arm'(_ctx, payload) {
      armed = payload;
      return null;
    },
  },
  queries: {
    ...queries,
    'test.counts'(ctx) {
      return {
        events: Number(ctx.prepare('SELECT count(*) AS n FROM chat_history_events').get().n),
        receipts: Number(ctx.prepare('SELECT count(*) AS n FROM command_receipts').get().n),
      };
    },
    'test.attempts'() {
      return attempts;
    },
    'test.observations'() {
      return observations;
    },
  },
  faultInjection: {
    afterCommit(ctx) {
      if (pendingCommit?.requestId === transactionId(ctx.requestId) && pendingCommit.mode === 'afterCommitExit') process.exit(1);
    },
    commitFault(ctx) {
      if (pendingCommit?.requestId !== transactionId(ctx.requestId) || pendingCommit.mode !== 'busyCommit') return null;
      pendingCommit = null;
      return 'busy';
    },
  },
};
