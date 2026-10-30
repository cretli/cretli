import { getChatById } from '../persist/chats-persist.js';
/** Live host gates retain their original reply functions and first-answer guards. */
const sources = new Map();
/** @param {unknown} key @param {(workspaceFolder: string) => any[] | Promise<any[]>} source */
export function registerDecisionGateSource(key, source) {
  sources.set(key, source);
  return () => { if (sources.get(key) === source) sources.delete(key); };
}
export async function listHostDecisionGates(workspaceFolder) {
  const gates = [];
  for (const source of sources.values()) gates.push(...await source(workspaceFolder));
  return gates;
}
/** @param {any} room @param {any} event @param {(payload: {requestId: string, reply: string}) => unknown} reply */
export function permissionGate(room, event, reply) {
  return {
    kind: 'permission', key: `permission:${room.chatId}:${event.requestId}`,
    subject: { chatId: room.chatId, requestId: event.requestId, updatedAt: event.requestId },
    title: 'Allow agent action?', summary: [event.action || event.title || event.permission || event.toolName, ...(event.resources || [])].filter(Boolean).join(' · '),
    evidence: [{ action: event.action || '', resources: event.resources || [] }],
    options: ['once', 'reject'].map((id) => ({ id, label: id === 'once' ? 'Allow once' : 'Reject', effect: id })),
    resolve: (id) => reply({ requestId: event.requestId, reply: id }),
  };
}
/** @param {any} room @param {any} event @param {(payload: {requestId: string, answers: string[][], reject: boolean}) => unknown} reply */
export function questionGate(room, event, reply) {
  const questions = event.questions || [];
  if (!questions.length) return null;
  // Keep the card compact. The full form is retained as evidence and custom
  // answers use the original harness payload, including multiple selections.
  let answers = [[]];
  for (const question of questions) {
    const labels = (question.options || []).map((option) => option.label).filter(Boolean);
    const selections = question.multiple
      ? Array.from({ length: Math.min(5, (2 ** Math.min(labels.length, 3)) - 1) }, (_, i) => labels.filter((_, j) => j < 3 && ((i + 1) & (1 << j))))
      : labels.slice(0, 5).map((label) => [label]);
    answers = answers.flatMap((prior) => selections.map((selection) => [...prior, selection])).slice(0, 5);
  }
  const shown = answers.length > 4 ? answers.slice(0, 3) : answers;
  const options = shown.map((answer, index) => ({ id: `answer_${index}`, label: answer.flat().join(' / '), effect: 'Send this answer' }));
  if (options.length < 4) options.push({ id: 'reject', label: 'Reject', effect: 'Decline to answer' });
  if (options.length < 2) options.unshift({ id: '__other__', label: 'Answer…', effect: 'Enter an answer in the details' });
  return {
    kind: 'question', key: `question:${room.chatId}:${event.requestId}`,
    subject: { chatId: room.chatId, requestId: event.requestId, updatedAt: event.requestId },
    title: String(questions[0].question), options, allowOther: true,
    summary: questions.length > 1 || questions.some((question) => question.multiple)
      ? 'Other answers: enter one JSON array of selected labels per question, for example [["A"], ["B", "C"]]. The full question form is in the details and chat.'
      : 'Select an option or enter a label or custom answer in the details.',
    evidence: [{ questions }],
    parseAnswer: (text) => {
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (!Array.isArray(parsed)) parsed = [[typeof parsed === 'string' ? parsed : String(text).trim()]];
      if (!Array.isArray(parsed) || parsed.length !== questions.length) return null;
      if (!parsed.every((selection, index) => Array.isArray(selection) && selection.length
        && (questions[index].multiple || selection.length === 1)
        && selection.every((label) => typeof label === 'string' && label.trim()
          && (questions[index].custom === true || !(questions[index].options || []).length
            || questions[index].options.some((option) => option.label === label))))) return null;
      return parsed;
    },
    resolve: (id, _request = undefined, customAnswers = undefined) => reply({ requestId: event.requestId,
      answers: id === 'reject' ? [] : id === '__other__' ? customAnswers : shown[Number(id.slice(7))], reject: id === 'reject' }),
  };
}

/** Reuse an existing human route with its original authenticated request. */
export async function invokeDecisionRoute(handler, request, params, body) {
  if (!request) return false;
  const scoped = Object.assign(Object.create(request), { params, body, query: {} });
  let payload;
  const response = { status() { return this; }, json(value) { payload = value; return this; } };
  await handler(scoped, response);
  if (payload?.ok === true) return true;
  if (['not-found', 'not_found', 'CONFLICT', 'conflict'].includes(payload?.code)) return false;
  throw new Error(payload?.error || 'Gate reply failed');
}

/** Cards follow the logical workspace even when an agent executes in a worktree. */
export function decisionRoomWorkspace(room) {
  try { return getChatById(room.chatId)?.workspaceFolder || room.cwd; }
  catch { return room.cwd; }
}
