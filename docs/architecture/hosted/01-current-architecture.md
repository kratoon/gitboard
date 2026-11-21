# A. Current architecture assessment

Part of [FEAT-8c2e32c](README.md). Status: analysis, 2026-11-21. Based on `main` at `83749cc`. Still valid under the self-hosted direction ([07](07-self-hosted-architecture.md)); the "refactoring" row about a storage seam is no longer required.

Evidence labels used in all documents of this set: **[F]** verified fact (code or official documentation), **[A]** assumption,
**[E]** estimate derived from stated assumptions, **[R]** recommendation.

## 1. How Gitboard works today

```
 coding agents ──▶ CLI (src/cli) ───────┐
                                         ▼
                              core (src/core): operations ──▶ services ──▶ storage ──▶ .gitboard/*.md   (working tree)
                                         ▲                                      └────▶ ~/.config/gitboard/repos.json
 React UI ──▶ HTTP server (src/server) ──┘                                      └────▶ git (execFile): status, clone, rev-parse
        ▲                                    chokidar watcher ── SSE ◀──────────────────┘
        └─ GitboardClient (src/web/client.ts)
```

| Layer | Location | What it does |
|---|---|---|
| Operation registry | `src/core/operations.ts` | 30 operations, each declared once with a Zod input schema, scope (`global`, `repo`, `repo-uninitialized`), `readOnly`, surfaces (`cli`, `http`) and handler. `executeOperation` (`:318`) is the single entry point for CLI and HTTP. |
| Services | `src/core/issues/service.ts`, `src/core/projects/*.ts`, `src/core/validation/validate.ts` | Business rules: board/backlog assembly, references, ranking, columns, projects, validation. |
| Issue store | `src/core/issues/store.ts`, `parse.ts` | Parse frontmatter + body (`parse.ts`), validate with Zod, minimal-diff patching with the `yaml` Document API, exclusive create with random ids. Pure text-in/text-out except for calls into `storage`. |
| Storage | `src/core/storage/*` | **The only code that touches the filesystem** (ESLint-enforced, `eslint.config.js`). `repo-files.ts` reads/writes `.gitboard/`, `fs-safe.ts` does atomic writes, `watch.ts` wraps chokidar, `git.ts` runs `git` without a shell. |
| Repo registry | `src/core/repos/registry.ts` | User-level `repos.json` (path, name, `local`/`remote`), repo resolution (explicit selector, then cwd, then default), SSH clone. |
| Adapters | `src/cli/*`, `src/server/*` | CLI binds flags to operation schemas; the server mounts operations at `POST /api/repos/:repo/ops/:name` and pushes SSE at `GET /api/repos/:repo/events`. |
| UI | `src/web/*` | React, talks to the backend only through `GitboardClient` (`call`, `subscribe`). |

## 2. Verification of the assumptions in the brief

| Assumption in the brief | Verdict | Evidence |
|---|---|---|
| Runs locally | **Confirmed** | Server binds `127.0.0.1` only and rejects any other `Host` (`src/server/security.ts:15-27`). |
| CLI performs the business operations | **Partly**: the *core* does, and CLI and HTTP are equal adapters over it | `README.md` Architecture; ADR-9b13ab6; parity test `tests/parity.test.ts`. |
| Stores issues and project data as Markdown under `.gitboard/` | **Confirmed**, with a correction: issue files are Markdown, but project definitions, columns and views live in **`.gitboard/config.yaml`** (or `config.json`), one file per repository | `src/core/storage/repo-files.ts:49-52`, `src/core/projects/config.ts`. |
| Uses file watchers to detect changes | **Confirmed** (chokidar, depth 2, content-hash de-duplication, 75 ms debounce) | `src/core/storage/watch.ts`. Watches the working tree, so it also sees `git checkout`/`pull` effects. |
| Supports local repositories | **Confirmed**; also clones **SSH** remotes into `~/.gitboard/repos/` | `registry.ts:95-135`; `assertSshUrl` rejects every non-SSH scheme (`remote.ts:20-30`). |
| **Uses Git to version and synchronize issue data** | **Not true today** | Gitboard **never commits, pushes, pulls, fetches or merges** (ADR-7027c6a, `README.md` "Git workflow"). Git is used only for `status`, `rev-parse`, `symbolic-ref` and the initial `clone` (`src/core/storage/git.ts`, `repos/git-status.ts`, `registry.ts`). Versioning and sync are done by the *user* with ordinary Git. |
| Short, non-sequential identifiers | **Confirmed** | 12 hex chars from `randomBytes(6)`, also the filename (`issues/id.ts`); display refs use the shortest unique prefix, minimum 7 (`shortPrefixLengths`). Creation is collision-safe via exclusive create (`createFileExclusive`). |

**The one correction that matters for the hosted design:** the local product has *no write path to Git*. The hosted product must add one
(commit, fetch, push), which reverses a stated MVP rule ("never commits or pushes", ADR-7027c6a). That ADR scopes the rule to the MVP
and already names "writes that become commits or pull requests" as the hosted requirement, so this is an extension, not a contradiction,
but it needs its own decision record (ADR *Write path*, below) and an amendment note on ADR-7027c6a when accepted.

## 3. Facts about the current implementation that drive the hosted design

1. **Every operation scans the whole repository.** `snapshot()` (`issues/service.ts:53`) loads the config and calls `loadIssues`, which
   reads and parses *every* `.gitboard/issues/*.md` (`readAllIssueFiles`, batches of 32, `repo-files.ts:179`). That includes
   `issue.get`, `issue.update`, `issue.move` and `issue.check`, which need one file plus a rank neighbourhood. Cost is O(N) file reads and YAML parses
   per call, with no cache. Fine on a local SSD for hundreds of issues; the dominant cost in a hosted setting.
2. **Several operations write more than one file, sequentially and non-atomically.** `moveIssue` re-ranks a column when neighbours cannot be
   separated (`service.ts:477`), `deleteIssue --unlink-children` edits every child then deletes (`:494-495`), `changeColumns` writes the
   config then remaps issues (`config.ts:355`). Locally a crash mid-way leaves a partial state. A Git commit is atomic, so a hosted
   write path improves on this, but only if core can collect the writes into one unit.
3. **Concurrency control is optimistic and hash-based.** `saveChanges` compares `expectedHash` (`sha256(content)[0..16]`, `fs-safe.ts:15`)
   and throws `CONFLICT`. The web app sends `expectedHash` for drawer and backlog edits (`IssueDrawer.tsx:82`, `App.tsx:200`) and the drawer
   already detects external changes. The check is read-then-rename (a TOCTOU window), acceptable locally and replaced by the push in a Git design.
   Updates are **minimal patches** (`parse.ts` `applyChanges`): only changed keys are written, so re-applying an operation to a newer
   file merges disjoint field edits for free. This is the property the hosted conflict strategy builds on.
4. **Uniqueness of ids is enforced by the filesystem** (`wx`/hard-link create). On a remote there is no exclusive create; collisions are
   detected only at push (a rejected non-fast-forward, then re-check). With 48 random bits the collision probability is negligible, and
   `DUPLICATE_ID` would be reported by `validate`, but the hosted path must re-run the existence check after every rebase onto a new tip.
5. **Branch scoping is implicit.** "Board state is per branch" because the working tree is whatever is checked out (ADR-7027c6a). A hosted
   service has no checked-out branch, so the *board branch* becomes an explicit setting (open question OQ-1).
6. **Identity of repositories is a local path.** The registry maps an id to a filesystem path; `resolveRepo` also walks up from `cwd`
   (`registry.ts:176-231`). `registeredOnly` already exists for the HTTP server and shows the intended seam: the server only operates on
   registered ids, never on request-supplied paths.
7. **No users, no authentication, no authorization.** The security model is "loopback only" (ADR-b9d4018): Host/Origin checks, JSON-only
   POSTs, no CORS. None of it generalises; it must be replaced, not extended.
8. **Real-time is watcher-driven and per process.** `server/index.ts:81-100` keeps one chokidar watcher per repo root and fan-outs to SSE
   streams in the same process. The event payload carries file paths but the client ignores them and refetches (`client.ts`
   `subscribe(repoId, onChange)`), so the *contract* is already "something changed, re-query". That contract carries over unchanged.
9. **Ambient process state.** `userDirs()` reads `GITBOARD_HOME`/`XDG_CONFIG_HOME`/`HOME`; `runGit` copies `process.env`; `runtime()` is a
   module-level mutable singleton (clock and RNG, `core/runtime.ts`). The singleton is harmless for production (defaults), but `setRuntime`
   is global state and must not be used by a multi-tenant process.
10. **Git is invoked via the system `git` binary** on purpose (ADR-9d88632 rejected libgit2/isomorphic-git to reuse the user's SSH
    config). In a hosted setting that reason disappears (credentials are tokens, not the user's SSH agent), but the system `git`
    remains the most complete and best-tested implementation of partial clone, protocol v2 and push.
11. **Format details that a non-filesystem implementation must reproduce:** `.gitboard/.gitattributes` forces `* text eol=lf`; the parser
    preserves CRLF if present; files may have a BOM; unknown frontmatter keys are preserved; files whose names are not `<12 hex>.md` are
    reported as problems. All of this lives in `parse.ts`/`store.ts` and is independent of where the bytes come from.
12. **Flat layout.** All issues live in a single directory `.gitboard/issues/` and "stay flat" (ADR-30abf7d). Tree-object size therefore grows
    linearly with the issue count (see [scalability](03-scalability-and-limits.md)). Changing this later is a format change and is hard to reverse.
13. **Board and backlog responses carry everything.** `boardFor` maps every card through `toIssue`, which includes the full Markdown `body`, checklist and hash (`service.ts:225-229`, `toIssue`). A board response is therefore O(total body bytes), not O(cards): about 1.5 MB per 1,000 issues at an assumed 1.5 KB per issue, 15 MB at 10,000. Fine on loopback; a hosted API needs a summary projection (without bodies) and per-issue fetch. This is an API change, not a storage one.
14. **No Git-provider concept** exists: no provider type, no token handling, no webhooks. GitHub is mentioned only as an example SSH URL.

## 4. What can stay, be reused, be refactored, or must be built

| Category | Components |
|---|---|
| **Unchanged** (format and rules, used by the CLI forever and by the hosted API as-is) | Issue and config formats; `types.ts` Zod schemas (also the web-safe contract); `parse.ts` (split, patch, serialise, checklist); `issues/id.ts`, `rank.ts` (fractional ranking, implicit keys: *rank needs no neighbour writes*, which is exactly what keeps concurrent moves cheap); `validation/validate.ts`; `errors.ts` (error table maps to CLI exit codes and HTTP statuses, `CONFLICT`=5/409); the CLI; the operation registry's schemas and parity tests. |
| **Reusable** (works if given bytes instead of paths) | `parseIssueText`, `applyChanges`, `serializeNewIssue`, `columns.ts`, `views.ts`, all of `service.ts` *above* the storage calls (board/backlog assembly, refs, placement), `parseConfigFile`/`serializeConfig`, `contentHash`. The web UI (`src/web`) with a different `GitboardClient`. |
| **Needs refactoring** | (1) **Storage seam**: `store.ts` and `config.ts` call concrete functions of `repo-files.ts` with `Repo = { root: string }`. These need to go through an interface that offers *read a snapshot*, *stage writes*, *commit as one unit* (see ADR *Storage seam*). The seam is already a single module, which is why this is a contained change; ADR-7027c6a deliberately postponed the interface "until hosting is planned". (2) `service.ts` write operations must stage rather than write immediately, so that multi-file operations become one commit. (3) `snapshot()` must be able to reuse a parsed, immutable snapshot instead of rescanning. (4) `executeOperation` resolves repos through `resolveRepo` (registry + paths); it needs a hosted resolver that yields a repository handle from `(tenant, provider repo id, branch)`. (5) The `GitboardClient.subscribe` contract should carry an optional revision so reconnecting clients can skip a refetch. |
| **Replaced or kept local-only** | `registry.ts` (local paths, `repos.json`), `registry-file.ts`, `userdirs.ts`, SSH-only `remote.ts`, `git-status.ts` (working-tree dirty state is meaningless without a working tree), `watch.ts` (replaced by webhook/fetch-driven revision events), `server/security.ts` (loopback model), `skills/*` (agent skill installer, CLI-only). |
| **New for hosted operation** | Authentication and sessions; GitHub App integration (installation discovery, short-lived tokens, webhook endpoint); repository cache manager (bare partial clones, leases, eviction); Git read engine (tree/blob reads, snapshot cache keyed by tree id); Git write engine (plumbing commits, compare-and-swap push, batching); sync service (webhook intake, fetch scheduling, reconciliation); event distribution (SSE); request routing by repository; sandboxing and resource limits; observability. |

## 5. Constraints inherited from existing accepted ADRs

| ADR | Constraint for hosting |
|---|---|
| ADR-30abf7d | Flat layout, random hex ids, passthrough of unknown keys. Hosted writes must not normalise or reformat anything the CLI would not. |
| ADR-7a20520 | Minimal writes and byte-preserving patches. This is the foundation of field-level merge on retry. |
| ADR-9b13ab6 | One implementation of business logic; CLI and server are thin adapters; parity tests. A hosted adapter must not fork business rules. |
| ADR-7027c6a | Storage confined to `core/storage`; web only via `GitboardClient`; core reads no ambient state outside resolver. **Never commits** (MVP rule, to be extended for hosted mode). |
| ADR-b9d4018 | Loopback security model, `execFile` without a shell, hooks disabled for clones. The *git hardening* part carries over; the *network* part does not. |
| ADR-9d88632 | Registry is per user and machine specific; SSH clones; system `git`. |
| ADR-9b39f45 | Cross-platform. The hosted server targets Linux only; the CLI stays cross-platform. Any shared code must remain portable. |

The three "hosting readiness" constraints of ADR-7027c6a were kept: filesystem access is in `core/storage` (lint-enforced), the web app
talks only through `GitboardClient`, and core reads ambient state only in the resolver, git runner and `userDirs`. Verified by reading
the code; `core/runtime.ts` is the one global singleton noted above.
