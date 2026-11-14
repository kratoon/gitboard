---
id: a3bf7eb24cac
title: "Board columns: per repo or per project?"
status: resolved
project: OQ
type: story
labels: []
createdAt: 2026-11-14T14:43:16.192Z
updatedAt: 2026-11-14T14:43:21.876Z
rank: a8
---

- **Question:** Should columns (statuses) be defined once in `.gitboard/config.json` for the whole repo, or may
  each project override them?
- **Recommendation:** Repo-level only in the MVP. Per-project override is a non-breaking later addition.
- **Note (2026-11-14):** migrating ADRs into Gitboard (OQ-9a86155) would need ADR-specific statuses, which
  strengthens the case for per-project columns. Worth reconsidering before M1.
- **Decision / date:** 2026-11-14. Done in the MVP, with three layers: Gitboard built-in defaults, then a repo override, then a project override that takes precedence over the repo. Recorded in ADR-0011.
