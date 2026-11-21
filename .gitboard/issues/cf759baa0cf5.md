---
id: cf759baa0cf5
title: "Hosted: repositories that require signed commits or restrict who may push"
status: todo
project: FEAT
type: story
labels: []
createdAt: 2026-11-21T18:01:14.732Z
---

- **Question:** What happens when a repository requires signed commits or otherwise rejects pushes from the server?
- **Why it matters:** A pushed commit that violates a ruleset is rejected, so writes are impossible for those repositories unless a workaround exists.
- **Options:** (1) Read-only for such repositories with a clear message. (2) Sign commits with a key the remote trusts (viability unverified). (3) Per-repository fallback through the provider's content API (provider-specific, reintroduces quotas for that subset).
- **Recommendation:** Option 1 with detection and a precise error; evaluate the others only if the Phase 0 spikes show the case is common. Author is always the acting user.
- **Related:** FEAT-8c2e32c, ADR-0aa6b23
- **Decision / date:** _pending_
