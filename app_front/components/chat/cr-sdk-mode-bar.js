import { LitElement, html } from 'lit';
import { modeBarStyles } from './cr-sdk-mode-bar.styles.js';
import '../ui/cr-searchable-select.js';
import { initDropdown } from '../../lib/dropdown.js';
import { t } from '../../i18n/index.js';
import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.ts';
import { getHarnessUiMeta, listHarnessUiMeta } from '../../core/harness/harnessUiRegistry.js';
import { formatContextRingCenterLabel } from '../../../lib/sdk/sdk-context-advisory.ts';
import { getHarnessBadge } from '../../core/harness/harnessBadge.js';
import { effortBarCount, formatModelDisplay } from '../../features/chat/modelDisplay.js';

const BUSY_TONES = new Set(['active', 'generating', 'running', 'grepping', 'reading', 'thinking', 'editing']);
const ATTENTION_TONES = new Set(['awaiting', 'waiting', 'attention', 'approval', 'question', 'choice', 'textarea']);
const SYNC_TONES = new Set(['connecting', 'syncing']);

/**
 * Indicator shape for a status tone. `sync` tones are short-lived connection or
 * catch-up states and are the only ones mirrored in the floating pill.
 *
 * @param {string} tone
 * @returns {'busy' | 'attention' | 'sync' | 'offline' | 'idle'}
 */
export function statusIndicatorKind(tone) {
  if (SYNC_TONES.has(tone)) return 'sync';
  if (BUSY_TONES.has(tone)) return 'busy';
  if (ATTENTION_TONES.has(tone)) return 'attention';
  if (tone === 'disconnected') return 'offline';
  return 'idle';
}

class CrSdkModeBar extends LitElement {
  static properties = {
    mode: { type: String },
    showBuild: { type: Boolean, attribute: 'show-build' },
    statusLabel: { type: String, attribute: 'status-label' },
    statusTone: { type: String, attribute: 'status-tone' },
    harness: { type: String },
    model: { type: String },
    models: { attribute: false },
    pickerOptions: { attribute: false },
    pickerHarnessLabels: { attribute: false },
    pickerHarness: { type: String },
    pickerLabels: { attribute: false },
    contextPercent: { type: Number, attribute: 'context-percent' },
    contextLevel: { type: String, attribute: 'context-level' },
    contextLabel: { type: String, attribute: 'context-label' },
    contextEstimated: { type: Boolean, attribute: 'context-estimated' },
    contextVisible: { type: Boolean, attribute: 'context-visible' },
    pickerStep: { type: String, attribute: false },
    pendingHarness: { type: String, attribute: false },
    enabledHarnesses: { attribute: false },
  };

  static styles = modeBarStyles;

  constructor() {
    super();
    this.mode = 'agent';
    this.showBuild = false;
    this.harness = 'sdk';
    this.model = '';
    this.models = [];
    this.pickerOptions = [];
    this.pickerHarnessLabels = {};
    this.pickerHarness = '';
    this.pickerLabels = {};
    this.statusLabel = '';
    this.statusTone = 'connecting';
    this._pillLabel = '';
    this.contextPercent = null;
    this.contextLevel = 'none';
    this.contextLabel = '';
    this.contextEstimated = false;
    this.contextVisible = false;
    this.pickerStep = 'harness';
    this.pendingHarness = '';
    this._buildMenuReady = false;
    this._buildDropdownApi = null;
    this._buildMenuEl = null;
    this._buildTriggerEl = null;
    this._modeMenuReady = false;
    this._modeDropdownApi = null;
    this._modeMenuEl = null;
    this._modeTriggerEl = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._onLangChanged = () => this.requestUpdate();
    window.addEventListener('cr-lang-changed', this._onLangChanged);
  }

  disconnectedCallback() {
    window.removeEventListener('cr-lang-changed', this._onLangChanged);
    this.destroyModeMenu();
    this.destroyBuildMenu();
    super.disconnectedCallback();
  }

  updated() {
    this.ensureModeMenu();
    if (!this.showBuild) {
      if (this._buildMenuReady) this.destroyBuildMenu();
      return;
    }
    this.ensureBuildMenu();
  }

  normalizeBarHarness(value, fallback = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (getHarnessUiMeta(raw)?.modeBarNormalized) return raw;
    return fallback;
  }

  hasPendingHarnessSwitch() {
    const pending = this.normalizeBarHarness(this.pendingHarness, '');
    if (!pending) return false;
    const current = this.normalizeBarHarness(this.harness, 'sdk');
    return pending !== current;
  }

  _getNormalizedModels() {
    const rows = Array.isArray(this.models) ? this.models : [];
    const seen = new Set();
    const next = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const value = String(row.value || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const label = String(row.label || value).trim() || value;
      next.push({ value, label });
    }
    const currentValue = String(this.model || '').trim();
    if (currentValue && !seen.has(currentValue)) {
      next.push({ value: currentValue, label: currentValue });
    }
    return next;
  }

  handleModelSelect(nextModel) {
    const normalized = String(nextModel || '').trim() || 'auto';
    if (this.normalizePickerStep(this.pickerStep) === 'model') {
      this.dispatchEvent(
        new CustomEvent('cr-sdk-harness-commit', {
          detail: {
            harness: this.normalizeBarHarness(this.pendingHarness, ''),
            model: normalized,
          },
          bubbles: true,
          composed: true,
        })
      );
      return;
    }
    if (normalized === this.model) return;
    this.dispatchEvent(
      new CustomEvent('cr-sdk-model-change', {
        detail: { model: normalized },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Grouped harness+model picker (same rows as the new-chat modal): [harness, model] JSON values. */
  handleGroupedPickerChange(event) {
    let pair = null;
    try {
      pair = JSON.parse(String(event?.detail?.value || ''));
    } catch {
      return;
    }
    if (!Array.isArray(pair) || pair.length !== 2 || !pair[0] || !pair[1]) return;
    const [harness, model] = pair;
    const option = this.pickerOptions.find((row) => row.value === event.detail.value);
    if (!option || option.disabled) return;
    if (this.normalizeBarHarness(harness, 'sdk') !== this.normalizeBarHarness(this.harness, 'sdk')) {
      this.dispatchEvent(new CustomEvent('cr-sdk-harness-commit', {
        detail: { harness, model }, bubbles: true, composed: true,
      }));
      return;
    }
    if (model === this.model) return;
    this.dispatchEvent(new CustomEvent('cr-sdk-model-change', {
      detail: { model }, bubbles: true, composed: true,
    }));
  }

  handleGroupedFavoriteToggle(event) {
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent('cr-sdk-favorite-toggle', {
      detail: { value: event.detail?.value }, bubbles: true, composed: true,
    }));
  }

  handleModelChange(event) {
    const nextModel = event?.detail?.value;
    this.handleModelSelect(nextModel);
  }

  normalizePickerStep(step) {
    return step === 'model' ? 'model' : 'harness';
  }

  handleModeClick(nextMode) {
    const normalized = normalizeSdkMode(nextMode);
    this._modeDropdownApi?.close();
    if (this.mode === normalized) return;
    this.mode = normalized;
    this.showBuild = normalized === 'plan';
    this.dispatchEvent(
      new CustomEvent('cr-sdk-mode-change', {
        detail: { mode: normalized },
        bubbles: true,
        composed: true,
      })
    );
  }

  handleModeMenuToggle(event) {
    event.preventDefault();
    event.stopPropagation();
    this._buildDropdownApi?.close();
    this.ensureModeMenu();
    this._modeDropdownApi?.toggle();
  }

  handleHarnessChange(event) {
    const normalized = this.normalizeBarHarness(event?.detail?.value, 'sdk');
    const current = this.normalizeBarHarness(this.harness, 'sdk');
    if (normalized === current) {
      const hadPending = this.hasPendingHarnessSwitch();
      this.pendingHarness = '';
      if (!hadPending) return;
      this.dispatchEvent(
        new CustomEvent('cr-sdk-harness-cancel', {
          bubbles: true,
          composed: true,
        })
      );
      return;
    }
    this.pendingHarness = normalized;
    this.dispatchEvent(
      new CustomEvent('cr-sdk-harness-intent', {
        detail: { harness: normalized },
        bubbles: true,
        composed: true,
      })
    );
  }

  keepPickerOpenAfterStepChange(pickerEl) {
    const reopenPicker = () => {
      pickerEl?.refreshOptions?.();
      pickerEl?.openDropdown?.();
    };
    void this.updateComplete.then(() => {
      reopenPicker();
      window.requestAnimationFrame(reopenPicker);
    });
  }

  handleCombinedSelectionChange(event) {
    const nextValue = String(event?.detail?.value || '').trim();
    if (!nextValue) return;
    const pickerEl = event?.currentTarget;
    if (nextValue === 'step::harness') {
      event.preventDefault();
      const hadPending = this.hasPendingHarnessSwitch();
      this.pendingHarness = '';
      this.pickerStep = 'harness';
      if (hadPending) {
        this.dispatchEvent(
          new CustomEvent('cr-sdk-harness-cancel', {
            bubbles: true,
            composed: true,
          })
        );
      }
      this.keepPickerOpenAfterStepChange(pickerEl);
      return;
    }
    if (nextValue.startsWith('harness::')) {
      event.preventDefault();
      const nextHarness = nextValue.slice('harness::'.length);
      this.handleHarnessChange({ detail: { value: nextHarness } });
      this.pickerStep = 'model';
      this.keepPickerOpenAfterStepChange(pickerEl);
      return;
    }
    if (nextValue.startsWith('model::')) {
      const nextModel = nextValue.slice('model::'.length);
      this.handleModelSelect(nextModel);
      if (!this.hasPendingHarnessSwitch()) this.pickerStep = 'harness';
      pickerEl?.closeDropdown?.();
      return;
    }
  }

  handleBuildMenuToggle(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.showBuild) return;
    this._modeDropdownApi?.close();
    this.ensureBuildMenu();
    this._buildDropdownApi?.toggle();
  }

  handleBuildClick() {
    this._buildDropdownApi?.close();
    this.dispatchEvent(
      new CustomEvent('cr-sdk-build-plan', {
        bubbles: true,
        composed: true,
      })
    );
  }

  handleBuildNewAgentClick() {
    this._buildDropdownApi?.close();
    this.dispatchEvent(
      new CustomEvent('cr-sdk-build-plan-new-agent', {
        bubbles: true,
        composed: true,
      })
    );
  }

  destroyBuildMenu() {
    this._buildDropdownApi?.close();
    if (this._buildDropdownApi) {
      this._buildDropdownApi.destroy();
      this._buildDropdownApi = null;
    }
    if (this._buildMenuEl) {
      this._buildMenuEl.remove();
      this._buildMenuEl = null;
    }
    this._buildTriggerEl = null;
    this._buildMenuReady = false;
  }

  destroyModeMenu() {
    this._modeDropdownApi?.close();
    if (this._modeDropdownApi) {
      this._modeDropdownApi.destroy();
      this._modeDropdownApi = null;
    }
    if (this._modeMenuEl) {
      this._modeMenuEl.remove();
      this._modeMenuEl = null;
    }
    this._modeTriggerEl = null;
    this._modeMenuReady = false;
  }

  modeLabel(mode) {
    const normalized = normalizeSdkMode(mode);
    if (normalized === 'plan') return t('sdkBlock.modePlan');
    if (normalized === 'ask') return t('sdkBlock.modeAsk');
    return t('sdkBlock.modeAgent');
  }

  renderModeMenuItems() {
    const listEl = this._modeMenuEl?.querySelector('[data-mode-menu-items]');
    if (!(listEl instanceof HTMLElement)) return;
    const current = normalizeSdkMode(this.mode);
    const items = [
      { id: 'plan', label: t('sdkBlock.modePlan'), title: t('sdkBlock.modePlan') },
      { id: 'agent', label: t('sdkBlock.modeAgent'), title: t('sdkBlock.modeAgent') },
      { id: 'ask', label: t('sdkBlock.modeAsk'), title: t('sdkBlock.modeAskHint') },
    ];
    // The menu lives in light DOM, so the global `.mdi` classes apply; the same
    // icons label the compact trigger, which teaches the icon-to-mode mapping.
    const iconClass = { plan: 'mdi-clipboard-list-outline', agent: 'mdi-robot-outline', ask: 'mdi-chat-question-outline' };
    listEl.replaceChildren();
    items.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-list-item send-keys-send-menu-item';
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', item.id === current ? 'true' : 'false');
      button.dataset.mode = item.id;
      button.title = item.title;
      const icon = document.createElement('span');
      icon.className = `mdi ${iconClass[item.id]} cr-sdk-mode-menu-icon cr-sdk-mode-menu-icon--${item.id}`;
      icon.setAttribute('aria-hidden', 'true');
      button.appendChild(icon);
      const label = document.createElement('span');
      label.className = 'chat-list-item-title';
      label.textContent = item.label;
      button.appendChild(label);
      button.addEventListener('click', () => this.handleModeClick(item.id));
      listEl.appendChild(button);
    });
  }

  ensureModeMenu() {
    const triggerEl = this.shadowRoot?.querySelector('.mode');
    if (!(triggerEl instanceof HTMLButtonElement)) return;
    if (this._modeMenuReady && this._modeTriggerEl === triggerEl) {
      this.renderModeMenuItems();
      return;
    }
    this.destroyModeMenu();
    this._modeTriggerEl = triggerEl;
    const menu = document.createElement('div');
    menu.id = 'cr-sdk-mode-menu';
    menu.className = 'chat-list-modal send-keys-send-menu';
    menu.hidden = true;
    menu.innerHTML =
      '<div class="chat-list-panel send-keys-send-menu-panel dropdown-panel--compact">' +
      '<div class="chat-list-items send-keys-send-menu-items" data-mode-menu-items role="menu"></div>' +
      '</div>';
    document.body.appendChild(menu);
    this._modeMenuEl = menu;
    triggerEl.setAttribute('aria-controls', menu.id);
    this._modeDropdownApi = initDropdown({
      triggerEl,
      floatingEl: menu,
      compact: true,
      placement: 'bottom-start',
      matchTriggerWidth: false,
      offsetPx: 6,
      viewportPadding: 8,
      minWidthPx: 160,
      maxHeightPx: 220,
      onOpen: () => {
        this._buildDropdownApi?.close();
        this.renderModeMenuItems();
      },
    });
    this._modeMenuReady = true;
    this.renderModeMenuItems();
  }

  renderBuildMenuItems() {
    const listEl = this._buildMenuEl?.querySelector('[data-build-menu-items]');
    if (!(listEl instanceof HTMLElement)) return;
    const items = [
      {
        id: 'this-chat',
        label: t('sdkBlock.buildPlanThisChat'),
        title: t('sdkBlock.buildPlanThisChatTitle'),
      },
      {
        id: 'new-agent',
        label: t('sdkBlock.buildPlanNewAgent'),
        title: t('sdkBlock.buildPlanNewAgentTitle'),
      },
    ];
    listEl.replaceChildren();
    items.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-list-item send-keys-send-menu-item';
      button.setAttribute('role', 'menuitem');
      button.dataset.action = item.id;
      button.title = item.title;
      const label = document.createElement('span');
      label.className = 'chat-list-item-title';
      label.textContent = item.label;
      button.appendChild(label);
      button.addEventListener('click', () => {
        if (item.id === 'new-agent') {
          this.handleBuildNewAgentClick();
          return;
        }
        this.handleBuildClick();
      });
      listEl.appendChild(button);
    });
  }

  ensureBuildMenu() {
    const triggerEl = this.shadowRoot?.querySelector('.build');
    if (!(triggerEl instanceof HTMLButtonElement)) return;
    if (this._buildMenuReady && this._buildTriggerEl === triggerEl) return;
    this.destroyBuildMenu();
    this._buildTriggerEl = triggerEl;
    const menu = document.createElement('div');
    menu.className = 'chat-list-modal send-keys-send-menu';
    menu.hidden = true;
    menu.innerHTML =
      '<div class="chat-list-panel send-keys-send-menu-panel dropdown-panel--compact">' +
      '<div class="chat-list-items send-keys-send-menu-items" data-build-menu-items role="menu"></div>' +
      '</div>';
    document.body.appendChild(menu);
    this._buildMenuEl = menu;
    this._buildDropdownApi = initDropdown({
      triggerEl,
      floatingEl: menu,
      compact: true,
      placement: 'bottom-start',
      matchTriggerWidth: false,
      offsetPx: 6,
      viewportPadding: 8,
      minWidthPx: 180,
      maxHeightPx: 180,
      onOpen: () => {
        this._modeDropdownApi?.close();
        this.renderBuildMenuItems();
      },
    });
    this._buildMenuReady = true;
    this.renderBuildMenuItems();
  }

  handleContextDetailsClick() {
    this.dispatchEvent(
      new CustomEvent('cr-context-details-open', {
        detail: {
          percent: this.contextPercent,
          level: this.contextLevel || 'none',
          estimated: this.contextEstimated === true,
          label: this.contextLabel || '',
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    const mode = normalizeSdkMode(this.mode);
    const modeLabel = this.modeLabel(mode);
    const tone = this.statusTone || 'connecting';
    const label = this.statusLabel || t('status.connecting');
    const kind = statusIndicatorKind(tone);
    const pillVisible = kind === 'sync';
    // Keep the last transient text so the pill fades out with its label intact.
    if (pillVisible) this._pillLabel = label;
    const harnessValue = this.normalizeBarHarness(this.harness, 'sdk');
    const pendingHarness = this.normalizeBarHarness(this.pendingHarness, '');
    const displayHarnessValue = pendingHarness || harnessValue;
    const allHarnessOptions = listHarnessUiMeta().map((meta) => ({ value: meta.id, label: meta.barLabel }));
    const enabledIds = Array.isArray(this.enabledHarnesses) ? this.enabledHarnesses : null;
    const harnessById = new Map(allHarnessOptions.map((entry) => [entry.value, entry]));
    const orderedIds = enabledIds && enabledIds.length > 0
      ? enabledIds.slice()
      : allHarnessOptions.map((entry) => entry.value);
    if (harnessValue && !orderedIds.includes(harnessValue)) orderedIds.push(harnessValue);
    const harnessOptions = orderedIds
      .map((id) => harnessById.get(id))
      .filter(Boolean);
    const models = this._getNormalizedModels();
    const rawModelValue = String(this.model || '').trim();
    const modelValue = rawModelValue || 'auto';
    const selectedModel = models.find((item) => item.value === modelValue);
    const modelLabel = selectedModel?.label || modelValue;
    const selectedHarnessLabel = harnessOptions.find((entry) => entry.value === displayHarnessValue)?.label || 'Cursor SDK';
    const pickerStep = this.normalizePickerStep(this.pickerStep);
    const combinedOptions = pickerStep === 'harness'
      ? harnessOptions.map((entry) => ({
          value: `harness::${entry.value}`,
          label: entry.label,
        }))
      : [
          { value: 'step::harness', label: t('sdkBlock.pickerChangeHarness') },
          ...models.map((entry) => ({
            value: `model::${entry.value}`,
            label: entry.label,
          })),
        ];
    const combinedValue = pickerStep === 'harness'
      ? `harness::${harnessValue}`
      : (rawModelValue ? `model::${modelValue}` : '');
    const combinedPlaceholder = pickerStep === 'harness'
      ? t('sdkBlock.pickerHarnessStep', { harness: selectedHarnessLabel })
      : (rawModelValue
        ? t('sdkBlock.pickerModelStep', { model: modelLabel || modelValue })
        : t('sdkBlock.pickerModelStepEmpty', { harness: selectedHarnessLabel }));
    const combinedDisplayLabel = pickerStep === 'harness' && modelLabel
      ? t('sdkBlock.pickerClosedLabel', { harness: selectedHarnessLabel, model: modelLabel })
      : '';
    const groupedHarnessLabel = this.pickerHarnessLabels?.[this.normalizeBarHarness(this.harness, 'sdk')] || selectedHarnessLabel;
    const groupedChoice = JSON.stringify([this.normalizeBarHarness(this.harness, 'sdk'), modelValue]);
    const groupedSelected = (this.pickerOptions || []).find((row) => row.value === groupedChoice);
    const groupedHarnessId = this.normalizeBarHarness(this.harness, 'sdk');
    const modelDisplay = formatModelDisplay(modelValue, groupedSelected?.name || selectedModel?.label || '');
    const harnessBadge = getHarnessBadge(groupedHarnessId, groupedHarnessLabel);
    const effortCount = effortBarCount(modelDisplay.effort);
    const effortText = modelDisplay.effort ? t(`sdkBlock.effortLevel.${modelDisplay.effort}`) : '';
    const groupedPickerAria = `${t('sdkBlock.harnessModelAria')} (${effortText
      ? t('sdkBlock.harnessModelSummaryAria', { harness: groupedHarnessLabel, effort: effortText })
      : groupedHarnessLabel})`;
    const contextPercent = this.contextPercent == null ? Number.NaN : Number(this.contextPercent);
    const hasContextPercent = Number.isFinite(contextPercent) && contextPercent >= 0;
    const normalizedContextPercent = hasContextPercent
      ? Math.max(0, Math.min(100, contextPercent))
      : 0;
    const ringRadius = 10;
    const ringCircumference = 2 * Math.PI * ringRadius;
    const ringDash = (normalizedContextPercent / 100) * ringCircumference;
    const ringTone =
      this.contextLevel === 'critical' || this.contextLevel === 'danger'
        ? 'danger'
        : this.contextLevel === 'warn'
          ? 'warn'
          : 'ok';
    const ringCenterLabel = formatContextRingCenterLabel(this.contextPercent);
    const ringLabel = String(this.contextLabel || '').trim() || t('sdkBlock.contextDetails');
    return html`
      <div class="bar">
        <div class="cluster cluster--start">
          <button
            type="button"
            class="mode mode--${mode}"
            aria-haspopup="menu"
            aria-expanded="false"
            aria-label=${`${t('sdkBlock.modeMenuAria')}: ${modeLabel}`}
            title=${`${t('sdkBlock.modeMenuAria')}: ${modeLabel}`}
            @click=${this.handleModeMenuToggle}
          >
            <span class="mode-icon" aria-hidden="true"></span>
            <span class="mode-label">${modeLabel}</span>
            <span class="mode-chevron" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path fill="currentColor" d="M7.41 8.58L12 13.17l4.59-4.59L18 10l-6 6-6-6z" />
              </svg>
            </span>
          </button>
          ${this.showBuild
            ? html`
                <button
                  type="button"
                  class="build"
                  aria-haspopup="menu"
                  aria-expanded="false"
                  aria-label=${t('sdkBlock.buildPlanMenuAria')}
                  title=${t('sdkBlock.buildPlanMenuAria')}
                  @click=${this.handleBuildMenuToggle}
                >
                  ${t('sdkBlock.buildPlan')}
                  <span class="build-arrow" aria-hidden="true">▾</span>
                </button>
              `
            : null}
        </div>
        <div class="cluster cluster--end">
          ${Array.isArray(this.pickerOptions) && this.pickerOptions.length > 0 ? html`
          <cr-searchable-select
            class="combined-picker"
            size="sm"
            search-threshold="0"
            panel-min-width="460"
            .value=${JSON.stringify([this.normalizeBarHarness(this.harness, 'sdk'), modelValue])}
            .options=${this.pickerOptions}
            .displayLabel=${modelDisplay.name}
            .displayTitle=${`${groupedHarnessLabel} · ${modelValue}`}
            .favoritesEnabled=${this.pickerLabels.favoritesEnabled === true}
            .favoritesOnly=${this.pickerLabels.defaultFavoritesOnly === true}
            .availableOnly=${this.pickerLabels.availableFilterEnabled === true}
            .favoritesFilterEnabled=${this.pickerLabels.favoritesFilterEnabled === true}
            .availableFilterEnabled=${this.pickerLabels.availableFilterEnabled === true}
            .availableOptionsLabel=${this.pickerLabels.availableOptionsLabel}
            .allOptionsLabel=${this.pickerLabels.allOptionsLabel}
            .favoriteOptionsLabel=${this.pickerLabels.favoriteOptionsLabel}
            .emptyFavoritesLabel=${this.pickerLabels.emptyFavoritesLabel}
            .addFavoriteLabel=${this.pickerLabels.addFavoriteLabel}
            .removeFavoriteLabel=${this.pickerLabels.removeFavoriteLabel}
            .searchPlaceholder=${this.pickerLabels.searchPlaceholder || ''}
            .emptyLabel=${this.pickerLabels.emptyLabel || ''}
            aria-label=${groupedPickerAria}
            @cr-change=${this.handleGroupedPickerChange}
            @cr-favorite-toggle=${this.handleGroupedFavoriteToggle}
            @cr-open=${() => this.dispatchEvent(new CustomEvent('cr-sdk-picker-open', { bubbles: true, composed: true }))}
          >
            <span slot="start" class="harness-badge harness-badge--${harnessBadge.tone}" aria-hidden="true">${harnessBadge.text}</span>
            ${effortCount > 0 ? html`
              <span
                slot="end"
                class="effort ${modelDisplay.effort === 'max' || modelDisplay.effort === 'ultra' ? 'effort--max' : ''}"
                title=${t('sdkBlock.effortTitle', { effort: effortText })}
                aria-hidden="true"
              >
                <span class="effort-bars">
                  ${[0, 1, 2, 3].map((index) => html`<i class=${index < effortCount ? 'is-on' : ''}></i>`)}
                </span>
                <span class="effort-label">${effortText}</span>
              </span>` : null}
          </cr-searchable-select>` : html`<cr-searchable-select
            class="combined-picker"
            size="sm"
            .value=${combinedValue}
            .options=${combinedOptions}
            .placeholder=${combinedPlaceholder}
            .displayLabel=${combinedDisplayLabel}
            search-threshold="8"
            search-placeholder=${pickerStep === 'harness' ? t('sdkBlock.searchHarness') : t('sdkBlock.searchModel')}
            empty-label=${t('sdkBlock.noMatchingOptions')}
            aria-label=${t('sdkBlock.harnessModelAria')}
            @cr-change=${this.handleCombinedSelectionChange}
          >
          </cr-searchable-select>`}
          <button
            type="button"
            class="context-ring context-ring--${ringTone} ${this.contextVisible ? '' : 'is-dimmed'}"
            title=${ringLabel}
            aria-label=${ringLabel}
            @click=${this.handleContextDetailsClick}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle class="context-ring-bg" cx="12" cy="12" r=${ringRadius}></circle>
              <circle
                class="context-ring-value"
                cx="12"
                cy="12"
                r=${ringRadius}
                stroke-dasharray="${ringDash} ${ringCircumference}"
              ></circle>
            </svg>
            <span class="context-ring-center">${ringCenterLabel}</span>
          </button>
          <span class="status status--${tone} status-kind--${kind}" title=${label}>
            <span class="status-dot" aria-hidden="true"></span>
            <span class="status-label" aria-live="polite">${label}</span>
          </span>
        </div>
        <span class="status-pill status-kind--sync ${pillVisible ? 'is-visible' : ''}" aria-hidden="true">
          <span class="status-dot"></span>
          <span class="status-pill-label">${this._pillLabel}</span>
        </span>
      </div>
    `;
  }
}

if (!customElements.get('cr-sdk-mode-bar')) {
  customElements.define('cr-sdk-mode-bar', CrSdkModeBar);
}
