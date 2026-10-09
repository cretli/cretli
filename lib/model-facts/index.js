/**
 * Barrel for the shared scoring/usage fact schema (stage 1 of `2584cd05`).
 * Identity resolution and the versioned fact schema are kept in separate files
 * so a caller can import identity alone (no fact normalization, no pricing).
 */

export {
  ALIAS_REASONS,
  ALIAS_STATUSES,
  DEFAULT_MODEL_IDENTITY_ALIASES,
  MODEL_IDENTITY_SCHEMA_VERSION,
  buildModelIdentityIndex,
  defaultModelIdentityIndex,
  isAliasStatus,
  modelIdentityKey,
  normalizeIdentityPart,
  resolveModelIdentity,
} from './identity.js';

export {
  SCORING_FACT_BILLING_CLASSES,
  SCORING_FACT_CANDIDATE_GATE,
  SCORING_FACT_KINDS,
  SCORING_FACT_METRICS,
  SCORING_FACT_SCHEMA_VERSION,
  SCORING_FACT_SOURCE_CLASSES,
  compareScoringFacts,
  createScoringFact,
  describeScoringFactPrecedence,
  factInfluencesRanking,
  factMayCarryUsd,
  factUsdValue,
  isScoringFactAliasStatus,
  normalizeBillingClass,
  normalizeScoringFactKind,
  normalizeSourceClass,
  resolvePreferredFact,
  selectPreferredFacts,
} from './schema.js';

export {
  TELEMETRY_INFRA_PENALTY_RATIO,
  TELEMETRY_LOCAL_PROVIDERS,
  TELEMETRY_METERED_PROVIDERS,
  TELEMETRY_RUN_CLASSES,
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_SHRINKAGE_HALF_LIFE,
  TELEMETRY_SUBSCRIPTION_HARNESSES,
  TELEMETRY_SUBSCRIPTION_PROVIDERS,
  TELEMETRY_TOKEN_METRICS,
  billingClassAllowsUsd,
  buildLimitLink,
  buildModelHarnessTelemetry,
  buildPlanUsageFact,
  buildTaskQualityTelemetry,
  buildTokenFacts,
  buildUsdEstimateFact,
  normalizeTelemetryRunClass,
  planUsageRef,
  resolveTelemetryBillingClass,
} from './telemetry.js';
