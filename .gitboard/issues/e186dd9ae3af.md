---
id: e186dd9ae3af
title: "Hosted phase 3: per-user profile file and preferences"
status: todo
project: FEAT
type: story
labels: []
parent: cd25599aa801
createdAt: 2026-11-21T18:01:15.949Z
updatedAt: 2026-11-21T20:18:42.907Z
---

- **Goal:** per-user settings kept on the instance instead of browser storage.
- **Includes:** the profile schema and validation (no secrets, no machine paths, canonical remotes; compatible with a later Git-backed backing); reading and writing the instance-local profile file per workspace; preferences (view, theme, default repository) and personal saved views served from it; per-repository `branch` override; commit identity; fallback to the last good copy.
- **Not included:** the Git-backed profile and sharing the repository list with the local app (FEAT-31d4843).
- **Depends on:** phase 2; ADR-7d58e8b.
- **Validation milestone:** preferences and repository lists persist per user across sessions and survive an instance restart; a corrupted profile file falls back without breaking board access.
- **Related:** FEAT-8c2e32c, ADR-7d58e8b
