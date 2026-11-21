---
id: dc3a07eaaf1a
title: Hosted reads come from Git objects through a tree-keyed snapshot cache
status: proposed
project: ADR
type: story
labels: []
createdAt: 2026-11-21T17:20:11.925Z
updatedAt: 2026-11-21T17:46:54.620Z
---

- **Date:** 2026-11-21
- **Related:** FEAT-8c2e32c, ADR-0495ea1, ADR-9eb2543, ADR-82e7ef1, ADR-3f39a2f

## Context

Today every operation reads and parses every issue file (`snapshot()` in `service.ts`). A hosted board read must not touch a working tree, must
be fast for repositories with thousands of issues, and must communicate how fresh the data is.

## Decision

1. Reads come from **Git objects in the bare cache** (`rev-parse`, `ls-tree`, `cat-file --batch`); nothing is checked out.
2. A **snapshot** is the parsed, immutable representation of `.gitboard/` (config, issues, problems) at a given tree. Snapshots are cached **keyed by the tree id of `.gitboard/`**, so commits that do not touch `.gitboard/` (the vast majority on an active code branch) never invalidate anything.
3. When the tree id changes, the new snapshot is derived **incrementally**: `diff-tree` old to new, re-read and re-parse only changed blobs, share the rest structurally. First load reads all blobs in one batch.
4. Snapshots live in memory, bounded by bytes, evicted LRU; they are rebuildable from the cache, which is rebuildable from the remote.
5. **Freshness contract.** Responses carry `ETag: <tree id>` and `X-Gitboard-Revision` (commit, tree, `verifiedAt`). The default read accepts a tip verified within `T_fresh` (default 5-30 s [A]) when webhook delivery is healthy for that repository; otherwise or on `fresh=strict` the node first probes the remote ref (protocol v2 `ls-refs` with ref prefix) and fetches if it moved. Writes always operate on a verified tip.
6. Staleness is **labelled, never hidden**: when the remote is unreachable a warm cache may serve reads marked stale with their age; cold reads fail.
7. Operations run on the snapshot through core (ADR-9eb2543): the same code as the CLI, with the Git-object `RepoSnapshot`.

## Alternatives considered

- **Materialise files and reuse today's code:** needs a worktree per read; rejected (ADR-0495ea1).
- **Cache by commit id:** invalidates on every code push; tree id is strictly better for the same correctness.
- **Persist parsed issues in a database:** adds an authoritative-looking second copy (ADR-099d4df). A derived index is possible later under that ADR's conditions.
- **Always fetch before every read:** correct but pays a network round trip per request and multiplies provider traffic by read rate.

## Rationale

Issues are small immutable-by-version blobs addressed by content. Tree-id keying turns Git's own structure into a perfect cache key.
Bounded staleness with explicit labelling keeps reads fast and honest; writes carry the real consistency (CAS).

## Consequences

- Snapshot memory is proportional to total issue text on hot repositories: about 2-3x raw bytes [E]; with a 20 GB cache budget, on the order of 10^4 repositories of 1k issues stay warm per node pair (model in FEAT-84505b0 (capacity model)).
- A read can be up to `T_fresh` behind the remote; users see their own writes immediately because the writer updates the snapshot.
- First load of a large repo is O(issues) blob reads and parses.

## Scalability implications

Warm read cost is O(issues) for `board.get` (assembly) and O(1) for `issue.get` once indexed by id; assembly can itself be memoised per snapshot and project. Cross-repository aggregation multiplies cold starts (FEAT-61ef959).

## Open questions

- `T_fresh` default; memory budget per repository; whether assembled boards should be memoised per snapshot (cheap, likely yes).


## Amendment 2026-11-21 (self-hosted direction)

No longer the baseline. Under ADR-819be48 and ADR-0aa6b23 reads use the existing filesystem reads of each user's clone. The tree-keyed snapshot cache described here (key = `git rev-parse HEAD:.gitboard`, valid because the managed working tree equals HEAD) stays an **optional later optimisation**, for example above ~30 active users on large boards.
