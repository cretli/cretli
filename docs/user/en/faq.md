---
title: FAQ
description: Short answers to common questions about Cretli, agents, access, and data.
---

# FAQ

## Is Cretli a hosted service?

No. Cretli is open source and runs on your own machine. The documentation site is static; your workspace, chats, and credentials stay on your server.

## Do I need an account or API keys?

Cretli itself needs no account. Each harness has its own requirement: some use a provider API key, others a vendor login. See the pages in the harness section.

## Which agent should I choose?

Start with one harness you already have access to. Add a second later if you want independent review from a different model. See [delegation and review](delegation-review.md).

## Can I use it from my phone?

Yes, after you opt in to LAN access with HTTPS and authentication. See [remote access](remote-access.md). The default is local only.

## Is it safe to expose it to the internet?

Not directly. It provides a full shell. Keep the default bind or use a trusted authenticated, encrypted boundary. See [security basics](security-basics.md).

## Does Watcher change my repository on its own?

Watcher can run bounded work cycles, but it never approves plans and never pushes. Automatic integration is off by default. See [Workspace Watcher](workspace-watcher.md).

## Where is my data and can I move it?

In the `data/` folder of the installation. Use the export and backup tools in [backups and data](backups-and-data.md), and never commit that folder.

## Why does an agent not see my MCP server?

Automatic roles only see external servers with **For automatic agents** enabled. See [MCP](mcp.md).

## Where do I get help?

Start with [troubleshooting](troubleshooting.md), then open an issue in the project repository without secrets or private paths.

<!-- sources: README.md, SECURITY.md, docs/INSTALL.md, docs/mcp/SETUP.md -->
