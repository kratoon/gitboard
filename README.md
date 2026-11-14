# Gitboard

A lightweight, **Git-native, local-first** Kanban board. Issues are plain Markdown files stored in your
repositories (`.gitboard/issues/`), managed through a CLI, a local web UI and coding agents such as Claude
Code and GitHub Copilot.

- **Git-native:** issues are versioned alongside your code and stay readable without Gitboard.
- **Local-first:** no accounts, no database, no cloud. The web UI runs on `127.0.0.1`.
- **CLI-first:** everything the UI can do is a CLI command, so agents never need the UI or hand-edited files.
- **Branch-safe:** issue ids are random, so branches create issues independently without merge conflicts.
- **Single user, personal tool.** Hosting and collaboration are out of scope (see ADR-0012, [below](#architecture-decisions)).

## Install

```bash
npm install -g gitboard      # then: gitboard --help
npx gitboard --help          # or run without installing
```

Requires Node.js 20+ and `git`. Works on macOS, Linux and Windows.

## Quick start

```bash
cd my-project                      # any Git repository
gitboard init                      # creates .gitboard/ and registers the repo; safe to re-run
gitboard issue create "Implement authentication" --priority high --label backend
gitboard issue list
gitboard issue move <ref> in-progress
gitboard start                     # open the board in your browser
```

Commit the `.gitboard/` directory to share the board. Gitboard never commits, pushes, pulls or merges.

## Concepts

| Term | Meaning |
|---|---|
| **Repository** | A Git repository registered with Gitboard (`gitboard repo ...`). |
| **Project** | A group of issues inside a repository, identified by a key such as `AUTH` (like a Jira project). Every issue belongs to one. |
| **Epic** | An issue with `type: epic` that groups stories. A story links to it with `parent`. One level, same project. |
| **Status / column** | Where an issue is on the board. Defaults to `todo`, `in-progress`, `done`; overridable per repository and per project. Each column can be flagged **done** (finished work). |
| **View** | A way to look at a project's issues: `kanban` (the board) or `backlog` (open work as a list). Which views are offered is configurable per repository and per project. |
| **Reference** | `KEY-<short id>` such as `AUTH-a3f91c2`, a short id prefix, or the full 12-character id. |

## Running the web UI

```bash
gitboard start [--port 4317] [--no-open]
```

Add repositories in the UI (a local path, or an SSH URL such as `git@github.com:org/repo.git`, which is
cloned into a Gitboard-managed folder). Switch between the **Board** and the **Backlog** (open work as a list
grouped by status, with inline priority and status pickers, quick-add and drag and drop; columns flagged done are hidden
unless you tick "Show done"). The **Views** button chooses which views a project offers. The board supports drag and drop between columns and within a column,
search and filters, an epic panel with progress, an issue drawer (edit title, status, priority, labels, epic,
description and checklist; delete with confirmation), and it **refreshes live** when files change on disk, for
example when an agent runs the CLI. The header shows the current Git branch and whether `.gitboard/` has
uncommitted changes.

## Registering repositories

```bash
gitboard repo add ~/code/my-project              # a local repository
gitboard repo add git@github.com:org/repo.git    # clone (SSH) and register
gitboard repo list
gitboard repo default my-project                 # used when running outside any repo
gitboard repo remove my-project                  # registry entry only; the repo is never deleted
```

CLI commands use the repository that contains the current directory; pass `-r, --repo <name|path>` to choose
another. The registry lives in your user config directory, never in a repository (no machine-specific paths
are committed).

## CLI reference

Global options: `-r, --repo <name|path>`, `--json`, `--help`, `--version`.

| Command | Purpose |
|---|---|
| `gitboard init [--columns a,b,c] [--project-key K] [--project-name N]` | Initialise `.gitboard/` and register the repo. Idempotent: re-running changes nothing except registering the repo |
| `gitboard start [--port N] [--no-open]` | Start the local web UI |
| `gitboard repo add \| list \| remove \| default` | Manage registered repositories |
| `gitboard project create <KEY> [--name N] [--columns a,b,c]` / `list` / `update <KEY>` / `delete <KEY>` | Manage projects |
| `gitboard columns show \| set \| reset [--project KEY] [--done ids] [--remap old=new]` | Manage board columns; `--done` says which are done columns |
| `gitboard config convert [--to yaml\|json]` | Convert `.gitboard/config` between YAML (default) and JSON |
| `gitboard issue list [--project --status --label --priority --type --parent -q text]` | List and search |
| `gitboard issue show <ref>` | Show one issue (epics include children and progress) |
| `gitboard issue create [title] [--project --type --status --priority --label --parent --body --body-file --stdin]` | Create |
| `gitboard issue update <ref> [--title --status --priority --add-label --remove-label --set-labels --project --parent --no-parent --body ...]` | Update |
| `gitboard issue move <ref> [status] [--before <ref> \| --after <ref> \| --top \| --bottom]` | Change status and/or order. A status change alone ranks nothing and rewrites only that issue |
| `gitboard issue check <ref> <n> [--uncheck]` | Tick a checklist item (1-based) |
| `gitboard issue delete <id> [--yes] [--unlink-children]` | Delete (needs the full id) |
| `gitboard board [--project KEY]` | Print the board |
| `gitboard backlog [--project KEY] [--all]` | Print open work as a list grouped by status (`--all` includes the done column) |
| `gitboard views show \| set \| reset [--project KEY] [--views backlog,kanban]` | Choose which views are offered (first is the default) |
| `gitboard validate` | Check issue storage (exit code 4 on problems) |
| `gitboard status` | Git branch and uncommitted `.gitboard` changes |
| `gitboard skills install \| sync \| status` | Agent skill (see below) |

**For scripts and agents**

- `--json` prints `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message" } }`, with
  warnings in `warnings`. Nothing is written to stderr in JSON mode.
- Commands never prompt when stdin/stdout is not a terminal; missing input is an error (exit code 2).
- Exit codes: `0` success, `1` unexpected error, `2` usage or missing input, `3` not found,
  `4` validation failed, `5` conflict, `6` not inside a Gitboard repository.
- Everything is also available through the shared core, so the CLI works without the server running.

## Issue format

```markdown
---
id: a3f91c2e8b40
title: Implement authentication service
status: todo
project: AUTH
type: story
priority: high
labels:
  - backend
parent: 9b1c0de4f2a1
rank: a0
createdAt: 2026-11-14T10:00:00.000Z
updatedAt: 2026-11-14T10:00:00.000Z
---

## Description

Implement the authentication service.

## Acceptance Criteria

- [ ] Implement authentication
- [ ] Add unit tests
```

- `id`: 12 lowercase hex characters from `crypto.randomBytes(6)`; also the filename. Never changes.
- `project` is required; `type` is `story` (default) or `epic`; `parent` (optional) is an epic id in the same
  project; `rank` (optional) orders cards within a column (set only when you give a position; a move
  or reorder rewrites just the moved issue, never its neighbours); unknown keys are preserved.
- Updates edit only the changed keys (comments and formatting are kept), never rewrite unchanged files, and
  stamp `updatedAt` only when something changed (reordering cards changes `rank` only, never `updatedAt`). Line endings (LF or CRLF) are preserved.
- Repository settings live in `.gitboard/config.yaml` (YAML is the default; `config.json` is also supported, and
  a repository must have exactly one of them):

```yaml
# Settings for the whole repository; a project can override columns and views.
version: 1
columns:
  - id: backlog
  - id: doing
  - id: done
    done: true            # finished work
views: [kanban, backlog]  # the views offered; the first is the default
projects:
  - key: WEB
    name: Website
  - key: ADR
    name: Decisions
    columns:
      - id: proposed
      - id: accepted
        done: true
      - id: superseded
        done: true
      - id: rejected
        done: true
```

Columns resolve project, then repository, then the built-in `todo / in-progress / done`. An override replaces
the layer below. A column can carry `done: true` to mark finished work: the backlog hides done columns and epic
progress counts them. If no column says anything, the last one is done. Views are configured the same way with a
`views` list (`kanban`, `backlog`; the first is the default); the built-in default offers both. Your last choice
of view is remembered in the browser, not in the repository.

Updates keep the file's format, and YAML comments and layout are preserved. `gitboard config convert` switches a
repository to the other format (`--to json`, or `--to yaml` which is the default); comments do not survive a
conversion to JSON. Issues are valid, readable Markdown without Gitboard.

## Git workflow

Edits change files in the working tree of the checked-out branch and nothing else. You commit and merge
`.gitboard/` changes like code, so branch protection and pull-request workflows apply unchanged. Board state is
therefore per branch: an issue created on a feature branch appears elsewhere once that branch merges.

## Agent skill

Gitboard ships a skill (`skills/gitboard/SKILL.md`) that teaches coding agents to manage issues through the
CLI instead of editing files. Agents do not discover skills inside npm packages, so install it explicitly:

```bash
gitboard skills install             # into the current repository
gitboard skills install --global    # into your home directory, for all repositories
gitboard skills sync                # update installed copies after upgrading Gitboard
gitboard skills status
```

| Agent | Reads (project) | Reads (global) |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| GitHub Copilot | `.agents/skills/`, `.claude/skills/`, `.github/skills/` | `~/.agents/skills/`, `~/.copilot/skills/`, `~/.claude/skills/` |
| Codex, Cursor, Gemini CLI and others | `.agents/skills/` | varies |

By default the skill is installed to the shared `.agents/skills/gitboard/` plus `.claude/skills/gitboard/`
(Claude Code does not read `.agents/skills/`). Project installs are real copies so they work on every OS and
checkout; global installs are links where possible. Options: `-a, --agent <ids>` (`claude-code`,
`github-copilot`, `codex`, `cursor`, `gemini-cli`, `universal`), `--mode copy|link`, `--path <dir>`, `--force`.
Customised skill files are never overwritten without confirmation or `--force`. Installing never modifies
anything else, and nothing runs when you `npm install` Gitboard. Agent paths change quickly; they are data
in `src/core/skills/agents.ts` and were last verified on 2026-11-14.

## Security

The server binds to `127.0.0.1` only, rejects unexpected `Host` headers (DNS rebinding), cross-origin and
non-JSON writes, and only operates on registered repositories (never on paths from requests). File access is
confined to each repository's `.gitboard/` directory (symlinks and traversal are rejected). Git runs without a
shell and clone hooks are disabled. Markdown is rendered sanitised, and issue content is never executed. See
ADR-0005.

## Architecture

```
 coding agents ──▶ CLI ──────┐
                              ▼
                      shared core (all business logic) ──▶ .gitboard/*.md, config.yaml
                              ▲
 React UI ──▶ HTTP server ───┘
```

- `src/core`: the only implementation of business logic. Operations are declared once in
  `src/core/operations.ts`; the server mounts them generically and each CLI command binds flags to the same
  input schemas. `src/core/types.ts` is the only part the web app may import.
- `src/cli`, `src/server`: thin adapters (argument parsing and output; HTTP and events).
- `src/web`: React UI with no business logic; search and filters call the same core operations.
- Boundaries are enforced by ESLint (`eslint.config.js`) and by tests: every operation has a CLI command, and
  a parity test runs one scenario through core, CLI and HTTP and requires identical results and files.
- Decisions and their rationale, and the questions still being decided: see
  [Architecture decisions](#architecture-decisions).

## Architecture decisions

Gitboard tracks its own architecture decisions in Gitboard. They are issues in the `ADR` project of this
repository (stored in `.gitboard/issues/`), titled `ADR-0001: ...`, and their status is the column: `proposed`,
`accepted`, `superseded` or `rejected`.

```bash
gitboard init                                    # once per clone: registers this repo so `gitboard start` lists it
gitboard issue list --project ADR                # all decisions
gitboard issue list --project ADR -q "ADR-0012"  # find one by number, then `gitboard issue show <ref>`
gitboard board --project ADR
```

To record a new decision, create an issue with the next number and a body that follows the usual sections
(`Date` and `Related` bullets, then `## Context`, `## Decision`, `## Alternatives considered`,
`## Consequences`):

```bash
gitboard issue create "ADR-0014: Title" --project ADR --status proposed --body-file decision.md
gitboard issue move <ref> accepted      # or superseded / rejected (say which ADR replaces it in the body)
```

Reference decisions by number (`ADR-0002`) in code comments, pull requests and other ADRs.

Questions that are not decided yet are issues in the `OQ` project, with the columns `open`, `deferred` and
`resolved`. They have no numbers of their own: refer to one by its Gitboard reference (for example
`OQ-85a6d2c`). A reference never changes unless another issue's id starts with the same 7
characters, in which case Gitboard asks for more; the full id always works.

```bash
gitboard backlog --project OQ                    # unresolved questions (resolved ones are hidden; add --all)
gitboard issue create "Question title" --project OQ --status open --body-file question.md
gitboard issue move <ref> resolved               # after recording the answer in the body and, if it
                                                 # is a design decision, in an ADR
```

A question body has the bullets `Question`, `Recommendation` and `Decision / date`. When a question is
resolved, name the ADR that records the outcome in its `Decision / date` text.

## Development

```bash
npm install
npm run dev:server      # CLI + server with reload (http://127.0.0.1:4317)
npm run dev:web         # Vite dev server with hot reload, proxied to the API
npm run typecheck
npm run lint
npm test                # vitest: core, CLI, server, parity, skills
npm run build           # dist/cli.js (+ server and core) and dist/web
```

Tests isolate state with `GITBOARD_HOME` (registry) and `GITBOARD_USER_HOME` (global skills), and use an
injectable clock and id source so interfaces can be compared byte for byte.

## Packaging

The npm package is a single `gitboard` package whose `bin` is `dist/cli.js`; it contains the compiled CLI,
server and core, the built UI (`dist/web`) and `skills/`. Verify it:

```bash
npm run build
npm run check:package     # inspects `npm pack --dry-run`: required files present, sources absent
npm run verify:install    # packs, installs the tarball in a clean project and exercises the binary (needs network)
```

CI runs lint, typecheck, tests, build and the package check on Linux, macOS and Windows.

## License

Not yet specified.
