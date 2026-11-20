---
title: Install with Docker
description: Run Cretli with Docker Compose and persist its runtime data safely.
---

# Install with Docker

Docker Compose is the shortest route when Node.js is not installed on the host. In a checkout of Cretli, start the service with:

```sh
docker compose up
```

The Compose file publishes Cretli on port `3011` and bind-mounts the `./data` directory next to `docker-compose.yml` to `/app/data`. That directory keeps setup state, configuration, and other application data across container replacements. Back up the `./data` directory according to your normal Docker operations policy.

On startup, the container entrypoint generates a `CRETLI_SETUP_TOKEN` when one is not already supplied and prints the generated token in the container log. Read it with `docker compose logs` and use it during initial setup. For repeatable deployments, provide your own `CRETLI_SETUP_TOKEN` through the Compose environment configuration instead of copying a generated value into source control.

The container uses HTTPS, so open the local HTTPS address after the service is ready. Keep the published port on a trusted network, configure a password, and review [Security basics](security-basics.md) before forwarding traffic beyond the host.

<!-- sources: docker-compose.yml, Dockerfile, scripts/docker-entrypoint.sh, lib/bind-host.js -->
