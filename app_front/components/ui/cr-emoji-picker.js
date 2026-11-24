/**
 * cr-emoji-picker — compact emoji grid with category tabs (Lit, shadow DOM).
 *
 * Fires `cr-change` with `detail.value` when an emoji is picked, or '' when the
 * clear button is used. Touch targets are sized for phones. A curated set keeps
 * the bundle small; free-form emoji can still be typed or pasted in the field
 * the picker is attached to.
 */
import { LitElement, css, html } from 'lit';
import { t } from '../../i18n/index.js';

/** @type {Array<{ id: string, icon: string, emojis: string[] }>} */
export const EMOJI_CATEGORIES = [
  { id: 'work', icon: '💼', emojis: ['💼', '🗂️', '📁', '📂', '📌', '📎', '🔧', '🛠️', '⚙️', '🧰', '🔬', '🧪', '💡', '📝', '📚', '📊', '📈', '🧮', '💻', '🖥️', '⌨️', '🖨️', '🔒', '🔑'] },
  { id: 'tech', icon: '🚀', emojis: ['🚀', '🛰️', '🤖', '👾', '🧠', '⚡', '🔥', '💾', '📡', '🌐', '🔌', '🔋', '📱', '🎮', '🕹️', '🧬', '🧲', '🛡️', '🐛', '🧩', '🧵', '🪄', '🔭', '⏱️'] },
  { id: 'nature', icon: '🌿', emojis: ['🌿', '🌲', '🌴', '🌵', '🍀', '🌸', '🌻', '🌊', '🔥', '❄️', '☀️', '🌙', '⭐', '🌈', '☁️', '⛰️', '🐶', '🐱', '🦊', '🐻', '🐼', '🦉', '🐝', '🦋'] },
  { id: 'food', icon: '🍎', emojis: ['🍎', '🍊', '🍋', '🍇', '🍓', '🍒', '🥑', '🌶️', '🥕', '🌽', '🍕', '🍔', '🌮', '🍣', '🍩', '🍪', '🍫', '☕', '🍵', '🍺', '🍷', '🥤', '🧁', '🍰'] },
  { id: 'places', icon: '🏠', emojis: ['🏠', '🏢', '🏭', '🏪', '🏫', '🏥', '🏦', '🏛️', '🏰', '🗼', '🌉', '🚗', '🚕', '🚌', '🚲', '✈️', '🚢', '🚂', '🛒', '🛍️', '🎪', '🎡', '⛺', '🗺️'] },
  { id: 'symbols', icon: '❤️', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '✅', '❌', '⚠️', '❓', '❗', '♻️', '🔔', '🏷️', '💰', '💎', '🎯', '🏆', '🎁', '🎉', '✨', '💫'] },
  { id: 'faces', icon: '😀', emojis: ['😀', '😎', '🤓', '🤔', '😴', '🥳', '😇', '🤠', '👻', '💀', '👽', '🤡', '😈', '🙈', '🙌', '👍', '👋', '💪', '🙏', '👀', '🧑‍💻', '🧙', '🦸', '🥷'] },
];

class CrEmojiPicker extends LitElement {
  static properties = {
    value: { type: String },
    _category: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      max-width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--cr-field-border);
      border-radius: var(--cr-radius-sm);
      background: var(--cr-field-bg);
      padding: var(--cr-space-2);
    }
    .tabs {
      display: flex;
      gap: var(--cr-space-1);
      margin-bottom: var(--cr-space-2);
      overflow-x: auto;
    }
    .tab, .emoji, .clear {
      font: inherit;
      color: var(--cr-text);
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--cr-radius-sm);
      cursor: pointer;
    }
    .tab {
      flex: 0 0 auto;
      min-width: 2.2rem;
      height: 2.2rem;
      font-size: var(--cr-font-size-legacy-115);
      padding: 0;
    }
    .tab[aria-selected='true'] {
      background: var(--cr-active);
      border-color: var(--cr-border-strong);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(2.4rem, 1fr));
      gap: var(--cr-space-1);
    }
    .emoji {
      height: 2.4rem;
      font-size: calc(var(--cr-font-size-legacy-2) * 0.7);
      line-height: 1;
      padding: 0;
    }
    .tab:hover, .emoji:hover, .clear:hover { background: var(--cr-hover); }
    .emoji[aria-pressed='true'] {
      background: var(--cr-active);
      border-color: var(--cr-accent);
    }
    .tab:focus-visible, .emoji:focus-visible, .clear:focus-visible {
      outline: 2px solid var(--cr-accent);
      outline-offset: 1px;
    }
    .footer {
      display: flex;
      justify-content: flex-end;
      margin-top: var(--cr-space-2);
    }
    .clear {
      font-size: var(--cr-font-size-sm);
      color: var(--cr-text-muted);
      padding: var(--cr-space-1) var(--cr-space-2);
      border-color: var(--cr-border-strong);
    }
  `;

  constructor() {
    super();
    this.value = '';
    this._category = EMOJI_CATEGORIES[0].id;
  }

  /** @param {string} value */
  _pick(value) {
    this.value = value;
    this.dispatchEvent(new CustomEvent('cr-change', { detail: { value }, bubbles: true, composed: true }));
  }

  render() {
    const active = EMOJI_CATEGORIES.find((cat) => cat.id === this._category) || EMOJI_CATEGORIES[0];
    return html`
      <div class="tabs" role="tablist" aria-label=${t('emojiPicker.categories')}>
        ${EMOJI_CATEGORIES.map((cat) => html`
          <button
            type="button"
            class="tab"
            role="tab"
            aria-selected=${cat.id === active.id ? 'true' : 'false'}
            title=${t(`emojiPicker.category.${cat.id}`)}
            aria-label=${t(`emojiPicker.category.${cat.id}`)}
            @click=${() => { this._category = cat.id; }}
          >${cat.icon}</button>
        `)}
      </div>
      <div class="grid" role="listbox" aria-label=${t(`emojiPicker.category.${active.id}`)}>
        ${active.emojis.map((emoji) => html`
          <button
            type="button"
            class="emoji"
            aria-pressed=${emoji === this.value ? 'true' : 'false'}
            aria-label=${emoji}
            @click=${() => this._pick(emoji)}
          >${emoji}</button>
        `)}
      </div>
      <div class="footer">
        <button type="button" class="clear" @click=${() => this._pick('')}>${t('emojiPicker.clear')}</button>
      </div>
    `;
  }
}

if (!customElements.get('cr-emoji-picker')) customElements.define('cr-emoji-picker', CrEmojiPicker);
export { CrEmojiPicker };
