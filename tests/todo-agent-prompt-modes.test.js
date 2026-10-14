/** Start prompts remain bounded and preserve role, approval and phase gates. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveProjectPath } from '../lib/runtime-paths.js';
import { TODO_EXECUTION_WORKFLOW } from '../lib/todo-execution-prompt.js';
import { buildTodoAgentInitialPrompt, buildTodoFullOrchestratorPrompt } from '../lib/todo-agent.js';

const todo = { id: 'abc', title: 'T', status: 'ready', plan: { markdown: 'P' } };
const a = buildTodoAgentInitialPrompt(todo, 'c1', 'http://x', { hasChildren: true });
assert.match(a, /orchestrate the entire subtree/);
assert.doesNotMatch(a, /per-todo orchestrator/);
const noPlan = buildTodoFullOrchestratorPrompt({ id: 'abc', title: 'T' }, 'c1');
assert.match(noPlan, /@cretli-todo-refine-loop/);
assert.match(noPlan, /ready for human approval/);
const reviewed = buildTodoFullOrchestratorPrompt({ ...todo, review: { plan: { state: 'passed' } } }, 'c1');
assert.match(reviewed, /do not repeat it/);
assert.doesNotMatch(reviewed, /Run the skill @cretli-todo-refine-loop/);
const approved = buildTodoFullOrchestratorPrompt({ ...todo, plan: { markdown: 'P', approvedAt: '2026-01-01' } }, 'c1');
assert.match(approved, /3\. Implementation/);
assert.doesNotMatch(approved, /ready for human approval/);
for (const p of [noPlan, reviewed, approved]) {
  assert.doesNotMatch(p.replace(/never call todo_integration with action confirm|Never call todo_integration with action confirm/, ''), /todo_integration/);
  assert.doesNotMatch(p, /\bgit (commit|push)\b/);
}
// Large stored plans and histories must not inflate any execution start.
const largeTodo = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  title: 'Long task title '.repeat(1000),
  status: 'doing',
  body: 'BODY_SENTINEL '.repeat(10000),
  plan: { markdown: 'PLAN_SENTINEL '.repeat(10000), approvedAt: '2026-01-01' },
};
const previousChats = Array.from({ length: 100 }, (_, index) => ({
  id: `old-chat-${index}`, title: 'HISTORY_SENTINEL '.repeat(1000),
}));
for (const prompt of [
  buildTodoAgentInitialPrompt(largeTodo, 'chat', 'https://localhost', { previousChats }),
  buildTodoAgentInitialPrompt(largeTodo, 'chat', '', { previousChats, hasChildren: true }),
  buildTodoFullOrchestratorPrompt(largeTodo, 'chat', { previousChats }),
]) {
  assert.ok(prompt.length < 4000, `start grew to ${prompt.length} characters`);
  assert.doesNotMatch(prompt, /BODY_SENTINEL|PLAN_SENTINEL|HISTORY_SENTINEL|old-chat-|curl|set-todo-from-agent/);
  assert.match(prompt, /cretli-ref todo=aaaaaaaa-1111-2222-3333-444444444444/);
  assert.match(prompt, /todo_show, including every body\/plan page/);
  assert.match(prompt, /Never infer approval from status doing/);
  assert.match(prompt, /Plan: saved and approved/);
  assert.ok(!prompt.includes(TODO_EXECUTION_WORKFLOW));
}
const direct = buildTodoAgentInitialPrompt(largeTodo, 'chat', '');
assert.match(direct, /direct executor/);
assert.match(direct, /without asking for approval again/);
assert.match(direct, /do not start child delegations/);
const unapproved = buildTodoAgentInitialPrompt({ ...largeTodo, plan: { markdown: 'draft' } }, 'chat', '');
assert.match(unapproved, /Plan: saved, not approved/);
assert.match(unapproved, /STOP for human approval/);
const draft = buildTodoAgentInitialPrompt({ id: largeTodo.id, status: 'doing' }, 'chat', '');
assert.match(draft, /Plan: none yet/);
assert.match(draft, /never approve it yourself/);
const protocol = readFileSync(resolveProjectPath('docs', 'todo-direct-executor-protocol.md'), 'utf8');
assert.ok(direct.includes(resolveProjectPath('docs', 'todo-direct-executor-protocol.md')));
assert.match(protocol, /expected_updated_at/);
assert.match(protocol, /Never write the server-owned `review`/);
assert.match(protocol, /all\n   acceptance criteria are met and required verification passes/);
assert.match(protocol, /must\nnot start implementation or review delegations/);
const disabledPlan = buildTodoFullOrchestratorPrompt(todo, 'chat', { phases: { plan: false } });
assert.match(disabledPlan, /phase_disabled:plan/);
assert.doesNotMatch(disabledPlan, /Run the skill @cretli-todo-refine-loop/);
const disabledImplementation = buildTodoFullOrchestratorPrompt(largeTodo, 'chat', { phases: { implement: false } });
assert.match(disabledImplementation, /phase_disabled:implement/);
assert.doesNotMatch(disabledImplementation, /3\. Implementation/);
console.log('todo-agent-prompt-modes: all passed');
