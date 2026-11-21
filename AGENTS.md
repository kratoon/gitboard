# Agent instructions

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/): `type(area): short description`.

- `type`: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`.
- `area`: the part of the codebase touched, e.g. `cli`, `web`, `core`, `skill`, `config`, `board`.
- The description is short, imperative and lower-case, with no trailing period.
- If the change relates to a Gitboard issue, put its key (e.g. `FEAT-85`, `BUG-3`) after the scope:
  `type(area): <gitboard-key> short description`.

Examples:

```
feat(cli): add backlog command
fix(web): FEAT-85 keep due date when editing a card
docs(readme): describe agent skill install
```
