# Re-platform Epic Index

**Integration model (locked):** the whole program lands on the single branch
`docs/replatform-program` as one continuous PR (#323, WIP/do-not-merge) — no per-epic PRs,
no per-epic merges to `main`. CI runs on that PR; the required check is `ci-required`. See
[`program-design.md` → Test and merge policy → Integration branch and PR strategy](../program-design.md).

**Current tip:** `docs/replatform-program` is green on Linux CI (all required checks pass).
Core execution complete on E3 (JOB-001/002/009/003), E4 (WRK-001..004), and E6
(DEP-000..004). **The `E6-D1-FOUNDATION` gate campaign has PASSED live on Linux CI** — the
`d1-merge-train.yml` lane builds the signed split images, brings up the 9-service D1 stack
healthy, and runs the E6F conformance suite live (`AOA_D1_CAMPAIGN=foundation`, `tests 11 · pass
11 · fail 0`) on `85599b192` (run 31749145506). See
`E6-deployment-test-harness/qa/2026-08-14-e6-d1-foundation-campaign-pass-85599b192.md`. The gate
**now UNBLOCKS JOB-004..014 and WRK-005..007** (and, transitively, most of E5). Next critical-path
step: E3/E4 remaining tickets.

> ⚠️ **This status table lags the reconciled ground truth (as of 2026-09-10).** The rows below
> are the pre-reconciliation view (E3/E4 mid-flight, E5/E7–E11 `backlog`). The authoritative
> current status is **GO-BOOK §1 "★ CURRENT STATUS" (reconciled 2026-08-28 and later)**: E0–E6
> are DONE (the whole mechanism), with substantial E7–E11 progress (E7 CLI-001..007, E10-desktop
> DSK-001..004 + realtime foundation, E8 Lane-B, E9 SVC-001, several E11 items) — what remains is
> breadth, two owed live-infra runs (E7-1 staging canary, REL-003 DR), and the DE threat-control
> audit. The formal cells here are intentionally NOT flipped to `complete`: per the governance
> note below, only the Integration Gate Owner does that, on a committed `pass` QA + handoff.

| Epic | Status | Depends on | Ticket range | Exit gate |
|---|---|---|---|---|
| [E0 Foundation](E0-foundation/) | `complete` | approved program design | FND-001–FND-008 | foundation checker, current-main crosswalk, cloud-plugin exclusion, focused config tests, repository verification |
| [E1 Worker protocol](E1-worker-protocol/) | `complete` | E0 | PRT-001–PRT-007 | package contract, transport/control semantics, frozen conformance vectors, compatibility and boundary checks |
| [E2 Tenant kernel](E2-tenant-kernel/) | `complete` | E0 | TEN-001–TEN-006 | non-owner RLS, sentinel removal, and adversarial tenant suite |
| [E3 Job control](E3-job-control/) | `in_progress` (core JOB-001/002/009/003 done; **JOB-004..014 UNBLOCKED** — `E6-D1-FOUNDATION` passed) | E1, E2; JOB-004–JOB-008 and JOB-011–JOB-014 required `E6-D1-FOUNDATION` (now satisfied) | JOB-001–JOB-014 | authoritative hybrid placement, fenced distributed lifecycle, and bounded legacy-control parity |
| [E4 Worker daemon](E4-worker-daemon/) | `in_progress` (core WRK-001..004 done; **WRK-005..007 UNBLOCKED** — `E6-D1-FOUNDATION` passed) | E1 plus ticket-level E3 core; WRK-005+ required `E6-D1-FOUNDATION` (now satisfied) | WRK-001–WRK-007 | restart-safe worker with encrypted event outbox |
| [E5 Workspaces and secrets](E5-workspaces-secrets/) | `backlog` | E3, E4 | DAT-001–DAT-006 | fenced artifact round trip, orphan quarantine, and lease-scoped secret tests |
| [E6 Deployment/test harness](E6-deployment-test-harness/) | `in_progress` (DEP-000..004 done; **E6-D1-FOUNDATION gate PASSED live** @ `85599b192`; DEP-005..009 remain) | E0; partial gate consumes E2 and E3/E4 core | DEP-000–DEP-009 | D1 topology, migration-0188 snapshot/marker preflight, reusable hostile isolation conformance, and two-replica HA; E2B evidence lands in E7/D2 |
| [E7 Coding/E2B](E7-coding-e2b/) | `backlog` | E3–E6; CLI-006 requires MIG-008 and `E10-REALTIME-FOUNDATION` | CLI-001–CLI-006 | mandatory canary-Organization coding journey and D2 E2B lane |
| [E8 Browser automation](E8-browser-automation/) | `backlog` | E7; BRW-006 requires `E10-REALTIME-FOUNDATION` | BRW-001–BRW-006 | mandatory D3 browser evidence/approval journey |
| [E9 Service agents](E9-service-agents/) | `backlog` | E7; SVC-007 requires `E10-REALTIME-FOUNDATION` | SVC-001–SVC-007 | mandatory D4 72-hour continuity/reconciliation canary |
| [E10 Desktop/migration/realtime](E10-desktop-migration-realtime/) | `backlog` | ticket-level E3–E7 dependencies; MIG-003 plus JOB-005/DEP-009 precede `E10-REALTIME-FOUNDATION` | DSK-001–DSK-004, MIG-001–MIG-008 | CM-015/current-path cutover, named realtime preflight, signed desktop lifecycle, and conditional handoff |
| [E11 Hardening/release](E11-hardening-release/) | `backlog` | E8, E9, DEP-009, MIG-001–MIG-003, MIG-005–MIG-008; DSK/MIG-004 are advertised-matrix conditional | REL-001–REL-005 | pre-0188 full restore plus mandatory coding/browser/service private-beta evidence pack |

Only the Integration Gate Owner changes an epic to `complete`, and only after a committed `pass` QA result and committed `pass` completion handoff on the exact candidate revision. Failed or blocked records leave it in `gate_review`.
