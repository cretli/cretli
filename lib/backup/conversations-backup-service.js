/**
 * Facade for conversation export/import jobs (B3). Wires the store port, the job
 * runner and the importer; the HTTP layer only talks to this module.
 * Docs: docs/backup/conversations-export-import.md.
 */

import { resolveDataPath } from '../runtime-paths.js';
import { createDefaultConversationStore } from './conversations-store.js';
import { createJobManager } from './backup-jobs.js';
import {
  ConversationArchiveError,
  buildConversationsExport,
  previewExport,
} from './conversations-archive.js';
import { ConversationImportError, createConversationImporter } from './conversations-import.js';

const EXPORT_SCOPES = Object.freeze(['chat', 'selection', 'workspace', 'all']);

/**
 * @param {unknown} raw
 * @returns {Parameters<typeof buildConversationsExport>[1]}
 */
export function normalizeExportRequest(raw) {
  const body = raw && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {};
  const scope = String(body.scope || '');
  if (!EXPORT_SCOPES.includes(scope)) throw new ConversationArchiveError('selection_invalid', `scope must be one of: ${EXPORT_SCOPES.join(', ')}`);
  const chatIds = Array.isArray(body.chatIds) ? body.chatIds.map((id) => String(id)).slice(0, 5000) : undefined;
  const format = body.format === 'markdown' ? 'markdown' : 'archive';
  return {
    scope: /** @type {any} */ (scope),
    chatIds,
    workspaceFolder: typeof body.workspaceFolder === 'string' ? body.workspaceFolder : undefined,
    workspaceFile: typeof body.workspaceFile === 'string' ? body.workspaceFile : undefined,
    includeArchived: body.includeArchived === true,
    includeSubchats: body.includeSubchats === true,
    includeAttachments: body.includeAttachments !== false,
    includeWorkspacePaths: body.includeWorkspacePaths === true,
    includeMarkdown: body.includeMarkdown !== false,
    format,
  };
}

/**
 * @param {{
 *   store?: import('./conversations-store.js').ConversationStore,
 *   jobsDir?: string,
 *   importerHooks?: Parameters<typeof createConversationImporter>[0]['hooks'],
 *   maxImportBytes?: number,
 * }} [options]
 */
export function createConversationsBackupService(options = {}) {
  const store = options.store || createDefaultConversationStore();
  const jobs = createJobManager({ dir: options.jobsDir || resolveDataPath('backup-jobs') });
  const importer = createConversationImporter({ store, hooks: options.importerHooks, maxImportBytes: options.maxImportBytes });

  return {
    jobs,
    importer,
    store,

    /** Selection summary and size estimate; nothing is written. @param {unknown} raw */
    async estimateExport(raw) {
      return previewExport(store, normalizeExportRequest(raw));
    },

    /**
     * Starts an export as a job that survives the HTTP connection.
     *
     * @param {unknown} raw
     * @param {{ idempotencyKey?: string }} [opts]
     */
    startExport(raw, opts = {}) {
      const request = normalizeExportRequest(raw);
      return jobs.start('conversations-export', async (ctx) => {
        ctx.progress(0, 1, 'collecting');
        const built = await buildConversationsExport(store, {
          ...request,
          shouldCancel: ctx.isCancelled,
          onProgress: (done, total) => ctx.progress(done, total + 1, 'reading chats'),
        });
        const contentType = built.format === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/zip';
        const artifact = ctx.publish(built.fileName, built.bytes, contentType);
        return { artifact, format: built.format, archiveId: built.archiveId, ...built.summary };
      }, { idempotencyKey: opts.idempotencyKey });
    },

    /** @param {Buffer} bytes */
    stageImport: (bytes) => importer.stage(bytes),

    /** @param {{ stageId: string, options?: unknown }} input */
    previewImport: (input) => importer.preview(input),

    /**
     * Apply runs as a non-cancellable job: once the chat-list commit may have happened,
     * "cancelled" would be a lie. The job id is derived from the preview, so a retried
     * request after a lost response returns the same job.
     *
     * @param {{ previewId: string }} input
     */
    startImportApply(input) {
      const previewId = String(input.previewId || '');
      if (!/^[0-9a-f-]{36}$/.test(previewId)) throw new ConversationImportError('PREVIEW_NOT_FOUND', 'Invalid preview id', 404);
      return jobs.start('conversations-import', async (ctx) => {
        ctx.progress(0, 1, 'importing');
        const result = await importer.apply({ previewId });
        ctx.progress(1, 1, 'imported');
        return { ...result };
      }, { idempotencyKey: `apply:${previewId}`, cancellable: false });
    },

    /** Roll interrupted imports forward/back; call once at startup. */
    recover: () => importer.recover(),
  };
}

/** @type {ReturnType<typeof createConversationsBackupService> | null} */
let shared = null;

/** @returns {ReturnType<typeof createConversationsBackupService>} */
export function getConversationsBackupService() {
  if (!shared) shared = createConversationsBackupService();
  return shared;
}

/** Test hook. */
export function resetConversationsBackupServiceForTests() {
  shared = null;
}
