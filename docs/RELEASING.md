# Releasing Cretli

Cretli uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The product is still
early (`0.x`): breaking changes may land in a minor bump. `1.0.0` is reserved
for when README no longer calls the project experimental.

## Version source

The public version is the root [`package.json`](../package.json) `"version"`
field. The UI (Settings → Account) and GitHub Release tags use the same value.
Do not give `app_front/` its own version.

## Changelog

User-facing pull requests add a bullet under `[Unreleased]` in
[`CHANGELOG.md`](../CHANGELOG.md) (`Added`, `Fixed`, `Changed`, or `Removed`).

A release **freezes** that section:

1. Rename `## [Unreleased]` content to `## [X.Y.Z] - YYYY-MM-DD`.
2. Leave an empty `## [Unreleased]` heading at the top.
3. Update the compare links at the bottom of the file.

## Local gates (before tag)

`npm test` (includes the tracked-file token scan) and `npm run lint` must pass
on Node >= 22.13. Do not push a tag if either fails.

## Tag and GitHub Release

1. `package.json` (and the root entries in `package-lock.json`) already show
   `X.Y.Z`.
2. README status line matches `vX.Y.Z`.
3. Create an annotated tag **`vX.Y.Z`**. The tag without the `v` prefix **must**
   equal `package.json` version — CI checks this in
   [`.github/workflows/release.yml`](../.github/workflows/release.yml).
4. Push the tag to `github.com/cretli/cretli`. The workflow runs lint, tests,
   and a production front build, then opens a GitHub Release.
5. Set the GitHub Release body to the frozen `CHANGELOG.md` section for that
   version (auto-generated notes from commits are a fallback, not the source of
   truth).

## Cadence (0.x)

- `0.x.y` — bug fixes
- `0.x.0` (minor) — feature sets
- `1.0.0` — stable, non-experimental
