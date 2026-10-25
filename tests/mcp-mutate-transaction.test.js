import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
} from '../lib/mcp/mcp-service.js';
import {
  McpConfigCorruptError,
  McpRevisionConflictError,
  getMcpJournalPath,
  getMcpSecretsPath,
  loadMcpDocument,
  loadMcpSecretsDocument,
  mutateMcpConfiguration,
  recoverMcpTransaction,
} from '../lib/persist/mcp-persist.js';
import { getMcpSecrets } from '../lib/mcp/mcp-secrets.js';

const created = await createMcpServer({
  name: 'Secrets',
  enabled: true,
  harnesses: ['sdk'],
  connection: {
    command: 'node',
    env: { TOKEN: { secret: 'TOKEN', value: 'alpha' } },
  },
}, 0);
assert.equal(getMcpSecrets(created.server.id).TOKEN, 'alpha');

let conflicted = false;
try {
  await updateMcpServer(created.server.id, {
    secrets: { TOKEN: 'beta' },
  }, 0);
} catch (err) {
  conflicted = err instanceof McpRevisionConflictError;
}
assert.equal(conflicted, true);
assert.equal(getMcpSecrets(created.server.id).TOKEN, 'alpha');

let missingRevision = false;
try {
  await createMcpServer({ name: 'NoRev', connection: { command: 'node' } }, undefined);
} catch (err) {
  missingRevision = err.code === 'VALIDATION';
}
assert.equal(missingRevision, true);

const [first, second] = await Promise.allSettled([
  updateMcpServer(created.server.id, { name: 'A' }, created.revision),
  updateMcpServer(created.server.id, { name: 'B' }, created.revision),
]);
const okCount = [first, second].filter((row) => row.status === 'fulfilled').length;
const conflictCount = [first, second].filter((row) =>
  row.status === 'rejected' && row.reason instanceof McpRevisionConflictError).length;
assert.equal(okCount, 1);
assert.equal(conflictCount, 1);
assert.equal(getMcpSecrets(created.server.id).TOKEN, 'alpha');

const listed = loadMcpDocument();
const kept = await updateMcpServer(created.server.id, {
  connection: { env: { TOKEN: { secret: 'TOKEN' } } },
}, listed.revision);
assert.equal(getMcpSecrets(created.server.id).TOKEN, 'alpha');

const journalPath = getMcpJournalPath();
const secretsPath = getMcpSecretsPath();
fs.writeFileSync(journalPath, JSON.stringify({
  expectedRevision: kept.revision,
  nextRevision: kept.revision + 1,
  servers: loadMcpDocument().servers.map((row) => (
    row.id === created.server.id ? { ...row, name: 'Recovered' } : row
  )),
  secrets: { [created.server.id]: { TOKEN: 'recovered' } },
}));
fs.unlinkSync(secretsPath);
recoverMcpTransaction();
assert.equal(loadMcpDocument().servers.find((row) => row.id === created.server.id)?.name, 'Recovered');
assert.equal(loadMcpSecretsDocument().secrets[created.server.id].TOKEN, 'recovered');
assert.equal(fs.existsSync(journalPath), false);

const mode = fs.statSync(secretsPath).mode & 0o777;
assert.ok(mode === 0o600 || mode === 0o666);

let deleteConflict = false;
try {
  await deleteMcpServer(created.server.id, 0);
} catch (err) {
  deleteConflict = err instanceof McpRevisionConflictError;
}
assert.equal(deleteConflict, true);
assert.equal(getMcpSecrets(created.server.id).TOKEN, 'recovered');

const secretsBefore = fs.readFileSync(secretsPath, 'utf8');
fs.writeFileSync(secretsPath, '{not-json');
let secretsCorrupt = false;
try {
  await updateMcpServer(created.server.id, { name: 'MustNotWrite' }, loadMcpDocument().revision);
} catch (err) {
  secretsCorrupt = err instanceof McpConfigCorruptError;
}
assert.equal(secretsCorrupt, true);
assert.equal(fs.readFileSync(secretsPath, 'utf8'), '{not-json');
fs.writeFileSync(secretsPath, secretsBefore);

await mutateMcpConfiguration(loadMcpDocument().revision, (state) => ({
  servers: state.servers.filter((row) => row.id !== created.server.id),
  secrets: {},
}));

removeIsolatedDataDir();
console.log('mcp-mutate-transaction.test.js OK');
