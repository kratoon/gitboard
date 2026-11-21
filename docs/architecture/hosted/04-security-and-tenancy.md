# Security and multi-tenancy analysis

> **Partly replaced (2026-11-21).** The requirements changed to a self-hosted, multi-user server for any Git remote. Where this document conflicts with [07 Self-hosted architecture](07-self-hosted-architecture.md), 07 wins. This text remains the analysis of the provider-hosted (SaaS) variant.

Part of [FEAT-8c2e32c](README.md). Status: **analysis; decisions are proposed** (ADR *Tenancy, credentials and sandboxing*).
Labels: **[F]** fact, **[A]** assumption, **[R]** recommendation. Git facts below were verified locally with git 2.54.0 or from git-scm/GitHub documentation as noted.

## 1. Threat model

Shared infrastructure processes **private repositories of different tenants**. Assets: repository contents (issues), credentials (installation tokens, user tokens, App private key, webhook secret), availability.

| Adversary | Capability | Goal |
|---|---|---|
| Malicious repository author (tenant A) | Fully controls repository content: file names, `.gitattributes`, `.gitmodules`, symlinks, huge trees/objects, crafted issue files | Code execution on a node, read tenant B's data, exhaust resources |
| Malicious or compromised tenant user | Valid session | Read/write repositories they should not; keep access after revocation |
| Network attacker / forged webhook sender | Can POST to the webhook URL | Trigger work, inject false revisions |
| Compromised node | Code execution on one node | Steal tokens and cached data of repositories on that node |
| Malicious Git server response | Only if the provider or a proxy is compromised | CVEs in fetch/clone parsing |

## 2. What the design removes structurally

| Risk | How the design handles it |
|---|---|
| Checkout-time code execution (symlink/submodule/hook tricks, e.g. CVE-2024-32002 class) | **No working tree is ever created** (bare repositories, plumbing writes). Most published Git CVEs of the last two years need a checkout, a recursive submodule clone, or a local-path clone [F: GitHub security blog posts, May 2024, Jan 2025, Jul 2025, Nov 2026]; none of those operations occur |
| Clean/smudge filters and `.gitattributes` | `hash-object --stdin` applies no filters without `--path`; `mktree` and `commit-tree` apply none [F, measured]. Reading with `cat-file --batch` applies none |
| Repository-supplied configuration | `.git/config` is **not** transferred by clone/fetch [F, measured locally: `core.sshCommand` and `core.fsmonitor` set in the source did not appear in the clone]. Our caches are created by `git init --bare` with generated config |
| Hooks | None are transferred (clone's hooks dir held only samples [F]); `update-ref` runs the `reference-transaction` hook if present [F], so hooks are disabled with `core.hooksPath=/dev/null` (verified to disable `pre-push`) |
| Submodules / LFS / archive | Not used; `fetch.recurseSubmodules=no`; `transfer.bundleURI=false` (default false) |

## 3. Residual risks and controls

1. **Fetch/pack/object parsing bugs** (e.g. the November 2026 advisories include a protocol-v2 HEAD advertisement path-traversal that needs no checkout, memory-corruption bugs in merge/patch/signature handling, and `fast-import` path issues; CVE identifiers as listed in GitHub's *Git security vulnerabilities announced* posts, **not cross-checked against git-scm release notes**).
   Controls: enforce a minimum Git version and patch promptly; do not use `merge-tree`, `apply`, `fast-import`, signature verification or `bundle` features; run `git` sandboxed as an unprivileged per-tenant uid with seccomp/namespaces, no write access outside the tenant cache directory; `transfer.fsckObjects=true` (rejects malformed objects, `.GIT` directory names and malicious `.gitmodules` [F: git-config docs]).
2. **Resource exhaustion** (huge packs, deep or wide trees, billions of tiny objects, slow-loris servers): per-process CPU/memory/file-size/process limits, wall-clock timeout, fetch size cap (abort when the pack exceeds the limit), tree-entry cap for `.gitboard/`, per-tenant concurrency and disk quotas, quarantine after repeated breaches. Provider-side limits help (push 2 GB, object 100 MB [F]) but are far above ours.
3. **Hostile issue content** (Markdown/YAML): parsed with the existing `yaml` + Zod pipeline under size limits and a time budget; never executed; rendered in the UI only through the existing sanitising renderer (`react-markdown` + `rehype-sanitize`, ADR-b9d4018). YAML anchors/aliases bombs must be bounded (parser limits, maximum file size) [R].
4. **Webhook forgery:** HMAC-SHA256 (`X-Hub-Signature-256`) verified with a constant-time compare before parsing; secret in the secret manager; payloads only produce *hints* (a forged hint can at worst cause a fetch of the real remote state) [R].
5. **Cross-tenant cache exposure:** cache path = `<root>/<tenant uid>/<provider>/<repoId>`; directories 0700; no alternates across tenants; snapshot cache entries are tagged and only returned after the authorisation check for the *requesting user*; process memory is shared per node, so a node-level compromise exposes that node's hot repositories (mitigation: smaller nodes per trust domain; dedicated nodes for sensitive tenants, OQ-8).
6. **Credential leakage:** tokens only in memory; passed to `git` via a credential helper channel (not argv, not URL, not logged); redaction in logs; short TTLs; installation tokens restricted via the `repositories` and `permissions` parameters when minted [F: up to 500 repositories per token; enterprise installation tokens cannot be scoped down]. The token format is changing (stateless format being rolled out from April 2026 [F]): never assume length or prefix.
7. **Over-broad permission:** GitHub App `contents: write` is documented per repository, with no path scoping [F, no path scoping documented]. A bug in GitBoard could therefore modify code, not just `.gitboard/`. Controls: defence in depth in the engine (the commit builder can only produce trees that differ from the tip solely under `.gitboard/`, enforced and asserted before push), user-token pushes (OQ-2) so the provider enforces the user's own rights, branch protection for code paths where used.

## 4. Authentication and authorisation

- **Sign-in:** GitHub App user-to-server OAuth; session = encrypted, HttpOnly, Secure, SameSite cookie holding the user token and refresh token (OQ-5). CSRF protection on cookie-authenticated POSTs (double-submit or `Origin` check) and `application/json` requirement (existing behaviour) carry over. The loopback `Host` checks do not.
- **Authorisation source of truth:** the provider. Check `(user, repo)` access with the user's token; cache ≤ 60 s; invalidate on `installation_repositories`, `member`, `repository` events; **deny on provider failure** (no stale-while-error). Authorise the *installation* too: a repository is served only if the App is installed on it.
- **Write authorisation:** on every write, using the credential that will push (OQ-2).
- **Revocation:** see §6.

## 5. GitHub App vs other credential models

| Model | Verdict | Reason |
|---|---|---|
| **GitHub App (user-to-server + installation tokens)** | **Recommended** | Per-repo permission, 1 h installation tokens, 8 h user tokens, scoped token creation, App-level webhooks, ruleset bypass actors [F] |
| OAuth App with `repo` scope | Rejected | User-wide broad scope, long-lived, no per-repo install control |
| Personal access tokens | Rejected as primary | User-managed, long-lived; possible for self-hosted deployments |
| Deploy keys (SSH) | Rejected | Per repository, SSH-only, not user-attributed, awkward revocation; the local product's SSH approach does not transfer |

## 6. Access revocation, cleanup, retention

- Triggers: `installation.deleted`, `installation_repositories.removed`, user token refresh failure, authorisation check failure, tenant offboarding, admin action.
- Actions (idempotent, within seconds of the trigger): invalidate authz cache entries; close SSE streams for the repo/user; delete the repository cache directory; evict snapshots and any derived index entries; purge tokens; stop reconciling the repo.
- Residual: data in provider-side logs and our own logs: logs must exclude issue bodies and tokens by construction (structured logging with an allow-list of fields) [R].
- Test: a revocation drill is a Phase 4 validation milestone ([roadmap](06-roadmap.md)).

## 7. Isolation levels (see OQ-8)

| Level | Isolation | Cost | When |
|---|---|---|---|
| Per-process sandbox, per-tenant uid, shared node | Process and filesystem separation; kernel shared | Low | Default [R] |
| Per-tenant container or microVM, pooled | Stronger kernel boundary | Medium-high (startup, memory) | Regulated tenants if threat model requires |
| Dedicated nodes | Physical separation | High | Enterprise contracts |

## 8. What is explicitly out of scope here

Billing, tenant administration UI, SSO/SAML for non-GitHub identity, data-residency, compliance certifications, and self-hosted GitHub Enterprise Server support (different token and webhook limits; needs its own note, OQ-10).
