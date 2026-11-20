import fs from 'node:fs';
import { createDocsProposals } from './docs-proposals.js';
import { setImmediate } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { collectDocLinks, defaultTargetExists, validateTarget, linkHints } from './docs-links.js';
import path from 'node:path';
import { DocsError, getDocsWorkspace, updateDocsWorkspace } from './docs-state-store.js';
import { MAX_SKIPPED, checkExpected, checkText, inside, notePath, readNote, resolveNote, trashNote, writeNote } from './docs-files.js';
import { backlinksFor, createDocsIndex, parseNote, rewriteWikilinks } from './docs-index.js';

async function defaultScope(dataDir, input) {
  const { resolveInitiativeScopeDefault } = await import('../initiatives/initiatives-service.js');
  try { return await resolveInitiativeScopeDefault(dataDir, input); }
  catch { throw new DocsError('workspace_required', 'A registered workspace is required', 409); }
}

export function createDocsService({ dataDir, resolveScope = defaultScope, targetExists = defaultTargetExists }) {
  const indexes = new Map();
  const scope = async (input) => {
    const value = await resolveScope(dataDir, input || {});
    if (!value?.workspaceUuid || !value.homeFolder) throw new DocsError('workspace_required', 'A registered workspace is required', 409);
    return value;
  };
  const stateFor = (ws) => {
    const saved = getDocsWorkspace(dataDir, ws.workspaceUuid);
    if (saved) return saved;
    let root = null;
    try { if (fs.statSync(path.join(ws.homeFolder, 'docs')).isDirectory()) root = { path: 'docs', external: false }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { root, consent: null, links: [] };
  };
  const rootInfo = (ws, state) => {
    if (!state.root) throw new DocsError('docs-not-configured', 'Docs root is not configured', 409);
    const home = fs.realpathSync(ws.homeFolder);
    const realpath = fs.realpathSync(path.resolve(home, state.root.path));
    if (!fs.statSync(realpath).isDirectory()) throw new DocsError('docs-invalid-root', 'Docs root must be a directory');
    const external = !inside(home, realpath);
    const consented = Boolean(state.consent?.grantedBy === 'human' && state.consent.realpath === realpath);
    return { path: state.root.path, realpath, external, consented, agentRead: !external || (consented && state.consent?.agentRead === true) };
  };
  const access = (ws, actor) => {
    const state = stateFor(ws);
    const root = rootInfo(ws, state);
    if (root.external && !root.consented) throw new DocsError('docs-consent-required', 'External Docs root requires human consent', 403);
    if (actor !== 'human' && !root.agentRead) throw new DocsError('docs-agent-read-denied', 'Agent reading is disabled for this root', 403);
    return { state, root };
  };
  const human = (actor) => { if (actor !== 'human') throw new DocsError('docs-human-required', 'A human session is required', 403); };
  const indexFor = (ws, root) => {
    let entry = indexes.get(ws.workspaceUuid);
    if (entry?.root !== root.realpath) {
      entry?.index.close();
      entry = { root: root.realpath, index: createDocsIndex(root.realpath) };
      indexes.set(ws.workspaceUuid, entry);
    }
    return entry.index;
  };
  const unavailableIn = (skipped) => (note) => skipped.length >= MAX_SKIPPED
    || skipped.some((entry) => entry.path === note || note.startsWith(`${entry.path}/`));
  const collectLinks = async (ws, notes, skipped) => {
    const links = await collectDocLinks({ dataDir, ws, state: stateFor(ws), notes, observed, targetExists });
    for (const link of links) if (link.noteMissing && unavailableIn(skipped)(link.note)) {
      link.noteMissing = null;
      link.state = link.targetMissing ? 'dangling' : 'unknown';
      link.suggestedPath = null;
    }
    return links;
  };
  const observed = new Map();
  const refresh = (ws, root, actor = 'human') => {
    const index = indexFor(ws, root);
    const { notes, previous, skipped } = index.refresh();
    const state = stateFor(ws);
    // Once diagnostics fill up, absence from the index cannot prove a note is missing.
    const unavailable = unavailableIn(skipped);
    const missing = state.links.filter((link) => !notes.has(link.note) && !unavailable(link.note) && link.state !== 'dangling');
    if (missing.length && actor === 'human') updateDocsWorkspace(dataDir, ws.workspaceUuid, (stored) => {
      for (const link of stored.links) {
        if (!notes.has(link.note) && !unavailable(link.note)) {
          const old = previous.get(link.note);
          const candidates = old ? [...notes.values()].filter((note) => note.path !== link.note
            && ((old.frontmatter.cretli_id && note.frontmatter.cretli_id === old.frontmatter.cretli_id) || old.sha256 === note.sha256)) : [];
          link.state = 'dangling';
          link.suggestedPath = candidates.length === 1 ? candidates[0].path : null;
        }
      }
      return stored;
    });
    for (const [key, note] of previous) observed.set(`${ws.workspaceUuid}:${key}`, {
      sha256: note.sha256, frontmatter: { cretli_id: note.frontmatter.cretli_id },
    });
    while (observed.size > 4000) observed.delete(observed.keys().next().value);
    return { notes, skipped };
  };
  const proposals = createDocsProposals({ dataDir, scope, access, stateFor, targetExists,
    invalidate: (ws, root) => indexFor(ws, root).invalidate() });
  const api = {
    ...proposals,
    async config(input, actor = 'agent') {
      const ws = await scope(input);
      const state = stateFor(ws);
      if (!state.root) return { root: null, consent: null, agentRead: false };
      const root = rootInfo(ws, state);
      if (actor !== 'human') {
        // Consent and resolved paths are host metadata, even when agents may read notes.
        const relativeHint = !root.external && !path.isAbsolute(root.path) ? path.basename(path.normalize(root.path)) : null;
        return { root: { external: root.external, consented: root.consented, agentRead: root.agentRead,
          label: root.external ? 'External Docs' : 'Workspace Docs',
          ...(!root.external ? { internal: true } : {}), ...(relativeHint ? { relativeHint } : {}) },
        consent: { granted: root.consented, agentRead: root.agentRead,
          ...(root.consented ? { at: state.consent.grantedAt } : {}) }, agentRead: root.agentRead };
      }
      return { root, consent: root.consented ? state.consent : null, agentRead: root.agentRead };
    },
    async setConfig(input, args, actor) {
      human(actor);
      const ws = await scope(input);
      const value = args.root;
      let root = null;
      if (value !== null) {
        if (typeof value !== 'string' || !value || value.includes('\0')) throw new DocsError('docs-invalid-root', 'root must be a directory path or null');
        const home = fs.realpathSync(ws.homeFolder);
        const absolute = path.resolve(home, value);
        if (!path.isAbsolute(value) && !inside(home, absolute)) throw new DocsError('docs-invalid-root', 'Relative root must stay inside the workspace');
        if (args.create === true && !fs.existsSync(absolute)) {
          // Root creation is limited to one child of an existing workspace directory.
          const parent = fs.realpathSync(path.dirname(absolute));
          if (!inside(home, parent)) throw new DocsError('docs-invalid-root', 'Create roots inside the workspace only');
          fs.mkdirSync(path.join(parent, path.basename(absolute)));
        }
        const real = fs.realpathSync(absolute);
        if (!fs.statSync(real).isDirectory()) throw new DocsError('docs-invalid-root', 'Docs root must be a directory');
        root = { path: value, external: !inside(home, real) };
      }
      updateDocsWorkspace(dataDir, ws.workspaceUuid, (state) => ({ ...state, root, consent: null }));
      indexes.get(ws.workspaceUuid)?.index.close();
      indexes.delete(ws.workspaceUuid);
      for (const key of observed.keys()) if (key.startsWith(`${ws.workspaceUuid}:`)) observed.delete(key);
      return api.config(input, actor);
    },
    async consent(input, args, actor, revoke = false) {
      human(actor);
      const ws = await scope(input);
      const state = stateFor(ws);
      const root = rootInfo(ws, state);
      updateDocsWorkspace(dataDir, ws.workspaceUuid, (saved) => ({ ...saved, root: state.root,
        consent: revoke ? null : { realpath: root.realpath, grantedAt: new Date().toISOString(), grantedBy: 'human', agentRead: args.agentRead === true },
      }));
      return api.config(input, actor);
    },
    async tree(input, actor) {
      const ws = await scope(input);
      const { root } = access(ws, actor);
      const { notes, skipped } = refresh(ws, root, actor);
      return { items: [...notes.values()].map(({ path, title, size, tags }) => ({ path, title, size, tags })), skipped };
    },
    async read(input, args, actor) {
      const ws = await scope(input);
      const { root } = access(ws, actor);
      const note = parseNote(readNote(root.realpath, notePath(args.path)));
      const { notes, skipped } = refresh(ws, root, actor);
      const links = await collectLinks(ws, notes, skipped);
      const managed = links.filter((link) => link.note === note.path);
      return { note: { ...note, links: managed, linkHints: linkHints(note, managed), backlinks: backlinksFor(note.path, notes) } };
    },
    async search(input, args, actor) {
      const ws = await scope(input);
      const { root } = access(ws, actor);
      if (typeof args.q !== 'string' || args.q.length > 256) throw new DocsError('docs-invalid-query', 'Search query must be at most 256 characters');
      const q = args.q.trim().toLowerCase();
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));
      return { items: q ? [...refresh(ws, root, actor).notes.values()].filter((note) => `${note.title}\n${note.text}`.toLowerCase().includes(q))
        .slice(0, limit).map(({ path, title, tags }) => ({ path, title, tags })) : [] };
    },
    async backlinks(input, args, actor) {
      const ws = await scope(input);
      const { root } = access(ws, actor);
      if (args.path && args.target) throw new DocsError('docs-invalid-link', 'Choose path or target');
      if (args.target) return api.links(input, { target: args.target }, actor);
      const target = notePath(args.path);
      const result = await api.links(input, { note: target }, actor);
      return { items: backlinksFor(target, refresh(ws, root, actor).notes), links: result.items };
    },
    /** Bounded metadata for one todo, without scanning unrelated notes or link targets. */
    async agentContext(input, { todoId, signal, limit = 50 }) {
      const ws = await scope(input);
      signal?.throwIfAborted();
      const { state, root } = access(ws, 'agent');
      const target = validateTarget(`todo:${todoId}`);
      const matching = state.links.filter((link) => link.kind === target.kind && link.targetId === target.targetId);
      const cap = Math.min(50, Math.max(1, Math.floor(Number(limit) || 50)));
      const selected = matching.slice(0, cap);
      if (!selected.length) return { items: [], notes: [], truncated: false };
      const targetMissing = !await targetExists(dataDir, ws, target.kind, target.targetId);
      signal?.throwIfAborted();
      const items = []; const notes = [];
      for (const link of selected) {
        // Yield between bounded file reads so the helper's deadline can abort remaining work.
        await setImmediate(undefined, { signal });
        let noteMissing = false;
        try {
          const note = parseNote(readNote(root.realpath, link.note));
          notes.push({ path: note.path, title: note.title });
        } catch (error) {
          if (error.code === 'ENOENT') noteMissing = true;
          else continue; // Unreadable or escaping paths must never be advertised to an agent.
        }
        items.push({ note: link.note, source: 'managed', noteMissing, targetMissing,
          state: noteMissing || targetMissing ? 'dangling' : 'ok' });
      }
      signal?.throwIfAborted();
      // Consent or a symlink root may have changed while a target lookup was pending.
      if (access(ws, 'agent').root.realpath !== root.realpath) throw new DocsError('docs-root-changed', 'Docs root changed');
      return { items, notes, truncated: matching.length > selected.length || items.length < selected.length };
    },
    async links(input, args, actor) {
      const ws = await scope(input);
      const { root } = access(ws, actor);
      const { notes, skipped } = refresh(ws, root, actor);
      if (args.note && args.target) throw new DocsError('docs-invalid-link', 'Choose note or target');
      const note = args.note ? notePath(args.note) : null;
      const target = args.target ? validateTarget(args.target) : null;
      if (!note && !target) throw new DocsError('docs-invalid-link', 'note or target is required');
      const items = await collectLinks(ws, notes, skipped);
      return { items: items.filter((link) => note ? link.note === note : link.kind === target.kind && link.targetId === target.targetId) };
    },
    async addLink(input, args, actor) {
      human(actor);
      const ws = await scope(input);
      const { root } = access(ws, actor);
      const note = notePath(args.note);
      readNote(root.realpath, note);
      const target = validateTarget(`${args.kind}:${args.targetId}`);
      if (!await targetExists(dataDir, ws, target.kind, target.targetId)) throw new DocsError('docs-target-not-found', 'Target is unavailable in this workspace', 404);
      const saved = updateDocsWorkspace(dataDir, ws.workspaceUuid, (state) => {
        state.root ||= { path: root.path, external: root.external };
        if (!state.links.some((link) => link.note === note && link.kind === target.kind && link.targetId === target.targetId)) {
          state.links.push({ id: randomUUID(), note, ...target, createdAt: new Date().toISOString(), createdBy: 'human', state: 'ok', suggestedPath: null });
        }
        return state;
      });
      return { link: saved.links.find((link) => link.note === note && link.kind === target.kind && link.targetId === target.targetId) };
    },
    async changeLink(input, args, actor, resolve = false) {
      human(actor);
      const ws = await scope(input);
      const { root } = access(ws, actor);
      const current = stateFor(ws).links.find((link) => link.id === args.id);
      if (!current) throw new DocsError('docs-link-not-found', 'Link does not exist', 404);
      const note = resolve ? notePath(args.note || current.suggestedPath) : null;
      if (resolve) readNote(root.realpath, note);
      updateDocsWorkspace(dataDir, ws.workspaceUuid, (state) => {
        if (resolve) Object.assign(state.links.find((link) => link.id === args.id), { note, state: 'ok', suggestedPath: null });
        else state.links = state.links.filter((link) => link.id !== args.id);
        return state;
      });
      return { id: args.id };
    },
    async write(input, args, actor, create = false) {
      human(actor);
      const ws = await scope(input);
      const { root } = access(ws, actor);
      const note = writeNote(root.realpath, args.path, args.text, { create, expectedSha256: args.expectedSha256 });
      indexFor(ws, root).invalidate();
      return { note };
    },
    async remove(input, args, actor) {
      human(actor);
      const ws = await scope(input);
      const { root } = access(ws, actor);
      const result = trashNote(root.realpath, args.path, args.expectedSha256);
      indexFor(ws, root).invalidate();
      refresh(ws, root, actor);
      return result;
    },
    async rename(input, args, actor) {
      human(actor);
      const ws = await scope(input);
      const { root } = access(ws, actor);
      const oldPath = notePath(args.path);
      const newPath = notePath(args.newPath);
      const original = readNote(root.realpath, oldPath);
      checkExpected(original, args.expectedSha256);
      const target = resolveNote(root.realpath, newPath, { missing: true });
      if (fs.existsSync(target)) throw new DocsError('docs-exists', 'Rename target already exists', 409);
      const { notes } = refresh(ws, root, actor);
      const edits = [...notes.values()].map((note) => ({ note, text: rewriteWikilinks(note, oldPath, newPath, notes) }))
        .filter(({ note, text }) => note.text !== text);
      for (const edit of edits) { checkText(edit.text); checkExpected(readNote(root.realpath, edit.note.path), edit.note.sha256); }
      const completed = [];
      try {
        // Reserve the destination without replacing an externally created note.
        fs.linkSync(resolveNote(root.realpath, oldPath), target);
        completed.push(`create:${newPath}`);
        for (const { note, text } of edits) {
          writeNote(root.realpath, note.path, text, { expectedSha256: note.sha256 });
          completed.push(`rewrite:${note.path}`);
        }
        // The renamed note may itself contain a link to the old name.
        const selfEdit = edits.find(({ note }) => note.path === oldPath);
        if (selfEdit) writeNote(root.realpath, newPath, selfEdit.text, { expectedSha256: original.sha256 });
        fs.unlinkSync(resolveNote(root.realpath, oldPath));
        completed.push(`remove:${oldPath}`);
        updateDocsWorkspace(dataDir, ws.workspaceUuid, (state) => {
          state.root ||= { path: root.path, external: root.external };
          for (const link of state.links) if (link.note === oldPath) Object.assign(link, { note: newPath, state: 'ok', suggestedPath: null });
          return state;
        });
      } catch (error) {
        throw new DocsError('docs-rename-partial', 'Rename failed; inspect completed steps before retrying', 409, { completed, cause: error.code });
      } finally { indexFor(ws, root).invalidate(); }
      return { path: newPath, updated: edits.map(({ note }) => note.path) };
    },
    close() { for (const { index } of indexes.values()) index.close(); indexes.clear(); observed.clear(); },
  };
  return api;
}

const services = new Map();
export function getDocsService(dataDir, options = {}) {
  if (!services.has(dataDir)) services.set(dataDir, createDocsService({ dataDir, ...options }));
  return services.get(dataDir);
}
