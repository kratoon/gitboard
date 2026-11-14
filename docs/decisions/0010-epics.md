# ADR-0010: Epics as groups within a project (linked via `parent`)

- **Status:** Accepted (2026-11-14)
- **Date:** 2026-11-14
- **Related:** ADR-0003, ADR-0009, OQ-010, OQ-011, OQ-012

## Context

A project (ADR-0009) groups stories. Users also need a second level, **epics**: groups of stories within a
project. The design must keep the branch-safe random ID model, stay readable as plain Markdown, and keep a
single implementation in core (ADR-0002).

## Decision

Hierarchy: **repository, project (key), epic, story.**

- An epic is an ordinary issue file, `.gitboard/issues/<id>.md`, with `type: epic`. It has a title, body,
  labels and status like any issue, and gets a random 12-hex ID like any issue.
- A child issue points to its epic with `parent: <epic id>` in frontmatter. The field is called `parent`
  rather than `epic`, so the model can later grow beyond epics without a rename. The link lives on the
  child only, so adding a story never touches the epic file and merges cleanly across branches.
- `type` is `story` (default when absent) or `epic`. An epic has a `project` and cannot itself have a
  `parent` (no nesting in the MVP, see OQ-012).
- An issue's `parent` must reference an existing issue of `type: epic` in the **same project**. `validate`
  reports violations. Changing the project of an issue that has a parent is refused unless the caller
  explicitly clears the parent.
- Epic progress (counts of children per status) is **always derived** by core and returned with the epic by
  `getIssue`. It is never stored, and an epic's own `status` is explicit, with no automatic transitions.
- Deleting an epic is refused while stories reference it, unless the caller passes an explicit unlink flag.

**Operations and CLI** (each is a registered operation, per ADR-0002)

- `gitboard issue create --type epic --project AUTH --title ...`
- `gitboard issue create --parent <id> ...` and `gitboard issue update <id> --parent <id> | --no-parent`
- `gitboard issue list --parent <id>`, `--type epic|story`, `--project KEY`
- `gitboard issue show <id>` on an epic includes its children and derived progress.
- No separate `epic` command group, so there is one code path for all issues.

**Board / UI**

- Epics are not cards in the status columns. They appear as a filter and as a grouping (swimlane) on the
  project board, with a progress bar.
- A dedicated epic panel lists epics for the selected project.

## Alternatives considered

- **Calling the link `epic`:** ties the schema to one issue type. `parent` is generic.
- **Epics in `config.json`:** a merge hotspot, with no body, status or history of their own.
- **Epic holds a list of child IDs:** every new story edits the epic file, which conflicts across branches.
- **Directory per epic:** moving a story between epics renames files and complicates ID lookup.
- **Arbitrary nested groups:** more general, but more validation and UI work than the MVP needs.

## Consequences

- A single storage mechanism (issue files) serves stories and epics, and ID generation, validation and the
  skill stay uniform.
- Adds the optional `type` and `parent` frontmatter fields, so the schema needs updating. The change is
  backward compatible.
- Listing the stories of an epic requires scanning issues. That is fine for a personal-scale repo.
