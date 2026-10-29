import { randomUUID } from 'node:crypto';
import { openDecisionsRuntime } from '../persist/decisions-runtime.js';
import { broadcastDecisionsChanged } from './decision-live.js';

const POLICY = Object.freeze({
  plan_approval: { risk: 'high', reversible: false, humanOnly: true },
  integration: { risk: 'high', reversible: false, humanOnly: true },
  policy_upgrade: { risk: 'high', reversible: false, humanOnly: true },
  needs_human: { risk: 'medium', reversible: false, humanOnly: false },
  permission: { risk: 'medium', reversible: false, humanOnly: false },
  question: { risk: 'medium', reversible: false, humanOnly: false },
  browser_consent: { risk: 'medium', reversible: false, humanOnly: false },
  scout_finding: { risk: 'medium', reversible: false, humanOnly: false },
  lesson_candidate: { risk: 'medium', reversible: false, humanOnly: false },
  rescope: { risk: 'medium', reversible: false, humanOnly: false },
});
const RISK = { low: 0, medium: 1, high: 2 };
/** One worker-backed runtime per data directory, opened lazily on first use. */
const runtimes = new Map();
function storeFor(dataDir) {
  if (!runtimes.has(dataDir)) {
    const opening = openDecisionsRuntime({ dataDir });
    opening.catch(() => { if (runtimes.get(dataDir) === opening) runtimes.delete(dataDir); });
    runtimes.set(dataDir, opening);
  }
  return runtimes.get(dataDir).then((runtime) => runtime.store);
}
/** Close every opened decisions worker (tests, shutdown). */
export async function closeDecisionStores() {
  const opened = [...runtimes.values()];
  runtimes.clear();
  await Promise.all(opened.map((opening) => opening.then((runtime) => runtime.close(), () => {})));
}
export function classifyDecision(kind, producer = {}) {
  const base = POLICY[kind];
  if (!base) throw Object.assign(new Error('Unknown decision kind'), { code: 'VALIDATION' });
  const risk = RISK[producer.risk] > RISK[base.risk] ? producer.risk : base.risk;
  return { risk, reversible: base.reversible && producer.reversible !== false, humanOnly: base.humanOnly };
}
export async function createDecision(dataDir, input) {
  const classification = classifyDecision(input.kind, input);
  if (!input.dedupeKey || !['todoId', 'chatId', 'delegationId', 'findingId'].some((key) => input.subject?.[key]) || !input.subject?.updatedAt) {
    throw Object.assign(new Error('Decision needs a dedupe key and subject revision'), { code: 'VALIDATION' });
  }
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 4
    || input.options.some((option) => !option.id || !option.label || !option.effect)) {
    throw Object.assign(new Error('Decision needs 2–4 complete options'), { code: 'VALIDATION' });
  }
  if (input.onTimeout && !['nothing', 'reject', 'recommended'].includes(input.onTimeout)) {
    throw Object.assign(new Error('Unknown timeout policy'), { code: 'VALIDATION' });
  }
  if (input.onTimeout === 'recommended' && (classification.humanOnly || classification.risk !== 'low' || !classification.reversible)) {
    throw Object.assign(new Error('Recommended timeout requires low, reversible, non-human-only decision'), { code: 'VALIDATION' });
  }
  const row = {
    id: randomUUID(), kind: input.kind, subject: input.subject, workspaceFolder: input.workspaceFolder,
    title: input.title, summary: input.summary || '', evidence: input.evidence || [],
    options: input.options.map(({ id, label, effect, risk, reversible }) => ({
      id, label, effect,
      risk: RISK[risk] > RISK[classification.risk] ? risk : classification.risk,
      reversible: classification.reversible && reversible !== false,
    })),
    recommended: input.recommended || '', why: input.why || '', confidence: input.confidence ?? null,
    expiresAt: input.expiresAt || null, onTimeout: input.onTimeout || 'nothing',
    dedupeKey: input.dedupeKey, producer: input.producer || 'server',
    ...classification, status: 'pending', revision: 1, createdAt: new Date().toISOString(),
  };
  const store = await storeFor(dataDir);
  const result = await store.create({ commandId: randomUUID(), row });
  if (result.created) broadcastDecisionsChanged({ revision: result.revision });
  return result.row;
}
export async function listPendingDecisions(dataDir, workspaceFolder) {
  return (await storeFor(dataDir)).list({ workspaceFolder, status: 'pending' });
}
export async function listDecisions(dataDir, workspaceFolder) {
  return (await storeFor(dataDir)).list({ workspaceFolder }).then((result) => result.items);
}
export async function getDecision(dataDir, id) {
  return (await storeFor(dataDir)).get({ id }).then((result) => result.row);
}
/**
 * Compare-and-swap a card transition. `status: 'deciding'` is the atomic claim (pending -> deciding);
 * leaving it needs `fromStatus: 'deciding'`.
 */
export async function changeDecision(dataDir, id, expectedRevision, status, details = {}, fromStatus = 'pending') {
  const result = await (await storeFor(dataDir)).change({ commandId: randomUUID(), id, expectedRevision, status, details, fromStatus });
  if (result.row) broadcastDecisionsChanged({ revision: result.revision });
  return result.row;
}
