import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyCretliBootEnv,
  applyEnvFileToProcess,
  applyHttpsDefault,
  parseEnvFileContent,
} from '../lib/boot-env.js';
import { shouldGenerateDefaultTlsCerts } from '../lib/server-tls.js';

const parsed = parseEnvFileContent('USE_HTTPS=0\n# comment\nCRETLI_DATA_DIR=/tmp/isolated\nPWNED=$(echo hi)\n');
assert.equal(parsed.USE_HTTPS, '0');
assert.equal(parsed.CRETLI_DATA_DIR, '/tmp/isolated');
assert.equal(parsed.PWNED, '$(echo hi)');

const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-boot-env-')), '.env');
fs.writeFileSync(envFile, 'USE_HTTPS=0\nCRETLI_DATA_DIR=/tmp/from-env\nSSL_KEY_PATH=/tmp/from-env/key.pem\nSSL_CERT_PATH=/tmp/from-env/cert.pem\n');

const processWins = { USE_HTTPS: '1', CRETLI_DATA_DIR: '/tmp/process' };
applyEnvFileToProcess({ filePath: envFile, env: processWins });
assert.equal(processWins.USE_HTTPS, '1');
assert.equal(processWins.CRETLI_DATA_DIR, '/tmp/process');

const fromFile = {};
applyCretliBootEnv({ envFile, env: fromFile });
assert.equal(fromFile.USE_HTTPS, '0');
assert.equal(fromFile.CRETLI_DATA_DIR, '/tmp/from-env');
assert.equal(shouldGenerateDefaultTlsCerts({
  useHttpsEnv: fromFile.USE_HTTPS,
  keyPath: fromFile.SSL_KEY_PATH,
  certPath: fromFile.SSL_CERT_PATH,
  defaultKeyPath: path.join(fromFile.CRETLI_DATA_DIR, 'key.pem'),
  defaultCertPath: path.join(fromFile.CRETLI_DATA_DIR, 'cert.pem'),
}), false);

const defaults = {};
applyHttpsDefault(defaults);
assert.equal(defaults.USE_HTTPS, '1');

fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
console.log('All boot-env tests passed.');
