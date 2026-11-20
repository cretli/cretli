import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pl } from '../app_front/i18n/pl.js';
import { en } from '../app_front/i18n/en.js';
import { readTodoPanelSource } from './helpers/todoPanelSource.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('todo.saving and todo.savingSlow exist in both dictionaries', () => {
  for (const dict of [pl, en]) {
    assert.ok(dict.todo.saving && dict.todo.saving !== 'todo.saving');
    assert.ok(dict.todo.savingSlow);
  }
});

test('every todo.* key used by the panel save path is defined', () => {
  const src = readTodoPanelSource();
  for (const key of ['saving', 'savingSlow', 'saved', 'saveError', 'networkError']) {
    assert.ok(src.includes(`t('todo.${key}')`), key);
    assert.ok(en.todo[key] && pl.todo[key], key);
  }
});

test('status changes use the optimistic saver and no tree reload', () => {
  const src = readTodoPanelSource();
  const start = src.indexOf('async function onStatusChange');
  const body = src.slice(start, src.indexOf('async function onTitleBlur'));
  assert.match(body, /todoFieldSaver\.save/);
  assert.doesNotMatch(body, /refreshTodoList|getTodos/);
});
