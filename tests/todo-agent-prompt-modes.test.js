/** Start prompts remain bounded and preserve role, approval and phase gates. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveProjectPath } from '../lib/runtime-paths.js';
import { TODO_EXECUTION_WORKFLOW } from '../lib/todo-execution-prompt.js';
import { buildTodoAgentInitialPrompt, buildTodoFullOrchestratorPrompt, buildTodoRefineInitialPrompt } from '../lib/todo-agent.js';

const todo = { id: 'abc', title: 'T', status: 'ready', plan: { markdown: 'P' } };
const a = buildTodoAgentInitialPrompt(todo, 'c1', { hasChildren: true });
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
  buildTodoAgentInitialPrompt(largeTodo, 'chat', { previousChats }),
  buildTodoAgentInitialPrompt(largeTodo, 'chat', { previousChats, hasChildren: true }),
  buildTodoFullOrchestratorPrompt(largeTodo, 'chat', { previousChats }),
]) {
  assert.ok(prompt.length < 4000, `start grew to ${prompt.length} characters`);
  assert.doesNotMatch(prompt, /BODY_SENTINEL|PLAN_SENTINEL|HISTORY_SENTINEL|old-chat-|curl|set-todo-from-agent/);
  assert.match(prompt, /cretli-ref todo=aaaaaaaa-1111-2222-3333-444444444444/);
  assert.match(prompt, /todo_show, including every body\/plan page/);
  assert.match(prompt, /Never infer approval from status doing/);
  assert.match(prompt, /Plan: saved and approved/);
  assert.match(prompt, /Siblings run sequentially in sibling order/);
  assert.match(prompt, /Status transitions: idea -> ready -> doing -> done/);
  assert.match(prompt, /MCP todo_update contract/);
  assert.match(prompt, /MCP tools are unavailable/);
  assert.match(prompt, /report a concrete blocker/);
  assert.ok(!prompt.includes(TODO_EXECUTION_WORKFLOW));
}
const direct = buildTodoAgentInitialPrompt(largeTodo, 'chat');
assert.match(direct, /direct executor/);
assert.match(direct, /without asking for approval again/);
assert.match(direct, /do not start child delegations/);
const unapproved = buildTodoAgentInitialPrompt({ ...largeTodo, plan: { markdown: 'draft' } }, 'chat');
assert.match(unapproved, /Plan: saved, not approved/);
assert.match(unapproved, /STOP for human approval/);
const draft = buildTodoAgentInitialPrompt({ id: largeTodo.id, status: 'doing' }, 'chat');
assert.match(draft, /Plan: none yet/);
assert.match(draft, /never approve it yourself/);
const protocol = readFileSync(resolveProjectPath('docs', 'todo-direct-executor-protocol.md'), 'utf8');
assert.ok(direct.includes(resolveProjectPath('docs', 'todo-direct-executor-protocol.md')));
assert.match(protocol, /expected_updated_at/);
assert.match(protocol, /Never write the server-owned `review`/);
assert.match(protocol, /all\n {3}acceptance criteria are met and required verification passes/);
assert.match(protocol, /must\nnot start implementation or review delegations/);
// The canonical protocol carries the durable ordering, status and MCP-unavailable detail.
assert.match(protocol, /## Ordering and status/);
assert.match(protocol, /idea -> ready -> doing -> done/);
assert.match(protocol, /## When the Cretli MCP tools are unavailable/);
assert.match(protocol, /hand-built `set-todo-from-agent` payload/);
assert.match(protocol, /read-only evidence with the local file, search and git tools/);
assert.match(protocol, /Leave the TODO status, plan approval and/);
const disabledPlan = buildTodoFullOrchestratorPrompt(todo, 'chat', { phases: { plan: false } });
assert.match(disabledPlan, /phase_disabled:plan/);
assert.doesNotMatch(disabledPlan, /Run the skill @cretli-todo-refine-loop/);
const disabledImplementation = buildTodoFullOrchestratorPrompt(largeTodo, 'chat', { phases: { implement: false } });
assert.match(disabledImplementation, /phase_disabled:implement/);
assert.doesNotMatch(disabledImplementation, /3\. Implementation/);
// Opt-in reviewer pool: switch off = unchanged prompts, on = extra instruction.
{
  const members = [{ harness: 'claude', model: 'rev-a' }, { harness: 'codex', model: 'rev-b' }];
  const refineOff = buildTodoRefineInitialPrompt(largeTodo, 'chat');
  assert.equal(buildTodoRefineInitialPrompt(largeTodo, 'chat', { reviewerPool: [] }), refineOff);
  assert.ok(!refineOff.includes('REVIEWER POOL'));
  const refineOn = buildTodoRefineInitialPrompt(largeTodo, 'chat', { reviewerPool: members });
  assert.match(refineOn, /REVIEWER POOL/);
  assert.match(refineOn, /claude\/rev-a, codex\/rev-b/);
  assert.doesNotMatch(refineOn, /resume_session_of\)/);
  assert.equal(refineOn.replace(/REVIEWER POOL[\s\S]*?\n\n(?=Finish with)/, ''), refineOff);
  const fullOff = buildTodoFullOrchestratorPrompt(largeTodo, 'chat', {});
  assert.equal(buildTodoFullOrchestratorPrompt(largeTodo, 'chat', { reviewerPool: [] }), fullOff);
  assert.match(buildTodoFullOrchestratorPrompt(largeTodo, 'chat', { reviewerPool: members }), /REVIEWER POOL/);
}
console.log('todo-agent-prompt-modes: all passed');

// An approved ancestor plan opens the gate like the tree does (lib/todo-tree.js).
const ancestor = { id: 'root-1', title: 'Approved root' };
const gated = buildTodoAgentInitialPrompt({ id: 'leaf-1', status: 'ready' }, 'chat', { approvedAncestor: ancestor });
assert.match(gated, /Plan gate: open - the plan of ancestor root-1/);
assert.doesNotMatch(buildTodoAgentInitialPrompt({ id: 'leaf-1', status: 'ready' }, 'chat'), /Plan gate: open/);
const ownApproved = buildTodoAgentInitialPrompt({ id: 'leaf-1', plan: { markdown: 'p', approvedAt: '2026-01-01' } }, 'chat', { approvedAncestor: ancestor });
assert.doesNotMatch(ownApproved, /Plan gate: open/);
const fullGated = buildTodoFullOrchestratorPrompt({ id: 'leaf-1', status: 'ready' }, 'chat', { approvedAncestor: ancestor, phases: { integrate: true } });
assert.match(fullGated, /CURRENT PHASE: execution/);
// Integration prepare goes through the MCP tool, not through library paths.
assert.match(fullGated, /todo_integration with action prepare/);
assert.doesNotMatch(fullGated, /lib\/workspace-watcher-integration\.js/);
assert.match(fullGated, /no_worktree/);
