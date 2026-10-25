/**
 * Mutable state of the Files panel: loaded directories, expanded folders and
 * the current preview. Views read it; components mutate it and re-render.
 */
export const filesState = {
  /** Loaded directories: path ('' = root) -> { status, entries, error }. */
  dirs: new Map(),
  /** Expanded folder paths. */
  expanded: new Set(),
  /** Bumped on every root rebuild so late responses of an old tree are dropped. */
  generation: 0,
  previewPath: '',
  previewContent: '',
  /** null = not loaded yet; string = diff text. */
  diffContent: null,
  diffLoading: false,
  /** View-memory slice waiting for the tree to appear. */
  pendingViewMemory: null,
};
