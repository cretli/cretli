import { LitElement, html, render } from 'lit';

/**
 * One row of the Todo tree (light DOM, so the global `.todo-row*` styles and the
 * panel's event wiring keep working). Stage 1 of the signals migration: the
 * component owns the static row skeleton; the panel still paints the dynamic
 * parts per row, and only for rows whose item or tree state changed.
 *
 * The skeleton is stamped synchronously through `ensureSkeleton()` because the
 * panel wires listeners and paints right after creating the element. The Lit
 * `render()` returns the identical template, so the first reactive update
 * adopts the stamped DOM instead of duplicating it.
 */
// No whitespace between tags: the markup must match the former innerHTML skeleton exactly.
const rowTemplate = () => html`<cr-checkbox class="todo-row-select" hidden></cr-checkbox><button type="button" class="todo-row-grip" draggable="false"><span class="mdi mdi-drag-vertical" aria-hidden="true"></span></button><button type="button" class="todo-row-toggle" hidden></button><button type="button" class="todo-row-main"><span class="todo-item-status-icon" aria-hidden="true"></span><span class="todo-row-worktree-badge" role="img" hidden><span class="mdi mdi-source-branch" aria-hidden="true"></span></span><span class="todo-row-text"><span class="todo-row-title"></span><span class="todo-row-meta" hidden></span><span class="todo-row-stage-host"></span></span><cr-todo-review-badge class="todo-row-review" hidden></cr-todo-review-badge><span class="todo-row-batch-badge" hidden></span><span class="todo-row-badge" hidden></span><span class="todo-row-mark" hidden></span></button><button type="button" class="todo-row-close" hidden><span class="mdi mdi-check" aria-hidden="true"></span><span class="todo-row-close-label"></span></button><button type="button" class="todo-row-add"><span class="mdi mdi-plus" aria-hidden="true"></span></button><button type="button" class="todo-row-menu" aria-haspopup="menu" aria-expanded="false"><span class="mdi mdi-dots-vertical" aria-hidden="true"></span></button>`;

class CrTodoRow extends LitElement {
  createRenderRoot() {
    return this;
  }

  ensureSkeleton() {
    if (this.querySelector('.todo-row-main')) return;
    this.classList.add('todo-row');
    this.setAttribute('role', 'treeitem');
    render(rowTemplate(), this);
  }

  render() {
    return rowTemplate();
  }
}

if (!customElements.get('cr-todo-row')) customElements.define('cr-todo-row', CrTodoRow);
export { CrTodoRow, rowTemplate };
