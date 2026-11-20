/** Match the backend's relative, root-relative, then unique-basename wiki resolution order. */
export function resolveWikilink(source, raw, items) {
  // The backend resolves wiki target spelling verbatim, without Unicode normalization.
  const target = raw.split('|')[0].split('#')[0].trim();
  if (!target) return source;
  const ext = target.endsWith('.md') ? target : `${target}.md`;
  const paths = new Set(items.map((item) => item.path));
  const segments = source.split('/').slice(0, -1).concat(ext.split('/'));
  const normalized = [];
  for (const part of segments) {
    if (part === '..') {
      if (normalized.length && normalized.at(-1) !== '..') normalized.pop();
      else normalized.push('..');
    }
    else if (part && part !== '.') normalized.push(part);
  }
  const local = normalized.join('/');
  if (paths.has(local)) return local;
  if (paths.has(ext)) return ext;
  const matches = [...paths].filter((path) => path.split('/').at(-1) === ext);
  return !target.includes('/') && matches.length === 1 ? matches[0] : null;
}

export function conflictKind(error) {
  if (error.code === 'docs-rename-partial') return 'partial';
  if (error.status === 428) return 'precondition';
  if (error.status === 409 && error.code === 'docs-conflict') return 'conflict';
  return 'error';
}

/** The reviewed disk version becomes the precondition, never an unconditional overwrite. */
export function reviewedSave(note, draft, remote) {
  if (!remote || remote.path !== note.path) throw new Error('Review the current note first');
  return { path: note.path, text: draft, expectedSha256: remote.sha256 };
}

export function directoryTree(items) {
  const root = { folders: new Map(), notes: [] };
  for (const item of items) {
    let node = root;
    for (const name of item.path.split('/').slice(0, -1)) {
      if (!node.folders.has(name)) node.folders.set(name, { folders: new Map(), notes: [] });
      node = node.folders.get(name);
    }
    node.notes.push(item);
  }
  return root;
}
