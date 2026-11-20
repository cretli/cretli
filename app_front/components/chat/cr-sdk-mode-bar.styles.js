import { css } from 'lit';

/** Shadow styles of <cr-sdk-mode-bar>, kept apart so the component file stays readable. */
export const modeBarStyles = css`
    :host {
      display: block;
      margin: 0 0 0.35rem;
      font-family: inherit;
      container: modebar / inline-size;
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

    /*
     * Mode glyph from the globally loaded MDI font (the font crosses the shadow
     * boundary, the global .mdi classes do not). Narrow bars show only the glyph;
     * colour marks the mutating Agent mode apart from read-only Plan / Ask.
     */
    .mode-icon {
      font-family: 'Material Design Icons';
      font-size: 1rem;
      font-weight: normal;
      line-height: 1;
    }

    .mode--agent .mode-icon::before { content: '\\F167A'; }
    .mode--plan .mode-icon::before { content: '\\F10D5'; }
    .mode--ask .mode-icon::before { content: '\\F1739'; }

    .mode--agent .mode-icon { color: var(--cr-accent); }
    .mode--plan .mode-icon { color: var(--cr-plan); }
    .mode--ask .mode-icon { color: var(--cr-text-muted); }

    .mode-label {
      display: none;
    }

    /* Same chevron as the cr-searchable-select model picker next to it. */
    .mode-chevron {
      display: inline-flex;
      flex-shrink: 0;
      width: 0.65rem;
      height: 0.65rem;
      opacity: 0.8;
    }

    .mode-chevron svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    @container modebar (min-width: 36rem) {
      .mode {
        gap: 0.3rem;
      }

      .mode-label {
        display: inline;
      }
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

    /* Decorations slotted into the closed picker trigger. */
    .harness-badge {
      display: inline-grid;
      place-items: center;
      min-width: 1.15rem;
      height: 1.15rem;
      padding: 0 0.15rem;
      box-sizing: border-box;
      border: 1px solid var(--badge-border);
      border-radius: var(--cr-radius-sm, 4px);
      background: var(--badge-bg);
      color: var(--badge-fg);
      font-size: 0.6rem;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0.02em;
    }

    .harness-badge--info { --badge-fg: var(--cr-info); --badge-bg: var(--cr-info-bg); --badge-border: var(--cr-info-border); }
    .harness-badge--success { --badge-fg: var(--cr-success); --badge-bg: var(--cr-success-bg); --badge-border: var(--cr-success-border); }
    .harness-badge--warn { --badge-fg: var(--cr-warn); --badge-bg: var(--cr-warn-bg); --badge-border: var(--cr-warn-border); }
    .harness-badge--plan { --badge-fg: var(--cr-plan); --badge-bg: var(--cr-plan-bg); --badge-border: var(--cr-plan-border); }
    .harness-badge--status { --badge-fg: var(--cr-status); --badge-bg: var(--cr-status-bg); --badge-border: var(--cr-status-border); }
    .harness-badge--neutral { --badge-fg: var(--cr-neutral); --badge-bg: var(--cr-neutral-bg); --badge-border: var(--cr-neutral-border); }
    .harness-badge--error { --badge-fg: var(--cr-error); --badge-bg: var(--cr-error-bg); --badge-border: var(--cr-error-border); }

    .effort {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      color: var(--cr-text-muted);
      font-size: var(--cr-mode-bar-font-size);
      font-weight: 600;
    }

    .effort-bars {
      display: inline-flex;
      align-items: flex-end;
      gap: 2px;
      height: 0.7rem;
    }

    .effort-bars i {
      display: block;
      width: 3px;
      border-radius: 1px;
      background: var(--cr-border-strong);
    }

    .effort-bars i:nth-child(1) { height: 40%; }
    .effort-bars i:nth-child(2) { height: 60%; }
    .effort-bars i:nth-child(3) { height: 80%; }
    .effort-bars i:nth-child(4) { height: 100%; }

    .effort-bars i.is-on {
      background: var(--cr-accent);
    }

    .effort--max .effort-bars i.is-on {
      background: var(--cr-warn);
    }

    /* Narrow bars keep only the glyph; the level name needs room. */
    .effort-label {
      display: none;
    }

    @container modebar (min-width: 36rem) {
      .effort-label {
        display: inline;
      }
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

    /*
     * The status chip has a fixed footprint so a label change never reflows the
     * picker next to it: a square indicator on narrow bars, a fixed-width
     * (ellipsised) label on wide ones. Transient states also float as a pill.
     */
    .status {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      width: var(--cr-mode-bar-control-height);
      height: var(--cr-mode-bar-control-height);
      padding: 0;
      box-sizing: border-box;
      border-radius: var(--cr-radius-sm, 4px);
      border: 1px solid var(--cr-border-subtle);
      font-size: var(--cr-mode-bar-font-size);
      line-height: 1;
      font-weight: 600;
      background: var(--cr-control-idle-bg);
      color: var(--cr-neutral);
      overflow: hidden;
    }

    .status-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }

    @container modebar (min-width: 36rem) {
      .status {
        width: 11rem;
        justify-content: flex-start;
        padding: 0 0.55rem;
      }

      .status-label {
        position: static;
        width: auto;
        height: auto;
        clip: auto;
        min-width: 0;
        text-overflow: ellipsis;
      }
    }

    .status-dot {
      flex-shrink: 0;
      width: 0.5rem;
      height: 0.5rem;
      box-sizing: border-box;
      border-radius: 999px;
      background: currentColor;
    }

    .status-kind--idle .status-dot {
      opacity: 0.55;
    }

    .status-kind--busy .status-dot {
      animation: cr-status-pulse 1.4s ease-out infinite;
    }

    .status-kind--sync .status-dot {
      width: 0.7rem;
      height: 0.7rem;
      background: transparent;
      border: 2px solid currentColor;
      border-top-color: transparent;
      animation: cr-status-spin 0.8s linear infinite;
    }

    .status-kind--attention .status-dot {
      animation: cr-status-blink 1.6s ease-in-out infinite;
    }

    .status-kind--offline .status-dot {
      background: transparent;
      border: 2px solid currentColor;
    }

    .status-pill {
      position: absolute;
      top: calc(100% + 0.5rem);
      left: 50%;
      z-index: 5;
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      max-width: min(22rem, calc(100% - 2rem));
      padding: 0.3rem 0.75rem;
      box-sizing: border-box;
      border: 1px solid var(--cr-info-border);
      border-radius: 999px;
      background: var(--cr-surface);
      box-shadow: 0 4px 14px var(--cr-color-rgba-0-0-0-0-35);
      color: var(--cr-info);
      font-size: var(--cr-mode-bar-font-size);
      font-weight: 600;
      line-height: 1.2;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transform: translate(-50%, -0.35rem);
      transition: opacity 160ms ease, transform 160ms ease;
    }

    .status-pill.is-visible {
      opacity: 1;
      transform: translate(-50%, 0);
    }

    .status-pill-label {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Wide bars already show the label in the chip; the pill would duplicate it. */
    @container modebar (min-width: 36rem) {
      .status-pill {
        display: none;
      }
    }

    @keyframes cr-status-pulse {
      0% { box-shadow: 0 0 0 0 currentColor; }
      70% { box-shadow: 0 0 0 0.3rem transparent; }
      100% { box-shadow: 0 0 0 0 transparent; }
    }

    @keyframes cr-status-spin {
      to { transform: rotate(360deg); }
    }

    @keyframes cr-status-blink {
      50% { opacity: 0.35; }
    }

    @media (prefers-reduced-motion: reduce) {
      .status-dot,
      .status-pill {
        animation: none !important;
        transition: none;
      }
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

    .status--connecting,
    .status--syncing {
      color: var(--cr-info);
      border-color: var(--cr-info-border);
      pointer-events: none;
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

    .status--waiting {
      color: var(--cr-info);
      border-color: var(--cr-info-border);
    }

    .status--attention {
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
      /* Let the status pill centre on the whole toolbar (the chat width). */
      position: static;
    }

    :host-context(.chat-fullscreen-bar) .mode {
      border-color: var(--cr-border-subtle);
    }
  `;
