/**
 * One automatic model-selection entry point for every feature that has to
 * choose a harness/model on its own (delegation `model_pick`, Workspace
 * Watcher orchestrator, Scout, future features).
 *
 * A feature names itself with a `purpose`; chats it creates are tagged with
 * `pickPurpose: <purpose>` (see `addChat` extras). Those chats count as role
 * usage next to delegation jobs, so the rotation / least-used balance applies
 * and the same top-ranked model is not picked forever.
 */

import { loadChats } from './persist/chats-persist.js';
import { buildModelPickHistory, delegationPersistedRole, ROLE_USAGE_WINDOW_MS } from './model-pick-history.js';
import { loadDelegationsReadonly } from './persist/delegations-persist.js';
import { buildCostProxyForPick, loadCostProxyConfig } from './model-pick-cost-proxy.js';
import { buildBenchmarkShadow } from './model-pick-benchmark.js';
import { readBenchmarkSnapshots } from './persist/benchmark-snapshots-persist.js';
import { selectModelPick } from './model-role-profiles.js';
import { resolvePlanWindowSettings } from './delegation-settings.js';
import { requestPlanLimitsRefresh } from './model-pick-plan-refresh.js';
import { classifyTaskComplexity } from './model-pick-complexity.js';
import { resolveComplexityShadowForPick } from './model-pick-complexity-classifier.js';
import { billingClassOfCandidate } from './model-pick-billing-class.js';
import { applyCostPolicyLayer } from './model-pick-cost-policy-layer.js';
import { persistModelPickProposal, persistModelPickShadowComparison } from './model-pick-decisions.js';
import { loadModelPickExploreAttempts } from './persist/model-pick-explore-persist.js';
import { getOpenRouterEndpointPricing } from './providers/openrouter/openrouter-pricing-cache.ts';
import {
  MODEL_PICK_SHADOW_CONFIG_DEFAULTS,
  composeModelPickShadowSegment,
  normalizeModelPickShadowConfig,
} from './model-pick-policy.js';
import { applyShadowLayer, loadModelPickShadowConfig } from './model-pick-shadow.js';
import { buildObservedMeasurementFactsForCandidates } from './model-pick-shadow-facts.js';
import {
  buildExploreAttemptMarker,
  countAutoExecutedWorkload,
  loadModelPickExploreConfig,
} from './model-pick-explore.js';
import { loadModelPickOverridesForSelection } from './persist/model-pick-overrides-persist.js';
import {
  applyModelPickOverridePreference,
  resolveModelPickOverrideDecision,
  summarizeOverrideDecision,
} from './model-pick-overrides.js';

/**
 * @typedef {ReturnType<typeof buildModelPickHistory>} ModelPickServiceHistory
 * @typedef {import('./model-role-profiles.js').ModelPickCandidate} ModelPickServiceCandidate
 * @typedef {import('./model-pick-shadow.js').ModelPickShadowIdentity} ModelPickServiceShadowIdentity
 * @typedef {import('./model-pick-shadow.js').ModelPickShadowCandidate} ModelPickServiceShadowCandidate
 */

/**
 * Chat row as the purpose-usage listing reads it.
 *
 * @typedef {object} ModelPickServiceChatRow
 * @property {string} [pickPurpose]
 * @property {string} [createdAt]
 * @property {string} [agentTransport]
 * @property {string} [model]
 */

/**
 * Caller-facing input of the pick entry points. It extends the
 * `selectModelPick` input with the service-level knobs (explore ledger,
 * shadow observer, overrides, cost policy, cost proxy, benchmark) and the
 * pass-through fields the history builder and the persistence layer read.
 *
 * @typedef {NonNullable<Parameters<typeof selectModelPick>[0]>
 *   & import('./model-pick-cost-policy-layer.js').ModelPickCostPolicyLayerInput & {
 *   role?: string,
 *   now?: number,
 *   selectModelPick?: typeof selectModelPick,
 *   dataDir?: string,
 *   leafSource?: string,
 *   leaf_source?: string,
 *   lockouts?: object[],
 *   delegations?: Record<string, any>[],
 *   planWindowConfig?: ReturnType<typeof resolvePlanWindowSettings>,
 *   planLimitsRefresh?: boolean,
 *   exploreLedger?: object,
 *   exploreConfig?: object,
 *   exploreLog?: (line: string) => void,
 *   exploreFile?: string,
 *   exploreContext?: unknown,
 *   exploreMetering?: unknown,
 *   shadow?: boolean,
 *   shadowConfig?: object,
 *   shadowFile?: string,
 *   shadowPriceFor?: import('./model-pick-shadow.js').ModelPickShadowScorerInput['priceFor'],
 *   shadowBillingClassOf?: import('./model-pick-shadow.js').ModelPickShadowScorerInput['billingClassOf'],
 *   shadowIdentityOf?: import('./model-pick-shadow.js').ModelPickShadowScorerInput['identityOf'],
 *   shadowMeasurementFacts?: object[],
 *   shadowMeasurementFor?: import('./model-pick-shadow.js').ModelPickShadowScorerInput['measurementFor'],
 *   overrides?: boolean,
 *   overrideDecision?: import('./model-pick-overrides.js').ModelPickOverrideDecision,
 *   overrideRows?: import('./model-pick-overrides.js').ModelPickOverrideRecord[],
 *   costProxyConfig?: import('./model-pick-cost-proxy.js').CostProxyConfig,
 *   openrouterPricingFor?: (model: string) => unknown,
 *   benchmarkSnapshots?: object[],
 *   benchmarkSourcePreferences?: Record<string, { enabled?: boolean }>,
 *   benchmarkFile?: string,
 *   history?: ModelPickServiceHistory,
 * }} ModelPickServiceInput
 */

/**
 * Pick result after the service layers (overrides, shadow observer, cost
 * policy). A failed pick carries `code` / `error` instead of a candidate.
 *
 * @typedef {object} ModelPickServiceResult
 * @property {boolean} ok
 * @property {string} [code]
 * @property {string} [error]
 * @property {ModelPickServiceCandidate} [pick]
 * @property {ModelPickServiceCandidate[]} [picks]
 * @property {ModelPickServiceCandidate[]} [candidates]
 * @property {object} [rotation]
 * @property {ModelPickServiceHistory} [history]
 * @property {{ level: string, signals: string[] }} [complexity]
 * @property {{ mode?: string }} [cost_policy]
 * @property {object | null} [planPace]
 * @property {Parameters<typeof buildExploreAttemptMarker>[0]} [explore]
 * @property {object} [overrides]
 * @property {import('./model-pick-shadow.js').ModelPickShadowTopSummary | null} [shadow_top]
 * @property {Record<string, unknown>} [shadow_explanation]
 * @property {import('./model-pick-shadow.js').ModelPickShadowResult['agreement']} [shadow_agreement]
 * @property {object | null} [benchmark]
 * @property {object | null} [costProxy]
 * @property {object | null} [complexityShadow]
 * @property {string} [pickId]
 * @property {string} [pickExpiresAt]
 * @property {string} [policyVersion]
 */

/**
 * @param {string} line
 */
function logWouldExplore(line) {
  // Same test suppression as the delegation log: unit tests capture the line
  // through `exploreLog`, the server prints it.
  if (process.env.CRETLI_TEST_DATA_DIR) return;
  console.info('[model-pick]', line);
}

/**
 * Durable inputs the exploration policy needs: the attempts already made (for
 * the deterministic order, the caps, and the pair cooldown) and the executed
 * automatic workload (the only denominator that earns explore credits).
 *
 * Both stores are optional: an unreadable store yields an empty ledger, which
 * simply leaves the budget at zero instead of inventing chances.
 *
 * @param {{ now?: number, workspaceFolder?: string, file?: string, exploreFile?: string, delegations?: Record<string, any>[] }} [input]
 * @returns {{ attempts: Record<string, any>[], autoExecuted: number, workspaceKey: string }}
 */
export function buildModelPickExploreLedger(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  let attempts = [];
  try {
    attempts = loadModelPickExploreAttempts({ file: input.exploreFile });
  } catch {
    attempts = [];
  }
  let delegations = input.delegations;
  if (!Array.isArray(delegations)) {
    try {
      delegations = loadDelegationsReadonly();
    } catch {
      delegations = [];
    }
  }
  const windowMs = loadModelPickExploreConfig().windowMs;
  return {
    attempts,
    autoExecuted: countAutoExecutedWorkload(delegations, { now, windowMs }),
    workspaceKey: String(input.workspaceFolder || '').trim(),
  };
}

/**
 * Model of the chat that asks for the pick (the orchestrator). Empty when the
 * chat is unknown or its model is `auto`, so no exclusion is added.
 *
 * @param {string} chatId
 * @returns {string}
 */
export function readControllerChatModel(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return '';
  try {
    const chat = loadChats().find((row) => row?.id === id);
    const model = String(chat?.model || '').trim();
    return model.toLowerCase() === 'auto' ? '' : model;
  } catch {
    return '';
  }
}

/**
 * Tagged chats of one purpose inside the usage window, as role usage rows.
 *
 * @param {string} purpose
 * @param {{ chats?: Record<string, any>[], now?: number }} [input]
 * @returns {{ harness: string, model: string, createdAt: string }[]}
 */
export function listPurposeUses(purpose, input = {}) {
  const wanted = String(purpose || '').trim();
  if (!wanted) return [];
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  let chats = input.chats;
  if (!Array.isArray(chats)) {
    try {
      chats = loadChats();
    } catch {
      chats = [];
    }
  }
  const out = [];
  for (const chat of chats) {
    if (String(chat?.pickPurpose || '') !== wanted) continue;
    const at = Date.parse(String(chat?.createdAt || ''));
    if (!Number.isFinite(at) || at < now - ROLE_USAGE_WINDOW_MS) continue;
    out.push({
      harness: String(chat?.agentTransport || '').trim(),
      model: String(chat?.model || '').trim(),
      createdAt: String(chat.createdAt),
    });
  }
  return out;
}

/**
 * Network-free default price lookup for the shadow observer: it resolves the
 * exact endpoint id through the stage-1 identity registry and reads the stage-3
 * cache synchronously. It never fetches, so the observer cannot add a request
 * to `model_pick`.
 *
 * @param {Record<string, any>} _candidate
 * @param {{ externalModelId?: string } | null} identity
 * @returns {Record<string, any> | null}
 */
function defaultShadowPriceFor(_candidate, identity) {
  const externalModelId = String(identity?.externalModelId || '').trim();
  if (!externalModelId) return null;
  return getOpenRouterEndpointPricing(externalModelId);
}

/**
 * Resolve the shadow policy for one call. `shadow: false` disables the observer
 * for the call; otherwise the explicit config wins over the operator file.
 *
 * @param {Record<string, any>} input
 * @returns {import('./model-pick-policy.js').ModelPickShadowConfig}
 */
function resolveShadowConfig(input) {
  if (input.shadow === false) {
    return normalizeModelPickShadowConfig({ ...MODEL_PICK_SHADOW_CONFIG_DEFAULTS, mode: 'off' });
  }
  return normalizeModelPickShadowConfig(input.shadowConfig ?? loadModelPickShadowConfig());
}

/**
 * `selectModelPick` plus usage history (delegations + chats of `purpose`) plus
 * the durable out-of-band exploration ledger. Accepts every `selectModelPick`
 * input; `history` overrides the built one.
 *
 * Exploration is the picker's own decision, not a feature of one caller: this
 * entry point is what `model_pick`, the Watcher orchestrator and the Scout all
 * use, so all three read the same explore policy and the same budget.
 * `explore: false` turns the assessment off for a call.
 *
 * The explainable shadow observer (stage 4) runs after the pick and adds
 * `shadow_top` / `shadow_explanation` / `shadow_agreement` to the result. It
 * never changes `pick`, `picks` or `candidates`; `shadow: false` (or
 * `shadowConfig.mode: 'off'`) returns the pre-shadow response unchanged.
 *
 * Stage 7 feeds the observer provenance-labelled measurements: by default the
 * speed facts already present in each candidate's history block, or an explicit
 * bounded `shadowMeasurementFacts` list / `shadowMeasurementFor` getter. This
 * input is bounded and network-free, and the selected pick is identical either
 * way.
 *
 * @param {Record<string, any>} input
 * @param {string} [input.purpose]
 * @param {string} [input.chatId]
 * @param {typeof selectModelPick} [input.selectModelPick]
 * @param {Record<string, any>[]} [input.shadowMeasurementFacts]
 * @param {(candidate: Record<string, any>, identity: Record<string, any>) => Record<string, any> | null} [input.shadowMeasurementFor]
 * The cost policy layer (`model-pick-cost-policy-layer.js`) wraps this call:
 * `shadow` (default) only records the verdict, `enforce` re-runs the picker
 * with rejected pairs excluded; `costPolicy: false` skips it.
 *
 * @returns {ModelPickServiceResult}
 */
export function pickModelForPurpose(input = {}) {
  const first = pickModelForPurposeUnconstrained(input);
  // Reuse the exact history ranked by the picker, including internally built history.
  const costInput = !input.history && first.history ? { ...input, history: first.history } : input;
  if (input.costPolicy === false) {
    // The cost policy layer normally attaches the classification; with the layer
    // skipped, the result must still carry level + signals so a persisted pick is
    // never stored without them.
    return first.complexity ? first : { ...first, complexity: classifyPickComplexity(costInput) };
  }
  return applyCostPolicyLayer(costInput, first, (next) => pickModelForPurposeUnconstrained({ ...next }));
}

/**
 * Shadow-only classification for a pick result that carries none. The input
 * mapping mirrors the cost policy layer so both paths read one snapshot.
 *
 * @param {Record<string, any>} input
 * @returns {{ level: string, signals: string[] }}
 */
function classifyPickComplexity(input) {
  return classifyTaskComplexity({
    role: input.role,
    leafBody: input.leafBody,
    leafSize: input.leafSize,
    heavy: input.heavy === true,
    complexity: input.complexityLevel ?? input.complexity,
    history: input.history,
    sourceKind: input.sourceKind,
    exists: input.leafExists,
  });
}

/**
 * @param {Record<string, any>} [input]
 * @returns {ReturnType<typeof selectModelPick>}
 */
function pickModelForPurposeUnconstrained(input = {}) {
  const {
    purpose,
    chatId,
    selectModelPick: picker,
    exploreLedger,
    exploreConfig,
    exploreLog,
    shadow,
    shadowConfig,
    shadowPriceFor,
    shadowBillingClassOf,
    shadowIdentityOf,
    shadowMeasurementFacts,
    shadowMeasurementFor,
    ...rest
  } = input;
  const select = typeof picker === 'function' ? picker : selectModelPick;
  // Settings feed the plan-window mode unless the caller injects a config.
  if (rest.planWindowConfig === undefined && String(rest.workspaceFolder || '').trim()) {
    rest.planWindowConfig = resolvePlanWindowSettings(rest.workspaceFolder, { dataDir: rest.dataDir });
  }
  const history = rest.history || buildModelPickHistory({
    role: rest.role,
    chatId,
    controllerModel: rest.controllerModel ?? readControllerChatModel(chatId),
    leafId: rest.leafId ?? rest.leaf_id ?? rest.todoId ?? rest.todo_id,
    harnesses: rest.harnesses,
    workspaceFolder: rest.workspaceFolder,
    dataDir: rest.dataDir,
    // Caller-injected lockouts/rows must reach the history even when the caller
    // also passes `excludeModels`/`usageLimits` directly to the picker.
    lockouts: rest.lockouts,
    delegations: rest.delegations,
    planWindowConfig: rest.planWindowConfig,
    // Optional store-free injection points (tests); undefined keeps the disk readers.
    planLimits: rest.planLimits,
    outcomes: rest.outcomes,
    freshLimitHits: rest.freshLimitHits,
    extraUses: listPurposeUses(purpose, { now: rest.now }),
  });
  // Best-effort and detached: the pick below never waits for the provider; an
  // aged reading only makes a later pick better informed. Skipped for injected
  // history (tests) so no provider is contacted.
  if (!rest.history && rest.planLimitsRefresh !== false && rest.planWindowConfig?.enabled !== false) {
    try {
      requestPlanLimitsRefresh({
        planLimits: history.planLimits,
        now: rest.now,
        dataDir: rest.dataDir,
        // Optional stub injection point for tests; production passes none.
        refreshers: rest.planLimitsRefreshers,
      });
    } catch { /* refresh is optional */ }
  }
  const exploration = rest.explore === false
    ? {}
    : {
      exploreConfig: exploreConfig ?? loadModelPickExploreConfig(),
      exploreLedger: exploreLedger ?? buildModelPickExploreLedger({
        now: rest.now,
        workspaceFolder: rest.workspaceFolder,
        exploreFile: rest.exploreFile,
        delegations: rest.delegations,
      }),
      exploreContext: rest.exploreContext,
      exploreMetering: rest.exploreMetering,
      exploreLog: typeof exploreLog === 'function' ? exploreLog : logWouldExplore,
    };
  // Audited overrides are a layer above the ranking, loaded from the one durable
  // store unless the caller injects a decision/rows (tests) or disables them.
  // A precedence conflict refuses the whole selection before any candidate is
  // ranked; the active excludes are merged into the picker's own hard filters so
  // a target pair cannot slip through as a non-winner.
  const overrideDecision = rest.overrides === false
    ? null
    : (rest.overrideDecision && typeof rest.overrideDecision === 'object'
      ? /** @type {import('./model-pick-overrides.js').ModelPickOverrideDecision} */ (rest.overrideDecision)
      : resolveModelPickOverrideDecision({
        overrides: Array.isArray(rest.overrideRows)
          ? rest.overrideRows
          : loadModelPickOverridesForSelection({ workspaceFolder: rest.workspaceFolder, now: rest.now }),
        now: rest.now,
        workspaceFolder: rest.workspaceFolder,
        role: rest.role,
      }));
  if (overrideDecision?.conflict) {
    return {
      ok: false,
      code: 'override_conflict',
      error: 'Conflicting explicit-orchestrator overrides apply to this selection.',
      overrides: summarizeOverrideDecision(overrideDecision),
    };
  }
  const mergedExcludes = {
    excludeModels: [
      ...(Array.isArray(rest.excludeModels) ? rest.excludeModels : []),
      ...(overrideDecision ? overrideDecision.excludedModels : []),
    ],
    excludeHarnesses: [
      ...(Array.isArray(rest.excludeHarnesses) ? rest.excludeHarnesses : []),
      ...(overrideDecision ? overrideDecision.excludedHarnesses : []),
    ],
    excludePairs: [
      ...(Array.isArray(rest.excludePairs) ? rest.excludePairs : []),
      ...(overrideDecision ? overrideDecision.excludedPairs : []),
    ],
  };
  const picked = select({ ...rest, ...mergedExcludes, history, ...exploration });
  const withOverrides = applyModelPickOverridePreference(picked, overrideDecision);
  // Default measurement input: the speed facts the pick already carries locally,
  // labelled with provenance instead of an anonymous `observed` block. A caller
  // may override with an explicit bounded fact list or a per-candidate getter;
  // an explicit getter suppresses the default so the two never mix.
  const measurementFor = typeof shadowMeasurementFor === 'function' ? shadowMeasurementFor : undefined;
  const measurementFacts = measurementFor
    ? undefined
    : (Array.isArray(shadowMeasurementFacts)
      ? shadowMeasurementFacts
      : buildObservedMeasurementFactsForCandidates(withOverrides.candidates, { role: rest.role }));
  const result = applyShadowLayer(withOverrides, {
    role: rest.role,
    now: rest.now,
    enabled: shadow !== false,
    config: shadowConfig ?? loadModelPickShadowConfig(),
    priceFor: typeof shadowPriceFor === 'function' ? shadowPriceFor : defaultShadowPriceFor,
    // Production default: harness + provider -> billing class, so USD stays
    // restricted to api_metered pairs even when the caller injects nothing.
    billingClassOf: typeof shadowBillingClassOf === 'function' ? shadowBillingClassOf : billingClassOfCandidate,
    identityOf: shadowIdentityOf,
    measurementFacts,
    measurementFor,
  });
  // Return the exact history object the picker ranked against to a caller that
  // may inject none (`input.history` absent). `pickAndPersistModelForPurpose`
  // classifies that object so the complexity signal sees the real history.
  return /** @type {ModelPickServiceResult} */ ({ ...result, history });
}

/**
 * Shadow cost proxy (RCU) for the picked and audit candidates. It reads
 * delegation history for token medians and never feeds the selection; a failure
 * degrades to no proxy rather than failing the pick.
 *
 * @param {Record<string, any>} input
 * @param {Record<string, any>} picked
 * @param {{ level: string } | null} complexity
 * @returns {Record<string, any> | null}
 */
function computeCostProxyForPick(input, picked, complexity) {
  try {
    const rows = Array.isArray(input.delegations) ? input.delegations : loadDelegationsReadonly();
    return buildCostProxyForPick({
      pickResult: picked,
      role: input.role,
      level: complexity?.level,
      rows,
      roleOfRow: delegationPersistedRole,
      config: input.costProxyConfig ?? loadCostProxyConfig(),
      openrouterPricingFor: input.openrouterPricingFor,
    });
  } catch {
    return null;
  }
}

/**
 * Shadow benchmark block (plan §2.5). Reads local snapshots only (no network);
 * missing or unreadable data degrades to no block and never affects the pick.
 *
 * @param {Record<string, any>} input
 * @param {Record<string, any>} picked
 * @param {{ level: string } | null} complexity
 * @returns {Record<string, any> | null}
 */
function computeBenchmarkForPick(input, picked, complexity) {
  try {
    /** @type {{ snapshots?: object[], sourcePreferences?: Record<string, { enabled?: boolean }> }} */
    const stored = Array.isArray(input.benchmarkSnapshots)
      ? { snapshots: input.benchmarkSnapshots, sourcePreferences: input.benchmarkSourcePreferences }
      : readBenchmarkSnapshots({ filePath: input.benchmarkFile, now: input.now });
    if (!stored.snapshots?.length) return null;
    return buildBenchmarkShadow({
      role: input.role,
      level: complexity?.level,
      selected: picked.pick,
      candidates: picked.candidates,
      snapshots: stored.snapshots,
      sourcePreferences: stored.sourcePreferences,
      now: input.now,
    });
  } catch {
    return null;
  }
}

/**
 * Run {@link pickModelForPurpose} and persist a bounded proposal when the pick succeeds.
 *
 * When the observer produced an agreement record it is appended to the durable
 * shadow comparison window (per-role agreement counters + recent rows). The
 * pick record itself and the selection are untouched.
 *
 * @param {Record<string, any>} input
 * @returns {ReturnType<typeof pickModelForPurpose> & { pickId?: string, pickExpiresAt?: string, policyVersion?: string }}
 */
export function pickAndPersistModelForPurpose(input = {}) {
  // Read the durable snapshots once: the usage history/explore ledger, the
  // cost-policy canary join and the shadow cost proxy all need the same
  // delegation rows, and the proxy also needs one cost-proxy config. Callers
  // may still inject either; direct callers keep the lazy fallback.
  const shared = { ...input };
  if (!Array.isArray(shared.delegations)) {
    try {
      shared.delegations = loadDelegationsReadonly();
    } catch {
      shared.delegations = [];
    }
  }
  if (!shared.costProxyConfig) {
    shared.costProxyConfig = loadCostProxyConfig();
  }
  if (!Array.isArray(shared.costPolicyDelegations)) {
    shared.costPolicyDelegations = shared.delegations;
  }
  const picked = pickModelForPurpose(shared);
  const shadowConfig = resolveShadowConfig(input);
  // Enforced cost policy changes pick semantics: a distinct policy-version cohort.
  const enforced = picked.cost_policy?.mode === 'enforce';
  const shadowSegment = [composeModelPickShadowSegment(shadowConfig), enforced ? 'cost-policy=enforce' : '']
    .filter(Boolean).join(',');
  // Shadow signal: computed for every pick (also without a leaf) so each
  // decision carries level + signals. It never feeds the selection above.
  const complexity = picked.complexity || classifyPickComplexity({ ...input, history: picked.history ?? input.history });
  if (!picked.ok) return { ...picked, complexity };
  const costProxy = computeCostProxyForPick(shared, picked, complexity);
  const benchmark = computeBenchmarkForPick(input, picked, complexity);
  // Optional decision-classifier shadow: a synchronous cache read; a miss
  // schedules a detached classification and this record carries no block.
  // It runs after the selection and the cost policy, so neither can read it.
  const complexityShadow = resolveComplexityShadowForPick(input);
  const persisted = persistModelPickProposal({
    complexity,
    complexityShadow,
    costProxy,
    benchmark,
    costPolicy: picked.cost_policy,
    chatId: input.chatId,
    workspaceFolder: input.workspaceFolder,
    purpose: input.purpose,
    role: input.role,
    leafId: input.leafId ?? input.leaf_id ?? input.todoId ?? input.todo_id,
    leafSource: input.leafSource ?? input.leaf_source,
    pickResult: picked,
    // The pick-time weekly pace snapshot (same `now`/planLimits as the
    // decision) so a start can show the snapshot the pick actually used.
    planPace: picked.planPace ?? null,
    // The pair an exploration chose, so a start can bind its durable attempt to
    // this proposal. Dry-run records the candidate only: no start, no attempt,
    // no budget consumed.
    explore: buildExploreAttemptMarker(picked.explore, input.role),
    shadowSegment,
    now: input.now,
    file: input.file,
  });
  if (picked.shadow_agreement) {
    persistModelPickShadowComparison({
      role: input.role,
      agreement: picked.shadow_agreement,
      reviewPassRateInfluencesScore: picked.shadow_explanation?.review_pass_rate_in_quality_score === true,
      // The scoring segment names the normalization the comparison was taken
      // under; a change restarts the agreement window rather than mixing.
      segment: shadowSegment,
      now: input.now,
      file: input.shadowFile,
    });
  }
  // The benchmark block (with attribution) rides along in the shadow
  // explanation; candidates and shadow_top are untouched.
  const shadowExplanation = benchmark && picked.shadow_explanation
    ? { ...picked.shadow_explanation, benchmark }
    : picked.shadow_explanation;
  return {
    ...picked,
    ...(shadowExplanation ? { shadow_explanation: shadowExplanation } : {}),
    benchmark,
    pickId: persisted.pickId,
    pickExpiresAt: persisted.expiresAt,
    policyVersion: persisted.policyVersion,
    complexity,
    ...(complexityShadow ? { complexityShadow } : {}),
    costProxy,
  };
}
