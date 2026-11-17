---
id: 70f6d3fcc8ff
title: Keep `updatedAt` in frontmatter?
status: done
project: FEAT
type: story
labels:
  - question
createdAt: 2026-11-14T14:43:15.401Z
rank: a1
updatedAt: 2026-11-17T13:45:50.627Z
---

- **Question:** `updatedAt` changes on every edit, which makes diffs noisier and can conflict when merging.
  Keep it as in the sample, make it optional, or drop it and rely on `git log`?
- **Recommendation:** Keep it (matches the spec sample), but only touch it when content actually changes.
  Consider making it optional in the schema.
- **Decision / date:** 2026-11-14. Keep `updatedAt`. Gitboard sets it only when the issue's content actually changes (never on a no-op write). The schema treats it as optional, so hand-written issues without it are valid, and Gitboard adds it on the next real change. Recorded in ADR-30abf7d and ADR-7a20520.
