import { LitElement, css, html } from 'lit';
import '../ui/cr-searchable-select.js';
import { initDropdown } from '../../lib/dropdown.js';
import { t } from '../../i18n/index.js';
import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.js';

class CrSdkModeBar extends LitElement {
  static properties = {
    mode: { type: String },
    showBuild: { type: Boolean, attribute: 'show-build' },
    statusLabel: { type: String, attribute: 'status-label' },
    statusTone: { type: String, attribute: 'status-tone' },
    harness: { type: String },
    model: { type: String },
    models: { attribute: false },
    contextPercent: { type: Number, attribute: 'context-percent' },
    contextLevel: { type: String, attribute: 'context-level' },
    contextLabel: { type: String, attribute: 'context-label' },
    contextEstimated: { type: Boolean, attribute: 'context-estimated' },
    contextVisible: { type: Boolean, attribute: 'context-visible' },
    pickerStep: { type: String, attribute: false },
    pendingHarness: { type: String, attribute: false },
    enabledHarnesses: { attribute: false },
  };

  static styles = css`
    :host {
      display: block;
      margin: 0 0 0.35rem;
      font-family: inherit;
      --cr-mode-bar-control-height: var(--cr-toolbar-control-height, 1.75rem);
      --cr-mode-bar-font-size: 0.72rem;
    }

    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.45rem 0.65rem;
      width: 100%;
      box-sizing: border-box;
      padding: 0.35rem 0.55rem;
      border: 1px solid var(--cr-border-subtle);
      border-radius: var(--cr-radius-md, 6px);
      background: var(--cr-surface-translucent);
      position: relative;
    }

    .cluster {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      min-width: 0;
    }

    .cluster--start {
      flex-shrink: 0;
    }

    .cluster--end {
      flex: 1 1 12rem;
      min-width: 0;
      justify-content: flex-end;
    }

    .mode {
      display: inline-flex;
      align-items: center;
      gap: 0.2rem;
      height: var(--cr-mode-bar-control-height);
      box-sizing: border-box;
      border: 1px solid var(--cr-border-subtle);
      border-radius: var(--cr-radius-sm, 4px);
      background: var(--cr-control-idle-bg);
      color: var(--cr-text);
      font-size: var(--cr-mode-bar-font-size);
      font-weight: 600;
      padding: 0 0.45rem 0 0.55rem;
      cursor: pointer;
      flex-shrink: 0;
    }

    .mode-arrow {
      flex-shrink: 0;
      font-size: 0.65rem;
      line-height: 1;
      opacity: 0.85;
    }

    .build {
      display: inline-flex;
      align-items: center;
      gap: 0.2rem;
      border: 1px solid var(--cr-plan-border);
      background: var(--cr-plan-bg);
      color: var(--cr-plan);
      border-radius: var(--cr-radius-sm, 4px);
      font-size: var(--cr-mode-bar-font-size);
      font-weight: 600;
      height: var(--cr-mode-bar-control-height);
      padding: 0 0.45rem 0 0.55rem;
      cursor: pointer;
      box-sizing: border-box;
      flex-shrink: 0;
    }

    .build-arrow {
      flex-shrink: 0;
      font-size: 0.65rem;
      line-height: 1;
      opacity: 0.85;
    }

    .combined-picker {
      --cr-searchable-select-height: var(--cr-mode-bar-control-height);
      --cr-searchable-select-padding-x: 0.5rem;
      --cr-searchable-select-font-size: 0.8rem;
      --cr-searchable-select-min-width: 8rem;
      flex: 1 1 auto;
      min-width: 0;
      max-width: 48ch;
      width: auto;
      display: block;
    }

    .combined-picker::part(control) {
      border-radius: var(--cr-radius-sm, 4px);
      border-color: var(--cr-border-subtle);
      background: var(--cr-control-idle-bg);
      color: var(--cr-text);
      font-weight: inherit;
      height: var(--cr-mode-bar-control-height);
      min-height: var(--cr-mode-bar-control-height);
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    .combined-picker::part(control):hover {
      border-color: var(--cr-border-strong);
    }

    .model {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      height: var(--cr-mode-bar-control-height);
      padding: 0 0.55rem;
      box-sizing: border-box;
      border-radius: var(--cr-radius-sm, 4px);
      border: 1px solid var(--cr-border-subtle);
      font-size: var(--cr-mode-bar-font-size);
      line-height: 1;
      font-weight: 600;
      background: var(--cr-control-idle-bg);
      color: var(--cr-text-muted);
      max-width: 22ch;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .model-picker {
      --cr-searchable-select-height: var(--cr-mode-bar-control-height);
      --cr-searchable-select-padding-x: 0.5rem;
      --cr-searchable-select-font-size: 0.8rem;
      --cr-searchable-select-min-width: 8rem;
      max-width: 28ch;
      width: auto;
      display: inline-block;
    }

    .model-picker::part(control) {
      border-radius: var(--cr-radius-sm, 4px);
      border-color: var(--cr-border-subtle);
      background: var(--cr-control-idle-bg);
      color: var(--cr-text);
      font-weight: inherit;
      height: var(--cr-mode-bar-control-height);
      min-height: var(--cr-mode-bar-control-height);
      max-width: 28ch;
      min-width: 0;
      box-sizing: border-box;
    }

    .model-picker::part(control):hover {
      border-color: var(--cr-border-strong);
    }

    .status {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      height: var(--cr-mode-bar-control-height);
      padding: 0 0.55rem;
      box-sizing: border-box;
      border-radius: var(--cr-radius-sm, 4px);
      border: 1px solid var(--cr-border-subtle);
      font-size: var(--cr-mode-bar-font-size);
      line-height: 1;
      font-weight: 600;
      background: var(--cr-control-idle-bg);
      color: var(--cr-neutral);
    }

    .context-ring {
      width: var(--cr-mode-bar-control-height);
      height: var(--cr-mode-bar-control-height);
      min-width: var(--cr-mode-bar-control-height);
      flex-shrink: 0;
      padding: 0;
      box-sizing: border-box;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--cr-text-muted);
      display: inline-grid;
      place-items: center;
      cursor: pointer;
      position: relative;
    }

    .context-ring:hover .context-ring-bg {
      stroke: var(--cr-border-strong);
    }

    .context-ring:focus-visible {
      outline: 2px solid var(--cr-focus-outline, var(--cr-accent));
      outline-offset: 1px;
    }

    .context-ring.is-dimmed {
      opacity: 0.72;
    }

    .context-ring svg {
      width: 100%;
      height: 100%;
      display: block;
    }

    .context-ring-bg {
      fill: none;
      stroke: var(--cr-border-subtle);
      stroke-width: 3;
    }

    .context-ring-value {
      fill: none;
      stroke-width: 3;
      stroke-linecap: round;
      transform: rotate(-90deg);
      transform-origin: 50% 50%;
      transition: stroke-dasharray 160ms ease;
      stroke: var(--cr-success);
    }

    .context-ring--warn .context-ring-value {
      stroke: var(--cr-warn);
    }

    .context-ring--danger .context-ring-value {
      stroke: var(--cr-error);
    }

    .context-ring-center {
      position: absolute;
      font-size: 0.62rem;
      line-height: 1;
      font-weight: 700;
      letter-spacing: 0.01em;
      pointer-events: none;
      color: var(--cr-text-muted);
    }

    .status--connecting {
      color: var(--cr-info);
      border-color: var(--cr-info-border);
    }

    .status--active {
      color: var(--cr-success);
      border-color: var(--cr-success-border);
    }

    .status--generating,
    .status--running,
    .status--grepping {
      color: var(--cr-success);
      border-color: var(--cr-success-border);
    }

    .status--reading {
      color: var(--cr-info);
      border-color: var(--cr-info-border);
    }

    .status--approval {
      color: var(--cr-warn);
      border-color: var(--cr-warn-border);
    }

    .status--thinking {
      color: var(--cr-warn);
      border-color: var(--cr-warn-border);
    }

    .status--editing {
      color: var(--cr-status);
      border-color: var(--cr-status-border);
    }

    .status--textarea {
      color: var(--cr-warn);
      border-color: var(--cr-warn-border);
    }

    .status--choice,
    .status--question,
    .status--awaiting {
      color: var(--cr-warn);
      border-color: var(--cr-warn-border);
    }

    .status--disconnected {
      color: var(--cr-neutral);
      border-color: var(--cr-neutral-border);
    }

    :host-context(.chat-fullscreen-bar) {
      margin: 0;
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
    }

    :host-context(.chat-fullscreen-bar) .bar {
      border: none;
      background: transparent;
      padding: 0;
      width: 100%;
      gap: var(--cr-toolbar-gap, 0.5rem);
    }

    :host-context(.chat-fullscreen-bar) .mode {
      border-color: var(--cr-border-subtle);
    }
  `;

  constructor() {
    super();
    this.mode = 'agent';
    this.showBuild = false;
    this.harness = 'sdk';
    this.model = '';
    this.models = [];
    this.statusLabel = '';
    this.statusTone = 'connecting';
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
    if (raw === 'openrouter' || raw === 'opencode' || raw === 'codebuddy' || raw === 'deepseek' || raw === 'codex' || raw === 'qwen') return raw;
    if (raw === 'sdk') return 'sdk';
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
    listEl.replaceChildren();
    items.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-list-item send-keys-send-menu-item';
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', item.id === current ? 'true' : 'false');
      button.dataset.mode = item.id;
      button.title = item.title;
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
    const harnessValue = this.normalizeBarHarness(this.harness, 'sdk');
    const pendingHarness = this.normalizeBarHarness(this.pendingHarness, '');
    const displayHarnessValue = pendingHarness || harnessValue;
    const allHarnessOptions = [
      { value: 'sdk', label: 'Cursor SDK' },
      { value: 'openrouter', label: 'OpenRouter' },
      { value: 'opencode', label: 'OpenCode' },
      { value: 'codebuddy', label: 'CodeBuddy' },
      { value: 'deepseek', label: 'DeepSeek' },
      { value: 'qwen', label: 'Qwen' },
      { value: 'codex', label: 'Codex' },
    ];
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
    const contextPercent = Number(this.contextPercent);
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
    const roundedContextPercent = hasContextPercent ? Math.round(contextPercent) : null;
    const ringCenterLabel = roundedContextPercent == null
      ? '—'
      : roundedContextPercent > 99
        ? '99+'
        : String(roundedContextPercent);
    const ringLabel = String(this.contextLabel || '').trim() || t('sdkBlock.contextDetails');
    return html`
      <div class="bar">
        <div class="cluster cluster--start">
          <button
            type="button"
            class="mode"
            aria-haspopup="menu"
            aria-expanded="false"
            aria-label=${t('sdkBlock.modeMenuAria')}
            title=${t('sdkBlock.modeMenuAria')}
            @click=${this.handleModeMenuToggle}
          >
            ${modeLabel}
            <span class="mode-arrow" aria-hidden="true">▾</span>
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
          <cr-searchable-select
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
          </cr-searchable-select>
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
          <span class="status status--${tone}" aria-live="polite">${label}</span>
        </div>
      </div>
    `;
  }
}

if (!customElements.get('cr-sdk-mode-bar')) {
  customElements.define('cr-sdk-mode-bar', CrSdkModeBar);
}
