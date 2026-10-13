import { resolveNewChatUsageLimit, getNewChatLimitResetTime } from './newChatUsageLimit.js';
import { sortHarnessesByModelStrength, sortModelOptionsByStrength } from '../../../lib/model-strength-sort.js';

/** One stable value carries both choices through the searchable select. */
export function encodeNewChatModelChoice(harness, model) {
  return JSON.stringify([harness, model]);
}

/** Validate a custom-select value before applying it to the form. */
export function decodeNewChatModelChoice(value) {
  try {
    const pair = JSON.parse(value);
    return Array.isArray(pair) && pair.length === 2 && pair.every((item) => typeof item === 'string')
      ? { harness: pair[0], model: pair[1] } : null;
  } catch {
    return null;
  }
}

/** Build sorted groups without mutating catalogs or the selected harness. */
export function buildNewChatModelOptions(harnesses, lockouts, t, { limitsPending = false, locale } = {}) {
  return sortHarnessesByModelStrength(harnesses, locale).flatMap((harness) => {
    const models = harness.models.length ? harness.models : [{ value: '', label: t('chat.newNoModels') }];
    const options = models.map((model) => {
      const limit = resolveNewChatUsageLimit(lockouts, harness.id, model.value);
      const disabled = harness.ready !== true || !model.value || !!limit || limitsPending || model.settingsDisabled === true;
      const checking = harness.checking || limitsPending;
      let description = '';
      let status = t('chat.newModelReady');
      if (limit) {
        status = t(limit.code === 'model_unavailable' ? 'chat.newModelUnavailable' : 'chat.newLimitedBadge');
        const time = getNewChatLimitResetTime(limit, locale);
        description = limit.code === 'model_unavailable' ? t('chat.newUnavailable')
          : time ? t('chat.newLimitReset', { time }) : t('chat.newLimit');
      } else if (harness.ready === false) {
        status = t('chat.newModelUnavailable');
        description = harness.error;
      } else if (checking) {
        status = t('chat.newChecking');
      } else if (model.settingsDisabled) {
        status = t('chat.newModelUnavailable');
        description = t('chat.newModelDisabledSettings');
      } else if (disabled) {
        status = t('chat.newModelUnavailable');
        description = t('chat.newAvailabilityUnknown');
      }
      return { value: encodeNewChatModelChoice(harness.id, model.value), label: model.label,
        group: harness.label, keywords: `${harness.id} ${model.value}`, disabled, status, description,
        modelId: model.modelId || model.value.split('::')[0], strengthModelValue: model.value, params: model.params,
        qualityTier: model.qualityTier, strengthRank: model.strengthRank };
    });
    return sortModelOptionsByStrength(options, locale);
  });
}
