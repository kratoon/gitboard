# Open Questions

Tracks decisions that are not yet made, grouped by when they must be settled. When a question is resolved, set
its status to `Resolved`, record the answer, link the ADR that captures it (an issue in the `ADR` project:
create or amend one), and move the entry to the **Resolved** section. Don't delete entries, so the history
stays readable.

**Status values:** `Open` (must be settled for the MVP) | `Deferred` (post-MVP, not blocking) | `Resolved`

## Open: needed for the MVP

_None._

## Deferred: post-MVP

| ID | Question | Revisit |
|---|---|---|
| [OQ-015](#oq-015) | Hosted / multi-user readiness | post-MVP |

## Resolved

| ID | Question | Recorded in |
|---|---|---|
| [OQ-013](#oq-013) | Migrate ADRs into Gitboard as project `ADR` | `ADR` project in `.gitboard/` |
| [OQ-011](#oq-011) | Epic status and progress: stored or derived? | ADR-0010 |
| [OQ-001](#oq-001) | Intra-column card ordering | ADR-0006 |
| [OQ-002](#oq-002) | Keep `updatedAt` in frontmatter? | ADR-0003, ADR-0004 |
| [OQ-003](#oq-003) | Default skill install target | ADR-0007 |
| [OQ-004](#oq-004) | Frontend decoupling via `GitboardClient` | ADR-0012 |
| [OQ-005](#oq-005) | npm package name / scope | ADR-0001 |
| [OQ-006](#oq-006) | Terminology: repository vs. project | ADR-0009 |
| [OQ-007](#oq-007) | Is `project` required on every issue? | ADR-0009 |
| [OQ-008](#oq-008) | Issue reference format | ADR-0009 |
| [OQ-009](#oq-009) | Board columns: per repo or per project? | ADR-0011 |
| [OQ-010](#oq-010) | How are epics represented? | ADR-0010 |
| [OQ-012](#oq-012) | Issue `type` field and `parent` rules | ADR-0010 |
| [OQ-014](#oq-014) | Git workflow for edits: branches, commits, branch protection | ADR-0012 |


---

# Deferred entries

---

## OQ-015
**Hosted / multi-user readiness**

- **Position:** The MVP is a personal, local application. Hosting (for example on Heroku) and multiple
  users are explicitly not supported, and they are more than a deployment change. A hosted version would need
  authentication and per-repo authorization, a Git provider integration (for example a GitHub App) in place of
  local SSH credentials, a storage layer that does not use a local filesystem (Heroku's disk is ephemeral),
  and writes that become commits or pull requests instead of working-tree edits.
- **What carries over:** the core operations and schema, the CLI, the web UI, and the validation rules.
- **Design constraints to keep the option open, at no extra cost:**
  - All filesystem access stays inside `core/storage` and nowhere else in core, so a different storage
    backend can replace it later.
  - The web app talks to the backend only through the `GitboardClient` (OQ-004).
  - Core does not read ambient process state (cwd, env) outside the project resolver.
  - Do not add a storage interface or user model until a hosted version is actually planned.
- **Multi-user with local installs already works through Git:** each person runs Gitboard locally and merges
  with Git. Random IDs keep issue creation conflict-free. Shared files that can still conflict are
  `config.json` and a card's `rank`.
- **Status:** Deferred
- **Decision / date:** 2026-11-14. Deferred. The three design constraints above are accepted (ADR-0012). Hosting itself is out of scope for the MVP.

---

# Resolved entries

## OQ-013
**Migrate ADRs into Gitboard as project `ADR`**

- **Intent:** Track our decisions in Gitboard itself (dogfooding).
- **Status:** Resolved
- **Decision / date:** 2026-11-14. The ADRs moved from `docs/decisions/` into the `ADR` project of this
  repository's `.gitboard/`, using only the CLI. Each is an issue titled `ADR-00NN: ...`; the status is the
  column (`proposed`, `accepted`, `superseded`, `rejected`, a project-level column override per ADR-0011);
  sibling links became plain `ADR-00NN` references. The template and the index file were dropped (the
  `ADR` board is the index; the template is described in the README). Open questions stay in this file.

---

## OQ-011
**Epic status and progress: stored or derived?**

- **Question:** Should an epic's progress (for example 3 of 5 stories done) and its status be stored in its
  frontmatter or derived from its stories?
- **Recommendation:** Progress is always derived by core, never stored, so it cannot drift or conflict on
  merge. The epic keeps its own explicit `status` for planning, with no automatic transitions in the MVP.
  Epics appear in the UI as a swimlane or filter, not as cards in the status columns (see OQ-012).
- **Status:** Resolved
- **Decision / date:** 2026-11-14. Epic progress is always derived by core and never stored. An epic keeps its own explicit `status` with no automatic transitions. Recorded in ADR-0010.

---

## OQ-005
**npm package name / scope**

- **Question:** Is `gitboard` available on npm, or should we publish as a scoped package (for example
  `@kratoon/gitboard`)? The executable stays `gitboard` either way.
- **Action:** Check availability (`npm view gitboard`) before M0 finalises `package.json`.
- **Status:** Resolved
- **Decision / date:** 2026-11-14. The unscoped name `gitboard` is available on npm and will be used. The executable is `gitboard`. Recorded in ADR-0001.

---

## OQ-004
**Frontend decoupling via `GitboardClient`**

- **Question:** Add a small `GitboardClient` interface in the web app, with a single HTTP implementation, to
  keep a future GitHub Pages data provider possible without building a real abstraction layer?
- **Recommendation:** Yes (about 30 lines, no speculative generality).
- **Status:** Resolved
- **Decision / date:** 2026-11-14. Accepted: a small `GitboardClient` interface in the web app with a single HTTP implementation. Recorded in ADR-0012.

---

## OQ-003
**Default skill install target**

- **Question:** Should `gitboard skills install` write only `.agents/skills/gitboard/` by default (agents
  must opt in with `--target claude`), or write `.agents` plus `.claude` so Claude Code works out of the box?
- **Note:** Claude Code is understood to read only `.claude/skills` today. This is to be verified in M5.
- **Recommendation:** Default to `.agents/skills/` as specified, and print a hint when Claude Code is
  detected. Revisit after verifying agent discovery paths.
- **Research (2026-11-14):** Claude Code reads only `.claude/skills/`. GitHub Copilot reads `.agents/skills/`, `.claude/skills/` and `.github/skills/`. The `npx skills` CLI keeps a canonical copy in `.agents/skills/<name>` and links agent-specific dirs to it.
- **Status:** Resolved
- **Decision / date:** 2026-11-14. Default install writes the canonical skill to `.agents/skills/gitboard/` and links `.claude/skills/gitboard/` to it. An optional `--agent` flag selects targets, modelled on `npx skills add`. Recorded in ADR-0007.

---

## OQ-002
**Keep `updatedAt` in frontmatter?**

- **Question:** `updatedAt` changes on every edit, which makes diffs noisier and can conflict when merging.
  Keep it as in the sample, make it optional, or drop it and rely on `git log`?
- **Recommendation:** Keep it (matches the spec sample), but only touch it when content actually changes.
  Consider making it optional in the schema.
- **Status:** Resolved
- **Decision / date:** 2026-11-14. Keep `updatedAt`. Gitboard sets it only when the issue's content actually changes (never on a no-op write). The schema treats it as optional, so hand-written issues without it are valid, and Gitboard adds it on the next real change. Recorded in ADR-0003 and ADR-0004.

---

## OQ-001
**Intra-column card ordering**

- **Question:** Is sorting by priority then `createdAt` acceptable, or is manual ordering required?
- **Trade-off:** Manual ordering needs a fractional-index `rank` frontmatter field. Each drag rewrites a file
  and adjacent drags on different branches conflict on merge.
- **Recommendation:** No stored ordering in the MVP. Add optional `rank` later if wanted.
- **Status:** Resolved
- **Decision / date:** 2026-11-14. Manual ordering is supported through an optional `rank` field. Recorded in ADR-0006.

---

## OQ-006
**Terminology: repository vs. project**

- **Question:** Registered Git repos become "repository" (`gitboard repo ...`) and issue groups become
  "project" with a key (Jira vocabulary). Alternatively, keep "project" for repos and pick another word for
  groups (e.g. "group", "epic", "board").
- **Recommendation:** repo = repository, group = project (ADR-0009).
- **Status:** Resolved
- **Decision / date:** 2026-11-14. Registered Git repos are "repositories" (`gitboard repo ...`). A group of
  stories is a "project" identified by a key. Recorded in ADR-0009.

---

## OQ-007
**Is `project` required on every issue?**

- **Question:** Must every issue carry `project: KEY`, or may it be omitted (unassigned)?
- **Trade-off:** Required keeps the model uniform, with `init` creating a default project (named after the
  repo, or a placeholder such as `MAIN`). Optional is lighter for tiny repos but adds an "unassigned" case to
  every filter and view.
- **Recommendation:** Required, with a default project created by `init`. Existing and hand-written issues
  without a key fail `validate` with a clear fix hint.
- **Status:** Resolved
- **Decision / date:** 2026-11-14. `project` is required on every issue, and `init` creates a default project. `parent` stays optional (ADR-0010). Recorded in ADR-0009.

---

## OQ-008
**Issue reference format**

- **Question:** How do humans and agents refer to an issue? Options: bare short ID (`a3f91c2`),
  `KEY-shortid` (`AUTH-a3f91c2`), or the full 12-hex ID only.
- **Recommendation:** Accept all three as CLI input. Display `KEY-<shortest unique prefix, min 7>`. The key is
  only for display and filtering, and the ID stays the identity. If the key in a reference disagrees with the
  issue's actual project, warn but resolve by ID.
- **Status:** Resolved
- **Decision / date:** 2026-11-14. Recommendation accepted. Recorded in ADR-0009.

---

## OQ-009
**Board columns: per repo or per project?**

- **Question:** Should columns (statuses) be defined once in `.gitboard/config.json` for the whole repo, or may
  each project override them?
- **Recommendation:** Repo-level only in the MVP. Per-project override is a non-breaking later addition.
- **Note (2026-11-14):** migrating ADRs into Gitboard (OQ-013) would need ADR-specific statuses, which
  strengthens the case for per-project columns. Worth reconsidering before M1.
- **Status:** Resolved
- **Decision / date:** 2026-11-14. Done in the MVP, with three layers: Gitboard built-in defaults, then a repo override, then a project override that takes precedence over the repo. Recorded in ADR-0011.

---

## OQ-010
**How are epics represented?**

- **Question:** Epics are groups within a project. Should an epic be (a) an issue file with `type: epic`,
  or (b) an entry in `.gitboard/config.json` like projects?
- **Trade-off:** (a) keeps the one-file-per-item, random-ID, branch-safe model. (b) makes `config.json` a
  merge hotspot and gives epics no body or history of their own.
- **Recommendation:** (a).
- **Status:** Resolved
- **Decision / date:** 2026-11-14. An epic is an issue file with `type: epic`. The link from a child to its
  epic is a frontmatter field named **`parent`** (not `epic`). Recorded in ADR-0010.

---

## OQ-012
**Issue `type` field and `parent` rules**

- **Question:** Add `type: epic | story` to frontmatter, defaulting to `story`? Do we also want `task` or
  `bug`? The link field is now the generic name `parent`, so which issues may be a parent, and can parents
  nest (an epic under an epic, or a story under a story)?
- **Recommendation:** MVP types are `story` (default) and `epic`. Only an issue of `type: epic` may be a
  parent, and an epic cannot itself have a `parent` (one level). The field name stays generic so nesting or
  sub-tasks can be added later without a rename. `validate` flags a `parent` that is missing, is not an epic,
  or is in a different project. Deleting an epic is refused while issues reference it unless the user passes
  a flag to unlink them.
- **Status:** Resolved
- **Decision / date:** 2026-11-14. Recommendation accepted. Recorded in ADR-0010.

---

## OQ-014
**Git workflow for edits: branches, commits, branch protection**

- **Current design:** every edit (CLI, agent or UI) changes files in the working tree of the branch that is
  checked out. Gitboard never commits, pushes, pulls or merges (ADR-0003, ADR-0008). The user commits and
  merges `.gitboard/` changes like code, in the same PR as the code or in a separate one. This works with
  branch protection, because Gitboard never writes to a remote.
- **Consequence to accept:** board state is per branch. The board on `main` shows what is merged into `main`.
  An issue an agent creates on a feature branch is visible elsewhere only after that branch is merged.
- **Options:**
  - (a) MVP as designed, plus UI safeguards: show the current branch and an "uncommitted `.gitboard`
    changes" indicator in the header.
  - (b) Add an opt-in `gitboard commit` that commits only `.gitboard/` on the current branch. It never pushes,
    and it refuses to run on branches the user lists as protected in user-level config.
  - (c) A dedicated long-lived issues branch checked out as a Git worktree, so board state is independent of
    code branches. A larger design that needs its own ADR.
  - Never: auto-push to `main`.
- **Recommendation:** (a) for the MVP, (b) after the MVP if wanted. Not (c) unless per-branch boards become a
  real problem.
- **Status:** Resolved
- **Decision / date:** 2026-11-14. Option (a) for the MVP, with option (b) `gitboard commit` as an opt-in after the MVP. Auto-push is ruled out. Recorded in ADR-0012.
