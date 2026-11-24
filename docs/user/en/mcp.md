---
title: MCP tools and external clients
description: Use Cretli's built-in tools, add MCP servers, and connect outside clients such as Claude Code.
---

# MCP tools and external clients

MCP (Model Context Protocol) lets agents call tools. Cretli uses it in two directions: agents inside Cretli call Cretli's own tools and any servers you add, and outside clients can call Cretli.

## Built-in tools

Every chat on a supported harness receives Cretli's built-in tools. They cover tasks (`todo_list`, `todo_update`), chat history (`chat_show`, `chat_history`), delegation (`delegation_start`), the built-in browser (`browser_*`), ports, and workspace docs. In Plan mode, reads stay available while writes need Agent mode. Browser, task, and delegation actions run against the workspace of the calling chat.

## Add MCP servers

Open **Settings → MCP** to add a server once instead of editing each harness config. Supported transports are **stdio** (a command and an argument list) and **Streamable HTTP** (a URL and headers). Choose which workspaces and harnesses may see it. Secrets are stored separately and never shown again after saving.

Automatic roles, such as delegation children, reviewers, and Watcher orchestrators, only get external servers when you switch on **For automatic agents** for that server. It is off by default. Every external tool call is logged in **Access log** without arguments or results. If a server gains tools, use **Refresh tools**.

## Connect an outside client

An external client such as Claude Code, Cursor, or Codex can reach Cretli at its `/mcp` endpoint. In **Settings → MCP**, install the connection for a folder. Cretli writes the `cretli` entry into the folder's `.mcp.json` (or the matching Cursor or Codex file) and keeps the token in a private file instead of the config. Each client has a mode:

- **plan**: read-only tools.
- **agent**: the full built-in catalog.
- **operator**: agent plus tools that act for you, for example reading delegation reports, checking or pausing the Watcher, and sending a message to a chat.

Choose the lowest mode that does the job, and revoke a client in Settings when you no longer need it. Never paste its token into chats or tasks.

<!-- sources: docs/mcp/SETUP.md, docs/mcp/OPERATOR-PLAYBOOK.md -->
