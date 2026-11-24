const $ = (id) => document.getElementById(id);
const ask = (message) => chrome.runtime.sendMessage(message);
const DEFAULT_URL = 'wss://127.0.0.1:3011/ws-chrome-ext';

/** ws:// is accepted for loopback only. */
function validUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'wss:') return true;
    return url.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  } catch {
    return false;
  }
}

function show(status) {
  $('state').textContent = status.paired
    ? `Paired${status.connected ? ' and connected' : ', not connected'}.`
    : 'Not paired.';
}

$('pair').onclick = async () => {
  const serverUrl = $('url').value.trim() || DEFAULT_URL;
  if (!validUrl(serverUrl)) { $('state').textContent = 'Use wss://, or ws:// for 127.0.0.1 / localhost only.'; return; }
  show(await ask({ type: 'pair', code: $('code').value, serverUrl }));
};
chrome.runtime.onMessage.addListener((message) => { if (message.type === 'status') show(message.status); });
const initial = await ask({ type: 'status' });
$('url').value = initial.serverUrl;
show(initial);
