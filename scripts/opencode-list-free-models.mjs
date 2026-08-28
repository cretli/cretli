import { listOpenCodeModels, getOrCreateOpenCodeInstance } from '../lib/opencode/opencode-server-manager.js';

const folder = process.argv[2] || process.cwd();
const models = await listOpenCodeModels(folder);
const hits = models.filter((m) => /ox|alpha|free|pickle|preview/i.test(`${m.id} ${m.name}`));
console.log(JSON.stringify(hits, null, 2));

const inst = await getOrCreateOpenCodeInstance({ workspaceFolder: folder });
try {
  const providers = await inst.client.config.providers({ query: { directory: folder } });
  const list = providers?.data?.providers ?? providers?.providers ?? [];
  for (const p of list) {
    if (!/opencode/i.test(String(p.id))) continue;
    console.log('provider', p.id, 'model count', Object.keys(p.models || {}).length);
  }
} finally {
  inst.release();
}
