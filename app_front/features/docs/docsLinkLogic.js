import { isDocPath } from '../../../lib/docs/doc-ref.js';

/** Keep only renderable note metadata; never return note bodies to the composer. */
export function docChoices(items) {
  return (Array.isArray(items) ? items : []).filter((item) => isDocPath(item.path))
    .map(({ path, title }) => ({ path, title: String(title || path) }));
}

export async function loadDocChoices(api, query, agentOnly = false) {
  if (agentOnly) {
    const config = await api.config();
    if (!config.agentRead) throw Object.assign(new Error('Agent reading is disabled'), { code: 'docs-agent-read-denied' });
  }
  const result = query.trim() ? await api.search(query.trim().slice(0, 256)) : await api.tree();
  return docChoices(result.items);
}

export function linkedDocRows(links, notes) {
  const titles = new Map(docChoices(notes).map((note) => [note.path, note.title]));
  return links.filter((link) => isDocPath(link.note)).map((link) => ({
    ...link, title: titles.get(link.note) || link.note,
    dangling: link.state === 'dangling' || link.noteMissing || link.targetMissing,
    removable: link.source === 'managed' && Boolean(link.id),
  }));
}
