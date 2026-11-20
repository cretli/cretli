const SKIPPED_REASONS = Object.freeze({
  'docs-not-found': 'missing',
  'docs-unreadable': 'unreadable',
  'docs-symlink-cycle': 'cycle',
  'docs-invalid-path': 'invalidPath',
  'docs-path-escape': 'outsideRoot',
  'docs-too-large': 'tooLarge',
  'docs-invalid-encoding': 'encoding',
  'docs-entry-unavailable': 'unavailable',
});

export function skippedReasonKey(code) {
  return `docs.skipReason.${Object.hasOwn(SKIPPED_REASONS, code) ? SKIPPED_REASONS[code] : 'unavailable'}`;
}

export function linkKindKey(kind) {
  return `docs.kind.${['todo', 'initiative', 'decision'].includes(kind) ? kind : 'unknown'}`;
}

/** Preserve paths containing colons; only the server's operation prefix is interpreted. */
export function completedRenameSteps(steps) {
  return (Array.isArray(steps) ? steps : []).map((step) => {
    const value = String(step);
    const separator = value.indexOf(':');
    const action = separator < 0 ? '' : value.slice(0, separator);
    return {
      key: `docs.renameStep.${['create', 'rewrite', 'remove'].includes(action) ? action : 'unknown'}`,
      path: separator < 0 ? '' : value.slice(separator + 1),
    };
  });
}
