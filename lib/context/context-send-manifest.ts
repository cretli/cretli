/**
 * Context send manifest, snapshot and next-send preview.
 *
 * One builder serves both: `buildContextSnapshot` calls `assemble` (the same
 * function the comparison mode uses) and projects the result into a public,
 * content-free record. A real send is recorded with `recordContextSend`, a
 * preview is produced with `previewNextSend`; both go through
 * `buildContextSnapshot`, so a preview and a send of unchanged inputs have the
 * same `revision`.
 *
 * What a snapshot never holds: prompt text, block text, tool results, absolute
 * paths, host source roots. It holds ids, relative paths, hashes, sizes and
 * reason codes.
 *
 * `read` is always false with `readEvidence: 'none'`: Cretli has no signal that
 * a harness actually opened an entry, so it does not claim one.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import { assemble, CONTEXT_ADAPTERS } from './context-assembler.ts';
import type { AssembleContext, ContextAdapter } from './context-assembler.ts';
import { isListableEntry } from './registry.ts';
import {
  appendContextSendManifest,
  getContextPreviewMarker,
  setContextPreviewMarker,
} from '../persist/context-send-manifests-persist.js';

export const CONTEXT_SNAPSHOT_SCHEMA = 1;
/** Today's only Cretli channel: the message prefix. */
export const CONTEXT_CHANNEL_MESSAGE_PREFIX = 'message_prefix';
export const CONTEXT_ENTRY_STATES = Object.freeze([
  'available', 'delivered', 'unknown_native', 'error', 'overridden', 'disabled',
]);

function sha256(text: string): string {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * Replace host paths in free text so a warning can never leak them.
 */
function scrubPaths(text: string, roots: string[]): string {
  let out = String(text || '');
  for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(root).join('<path>');
  }
  return out;
}

function resolveAdapter(adapterId: 'sdk' | 'harness'): ContextAdapter {
  return CONTEXT_ADAPTERS[adapterId === 'sdk' ? 'sdk' : 'harness'];
}

/**
 * Per-entry state. `delivered` means the entry is part of the assembled
 * payload (for a preview: would be). `unknown_native` marks entries the harness
 * may load by itself; Cretli cannot confirm it, so it does not say it did.
 */
function buildEntryRows(result: ReturnType<typeof assemble>, adapter: ContextAdapter): Record<string, any>[] {
  const roles = new Map<string, string[]>();
  for (const item of result.manifest.entries) {
    roles.set(item.id, [...(roles.get(item.id) || []), item.role]);
  }
  const winnerNames = new Set<string>();
  for (const entry of result.registry.entries) {
    if (entry.kind === 'skill' && isListableEntry(entry) && (roles.get(entry.id) || []).includes('catalog')) {
      winnerNames.add(entry.callName.toLowerCase());
    }
  }
  return result.registry.entries.map((entry) => {
    const entryRoles = roles.get(entry.id) || [];
    const errors = entry.diagnostics.filter((item) => item.severity === 'error').map((item) => item.code);
    let verdict: { state: string, reason: string } = { state: 'available', reason: entry.kind === 'rule' ? 'not_assembled' : 'catalog_only' };
    if (!entry.valid || errors.length) {
      verdict = { state: 'error', reason: errors[0] || 'invalid_entry' };
    } else if (entryRoles.length) {
      verdict = { state: 'delivered', reason: entryRoles.includes('selected') ? 'selected_in_message' : entryRoles[0] };
    } else if (entry.kind === 'skill' && !result.catalogIncluded) {
      verdict = { state: 'disabled', reason: 'omitted_by_profile' };
    } else if (entry.kind === 'skill' && isListableEntry(entry) && winnerNames.has(entry.callName.toLowerCase())) {
      verdict = { state: 'overridden', reason: 'shadowed_by_higher_precedence' };
    } else if (entry.kind === 'rule') {
      const meta = result.registry.getRuleMeta(entry.id);
      if (entry.scope === 'project' && !adapter.workspaceRules) {
        verdict = { state: 'unknown_native', reason: 'harness_may_load_natively' };
      } else if (entry.scope !== 'project' && entry.scope !== 'shared') {
        verdict = { state: 'disabled', reason: 'source_not_delivered' };
      } else if (!meta?.alwaysApply) {
        verdict = { state: 'disabled', reason: 'not_always_apply' };
      } else {
        verdict = { state: 'disabled', reason: 'scope_mismatch' };
      }
    }
    return {
      id: entry.id,
      kind: entry.kind,
      source: entry.source,
      scope: entry.scope,
      relPath: entry.relPath,
      callName: entry.callName,
      contentHash: entry.contentHash,
      sizeBytes: entry.sizeBytes,
      state: verdict.state,
      reason: verdict.reason,
      selected: entryRoles.includes('selected'),
      read: false,
      readEvidence: 'none',
      diagnosticCodes: entry.diagnostics.map((item) => item.code),
    };
  });
}

/**
 * Public, content-free snapshot of one assembly.
 *
 * @param context Same fields as `assemble`.
 */
export function buildContextSnapshot(
  context: AssembleContext & { staticDelivery?: Record<string, any> | null },
  adapterId: 'sdk' | 'harness',
  options: { kind?: 'preview' | 'send', sendId?: string } = {},
): Record<string, any> {
  const adapter = resolveAdapter(adapterId);
  const result = assemble(context, adapter);
  const staticHashes = result.blocks.filter((block) => block.kind === 'static').map((block) => block.hash);
  const revision = sha256([adapter.id, result.registry.epoch, result.registry.contentRevision, ...staticHashes].join('|')).slice(0, 16);
  const scrubRoots = [result.manifest.projectRoot, context.cwd, context.projectRoot, context.homeDir || os.homedir()]
    .map((value) => String(value || ''));
  const entries = buildEntryRows(result, adapter);
  const blocks = result.blocks.map((block) => ({
    id: block.id,
    kind: block.kind,
    hash: block.hash,
    length: block.text.length,
    entryIds: block.entryIds,
    included: block.text.length > 0,
    reason: block.text.length > 0
      ? (block.kind === 'static' ? 'assembled_from_registry' : 'dynamic_block')
      : (block.id === 'workspace_rules' && !adapter.workspaceRules ? 'adapter_excludes'
        : block.id === 'skills_catalog' && !result.catalogIncluded ? 'omitted_by_profile' : 'empty'),
  }));
  const counts: Record<string, number> = Object.fromEntries(CONTEXT_ENTRY_STATES.map((state) => [state, 0]));
  for (const row of entries) counts[row.state] += 1;
  return {
    schema: CONTEXT_SNAPSHOT_SCHEMA,
    kind: options.kind === 'send' ? 'send' : 'preview',
    ...(options.sendId ? { sendId: options.sendId } : {}),
    adapter: adapter.id,
    channel: CONTEXT_CHANNEL_MESSAGE_PREFIX,
    mode: String(context.mode || ''),
    profile: result.profileId || null,
    transport: String(context.transport || adapter.id),
    registryEpoch: result.manifest.registryEpoch,
    revision,
    assembledAt: result.manifest.assembledAt,
    projectRootId: sha256(result.manifest.projectRoot).slice(0, 12),
    payloadHash: result.manifest.payloadHash,
    payloadLength: result.payload.length,
    blocks,
    entries,
    counts,
    selection: result.manifest.selection || null,
    // Estimated sizes of Cretli's own contribution; not provider usage, cache or cost.
    budget: result.budget,
    // How the static block was delivered and why; says nothing about the model's memory.
    staticDelivery: context.staticDelivery
      ? {
        mode: String(context.staticDelivery.staticMode || 'always'),
        reason: String(context.staticDelivery.reason || ''),
        instructionEpoch: Number(context.staticDelivery.epoch) || 0,
        memoryKnowledge: 'not_claimed',
      }
      : null,
    warnings: result.warnings.map((warning) => scrubPaths(warning, scrubRoots)),
  };
}

/**
 * Next-send preview. Stores the revision so the following send can report
 * whether the files changed in between.
 */
export function previewNextSend(context: AssembleContext, adapterId: 'sdk' | 'harness', options: { chatId?: string } = {}): Record<string, any> {
  const snapshot = buildContextSnapshot(context, adapterId, { kind: 'preview' });
  if (options.chatId) {
    setContextPreviewMarker(options.chatId, {
      revision: snapshot.revision,
      adapter: snapshot.adapter,
      previewedAt: snapshot.assembledAt,
    });
  }
  return snapshot;
}

/**
 * Record one real send. `sentPayload` is what actually went out; its hash is
 * stored next to the assembled one with a `matchesAssembler` flag, so a drift
 * between the legacy send path and the assembler is visible, not hidden.
 * Idempotent by `sendId`.
 *
 * @returns The stored manifest, or null when skipped.
 */
export function recordContextSend(input: {
  chatId: string,
  sendId: string,
  context: AssembleContext,
  adapterId: 'sdk' | 'harness',
  sentPayload?: string,
}): Record<string, any> | null {
  const { chatId, sendId } = input;
  if (!chatId || !sendId) return null;
  const snapshot = buildContextSnapshot(input.context, input.adapterId, { kind: 'send', sendId });
  const marker = getContextPreviewMarker(chatId);
  const sentHash = typeof input.sentPayload === 'string' ? sha256(input.sentPayload) : '';
  const manifest: Record<string, any> & { sendId: string } = {
    ...snapshot,
    sendId,
    delivery: {
      sentPayloadHash: sentHash,
      sentPayloadLength: typeof input.sentPayload === 'string' ? input.sentPayload.length : 0,
      matchesAssembler: sentHash ? sentHash === snapshot.payloadHash : null,
    },
    preview: marker && marker.adapter === snapshot.adapter
      ? {
        revision: marker.revision,
        previewedAt: marker.previewedAt,
        // The files (or registry composition) changed after the preview was shown.
        changedSincePreview: marker.revision !== snapshot.revision,
      }
      : null,
  };
  appendContextSendManifest(chatId, manifest);
  return manifest;
}

/** Quiet by default in tests and on request: `CRETLI_CONTEXT_MANIFEST=0` disables recording. */
export function isContextManifestRecordingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.CRETLI_CONTEXT_MANIFEST ?? '1').trim() !== '0';
}

/**
 * Best-effort wrapper for the send path: never throws, never delays the send by
 * more than one assembly.
 */
export function tryRecordContextSend(input: Parameters<typeof recordContextSend>[0]) {
  if (!isContextManifestRecordingEnabled()) return null;
  try {
    return recordContextSend(input);
  } catch {
    return null;
  }
}


/**
 * Manifest of a raw mid-run steer (`kind: 'steer'`). A steer injected into a
 * live run does not re-run the prompt builder, so it carries only a hash and a
 * size plus a delivery status; it never claims that rules or skills were
 * delivered again. A steer that selects a skill is not recorded here: it is
 * routed to a follow-up and recorded as an ordinary send.
 */
export function recordSteerManifest(input: { chatId: string, text: string, transport?: string, status: string, sendId?: string }): Record<string, any> | null {
  if (!input.chatId || !isContextManifestRecordingEnabled()) return null;
  try {
    const text = String(input.text || '');
    const manifest = {
      schema: CONTEXT_SNAPSHOT_SCHEMA,
      kind: 'steer',
      sendId: input.sendId || crypto.randomUUID(),
      transport: String(input.transport || ''),
      channel: 'run_steer',
      textHash: sha256(text),
      textLength: text.length,
      delivery: { status: String(input.status || 'unknown') },
      // Rules and skills are not part of a raw steer; nothing is re-delivered.
      redelivery: 'not_claimed',
    };
    appendContextSendManifest(input.chatId, manifest);
    return manifest;
  } catch {
    return null;
  }
}
