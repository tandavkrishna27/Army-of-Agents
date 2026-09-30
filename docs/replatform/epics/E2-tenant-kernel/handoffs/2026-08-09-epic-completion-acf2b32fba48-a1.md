# Handoff — E2-tenant-kernel epic completion

**Date (UTC):** `2026-08-09`
**Epic:** `E2-tenant-kernel`
**Record path:** `docs/replatform/epics/E2-tenant-kernel/handoffs/2026-08-09-epic-completion-acf2b32fba48-a1.md`
**Gate slug:** `epic-completion`
**Reviewed revision:** `acf2b32fba480aa5d440e9606e20c3b542544d5d`
**Attempt:** `1`
**Supersedes:** `none`
**Decision:** `blocked_external`
**Gate owner role:** `Integration Gate Owner`
**Gate owner identity:** `E2 integration-gate owner subagent (Claude)`

> This file is immutable from its first commit. A correction, rerun, changed decision, or changed
> revision creates a higher attempt and links this path through `Supersedes`.

The gate owner implemented and reviewed **no** E2 ticket and did not author any E2-F0xx fix. All
eight ticket ledgers were independently re-confirmed `complete`/`approved` with a distinct
implementer≠reviewer and a 40-hex-commit ancestor reviewed revision; the D0 rollup, the H-01
critical suites (3× each, `AOA_RUN_WIN_INTEGRATION=1`), and the DEC-03 repository lanes were
independently re-run on the recorded revision. The blob SHAs below were recomputed with
`git rev-parse HEAD:<path>`; each reviewed implementation SHA was confirmed a commit and an
ancestor of HEAD (`git merge-base --is-ancestor`).

**This gate does not pass yet.** Every locally-runnable REQUIRED / HARD (H-01) / INITIAL condition
is green on this revision, but the mandatory **≥1 real Linux execution of the H-01 suites**
(E2-D05 / E2-F008) — an operator-gated CI action the gate owner must not trigger — has **not
started**. E2 therefore stays `gate_review`; a superseding `a2` handoff will record `pass` once
the Linux run is green.

## Included ticket results

| Ticket | Ticket-result path | Ticket-result Git blob SHA | Reviewed implementation SHA | Latest review disposition |
|---|---|---|---|---|
| TEN-001a | `docs/replatform/epics/E2-tenant-kernel/tickets/TEN-001a-result.md` | `9e3f922879d0cdb5d7010e40b7a2128b205e0102` | `b5a9e8178c4bcc3fb0c72b564a858b06fad1ddc0` | `approved` |
| TEN-001b | `docs/replatform/epics/E2-tenant-kernel/tickets/TEN-001b-result.md` | `b4fd200929bc6493ad4333dff41182f302c691de` | `f9b37cd98e195e57f65eeb9d04f330b933b0dc74` | `approved` |
| TEN-002 | `docs/replatform/epics/E2-tenant-kernel/tickets/TEN-002-result.md` | `bffc21baa481b3d2316aaa131d19dda83cb474a2` | `0b22d3934396c6c2bb6f3844800696c0fc38f233` | `approved` |
| TEN-003 | `docs/replatform/epics/E2-tenant-kernel/tickets/TEN-003-result.md` | `ab5b28894d631fe74f971761e8119b2ff905945a` | `10592fc0b5cd9f759fb24d0fc2e15e908d4d7653` | `approved` |
| TEN-004 | `docs/replatform/epics/E2-tenant-kernel/tickets/TEN-004-result.md` | `9fbd065157039c523d0ed1f35aad17b0f59903b5` | `bd4fe0283cce23f3e0983340435c14749a7a0c73` | `approved` |
| TEN-005 | `docs/replatform/epics/E2-tenant-kernel/tickets/TEN-005-result.md` | `762fdc3ad2860afbb1b719e312313aa93564715b` | `3f994fd6b1c1c3d9c51fb7242f3bde0426437aac` | `approved` (a2; a1 `changes_requested`→E2-F013) |
| TEN-006a | `docs/replatform/epics/E2-tenant-kernel/tickets/TEN-006a-result.md` | `1ed2724d6043a8e1c7bbd0b6fc008fefc0d0d8ba` | `324e62ca64045c12f0aacba01afe454e6decdb9d` | `approved` (a2; a1 `changes_requested`→E2-F010) |
| TEN-006b | `docs/replatform/epics/E2-tenant-kernel/tickets/TEN-006b-result.md` | `3a89564dfad9c2fa80e0f76340dded345173c47c` | `a269f8bd2cd15a90c26c61784c473033ab229872` | `approved` |

## QA evidence

| QA record | QA revision | Lane | Attempt | Result |
|---|---|---|---:|---|
| `docs/replatform/epics/E2-tenant-kernel/qa/2026-08-09-d0-e2-tenant-kernel-acf2b32fba48-a1.md` | `acf2b32fba480aa5d440e9606e20c3b542544d5d` | `D0` | `1` | `blocked_external` |
| `docs/replatform/epics/E2-tenant-kernel/qa/pre-existing-failure-baseline.md` (DEC-03 seed) | `acf2b32fba48` (files byte-identical to Start `df509b946`) | `D0` | — | advisory seed |

## Dependency handoffs (confirmed `pass`)

| Epic | Handoff | Decision |
|---|---|---|
| E0-foundation | `docs/replatform/epics/E0-foundation/handoffs/2026-08-08-epic-completion-3a469b6bec68-a1.md` | `pass` |
| E1-worker-protocol | `docs/replatform/epics/E1-worker-protocol/handoffs/2026-08-09-epic-completion-b03262692882-a2.md` | `pass` |

E2 is independent of E1 (E0 unblocks it); both dependency handoffs are `pass`.

## Threshold decision (D0 rollup, Windows-local per DEC-03)

| Requirement ID | Class | Required value/condition | Observed | Decision |
|---|---|---|---|---|
| H-01 | **HARD** | Zero cross-Org/unauthorized cross-Company read/write/delete/existence-disclosure; forced RLS; mandatory context; composite integrity; uniform denial. | Windows-local PASS 3× deterministic: TEN-002 10/10, TEN-003 7/7, TEN-004 9/9 + ondelete 4/4, TEN-005 11/11 (8 seeds, `totalOps=4460`, `crossParentVsAbsentUniform=216` byte-identical cross-vs-absent). **Linux lane NOT started.** | Windows-local `pass`; **Linux lane `blocked_external`** |
| D0-T01 | REQUIRED | Focused acceptance per ticket. | Re-verified via critical suites + ledgers; typecheck/build 0. | `pass` |
| D0-T02 | REQUIRED | Lifecycle matrix. | TEN-003 `runInTenant` commit/rollback/nested/background + (d)/(d2). | `pass` |
| D0-T04 | REQUIRED | Schema/protocol conformance. | Migrations `0207`–`0212` integration + idempotency; policy/role SQL unit. | `pass` |
| D0-R01 | REQUIRED | `pnpm -r typecheck`+`test:run`+`pnpm -r build`; DEC-03-governed. | typecheck 0; `-r build` 0; `test:run` exit 1 = 1 non-E2 file (baseline B1), 18795 passed/0 failed bodies; zero E2-touched failure. | `pass` |
| D0-R02 | REQUIRED | Root `pnpm build`; no tracked-byte change. | exit 0; byte-clean before/after; `diff --check` clean. | `pass` |
| D0-R03 | REQUIRED | Critical suites 3× consecutive, zero flaky. | DB 7/37 ×3; server 8/74 ×3; `totalOps=4460` identical; no re-run needed. | `pass` |
| D0-R04 | REQUIRED | Byte-clean worktree; retained evidence. | `git status --porcelain` empty; `diff --check` clean; logs retained. | `pass` |
| DEC-01 | REQUIRED | One-revision decision; no hard-invariant failure; REQUIRED failure fail unless DEC-03. | No hard-invariant/epic-touched failure; H-01 Linux lane unstarted. | `blocked_external` |
| DEC-03 | REQUIRED | REQUIRED-suite failures ⊆ attributed baseline; non-epic-touched. | Single `test:run` failure = attributed baseline B1 (worker-protocol, non-E2, unchanged since Start SHA). | `pass` |
| TEN-002 owner-cred-absence | REQUIRED | Owner/superuser creds absent from app container. | Certified flag-ON (E2-D03): fail-closed non-owner pool + `assertNonOwnerConnection`. Flag-OFF interim not claimed. Not H-05. | `pass (flag-ON)` |
| D1-01 | INITIAL | 20 seeds × 10,000 ops × ≥10 Orgs. | Deferred to the D1 gate; TEN-005 is the E2-available-surface partial (E2-D04). | `deferred (D1 gate)` |

A handoff cannot pass with any required-condition/command failure or HARD/INITIAL failure. There
is **no** required-condition or hard-invariant failure at this revision; the only outstanding
item is the required H-01 **Linux** lane, which has not started.

## Open risks

1. **Owed: ≥1 real Linux H-01 execution (E2-F008 / E2-D05) — the sole blocker.** H-01 is HARD /
   non-waivable and must not rest on Windows-only console output. The gate owner must not trigger
   CI (no `workflow_dispatch`, no scratch PR, no push). An operator-triggered Linux run of the
   tenant/company-writer suites at this revision, pinned as formal evidence, converts this handoff
   to `a2` `pass`.
2. **E2-F012 NULLIF hardening deferred to E3.** The TEN-002 policy predicate has no `NULLIF`; an
   un-wrapped reused-connection read fails closed by throwing `22P02` (never leaks). No H-01 gap
   at E2 (policies dormant). Revisit only if an E3 operator/monitoring path legitimately issues
   un-wrapped new-path reads.
3. **Sentinel admission helper dormant until E3.** `forbiddenOrganizationSentinels` admission
   denial (`server/src/services/tenant-admission.ts`) is unit-proven but has no runtime caller
   until JOB-001/JOB-010 (E3). At E2 only `organization_id NOT NULL` on the new-path tables is
   runtime-enforced.
4. **Legacy tables remain app-layer-isolated (CAV-005).** H-01 is DB-enforced for new-path tables
   only; the ~129 legacy `companyId` tables keep `assertCompanyAccess` + `tenantIsolationEnforced()`
   + the `company_secrets` canary (no RLS retrofit). New enforcement is new-path only.
5. **DEC-03 baseline B1 is Windows-local advisory.** `worker-protocol/cross-version.test.ts`
   (E1, non-E2) fails to collect under vitest transform on Windows (`SyntaxError`); the modules
   Node-parse clean. Expected GREEN on Linux CI; confirm at the Linux run. Not an E2 defect.
6. **E2-F009 correction.** Contrary to the finding's literal wording, `@armyofagents/plugin-sdk`
   is present (`packages/plugins/sdk`, tracked since the Start SHA); the isolated `--filter server`
   typecheck/build failure is a build-ordering artifact resolved by the D0-R01 package build. The
   `-r typecheck`/`-r build` gate lanes pass clean and the two predicted fail-to-collect files
   both pass. No residual gate failure from this axis.

## Compatibility and rollout

- **Protocol/schema compatibility:** E2 adds new-path tenant tables + composite FKs via
  `db:generate` (`0207`–`0212`); the RLS/role/GRANT/FORCE/POLICY enforcement is C14 hand-appended
  idempotent raw SQL in the `0211` `--custom` delta-free migration (E2-D01, promoted to
  `docs/architecture/decisions.md` #122). `0212` closes the E2-F013 existence oracle (E2-D09). No
  worker wire-protocol change (PRT-006/007 stay context-free). `companies.organization_id` schema
  default dropped fail-closed (E2-D07); the self-hosted Default-Org resolution preserved as
  explicit.
- **Flags/migration state:** the whole-app non-owner serving cutover is behind the FND-005
  distributed-execution disable flag (dormant-by-default, dormant-but-tested). New-path
  repositories always use the fail-closed non-owner pool + forced RLS. Migrations run under a
  separate privileged phase before the non-owner serving pool opens (E2-D03).
- **Rollback/disable path:** reverting the E2 commits removes additive tables + the dormant
  non-owner pool with no live behavior change (new-path tables have no runtime caller at E2).
  Rollback preserves the explicit Default-Org mapping and never restores the fail-open sentinel
  default.
- **Residual risk (non-blocking except item 1):** the authoritative H-01 Linux run per
  DEC-03/E2-D05 is owed; this gate ran Windows-local per the E0/E1 operator precedent.

## Next unblocked work

E2 remains `gate_review` pending the Linux H-01 run. On `a2` `pass` (Linux green), E2 moves
`gate_review → complete` and, once both E1 and E2 are green on main, the next planning order is
E3/E4 core planning, then JOB-001/JOB-002/WRK-001 bootstrap, then E6 DEP-000..004 and the
`E6-D1-FOUNDATION` gate (which owns the full D1-01 tenant property floor E2-D04 defers).

## Decision rationale

Everything locally runnable is green on `acf2b32fba480aa5d440e9606e20c3b542544d5d`: all 8 tickets
`complete`/`approved` with distinct reviewers on ancestor revisions; the D0 rollup passes
(`pnpm -r typecheck` 0, `pnpm -r build` 0, root `pnpm build` 0 byte-clean, `pnpm test:run` one
non-epic DEC-03-baseline file failure and zero failed test bodies); the H-01 critical suites pass
3× deterministically under the Windows integration hatch (`totalOps=4460`, the closed existence
oracle proven byte-identical); and no E2-changed file appears in any failure. The single
outstanding requirement is the mandatory ≥1 real Linux execution of the H-01 suites (E2-D05 /
E2-F008), an operator-gated CI action the Integration Gate Owner must not trigger — its required
lane has not started, which is precisely `blocked_external` under DEC-01, not `pass` (the Linux
lane has passed nothing yet) and not `fail` (nothing failed). E2 stays `gate_review`.
