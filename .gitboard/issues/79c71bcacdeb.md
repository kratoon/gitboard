---
id: 79c71bcacdeb
title: Tenancy, credentials and sandboxing model for hosted Gitboard
status: rejected
project: ADR
type: story
labels: []
createdAt: 2026-11-21T17:20:12.819Z
updatedAt: 2026-11-21T17:53:38.052Z
---

> **Rejected 2026-11-21 (never accepted); replaced by ADR-87400e0.** Not rejected on technical merit: the requirements changed to a self-hosted, multi-user server for any Git remote (docs/architecture/hosted/07-self-hosted-architecture.md). This text is kept as the analysis of the provider-hosted (SaaS) variant; references to other ADRs in this text point to proposals of that variant.

- **Date:** 2026-11-21
- **Related:** FEAT-8c2e32c, ADR-b9d4018, ADR-9d88632, ADR-b33c5a6, ADR-0495ea1, ADR-6f6fd0c, ADR-82e7ef1
- **Documents:** docs/architecture/hosted/04-security-and-tenancy.md

## Context

Hosted GitBoard processes private repositories of many tenants on shared machines, runs `git` against attacker-influenced content, holds provider credentials, and must stop serving users whose access was revoked.
The local security model (ADR-b9d4018: loopback, Host/Origin checks, no authentication) does not generalise; its Git-hardening part does.

## Decision

1. **Identity and provider model: a GitHub App** (not an OAuth app, not personal access tokens, not deploy keys). Users sign in with the App's user-to-server OAuth flow; repositories come from App installations. Rationale: fine-grained repository permissions, short-lived tokens, per-installation scoping, App-level webhooks, bypass-actor support.
2. **Credentials are short-lived and narrowly scoped.** Installation tokens (1 h) are minted per installation, restricted to the single repository and the minimum permissions (`contents` read for sync/reads; write only where OQ-2 requires), held in memory only, never written to disk, never placed in a URL that is logged, and passed to `git` through a credential helper/`GIT_ASKPASS`-style channel rather than the command line. User tokens (8 h) and refresh tokens (6 months) live in an encrypted session cookie or encrypted store (OQ-5). The App private key and webhook secret are held in a secret manager and used only by the minting/ingress code.
3. **Authorisation is re-evaluated, never assumed.** Every request is authorised against the provider's view (user token) with a short TTL cache (default 60 s) and webhook-driven invalidation; if the provider cannot confirm access, deny. Writes are authorised on every call. SSE streams re-check on the same schedule.
4. **Tenant isolation.** Cache directories and snapshot caches are keyed by tenant-qualified repository identity; directories are mode 0700 owned by an unprivileged per-tenant uid; no shared object stores (alternates) across tenants; snapshot cache entries carry their tenant and are never served without a fresh authorisation decision.
5. **Sandboxed Git execution.** Each `git` subprocess runs as the tenant uid with: generated minimal configuration (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `core.hooksPath=/dev/null`, protocols restricted to https, `transfer.fsckObjects=true`, `fetch.recurseSubmodules=no`, `transfer.bundleURI=false`, no credential helpers other than ours, `GIT_TERMINAL_PROMPT=0`), a clean environment, no network except the provider hosts, rlimits and cgroup limits (CPU time, memory, processes, file size, open files, disk quota), and a wall-clock timeout. The repository's own config is never used (it is not transferred by clone/fetch).
6. **No untrusted checkout.** Per ADR-0495ea1: bare repositories only; no working tree, no submodule handling, no filters, no LFS, no archive. Issue content is only parsed as text by core (the existing Zod/`yaml` parsing with size limits).
7. **Resource limits for untrusted repositories:** maximum fetch size and object count, maximum tree entries in `.gitboard/`, maximum issue size (the provider already blocks 100 MB objects; we enforce far smaller limits for `.gitboard` files), maximum issues per snapshot, parse time budget, per-tenant concurrency caps; repeated breaches quarantine the repository.
8. **Revocation and cleanup.** On `installation.deleted`, `installation_repositories.removed`, access-check failure or user removal: invalidate authz entries, close SSE streams, delete the cache directory and evict snapshots, purge credentials. Logs and metrics must not contain issue content or tokens.
9. **Git version policy:** the server tracks Git security releases and is patched promptly; a minimum Git version is enforced at startup.
10. The local-only controls (loopback binding, Host allow-list) remain for the local server and are not reused for hosted mode, which gets standard TLS, secure cookies (SameSite, HttpOnly), CSRF defence for cookie-authenticated POSTs and a strict CSP.

## Alternatives considered

- **OAuth app with broad `repo` scope:** one token reaches every repository the user can; not revocable per repository; rejected.
- **Personal access tokens / deploy keys supplied by users:** long-lived, hard to rotate and audit; rejected as primary (could be a self-hosted option).
- **Installation token for all writes (OQ-2 option b):** simpler, but GitBoard becomes responsible for authorisation and the token reaches every repository of the installation (`contents` is not documented as path-scoped); kept as an option.
- **Per-tenant containers/microVMs:** strongest isolation, higher cost; reserved for dedicated tenants (OQ-8).
- **Authorise once at connection time:** rejected; access changes.

## Rationale

The largest risks are cross-tenant data exposure, credential theft and code execution from hostile repository content. The design removes the third class structurally (no checkout), narrows the second by scope and lifetime, and addresses the first by key-scoped caches and re-checked authorisation.

## Consequences

- Operating a secrets manager, uid-per-tenant sandboxing and a Git patch process is a prerequisite for multi-tenant launch.
- Credential passing to `git` needs care (no argv, no logs).
- Per-request authorisation adds provider calls on the user's own quota (about one per minute per user and repository [E]).

## Scalability implications

Sandboxing adds per-process cost (to be measured, S6) and caps concurrency per tenant; authorisation caching keeps provider traffic proportional to active (user, repo) pairs. The OAuth token-request limit (2,000/h per App) bounds active users per App (about 16,000 [E]) and may force tenant sharding across Apps (scalability document §7).

## Open questions

- OQ-2 push credential; OQ-8 isolation level; OQ-9 revocation window; OQ-15 retention; whether to support self-hosted/GHES.

