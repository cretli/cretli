---
title: Getting started
description: Install Cretli with Node.js and open your first secure browser session.
---

# Getting started

Cretli provides a browser terminal and agent chat backed by your local machine. It requires Node.js `>=22.18`. From a clone of the repository, install dependencies and start the server:

```sh
git clone https://github.com/cretli/cretli.git
cd cretli
npm ci
npm start
```

The default address is `https://localhost:3011`. On the first visit, follow the setup flow to create a password. Keep that password private; it protects the web session and API.

![Cretli chat list on mobile](img/chat-list-mobile.png)

By default the server binds to `127.0.0.1`, so it is reachable only from the computer running it. To open it from a phone on your trusted LAN, use `npm run start:lan` or set `CRETLI_BIND=0.0.0.0`. LAN access must have a password or a `CRETLI_SETUP_TOKEN` configured. Do not expose the service directly to the public internet.

If the browser reports a certificate warning, use the local HTTPS address and accept the locally generated certificate only when you trust the machine and network. For deeper operational details, see [Troubleshooting](troubleshooting.md).

<!-- sources: README.md, package.json, lib/bind-host.js, server.js -->
