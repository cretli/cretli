/**
 * MCP spec tool annotations (`Tool.annotations`, 2025-03-26 revision) for the
 * Cretli custom tools handed to `@cursor/sdk`.
 *
 * The SDK advertises these verbatim and nothing in the harness enforces them,
 * so they are descriptive metadata only: a wrong hint makes the model more
 * careless, it does not grant or remove a capability. Classifications here are
 * deliberately conservative — an unannotated tool is treated by consumers as
 * the most dangerous case, so a tool that might destroy state is annotated
 * destructive even when the common call is harmless.
 */

const ANNOTATION_BOOLEAN_KEYS = Object.freeze([
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
]);

/**
 * Drop non-boolean hints and empty titles so a misspelled key can never be
 * advertised as a false "unannotated -> trusted" signal.
 *
 * @param {Record<string, unknown> | null | undefined} annotations
 * @returns {Record<string, unknown> | undefined}
 */
export function normalizeSdkToolAnnotations(annotations) {
  if (!annotations || typeof annotations !== 'object') return undefined;
  /** @type {Record<string, unknown>} */
  const normalized = {};
  const title = typeof annotations.title === 'string' ? annotations.title.trim() : '';
  if (title) normalized.title = title.slice(0, 120);
  for (const key of ANNOTATION_BOOLEAN_KEYS) {
    if (typeof annotations[key] === 'boolean') normalized[key] = annotations[key];
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * @param {{ title?: string, readOnly?: boolean, destructive?: boolean, idempotent?: boolean, openWorld?: boolean }} hints
 * @returns {Record<string, unknown> | undefined}
 */
function hint(hints) {
  return normalizeSdkToolAnnotations({
    title: hints.title,
    readOnlyHint: hints.readOnly,
    destructiveHint: hints.destructive,
    idempotentHint: hints.idempotent,
    openWorldHint: hints.openWorld,
  });
}

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false };

/**
 * Page-bridge tools keyed by their permission bucket. The bucket is the honest
 * source of the classification: `context`/`dom`/`console`/`network`/`storage`
 * are snapshots, `interact` mutates a live page, `navigate` throws away the
 * current document and fetches another origin.
 */
const PAGE_ANNOTATIONS_BY_PERMISSION = Object.freeze({
  context: READ,
  dom: READ,
  console: READ,
  network: READ,
  storage: READ,
  screenshot: READ,
  navigate: { readOnly: false, destructive: true, idempotent: false, openWorld: true },
  interact: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
});

/**
 * Interactive page tools whose effect leaves the page: the clipboard is host
 * state and a screenshot is a rendered capture of it.
 */
const PAGE_OPEN_WORLD_TOOLS = new Set(['page_copy_text']);

/**
 * @param {string} toolName
 * @param {string} permission
 * @param {string} description
 * @returns {Record<string, unknown> | undefined}
 */
export function pageToolAnnotations(toolName, permission, description = '') {
  const base = PAGE_ANNOTATIONS_BY_PERMISSION[permission];
  if (!base) return undefined;
  const openWorld = base.openWorld === true || PAGE_OPEN_WORLD_TOOLS.has(toolName);
  return hint({
    title: description || toolName,
    readOnly: base.readOnly,
    destructive: base.destructive,
    idempotent: base.idempotent,
    openWorld,
  });
}

/**
 * Host-page chat binding tools. `chat_pin_url` rewrites a chat record and may
 * navigate the host, so it is neither read-only nor open-world-free, but
 * pinning the same URL twice settles on the same value.
 *
 * @param {string} toolName
 * @param {string} description
 * @returns {Record<string, unknown> | undefined}
 */
export function chatHostToolAnnotations(toolName, description = '') {
  if (toolName === 'chat_pin_url') {
    return hint({
      title: description || 'Pin the chat to a host page URL',
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: true,
    });
  }
  return undefined;
}

/**
 * Built-in Browser (`browser_*`) tools. The read/mutation split already drives
 * mode gating, so the annotation is derived from the same lists and can never
 * drift from what a plan or review chat is actually allowed to call.
 *
 * @param {string} toolName
 * @param {ReadonlyArray<string>} readTools
 * @param {ReadonlyArray<string>} mutationTools
 * @param {string} description
 * @returns {Record<string, unknown> | undefined}
 */
export function browserToolAnnotations(toolName, readTools = [], mutationTools = [], description = '') {
  const title = description || toolName;
  if (readTools.includes(toolName)) {
    return hint({ title, ...READ });
  }
  if (!mutationTools.includes(toolName)) return undefined;
  if (toolName === 'browser_close') {
    return hint({
      title,
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: false,
    });
  }
  const openWorld = toolName === 'browser_open' || toolName === 'browser_navigate';
  return hint({ title, readOnly: false, destructive: false, idempotent: false, openWorld });
}

/**
 * True when the SDK would advertise the tool as unannotated.
 *
 * @param {Record<string, unknown> | null | undefined} annotations
 * @returns {boolean}
 */
export function hasSdkToolAnnotations(annotations) {
  return normalizeSdkToolAnnotations(annotations) !== undefined;
}
