---
id: dc3a07eaaf1a
title: Reads use the clone's files; a tree-keyed snapshot cache is introduced only on measured need
status: accepted
project: ADR
type: story
labels: []
createdAt: 2026-11-21T17:20:11.925Z
updatedAt: 2026-11-21T21:03:38.316Z
---

- **Date:** 2026-11-21
- **Related:** FEAT-8c2e32c, ADR-0aa6b23, ADR-099d4df, FEAT-dbcef46

## Context

Today every operation reads and parses every issue file (`snapshot()` in `service.ts`), about 50-150 ms per 1,000 issues on NAS-class hardware (an assumption to validate in Phase 0, FEAT-84505b0). That is acceptable for the MVP's target of tens of users. An optimisation may be needed on large boards with many active users.

## Decision

1. **The MVP uses the existing reads** of the user's clone (a clean working tree equal to the remote branch tip), under a per-clone read lock.
2. **A tree-keyed snapshot cache is introduced only on measured need**, for example above about 30 active users on large boards, or when measured read latency misses its target. It is tracked with the optional features (FEAT-dbcef46).
3. When introduced: the parsed, immutable snapshot of `.gitboard/` is keyed by the tree id (`git rev-parse HEAD:.gitboard`), so commits that do not touch `.gitboard/` never invalidate it; a changed tree is derived incrementally with `diff-tree`; memory is bounded and entries are evicted least-recently-used; the cache is rebuildable and never authoritative (ADR-099d4df).

## Alternatives considered

- **Reading from Git objects in bare repositories without a working tree:** reads without checkout. Rejected: the clone design already has a working tree and reuses the existing code unchanged.
- **Keying the cache by commit id:** invalidates on every code push; the tree id is strictly better.
- **Persisting parsed issues in a database:** a second copy that looks authoritative. Rejected (ADR-099d4df).
- **Fetching before every read:** correct but pays a network round trip per request.

## Consequences

- Read cost grows linearly with the issue count until the cache exists.
- No new code or state in the MVP.
