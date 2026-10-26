---
title: Workspace Watcher
description: Understand Watcher modes, planning gates, and safe autonomous cycles.
---

# Workspace Watcher

Workspace Watcher observes a workspace and coordinates recurring work. Its modes are `off`, `observe`, and `autopilot`. Turn it off when no monitoring is wanted; use observe for inspection and reporting; use autopilot when the configured workflow may schedule execution.

![Workspace Watcher panel](img/watcher-panel.png)

Control the feature in **Settings → Workspace Watcher**. One Watcher cycle creates one orchestrator chat. The orchestrator may inspect the workspace, create or update TODOs, and coordinate delegated work according to the configured harnesses.

The plan gate remains human-controlled: Watcher does not approve a plan automatically. Watcher also does not commit or push changes. Review the resulting TODO, plan, files, and test output before integrating work into your normal branch workflow.

For configuration details, event handling, and operational limits, see the [Workspace Watcher technical guide](https://github.com/cretli/cretli/blob/master/docs/workspace-watcher.md).

<!-- sources: docs/workspace-watcher.md, public/index.html, app_front/i18n/en.js -->
