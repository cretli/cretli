/** Tracks the server instance token in localStorage to tell a restart from a brief disconnect. */
import { getSettings } from '../../../core/api/index.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../../lib/storageKeyAlias.js';

const TASK_SERVER_INSTANCE_TOKEN_STORAGE_KEY = 'cretli-server-instance-token';

function readStoredServerInstanceToken() {
  if (typeof localStorage === 'undefined') return '';
  try {
    const token = readStorageValueWithAlias(localStorage, TASK_SERVER_INSTANCE_TOKEN_STORAGE_KEY, '');
    if (!token || typeof token !== 'string') return '';
    return token.trim();
  } catch (_) {
    return '';
  }
}

function writeStoredServerInstanceToken(token) {
  if (typeof localStorage === 'undefined') return;
  if (!token || typeof token !== 'string') return;
  const clean = token.trim();
  if (!clean) return;
  try {
    writeStorageValueWithAlias(localStorage, TASK_SERVER_INSTANCE_TOKEN_STORAGE_KEY, clean);
  } catch (_) {}
}

function extractServerInstanceToken(settingsData) {
  if (!settingsData || typeof settingsData !== 'object') return '';
  if (typeof settingsData.serverInstanceToken !== 'string') return '';
  return settingsData.serverInstanceToken.trim();
}

export function didServerRestart(settingsData) {
  const currentToken = extractServerInstanceToken(settingsData);
  if (!currentToken) return false;
  const previousToken = readStoredServerInstanceToken();
  writeStoredServerInstanceToken(currentToken);
  if (!previousToken) return false;
  return previousToken !== currentToken;
}

export function cacheServerInstanceTokenOnInit() {
  getSettings()
    .then((data) => {
      if (!data?.ok) return;
      const token = extractServerInstanceToken(data);
      if (!token) return;
      writeStoredServerInstanceToken(token);
    })
    .catch(() => {});
}
