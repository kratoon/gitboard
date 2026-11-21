# Hosted Gitboard: architecture analysis and proposed decisions

Tracked under **FEAT-8c2e32c** (Hosted / multi-user readiness). Date: 2026-11-21. Status: **analysis and proposals; nothing here is accepted or implemented.**

> **Requirements changed on 2026-11-21: self-hosted (NAS first), multi-user, any Git remote, clones and worktrees acceptable, per-user settings in a versioned profile.** The current direction is [07 Self-hosted architecture](07-self-hosted-architecture.md). Documents 02-04 and 06 are kept as the analysis of the provider-hosted (SaaS) variant and are superseded where they conflict with 07. Document 01 is unchanged and still valid.

Scope (original brief): evaluate the existing code base, challenge the preferred hosted architecture (*stateless API + Git workers + ephemeral workspaces + shared object
caching + webhook sync*), quantify limits, and propose decision records. No application code was changed.

## Documents

| | Document | Contents |
|---|---|---|
| A | [01 Current architecture](01-current-architecture.md) | How Gitboard works today, verification of the brief's assumptions, reuse/refactor/replace/new |
| B | [02 Proposed architecture](02-proposed-architecture.md) | Component diagram, responsibilities, five sequence diagrams, interfaces, failure behaviour |
| C | [03 Scalability and limits](03-scalability-and-limits.md) | Provider and Git facts with sources, formulas, seven scenarios, limit classification, failure modes |
| - | [04 Security and tenancy](04-security-and-tenancy.md) | Threat model, credential models, isolation, revocation |
| E | [05 Open questions](05-open-questions.md) | 15 prioritised questions with options and recommendations |
| F | [06 Roadmap](06-roadmap.md) | Phases 0-5, dependencies, risks, validation milestones |
| G | [07 Self-hosted architecture](07-self-hosted-architecture.md) | **Current direction.** Self-hosted multi-user design, per-user profile, security, NAS resource model, scenarios, revised questions and roadmap |
| D | Decision records | Below. Stored as issues in the `ADR` project, per this repository's convention (README "Architecture decisions") |

Evidence labels: **[F]** fact (code, official docs, or measured locally), **[A]** assumption, **[E]** estimate from assumptions, **[R]** recommendation.

## Decision records

All are `proposed` or `rejected`; none is accepted. The requirement change of 2026-11-21 replaced the provider-hosted ADRs.

**Current direction (self-hosted):**

| Ref | Decision | Status |
|---|---|---|
| ADR-819be48 | Hosted Gitboard is a self-hostable server for any Git remote | proposed |
| ADR-0aa6b23 | Per-user managed clones; operations commit and push through the existing core | proposed |
| ADR-fe71de9 | Remote changes are fetched by adaptive polling, with webhooks optional | proposed |
| ADR-87400e0 | Accounts, sessions and per-user Git credentials for self-hosting | proposed |
| ADR-7d58e8b | Versioned per-user profile and the split of settings between repository, user and instance | proposed |
| ADR-7955eb5 | Git remains the only authoritative store in hosted mode (requirement) | proposed, amended |
| ADR-099d4df | No database for issue data; derived indexes admitted only under stated conditions | proposed, amended |
| ADR-3f39a2f | Real-time browser updates use SSE with idempotent revision hints | proposed, amended |
| ADR-dc3a07e | Tree-keyed snapshot cache (now an optional later optimisation) | proposed, amended |

**Rejected, never accepted (requirements changed; analysis of the provider-hosted SaaS variant, kept for reference):** ADR-b33c5a6 (Git transport vs provider APIs), ADR-0495ea1 (bare caches), ADR-6f6fd0c (plumbing CAS writes), ADR-db6547a (coalescing and semantic retry; the retry idea survives in ADR-0aa6b23), ADR-82e7ef1 (webhook-first sync), ADR-375920a (rendezvous sharding), ADR-79c71bc (GitHub App tenancy), ADR-9eb2543 (storage seam).

```bash
gitboard issue list --project ADR --status proposed
gitboard issue show ADR-819be48
```

## Headline findings (original analysis; items 3-4 and 8 are specific to the provider-hosted variant)

1. **The local product has no Git write path.** Gitboard never commits, pushes, pulls or fetches (ADR-7027c6a); the brief's "uses Git to version and synchronize" is true only through the user. The hosted write path is new and extends that ADR for hosted mode.
2. **The seam already exists.** All filesystem access is in `core/storage`; operations are text patches with minimal diffs; hash-based optimistic concurrency exists. The needed core change is one interface (snapshot reads plus transactional writes), done first, locally, under the parity tests.
3. **Worktrees are the wrong abstraction.** Nothing needs checked-out files. Reading from Git objects and building commits with plumbing in a *bare* cache avoids checkout cost, locking, pools, and the largest security surface (untrusted checkouts). Verified locally: plumbing commits push and are rejected as non-fast-forward when stale.
4. **Parallel workspaces do not help; the push is the serialisation point.** GitHub documents **6 pushes per minute per repository** as the recommended maximum. Naive parallel retry costs W(W+1)/2 push attempts (5,050 for 100 writers). Group commit through a per-branch queue turns a hot branch into a *latency* limit (about 10 s cycles) instead of a throughput collapse.
5. **Git transport does not escape provider limits.** The per-repository read/push recommendations, push policies (protection, push protection, possibly signing), webhook semantics (no redelivery, 3-day retention) and the **2,000 OAuth token requests/hour per GitHub App** (about 16,000 active users per App) remain. The last one does not scale with nodes.
6. **Details that change the baseline:** lazy fetch spawns one fetch per missing blob (bulk prefetch by object id is required and unverified on GitHub); `git ls-remote <ref>` is not a cheap probe; GitHub advises against repeated shallow fetches; GitHub recommends at most **3,000 entries per directory**, which the flat issue layout exceeds beyond 3,000 issues; sustained writes on one branch grow the repository past recommended size within months unless commits are squashed or a dedicated board branch is used.
7. **A board response today includes every issue body**, O(total text); hosted needs a summary projection.
8. **Simplest scalable shape:** one node type sharded by repository (rendezvous hashing), in-memory snapshots keyed by the `.gitboard` tree id, SSE hints, webhooks as hints with demand-driven fetch, no database until a non-issue requirement forces one.

## What must be decided first

Under the self-hosted direction: **SH-1** clone layout, **SH-3** per-user credentials, **SH-6** board branch / protected branches (OQ-1), **SH-5** the settings split, then the Phase 0 spikes in [07 §9](07-self-hosted-architecture.md#9-revised-roadmap) on real NAS hardware.

## Not done (by instruction)

No application code changed, no dependencies installed, no commits or pushes. The new files (`docs/architecture/hosted/`, 17 ADR issues under `.gitboard/issues/`, and the updated FEAT-8c2e32c body) are uncommitted in the working tree.
