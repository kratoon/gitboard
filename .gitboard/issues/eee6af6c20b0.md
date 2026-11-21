---
id: eee6af6c20b0
title: "Hosted: PR mode (write to a branch and open a pull request) and board-branch auto-discovery"
status: todo
project: FEAT
type: story
labels: []
parent: 43d54b1ea488
createdAt: 2026-11-21T20:02:10.748Z
---

- **What:** an opt-in mode where edits go to a short-lived branch and a pull request is opened, for strictly protected branches; and optional automatic discovery of a conventionally named board branch (like gh-pages' `gh-pages`).
- **Why deferred:** the MVP pushes directly to one branch and has no `mode` key; unknown config keys are preserved, so a `mode` key can be added later without breaking older tools.
- **Open design questions:** one rolling PR branch versus a PR per session (a PR per edit is not workable); what the board shows (base branch, or base plus pending PRs) and how a user's saved edit stays visible; conflicts between rolling PRs; a provider-adapter method to open a PR (provider API on the write path, with its own permission); whether "saved" must be redefined as "proposed"; auto-merge where allowed. Convention-based discovery is implicit behaviour (a repo may have a `gitboard` branch for other reasons).
- **Related:** FEAT-8c2e32c, FEAT-cd25599
