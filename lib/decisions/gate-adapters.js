import { listHostDecisionGates } from './host-gates.js';
import { listLessons, updateLesson } from '../review-lessons-service.js';
import { listScoutFindings, acceptScoutFindings, rejectScoutFindings } from '../workspace-watcher-scout.js';
import { createDecision, changeDecision, listPendingDecisions } from './decision-store.js';

const options = (entries) => entries.map(([id, label, effect]) => ({ id, label, effect }));
async function gates(dataDir, workspaceFolder) {
  const result = await listHostDecisionGates(workspaceFolder);
  for (const row of listLessons(workspaceFolder, { dataDir }).filter((lesson) => lesson.status === 'candidate')) {
    result.push({
      kind: 'lesson_candidate', key: `lesson:${row.id}`, title: 'Activate lesson?', summary: row.text,
      subject: { findingId: row.id, updatedAt: String(row.revision), expected_revision: row.revision },
      options: options([['activate', 'Activate', 'Activate this lesson'], ['withdraw', 'Withdraw', 'Retire this candidate']]),
      resolve: (id) => { updateLesson(workspaceFolder, row.id, id === 'activate' ? { status: 'active' } : { status: 'retired', retiredReason: 'Withdrawn by the operator' }, row.revision, { dataDir }); return true; },
    });
  }
  const scout = /** @type {Record<string, any>[]} */ (listScoutFindings(workspaceFolder, { dataDir, status: 'pending' }));
  for (const row of scout) {
    result.push({
      kind: 'scout_finding', key: `scout:${row.id}`, title: row.title, summary: row.rationale,
      subject: { findingId: row.id, updatedAt: row.updatedAt || row.createdAt },
      options: options([['accept', 'Accept', 'Accept this proposal under the current Scout policy'], ['reject', 'Reject', 'Reject this proposal']]),
      resolve: async (id) => {
        const result = await (id === 'accept' ? acceptScoutFindings : rejectScoutFindings)(workspaceFolder, [row.id], { dataDir });
        return result.ok && result.changed === 1;
      },
    });
  }
  return result;
}
export async function syncGateDecisionCards(dataDir, workspaceFolder) {
  const current = await gates(dataDir, workspaceFolder);
  const revisions = new Map(current.map((gate) => [gate.key, gate.subject.updatedAt]));
  for (const card of (await listPendingDecisions(dataDir, workspaceFolder)).items) {
    if (card.producer !== 'host-gate-adapter') continue;
    if (revisions.get(card.subject.gateKey) !== card.subject.updatedAt) await changeDecision(dataDir, card.id, card.revision, 'stale');
  }
  for (const gate of current) await createDecision(dataDir, {
    ...gate, workspaceFolder, producer: 'host-gate-adapter',
    subject: { ...gate.subject, gateKey: gate.key }, dedupeKey: `gate:${workspaceFolder}:${gate.key}`,
    onTimeout: 'nothing', allowOther: gate.allowOther === true,
  });
}
export async function executeGateDecision(card, optionId, dataDir, request, reason = '') {
  if (card.producer !== 'host-gate-adapter') return null;
  const gate = (await gates(dataDir, card.workspaceFolder)).find((entry) => entry.key === card.subject.gateKey);
  if (!gate || gate.subject.updatedAt !== card.subject.updatedAt) return { ok: false, reason: 'stale' };
  if (optionId === '__other__' && gate.allowOther) {
    const answers = gate.parseAnswer(reason);
    if (!answers) return { ok: false, reason: 'invalid_answer' };
    return await gate.resolve(optionId, request, answers) ? { ok: true } : { ok: false, reason: 'stale' };
  }
  if (!gate.options.some((option) => option.id === optionId)) return { ok: false, reason: 'unknown_option' };
  return await gate.resolve(optionId, request) ? { ok: true } : { ok: false, reason: 'stale' };
}
