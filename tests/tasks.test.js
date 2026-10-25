import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { loadTasks, loadTasksFromDirectories } from '../lib/tasks.js';

test('loadTasks reads shell tasks and substitutes workspaceFolder', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-tasks-'));
  await mkdir(path.join(dir, '.vscode'));
  await writeFile(path.join(dir, '.vscode', 'tasks.json'), `{
    // comment
    "version": "2.0.0",
    "tasks": [
      {
        "label": "Build",
        "type": "shell",
        "command": "npm",
        "args": ["run", "prod"],
        "options": { "cwd": "\${workspaceFolder}/app_front" }
      }
    ]
  }`, 'utf8');
  await mkdir(path.join(dir, 'app_front'));
  const actual = loadTasks(dir);
  assert.equal(actual.tasks.length, 1);
  assert.equal(actual.tasks[0].label, 'Build');
  assert.equal(actual.tasks[0].cwd, path.join(dir, 'app_front'));
  assert.equal(actual.tasks[0].folderName, path.basename(dir));
});

test('loadTasksFromDirectories merges every folder and prefixes duplicate labels', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cretli-tasks-multi-'));
  const first = path.join(root, 'one');
  const second = path.join(root, 'two');
  await mkdir(path.join(first, '.vscode'), { recursive: true });
  await mkdir(path.join(second, '.vscode'), { recursive: true });
  await writeFile(path.join(first, '.vscode', 'tasks.json'), JSON.stringify({
    tasks: [{ label: 'Watch', type: 'shell', command: 'echo one' }],
  }));
  await writeFile(path.join(second, '.vscode', 'tasks.json'), JSON.stringify({
    tasks: [
      { label: 'Watch', type: 'shell', command: 'echo two' },
      { label: 'Prod', type: 'shell', command: 'echo prod' },
    ],
  }));
  const actual = loadTasksFromDirectories([first, second, first]);
  assert.deepEqual(actual.tasks.map((task) => task.label), ['Watch', 'two: Watch', 'Prod']);
  assert.equal(actual.tasks[0].command.includes('one'), true);
  assert.equal(actual.tasks[1].command.includes('two'), true);
});
