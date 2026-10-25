/**
 * Per-workspace MCP operator prompt overrides, history and human-approved
 * proposals. This intentionally uses a dedicated SQLite file: prompt text is
 * workspace state, while repository files remain the immutable defaults.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { resolveDataPath } from '../runtime-paths.js';

export const MCP_OPERATOR_PROMPT_KEYS = Object.freeze(['common', 'operator', 'playbook']);
export const MCP_INSTRUCTIONS_MAX_CHARS = 3500;
export const MCP_PLAYBOOK_MAX_CHARS = 100_000;
export const MCP_OPERATOR_PROMPT_DB = 'mcp-operator-prompts.sqlite';

/** @typedef {{ dataDir?: string, now?: string, limit?: number, id?: string }} StoreOptions */

function dbPath(dataDir) {
  return dataDir ? path.join(dataDir, MCP_OPERATOR_PROMPT_DB) : resolveDataPath(MCP_OPERATOR_PROMPT_DB);
}

function open(dataDir) {
  const file = dbPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS mcp_operator_prompt_overrides (
      workspace_folder TEXT NOT NULL,
      prompt_key TEXT NOT NULL,
      text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_folder, prompt_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS mcp_operator_prompt_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_folder TEXT NOT NULL,
      prompt_key TEXT NOT NULL,
      text TEXT,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS mcp_operator_prompt_proposals (
      id TEXT PRIMARY KEY,
      workspace_folder TEXT NOT NULL,
      prompt_key TEXT NOT NULL,
      text TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      decided_at TEXT
    ) STRICT;
  `);
  return db;
}

function workspaceKey(workspaceFolder) {
  const value = String(workspaceFolder || '').trim();
  if (!value || !path.isAbsolute(value)) throw Object.assign(new Error('workspaceFolder must be an absolute path'), { code: 'VALIDATION_ERROR' });
  return path.resolve(value);
}

function promptKey(key) {
  const value = String(key || '').trim();
  if (!MCP_OPERATOR_PROMPT_KEYS.includes(value)) throw Object.assign(new Error('Unknown MCP operator prompt key'), { code: 'VALIDATION_ERROR' });
  return value;
}

function checkedText(key, text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) throw Object.assign(new Error('Prompt text must not be empty'), { code: 'VALIDATION_ERROR' });
  const limit = key === 'playbook' ? MCP_PLAYBOOK_MAX_CHARS : MCP_INSTRUCTIONS_MAX_CHARS;
  if (value.length > limit) throw Object.assign(new Error(`Prompt text is limited to ${limit} characters`), { code: 'VALIDATION_ERROR' });
  return value;
}

/** @param {string} workspaceFolder @param {StoreOptions} [options] */
export function readMcpOperatorPromptOverrides(workspaceFolder, { dataDir } = {}) {
  const workspace = workspaceKey(workspaceFolder);
  const db = open(dataDir);
  try {
    return Object.fromEntries(db.prepare('SELECT prompt_key, text FROM mcp_operator_prompt_overrides WHERE workspace_folder = ?').all(workspace).map((row) => [row.prompt_key, row.text]));
  } finally {
    db.close();
  }
}

/** @param {string} workspaceFolder @param {string} key @param {unknown} text @param {StoreOptions} [options] */
export function setMcpOperatorPromptOverride(workspaceFolder, key, text, { dataDir, now = new Date().toISOString() } = {}) {
  const workspace = workspaceKey(workspaceFolder);
  const checkedKey = promptKey(key);
  const value = checkedText(checkedKey, text);
  const db = open(dataDir);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`INSERT INTO mcp_operator_prompt_overrides(workspace_folder, prompt_key, text, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(workspace_folder, prompt_key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`).run(workspace, checkedKey, value, now);
    db.prepare('INSERT INTO mcp_operator_prompt_versions(workspace_folder, prompt_key, text, action, created_at) VALUES (?, ?, ?, ?, ?)').run(workspace, checkedKey, value, 'set', now);
    db.exec('COMMIT');
    return { workspaceFolder: workspace, key: checkedKey, text: value, updatedAt: now };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

/** @param {string} workspaceFolder @param {string} key @param {StoreOptions} [options] */
export function resetMcpOperatorPromptOverride(workspaceFolder, key, { dataDir, now = new Date().toISOString() } = {}) {
  const workspace = workspaceKey(workspaceFolder);
  const checkedKey = promptKey(key);
  const db = open(dataDir);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM mcp_operator_prompt_overrides WHERE workspace_folder = ? AND prompt_key = ?').run(workspace, checkedKey);
    db.prepare('INSERT INTO mcp_operator_prompt_versions(workspace_folder, prompt_key, text, action, created_at) VALUES (?, ?, NULL, ?, ?)').run(workspace, checkedKey, 'reset', now);
    db.exec('COMMIT');
    return { workspaceFolder: workspace, key: checkedKey, reset: true };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

/** @param {string} workspaceFolder @param {StoreOptions} [options] */
export function listMcpOperatorPromptHistory(workspaceFolder, { dataDir, limit = 50 } = {}) {
  const workspace = workspaceKey(workspaceFolder);
  const db = open(dataDir);
  try {
    return db.prepare(`SELECT id, prompt_key AS promptKey, text, action, created_at AS createdAt
      FROM mcp_operator_prompt_versions WHERE workspace_folder = ? ORDER BY id DESC LIMIT ?`).all(workspace, Math.max(1, Math.min(200, Number(limit) || 50)));
  } finally {
    db.close();
  }
}

/** @param {string} workspaceFolder @param {string} key @param {unknown} text @param {unknown} reason @param {StoreOptions} [options] */
export function proposeMcpOperatorPromptChange(workspaceFolder, key, text, reason, { dataDir, now = new Date().toISOString(), id = randomUUID() } = {}) {
  const workspace = workspaceKey(workspaceFolder);
  const checkedKey = promptKey(key);
  const value = checkedText(checkedKey, text);
  const why = String(reason || '').trim();
  if (!why) throw Object.assign(new Error('reason is required'), { code: 'VALIDATION_ERROR' });
  const db = open(dataDir);
  try {
    db.prepare(`INSERT INTO mcp_operator_prompt_proposals(id, workspace_folder, prompt_key, text, reason, status, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`).run(id, workspace, checkedKey, value, why, now);
    return { id, workspaceFolder: workspace, promptKey: checkedKey, text: value, reason: why, status: 'pending', createdAt: now };
  } finally {
    db.close();
  }
}

/** @param {string} workspaceFolder @param {StoreOptions} [options] */
export function listMcpOperatorPromptProposals(workspaceFolder, { dataDir } = {}) {
  const workspace = workspaceKey(workspaceFolder);
  const db = open(dataDir);
  try {
    return db.prepare(`SELECT id, prompt_key AS promptKey, text, reason, status, created_at AS createdAt, decided_at AS decidedAt
      FROM mcp_operator_prompt_proposals WHERE workspace_folder = ? ORDER BY created_at DESC`).all(workspace);
  } finally {
    db.close();
  }
}

/** @param {string} workspaceFolder @param {string} id @param {boolean} approve @param {StoreOptions} [options] */
export function decideMcpOperatorPromptProposal(workspaceFolder, id, approve, options = {}) {
  const workspace = workspaceKey(workspaceFolder);
  const proposalId = String(id || '').trim();
  const now = options.now || new Date().toISOString();
  const db = open(options.dataDir);
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare(`SELECT prompt_key AS promptKey, text, status FROM mcp_operator_prompt_proposals
      WHERE id = ? AND workspace_folder = ?`).get(proposalId, workspace);
    if (!row) throw Object.assign(new Error('Proposal not found'), { code: 'NOT_FOUND' });
    if (row.status !== 'pending') throw Object.assign(new Error('Proposal has already been decided'), { code: 'CONFLICT' });
    const updated = db.prepare("UPDATE mcp_operator_prompt_proposals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(approve ? 'approved' : 'rejected', now, proposalId);
    if (Number(updated.changes) !== 1) throw Object.assign(new Error('Proposal has already been decided'), { code: 'CONFLICT' });
    if (approve) {
      db.prepare(`INSERT INTO mcp_operator_prompt_overrides(workspace_folder, prompt_key, text, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(workspace_folder, prompt_key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`).run(workspace, row.promptKey, row.text, now);
      db.prepare('INSERT INTO mcp_operator_prompt_versions(workspace_folder, prompt_key, text, action, created_at) VALUES (?, ?, ?, ?, ?)').run(workspace, row.promptKey, row.text, 'approve-proposal', now);
    }
    db.exec('COMMIT');
    return { id: proposalId, status: approve ? 'approved' : 'rejected', promptKey: row.promptKey };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }
}
