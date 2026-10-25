/**
 * Disk-backed side of the context settings: loads host settings, the chat
 * override and the validated project config, resolves the effective settings
 * and builds the per-turn AGENTS.md block.
 *
 * Kept apart from `context-settings.js` (pure resolver) so the resolver stays
 * trivially testable and the persist layers are imported only here.
 */
import { loadSettings, saveSettings } from '../persist/settings.js';
import { loadChats, updateChat } from '../persist/chats-persist.js';
import { normalizeFolder } from '../git-context.js';
import { loadValidatedProjectContextConfig } from './project-context-config.ts';
import { mergeSettingsPatch, resolveContextSettings } from './context-settings.ts';
import { buildAgentsMdPromptBlock } from './agents-md.ts';
import { resolveInstructionDelivery } from './instruction-epoch.ts';

export function findChatById(chatId: string): Record<string, any> | null {
  const id = String(chatId || '').trim();
  if (!id) return null;
  return ((loadChats() || []) as Record<string, any>[]).find((row) => String(row?.id || '') === id) || null;
}

/**
 * The project root a chat's repo config belongs to: the chat's own folder,
 * never another root of a multi-root workspace.
 */
export function resolveChatProjectRootForSettings(chat: Record<string, any> | null, fallback: string): string {
  return normalizeFolder(chat?.workspaceFolder) || normalizeFolder(chat?.executionFolder) || fallback;
}

export function resolveContextSettingsForScope(input: { projectRoot: string, chatId?: string, chat?: Record<string, any> | null, hostSettings?: Record<string, any> }): ReturnType<typeof resolveContextSettings> {
  const chat = input.chat !== undefined ? input.chat : findChatById(input.chatId || '');
  const loaded = loadValidatedProjectContextConfig(input.projectRoot);
  const projectConfig: { active: boolean, config?: Record<string, any> | null, path?: string, error?: string } = loaded.ok === true
    ? { active: Boolean(loaded.config), config: loaded.config, path: loaded.path }
    : { active: false, error: loaded.error };
  return resolveContextSettings({
    hostSettings: input.hostSettings || loadSettings(),
    projectConfig,
    chat,
  });
}

/**
 * AGENTS.md block for one turn, using the effective settings of this chat.
 * Failures never block a send: they degrade to "no block".
 */
export function buildAgentsMdBlockForTurn(input: { cwd?: string, chatId?: string, transport?: string, projectRoot?: string, contextSettings?: Record<string, any> }): { text: string, entryIds: string[], warnings: string[], delivery: Record<string, any> | null } {
  try {
    const cwd = String(input.cwd || '');
    if (!cwd) return { text: '', entryIds: [], warnings: [], delivery: null };
    const chat = findChatById(input.chatId || '');
    const projectRoot = input.projectRoot || resolveChatProjectRootForSettings(chat, cwd);
    const effective = input.contextSettings
      || resolveContextSettingsForScope({ projectRoot, chat }).effective;
    const mode = String(effective['agentsMd.mode'] || 'auto');
    return buildAgentsMdPromptBlock({ projectRoot, cwd, transport: input.transport, mode });
  } catch {
    return { text: '', entryIds: [], warnings: ['agents_md_error: block skipped'], delivery: null };
  }
}

/**
 * How the static block is delivered this turn. Any failure resolves to the
 * safe fallback (delivery on every turn), never to dedupe.
 */
export function resolveInstructionDeliveryForTurn(input: { room?: unknown, cwd?: string, chatId?: string, transport?: string, projectRoot?: string, contextSettings?: Record<string, any> }): ReturnType<typeof resolveInstructionDelivery> {
  try {
    const chat = findChatById(input.chatId || '');
    const projectRoot = input.projectRoot || resolveChatProjectRootForSettings(chat, String(input.cwd || ''));
    const effective = input.contextSettings
      || resolveContextSettingsForScope({ projectRoot, chat }).effective;
    return resolveInstructionDelivery({
      transport: input.transport,
      dedupeSetting: String(effective['instructions.dedupe'] || 'off'),
      room: input.room,
    });
  } catch {
    return resolveInstructionDelivery({ transport: input.transport, room: input.room });
  }
}

/**
 * Persist a host-global patch (`contextSettings` / `contextProfiles`). The
 * legacy `additionalCursorContextDirs` key and every other key are left as they are.
 */
export function patchHostContextSettings(patch: { settings?: Record<string, any>, profiles?: Record<string, any> }): { ok: true } | { ok: false, errors: { key: string, code: string }[] } {
  const stored = loadSettings() as Record<string, any>;
  const next: Record<string, any> = { ...stored };
  if (patch.settings) {
    const merged = mergeSettingsPatch(stored.contextSettings, patch.settings);
    if (!merged.ok) return merged;
    next.contextSettings = merged.block;
  }
  if (patch.profiles && typeof patch.profiles === 'object') {
    const profiles: Record<string, any> = { ...(stored.contextProfiles || {}) };
    for (const [name, body] of Object.entries(patch.profiles)) {
      if (body === null) {
        delete profiles[name];
        continue;
      }
      const merged = mergeSettingsPatch(undefined, body as Record<string, any>);
      if (!merged.ok) return merged;
      profiles[name] = merged.block;
    }
    if (Object.keys(profiles).length > 0) next.contextProfiles = profiles;
    else delete next.contextProfiles;
  }
  saveSettings(next);
  return { ok: true };
}

/**
 * Persist a per-chat override on the chat record.
 */
export function patchChatContextSettings(chatId: string, patch: Record<string, any>): { ok: true } | { ok: false, errors: { key: string, code: string }[] } {
  const chat = findChatById(chatId);
  const merged = mergeSettingsPatch(chat?.contextSettings, patch);
  if (!merged.ok) return merged;
  updateChat(chatId, { contextSettings: merged.block });
  return { ok: true };
}
