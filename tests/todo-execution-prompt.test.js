import assert from 'node:assert/strict';
import { buildTodoContinueNote, stripTodoExecutionWorkflow, TODO_CONTINUE_INSTRUCTIONS, TODO_EXECUTION_WORKFLOW } from '../lib/todo-execution-prompt.js';
import { buildTodoAgentInitialPrompt } from '../lib/todo-agent.js';
import { appendTodoRef, extractTodoRefsFromMessage } from '../app_front/features/chat/todoMention.js';

const id = 'aaaaaaaa-1111-2222-3333-444444444444';
const note = buildTodoContinueNote('Kontynuuj to zadanie.');
const sent = appendTodoRef(`Dodatkowe wymagania\n${note}`, id);
assert.deepEqual(extractTodoRefsFromMessage(sent).todoIds, [id]);
assert.match(sent, /Dodatkowe wymagania/);
assert.match(sent, /todo_show, including every body\/plan page/);
assert.match(sent, /execution_protocol_path/);
assert.match(sent, /independent review/);
assert.match(sent, /respect human plan approval/);
assert.ok(note.length < 700);
assert.ok(!sent.includes(TODO_EXECUTION_WORKFLOW));
assert.match(TODO_EXECUTION_WORKFLOW, /todo_next_ready/);
assert.match(TODO_EXECUTION_WORKFLOW, /newFailures/);
assert.match(TODO_EXECUTION_WORKFLOW, /preexistingFailures/);
assert.match(TODO_EXECUTION_WORKFLOW, /ONE follow-up todo/);
assert.match(TODO_EXECUTION_WORKFLOW, /slot_occupied=false/);
assert.match(TODO_EXECUTION_WORKFLOW, /Keep the leaf doing until verification PASS/);
assert.match(TODO_EXECUTION_WORKFLOW, /server persists the review status/);
assert.match(TODO_EXECUTION_WORKFLOW, /re-read it with `todo_show`/);
assert.match(TODO_EXECUTION_WORKFLOW, /never try to set it with `todo_update`/);
assert.match(TODO_EXECUTION_WORKFLOW, /Forward the pickId returned by model_pick as pick_id/);
assert.match(TODO_EXECUTION_WORKFLOW, /without re-picking or matching the proposal by time/);
assert.match(TODO_EXECUTION_WORKFLOW, /required unapproved plan/);
assert.match(TODO_EXECUTION_WORKFLOW, /Continue automatically/);
assert.match(TODO_EXECUTION_WORKFLOW, /workflow_show with leaf_id/);
assert.match(TODO_EXECUTION_WORKFLOW, /max_rounds=4/);
assert.match(TODO_EXECUTION_WORKFLOW, /assignment=fix/);
assert.match(TODO_EXECUTION_WORKFLOW, /exclude_models/);
assert.match(TODO_EXECUTION_WORKFLOW, /not a blanket shell prohibition/);
assert.match(TODO_EXECUTION_WORKFLOW, /At the soft checkpoint \(15 minutes fix\/review, 30 minutes implement\)/);
assert.match(TODO_EXECUTION_WORKFLOW, /never extends a user deadline/);
assert.match(TODO_EXECUTION_WORKFLOW, /run delegation_verify on that delegation id before starting a code review/);
assert.match(TODO_EXECUTION_WORKFLOW, /workflow_update rejected_findings=\[\{key, reason: false_positive\|wont_fix\|duplicate\|out_of_scope_elsewhere, note\}\]/);
assert.match(TODO_EXECUTION_WORKFLOW, /OUT_OF_SCOPE and gets its own todo, never a false_positive/);
assert.match(TODO_EXECUTION_WORKFLOW, /`LESSONS CHECKED`[^.]*never acceptance criteria/);
assert.match(TODO_EXECUTION_WORKFLOW, /Cretli MCP tools are unavailable/);
assert.match(TODO_EXECUTION_WORKFLOW, /report a concrete blocker \(which call failed, what remains unknown\)/);
assert.match(TODO_EXECUTION_WORKFLOW, /Never guess live state, invent a status transition, or execute a copied plan/);
assert.equal(stripTodoExecutionWorkflow(extractTodoRefsFromMessage(sent).text), 'Dodatkowe wymagania\nKontynuuj to zadanie.');
assert.equal(stripTodoExecutionWorkflow('Ordinary message'), 'Ordinary message');
assert.equal(stripTodoExecutionWorkflow(`Earlier user text\n\n${TODO_EXECUTION_WORKFLOW}`), 'Earlier user text');
assert.equal(stripTodoExecutionWorkflow(`Earlier user text\n\n${TODO_CONTINUE_INSTRUCTIONS}`), 'Earlier user text');
const quoted = `My instructions include ${TODO_CONTINUE_INSTRUCTIONS}\nKeep this user ending.`;
assert.equal(stripTodoExecutionWorkflow(quoted), quoted);

const parent = buildTodoAgentInitialPrompt({ id, title: 'Parent' }, 'chat', '', { hasChildren: true });
assert.match(parent, /read .*todo-execution-prompt\.js/);
assert.ok(!parent.includes(TODO_EXECUTION_WORKFLOW));
assert.match(parent, /do not implement in this chat/);
assert.doesNotMatch(parent, /Present the plan and wait for user approval/);
const leaf = buildTodoAgentInitialPrompt({ id, title: 'Leaf' }, 'chat', '');
assert.match(leaf, /direct-executor protocol/);
assert.match(leaf, /STOP for human approval/);
assert.match(leaf, /do not start child delegations/);
assert.ok(!leaf.includes(TODO_EXECUTION_WORKFLOW));
console.log('OK: TODO execution prompts preserve scope, review, continuation and approval gates');

// Opt-in reviewer pool: off = unchanged, on = extra instruction.
{
  const { buildReviewerPoolInstruction } = await import('../lib/todo-execution-prompt.js');
  const members = [{ harness: 'claude', model: 'rev-a' }, { harness: 'codex', model: 'rev-b' }];
  const instruction = buildReviewerPoolInstruction(members);
  assert.match(instruction, /REVIEWER POOL/);
  assert.match(instruction, /claude\/rev-a, codex\/rev-b/);
  assert.match(instruction, /prefer_models/);
  assert.match(instruction, /count=2/, 'the pool pick must ask for both reviewers');
  assert.match(instruction, /exclude_models/, 'a replacement excludes the surviving member');
  assert.match(instruction, /Do not use resume_session_of/);
  assert.ok(instruction.length > 100);
  const perSubject = buildReviewerPoolInstruction(members, { policies: [
    { subject: 'plan', selection: 'fixed_pair', session: 'leaf', known: [{ harness: 'claude', model: 'rev-a' }, { harness: 'codex', model: 'rev-b' }] },
    { subject: 'code', selection: 'fixed_pair', session: 'orchestrator', known: [{ harness: 'claude', model: 'rev-a' }, { harness: 'qwen', model: 'rev-c' }] },
  ] });
  assert.doesNotMatch(perSubject, /fixed pool of two/, 'subject-specific pairs must not be collapsed into one pair');
  assert.match(perSubject, /plan review: fixed pair claude\/rev-a, codex\/rev-b/);
  assert.match(perSubject, /code review: fixed pair claude\/rev-a, qwen\/rev-c/);
  assert.match(perSubject, /matching review_subject and count=2/);
  assert.doesNotMatch(perSubject, /claude\/rev-a, codex\/rev-b, qwen\/rev-c/);
  // F9: the outside-pair contract must match the server (fresh chat, pair kept).
  assert.doesNotMatch(perSubject, /server rejects a reviewer outside the pair/);
  assert.match(perSubject, /NOT rejected/);
  assert.match(perSubject, /reuse_not_pool_member/);
  assert.match(perSubject, /never changes the configured pair/);
  // F11: fixed-pair policy lines extend, never replace, the pool safeguards.
  assert.match(perSubject, /never pick the implementer as a reviewer/);
  assert.match(perSubject, /rotation\.pool\.degraded=true/);
  assert.match(perSubject, /exclude_models = \[the failed member, the surviving member, the implementer\]/);
  const autoOnly = buildReviewerPoolInstruction([], { policies: [
    { subject: 'code', selection: 'auto', session: 'fresh', known: [] },
  ] });
  assert.match(autoOnly, /code review: automatic reviewer selection/);
  assert.doesNotMatch(autoOnly, /never pick the implementer as a reviewer/, 'no fixed pool means no pool safeguards');
  const off = buildTodoAgentInitialPrompt({ id, title: 'T', status: 'ready' }, 'chat-1', 'https://x', { hasChildren: true });
  const on = buildTodoAgentInitialPrompt({ id, title: 'T', status: 'ready' }, 'chat-1', 'https://x', { hasChildren: true, reviewerPool: members });
  assert.ok(!off.includes('REVIEWER POOL'));
  assert.match(on, /REVIEWER POOL/);
}
