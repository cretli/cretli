/**
 * Store port for conversation export/import (B3).
 *
 * The backup services never touch the chat store, history or `uploads/` directly;
 * they go through this port so tests can inject failures and so a later storage
 * backend only needs a new adapter. The default adapter reads the chat list
 * strictly (a corrupt store fails the job instead of looking like "no chats") and
 * commits imports through one bounded adapter operation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from '../runtime-paths.js';
import { readChatsStrictAsync, importChatsBatchAsync } from '../persist/chats-persist.js';
import {
  appendChatHistoryEvents,
  deleteChatHistory,
  loadChatHistory,
} from '../persist/chat-history-service.js';
import { writeFileDurable } from './durable-write.js';

/** Upload names created by `/api/upload-screenshot` (UUID + .jpg) are the only attachments. */
export const ATTACHMENT_NAME_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jpg$/;

/** The sqlite history backend refuses larger append batches. */
const APPEND_BATCH = 128;

export class ConversationStoreError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ConversationStoreError';
    this.code = code;
  }
}

/** @returns {string} */
const uploadsDir = () => resolveDataPath('uploads');

/**
 * @typedef {Object} ConversationStore
 * @property {() => Promise<{ chats: Record<string, any>[], revision: string | number }>} readChats logical strict read
 * @property {(chatId: string) => Promise<{ headSeq: number, events: Array<{ seq: number, rec: any }> } | null>} loadHistory
 * @property {(name: string) => Buffer | null} readUpload null when the attachment is missing
 * @property {() => string} uploadsPath absolute destination directory (used to rewrite references)
 * @property {(name: string, bytes: Buffer) => void} writeUpload
 * @property {(name: string) => void} deleteUpload
 * @property {(chatId: string, cursorSessionId: string, recs: Record<string, any>[]) => Promise<void>} writeHistory
 * @property {(chatId: string) => Promise<void>} deleteHistory
 * @property {(entries: Record<string, any>[]) => Promise<string | number>} commitChats appends entries; returns the new revision
 * @property {(ids: string[]) => Promise<void>} rollbackImportedChats removes chats a failed import added
 */

/**
 * @returns {Promise<{ chats: Record<string, any>[], revision: string | number }>}
 */
async function readChatsStrict() {
  try {
    return await readChatsStrictAsync();
  } catch (err) {
    if (err?.code === 'SOURCE_CORRUPT') throw new ConversationStoreError('SOURCE_CORRUPT', err.message);
    throw err;
  }
}

/**
 * @returns {ConversationStore}
 */
export function createDefaultConversationStore(overrides = {}) {
  return {
    readChats: readChatsStrict,
    async loadHistory(chatId) {
      const doc = await loadChatHistory(chatId);
      if (!doc) return null;
      return { headSeq: Number(doc.headSeq) || 0, events: Array.isArray(doc.events) ? doc.events : [] };
    },
    readUpload(name) {
      if (!ATTACHMENT_NAME_PATTERN.test(name)) return null;
      const root = path.resolve(uploadsDir());
      const target = path.resolve(root, name);
      if (path.dirname(target) !== root) return null;
      try {
        const stat = fs.lstatSync(target);
        if (!stat.isFile()) return null;
        return fs.readFileSync(target);
      } catch {
        return null;
      }
    },
    uploadsPath: () => path.resolve(uploadsDir()),
    writeUpload(name, bytes) {
      if (!ATTACHMENT_NAME_PATTERN.test(name)) throw new ConversationStoreError('ATTACHMENT_NAME_INVALID', `Illegal attachment name: ${name}`);
      writeFileDurable(path.join(uploadsDir(), name), bytes, { mode: 0o600 });
    },
    deleteUpload(name) {
      if (!ATTACHMENT_NAME_PATTERN.test(name)) return;
      try { fs.unlinkSync(path.join(uploadsDir(), name)); } catch { /* already gone */ }
    },
    async writeHistory(chatId, cursorSessionId, recs) {
      for (let i = 0; i < recs.length; i += APPEND_BATCH) {
        const result = await appendChatHistoryEvents(
          chatId,
          cursorSessionId,
          recs.slice(i, i + APPEND_BATCH).map((rec) => ({ rec })),
        );
        if (!result || result.ok === false) {
          throw new ConversationStoreError('HISTORY_WRITE_FAILED', `History append failed for ${chatId}: ${result?.error || 'unknown'}`);
        }
      }
    },
    async deleteHistory(chatId) {
      await deleteChatHistory(chatId);
    },
    async commitChats(entries) {
      const result = await importChatsBatchAsync(entries);
      if (result.added !== entries.length) {
        const { rollbackImportedChatsAsync } = await import('../persist/chats-persist.js');
        await rollbackImportedChatsAsync(result.addedIds || []);
        throw new ConversationStoreError('CHAT_IMPORT_CONFLICT', 'Some destination chats already exist');
      }
      return result.revision;
    },
    async rollbackImportedChats(ids) {
      const { rollbackImportedChatsAsync } = await import('../persist/chats-persist.js');
      await rollbackImportedChatsAsync(ids);
    },
    ...overrides,
  };
}
