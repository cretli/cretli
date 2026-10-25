import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveControlDir } from '../lib/backup/offline/control-dir.js';

let root;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-ctl-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('resolveControlDir', () => {
  it('returns the real path of a symlinked location outside the data dir', () => {
    const data = path.join(root, 'data');
    const real = path.join(root, 'ctl-real');
    fs.mkdirSync(data); fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(root, 'ctl-link'));
    assert.equal(resolveControlDir(data, path.join(root, 'ctl-link')), real);
  });

  it('defaults to <dataDir>/.cretli-control as a real path', () => {
    const data = path.join(root, 'data');
    fs.mkdirSync(data);
    fs.symlinkSync(data, path.join(root, 'data-link'));
    assert.equal(resolveControlDir(path.join(root, 'data-link')), path.join(data, '.cretli-control'));
  });

  it('rejects a symlink that points into a restore path', () => {
    const data = path.join(root, 'data');
    fs.mkdirSync(path.join(data, 'chat-history'), { recursive: true });
    fs.symlinkSync(path.join(data, 'chat-history'), path.join(root, 'sneaky'));
    assert.throws(() => resolveControlDir(data, path.join(root, 'sneaky')), (e) => e.code === 'CONTROL_DIR_INVALID');
    assert.throws(() => resolveControlDir(data, path.join(data, 'chat-history', 'ctl')), (e) => e.code === 'CONTROL_DIR_INVALID');
  });
});
