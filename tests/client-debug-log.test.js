import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClientDebugLog } from '../lib/client-debug-log.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-client-debug-'));
const debugLog = createClientDebugLog(tempDir);
debugLog.appendClientDebugLogFile('freeze', 'Mozilla/5.0', ['line-one', 'line-two']);
const actualBody = fs.readFileSync(debugLog.logPath, 'utf8');
assert.ok(actualBody.includes('reason=freeze'));
assert.ok(actualBody.includes('line-one'));
assert.ok(actualBody.includes('line-two'));
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('client-debug-log.test.js OK');
