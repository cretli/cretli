/**
 * MCP todo tools through both clients (in-process and remote HTTP), plus chat
 * history (`chats[]`) and id-prefix resolution.
 */
import assert from 'node:assert/strict';
import './fixtures/fake-transport.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-tools-data-'));
process.env.CRETLI_DATA_DIR = dataDir;

const { addChat, loadChats } = await import('../lib/persist/chats-persist.js');
const { addTodo, loadTodosData, saveTodosData, updateTodo, writeTodoReview } = await import('../lib/persist/todos-persist.js');
const { FEEDBACK_ROOT_MARKER } = await import('../lib/feedback-marker.js');
const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
const { createInProcessMcpClient } = await import('../lib/mcp/mcp-inprocess-client.js');
const { createCretliMcpToolHandlers } = await import('../lib/mcp/mcp-builtin-tools.js');
const { buildTodoChatIndex, enrichTodoItemsWithSourceChat } = await import('../lib/todo-source-chat.js');
const { CretliApiClient } = await import('../lib/remote-api-client.js');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

setBuiltinMcpRuntimeDeps({
  dataDir,
  workspaceDirForAgent: () => '',
  taskRuns: new Map(),
});

const root = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-tools-ws-'));
const wsInProcess = path.join(root, 'in-process');
const wsPrefix = path.join(root, 'prefix');
const wsRemote = path.join(root, 'remote');
const wsRemotePrefix = path.join(root, 'remote-prefix');
const wsReview = path.join(root, 'review');
for (const dir of [wsInProcess, wsPrefix, wsRemote, wsRemotePrefix, wsReview]) mkdirSync(dir, { recursive: true });

const chatIp = addChat('sess-ip', 'In-process chat', null, wsInProcess, 'model-ip', { agentTransport: 'testfake', sdkMode: 'agent' });
const chatRemote = addChat('sess-remote', 'Remote chat', null, wsRemote, 'model-r', { agentTransport: 'sdk', sdkMode: 'agent' });

function handlersFor(client, chatId, workspaceFolder, harness) {
  return createCretliMcpToolHandlers(client, {
    chatId,
    workspaceFolder,
    harness,
    mode: 'agent',
    builtinClient: client,
  });
}

const ipClient = createInProcessMcpClient({ harness: 'testfake', chatId: chatIp.id, workspaceFolder: wsInProcess });
const ip = handlersFor(ipClient, chatIp.id, wsInProcess, 'testfake');

const feedbackContainer = addTodo(dataDir, wsInProcess, { title: 'Feedback root', body: FEEDBACK_ROOT_MARKER }).item;
const feedbackReport = addTodo(dataDir, wsInProcess, { title: 'Feedback report', parentId: feedbackContainer.id }).item;
const extractedFeedback = addTodo(dataDir, wsInProcess, { title: 'Extracted report', sourceTodoId: feedbackReport.id }).item;
const clearSource = await ip.todo_update({ todo_id: extractedFeedback.id, expected_updated_at: extractedFeedback.updatedAt,
  patch: { source_todo_id: '' } });
check('MCP source detachment retains server-owned feedback provenance', () => {
  assert.equal(clearSource.isError, false);
  const saved = loadTodosData(dataDir, wsInProcess).items.find((row) => row.id === extractedFeedback.id);
  assert.equal(saved.sourceTodoId, undefined);
  assert.deepEqual(saved.feedbackOrigin, { kind: 'extracted', rootId: feedbackContainer.id, reportId: feedbackReport.id });
});
const forgedCreate = await ip.todo_create({ title: 'Forged feedback', idempotency_key: 'forged-feedback', feedbackOrigin: {} });
const forgedUpdate = await ip.todo_update({ todo_id: extractedFeedback.id,
  expected_updated_at: loadTodosData(dataDir, wsInProcess).items.find((row) => row.id === extractedFeedback.id).updatedAt,
  patch: { feedback_origin: null } });
check('MCP create and update reject client feedback provenance', () => {
  assert.equal(forgedCreate.isError, true);
  assert.equal(forgedUpdate.isError, true);
  assert.deepEqual(loadTodosData(dataDir, wsInProcess).items.find((row) => row.id === extractedFeedback.id).feedbackOrigin,
    { kind: 'extracted', rootId: feedbackContainer.id, reportId: feedbackReport.id });
});

// --- In-process: createdByChatId + chats[] ---
const ipCreated = await ip.todo_create({ title: 'In-process task', status: 'ready', idempotency_key: 'ip-1' });
check('in-process todo_create succeeds and records the creator', () => {
  assert.equal(ipCreated.isError, false);
  assert.equal(ipCreated.structuredContent.item.created_by_chat_id, chatIp.id);
});
const ipId = ipCreated.structuredContent.item.id;

const ipShown = await ip.todo_show({ todo_id: ipId });
check('in-process todo_show returns chats[] with the creator role', () => {
  const item = ipShown.structuredContent.item;
  const creator = item.chats.find((row) => row.id === chatIp.id);
  assert.ok(creator, 'chat missing from chats[]');
  assert.ok(creator.roles.includes('creator'));
  assert.equal(creator.deleted, false);
  const protocolPath = ipShown.structuredContent.execution_protocol_path;
  assert.ok(path.isAbsolute(protocolPath));
  assert.match(readFileSync(protocolPath, 'utf8'), /export const TODO_EXECUTION_WORKFLOW/);
  assert.ok(ipShown.content[0].text.includes(`execution_protocol_path: ${protocolPath}`));
});

// --- Hierarchy through the real MCP client and persistence ---
const hierarchyRoot = await ip.todo_create({ title: 'Hierarchy root', status: 'ready', idempotency_key: 'hierarchy-root' });
const hierarchyId = hierarchyRoot.structuredContent.item.id;
const hierarchyFirst = await ip.todo_create({ title: 'First', status: 'ready', parent_id: hierarchyId, idempotency_key: 'hierarchy-first' });
const hierarchyLast = await ip.todo_create({ title: 'Last', status: 'ready', parent_id: hierarchyId, idempotency_key: 'hierarchy-last' });
const hierarchyShown = await ip.todo_show({ todo_id: hierarchyId });
check('todo_show exposes ordered direct children without claiming them', () => {
  const item = hierarchyShown.structuredContent.item;
  assert.equal(item.children_count, 2);
  assert.deepEqual(item.children.map((child) => child.id), [hierarchyFirst.structuredContent.item.id, hierarchyLast.structuredContent.item.id]);
  assert.deepEqual(item.children.map((child) => child.status), ['ready', 'ready']);
  assert.equal(item.has_plan, false);
  assert.equal(item.plan_approved_at, '');
  assert.equal(hierarchyShown.structuredContent.next_children_cursor, '');
  assert.match(hierarchyShown.content[0].text, /When the user requests execution/);
  assert.match(hierarchyShown.content[0].text, /read execution_protocol_path/);
  assert.match(hierarchyShown.content[0].text, /Inspection or planning alone does not authorize execution/);
  assert.doesNotMatch(hierarchyShown.content[0].text, /assignment=review|At the soft checkpoint/);
  assert.ok(hierarchyShown.content[0].text.length < 2500);
  assert.equal(hierarchyShown.structuredContent.execution_protocol_path, ipShown.structuredContent.execution_protocol_path);
});

const paginationRoot = await ip.todo_create({ title: 'Paged tree', idempotency_key: 'paged-tree' });
const paginationId = paginationRoot.structuredContent.item.id;
for (let i = 0; i < 22; i += 1) {
  await ip.todo_create({ title: `Step ${i}`, parent_id: paginationId, idempotency_key: `paged-child-${i}` });
}
const childrenPage1 = await ip.todo_show({ todo_id: paginationId });
const childrenPage2 = await ip.todo_show({ todo_id: paginationId, children_cursor: childrenPage1.structuredContent.next_children_cursor });
check('todo_show pages children independently of body', () => {
  assert.equal(childrenPage1.structuredContent.item.children_count, 22);
  assert.equal(childrenPage1.structuredContent.item.children.length, 20);
  assert.equal(childrenPage1.structuredContent.next_children_cursor, '20');
  assert.deepEqual(childrenPage2.structuredContent.item.children.map((child) => child.title), ['Step 20', 'Step 21']);
  assert.equal(childrenPage2.structuredContent.next_children_cursor, '');
  assert.equal(childrenPage1.structuredContent.revision, childrenPage2.structuredContent.revision);
});
await ip.todo_update({ todo_id: paginationId, expected_updated_at: childrenPage1.structuredContent.item.updated_at, patch: { plan: { markdown: 'Plan for all descendants' } } });
const draftParent = await ip.todo_show({ todo_id: paginationId, field: 'plan' });
check('todo_show exposes draft plan approval state', () => {
  assert.equal(draftParent.structuredContent.item.has_plan, true);
  assert.equal(draftParent.structuredContent.item.plan_approved_at, '');
  assert.equal(draftParent.structuredContent.item.plan, 'Plan for all descendants');
  assert.match(draftParent.content[0].text, /awaiting approval/);
});

async function setHierarchyStatus(id, status) {
  const shown = await ip.todo_show({ todo_id: id });
  return ip.todo_update({ todo_id: id, expected_updated_at: shown.structuredContent.item.updated_at, patch: { status } });
}
const premature = await setHierarchyStatus(hierarchyId, 'done');
const outOfOrder = await setHierarchyStatus(hierarchyLast.structuredContent.item.id, 'doing');
await setHierarchyStatus(hierarchyFirst.structuredContent.item.id, 'done');
const partialParent = await ip.todo_show({ todo_id: hierarchyId });
await setHierarchyStatus(hierarchyLast.structuredContent.item.id, 'done');
const completedParent = await ip.todo_show({ todo_id: hierarchyId });
check('MCP enforces sibling order and completes parents only after all children', () => {
  assert.equal(premature.isError, true);
  assert.match(premature.content[0].text, /VALIDATION_ERROR/);
  assert.equal(outOfOrder.isError, true);
  assert.equal(partialParent.structuredContent.item.status, 'doing');
  assert.equal(completedParent.structuredContent.item.status, 'done');
  assert.equal(completedParent.structuredContent.item.run_mode, 'sequential');
});

// --- In-process: id prefix + update links the calling chat ---
const ipPrefix = ipId.slice(0, 8);
const ipUpdated = await ip.todo_update({
  todo_id: ipPrefix,
  expected_updated_at: ipShown.structuredContent.item.updated_at,
  patch: { status: 'doing' },
});
check('in-process todo_update accepts an id prefix', () => {
  assert.equal(ipUpdated.isError, false);
  assert.equal(ipUpdated.structuredContent.item.id, ipId);
  assert.equal(ipUpdated.structuredContent.item.status, 'doing');
});

const ipShown2 = await ip.todo_show({ todo_id: ipId });
check('in-process todo_update links the caller and logs the status change', () => {
  const item = ipShown2.structuredContent.item;
  const linked = item.chats.find((row) => row.id === chatIp.id);
  assert.ok(linked.roles.includes('linked'));
  assert.ok(item.changelog.some((entry) => String(entry.text).includes('ready→doing')));
});

// --- Review is server-owned: an agent patch must be rejected ---
const ipReviewPatch = await ip.todo_update({
  todo_id: ipId,
  expected_updated_at: ipShown2.structuredContent.item.updated_at,
  patch: { review: { code: { state: 'passed' } } },
});
check('in-process todo_update rejects a review patch', () => {
  assert.equal(ipReviewPatch.isError, true);
  assert.match(ipReviewPatch.content[0].text, /VALIDATION_ERROR/);
  assert.match(ipReviewPatch.content[0].text, /review/);
});

const ipReviewSubjectPatch = await ip.todo_update({
  todo_id: ipId,
  expected_updated_at: ipShown2.structuredContent.item.updated_at,
  patch: { review_subject: 'code' },
});
check('in-process todo_update rejects a review_subject patch', () => {
  assert.equal(ipReviewSubjectPatch.isError, true);
  assert.match(ipReviewSubjectPatch.content[0].text, /VALIDATION_ERROR/);
  assert.match(ipReviewSubjectPatch.content[0].text, /review_subject/);
});

const ipCreateWithReview = await ip.todo_create({
  title: 'Review cannot be created',
  idempotency_key: 'ip-review-create',
  review: { code: { state: 'passed' } },
});
check('in-process todo_create never persists a review', () => {
  const created = ipCreateWithReview.structuredContent.item;
  const stored = loadTodosData(dataDir, wsInProcess).items.find((row) => row.id === created.id);
  assert.equal(stored.review, undefined);
});

// --- Review read surface: list fields, filter, show block, aggregate ---
const chatReview = addChat('sess-review', 'Review chat', null, wsReview, 'model-rv', { agentTransport: 'sdk', sdkMode: 'agent' });
const reviewClient = createInProcessMcpClient({ harness: 'sdk', chatId: chatReview.id, workspaceFolder: wsReview });
const reviewMcp = handlersFor(reviewClient, chatReview.id, wsReview, 'sdk');
const reviewParent = addTodo(dataDir, wsReview, { title: 'Review parent', status: 'doing' }).item;
const reviewLeaf = addTodo(dataDir, wsReview, { title: 'Review leaf', status: 'doing', parentId: reviewParent.id }).item;
const reviewEmpty = addTodo(dataDir, wsReview, { title: 'No review leaf', status: 'doing', parentId: reviewParent.id }).item;
const integrationAwaiting = addTodo(dataDir, wsReview, { title: 'Awaiting integration', status: 'done' }).item;
updateTodo(dataDir, wsReview, integrationAwaiting.id, { integration: { state: 'ready', appliedAt: '2026-10-11T00:00:00.000Z' } });
const integrationLegacy = addTodo(dataDir, wsReview, { title: 'Legacy confirmation', status: 'done' }).item;
updateTodo(dataDir, wsReview, integrationLegacy.id, { integration: { state: 'integrated' } });
writeTodoReview(dataDir, wsReview, reviewLeaf.id, {
  code: {
    state: 'passed',
    stateReason: 'fresh_review',
    subject: 'code',
    subjectSource: 'explicit',
    reviewerCount: 2,
    reviewers: [
      { delegationId: 'd1', attemptId: 'a1', harness: 'testfakeb', model: 'flash', status: 'completed', verdict: 'PASS', usable: true, independence: 'different_base_model' },
      { delegationId: 'd2', attemptId: 'a2', harness: 'claude', model: 'sonnet', status: 'completed', verdict: 'PASS', usable: true, independence: 'different_base_model' },
    ],
    independence: { independent: true, class: 'different_base_model', reference: 'implementer' },
    implementer: { delegationId: 'impl', attemptId: 'ia', role: 'implement', harness: 'codex', model: 'gpt' },
    material: { current: true, kind: 'trusted', reason: 'fresh_review' },
  },
  plan: { state: 'none', stateReason: 'no_review', subject: 'plan', subjectSource: 'default' },
});

const reviewList = await reviewMcp.todo_list({ limit: 100 });
check('todo_list exposes the four review fields on a leaf', () => {
  const row = reviewList.structuredContent.items.find((item) => item.id === reviewLeaf.id);
  assert.ok(row, 'review leaf missing from list');
  assert.equal(row.review_state, 'passed');
  assert.equal(row.review_plan_state, 'none');
  assert.deepEqual(row.review_reviewer, { harness: 'testfakeb', model: 'flash', count: 2 });
  assert.equal(row.review_independence, 'different_base_model');
});

check('todo_list reports none for a missing snapshot and empty fields for a container', () => {
  const rows = reviewList.structuredContent.items;
  const emptyLeaf = rows.find((item) => item.id === reviewEmpty.id);
  assert.equal(emptyLeaf.review_state, 'none');
  assert.equal(emptyLeaf.review_reviewer, null);
  const parent = rows.find((item) => item.id === reviewParent.id);
  assert.equal(parent.review_state, '', 'a container has no own leaf state');
  assert.equal(parent.review_reviewer, null);
});

const integrationFiltered = await reviewMcp.todo_list({ integration: 'awaiting', limit: 100 });
check('MCP TODO list exposes and filters derived integration summaries', () => {
  const awaiting = reviewList.structuredContent.items.find((item) => item.id === integrationAwaiting.id);
  const legacy = reviewList.structuredContent.items.find((item) => item.id === integrationLegacy.id);
  assert.equal(awaiting.integration_summary.state, 'awaiting');
  assert.equal(awaiting.integration_summary.detail, 'working_directory_applied');
  assert.equal(legacy.integration_summary.state, 'unconfirmed');
  assert.equal(legacy.integration_summary.detail, 'legacy_confirmation');
  assert.deepEqual(integrationFiltered.structuredContent.items.map((item) => item.id), [integrationAwaiting.id]);
});

const reviewFiltered = await reviewMcp.todo_list({ review: 'passed', limit: 100 });
const reviewPlanNone = await reviewMcp.todo_list({ review: 'plan:none', limit: 100 });
const reviewInvalid = await reviewMcp.todo_list({ review: 'banana' });
check('todo_list review filter matches leaves only', () => {
  const passedIds = reviewFiltered.structuredContent.items.map((item) => item.id);
  assert.ok(passedIds.includes(reviewLeaf.id));
  assert.equal(passedIds.includes(reviewParent.id), false);
  assert.equal(passedIds.includes(reviewEmpty.id), false);
  assert.ok(reviewPlanNone.structuredContent.items.some((item) => item.id === reviewEmpty.id));
  assert.equal(reviewInvalid.isError, true);
  assert.match(reviewInvalid.content[0].text, /VALIDATION_ERROR/);
});

const reviewShown = await reviewMcp.todo_show({ todo_id: reviewLeaf.id });
check('todo_show returns the full review block with reviewer, subject and independence', () => {
  const review = reviewShown.structuredContent.item.review;
  assert.equal(review.code.state, 'passed');
  assert.equal(review.code.subject, 'code');
  assert.equal(review.code.reviewers.length, 2);
  assert.equal(review.code.reviewers[0].harness, 'testfakeb');
  assert.equal(review.code.independence.class, 'different_base_model');
  assert.equal(review.code.implementer.model, 'gpt');
  assert.equal(review.plan.state, 'none');
  assert.equal(reviewShown.structuredContent.item.review_state, 'passed');
  assert.match(reviewShown.content[0].text, /review: code=passed/);
});

const parentShown = await reviewMcp.todo_show({ todo_id: reviewParent.id });
check('todo_show on a container derives the aggregate from direct children', () => {
  const review = parentShown.structuredContent.item.review;
  assert.equal(review.aggregate.source, 'children');
  assert.equal(review.aggregate.code.passed, 1);
  assert.equal(review.aggregate.code.none, 1);
  assert.equal(review.aggregate.plan.none, 2);
  assert.equal(parentShown.structuredContent.item.review_state, '');
});

// --- Prefix resolution: unique / collision / missing (in-process) ---
function seedWorkspace(workspaceFolder, items) {
  saveTodosData(dataDir, workspaceFolder, {
    version: 3,
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: items.map((item) => ({
      status: 'idea',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...item,
    })),
    idempotency: {},
  });
}
seedWorkspace(wsPrefix, [
  { id: 'abcdef12-0000-4000-8000-000000000001', title: 'One' },
  { id: 'abcdef12-0000-4000-8000-000000000002', title: 'Two' },
  { id: 'ffffffff-0000-4000-8000-000000000003', title: 'Three' },
]);
const chatPrefix = addChat('sess-prefix', 'Prefix chat', null, wsPrefix, 'model-p', { agentTransport: 'sdk', sdkMode: 'agent' });
const prefixClient = createInProcessMcpClient({ harness: 'sdk', chatId: chatPrefix.id, workspaceFolder: wsPrefix });
const prefix = handlersFor(prefixClient, chatPrefix.id, wsPrefix, 'sdk');

const prefixUnique = await prefix.todo_show({ todo_id: 'ffffffff' });
check('in-process prefix: a unique 8-char prefix resolves', () => {
  assert.equal(prefixUnique.isError, false);
  assert.equal(prefixUnique.structuredContent.item.id, 'ffffffff-0000-4000-8000-000000000003');
});

const prefixCollision = await prefix.todo_show({ todo_id: 'abcdef12' });
check('in-process prefix: a colliding prefix is VALIDATION_ERROR with candidates', () => {
  assert.equal(prefixCollision.isError, true);
  assert.match(prefixCollision.content[0].text, /VALIDATION_ERROR/);
  assert.match(prefixCollision.content[0].text, /abcdef12-0000-4000-8000-000000000001/);
  assert.match(prefixCollision.content[0].text, /abcdef12-0000-4000-8000-000000000002/);
});

const prefixMissing = await prefix.todo_show({ todo_id: '99999999' });
check('in-process prefix: no match is NOT_FOUND', () => {
  assert.equal(prefixMissing.isError, true);
  assert.match(prefixMissing.content[0].text, /NOT_FOUND/);
});

const prefixTooShort = await prefix.todo_show({ todo_id: 'abc' });
check('in-process prefix: shorter than 8 chars is NOT_FOUND, not a collision', () => {
  assert.equal(prefixTooShort.isError, true);
  assert.match(prefixTooShort.content[0].text, /NOT_FOUND/);
});

// --- Remote client over HTTP ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = () => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(JSON.parse(raw || '{}')));
  });
  const todosPayload = (cwd) => {
    const data = loadTodosData(dataDir, cwd);
    const index = buildTodoChatIndex(loadChats(), { workspaceFolder: cwd });
    return {
      ok: true,
      cwd,
      version: data.version,
      updatedAt: data.updatedAt,
      items: enrichTodoItemsWithSourceChat(data.items, index, cwd),
    };
  };
  if (req.method === 'POST' && url.pathname === '/api/login') {
    send(200, { ok: true, csrfToken: 'csrf-tools' }, { 'Set-Cookie': 'cr_session=tools; Path=/; HttpOnly' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/todos') {
    send(200, todosPayload(url.searchParams.get('workspaceFolder')));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/todos') {
    readBody().then((body) => {
      const cwd = body.workspaceFolder;
      const saved = addTodo(dataDir, cwd, { ...body, strictStatus: body.strictStatus === true });
      send(200, { ...todosPayload(cwd), item: saved.item, replayed: saved.replayed === true });
    });
    return;
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/todos/')) {
    const todoId = decodeURIComponent(url.pathname.slice('/api/todos/'.length));
    readBody().then((body) => {
      const cwd = body.workspaceFolder;
      const saved = updateTodo(dataDir, cwd, todoId, { ...body, strictStatus: body.strictStatus === true });
      send(200, { ...todosPayload(cwd), item: saved.items.find((row) => row.id === todoId) || null });
    });
    return;
  }
  send(404, { ok: false, error: 'Not found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const remoteClient = new CretliApiClient({ baseUrl, password: 'tools' });
  const remote = handlersFor(remoteClient, chatRemote.id, wsRemote, 'sdk');

  const rCreated = await remote.todo_create({ title: 'Remote task', status: 'ready', idempotency_key: 'r-1' });
  check('remote todo_create succeeds and records the creator', () => {
    assert.equal(rCreated.isError, false);
    assert.equal(rCreated.structuredContent.item.created_by_chat_id, chatRemote.id);
  });
  const rId = rCreated.structuredContent.item.id;

  const rShown = await remote.todo_show({ todo_id: rId });
  check('remote todo_show returns chats[] with the creator role', () => {
    const item = rShown.structuredContent.item;
    const creator = item.chats.find((row) => row.id === chatRemote.id);
    assert.ok(creator, 'chat missing from chats[]');
    assert.ok(creator.roles.includes('creator'));
  });

  const rUpdated = await remote.todo_update({
    todo_id: rId.slice(0, 8),
    expected_updated_at: rShown.structuredContent.item.updated_at,
    patch: { status: 'doing' },
  });
  check('remote todo_update accepts an id prefix and links the caller', () => {
    assert.equal(rUpdated.isError, false);
    assert.equal(rUpdated.structuredContent.item.id, rId);
    assert.equal(rUpdated.structuredContent.item.status, 'doing');
  });

  const rShown2 = await remote.todo_show({ todo_id: rId });
  check('remote todo_show reports the linked caller and the status changelog', () => {
    const item = rShown2.structuredContent.item;
    const linked = item.chats.find((row) => row.id === chatRemote.id);
    assert.ok(linked.roles.includes('linked'));
    assert.ok(item.changelog.some((entry) => String(entry.text).includes('ready→doing')));
  });

  const rReviewPatch = await remote.todo_update({
    todo_id: rId,
    expected_updated_at: rShown2.structuredContent.item.updated_at,
    patch: { review: { code: { state: 'passed' } } },
  });
  check('remote todo_update rejects a review patch', () => {
    assert.equal(rReviewPatch.isError, true);
    assert.match(rReviewPatch.content[0].text, /VALIDATION_ERROR/);
    assert.match(rReviewPatch.content[0].text, /review/);
  });

  seedWorkspace(wsRemotePrefix, [
    { id: 'abcdef12-1111-4000-8000-000000000001', title: 'Remote one' },
    { id: 'abcdef12-1111-4000-8000-000000000002', title: 'Remote two' },
    { id: 'ffffffff-1111-4000-8000-000000000003', title: 'Remote three' },
  ]);
  const chatRemotePrefix = addChat('sess-rp', 'Remote prefix chat', null, wsRemotePrefix, 'model-rp', { agentTransport: 'sdk', sdkMode: 'agent' });
  const remotePrefix = handlersFor(remoteClient, chatRemotePrefix.id, wsRemotePrefix, 'sdk');

  const rUnique = await remotePrefix.todo_show({ todo_id: 'ffffffff' });
  check('remote prefix: a unique 8-char prefix resolves', () => {
    assert.equal(rUnique.isError, false);
    assert.equal(rUnique.structuredContent.item.id, 'ffffffff-1111-4000-8000-000000000003');
  });

  const rCollision = await remotePrefix.todo_show({ todo_id: 'abcdef12' });
  check('remote prefix: a colliding prefix is VALIDATION_ERROR with candidates', () => {
    assert.equal(rCollision.isError, true);
    assert.match(rCollision.content[0].text, /VALIDATION_ERROR/);
    assert.match(rCollision.content[0].text, /abcdef12-1111-4000-8000-000000000001/);
  });

  const rMissing = await remotePrefix.todo_show({ todo_id: '99999999' });
  check('remote prefix: no match is NOT_FOUND', () => {
    assert.equal(rMissing.isError, true);
    assert.match(rMissing.content[0].text, /NOT_FOUND/);
  });
} finally {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
