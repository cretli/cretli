import { DocsError } from './docs-state-store.js';

export function validateTarget(value) {
  const match = /^(todo|initiative|decision):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(value);
  if (!match) throw new DocsError('docs-invalid-link', 'Target must be kind:uuid');
  return { kind: match[1].toLowerCase(), targetId: match[2].toLowerCase() };
}

export async function defaultTargetExists(dataDir, ws, kind, id) {
  if (kind === 'todo') {
    const { getTodo } = await import('../persist/todos-store.js');
    return Boolean(await getTodo(dataDir, ws.homeFolder, id));
  }
  if (kind === 'decision') {
    const { getDecision } = await import('../decisions/decision-store.js');
    const row = await getDecision(dataDir, id);
    return Boolean(row && row.workspaceFolder === ws.homeFolder);
  }
  const { getInitiativesService } = await import('../initiatives/initiatives-service.js');
  try { return Boolean(await getInitiativesService(dataDir).get({ workspaceUuid: ws.workspaceUuid }, id)); }
  catch (error) { if (error.code === 'not_found') return false; throw error; }
}

// Hints remain visible metadata; only persisted managed records establish authority.
export function linkHints(note, links) {
  const hints = note.frontmatter.cretli;
  if (!hints || typeof hints !== 'object') return [];
  return ['todo', 'initiative', 'decision'].flatMap((kind) => {
    const raw = hints[kind];
    return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((targetId) => ({ kind, targetId,
      conflict: !links.some((link) => link.source === 'managed' && link.kind === kind && link.targetId === targetId) }));
  });
}

export async function collectDocLinks({ dataDir, ws, state, notes, observed, targetExists }) {
  const links = state.links.map((link) => ({ ...link, source: 'managed' }));
  for (const note of notes.values()) for (const targetId of note.mentions) {
    links.push({ note: note.path, kind: 'todo', targetId, source: 'mention' });
  }
  const targets = new Map();
  for (const link of links) {
    const key = `${link.kind}:${link.targetId}`;
    if (!targets.has(key)) targets.set(key, await targetExists(dataDir, ws, link.kind, link.targetId));
    link.noteMissing = !notes.has(link.note);
    link.targetMissing = !targets.get(key);
    link.state = link.noteMissing || link.targetMissing ? 'dangling' : 'ok';
    if (link.noteMissing) {
      const old = observed.get(`${ws.workspaceUuid}:${link.note}`);
      const candidates = old ? [...notes.values()].filter((note) => old.sha256 === note.sha256
        || (old.frontmatter.cretli_id && old.frontmatter.cretli_id === note.frontmatter.cretli_id)) : [];
      link.suggestedPath ||= candidates.length === 1 ? candidates[0].path : null;
    }
  }
  return links;
}
