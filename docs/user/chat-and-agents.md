---
title: Chat and agents
description: Configure harnesses, choose a model, and run agents from the Cretli chat.
---

# Chat and agents

Cretli chat connects a conversation to a configured harness. Configure available harnesses in **Settings → Harness**, then select the harness and model in the chat controls. Provider credentials are stored in the application settings; never paste secrets into a conversation.

![Cretli chat on desktop](img/chat-desktop.png)

Use **Plan** mode when you want an agent to inspect the task and propose work before changes are made. Use **Agent** mode when the approved task should be executed in the workspace. The exact tools and model choices depend on the harness configuration.

Delegation lets an orchestrator ask another configured harness to perform a focused plan, implementation, or review. Delegated chats report back to the parent conversation; they do not change the approval rules for a TODO. The MCP setup guide explains the available delegation endpoints and configuration in detail.

When a run appears stuck, first check the selected harness, model, credentials, and server logs. Keep the browser connected while a run is active, and treat generated code as a change to review before using it.

<!-- sources: README.md, docs/ARCHITECTURE.md, docs/mcp/SETUP.md, app_front/i18n/en.js -->
