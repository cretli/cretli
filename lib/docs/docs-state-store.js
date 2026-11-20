import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../persist/atomic-write.js';

export class DocsError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function loadDocsState(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, 'docs-state.json'), 'utf8'));
    if (value?.v !== 1 || !value.workspaces || Array.isArray(value.workspaces) || typeof value.workspaces !== 'object') {
      throw new Error('Invalid Docs state');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { v: 1, workspaces: {} };
    throw new DocsError('docs-state-unavailable', 'Docs state could not be loaded', 503);
  }
}

export function getDocsWorkspace(dataDir, workspaceUuid) {
  return loadDocsState(dataDir).workspaces[workspaceUuid] || null;
}

// Synchronous read-modify-write has no yield point between loading and committing.
export function updateDocsWorkspace(dataDir, workspaceUuid, update) {
  if (!workspaceUuid || ['__proto__', 'constructor', 'prototype'].includes(workspaceUuid)) {
    throw new DocsError('workspace_required', 'A registered workspace is required', 409);
  }
  const store = loadDocsState(dataDir);
  const current = store.workspaces[workspaceUuid] || { root: null, consent: null, links: [] };
  const next = update(structuredClone(current));
  next.revision = (current.revision || 0) + 1;
  store.workspaces[workspaceUuid] = next;
  fs.mkdirSync(dataDir, { recursive: true });
  writeJsonAtomic(path.join(dataDir, 'docs-state.json'), store);
  return structuredClone(next);
}
