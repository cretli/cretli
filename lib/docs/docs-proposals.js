import { randomUUID } from 'node:crypto';
import { createDecision, listDecisions, changeDecision } from '../decisions/decision-store.js';
import { DocsError, updateDocsWorkspace } from './docs-state-store.js';
import { checkText, notePath, readNote, resolveNote, sha256, writeNote } from './docs-files.js';
import { validateTarget } from './docs-links.js';

export const MAX_PROPOSAL_BYTES = 128 * 1024;
export const MAX_PROPOSAL_METADATA_BYTES = 4 * 1024;
export const MAX_PENDING_PROPOSALS = 20;
export const MAX_CARD_BYTES = 48 * 1024;
export const MAX_PENDING_WORKSPACE_BYTES = 1024 * 1024;
// Reserve space for the decision store's generated fields and subsequent resolution metadata.
const CARD_ENVELOPE_BYTES = 4 * 1024;
const proposalQueues = new Map();

async function serializeProposal(key, operation) {
  const previous = proposalQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  proposalQueues.set(key, next);
  try { return await next; }
  finally { if (proposalQueues.get(key) === next) proposalQueues.delete(key); }
}

function unpackPayload(payload) {
  if (payload?.textBase64 === undefined) return payload;
  if (typeof payload.textBase64 !== 'string' || payload.textBase64.length > Math.ceil(MAX_PROPOSAL_BYTES / 3) * 4) {
    throw new DocsError('docs-too-large', 'Note exceeds 128 KiB', 413);
  }
  const { textBase64, ...metadata } = payload;
  return { ...metadata, text: Buffer.from(textBase64, 'base64').toString('utf8') };
}

function checkPayload(payload, chatId = '', workspaceFolder = '') {
  const { text, ...metadata } = payload;
  if (text !== undefined) checkText(text);
  if (Buffer.byteLength(JSON.stringify({ ...metadata, chatId, workspaceFolder })) > MAX_PROPOSAL_METADATA_BYTES) {
    throw new DocsError('docs-proposal-metadata-too-large', 'Proposal metadata exceeds 4 KiB', 413);
  }
}

const proposalHash = (stored) => {
  const payload = unpackPayload(stored);
  return sha256(JSON.stringify([payload.kind, payload.path,
    payload.kind === 'link' ? payload.target : payload.text, payload.baseSha256]));
};

// Agents receive a whitelisted view: the stored card also carries the absolute workspace folder.
const AGENT_CARD_FIELDS = ['id', 'revision', 'kind', 'status', 'title', 'summary', 'why', 'options', 'otherOption',
  'recommended', 'onTimeout', 'evidence', 'subject', 'risk', 'reversible', 'createdAt'];
export const agentProposalView = (card, proposal) => ({
  ...Object.fromEntries(AGENT_CARD_FIELDS.filter((key) => card[key] !== undefined).map((key) => [key, card[key]])), proposal,
});

const MAX_DIFF_CHARS = 48 * 1024;
const options = [
  { id: 'apply', label: 'Apply proposal', effect: 'Apply exactly the proposed Docs change' },
  { id: 'reject', label: 'Reject proposal', effect: 'Leave the note and links unchanged' },
];

function currentNote(root, path, allowMissing) {
  try { return readNote(root, path); }
  catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    resolveNote(root, path, { missing: true });
    return { text: '', sha256: null };
  }
}

// A full replacement hunk is deterministic, preserves blank lines, and needs no diff dependency.
export function proposalDiff(path, before, after) {
  const count = (text) => text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
  const lines = (text, sign) => {
    if (!text) return '';
    const value = text.endsWith('\n') ? text.slice(0, -1) : text;
    return value.split('\n').map((line) => `${sign}${line}`).join('\n')
      + (text.endsWith('\n') ? '\n' : '\n\\ No newline at end of file\n');
  };
  const value = `--- a/${path}\n+++ b/${path}\n@@ -${before ? 1 : 0},${count(before)} +${after ? 1 : 0},${count(after)} @@\n${lines(before, '-')}${lines(after, '+')}`;
  let bytes = 0;
  let length = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > MAX_PROPOSAL_BYTES || length + char.length > MAX_DIFF_CHARS) break;
    bytes += size; length += char.length;
  }
  return { diff: value.slice(0, length), truncated: length < value.length };
}

export function createDocsProposals({ dataDir, scope, access, stateFor, targetExists, invalidate }) {
  const rootKey = (root) => sha256(root.realpath);
  const snapshot = (ws, payload) => {
    // Approval also checks the agent grant, so revocation invalidates an outstanding proposal.
    const { root, state } = access(ws, 'agent');
    if (rootKey(root) !== payload.rootKey) throw new DocsError('docs-conflict', 'Docs root changed', 409);
    const note = currentNote(root.realpath, payload.path, payload.baseSha256 === null);
    if (note.sha256 !== payload.baseSha256
      || (payload.kind === 'link' && (state.revision || 0) !== payload.linkRevision)) {
      throw new DocsError('docs-conflict', 'Proposal base changed', 409);
    }
    return { root, state, note };
  };
  const isStale = (error) => error instanceof DocsError && error.status !== 503
    || ['ENOENT', 'EEXIST'].includes(error.code);
  return {
    async propose(input, args, actor, chatId) {
      if (actor !== 'agent' || typeof chatId !== 'string' || !chatId) {
        throw new DocsError('docs-agent-required', 'A workspace-bound agent chat is required', 403);
      }
      if (!['write', 'append', 'link'].includes(args.kind)) throw new DocsError('docs-invalid-proposal', 'Unknown proposal operation');
      const ws = await scope(input);
      const { root } = access(ws, 'agent');
      const path = notePath(args.path);
      const before = currentNote(root.realpath, path, args.kind === 'write');
      const payload = { v: 1, kind: args.kind, workspaceUuid: ws.workspaceUuid, path,
        rootKey: rootKey(root), baseSha256: before.sha256 };
      let evidence;
      if (args.kind === 'link') {
        const target = validateTarget(args.target);
        if (!await targetExists(dataDir, ws, target.kind, target.targetId)) throw new DocsError('docs-target-not-found', 'Target is unavailable in this workspace', 404);
        Object.assign(payload, { target, linkRevision: stateFor(ws).revision || 0 });
        evidence = { diff: `+ ${path} -> ${target.kind}:${target.targetId}`, truncated: false };
      } else {
        checkText(args.text);
        payload.text = args.kind === 'append' ? before.text + args.text : args.text;
        checkText(payload.text);
        evidence = proposalDiff(path, before.text, payload.text);
      }
      checkPayload(payload, chatId, ws.homeFolder);
      return serializeProposal(JSON.stringify([dataDir, ws.workspaceUuid]), async () => {
        const hash = proposalHash(payload);
        const workspacePending = (await listDecisions(dataDir, ws.homeFolder)).filter((card) => card.kind === 'doc_proposal'
          && card.proposal?.workspaceUuid === ws.workspaceUuid && ['pending', 'deciding'].includes(card.status));
        const pending = workspacePending.filter((card) => card.subject?.chatId === chatId);
        if (pending.some((card) => proposalHash(card.proposal) === hash)) {
          throw new DocsError('docs-proposal-duplicate', 'An identical proposal is already awaiting review', 409);
        }
        if (pending.length >= MAX_PENDING_PROPOSALS) {
          throw new DocsError('docs-proposal-limit', 'At most 20 proposals may await review per workspace and chat; resolve a card first', 429);
        }
        snapshot(ws, payload);
        const proposalId = randomUUID();
        const input = {
          kind: 'doc_proposal', workspaceFolder: ws.homeFolder, producer: 'docs-service', proposal: payload,
          subject: { chatId, updatedAt: proposalId, docPath: path, baseSha256: before.sha256, proposalKind: args.kind },
          dedupeKey: `doc-proposal:${ws.workspaceUuid}:${proposalId}`, allowOther: false,
          title: `Docs: ${path}`, summary: args.kind, evidence: [{ type: 'doc_diff', ...evidence, chatId, at: new Date().toISOString() }],
          options, recommended: 'reject', why: 'A human must review the proposed change.', onTimeout: 'nothing',
        };
        while (Buffer.byteLength(JSON.stringify(input)) + CARD_ENVELOPE_BYTES > MAX_CARD_BYTES && evidence.diff.length) {
          evidence.diff = evidence.diff.slice(0, Math.floor(evidence.diff.length / 2));
          evidence.truncated = true;
          Object.assign(input.evidence[0], evidence);
        }
        if (Buffer.byteLength(JSON.stringify(input)) + CARD_ENVELOPE_BYTES > MAX_CARD_BYTES) {
          throw new DocsError('docs-proposal-card-too-large', 'Proposal card exceeds 48 KiB; submit a smaller change', 413);
        }
        const pendingBytes = workspacePending.reduce((total, card) => total + Buffer.byteLength(JSON.stringify(card)), 0);
        const cardBudget = Buffer.byteLength(JSON.stringify(input)) + CARD_ENVELOPE_BYTES;
        if (pendingBytes + cardBudget > MAX_PENDING_WORKSPACE_BYTES) {
          throw new DocsError('docs-proposal-workspace-limit', 'Pending proposals exceed the 1 MiB workspace budget; resolve a card first', 429);
        }
        const card = await createDecision(dataDir, input);
        return { decision: agentProposalView(card, payload) };
      });
    },
    async proposals(input, actor) {
      if (actor !== 'human') throw new DocsError('docs-human-required', 'A human session is required', 403);
      const ws = await scope(input);
      const all = await listDecisions(dataDir, ws.homeFolder);
      const items = [];
      for (let card of all.filter((c) => c.kind === 'doc_proposal' && c.proposal?.workspaceUuid === ws.workspaceUuid)) {
        if (card.status === 'pending') {
          try { snapshot(ws, unpackPayload(card.proposal)); }
          catch (error) {
            if (!isStale(error)) throw error;
            card = await changeDecision(dataDir, card.id, card.revision, 'stale') || card;
          }
        }
        items.push({ ...card, proposal: unpackPayload(card.proposal) });
      }
      return { items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) };
    },
    async resolveProposal(card, optionId, actor) {
      if (actor !== 'human') throw new DocsError('docs-human-required', 'A human session is required', 403);
      let payload;
      try { payload = unpackPayload(card.proposal); }
      catch { return { ok: false, reason: 'invalid_proposal' }; }
      if (card.producer !== 'docs-service' || payload?.v !== 1 || !['write', 'append', 'link'].includes(payload.kind)) return { ok: false, reason: 'invalid_proposal' };
      try { checkPayload(payload, card.subject?.chatId, card.workspaceFolder); }
      catch { return { ok: false, reason: 'invalid_proposal' }; }
      if (!['apply', 'reject'].includes(optionId)) return { ok: false, reason: 'unknown_option' };
      if (optionId === 'reject') return { ok: true };
      try {
        const ws = await scope({ workspaceUuid: payload.workspaceUuid });
        if (ws.homeFolder !== card.workspaceFolder) return { ok: false, reason: 'stale' };
        if (payload.kind === 'link' && !await targetExists(dataDir, ws, payload.target.kind, payload.target.targetId)) return { ok: false, reason: 'stale' };
        // No await between the final preconditions and the synchronous filesystem/state commit.
        const { root } = snapshot(ws, payload);
        if (payload.kind === 'link') {
          updateDocsWorkspace(dataDir, ws.workspaceUuid, (state) => {
            if ((state.revision || 0) !== payload.linkRevision) throw new DocsError('docs-conflict', 'Link revision changed', 409);
            state.root ||= { path: root.path, external: root.external };
            if (!state.links.some((l) => l.note === payload.path && l.kind === payload.target.kind && l.targetId === payload.target.targetId)) {
              state.links.push({ id: randomUUID(), note: payload.path, ...payload.target, state: 'ok', suggestedPath: null,
                createdAt: new Date().toISOString(), createdBy: 'human', proposingChatId: card.subject.chatId, decisionId: card.id });
            }
            return state;
          });
        } else {
          writeNote(root.realpath, payload.path, payload.text, { create: payload.baseSha256 === null, expectedSha256: payload.baseSha256 });
          invalidate(ws, root);
        }
        // The decided card stores actor/time, source chat and the exact payload as edit history.
        return { ok: true, response: { path: payload.path, proposingChatId: card.subject.chatId } };
      } catch (error) {
        if (isStale(error)) return { ok: false, reason: 'stale' };
        throw error;
      }
    },
  };
}
