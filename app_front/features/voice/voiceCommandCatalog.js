/**
 * Spoken-command catalog for the voice panel help list.
 *
 * Generated from the shared action registry (`lib/voice/action-registry.js`). Example phrases live in i18n
 * (`voice.command.<id>`). The Live model still accepts natural speech — this
 * list is a cheat-sheet, not a grammar.
 */

import { VOICE_ACTIONS } from '../../../lib/voice/action-registry.js';

/** @typedef {{ id: string, group: 'chat' | 'workspace' | 'agent' | 'session' | 'app' }} VoiceCommandEntry */

export const VOICE_COMMAND_GROUPS = /** @type {const} */ ([
  'chat',
  'workspace',
  'agent',
  'app',
  'session',
]);

/** @type {readonly VoiceCommandEntry[]} */
export const VOICE_COMMAND_CATALOG = VOICE_ACTIONS.map((action) => ({
  id: action.id,
  group: action.group,
}));

/**
 * @returns {string[]}
 */
export function listVoiceCommandIds() {
  return VOICE_COMMAND_CATALOG.map((entry) => entry.id);
}

/**
 * @returns {Array<{ id: string, commands: VoiceCommandEntry[] }>}
 */
export function listVoiceCommandGroups() {
  return VOICE_COMMAND_GROUPS.map((group) => ({
    id: group,
    commands: VOICE_COMMAND_CATALOG.filter((entry) => entry.group === group),
  })).filter((group) => group.commands.length > 0);
}
