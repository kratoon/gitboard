---
id: cd7b875adba5
title: Custom and saved views
status: todo
project: FEAT
type: story
labels:
  - question deferred
createdAt: 2026-11-14T14:43:17.247Z
updatedAt: 2026-11-17T13:45:51.779Z
---

- **Question:** Should users define their own views (a saved filter, a grouping, a column subset) in
  `config.json`, beyond the built-in `kanban` and `backlog`?
- **Recommendation:** wait for real demand. If needed, allow `views` entries to be objects such as
  `{ "id": "my-bugs", "type": "backlog", "filter": { "label": "bug" } }` while plain strings keep meaning the
  built-ins, so existing files stay valid.
- **Decision / date:** _pending_
