---
id: caff4fa287bf
title: "Hosted: more login and forge adapters (Gitea first, then GitLab, Forgejo)"
status: todo
project: FEAT
type: story
labels: []
parent: 43d54b1ea488
createdAt: 2026-11-21T19:43:00.515Z
---

- **What:** additional provider adapters around the generic OAuth2/OIDC core. Gitea is next; GitLab and Forgejo after.
- **Why deferred:** the MVP supports GitHub only.
- **Notes from research (2026-11-21):** Gitea 1.23+ has granular scopes (`read:repository`, `write:repository`) but falls back to full access if a scope is mis-specified, has no device flow and, by default, non-rotating refresh tokens. Forgejo OAuth tokens have no scopes at all (full-account power), so for Forgejo OAuth should be login only and Git access should use a scoped token or SSH key. GitLab: `oauth2` as username with `read_repository` / `write_repository`, 2 hour tokens with rotating refresh tokens, no per-project selection for classic scopes, git-only scopes cannot call the API (so detect read-only by a failed push). Each adapter declares: endpoints, stable subject, Git credential format, refresh behaviour, whether its tokens are safe for Git (scoped, full-account, no), and an optional can-push lookup.

- **Related:** FEAT-8c2e32c, FEAT-cd25599
