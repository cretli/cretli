# Backup and restore acceptance report

Scope: acceptance of the export/restore system implemented by the backup slices (B1–B6) as it exists in this
repository. Suite: `tests/backup-acceptance.test.js`, run with `node --test tests/backup-acceptance.test.js`.
Operator documentation: [backup/recovery-guide.md](backup/recovery-guide.md).

This report covers only the code that exists today. Tests that already existed in the repository
(`offline-data-recovery`, `encrypted-backup`, `online-backup`, `conversations-backup`, `settings-backup`) are separate,
are not rerun here as evidence, and are **not** evidence for any future migration or consolidation of legacy stores.
Every fixture is a fresh temp directory; nothing starts an agent, a provider or a child process (case 17 replaces
`child_process` spawn functions with throwing stubs for the duration of a backup and restore).

## Environment

Node v22.23.2, Linux (WSL2), bundled SQLite from `node:sqlite`, scrypt cost log2N 14 (reduced for test speed; the
product default is 15). Single run; timings are wall clock on a developer machine and indicate order of magnitude only.

## Result

17 passed, 0 failed, 6 skipped (documented gaps), total 75.8 s (the suite is dominated by autocommit SQLite fixture seeding and
the 29-iteration crash loop, not by backup or restore).

## Measurements

| Measurement | Value |
| --- | --- |
| Fresh install, 7 managed files incl. 2 SQLite DBs with 500 child rows each: backup / restore | 76 ms / 435 ms |
| Content check after restore | SHA-256 of every file and SQLite row count/first row equal to the source |
| Encrypted backup (log2N 14), 200-row fixture, with secrets: create / verify / restore (incl. encrypted pre-restore copy and re-open) | 194 ms / 38 ms / 1091 ms |
| Encrypted envelope size (fixture) | 32,257 bytes; 237,124 bytes for the ~200 KB crypto fixture (6 records at 64 KiB chunks) |
| Restore journal crash points exercised | 29 (crash injected after each journal step); 29/29 recovered by roll-forward to the exact backup state |
| Full-disk injection while staging (plain and encrypted) | destination, journal and staging unchanged / removed in both |

## Cases

| # | Case | Result |
| --- | --- | --- |
| 1 | Fresh install restore: hashes, SQLite counts, retained paths not archived, plain backup has no secret canary, paused until `resume` | pass |
| 2 | Existing install: retained auth/harness/unrelated files untouched, extra managed file removed, destination secrets kept, lossy rollback restores the pre-restore state and stays paused | pass |
| 3 | Corrupt source (non-SQLite `.sqlite`): backup aborts, nothing published | pass (no quarantine, see gaps) |
| 4 | Corrupt backup: digest mismatch, missing payload, unknown format, dangling foreign key all rejected; destination unchanged | pass |
| 5 | Traversal/absolute/protected/non-managed manifest entries (`../`, `/etc/passwd`, `auth.json`, `claude-home/x`, control dir, `a/../../b`) rejected | pass |
| 6 | Encrypted round trip: canary absent from ciphertext, owner-only file, secrets restored only with the opt-in, plain profile keeps destination secrets, encrypted pre-restore copy re-opens, wrong key fails, staging cleaned | pass |
| 7 | Crypto: truncation (tail, half), trailing byte, three bit flips, record reorder, dropped record, forged KDF cost (no scrypt run) — no plaintext left | pass |
| 8 | ZIP: traversal/absolute/backslash/drive/empty names, member/total/entry-count limits, non-ZIP, CRC tamper | pass |
| 9 | Version limits: future `format` → `BACKUP_UNSUPPORTED`; plain backup declaring secrets → `BACKUP_INVALID` | pass |
| 10 | Permissions: backup root, backup dir, control dir, pre-restore dirs have no group/other bits | pass |
| 11 | Fault injection at every restore journal step | pass |
| 12 | Full disk (ENOSPC) during staging, plain and encrypted restore | pass |
| 13 | Crash mid-copy of a backup publishes no partial directory | pass |
| 14 | Generation/fence advance above source and external high-water; restore result equals stored state | pass |
| 15 | Retention: failed (unverified) backup deletes nothing; verified run keeps newest N scheduled, manual/protected/newest kept | pass |
| 16 | Online backup without a coordinator refused, nothing written | pass (weak; see gaps) |
| 17 | No spawn during backup/restore | pass |

## Findings

- Plain backup payload files are created `0644`; confidentiality relies on the `0700` directory chain. Encrypted files are `0600`.
- `docs/backup/offline-data-recovery.md` states Node >= 22.16; the code constant `MIN_STORAGE_NODE_VERSION` is 22.18. The new guide uses 22.18.
- Test 16 only proves refusal without a coordinator. The active-run defer path is covered by the existing
  `tests/online-backup.test.js` with synthetic gates, not by this suite.

## Gaps (skipped or unverified; not claimed as working)

1. Quarantine of corrupt raw source files in data backups does not exist (backup aborts). Skipped case.
2. Receipt replay / lost response / deleted target for data **restore** does not exist (conversation import has it, tested elsewhere).
3. WebSocket generation transport and offline-client generation handling are not implemented. Skipped.
4. Online backups are disabled (no certified writers); barrier budgets were never measured under real writers. Skipped.
5. No Settings UI for data backup/restore, hence no PL/EN/mobile readability check. Skipped.
6. No legacy-store readers or forward migration; this report makes no claim about consolidation of legacy stores. Skipped.
7. Not tested here: rename/fsync failures and worker crash beyond the journal-step and ENOSPC hooks (no further hooks exist);
   mount-point destinations; KDF defaults at full cost; datasets near the 1 GiB online stage or 8 GiB plaintext caps;
   Windows permission semantics; retention in the full scheduler path after a failed run (unit-level only here).
8. Settings and conversations export/import are not re-exercised end to end in this suite; see their own tests.
