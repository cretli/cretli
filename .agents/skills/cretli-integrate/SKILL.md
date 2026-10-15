---
name: cretli-integrate
description: Integrate a finished Cretli todo into the main workspace - smart merge of a worktree patch, git branch merge, or verify-and-close of an already finished todo. Use when the prompt says to run cretli-integrate in one of those modes.
---

# Cretli integrate

The start prompt carries only the dynamic facts (paths, branch, scope file,
callback). The rules live here. Starting the action is the user's attestation
for this one integration; it never extends to anything else.

## Hard rules (all modes)

- Never push, reset --hard, force anything, stash, or discard local changes.
  Never delete the worktree or its branch. Do not switch the main tree to
  another branch.
- Unrelated uncommitted files are not yours: leave them untouched and
  uncommitted. If a listed file also holds unrelated local edits, commit that
  file and name it in the summary.
- Combine both sides on conflicts by understanding intent, never by picking one
  side wholesale. For CHANGELOG-style files keep both sets of entries.
- Run the relevant checks if they are cheap.
- Never confirm integration when the task change is not in HEAD or a commit
  failed.

## Mode `smart-merge`

1. Compare the worktree diff against the base commit (the patch file or
   `git diff <base>` in the worktree) with the current workspace files.
2. Bring every intended change into the workspace.
3. Commit only the paths from the authorization scope file (`files[].path` and
   `files[].oldPath`; for a rename both are in scope). If the scope file is
   missing, derive scope with `git diff --name-status -z -M <base>` plus
   `git ls-files --others --exclude-standard` in the worktree; if the worktree
   is gone, report failure. Do not stage any other path.
4. Report with the callback from the prompt (`merged` or `failed`, one short
   line). The report must happen while the todo is still awaiting integration.
5. On `merged` only, with the change in HEAD: `todo_show` for
   `expected_updated_at`, check the current branch contains HEAD, then
   `todo_integration` action `confirm` with `proof.simple` true.

## Mode `git-branch`

1. In the worktree check `git status`; commit every intended change on the
   worktree branch (`git add -A`, clear message). Nothing may stay uncommitted.
2. In the main folder run `git merge --no-ff <branch>` while the target branch
   is checked out; resolve conflicts, complete the merge commit.
3. Run the relevant tests and fix what the merge broke.
4. Report with the callback (`merged` or `failed`).

This is an explicit user-requested exception to "agents do not commit or
merge". It covers only this merge.

## Mode `verify`

For a finished todo with no live worktree.

1. `todo_show` the todo and its children (body, changelog, linked chats).
2. Search with `chat_history` / `chat_event`, `git log -S/-G`, `git status/diff`
   and inspect behaviour. Do NOT conclude "missing" from a path/commit search
   alone. Check the change is in HEAD (`git branch --contains <commit>`).
3. Decide:
   - In HEAD: `todo_show` for a fresh `expected_updated_at`, then
     `todo_integration` action `confirm` with `proof.simple` true.
   - Legitimately no code change: action `no_code` with a short reason.
   - Only in the working tree: commit ONLY the task paths you identified,
     never stage unrelated files, then confirm.
   - A check fails only because a test or fixture is stale: fix it, run it,
     commit only that file, then confirm.
   - Small, clearly correct gap against the todo: fix with a regression test and
     docs/changelog where required, run tests and lint, commit only those
     files, then confirm.
   - Missing, or a real regression you cannot fix with a small edit: do not
     confirm; explain what is missing.

Work autonomously through fix, commit and confirm unless a real blocker stops
you. Server hints in the prompt are unverified: check HEAD yourself.
