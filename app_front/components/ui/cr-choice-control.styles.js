import { css } from 'lit';

/**
 * Shared look of checkboxes and radios: a dark field-style box with the field border, the
 * accent colour only when selected. The same rules exist for native inputs in
 * css/cr-recipes.scss (`.cr-check`, `.cr-radio`); keep both in step.
 */
export const choiceControlStyles = css`
  .control {
    appearance: none;
    -webkit-appearance: none;
    display: inline-grid;
    place-content: center;
    flex: 0 0 auto;
    box-sizing: border-box;
    width: 1rem;
    height: 1rem;
    margin: 0;
    border: 1px solid var(--cr-field-border);
    border-radius: var(--cr-radius-sm, 4px);
    background: var(--cr-field-bg);
    cursor: pointer;
    transition: background var(--cr-transition, 120ms), border-color var(--cr-transition, 120ms);
  }
  .control:hover {
    border-color: var(--cr-field-border-hover);
  }
  .control:focus-visible {
    outline: 2px solid var(--cr-accent);
    outline-offset: 2px;
  }
  .control::after {
    content: '';
    opacity: 0;
  }
  .control:checked::after {
    opacity: 1;
  }
  .control:disabled {
    cursor: not-allowed;
  }
  /* Checkbox: accent fill with a tick. */
  .control[type='checkbox']:checked {
    background: var(--cr-accent);
    border-color: var(--cr-accent);
  }
  .control[type='checkbox']::after {
    width: 0.3rem;
    height: 0.6rem;
    margin-top: -0.1rem;
    border: solid var(--cr-text-inverse);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
  /* Radio: round, accent ring and dot. */
  .control[type='radio'] {
    border-radius: 50%;
  }
  .control[type='radio']:checked {
    border-color: var(--cr-accent);
  }
  .control[type='radio']::after {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--cr-accent);
  }
`;
