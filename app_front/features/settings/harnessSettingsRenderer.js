import '../../state/index.js';
/**
 * Generic renderer for the per-harness Settings screens. It reads each harness's
 * `settingsSchema` (see app_front/harnessSettingsSchemas.js) and wires the
 * credential rows, text fields and selects already present in the page: hint
 * lines from GET /api/settings flags, save / clear buttons, PATCH payloads and
 * credential revision signals. It never names a harness.
 */
import * as api from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import { getHarnessSettingsHooks, listHarnessSettingsSchemas, onHarnessSettingsSchemaAdded } from './models/harnessSettingsSchemas.js';

/** @typedef {import('../../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsSchema} HarnessSettingsSchema */
/** @typedef {import('../../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsHint} HarnessSettingsHint */
/** @typedef {import('../../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsSelectUi} HarnessSettingsSelectUi */

/**
 * @param {string} id
 * @returns {HTMLElement | null}
 */
function byId(id) {
  return document.getElementById(id);
}

/**
 * @param {string} id
 * @param {string} text
 */
function setText(id, text) {
  const el = byId(id);
  if (el) el.textContent = text;
}

/**
 * First rule whose flags are all truthy wins, else the fallback.
 *
 * @param {HarnessSettingsHint} hint
 * @param {Record<string, any>} data
 * @returns {string}
 */
function resolveHintText(hint, data) {
  const rule = hint.rules.find((row) => row.when.every((flag) => data[flag]));
  return t(rule ? rule.key : hint.fallbackKey);
}

/**
 * @param {HTMLElement | null} el
 * @param {HarnessSettingsSelectUi} select
 */
function fillSelectOptions(el, select) {
  if (!el || el.tagName !== 'CR-BAR-SELECT') return;
  /** @type {any} */ (el).options = select.options.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
}

/**
 * Wires every harness Settings screen and returns the renderer for settings snapshots.
 *
 * @returns {{ applySnapshot: (data: Record<string, any> | undefined) => void }}
 */
export function initHarnessSettingsScreens() {
  /** @type {HarnessSettingsSchema[]} */
  const schemas = [];
  /** @type {Record<string, any> | undefined} */
  let lastSnapshot;

  /**
   * @param {HarnessSettingsSchema} schema
   * @param {string} groupId
   * @param {Record<string, any> | undefined} data
   */
  function applyGroup(schema, groupId, data) {
    const { ui } = schema;
    const group = ui.groups.find((row) => row.group === groupId);
    for (const secret of ui.secrets.filter((row) => row.group === groupId)) {
      const input = byId(`${secret.prefix}-input`);
      if (input) /** @type {HTMLInputElement} */ (input).value = '';
      setText(`${secret.prefix}-save-status`, '');
    }
    for (const select of ui.selects.filter((row) => row.group === groupId)) {
      const el = byId(select.id);
      fillSelectOptions(el, select);
      const raw = data?.[select.field];
      if (!el || (select.applyOnlyWhenSet && !raw)) continue;
      if (el.tagName === 'CR-BAR-SELECT' || el.tagName === 'SELECT') {
        /** @type {any} */ (el).value = select.options.some((option) => option.value === raw) ? raw : select.fallback;
      }
    }
    for (const text of ui.texts.filter((row) => row.group === groupId)) {
      const input = byId(text.inputId);
      if (input && typeof data?.[text.field] === 'string') /** @type {HTMLInputElement} */ (input).value = data[text.field];
    }
    getHarnessSettingsHooks(schema.harness).afterApply?.(data);
    const hintEl = group ? byId(group.id) : null;
    if (!group || !hintEl) return;
    if (!data?.ok) {
      hintEl.textContent = '';
      return;
    }
    for (const text of ui.texts.filter((row) => row.group === groupId && row.hint)) {
      const textHintEl = byId(text.hint.id);
      if (textHintEl) textHintEl.textContent = resolveHintText(text.hint, data);
    }
    hintEl.textContent = resolveHintText(group, data);
  }

  /**
   * PATCH one change, report it in the status element and re-render the group.
   *
   * @param {HarnessSettingsSchema} schema
   * @param {string} groupId
   * @param {string | null} statusId
   * @param {Record<string, unknown>} payload
   * @param {{ saving: string, saved: string, errorKey: string }} texts
   */
  function patchAndApply(schema, groupId, statusId, payload, texts) {
    if (statusId) setText(statusId, texts.saving);
    const report = (text) => { if (statusId) setText(statusId, text); };
    api
      .patchSettings(payload)
      .then((data) => {
        if (!data?.ok) {
          report(data?.error || t(texts.errorKey));
          return;
        }
        applyGroup(schema, groupId, data);
        report(texts.saved);
        // The plugin's DOM contract also feeds the shared configuration signals.
        if (schema.ui.keyChangedEvent && statusId) window.dispatchEvent(new Event(schema.ui.keyChangedEvent));
      })
      .catch(() => report(t('lanSettings.connectionError')));
  }

  const SAVE_TEXTS = { saving: '', saved: '', errorKey: 'lanSettings.saveError' };

  /** @param {HarnessSettingsSchema} schema */
  function wireSchema(schema) {
    const { ui } = schema;
    for (const secret of ui.secrets) {
      const input = /** @type {HTMLInputElement | null} */ (byId(`${secret.prefix}-input`));
      const statusId = `${secret.prefix}-save-status`;
      const saveBtn = byId(`${secret.prefix}-save-btn`);
      if (saveBtn && input) {
        saveBtn.addEventListener('click', () => {
          const value = (input.value || '').trim();
          if (!value) {
            setText(statusId, t('lanSettings.pasteKeyFirst'));
            return;
          }
          const extra = getHarnessSettingsHooks(schema.harness).extraSavePayload?.(secret.field, value) || {};
          patchAndApply(schema, secret.group, statusId, { [secret.field]: value, ...extra }, {
            ...SAVE_TEXTS, saving: t('common.saving'), saved: t('common.saved'),
          });
        });
      }
      byId(`${secret.prefix}-clear-btn`)?.addEventListener('click', () => {
        patchAndApply(schema, secret.group, statusId, { [secret.clearFlag]: true }, {
          saving: t('common.removing'), saved: t('common.removed'), errorKey: 'lanSettings.error',
        });
      });
    }

    for (const text of ui.texts) {
      const input = /** @type {HTMLInputElement | null} */ (byId(text.inputId));
      byId(text.saveBtnId)?.addEventListener('click', () => {
        if (!input) return;
        patchAndApply(schema, text.group, text.statusId, { [text.field]: (input.value || '').trim() }, {
          ...SAVE_TEXTS, saving: t('common.saving'), saved: t('common.saved'),
        });
      });
    }

    for (const select of ui.selects) {
      const el = byId(select.id);
      if (!el) continue;
      fillSelectOptions(el, select);
      if (select.relabelOnLangChange) {
        window.addEventListener('cr-lang-changed', () => fillSelectOptions(el, select));
      }
      el.addEventListener(select.event, (event) => {
        const raw = select.event === 'cr-change'
          ? String(/** @type {CustomEvent} */ (event)?.detail?.value || '').trim()
          : String(/** @type {any} */ (el).value || '');
        const value = select.options.some((option) => option.value === raw) ? raw : select.fallback;
        patchAndApply(schema, select.group, select.statusId, { [select.field]: value }, {
          ...SAVE_TEXTS, saving: t('common.saving'), saved: t('common.saved'),
        });
      });
    }
  }

  /** @param {HarnessSettingsSchema} schema */
  function addSchema(schema) {
    if (schema.ui.groups.length === 0 || schemas.includes(schema)) return;
    schemas.push(schema);
    wireSchema(schema);
    // A plugin schema can arrive after the first snapshot; paint it with the latest one.
    if (lastSnapshot) for (const group of schema.ui.groups) applyGroup(schema, group.group, lastSnapshot);
  }

  for (const schema of listHarnessSettingsSchemas()) addSchema(schema);
  onHarnessSettingsSchemaAdded(addSchema);

  return {
    applySnapshot(data) {
      lastSnapshot = data;
      for (const schema of schemas) {
        for (const group of schema.ui.groups) applyGroup(schema, group.group, data);
      }
    },
  };
}
