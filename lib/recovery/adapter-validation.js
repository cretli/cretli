/**
 * Per-harness, per-exact-SDK-version validation matrix for the recovery MVP adapter
 * contract (leaf R7).
 *
 * `describeRecoveryAdapterContract` only reads the declared row (and optional
 * package.json version metadata). It never opens a recovery store.
 * `evaluateRecoveryAdapterValidation` is the explicit runtime probe: waiting,
 * cancel and missing_transcript run against a caller-supplied store, or against
 * an ephemeral store only when `{ openEphemeralStore: true }` is passed.
 * `buildRecoveryAdapterValidationRecord` composes those pieces and does no I/O.
 *
 * Overall status stays `pending` until a live SIGKILL crash suite (R19) validates
 * the same `{harness, sdkVersion}` key; a pass for version X never satisfies version Y.
 */

import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDurableRequestLookup } from '../chat-run/kernel-adapter.js';
import {
  RECOVERY_DEFERRED_ADAPTERS,
  RECOVERY_MVP_ADAPTERS,
  RUN_TRANSCRIPT_LOSS_REASONS,
  resolveRecoveryAdapter,
  resolveRecoveryDecision,
} from './recovery-contract.js';
import { createRecoveryIds } from './recovery-ids.js';
import {
  beginRunLaunch,
  canAutoRelaunch,
  recordExecutorAck,
} from './recovery-lifecycle.js';
import { markRunWaiting, requestRunCancel } from './recovery-queue.js';
import { closeRecoveryStore, openRecoveryStore } from './recovery-store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Named acceptance dimensions from plan section 5 (R7). */
export const RECOVERY_VALIDATION_SCENARIOS = Object.freeze([
  'context',
  'live_executor',
  'waiting',
  'cancel',
  'missing_transcript',
]);

/** Overall validation statuses for a version-keyed record. */
export const RECOVERY_ADAPTER_VALIDATION_STATUSES = Object.freeze([
  'validated',
  'pending',
  'failed',
  'unsupported',
  'no_validation',
]);

/**
 * Installed SDK package locations per MVP harness (caret ranges live in package.json).
 * Claude installs into an isolated optional-packages tree.
 */
export const RECOVERY_MVP_HARNESS_SDK_SPECS = Object.freeze({
  sdk: Object.freeze({
    packageName: '@cursor/sdk',
    packagePaths: Object.freeze(['node_modules/@cursor/sdk/package.json']),
  }),
  claude: Object.freeze({
    packageName: '@anthropic-ai/claude-agent-sdk',
    packagePaths: Object.freeze([
      'optional-packages/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    ]),
  }),
  codex: Object.freeze({
    packageName: '@openai/codex-sdk',
    packagePaths: Object.freeze(['node_modules/@openai/codex-sdk/package.json']),
  }),
  qwen: Object.freeze({
    packageName: '@qwen-code/sdk',
    packagePaths: Object.freeze(['node_modules/@qwen-code/sdk/package.json']),
  }),
  deepseek: Object.freeze({
    packageName: '@deepseek-ai/dsh',
    packagePaths: Object.freeze(['node_modules/@deepseek-ai/dsh/package.json']),
  }),
  opencode: Object.freeze({
    packageName: '@opencode-ai/sdk',
    packagePaths: Object.freeze([
      'node_modules/@opencode-ai/sdk/package.json',
      'node_modules/opencode-ai/package.json',
    ]),
  }),
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {string} repoRoot
 * @param {readonly string[]} relativePaths
 * @returns {string} resolved semver or '' when absent/unreadable
 */
export function readInstalledSdkVersion(repoRoot, relativePaths) {
  const root = text(repoRoot) || REPO_ROOT;
  for (const rel of relativePaths) {
    const abs = path.join(root, rel);
    try {
      const raw = fs.readFileSync(abs, 'utf8');
      const version = text(JSON.parse(raw).version);
      if (version) return version;
    } catch {
      // optional package missing — degrade gracefully
    }
  }
  return '';
}

/**
 * @param {unknown} harness
 * @param {string} [repoRoot]
 * @returns {{ packageName: string, sdkVersion: string, unpinned: boolean }}
 */
export function resolveHarnessSdkPackageInfo(harness, repoRoot = REPO_ROOT) {
  const id = text(harness).toLowerCase();
  const spec = RECOVERY_MVP_HARNESS_SDK_SPECS[id];
  if (!spec) {
    return { packageName: '', sdkVersion: '', unpinned: true };
  }
  const sdkVersion = readInstalledSdkVersion(repoRoot, spec.packagePaths);
  return {
    packageName: spec.packageName,
    sdkVersion: sdkVersion || 'unknown',
    unpinned: !sdkVersion,
  };
}

/**
 * @param {unknown} harness
 * @param {unknown} sdkVersion
 * @returns {string}
 */
export function buildAdapterValidationVersionKey(harness, sdkVersion) {
  const id = text(harness).toLowerCase();
  const version = text(sdkVersion) || 'unknown';
  if (!id) return '';
  return `${id}@${version}`;
}

/**
 * @param {object | null | undefined} record
 * @param {unknown} sdkVersion
 * @returns {boolean}
 */
export function adapterValidationRecordCoversVersion(record, sdkVersion) {
  const required = text(sdkVersion);
  if (!record || !required || required === 'unknown') return false;
  return text(record.sdkVersion) === required && text(record.versionKey) === buildAdapterValidationVersionKey(record.harness, required);
}

/**
 * Static contract fields aligned with `describeRecoveryAdapterContract` vocabulary
 * without calling it (static half only; contract module imports this file for R7).
 *
 * @param {object} descriptor
 * @returns {{
 *   resumeStrategy: string,
 *   reattach: boolean,
 *   transcriptLossReason: string,
 *   transcriptLost: boolean,
 * }}
 */
function buildStaticContractView(descriptor) {
  const supported = descriptor.supported !== false && Boolean(text(descriptor.harness));
  const reattach = supported && descriptor.reattach === true;
  const transcriptLossReason = !supported
    ? 'no_recovery_contract'
    : reattach
      ? 'none'
      : 'fresh_turn_in_saved_session';
  return {
    resumeStrategy: text(descriptor.resumeStrategy),
    reattach,
    transcriptLossReason,
    transcriptLost: transcriptLossReason !== 'none',
  };
}

/**
 * @param {string} harness
 * @param {object} store
 * @returns {{ ids: object, run: object }}
 */
function launchAckedRun(harness, store) {
  const ids = createRecoveryIds();
  const launched = beginRunLaunch({
    ...ids,
    family: 'chat',
    owner: 'chat-run-service',
    chatId: `adapter-val-${harness}`,
    harness,
  }, store);
  const ack = recordExecutorAck({
    logicalRunId: ids.logicalRunId,
    expectedRevision: launched.run.revision,
    source: 'adapter_ack',
    adapterRunId: `run-${ids.requestId.slice(0, 8)}`,
  }, store);
  return { ids, run: ack.run };
}

/**
 * @param {string} harness
 * @param {object} store
 * @param {typeof canAutoRelaunch} [canAutoRelaunchFn]
 * @returns {object}
 */
function evaluateWaitingScenario(harness, store, canAutoRelaunchFn = canAutoRelaunch) {
  const { ids, run } = launchAckedRun(harness, store);
  const waitMark = markRunWaiting({
    logicalRunId: ids.logicalRunId,
    expectedRevision: run.revision,
    kind: 'question',
    requestId: createRecoveryIds().requestId,
  }, store);
  const gate = canAutoRelaunchFn({ logicalRunId: ids.logicalRunId }, store);
  const validated = waitMark.ok === true && gate.allowed === false && gate.reason === 'waiting';
  return Object.freeze({
    status: validated ? 'validated' : 'failed',
    autoRelaunchAllowed: gate.allowed,
    gateReason: gate.reason,
    artifact: 'markRunWaiting + canAutoRelaunch (recovery-queue.js, recovery-lifecycle.js)',
  });
}

/**
 * @param {string} harness
 * @param {object} store
 * @param {typeof canAutoRelaunch} [canAutoRelaunchFn]
 * @returns {object}
 */
function evaluateCancelScenario(harness, store, canAutoRelaunchFn = canAutoRelaunch) {
  const { ids } = launchAckedRun(harness, store);
  requestRunCancel({
    logicalRunId: ids.logicalRunId,
    requestId: createRecoveryIds().requestId,
    reason: 'user_cancel',
  }, store);
  const gate = canAutoRelaunchFn({ logicalRunId: ids.logicalRunId }, store);
  const validated = gate.allowed === false && gate.reason === 'cancelled';
  return Object.freeze({
    status: validated ? 'validated' : 'failed',
    autoRelaunchAllowed: gate.allowed,
    gateReason: gate.reason,
    artifact: 'requestRunCancel + canAutoRelaunch (recovery-queue.js, recovery-lifecycle.js)',
  });
}

/**
 * @param {string} harness
 * @param {object} descriptor
 * @param {object} store
 * @param {Map<string, object>} [roomsOverride]
 * @param {typeof createDurableRequestLookup} [createLookup]
 * @returns {object}
 */
function evaluateMissingTranscriptScenario(harness, descriptor, store, roomsOverride, createLookup = createDurableRequestLookup) {
  const reattach = descriptor.reattach === true;
  /** @type {string[]} */
  const observedLossReasons = [];
  const { ids: idsEmpty } = launchAckedRun(harness, store);
  const lookupEmpty = createLookup({
    transport: harness,
    rooms: roomsOverride instanceof Map ? roomsOverride : new Map(),
    recoveryStore: store,
  });
  const emptyRoomResult = lookupEmpty({
    chat: { cursorSessionId: 'sess-missing-empty' },
    requestId: idsEmpty.requestId,
  });
  const emptyReason = text(emptyRoomResult?.transcriptLossReason);
  if (emptyReason) observedLossReasons.push(emptyReason);
  let foreignReason = '';
  if (reattach) {
    const { ids: idsForeign } = launchAckedRun(harness, store);
    const roomsForeign = new Map([
      ['sess-missing-foreign', { currentRun: { id: 'foreign-run-not-durable' } }],
    ]);
    const lookupForeign = createLookup({
      transport: harness,
      rooms: roomsForeign,
      recoveryStore: store,
    });
    const foreignResult = lookupForeign({
      chat: { cursorSessionId: 'sess-missing-foreign' },
      requestId: idsForeign.requestId,
    });
    foreignReason = text(foreignResult?.transcriptLossReason);
    if (foreignReason) observedLossReasons.push(foreignReason);
  } else {
    const { ids: idsPresent } = launchAckedRun(harness, store);
    const roomsPresent = new Map([
      ['sess-missing-present', { currentRun: { id: 'foreign-run-not-durable' } }],
    ]);
    const lookupPresent = createLookup({
      transport: harness,
      rooms: roomsPresent,
      recoveryStore: store,
    });
    const presentResult = lookupPresent({
      chat: { cursorSessionId: 'sess-missing-present' },
      requestId: idsPresent.requestId,
    });
    const presentReason = text(presentResult?.transcriptLossReason);
    if (presentReason) observedLossReasons.push(presentReason);
    foreignReason = presentReason;
  }
  const roomMissingOk = emptyReason === 'room_missing';
  const reattachOk = !reattach || foreignReason === 'no_live_run_match';
  const nonReattachOk = reattach || (foreignReason === 'fresh_turn_in_saved_session' && !observedLossReasons.includes('no_live_run_match'));
  const tokensOk = observedLossReasons.every((token) => RUN_TRANSCRIPT_LOSS_REASONS.includes(token));
  const validated = roomMissingOk && reattachOk && nonReattachOk && tokensOk;
  return Object.freeze({
    status: validated ? 'validated' : 'failed',
    emptyRoomTranscriptLossReason: emptyReason,
    foreignRoomTranscriptLossReason: foreignReason,
    observedLossReasons: Object.freeze([...new Set(observedLossReasons)]),
    lookupExplicitUnsupported: false,
    artifact: 'createDurableRequestLookup + resolveObservedTranscriptLoss (kernel-adapter.js)',
  });
}

/**
 * @returns {object}
 */
function notRunScenario() {
  return Object.freeze({ status: 'pending', notRun: true });
}

/**
 * @param {object} descriptor
 * @param {ReturnType<typeof buildStaticContractView>} view
 * @returns {Record<string, object>}
 */
function evaluateStaticScenarios(descriptor, view) {
  const aliveDecision = resolveRecoveryDecision({
    reason: 'server_restart',
    adapter: descriptor,
    liveness: 'alive',
  });
  const deadDecision = resolveRecoveryDecision({
    reason: 'server_restart',
    adapter: descriptor,
    liveness: 'dead',
  });
  const contextOk = RUN_TRANSCRIPT_LOSS_REASONS.includes(view.transcriptLossReason)
    && Boolean(view.resumeStrategy);
  const liveOk = descriptor.reattach === true
    ? aliveDecision.decision === 'reattach' && aliveDecision.automatic === true
    : view.reattach === false
      && view.transcriptLossReason === 'fresh_turn_in_saved_session'
      && deadDecision.decision === 'resume_session'
      && aliveDecision.decision !== 'reattach';
  return {
    context: Object.freeze({
      status: contextOk ? 'validated' : 'failed',
      resumeStrategy: view.resumeStrategy,
      transcriptLossReason: view.transcriptLossReason,
      transcriptLost: view.transcriptLost,
    }),
    live_executor: Object.freeze({
      status: liveOk ? 'validated' : 'failed',
      canReattach: view.reattach,
      resumeStrategy: view.resumeStrategy,
      aliveDecision: aliveDecision.decision,
      aliveAutomatic: aliveDecision.automatic,
      deadDecision: deadDecision.decision,
    }),
  };
}

/**
 * @param {(store: object) => Record<string, object>} buildScenarios
 * @returns {Record<string, object>}
 */
function withEphemeralValidationStore(buildScenarios) {
  const dir = mkdtempSync(path.join(tmpdir(), 'recovery-adapter-val-'));
  const ephemeral = openRecoveryStore({ dataDir: dir });
  try {
    return buildScenarios(ephemeral);
  } finally {
    closeRecoveryStore(ephemeral);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} harness
 * @param {object} descriptor
 * @param {ReturnType<typeof buildStaticContractView>} view
 * @param {object} store
 * @param {{
 *   rooms?: Map<string, object>,
 *   canAutoRelaunch?: typeof canAutoRelaunch,
 *   createDurableRequestLookup?: typeof createDurableRequestLookup,
 * }} deps
 * @returns {Record<string, object>}
 */
function evaluateMvpValidationScenarios(harness, descriptor, view, store, deps) {
  const staticScenarios = evaluateStaticScenarios(descriptor, view);
  const gate = deps.canAutoRelaunch || canAutoRelaunch;
  const createLookup = deps.createDurableRequestLookup || createDurableRequestLookup;
  return Object.freeze({
    ...staticScenarios,
    waiting: evaluateWaitingScenario(harness, store, gate),
    cancel: evaluateCancelScenario(harness, store, gate),
    missing_transcript: evaluateMissingTranscriptScenario(
      harness,
      descriptor,
      store,
      deps.rooms,
      createLookup,
    ),
  });
}

/**
 * Runs waiting, cancel and missing_transcript against an explicit recovery store.
 * There is no implicit store: pass `store`, or `{ openEphemeralStore: true }` for tooling.
 *
 * @param {{
 *   harness?: unknown,
 *   store?: object,
 *   rooms?: Map<string, object>,
 *   openEphemeralStore?: boolean,
 *   canAutoRelaunch?: typeof canAutoRelaunch,
 *   createDurableRequestLookup?: typeof createDurableRequestLookup,
 * }} [options]
 * @returns {Record<string, object>}
 */
export function evaluateRecoveryAdapterValidation(options = {}) {
  const id = text(options.harness).toLowerCase();
  if (!id || RECOVERY_DEFERRED_ADAPTERS.includes(id)) return Object.freeze({});
  const descriptor = resolveRecoveryAdapter(id);
  const supported = descriptor.supported !== false && Boolean(id);
  if (!supported) return Object.freeze({});
  const providedStore = options.store;
  const openEphemeral = options.openEphemeralStore === true && !providedStore;
  if (!providedStore && !openEphemeral) {
    throw new Error('evaluateRecoveryAdapterValidation requires store or { openEphemeralStore: true }');
  }
  const view = buildStaticContractView(descriptor);
  const run = (activeStore) => evaluateMvpValidationScenarios(id, descriptor, view, activeStore, options);
  if (providedStore) return run(providedStore);
  return withEphemeralValidationStore(run);
}

/**
 * Package identity for a pure record. Disk reads stay in `resolveHarnessSdkPackageInfo`.
 *
 * @param {string} id
 * @param {{
 *   sdkVersionOverride?: string,
 *   packageName?: string,
 *   unpinned?: boolean,
 *   packageInfo?: { packageName?: string, sdkVersion?: string, unpinned?: boolean },
 * }} options
 * @returns {{ packageName: string, sdkVersion: string, unpinned: boolean }}
 */
function resolveRecordPackage(id, options) {
  if (options.packageInfo && typeof options.packageInfo === 'object') {
    const info = options.packageInfo;
    const sdkVersion = text(options.sdkVersionOverride) || text(info.sdkVersion) || 'unknown';
    return {
      packageName: text(info.packageName),
      sdkVersion,
      unpinned: text(options.sdkVersionOverride) ? options.unpinned === true : info.unpinned !== false || sdkVersion === 'unknown',
    };
  }
  const spec = RECOVERY_MVP_HARNESS_SDK_SPECS[id];
  const override = text(options.sdkVersionOverride);
  if (override) {
    return {
      packageName: text(options.packageName) || spec?.packageName || '',
      sdkVersion: override,
      unpinned: options.unpinned === true,
    };
  }
  return {
    packageName: text(options.packageName) || spec?.packageName || '',
    sdkVersion: 'unknown',
    unpinned: true,
  };
}

/**
 * @param {Record<string, object>} staticScenarios
 * @param {Record<string, object> | undefined} injected
 * @returns {Record<string, object>}
 */
function composeValidationScenarios(staticScenarios, injected) {
  /** @type {Record<string, object>} */
  const scenarios = {
    ...staticScenarios,
    waiting: notRunScenario(),
    cancel: notRunScenario(),
    missing_transcript: notRunScenario(),
  };
  if (!injected || typeof injected !== 'object') return Object.freeze(scenarios);
  for (const name of RECOVERY_VALIDATION_SCENARIOS) {
    if (injected[name]) scenarios[name] = injected[name];
  }
  return Object.freeze(scenarios);
}

/**
 * Pure composition of the declared adapter row and optional evaluated scenarios.
 * Does not open a store, read package.json, or run waiting/cancel/lookup.
 *
 * @param {{
 *   harness?: unknown,
 *   sdkVersionOverride?: string,
 *   packageName?: string,
 *   unpinned?: boolean,
 *   packageInfo?: { packageName?: string, sdkVersion?: string, unpinned?: boolean },
 *   scenarios?: Record<string, object>,
 * }} [options]
 * @returns {object}
 */
export function buildRecoveryAdapterValidationRecord(options = {}) {
  const id = text(options.harness).toLowerCase();
  if (RECOVERY_DEFERRED_ADAPTERS.includes(id)) {
    return Object.freeze({
      harness: id,
      scope: 'deferred',
      deferred: true,
      packageName: '',
      sdkVersion: '',
      versionKey: '',
      overallStatus: 'unsupported',
      enableGateValidation: '',
      requiresCrashValidation: false,
      scenarios: Object.freeze({}),
    });
  }
  const descriptor = resolveRecoveryAdapter(id);
  const supported = descriptor.supported !== false && Boolean(id);
  if (!supported) {
    return Object.freeze({
      harness: id,
      scope: 'unsupported',
      deferred: false,
      packageName: '',
      sdkVersion: '',
      versionKey: '',
      overallStatus: 'no_validation',
      enableGateValidation: '',
      requiresCrashValidation: false,
      scenarios: Object.freeze({}),
    });
  }
  const pkg = resolveRecordPackage(id, options);
  const view = buildStaticContractView(descriptor);
  const scenarios = composeValidationScenarios(
    evaluateStaticScenarios(descriptor, view),
    options.scenarios,
  );
  const scenarioFailed = RECOVERY_VALIDATION_SCENARIOS.some(
    (name) => scenarios[name]?.status === 'failed',
  );
  return Object.freeze({
    harness: id,
    scope: 'mvp',
    deferred: false,
    packageName: pkg.packageName,
    sdkVersion: pkg.sdkVersion,
    unpinned: pkg.unpinned,
    versionKey: buildAdapterValidationVersionKey(id, pkg.sdkVersion),
    overallStatus: scenarioFailed ? 'failed' : 'pending',
    enableGateValidation: 'pending',
    requiresCrashValidation: descriptor.requiresCrashValidation === true,
    scenarios,
  });
}

/**
 * @returns {readonly string[]}
 */
export function listRecoveryAdapterValidationSubjects() {
  return Object.freeze([
    ...Object.keys(RECOVERY_MVP_ADAPTERS),
    ...RECOVERY_DEFERRED_ADAPTERS,
  ]);
}

/**
 * Declared package identity plus an optional evaluated scenario map.
 * Reads package.json only. Never opens a recovery store.
 *
 * @param {string} harness
 * @param {{ repoRoot?: string }} [options]
 * @param {Record<string, object> | undefined} scenarios
 * @returns {object}
 */
function composeHarnessValidationRecord(harness, options, scenarios) {
  const pkg = resolveHarnessSdkPackageInfo(harness, options.repoRoot);
  return buildRecoveryAdapterValidationRecord({
    harness,
    packageInfo: pkg,
    scenarios,
  });
}

/**
 * Rows for every MVP and deferred harness.
 * Runtime scenarios run only when `store` or `openEphemeralStore: true` is passed.
 *
 * @param {{
 *   repoRoot?: string,
 *   store?: object,
 *   rooms?: Map<string, object>,
 *   openEphemeralStore?: boolean,
 * }} [options]
 * @returns {Record<string, object>}
 */
export function getRecoveryAdapterValidationMatrix(options = {}) {
  const wantsRuntime = Boolean(options.store) || options.openEphemeralStore === true;
  /** @type {Record<string, object>} */
  const matrix = {};
  for (const harness of Object.keys(RECOVERY_MVP_ADAPTERS)) {
    const scenarios = wantsRuntime
      ? evaluateRecoveryAdapterValidation({
        harness,
        store: options.store,
        rooms: options.rooms,
        openEphemeralStore: options.openEphemeralStore === true,
      })
      : undefined;
    matrix[harness] = composeHarnessValidationRecord(harness, options, scenarios);
  }
  for (const harness of RECOVERY_DEFERRED_ADAPTERS) {
    matrix[harness] = buildRecoveryAdapterValidationRecord({ harness });
  }
  return Object.freeze(matrix);
}

/**
 * Declared validation row for the contract view: package.json metadata and
 * static scenarios only. Waiting, cancel and missing_transcript stay not-run.
 * Does not accept a store and does not open one.
 *
 * @param {unknown} harness
 * @param {{ repoRoot?: string }} [options]
 * @returns {object}
 */
export function resolveRecoveryAdapterValidation(harness, options = {}) {
  return composeHarnessValidationRecord(harness, options, undefined);
}
