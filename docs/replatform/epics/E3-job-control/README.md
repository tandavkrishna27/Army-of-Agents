# E3 — Durable Job Control

**Status:** `complete` (all tickets JOB-001 through JOB-015 shipped; the durable job-control foundation E4/E5/E7/E10 build atop and E2 depends on as satisfied — reconciled from a stale `backlog` in the 2026-09-13 record-integrity sweep, ticket range corrected from its own `tickets/` set)
**Depends on:** E1 and E2; JOB-004 through JOB-008, JOB-011 through JOB-014, and the exit gate require `E6-D1-FOUNDATION`; admission-only JOB-010 does not
**Tickets:** JOB-001 through JOB-015
**Exit gate:** submit, enroll, admission, assignment, product approval, runtime decision, lease, ACK, renew, fence, event, completion, cancellation, retry, budget, cost, output/run projection, revocation, and operator controls pass in D1 with source-specific provenance.

## Mandatory planning brief

The E3 plan is not approvable until it makes durable hybrid placement authoritative. It must separate server-assigned target scope/class, conditional Organization/owner binding, trust/credential/locality ceilings, provider allowlist and normalized provider-constraint profile, revocation generation, and fallback policy from worker-reported version, health, capacity, and capabilities. Scheduler matching uses the intersection; a worker cannot self-promote. Platform targets are operator-managed global catalog entries, but job details remain tenant-scoped and invisible until the atomic placement/lease transaction authorizes them.

`JOB-009 — Authoritative hybrid target placement` lands before JOB-003. JOB-003 leases only through that decision. The plan must cover platform-managed shared workers, dedicated/Organization workers, owner desktops, personal-credential binding, required/preferred/forbidden targets, data-local work, explicit fallback, target replacement, owner removal, drain/revocation races, and attributable queue reasons.

Focused evidence includes false privileged capability advertisement, owner mismatch/removal, target-generation replacement, shared versus dedicated routing, required target offline, allowed/forbidden fallback, owner-only credential with shared fallback requested, local-only workspace with cloud requested, concurrent compatible/incompatible claims, and revocation during lease/secret/upload/terminal commit.

`JOB-010 — Admission and assignment parity`, `JOB-011 — Approval and completion parity`, `JOB-012 — Budget and authoritative cost parity`, `JOB-013 — Transactional activity-audit parity`, and `JOB-014 — Task-output and run-summary parity` are separate bounded tickets. Together they preserve the current task, Commander, crew, one-shot, browser, and service control semantics without forcing every source into a task `runId`/`issueId`. CLI-005 cannot cut over until all five pass.
