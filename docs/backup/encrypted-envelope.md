# Encrypted backups: envelope v1 (B5)

Frozen format and operating rules for encrypted offline backups. Code: `lib/backup/encryption/`
(`envelope.js`, `pack.js`, `encrypted-backup.js`) and `lib/backup/offline/staging.js`. Tests:
`tests/encrypted-backup.test.js`; compatibility fixture: `tests/fixtures/backup/envelope-v1/`
(`fixture.cretlibak` + `plain.bin`, password `correct horse battery staple`). Contract:
[settings-backup-design.md](../settings-backup-design.md) ("Secret boundaries"), BACKUP-06 in
[the review](../persistence-backup-review-opus55.md). Operator commands: [offline-data-recovery.md](offline-data-recovery.md).

## Envelope v1

A single file `<id>.cretlibak` (big-endian integers). A change to anything below needs envelope v2;
the fixture test fails on any byte difference of v1.

| Part | Content |
| --- | --- |
| header (42 + descriptor bytes) | magic `CRETLIBK`, version `1`, kdf `1` (scrypt), cipher `1` (AES-256-GCM), `0`, `log2N`, `r`, `p`, `0`, chunk size `u32`, salt (16), nonce prefix (4), descriptor length `u16`, descriptor |
| descriptor (JSON, ≤ 512 B) | exactly `createdAt` and `profile` (`data` or `data-credentials`) |
| record | type `u8` (`H` header-auth, `C` chunk, `F` final), ciphertext length `u32`, ciphertext, GCM tag (16) |

* Order: one `H` record (index 0, empty plaintext), chunk records (`C`, indices 1..n), one `F` record, end of file.
* Every record: AES-256-GCM, nonce = nonce prefix ‖ `u64(index)`, AAD = **whole header** ‖ type ‖ `u64(index)`.
  The header is authenticated by every record; reordering, duplicating or dropping a record changes an index and fails.
* Chunks are `chunkSize` plaintext bytes (power of two, 64 KiB – 4 MiB, default 1 MiB); only the last may be shorter; none is empty.
* `F` plaintext: chunk count `u64` ‖ total plaintext length `u64` ‖ SHA-256 of the whole plaintext. Reader verifies all three,
  then requires end of file (**trailing bytes fail**). A missing `F` is truncation.
* Key: `scrypt(NFKC(password), salt)` (32 B) → HKDF-SHA256 (salt = file salt, info `cretli-backup-envelope-v1/aes-256-gcm`).
  Default cost `log2N=15, r=8, p=1` (32 MiB). Passwords: 8–1024 characters when creating.
* Wrong password and tampering both surface as `ENVELOPE_AUTH_FAILED` (no oracle); structural problems use
  `ENVELOPE_FORMAT` / `_UNSUPPORTED` / `_TRUNCATED` / `_TRAILING` / `_TOO_LARGE` / `_KDF_LIMIT`.

### Bounds checked before any allocation or key derivation

`log2N` 14–17, `r` ≤ 8, `p` ≤ 4, `N·r·p` ≤ 2^21 (≤ 128 MiB scrypt memory); chunk size 64 KiB–4 MiB; descriptor ≤ 512 B;
each record's length ≤ chunk size (or 48 for `F`) **before** its body is read; file size ≤ plaintext cap (default 8 GiB)
plus per-record overhead, checked before the KDF; plaintext total re-checked while streaming. A forged header therefore
cannot make Cretli run an expensive KDF or reserve a large buffer.

## What is inside, and ordering of work

The plaintext is the verified B4 backup directory as a flat store-only stream (`pack.js`: `manifest.json` then
`files/<rel>`), so the detailed manifest (paths, counts, digests) is encrypted. **Nothing parses the stream until the whole envelope
authenticated:** `decryptToFile` writes to private staging and returns only after the final record (count/length/digest) and
end-of-file check pass; then the pack is unpacked (bounded, safe names), then the normal B4 verification (digests, SQLite checks)
runs; only then can restore apply anything.

## Listing

`listEncryptedBackups` / CLI `list` read only the unauthenticated header: `id` (file name), `createdAt`, `profile`, size and status
(`complete`, `incomplete` for `.partial`, `invalid`). No password, no paths, counts, prompts or secrets. The descriptor is
authenticated and cross-checked against the manifest when the backup is opened.

## Key custody

The passphrase is a function argument only. It is never written to settings, the control directory, the restore journal, the
manifest, the descriptor, logs or error messages; the CLI reads it from an owner-only `--passphrase-file` or
`CRETLI_BACKUP_PASSPHRASE`, never from argv. **A lost passphrase means the backup cannot be restored.** Scheduled encryption (B6)
must use a separate operator-provided key and never a plaintext key next to the backup.

## Managed secrets (opt-in, encrypted only)

`mcp-secrets.json`, `mcp-integration-secret.json`, `push-subscriptions.json`, `widget-installations.json`
(`CREDENTIAL_PATHS` in `managed-files.js`) are registry-managed but travel **only** in an encrypted backup created with
`--include-secrets` (profile `data-credentials`). Plain backups omit them (listed in `omissions`, `manifest.credentials=false`);
a plain backup directory declaring or containing them fails verification, and a restore of a backup without managed
secrets keeps the destination's own credentials. `.env`, login sessions, authentication signing material, TLS/SSH keys
and native harness homes are not managed paths and are never exported.

## Private plaintext staging

Plaintext (the staged backup directory, the packed stream, the decrypted stage) exists only under
`<controlDir>/staging/<op>-<id>/`, created `0700` (files `0600`), refused if not owned by the current user or accessible to
others (POSIX). Cretli does **not** encrypt the disk: the area relies on host disk protection (full-disk encryption, a private
account). Lifetime: removed in a `finally` after each operation; crash leftovers (kill -9, power loss) are swept the next time the
exclusive lease is held — every CLI command that takes it, and startup recovery (`recoverPendingRestore`). The one exception is
the stage an unfinished encrypted restore still reads for its roll-forward: it is kept (owner-only) until the restore is rolled
forward and then removed; if it was deleted, `recover` with the passphrase rebuilds it from the encrypted source recorded
(path only) in the journal. Leftover envelope names: `<id>.cretlibak.partial` (incomplete, never listed as complete).

## Encrypted restore and pre-restore copy

`restoreEncryptedBackup` takes the exclusive lease, authenticates/unpacks/verifies the backup, then creates the pre-restore copy
as an **encrypted** envelope under `<controlDir>/pre-restore/` with the same key and **re-opens it with that key** (decrypt,
unpack, B4 verification) before the first managed path changes. If either step fails nothing is touched and the journal is not
created. The copy includes managed secrets exactly when the incoming backup does. To go back, restore that `.cretlibak` file.
