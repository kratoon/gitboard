# ADR-0004: Comment-preserving YAML and minimal writes

- **Status:** Accepted (2026-11-14)
- **Date:** 2026-11-14
- **Related:** ADR-0003

## Context

Users and agents may hand-edit issues. Gitboard must preserve existing Markdown and frontmatter formatting
when updating metadata, and must not rewrite unchanged files, which would produce noisy diffs and trigger
watchers.

## Decision

- Use the `yaml` package's Document API to patch only changed frontmatter keys. This preserves comments,
  key order and quoting.
- The Markdown body is kept byte-for-byte unless the operation explicitly changes it (body update or
  checklist toggle).
- Before writing, compare the new content to the original. If they are equal, skip the write.
- Writes go to a temp file followed by an atomic `rename`.
- Optimistic concurrency: a write fails with `CONFLICT` if the file's hash or mtime changed since it was
  read.
- `updatedAt` is kept, optional in the schema, and changes only when content actually changes (OQ-002, accepted).

## Alternatives considered

- **`gray-matter` / `js-yaml` re-serialize:** loses comments and reorders keys.
- **Regex edits on frontmatter:** fragile.

## Consequences

- Slightly more code than naive parse and stringify, covered by fixture round-trip tests.
- The concurrency check protects against UI-versus-agent write races.
