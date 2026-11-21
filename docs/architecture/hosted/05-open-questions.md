# E. Open questions and unresolved decisions

> **Partly superseded (2026-11-21).** OQ-2, OQ-5, OQ-8, OQ-9, OQ-10, OQ-11 and OQ-15 are replaced by the self-hosted questions SH-1..SH-12 in [07](07-self-hosted-architecture.md#8-revised-open-questions-supersede-oq-2-oq-5-oq-8-oq-9-oq-10-oq-11-oq-15-oq-1-oq-4-oq-6-oq-7-oq-12-oq-13-oq-14-still-apply). OQ-1, OQ-4, OQ-6, OQ-7, OQ-12, OQ-13 and OQ-14 still apply.

Part of [FEAT-8c2e32c](README.md). Ordered by priority. **Blocking** = must be resolved before the phase named in *Needed by*
(see [roadmap](06-roadmap.md)). Labels: **[F]** fact, **[A]** assumption, **[R]** recommendation.

| ID | Question | Priority | Needed by |
|---|---|---|---|
| OQ-1 | Which branch does the hosted board use, and what happens on protected branches? | P0 | Phase 3 (design now) |
| OQ-2 | Whose credential pushes: the user's token or the app's installation token? | P0 | Phase 3 |
| OQ-3 | Do we introduce a transactional storage seam in core now? | P0 | Phase 1 |
| OQ-4 | Repositories that require signed commits or block App pushes: supported how? | P0 | Phase 3 |
| OQ-5 | Is a database needed for v1? | P1 | Phase 2 |
| OQ-6 | Commit granularity, message format and CI noise on the code branch | P1 | Phase 3 |
| OQ-7 | Flat `.gitboard/issues/` beyond 3,000 issues (GitHub's recommended directory maximum): keep or shard? (format change) | P1 | before GA, decide at Phase 0 |
| OQ-8 | Isolation level for untrusted repositories on shared nodes | P1 | Phase 4 |
| OQ-9 | Authorisation freshness (revocation window) | P1 | Phase 2 |
| OQ-10 | Provider abstraction: when and how thin? | P2 | Phase 2 (shape), Phase 5 (second provider) |
| OQ-11 | Event distribution once API and repo engines are separate processes | P2 | Phase 5 |
| OQ-12 | Cross-repository views and search: when does a derived index become justified? | P2 | Phase 5 |
| OQ-13 | Local-first interplay: CLI users and hosted users on the same repo | P2 | Phase 3 |
| OQ-14 | `repo.init` and repository onboarding in hosted mode | P2 | Phase 2 |
| OQ-15 | Cache and data retention after uninstall/revocation | P1 | Phase 2 |

---

## OQ-1. Board branch and protected branches (P0, blocking)

- **Question.** Locally "board state is per branch" because it is whatever is checked out (ADR-7027c6a). A hosted service must pick the
  branch whose `.gitboard/` it reads and writes, and decide what to do when direct pushes to that branch are not allowed.
- **Why it matters.** It determines whether writes are possible at all on the most common team setup (protected default branch, required
  reviews, required status checks), the commit noise on the code branch, CI cost, and the shape of the concurrency problem (all writers
  on one branch). It is hard to change later because it defines where users' data lives.
- **Options.**
  1. *Default branch, direct push.* Simple; matches "issues travel with code" and the CLI mental model. Fails on protected branches unless the app is a bypass actor. Every issue edit is a commit on the code branch and may trigger CI.
  2. *Configurable `boardBranch`* (key in `.gitboard/config.yaml`; older CLIs ignore it because `RepoConfigSchema` is `passthrough`). Same as 1 by default; teams can point at a dedicated branch.
  3. *Dedicated orphan branch* containing only `.gitboard/`. Tiny history, fast cold start for any repo size, no CI/CODEOWNERS interaction, trivial protection rules. Breaks "board versioned with the code", and the CLI's working-tree model reads the checked-out branch, so local users would need a worktree or a second clone to see it.
  4. *PR mode*: write to a short-lived branch and open or update a PR. Works with protection and review rules; not "durable" until merged (conflicts with the durability requirement unless defined as "persisted to the remote").
- **Trade-offs.** 1/2 are simplest and exactly what local users see; 3 is operationally best for scale and large repositories; 4 is the only
  option for strictly protected branches but changes the product's semantics (edits become proposals).
- **Recommendation [R].** Option 2: default branch, direct push, `boardBranch` configurable, with a clear `PUSH_REJECTED` error that names the
  protection rule. Treat Option 3 as a supported *configuration* (validated in a spike, S4) rather than a different architecture, since the engine is
  identical. Defer Option 4 to Phase 5 and define its durability semantics separately ("accepted by the remote" = branch updated).

## OQ-2. Which credential pushes? (P0, blocking)

- **Question.** After a user authorises the GitHub App, writes can be pushed with (a) the user-to-server token or (b) the app's
  installation token.
- **Why it matters.** Authorisation, audit trail, branch-protection behaviour and blast radius all follow from it.
- **Options.** (a) GitHub itself enforces the user's real permission and protection rules; commits show the user; tokens expire (hours),
  so refresh tokens must be held. (b) Simple, no per-user token plumbing; but GitBoard must implement authorisation itself, needs bypass rights
  for protected branches, and the installation token grants `contents: write` on **every** repo of the installation (GitHub permissions are not path-scoped), so a bug is a wider breach.
- **Recommendation [R].** (a) for writes triggered by users, (b) only for reads, webhook-driven sync and background work (scoped to the
  single repository via the token-creation `repositories` parameter). Author = the user (GitHub noreply address), committer = the app,
  with `Gitboard-Actor` trailer. Needs a small encrypted credential store (cookie or table) for refresh tokens, which feeds OQ-5.

## OQ-3. Transactional storage seam in core (P0, blocking)

- **Question.** ADR-7027c6a postponed a storage interface "until hosting is planned". Hosting is now planned. What exactly do we introduce?
- **Why it matters.** It is the one change inside the existing code base; everything else is additive. It must keep the CLI/HTTP parity tests byte-identical and must not leak Git into core.
- **Options.** (1) Do nothing in core; build a separate hosted implementation of every service (duplicates business rules, violates ADR-9b13ab6). (2) A `RepoSnapshot` read interface plus `RepoTransaction` write interface (staged writes, one commit), with the filesystem implementation behind them. (3) Make core operate on an in-memory file map and let adapters load/flush it (smallest interface, but forces loading everything for every op).
- **Recommendation [R].** Option 2, designed so reads are lazy (`readIssue(id)` does not load everything) and so a snapshot can be reused across requests. Do it in Phase 1 as a pure refactor with no behaviour change.

## OQ-4. Signed commits and App-push restrictions (P0, blocking for the write path)

- **Question.** Some repositories require signed commits, or restrict who may push, via rulesets. A raw `git push` of an unsigned commit by the App may be rejected.
- **Why it matters.** It can make Option B impossible for those repositories; the only workaround is provider APIs that create verified commits on the App's behalf, which reintroduces provider-specific paths and quotas for a subset of repos.
- **Options.** (1) Declare such repositories unsupported for writes (read-only), clearly surfaced. (2) Sign commits with a key the provider trusts (viable only if the provider supports bot signing keys; **[A]** not confirmed, spike S4). (3) Per-repo fallback write path via the provider's Git-data/Contents API, used only when the push is rejected for signature reasons.
- **Recommendation [R].** Start with (1) plus detection and a precise error; evaluate (3) as a bounded, per-repo exception (it does not make Option A the primary path and its quota exposure is limited to those repos). Do not build until S4 shows how common the case is.

## OQ-5. Database for v1? (P1)

- **Question.** Do we need any database at launch?
- **Options.** (1) None: encrypted session cookies, tenancy derived from GitHub (installation and repository listings cached in memory), webhook handling idempotent, idempotency via commit trailers. (2) Small relational store for sessions, installations, refresh tokens, audit log, quotas.
- **Trade-offs.** (1) removes an operational dependency and any temptation to store issue data; limits cross-node state (global rate limiting, dedupe, audit retention, billing). (2) is conventional and cheap but must stay strictly *metadata*.
- **Recommendation [R].** Start with (1) for Phases 2-3. Introduce (2) at the first requirement that cannot be met statelessly (audit log retention, per-tenant quotas, refresh-token storage if cookies prove too large). This must not be decided implicitly: see ADR *Database-free issue storage*.

## OQ-6. Commit granularity, message format, CI noise (P1)

- **Question.** One commit per operation or one per batch? What message and trailers? How do we avoid triggering code CI on every issue move?
- **Options.** Per-operation commits inside a batch (attribution, simple revert); one squashed commit per batch (fewer commits, loses authorship); `[skip ci]`-style markers; path filters on the customer's CI side.
- **Recommendation [R].** Per-operation commits, conventional message `chore(board): <op> <ref>` with trailers `Gitboard-Op`, `Gitboard-Actor`, and a configurable skip-CI marker (off by default; CI path filters are the customer's tool). Document the CI implication in onboarding. Needed before beta.

## OQ-7. Flat issue directory at scale (P1, irreversible later)

- **Question.** ADR-30abf7d fixes a flat `.gitboard/issues/`. Is that acceptable at thousands of issues?
- **Why it matters.** (1) GitHub's repository-limits page lists **3,000 entries per directory** as a recommended maximum, so a flat directory exceeds a provider recommendation beyond 3,000 issues [F]. (2) Tree objects cost 43 bytes per entry [F, measured]: 430 KB at 10k, 4.3 MB at 100k issues, read at every cold start and rebuilt on every write; pushes stay tiny (thin pack 272-392 bytes measured) because Git deltas the tree. (3) The Contents API lists at most 1,000 files per directory and the Trees API truncates at 100,000 entries / 7 MB [F, GitHub REST docs], which matters only for provider-API access (Option A) but also for other tools users run on the repository. Sharding (`issues/ab/<id>.md`) changes the format, breaks old CLIs and complicates merges.
- **Options.** Keep flat; shard by id prefix in a `version: 2` format with readers that accept both; per-project subdirectories.
- **Recommendation [R].** Keep flat for now, but treat 3,000 issues per repository as the **decision trigger** and design a reader-compatible v2 sharded layout during Phase 0/1 (the storage seam makes the layout an implementation detail of one module). Measure in spike S2 before choosing a layout. Because this is a format decision, it must be settled before general availability.

## OQ-8. Isolation level for untrusted repositories (P1)

- **Question.** Run Git subprocesses for different tenants in the same container, in per-process sandboxes, or in per-tenant microVMs/containers?
- **Why it matters.** Repository content is attacker-controlled. Our design avoids checkouts, which removes the worst class, but fetch/pack parsing/oversized objects remain.
- **Options.** (1) Dedicated unprivileged uid per tenant + namespaces/seccomp/rlimits/cgroups per git process, tenant cache directories mode 0700. (2) One container or microVM per tenant, pooled. (3) Dedicated nodes for large/regulated tenants.
- **Recommendation [R].** (1) as the baseline, (3) as the commercial escape hatch; (2) only if the threat model demands it. See [security](04-security-and-tenancy.md).

## OQ-9. Authorisation freshness (P1)

- **Question.** After a user loses repository access, how quickly must GitBoard stop serving them?
- **Options.** Check on every request (user token REST call; per-user quota, extra latency); cache with TTL (30-120 s); push-based invalidation from `member`, `installation_repositories` webhooks plus TTL as backstop.
- **Recommendation [R].** TTL 60 s with webhook invalidation, no stale-while-error: if the provider cannot confirm access, deny. SSE connections re-check on the same schedule. Write-through checks on every write (writes already talk to the provider).

## OQ-10. Provider abstraction (P2)

- **Question.** How general should the provider interface be before there is a second provider?
- **Recommendation [R].** A four-method internal interface: `authenticate/refresh`, `listAccessibleRepos`, `checkPermission(user, repo)`, `parseWebhook`, plus `gitCredentials(repo)`. Everything else is plain Git over HTTPS. Do not generalise the data path (it is already provider-independent). Implement GitHub only; write a short "what GitLab/Bitbucket/GHES need" note before Phase 5.

## OQ-11. Event distribution across processes (P2)

- **Question.** In-process SSE fan-out is enough while the API and repo engine share a process. When they separate, how do events reach the node holding the browser connection?
- **Options.** Route SSE connections to the owner node too (no bus); lightweight pub/sub (Redis/NATS/Postgres NOTIFY); poll the owner.
- **Recommendation [R].** Keep SSE on the owner node (routing already hashes by repo). Introduce a bus only when API frontends terminate SSE; events are idempotent revision hints, so at-most-once delivery is sufficient.

## OQ-12. Cross-repository views and search (P2)

- **Question.** "My issues across 200 repositories" and full-text search over bodies.
- **Why it matters.** It is the first feature that forces touching many repos per request, i.e. many cold starts, and the obvious pressure to introduce a database.
- **Recommendation [R].** Ship per-repo views first. For aggregation, fan out to owner nodes with hard caps (repos per request, time budget, partial results labelled), reading only warm snapshots by default. If product requires global search/aggregation, add a **derived, rebuildable index** built from snapshots (conditions in the ADR), never a second source of truth.

## OQ-13. Hosted and local users on one repository (P2)

- **Question.** The CLI never pulls or pushes. A developer with local edits and the hosted app on the same branch will create divergence.
- **Recommendation [R].** Nothing special in the engine (Git semantics already handle it: the developer's push is non-fast-forward and they rebase/merge as usual). Add UX: the hosted app's commits are small and per-issue, so merge conflicts are rare and localised; document `git pull --rebase` before pushing `.gitboard/` changes. Conflict-prone files remain `config.yaml` and a card's `rank`.

## OQ-14. Onboarding and `repo.init` (P2)

- **Question.** `repo.add` (path or SSH URL) and `repo.init` have no hosted meaning. How does a repository become a GitBoard repository?
- **Recommendation [R].** Repositories appear from the GitHub App installation; "enable GitBoard" performs `repo.init` as a commit on the board branch (new write operation through the same write path). `repo.add/remove/default` stay CLI-only (`surfaces: ['cli']`).

## OQ-15. Retention after revocation (P1)

- **Question.** What exactly is deleted, and when, if the app is uninstalled or a repo is removed from the installation?
- **Recommendation [R].** On `installation.deleted` / `installation_repositories.removed`: immediate lease invalidation, cache directory deletion, snapshot eviction, SSE close; credentials purged; no copy of repository data survives outside the node cache (logs must not contain issue content). Verified by a test in the Phase 4 revocation drill.
