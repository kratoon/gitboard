# ADR-0007: Agent skill distribution

- **Status:** Accepted (2026-11-14)
- **Date:** 2026-11-14
- **Related:** ADR-0002, ADR-0013, OQ-003

## Context

Claude Code and GitHub Copilot should manage issues through the CLI. Agents do not discover skills inside
npm packages, and consuming repos must not need Gitboard as a dependency or be modified by `npm install`.

Discovery paths found on 2026-11-14 (to be re-verified in milestone M5, because they change quickly):

| Agent | Project path | Global path |
|---|---|---|
| Claude Code | `.claude/skills/` only | `~/.claude/skills/` |
| GitHub Copilot | `.agents/skills/`, `.claude/skills/`, `.github/skills/` | `~/.agents/skills/`, `~/.copilot/skills/`, `~/.claude/skills/` |
| Codex, Cursor, Gemini CLI and others | `.agents/skills/` | varies |

The `npx skills add` CLI (vercel-labs/skills) keeps one canonical copy in `.agents/skills/<name>` and links
each agent that needs its own directory to it. `--copy` makes independent copies instead.

## Decision

- Source of truth: `skills/gitboard/SKILL.md` in this repo, shipped in the npm package. It contains
  workflow guidance only and tells agents to use `gitboard ... --json` rather than editing issue files.
- `gitboard skills install` writes the **canonical copy to `.agents/skills/gitboard/`** and, by default, also
  provides **`.claude/skills/gitboard/`**, because Claude Code does not read `.agents/skills/`. Copilot and
  other agents that read `.agents/skills/` need nothing more.
- **Link mode** (`--mode copy|link`):
  - **Project install defaults to `copy`.** Project files are committed to Git and shared across machines.
    A committed symlink is checked out as a plain text file on Windows unless `core.symlinks` is enabled,
    so Claude Code would silently not find the skill. Real copies work everywhere. `skills sync` keeps the
    copies identical (see the manifest below).
  - **Global install (`-g`) defaults to `link`.** On POSIX it is a symlink. On Windows it is a directory
    junction, which needs no admin rights or Developer Mode. If linking fails, it falls back to `copy` and
    says so.
  - `--mode link` on a project install is available for users who accept the portability trade-off.
- Flags, modelled on `npx skills add`:
  - `-a, --agent <id...>`: choose targets (`claude-code`, `github-copilot`, `codex`, `cursor`,
    `gemini-cli`, `universal`, ...). Agents that read `.agents/skills/` need no extra directory. Without
    `--agent`, the default is `universal` plus `claude-code`.
  - `-g, --global`: install to user-level directories instead (`~/.agents/skills/gitboard/` with
    `~/.claude/skills/gitboard/` linked to it).
  - `--mode copy|link`: override the default described above.
  - `--path <dir>`: escape hatch for an agent not in the table.
  - `-y/--yes`: skip confirmation prompts. Non-interactive runs never prompt.
- The agent-to-path mapping is a data table in core, so a path change, or Claude Code adding `.agents/skills/`
  support, is a one-line edit.
- The skill folder layout (`skills/gitboard/SKILL.md`) is also compatible with `npx skills add`, so users
  can install it that way too. Gitboard's own command stays the documented path, because it also handles
  `sync`.
- Each install writes a `.gitboard-skill.json` manifest next to the canonical copy (version plus content
  hashes). `gitboard skills sync` compares installed files, manifest, and packaged files: unmodified installs
  update silently, and customised ones prompt, or fail with `SKILL_MODIFIED` non-interactively unless
  `--force`. Each copy is hashed separately, so a modified `.claude` copy is detected and not overwritten
  silently. Linked installs update with the canonical copy.
- No `postinstall` scripts, and nothing modifies a consuming repo during `npm install`.

## Alternatives considered

- **Symlinks by default for project installs:** avoids duplicate files, but breaks for Windows teammates and
  checkouts without `core.symlinks`. Available through `--mode link`.
- **`.agents/skills/` only:** generic, but Claude Code would not find it today.
- **`.claude/skills/` only:** works for Claude Code and Copilot, but is not generic for other agents.
- **Relying on npm discovery:** not supported by agents.

## Consequences

- Project installs contain two identical copies (`.agents` and `.claude`). That is a small duplication in
  exchange for working on every OS. `skills sync` prevents drift.
- Updating the skill requires running `skills sync`.
- Agent path conventions may change, and the data-driven table keeps that cheap.
