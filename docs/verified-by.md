# Verified-by commit trailers

Cretli checkpoint and automatic integration commits include a `Verified-by` trailer derived from the latest implement/fix delegation for the leaf:

```text
Verified-by: unit
Verified-ids: todo-leaf-material
```

`Verified-by` is `none` when no verification result exists, verification did not pass, or its result is stale. A passed result is `e2e` when at least one selected id belongs to `REVIEW_VERIFY_E2E_IDS`; otherwise it is `unit`. The e2e set is empty initially. `Verified-ids` lists the ids returned by the verify result when available.

Tree merges and voice commits do not add this trailer. Their commit paths are independent of leaf checkpoint and automatic integration commits.

## Commit gate for other commits

Install the tracked hook from a checkout with:

```sh
npm run hooks:install
```

The installer copies `scripts/git-hooks/commit-msg` to `.git/hooks/commit-msg`. It does not change `core.hooksPath` or replace other hooks such as `pre-push`. If a different local `commit-msg` hook already exists, installation refuses; `--force` backs it up first. Identical hooks are left untouched. A configured `core.hooksPath` produces a warning because Git may not run the copied hook.

Configure the gate locally with `git config cretli.verifiedByGate off|observe|enforce`. The default is `off`.

- `off`: allow commits without recording evidence.
- `observe`: allow commits and append a JSON line to `.git/cretli-verified-by.log` when code files are staged without a non-`none` trailer.
- `enforce`: block those commits. Attempts are counted by staged tree hash in `.git/cretli-verified-by-gate.json`; the third attempt for the same tree is allowed and logged as `override`. The state file keeps at most the latest 200 tree hashes. If Git cannot write the tree, the hook logs `write-tree-failed` and allows the commit.

The hook checks staged paths ending case-insensitively in `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.mts`, `.cjs`, `.cts`, `.py`, `.rb`, `.go`, `.rs`, `.java`, `.kt`, `.swift`, `.c`, `.cc`, `.cpp`, `.h`, `.hpp`, `.cs`, `.php`, `.sh`, `.sql`, `.vue`, `.svelte`, `.json`, `.yml`, `.yaml`, or `.toml`. Other extensions (including documentation and lock files) do not trigger the gate. Merge, cherry-pick, and revert commits are skipped. It does not run for Cretli's `git commit-tree` commits, whose trailers are written by the server.
