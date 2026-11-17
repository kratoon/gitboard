---
id: 8c2dda3b8cfc
title: "Single ESM npm package"
status: accepted
project: ADR
type: story
labels: []
createdAt: 2026-11-14T14:10:22.451Z
updatedAt: 2026-11-14T14:43:17.922Z
---

- **Date:** 2026-11-14
- **Related:** ADR-9b13ab6, FEAT-15fbb43

## Context

Gitboard ships a CLI, a local server, a React UI, and an agent skill. The requirements call for avoiding
multiple npm packages unless there is a compelling reason, and for `npm install -g gitboard` / `npx gitboard`
to work.

## Decision

- Publish one unscoped package named `gitboard` (name confirmed available, FEAT-15fbb43) exposing the `gitboard` binary, containing compiled `core`, `cli`, `server`, the built
  web bundle (`dist/web`), and `skills/`.
- ESM only, strict TypeScript, Node >= 20.
- Bundle with `tsup` (Node code) and Vite (web). Module boundaries are enforced by ESLint
  `no-restricted-imports` and TypeScript project references rather than by package boundaries.

## Alternatives considered

- **Monorepo with `@gitboard/core`, `/cli`, `/server`, `/web`:** stronger boundary enforcement, but
  release overhead and version skew for no user benefit at MVP scale.
- **Dual CJS/ESM:** unnecessary complexity; all target consumers are Node >= 20.

## Consequences

- Simple install and release story.
- Boundaries rely on lint and tests, so CI must fail on violations.
- If a future hosted frontend needs `core` types alone, a `gitboard/types` subpath export is sufficient.
