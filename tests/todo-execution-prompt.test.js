import assert from 'node:assert/strict';
import { buildTodoContinueNote, stripTodoExecutionWorkflow, TODO_EXECUTION_WORKFLOW } from '../lib/todo-execution-prompt.js';
import { buildTodoAgentInitialPrompt } from '../lib/todo-agent.js';
import { appendTodoRef, extractTodoRefsFromMessage } from '../app_front/features/chat/todoMention.js';

const id = 'aaaaaaaa-1111-2222-3333-444444444444';
const note = buildTodoContinueNote('Kontynuuj to zadanie.');
const sent = appendTodoRef(`Dodatkowe wymagania\n${note}`, id);
assert.deepEqual(extractTodoRefsFromMessage(sent).todoIds, [id]);
assert.match(sent, /Dodatkowe wymagania/);
assert.match(sent, /todo_next_ready/);
assert.match(sent, /slot_occupied=false/);
assert.match(sent, /Keep the leaf doing until verification PASS/);
assert.match(sent, /Forward the pickId returned by model_pick as pick_id/);
assert.match(sent, /without re-picking or matching the proposal by time/);
assert.match(sent, /required unapproved plan/);
assert.match(sent, /Continue automatically/);
assert.equal(stripTodoExecutionWorkflow(extractTodoRefsFromMessage(sent).text), 'Dodatkowe wymagania\nKontynuuj to zadanie.');
assert.equal(stripTodoExecutionWorkflow('Ordinary message'), 'Ordinary message');

const parent = buildTodoAgentInitialPrompt({ id, title: 'Parent' }, 'chat', '', { hasChildren: true });
assert.ok(parent.includes(TODO_EXECUTION_WORKFLOW));
assert.doesNotMatch(parent, /Present the plan and wait for user approval/);
const leaf = buildTodoAgentInitialPrompt({ id, title: 'Leaf' }, 'chat', '');
assert.match(leaf, /Present the plan and wait for user approval/);
assert.ok(!leaf.includes(TODO_EXECUTION_WORKFLOW));
console.log('OK: TODO execution prompts preserve scope, review, continuation and approval gates');
