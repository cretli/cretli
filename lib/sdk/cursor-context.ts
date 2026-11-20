/**
 * Collects Cursor rules, commands, skills and agents (project + user + shared roots).
 *
 * The lists are projections of the shared context registry
 * (`lib/context/registry.ts`): the same scan feeds this legacy-shaped payload
 * and the registry-based prompt assembler. List shapes stay compatible; each
 * item additionally carries its stable `id`, `valid` flag and diagnostics.
 */

import os from 'os';
import path from 'path';
import { ensureCursorShare } from './cursor-share.ts';
import {
  getConfiguredAdditionalCursorContextDirs,
  mergeNamedContextEntries,
} from './shared-cursor-context.ts';
import {
  buildContextRegistry,
  isListableEntry,
  toPublicRegistryEntry,
} from '../context/registry.ts';
import type { RegistryEntry } from '../context/registry.ts';

type ContextItem = Record<string, any>;
type ContextRegistry = ReturnType<typeof buildContextRegistry>;

function withRegistryFields(entry: RegistryEntry, base: ContextItem): ContextItem {
  const item: ContextItem = { ...base, id: entry.id, valid: entry.valid };
  if (entry.diagnostics.length > 0) item.diagnostics = entry.diagnostics.map((d) => ({ ...d }));
  return item;
}

/**
 * Legacy list item for one registry entry.
 */
function toLegacyItem(registry: ContextRegistry, entry: RegistryEntry): ContextItem {
  const root = registry.sourceRoots.get(entry.source) || '';
  if (entry.scope === 'project') {
    return withRegistryFields(entry, { name: entry.listName, path: entry.relPath, source: 'project' });
  }
  if (entry.scope === 'user') {
    const base = entry.kind === 'skill'
      ? { name: entry.listName }
      : { name: entry.listName, path: `~/${entry.relPath}` };
    return withRegistryFields(entry, base);
  }
  return withRegistryFields(entry, {
    name: entry.listName,
    path: path.join(root, entry.relPath).replace(/\\/g, '/'),
    source: entry.source,
  });
}

/**
 * Entries of one source and kind in legacy list form. Skills keep the legacy
 * "first folder name wins" projection; the registry still holds (and flags)
 * the duplicates.
 */
function projectList(
  registry: ContextRegistry,
  source: string,
  kind: 'rule' | 'skill' | 'command' | 'agent',
): ContextItem[] {
  const seen = new Set<string>();
  const out: ContextItem[] = [];
  for (const entry of registry.entries) {
    if (entry.source !== source || entry.kind !== kind || !isListableEntry(entry)) continue;
    if (kind === 'skill') {
      if (seen.has(entry.listName)) continue;
      seen.add(entry.listName);
    }
    out.push(toLegacyItem(registry, entry));
  }
  return out;
}

export function getCursorContext(
  workspaceDir: string,
  options: {
    additionalDirs?: string[];
    projectRoot?: string;
    audience?: 'host' | 'widget';
    homeDir?: string;
    bundledRoot?: string;
  } = {},
) {
  const audience = options.audience === 'widget' ? 'widget' : 'host';
  const workspaceResolved = workspaceDir ? path.resolve(workspaceDir) : '';
  const additionalDirs = audience === 'widget'
    ? []
    : Array.isArray(options.additionalDirs)
      ? options.additionalDirs
      : getConfiguredAdditionalCursorContextDirs().filter((dir) => dir !== workspaceResolved);

  const registry = buildContextRegistry(workspaceDir, {
    projectRoot: options.projectRoot,
    audience,
    additionalDirs,
    bundledRoot: options.bundledRoot || ensureCursorShare(),
    homeDir: options.homeDir || os.homedir(),
  });

  let sharedRules: ContextItem[] = [];
  let sharedCommands: ContextItem[] = [];
  // Bundled contributes skills and agents only (its tree never holds rules).
  let sharedSkills = projectList(registry, 'bundled', 'skill');
  let sharedAgents = projectList(registry, 'bundled', 'agent');
  for (const source of registry.entries.filter((e) => e.scope === 'shared').map((e) => e.source)
    .filter((label, index, all) => all.indexOf(label) === index)) {
    sharedRules = mergeNamedContextEntries(sharedRules, projectList(registry, source, 'rule'));
    sharedCommands = mergeNamedContextEntries(sharedCommands, projectList(registry, source, 'command'));
    sharedSkills = mergeNamedContextEntries(sharedSkills, projectList(registry, source, 'skill'));
    sharedAgents = mergeNamedContextEntries(sharedAgents, projectList(registry, source, 'agent'));
  }

  const includeHostUserSources = audience === 'host';
  return {
    projectRules: projectList(registry, 'project', 'rule'),
    projectCommands: projectList(registry, 'project', 'command'),
    projectSkills: projectList(registry, 'project', 'skill'),
    projectAgents: projectList(registry, 'project', 'agent'),
    sharedRules,
    sharedCommands,
    sharedSkills,
    sharedAgents,
    additionalCursorContextDirs: includeHostUserSources ? additionalDirs : [],
    userSkills: includeHostUserSources ? projectList(registry, 'user', 'skill') : [],
    userAgents: includeHostUserSources ? projectList(registry, 'user', 'agent') : [],
    registry: {
      epoch: registry.epoch,
      contentRevision: registry.contentRevision,
      entries: registry.entries.map(toPublicRegistryEntry),
      diagnostics: registry.diagnostics,
    },
    cursorRemoteTodosApi: {
      list: 'GET /api/todos',
      create: 'POST /api/todos',
      update: 'PATCH /api/todos/:id',
      remove: 'DELETE /api/todos/:id',
      startAgent: 'POST /api/todos/:id/start-agent',
      setFromAgent: 'POST /api/set-todo-from-agent',
    },
  };
}
