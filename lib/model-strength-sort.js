/** UI strength ordering uses catalog heuristics, never prices or vendor benchmark claims. */
import { decodeModelValue } from './model-catalog.js';
import { estimateModelQualityTier } from './model-catalog-meta.js';
import { resolveModelFamily } from './model-alias-policy.js';

/** Tie-breaks inside the same quality tier; catalog strengthRank can override this UI prior. */
const FAMILY_ORDER = ['astra', 'sol', 'opus', 'grok', 'terra', 'sonnet', 'luna', 'mythos',
  'deepseek', 'hy4', 'hy3', 'kimi', 'composer', 'glm', 'qwen', 'mistral-large', 'flash', 'haiku', 'mini', 'nano'];
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'];

/** Resolve strength once per row while keeping encoded reasoning variants separate from model identity. */
export function resolveModelStrength(model) {
  const decoded = decodeModelValue(model.strengthModelValue || model.value || model.modelId || '');
  const modelId = decodeModelValue(model.modelId || decoded.modelId).modelId;
  const family = resolveModelFamily(modelId);
  const quality = Number.isFinite(model.qualityTier) ? model.qualityTier : estimateModelQualityTier(modelId);
  const hasRank = Number.isFinite(model.strengthRank);
  const isAutomatic = ['auto', 'default', ''].includes(String(modelId).toLowerCase());
  const known = !isAutomatic && (hasRank || Number.isFinite(model.qualityTier) || family.verified);
  const familyIndex = FAMILY_ORDER.indexOf(family.family);
  const params = Array.isArray(model.params) ? model.params : decoded.params || [];
  const effort = params.find((param) => ['effort', 'reasoning_effort', 'reasoningeffort', 'reasoning'].includes(String(param.id).toLowerCase()));
  const version = String(modelId).match(/\d+(?:[.-]\d+)*/)?.[0]?.split(/[.-]/).map(Number) || [];
  return { modelId, family: family.family, known, quality: known ? quality : 0,
    familyRank: familyIndex < 0 ? 0 : FAMILY_ORDER.length - familyIndex,
    explicitRank: hasRank ? model.strengthRank : quality,
    version, effort: Math.max(0, EFFORT_ORDER.indexOf(String(effort?.value || '').toLowerCase())) };
}

/** Compare base models strongest first; reasoning never promotes a weak family over a stronger one. */
export function compareModelStrength(left, right) {
  if (left.known !== right.known) return Number(right.known) - Number(left.known);
  if (left.explicitRank !== right.explicitRank) return right.explicitRank - left.explicitRank;
  if (left.familyRank !== right.familyRank) return right.familyRank - left.familyRank;
  if (left.known && left.family === right.family) {
    for (let index = 0; index < Math.max(left.version.length, right.version.length); index += 1) {
      const difference = (right.version[index] || 0) - (left.version[index] || 0);
      if (difference) return difference;
    }
  }
  return 0;
}

/** Keep all variants of a base model adjacent and sort their reasoning levels descending. */
export function sortModelOptionsByStrength(models, locale) {
  const compare = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }).compare;
  const groups = new Map();
  for (const model of models) {
    const strength = resolveModelStrength(model);
    const key = strength.modelId.toLowerCase();
    if (!groups.has(key)) groups.set(key, { strength, rows: [], label: model.label || key });
    groups.get(key).rows.push({ model, strength });
  }
  return [...groups.values()].sort((a, b) => compareModelStrength(a.strength, b.strength)
    || Number(a.rows.every((row) => row.model.disabled)) - Number(b.rows.every((row) => row.model.disabled))
    || compare(a.label, b.label)).flatMap((group) => group.rows.sort((a, b) => b.strength.effort - a.strength.effort
      || Number(a.model.disabled) - Number(b.model.disabled) || compare(a.model.label, b.model.label)).map((row) => row.model));
}

/** A harness is a transport: rank its group by its best catalog model, not a fabricated harness score. */
export function sortHarnessesByModelStrength(harnesses, locale) {
  const compare = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }).compare;
  return harnesses.map((harness) => ({ harness,
    best: harness.models.map(resolveModelStrength).sort(compareModelStrength)[0] || resolveModelStrength({ value: '' }),
  })).sort((a, b) => compareModelStrength(a.best, b.best) || compare(a.harness.label, b.harness.label))
    .map((row) => row.harness);
}
