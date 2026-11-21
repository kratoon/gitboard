---
id: fbb4fe85d7cb
title: "Hosted: workspaces (several per user, each with its own forge connections and profile)"
status: todo
project: FEAT
type: story
labels: []
parent: 43d54b1ea488
createdAt: 2026-11-21T19:43:00.640Z
---

- **What:** a user may have several workspaces (for example personal and work). Each has its own forge connections, repository list, preferences and profile repository; a switcher selects the active one. This is how a user connects several accounts on the same provider, instead of per-repository credential binding.
- **Why deferred:** the MVP has one workspace, `default`. It is prepared for: per-user state keyed by (user id, workspace id), login identities and forge connections as separate records, clone paths computed from (user, workspace, canonical URL), the session carrying the active workspace id, workspace-scoped repository ids in the API.
- **Open:** whether the switcher also needs a combined view (currently no).

- **Related:** FEAT-8c2e32c, FEAT-cd25599
