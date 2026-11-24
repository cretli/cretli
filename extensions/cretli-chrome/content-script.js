// Injected on demand (chrome.scripting) into tabs of approved domains only.
// Reads link candidates from the DOM. It never reads form values, cookies or
// storage, and never executes anything derived from page text.
(() => {
  if (globalThis.__cretliExt) return;
  const DOC_HINT = /\.(pdf|csv)(\?|#|$)/i;

  function cssPath(el) {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.body; node = node.parentElement) {
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
      parts.unshift(`${node.tagName.toLowerCase()}${same.length > 1 ? `:nth-of-type(${same.indexOf(node) + 1})` : ''}`);
    }
    return `body > ${parts.join(' > ')}`;
  }

  function regex(pattern) {
    try { return pattern ? new RegExp(pattern, 'i') : null; } catch { return null; }
  }

  globalThis.__cretliExt = {
    list({ selector, match = {}, limit = 50 }) {
      const hrefRe = regex(match.hrefPattern);
      const textRe = regex(match.textPattern);
      const nodes = document.querySelectorAll(selector || 'a[href]');
      const items = [];
      for (const el of nodes) {
        const href = el.href || el.getAttribute?.('href') || '';
        if (!href.startsWith('https://')) continue;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (hrefRe && !hrefRe.test(href)) continue;
        if (textRe && !textRe.test(text)) continue;
        if (!selector && !hrefRe && !textRe && !DOC_HINT.test(href)) continue;
        const mimeHint = /\.csv(\?|#|$)/i.test(href) ? 'text/csv' : /\.pdf(\?|#|$)/i.test(href) ? 'application/pdf' : '';
        items.push({ selector: cssPath(el), href, text, mimeHint });
        if (items.length >= limit) break;
      }
      return { items };
    },
    /** Resolves one selector to exactly one https link, or reports why not. */
    resolve(selector) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { return { error: 'E_SELECTOR' }; }
      if (nodes.length !== 1) return { error: 'E_SELECTOR' };
      const href = nodes[0].href || '';
      return href.startsWith('https://') ? { href } : { error: 'E_SELECTOR' };
    },
  };
})();
