# C. Scalability and limits analysis

> **Partly replaced (2026-11-21).** The requirements changed to a self-hosted, multi-user server for any Git remote. Where this document conflicts with [07 Self-hosted architecture](07-self-hosted-architecture.md), 07 wins. This text remains the analysis of the provider-hosted (SaaS) variant.

Part of [FEAT-8c2e32c](README.md). Status: **analysis with stated assumptions; no benchmarks have been run against the proposed design.**
Labels: **[F]** fact (code, official docs, or measured locally, source named), **[A]** assumption, **[E]** estimate computed from assumptions, **[R]** recommendation.
Numbers marked [A] must be replaced by the Phase 0 spike results (S1-S6, see [roadmap](06-roadmap.md)).

## 1. Method and assumptions

### 1.1 Provider facts (GitHub, from the official docs source; `github/docs`, `github/rest-api-description`, github.blog, retrieved 2026-11-21)

| Fact [F] | Figure | Kind |
|---|---|---|
| Git read operations (clone, fetch) | **Recommended maximum 15 per second per repository**; "large amounts of read operations can result in throttled performance" | Provider recommendation (not a documented hard quota) |
| Pushes | **Recommended maximum 6 pushes per minute per repository** | Provider recommendation |
| Push size | Enforced at **2 GB** | Provider hard limit |
| Single object / file | Recommended 1 MB, enforced at **100 MB**; warning above 50 MiB | Provider hard limit |
| Repository size | Recommended ≤ 10 GB on disk (≤ 1 GB ideal, < 5 GB strongly recommended elsewhere) | Provider recommendation |
| Directory | Recommended ≤ **3,000 entries per directory**, depth ≤ 50, ≤ 5,000 branches | Provider recommendation |
| Documented rate limit for Git over HTTPS/SSH | **None as a numeric quota**; only the recommendations above. SSH-specific throttling: not documented | Unknown |
| REST primary limit | User 5,000/h (15,000 for Cloud-org-owned apps); App installation 5,000/h + 50/h per repository beyond 20, **cap 12,500/h**; Enterprise Cloud installation 15,000/h; user-to-server tokens share the user's 5,000/h | Provider hard limit |
| Conditional requests | A `304` does not count against the primary limit when correctly authorised | Provider behaviour |
| REST/GraphQL secondary limits | 100 concurrent requests (shared), 900 REST points/min per endpoint, 2,000 GraphQL points/min, 90 s CPU per 60 s, **80 content-generating requests/min and 500/h**; "subject to change without notice" | Provider hard limits |
| OAuth token requests | **No more than 2,000 OAuth access token requests per hour** (GitHub Apps and OAuth apps) | Provider hard limit |
| Tokens | Installation token lifetime 1 h; user access token 8 h, refresh token 6 months; `contents` permission is not documented as path-scoped | Provider facts |
| Webhooks | 10 s timeout; **no automatic redelivery**; deliveries retained 3 days; payload cap 25 MB; deliveries may arrive out of order | Provider facts |
| GitHub partial/shallow guidance | Blobless clones are "the most widely-used partial clone option"; treeless clones not recommended for daily use; "shallow fetches are the worst possible option"; shallow clones are costly for the server on later fetches | Provider guidance |
| Linux kernel clone study (≈4 GB repo, ~1M commits) | Full 5 min, shallow 1.2 min, treeless 2.4 min, blobless 3 min (average response time); server CPU full 60 s, shallow 40 s, treeless 120 s | Provider data point (large-repo upper bound) |
| Provider *API* directory reads | Contents API: 1,000 files per directory; Trees API: truncated beyond 100,000 entries or 7 MB | Evidence for rejecting Option A |

Sources: `docs/repositories/creating-and-managing-repositories/repository-limits`, `rest/using-the-rest-api/rate-limits-for-the-rest-api`,
`rest/using-the-rest-api/best-practices-for-using-the-rest-api`, `webhooks/using-webhooks/best-practices-for-using-webhooks`, `apps/.../generating-an-installation-access-token-for-a-github-app`,
and the github.blog articles *Get up to speed with partial clone and shallow clone* and *Git clone: a data-driven study on cloning behaviors* (both December 2020).
docs.github.com itself was unreachable from the research environment; the quotes were taken from the `github/docs` and `github/rest-api-description` source repositories, which are the pages' own text.
**Using Git transport instead of the REST API does not remove provider limits**: the per-repository Git recommendations above, push policies, webhook semantics and the token endpoints all remain.

### 1.2 Git facts measured locally (git 2.54.0, throwaway repositories, no remote contacted)

| Fact [F] | Result |
|---|---|
| Blobless clone contents | All commits **and all historical trees**; no blobs (72-object test repo: 3 commits, 6 trees, 63 blobs missing) |
| Treeless (`tree:0`) | Commits only |
| Lazy fetch | One `fetch` / `upload-pack` process **per missing object**: `cat-file --batch` over 10 missing blobs spawned 10 fetches |
| Bulk prefetch | `git fetch --no-tags --filter=blob:none origin <20 oids>` fetched all in **1** upload-pack (requires the server to allow fetching by object id: **not confirmed for GitHub**, spike S1) |
| Sparse checkout | Affects the working tree only. Without a filter, `clone --sparse` still downloaded all 72 objects |
| Shallow | Pushing a commit whose parent is the shallow boundary to a full-history remote is accepted; repeated `fetch --depth=1` stays at depth 1 |
| Plumbing commits | `hash-object -w`, `mktree`, `commit-tree`, `update-ref` work in a bare clone; `push <sha>:refs/heads/x` works; a stale base is rejected `(fetch first)`; `--atomic` and `--force-with-lease=ref:sha` behave as documented |
| Filters | `hash-object --stdin` applies no filters unless `--path` is given; `mktree`/`commit-tree` apply none. `update-ref` **does run the `reference-transaction` hook**: hooks must be disabled (`core.hooksPath=/dev/null` disables them) |
| `ls-remote origin <ref>` | Sent **no** `ref-prefix`; cost scales with the repository's ref count. A refspec `fetch` does send `ref-prefix` for that ref |
| Tree size | **43 bytes per entry** (flat `<12 hex>.md`): 430,000 B at 10k, 4,300,000 B at 100k issues. Thin pack for a one-file change: **272 B at 10k, 392 B at 100k**. `ls-tree` of the 100k tree: 0.05 s. On-disk after `gc`: 3.1 MB (10k), 19 MB (100k) |

### 1.3 Workload and sizing assumptions [A]

| Symbol | Meaning | Value used |
|---|---|---|
| s | raw bytes per issue file | 1.5 KB |
| k | in-memory parsed size / raw | 3 (so 4.5 KB per issue) |
| I | issues per repository | 200 typical; 5,000 large; 50,000 extreme |
| R | repositories connected | scenario-dependent |
| U | concurrent (active) users | scenario-dependent |
| h | hot repositories per active user | 1 |
| ρ | reads per active user per second | 0.2 |
| ω | writes per active user per second | 0.01 |
| T_push, T_fetch | push / incremental fetch latency to GitHub | 0.3-1.0 s, 0.2-0.6 s |
| T_cold | cold start, typical repo / huge-tree repo | 1-5 s / 30 s to minutes |
| c_cold | cold starts one node runs concurrently | 8 |
| Node | 8 vCPU, 32 GB RAM, 500 GB NVMe | |
| webhook rate | pushes per repository per day | 20 on average; peak 10x |

## 2. Resource model

- **Memory (hot snapshots):** `M = H · I · s · k`, with H hot repositories. Example: 1,000 hot repos × 200 issues × 4.5 KB = **0.9 GB**; one repo of 10,000 issues = 45 MB. Add per-connection overhead for SSE (tens of KB each [A]) and per-process overhead for Git subprocesses (tens of MB peak each [A], bounded by the concurrency caps).
- **Disk (repository caches):** `D ≈ R_cached · (c0 + T_tip + I · s_c)`; c0 ≈ 0.2 MB [A] (bare repo, refs, commits), T_tip = size of the tip commit's trees (0.1 MB for a small repo, 5-50 MB for 10^5-10^6 files [E: ≈ 43 bytes per entry before compression]), s_c ≈ 0.6 KB compressed issue [A]. Typical repo ≈ 1-3 MB; 10,000 cached typical repos ≈ 10-30 GB. Disk is a **soft limit** because eviction is free (the cache is disposable): undersizing converts into cold starts, not failure.
- **CPU:** the expensive operations are (in order) cold-start pack indexing/`fetch` of large tree sets, `mktree` over huge directories (O(entries)), parsing YAML for the first snapshot load (O(issues)), and `git push` process spawn plus TLS. Warm reads are assembly over memory: roughly 1 ms per 1,000 issues [A] plus response serialisation.
- **Network:** cold start = T_tip + `.gitboard` blobs; incremental fetch = new commits and trees on the path to changed files (small); push = commit + 3 trees as a thin pack (hundreds of bytes [F]). Network cost is dominated by cold starts of large-tree repositories, not by writes.

## 3. Read path

| Quantity | Behaviour |
|---|---|
| Warm read | No provider traffic if tip verified within `T_fresh`; CPU ∝ I (assembly) and response size ∝ I × bytes returned |
| Response size | **Today a board response includes every issue body** ([A. current](01-current-architecture.md), item 13): ~1.5 MB per 1,000 issues, 15 MB at 10,000 [E]. A summary projection is a prerequisite for large boards [R] |
| First load after change | Incremental: `diff-tree` old→new, re-read and re-parse changed blobs only; O(changes) |
| First load after cold start | O(I) blob reads (must be **bulk prefetched**; unbatched lazy fetch is one process per blob [F]) |
| Freshness | Bounded by `T_fresh` and the webhook path; labelled in responses |
| Cross-repo aggregation | k repositories ⇒ k snapshots; any cold one costs T_cold. Needs caps and partial results (OQ-12) |

Read latency scales **linearly in issues per repo** for board assembly and is **independent of the number of repositories** once warm; it scales with repository count only through the cold-start rate (below).

## 4. Write throughput and contention

**4.1 One branch.** Let W writers submit simultaneously against one tip.

- Naive parallel preparation + push + retry: attempts `W(W+1)/2` (W=10 → 55, W=100 → **5,050**), each a provider push. Incompatible with 6 pushes/min/repo [F].
- Queue + group commit: pushes `= ⌈W / B⌉` per burst for batch size B (≈ 1 for W ≤ B_max); cycle time `max(T_push, 60 s / 6)` when the governor is active. For W = 100 the burst is one batch: ~100 ms CPU [E] + 1 push. Under *sustained* load the latency is bounded by the governor interval: **about 10 s per cycle at 6 pushes/min [E]**; ops/s is limited only by batch CPU.
- **Latency floor:** one fetch-if-stale + one push: 0.3-1.5 s [A].
- **Hard long-run limit: history growth.** About 0.4-1 KB of pack data per commit [E, from measured 272-392 B thin packs]. One op/s sustained = 86,400 commits/day ≈ 35-85 MB/day ≈ 13-31 GB/year on one branch, beyond the 5-10 GB recommendation within months. Squashing large batches into one commit (ADR *Concurrent writes*) reduces it by the batch factor; the dedicated board branch/repository isolates it [R].

**4.2 Across repositories.** Aggregate write throughput = Σ over repositories of their governed rates, limited by node CPU for push (spawn + TLS, ≈ 30-50 ms CPU each [A] ⇒ ≈ 150-250 pushes/s per 8-vCPU node [E]) and by whatever GitHub tolerates in aggregate (undocumented; spike S3).

**4.3 Provider content-creation limits** (80/min, 500/h) apply to REST content creation, **not** to Git pushes [A: unverified; the docs describe them in terms of API requests], which is a major reason Option A is rejected: each issue write through the Contents API would consume that quota per user/installation.

## 5. Storage details

### 5.1 Capacity

`D` formula in §2. Per-node disk 500 GB ⇒ ≈ 100,000-300,000 typical cached repos or ≈ 2,000-10,000 repos with 10^5-file trees [E]. Idle expiry (30 min [A]) means disk tracks the *recently used* set.

### 5.2 Git object sizes

See §1.2. Flat-directory issue trees: 430 KB / 4.3 MB at 10k / 100k issues. The provider recommends ≤ 3,000 entries per directory, which this layout exceeds beyond 3,000 issues ([OQ-7](05-open-questions.md#oq-7-flat-issue-directory-at-scale-p1-irreversible-later)). Server-side repacking keeps the repository growth to deltas; client pushes are thin packs.

## 6. Synchronisation load

- **Webhook ingress:** `λ_wh = R · pushes_per_repo_per_day / 86,400`. 100,000 repos × 20/day = **23/s average, ~230/s peak [E]**: signature check + map update; trivial on a few edge instances.
- **Work caused:** only for hot repos: `λ_fetch ≈ H · fraction_of_pushes_touching_.gitboard_or_unknown`. With a complete path list in the payload the fraction is small; truncated or unknown pushes force a fetch. Provider limit to respect: 15 Git read operations per second **per repository** [F]; a single repo with a burst of pushes is coalesced by single-flight, so it stays below that.
- **Reconciler (hot repos only):** `λ_probe = H_unhealthy / I_fast + H_healthy / I_slow`. With H = 10,000, I_slow = 600 s, I_fast = 60 s and 5% of repos with unhealthy webhooks: 17 + 8 = **≈ 25 probes/s [E]** across the fleet (each a one-ref fetch). Cold repos cost nothing.
- **Lost webhooks:** no redelivery by the provider [F]; correctness from read-time probes and the reconciler; bound = `T_fresh` or I_slow.

## 7. Authentication and token limits (provider-imposed)

- Authorisation checks use the **user's own token**, so REST load lands on per-user quota (5,000/h each [F]), at ≤ 1 check/min per (user, repo) with a 60 s cache ≈ 60/h/user [E]: not a shared bottleneck.
- **User-token refresh vs the OAuth token-request limit.** User tokens live 8 h [F]; 2,000 OAuth token requests/hour per app [F]. Steady state `U_active / 8 h` refreshes per hour: 10,000 active users ⇒ 1,250/h (63% of the limit before login bursts); the limit saturates at **≈ 16,000 distinct active users per token window per GitHub App** [E, assuming refreshes and logins count against it; interpretation unconfirmed]. This is a **provider hard limit that horizontal scaling of nodes does not move**; mitigations: refresh lazily, use installation tokens for reads where authorisation can be derived otherwise, and shard tenants across several GitHub Apps (a deployment-level change, so decide before launch).
- Installation tokens: 1 h lifetime; one per installation per hour: 20,000 installations ⇒ 5.6/s [E], cached per node.

## 8. Dimension-by-dimension limits

| Dimension | Behaviour near the limit | Kind of limit |
|---|---|---|
| **Users (concurrent)** | Bound by SSE connections per node (≈ 5,000-10,000 per Node process [A]) and CPU for reads (≈ 200-500 reads/s per core for typical boards [A]); scales with nodes. Hard bound ≈ 16k active users per GitHub App from token refresh (§7) | Infrastructure (scalable) + **provider hard limit** |
| **Repositories** | Cost ∝ *active* repositories (memory, cache, probes); idle repositories cost only metadata. Cold-start rate bounds how fast users can roam | Infrastructure (scalable); cold start = architectural |
| **Issues per repo** | Snapshot memory 4.5 KB/issue; first load O(I); board payload O(I × body); tree size 43 B/issue; GitHub recommends ≤ 3,000 files per directory | Architectural (format) beyond ~3k; payload needs API change |
| **Reads** | ∝ I when warm; no provider traffic; per-node CPU | Infrastructure (scalable) |
| **Writes** | Per repo: governed pushes (6/min recommended) ⇒ latency not throughput; per node: push spawn CPU; long-run: history growth | **Provider recommendation** + architectural (per-branch) |
| **Concurrency (many users, one branch)** | Group commit: latency ≈ governor interval; same-field edits last-writer-wins without preconditions | Architectural |
| **Git transport** | Provider: 15 read ops/s and 6 pushes/min per repo (recommended), 2 GB push, 100 MB object, protection/push-protection policies; undocumented aggregate throttling | **Provider-imposed**; spike S3 |
| **Storage** | Disk soft limit through eviction | Infrastructure (scalable) |
| **CPU** | Cold-start index-pack and large-directory `mktree` dominate; parse on first load | Infrastructure (scalable) |
| **Memory** | `H · I · 4.5 KB`; LRU by bytes | Infrastructure (scalable) |
| **Network** | Cold starts of large-tree repos; writes negligible | Infrastructure; large trees = architectural |
| **Synchronisation** | Webhooks scale horizontally; work ∝ hot repos; probes ∝ hot repos / interval | Scalable; delivery loss = provider semantics |
| **Cold starts** | T_cold from ~1 s (small) to minutes (kernel-sized, [F] 1.2-5 min for full/shallow/blobless, Linux study) | Architectural for huge repos (needs board branch or pre-warm) |
| **Failures** | See §10 | Mixed |

## 9. Scenarios

Assumes the defaults of §1.3. Node = 8 vCPU / 32 GB / 500 GB.

| # | Scenario | Offered load [E] | Resources [E] | Likely bottleneck | Needed changes |
|---|---|---|---|---|---|
| 1 | 100 repos, 10 users | 2 reads/s, 0.1 writes/s; ≤ 10 hot repos | ~0.1 GB RAM, ~0.3 GB disk | None. First touch of each repo pays T_cold | One node. Nothing to scale |
| 2 | 1,000 repos, 100 users | 20 reads/s, 1 write/s over ≤ 100 repos (≪ 6 pushes/min each); webhooks 0.23/s | ≤ 0.1-0.9 GB RAM, 1-3 GB disk | None | One node plus a second for availability. No database, no bus |
| 3 | 10,000 repos, 1,000 users | 200 reads/s (~1 core), 10 writes/s; webhooks 2.3/s avg; probes ≈ 2.5/s; ≤ 1,000 hot repos, 1,000 SSE connections | ≈ 0.9 GB hot snapshots; ≤ 30 GB disk if never evicted | Cold-start rate when users roam; first-load parse; provider tolerance for clone rate | 2-3 nodes (capacity + HA), rendezvous routing at the edge, per-tenant concurrency caps, metrics. Metadata store only if audit/quotas are required |
| 4 | 100,000 repos, 10,000 users | 2,000 reads/s, 100 writes/s; webhooks 23/s avg (230 peak), probes ≈ 25/s; ≤ 10,000 hot repos; 10,000 SSE connections; cold starts ≈ 5.6/s if each user touches 2 new repos/hour | ≈ 9 GB hot snapshots + overhead; disk 30-60 GB with eviction (300 GB if everything were kept); cold-start concurrency ≈ 17 | **Provider-side**: refresh limit (1,250/h of 2,000/h), aggregate clone/fetch tolerance (undocumented), per-installation REST for discovery. **Cold-start storm** after node loss | 8-16 nodes; metadata store (audit, quotas, token storage) very likely; sharding tenants over GitHub Apps; pre-warming; admission control and load shedding; consider SSE termination off the engines (OQ-11) |
| 5 | One repo, 100 concurrent writers | Burst of 100 simultaneous ops, or sustained ~1-10 ops/s | Negligible CPU (~0.1 s per batch of 100) | **The push**: 6/min recommended ⇒ ~10 s cycle ⇒ p50 write latency ≈ 5-10 s under sustained load; history growth 35-85 MB/day at 1 op/s | Group commit + governor (ADR), squash large batches, optimistic UI, dedicated board branch/repo for heavy boards. Naive design: 5,050 attempts |
| 6 | Burst of writes across many repos (e.g., 10,000 writes in 10 s over 5,000 repos) | ≈ 1,000 writes/s offered | Each repo's own push; per-node ≈ 150-250 pushes/s [E] | Node push CPU; **aggregate Git write tolerance of the provider (unknown)**; token endpoints | Admission control and per-tenant fairness, bounded queue depth, `429/503 Retry-After` (no write-behind exists), jittered retries; spike S3 to learn provider behaviour |
| 7 | Large repo, long history, small `.gitboard/` | Cold start only: trees of the tip (≈ 43 B per file before compression: 50 MB at 10^6 files [E]) plus, for blobless **non-shallow**, all historical trees | Disk per cache up to hundreds of MB (blobless full history) | **Cold start time**: Linux-size repo (4 GB) took 1.2-5 min on GitHub for shallow/full/blobless [F]. Repeated *shallow fetches* are discouraged by GitHub [F] | Dedicated board branch (OQ-1 Option 3: cold start ≈ 1 s), "preparing repository" state with background warm-up on installation, pin cache (no eviction), one-shot shallow fallback with re-creation instead of incremental shallow fetch, per-tenant limits on cache size |

## 10. Failure modes

| Failure | Effect | Behaviour | Bound |
|---|---|---|---|
| Provider outage / Git 5xx | Fetch and push fail | Reads: warm cache labelled stale; writes 503 + `Retry-After`; no write-behind (durability rule) | Staleness grows until recovery; no data loss |
| Provider throttling of Git traffic | Slow or failing fetch/push | Governor and single-flight reduce load; jittered backoff; per-installation circuit breaker | Unknown threshold (S3) |
| Worker crash before push | Request unacknowledged | Client retries with idempotency key; nothing durable | None lost |
| Crash after push, before reply | Write durable, caller unaware | Retry finds `Gitboard-Op` trailer, returns original outcome | Exactly-once effect |
| Crash mid-cold-start | Partial cache directory | Directory discarded on restart (no partial cache is served) | One cold start |
| Node loss | Its repos re-homed | Cold starts on new owners; single-flight and cold-start caps absorb the storm: λ_cold · T_cold concurrent starts must stay below `nodes · c_cold` | Recovery time ≈ R_hot · T_cold / (nodes · c_cold): 10,000 hot repos, 5 s, 10 nodes × 8 ⇒ ≈ 10 min of degraded latency [E] |
| Webhook loss | Delayed freshness | Read-time probe and reconciler | `T_fresh` or I_slow |
| Push rejected (protection, push protection, signing) | Write fails, nothing durable | Distinct error with provider message | Policy-dependent (OQ-1, OQ-4) |
| Disk full | Cache writes fail | Eviction before high-water mark; refuse new cold starts at hard mark | Soft |
| Poisoned repository | CPU/RAM/disk abuse | Sandboxed subprocess with limits; quarantine | Per-tenant caps |

## 11. Summary: practical limits and what moves them

**Scales with nodes (horizontal):** concurrent users, repositories (active set), reads, aggregate writes across repositories, webhook ingress, SSE connections, disk.

**Does not scale with nodes:** the push rate of a single repository branch (6/min recommended [F]); the provider's per-installation REST quotas (auxiliary only); the OAuth token-request limit (≈ 16,000 active users per GitHub App window [E]); cold-start time of a given huge repository; history growth of a single hot branch.

**Requires architectural change if reached:** flat issue directory beyond ~3,000 entries (format v2); board payload including bodies (API projection); very large-tree repositories (dedicated board branch); sustained > ~1 write/s on one board (squash, dedicated repo).

**Honest bottom line [R].** The design is sound to roughly the 10^4-repository / 10^3-user scale on a handful of nodes using only Git and memory. At 10^5 repositories / 10^4 users it still works on the same principles, but three things stop being optional: a metadata store, tenant sharding across GitHub Apps, and measured provider-tolerance data (S3, S5). The single-repository ceiling is **latency, not throughput**, and it is set by the provider's documented push recommendation, not by GitBoard.
