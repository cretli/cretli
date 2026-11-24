import { loadSettings } from '../persist/settings.js';
import { listRegisteredWorkspacesForFolder } from '../workspace-registry-service.js';
import path from 'node:path';
import { getChatByIdAsync } from '../persist/chats-persist.js';
import { resolveTodoHomeFromSettings } from '../todo-home.js';
import { requireRequestScope, scopeFolderOf } from '../workspace-scope.js';
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
  const getSettings = typeof ctx.loadSettings === 'function' ? ctx.loadSettings : loadSettings;
  function isKnownFolder(folder) {
    if (typeof ctx.isKnownFolder === 'function') return ctx.isKnownFolder(folder);
    return listRegisteredWorkspacesForFolder(getSettings(), folder).length > 0;
  }
  /**
   * Same scope rule as the delegation routes: the scope is explicit (folder, workspace or chat),
   * never the UI-selected workspace. A chat must belong to the requested workspace; without a
   * chat the folder must be a registered workspace folder. Returns { folder } or { denied }.
   */
  async function resolveScope(req) {
    const settings = getSettings();
    const resolved = await requireRequestScope(req, settings, ctx.scopeDeps);
    if (!resolved.ok) {
      return { denied: { status: resolved.status, json: { ok: false, code: resolved.code, error: resolved.error } } };
    }
    const { scope } = resolved;
    const folder = scopeFolderOf(scope, (input) => resolveTodoHomeFromSettings(input, settings));
    if (!folder) return { denied: { status: 400, json: { ok: false, code: 'workspace-scope-required', error: 'workspace-scope-required' } } };
    const widgetChatId = req.widgetAccess ? String(req.query?.chatId || req.body?.chatId || '').trim() : '';
    if (widgetChatId) {
      const chat = await getChatByIdAsync(widgetChatId);
      if (!chat || chat.widgetInstallationId !== req.widgetAccess.installationId) return { denied: { status: 404, json: { ok: false, code: 'NOT_FOUND', error: 'Chat not found.' } } };
    }
    if (scope.source !== 'chat' && !scope.chatId && scope.source !== 'widget' && !isKnownFolder(path.resolve(folder))) {
      return { denied: { status: 403, json: { ok: false, code: 'OUT_OF_SCOPE', error: 'This folder is not a registered workspace.' } } };
    }
    return { folder };
  }
  function fail(res, err) {
    const status = err.code === 'CONFLICT' ? 409 : err.code === 'NOT_FOUND' ? 404 : err.code === 'CORRUPT' ? 500 : 400;
    return res.status(status).json({ ok: false, error: err.message, code: err.code === 'CONFLICT' ? 'CONFLICT' : err.code || 'VALIDATION' });
  }
  app.get('/api/review-lessons', async (req, res) => {
    const { folder, denied } = await resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try { return res.json({ ok: true, lessons: listLessons(folder, { dataDir: ctx.dataDir }) }); } catch (err) { return fail(res, err); }
  });
  app.post('/api/review-lessons', async (req, res) => {
    const { folder, denied } = await resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try { return res.json({ ok: true, lesson: addLesson(folder, lessonFromBody(req.body), { dataDir: ctx.dataDir }) }); } catch (err) { return fail(res, err); }
  });
  // Manual distillation: same scope rule as the other lesson routes; candidates only.
  app.post('/api/review-lessons/distill', async (req, res) => {
    const { folder, denied } = await resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try {
      const { minFindings, minLeaves, windowDays, dryRun } = req.body || {};
      return res.json({ ok: true, ...distillReviewLessons(folder, { minFindings, minLeaves, windowDays, dryRun: dryRun === true, dataDir: ctx.dataDir }) });
    } catch (err) { return fail(res, err); }
  });
  // Propose a deterministic check: one idea todo per lesson (replays return the same todo).
  app.post('/api/review-lessons/:id/propose-check', async (req, res) => {
    const { folder, denied } = await resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try {
      const chatId = String(req.query?.chatId || req.body?.chatId || '').trim();
      return res.json({ ok: true, ...await proposeLessonCheck(folder, req.params.id, { dataDir: ctx.dataDir, createdByChatId: chatId }) });
    } catch (err) { return fail(res, err); }
  });
  app.patch('/api/review-lessons/:id', async (req, res) => {
    const { folder, denied } = await resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try { return res.json({ ok: true, lesson: updateLesson(folder, req.params.id, req.body?.patch || {}, req.body?.expectedRevision, { dataDir: ctx.dataDir }) }); } catch (err) { return fail(res, err); }
  });
  app.delete('/api/review-lessons/:id', async (req, res) => {
    const { folder, denied } = await resolveScope(req);
    if (denied) return res.status(denied.status).json(denied.json);
    try { return res.json({ ok: true, ...deleteLesson(folder, req.params.id, { dataDir: ctx.dataDir }) }); } catch (err) { return fail(res, err); }
  });
  // Findings of one leaf for the Todo panel (current cycle first). Text is scrubbed of private paths.
  app.get('/api/review-findings', async (req, res) => {
    const { folder, denied } = await resolveScope(req);
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
  app.post('/api/review-findings/reject', async (req, res) => {
    const { folder, denied } = await resolveScope(req);
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
