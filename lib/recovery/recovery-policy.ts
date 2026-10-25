/**
 * Chat restart recovery policy (leaf R14).
 *
 * `chatRestartRecoveryMode` is `off | manual | automatic` (default `manual`)
 * with an optional per-workspace override. This module only resolves the mode
 * and decides whether an *automatic* resume is allowed; the resume itself still
 * goes through `createRecoveryResumeService` (R12), so its fencing, stop,
 * waiting, family and limit gates are never bypassed.
 *
 * - `off`: no recovery offer and no automatic action; the manual route refuses.
 * - `manual`: the user decides (R12/R13). Default for missing/invalid values.
 * - `automatic`: only a CONFIRMED interruption (state `interrupted`, accepted
 *   acceptance proof, recoverable reason, liveness probed `dead`) on an adapter
 *   that can resume the session, with a persisted session id.
 */

import { isRecoverableRunInterruptReason } from './recovery-contract.ts';

export const CHAT_RESTART_RECOVERY_MODES: readonly string[] = Object.freeze(['off', 'manual', 'automatic']);
export const DEFAULT_CHAT_RESTART_RECOVERY_MODE = 'manual';

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function modeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isChatRestartRecoveryMode(value: unknown): boolean {
  return CHAT_RESTART_RECOVERY_MODES.includes(modeText(value));
}

/**
 * Safe migration: a missing, mistyped or unknown value becomes `manual`.
 *
 * @param {unknown} value
 * @returns {'off'|'manual'|'automatic'}
 */
export function normalizeChatRestartRecoveryMode(value: unknown): 'off'|'manual'|'automatic' {
  const mode = modeText(value);
  return CHAT_RESTART_RECOVERY_MODES.includes(mode) ? mode as 'off'|'manual'|'automatic' : DEFAULT_CHAT_RESTART_RECOVERY_MODE;
}

/**
 * @param {Record<string, any> | null | undefined} settings - loadSettings() result
 * @returns {{ mode: string, workspaces: Record<string, string> }}
 */
export function getChatRestartRecoverySettings(settings: Record<string, any> | null | undefined): { mode: string, workspaces: Record<string, string> } {
  const src: Record<string, any> = settings && typeof settings === 'object' ? settings : {};
  const workspaces: Record<string, string> = {};
  const raw = src.chatRestartRecoveryWorkspaces;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [folder, mode] of Object.entries(raw)) {
      // Invalid overrides are dropped (inherit the global mode), never coerced.
      if (text(folder) && isChatRestartRecoveryMode(mode)) workspaces[text(folder)] = modeText(mode);
    }
  }
  return { mode: normalizeChatRestartRecoveryMode(src.chatRestartRecoveryMode), workspaces };
}

/**
 * @param {Record<string, any> | null | undefined} settings
 * @param {string} [workspaceFolder]
 * @returns {'off'|'manual'|'automatic'}
 */
export function resolveChatRestartRecoveryMode(settings: Record<string, any> | null | undefined, workspaceFolder: string = ''): 'off'|'manual'|'automatic' {
  const cfg = getChatRestartRecoverySettings(settings);
  const folder = text(workspaceFolder);
  return (folder && cfg.workspaces[folder] ? cfg.workspaces[folder] : cfg.mode) as 'off'|'manual'|'automatic';
}

/**
 * Apply a settings PATCH body in place. Returns an error string or `''`.
 * Body: `chatRestartRecoveryMode` and/or
 * `chatRestartRecoveryWorkspace: { workspaceFolder, mode }` (`mode: null|''`
 * clears the override).
 *
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} body
 * @returns {{ changed: boolean, error: string }}
 */
export function applyChatRestartRecoveryPatch(settings: Record<string, any>, body: Record<string, any>): { changed: boolean, error: string } {
  const next: Record<string, any> = { ...settings, chatRestartRecoveryWorkspaces: { ...getChatRestartRecoverySettings(settings).workspaces } };
  let changed = false;
  if (body && typeof body.chatRestartRecoveryMode !== 'undefined') {
    if (!isChatRestartRecoveryMode(body.chatRestartRecoveryMode)) {
      return { changed: false, error: 'chatRestartRecoveryMode must be off, manual or automatic.' };
    }
    next.chatRestartRecoveryMode = modeText(body.chatRestartRecoveryMode);
    changed = true;
  }
  const ws = body?.chatRestartRecoveryWorkspace;
  if (typeof ws !== 'undefined') {
    const folder = ws && typeof ws === 'object' ? text(ws.workspaceFolder) : '';
    if (!folder) return { changed: false, error: 'chatRestartRecoveryWorkspace requires workspaceFolder.' };
    const hasMode = Object.prototype.hasOwnProperty.call(ws, 'mode');
    if (!hasMode || (ws.mode !== null && typeof ws.mode !== 'string')) {
      return { changed: false, error: 'chatRestartRecoveryWorkspace.mode must be off, manual, automatic or empty.' };
    }
    const clear = ws.mode === null || ws.mode.trim() === '';
    if (!clear && !isChatRestartRecoveryMode(ws.mode)) {
      return { changed: false, error: 'chatRestartRecoveryWorkspace.mode must be off, manual, automatic or empty.' };
    }
    if (clear) delete next.chatRestartRecoveryWorkspaces[folder];
    else next.chatRestartRecoveryWorkspaces[folder] = modeText(ws.mode);
    changed = true;
  }
  if (changed) Object.assign(settings, next);
  return { changed, error: '' };
}

/**
 * Pure gate: may this run be resumed automatically under the policy?
 *
 * @param {{
 *   mode: string,
 *   run: object | null,
 *   liveness?: string,
 *   capabilities?: { canResumeSession?: boolean },
 *   adapterValidated?: boolean,
 * }} input
 * @returns {{ allowed: boolean, reason: string }}
 */
export function evaluateAutomaticResume(input: { mode: string, run: Record<string, any> | null, liveness?: string, capabilities?: { canResumeSession?: boolean }, adapterValidated?: boolean, }): { allowed: boolean, reason: string } {
  const { run } = input;
  if (input.mode !== 'automatic') {
    return { allowed: false, reason: `mode_${modeText(input.mode) || 'manual'}` };
  }
  if (!run) return { allowed: false, reason: 'run_missing' };
  if (text(run.acceptance?.state) !== 'accepted') return { allowed: false, reason: 'no_acceptance_proof' };
  // `unknown` is an unproven interruption: it needs a human confirmation.
  if (text(run.state) !== 'interrupted') return { allowed: false, reason: 'not_confirmed_interrupted' };
  if (!isRecoverableRunInterruptReason(run.reason)) return { allowed: false, reason: 'reason_not_recoverable' };
  if (text(input.liveness) !== 'dead') return { allowed: false, reason: 'liveness_not_confirmed_dead' };
  if (input.capabilities?.canResumeSession !== true) return { allowed: false, reason: 'adapter_unsupported' };
  // Per-adapter enable gate: unknown or unvalidated adapters stay blocked.
  if (input.adapterValidated !== true) return { allowed: false, reason: 'adapter_not_validated' };
  if (!text(run.sessionId)) return { allowed: false, reason: 'context_unavailable' };
  return { allowed: true, reason: 'automatic_allowed' };
}

/**
 * @param {string} logicalRunId
 * @returns {string}
 */
export function automaticResumeKey(logicalRunId: string): string {
  return `auto-${logicalRunId}`;
}

/**
 * Resume one run automatically when policy and gates allow it. Delegates to the
 * R12 resume service (actor `automatic`, never `confirmUnknown`), which still
 * enforces fencing, stop/waiting/family/limit gates and idempotency.
 *
 * @param {{
 *   run: object,
 *   settings: object,
 *   resumeService: { resumeRun: Function },
 *   probeLiveness: (input: { run: object }) => string,
 *   getCapabilities: (harness: string) => object,
 *   isAdapterValidated?: (harness: string) => boolean,
 * }} deps
 * @returns {Promise<{ attempted: boolean, reason: string, outcome?: Record<string, any> }>}
 */
export async function resumeRunIfAutomatic(deps: { run: Record<string, any>, settings: Record<string, any>, resumeService: { resumeRun: Function }, probeLiveness: (input: { run: Record<string, any> }) => string, getCapabilities: (harness: string) => Record<string, any>, isAdapterValidated?: (harness: string) => boolean, }): Promise<{ attempted: boolean, reason: string, outcome?: Record<string, any> }> {
  const { run } = deps;
  const mode = resolveChatRestartRecoveryMode(deps.settings, run?.workspaceFolder);
  const verdict = evaluateAutomaticResume({
    mode,
    run,
    liveness: run ? deps.probeLiveness({ run }) : 'unknown',
    capabilities: run ? deps.getCapabilities(run.harness) : {},
    adapterValidated: run && typeof deps.isAdapterValidated === 'function' ? deps.isAdapterValidated(run.harness) === true : false,
  });
  if (!verdict.allowed) return { attempted: false, reason: verdict.reason };
  const outcome = await deps.resumeService.resumeRun({
    chatId: run.chatId,
    logicalRunId: run.logicalRunId,
    expectedState: run.state,
    expectedRevision: run.revision,
    // Stable per run (NOT per revision): the stored result is replayed on every
    // later tick, so a failed launch is never retried automatically (R15).
    idempotencyKey: automaticResumeKey(run.logicalRunId),
    confirmUnknown: false,
    actor: 'automatic',
  });
  return { attempted: true, reason: outcome?.status || 'unknown', outcome };
}
