import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readChatFilePreview } from '../lib/chat-file-preview.js';
import { resolveExecutionFolderForChat } from '../lib/execution-folder.js';
import { workspaceFilePath } from '../app_front/features/chat/history/services/workspaceFileLinks.js';

test('file links preserve workspace paths and leave web and media URLs alone', () => {
  assert.equal(workspaceFilePath('docs/report.md'), 'docs/report.md');
  assert.equal(workspaceFilePath('./docs/my%20report.md#results'), './docs/my report.md');
  assert.equal(workspaceFilePath('/workspace/my-app/app.js:12:4'), '/workspace/my-app/app.js');
  assert.equal(workspaceFilePath('../README.md'), '../README.md');
  for (const href of ['https://example.com/report.md', 'http://localhost:5173/', '//example.com', 'mailto:a@example.com', '#results', '?tab=chat', '/api/chats/id/media/a.png', '/uploads/a.png', 'javascript:alert(1)', 'docs/%00.md', '%broken']) {
    assert.equal(workspaceFilePath(href), null, href);
  }
});

test('preview follows the chat execution folder and confines reads including symlinks', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cretli-file-preview-'));
  try {
    const project = path.join(root, 'project');
    const worktree = path.join(root, 'worktree');
    for (const base of [project, worktree]) mkdirSync(path.join(base, 'docs'), { recursive: true });
    writeFileSync(path.join(project, 'docs/report.md'), 'original');
    writeFileSync(path.join(worktree, 'docs/report.md'), 'worktree report');
    const base = resolveExecutionFolderForChat({ workspaceFolder: project, executionFolder: worktree });
    assert.equal(readChatFilePreview(base, 'docs/report.md').content, 'worktree report');
    assert.equal(readChatFilePreview(base, path.join(base, 'docs/report.md')).content, 'worktree report');
    assert.equal(readChatFilePreview(project, 'docs/report.md').content, 'original');
    assert.equal(readChatFilePreview(base, '../project/docs/report.md').error, 'files.outsideWorkspace');
    const externalFile = path.join(project, 'docs/report.md');
    assert.equal(readChatFilePreview(base, externalFile, { allowOutsideWorkspace: 'true' }).status, 400);
    const approved = readChatFilePreview(base, externalFile, { allowOutsideWorkspace: true });
    assert.equal(approved.content, 'original');
    assert.equal(approved.path, externalFile.replace(/\\/g, '/'));
    assert.equal(readChatFilePreview(base, externalFile).status, 400);
    symlinkSync(project, path.join(base, 'escape'));
    assert.equal(readChatFilePreview(base, 'escape/docs/report.md').error, 'files.outsideWorkspace');
    symlinkSync(path.join(project, 'docs/report.md'), path.join(base, 'escape.md'));
    assert.equal(readChatFilePreview(base, 'escape.md').error, 'files.outsideWorkspace');
    assert.equal(readChatFilePreview(base, 'escape.md', { allowOutsideWorkspace: true }).path, externalFile.replace(/\\/g, '/'));
    assert.equal(readChatFilePreview(base, 'missing.md').status, 404);
    assert.equal(readChatFilePreview(base, 'docs').status, 404);
    writeFileSync(path.join(base, 'huge.txt'), 'a'.repeat(1024 * 1024 + 1));
    assert.equal(readChatFilePreview(base, 'huge.txt').status, 413);
    writeFileSync(path.join(base, 'binary.dat'), Buffer.from([0, 1, 2]));
    assert.equal(readChatFilePreview(base, 'binary.dat').status, 400);
    assert.equal(readChatFilePreview(project, path.join(base, 'huge.txt'), { allowOutsideWorkspace: true }).status, 413);
    assert.equal(readChatFilePreview(project, path.join(base, 'binary.dat'), { allowOutsideWorkspace: true }).status, 400);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
