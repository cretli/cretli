import { resolveNewChatUsageLimit, getNewChatLimitResetTime, getNewChatLimitCountdown } from './newChatUsageLimit.js';
import { sortHarnessesByModelStrength, sortModelOptionsByStrength } from '../../../lib/model-strength-sort.js';
import { EFFORT_DISPLAY_ORDER, formatModelDisplay } from './modelDisplay.js';

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
      // A ready model needs no badge; only problems (limit, unavailable, checking) are labelled.
      let status = '';
      if (limit) {
        status = t(limit.code === 'model_unavailable' ? 'chat.newModelUnavailable' : 'chat.newLimitedBadge');
        const time = getNewChatLimitResetTime(limit, locale);
        description = limit.code === 'model_unavailable' ? t('chat.newUnavailable')
          : time ? t('chat.newLimitReset', { time }) : t('chat.newLimit');
        const countdown = getNewChatLimitCountdown(limit);
        if (countdown && time) {
          const remaining = countdown.hours
            ? t('chat.newLimitCountdownHours', { hours: countdown.hours, minutes: countdown.minutes })
            : t('chat.newLimitCountdownMinutes', { minutes: countdown.minutes });
          description = t('chat.newLimitResetIn', { time, remaining });
        }
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
      // A real model gets a readable name, an effort pill and its raw id as a muted line;
      // `label` keeps name + effort so closed triggers and aria still tell variants apart.
      const display = model.value ? formatModelDisplay(model.value, model.label) : null;
      const tag = display?.effort ? t(`sdkBlock.effortLevel.${display.effort}`) : '';
      const label = display ? [display.name, tag].filter(Boolean).join(' · ') : model.label;
      // Effort variants of one model collapse into a single picker row with chips.
      const variant = display?.effort ? {
        variantOf: `${harness.id}\u0000${display.id}`,
        variantLabel: t(`sdkBlock.effortShort.${display.effort}`),
        variantRank: EFFORT_DISPLAY_ORDER.indexOf(display.effort),
        isDefault: model.isDefault === true,
      } : {};
      return { value: encodeNewChatModelChoice(harness.id, model.value), label, ...variant,
        name: display?.name || '', tag, meta: display?.id && display.id !== display.name ? display.id : '',
        group: harness.label, keywords: `${harness.id} ${model.value}`, disabled, status, description,
        modelId: model.modelId || model.value.split('::')[0], strengthModelValue: model.value, params: model.params,
        qualityTier: model.qualityTier, strengthRank: model.strengthRank };
    });
    return sortModelOptionsByStrength(options, locale);
  });
}
