# Isolated runtime environments for agents, terminal and workspaces

Status: research only (todo `0fbeb094`). No code, dependency or setting changed.
Idea origin (2026-10-25): optionally run agents, the terminal or whole workspaces
in a mini-VM, a container or on a remote machine.

## 1. Current state

Everything runs as the Cretli server user on the host. Nothing is isolated.

| Concern | Where | What happens |
| --- | --- | --- |
| Operator terminal / agent PTY | `lib/ws/pty-ws-handler.ts` `handlePtyConnection` | `pty.spawn(command, args, { cwd, env })` with env from `ctx.buildInteractivePtyEnv`. Agent PTYs pass through `assertExecutorLaunchAllowed`; the operator terminal does not. `resolvePtyScopedCwd` limits cwd to the workspace. |
| CLI agent runs | `lib/ws/agent-run-ws-handler.ts` | Two `pty.spawn(ctx.agentCmd, args, ...)` sites (resume and fresh run). |
| Built-in tool execution | `lib/agent-harness/tool-executor.ts` | `spawn('bash', ['-lc', command])` and `spawn('rg', ...)`. |
| Review verify | `lib/sdk/sdk-review-verify.ts` | `spawn(process.execPath, [filePath])`. |
| Other helpers | `lib/chat-title-plan-runners.js`, `lib/fork-title.js`, `lib/workspace-watcher-integration.js`, `lib/ws/task-ws-handler.ts`, `lib/codex/codex-device-login.ts`, `lib/storage/worker-host.js` | Direct `spawn`; not agent-run paths but still host processes. |
| Plugin harness lifecycle | `lib/agent-harness/process-lifecycle-runner.ts` `startProcessLifecycles` / `beginProcessLifecycleStop` / `finishProcessLifecycleStop`; contract in `harness-plugin-contract.ts` (`HarnessProcessLifecycle`, entry kind `lifecycle`); loader `local-harness-runtime.ts` (`loadLocalChatHarness`, `dispatchLocalHarnessWebSocket`) | Plugins own long-lived processes through a lifecycle hook. This is the existing seam for "a process the harness needs started/stopped". |
| Env inheritance | `lib/agent-env.js` `buildAgentChildEnv`, `buildAgentEnvMask`, `isAgentEnvAllowlistEnabled`; `docs/agent-env-allowlist.md` | Optional allowlist of env passed to harness children; provider keys are denied unless a harness needs them. Reusable as the secret-injection source. |
| Process tracking | `lib/child-process-registry.js` `trackChildProcess`, `killChildProcessTree`, `beginChildProcessShutdown` | Tracks host PIDs and kills trees on shutdown. A container/VM child needs its own stop path (`docker stop`), the PID alone is only the client. |
| Worktrees | `lib/worktree/worktree-mode.ts` `resolveWorktreeMode` (`inherit`/`worktree`/`project`), `lib/worktree-manager.js`, `lib/workspace-watcher-worktree.js`, `docs/todo-worktree-contract.md` | A leaf already gets its own directory. That directory is the natural mount unit. |
| Plan mode | `lib/sdk/sdk-plan-guard.ts` `resolvePlanModeToolDecision`, `isMutatingPlanModeShellCommand`; `SECURITY.md` | A tool-level policy guard, explicitly not a sandbox (Plan mode is not a sandbox; some harnesses stay `danger-full-access`). |
| Egress | `docs/browser-egress-proxy.md` (`CRETLI_BROWSER_PROXY_SERVER`) | Proxy applies to the built-in browser only, not to agents. |
| Containers today | `Dockerfile`, `docker-compose.yml`, `docker-compose.demo.yml`, `scripts/demo-instance.mjs`, `docs/demo-and-screenshots.md`, `docs/MULTI-INSTANCE.md` | Cretli itself can be containerised (the demo runs it that way). Agents inside are not separately isolated from the server. |

Consequence: any isolation must wrap the places that call `pty.spawn`/`spawn` for
agents, terminals and verify. There is no single choke point yet; `pty.spawn`
appears in two files and `spawn` in several.

## 2. Backend comparison

Start-up for Docker was measured on the dev machine (WSL2, Docker already
installed, image `node:22-bookworm` already local, `--pull=never`, `--network none`,
no-op `node -e 0`): 589, 687, 756 ms (median ~690 ms). Writing 2000 small files
through a bind mount from a Linux-filesystem path took ~480 ms in total
including start-up. A bind mount from a Windows-drive path in WSL was **not**
measured (see Risks). Other backends: unmeasured, nothing was installed;
figures are from vendor documentation and common experience and are
order-of-magnitude only.

| Backend | Linux | WSL2 | macOS | Windows | Start | Idle cost | Workspace mount | Network control | Rootless | User setup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Docker (Engine / Desktop) | yes | yes (Desktop or in-distro engine) | Desktop (VM) | Desktop | ~0.7 s measured | tiny | bind, named volume, tmpfs overlay | `--network none`, user networks, proxy env | optional (daemon is root by default; docker group = root-equivalent) | low if already installed |
| Podman rootless | yes | yes | `podman machine` (VM) | `podman machine` | ~0.5-1 s | tiny | bind with userns mapping (`--userns=keep-id`) | `--network none`, slirp4netns/pasta | yes (default) | low-medium |
| bubblewrap / firejail | yes | yes | no | no | <50 ms | none | bind/overlay namespaces | `--unshare-net` | yes (userns) | low; not a VM, shares kernel |
| systemd-nspawn | yes (root) | partly (needs systemd) | no | no | ~0.3 s | small | bind | private network | no (root) | medium |
| Lima | yes | n/a | yes (best fit) | experimental | 10-30 s boot, then reuse | 1-2 GB RAM | virtiofs/sshfs/9p | guest firewall | yes | medium |
| Multipass | yes | limited | yes | yes (Hyper-V) | 10-40 s | 1+ GB RAM | mount via sshfs | guest firewall | n/a | medium |
| QEMU/KVM | yes (needs /dev/kvm) | only with nested virt | HVF | WHPX/TCG (slow) | 2-10 s with a light image | 256 MB+ | 9p/virtiofs | full (user-mode net, nftables) | yes with user-mode net | high (images, kernels) |
| Firecracker | yes (KVM only) | nested virt only | no | no | ~125 ms claimed by project | ~5 MB overhead | block device / vsock; no easy shared dir | tap device, full control | needs KVM access | very high (rootfs, kernel, jailer) |
| Remote machine (SSH) | yes | yes | yes | yes | connection ~0.3-1 s | none locally | sync (rsync/git) or sshfs, not a live bind | remote's own policy | n/a | medium; secrets leave the host |

Reading the table:

* Only container engines cover all four host platforms with one code path (via
  Docker Desktop / `podman machine`), and they are the only ones with sub-second
  start.
* Firecracker and QEMU give a true kernel boundary but need KVM, which WSL2 and
  most macOS/Windows setups do not expose without extra work. They stay a
  later, Linux-only "hard isolation" tier.
* bubblewrap is the cheapest way to get filesystem and network namespaces on
  Linux/WSL without a daemon. It is a candidate for a zero-install tier but is
  Linux-only and shares the kernel (same threat class as containers).
* Remote machine isolates the host completely but changes the data path: the
  workspace must be synced and secrets leave the machine.

Threat class: containers and bubblewrap defend against an agent that is careless
or prompt-injected into touching the host filesystem/network; they do not defend
against a kernel exploit by a determined attacker. A VM (QEMU, Firecracker,
Lima) does.

## 3. Proposed model

### 3.1 Interface

A thin adapter, selected per run, that replaces direct `pty.spawn`/`spawn`:

```
ExecutionEnvironment {
  id, kind            // 'host' | 'container' | 'bubblewrap' | 'ssh' | 'vm'
  probe()             // availability + version, never starts anything
  prepare(run)        // pull/check image, create mounts, returns handle
  spawnPty(handle, command, args, { cwd, env, cols, rows })  // node-pty compatible
  spawn(handle, command, args, { cwd, env })                 // child_process compatible
  stop(handle, { force })  // required: PID tracking alone cannot stop a container
  snapshot?(handle)   // optional (VM only)
}
```

`host` is the identity implementation and stays the default, so behaviour is
unchanged when the feature is off. The container implementation returns an
object that looks like the node-pty/`ChildProcess` the callers already use
(`docker run -i -t ...` or `docker exec` as the client process), which keeps
`child-process-registry.js` working for the client PID while `stop` removes the
container.

### 3.2 Where it plugs in

1. A resolver `resolveExecutionEnvironment({ workspace, harness, role, leaf })`
   next to `resolveWorktreeMode` (`lib/worktree/worktree-mode.ts`): the same
   inherit/override pattern (`inherit | host | <environment id>`).
2. `lib/ws/agent-run-ws-handler.ts` (both `pty.spawn(ctx.agentCmd, ...)` sites)
   and `lib/ws/pty-ws-handler.ts` `handlePtyConnection`: call the adapter instead
   of `pty.spawn`. The operator terminal opt-in is separate from the agent one.
3. `lib/agent-harness/tool-executor.ts` (`spawn('bash', ['-lc', ...])`) and
   `lib/sdk/sdk-review-verify.ts`: route through `spawn` of the same handle so
   review verify runs where the implementation ran.
4. Plugin harnesses: expose the handle to `HarnessProcessLifecycle` via the
   existing `startProcessLifecycles` / `finishProcessLifecycleStop` pair, so
   plugin-owned processes are started and stopped with the environment. This
   needs an additive capability flag in `HarnessPluginCapabilities`
   (`HARNESS_PLUGIN_CAPABILITY_KEYS`) so a harness declares whether it works in
   a container (it must bring its own CLI binary and login state).
5. Watcher / worktree leaf: environment lifetime = leaf lifetime. Prepare when
   the worktree is prepared (`lib/workspace-watcher-worktree.js`), stop on
   checkpoint/close. Mount only the leaf worktree directory (and the git
   common dir read-write only if the leaf commits, which Cretli currently
   forbids for agents). Host-side steps (leaf checkpoint, integration) stay on
   the host.
6. Review gates: unchanged contract. Reviewer runs are read-only and may use a
   second, read-only mount of the same worktree. `lib/sdk/sdk-plan-guard.ts`
   stays as defence in depth; inside an environment it is no longer the only
   barrier, which finally lets "plan mode" be backed by a read-only mount.

### 3.3 Workspace mount

* Default: bind-mount the leaf worktree read-write at a fixed path in the
  guest. Everything else in the host filesystem is invisible.
* Review/plan roles: same mount read-only.
* Optional later: overlay (lower = worktree, upper = tmpfs) so the agent's
  changes can be reviewed as a diff before they reach the worktree.
* Guest user must map to the host UID so files are not root-owned (Podman
  `keep-id`, Docker `--user $(id -u):$(id -g)`).
* Mount the directory itself, not its parent; never mount the Cretli `data/`
  directory or the host home.

### 3.4 Network

* Default for an environment: no network except an allowlist.
* Allowlist enforced by an egress proxy the guest is forced through (proxy env
  plus `--network` limited to the proxy). The browser egress proxy
  (`docs/browser-egress-proxy.md`) has the right shape (allowlist, SSRF
  policy) but is scoped to the browser; reuse its design as a shared module
  rather than the same process, with its own per-environment allowlist (model
  provider hosts, package registries when the user opts in).
* Harness CLIs need their provider API host; that host list must come from the
  harness plugin manifest, not be hardcoded in Cretli.
* Cretli's own MCP bridge must be reachable from the guest (loopback-only
  today). Needs a documented, authenticated bridge endpoint or a unix socket
  mount. See Open questions.

### 3.5 Secrets

* Never baked into an image. Injected per run as env (`-e KEY` without value
  taken from the spawn env) or tmpfs file, built from the existing
  `buildAgentChildEnv(harness, ...)` allowlist, so one policy decides what a
  harness sees on the host and in the guest.
* CLI login state (`HOME`-based credentials of Claude/Codex/etc.) is the hard
  part: either mount a dedicated per-environment config directory (read-only),
  or require API-key auth inside environments. Never mount the real `HOME`.
* Logs and the child registry must keep redacting injected values.

### 3.6 Settings

* New Settings block "Execution environments", **off by default**.
* Per workspace: environment id (or `host`). Per harness: override. Per role
  (terminal / agent / verify): opt-in flags.
* The environment definition (image name, extra mounts, allowlist hosts) lives
  in the user's `data/` settings, never in the repo. Repo documentation uses
  generic names (`example.com`, `my-app`).
* `probe()` results drive the UI: a backend that is not installed is shown as
  unavailable with the reason, never auto-installed.

### 3.7 Demo / screenshots use case

`docker-compose.demo.yml` + `scripts/demo-instance.mjs` already give a
repeatable fictional-data instance (`docs/demo-and-screenshots.md`). That is
"Cretli inside a container", the inverse of this feature, and needs no adapter.
A later step is a reproducible screenshot environment definition that reuses
the same image, so demo captures do not depend on a developer machine.

## 4. Recommendation

First version: **container backend with Docker-compatible CLI (Docker or rootless
Podman), agent runs and review verify only, one worktree-leaf bind mount,
`--network none` by default, per-harness allowlist later.**

Why, with numbers:

* Only option that is cross-platform from one code path and uses software most
  developers already have. Docker was already present here.
* Start ~0.7 s measured (median of 3, local image, no pull) versus 10-40 s for
  Lima/Multipass and 2-10 s for QEMU; per-leaf start cost is negligible next to
  a model turn.
* No KVM requirement (Firecracker and QEMU/KVM would exclude WSL2, macOS and
  most Windows hosts).
* Matches the existing seams: one resolver beside `resolveWorktreeMode`, one
  adapter at the two `pty.spawn` agent sites, lifecycle hook for plugins.
* Rootless Podman as the preferred documented path; Docker accepted with a
  warning that docker-group membership is root-equivalent.

Explicitly deferred: operator terminal inside a container, whole-workspace
environments, VM tiers (Lima for macOS, QEMU/Firecracker for Linux), remote
machine, bubblewrap tier, overlay review mode.

Be honest about the guarantee: this is container isolation, not a VM boundary.
Docs and UI must say so, and `SECURITY.md` must keep plan mode described as
non-sandbox.

## 5. Risks

* **WSL bind-mount I/O.** A Linux-filesystem path was fast (2000 files in
  ~0.5 s including start-up). Paths on Windows drives mounted into WSL are
  known to be much slower and to break file watching and permissions; not
  measured here. Recommend refusing or warning for such workspaces.
* **PTY in a container.** Needs `-t` and correct resize propagation
  (`resolveAgentPtySize` / resize handling in `pty-ws-handler.ts`); the known
  "generating appends lines" issue in the system rules is exactly a PTY size
  mismatch, and a client PID wrapper adds a second place it can occur.
* **UID/permissions.** Wrong mapping leaves root-owned files in the worktree and
  breaks cleanup in `worktree-manager.js`.
* **Harness CLI availability and login.** Each CLI must exist in the image and
  authenticate without the host `HOME`. Image maintenance becomes Cretli's
  support burden; only a documented, user-supplied image should be required.
* **Process lifecycle.** `child-process-registry.js` kills trees by host PID; a
  killed `docker run` client can leave a running container. Needs a named
  container, label sweep on startup, and `stop` on every shutdown path.
* **Daemon trust.** Docker socket access is root-equivalent; Cretli must never
  mount the socket into a guest and should warn about the docker group.
* **False sense of security.** Users may assume VM-grade isolation. Wording and
  defaults (no network, no host HOME, no `data/`) matter more than the
  backend.
* **Memory pressure.** `assertExecutorLaunchAllowed` gates agent PTYs on host
  memory; container memory limits should feed the same gate, not bypass it.
* **Secrets leaking via logs, `docker inspect` or process lists** when passed as
  command-line values; use inherited env or tmpfs files.

## 6. Open questions

1. How does a guest reach Cretli's MCP bridge (loopback today): published
   port with token, unix socket mount, or stdio proxy?
2. Auth for subscription-based CLIs (browser/device login) inside a container:
   support only API-key auth in v1?
3. Should git operations of a leaf (status/diff for the leaf checkpoint) stay
   host-side only? Proposed yes; confirm no harness requires `git commit` in
   the guest.
4. Image policy: user-supplied image only, or a documented reference
   Dockerfile in the repo?
5. Does plan/review role get a read-only mount in v1, and may that replace part
   of `sdk-plan-guard` checks for sandboxed runs?
6. Is the operator terminal in scope at all? It is the remediation path under
   memory pressure and is exempt from the launch gate today.
7. Allowlist ownership: per harness plugin manifest, or Settings only?
8. Windows-native (non-WSL) Cretli hosts: support or explicitly out of scope?

## 7. Proposed follow-up todos

Created as separate root `idea` todos (not children of the research leaf),
each linked through `source_todo_id = 0fbeb094-bb7d-4f51-ab3a-0426176e7329`.

| Order | Todo id | Title |
| --- | --- | --- |
| 1 | `9ea64b73-7dac-45e7-a71c-9e04b13d2a10` | ExecutionEnvironment adapter interface + host passthrough |
| 2 | `b8430e54-52e9-48ef-826d-91fdb6f67cb7` | Container backend (Docker/rootless Podman) for agent runs |
| 3 | `1da82d4f-29b7-4998-b2bf-1626a187fc56` | Secrets and egress allowlist for guests |
| 4 | `56b5b870-ec43-473f-8470-b23aba14c1cc` | Settings (off by default) + worktree/Watcher/verify integration |
| 5 | `9a64b3fb-d362-4bf9-9570-fe6e77ba37b7` | Spike on hard-isolation tiers (Lima, QEMU/KVM, Firecracker, bubblewrap) |
