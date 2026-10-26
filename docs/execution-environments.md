# Execution environments

Execution environments are an opt-in adapter for running a process in a Docker-compatible container. The default is the existing host adapter; leaving the environment unset does not change process behavior.

The adapter supports Docker and rootless Podman. A run definition may provide an engine, image, and worktree path. The worktree is mounted at `/workspace` by default. Docker runs use the current UID and GID; Podman uses `--userns keep-id`. Containers use `--network none` unless a definition explicitly selects another network. No image is pulled by the adapter.

Container names and the `cretli.execution-environment=true` label let Cretli stop containers it created. A process exit hook removes live containers, and `sweepOrphanContainers` removes labelled containers left after an abrupt server kill. The sweep is exported so boot-time integration can call it without coupling this adapter to server startup.

Guest working directories are mapped from the mounted host worktree. PTY commands use an allocated `docker exec -t` or `podman exec -t` session, so resize events belong to the active exec PTY rather than the container's primary TTY. Spawn environment values are written to a private, temporary, read-only-at-use environment file in a second bind mount and sourced by the guest shell; values are never placed in engine argv. The temporary directory is removed by `stop()`.

## What this does and does not isolate

This is container isolation, not a virtual machine boundary. A container shares the host kernel. The guest sees only the mounted worktree (plus the private environment file), has no network by default, drops all Linux capabilities (`--cap-drop ALL`) and cannot gain privileges (`--security-opt no-new-privileges`). The adapter refuses to mount the filesystem root, the user's home directory, a relative path, or a path containing a comma or newline (a comma would inject extra `--mount` options). It never mounts the engine socket, the host home or the Cretli `data/` directory.

Things to know before relying on it:

- Docker group membership is equivalent to root on the host. Prefer rootless Podman.
- On WSL, worktrees on Windows drives (`/mnt/<letter>`) are slow and have unreliable permissions; keep worktrees on the Linux filesystem.
- Plan mode in Cretli remains a guard, not a sandbox (see `SECURITY.md`); a read-only worktree mount (`readOnly`) is the container-level equivalent.
- The harness CLI and its login must exist inside the user-supplied image; Cretli does not build or maintain images.
- Nothing selects the container backend yet: there is no Settings entry and no boot-time sweep wiring. Both belong to the follow-up Settings todo, so default runs are unaffected.

## Manual image check

With Docker or rootless Podman installed and a local image containing the desired command, verify that `probe()` reports the engine and version, files created under `/workspace` have the invoking host UID/GID, the default network is unavailable, PTY resize changes the guest terminal size, and `stop()` removes the named container. CI uses the fake engine fixture and does not pull images.
