/**
 * Context manifest of a delegation child and of its parent, in one comparable
 * shape.
 *
 * Separate fields (never one merged blob):
 * - `instructions`: rules, AGENTS.md and skills (profile, selected IDs, entries)
 * - `task`: the task / plan text the child receives
 * - `handoff`: a harness-switch transcript, when there is one
 * - `reports`: delegation reports placed in the prompt
 * - `omitted`: sources that are NOT delivered, each with a reason
 * - `limits`: the legacy per-input character limits, so truncation is visible
 *
 * The record is content-free: ids, hashes, sizes and reason codes only. It
 * never activates anything: skills come only from explicit IDs
 * (`parseMentions: false`), and report/handoff/task text is never scanned for
 * mentions. Building it is a pure read.
 */
import crypto from 'node:crypto';
import { buildContextSnapshot } from './context-send-manifest.ts';
import { CONTEXT_LEGACY_LIMITS } from './context-budget.ts';
import { resolveDelegationContextProfile } from './delegation-context-profile.ts';
import { normalizeWorkspaceKey } from './delegation-context-workspace.ts';
import { selectionFromSkillIds } from '../skills/skill-selection.js';

export const DELEGATION_CONTEXT_MANIFEST_SCHEMA = 1;

function sha256(text: string): string {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * Size and hash of one bounded text field. `truncated` is true when the text is
 * over the legacy limit or already carries a truncation marker.
 */
export function describeBoundedField(text: unknown, limit: { limit: number, unit?: string }): { present: boolean, hash: string, length: number, limit: number, overLimit: boolean, truncated: boolean } {
  const value = String(text ?? '');
  const marked = /\[truncated: (?:first|last) \d+ of \d+/.test(value);
  return {
    present: value.length > 0,
    hash: value ? sha256(value) : '',
    length: value.length,
    limit: limit.limit,
    overLimit: value.length > limit.limit,
    truncated: value.length > limit.limit || marked,
  };
}

function projectInstructions(snapshot: Record<string, any>): Record<string, any> {
  const delivered = snapshot.entries
    .filter((row: Record<string, any>) => row.state === 'delivered')
    .map((row: Record<string, any>) => ({
      id: row.id, kind: row.kind, scope: row.scope, relPath: row.relPath, reason: row.reason, contentHash: row.contentHash,
    }));
  const skipped = snapshot.entries
    .filter((row: Record<string, any>) => row.state === 'disabled' || row.state === 'error')
    .map((row: Record<string, any>) => ({ id: row.id, kind: row.kind, state: row.state, reason: row.reason }));
  return {
    profile: snapshot.profile || null,
    revision: snapshot.revision,
    adapter: snapshot.adapter,
    selection: snapshot.selection || null,
    delivered,
    skipped,
    counts: snapshot.counts,
    warnings: snapshot.warnings,
  };
}

function composeManifest(input: {
  subject: 'chat' | 'delegation',
  subjectId: string,
  workspaceFolder: string,
  snapshot: Record<string, any>,
  profile: Record<string, any> | null,
  taskText?: string,
  taskKind?: string,
  handoffText?: string,
  reports?: { id: string, text: string }[],
  omitted?: { source: string, reason: string }[],
  links?: Record<string, string>,
  now?: () => Date,
}): Record<string, any> {
  const reports = (input.reports || []).map((item) => ({
    id: item.id,
    ...describeBoundedField(item.text, CONTEXT_LEGACY_LIMITS.delegationReport),
  }));
  const omitted = [...(input.omitted || [])];
  if (input.profile && input.profile.skillsCatalog === false) {
    omitted.push({ source: 'skills_catalog', reason: `profile_${input.profile.id}_no_global_catalog` });
  }
  for (const row of input.snapshot.entries as Record<string, any>[]) {
    if (row.state === 'error') omitted.push({ source: row.id, reason: `entry_error:${row.reason}` });
  }
  return {
    schema: DELEGATION_CONTEXT_MANIFEST_SCHEMA,
    subject: input.subject,
    subjectId: input.subjectId,
    workspaceId: normalizeWorkspaceKey(input.workspaceFolder),
    ...(input.links ? { links: input.links } : {}),
    builtAt: (input.now ? input.now() : new Date()).toISOString(),
    instructions: projectInstructions(input.snapshot),
    task: {
      kind: input.taskKind || '',
      ...describeBoundedField(input.taskText, CONTEXT_LEGACY_LIMITS.delegationTask),
    },
    handoff: describeBoundedField(input.handoffText, CONTEXT_LEGACY_LIMITS.harnessHandoff),
    reports,
    omitted,
    limits: CONTEXT_LEGACY_LIMITS,
    // Reading or building a manifest never activates a skill or changes a
    // permission; a report is data, not a selection.
    activation: { skillSource: 'explicit_ids_only', mentionsParsed: false, reportsActivate: false, readChangesPermissions: false },
  };
}

/**
 * Manifest of a delegation child, derived from the delegation record alone
 * (what the child will be / was given).
 *
 * @param row Delegation record.
 */
export function buildDelegationContextManifest(row: Record<string, any>, options: { cwd?: string, homeDir?: string, bundledRoot?: string, additionalDirs?: string[], now?: () => Date } = {}): Record<string, any> {
  const profile = resolveDelegationContextProfile(row);
  const workspaceFolder = String(row.workspaceFolder || '');
  const cwd = options.cwd || String(row.executionFolder || '') || workspaceFolder;
  const snapshot = buildContextSnapshot({
    cwd,
    projectRoot: workspaceFolder || undefined,
    prompt: '',
    chatId: String(row.childChatId || ''),
    transport: String(row.executor?.transport || ''),
    mode: '',
    selection: selectionFromSkillIds(row.selectedSkillIds),
    profile,
    reportContext: '',
    homeDir: options.homeDir,
    bundledRoot: options.bundledRoot,
    additionalDirs: options.additionalDirs,
    now: options.now,
  }, String(row.executor?.transport || '') === 'sdk' ? 'sdk' : 'harness', { kind: 'preview' });
  const isTask = row.sourceKind === 'message' || row.sourceKind === 'text';
  const taskText = isTask ? row.sourceText : row.planMarkdown;
  return composeManifest({
    subject: 'delegation',
    subjectId: String(row.id || ''),
    workspaceFolder,
    snapshot,
    profile,
    taskText: String(taskText || ''),
    taskKind: String(row.sourceKind || ''),
    handoffText: '',
    reports: [],
    omitted: [
      { source: 'parent_transcript', reason: 'child_gets_task_only; read by reference with chat_event' },
      { source: 'parent_delegation_reports', reason: 'not_inherited' },
    ],
    links: {
      parentChatId: String(row.parentChatId || ''),
      childChatId: String(row.childChatId || ''),
      role: profile.id,
    },
    now: options.now,
  });
}

/**
 * Manifest of a normal chat (the parent side of a comparison).
 */
export function buildChatContextManifest(input: {
  chatId: string,
  workspaceFolder: string,
  cwd?: string,
  transport?: string,
  mode?: string,
  handoffText?: string,
  reports?: { id: string, text: string }[],
  homeDir?: string,
  bundledRoot?: string,
  additionalDirs?: string[],
  now?: () => Date,
}): Record<string, any> {
  const transport = String(input.transport || 'sdk');
  const snapshot = buildContextSnapshot({
    cwd: input.cwd || input.workspaceFolder,
    projectRoot: input.workspaceFolder || undefined,
    prompt: '',
    chatId: input.chatId,
    transport,
    mode: input.mode || '',
    selection: selectionFromSkillIds([]),
    profile: null,
    reportContext: (input.reports || []).map((item) => item.text).join('\n\n'),
    homeDir: input.homeDir,
    bundledRoot: input.bundledRoot,
    additionalDirs: input.additionalDirs,
    now: input.now,
  }, transport === 'sdk' ? 'sdk' : 'harness', { kind: 'preview' });
  return composeManifest({
    subject: 'chat',
    subjectId: input.chatId,
    workspaceFolder: input.workspaceFolder,
    snapshot,
    profile: null,
    taskText: '',
    taskKind: 'next_message',
    handoffText: input.handoffText || '',
    reports: input.reports || [],
    omitted: [],
    now: input.now,
  });
}

/**
 * Compare two manifests field by field. Entries are matched by stable ID.
 */
export function compareContextManifests(parent: Record<string, any>, child: Record<string, any>): Record<string, any> {
  const ids = (manifest: Record<string, any>): Set<string> => new Set(manifest.instructions.delivered.map((row: Record<string, any>) => row.id));
  const a = ids(parent);
  const b = ids(child);
  const fieldChanged = (name: string) => JSON.stringify(parent[name]) !== JSON.stringify(child[name]);
  return {
    sameWorkspace: parent.workspaceId === child.workspaceId,
    profile: { parent: parent.instructions.profile, child: child.instructions.profile },
    entries: {
      shared: [...a].filter((id) => b.has(id)).sort(),
      onlyParent: [...a].filter((id) => !b.has(id)).sort(),
      onlyChild: [...b].filter((id) => !a.has(id)).sort(),
    },
    omittedByChild: child.omitted.map((item: Record<string, any>) => item.source).filter((source: string) => !parent.omitted.some((item: Record<string, any>) => item.source === source)).sort(),
    fieldsDiffer: ['task', 'handoff', 'reports'].filter(fieldChanged),
  };
}
