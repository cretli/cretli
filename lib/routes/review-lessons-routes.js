import path from 'node:path';
import { loadChats } from '../persist/chats-persist.js';
import { isChatInWorkspace } from '../mcp/builtin/tool-context.js';
import { distillReviewLessons } from '../review-lessons-distill.js';
import { proposeLessonCheck } from '../review-lessons-checks.js';
import { getReviewFindingsLedger, rejectReviewFindingByHuman } from '../persist/review-findings-ledger-persist.js';
import { redactPrivatePaths } from '../review-lessons-privacy.js';
import { REVIEW_FINDING_REJECT_REASONS } from '../review-findings-taxonomy.js';
import { addLesson, deleteLesson, listLessons, updateLesson } from '../review-lessons-service.js';

/** Strip transport scope fields so they are never stored on the lesson. */
function lessonFromBody(body) {
  const { workspaceFolder, workspaceFile, chatId, ...lesson } = body || {};
  return lesson;
}

export function registerReviewLessonsRoutes(app, ctx = {}) {
  function workspaceFolderFrom(req) {
    return String(req.query?.workspaceFolder || req.body?.workspaceFolder || '').trim();
  }
  function selectedWorkspaceFolders() {
    const selected = typeof ctx.getCurrentWorkspace === 'function' ? ctx.getCurrentWorkspace() : null;
    if (typeof selected === 'string') return [selected];
    return [selected?.workspaceDir, ...(Array.isArray(selected?.folders) ? selected.folders.map((row) => row.resolvedPath || row.path) : [])]
      .map((row) => String(row || '').trim()).filter(Boolean);
  }
  /**
   * Same scope rule as the delegation routes: the calling chat must belong to
   * the requested workspace folder. Without a chat id the folder must be in
   * the UI-selected workspace. Returns { folder } or { denied }.
   */
  function resolveScope(req) {
    const folder = workspaceFolderFrom(req);
    if (!folder) return { denied: { status: 400, json: { ok: false, code: 'VALIDATION', error: 'workspaceFolder is required.' } } };
    const outOfScope = { status: 403, json: { ok: false, code: 'OUT_OF_SCOPE', error: 'This chat is outside the requested workspace.' } };
    const chatId = String(req.query?.chatId || req.body?.chatId || '').trim();
    if (!chatId) {
      const hasSelection = typeof ctx.getCurrentWorkspace === 'function';
      return hasSelection && !selectedWorkspaceFolders().some((row) => path.resolve(row) === path.resolve(folder)) ? { denied: outOfScope } : { folder };
    }
    const chat = loadChats().find((row) => row.id === chatId);
    if (!chat || (req.widgetAccess && chat.widgetInstallationId !== req.widgetAccess.installationId)) return { denied: { status: 404, json: { ok: false, code: 'NOT_FOUND', error: 'Chat not found.' } } };
    const file = String(req.query?.workspaceFile || req.body?.workspaceFile || '').trim();
    return isChatInWorkspace(chat, folder, file) ? { folder } : { denied: outOfScope };
  }
  function fail(res, err) {
    const status = err.code === 'CONFLICT' ? 409 : err.code === 'NOT_FOUND' ? 404 : err.code === 'CORRUPT' ? 500 : 400;
    return res.status(status).json({ ok: false, error: err.message, code: err.code === 'CONFLICT' ? 'CONFLICT' : err.code || 'VALIDATION' });
  }
  app.get('/api/review-lessons', (req, res) => {
    const { folder, denied } = resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try { return res.json({ ok: true, lessons: listLessons(folder, { dataDir: ctx.dataDir }) }); } catch (err) { return fail(res, err); }
  });
  app.post('/api/review-lessons', (req, res) => {
    const { folder, denied } = resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try { return res.json({ ok: true, lesson: addLesson(folder, lessonFromBody(req.body), { dataDir: ctx.dataDir }) }); } catch (err) { return fail(res, err); }
  });
  // Manual distillation: same scope rule as the other lesson routes; candidates only.
  app.post('/api/review-lessons/distill', (req, res) => {
    const { folder, denied } = resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try {
      const { minFindings, minLeaves, windowDays, dryRun } = req.body || {};
      return res.json({ ok: true, ...distillReviewLessons(folder, { minFindings, minLeaves, windowDays, dryRun: dryRun === true, dataDir: ctx.dataDir }) });
    } catch (err) { return fail(res, err); }
  });
  // Propose a deterministic check: one idea todo per lesson (replays return the same todo).
  app.post('/api/review-lessons/:id/propose-check', async (req, res) => {
    const { folder, denied } = resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try {
      const chatId = String(req.query?.chatId || req.body?.chatId || '').trim();
      return res.json({ ok: true, ...await proposeLessonCheck(folder, req.params.id, { dataDir: ctx.dataDir, createdByChatId: chatId }) });
    } catch (err) { return fail(res, err); }
  });
  app.patch('/api/review-lessons/:id', (req, res) => {
    const { folder, denied } = resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try { return res.json({ ok: true, lesson: updateLesson(folder, req.params.id, req.body?.patch || {}, req.body?.expectedRevision, { dataDir: ctx.dataDir }) }); } catch (err) { return fail(res, err); }
  });
  app.delete('/api/review-lessons/:id', (req, res) => {
    const { folder, denied } = resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try { return res.json({ ok: true, ...deleteLesson(folder, req.params.id, { dataDir: ctx.dataDir }) }); } catch (err) { return fail(res, err); }
  });
  // Findings of one leaf for the Todo panel (current cycle first). Text is scrubbed of private paths.
  app.get('/api/review-findings', (req, res) => {
    const { folder, denied } = resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    const leafId = String(req.query?.leafId || '').trim();
    if (!leafId) return res.status(400).json({ ok: false, code: 'VALIDATION', error: 'leafId is required.' });
    try {
      const item = getReviewFindingsLedger(folder, leafId);
      const findings = (item?.entries || []).map((entry) => ({
        key: entry.key,
        cycle: entry.cycle,
        priority: entry.priority || '',
        category: entry.category || 'other',
        files: (entry.files || []).map((file) => redactPrivatePaths(file)),
        summary: redactPrivatePaths(entry.summary),
        outcome: entry.outcome,
        delegationId: entry.origin?.delegationId || '',
        rejection: entry.rejection ? { reason: entry.rejection.reason, actor: entry.rejection.actor, note: redactPrivatePaths(entry.rejection.note), at: entry.rejection.at } : null,
      }));
      return res.json({ ok: true, leafId, cycle: item?.cycle || 1, seq: item?.seq || 0, rejectReasons: REVIEW_FINDING_REJECT_REASONS, findings });
    } catch (err) { return fail(res, err); }
  });
  // Human reject of one finding: overrides an orchestrator rejection; idempotent; `expectedSeq` is the CAS token.
  app.post('/api/review-findings/reject', (req, res) => {
    const { folder, denied } = resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try {
      const { leafId, key, reason, note, expectedSeq } = req.body || {};
      const result = rejectReviewFindingByHuman({ workspaceFolder: folder, leafId, key, reason, note, expectedSeq });
      if (result.ok) return res.json({ ok: true, changed: result.changed, seq: result.seq, finding: { key: result.entry.key, outcome: result.entry.outcome, rejection: result.entry.rejection } });
      const status = { VALIDATION: 400, NOT_FOUND: 404, CONFLICT: 409, NOT_REJECTABLE: 409 }[result.code] || 400;
      const error = { VALIDATION: 'leafId, key and a valid reason are required.', NOT_FOUND: 'Finding not found.', CONFLICT: 'The findings changed; reload and retry.', NOT_REJECTABLE: 'This finding cannot be rejected (out of scope or follow-up).' }[result.code] || 'Rejection failed.';
      return res.status(status).json({ ok: false, code: result.code, error, ...(result.seq != null ? { seq: result.seq } : {}) });
    } catch (err) { return fail(res, err); }
  });
}
