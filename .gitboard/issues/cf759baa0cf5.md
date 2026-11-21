---
id: cf759baa0cf5
title: "Hosted: repositories that require signed commits or restrict who may push"
status: done
project: FEAT
type: story
labels: []
createdAt: 2026-11-21T18:01:14.732Z
updatedAt: 2026-11-21T20:21:18.018Z
---

- **Question:** What happens when a repository requires signed commits or otherwise rejects pushes from the server?
- **Why it matters:** A pushed commit that violates a ruleset is rejected, so writes are impossible for those repositories unless a workaround exists.
- **Options:** (1) Read-only for such repositories with a clear message. (2) Sign commits with a key the remote trusts (viability unverified). (3) Per-repository fallback through the provider's content API (provider-specific, reintroduces quotas for that subset).
- **Recommendation:** Option 1 with detection and a precise error; evaluate the others only if the Phase 0 spikes show the case is common. Author is always the acting user.
- **Related:** FEAT-8c2e32c, ADR-0aa6b23
- **Decision / date:** 2026-11-21. MVP: read-only. When a push is rejected for a signature or ruleset reason, the repository is marked read-only for that user (the result is cached) with the remote's message shown, and the board stays visible. The author is always the acting user. Fallbacks are deferred (FEAT-eb374f4).
