---
title: Workspaces
description: Save project folders, import a workspace file, and choose the right working directory.
---

# Workspaces

A workspace groups project folders so chats, tasks, and tools can work in the right place. In **Settings → Workspace**, add your project folder or import an existing `.code-workspace` file from VS Code or Cursor. The folder must exist on the machine running Cretli, even when you connect from a phone. A project called `my-app` is a useful first example.

## Saved workspaces and imports

Cretli stores workspace definitions in its own SQL database, including folder order, enabled folders, and the default folder. You do not need a workspace file to keep using a saved workspace. An imported `.code-workspace` supplies the initial folder list; later edits to that file do not automatically change Cretli's list.

Use the explicit refresh-from-file action when you want to import newly added folders. Refresh adds missing folders rather than removing your saved choices. Writing folders back to the workspace file is a separate, optional action. Relative folder paths in an imported file are resolved from that file's location.

## Before starting work

Check the selected workspace and default folder before creating a chat or task. Chats, todos, and delegations are associated with the working directory, so changing that choice matters. Settings also lets you configure workspace Docs: an existing project documentation folder can be used immediately, while an external notes folder requires your consent and a separate switch for agent reading.

See [working surfaces](chat-and-agents.md) for the panels used inside a workspace and [Settings](settings.md) for other preferences.

<!-- sources: docs/ARCHITECTURE.md, lib/persist/workspaces-store.js, lib/workspace.js, docs/docs-module.md -->
