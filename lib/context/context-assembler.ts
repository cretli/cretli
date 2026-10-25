/**
 * Registry-based prompt assembler: `assemble(context, adapter)`.
 *
 * Builds the static blocks (skills catalog, workspace rules, shared rules) from
 * the shared registry and the dynamic blocks (selected skills, page context,
 * mode hint, plan, reports, title hint) with the same helpers the send path
 * uses. It returns the payload, a manifest and warnings.
 *
 * Status: comparison only. The real send path still uses the legacy
 * `apply*OutboundPrompt` functions; this result is never sent by default (see
 * `context-compare.js`). Invalid registry entries are skipped with a warning.
 *
 * Two adapters model today's two send paths and are intentionally NOT equal:
 * the SDK path adds neither workspace rules (its setting source loads them)
 * nor a textual mode hint; the non-SDK path adds both.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { buildContextManifest } from './registry-contract.ts';
import type { RegistryEntry } from './registry.ts';
import {
  buildContextRegistry,
  isListableEntry,
  nameResolutionRank,
  toPublicRegistryEntry,
} from './registry.ts';
import { buildSkillsCatalogText } from '../skills/skill-context.js';
import {
  normalizeSkillSelection,
  renderSelectedSkillsBlock,
  resolveSkillSelectionMode,
  selectSkills,
  summarizeSkillSelection,
} from '../skills/skill-selection.js';
import {
  getConfiguredAdditionalCursorContextDirs,
  matchCursorRuleScope,
  renderSharedRulesBlock,
  renderWorkspaceRulesBlock,
} from '../sdk/shared-cursor-context.ts';
import { ensureCursorShare } from '../sdk/cursor-share.ts';
import { buildAgentsMdBlockForTurn } from './context-settings-runtime.ts';
import { buildContextBudget } from './context-budget.ts';
import { resolveChatContextProfile } from './delegation-context-profile.ts';
import {
  PROMPT_DECORATION_BLOCK,
  PROMPT_DECORATION_VOLATILE_ORDER,
} from '../sdk/prompt-decoration.ts';
import {
  buildSdkVolatileDecorationBlocks,
  buildVolatileDecorationBlocks,
  composeStatelessDecoratedPrompt,
} from '../sdk/harness-plan-prompt.ts';

export interface ContextAdapter {
  id: 'sdk' | 'harness';
  /** Static workspace rules are in the prompt. */
  workspaceRules: boolean;
  /** Static shared rules are in the prompt. */
  sharedRules: boolean;
  /** The mode hint is a prompt block. */
  textualModeHint: boolean;
  /** The automatic page context is a prompt block. */
  pageContext: boolean;
}

export interface AssembleContext {
  cwd?: string;
  projectRoot?: string;
  prompt?: string;
  mode?: string;
  chatId?: string;
  transport?: string;
  skipPlanHint?: boolean;
  selection?: unknown;
  selectionMode?: 'explicit' | 'legacy';
  taskKind?: string;
  fileTypes?: string[];
  pageContext?: string;
  reportContext?: string;
  additionalDirs?: string[];
  contextSettings?: Record<string, any>;
  softBudgetTokens?: number;
  homeDir?: string;
  bundledRoot?: string;
  audience?: 'host' | 'widget';
  profile?: { id?: string, skillsCatalog?: boolean } | null;
  now?: () => Date;
}

export const CONTEXT_ADAPTERS: Readonly<Record<'sdk' | 'harness', ContextAdapter>> = Object.freeze({
  sdk: Object.freeze({
    id: 'sdk',
    workspaceRules: false,
    sharedRules: true,
    textualModeHint: false,
    pageContext: true,
  }),
  harness: Object.freeze({
    id: 'harness',
    workspaceRules: true,
    sharedRules: true,
    textualModeHint: true,
    pageContext: false,
  }),
});

function sha256(text: string): string {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * One skill per call name, picked by the name-resolution order (project →
 * shared → user → bundled). A name that collides inside the winning source is
 * ambiguous: no entry is chosen and the caller gets a warning.
 *
 * @param skills Listable skill entries.
 */
function resolveSkillsByName(skills: RegistryEntry[]): { chosen: RegistryEntry[], skipped: { entry: RegistryEntry, reason: string }[] } {
  const byName = new Map<string, RegistryEntry[]>();
  for (const entry of skills) {
    const key = entry.callName.toLowerCase();
    byName.set(key, [...(byName.get(key) || []), entry]);
  }
  const chosen: RegistryEntry[] = [];
  const skipped: { entry: RegistryEntry, reason: string }[] = [];
  for (const group of byName.values()) {
    const bestRank = Math.min(...group.map((entry) => nameResolutionRank(entry.scope)));
    const tier = group.filter((entry) => nameResolutionRank(entry.scope) === bestRank);
    const winner = tier[0];
    if (tier.filter((entry) => entry.source === winner.source).length > 1) {
      for (const entry of tier) skipped.push({ entry, reason: 'ambiguous_name' });
      continue;
    }
    if (!winner.valid) {
      skipped.push({ entry: winner, reason: 'invalid_entry' });
      continue;
    }
    chosen.push(winner);
    for (const entry of group) {
      if (entry !== winner) skipped.push({ entry, reason: 'shadowed_by_higher_precedence' });
    }
  }
  chosen.sort((a, b) => a.callName.localeCompare(b.callName));
  return { chosen, skipped };
}

/**
 * Assemble one turn from the registry.
 */
export function assemble(context: AssembleContext, adapter: ContextAdapter): {
  payload: string,
  blocks: { id: string, kind: 'static' | 'dynamic', text: string, hash: string, entryIds: string[] }[],
  manifest: Record<string, any>,
  warnings: string[],
  registry: ReturnType<typeof buildContextRegistry>,
  budget: ReturnType<typeof buildContextBudget>,
  catalogIncluded: boolean,
  profileId: string,
  legacyShape: { staticBlock: string, legacyStaticBlock: string, skillsBlock: string, volatile: Record<string, string> },
} {
  const cwd = context.cwd || process.cwd();
  const prompt = String(context.prompt || '');
  const audience = context.audience === 'widget' ? 'widget' : 'host';
  const additionalDirs = audience === 'widget'
    ? []
    : Array.isArray(context.additionalDirs)
    ? context.additionalDirs
    : getConfiguredAdditionalCursorContextDirs();
  const registry = buildContextRegistry(cwd, {
    projectRoot: context.projectRoot,
    audience,
    additionalDirs,
    bundledRoot: context.bundledRoot || ensureCursorShare(),
    homeDir: context.homeDir || os.homedir(),
  });
  const warnings: string[] = [];
  const used: { entry: RegistryEntry, role: string }[] = [];

  for (const entry of registry.entries) {
    if (entry.valid) continue;
    const codes = entry.diagnostics.filter((item) => item.severity === 'error').map((item) => item.code).join(',');
    warnings.push(`invalid_entry: ${entry.id} (${codes}) skipped`);
  }

  // Skills catalog + selected skills.
  const skills = registry.entries.filter((entry) => entry.kind === 'skill' && isListableEntry(entry));
  const { chosen, skipped } = resolveSkillsByName(skills);
  for (const item of skipped) {
    if (item.reason === 'ambiguous_name') warnings.push(`ambiguous_name: ${item.entry.id} not in catalog; select by ID`);
  }
  // A delegation profile may drop the inherited global catalog; explicitly
  // selected skills below are unaffected.
  const profile = context.profile !== undefined ? context.profile : resolveChatContextProfile(context.chatId);
  const catalogIncluded = profile?.skillsCatalog !== false;
  const catalog = !catalogIncluded ? '' : buildSkillsCatalogText(chosen.map((entry) => ({
    name: entry.callName,
    description: entry.description,
    path: registry.getAbsPath(entry.id),
  })));
  if (catalogIncluded) for (const entry of chosen) used.push({ entry, role: 'catalog' });
  // Explicit activation only (IDs / unquoted @name); same rules as the send path.
  const selectionInput = normalizeSkillSelection(context.selection);
  const ambiguousNames = new Set(
    skipped.filter((item) => item.reason === 'ambiguous_name').map((item) => item.entry.callName.toLowerCase()),
  );
  const toCandidate = (entry: RegistryEntry) => ({ id: entry.id, name: entry.callName, readContent: () => registry.getContent(entry.id) });
  const selectionResult = selectSkills({
    prompt,
    selection: selectionInput,
    mode: context.selectionMode || resolveSkillSelectionMode(),
    nameCandidates: chosen.map(toCandidate),
    ambiguousNames,
    resolveId: (id) => {
      const entry = registry.entries.find((item) => item.id === id);
      if (!entry || !isListableEntry(entry)) return { error: 'unknown_id' };
      if (entry.kind !== 'skill') return { kind: entry.kind };
      if (!entry.valid) return { error: 'invalid_entry' };
      return { candidate: toCandidate(entry) };
    },
  });
  const selectedIds: string[] = [];
  for (const item of selectionResult.selected) {
    const entry = registry.entries.find((candidate) => candidate.id === item.id);
    if (!entry) continue;
    selectedIds.push(entry.id);
    used.push({ entry, role: 'selected' });
  }
  for (const item of selectionResult.diagnostics) warnings.push(`${item.code}: ${item.id || item.name || ''}`.trim());
  const selected = renderSelectedSkillsBlock(selectionResult.selected);

  // Rules: alwaysApply only, valid only, scope-matched; workspace and shared.
  const ruleChunks = (scope: string, matchContext: Record<string, any>) => {
    const chunks: string[] = [];
    const ids: string[] = [];
    for (const entry of registry.entries) {
      if (entry.kind !== 'rule' || entry.scope !== scope || !entry.valid) continue;
      const meta = registry.getRuleMeta(entry.id);
      const body = registry.getBody(entry.id);
      if (!meta?.alwaysApply || !body) continue;
      if (!matchCursorRuleScope(meta.scope, matchContext).included) continue;
      chunks.push(`### ${entry.relPath}\n${body}`);
      ids.push(entry.id);
      used.push({ entry, role: 'rule' });
    }
    return { chunks, ids };
  };
  const workspaceRoot = path.resolve(cwd);
  const workspace = adapter.workspaceRules
    ? ruleChunks('project', { cwd: workspaceRoot })
    : { chunks: [], ids: [] };
  const shared = adapter.sharedRules
    ? ruleChunks('shared', { cwd, taskKind: context.taskKind, fileTypes: context.fileTypes })
    : { chunks: [], ids: [] };
  const ruleParts = [renderWorkspaceRulesBlock(workspace.chunks), renderSharedRulesBlock(shared.chunks)]
    .filter(Boolean);

  // AGENTS.md: pasted only when the matrix says Cretli is the channel (or the owner forces it).
  const agentsMd = buildAgentsMdBlockForTurn({
    cwd,
    chatId: context.chatId,
    transport: context.transport || (adapter.id === 'sdk' ? 'sdk' : undefined),
    projectRoot: context.projectRoot,
    contextSettings: context.contextSettings,
  });
  warnings.push(...agentsMd.warnings);
  const agentsPart = agentsMd.text ? [agentsMd.text] : [];

  const staticBlock = [catalog, ...agentsPart, ...ruleParts].filter(Boolean).join('\n\n');
  const legacyStaticBlock = [[catalog, selected].filter(Boolean).join('\n'), ...agentsPart, ...ruleParts]
    .filter(Boolean)
    .join('\n\n');

  // Dynamic blocks share the send path's own builders.
  const volatileInput = {
    cwd,
    chatId: context.chatId,
    mode: context.mode,
    transport: context.transport,
    skipPlanHint: context.skipPlanHint === true,
    pageContext: context.pageContext,
    ...(Object.prototype.hasOwnProperty.call(context, 'reportContext') ? { reportContext: context.reportContext } : {}),
  };
  const volatile = adapter.id === 'sdk'
    ? buildSdkVolatileDecorationBlocks(volatileInput, selected)
    : buildVolatileDecorationBlocks(volatileInput, selected);

  const blocks = [
    { id: 'skills_catalog', kind: 'static' as const, text: catalog, entryIds: catalogIncluded ? chosen.map((e) => e.id) : [] },
    { id: 'agents_md', kind: 'static' as const, text: agentsMd.text, entryIds: agentsMd.entryIds },
    { id: 'workspace_rules', kind: 'static' as const, text: renderWorkspaceRulesBlock(workspace.chunks), entryIds: workspace.ids },
    { id: 'shared_rules', kind: 'static' as const, text: renderSharedRulesBlock(shared.chunks), entryIds: shared.ids },
    ...PROMPT_DECORATION_VOLATILE_ORDER.map((key) => ({
      id: key,
      kind: 'dynamic' as const,
      text: volatile[key] || '',
      entryIds: key === PROMPT_DECORATION_BLOCK.SKILLS ? selectedIds : [],
    })),
  ].map((block) => ({ ...block, hash: sha256(block.text) }));

  const payload = composeStatelessDecoratedPrompt({ legacyStaticBlock }, volatile, prompt);

  const seen = new Set();
  const manifestEntries = [];
  for (const { entry, role } of used) {
    const key = `${entry.id}|${role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    manifestEntries.push({ ...toPublicRegistryEntry(entry), role });
  }
  const manifest: Record<string, any> = {
    ...buildContextManifest({
      registryEpoch: registry.epoch,
      assembledAt: (context.now ? context.now() : new Date()).toISOString(),
      projectRoot: registry.projectRoot,
      contentRevision: registry.contentRevision,
      entries: manifestEntries,
      warnings,
    }),
    adapter: adapter.id,
    blocks: blocks.map(({ id, kind, hash, text, entryIds }) => ({
      id,
      kind,
      hash,
      length: text.length,
      entryIds,
    })),
    payloadHash: sha256(payload),
    selection: summarizeSkillSelection(selectionResult, selectionInput),
  };

  // Soft budget of what Cretli adds (estimated tokens, not usage/cache/cost).
  // Informational only: it never changes the payload or blocks a send.
  const budget = buildContextBudget({
    blocks,
    message: prompt,
    mode: context.contextSettings?.['budget.mode'],
    softLimitTokens: context.softBudgetTokens,
  });
  manifest.budget = { status: budget.status, estimatedTokens: budget.totals.estimatedTokens, softLimitTokens: budget.softLimitTokens };

  return {
    payload,
    blocks,
    manifest,
    warnings,
    budget,
    registry,
    catalogIncluded,
    profileId: String(profile?.id || ''),
    legacyShape: { staticBlock, legacyStaticBlock, skillsBlock: selected, volatile },
  };
}
