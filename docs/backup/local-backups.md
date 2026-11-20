# Automatic local backups

The server writes a local automatic backup at startup and hourly to `data/backups/auto/<timestamp>/`. JSON files are copied hourly. Registry-managed SQLite databases are copied once per day with SQLite's online backup API in a worker thread. Each directory has a manifest with file sizes, SHA-256 digests, and JSON record counts. Files use mode `0600`; directories use `0700` where supported.

Retention keeps up to 24 recent hourly snapshots, 7 daily snapshots, and 4 weekly snapshots. Keep free disk space available; automatic backups remain on the local disk and are not an off-machine backup.

List snapshots with `node scripts/backup-restore.mjs --list`. Restore is a dry run by default. Stop Cretli and pause Workspace Watchers, inspect the dry run, then add `--apply`; `--only chats.json` limits a restore to one file. Review the manifest and verify the application after restoring.

Large record drops in `chats.json` and todo JSON writes create a sibling `.pre-shrink-<timestamp>` copy and log an alert before the new content is written. Check `operator_server_status.backup` for the last successful automatic backup and the most recent error.
