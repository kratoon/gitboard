# Agent instructions

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`.

- `type`: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`.
- `scope`: the part of the codebase touched, e.g. `cli`, `web`, `core`, `skill`, `config`, `board`.
- The description is short, imperative and lower-case, with no trailing period.
- If the change relates to a Gitboard issue, put its reference (`KEY-<short id>`, as printed by the CLI)
  before the description: `type(scope): <issue-reference> description`.

Examples:

```
feat(cli): add backlog command
fix(web): FEAT-a3f91c2 keep due date when editing a card
docs(readme): describe agent skill install
```
