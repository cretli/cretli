const $ = (id) => document.getElementById(id);
const ask = (message) => chrome.runtime.sendMessage(message);

async function render(status) {
  $('paired').textContent = status.paired ? 'yes' : 'no';
  $('connected').textContent = status.connected ? 'yes' : 'no';
  $('killed').textContent = status.killed ? 'ON' : 'off';
  $('kill').hidden = status.killed;
  $('resume').hidden = !status.killed;
  const list = $('domains');
  list.replaceChildren();
  for (const domain of [...status.allowed, ...status.pending.filter((d) => !status.allowed.includes(d))]) {
    const li = document.createElement('li');
    li.textContent = domain;
    if (status.allowed.includes(domain)) {
      const button = document.createElement('button');
      button.textContent = 'Grant Chrome access';
      button.onclick = async () => { await ask({ type: 'grant', domain }); };
      li.append(' ', button);
    } else {
      li.append(' (waiting for approval in Cretli)');
    }
    list.append(li);
  }
}

$('kill').onclick = async () => render(await ask({ type: 'kill' }));
$('resume').onclick = async () => render(await ask({ type: 'resume' }));
$('options').onclick = () => chrome.runtime.openOptionsPage();
chrome.runtime.onMessage.addListener((message) => { if (message.type === 'status') render(message.status); });
render(await ask({ type: 'status' }));
