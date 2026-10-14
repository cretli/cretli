/** Existing todo start prompts must stay byte-identical; only mode full has its own builder. */
import assert from 'node:assert/strict';
import { buildTodoAgentInitialPrompt, buildTodoFullOrchestratorPrompt } from '../lib/todo-agent.js';

const todo = { id: 'abc', title: 'T', status: 'ready', plan: { markdown: 'P' } };
const a = buildTodoAgentInitialPrompt(todo, 'c1', 'http://x', { hasChildren: true });
assert.equal(a, buildTodoAgentInitialPrompt(todo, 'c1', 'http://x', { hasChildren: true }));
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
console.log('todo-agent-prompt-modes: all passed');
