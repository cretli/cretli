---
name: quote-safe-probe-files
description: Probing code that parses shell quotes/backslashes (approval or risk classifiers) via a gitignored scratch .mjs instead of inline node -e, because a shell-escaping mistake can execute the very command under test and leak env secrets.
source: auto-skill
extracted_at: '2026-10-05T10:48:58.879Z'
---

# Probe quote/escape-sensitive code with a file, never inline `-e`

Trigger: you are verifying behaviour of code that consumes **shell command strings** — Cretli's
`lib/opencode/opencode-permission.js` (`readCommandPositionText`, `isOpenCodePermissionWithinWorkspace`,
`classifyOpenCodePermissionRisk`, `resolveOpenCodeApprovalAction`), the approval broker/advisor, any
command classifier or sanitizer — and your fixtures themselves contain `'`, `"`, or `\`.
Also applies to any probe whose input strings need escaping.

## Hard rule

Do **not** embed quote/escape-sensitive fixtures in `node -e '...'` or
`node --input-type=module -e "..."`. Write a throwaway module and run it:

```bash
# cretli: data/ is gitignored, so scratch never pollutes git status / material_revision
git check-ignore -v data/tmp/probe.mjs     # confirm before relying on it
node data/tmp/probe.mjs
```

Create it with the file-writing tool, not with a heredoc or `echo` — a heredoc re-introduces the
same shell layer you are trying to avoid.

## Why (real incident, 2026-10-05)

A Workspace Watcher parent ran an inline probe to test an escaped-quote bypass in the permission
classifier. The fixture `\'` sequences were re-parsed by bash on the way in; the mangled argument
caused the shell to **actually execute `env`**, which dumped the entire process environment —
including `OPENAI_API_KEY`, `QWEN_API_KEY` and `OPENCODE_API_KEY` — into the agent transcript.
The probe was *about* that exact class of bypass, and the parent became the victim of it.

Consequences that make this worth avoiding rather than recovering from: secrets in a transcript
must be treated as leaked and rotated, and the same failure mode silently corrupts the measurement
(your probe no longer tests the string you intended).

The mechanism: a fixture passes through **three** escaping layers — JS single-quoted string,
shell single-quoted `-e` argument, then the shell semantics of the string under test. `\'` is
"literal quote" in layer 3 but is invisible/absent in layer 2 (POSIX single quotes do not process
backslash escapes at all), so the argument terminates early and the remainder of your source
becomes shell tokens.

## Writing the fixture table

Use `String.raw` so backslashes survive into the string verbatim, and carry the expectation as a
separate flag instead of nesting more quotes:

```js
const cases = [
  ['must flag  sudo via escaped quote', String.raw`echo \'; sudo systemctl stop x; echo \'`, 'flag'],
  ['must quiet FP guard quoted pattern', `grep -r 'foo' '../i18n'`, 'quiet'],
];
for (const [label, command, expect] of cases) {
  const ev = { action: 'bash', metadata: { command } };            // correct event shape
  const r = classifyOpenCodePermissionRisk(ev, { allowReviewVerify: false });
  const a = resolveOpenCodeApprovalAction({ mode: 'local_reads', sdkMode: 'agent',
    permissionEvent: ev, assignment: '', workspaceFolder: W });
  const bypassed = expect === 'flag' && a.reply === 'once';
  console.log((bypassed ? 'MISMATCH ' : 'ok       ') + JSON.stringify(
    { label, command, risk: r.risk, categories: r.categories, within: ..., reply: a.reply }));
}
```

Notes learned the hard way in the same session:

- The event shape matters. `{action, command}` at the top level reads as an empty command and every
  case collapses to the same generic result — a false "all fine". These helpers read
  `metadata.command` (and `resources`). Confirm the shape by looking at an existing test, not by
  guessing.
- Assert **both** directions in one run: the defect must now be caught, *and* the intentional
  false-positive removal must still hold. Only checking the first lets a "fix" pass by flagging
  everything.
- Print a plain `PROBE: all expectations met` / `PROBE: N mismatch(es)` line so the verdict is not
  something you have to eyeball across rows.
- `rm -f` the scratch file(s) when done; they are disposable, not deliverables.

## Use it as independent evidence

A file probe you run yourself is the parent's substitute for a child that cannot execute tests
(`traits.review_can_run_tests=false`) and for areas with no audited `review-verify` catalog id.
Report it as a measured matrix with the exact commands, and say explicitly what remains unverified.
