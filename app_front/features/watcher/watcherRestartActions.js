/**
 * Watcher tab: the two server-restart actions.
 *
 * - "Restart after cycles finish" (drain): the server refuses while delegations run.
 * - "Fast restart": running agents get a notice and a grace window, then Cretli
 *   restarts and unfinished agents continue from their note. Needs a confirmation.
 *
 * The host element is created next to the automation block, so the page shell stays untouched.
 */
import { html, render } from 'lit';
import { t } from '../../i18n/index.js';
import { restartServer } from '../../app/serverRestartCoordinator.js';
import '../../components/ui/index.js';

let confirmOpen = false;

/** Create (once) and return the host element that follows the automation block. */
function ensureHost() {
  let host = document.getElementById('todo-watcher-restart');
  if (host) return host;
  const anchor = document.getElementById('todo-watcher-automation');
  if (!anchor || !anchor.parentElement) return null;
  host = document.createElement('div');
  host.id = 'todo-watcher-restart';
  host.className = 'todo-watcher-restart';
  anchor.insertAdjacentElement('afterend', host);
  return host;
}

/**
 * @param {'drain' | 'fast'} mode
 */
async function run(mode) {
  confirmOpen = false;
  paintWatcherRestartActions();
  await restartServer({ source: 'watcher-panel', mode });
}

/** Render (or re-render) the buttons and the confirmation dialog. */
export function paintWatcherRestartActions() {
  const host = ensureHost();
  if (!host) return;
  render(html`
    <cr-bar-button @click=${() => run('drain')}>${t('devActions.restartAfterCycles')}</cr-bar-button>
    <cr-bar-button @click=${() => { confirmOpen = true; paintWatcherRestartActions(); }}>${t('devActions.fastRestart')}</cr-bar-button>
    <cr-dialog .open=${confirmOpen} .heading=${t('devActions.fastRestart')}
      @cr-dialog-close=${() => { confirmOpen = false; paintWatcherRestartActions(); }}>
      <p>${t('devActions.fastRestartConfirm')}</p>
      <cr-bar-button slot="actions" @click=${() => { confirmOpen = false; paintWatcherRestartActions(); }}>${t('common.cancel')}</cr-bar-button>
      <cr-bar-button slot="actions" variant="primary" @click=${() => run('fast')}>${t('devActions.fastRestart')}</cr-bar-button>
    </cr-dialog>`, host);
}
