import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const startScripts = ['start', 'start:lan', 'start:termux', 'start:termux:lan', 'start:no-hmr'];
for (const name of startScripts) {
  const script = String(pkg.scripts?.[name] || '');
  assert.equal(
    /USE_HTTPS=1/.test(script),
    false,
    `${name} must not force USE_HTTPS=1 so USE_HTTPS=0 npm start works`,
  );
}

const launcher = readFileSync(path.join(root, 'scripts/start-server-node22.sh'), 'utf8');
assert.equal(/USE_HTTPS=\$\{USE_HTTPS:-1\}/.test(launcher), false);
assert.match(launcher, /register-boot-env\.js/);
const termux = readFileSync(path.join(root, 'scripts/start-termux.sh'), 'utf8');
assert.equal(/USE_HTTPS=\$\{USE_HTTPS:-1\}/.test(termux), false);
const docker = readFileSync(path.join(root, 'scripts/docker-entrypoint.sh'), 'utf8');
assert.equal(/USE_HTTPS=\$\{USE_HTTPS:-1\}/.test(docker), false);

console.log('All npm-start-https tests passed.');
