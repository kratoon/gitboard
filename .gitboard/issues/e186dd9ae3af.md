---
id: e186dd9ae3af
title: "Hosted phase 3: versioned per-user profile and preferences"
status: todo
project: FEAT
type: story
labels: []
parent: cd25599aa801
createdAt: 2026-11-21T18:01:15.949Z
---

- **Goal:** Git-backed profiles and preferences moved out of browser storage.
- **Includes:** `profile.yaml` schema and validation; read and write through the sync manager; preferences and personal saved views served from the profile; fallback to the last good copy.
- **Depends on:** phase 2; the profile question; ADR-7d58e8b.
- **Validation milestone:** moving to a new instance with only the profile location and credentials restores the user's setup.

- **Related:** FEAT-8c2e32c, ADR-819be48
