---
id: f515dce7dbb1
title: Is `project` required on every issue?
status: resolved
project: OQ
type: story
labels: []
createdAt: 2026-11-14T14:43:15.968Z
rank: a6
---

- **Question:** Must every issue carry `project: KEY`, or may it be omitted (unassigned)?
- **Trade-off:** Required keeps the model uniform, with `init` creating a default project (named after the
  repo, or a placeholder such as `MAIN`). Optional is lighter for tiny repos but adds an "unassigned" case to
  every filter and view.
- **Recommendation:** Required, with a default project created by `init`. Existing and hand-written issues
  without a key fail `validate` with a clear fix hint.
- **Decision / date:** 2026-11-14. `project` is required on every issue, and `init` creates a default project. `parent` stays optional (ADR-0010). Recorded in ADR-0009.
