import { LitElement, css, html, nothing, svg } from 'lit';
import { t } from '../../i18n/index.js';
import {
  MAP_EDGE_STYLES, MAP_HOME_VIEW, isClosed, neighborNode, panView, relationsOf, zoomView,
} from './initiativeLogic.js';

const PAN_STEP = 40;

/**
 * Initiative map: a pure view over the records and relations the panel already holds (no copy, no stored layout).
 * Horizon is the column, size the node height, state and relation type are always spelled out in text and drawn with
 * dash patterns, so nothing depends on colour. Selecting a node fires `cr-initiative-open`; the panel opens the same
 * details as the list.
 */
class CrInitiativesMap extends LitElement {
  static properties = { model: { attribute: false }, relations: { attribute: false }, view: { state: true }, focusId: { state: true } };

  static styles = css`
    :host { display:block; }
    .canvas { border:1px solid var(--cr-border-strong); border-radius:var(--cr-radius-lg); background:var(--cr-bg); overflow:hidden; touch-action:none; cursor:grab; }
    .canvas:focus-visible, g[tabindex]:focus-visible { outline:2px solid var(--cr-accent); outline-offset:2px; }
    svg { display:block; width:100%; height:min(60vh, 32rem); }
    .tools { display:flex; gap:var(--cr-space-2); margin-bottom:var(--cr-space-2); flex-wrap:wrap; align-items:center; }
    button { min-height:var(--cr-control-height); min-width:2.5rem; border:1px solid var(--cr-border-strong); border-radius:var(--cr-radius-sm); background:var(--cr-bg); color:var(--cr-text); font:inherit; cursor:pointer; }
    button:focus-visible { outline:2px solid var(--cr-accent); outline-offset:2px; }
    .node rect { fill:var(--cr-surface); stroke:var(--cr-border-strong); stroke-width:1.5; }
    .node[data-closed='true'] rect { stroke-dasharray:3 3; }
    .node[data-selected='true'] rect, .node:focus rect { stroke:var(--cr-accent); stroke-width:3; }
    .node text { fill:var(--cr-text); font:var(--cr-font-size-sm) var(--cr-font-ui); pointer-events:none; }
    .node .sub { fill:var(--cr-text-muted); font-size:var(--cr-font-size-xs); }
    .head { fill:var(--cr-text-muted); font:var(--cr-font-size-md) var(--cr-font-ui); }
    .edge { fill:none; stroke:var(--cr-text-muted); stroke-width:1.5; }
    .edge[data-type='requires'] { stroke:var(--cr-text); stroke-width:2.2; }
    .edge-label { fill:var(--cr-text-muted); font:var(--cr-font-size-xs) var(--cr-font-ui); paint-order:stroke; stroke:var(--cr-bg); stroke-width:3px; }
    .legend { display:flex; gap:var(--cr-space-3); flex-wrap:wrap; margin:var(--cr-space-2) 0; color:var(--cr-text-muted); font-size:var(--cr-font-size-sm); }
    .legend svg { width:3rem; height:.8rem; display:inline-block; vertical-align:middle; }
    .legend line { stroke:var(--cr-text-muted); stroke-width:2; }
    .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  `;

  constructor() {
    super();
    this.model = { nodes: [], edges: [], columns: [], width: 0, height: 0 };
    this.relations = [];
    this.view = { ...MAP_HOME_VIEW };
    this.focusId = '';
    this.drag = null;
    this.onLanguage = () => this.requestUpdate();
  }

  connectedCallback() { super.connectedCallback(); window.addEventListener('cr-lang-changed', this.onLanguage); }
  disconnectedCallback() { window.removeEventListener('cr-lang-changed', this.onLanguage); super.disconnectedCallback(); }

  open(id) { this.dispatchEvent(new CustomEvent('cr-initiative-open', { detail: { id }, bubbles: true, composed: true })); }

  zoom(factor) { this.view = zoomView(this.view, factor); }

  nodeLabel(node) {
    const { item } = node;
    const rels = relationsOf(item.id, this.relations, (id) => this.model.nodes.find((n) => n.id === id)?.item.title || id)
      .map((r) => `${t(`plans.map.relation.${r.type}.${r.direction}`)} ${r.otherName}`);
    return [item.title, `${t('plans.statusLabel')}: ${t(`plans.status.${item.status}`)}`, `${t('plans.horizonLabel')}: ${t(`plans.horizon.${item.horizon}`)}`,
      `${t('plans.scopeSizeLabel')}: ${item.scopeSize || '?'}`, ...(isClosed(item) ? [t('plans.map.closed')] : []), ...rels].join('. ');
  }

  onNodeKey(event, node) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.open(node.id); return; }
    if (!event.key.startsWith('Arrow')) return;
    event.preventDefault();
    const id = neighborNode(this.model.nodes, node.id, event.key);
    this.focusId = id;
    this.updateComplete.then(() => /** @type {HTMLElement | null} */ (this.renderRoot.querySelector(`[data-node="${id}"]`))?.focus());
  }

  /** Keys on the canvas itself (not a node): arrows pan, plus/minus zoom, 0 resets. */
  onCanvasKey(event) {
    if (event.target !== event.currentTarget) return;
    const pan = { ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0], ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP] }[event.key];
    if (pan) { event.preventDefault(); this.view = panView(this.view, pan[0], pan[1]); return; }
    if (event.key === '+' || event.key === '=') this.zoom(1.2);
    else if (event.key === '-') this.zoom(1 / 1.2);
    else if (event.key === '0') this.view = { ...MAP_HOME_VIEW };
  }

  onPointerDown(event) {
    if (event.target.closest?.('[data-node]')) return;
    this.drag = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  onPointerMove(event) {
    if (!this.drag) return;
    this.view = panView(this.view, (event.clientX - this.drag.x) / this.view.zoom, (event.clientY - this.drag.y) / this.view.zoom);
    this.drag = { x: event.clientX, y: event.clientY };
  }

  onWheel(event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    this.zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }

  edgePath(edge) {
    const a = edge.from;
    const b = edge.to;
    if (edge.loop) {
      const x = a.x + a.width;
      return { d: `M ${x} ${a.y + 14} c 40 -10 40 ${a.height - 18} 0 ${a.height - 28}`, lx: x + 34, ly: a.y + a.height / 2 };
    }
    const leftToRight = a.x <= b.x;
    const sx = a.x === b.x ? a.x + a.width / 2 : (leftToRight ? a.x + a.width : a.x);
    const ex = a.x === b.x ? b.x + b.width / 2 : (leftToRight ? b.x : b.x + b.width);
    const sy = a.x === b.x ? (a.y < b.y ? a.y + a.height : a.y) : a.y + a.height / 2;
    const ey = a.x === b.x ? (a.y < b.y ? b.y : b.y + b.height) : b.y + b.height / 2;
    const mx = (sx + ex) / 2;
    const d = a.x === b.x ? `M ${sx} ${sy} L ${ex} ${ey}` : `M ${sx} ${sy} C ${mx} ${sy} ${mx} ${ey} ${ex} ${ey}`;
    return { d, lx: mx, ly: (sy + ey) / 2 - 4 };
  }

  renderEdge(edge) {
    const { d, lx, ly } = this.edgePath(edge);
    const style = MAP_EDGE_STYLES[edge.type];
    return svg`<g><path class="edge" data-type=${edge.type} d=${d} stroke-dasharray=${style.dash || 'none'} marker-end="url(#arrow)"></path>
      <text class="edge-label" x=${lx} y=${ly} text-anchor="middle">${t(`plans.map.type.${edge.type}`)}</text></g>`;
  }

  renderNode(node, tabbable) {
    const { item } = node;
    const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    return svg`<g class="node" data-node=${node.id} data-closed=${isClosed(item)} tabindex=${tabbable ? 0 : -1} role="button"
      aria-label=${this.nodeLabel(node)} @click=${() => this.open(node.id)} @keydown=${(e) => this.onNodeKey(e, node)} @focus=${() => { this.focusId = node.id; }}>
      <title>${item.title}</title>
      <rect x=${node.x} y=${node.y} width=${node.width} height=${node.height} rx="6"></rect>
      <text x=${node.x + 10} y=${node.y + 20}>${clip(item.title, 30)}</text>
      <text class="sub" x=${node.x + 10} y=${node.y + 38}>${t(`plans.status.${item.status}`)} · ${t('plans.scopeSizeLabel')} ${item.scopeSize || '?'}${isClosed(item) ? ` · ${t('plans.map.closed')}` : ''}</text>
      ${node.height > 60 ? svg`<text class="sub" x=${node.x + 10} y=${node.y + 54}>${t(`plans.priority.${item.priority}`)}</text>` : nothing}
    </g>`;
  }

  render() {
    const m = this.model;
    const { zoom, x, y } = this.view;
    const first = this.focusId && m.nodes.some((n) => n.id === this.focusId) ? this.focusId : m.nodes[0]?.id;
    return html`
      <div class="tools" role="group" aria-label=${t('plans.map.controls')}>
        <button @click=${() => this.zoom(1.2)} aria-label=${t('plans.map.zoomIn')}>+</button>
        <button @click=${() => this.zoom(1 / 1.2)} aria-label=${t('plans.map.zoomOut')}>−</button>
        <button @click=${() => { this.view = { ...MAP_HOME_VIEW }; }}>${t('plans.map.reset')}</button>
        <span class="legend-note">${Math.round(zoom * 100)}%</span>
      </div>
      <div class="canvas" tabindex="0" role="group" aria-label=${t('plans.map.canvas')} aria-describedby="map-help"
        @keydown=${(e) => this.onCanvasKey(e)} @pointerdown=${(e) => this.onPointerDown(e)} @pointermove=${(e) => this.onPointerMove(e)}
        @pointerup=${() => { this.drag = null; }} @pointercancel=${() => { this.drag = null; }} @wheel=${(e) => this.onWheel(e)}>
        <svg viewBox=${`${-x} ${-y} ${m.width / zoom} ${m.height / zoom}`} preserveAspectRatio="xMinYMin meet" role="presentation">
          <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--cr-text-muted)"></path></marker></defs>
          ${m.columns.map((c, i) => svg`<text class="head" x=${m.pad + i * (m.columnWidth + m.columnGap)} y=${m.pad + 8}>${t(`plans.horizon.${c.horizon}`)} (${c.shown}/${c.total})</text>`)}
          ${m.edges.map((e) => this.renderEdge(e))}
          ${m.nodes.map((n) => this.renderNode(n, n.id === first))}
        </svg>
      </div>
      <p id="map-help" class="sr">${t('plans.map.help')}</p>
      <div class="legend" aria-label=${t('plans.map.legend')}>
        ${Object.entries(MAP_EDGE_STYLES).map(([type, s]) => html`<span><svg viewBox="0 0 48 10" aria-hidden="true"><line x1="0" y1="5" x2="48" y2="5" stroke-dasharray=${s.dash || 'none'}></line></svg> ${t(`plans.map.type.${type}`)}</span>`)}
      </div>`;
  }
}

if (!customElements.get('cr-initiatives-map')) customElements.define('cr-initiatives-map', CrInitiativesMap);
export { CrInitiativesMap };
