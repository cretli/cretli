/**
 * Screenshot import for the credit ledger.
 *
 * The calling agent reads the screenshot itself (image text is data, never
 * instructions); there is no separate OCR. This module only decides whether the
 * parsed fields are complete enough to be saved without another confirmation or
 * must stay a draft, and it ties the entry to an existing upload by reference.
 * Drafts are never persisted: the agent re-submits once the gaps are filled.
 * Nothing here moves money; the ledger records what already happened.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  LedgerError,
  loadLedger,
  previewTransaction,
  recordSnapshot,
  recordTransaction,
  resolveCreditLedgerPath,
} from './credit-ledger-store.ts';
import type { SnapshotInput, TransactionInput } from './credit-ledger-store.ts';

/** Raw import input (tool arguments); fields are validated at runtime. */
export interface ImportInput extends TransactionInput, SnapshotInput {
  kind?: unknown;
  save?: unknown;
  imageRead?: unknown;
  allowDuplicate?: unknown;
  unreadable?: unknown;
}

export const IMPORT_KINDS = Object.freeze(['transaction', 'snapshot']);
const UPLOAD_NAME_RE = /^[a-f0-9-]{36}\.jpg$/i;
const DEFAULT_SOURCE = 'screenshot';

/**
 * Reduces an upload path or filename to the bare filename of an existing upload.
 * Anything that is not a UUID .jpg produced by the upload route is rejected.
 */
export function normalizeAttachmentRef(ref: unknown): string | null {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const name = path.basename(raw);
  return UPLOAD_NAME_RE.test(name) ? name.toLowerCase() : null;
}

/** Returns null when there is no attachment. */
export function attachmentState(ref: string | null, uploadsDir: string): 'present' | 'missing' | null {
  if (!ref) return null;
  const name = normalizeAttachmentRef(ref);
  if (!name || !uploadsDir) return 'missing';
  return fs.existsSync(path.join(uploadsDir, name)) ? 'present' : 'missing';
}

/**
 * Adds a computed `attachmentState` to a ledger row. The reference is kept after
 * the image is deleted; only the state flips to `missing`.
 */
export function withAttachmentState<T extends object>(row: T, uploadsDir: string): T & { attachmentState?: 'present' | 'missing' | null } {
  if (!row || typeof row !== 'object') return row;
  const r = row as { attachmentRef?: string | null; attachmentRemoved?: boolean };
  if (r.attachmentRef) return { ...row, attachmentState: attachmentState(r.attachmentRef, uploadsDir) };
  return r.attachmentRemoved ? { ...row, attachmentState: 'missing' } : row;
}

function hashUpload(name: string, uploadsDir: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(uploadsDir, name))).digest('hex');
}

/**
 * Resolves an upload reference to a verified artefact: normalised filename that
 * exists in the upload store plus the SHA-256 of its bytes. Shared by evidence
 * checks outside the screenshot import (e.g. subscription payments).
 * Throws a LedgerError: `attachment_invalid` | `attachment_missing`.
 */
export function verifyUploadAttachment(ref: unknown, uploadsDir: string): { attachmentRef: string; imageHash: string } {
  const attachmentRef = normalizeAttachmentRef(ref);
  if (!attachmentRef) throw new LedgerError('attachment_invalid');
  if (attachmentState(attachmentRef, uploadsDir) !== 'present') throw new LedgerError('attachment_missing');
  return { attachmentRef, imageHash: hashUpload(attachmentRef, uploadsDir) };
}

function blank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}

/** Lists required fields that are absent or flagged unreadable by the agent. */
function findMissingFields(kind: string, input: ImportInput): string[] {
  const missing = new Set<string>();
  if (blank(input.accountId)) missing.add('accountId');
  if (kind === 'transaction') {
    if (blank(input.type)) missing.add('type');
    if (blank(input.credit?.amount)) missing.add('credit.amount');
    if (blank(input.credit?.currency)) missing.add('credit.currency');
    if (blank(input.occurredAt)) missing.add('occurredAt');
  } else {
    if (blank(input.totalBalance)) missing.add('totalBalance');
    if (blank(input.currency)) missing.add('currency');
    if (blank(input.observedAt)) missing.add('observedAt');
  }
  const unreadable = Array.isArray(input.unreadable) ? input.unreadable.map((f: unknown) => String(f)) : [];
  for (const field of unreadable) missing.add(field);
  return [...missing];
}

function draft(kind: string, reason: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { status: 'draft', kind, reason, ...extra };
}

function parsedFields(kind: string, input: ImportInput): Record<string, unknown> {
  if (kind === 'transaction') {
    return {
      accountId: input.accountId ?? null, type: input.type ?? null, state: input.state ?? 'posted',
      occurredAt: input.occurredAt ?? null, credit: input.credit ?? null, payment: input.payment ?? null,
      providerTransactionId: input.providerTransactionId ?? null,
    };
  }
  return {
    accountId: input.accountId ?? null, currency: input.currency ?? null, totalBalance: input.totalBalance ?? null,
    grantedBalance: input.grantedBalance ?? null, toppedUpBalance: input.toppedUpBalance ?? null,
    observedAt: input.observedAt ?? null, completeness: input.completeness ?? 'unknown',
  };
}

/**
 * Imports one ledger entry read from a screenshot (or typed manually).
 *
 * `input.save` is the explicit save request; `input.imageRead` is
 * `'none'` when the harness cannot see images (manual entry or questions only);
 * `input.allowDuplicate` acknowledges a flagged possible duplicate.
 */
export function importLedgerEntry({ ledgerPath, uploadsDir, chatId = '', input }: { ledgerPath?: string; uploadsDir: string; chatId?: string; input: ImportInput }): Record<string, unknown> {
  const src: ImportInput = input && typeof input === 'object' ? input : {};
  const kind = String(src.kind || '');
  if (!IMPORT_KINDS.includes(kind)) throw new LedgerError('kind_invalid');
  const parsed = parsedFields(kind, src);
  const noVision = String(src.imageRead || '').toLowerCase() === 'none';
  const missing = findMissingFields(kind, src);
  // A no-vision harness cannot read the screenshot at all, attached or not, so
  // incomplete fields always turn into a manual-entry prompt instead of a
  // generic missing-fields draft.
  if (noVision && missing.length) {
    return draft(kind, 'no_vision', {
      parsed, missing,
      next: 'This harness cannot read images: ask the user to type the account, amount, currency and time, then call again.',
    });
  }
  let attachmentRef: string | null = null;
  let imageHash: string | null = null;
  if (!blank(src.attachmentRef)) {
    attachmentRef = normalizeAttachmentRef(src.attachmentRef);
    if (!attachmentRef) return draft(kind, 'attachment_invalid', { parsed, missing: ['attachmentRef'] });
    if (attachmentState(attachmentRef, uploadsDir) !== 'present') {
      return draft(kind, 'attachment_missing', { parsed, missing: ['attachmentRef'], attachment: { ref: attachmentRef, state: 'missing' } });
    }
    imageHash = hashUpload(attachmentRef, uploadsDir);
  }
  if (missing.length) return draft(kind, 'missing_fields', { parsed, missing, next: 'Ask the user for the missing fields; do not guess them.' });
  const ledgerInput = {
    ...src, source: src.source || DEFAULT_SOURCE, imageHash, attachmentRef,
    chatRef: chatId || src.chatRef || null,
  };
  try {
    if (kind === 'transaction') {
      const preview = previewTransaction({ filePath: ledgerPath, input: ledgerInput });
      const dups = preview.possibleDuplicateOf;
      if (!preview.existing && dups.length && src.allowDuplicate !== true) {
        return draft(kind, 'possible_duplicate', { parsed, possibleDuplicateOf: dups,
          next: 'A similar transaction exists. Ask the user whether this is a new one; if so call again with allow_duplicate=true.' });
      }
    }
    if (src.save !== true) return draft(kind, 'save_not_requested', { parsed, next: 'Call again with save=true once the user asked to save.' });
    const result = kind === 'transaction'
      ? recordTransaction({ filePath: ledgerPath, expectedRevision: undefined, input: ledgerInput })
      : recordSnapshot({ filePath: ledgerPath, expectedRevision: undefined, input: ledgerInput });
    const row = (result.transaction || result.snapshot) as { id: string };
    return {
      status: 'saved', kind, id: row.id, deduplicated: result.deduplicated || null, revision: result.revision,
      parsed, attachment: attachmentRef ? { ref: attachmentRef, state: 'present' } : null,
      correct: { tool: 'billing_update', args: { kind, id: row.id }, note: 'Corrections append a new version; withdraw with billing_update withdraw=true.' },
    };
  } catch (err) {
    if (!(err instanceof LedgerError)) throw err;
    if (err.status === 404 && err.code === 'account_not_found') return draft(kind, 'account_not_found', { parsed, missing: ['accountId'] });
    if (err.status === 409) return { status: 'conflict', kind, error: err.code, parsed };
    if (err.status >= 500) throw err;
    return draft(kind, 'invalid_field', { parsed, invalid: [err.code], missing: [] });
  }
}

export function readLedgerDocument(ledgerPath?: string) {
  return loadLedger(resolveCreditLedgerPath(ledgerPath));
}
