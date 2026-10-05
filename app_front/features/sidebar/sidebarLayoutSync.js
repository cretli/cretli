/**
 * Server-backed sidebar layout. Local storage stays as a first-paint cache.
 * A remote frame never publishes back to the server.
 */

import { getSidebarLayout, patchSidebarLayout } from '../../api.js';
import {
  readStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';

export const SIDEBAR_LAYOUT_KEYS = Object.freeze([
  'chatOrder',
  'workspaceOrder',
  'favoriteChatIds',
  'collapsedWorkspaces',
  'subchatExpanded',
  'archiveOpen',
]);

const MIGRATED_KEY = 'cretli-sidebar-layout-migrated';
const PUBLISH_DELAY_MS = 80;

/** @type {Record<string, string[]> | null} */
let pending = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null;
let suppressPublish = false;
let localUpdatedAt = '';
let flushAttempts = 0;
/** @type {((layout: object) => void) | null} */
let applyHandler = null;
/** @type {(() => object) | null} */
let readLocalHandler = null;
/** @type {(body: object) => Promise<object | null | undefined>} */
let patchLayoutImpl = (body) => patchSidebarLayout(body);
/** @type {() => Promise<object | null | undefined>} */
let getLayoutImpl = () => getSidebarLayout();
let setTimeoutFn = (fn, ms) => setTimeout(fn, ms);
let clearTimeoutFn = (id) => clearTimeout(id);

/**
 * @param {object | null | undefined} source
 * @returns {Record<string, string[]>}
 */
export function pickSidebarLayoutFields(source) {
  /** @type {Record<string, string[]>} */
  const next = {};
  SIDEBAR_LAYOUT_KEYS.forEach((key) => {
    if (!Array.isArray(source?.[key])) return;
    next[key] = source[key].map((item) => String(item || '').trim()).filter(Boolean);
  });
  return next;
}

/**
 * Fields to upload once when the server has never stored them and this
 * browser still has a local copy.
 *
 * @param {object | null | undefined} server
 * @param {object | null | undefined} local
 * @param {boolean} alreadySynced
 * @returns {Record<string, string[]> | null}
 */
export function buildSidebarLayoutUpload(server, local, alreadySynced) {
  if (alreadySynced) return null;
  /** @type {Record<string, string[]>} */
  const upload = {};
  SIDEBAR_LAYOUT_KEYS.forEach((key) => {
    const serverList = Array.isArray(server?.[key]) ? server[key] : [];
    const localList = Array.isArray(local?.[key]) ? local[key] : [];
    if (serverList.length === 0 && localList.length > 0) upload[key] = localList;
  });
  return Object.keys(upload).length > 0 ? upload : null;
}

/**
 * @param {{
 *   apply?: (layout: object) => void,
 *   readLocal?: () => object,
 *   patchLayout?: (body: object) => Promise<object | null | undefined>,
 *   getLayout?: () => Promise<object | null | undefined>,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} [deps]
 * @returns {void}
 */
export function configureSidebarLayoutSync(deps = {}) {
  applyHandler = typeof deps.apply === 'function' ? deps.apply : null;
  readLocalHandler = typeof deps.readLocal === 'function' ? deps.readLocal : null;
  if (typeof deps.patchLayout === 'function') patchLayoutImpl = deps.patchLayout;
  if (typeof deps.getLayout === 'function') getLayoutImpl = deps.getLayout;
  if (typeof deps.setTimeoutFn === 'function') setTimeoutFn = deps.setTimeoutFn;
  if (typeof deps.clearTimeoutFn === 'function') clearTimeoutFn = deps.clearTimeoutFn;
}

/**
 * @returns {void}
 */
export function __resetSidebarLayoutSyncForTest() {
  pending = null;
  if (timer != null) clearTimeoutFn(timer);
  timer = null;
  suppressPublish = false;
  localUpdatedAt = '';
  flushAttempts = 0;
  applyHandler = null;
  readLocalHandler = null;
  patchLayoutImpl = (body) => patchSidebarLayout(body);
  getLayoutImpl = () => getSidebarLayout();
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms);
  clearTimeoutFn = (id) => clearTimeout(id);
}

/**
 * @param {object} layout
 * @returns {void}
 */
function applyLayout(layout) {
  if (typeof applyHandler !== 'function') return;
  suppressPublish = true;
  try {
    applyHandler(layout);
  } finally {
    suppressPublish = false;
  }
}

/**
 * @param {object} partial
 * @returns {boolean} false when a remote apply is in progress
 */
export function publishSidebarLayout(partial) {
  if (suppressPublish) return false;
  const fields = pickSidebarLayoutFields(partial);
  if (!Object.keys(fields).length) return false;
  pending = { ...(pending || {}), ...fields };
  if (timer != null) clearTimeoutFn(timer);
  timer = setTimeoutFn(() => {
    timer = null;
    void flushSidebarLayoutSync();
  }, PUBLISH_DELAY_MS);
  return true;
}

/**
 * @returns {Promise<void>}
 */
export async function flushSidebarLayoutSync() {
  if (timer != null) {
    clearTimeoutFn(timer);
    timer = null;
  }
  const body = pending;
  pending = null;
  if (!body) return;
  try {
    const saved = await patchLayoutImpl(body);
    if (!saved?.ok) throw new Error('save failed');
    flushAttempts = 0;
    if (typeof saved.updatedAt === 'string') localUpdatedAt = saved.updatedAt;
  } catch (_) {
    flushAttempts += 1;
    pending = { ...body, ...(pending || {}) };
    if (flushAttempts > 3 || timer != null) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void flushSidebarLayoutSync();
    }, PUBLISH_DELAY_MS * flushAttempts);
  }
}

/**
 * @param {object | null | undefined} message
 * @returns {void}
 */
export function applyRemoteSidebarLayout(message) {
  if (!message || message.type !== 'sidebarLayout') return;
  const remoteUpdatedAt = typeof message.updatedAt === 'string' ? message.updatedAt : '';
  if (remoteUpdatedAt && localUpdatedAt && remoteUpdatedAt < localUpdatedAt) return;
  const fields = pickSidebarLayoutFields(message);
  SIDEBAR_LAYOUT_KEYS.forEach((key) => {
    if (pending && Object.prototype.hasOwnProperty.call(pending, key)) delete fields[key];
  });
  if (remoteUpdatedAt) localUpdatedAt = remoteUpdatedAt;
  if (!Object.keys(fields).length) return;
  applyLayout(fields);
}

function readMigratedFlag() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, MIGRATED_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

function writeMigratedFlag() {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, MIGRATED_KEY, '1');
  } catch (_) {}
}

/**
 * Load the server layout. The first successful load on a browser uploads
 * local lists only for fields the server still has empty.
 *
 * @returns {Promise<void>}
 */
export async function hydrateSidebarLayout() {
  let data;
  try {
    data = await getLayoutImpl();
  } catch (_) {
    return;
  }
  if (!data?.ok) return;
  const alreadySynced = readMigratedFlag();
  const local = typeof readLocalHandler === 'function' ? readLocalHandler() : {};
  const upload = buildSidebarLayoutUpload(data, local, alreadySynced);
  let next = data;
  if (upload) {
    try {
      const saved = await patchLayoutImpl(upload);
      if (!saved?.ok) return;
      next = saved;
    } catch (_) {
      return;
    }
  }
  writeMigratedFlag();
  if (typeof next.updatedAt === 'string') localUpdatedAt = next.updatedAt;
  applyLayout(pickSidebarLayoutFields(next));
}
