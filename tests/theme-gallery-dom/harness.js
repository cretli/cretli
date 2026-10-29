import '../../app_front/css/tokens.scss';
import '../../app_front/css/features/files/_files-tree.scss';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import { initTheme, initThemeSelect } from '../../app_front/core/theme/theme.js';
import { getTerminalTheme, listenForTerminalThemeChanges } from '../../app_front/features/terminal/services/terminalTheme.js';

hljs.registerLanguage('javascript', javascript);
window.themeHarness = { bootId: crypto.randomUUID() };
const terminal = new Terminal({ cols: 50, rows: 3, theme: getTerminalTheme() });
terminal.open(document.getElementById('terminal'));
terminal.write('Cretli theme preview\r\n\x1b[31mred \x1b[32mgreen \x1b[34mblue\x1b[0m');
listenForTerminalThemeChanges(() => [terminal]);
window.themeHarness.terminal = terminal;
document.getElementById('code').innerHTML = hljs.highlight('const theme = "Cretli";', { language: 'javascript' }).value;
initTheme();
initThemeSelect().then(() => { window.themeHarness.ready = true; });
