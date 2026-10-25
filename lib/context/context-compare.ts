/**
 * Comparison mode: registry-based assembler vs. the blocks the real send path
 * builds today.
 *
 * - The SDK path and the non-SDK path are two separate baselines and are never
 *   merged: the SDK adds neither workspace rules nor a mode hint, the non-SDK
 *   path adds both (`baselineDelta` documents that).
 * - Comparing never changes what is sent: the legacy functions stay the send
 *   path and `resolveContextBuilderMode` keeps `legacy` as the default. The
 *   assembler result is observational until a controlled switch.
 */
import crypto from 'node:crypto';
import { assemble, CONTEXT_ADAPTERS } from './context-assembler.ts';
import {
  buildHarnessDecorationParts,
  buildSdkDecorationParts,
  composeStatelessDecoratedPrompt,
} from '../sdk/harness-plan-prompt.ts';
import { PROMPT_DECORATION_VOLATILE_ORDER } from '../sdk/prompt-decoration.ts';

export const CONTEXT_BUILDER_MODES = Object.freeze(['legacy', 'compare']);

/**
 * `legacy` (default) sends the legacy payload. `compare` also runs the
 * assembler for observation. There is deliberately no mode that sends the
 * assembler result yet; an unknown value falls back to `legacy`.
 */
export function resolveContextBuilderMode(env: NodeJS.ProcessEnv = process.env): 'legacy' | 'compare' {
  const raw = String(env.CRETLI_CONTEXT_BUILDER || '').trim().toLowerCase();
  return raw === 'compare' ? 'compare' : 'legacy';
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** Static block ids present in both baselines' comparison tables. */
const STATIC_IDS = ['skills_catalog', 'agents_md', 'workspace_rules', 'shared_rules'];

/**
 * Exact legacy blocks of one send path, in the assembler's block ids.
 */
export function buildLegacyBaseline(adapterId: 'sdk' | 'harness', context: Record<string, any>): { blocks: Map<string, string>, payload: string, legacyStaticBlock: string, staticBlock: string } {
  const prompt = String(context.prompt || '');
  const input = {
    cwd: context.cwd,
    chatId: context.chatId,
    mode: context.mode,
    transport: context.transport,
    skipPlanHint: context.skipPlanHint === true,
    pageContext: context.pageContext,
    taskKind: context.taskKind,
    fileTypes: context.fileTypes,
    skillOptions: context.skillOptions,
    selection: context.selection,
    sharedDirs: context.additionalDirs,
    projectRoot: context.projectRoot,
    contextSettings: context.contextSettings,
    ...(Object.prototype.hasOwnProperty.call(context, 'reportContext') ? { reportContext: context.reportContext } : {}),
  };
  const parts = adapterId === 'sdk'
    ? buildSdkDecorationParts(prompt, input)
    : buildHarnessDecorationParts(prompt, input);
  const { blocks, volatile } = parts;

  // The legacy static block is one string; split it back into the assembler's
  // block ids by their fixed headers so each block compares on its own.
  // AGENTS.md has its own block id; the header split below runs on the static block without it.
  const core = blocks.coreStaticBlock ?? blocks.staticBlock;
  const catalogEnd = (() => {
    const idx = core.search(/\n\n\[(WORKSPACE|SHARED) CURSOR RULES\]/);
    return idx === -1 ? core.length : idx;
  })();
  const catalogText = core.startsWith('[WORKSPACE CURSOR RULES]')
    || core.startsWith('[SHARED CURSOR RULES]')
    ? ''
    : core.slice(0, catalogEnd);
  const rest = core.slice(catalogText.length).replace(/^\n\n/, '');
  const workspaceStart = rest.indexOf('[WORKSPACE CURSOR RULES]');
  const sharedStart = rest.indexOf('[SHARED CURSOR RULES]');
  const workspaceText = workspaceStart === -1
    ? ''
    : rest.slice(workspaceStart, sharedStart === -1 ? undefined : sharedStart).replace(/\n\n$/, '');
  const sharedText = sharedStart === -1 ? '' : rest.slice(sharedStart);

  const map = new Map<string, string>([
    ['skills_catalog', catalogText],
    ['agents_md', blocks.agentsMdBlock || ''],
    ['workspace_rules', workspaceText],
    ['shared_rules', sharedText],
  ]);
  for (const key of PROMPT_DECORATION_VOLATILE_ORDER) map.set(key, volatile[key] || '');
  return {
    blocks: map,
    payload: composeStatelessDecoratedPrompt(blocks, volatile, prompt),
    legacyStaticBlock: blocks.legacyStaticBlock,
    staticBlock: blocks.staticBlock,
  };
}

/**
 * Compare the assembler against the legacy blocks of one path.
 *
 * @param context Same fields as `assemble`, plus optional
 *   `skillOptions` to pin the legacy skill scan roots.
 */
export function compareWithLegacy(context: Record<string, any>, adapterId: 'sdk' | 'harness', options: { includeText?: boolean } = {}): {
  adapter: string,
  defaultResult: 'legacy',
  identical: boolean,
  payloadIdentical: boolean,
  differences: { block: string, status: string, legacyHash: string, candidateHash: string, legacyLength: number, candidateLength: number, legacyText?: string, candidateText?: string }[],
  legacy: { payload: string, payloadHash: string },
  candidate: { manifest: Record<string, any>, warnings: string[], payloadHash: string },
} {
  const adapter = CONTEXT_ADAPTERS[adapterId];
  if (!adapter) throw new Error(`Unknown context adapter: ${adapterId}`);
  const baseline = buildLegacyBaseline(adapterId, context);
  const candidate = assemble(context, adapter);
  const candidateBlocks = new Map(candidate.blocks.map((block) => [block.id, block.text]));
  candidateBlocks.set('static_block', candidate.legacyShape.staticBlock);
  const differences: { block: string, status: string, legacyHash: string, candidateHash: string, legacyLength: number, candidateLength: number, legacyText?: string, candidateText?: string }[] = [];
  for (const id of ['static_block', ...STATIC_IDS, ...PROMPT_DECORATION_VOLATILE_ORDER]) {
    const legacyText = id === 'static_block' ? baseline.staticBlock : baseline.blocks.get(id) || '';
    const candidateText = candidateBlocks.get(id) || '';
    let status = 'same';
    if (legacyText !== candidateText) {
      if (!legacyText) status = 'only_candidate';
      else if (!candidateText) status = 'only_legacy';
      else status = 'different';
    }
    const row = {
      block: id,
      status,
      legacyHash: sha256(legacyText),
      candidateHash: sha256(candidateText),
      legacyLength: legacyText.length,
      candidateLength: candidateText.length,
    };
    if (options.includeText && status !== 'same') {
      Object.assign(row, { legacyText, candidateText });
    }
    differences.push(row);
  }
  const payloadIdentical = baseline.payload === candidate.payload;
  return {
    adapter: adapterId,
    defaultResult: 'legacy',
    identical: differences.every((row) => row.status === 'same') && payloadIdentical,
    payloadIdentical,
    differences,
    legacy: { payload: baseline.payload, payloadHash: sha256(baseline.payload) },
    candidate: {
      manifest: candidate.manifest,
      warnings: candidate.warnings,
      payloadHash: sha256(candidate.payload),
    },
  };
}

/**
 * Compare both send paths, each against its own baseline, and list which
 * blocks the two baselines differ in. The baselines are not equalized.
 */
export function compareAllAdapters(context: Record<string, any>, options: { includeText?: boolean } = {}) {
  const sdk = compareWithLegacy(context, 'sdk', options);
  const harness = compareWithLegacy(context, 'harness', options);
  const sdkBase = buildLegacyBaseline('sdk', context);
  const harnessBase = buildLegacyBaseline('harness', context);
  const baselineDelta = [...STATIC_IDS, ...PROMPT_DECORATION_VOLATILE_ORDER]
    .filter((id) => (sdkBase.blocks.get(id) || '') !== (harnessBase.blocks.get(id) || ''))
    .map((id) => ({
      block: id,
      sdkHasBlock: Boolean(sdkBase.blocks.get(id)),
      harnessHasBlock: Boolean(harnessBase.blocks.get(id)),
    }));
  return { builderMode: resolveContextBuilderMode(), sdk, harness, baselineDelta };
}
