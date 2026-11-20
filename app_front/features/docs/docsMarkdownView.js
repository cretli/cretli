import { html } from 'lit';
import { resolveWikilink } from './docsLogic.js';
import { safeMarkdown } from './docsMarkdown.js';

function wikiText(text, source, items, open) {
  return text.split(/(\[\[[^\]\n]+\]\])/g).map((part) => {
    if (!part.startsWith('[[') || !part.endsWith(']]')) return part;
    const raw = part.slice(2, -2);
    const path = resolveWikilink(source, raw, items);
    const label = raw.split('|')[1] || raw;
    return path ? html`<cr-bar-button class="docs-wikilink" @click=${() => open(path)}>${label}</cr-bar-button>` : html`<span class="docs-missing">${label}</span>`;
  });
}

/** Static Lit tags ensure note content can never choose an element or an attribute. */
export function renderDocMarkdown(text, source, items, open) {
  const render = (nodes, inLink = false) => nodes.map((node) => {
    const children = () => render(node.children || [], inLink || node.type === 'a');
    switch (node.type) {
      case 'text': return inLink ? node.text : wikiText(node.text, source, items, open);
      case 'p': return html`<p>${children()}</p>`;
      case 'h1': return html`<h1>${children()}</h1>`;
      case 'h2': return html`<h2>${children()}</h2>`;
      case 'h3': return html`<h3>${children()}</h3>`;
      case 'h4': return html`<h4>${children()}</h4>`;
      case 'h5': return html`<h5>${children()}</h5>`;
      case 'h6': return html`<h6>${children()}</h6>`;
      case 'ul': return html`<ul>${children()}</ul>`;
      case 'ol': return html`<ol>${children()}</ol>`;
      case 'li': return html`<li>${children()}</li>`;
      case 'blockquote': return html`<blockquote>${children()}</blockquote>`;
      case 'strong': return html`<strong>${children()}</strong>`;
      case 'em': return html`<em>${children()}</em>`;
      case 's': return html`<s>${children()}</s>`;
      case 'table': return html`<table>${children()}</table>`;
      case 'thead': return html`<thead>${children()}</thead>`;
      case 'tbody': return html`<tbody>${children()}</tbody>`;
      case 'tr': return html`<tr>${children()}</tr>`;
      case 'th': return html`<th>${children()}</th>`;
      case 'td': return html`<td>${children()}</td>`;
      case 'a': return node.href && !node.href.startsWith('#') ? html`<a href=${node.href} rel="noopener noreferrer" target="_blank">${children()}</a>` : children();
      case 'code': return html`<code>${node.text}</code>`;
      case 'pre': return html`<pre><code>${node.text}</code></pre>`;
      case 'br': return html`<br>`;
      case 'hr': return html`<hr>`;
      default: return children();
    }
  });
  return render(safeMarkdown(text));
}
