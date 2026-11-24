---
title: Backups and data
description: Where Cretli keeps its data, which backup tools exist, and how to restore safely.
---

# Backups and data

Cretli stores everything it creates in the `data/` folder inside the installation: chats, tasks, settings, certificates, and credentials. That folder is private runtime state. **Never commit it**, copy it into a repository, or paste its files into chats. The project's git ignore rules already exclude it.

## Choose a tool

| Need | Tool | Server |
| --- | --- | --- |
| Move non-secret settings | Settings → Data and backups, portable settings export | running |
| Copy or archive chats | Conversations export; import creates **new** chats | running |
| Hourly local snapshots | Automatic backups in `data/backups/auto/` | running |
| Disaster recovery of all data | `node scripts/cretli-offline-data.mjs` | **stopped** |

## Automatic local backups

The server writes a snapshot at startup and hourly. It keeps recent hourly, daily, and weekly copies, each with a manifest of sizes and checksums. These stay on the same disk, so they do not protect you from losing the machine. List them with `node scripts/backup-restore.mjs --list`. A restore is a dry run until you add `--apply`; stop Cretli and pause Watchers first.

## Full offline backup

With the server stopped, `backup --dest DIR` writes a verified copy of every managed file. Add `--encrypt` for a single encrypted `.cretlibak` file. Secrets are left out unless you also pass `--include-secrets`, so protect that file and its passphrase. Check any backup with `verify` before relying on it, and restore with `restore --backup PATH --yes`. A restore leaves the dataset paused: inspect the result, then run `node scripts/cretli-offline-data.mjs finalize` followed by `node scripts/cretli-offline-data.mjs resume`. Until you resume, automatic work such as Watchers stays off.

## Habits that help

- Copy backups to another machine or drive regularly.
- Take a backup before updating or changing configuration.
- Test a restore on a spare copy occasionally.
- Never share exported archives publicly; chats can contain private code and tokens.

<!-- sources: docs/backup/recovery-guide.md, docs/backup/local-backups.md, docs/backup/offline-data-recovery.md, docs/backup/conversations-export-import.md -->
