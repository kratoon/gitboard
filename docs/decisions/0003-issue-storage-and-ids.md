# ADR-0003: Markdown issue storage and random hex IDs

- **Status:** Accepted (2026-11-14)
- **Date:** 2026-11-14
- **Related:** ADR-0004, OQ-002

## Context

Issues must live in Git repos, be usable without Gitboard, and be creatable on different branches without
coordination. There is no database.

## Decision

- One file per issue: `.gitboard/issues/<id>.md`, YAML frontmatter plus free Markdown body.
- **The layout is flat and stays flat.** Project, parent, status and type are frontmatter fields only. Moving
  an issue to another project, changing its parent, or changing its status never renames or relocates its
  file. No per-project or per-epic subdirectories.
- Config in `.gitboard/config.json` (schema version, columns, optional label/priority lists). No absolute
  or machine-specific paths.
- IDs: 12 lowercase hex chars from `crypto.randomBytes(6)`, used as the filename. Created with exclusive
  open (`wx`) and retried on `EEXIST` (max 8 attempts). IDs are immutable.
- `createdAt` is set once on creation. `updatedAt` is optional in the schema and is set by Gitboard only when an
  operation actually changes the issue (accepted, OQ-002). Hand-written issues without it are valid.
- Frontmatter validated by a Zod schema: strict on known keys, **passthrough on unknown keys** so user
  extensions survive writes.
- `validate` detects: filename/frontmatter ID mismatch, duplicate IDs, unknown status, malformed
  frontmatter.
- CLI accepts unique ID prefixes (as Git does). Delete requires the full ID.
- Gitboard never commits, pushes, pulls or merges.

## What lives where

| Data | Location | In Git? |
|---|---|---|
| Issues (including each issue's `status`, `project`, `parent`, `rank`) | `.gitboard/issues/<id>.md` | Yes |
| Repo configuration: project definitions (key, name), repo-level columns, project-level columns (ADR-0009, ADR-0011), optional label/priority lists, schema version | `.gitboard/config.json` | Yes |
| Line-ending rule for issue files (ADR-0013) | `.gitboard/.gitattributes` | Yes |
| Installed agent skill (ADR-0007) | `.agents/skills/gitboard/`, `.claude/skills/gitboard/` | Yes, if the user chooses to commit it |
| Registry of known repos, local paths, default repo, protected-branch list, managed clones | user-level config directory (ADR-0008, ADR-0013) | No, machine-specific |

Rule of thumb: anything that describes the *project's* work and workflow is committed and travels with the
repo. Anything that describes *this machine* stays out of the repo, and no absolute paths ever appear in
committed files.

## Alternatives considered

- **Sequential IDs (`PROJ-12`):** conflict across branches.
- **UUIDs:** longer and no benefit over 48 random bits for a personal tool.
- **Single `issues.json` or SQLite:** merge-hostile and not portable.

## Consequences

- 48 bits gives a negligible collision chance at personal scale, and `wx` makes collisions safe.
- Two branches can independently create issues with a clean merge.
- Titles are not in filenames, so files are less browsable, but IDs stay stable under rename.
