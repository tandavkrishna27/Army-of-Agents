# E3 — Durable Job Control — Implementation Plan

**Plan status:** `needs_changes` — JOB-003 final-review fix round 3 is planned but not implemented; the operator approved the earlier reviewed plan
and recommended E2/E1/JOB-002 choices on 2026-08-10. On 2026-08-10 the operator also
approved the E3-F018 / Decision #124 amendment: tenant work on a platform target uses an
Organization-scoped logical worker session; a platform-scoped physical session remains
physical-control-only. The corrective E2 and E1 gates passed
at reviewed revisions `7843b86e25eb1ff9c520308aef7f123fec6997a7` and
`01ad1ab554fe25c5178c7552ec047d4df45b7dcf`. Pre-D1 tickets may now execute in dependency
order except that JOB-003 is paused for the final-review fix round named below; the
post-D1 boundary remains locked.

**JOB-003 final-review amendment status:** `needs_changes`. Review attempt 2
proved that restart-safe pull fairness needs durable progress. A first two-field cursor lost
the locked claim order, and independent review of the replacement four-field cyclic cursor
also rejected it: stale continuation can bypass newly eligible older work, JavaScript `Date`
cannot preserve PostgreSQL microseconds, and hint-first selection independently contradicts
the canonical oldest-eligible rule. JOB-003 implementation is paused before migration
`0229`. The successor below removes the cursor entirely. Every claim starts at the database-
ordered global head and anti-joins only exact, tenant-scoped static-ineligibility certificates;
dynamic capacity is hoisted before selection, and ready signals can affect retry latency but
never candidate identity or order. A distinct whole-plan reviewer and a distinct schema/security
reviewer independently accepted exact revision
`73675cc621008ea0dcf18f6ae0c430162e7e448e` with zero P0/P1/P2 findings. This authorizes only
replacement of the obsolete cursor-based tests with one corrected tests-only RED matching the
accepted successor. Migration generation and production GREEN remain paused until the controller
independently verifies that committed RED and its intended failure map. Final review attempt 3
of implementation candidate `392c3a2da52c3fd812d7b9e2801fe6523f1cc657` then opened
E3-F028 through E3-F033: one Critical shared-database/advisory-domain defect, four Important
startup/cleanup/performance/telemetry defects, and one Minor row-lock-order defect. The exact
fix-round-3 contract is appended to JOB-003 below. It supersedes only conflicting JOB-003
implementation details; prior accepted certificate, ordering, migration, and evidence
contracts remain binding. No part of JOB-003 is complete or accepted for release.

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `superpowers:subagent-driven-development` to execute this plan ticket by ticket
> **only after operator approval**. Every ticket uses a fresh implementer subagent
> (strict RED → GREEN) and a DISTINCT independent reviewer subagent. A separate
> Integration Gate Owner, who implemented/reviewed no E3 ticket, owns the epic gate.
> The operator approved the read-back on 2026-08-10. Only the approved predecessor
> corrections may execute first; no E3 ticket may be assigned until their committed passing
> handoffs exist. The ticket-by-ticket subagent/reviewer protocol then applies unchanged.

**Goal:** Build the dormant, durable, tenant-safe control plane for immutable job
submission, device-bound worker enrollment, authoritative hybrid placement, atomic
lease/ACK, fencing, ordered events, cancellation/retry/reconciliation, quota/revocation,
operator controls, and legacy-control parity without creating a second product engine.

**Approved architecture:** PostgreSQL is the sole job/attempt/lease authority. Every tenant job,
poll/lease, event, control, reconciliation, and operator read executes through an
operator-approved non-owner pool and `runInTenant(appDb, organizationId, fn(repos))`; forced
RLS and composite tenant FKs remain the defense-in-depth boundary. The approved E2-D03
successor uses bounded traced legacy grants on `aoa_app` plus a metadata-only
`aoa_operator` role for null-Organization platform authority. E1's frozen v1 protocol is
consumed unchanged; device possession travels in versioned HTTP headers. Server-owned
placement intersects the registered target profile with
the worker's dynamic report before job details are released. A platform-owned physical
target may back many Organization-scoped logical worker profiles, but only an authenticated
Organization-scoped logical session may poll, receive, ACK, renew, emit events, or otherwise
touch tenant work. The platform-scoped session carries no Organization and is limited to
physical enrollment, health, generation, and lifecycle control; it never selects a tenant
shard and never receives tenant job identity. A lease claim and its fence
are committed atomically, and one shared fence guard authorizes every later governed
mutation. Legacy task assignment, approvals, runtime decisions, budgets, cost, activity,
outputs, and summaries are called through transaction-scoped bridges; they are not
reimplemented. Distributed execution stays behind
`AOA_DISTRIBUTED_EXECUTION_ENABLED=false` and does not become authoritative for an
Organization/workload until E10 migration tickets transfer ownership.

**Tech stack:** TypeScript, Express 5, React/Vite, PostgreSQL, Drizzle ORM, E1
`@armyofagents/worker-protocol`, Vitest, and `embedded-postgres`.

---

## 0. Planning record, freeze, and dependency gates

| Item | Recorded value |
|---|---|
| Frozen `origin/main` | `003492988269a91eadfadb352bff7f413fa61adb` — present locally and an ancestor of the current `origin/main`; the crosswalk execution freeze is intact. |
| E3 Start SHA | `8e2faa590d4e97a2cbd250c55f4a2ed81a352a33` — fetched `origin/docs/replatform-program` and the `C:\e3` worktree's initial HEAD before planning commits. This exact bare 40-hex value is the `Start SHA` in `JOB-001-result.md`. |
| E0 completion | `pass` — `docs/replatform/epics/E0-foundation/handoffs/2026-08-08-epic-completion-3a469b6bec68-a1.md`. |
| E1 completion | Corrective QA and superseding handoff are `pass` for reviewed revision `01ad1ab554fe25c5178c7552ec047d4df45b7dcf` (`2026-08-10-d0-e1-frozen-checker-correction-01ad1ab554fe-a6.md` and paired completion handoff). E3-F004 is resolved. |
| E2 completion | Corrective QA and superseding handoff are `pass` for reviewed revision `7843b86e25eb1ff9c520308aef7f123fec6997a7` (`2026-08-10-d0-e2-tenant-kernel-21335854f-a5.md` and paired completion handoff). E3-F001/E3-F002 are resolved. |
| `E6-D1-FOUNDATION` | **Not present / not passed at planning time.** It is a named partial gate, never a ticket-result substitute. |
| Planning worktree | `C:\e3`, branch `codex/epic-e3-job-control`; dependencies installed with `pnpm install --frozen-lockfile`. |
| Formal test authority | Linux CI under DEC-03. Windows short-path evidence is operator-directed local evidence and must be labeled as such. |
| Planning baseline smoke | `pnpm build` passed at the Start SHA. After package build, `pnpm test:run` reaches the suite but exits on Windows with the already-recorded E2 `ERR_IPC_CHANNEL_CLOSED` worker-protocol transform artifact; this is planning context only, not E3 gate evidence or a waiver. |

The canonical JOB text and frozen-main crosswalk agree with E1's protocol semantics; E1's
as-built frozen-consumer verification seam conflicts with the required later consumer
dependency (STOP below). E2's locked decision and completion prose contradict its as-built
serving-role interface (STOP below). One separate
stale implementation shorthand was resolved without amendment: the
current `issueService.checkout` uses an atomic conditional update, while older prose says
`SELECT FOR UPDATE NO WAIT`. JOB-010 explicitly makes the observable single-winner
contract authoritative and forbids freezing a stale SQL detail, so E3 reuses the service
contract and does not duplicate its SQL.

Planning findings are retained in [`findings.md`](findings.md). E3-F001/E3-F002 cover the
serving/operator-role gaps, E3-F003 records checkout shorthand drift, E3-F004 records the E1
frozen-consumer checker conflict, and E3-F005 records the approved device-proof and
worker-target binding contract. E3-F006 through E3-F008 record plan defects corrected by
this revision. The operator selected bounded-grant E2 option B, approved the E1 checker-only
correction, and approved E3-F005's HTTP-header proof/composite binding on 2026-08-10.
E3-F001/E3-F002 and E3-F004 are resolved by independently reviewed corrective gates. The
approved E3-F005 contract remains binding on JOB-002; E3 may not improvise beyond it.

### RESOLVED — E2-D03 successor serving/operator path

Locked E2-D03 (`docs/replatform/epics/E2-tenant-kernel/decisions.md`) requires one
non-owner application role for all serving queries, full DML grants on legacy tables, a
flag-on whole-app serving connection, and privileged migrations/DDL completed before that
pool opens. The E2 completion handoff repeats that the whole-app cutover is
dormant-but-tested. At the branch tip, however:

- `packages/db/src/migrations/0211_tenant_rls_enforcement.sql` grants `aoa_app` only the
  eight new-path tables;
- `server/src/index.ts::maybeProvisionTenantAppRole` provisions LOGIN only and explicitly
  says it does not open the serving pool; and
- no flag-on whole-app switch replaces the owner `db` passed to `createApp`.

The operator selected option B on 2026-08-10. The alternatives remain recorded for review
provenance, but only B plus the metadata-only operator role is authorized:

1. **A — Correct E2 to its locked contract (review recommendation):** implement the full
   flag-on non-owner serving cutover and legacy grants, reconcile the already-described
   null-Org operator policy, rerun E2's security/integration gate, and commit a superseding
   E2 completion handoff before E3 assignment.
2. **B — SELECTED: bounded-grant successor to E2-D03:** permit only the traced parity-table
   grants on `aoa_app`, retain application-layer Company isolation for CAV-005, and add a
   distinct NOSUPERUSER/NOBYPASSRLS metadata-only `aoa_operator` role for null-Organization
   platform target/enrollment/proof/revocation authority. `aoa_operator` receives no access
   to jobs, attempts, leases, events, artifacts, or secrets. Update the locked decision and
   E2 evidence, then run a corrective E2 gate and superseding handoff.
3. **C — Approve a split-role successor to E2-D03:** use a distinct non-owner `aoa_bridge`
   role/pool for legacy parity bridges while `aoa_app` remains RLS-only for new-path tables;
   update the locked decision and E2 evidence, then run a corrective E2 gate and superseding
   handoff. This provides stronger privilege separation but adds a credential/pool. The
   amendment must also grant/policy `aoa_bridge` into the required new-path receipt/job rows
   under FORCE RLS; a legacy-only bridge cannot make one atomic new+legacy projection.

If none is acceptable, pause for a dedicated planning-only E2 security/migration audit.
No option may use an owner-pool bridge or split one parity projection across owner/new-path
transactions; either would violate the serving-role contract and JOB-013 atomicity.

The corrective implementation is reviewed at
`7843b86e25eb1ff9c520308aef7f123fec6997a7`; its QA record and superseding E2 completion
handoff are `pass`. E3 now consumes this interface, but ticket assignment remains blocked on
the separate E1 correction below.

### RESOLVED — E1 frozen-consumer checker correction

The frozen v1 bundle and schema are valid and remain immutable. The problem is the as-built
verification seam: `scripts/check-frozen-worker-protocol-consumer.mjs` hashes the current
working `pnpm-lock.yaml` and compares it with the E1 fixture's recorded hash. JOB-001 must add
`@armyofagents/worker-protocol: workspace:*` to `server/package.json` and regenerate that
lockfile under AGENTS §7, so a legitimate consumer declaration necessarily changes the hash
and fails `pnpm check:frozen-worker-protocol-v1`. The checker also hashes working-tree bytes,
which produces a separate CRLF false failure on Windows even when the Git blob is unchanged.

The operator approved this checker-only correction on 2026-08-10; it remains owned by the E1
Protocol/Schema Custodian. Keep the frozen fixture byte-identical, but make its dependency
proof compare the recorded source-SHA Git
blobs and protocol-relevant dependency snapshot—including recorded Zod/esbuild versions—
rather than the mutable current repository lockfile/package or currently installed versions.
The check fails clearly if the recorded source commit is unavailable, retains the mutation
corpus, adds LF/CRLF-safe tests, and commits a superseding E1 QA
record/handoff. Any alternative—including changing the frozen fixture, omitting the server
manifest dependency, or bypassing the check—is a STOP requiring explicit custodian approval.
JOB-001 cannot be assigned until the corrected check passes at its assignment revision.

The corrected checker passed independent review at
`01ad1ab554fe25c5178c7552ec047d4df45b7dcf`; its prerequisite result, corrective E1 QA,
and superseding completion handoff are `complete`/`pass`. JOB-001 may consume the frozen
package while preserving the immutable source and fixture anchors.

### Execution boundary

| Boundary | Tickets | Assignment rule |
|---|---|---|
| **Pre-D1, approved and assignable** | JOB-001, JOB-002, JOB-009, JOB-010 | E3-F001/E3-F002 and E3-F004 corrective handoffs passed. E3-F005's device/binding contract is approved for JOB-002 implementation. Respect ticket dependencies; JOB-010 may start after JOB-001. |
| **Pre-D1, needs changes** | JOB-003 | Final review attempt 3 opened E3-F028–E3-F033. Implement only the appended fix-round-3 contract with fresh behavior-first REDs, bounded GREEN commits, and distinct whole-plan plus schema/security review. Do not mark the ticket complete, run the formal million-row campaign, or make an SLO/capacity claim until all listed gates pass. |
| **Post-D1, blocked** | JOB-004–JOB-008, JOB-011–JOB-014 | Do not assign until a committed `E6-D1-FOUNDATION` QA record **and passing handoff** cover E6F-00–E6F-08 on one revision. |
| **E3 exit gate, blocked** | all JOB-001–JOB-014 evidence | Requires every ticket complete, the post-D1 closure, and a passing `E3-PERF-01` handoff before any production-capacity/SLO claim. A Windows-local run is not a substitute for the formal Linux lane or the pinned performance environment. |

### NOT in scope (epic non-goals)

- No legacy/distributed execution cutover, shadow execution with external effects, or
  per-Organization/workload authority transfer; E10 MIG tickets own cutover.
- No E1 v1 redesign. An unavoidable wire change is an additive, versioned field only and
  is a STOP requiring the Protocol/Schema Custodian's approval plus D0-T04 evidence.
- No second assignment, approval, runtime-decision, budget, pricing, audit, output, or
  completion engine.
- No provider implementation, runner, sandbox, object-byte store, secret materialization,
  public worker ingress, realtime durability claim, desktop packaging, or mobility.
- No Firecracker support or claim (CAV-002); target/provider matching remains provider-neutral
  and implements only registered capabilities.
- No RLS retrofit on legacy Company tables (CAV-005), no unsafe owner-pool fallback, and
  no weakening of `assertCompanyAccess`.
- No `NULLIF(current_setting(...), '')` RLS-policy rewrite for E2-F012. E3 has no valid
  unwrapped new-path query: every path uses `runInTenant`. Regression tests keep that
  fail-closed assumption explicit; a future global/operator read that needs otherwise
  requires a reviewed decision and custom RLS migration.

---

## 1. Consumed as-built interfaces / what already exists and is reused

### Frozen E1 protocol — consume, do not edit

| Interface | E3 use |
|---|---|
| `packages/worker-protocol/src/job.ts` | Validate immutable `JobEnvelopeV1`, all six source variants, target requirements, requester/executor identity, policy hashes, lease offer/ACK/renew shapes. |
| `states.ts` | Apply the generated legal job/attempt/lease transitions; never invent a combined state machine. |
| `capabilities.ts` | Use `registeredTargetProfileV1Schema` and `workerSatisfiesRequirements`; registered profile/provider ceilings intersect worker hello. |
| `transport.ts` | Implement enrollment, poll/no-work, lease ACK/renew, event upload, control commands/ACKs with the frozen operation limits/audiences. |
| `events.ts` | Recompute event digest before authorization/persistence; use receiver replay/gap/stale-fence decisions and cumulative ACKs. |
| `policy.ts` | Preserve separate product approval and runtime-decision aggregates and timeout/default rules. |
| `artifacts.ts` | Expose the active-fence authorization seam for ordinary commit; stale/replaced output can only enter the separate quarantine operation owned downstream. |
| `errors.ts` | Return the closed v1 codes (`malformed`, `unauthorized`, `incompatible_*`, `stale_fence`, `sequence_gap`, `target_revoked`, `event_hash_mismatch`, `throttled`, `payload_too_large`, `attempt_terminal`, `internal_unavailable`) without existence or secret disclosure. |

### E2 tenant kernel — mandatory for every E3 path

| Interface | E3 use |
|---|---|
| `server/src/db/tenant-context.ts` | All tenant job/lease/event/control handlers, outbox drains, sweepers, bridge projections, and tenant operator reads call `runInTenant`. Platform-target enrollment/session verification is a separate operator-only path that can read no job data. It never chooses a tenant for a worker operation: the authenticated Organization-scoped logical session supplies the only tenant identity accepted by `runInTenant`. Add an overload-compatible second callback argument only where an existing legacy service must share the same transaction; old one-argument callbacks remain source-compatible and the handle may not escape. |
| `packages/db/src/repositories/tenant/index.ts` | Extend the tenant-bound repository factory with job-control methods. No unscoped new-path reader is exported. |
| Eight E2 tables | Add rich E3 columns to `jobs`, `job_attempts`, `leases`, and `workers`; retain E2 composite FKs and FORCE RLS. `job_artifacts` and `job_secret_handles` consume the shared fence guard but their content/materialization remains E5. |
| `server/src/services/tenant-admission.ts` | JOB-001/JOB-010 call it before persistence and add the missing Organization-mapping/existence check. Sentinel or unmapped admission fails uniformly. |
| `createTenantAppDb` / `assertNonOwnerConnection` | When the deployment flag is on, boot opens only the explicit `AOA_APP_DATABASE_URL`, asserts NOSUPERUSER/NOBYPASSRLS, and fails startup on missing/privileged credentials. Flag-off boot creates no tenant pool. |
| `resolveDistributedExecutionRollout` | The global flag is necessary but never sufficient for execution authority. E3 tests deployment/Organization/workload decisions; E10 owns enabling actual Organization/workload cutover. |

### Existing engines E3 bridges

| Existing authority | Files | Reuse rule |
|---|---|---|
| Target registry / Decision #117 | `packages/db/src/schema/execution_targets.ts`, `server/src/services/execution-targets.ts`, `server/src/routes/execution-targets.ts`, `server/src/services/execution-target-resolver.ts` | Extend this registry and link E2 `workers`; do not create a second target catalog. |
| Task checkout / assignment | `server/src/services/issues.ts` | Call `issueService.checkout`, ownership validation, and release behavior. Preserve dependencies, single assignee, replay, and bounded stale-owner adoption. |
| Organization capacity | `server/src/services/org-concurrency.ts` | Refactor into one shared transaction-scoped claim/release/wakeup primitive that counts legacy runs plus distributed attempts. |
| Product approvals | `server/src/services/approvals.ts`; crew preflight services | Call existing create/resolve/preflight behavior. |
| Runtime decisions | `server/src/services/agent-runtime-decisions.ts` | Persist/answer/expire/cancel using the existing aggregate; worker events are observations only. |
| Budgets / cost | `server/src/services/budgets.ts`, `server/src/services/costs.ts`, `server/src/services/one-shot-cli-budget.ts` | Extend the existing scopes/idempotency and server-owned rate calculation; worker usage is evidence, never price authority. |
| Activity/audit | `server/src/services/activity-log.ts` and hub activity contracts | Insert accepted audit in the mutation transaction; publish only after commit. |
| Task output / summary | `server/src/services/task-outputs.ts`, `server/src/services/run-summary-comment.ts` | Reuse provider/external idempotency, primary/review semantics, and summary formatting; add durable projection identity rather than a parallel store. |
| Current execution sources | `server/src/services/heartbeat.ts`, Commander runner, crew runner, extraction/compaction/readiness services | JOB-010–014 provide admission/projection bridge seams and parity tests. The current path stays authoritative until MIG-005/006/007. |

---

## 2. Control-plane shape and transaction rules

### Source of truth and synchronization

| Aggregate/fact | Authority | Synchronization rule |
|---|---|---|
| Job, attempt, placement, lease, fence, accepted event/control, projection receipt | PostgreSQL E2/E3 tenant tables | Single writer in the tenant transaction. Worker state is a report; no peer sync or permanent dual write. |
| Registered target policy/profile | Existing `execution_targets` registry; E2 `workers` holds device/logical-profile identity | Server profile and generation are authoritative; worker hello can only narrow eligibility. |
| Legacy assignment/approval/budget/cost/activity/output | Existing product tables/services | E3 invokes the current engine transactionally and stores only a linking receipt. Ownership transfers only in E10. |
| Immutable input/base/policy hashes | Job row plus Git/object manifest references | References are immutable; E3 does not copy repository or object bytes into the DB. |
| Event/output observation | Worker, until accepted | It becomes authoritative only after digest, tenant, active-fence, sequence, state, and policy checks commit. |
| Ready signal | Job outbox, then one non-authoritative Organization/target coalesced bit (no attempt ID) | Loss/duplication may affect only the bounded `no_work` retry delay. Poll always starts at the canonical database head and rechecks every authority condition. |

### Frozen lifecycle application

E3 calls E1 transition predicates directly. Database checks constrain membership; services
own guarded edges and test the exhaustive allowed/forbidden Cartesian matrix.

```text
job:     queued -> running -> succeeded | failed | dead_letter
           |          |
           +-----> cancel_requested -> cancelled | failed | dead_letter

attempt: pending -> offered -> leased -> running -> succeeded | failed
            |         |         |          |
            +---------+---------+------> cancel_requested -> cancelled | succeeded | failed | expired
            \---------\---------\--------------------------> expired/cancelled

lease:   offered -> active -> released
            |         |
            +---------+-> expired | revoked
```

`failed` requires E1 `non_retryable_failure`; `dead_letter` requires
`policy_exhausted`. Retrying creates a new attempt. Terminal job/attempt/lease rows are
immutable. Browser-session and service desired/instance machines remain distinct and are
never collapsed into these delivery states.

```text
authenticated caller / worker session / operator
                    |
       resolve Organization + Company + actor
                    |
       runInTenant(non-owner appDb, orgId)
                    |
       +------------+------------------------------+
       | tenant repositories (FORCE RLS)           |
       | optional callback-local tx bridge          |
       +------------+------------------------------+
                    |
 submit -> immutable job + attempt + outbox (one tx)
                    |
 placement -> one server decision, no job disclosure
                    |
 poll -> lock oldest eligible attempt -> offered lease/fence
                    |
 ACK -> active lease -> renew/events/controls/completion
                    |
 every governed write calls authorizeActiveFence(...)
                    |
 stale/replaced/terminal -> reject; output quarantine only
```

Inline ASCII comments explaining this ordering belong in
`packages/db/src/repositories/tenant/job-control.ts` (claim/fence predicates),
`server/src/services/job-leasing.ts` (placement → lock → lease),
`server/src/services/job-events.ts` (digest → identity/fence → sequence → projection → ACK),
and `server/src/services/job-reconciliation.ts` (cancel/expire/retry winner ordering).

### Shared database changes

E3 primarily extends E2 tables. New tenant tables are limited to durable facts that do
not fit an existing aggregate:

| Owner ticket | Schema module | Purpose / key constraints |
|---|---|---|
| JOB-001 | `packages/db/src/schema/job_outbox.ts` | Transactional attempt-ready notification. Unique `(organization_id, attempt_id, kind)`; bounded claim/retry metadata; payload contains identifiers only. JOB-006 writes a new row atomically with every retry attempt. |
| JOB-002 | `packages/db/src/schema/worker_enrollment_code_routes.ts` | Opaque, unguessable locator hash→candidate Organization shard (or platform) for enrollment routing only. Operator-readable; tenant sessions insert only their current-Org rows and operator sessions insert only null-Org platform rows under FORCE RLS. Contains no secret hash/result and is never admission/consumption authority. |
| JOB-002 | `packages/db/src/schema/worker_enrollment_codes.ts` | FORCE-RLS hashed single-use code authority: Organization/owner rows have non-null Organization and are consumed with worker profile+semantic replay result in one `runInTenant`; platform rows are null-Org and commit with the platform profile in one operator transaction. Same target/key/digest can replay after a lost response; changed digest conflicts. Raw code/session material is never stored. |
| JOB-002 | `packages/db/src/schema/worker_proof_replays.ts` | Operator metadata anti-replay register keyed by `(device_thumbprint, proof_id)` with issued/expiry timestamps and no request body/tenant payload. Fresh proof IDs are required even when the E1 semantic idempotency key is retried. |
| JOB-003 | `packages/db/src/schema/worker_operation_receipts.ts` | Tenant RLS receipts for E1 ACK/renew idempotent retry. Unique `(organization_id, company_id, worker_id, operation, idempotency_key)` plus composite lease/attempt FKs, semantic request digest, and bounded response fields; JOB-004 extends it for renew. |
| JOB-003 | `packages/db/src/schema/worker_lease_rejections.ts` | Tenant FORCE-RLS negative eligibility certificates. At most one row per `(organization_id, worker_id, attempt_id)`; exact composite attempt and logical-worker/target FKs; static matcher/context version, complete placement tuple/digests, closed reason code, and no payload/secret. Certificates are derived exclusion evidence only, never lease authority. |
| JOB-005 | `packages/db/src/schema/job_events.ts` | Immutable accepted event bytes/digest with unique `(organization_id, event_id)` and `(organization_id, attempt_id, sequence)`. |
| JOB-006 | `packages/db/src/schema/job_control_commands.ts` | Durable cancel/drain/graceful-stop command sequence and worker ACK, unique per lease/command id. |
| JOB-005 | `packages/db/src/schema/job_projection_receipts.ts` | Idempotency state machine for accepted state projection and later calls into existing approval/budget/audit/output engines. Unique `(organization_id, company_id, projection_kind, source_identity)` plus `source_digest`, `job_id`, `attempt_id`, `source_fence`, `status=pending|applied`, `target_aggregate_id`, `created_at`, `applied_at`. Same identity/different digest is a hard conflict; pending is crash-recoverable; applied replays. Prefer an existing legacy unique key when it proves the same authority. |
| JOB-007 | `packages/db/src/schema/execution_target_revocations.ts` | Operator-metadata-only durable fanout record for a committed target generation cutoff. Unique `(target_id, revoked_generation)` with bounded scan/retry/cursor state; contains no job/event/secret data and is not lease authority. |

JOB-003 does **not** add a worker cursor. To remain inside locked Decision #19/AGENTS migration
authority without any cross-migration statement reordering, generated successor `0229` adds only the
worker parent UNIQUE
`(organization_id, id, target_authority_key, execution_target_id)`. After that generated
migration and snapshot exist, generated successor `0230` creates `worker_lease_rejections`,
its child FKs/indexes, and replaces the same-named all-ascending `jobs_claim_idx` with
`(organization_id ASC, status ASC, available_at ASC, priority DESC, created_at ASC, id ASC)`.
It also adds partial `job_attempts_lease_candidate_idx` on
`(organization_id, placement_target_id, job_id, id)` for rows whose status is `pending`,
placement disposition/mode are `selected`/`active`, and `placement_lease_eligible=true`.
The generated migrations are C14-replayable; `0230` drops the old index with `IF EXISTS` before
creating the corrected definition with `IF NOT EXISTS`; a create-only guard that silently
retains the old priority direction is forbidden. Custom Decision #122 successor `0231`
revokes PUBLIC and `aoa_operator`, grants exactly `SELECT`, `INSERT`, `UPDATE`, and `DELETE`
to `aoa_app`, and ENABLEs/FORCEs tenant RLS on the certificate table. The same four privileges
must be added to `JOB_LEASING_NEW_PATH_GRANTS.worker_lease_rejections`; the exact startup
authority audit and its contract test must fail before that allowlist change and pass after it.
No migration changes E1, operator job authority, or a public API. The two-step generated
sequence is mandatory: `0229` must apply successfully before `0230` is generated/applied, and
the populated-chain test must prove the parent UNIQUE exists before the child FK. Combining
them into one generated migration, reordering statements, or hand-authoring replacement DDL
is forbidden.

The generated certificate columns are exact: `organization_id`, `company_id`, `job_id`,
`attempt_id`, `worker_id`, `target_id`, `target_authority_key`, `eligibility_version`,
`static_context_hash`, `workload_type`, `placement_owner`, `placement_target_class`,
`placement_target_scope`, `placement_target_generation`, `placement_profile_hash`,
`placement_provider_constraint_hash`, `placement_input_digest`, `placement_policy_digest`,
`reason_code`, `created_at`, and `updated_at`. Hash/digest columns require lowercase SHA-256;
generation/version are positive; workload/placement/reason values use their closed existing
vocabularies, with reason fixed to `static_requirements_mismatch`. The composite primary/
unique key is `(organization_id, worker_id, attempt_id)`. No JSON request, capacity snapshot,
job input, proof, fence, credential, lease ID, or operator-visible payload is stored.
Generated child indexes cover `(organization_id, company_id, job_id, attempt_id)` for cascade/
cleanup and `(organization_id, updated_at, worker_id, attempt_id)` for bounded stale sweeps;
the primary key supplies the candidate anti-join lookup.

Each new table has non-null Organization identity, Company identity where applicable,
composite tenant FKs, repository-only access, FORCE RLS, and grants to `aoa_app`. Normal
table/column/index/FK DDL comes only from Drizzle schema plus generated migrations. For
each new RLS table, generate a separate delta-free `--custom` RLS migration per E2-D01 /
Decision #122. Hand-added SQL is limited to C14 idempotency guards and #122 role/GRANT/
FORCE/POLICY DDL. Expected first migration is `0213`, but execution always uses the next
unused number produced by drizzle-kit.

The operator-readable enrollment route, platform enrollment rows, proof-replay, and revocation
metadata are exceptions to ordinary tenant visibility, not to least privilege. Organization/
owner code authority remains tenant RLS data; `aoa_operator` can read its opaque routing row
but cannot read/consume its code row. These paths use the E3-F001/E3-F002-approved non-owner
policies and expose no tenant job/event/secret payload. Proof IDs/operation receipts use
expiry indexes, bounded batch deletion, and a minimum retention of session expiry plus maximum
clock skew/retry window; cleanup never removes an unexpired replay defense or an operation
receipt still needed by a live lease/enrollment response. D1 query-plan and restart tests
cover replay lookup and cleanup. No in-memory replay cache is correctness authority.
The raw enrollment code has independent ≥128-bit locator and secret components. Only their
hashes persist. Issuance inserts route+code atomically in the owning tenant transaction (or
one platform operator transaction). Enrollment uses the locator row only to choose a candidate
shard, then `runInTenant` revalidates target/scope/code secret and atomically consumes the code,
creates/rotates the worker, and records the semantic result. Missing/stale/wrong-shard lookups
are indistinguishable from an invalid code. Route cleanup cannot precede its authoritative
code/receipt retention.

Parity bridges require one non-owner transaction to call existing legacy tables. E2's
current `0211` grants `aoa_app` only the eight new-path tables, despite the locked E2-D03
contract and handoff prose. E3 therefore never assumes legacy access exists and never falls
back to the owner pool. The exact serving role and grants below are **conditional on the
operator's E3-F001 choice**: option A grants the locked full legacy DML surface to `aoa_app`;
option B grants only the traced tables to `aoa_app`; option C grants those traced legacy
tables **and** the required new-path receipt/job operations to `aoa_bridge`, adds explicit
Decision #122 FORCE-RLS policies for that role, and passes that non-owner pool through the
existing mandatory `runInTenant` entry point with identical Organization-setting and
fail-closed semantics. JOB-001 needs read access to `organizations`,
`companies`, `organization_memberships`, and `company_memberships` for admission/
authorization edge checks; JOB-002/009 need the approved access to both `workers` and
`execution_targets` for registry/profile resolution and revocation recheck. The traced
parity surfaces are:
JOB-010 (`issues`, `heartbeat_runs`
and exact source-claim tables reached by the traced services); JOB-011 (`approvals`,
`agent_runtime_decisions`, `internal_agent_runtime_approvals`); JOB-012
(`budget_policies`, `budget_incidents`, `cost_events` plus the existing counter rows touched
by the budget service); JOB-013 (`activity_log`); JOB-014 (`task_outputs`,
`issue_comments` and the task terminal row). These legacy tables remain CAV-005 app-layer
isolated—no RLS retrofit. Every bridge validates the Organization→Company edge before the
legacy service call, passes the callback-local transaction to that service, and runs direct
cross-Company negative tests. A reviewer must verify the service query trace and narrow the
grant list before each migration is accepted; any unexpected table is a plan amendment, not
an owner-pool escape.

`server/src/db/job-control-legacy-grants.ts` is the reviewed trace/allowlist for options B/C
(and a regression inventory under option A), and
`server/src/__tests__/job-control-legacy-grants.contract.test.ts` compares it with every
custom GRANT migration. Under options B/C it rejects wildcard schema/table grants; under
option A it instead proves the locked full-DML surface and whole-app non-owner cutover.
Privilege tests connect as the operator-approved serving role: required operations succeed
only through the owning bridge, an unapproved legacy operation remains permission-denied
where the chosen contract promises that restriction, and cross-Company rows remain denied
by the bridge's application guard.

Granting a table is not enough to make a legacy helper safe in an outer transaction.
`runInTenant`'s additive callback-local control context registers durable/awaited mutation
work separately from after-commit effects. Ticket adapters must change existing helpers so:

- checkout, runtime-decision, budget hard-stop, cost/counter, activity insert, output, and
  summary mutations are awaited and throw on failure before a receipt becomes `applied`;
- `issueService`/budget/runtime-decision/activity live publications are returned or
  registered as after-commit effects rather than emitted inside the outer transaction;
- fire-and-forget budget evaluation is replaced by an awaited transaction-scoped policy
  evaluation for distributed mutations; and
- `run-summary-comment` cannot swallow an error that would otherwise leave an applied
  receipt without a summary.

The existing one-argument `fn(repos)` form stays source-compatible. The additive form is
conceptually `fn(repos, { tx, afterCommit(effect) })`; the transaction handle/context cannot
escape. `runInTenant` executes registered publication effects only after `withTenantTx`
returns successfully. The current live publications are best-effort cache/UI invalidations,
not a durable correctness channel: failure is logged and metered and clients recover by the
existing read/refresh path. A ticket that needs guaranteed delivery must name and test a
durable outbox before implementation; it may not pretend a projection receipt retries an
unrelated live publication. A receipt may be committed `pending` with its accepted source;
the later projection transaction locks it, invokes the required legacy mutation, and marks
it `applied` atomically, so a crash rolls both steps back to pending. If projection is
synchronous with the source mutation, receipt insert/lock, legacy mutation, and `applied`
all occur in that one transaction.

```powershell
function Invoke-NativeGate([string]$Label, [scriptblock]$Command) {
  $priorErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Stop'
  try {
    $global:LASTEXITCODE = 0
    & $Command
    $invocationSucceeded = $?
    $code = $global:LASTEXITCODE
  }
  catch { throw "$Label failed before a valid native exit: $($_.Exception.Message)" }
  finally { $ErrorActionPreference = $priorErrorAction }
  if (-not $invocationSucceeded -or $code -ne 0) {
    throw "$Label failed with native exit $code"
  }
}

$migrationSlug = 'job_control_submission' # JOB-001 exact example; use the owner map below.
Invoke-NativeGate 'db build before generation' { pnpm --filter @armyofagents/db build }
Push-Location packages/db
try {
  Invoke-NativeGate 'Drizzle generated migration' { pnpm exec drizzle-kit generate --name=$migrationSlug }
  # Add C14 IF NOT EXISTS guards to each generated CREATE TABLE/INDEX.
  Invoke-NativeGate 'Drizzle custom RLS migration' { pnpm exec drizzle-kit generate --custom --name="${migrationSlug}_rls" }
  # Add only idempotent #122 role/GRANT/ENABLE/FORCE/POLICY statements.
}
finally { Pop-Location }
```

Migration slugs are fixed per owner: JOB-001 `job_control_submission`, JOB-002
`worker_enrollment`, JOB-009 `job_placement`, JOB-003 `job_leasing`, JOB-005 `job_events`,
JOB-006 `job_controls`, and JOB-007 `job_quotas_revocation`. If drizzle-kit coalesces an
adjacent schema diff, the ticket ledger records the generated number/name and no later ticket
regenerates or hand-renumbers it.

JOB-001 adds the existing workspace package `@armyofagents/worker-protocol: workspace:*`
to `server/package.json`; `server` currently has no declared E1 dependency and must consume
the reviewed package root rather than copy its schemas. Commit `server/package.json` and the
regenerated `pnpm-lock.yaml` together after `pnpm install --no-frozen-lockfile`, then prove
`pnpm install --frozen-lockfile` is a no-op. No external dependency is expected. Any other
dependency is a STOP for controller approval. Schema-only changes commit schema, generated
migration, migration metadata, and tests; they do not fabricate a lockfile change.
This manifest change is blocked by E3-F004 until the Protocol/Schema Custodian corrects and
re-certifies `check:frozen-worker-protocol-v1`; JOB-001 then runs that check against E1's
recorded source SHA before and after its dependency commit.

```powershell
Invoke-NativeGate 'regenerate manifest lockfile' { pnpm install --no-frozen-lockfile }
Invoke-NativeGate 'verify frozen lockfile' { pnpm install --frozen-lockfile }
```

### Shared fence authorization

`packages/db/src/repositories/tenant/job-control.ts` owns one conditional predicate,
conceptually:

```ts
authorizeActiveFence({ organizationId, jobId, attemptId, leaseId, workerId,
  targetId, targetGeneration, fence })
```

Authorization succeeds only when the same tenant row is the current nonterminal attempt,
the lease is `active`, unexpired, unrevoked, matches worker/target/generation, carries the
exact opaque fence, and the current worker/target authority still has the same active
generation. Expiry compares `expires_at > clock_timestamp()` inside the conditional SQL
mutation; PostgreSQL `now()`/`transaction_timestamp()` and server/worker time are forbidden
because a transaction may cross the deadline. Worker `observedAt`, `ackedAt`, or event
timestamps are evidence only and never authorize time. For Organization/owner targets, the
current-generation recheck locks the exact tenant-visible `execution_targets` authority row
and the governed mutation executes in the same tenant transaction. For a platform target,
Decision #124 keeps the authenticated `runInTenant` app transaction outermost. Inside it, a
bounded operator transaction locks the exact physical target and then physical worker
`FOR SHARE` in that fixed order and validates only active generation/device/profile metadata.
While those row locks remain held, the already-open app transaction acquires the
domain-separated transaction-scoped shared advisory lock for the target and performs a plain
SELECT recheck of the null-Organization target; it never requests an UPDATE row lock or wider
RLS policy. Operator validation must then commit successfully before the app transaction may
mutate tenant state. The app transaction retains the advisory lock through its own commit.
Operator failure forces app rollback; app/process failure rolls back and automatically
releases the advisory lock. All nested pool use is app→operator, never operator→app.

Every platform status/generation/device-binding/registered-profile cutoff path locks the
physical target and then its bound worker when present `FOR UPDATE`, acquires the matching
transaction-scoped exclusive advisory lock, and only then mutates. Last-seen-only heartbeat updates are split
from authority changes and need not take the exclusive lock. Locks have a bounded timeout and
fail closed. Thus guard-first tenant work commits before cutoff, while cutoff-first work waits
at the physical row handoff and then observes the changed authority; there is no check-then-
write gap, grant expansion, or distributed two-phase commit. Platform revocation cannot
update every tenant RLS shard in one transaction. Its operator transaction uses the
exclusive protocol above, increments generation/disables the target, and inserts a durable
revocation-fanout record.
That commit is the linearization point: a guard that locked first may finish before cutoff;
one that starts or resumes after waits and fails the new generation/status check. An
idempotent reconciler then enumerates admitted Organizations and, separately inside each
`runInTenant`, marks old-generation leases revoked, requests attempt cancellation, and queues
termination controls. Crash between cutoff and fanout never restores write authority and the
durable scan resumes to convergence. Organization/owner targets may combine cutoff and their
single tenant's lease updates only when the approved role can do so in one `runInTenant`
transaction. Replacing or expiring a lease first makes the old predicate false; no cleanup
path revives it.

The governed repository surface is closed and enumerated: event acceptance; artifact
metadata/ordinary-commit authorization; secret-handle read; attempt/job terminal completion;
service-instance health; projection-receipt apply; and control-command ACK. A static contract
test imports every exported governed mutator from the tenant repository and fails if it does
not call the common active-fence predicate. The pre-JOB-005 surfaces may initially be test
stubs, but JOB-004 owns the guard contract before later tickets fill them in.

### API and flag surface

- Tenant/operator: `POST/GET /api/organizations/:organizationId/companies/:companyId/jobs`
  and `/job-control/*` status/control routes.
- Enrollment administration extends `/api/organizations/:organizationId/execution-targets/*`;
  platform profiles remain operator-only and never appear in tenant enumeration.
- Worker protocol: `/api/worker-control/enroll`, `/poll`, `/leases/:leaseId/ack`,
  `/renew`, `/events`, and `/control-acks`; every route validates the frozen v1 schema,
  auth audience, target, generation, and anti-replay identity.
- With the deployment flag off, worker/job-control route composition is absent and no
  outbox/sweeper starts. Enabling the deployment flag exposes dormant tested control-plane
  APIs but still cannot transfer an Organization/workload's execution authority.
- Worker errors use E1 `ProtocolErrorV1`; tenant/operator endpoints use existing
  `400/401/403/404/409/422/500` envelopes. Cross-tenant and absent identities have the same
  response status/body/timing class to the extent testable.

E1 operation idempotency is distinct from device-proof anti-replay. For `enrollment`,
`lease_ack`, and `lease_renew`, the authenticated scope plus E1 `idempotencyKey` indexes a
durable semantic receipt. Its request digest covers audience, authenticated worker/target/
generation, body, and enrollment public-key/binding facts, but excludes correlation ID,
fresh proof ID/signature, and transport timestamps. Same key+digest with a new valid device
proof replays the stored E1 outcome/authority without reapplying the effect; changed digest
returns the operation's allowed generic `malformed` error without an existence signal. A
retry always uses a fresh proof ID over the same E1 idempotency key. Enrollment stores its
receipt on the retained hashed-code row and may mint a new equivalent proof-bound session
header for the same enrolled identity; ACK/renew store bounded response fields in
`worker_operation_receipts`. Receipts are written atomically only for committed success or
deterministic rejection outcomes; pre-auth failures and `throttled`/`internal_unavailable`
leave no misleading receipt. No plaintext token or event/job payload is stored there.

Worker polling never scans tenant job rows globally. Organization/dedicated/owner logical
sessions, including Organization-scoped profiles backed by a platform target, enter exactly
their authenticated Organization. A platform-scoped physical session never polls tenant
work, selects a shard, or consumes a ready signal. Each logical poll drains at most one
coalesced signal for its exact Organization/target and then performs the same bounded tenant-
local pull through one `runInTenant`; the signal can shorten a `no_work` retry from 750 ms to
100 ms but cannot identify, rank, filter, or authorize a candidate. That transaction must
confirm placement/profile/capability/authority and atomically claim the database-ordered
oldest claimable row before releasing job details.

Separately, the flag-on JOB-001 outbox runtime lists only admitted Organization IDs from the
established registry through the bounded non-owner `aoa_app` pool. One rotating lexical tick
admits at most 32 Organization shards during one 750-ms monotonic **launch window**, claiming
each Organization's outbox only inside its separate `runInTenant` and publishing an
Organization/target coalesced signal. The window is checked before every page read, shard
transaction, individual signal publication, and delivery transaction; already-launched work
is awaited and may finish after the window. It is not a cumulative database-time,
cancellation, response-time, or hard-wall-clock guarantee. Exhaustion resumes from the fair
cursor on the next non-overlapping tick rather than continuing an unbounded loop. A missed,
rejected, expired, or lost signal can delay the next client retry but can never grant
authority; tenant-local pull, outbox replay, and the reconciliation sweep recover after
restart and membership churn. Operator job/event/worker endpoints use opaque `(createdAt,
id)` cursors with a default page of 50 and hard maximum 200.

Required query shapes/indexes are explicit: job claim
`(organization_id ASC, status ASC, available_at ASC, priority DESC, created_at ASC, id ASC)` with placed/queued
predicate; outbox claim `(organization_id, status, available_at, created_at, id)`; active
lease expiry `(organization_id, status, expires_at)`; pending control
`(organization_id, lease_id, status, sequence)`; event list
`(organization_id, attempt_id, sequence)`; and operator job list
`(organization_id, company_id, created_at, id)`. D1 records `EXPLAIN (ANALYZE, BUFFERS)` for
claim/sweep/list at gate volume and fails on sequential scans of the hot tables.

### Accepted-caveat / target-impact matrix

| Ticket(s) | Target / credential / locality / fallback and accepted-caveat impact |
|---|---|
| JOB-001 | Persists immutable requirements and credential handles only; no target contact. Admission denies sentinel/unmapped Org. |
| JOB-002 | Owns scope/owner/device/generation/session binding; raw credentials never persist. CAV-002: no Firecracker capability claim. |
| JOB-009 | Owns target class/scope/trust/provider/locality/credential/fallback decision. Unsupported provider/target features fail closed under CAV-002. |
| JOB-003 | Consumes the frozen placement; cannot widen target/fallback or reveal details to an incompatible worker. |
| JOB-004/005 | CAV-004: stale/offline workers cannot commit; event buffering does not preserve authority. |
| JOB-006 | CAV-003: every recovery/handoff is a new attempt/fence; CAV-004 late output is quarantine-only. |
| JOB-007 | Revocation and limits are server authority; immutable fallback alone may requeue to another target. |
| JOB-008 | Displays redacted target/reason metadata, never credentials or cross-tenant IDs; manual refresh until realtime gate. |
| JOB-010 | Source admission preserves current owner/assignment/claim; no target cutover. |
| JOB-011 | CAV-001: `park_run` releases managed compute and resumes under a new attempt/fence; no paused E2B VM. |
| JOB-012/013 | No new target/credential authority; accounting/audit use the placed job identity and existing engines. |
| JOB-014 | CAV-004: losing/offline artifacts remain quarantined and cannot become output; no automatic promotion. |

---

## 3. TDD, evidence, and commit protocol for every ticket

1. The controller creates `tickets/JOB-0XX-result.md` with the exact bare 40-hex Start
   SHA, `Status` and `Disposition` backtick-wrapped, named implementer/reviewer, acceptance
   checklist, and command ledger. JOB-001 uses the E3 Start SHA above; later tickets use
   their actual assignment SHA.
2. A fresh implementer writes focused tests first and commits/records a genuine RED on the
   unchanged behavior. The controller inspects the failure and rejects false REDs caused by
   imports, build order, or environment setup.
3. The implementer makes the smallest GREEN change, runs focused acceptance plus affected
   package typecheck/build, updates `findings.md` for non-obvious discoveries, and commits.
4. A DISTINCT reviewer checks the reviewed 40-hex revision (an ancestor of HEAD), reruns the
   focused command on that revision, appends review attempt 1, and uses plain `git commit`.
   Only the reviewer changes ticket `Status` to `complete`.
5. Any H-01/H-02/H-03 failure is a non-waivable `fail`; stop downstream assignment. A
   dependency, protocol, canonical-scope, or frozen-main contradiction is a STOP and plan
   amendment, never an improvised implementation.

Common affected-package commands:

```powershell
function Invoke-NativeGate([string]$Label, [scriptblock]$Command) {
  $priorErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Stop'
  try {
    $global:LASTEXITCODE = 0
    & $Command
    $invocationSucceeded = $?
    $code = $global:LASTEXITCODE
  }
  catch { throw "$Label failed before a valid native exit: $($_.Exception.Message)" }
  finally { $ErrorActionPreference = $priorErrorAction }
  if (-not $invocationSucceeded -or $code -ne 0) {
    throw "$Label failed with native exit $code"
  }
}

function Invoke-E3Integration([scriptblock]$Body) {
  $env:AOA_RUN_WIN_INTEGRATION = '1'
  try { & $Body }
  finally { Remove-Item Env:AOA_RUN_WIN_INTEGRATION -ErrorAction SilentlyContinue }
}

Invoke-NativeGate 'db typecheck' { pnpm --filter @armyofagents/db typecheck }
Invoke-NativeGate 'db build' { pnpm --filter @armyofagents/db build }
Invoke-NativeGate 'shared typecheck' { pnpm --filter @armyofagents/shared typecheck }
Invoke-NativeGate 'shared build' { pnpm --filter @armyofagents/shared build }
Invoke-NativeGate 'server typecheck' { pnpm --filter @armyofagents/server typecheck }
Invoke-NativeGate 'server build' { pnpm --filter @armyofagents/server build }
Invoke-NativeGate 'ui typecheck' { pnpm --filter @armyofagents/ui typecheck }
Invoke-NativeGate 'ui build' { pnpm --filter @armyofagents/ui build }

# Real PostgreSQL lane from short path C:\e3. Each integration file uses
# describe.skipIf(process.platform === "win32" && AOA_RUN_WIN_INTEGRATION !== "1")
# and embedded-postgres initdb flags --encoding=UTF8 --locale=C.
Invoke-E3Integration {
  Invoke-NativeGate '<suite>' {
    pnpm --filter @armyofagents/server exec vitest run src/__tests__/<suite>.integration.test.ts
  }
}
```

Every ledger runs each native process through `Invoke-NativeGate`; cleanup lives only in
`finally`. A later successful PowerShell cmdlet may never mask a failed test. RED and GREEN
use the identical helper invocation and record the failing/passing native exit code.

Tests are hermetic: fake clock, deterministic UUID/digest fixtures, embedded PostgreSQL,
no live provider/network/customer data/credential. Every focused result records command,
exit code, test count, duration, platform, and exact revision.

Focused commands (the implementer first records the expected assertion failure, then reruns
the identical command GREEN; append the affected package typecheck/build commands above):

| Ticket | Exact focused command from `C:\e3` |
|---|---|
| JOB-001 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-001 db' { pnpm --filter @armyofagents/db exec vitest run src/__tests__/job-control-schema.integration.test.ts src/__tests__/migration-idempotency.test.ts }; Invoke-NativeGate 'JOB-001 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-submission.integration.test.ts src/__tests__/tenant-app-db-startup.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts src/__tests__/integration-test-hygiene.test.ts } }; Invoke-NativeGate 'JOB-001 frozen consumer' { pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870ce7509d8baa75409e0ab19da375c88a }` |
| JOB-002 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-002 db' { pnpm --filter @armyofagents/db exec vitest run src/__tests__/worker-enrollment-schema.integration.test.ts src/__tests__/worker-operator-policy.integration.test.ts src/__tests__/migration-idempotency.test.ts }; Invoke-NativeGate 'JOB-002 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/worker-enrollment.integration.test.ts src/__tests__/worker-session-auth.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts } }` |
| JOB-009 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-009 db' { pnpm --filter @armyofagents/db exec vitest run src/__tests__/migration-idempotency.test.ts }; Invoke-NativeGate 'JOB-009 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-placement.property.test.ts src/__tests__/job-placement.integration.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts } }` |
| JOB-003 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-003 db' { pnpm --filter @armyofagents/db exec vitest run src/__tests__/job-control-schema.integration.test.ts src/__tests__/worker-operation-receipts-schema.integration.test.ts src/__tests__/worker-lease-rejections-schema.integration.test.ts src/__tests__/platform-target-authority-lock.integration.test.ts src/__tests__/job-leasing-migration-upgrade.integration.test.ts src/__tests__/worker-operator-policy.integration.test.ts src/__tests__/migration-idempotency.test.ts }; Invoke-NativeGate 'JOB-003 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-leasing.integration.test.ts src/__tests__/job-lease-eligibility.test.ts src/__tests__/job-leasing-contract.test.ts src/__tests__/job-control-runtime.test.ts src/__tests__/worker-enrollment.integration.test.ts src/__tests__/worker-session-auth.test.ts src/__tests__/job-placement.integration.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts src/__tests__/distributed-execution-db-startup.integration.test.ts src/__tests__/server-shutdown.test.ts }; Invoke-NativeGate 'JOB-003 load' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-leasing-load.integration.test.ts --maxWorkers=1 } }; Invoke-NativeGate 'JOB-003 perf runner' { node --test scripts/run-e3-perf-01.test.mjs }` |
| JOB-010 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-010 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-admission-parity.integration.test.ts src/__tests__/job-source-admission-matrix.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts src/__tests__/job-legacy-after-commit.integration.test.ts } }` |
| JOB-004 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-004 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-fencing.integration.test.ts src/__tests__/job-fence-surface.contract.test.ts } }` |
| JOB-005 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-005 db' { pnpm --filter @armyofagents/db exec vitest run src/__tests__/job-events-schema.integration.test.ts src/__tests__/migration-idempotency.test.ts }; Invoke-NativeGate 'JOB-005 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-events.integration.test.ts } }` |
| JOB-006 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-006 db' { pnpm --filter @armyofagents/db exec vitest run src/__tests__/job-controls-schema.integration.test.ts src/__tests__/migration-idempotency.test.ts }; Invoke-NativeGate 'JOB-006 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-reconciliation.integration.test.ts src/__tests__/job-control-commands.integration.test.ts } }` |
| JOB-007 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-007 db' { pnpm --filter @armyofagents/db exec vitest run src/__tests__/execution-target-revocations-schema.integration.test.ts src/__tests__/job-control-schema.integration.test.ts src/__tests__/migration-idempotency.test.ts }; Invoke-NativeGate 'JOB-007 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-quotas.integration.test.ts src/__tests__/worker-revocation.integration.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts } }` |
| JOB-008 | `Invoke-NativeGate 'JOB-008 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-operations-routes.test.ts }; Invoke-NativeGate 'JOB-008 ui' { pnpm --filter @armyofagents/ui exec vitest run src/__tests__/OperationsSection.test.tsx }` |
| JOB-011 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-011 db' { pnpm --filter @armyofagents/db exec vitest run src/__tests__/migration-idempotency.test.ts }; Invoke-NativeGate 'JOB-011 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-approval-parity.integration.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts src/__tests__/job-legacy-after-commit.integration.test.ts } }` |
| JOB-012 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-012 db' { pnpm --filter @armyofagents/db exec vitest run src/__tests__/migration-idempotency.test.ts }; Invoke-NativeGate 'JOB-012 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-budget-cost-parity.integration.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts src/__tests__/job-legacy-after-commit.integration.test.ts } }` |
| JOB-013 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-013 db' { pnpm --filter @armyofagents/db exec vitest run src/__tests__/migration-idempotency.test.ts }; Invoke-NativeGate 'JOB-013 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-audit-parity.integration.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts src/__tests__/job-legacy-after-commit.integration.test.ts } }` |
| JOB-014 | `Invoke-E3Integration { Invoke-NativeGate 'JOB-014 db' { pnpm --filter @armyofagents/db exec vitest run src/__tests__/migration-idempotency.test.ts }; Invoke-NativeGate 'JOB-014 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-output-parity.integration.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts src/__tests__/job-legacy-after-commit.integration.test.ts } }` |

---

## 4. Ticket implementation tasks

### JOB-001 — Submit immutable jobs transactionally (M, ≤3 agent-days, PRE-D1)

**Depends on:** PRT-003, TEN-003, TEN-006 — all passed.
**Outcome:** Authorized source submission commits one immutable job, initial attempt, and
one job-ready outbox row in a single tenant transaction.

**Ticket non-goals:** placement, leasing, worker dispatch/contact inside the transaction,
legacy cutover, and provider effects.

**Files:**
- Modify `packages/db/src/schema/jobs.ts`, `job_attempts.ts`, `schema/index.ts`.
- Create `packages/db/src/schema/job_outbox.ts`; extend
  `packages/db/src/repositories/tenant/index.ts`; create
  `packages/db/src/repositories/tenant/job-control.ts`.
- Modify `server/src/config.ts`, `server/src/index.ts`, `server/src/app.ts`,
  `server/src/db/tenant-context.ts`; create
  `server/src/db/job-control-legacy-grants.ts`; modify
  `server/src/services/tenant-admission.ts`.
- Modify `server/package.json` and regenerated `pnpm-lock.yaml` together to declare the
  frozen E1 package root.
- Create `packages/shared/src/validators/job-control.ts`,
  `packages/shared/src/types/job-control.ts`, `server/src/services/job-submission.ts`,
  `server/src/services/job-outbox.ts`,
  `server/src/routes/job-control.ts` and their barrel/API-path exports.
- Create `packages/db/src/__tests__/job-control-schema.integration.test.ts`,
  `server/src/__tests__/job-submission.integration.test.ts`, and
  `server/src/__tests__/tenant-app-db-startup.test.ts`; create shared
  `server/src/__tests__/job-control-legacy-grants.contract.test.ts`.

**Inputs/outputs:** External callers send a source-specific `SubmitJobCommand`, not an E1
`JobEnvelopeV1`. The command contains authenticated source intent and a bounded idempotency
key; it cannot choose job/attempt IDs, Organization/Company, requester authority, timestamps,
policy/input hashes, placement authority, or fence data. The server derives those fields
from the authenticated principal, admitted Organization→Company edge, current policy and
source engine, then persists the immutable facts. JOB-003 later constructs and validates the
E1 `JobEnvelopeV1` from those server-owned rows immediately before lease delivery. Output is
`{jobId, attemptId, status, replayed}` with no worker contact. Persist source kind/identity,
requester/executor, canonical input hash, policy snapshot/hash, requirements, immutable
placement request, priority/availability, and the first pending attempt plus attempt-ready
outbox row. A unique `(organization_id, company_id, authenticated_principal_kind,
authenticated_principal_id, authenticated_source_kind, authenticated_source_identity,
idempotency_key)` constraint returns the original identical submission; same scope/key with
a different canonical command digest is `409`. Two authorized principals using the same
client key cannot collide or observe one another's replay.
JOB-001 does not build the global drainer/fair scheduler; JOB-003 consumes the durable row.
This keeps submission within the ticket bound and ensures the notification's first consumer
is reviewed alongside atomic leasing.
`packages/shared` owns only board/operator/source submission DTOs; it does not duplicate E1
worker wire schemas. `server` imports validators/types from the built E1 package root only at
the worker-wire construction/validation boundary.

**Failure behavior:** malformed/protocol-invalid input is `400`; unauthorized requester,
wrong Company, forbidden sentinel, or unmapped Organization is a uniform denial before
persistence; owner-pool or missing non-owner URL fails flag-on boot; transaction/outbox
failure rolls back job and attempt; no post-commit notification is lost because the outbox
is authoritative. Logs/metrics contain IDs, source kind, replay flag, and reason code only.

**Compatibility / rollback:** additive columns/table/API. Generate normal + custom RLS
migrations. Flag-off omits routes and pool; rollback leaves inert outbox rows. Legacy
submission remains authoritative.

**RED → GREEN:**
- RED `job-submission.integration.test.ts`: duplicate-identical replay, changed-payload
  conflict, two principals using the same key, forced outbox insert failure rollback, 32 concurrent same-key submissions,
  all six source variants, requester/assignee mismatch, sentinel and nonexistent Org,
  foreign Company, and assertion that no worker adapter is called.
- RED startup test: flag on + blank/privileged app URL must fail; flag off must not open a
  serving pool.
- GREEN schema/repository/config/service/route; generate migrations; run:
  `Invoke-E3Integration { Invoke-NativeGate 'JOB-001 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-submission.integration.test.ts src/__tests__/tenant-app-db-startup.test.ts } }`.
- Run db/shared/server typecheck+build, protocol-boundary checks, and the corrected
  `check:frozen-worker-protocol-v1` against source SHA
  `b7a842870ce7509d8baa75409e0ab19da375c88a`. Expected E1 source/fixture diff: zero.

**Evidence / commit:** `tickets/JOB-001-result.md`; one schema/service commit
`feat(job-control): submit immutable tenant jobs`. Maps D0-T01/T03/T05, H-01, H-04.

**Internal TDD/commit slices (one ticket, one final reviewer):** A—declare E1 dependency,
non-owner startup/admission seam; B—schema/repository/migrations and attempt-ready outbox;
C—service/route/idempotency/concurrency. Each slice is independently green and ≤1 agent-day;
the reviewer reviews the combined revision and alone completes JOB-001.

### JOB-002 — Enroll workers with device-bound identity (M, ≤3 agent-days, PRE-D1)

**Depends on:** PRT-006, PRT-007, TEN-003 — passed.
**Outcome:** Extend the existing target registry with single-use enrollment and durable,
generation-bound logical worker profiles for platform, Organization, and owner scopes.

**Ticket non-goals:** scheduling, placement, execution, recovering a lost private device
key, or allowing worker-reported capability to change registered trust.

**Files:** modify `packages/db/src/schema/execution_targets.ts`, `workers.ts`,
`packages/db/src/client.ts`, repository modules; create
`packages/db/src/schema/worker_enrollment_code_routes.ts`,
`worker_enrollment_codes.ts`, and
`worker_proof_replays.ts` if E3-F005 selects application-layer proof; modify
`packages/shared/src/validators/execution-target.ts` and target constants; modify
`server/src/config.ts`, `server/src/index.ts`, `server/src/db/rls-tenant.ts`,
`server/src/services/execution-targets.ts`, `routes/execution-targets.ts`; create
`server/src/services/worker-enrollment.ts`, `routes/worker-control.ts`,
`middleware/worker-session-auth.ts`; tests
`packages/db/src/__tests__/worker-enrollment-schema.integration.test.ts`,
`server/src/__tests__/worker-enrollment.integration.test.ts` and
`worker-session-auth.test.ts`, plus a generated operator-role/policy custom migration and
its db/unit enforcement tests.

**Internal TDD/commit slices (one ticket, one final reviewer):** A—worker/target schema and
the operator-role correction chosen by the E3-F001 amendment; B—single-use enrollment and
device proof; C—session audience/generation/revocation. Each slice is ≤1 agent-day and no
slice is independently considered JOB-002 complete.

**Blocking contract decision (E3-F005):** E1's strict enrollment JSON has no device public
key/proof/session fields. A bearer token that merely contains a thumbprint is not device
bound. The recommended candidate preserves frozen E1 JSON and puts proof at the authenticated
HTTP transport boundary: a Node-native Ed25519 device key signs a canonical tuple of method,
normalized path, body SHA-256, E1 request/correlation identity, issued-at, and unique proof
ID. Enrollment supplies the public key and proof in versioned `AoA-Device-*` headers, consumes
the one-time code, and returns the short-lived session in an HTTP header whose claims include
the key thumbprint. Every poll/ACK/renew/event/control request must present a matching fresh
signature; the server enforces bounded clock skew and a database-unique proof ID until session
expiry. Rotation/reinstall increments generation and replaces the key. This candidate needs
an operator-approved threat model and exact header/canonicalization test vectors before
assignment. The alternative is an additive, versioned E1 body change, which triggers the
Protocol/Schema Custodian STOP and D0-T04 corpus. Pure bearer authentication is rejected.

**Interfaces:** Admin issues one hashed, expiring enrollment code for a registered target;
the raw locator+secret code is returned once and never logged. Organization/owner issuance
commits its route and authoritative code inside `runInTenant`; platform issuance commits both
with the platform target in one operator transaction. Enrollment uses the locator only to
discover a candidate shard. For Organization/owner it then consumes the unchanged E1 target-
enrollment request/response at the body boundary, verifies the approved device proof, and
atomically consumes code+creates/rotates profile+stores replay result in one `runInTenant`.
Platform enrollment performs the equivalent work in one operator transaction. It returns a
short-lived signed proof-bound session
with audience, worker, target, generation, scope, and device thumbprint. One physical device
key may back distinct Org-scoped logical profiles; it never confers cross-profile authority.
The existing `execution_targets.worker_token_hash` is bootstrap-only: successful enrollment
revokes/clears its worker-session authority, and no poll or governed operation accepts it.
Unenrolled legacy targets keep their current heartbeat credential; an enrolled target's
legacy heartbeat endpoint is upgraded to accept the proof-bound session so the authentication
upgrade does not itself transfer execution authority before E10.

The recommended registry binding is many logical `workers` profiles to one physical
`execution_targets` row, with database enforcement rather than a single target-ID FK.
JOB-002 adds explicit target scope plus a non-null, checked `target_authority_key` to the
registry (`platform`, `organization:<org-id>`, or `owner:<org-id>:<owner-id>`) and a unique
`(target_authority_key,id)` FK target. Each worker stores the selected authority key and
`execution_target_id`; a composite FK binds both to the same registry row. Worker CHECKs
permit only: platform profile→platform target; Organization profile→platform or the same
Organization target; owner profile→the same Organization+owner target. A foreign-Org target
therefore produces the same composite-FK failure as a nonexistent target and cannot become
an existence oracle. Platform targets may back multiple Organization-scoped profiles without
creating a second catalog. JOB-002 also migrates `workers.owner_user_id` from `uuid` to `text`
and adds the FK to `authUsers.id`, matching the existing target registry. Partial unique
constraints enforce one platform profile per target, one Organization profile per
`(organization,target)`, and one owner profile per `(organization,target,owner)`. This exact
binding, including safe migration/backfill of pre-E3 rows and database negative tests, must
be ratified with E3-F005 before assignment.

Organization/owner profiles and authoritative code/receipt rows are written through
`runInTenant`. **Conditional on the
E3-F001 operator choice**, the operator-metadata candidate writes/reads platform null-Org profiles
through a least-privilege `aoa_operator` role and JOB-002 Decision #122 custom policies on
both `workers` and the existing `execution_targets` registry. It can access only null-Org
registration/status/profile/enrollment/generation metadata, plus SELECT-only opaque locator→
candidate-shard rows in `worker_enrollment_code_routes`; it cannot read Organization/owner
code hashes/results, jobs, attempts,
leases, events, artifacts, or secret handles. `AOA_OPERATOR_DATABASE_URL` is explicit and
fail-closed. Tenant `aoa_app` sessions continue to see zero platform worker rows.

Platform authentication produces a bounded server-internal physical-control principal
`{workerId,targetId,targetGeneration,deviceThumbprint,profileHash,expiresAt}` with no tenant
or job data. Decision #124 forbids using that platform-scoped principal on tenant poll, ACK,
renew, event, control, artifact, secret, or completion paths. A device that serves tenant work
selects one of its Organization-scoped logical profiles and obtains an Organization-scoped
session whose worker ID, Organization, target, generation, device thumbprint, and profile
hash are server-bound. That authenticated Organization is the sole shard selector for
`runInTenant`; the logical worker ID is the lease/receipt foreign-key identity. The platform
physical row is never copied into a tenant lease and a signed physical snapshot alone never
authorizes tenant work. Tests deny the platform-scoped session uniformly and race one
platform revocation against logical-session ACK/renew/event/completion in two Organizations,
requiring both tenant paths to deny the old generation after cutoff.

**Failure behavior:** reused device proof ID/signature, expired code/session, key mismatch,
replaced generation, or revocation returns the closed unauthorized/target-revoked protocol
error before profile disclosure. In contrast, a lost-response retry with the same enrollment
code/authenticated scope/E1 idempotency key/semantic digest and a fresh valid proof replays the
stored `enrolled` identity without rotating or consuming twice; same key with a changed digest
is generic `malformed`. Forced worker/profile/receipt failure rolls back code consumption;
a stale or malicious route cannot select a different authoritative tenant. Tenant reads
never enumerate null-Org platform targets; owner removal or target transfer revokes refresh
and increments generation; deletion/reinstall creates new identity and cannot revive the
old session. Audit records issue/consume/rotate/revoke/transfer-denial without raw code/key.

**Compatibility / rollback:** extend the existing registry—no second catalog. Additive
Drizzle migration plus the operator-role/policy custom migration required above. Flag-off mounts no
enrollment route. Revocation remains safe during rollback; never re-enable a revoked
generation.

**RED → GREEN:** enrollment same-key/same-digest lost-response replay with fresh proof;
same-key/changed-digest conflict; consumed code with unrelated key; invalid/missing device
signature; proof-ID replay across replicas; replay-record expiry/cleanup and restart; clock
skew; body/path/method tamper; session copied without key; route-insert issuance rollback;
crash/failure after route lookup and at every code/profile/receipt statement; stale/wrong-shard
route with uniform denial;
platform operator auth; cross-tenant enumeration; wrong Org/owner; binding cardinality and
owner-ID migration; multi-Org profiles; owner membership removal; rotation, reinstall,
replacement, transfer denial, revocation, and wrong audience/target/generation. Run focused embedded-PG suite
and db/shared/server typecheck+build. Evidence `tickets/JOB-002-result.md`; commit
`feat(job-control): enroll device-bound workers`. Maps D0-T01/T03/T05, H-01/H-04.

### JOB-009 — Make hybrid target placement authoritative (M, ≤3 agent-days, PRE-D1)

**Depends on:** FND-002, PRT-006/007, TEN-003/004, JOB-001/002.
**Outcome:** Persist exactly one server-owned placement decision per attempt before lease.

**Ticket non-goals:** lease issuance, target cutover, provider execution, dynamic policy
rewrite, or implicit fallback.

**Files:** modify `jobs.ts`, `job_attempts.ts`, `execution_targets.ts`, tenant repositories,
shared job-control types; modify `server/src/services/execution-target-resolver.ts`; create
`server/src/services/job-placement.ts`; tests
`server/src/__tests__/job-placement.property.test.ts` and
`job-placement.integration.test.ts`.

**Interfaces:** Input combines immutable job requirements/fallback, deployment → Org →
workload rollout decision, credential binding, target scope/trust/locality/profile hash,
normalized provider constraints, registry health/capacity/generation, and E1 worker hello.
Output is an immutable placement decision `{owner, targetId, targetClass, targetScope,
targetGeneration, profileHash, providerConstraintHash, fallbackDisposition, reasonCode}` or
an attributable queued/failed reason. The worker never chooses or upgrades it.

**Failure behavior:** revoked/unmapped/offline/over-limit/hash-changed/owner-mismatched/
locality-incompatible targets queue or fail exactly per immutable fallback; forbidden
fallback never widens silently; shadow placement records a decision but is ineligible for
lease/effects. Platform targets are evaluated inside the job's tenant transaction and no
job details leave it until authorized.

**Compatibility / rollback:** additive decision columns/indexes. Legacy remains owner; flag
off performs no placement. A policy/profile mutation creates a new attempt/decision rather
than rewriting a prior decision.

**RED → GREEN:** deterministic property matrix across target scopes and all source kinds;
false privileged advertisement/provider ceiling; owner mismatch/removal; generation
replacement; concurrent capacity; drain/revoke; required offline; allowed/forbidden
fallback; personal credential vs shared target; local-only vs cloud; shadow no-effect;
deterministic replay. Run suite with 20 deterministic seeds locally (D1 later owns 20×10k),
then db/shared/server typecheck+build. Evidence `tickets/JOB-009-result.md`; commit
`feat(job-control): persist authoritative placement`. Maps D0-T01/T05, H-01/H-03/H-04.

**Internal TDD/commit slices (one canonical ticket, one final reviewer):** A—normalize the
target-authority schema/registry inputs and characterize the existing resolver, including
composite binding and cross-tenant denial; B—implement the pure deterministic placement
policy and seeded property matrix with no DB or lease side effects; C—persist the immutable
decision transactionally and prove concurrency, generation, capacity, shadow, and flag-off
behavior. Budget each slice at no more than one agent-day. Each slice records its own
RED/GREEN evidence, but JOB-009 remains `backlog` until one distinct reviewer reruns the
combined acceptance matrix on the reviewed revision and alone marks the ticket `complete`.

### JOB-003 — Lease and ACK compatible jobs atomically (M, ≤3 agent-days, PRE-D1)

**Depends on:** JOB-001, JOB-009, PRT-007.
**Outcome:** Eligible worker poll atomically returns at most one offer with a fresh fence;
ACK activates exactly that lease.

**Ticket non-goals:** renewal, event ingestion, retry/reaping, artifact bytes, or changing
the stored placement decision.

**Files:** modify `job_attempts.ts`, `leases.ts`, `jobs.ts`, `workers.ts`, tenant job-control and worker-enrollment
repositories, `packages/db/src/schema/index.ts`, `server/src/db/job-control-legacy-grants.ts`,
`server/src/middleware/worker-operation-proof.ts`,
`server/src/middleware/worker-session-auth.ts`, `server/src/services/worker-enrollment.ts`,
`server/src/services/execution-targets.ts`, the worker route, and the flag-on runtime
composition in `server/src/index.ts`; create
`packages/db/src/platform-target-authority-lock.ts` with the shared lock API,
`packages/db/src/repositories/operator/job-leasing.ts`,
`packages/db/src/schema/worker_operation_receipts.ts`, its generated/RLS migrations,
`packages/db/src/schema/worker_lease_rejections.ts`, generated `0229` + `0230` and custom `0231`,
`server/src/services/job-leasing.ts`,
`server/src/services/job-lease-eligibility.ts`,
`server/src/services/job-outbox-worker.ts`, and
`server/src/services/job-ready-scheduler.ts`; tests
`packages/db/src/__tests__/worker-operation-receipts-schema.integration.test.ts`,
`worker-lease-rejections-schema.integration.test.ts`,
`platform-target-authority-lock.integration.test.ts`, and
`job-leasing-migration-upgrade.integration.test.ts`,
`server/src/__tests__/job-leasing.integration.test.ts`, `job-control-runtime.test.ts`, and
`job-leasing-contract.test.ts`, `job-lease-eligibility.test.ts`, and
`job-leasing-load.integration.test.ts`; create `scripts/run-e3-perf-01.mjs` and
`scripts/run-e3-perf-01.test.mjs`, `scripts/e3-perf-01-manifest.schema.json`, and
`scripts/e3-perf-01-evidence.schema.json`; extend
`server/src/__tests__/job-control-legacy-grants.contract.test.ts` and
`distributed-execution-db-startup.integration.test.ts`, including runtime-composition, multi-Organization platform
target, advisory-handoff/revocation, authority-mutation-inventory, liveness, and fair-scheduler
cases. Predecessor file edits are bounded synchronization corrections only; they may not
change JOB-002 enrollment identity or JOB-009 placement semantics.

Review-attempt-2 corrections additionally generate the next unused Drizzle successor
(`0229` at the reviewed branch tip) for only the logical-worker composite parent UNIQUE, then
generate `0230` for the certificate table, its exact child FKs/indexes, and the corrected
mixed-direction jobs claim index; create custom RLS successor `0231`; add a database-keyset
admitted-Organization reader; and replace the platform-writer
substring test with an exhaustive AST/exact allowlist plus injected bypass fixtures. Normal
DDL remains Drizzle-generated. Hand edits are limited to C14 guards in `0229`/`0230` and
Decision #122 RLS/GRANT/POLICY DDL in custom `0231`; no cross-migration statement reorder is
authorized.

The shared DB helper exports
`acquirePlatformTargetAuthorityShared(tx, targetId)`,
`acquirePlatformTargetAuthorityExclusive(tx, targetId)`, and the bounded transaction lock-
timeout setup used before physical row locks. It validates a canonical UUID and uses the
two-int PostgreSQL advisory namespace `(1095713075, hashtext(targetId))`, where
`1095713075 = 0x414f4133` (`AOA3`). Both modes therefore derive the identical
domain-separated key; a rare hash collision may only over-serialize unrelated targets and
can never authorize one. The timeout is 750 ms through transaction-local `lock_timeout`;
timeout/cancellation maps to bounded `internal_unavailable` and never retries outside the
operation's existing idempotency contract.

The mandatory current writer inventory is explicit: platform physical enrollment/replacement
in `server/src/services/worker-enrollment.ts` and repository
`advanceTargetGeneration`/`rotateWorker`; shared-platform logical-enrollment validation before
its tenant profile/session commit; `heartbeatSessionTarget` in
`server/src/middleware/worker-session-auth.ts` (split last-seen-only writes from any status
transition); platform registered-profile ratification in
`server/src/services/execution-targets.ts`; and the platform revoke helper plus JOB-007's later
cutoff implementation. Each authority-changing path calls the exclusive helper and uses
target→bound-worker row order. JOB-009 placement keeps its existing app→operator order and is
rerun as a regression; it may not acquire an operator connection outside an app transaction.
The static contract fails when a new platform status/generation/device/profile mutation is
added without the exclusive helper.

**Interfaces:** Poll validates an E1 Organization-scoped logical worker
session/hello/capacity. A platform-scoped physical session is rejected before tenant lookup
with the uniform frozen protocol error and can reveal neither Organization nor job existence.
For an Organization/owner target, poll proceeds in one tenant transaction. For a platform
target, the outer tenant transaction performs the Decision #124 physical-row-to-shared-
advisory handoff and retains the advisory guard through commit. The authenticated session
Organization—not a request field,
operator lookup, lease locator, or scan—selects exactly one `runInTenant` transaction, which
selects the oldest eligible placed attempt with Drizzle's PostgreSQL row-lock
API (`FOR UPDATE SKIP LOCKED`), rechecks target/profile/generation/capability/capacity, moves
attempt `pending→offered`, and inserts the `offered` lease with server ACK deadline, expiry,
and opaque fence. One conditional ACK transaction locks the same identities and moves lease
`offered→active` plus attempt `offered→leased`; a late/wrong/replayed loser changes neither.
ACK uses the Organization and logical worker identity from the authenticated session, so the
strict frozen ACK v1 body and lease-only URL need no tenant field or extension. Platform
targets use the same advisory handoff across ACK's tenant commit; revocation-first observes
the new generation and denies, while ACK-first commits before the cutoff can acquire its
exclusive advisory lock.
For Organization/owner targets, logical worker and target heartbeat freshness remains part of
authority. For an Organization-scoped logical profile backed by a platform target, a fresh
session-bound device proof plus the guarded current physical worker/target heartbeat supplies
liveness; `workers.last_seen_at` on the logical profile is not a circular prerequisite and may
be NULL immediately after real enrollment. After all authority checks pass, the tenant
transaction updates only that exact logical profile's `last_seen_at` from
`clock_timestamp()` for observability. The physical worker remains eligible in exactly the
proof-bound `enrolled` or `active` states; the last-seen-only heartbeat does not promote
`enrolled` to `active`. Poll's `authorityCurrent` return, ACK's `ackAuthorityCurrent` return,
and the physical-authority guard each embed their own closed inline
`status === "enrolled" || status === "active"` predicate; no shared mutable set, helper, alias,
or precomputed boolean may supply it. The physical guard rejects
`!(physical.worker.status === "enrolled" || physical.worker.status === "active")` before claim,
and the poll/ACK rejection must dominate their respective lease effects. `draining`, `revoked`,
unknown, non-null `revoked_at`, or otherwise noncurrent physical authority denies. A stale
physical heartbeat still denies. The transaction also stores the ACK operation receipt. A
lost-response retry with the same
authenticated scope/idempotency key/semantic digest and a fresh device proof returns the
original `acknowledged` outcome even though the lease is already active; it never reapplies
the transition. Same key with a changed digest is generic `malformed`.
The job remains `queued` until JOB-005 accepts the first fence-authorized
`attempt_started` event, which moves attempt `leased→running` and job `queued→running` in the
event transaction. Incompatible/no-work responses reveal no job IDs/details.

Every authoritative poll starts at the global canonical head. After proof and authority
validation locks the authenticated logical worker, the service takes one database snapshot of
live lease totals for `batch`, `browser_session`, and `service`, constrained by the current
Organization, logical worker, and target. Provider-total, resource-ceiling, and normalized
resource-demand gates are therefore authenticated Organization-scoped logical-profile clamps,
not cross-tenant physical-target accounting. The service derives the currently admissible
workload classes from that logical profile's effective poll capacity and live class counts;
SQL excludes inadmissible classes before ordering. Dynamic slots, free resources, or live
counts are never encoded in a durable rejection. JOB-009's normalized provider demand is
derived solely from the already selected registered target, so the logical-profile resource
comparison is identical for every candidate in this poll; if it fails, the poll returns
`no_work` without scanning or certifying a job. Aggregate physical capacity across multiple
Organization profiles sharing one platform target remains WRK-003 scope. A two-tenant/same-
platform-target test must prove each logical poll counts only its own Organization profile's
leases and neither query can read or infer the other profile's capacity or jobs.

The server factors a static-only matcher adapter around frozen E1 matching. It uses the
authenticated stored worker profile/capability/protocol/policy facts and the registered target
and verified provider profile, while substituting neutral capacity facts only after every
dynamic capacity gate above has passed. An undifferentiated `workerSatisfiesRequirements`
`false` is never certifiable. Only the closed reason `static_requirements_mismatch` may create
a certificate. Placement normalization or envelope construction failure is an invariant
`internal_unavailable`, never a skippable rejection.
The neutral matcher capacity is exactly one slot for each workload class and zero free CPU,
memory, and disk; the frozen matcher uses those fields only for its already-hoisted
over-advertisement and nonzero-slot checks. The focused equivalence matrix is bidirectional:
after all dynamic gates pass, adapter acceptance must equal frozen-matcher acceptance across
the full frozen corpus and representative admissible real-capacity values. In particular,
every certifiable `static_requirements_mismatch` must also be a frozen-matcher rejection, and
the adapter may never certify a rejection that any dynamically admissible capacity would
accept. The converse offer-safety implication remains mandatory too.

`worker_lease_rejections` has composite primary/unique identity
`(organization_id, worker_id, attempt_id)`. Its exact tenant relationships are
`(organization_id, company_id, job_id, attempt_id)` to the attempt and
`(organization_id, worker_id, target_authority_key, target_id)` to the logical-worker binding,
both `ON DELETE CASCADE`; no redundant single-column Company/job/attempt/worker FK is allowed.
Certificate validity deliberately separates poll-invariant authority from candidate facts.
After locking and validating the logical worker plus current target/physical authority, the
service computes one poll-scoped `static_context_hash` and passes it as a bound parameter to
the claim statement; PostgreSQL compares it for equality and never attempts to reproduce
application canonicalization. Version 1 is the exported server constant
`LEASE_STATIC_ELIGIBILITY_VERSION = 1`; the hash is lowercase SHA-256 of
`canonicalizeJsonV1` over exactly these keys (order-independent canonicalizer, never
`JSON.stringify`):

```text
{
  certificateVersion, canonicalizerVersion, leasingAlgorithmVersion, matcherVersion,
  placementNormalizerVersion, workloadVocabularyVersion, organizationId,
  logicalWorkerId, logicalWorkerScope, logicalWorkerOwnerUserId,
  logicalWorkerTargetAuthorityKey, logicalWorkerDeviceGeneration,
  logicalWorkerDeviceThumbprint, logicalWorkerProfileHash,
  logicalWorkerStaticMatcherProfileHash,
  physicalAuthorityWorkerId, physicalAuthorityWorkerDeviceGeneration,
  physicalAuthorityWorkerProfileHash, targetId, targetScope, targetOwnerUserId,
  targetAuthorityKey, targetDeviceGeneration, targetRegisteredProfileHash,
  targetProviderConstraintHash
}
```

The three `physicalAuthorityWorker*` values are the guarded platform worker snapshot for a
platform target and `null` otherwise; nullable owner values are represented explicitly as
`null`. `logicalWorkerStaticMatcherProfileHash` is computed separately from the successfully
parsed stored `workerHelloV1` after replacing only `capacity` with the exact neutral capacity
above, using lowercase SHA-256 of `canonicalizeJsonV1`; it does not reuse or attempt to
reconstruct the enrollment-time `sha256(JSON.stringify(...))` authorization hash. Thus every
static matcher-consumed snapshot field is bound even if `workers.profile_hash` is unchanged.
Generation provenance remains distinct even though Decision #124 requires logical-worker,
platform physical-worker, target, and authenticated generations to agree on every successful
platform poll. `server/src/services/job-lease-eligibility.ts` exports the closed production
types `LeaseStaticContextSources` and `LeaseStaticContextInput`, plus the pure
`buildLeaseStaticContextInput(sources)` projection. `LeaseStaticContextInput` is exactly the 19
non-version facts above; sources and callers cannot supply version keys. The hash function
constructs an explicit 25-key object by adding the six exported server version constants, so
extra caller properties cannot enter the preimage. Any post-deployment key-set, projection,
neutralization, or algorithm change bumps `certificateVersion` and its affected component
version.

`LeaseStaticContextSources` groups the Organization ID, successfully parsed `WorkerHelloV1`,
non-null validated authority/profile/thumbprint facts, and readonly logical-worker and current-
target snapshots. It is a target-scope-discriminated union: normalized `platform` scope requires
one non-null minimal guarded physical-worker snapshot; normalized `organization` or `owner`
scope requires `physicalAuthorityWorker: null`. The physical snapshot is one all-or-none object,
so a partial triple is not representable. `buildLeaseStaticContextInput` enforces the same
discriminator at runtime as well as in TypeScript; platform/null, non-platform/non-null, raw or
cast partial physical sources, or missing validated facts raise `internal_unavailable` and
abort the enclosing transaction. Any proof or liveness statement already executed in that
attempt rolls back, leaving no committed proof, liveness, certificate, attempt, or lease
mutation. Deliberately distinct generation values are allowed only in the pure builder test and
do not relax H-02 poll authority equality.

`server/src/services/job-leasing.ts` has one lexical `buildLeaseStaticContextInput` call site,
but executes it exactly once per head-restart attempt inside that attempt's `runInTenant`
transaction, only after that attempt has reacquired and validated the logical worker,
post-advisory current target, guarded physical authority, and parsed/normalized hello. It hashes
only that returned input once and binds the value to that attempt's sole candidate-selection
statement. No source snapshot, parsed hello, context input, or hash survives rollback or is
reused by a later attempt. The logical generation comes only from the locked logical-worker
snapshot, the physical generation only from the guarded operator physical-worker snapshot, and
the target generation only from the current target snapshot; none may come from the request,
authenticated-generation scalar, or a shared sibling local.

`createJobLeasingService` exposes no builder, observer, authority guard, or test-only injection
hook. A symbol-aware call-site contract resolves exact import provenance and rejects source
substitution or collapse, shadowed/fake bindings, alias/reassignment, spread or computed
override, wrapper laundering, call/apply/bind, conditional/try-catch/`Promise.all` non-
dominance, a second builder/hash call, inline hashing, or service-option injection.
All six version values are stable exported literals covered by contract tests; any
canonicalizer, leasing algorithm, matcher, placement normalizer, or workload-vocabulary
behavior change must bump `certificateVersion` before deployment. A worker/device/profile,
parsed matcher snapshot, platform physical worker, target generation/profile/provider,
authority-key, or version change therefore produces a different bound hash and makes old rows
nonmatching immediately.

Candidate-specific facts are **not** hidden inside that opaque hash. The correlated
`NOT EXISTS` anti-join must compare ordinary columns for exact equality across certificate
and current candidate/input: Organization, Company, job, attempt, logical worker, target,
target authority key, workload type, placement owner/class/scope/generation/profile hash/
provider hash, and both JOB-009 placement digests, plus
`eligibility_version = LEASE_STATIC_ELIGIBILITY_VERSION` and
`static_context_hash = :currentPollStaticContextHash`. The claim `WHERE` independently
requires the candidate placement generation/profile/provider facts to equal the current
validated target snapshot. A mismatched version, context hash, candidate column, worker,
target, or tenant is ignored. An exhaustive AST/exact writer inventory proves the compared
immutable job/placement fields cannot change after submission/placement; injected protected-
field writers must fail it.

`placement_owner` is the JOB-009 placement-class enum and, for a selected attempt, equals
`placement_target_class`. The leasing candidate/repository input names this fact
`placementOwner` and sources it only from `normalizedCurrentTarget.targetClass`; it must never
use `execution_targets.owner_user_id`, an authenticated/request owner, or any user principal.
The optional target owner UUID remains exclusively `targetOwnerUserId` inside the static
authority context above. Contract REDs reject the ambiguous `targetOwner` candidate field name
and any owner-user-ID-to-placement-owner mapping.

Candidate selection is one database-native statement with stable
`statement_timestamp()`, the exact correlated equality anti-join above, canonical
`available_at ASC, priority DESC, created_at ASC, id ASC`, `LIMIT 256`, and `FOR UPDATE SKIP
LOCKED`. Its `WHERE` binds pending/selected/active/lease-eligible plus the current target ID,
owner, class, scope, generation, profile hash, and provider hash before ordering. It has no
cross-statement JavaScript timestamp or keyset cursor. Eligibility means
claimable at that selection statement: a row held by bounded lifecycle work is temporarily
unavailable and never certified. This remains safe because the logical worker is locked first,
schema proves one Organization poller per Organization/target, platform physical sessions
cannot poll, and non-platform target locking serializes residual same-target paths. Commit and
rollback tests must prove a lifecycle-locked older row returns on the next poll.

The service evaluates returned rows in database order. It bulk-upserts only predecessors
actually evaluated as static-negative before the first eligible row, in the same transaction
as the conditional `pending -> offered` transition and lease insert. Timeout, DB/authority
error, unknown reason, parsing/envelope failure, `SKIP LOCKED`, and offer race never create a
certificate. A conditional-offer null or invariant mismatch rolls the whole transaction back
and restarts from the global head, at most three attempts; exhaustion returns
`internal_unavailable`. One certificate row is retained per worker/attempt without a
correctness TTL, so alternating capacity/live-count reports cannot overwrite static evidence
or pin the first 256. Offering or deleting an attempt removes its rows; a bounded tenant
sweeper deletes at most 256 terminal, mismatched, or retired-worker rows per admitted-shard
visit, including permanently offline workers. The storage bound is explicit
`O(logical workers x pending attempts)`, not a constant-memory claim.
Payload-free metrics record certificate hit/miss/upsert/cleanup counts, scan-limit
exhaustion, head-restart count, certificate-table cardinality, readiness-signal rejection/
expiry, and launch-window overshoot; no job input, requirement, fence, proof, or credential is
logged.

The flag-on outbox worker lists admitted Organization IDs through the bounded non-owner app
pool, excluding the sentinel, inactive, and unmapped entries without reading job facts. The
database-facing reader accepts `(afterOrganizationId, limit)` and issues at most two ordered
queries per tick (tail then bounded wrap). The first has `LIMIT <= 32`; the second has
`LIMIT <= 32 - tailCount`, so the combined distinct window never exceeds 32 and the full
registry is never materialized. The runtime uses a stable lexical rotating cursor and is
single-flight. A tick snapshots `launchDeadline = monotonicNow() + 750 ms` and immediately
before each page reader, claim or delivery `runInTenant`, and individual local signal
publication rechecks the clock. Below 1 ms it launches no additional external unit. Work
already invoked is awaited and may acquire a pool connection, execute, publish, commit, roll
back, or return after the window. This is a launch-admission bound, not cumulative database
time, cancellation, response time, or a hard wall-clock guarantee. `statement_timeout` set
from the launch-time remainder is defense in depth only. Overshoot is measured/logged without
tenant payload, and no overlapping tick may start.

The rotation cursor advances past every admitted/attempted Organization even when its claim
times out or publication is rejected, so one slow/full shard cannot pin the window. A claim
that cannot publish or launch delivery remains durable for visibility-timeout retry; accepted
rows alone are marked delivered, and duplicate publication is idempotent. Repeated ticks must
visit every admitted shard rather than restarting at the first 32.

The in-process scheduler stores one coalesced readiness bit per
`(organization_id, target_id)`, never attempt IDs. Production defaults/hard bounds are:
Organizations `32/32`, targets per Organization `128/1024`, global signals `1024/1024`, and
TTL `30,000/300,000 ms`. Every configured value must be a finite positive integer; invalid or
fractional input fails startup, and valid input is clamped to its hard ceiling. A monotonic
clock drives expiry. Admission purges expiry first; duplicates change neither size, order, nor
expiry; a live-cap violation returns false without eviction and leaves the outbox row
retryable. Exact-target consumption atomically drains the one bit and returns only a boolean.
The leasing API can use that boolean only to choose `no_work.retryAfterMs` (`100` when signaled,
otherwise `750`); it never receives an attempt ID, list, rank, cursor, or query predicate.
Signal presence cannot alter candidate `WHERE`, `ORDER BY`, `LIMIT`, certificate validity, or
scan start. A platform-scoped session neither consumes signals nor causes a tenant scan.

**Failure behavior:** partial unique `leases_active_per_attempt_idx` plus the locked
transition makes concurrent claim losers return no-work; late/wrong ACK is stale-fence or
attempt-terminal; disconnected pre-ACK offers remain for JOB-006 reaping; target revocation
or generation change invalidates ACK. Database serialization/internal errors return bounded
`internal_unavailable`, never a second lease. Capacity is evaluated once per applicable
workload class and filtered before canonical ordering; a valid static-negative certificate
can hide only its exact unchanged worker/target/attempt facts, while an uncertified, new,
changed, previously lifecycle-locked, or capacity-reenabled older row is visible immediately.
The exact expired
semantic receipt is checked/deleted independently of bounded housekeeping before replay or
insert, so a collision beyond the cleanup batch cannot replay or permanently block progress.

A bounded scan that finds no compatible work commits only exact static-negative certificates
with proof/liveness changes; statement failure rolls all of them back. At launch-window
exhaustion, no new external unit starts and the fair Organization cursor resumes after the
last attempted shard on the next non-overlapping tick. Scheduler capacity or expiry never
marks a rejected outbox publication delivered and never changes job/attempt/lease authority.

**Compatibility / rollback:** additive lease/attempt columns. Because E3 migration `0227`
has not shipped on the shared branch, its generated DDL receives the permitted hand-appended,
idempotent data correction for E2-valid legacy active leases immediately before that same
migration enforces the activation invariant; a later migration cannot repair a predecessor
that already fails. The exact backfill is
`UPDATE leases SET activated_at = COALESCE(updated_at, created_at) WHERE status = 'active' AND activated_at IS NULL`;
offered/terminal rows and already-populated activation facts remain unchanged. The statement
is immediately preceded by the literal comment
`-- C14 permitted idempotent data backfill for E2-valid active leases before leases_activation_check.`
Replay over populated E2 state must pass.
Generated `0229` + `0230` and custom `0231` are additive except for replacing the same-named
claim index with its correct mixed direction. Certificate rows are derived tenant metadata: flag-
off reads/writes none, and a rollback may leave the table/index in place while the canonical
head scan simply stops consulting it. No lease locator or E1 wire/schema change is introduced.
Flag-off has no poll/ACK route or outbox/scheduler runtime. Rollback stops offers and lets
already offered leases expire; never transfers their fence.

**RED → GREEN:** real embedded PostgreSQL barrier tests with ≥100 concurrent claim/ACK races,
two compatible plus one incompatible worker, oldest-eligible ordering, target/generation
change, ACK same-key/same-digest response loss, same-key/changed-digest conflict, fresh proof
ID on semantic replay, late/wrong ACK, rollback between each lease/attempt update (proving the whole ACK
transaction rolls back), restart consistency, and no-detail response. Add explicit REDs for:
Organization-scoped logical sessions on one platform target in two tenants; platform-session
poll/ACK denial; poll/offer/ACK against guard-first and cutoff-first revoke, replacement, and
registered-profile mutation; operator-connection loss before/during/after advisory handoff;
app/process crash; bounded lock timeout; no operator job/lease/tenant/fence/payload facts;
real enrollment→physical heartbeat→logical poll/ACK with initial NULL and beyond-window
logical `last_seen_at`, plus stale-physical denial; >32-shard fair rotation, membership churn,
publish rejection, and restart pull recovery; exact scheduler defaults/hard caps, non-finite
and fractional configuration denial, duplicate/TTL semantics, and more-target/global-cap
churn; launch-window expiry after page read, claim, and publisher `k`, proving no later
publisher/delivery/shard launch, allowed completion after 750 ms, non-overlap on success and
rejection, bounded two-query/32-Organization wrap, slow-shard cursor advance, and retryable
claimed rows; mixed workload capacity without head-of-line starvation; 256 static-incompatible
heads followed by compatible attempt 257 across restart, alternating dynamic capacity/live
counts, and concurrent polls; a newly inserted/changed/capacity-reenabled/lifecycle-unlocked
older row; a newer signaled attempt that cannot leap an older eligible attempt; database-
native microsecond tie ordering; certificate version/digest/placement mismatch; offer-null
rollback and three head restarts; an exact expired receipt behind >100 other expired rows;
populated-0228 migration/replay through generated parent-key `0229`, generated certificate/
index `0230`, and custom RLS `0231`; exact
`pg_get_indexdef()` priority DESC and Drizzle snapshot direction; forced-RLS/no-GUC/cross-
Organization/cross-Company certificate denial; and raw-`aoa_app` H-01 oracle probes for both
the attempt FK and logical-worker-binding FK, where a real foreign parent and a random missing
parent must return the identical SQLSTATE, constraint name, and server message. Add current-
hash cases for worker generation/profile, platform physical-worker generation/profile, target
generation/profile/provider, algorithm version, and candidate-column mismatches. Because H-02
rejects a successful platform poll whenever logical-worker, physical-worker, target, and
authenticated generations diverge, generation-source independence is proved in three layers:
(1) a behavioral test of the production typed builder with deliberately distinct logical,
physical, and target generations plus one-source-at-a-time mutations; (2) a symbol-aware static
contract proving the real poll maps each builder source from its exact locked/guarded authority
snapshot and binds the returned hash to selection; and (3) integration tests proving each
isolated DB generation divergence fails before claim with no certificate, attempt, lease,
proof, or liveness mutation, followed by a coherent rotation that makes the old certificate
nonmatching before cleanup. Do not bypass authority or require divergent rows to reach
candidate evaluation. Builder REDs also reject platform/null, non-platform/non-null, and
raw/cast partial physical snapshots. A head-restart RED forces attempt one to roll back, changes
a same-generation guarded physical or target profile before attempt two, and proves attempt two
reacquires its sources and cannot reuse the first attempt's context input or hash. A separate
restart subcase changes one non-capacity field in the logical worker's stored `profile_snapshot`
while retaining the same `workers.profile_hash`; attempt two must reparse that hello, reject the
old static matcher hash/certificate, and reevaluate the candidate. All rollback assertions
compare committed database state rather than assuming that no repository statement ran.
Programmatically mutate each non-capacity static matcher-consumed
`workerHelloV1` field while retaining the same stored `workers.profile_hash`, and separately
write a correctly rehashed changed profile; both must change
`logicalWorkerStaticMatcherProfileHash`, ignore the old certificate, and expose the candidate
for current evaluation. Capacity-only mutations remain governed by the dynamic gates, must
leave `logicalWorkerStaticMatcherProfileHash` unchanged, and must not create static
certificates. Cover terminal/retired-worker cleanup and cascades.

The Linux load-characterization lane seeds exactly 1,000,000 canonical candidate rows and
1,000,000 certificate rows and records table/index bytes plus
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. It runs four named shapes: (1) one hot logical
worker in a fully certified `no_work` state, then deletes only the newest 256 certificates so
the 999,744 oldest candidates remain a current matching prefix before 256 uncertified rows;
(2) 10,000 workers x 100 rows; (3) at least 90% stale-version/context rows; and (4) 250,000
terminal/offline cleanup-eligible rows first evenly sparse among retained rows and then
re-timestamped to the tail of `(organization_id, updated_at, worker_id, attempt_id)`. Every
plan records actual/removed rows plus shared/local blocks hit/read, not latency alone. After
five warmups and 30 claim samples, it reports the provisional objectives: shapes 2/3 p95 <=
250 ms with no sample above 1,500 ms; head-saturated/fully-certified p95 <= 2,000 ms with no
sample above 5,000 ms; 20 x 256-row bulk-upsert p95 <= 500 ms; and 20 x 256-row sparse/tail
cleanup p95 <= 750 ms. These absolute latencies are `OBSERVED`, not pass/fail, while CI uses
variable `ubuntu-latest`. Every report must capture runner image label/version, CPU model and
vCPU count, RAM, storage/filesystem, Node/pnpm, embedded-PostgreSQL version and binary SHA-256,
relevant PostgreSQL settings, and competing load. Blocking gates remain: correct results and
row counts, combined table+index size <= 2 GiB, the expected indexes/predicates, no unbounded
sort, and no sequential scan of the hot queue/certificate tables at INITIAL/D1 or any million-
row shape.

#### E3-PERF-01 — pinned production-capacity benchmark gate

The independent E3 Integration Gate Owner owns `E3-PERF-01`; a distinct named Security Gate
Owner prospectively approves its manifest and independently reviews the result. Before the
first sample, after the implementation candidate is frozen, they commit an immutable
`qa/<date>-e3-perf-01-manifest-<sha12>-aN.json`. That manifest pins the exact 40-hex
implementation revision plus the exact pre-manifest evidence-parent revision/root tree and
its own one allowed added path. It also pins the complete no-replace implementation-to-parent
diff as an exact list of evidence-only path, add/modify status, file mode, old/new Git blob,
SHA-256, and independent review-evidence blob; no wildcard or directory allowlist is valid.
It must validate against strict, unknown-key-rejecting,
explicitly non-secret `scripts/e3-perf-01-manifest.schema.json`. It deliberately does **not**
contain its future Git blob, containing commit, or containing root tree. It pins the
immutable OS/runner image digest; CPU model and vCPU allocation;
RAM; storage class, filesystem, and tmpfs settings; Node/pnpm versions; PostgreSQL version,
binary SHA-256, and complete non-default configuration; exclusive competing-workload policy;
dataset seeds/counts; credentialless output-store/repository plus immutable attempt namespace
and >=180-day retention deadline; and every
numeric threshold. It also pins Git blob IDs and SHA-256 for
the runner, runner contract test, load suite, root/server/DB manifests, lockfile/workspace/npm
configuration, root/server Vitest configuration, and every tracked file below `server/src`,
`packages/db/src`, `packages/shared/src`, and `packages/worker-protocol/src`; Node/pnpm
executable hashes; the complete frozen-install package inventory and package-store integrity
digest; the strict manifest/evidence JSON-schema Git blobs and hashes; and the approved runner-image
provenance inputs below. Both owners and their approval timestamps are part of the committed
manifest. The evidence parent already contains every reviewed ticket artifact; the manifest
commit must have that exact single parent and add exactly that one manifest path with no other
delta. The resulting gate revision/tree and manifest Git blob are derived only after commit,
then verified by the runner and pinned by the later immutable QA/handoff, avoiding any Git
self-reference.

The first manifest freezes these `INITIAL` latency thresholds before execution: shapes 2/3
p95 <=250 ms and max <=1,500 ms; head-saturated and fully-certified p95 <=2,000 ms and max
<=5,000 ms; 256-row bulk-certificate upsert p95 <=500 ms over 20 samples; and sparse and tail
256-row cleanup p95 <=750 ms over 20 samples each. It also freezes the REQUIRED structural
conditions above: exact row/results, <=2 GiB combined table+index size, expected index and
predicate use, no unbounded sort, and no hot queue/certificate sequential scan. A manifest,
environment, dataset, or revision mismatch aborts before samples and cannot be classified as
a pass. Once sampling begins, a threshold miss is `fail`. A threshold change requires a dated
prospective decision approved by both owners, a higher manifest/QA/handoff attempt, and a
complete new gate campaign; the failed attempt and raw evidence remain immutable. Thresholds
may never be selected or lowered in response to observed results.

H-08 applies to the benchmark environment itself. E3 adds no image: the manifest must link the
exact passing E6F-06 QA/handoff Git blobs for the approved D1 runner image and pin its image
digest, project signature or provider-provenance attestation digest/URI, verification-policy
digest, and trust-root digest. The outer launcher verifies that signature/attestation and
policy before creating the benchmark process; an absent, unapproved, substituted, unsigned,
or tampered image is a pre-sample HARD failure. The verified output and policy/root blobs are
retained with the campaign. A test substitutes an unapproved digest and a forged attestation;
both must fail before the load child starts.

Every pre-existing manifest input URI (image, attestation, verification policy, trust root,
and referenced evidence) is a credentialless content-addressed reference using only the
reviewed `https`, `s3`, `gs`, or `oci` scheme. The prospective output field is different: it
pins an exact approved store/repository origin plus immutable
`e3-perf-01/<implementation-sha40>/aN` namespace, because the archive digest does not exist
yet. It is not an evidence reference and cannot be used as input. After scanning and hashing
the completed archive, the runner derives the final
`<output-namespace>/sha256/<archive-sha256>` URI; only that digest-addressed URI and matching
SHA-256 enter QA/handoff. The schema rejects input refs without a digest, output namespaces
outside the approved origin/prefix/attempt, URI userinfo, query, fragment, non-digest image
tags, inline credentials, presigned URLs, and every unapproved scheme; access credentials
remain out-of-band and never enter process argv, manifest, Git, console, or evidence. Before
owners approve or commit the manifest, and again before execution, the validator recursively
scans every string value—not only known URI fields—for the generated secret-canary set and
credential patterns. Canary fixtures in output namespace, attestation, policy, trust-root,
referenced-evidence URI, and nested manifest strings must all fail without echoing the value.

Execution occurs only in a disposable clean detached checkout of the derived gate revision,
with Git replacement processing disabled, the source and frozen-install dependency tree
mounted read-only inside the approved image, and only the external evidence directory
writable. Immediately before the first sample and after the last child exits,
`scripts/run-e3-perf-01.mjs` requires detached HEAD equality; a single parent equal to the
manifest's evidence-parent revision/tree; a parent-to-HEAD diff containing only the exact
added manifest path; and a no-replace implementation-to-parent diff byte-for-byte equal to
the manifest's exact reviewed-evidence list. Every path not on that list—and specifically all
source, script, package/config/lock, generated, schema, and migration inputs—must have the same
mode/blob as the implementation revision. The implementation revision must be an ancestor;
no replace refs; empty staged,
tracked, untracked, and unexpected ignored state; `pnpm install --frozen-lockfile` provenance
plus package-store integrity; the parent input tree and derived HEAD tree; and byte-for-byte equality between every
tracked working file and its `git --no-replace-objects cat-file` blob. It separately verifies
the critical runner/test/config/manifest/lock/schema/migration blob list above before spawning
the child and records both verified diffs. Any mismatch invalidates the entire attempt even when samples met thresholds. The
read-only mount prevents a mid-run input swap; the post-check detects an environment escape.

The runner then launches `job-leasing-load.integration.test.ts --maxWorkers=1` and emits only
the closed non-secret `scripts/e3-perf-01-evidence.schema.json`: pinned image/kernel/
architecture, CPU/vCPU and total
RAM, storage class/filesystem/mount flags, Node/pnpm/PostgreSQL versions and hashes, the fixed
safe PostgreSQL setting allowlist, campaign counts/seeds, samples, table/index sizes, row/
buffer counts, and JSON query plans. It never serializes `process.env`, usernames, hostnames,
home/temp paths, database/registry URLs, credentials, tokens, headers, arbitrary argv, or raw
child output. The load child emits newline-delimited JSON that must validate against the strict
evidence schema; unknown/non-JSON output is withheld from artifacts and streamed only through
the fail-closed redactor. Child stdout/stderr and the rendered command pass through that
redactor before console or persistence, and an archive-wide binary canary scan runs before
hashing/upload. The
runner contract injects canaries into an unrelated environment variable, DB username/password/
URL, argv, and child stdout/stderr and requires zero canary bytes in console, files, archive,
QA fixture, and handoff fixture.

Its Node contract test also fails an untracked/modified manifest, dirty runner/load/config/
lock/schema/migration input, Git replacement, changed installed dependency, pre/post mutation,
revision or environment mismatch, nonempty/reused output path, altered thresholds, missing
owner approvals, a self-referential containing-commit/tree field, a wrong/multiple parent or
extra parent-to-gate delta, an intervening source/config/lock/schema/migration change, an
unlisted or blob-mismatched evidence path, input URI userinfo/query/fragment/presign/non-digest
references, output namespace origin/prefix/attempt drift, a canary in every manifest string
class, and a simulated threshold/structural miss. A hermetic future-output fixture proves an
unknown archive can target the approved attempt namespace and becomes digest-addressed only
after bytes exist, while every pre-existing input remains digest-bound; the success fixture
also proves the expanded child command and complete archive manifest. From the clean
evidence-parent revision, the owners run this exact pre-commit validation before approving and
committing the one new manifest file:

```powershell
$perfManifest = 'docs/replatform/epics/E3-job-control/qa/<new-manifest-name>.json'
$perfParent = git rev-parse HEAD
Invoke-NativeGate 'E3-PERF-01 manifest preflight' {
  node scripts/run-e3-perf-01.mjs --validate-manifest $perfManifest --evidence-parent $perfParent
}
```

After the one-file manifest commit, the Gate Owner must use the final-review binding delta's
out-of-band pinned absolute-Node bootstrap command below. A PATH-resolved `node`, substituted
manifest/output argument, or direct invocation of the JS entry is not campaign authority.

The expanded command, manifest Git blob, verified source/dependency input closure, runner-
script Git blob, implementation and evidence-parent revisions/trees, derived gate revision/
tree, exact implementation-to-parent reviewed-evidence closure, parent-to-gate diff,
config/image/provenance/policy/trust-root digests, controlled
artifact URI, archive SHA-256, retention deadline, redaction/canary result, and every threshold/
result are recorded in immutable
`qa/<date>-e3-perf-01-<sha12>-aN.md`. The distinct Security Gate Owner writes
`handoffs/<date>-e3-perf-01-<sha12>-aN.md` only after independently reproducing manifest and
artifact hashes and confirming every INITIAL/REQUIRED result passes. The Git QA keeps enough
row/buffer/plan/sample summary to remain meaningful after linked CI artifacts expire. A
Windows or variable `ubuntu-latest` run remains OBSERVED diagnostic evidence only and cannot
replace either passing artifact.
Add an exhaustive AST/exact allowlist mutation inventory proving every current platform
status/generation/device/profile authority writer uses target→worker row order plus the
exclusive advisory helper, while last-seen-only heartbeat stays non-authoritative and cannot
change status. Its negative fixtures inject an unlisted file, an unguarded writer, and wrong
target→worker→exclusive order; each must fail the inventory. A separate exact AST inventory
covers protected immutable job/placement fields used by certificate validity and fails on an
injected post-placement writer. Certificate upsert/cleanup is classified
`eligibility_certificate_only`, must include exact tenant, worker, target, and attempt
predicates, and may mutate only certificate rows (never worker, target, job, attempt, lease,
liveness, or authority facts).
JOB-005 later adds the
started-event job/attempt transition test. Run focused suite three
times because it is H-03 critical, plus db/server build. Evidence
`tickets/JOB-003-result.md`; commit `feat(job-control): lease placed jobs atomically`.
Maps D0-T01/T02/T05, H-01/H-02/H-03, E6F-01/E6F-04 inputs.

#### JOB-003 final-review fix round 3 — binding delta for E3-F028–E3-F033

**Status and precedence.** This is a design-only amendment for the `needs_changes`
disposition in `tickets/JOB-003-result.md`. It does not reopen the accepted static-certificate
or canonical-order design and does not mark JOB-003 complete. Where this subsection conflicts
with earlier JOB-003 implementation wording, this subsection controls. There is no E1 wire,
schema, `0229`/`0230`/`0231`, role, or grant change in this round.

**Exact file responsibility delta:**

| File | Required responsibility |
|---|---|
| `packages/db/src/client.ts` | Export the strict checked-in migration identity and bounded non-owner connection options. Only the owner connection reads `drizzle.__drizzle_migrations`; app/operator receive no schema/table/column grant on `drizzle`. |
| `server/src/db/distributed-execution-databases.ts` | Derive exact relation/column/RLS manifests from the grant constants, attest them, construct bounded pools, and prove owner/app/operator share one transaction-advisory domain before returning either serving pool. |
| `server/src/db/job-control-legacy-grants.ts` | Export the immutable derived serving-relation manifests and table-specific RLS manifest. Do not duplicate relation names in the startup helper. |
| `server/src/index.ts` | Pass the migrated owner `Db` and strict migration identity into startup; construct one Pino metrics adapter only inside the flag-on branch and pass it to leasing, scheduler, and outbox. Flag-off performs no dynamic import, construction, emission, or database probe for these objects. |
| `server/src/app.ts`, `server/src/routes/worker-control.ts` | `app.ts` dynamically imports the worker-control route only inside the flag-on branch; the route threads the already-created optional `JobControlMetrics` instance to leasing and uses only erased type imports for metrics/scheduler. Never construct a logger adapter per request or under flag-off. |
| `packages/db/src/repositories/tenant/job-control.ts` | Return bounded truthful scan telemetry from the claim statement; select and delete only exact cleanup tuples; return the actual affected count; lock non-platform target before worker and revalidate the binding. |
| `server/src/services/job-outbox-worker.ts` | Invoke cleanup exactly once inside the existing admitted-shard tenant transaction for every actually visited shard, including empty and already-pending shards, without adding a shard/page or resetting the cursor/deadline. Return and emit exact tick/cleanup counts. |
| `server/src/services/job-leasing.ts` | Consume repository scan/upsert counts and emit only closed metrics; emit one head-restart event per real rollback/restart. Do not infer certificate hits. |
| `server/src/services/job-ready-scheduler.ts` | Emit exact capacity-reject, expiry, and bounded cardinality events while preserving the public boolean scheduler contract. |
| `server/src/services/job-control-metrics.ts` | New closed synchronous, nonthrowing interface, frozen no-op singleton, and Pino-backed exact-field implementation. |
| `scripts/run-e3-perf-01.mjs` | Replace the unconditional campaign failure with a sealed production factory and real Git/process/provenance/NDJSON/redaction/archive/S3 Object Lock/readback/QA orchestration. |
| `scripts/e3-perf-01-manifest.schema.json`, `scripts/e3-perf-01-evidence.schema.json` | Close executable/digest/environment, store, result, and failure-evidence fields; reject unknown or credential-bearing input. |
| `scripts/verify-e3-perf-01-handoff.mjs` | New independent Security Gate command that re-fetches and revalidates the immutable object and retention before producing a handoff receipt. |
| Existing JOB-003 DB/server tests, including `distributed-execution-databases-unit.test.ts` and `tenant-app-db-startup.test.ts`, plus `server/src/__tests__/job-control-metrics.test.ts`, test-only `server/src/__tests__/fixtures/job-control-module-load-sentinel.mjs`, `packages/db/src/__tests__/job-leasing-lock-order.integration.test.ts`, and `scripts/verify-e3-perf-01-handoff.test.mjs` | Own the REDs and hermetic production-driver contracts below. Test seams may not be selected by real CLI/config/environment. |

##### 1. One migrated database and one advisory domain (E3-F028)

`packages/db/src/client.ts` adds this closed owner-produced value; no best-effort
`created_at` mapping, prefix match, unknown-row tolerance, or fallback is valid:

```ts
export interface RequiredMigrationIdentity {
  readonly orderedHashes: readonly string[];
  readonly ledgerSha256: string;
}

export async function loadRequiredMigrationIdentity(): Promise<RequiredMigrationIdentity>;
```

`loadRequiredMigrationIdentity()` hashes every checked-in migration byte stream using the
same algorithm and journal-file order used by Drizzle, rejects duplicate paths or hashes, and
returns that ordered ledger plus lowercase SHA-256 of its canonical ordered-hash array. The
owner query reads every non-null `id, hash` from `drizzle.__drizzle_migrations` without using
row order. Startup rejects duplicate DB hashes, then performs a one-to-one hash join from the
DB set to the checked-in ledger: every checked-in hash must map to exactly one DB row and no DB
row may remain. Only after that set proof does it reconstruct checked-in journal order and
recompute `ledgerSha256`. Database serial insertion IDs are diagnostic only and never define
migration order. Missing, extra, duplicate, unmapped, or unreadable rows fail
`distributed_execution_migration_identity`; a repaired missing journal row inserted later
with a higher/out-of-order serial ID passes when and only when the exact hash set is restored.
The RED matrix includes that repaired/out-of-order success case plus missing, extra, and
duplicate-hash failures. For E3-F028, “executed only through `ownerDb`” is an owner-authority
and transport boundary, not a requirement to queue startup work on the retained shared legacy
pool. Each open constructs one dedicated `max=1` owner-authority participant by losslessly
cloning the parsed postgres.js authentication and transport from `input.ownerDb`, including
multi-host hosts and per-host ports, socket/path, database and user,
passwordless/string/password-function forms, TLS/`ssl`, `sslnegotiation`, target-session
attributes, and every other domain-affecting parsed option. Apart from the explicit bound and
application-tag overrides below, the clone does not normalize, omit, or reinterpret those
options. The participant and every separately cloned owner control each install their own
distinct unique non-secret per-open/per-session `application_name` in the connection startup
options, before any query can run; no participant or control within an open shares another's
tag. They apply the fixed bounded connection options below and await disposal. The
migration-ledger query and every owner advisory phase run through the owner-authority
participant; app and operator never do. Neither serving role is granted `USAGE` on `drizzle` or
any privilege on the journal. This clarification changes no database privilege or role.

The startup signature becomes:

```ts
export async function openDistributedExecutionDatabases(input: {
  enabled: boolean;
  ownerDb: Db;
  requiredMigrationIdentity: RequiredMigrationIdentity;
  appDatabaseUrl: string | undefined;
  operatorDatabaseUrl: string | undefined;
}): Promise<DistributedExecutionDatabases | null>;
```

Fixed production bounds are `pool max=4`, connect `5_000 ms`, statement `5_000 ms`,
transaction lock `750 ms`, idle-in-transaction `5_000 ms`, pool idle `30_000 ms`, and close
`5_000 ms`. `packages/db/src/client.ts` maps these to postgres-js connection options; every
startup transaction also executes transaction-local `statement_timeout`, `lock_timeout`, and
`idle_in_transaction_session_timeout`. The dedicated owner participant is bounded from
connection startup, including `5_000 ms` connect, statement, and idle-in-transaction limits, so
its acquisition and first transaction-local timeout/identity statements do not inherit an
unbounded ambient owner session. One `AbortController` and one immutable outer deadline cover
the owner, app, and operator participants. Startup never returns a partly verified pool.

Before the dedicated owner participant has returned its PID, abort handling may discover only
the session carrying that participant's unique tag, using a separately and losslessly cloned
bounded owner-authority control carrying its own distinct tag. Every discovery or cancellation
query explicitly excludes the querying control's own application tag, PID, and full identity
tuple, and may select only the target participant tag. The control reads the target's exact PID,
`backend_start`, authenticated role, database, and application tag and cancels only a row that
matches that full tuple; PID-only, database-plus-PID, broad role, self, or historical matching
is invalid. After registration, an identity remains in the active-cancellation set until the
full transaction promise, including `COMMIT` or `ROLLBACK`, settles. A distinct
teardown-history set retains identities needed for disappearance/lock proofs and is never a
cancellation target. Every owner query still runs through Drizzle; raw postgres.js
`Query.cancel()`, an internal Drizzle session client, private pool queues/state, or closing the
retained legacy pool are not permitted implementation seams.

After the owner ledger check and both existing role/ACL checks, startup creates a secret
signed-bigint key with `randomBytes(8).readBigInt64BE()` and never logs or persists it. In an
owner transaction it obtains `pg_advisory_xact_lock(key)` and holds it behind an abort-aware
in-process barrier. While held, app and operator each begin a bounded transaction and execute
`pg_try_advisory_xact_lock_shared(key)`; both results must be exactly `false`. After those
transactions end and the owner transaction commits, app and operator begin concurrently,
each obtains the shared transaction lock, reaches a two-party barrier while both locks remain
held, and then commits; both must be exactly `true`. Transaction scope releases every probe
lock on success, error, backend loss, or timeout. Every participant registers its backend PID
before locking. Any participant error/timeout/backend loss aborts the common controller,
rejects every unopened/open barrier, prevents later phases, and makes each transaction execute
or await rollback. The coordinator awaits `Promise.allSettled` for all three participants
before close; it never leaves a peer waiting at a barrier. This owner-exclusive/app+operator-shared
contention followed by simultaneous shared/shared success binds both serving pools to the
owner's database and Decision #124 advisory domain without revealing database identity.

`NonOwnerDbConnection` changes its close signature to
`close(input: { timeoutSeconds: number }): Promise<void>`. Normal shutdown and startup failure
call postgres.js `end({ timeout: 5 })` through
`NonOwnerDbConnection.close({ timeoutSeconds: 5 })`; a naked `Promise.race` that abandons an
unsettled `end()` is forbidden. After participant settlement and forced bounded end, a bounded
final owner-authority verifier control, independent of shared-owner-pool slot availability,
polls until every recorded serving identity and every prior per-open participant/control
identity has disappeared from `pg_stat_activity` and `pg_locks` contains no advisory lock for
any participant PID/key; otherwise it fails `distributed_execution_close`. The verifier then
calls and awaits its own bounded postgres.js `end({ timeout: 5 })`. It never polls for its own
PID disappearance while connected: the awaited end is production's closure proof, and tests or
admin observation after end externally prove that final verifier PID disappeared. The retained
legacy owner pool is never ended or closed by this startup gate. Zero legacy owner-pool backend
PIDs is valid because the pool is lazy; every legacy PID that does exist must be idle, out of
transaction, and hold no advisory lock. All dedicated per-open participant and control queries,
transactions, disposal promises, PIDs, and locks settle or disappear before the public open
error or returned `close()` completes. PID/key values are assertion-only and never logged.

All expected failures are stable, non-secret codes from this closed set:
`distributed_execution_configuration`, `distributed_execution_migration_identity`,
`distributed_execution_app_authority`, `distributed_execution_operator_authority`,
`distributed_execution_advisory_domain`, `distributed_execution_timeout`, and
`distributed_execution_close`. Logs may contain only the code and phase enum; never a URL,
database/role name, advisory key, journal hash, SQL text, driver cause, or credentials.
Startup REDs use (a) owner/app on one fully migrated database and operator on a second fully
migrated database, (b) `pg_terminate_backend` separately while owner-exclusive, app-negative,
operator-negative, app-positive-shared, and operator-positive-shared is held, (c) a test-only
module mock of the real max-four connection factory that occupies exactly all four app slots
and then all four operator slots before the next phase, and (d) statement/lock/idle/forced-end
deadline expiry. Every barrier peer must reject, every transaction must settle, and the owner
PID/lock disappearance probe must pass before the stable error is observed. The normal
same-database case and clean shutdown must also prove all probe PIDs/locks disappear. Additional
REDs reserve every slot of the literal shared legacy owner pool while the dedicated owner
participant completes its ledger, timeout setup, identity, advisory, and cleanup duties; they
instrument the dedicated participant/control rather than requiring a queued literal
`input.ownerDb.transaction`. A fixture may prime a legacy idle PID as a non-vacuity control, but
its presence or exact count is not a production postcondition.

###### Accepted stable-endpoint security tightening (2026-08-12)

This subsection is the controlling E3-F028 transport and teardown contract and explicitly
supersedes the earlier clauses above that accepted custom postgres.js `socket` callbacks,
explicit multi-host host/port lists, or participant-settlement-before-close ordering.

Each configured owner, app, and operator endpoint must be one stable logical PostgreSQL
authority. Owner transport is exactly one native TCP host/port pair or one native Unix
`path`; an owner `options.socket` callback or explicit multi-host input fails
`distributed_execution_configuration` before the callback, a dedicated client, or a serving
pool is invoked or allocated. App and operator URLs likewise each name exactly one native TCP
authority endpoint. Their endpoint text need not be equal because the advisory contention
handshake proves their shared domain. Client-side endpoint rotation is unsupported; HA and
failover belong behind a stable endpoint, and a host list is never silently trusted as one
cluster. This explicit stable-endpoint trust boundary permits the startup certificate's
migration, authority, and advisory phases to remain separate bounded transactions without
repeating the full ledger and catalog audit in every transaction or future physical session.

Supported owner authentication and transport options remain exact: native TCP or Unix path,
database/user, TLS/`ssl`, `sslnegotiation`, target-session attributes, and passwordless,
string-password, or password-function authentication. An explicitly empty password remains
empty after postgres.js reparses the clone even when ambient `PGPASSWORD` is present.

On abort, the coordinator synchronously memo-starts normal awaited owner-participant
`end({ timeout: 5 })`, every allocated serving `close({ timeoutSeconds: 5 })`, and exact
cancellation before awaiting any participant promise. It then awaits cancellation, every
participant transaction, and every already-started close. No naked or abandoned
`Promise.race`, and no all-settled-before-close deadlock, is permitted.

Cancellation controls and the final verifier share one narrowly scoped absolute session
deadline of `5_000 ms` covering acquisition and their complete Drizzle query/poll work. One
structurally identified timer owns that deadline. If it fires, first-call-wins disposal calls
and awaits public postgres.js `end({ timeout: 0 })`; if work completes first, production
clears the timer and normal disposal calls and awaits exactly `end({ timeout: 5 })`. Both the
scoped Drizzle work and memoized disposal settle. Emergency `timeout: 0` is invalid outside
the timer-fired causal path. The verifier deadline bounds acquisition, query, and polling,
not merely whether another loop iteration starts; ordinary disposal keeps its separately
awaited five-second allowance.

REDs reverse the old transport positives: owner custom socket and owner/app/operator explicit
multi-host inputs must fail before any callback or allocation. Positive controls cover one
native TCP endpoint, one native Unix path, TLS/`sslnegotiation`, and passwordless/string/
password-function cloning through actual postgres.js reparsing. Teardown REDs require end/
close initiation before a blocked participant can settle; cancellation/verifier REDs cover
acquisition and query stalls, work/deadline races, exactly one memoized end, causal emergency
`end({ timeout: 0 })`, normal `end({ timeout: 5 })`, no unhandled rejection, and external PID
disappearance. The static source oracle recognizes exactly the existing outer-startup timer,
the bounded cleanup-poll timer, and this structurally causal control/verifier session-deadline
timer; arbitrary extra timers or unconstrained `0 | 5` disposal remain invalid.

##### 2. Exact relation, RLS, policy, and ACL certificate (E3-F029)

The app expected-relation set is the exact sorted union of the keys of
`JOB_CONTROL_LEGACY_GRANTS`, `JOB_CONTROL_NEW_PATH_GRANTS`,
`JOB_SUBMISSION_LEGACY_GRANTS`, `JOB_SUBMISSION_NEW_PATH_GRANTS`,
`WORKER_ENROLLMENT_APP_GRANTS`, and `JOB_LEASING_NEW_PATH_GRANTS`, plus the relations named by
all app column-grant constants (`mcp_api_keys` and `execution_targets`). The operator set is
the exact sorted union of `WORKER_ENROLLMENT_OPERATOR_GRANTS` keys and every relation named by
`OPERATOR_METADATA_COLUMN_GRANTS` or operator enrollment/placement column-grant constants.
The contract test proves there is no duplicate hand-maintained startup list. Every expected
`public` relation must exist exactly once with `pg_class.relkind = 'r'`; missing, duplicate,
view, materialized-view, foreign-table, sequence, or partitioned-table substitution fails.
The existing whole-catalog effective-privilege scan remains and proves every nonmanifest
relation/column/sequence is inaccessible.

`job-control-legacy-grants.ts` freezes these exact relation arrays and counts; no runtime
discovery may add a row:

```text
RLS_RELATIONS[15] = [jobs, job_attempts, leases, workers, services,
  service_instances, job_artifacts, job_secret_handles, job_outbox,
  worker_enrollment_code_routes, worker_enrollment_codes, worker_proof_replays,
  execution_targets, worker_operation_receipts, worker_lease_rejections]
FORCE_RLS_RELATIONS[14] = RLS_RELATIONS except execution_targets
NON_FORCE_RLS_RELATIONS[1] = [execution_targets]
POLICY_COUNTS = { jobs:1, job_attempts:1, leases:1, workers:2, services:1,
  service_instances:1, job_artifacts:1, job_secret_handles:1, job_outbox:1,
  worker_enrollment_code_routes:3, worker_enrollment_codes:2,
  worker_proof_replays:2, execution_targets:3, worker_operation_receipts:1,
  worker_lease_rejections:1 }
```

The same checked-in manifest contains exactly these 22 permissive policy rows. `ALL` maps to
catalog `polcmd='*'`; every row requires `polpermissive=true`, the single listed role, and the
exact `pg_get_expr` qual/check string produced by the installed PostgreSQL, including implicit
`'literal'::text` casts:

```text
ORG = (organization_id = (current_setting('aoa.organization_id'::text, true))::uuid)
CANDIDATE_ORG = (candidate_organization_id = (current_setting('aoa.organization_id'::text, true))::uuid)
NULL_ORG = (organization_id IS NULL)
NULL_CANDIDATE_ORG = (candidate_organization_id IS NULL)
PLATFORM_WORKER = ((organization_id IS NULL) AND (scope = 'platform'::text))
TENANT_TARGET = ((organization_id IS NULL) OR (organization_id = (current_setting('aoa.organization_id'::text, true))::uuid))
PLATFORM_TARGET = ((organization_id IS NULL) AND (owner_user_id IS NULL))

[jobs, jobs_tenant_isolation, ALL, aoa_app, ORG, ORG]
[job_attempts, job_attempts_tenant_isolation, ALL, aoa_app, ORG, ORG]
[leases, leases_tenant_isolation, ALL, aoa_app, ORG, ORG]
[workers, workers_tenant_isolation, ALL, aoa_app, ORG, ORG]
[services, services_tenant_isolation, ALL, aoa_app, ORG, ORG]
[service_instances, service_instances_tenant_isolation, ALL, aoa_app, ORG, ORG]
[job_artifacts, job_artifacts_tenant_isolation, ALL, aoa_app, ORG, ORG]
[job_secret_handles, job_secret_handles_tenant_isolation, ALL, aoa_app, ORG, ORG]
[job_outbox, job_outbox_tenant_isolation, ALL, aoa_app, ORG, ORG]
[worker_enrollment_code_routes, worker_enrollment_code_routes_tenant_isolation, ALL, aoa_app, CANDIDATE_ORG, CANDIDATE_ORG]
[worker_enrollment_code_routes, worker_enrollment_code_routes_platform_operator, ALL, aoa_operator, NULL_CANDIDATE_ORG, NULL_CANDIDATE_ORG]
[worker_enrollment_code_routes, worker_enrollment_code_routes_operator_discovery, SELECT, aoa_operator, true, null]
[worker_enrollment_codes, worker_enrollment_codes_tenant_isolation, ALL, aoa_app, ORG, ORG]
[worker_enrollment_codes, worker_enrollment_codes_platform_operator, ALL, aoa_operator, NULL_ORG, NULL_ORG]
[worker_proof_replays, worker_proof_replays_tenant_isolation, ALL, aoa_app, ORG, ORG]
[worker_proof_replays, worker_proof_replays_platform_operator, ALL, aoa_operator, NULL_ORG, NULL_ORG]
[workers, workers_platform_operator, ALL, aoa_operator, PLATFORM_WORKER, PLATFORM_WORKER]
[execution_targets, execution_targets_tenant_serving, SELECT, aoa_app, TENANT_TARGET, null]
[execution_targets, execution_targets_platform_operator, ALL, aoa_operator, PLATFORM_TARGET, PLATFORM_TARGET]
[execution_targets, execution_targets_tenant_enrollment_update, UPDATE, aoa_app, ORG, ORG]
[worker_operation_receipts, worker_operation_receipts_tenant_isolation, ALL, aoa_app, ORG, ORG]
[worker_lease_rejections, worker_lease_rejections_tenant_isolation, ALL, aoa_app, ORG, ORG]
```

Startup requires exactly 15 RLS rows, 14 FORCE rows, one non-FORCE row, 22 policy rows, and
the per-table policy counts implied above. It compares `pg_get_expr(polqual, polrelid)` and
`pg_get_expr(polwithcheck, polrelid)` byte-for-byte with those checked-in deparse strings;
whitespace/parentheses/casts are not normalized away. A supported PostgreSQL build whose
deparser differs fails closed until its exact manifest is prospectively reviewed.

For every expected relation, startup records whether `pg_class.relacl` is null and compares
every tuple from `aclexplode(relacl)` as exact
`(grantor, grantee, privilege_type, is_grantable)`. Grantor must be the current relation owner
OID normalized to the checked-in `RELATION_OWNER` symbol; grantee is the exact role or PUBLIC.
It also enumerates every non-dropped user `pg_attribute` row, records whether `attacl` is null,
and compares every `aclexplode(attacl)` tuple by column name against the checked-in arrays
derived from all table/column grant constants. Thus an ACL on an unlisted column, an unexpected
grantor/grantee/privilege, or any grant option fails even when effective access appears equal.
The certificate tables have exact non-grantable app CRUD, no app column ACL, and no PUBLIC/
operator tuple; `execution_targets` keeps only its exact current app/operator column tuples.
The PostgreSQL 18 raw-ACL certificate is literal catalog fact, not an effective-privilege
approximation. A non-null ordinary-table owner ACL materializes exactly eight owner tuples:
`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, and `MAINTAIN`;
`aclexplode` reports each with `is_grantable=false`. `execution_targets.relacl` and
`mcp_api_keys.relacl` are both non-null and owner-only: each contains exactly those eight owner
tuples and no app, operator, or PUBLIC table tuple. Their serving authority remains expressed by
exact column ACLs, including the four exact app `SELECT` privileges on `mcp_api_keys`. A relation
with direct table-level serving grants has a
non-null ACL containing those eight owner tuples plus only the reviewed direct serving-role
tuples. Only the actual `pg_class.relowner` OID may normalize to `RELATION_OWNER`; no synthetic
owner, unexpected grantee, or privilege may be filtered before comparison. Any PostgreSQL-
version drift in these raw catalog facts fails closed until a prospectively reviewed manifest
pins the new facts.

The legacy non-superuser flag-off fixture runs in a third fully migrated database. Its broad
legacy grants and its `execution_targets` ownership must never contaminate either the main exact-
certificate database or the second advisory-domain database. This is strictly a catalog-fact and
test-isolation correction: it authorizes no migration, role-grant, schema, or production-filtering
change.
REDs drop/replace an expected relation, disable RLS/FORCE, add/remove/rename/restrict a policy,
change permissiveness/command/role/qual/check, add a 23rd policy, change a per-table count, add
PUBLIC/operator ACL, add relation grant option, and add expected or unexpected-column
`attacl` grant option. Every mutation fails startup; unchanged post-0231 passes. No corrective
migration or grant is authorized by this audit.

##### 3. Exact, composed certificate cleanup (E3-F030)

The repository contract changes to:

```ts
export interface LeaseRejectionCleanupResult {
  readonly deleted: number;
  readonly cardinalityObserved: number;
  readonly cardinalitySaturated: boolean;
}

cleanupLeaseRejectionCertificates(input: {
  limit: number;
  cardinalityLimit: number;
  beforeStatement(phase: "select" | "delete" | "cardinality"): Promise<void>;
}): Promise<LeaseRejectionCleanupResult>;
```

Both integers must be finite positive safe integers; production passes `limit=256` and
`cardinalityLimit=4096`. The selection uses `.limit(boundedLimit)`, deterministic
`updated_at, worker_id, attempt_id`, and `FOR UPDATE SKIP LOCKED`. It uses left joins/current
authority comparisons so drift and missing/cascading parents cannot disappear from the
candidate set. A row is eligible only for a correctness reason: attempt status
`ne(jobAttempts.status, "pending")`; job status in
`succeeded|failed|cancelled|dead_letter`; worker status `revoked`;
target status `offline|disabled`; or mismatch/missing current target ID, logical-worker
placement/binding, current target authority key/generation/registered-profile hash/provider-
constraint hash, or stored certificate placement generation/profile/provider/digests. There
is no age/TTL predicate; `updated_at` is ordering only.

Deletion is a single statement over the exact selected primary-key tuples
`(organization_id, worker_id, attempt_id)`—a joined
`DELETE FROM worker_lease_rejections USING selected` CTE or an
equivalent OR-of-AND tuple predicate—not independent `IN` lists. The exact-tuple
`DELETE RETURNING` result is
the sole affected-count source. If it ever returns more than `boundedLimit`, the repository
throws `lease_rejection_cleanup_bound` so the enclosing tenant transaction rolls back; it
never clamps with `Math.min`. Immediately after the exact-tuple delete, a bounded second query
in the same tenant transaction probes at most `cardinalityLimit + 1` remaining certificate
keys; it reports the cardinality visible at that query as
`observed=min(rows, limit)` plus `saturated=rows>limit`; it is truthful, bounded, and not a
global owner scan.

`createJobOutboxWorker` performs one admission transaction for every shard it actually visits
after the durable cursor advances and before its deadline expires. Inside that existing
transaction it first invokes cleanup exactly once, then either claims rows or honors an
already-cached pending row. Thus empty shards and pending-delivery shards are cleaned; a shard
not visited because the 32-shard/page/deadline bound fired is not. Cleanup neither creates a
second transaction nor extends/resets the monotonic deadline, admitted-page limit, cursor, or
publisher/delivery budget. Cleanup failure rolls back that shard admission and remains
retryable; it cannot lose the already-durable outbox row.

The tick captures exactly one immutable `deadline = start + tickBudgetMs`. Immediately before
each cleanup SELECT, exact-tuple DELETE, cardinality SELECT, database-time SELECT, outbox claim,
and delivery/publication database statement, a closed wrapper recomputes
`remaining = max(0, floor(deadline - monotonicNow()))`; at zero it throws the existing bounded
deadline result without issuing `SET LOCAL` or the operation. Otherwise it executes
`setLocalStatementTimeout(remaining)` and launches exactly that one following statement.
Cleanup receives this wrapper as `beforeStatement` and calls it immediately before its three
statements; database time, claim, and delivery call it separately. After every awaited
non-database publisher, remaining time is recomputed before another publisher, DB statement,
or shard can launch. A timeout never resets the deadline and an earlier statement timeout is
never reused for a later statement.

REDs seed dense cross-products of at least three workers × three attempts × two targets and
prove only the selected tuples disappear; exactly 256 are deleted, the 257th remains, and the
returned count is 256. Separate cases cover every trigger above, pending/current retention,
no TTL deletion, cleaner/cleaner `SKIP LOCKED`, cleanup racing claim/upsert, rollback on an
injected 257-row return, empty/pending shard composition, deadline expiry, cursor continuity,
and exactly-once invocation per visited shard. A fake monotonic clock advances before the six
statement phases and asserts the installed timeouts are exactly descending
`[600, 500, 400, 300, 200, 100]`; advancing to the immutable deadline before the next cleanup,
DB-time, claim, publisher, delivery, or shard asserts that operation is never called. Real-PG
`pg_sleep` cases repeat the no-post-deadline assertion for cleanup and delivery.

##### 4. Closed payload-free metrics and truthful claim counts (E3-F032)

The new interface is synchronous and closed:

```ts
export type SchedulerCapacityScope = "organization" | "target" | "global";

export interface JobControlMetrics {
  certificateScan(value: { hitsObserved: number; hitsSaturated: boolean;
    missesObserved: number; missesSaturated: boolean; scanExhausted: boolean;
    cardinalityObserved: number; cardinalitySaturated: boolean }): void;
  certificateUpsert(value: { count: number }): void;
  certificateCleanup(value: { count: number; cardinalityObserved: number;
    cardinalitySaturated: boolean }): void;
  headRestart(): void;
  schedulerCapacityReject(value: { scope: SchedulerCapacityScope }): void;
  schedulerExpiry(value: { count: number }): void;
  schedulerCardinality(value: { organizations: number; targets: number;
    signals: number }): void;
  outboxTick(value: { budgetMs: number; elapsedMs: number; overshootMs: number;
    organizations: number; claimed: number; delivered: number; cleaned: number }): void;
}

export const NOOP_JOB_CONTROL_METRICS: JobControlMetrics;
export function createPinoJobControlMetrics(log: Pick<Logger, "info">): JobControlMetrics;
```

The option deltas are exact and optional for source compatibility; returned public methods
remain unchanged except for the tick result noted below:

```ts
export interface JobLeasingServiceOptions { appDb: Db; operatorDb?: Db;
  scheduler?: JobReadyScheduler; metrics?: JobControlMetrics;
  ackTimeoutMs?: number; leaseDurationMs?: number; maxHeartbeatAgeMs?: number }
export interface JobReadySchedulerOptions { maxOrganizationShards?: number;
  maxTargetsPerOrganization?: number; maxSignalsGlobal?: number;
  signalTtlMs?: number; monotonicNow?: () => number;
  metrics?: JobControlMetrics }
export interface JobOutboxWorkerInput {
  appDb: Db; scheduler: JobReadyScheduler;
  listAdmittedOrganizationIds(input: AdmittedOrganizationPageInput): Promise<string[]>;
  publishHint?(signal: JobReadySignal): Promise<void>;
  visibilityTimeoutMs?: number; maxOrganizationShards?: number;
  maxRowsPerShard?: number; tickBudgetMs?: number; monotonicNow?: () => number;
  metrics?: JobControlMetrics; cleanupLimit?: number;
  cleanupCardinalityLimit?: number;
}
```

The existing factories accept those named option interfaces exactly:
`createJobLeasingService(input: JobLeasingServiceOptions)`,
`createJobReadyScheduler(input: JobReadySchedulerOptions = {})`, and
`createJobOutboxWorker(input: JobOutboxWorkerInput)`.
`JobOutboxTickResult` adds `cleaned: number`. `createApp` and `workerControlRoutes` add
`jobControlMetrics?: JobControlMetrics`; `index.ts` dynamically imports metrics, scheduler,
and outbox only after the flag is true, then passes the same instance through both. `app.ts`
removes its static `worker-control` import and awaits that route import only in its existing
flag-on composition block. `worker-control.ts` may statically import leasing because the route
module itself is now absent from the flag-off graph; metrics/scheduler imports there and in
`app.ts` are `import type`. Services use `NOOP_JOB_CONTROL_METRICS` only when an already-loaded
flag-on/test caller omits the option.

Every method validates/clamps only to a nonnegative safe integer/boolean/closed scope, catches
all logger failures, returns `void`, and never changes control flow. The no-op is frozen and
allocates/logs nothing per call. Pino emits fixed event names and exactly the fields in the
corresponding value above. The complete event allowlist is
`job_control.certificate_scan`, `job_control.certificate_upsert`,
`job_control.certificate_cleanup`, `job_control.head_restart`,
`job_control.scheduler_capacity_reject`, `job_control.scheduler_expiry`,
`job_control.scheduler_cardinality`, and `job_control.outbox_tick`; no other event/field is
accepted. There are no Organization/company/worker/target/job/attempt/lease IDs, hashes,
reasons, errors/stacks, SQL, inputs, requirements, fences, proofs, credentials, URLs, or
caller-supplied labels. Tests capture exact object keys and inject forbidden canaries into all
nearby domain inputs; zero canary bytes may reach the logger. With the flag off, a direct
`createApp` import uses hoisted module mocks that throw on resolving `worker-control`,
`job-leasing`, or `job-control-metrics`; all remain untouched. Separately, the real startup
child runs under a test-only ESM resolve hook that throws if it sees those modules,
`job-ready-scheduler`, or `job-outbox-worker`, and must reach health. Flag-on variants must hit
each sentinel, so both REDs are non-vacuous. Static-import AST assertions forbid those runtime
modules from re-entering the flag-off `index.ts`/`app.ts` graph; the resolve hook is test-only
and is not selectable by production configuration.

`lockEligibleLeaseCandidates` returns
`{ candidates, certificateMetrics }`. In the same tenant claim statement, a bounded ordered
probe of at most 4,097 current candidate rows counts exact correlated-certificate matches and
misses; it reports each as `min(count, 4096)` with a saturation boolean. The actual canonical
claim/anti-join remains unchanged and `scanExhausted` means its returned candidate batch is
exactly 256. The same statement probes at most 4,097 tenant-visible certificate primary keys
for per-shard cardinality. These are SQL-returned facts, not `candidates.length` inference,
planner row estimates, a second privileged/global scan, or post-hoc application matching.
Upsert uses its exact `RETURNING` row count; cleanup uses its exact result above. Leasing emits
one restart only when a failed claim attempt really rolls back and the bounded head loop
continues. Scheduler expiry reports the actual removed entries and capacity rejects report
the exact closed cap that denied insertion. Outbox uses its monotonic clock at entry/settle:
`elapsedMs=max(0,end-start)` and `overshootMs=max(0,elapsedMs-budgetMs)`.

##### 5. Executable E3-PERF-01 campaign (E3-F031)

`runE3Perf01` is refactored so hermetic tests can replace only four capability objects:
`process` (spawn/exit/byte streams), `artifact` (exclusive-create/read/archive/local-retain),
`store` (put/head/get/retention), and `clock`. Git facts, dependency/provenance decisions,
NDJSON parsing/schema validation, redaction, thresholds, archive manifest/hash, QA result, and
pass/fail classification are recomputed by production code and are not injectable facts.
`runCampaignCommand(argv, capabilities)` may be exported for hermetic CLI-contract tests.
The real module entry point always calls a module-private frozen
`createProductionCampaignCapabilities()`; no CLI option, manifest key, environment variable,
dynamic module path, endpoint override, or test mode can select substitutes.

The strict credentialless manifest adds absolute executable paths plus SHA-256 for Git, Node,
pnpm, the container runtime, and the E6F-06 provenance verifier; the immutable image digest,
policy/trust-root digests; the exact fixed argv; and a closed child environment name/value
allowlist. The Node path/hash must exactly equal the independently pinned bootstrap values
below. Only a fixed database-secret file mount and the runner image's workload-identity AWS
chain are out-of-band secret slots; neither secret is serialized or forwarded except to its
fixed consumer. Production verifies every executable byte digest, runs
`git --no-replace-objects` itself, proves detached clean
single-parent lineage and pre/post blob closure, verifies image signature/provenance with the
pinned verifier/policy/root, and spawns the digest-pinned campaign without a shell and with
only that environment. Unknown executable, argv, environment, Git, or provenance data fails
before sampling.

JavaScript cannot attest the Node binary that has already loaded it, so the trust root is the
pinned E6F-06 Integration Gate runner image/config, not a runner-selected JS seam. That image
mounts one root-owned read-only credentialless
`/run/aoa/e3-perf-01-bootstrap.json`. E6F-06 pins the bootstrap schema, image entrypoint,
native hash verifier, and control-plane signing trust root; before each job, the protected Gate
control plane binds the exact campaign-config digest out-of-band and the entrypoint verifies/
mounts those bytes before PowerShell or repository code. QA/handoff later records that digest;
the manifest and config do not hash each other, so there is no bootstrap self-reference. The
config's closed fields are: schema version; detached checkout and runner-script absolute paths/hashes; manifest
absolute path/hash; output directory; absolute Node path/hash; and exact safe parent
environment keys `LANG=C`, `LC_ALL=C`, `TZ=UTC`, plus `TMPDIR` bound to the config's absolute
writable temp directory and `AOA_E3_PERF_DATABASE_URL_FILE` bound to its absolute read-only
secret-file mount. The config contains
paths and hashes only, never the database value, AWS credential, token, or signing material.
The pinned image entrypoint supplies this config before repository code runs; real CLI/config/
environment cannot replace it.

Before Node starts, the formal gate requires the absolute Node/manifest/runner paths, hashes
their exact bytes with the pinned image PowerShell, and rejects a nonempty `NODE_OPTIONS`,
`NODE_PATH`, preload, or `PATH`; any `GIT_*` override; `AWS_ENDPOINT_URL*`,
`AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_PROFILE`, `AWS_CA_BUNDLE`, or static AWS
credential variable; `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, or `NO_PROXY`; and
`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, or `GIT_SSL_CAINFO`. It then clears the
parent environment and installs only the five exact bootstrap values above. Current v1 pins no
proxy, wrapper, preload, custom CA, AWS endpoint/config file, or PATH; supporting one later is
a manifest/bootstrap-schema and Security-review change with exact bytes/digest, never an
ambient exception. Every child executable is absolute, so PATH remains absent.
The real JS entry immediately re-reads the fixed mount and requires
`realpath(process.execPath) = realpath(bootstrap.nodeExecutable)` plus the same digest before
manifest validation; direct invocation outside the verified bootstrap fails closed.

Child stdout is line-buffered with a 1 MiB line cap and total evidence cap, accepts only UTF-8
NDJSON records valid under the closed evidence schema, and never persists raw stdout/stderr.
Non-JSON, unknown-key, oversize, invalid UTF-8, canary, or redaction failure terminates the
child and produces only a stable sanitized failure code. The artifact adapter exclusively
creates a new output directory, writes with `wx`/atomic rename, builds the deterministic
archive from the allowlisted files, rescans the exact archive bytes, then hashes them.

The production store uses the already-present `@aws-sdk/client-s3`—no dependency change—to
issue `PutObject` with checksum, `IfNoneMatch: *`, Object Lock `COMPLIANCE`, and the manifest's
retention date at least 180 days away. It then requires matching `HeadObject`, `GetObject`, and
`GetObjectRetention` bytes/checksum/version/lock-mode/retain-until before writing `qa.json`.
Any pre-sample or post-sample failure still writes a sanitized failure record and immutable
failed-attempt archive when the approved store is reachable. If upload/readback itself fails,
the new local attempt directory is retained, exit is nonzero, and no pass/handoff may be
written; no failure path deletes, overwrites, or reuses evidence.

`scripts/verify-e3-perf-01-handoff.mjs` runs under the distinct Security Gate Owner's AWS
identity, revalidates the committed manifest/Git blob, fetches the exact version from
`qa.json`, checks archive bytes/hash/schema/canaries and Object Lock COMPLIANCE retention, and
exclusive-creates `security-handoff.json`; it cannot trust the Integration Owner's local
archive. Hermetic tests call `runCampaignCommand` with only the four fake capabilities and
reach Git, provenance, child, redaction, archive, put/readback/retention, QA, and Security
verification. Source-contract negatives prove the real entry point has no substitute
selector. Security negatives cover forged/missing provenance, executable or digest drift,
dirty/attached/replaced Git, environment/argv widening, every NDJSON/redaction/canary failure,
archive mutation, overwrite, checksum/version/readback mismatch, absent/GOVERNANCE/short
retention, backend loss, and failure-evidence retention. Real-entry subprocess negatives run
the formal bootstrap—not `runCampaignCommand`—with a relative/PATH Node, wrong Node/script/
manifest digest, `NODE_OPTIONS` require/import preload, `NODE_PATH`, PATH wrapper, each Git/AWS
endpoint/config/proxy/custom-CA override above, and a modified bootstrap file. Each exits
before a JS module-load marker or load child can execute; the valid pinned absolute-node entry
reaches the real manifest validator. These entry tests expose no capability selector.

Ordinary tests use tiny NDJSON fixtures and never seed one million rows. The formal external
campaign remains mandatory before an E3 exit, capacity, or SLO claim. External prerequisites
are: the passing E6F-06 image/signature/provenance/policy/root and its pinned credentialless
bootstrap-config digest/mount; reviewed manifest-only gate commit and read-only detached
checkout; pinned absolute executable bytes; exclusive Linux host with
the manifest CPU/RAM/storage/PostgreSQL settings; a dedicated migrated benchmark database;
the bootstrap `outputDirectory` under the approved encrypted local evidence root; an S3 bucket with versioning and Object Lock
enabled at creation; Integration credentials limited to immutable put/readback; distinct
Security read/retention credentials; and outbound access only to the pinned provenance and S3
origins.

The exact Integration command consumes only the fixed out-of-band bootstrap mount; it does not
use PATH or run Git/Node by name before the absolute Node digest is verified:

```powershell
$bootstrapPath = '/run/aoa/e3-perf-01-bootstrap.json'
$bootstrap = Get-Content -Raw -LiteralPath $bootstrapPath | ConvertFrom-Json
if ($bootstrap.schemaVersion -ne 1) { throw 'invalid E3-PERF-01 bootstrap schema' }
$allowedBootstrapKeys = @('schemaVersion','checkoutPath','runnerScriptPath','runnerScriptSha256','manifestPath','manifestSha256','outputDirectory','nodeExecutable','nodeSha256','parentEnvironment')
$actualBootstrapKeys = @($bootstrap.PSObject.Properties.Name | Sort-Object) -join ','
$expectedBootstrapKeys = @($allowedBootstrapKeys | Sort-Object) -join ','
if ($actualBootstrapKeys -ne $expectedBootstrapKeys) { throw 'invalid E3-PERF-01 bootstrap fields' }
$safeEnvironmentKeys = @('LANG','LC_ALL','TZ','TMPDIR','AOA_E3_PERF_DATABASE_URL_FILE')
$actualEnvironmentKeys = @($bootstrap.parentEnvironment.PSObject.Properties.Name | Sort-Object) -join ','
$expectedEnvironmentKeys = @($safeEnvironmentKeys | Sort-Object) -join ','
if ($actualEnvironmentKeys -ne $expectedEnvironmentKeys) { throw 'invalid E3-PERF-01 parent environment' }
if ($bootstrap.parentEnvironment.LANG -ne 'C' -or $bootstrap.parentEnvironment.LC_ALL -ne 'C' -or $bootstrap.parentEnvironment.TZ -ne 'UTC') { throw 'invalid E3-PERF-01 locale environment' }
$forbiddenExact = @('PATH','NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','AWS_CONFIG_FILE','AWS_SHARED_CREDENTIALS_FILE','AWS_PROFILE','AWS_CA_BUNDLE','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR','GIT_SSL_CAINFO')
$forbiddenPresent = @(Get-ChildItem Env: | Where-Object { $_.Name -in $forbiddenExact -or $_.Name -like 'GIT_*' -or $_.Name -like 'AWS_ENDPOINT_URL*' })
if ($forbiddenPresent.Count -ne 0) { throw 'forbidden E3-PERF-01 parent environment' }
foreach ($path in @($bootstrap.checkoutPath,$bootstrap.runnerScriptPath,$bootstrap.manifestPath,$bootstrap.outputDirectory,$bootstrap.nodeExecutable,$bootstrap.parentEnvironment.TMPDIR,$bootstrap.parentEnvironment.AOA_E3_PERF_DATABASE_URL_FILE)) { if (-not [IO.Path]::IsPathFullyQualified($path)) { throw 'E3-PERF-01 requires absolute paths' } }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $bootstrap.nodeExecutable).Hash.ToLowerInvariant() -ne $bootstrap.nodeSha256) { throw 'E3-PERF-01 Node digest mismatch' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $bootstrap.runnerScriptPath).Hash.ToLowerInvariant() -ne $bootstrap.runnerScriptSha256) { throw 'E3-PERF-01 runner digest mismatch' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $bootstrap.manifestPath).Hash.ToLowerInvariant() -ne $bootstrap.manifestSha256) { throw 'E3-PERF-01 manifest digest mismatch' }
Get-ChildItem Env: | Remove-Item
foreach ($property in $bootstrap.parentEnvironment.PSObject.Properties) { Set-Item -LiteralPath ("Env:{0}" -f $property.Name) -Value ([string]$property.Value) }
Set-Location -LiteralPath $bootstrap.checkoutPath
$perfManifest = $bootstrap.manifestPath
$perfOutput = $bootstrap.outputDirectory
Invoke-NativeGate 'E3-PERF-01 formal campaign' {
  & $bootstrap.nodeExecutable $bootstrap.runnerScriptPath --manifest $perfManifest --output $perfOutput
}
```

After that command succeeds, the Security owner uses a distinct protected-control-plane pin
and root-owned read-only `/run/aoa/e3-perf-01-security-bootstrap.json`; reusing the Integration
bootstrap is forbidden. It has the same exact closed fields/parent-environment denial contract,
but its independently approved `runnerScriptPath` and `runnerScriptSha256` must name/hash
exactly `scripts/verify-e3-perf-01-handoff.mjs`; QA/handoff records its config digest separately
from the Integration bootstrap digest. The Security runner repeats the complete
absolute-path, Node/manifest hash, forbidden-environment, clear-and-rebuild validation above,
then additionally performs this verifier-specific gate and invocation:

```powershell
$securityBootstrapPath = '/run/aoa/e3-perf-01-security-bootstrap.json'
$bootstrap = Get-Content -Raw -LiteralPath $securityBootstrapPath | ConvertFrom-Json
$expectedVerifierPath = Join-Path $bootstrap.checkoutPath 'scripts/verify-e3-perf-01-handoff.mjs'
$realpathProgram = 'const fs=require("node:fs");process.stdout.write(JSON.stringify(process.argv.slice(1).map((value)=>fs.realpathSync.native(value))))'
$resolvedVerifierPaths = @(& $bootstrap.nodeExecutable -e $realpathProgram $bootstrap.runnerScriptPath $expectedVerifierPath | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $resolvedVerifierPaths.Count -ne 2) { throw 'E3-PERF-01 Security verifier realpath failure' }
$configuredVerifierRealPath = [string]$resolvedVerifierPaths[0]
$expectedVerifierRealPath = [string]$resolvedVerifierPaths[1]
if ($configuredVerifierRealPath -cne $expectedVerifierRealPath) { throw 'E3-PERF-01 Security verifier path mismatch' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $configuredVerifierRealPath).Hash.ToLowerInvariant() -ne $bootstrap.runnerScriptSha256) { throw 'E3-PERF-01 Security verifier digest mismatch' }
$perfManifest = $bootstrap.manifestPath
$perfOutput = $bootstrap.outputDirectory
$perfQa = Join-Path $perfOutput 'qa.json'
$securityReceipt = Join-Path $perfOutput 'security-handoff.json'
Invoke-NativeGate 'E3-PERF-01 independent security handoff' {
  & $bootstrap.nodeExecutable $bootstrap.runnerScriptPath --manifest $perfManifest --qa $perfQa --output $securityReceipt
}
```

A real-entry RED changes only the checked-out
`scripts/verify-e3-perf-01-handoff.mjs` bytes (and a sibling case redirects only the configured
path) while the campaign bootstrap's `run-e3-perf-01.mjs` digest remains valid. The independent
Security digest/realpath gate must fail before the verifier module-load marker, S3 read, or
handoff write. This proves a valid campaign-runner pin cannot authorize a substituted Security
verifier.

##### 6. Non-platform target→worker lock order (E3-F033)

For Organization/owner poll, `lockWorkerLeaseAuthority` first locks the authenticated
`execution_targets.id = input.targetId` row `FOR UPDATE`, then locks the exact worker by
`(organization_id, id, execution_target_id, target_authority_key)` `FOR UPDATE`, and finally
revalidates target scope/owner/status/generation/profile/provider and worker binding before any
profile/liveness, certificate, claim, attempt, or lease mutation. The proof receipt may be
recorded earlier only inside the same rollback-capable tenant transaction; the current
`touchWorkerLeaseProfile` worker update moves after target→worker authority locking. Merely
reversing the two repository selects while retaining that earlier worker update is not a fix.
Revoke already uses
target→worker; neither path may invert the order. A barrier test repeatedly overlaps poll and
revoke, requires both transactions to settle inside the existing 750 ms bound with no `40P01`,
and proves either poll commits before cutoff or observes cutoff with no effects.

The platform path remains the exact Decision #124 bounded nesting: the app tenant transaction
locks only its logical worker; the operator transaction locks physical target→physical worker
and acquires the shared advisory handoff; it commits while the app retains the shared advisory
lock. Authority writers use physical target→physical worker→exclusive advisory. Because the
app logical row is not an operator physical row and the operator transaction never waits on
it, this order cannot close a row-lock cycle. Existing operator-loss and writer-inventory
tests remain required.

##### TDD, commits, review, commands, and stop conditions

Implementation is split at these mandatory plain-commit/review boundaries; no reviewer may
review a mixed later slice:

1. `test(job-control): expose final review blockers` — tests only for all six findings; record
   the exact intended failure map. Controller review must accept the RED before GREEN.
2. `fix(job-control): bind serving pools to migrated authority` — client/startup/manifests/
   index only; independent schema/security review.
3. `fix(job-control): bound certificate cleanup and lock order` — repository/outbox/leasing
   only; independent concurrency/repository review.
4. `feat(job-control): add payload-free control metrics` — metrics/scheduler/leasing/outbox/
   `index.ts`/`app.ts`/`routes/worker-control.ts` only; independent privacy/observability review.
5. `feat(perf): launch and attest E3 performance campaign` — runner/schemas/verifier/tests
   only; independent Security review. Do not run the formal campaign in this slice.
6. `docs(job-control): record JOB-003 final review` — result/evidence only after all focused
   GREEN commands and a distinct whole-candidate reviewer; retain `needs_changes` unless that
   reviewer explicitly returns pass. The later manifest, formal campaign QA, and Security
   handoff are separate immutable commits owned by their named gate owners.

Exact fix-round command from `C:\e3` (RED and GREEN use the identical invocation; run the DB
and server groups three times before candidate review):

```powershell
Invoke-E3Integration {
  Invoke-NativeGate 'JOB-003 final DB' {
    pnpm --filter @armyofagents/db exec vitest run src/__tests__/worker-lease-rejections-schema.integration.test.ts src/__tests__/job-leasing-lock-order.integration.test.ts
  }
  Invoke-NativeGate 'JOB-003 final server' {
    pnpm --filter @armyofagents/server exec vitest run src/__tests__/distributed-execution-db-startup.integration.test.ts src/__tests__/distributed-execution-databases-unit.test.ts src/__tests__/tenant-app-db-startup.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts src/__tests__/job-control-runtime.test.ts src/__tests__/job-leasing.integration.test.ts src/__tests__/job-leasing-contract.test.ts src/__tests__/job-control-metrics.test.ts src/__tests__/server-shutdown.test.ts
  }
}
Invoke-NativeGate 'JOB-003 final perf contracts' {
  node --test scripts/run-e3-perf-01.test.mjs scripts/verify-e3-perf-01-handoff.test.mjs
}
Invoke-NativeGate 'JOB-003 db typecheck' { pnpm --filter @armyofagents/db typecheck }
Invoke-NativeGate 'JOB-003 server typecheck' { pnpm --filter @armyofagents/server typecheck }
```

Then rerun the pre-existing complete JOB-003 focused command in section 3, package builds,
and the Linux aggregate required by the ticket result. The ordinary gate does not run
E3-PERF-01's million-row campaign; only the formal command above may create that evidence.

Rollback keeps `AOA_DISTRIBUTED_EXECUTION_ENABLED=false`, stops new offers, closes both
serving pools inside the close deadline, and reverts one GREEN slice at a time; certificate
tables remain inert derived metadata and offered leases expire normally. STOP rather than
bypass if the exact ledger cannot be proven, any contention result is ambiguous, a required
relation/policy/ACL differs, cleanup could affect more than its selected tuples, a metric
requires payload/arbitrary labels or can throw, production CLI needs a selectable test seam,
immutable evidence cannot be retained/read back, or the lock-order fix requires an E1/schema/
migration/grant/owner-pool expansion. Any >256 cleanup result rolls back. Any startup or
campaign timeout/backend loss is a fail-closed error, never a retry that weakens attestation.
No new dependency is authorized while the existing AWS SDK suffices. E1 stays byte-frozen;
app/operator receive no new privilege, especially no `drizzle` access.

### JOB-010 — Preserve admission and assignment invariants (parity-exempt, PRE-D1)

**Depends on:** TEN-006, JOB-001.
**Outcome:** Bridge every execution source to its existing admission/assignment authority;
task runs reuse current checkout with one legacy/distributed winner.

**Ticket non-goals:** execution cutover, mixed legacy/distributed quota enforcement (owned
only by JOB-007), a new assignment/capacity store, fabricated task identity for non-task
sources, or model/provider effects in shadow mode.

**Files:** modify `server/src/db/tenant-context.ts` (overload-compatible callback-local tx),
`services/tenant-admission.ts`, `services/issues.ts` only for a reusable transaction seam if
needed, plus exact current source seams `services/heartbeat.ts`,
`services/internal-agent/cli-mode.ts`, `services/internal-agent/commander-sandbox.ts`,
`services/internal-agent/aoa-agents/runner.ts`, `services/crew-task-service.ts`,
`services/extraction-engine.ts`, `services/extraction-cli.ts`,
`services/internal-agent/cli-summarizer.ts`, and
`services/sandbox-readiness-probe.ts`; create
`server/src/services/job-admission-bridge.ts`; tests
`server/src/__tests__/job-admission-parity.integration.test.ts` and
`job-source-admission-matrix.test.ts`.

**Interfaces:** `admitAndSubmit(source, actor, idempotencyKey)` resolves Org/Company,
validates E2 sentinel/unmapped admission, and within one authoritative transaction invokes:
task `issueService.checkout`/ownership; Commander conversation authority; crew dispatch
claim/preflight; extraction claim, compaction hash, or readiness probe identity; browser
request and service reconcile source-specific idempotency (net-new, no fabricated issue).
Only task_run carries issue/run identity. A stable bridge claim identity links legacy and
distributed submissions while the legacy path is owner.

**Failure behavior:** dependency/assignee/status/membership mismatch rejects before job;
same source replays; concurrent legacy/distributed attempts have one winner; submit failure
or pre-lease rollback releases the existing claim exactly once; reassignment/status change
requests cancel and permanently fences the losing distributed attempt. No new assignment
column is authoritative.

**Compatibility / rollback:** no cutover. The bridge may be invoked in parity/shadow mode
only when it performs no model/provider effect. Flag-off keeps all current paths unchanged.
Rollback disables bridge invocation and releases unleased claims through the same engine.

**RED → GREEN:** full FND-007 source admission/assignment matrix. Capacity is
characterization-only here: record each source's current claim/release/wakeup behavior and
prove failed submit releases the existing authoritative claim, but do not add distributed
capacity authority before JOB-007. Test task
dependency, replay, bounded stale adoption, assignee removal/reassignment, status change,
legacy/distributed race; six source variants; duplicate key; failed submission/release.
Focused suite runs against embedded PG and existing heartbeat/crew/one-shot characterization
tests. Evidence `tickets/JOB-010-result.md`; commit
`feat(job-control): bridge legacy admission authority`. Maps D0-T01/T05, H-01/H-02/H-03.

> **STOP AFTER PRE-D1:** No following ticket may be assigned until the controller verifies
> a committed passing `E6-D1-FOUNDATION` QA record and handoff on the current ancestry.

### JOB-004 — Renew leases and enforce fencing (M, ≤3 agent-days, POST-D1)

**Depends on:** JOB-003 + passing `E6-D1-FOUNDATION`.
**Outcome:** Only the active lease renews, and the shared fence guard protects every
governed surface.

**Ticket non-goals:** event storage/projection, artifact-byte storage, secret
materialization, retry policy, or service reconciliation.

**Files:** modify lease repository/schema if timestamps are missing and worker routes;
create `server/src/services/job-fencing.ts`; in
`packages/db/src/repositories/tenant/job-control.ts` define guarded methods
`acceptEvent`, `authorizeArtifactCommit`, `readSecretHandle`, `completeAttempt`,
`recordServiceHealth`, `applyProjectionReceipt`, and `ackControlCommand`. JOB-004 lands the
shared predicate/closed interface and negative contract; JOB-005/006/011 fill the event,
control, and projection storage behind that already-guarded interface. Wire existing
`job_artifacts`, `job_secret_handles`, `job_attempts`, and `service_instances` methods; tests
`server/src/__tests__/job-fencing.integration.test.ts` and
`job-fence-surface.contract.test.ts`.

**Interfaces/failure:** server policy supplies lease duration/renew interval; worker cannot
extend it arbitrarily, and E1 `observedAt` never authorizes expiry. Conditional renew uses a
fresh SQL `clock_timestamp()` in the mutation (not transaction-start time), matches all lease
identity plus the current worker/target status and generation, and increments no authority. It stores the renewed
`expiresAt`/cancel response in the operation receipt atomically. Same scope/idempotency key/
digest with a fresh proof replays that exact renewal result and cannot extend twice; changed
digest is generic `malformed`. A new idempotency key is required for a later renewal effect.
Expired/replaced/revoked/terminal returns stale_fence/target_revoked/
attempt_terminal. One matrix proves stale fences cannot mutate events, ordinary artifact
metadata/commit authorization, secret handles, completion, or service health.

**Observability/rollback:** metric by renewal disposition and guard surface, redacted audit
for rejected stale authority. Flag-off no renew endpoint; rollback stops renewal and fences
leases by expiry, never extends them. RED transaction begins before expiry but conditional
mutation runs after expiry; same-key/same-digest lost-response replay returns the original
expiry without extending; changed digest conflicts; plus boundary/clock/revoked/replacement
races;
GREEN common guard; run critical suite 3×. Evidence `tickets/JOB-004-result.md`; commit
`feat(job-control): enforce active lease fences`. Maps D0-T01/T02/T05, H-01/H-02/H-03/H-04.

### JOB-005 — Ingest events and terminal results idempotently (M, ≤3 agent-days, POST-D1)

**Depends on:** JOB-004, PRT-004.
**Outcome:** Commit valid ordered events once and return a stable cumulative ACK while
transactionally applying legal job/attempt transitions.

**Ticket non-goals:** realtime fan-out/catch-up claims, artifact bytes, worker pricing,
cancellation policy, or legacy product projection.

**Files:** create `schema/job_events.ts`, extend tenant repositories, create
`schema/job_projection_receipts.ts`, `server/src/services/job-events.ts`, extend worker
routes/shared response types and tenant repositories; tests
`packages/db/src/__tests__/job-events-schema.integration.test.ts`,
`server/src/__tests__/job-events.integration.test.ts`; generated normal + custom RLS
migrations.

**Interfaces:** Import E1 `canonicalEventDigestInputV1` and
`verifyWorkerEventDigestV1`—do not reimplement RFC8785—then validate authenticated delivery
identity/current fence, then batch duplicates/gap, then persist events and state projection,
then cumulative ACK—all inside one tenant transaction. The first valid `attempt_started`
event owns attempt `leased→running` and job `queued→running`. Same event ID+digest/sequence replays
the prior ACK; changed digest, in-batch duplicate, gap, or illegal transition is rejected.
Terminal result wins once.

**Failure behavior:** crash before commit yields no ACK and safe replay; crash after commit
before response replays same ACK; partial invalid batch commits none; concurrent terminal
loser sees terminal and cannot overwrite. Payload bounds and secret canaries fail before
persistence. Metrics track accepted/replayed/gap/hash/stale/terminal without event content.

**Compatibility/rollback:** new RLS event table only; events are durable source for later
realtime but no live catch-up claim. Flag-off no ingest. RED duplicate/out-of-order/partial
retry/concurrent terminal/restart/hashes; GREEN and 3× critical suite. Evidence
`tickets/JOB-005-result.md`; commit `feat(job-control): ingest fenced job events`.
Maps D0-T01/T02/T03/T05, H-01/H-02/H-03/H-04, D1-03 input.

### JOB-006 — Cancellation, expiry, retry, and reconciliation (M, ≤3 agent-days, POST-D1)

**Depends on:** JOB-004, JOB-005.
**Outcome:** Durable controls and reconciliation converge abandoned or canceled work to one
winner/new attempt/terminal result.

**Ticket non-goals:** provider adapter/resource implementation, checkpoint byte handling,
mobility, or reviving an expired fence.

**Files:** modify `jobs.ts`, `job_attempts.ts` (including unique
`(organization_id, job_id, attempt_number)`); create
`schema/job_control_commands.ts`, repository methods,
`server/src/services/job-reconciliation.ts`, `job-control-sweeper.ts`; extend worker and
operator routes; tests `server/src/__tests__/job-reconciliation.integration.test.ts` and
`job-control-commands.integration.test.ts`; normal + custom RLS migrations.

**Interfaces:** cancellation transaction marks requested state and queues a monotonically
sequenced E1 cancel command; worker poll/renew returns pending controls until ACK. Reaper
locks the authoritative job/current-attempt row plus expired offer/lease, permanently revokes
the fence, applies server retry policy, allocates `max(attempt_number)+1` under that lock, and
either creates the uniquely constrained attempt N+1 plus its attempt-ready outbox row in the same transaction
with immutable backoff or terminates/dead-letters with explicit reason. Reconciliation finds
leaked attempts/commands and repeats idempotently.

**Failure behavior:** two concurrent retry/reconciliation creators produce one N+1 attempt
and one ready row; the loser idempotently observes it. Disconnect before/after ACK, during execution/upload, and after
terminal commit converges; late result never overwrites winner; retry exhaustion alone can
dead-letter; CAV-003 restart always creates a new attempt/fence; CAV-004 offline output is
quarantine-only. Reaper has bounded batches/backoff and one in-flight tick per process.

**Compatibility/rollback:** new RLS control table/additive columns. Flag-off stops sweeper
and routes. Rollback cancels/drains or lets leases expire; never deletes evidence or revives
fences. RED five disconnect phases + restart/retry/dead-letter/duplicate sweeper; GREEN and
3× critical suite. Evidence `tickets/JOB-006-result.md`; commit
`feat(job-control): reconcile cancellation and retries`. Maps D0-T01/T02/T05,
H-01/H-02/H-03/H-10, D1-04/D1-05/D1-07 inputs.

### JOB-007 — Organization quotas and worker revocation (M, ≤3 agent-days, POST-D1)

**Depends on:** JOB-003, JOB-006.
**Outcome:** One shared concurrency/capacity authority enforces Org/workload limits and
immediate target revocation without double release.

**Ticket non-goals:** a parallel quota counter, commercial billing, worker-owned limits,
or fallback beyond the immutable placement policy.

**Files:** modify `server/src/services/org-concurrency.ts`, `execution-targets.ts`,
`job-leasing.ts`, `job-reconciliation.ts`, budget bridge seam, attempt capacity columns and
tenant repository; create `packages/db/src/schema/execution_target_revocations.ts` plus its
approved operator-policy migration/repository; tests
`packages/db/src/__tests__/execution-target-revocations-schema.integration.test.ts`,
`server/src/__tests__/job-quotas.integration.test.ts` and
`worker-revocation.integration.test.ts`.

**Interfaces:** Refactor the current advisory-lock capacity transaction to count/claim both
legacy runs and distributed attempts, keyed by Organization plus workload; claim is stored
on the attempt and released by one conditional transition. Admission/effect checks call
existing budget policy. Revocation's operator transaction locks the target, increments its
generation/disables it, and writes the durable fanout record; it never attempts a cross-Org
lease transaction. The committed cutoff immediately blocks refresh/new leases and every
governed guard through the locked current-generation recheck. The fanout worker scans admitted
Organizations and separately uses `runInTenant` to mark matching old-generation leases
`revoked`, request attempt cancellation, enqueue termination, and wake queued work only when
immutable fallback permits.

**Failure behavior:** crash after global cutoff but before/during any Organization fanout
still denies all old-generation effects; restart resumes the durable idempotent scan until
every matching tenant lease converges. Concurrent claims never exceed cap; retry/reaper/
revocation/cost exhaustion can race but release once; unavailable shared admission storage fails closed;
revoked worker cannot renew/emit events/read secrets/upload/apply projections/report health/
ACK control/complete from the instant that transaction commits. Metrics: queued/running/reserved,
claim/release/reconcile/revocation dispositions, and queue-reason cardinality bounded by code.

**Compatibility/rollback:** extends the existing capacity service, not a new counter. Flag
off excludes distributed attempts. Revocation is irreversible for old generation. RED
concurrent quota, mixed legacy/distributed clamp (CM-014), authority-row lock ordering,
crash after cutoff/before fanout, multi-Org platform revoke at every lease phase,
budget exhaustion, double-release and reconciliation; GREEN 3×. Evidence
`tickets/JOB-007-result.md`; commit `feat(job-control): enforce shared organization quotas`.
Maps D0-T01/T05, H-01/H-02/H-03, D1-01/D1-02/D1-07 inputs.

### JOB-008 — Operator job and worker controls (M, ≤3 agent-days, POST-D1)

**Depends on:** JOB-005/006/007/009.
**Outcome:** Tenant-authorized operators can inspect redacted durable status and invoke
cancel/drain/revoke with explicit refresh.

**Ticket non-goals:** durable realtime, live log streaming, displaying secret/event
payloads, cross-tenant platform inventory, or execution cutover.

**Files:** extend `server/src/routes/job-control.ts`; create
`server/src/services/job-operations.ts`; create `ui/src/api/job-control.ts`,
`ui/src/components/settings/sections/OperationsSection.tsx`; modify
`ui/src/components/settings/SettingsLayout.tsx`, `ui/src/pages/SettingsPage.tsx`,
`ui/src/lib/queryKeys.ts`; tests `server/src/__tests__/job-operations-routes.test.ts` and
`ui/src/__tests__/OperationsSection.test.tsx`.

**Interfaces:** tenant-scoped list/detail for job/attempt/event/worker/placement; response
contains redacted envelopes, reason codes, target class/scope (not cross-tenant target IDs),
event metadata/digests (not payload secrets), and control status. Mutations call JOB-006/007
services. UI supports manual Refresh and states queued/leased/canceling/failed/revoked/stale.
It explicitly says realtime catch-up is unavailable until `E10-REALTIME-FOUNDATION`.

**Failure behavior:** board actor without Company/Org authority gets uniform 404/403; null-
Org platform rows are summarized only after job-scoped placement authorization; errors are
visible, no silent toast-only failure; repeat cancel/drain/revoke is idempotent. Audit every
mutation; read metrics avoid user/secret labels.

**Compatibility/rollback:** additive APIs/settings tab, route absent when flag off; legacy
settings untouched. RED API auth/cross-tenant/redaction and UI state/action/error/refresh
tests; GREEN server+UI typecheck/build. Evidence `tickets/JOB-008-result.md`; commit
`feat(job-control): add operator controls`. Maps D0-T01/T05, H-01/H-02/H-04/H-10.

### JOB-011 — Preserve approvals and completion policy (parity-exempt, POST-D1)

**Depends on:** PRT-007, JOB-006, JOB-010, passing foundation.
**Outcome:** Distributed attempts call existing product approval/runtime-decision/completion
authorities exactly once.

**Ticket non-goals:** a new approval/policy engine, worker-created policy, approval UI
redesign, or holding managed compute while parked.

**Files:** use the JOB-005 projection-receipt repository; create
`server/src/services/job-approval-bridge.ts`; minimally adapt `approvals.ts`,
`agent-runtime-decisions.ts`, crew dispatch/completion policy seams for callback-local tx;
tests `server/src/__tests__/job-approval-parity.integration.test.ts`; normal + custom RLS
migrations.

**Interfaces/failure:** server creates product approval or runtime decision with source
revision, nonce/digest/version/TTL/default, writes a projection receipt linking the existing
aggregate, and sends only the E1 control. Worker cannot create/approve/override it. Denial,
timeout, invalid/missing/multiple default, and forbidden persistent timeout grant fail before
effect. `park_run` ends attempt/releases compute and resumes through a new fence.

**Compatibility/rollback:** existing aggregates remain authoritative. Flag/cutover rollback
continues resolving their current rows and never duplicates them. Matrix covers task,
Commander, crew, one-shot, browser, service, allow/deny/timeout/default/retry/stale event and
active rollback. Evidence `tickets/JOB-011-result.md`; commit
`feat(job-control): bridge approval and completion policy`. Maps D0-T01/T02/T05,
H-01/H-02/H-03/H-10.

### JOB-012 — Preserve budget and authoritative cost policy (parity-exempt, POST-D1)

**Depends on:** JOB-005, JOB-007, JOB-010, passing foundation.
**Outcome:** Existing budget/cost authority prices accepted usage once and stops governed
effects at every applicable scope.

**Ticket non-goals:** commercial billing/payment, worker-supplied pricing, a parallel cost
ledger, or relaxing current hard stops.

**Files:** create `server/src/services/job-budget-cost-bridge.ts`; modify existing
`budgets.ts`, `costs.ts`, `one-shot-cli-budget.ts`, `org-concurrency.ts`; extend existing
budget/cost schemas only for department scope, server rate/version/rounding, and a stable
source idempotency key; use projection receipts; test
`server/src/__tests__/job-budget-cost-parity.integration.test.ts`.

**Interfaces:** worker event supplies bounded usage units only. Server resolves provider,
model, biller, billing type, rate/version, currency/rounding and calls `costService` once per
accepted event/attempt identity. Existing agent/Company policies plus the existing
project/department surface are extended inside the same budget engine. Checks occur at
admission, before next governed effect, and after authoritative cost.

**Failure behavior:** worker price/rate rejected; unknown rate fails closed before effect;
replay uses receipt and does not charge; exhaustion creates warning/incident/pause/cancel and
releases reservation/capacity exactly once even under race. Rollback preserves current
hard-stop and cannot erase charged events.

**Compatibility/rollback:** additive fields/scopes in existing engines, no parallel ledger.
Legacy callers retain defaults. Flag-off blocks new distributed admission/leasing, but an
accepted usage event must reach a terminal projection receipt before its bridge may disable;
the rollback gate fails closed while a cost receipt is pending, so disabling cannot erase or
skip an authoritative charge. RED server pricing fixtures, duplicate usage, all scopes,
warning/incident, concurrent exhaustion, retry attribution, pending-receipt flag-off, release
race, active rollback; GREEN existing cost/budget regression suites + focused embedded PG. Evidence
`tickets/JOB-012-result.md`; commit `feat(job-control): bridge budget and cost authority`.
Maps D0-T01/T05, H-01/H-02/H-03/H-10, D1-01/D1-07 inputs.

### JOB-013 — Preserve transactional activity audit (parity-exempt, POST-D1)

**Depends on:** JOB-005, JOB-010/011/012, passing foundation.
**Outcome:** Accepted state/control/accounting mutations write existing activity/hub audit
in the same transaction; publication occurs after commit.

**Ticket non-goals:** a new audit store, treating worker observations as product actions,
or publishing before commit.

**Files:** create `server/src/services/job-audit-bridge.ts`; modify
`server/src/services/activity-log.ts` only for callback-local transaction and post-commit
publication seam; use projection receipts; tests
`server/src/__tests__/job-audit-parity.integration.test.ts`.

**Interfaces/failure:** accepted mutation supplies typed actor/source/job/attempt/domain
resource and existing activity action. Receipt + mutation + activity insert commit together;
an after-commit callback publishes. Worker observation alone never becomes accepted product
action. Replay/stale/rejected events produce no duplicate/accepted activity; rollback
publishes nothing.

**Compatibility/rollback:** existing activity contract remains source of truth; self-hosted
callers unchanged. Flag-off blocks new distributed admission/leasing, while already accepted
mutations finish their same-transaction activity insert and terminal receipt; the rollback
gate refuses bridge disablement while a receipt is pending. RED per-source accepted/rejected/
stale, approval/budget, duplicate, pending-receipt flag-off, rollback,
publication-before-commit denial, tenant and actor attribution; GREEN. Evidence
`tickets/JOB-013-result.md`; commit `feat(job-control): project transactional activity audit`.
Maps D0-T01/T05, H-01/H-02/H-04/H-10.

### JOB-014 — Preserve task outputs and run summaries (parity-exempt, POST-D1)

**Depends on:** JOB-005/006/010/011/012/013, passing foundation.
**Outcome:** Accepted artifact/result and terminal winner project into existing output,
review, primary-selection, summary, and task terminal contracts exactly once.

**Ticket non-goals:** artifact-byte storage, automatic quarantine promotion, fabricating
task outputs for inapplicable sources, or changing the current review/primary contract.

**Files:** create `server/src/services/job-output-bridge.ts`; minimally adapt
`task-outputs.ts`, `run-summary-comment.ts`, and task terminal update seam for
transaction/idempotency; use projection receipts; tests
`server/src/__tests__/job-output-parity.integration.test.ts`.

**Interfaces/failure:** ordinary fenced artifact commit remains distinct from explicit
output projection. Existing provider/external identity and review/primary rules apply;
creator/source is typed. The terminal winner creates success/failure/cancel/dead-letter
summary once. Stale/losing output is only quarantine metadata and cannot become primary or
change terminal state. Commander/crew/one-shot use their applicable output/summary mapping
without fabricated task IDs.

**Compatibility/rollback:** existing task outputs/comments/status remain authoritative;
receipt makes fallback safe. Flag-off blocks new distributed admission/leasing, while an
accepted terminal/artifact event must finish or resume its idempotent projection before its
bridge disables; the rollback gate fails closed on pending receipts. RED duplicate provider
identity, review/primary, retry/stale winner/quarantine, six-source projections, every
terminal, pending-receipt flag-off, and rollback before/after accepted artifact; GREEN
existing output/comment regressions + focused lane. Evidence
`tickets/JOB-014-result.md`; commit `feat(job-control): project outputs and run summaries`.
Maps D0-T01/T02/T05, H-01/H-02/H-03/H-10, D1-06/D1-07 inputs.

---

## 5. Legacy parity mapping (FND-007 / frozen-main crosswalk)

`JOB-010`–`JOB-014` are exempt from the three-agent-day limit. Their scope is bounded by
this matrix, not by permission to build new engines.

| Ticket | FND-007 parity dimensions | Current-main crosswalk rows bridged | Required disposition |
|---|---|---|---|
| JOB-010 | `checkout_assignment`; characterize `capacity_claim_release_wakeup` and release the existing claim on failed submission | CM-002 heartbeat/agent-run; CM-003 crew; CM-004 Commander; CM-005 extraction; CM-006 compaction; CM-007 readiness; CM-014 current behavior | Reuse checkout/assignment and record current capacity semantics. JOB-007 alone implements mixed legacy/distributed claim/release/wakeup authority and full CM-014 proof; browser/service are net-new with explicit source idempotency, not task identity. |
| JOB-011 | `product_runtime_approval`, completion-policy portion of `completion_cancel_retry` | CM-002/003/004/005/006/007 plus source-specific `not_applicable` rows | Reuse product approvals, crew preflight, runtime decisions, timeout/default, completion policy. |
| JOB-012 | `budget`, `cost`, capacity release on hard stop | CM-002/003/004/005/006/007 and CM-014 | Reuse/extend budget and cost services; preserve source-specific N/A rationale; no worker pricing. |
| JOB-013 | `audit` | CM-002/003/004/005/006/007; CM-008 artifact/output attribution | Existing activity/hub audit only; accepted product mutations, not observations. |
| JOB-014 | `output_run_summary`, remaining `completion_cancel_retry` | CM-002/003/004/005/006/007 and CM-008 | Existing task-output/run-summary/status contracts; browser/service N/A until their owning epics define projections. |

Each parity test iterates all six frozen execution-source variants and every applicable
dimension. A `not_applicable` result must match the FND-007 rationale; absence of a current
crosswalk row for `browser_request` or `service_reconcile` is recorded as net-new, not silently
treated as parity passed.

---

## 6. Failure-mode coverage and observability

| Code path | Realistic production failure | Test | Handling / user signal |
|---|---|---|---|
| Flag-on tenant pool boot | Owner URL, missing app URL, role revoked | JOB-001 startup | Boot fails loudly; never falls back. |
| Submit/outbox | DB fails after job insert | JOB-001 rollback | Whole tx rolls back; retry by idempotency key. |
| Enrollment/session | Code replay or stolen old generation | JOB-002 | Uniform unauthorized/revoked; audited, no profile disclosure. |
| Placement | Worker self-advertises privileged capability | JOB-009 property | Server profile intersection rejects/queues with reason. |
| Lease claim | Two workers race | JOB-003 barrier | Row lock + partial unique yields one offer; loser gets no-work. |
| Renew/governed write | Lease expires between check and write | JOB-004 | Conditional in-tx guard rejects stale fence. |
| Event upload | Commit succeeds but ACK response is lost | JOB-005 restart/replay | Same digest replays cumulative ACK. |
| Cancel/reaper | Worker disconnects during artifact upload | JOB-006 | Fence first; late ordinary commit denied/quarantined downstream. |
| Capacity/revoke | Reaper and budget exhaustion both release | JOB-007 | Conditional release receipt makes second release no-op. |
| Operator UI | Poll fails or data is stale | JOB-008 UI | Visible error + last refresh time; no realtime claim. |
| Assignment bridge | Legacy and distributed submit concurrently | JOB-010 | Existing checkout has one winner; loser releases/no job. |
| Approval bridge | Worker forges an approval result | JOB-011 | No matching server aggregate/version/digest → deny before effect. |
| Cost bridge | Usage event replayed after restart | JOB-012 | Projection receipt/idempotency key prevents double charge. |
| Audit projection | Publish called before transaction commit | JOB-013 | After-commit callback only; rollback test proves no publication. |
| Output projection | Losing attempt completes late | JOB-014 | Active-fence/terminal-winner check blocks output/status/summary. |

No listed path is silent without both a test and handling. Stable metrics use bounded labels:
operation, source kind, target class, result/reason code, and workload—not Organization,
Company, actor, job, event content, or secret. Structured logs may include opaque IDs under
existing redaction policy. Activity/audit covers mutations; rejected security events are
attributable without becoming accepted product actions.

---

## 7. Gate traceability

### D0 REQUIRED / HARD / INITIAL map

| Requirement | Owning evidence |
|---|---|
| D0-T01 focused acceptance | Every ticket's result ledger and reviewer rerun. |
| D0-T02 lifecycle ownership | JOB-003/004/005/006/011/014 legal+illegal transition matrices against E1 state functions. |
| D0-T03 validators | JOB-001/002/003/004/005 run 10,000 deterministic vectors for any new auth/idempotency/secret-bearing validator; E1 validators remain unchanged. |
| D0-T04 protocol ownership | Expected N/A (zero E1 diff). Any additive protocol field triggers custodian review and full affected cross-version corpus. |
| D0-T05 hermetic inputs | All focused suites use embedded PG/fake clock/fixtures; no provider, customer, network, or live credential. |
| D0-R01 | Exact gate revision: through `Invoke-NativeGate`, build workspace packages, then run `pnpm -r typecheck`, `pnpm test:run`, `pnpm -r build`; classify only committed DEC-03 baseline failures as pre-existing/not-E3-touched. |
| D0-R02 | Root `pnpm build` through `Invoke-NativeGate`, with no tracked-byte mutation. |
| D0-R03 | JOB-003/004/005/006/007 and the final H-01/H-02/H-03 integration suite pass 3 consecutive times. |
| D0-R04 / EVID-01–03 | Byte-clean worktree and immutable QA/handoff with exact 40-hex revision, flags/config/protocol hash, commands/counts/durations, requirement IDs. |
| E3-PERF-01 pinned capacity gate | Independent Integration Gate Owner executes the prospectively frozen manifest/runner on the dedicated environment; distinct Security Gate Owner verifies the raw archive and writes the passing handoff. Overall E3 QA pins both Git blobs, manifest/blob/archive hashes, and exact implementation revision. |
| H-01 tenant isolation | Every ticket; final hostile cross-Org/Company submit/enroll/place/lease/event/control/operator/parity matrix through `runInTenant`. Zero tolerance. |
| H-02 lease authority | JOB-003–007/011–014; one shared stale/replaced fence surface matrix. Zero tolerance. |
| H-03 single executor | JOB-003/004/006/007/010/014 concurrent lease/replace/legacy races. Zero tolerance. |
| H-04 secret containment | E1 validators + JOB-001/002/005/008/013 redaction/canary tests + E3-PERF-01 strict non-secret manifest/evidence schemas, credentialless URI checks, child-output redaction, and recursive manifest/archive/QA/handoff secret-canary scans. |
| H-05 sandbox boundary | E3 sends only protocol control and no DB credential/tenant command to a worker; E6F-05 supplies the topology proof and E3 changes may not weaken it. |
| H-06 network boundary | E3 exposes no public ingress and no new egress; worker-control auth/topology negative enters E6/D1. |
| H-07 hosted exclusions | Default-off flag and existing distributed-exclusion checks remain green. |
| H-08 supply chain | E3 adds no image; the exact candidate consumes E6F-06 pinned-image/provenance evidence for worker/control-plane and the benchmark runner. E3-PERF-01 pins and verifies image, attestation/signature, policy, and trust-root digests and rejects tampered/unapproved inputs before sampling. |
| H-09 cleanup | JOB-006/007 contribute attempt/lease cleanup; provider resources remain E6 worker/provider owners. |
| H-10 evidence integrity | Append-only ticket/QA/handoff attempts and rejected/stale audit rules. |
| RET-01 INITIAL retention | Gate summary stays in Git permanently; controlled raw event/race/load evidence is retained ≥180 days. |
| D1-00 topology | PostgreSQL, MinIO, one control-plane replica, ≥2 workers, fake provider, Toxiproxy, isolated runner; E3 records joined E6 owner evidence. |
| D1-01 INITIAL 20×10k/≥10 Orgs | Final E3 tenant property campaign; focused tickets use smaller deterministic RED/GREEN samples. |
| D1-02 ≥1,000 lease races | Final claim/ACK/renew/replacement campaign; exactly one winner. |
| D1-03 ≥100k events + ≥10k each fault class | Final duplicate/gap/out-of-order/lost-ACK/restart/hash campaign. |
| D1-04 ≥100 lifecycle faults | E3 exit proves job/attempt/lease/control recovery against the E6 foundation fake-worker seam. Provider-resource kill/cleanup remains a later E6 contribution; E3 does not certify it. |
| D1-05 cancel ≤30s, cleanup ≤5m | E3 measures job/lease/control convergence only. Provider-resource cleanup remains E6's later contribution. |
| D1-06 artifact integrity 100% | E3 proves fenced artifact metadata/authorization as a non-certifying contribution. E5/DAT owns byte round trips and the later joined D1 gate; no E5 evidence is an E3 exit dependency. |
| D1-07 zero orphans | E3 exit requires no active E3 lease, unACKed terminal event, or capacity claim. Provider resources remain a later E6 joined-gate contribution. |

### `E6-D1-FOUNDATION` consumption

Before JOB-004+, verify E6F-00 dependency closure, E6F-01 100 two-profile races, E6F-02
25 fake-provider fault cases/zero resources, E6F-03 networked PG/MinIO/control-plane/worker
smoke, E6F-04 tenancy, E6F-05 topology, E6F-06 image policy, E6F-07 deliberate failure
evidence, and E6F-08 explicit non-certification. The E3 controller records the exact QA and
handoff paths/SHA in the first post-D1 ticket result. A ticket marked complete is not this
gate.

### E3 integration gate (independent Gate Owner)

1. Freeze one implementation candidate after all fourteen reviewer-completed ledgers.
2. Before any gate sample, the Integration Gate Owner and distinct Security Gate Owner
   prospectively approve the `E3-PERF-01` manifest described above against a clean evidence-
   parent revision that already contains all reviewed ticket records. The manifest pins that
   parent revision/tree, the exact implementation-to-parent evidence-only path/blob/review
   closure, and its own intended added path, but never its containing commit/tree. Preflight
   proves every executable/config/dependency/generated/schema/migration blob is identical to
   the frozen implementation revision and rejects an unlisted evidence delta.
   After strict schema/secret/parent preflight passes, commit exactly that one new file as a
   single-parent commit. Derive that commit/tree as the gate revision, verify its parent and
   one-path added diff, and record it later in QA/handoff. Any other code, evidence, dependency,
   migration, generated artifact, or runtime-configuration delta is a new implementation
   candidate and invalidates the campaign. The owners also verify the exact E6F-06 image/
   signature-or-attestation/policy/trust-root evidence before provisioning the disposable
   read-only detached checkout.
3. Build workspace packages before tests. Run focused critical suites 3×, then D0-R01/R02,
   foundation/protocol-boundary/idempotency/integration-hygiene checks, and byte-clean check.
4. Run the E3-owned D1 contributions at their INITIAL volumes/topology, retaining seeds and
   raw-log references. This is not full D1 promotion: E5 artifact bytes and the remaining E6
   provider-resource slices are downstream in the program DAG. H-01/H-02/H-03 failure is
   `fail`, never conditional/waived.

   ```powershell
   $env:AOA_RUN_WIN_INTEGRATION='1'
   $env:AOA_D1_TENANT_SEEDS='20'; $env:AOA_D1_OPS_PER_SEED='10000'; $env:AOA_D1_ORGS='10'
   $env:AOA_D1_LEASE_RACES='1000'; $env:AOA_D1_EVENTS='100000'; $env:AOA_D1_EVENT_FAULTS_EACH='10000'
   $env:AOA_D1_LIFECYCLE_FAULTS='100'
    try {
      Invoke-NativeGate 'E3 D1 contributions' {
        pnpm --filter @armyofagents/server exec vitest run `
          src/__tests__/job-control-d1-tenant.property.integration.test.ts `
          src/__tests__/job-control-d1-leases.load.integration.test.ts `
          src/__tests__/job-control-d1-events.load.integration.test.ts `
          src/__tests__/job-control-d1-lifecycle.integration.test.ts `
          src/__tests__/job-control-d1-artifact-authorization.integration.test.ts `
          src/__tests__/job-control-d1-reconciliation.integration.test.ts
      }
    }
    finally {
      Remove-Item Env:AOA_D1_TENANT_SEEDS,Env:AOA_D1_OPS_PER_SEED,Env:AOA_D1_ORGS,Env:AOA_D1_LEASE_RACES,Env:AOA_D1_EVENTS,Env:AOA_D1_EVENT_FAULTS_EACH,Env:AOA_D1_LIFECYCLE_FAULTS,Env:AOA_RUN_WIN_INTEGRATION -ErrorAction SilentlyContinue
    }
   ```

   The suites emit the exact ordered seed manifest, expected/observed operation counts,
   cancellation/cleanup timings, query plans, and reconciliation totals. Run the H-01/H-02/
   H-03 subset three consecutive times on the frozen revision. The QA record marks D1-04's
   provider-resource portion, D1-06 bytes, and provider-resource D1-07 closure as downstream/
   not certified by E3. Full D1 promotion joins E3, E5, and remaining E6 evidence later.
5. On Windows local, set `AOA_RUN_WIN_INTEGRATION=1` from `C:\e3` and label the result
   `operator-directed windows-local`. Linux CI is the formal DEC-03 authority.
6. On the same gate revision, the Integration Gate Owner runs the exact `E3-PERF-01` trigger
   on the manifest-pinned dedicated environment. Environment preflight mismatch, runner
   image/provenance failure, pre/post source/dependency byte mismatch, cleanliness failure,
   redaction/canary failure, any INITIAL threshold miss, or any REQUIRED structural miss is a
   failed attempt.
   The owner writes the immutable performance QA; the distinct Security Gate Owner verifies
   it and writes the performance handoff. Both paths, Git blobs, and raw-archive digest must
   say `pass` before continuing.
7. Gate Owner writes a new immutable
   `qa/<date>-d1-e3-job-control-<sha12>-aN.md`, then a distinct
   `handoffs/<date>-epic-completion-<sha12>-aN.md`, using a higher attempt for every retry and
   pinning every ticket ledger blob, reviewed
   revision, `E3-PERF-01` manifest/QA/handoff blob, runner blob, and controlled raw-archive
   digest. No self-certification.
8. Only after the performance QA/handoff and overall QA/handoff all say `pass` on the same
   gate and implementation revisions: change E3 README and epics index
   `backlog` → `complete`, commit evidence, fetch origin, verify
   `origin/docs/replatform-program` is an ancestor of HEAD, and—only with operator go-ahead—
   push `HEAD:docs/replatform-program`. Divergence is a STOP; never force-push.

---

## 8. Controller sequence and parallelization

The operator requested ticket-local fresh implementer/reviewer pairs. To keep migration and
shared service conflicts reviewable, the default controller sequence is:

```text
PRE-D1:
  JOB-001 -> JOB-002 -> JOB-009 -> JOB-003 -> JOB-010
                         |                     |
                         +---- E6/E4 work can consume interfaces after review

WAIT FOR committed passing E6-D1-FOUNDATION QA + handoff

POST-D1:
  JOB-004 -> JOB-005 -> JOB-006 -> JOB-007 -> JOB-008
                                      |
                                      +-> JOB-011 -> JOB-012 -> JOB-013 -> JOB-014

  all ticket reviews -> independent E3 gate -> operator push approval
```

At program level, JOB-001 and JOB-002 are independent enough to run in parallel worktrees,
and JOB-010 can follow JOB-001 while JOB-002/JOB-009 proceed. This E3 worktree deliberately
serializes them because all touch DB schema, shared route composition, and the one tenant
repository; avoiding migration-number and integration-ledger conflicts is cheaper than
parallel merge repair. Across epics, E4/E6 lanes may run independently according to Wave 2.

| Step | Modules touched | Depends on |
|---|---|---|
| Submit/admission foundation | db schema/repositories, server config/routes | E1/E2 |
| Enrollment | target registry, worker auth | E1/E2 |
| Placement | resolver, job repository | submit + enrollment |
| Lease/ACK | attempt/lease repository, worker route | submit + placement |
| Admission parity | legacy source services + submit | submit |
| Runtime lifecycle | lease/event/control/quota services | foundation partial gate + lease |
| Operator UI | server job-control API, UI settings | runtime lifecycle + placement |
| Legacy projections | existing policy/accounting/audit/output services | runtime lifecycle + admission parity |

### Commit/evidence boundaries

- Implementer code/migration commit per ticket; reviewer follow-up commit contains the
  append-only review result and is the only commit that completes the ticket.
- If one ticket needs a short commit series, every commit is scoped and the result ledger
  identifies the reviewed tip; no drive-by cleanup.
- Reviewers use plain `git commit` (never `--no-verify`).
- `findings.md` records discovered behavior, rejected hypotheses, STOP conditions, and
  resolution; a behavior-changing choice also updates `decisions.md` and this plan before
  implementation resumes.

---

## 9. Planner self-review

- All JOB-001–014 canonical outcomes/dependencies/failures are represented; standard tickets
  stay ≤3 agent-days and parity tickets are explicitly matrix-sized exemptions.
- JOB-009 precedes JOB-003; no job detail is exposed before tenant-scoped placement/claim.
- Every E3 entry point, background path, and bridge uses the E2 non-owner
  `runInTenant` transaction; E2-F012's requested NULLIF hardening is preserved because E3
  introduces no legitimate unwrapped tenant read and no raw unscoped repository.
- One conditional fence guard proves H-02 across every governed surface; row locking plus
  partial uniqueness and conditional transitions prove H-03.
- E1 v1 is consumed without edits and the custodian STOP is explicit.
- JOB-010–014 call the current engines, including the as-built conditional checkout rather
  than a stale SQL mechanism; CM-002/003/004/005/006/007/008/014 and every FND-007 dimension
  are mapped.
- Flag-off composition, no-effect shadow behavior, E10 cutover ownership, caveats
  CAV-001–004, migrations/#122, observability, rollback, evidence, and Linux-vs-Windows
  authority are explicit.
- The post-D1 named partial gate is a hard assignment boundary and the E3 gate has a distinct
  owner.

---

## 10. Implementation Tasks

Synthesized from the independent engineering review. Checkbox only after the named outcome
is committed and independently reviewed; these tasks do not authorize implementation.

- [ ] **T1 (P1 STOP, human: ~1 day / agent: ~2h)** — E2 serving role — choose and ratify A, B, or C.
  - Surfaced by: Architecture — locked E2-D03 contradicts migration 0211 and boot wiring.
  - Files: E2 decisions/findings/QA/handoff, migration/schema and startup files selected by the amendment.
  - Verify: corrective E2 security/integration gate and superseding `pass` handoff.
- [ ] **T2 (P1, human: ~2 days / agent: ~4h)** — legacy bridges — make outer transactions and publications safe.
  - Surfaced by: Architecture/Code Quality — current helpers publish early, fire-and-forget, or swallow errors.
  - Files: `issues.ts`, `costs.ts`, `budgets.ts`, `run-summary-comment.ts`, `agent-runtime-decisions.ts`, bridge adapters.
  - Verify: `job-legacy-after-commit.integration.test.ts` plus the owning parity suites.
- [ ] **T3 (P1, human: ~1 day / agent: ~2h)** — platform identity — close operator target and revocation authority.
  - Surfaced by: Architecture — enrollment needs both worker and target rows, while tenant fencing must see current generation.
  - Files: JOB-002 operator policy/pool, worker session auth, placement and fence authorization modules.
  - Verify: two-Organization revocation races against renew, event, secret, artifact, and completion.
- [ ] **T4 (P1, human: ~4h / agent: ~1h)** — capacity ownership — separate JOB-010 from JOB-007.
  - Surfaced by: Architecture — canonical admission parity and mixed capacity enforcement had overlapped.
  - Files: JOB-010 admission bridge/tests; JOB-007 capacity claim/release/wakeup service/tests.
  - Verify: source characterization pre-D1 and mixed legacy/distributed CM-014 proof post-D1.
- [ ] **T5 (P2, human: ~4h / agent: ~1h)** — readiness outbox — keep durable retry rows attempt-aware while process signals coalesce by target.
  - Surfaced by: Code Quality — job-keyed readiness cannot reliably rearm attempt N+1, while candidate IDs must not influence oldest-first leasing.
  - Files: `job_outbox.ts`, JOB-001 submit, JOB-003 drainer, JOB-006 retry/reconciliation.
  - Verify: retry attempt and readiness row commit atomically; the canonical tenant pull is sole selection authority and the coalesced signal changes retry latency only.
- [ ] **T6 (P2, human: ~4h / agent: ~1h)** — projection receipts — define durable exactly-once state.
  - Surfaced by: Code Quality — identity alone did not cover digest conflict, pending recovery, or target aggregate.
  - Files: `job_projection_receipts.ts`, tenant repository, parity bridge adapters.
  - Verify: same identity/same digest replays; different digest conflicts; pending resumes after crash.
- [ ] **T7 (P2, human: ~4h / agent: ~1h)** — acceptance commands — include every promised schema/security/load proof.
  - Surfaced by: Tests — focused commands omitted created DB/RLS/grant suites and exact D1 volume controls.
  - Files: ticket result ledgers, QA record, named DB/server integration suites.
  - Verify: command table in section 3 and D1 invocation in section 7 run on the reviewed revision.
- [ ] **T8 (P2, human: ~4h / agent: ~1h)** — fence contract — enumerate and guard all governed mutators.
  - Surfaced by: Tests — event, artifact, secret, completion, health, projection, and control ACK need one predicate.
  - Files: `job-fence-authorization.ts`, tenant repositories, contract and integration tests.
  - Verify: exported-governed-mutator contract test and stale/replaced fence matrix pass 3×.
- [ ] **T9 (P2, human: ~1 day / agent: ~2h)** — hot queries — bound polling and operator reads.
  - Surfaced by: Performance — claim/sweeper/control/outbox indexes and numeric fan-out limits were missing.
  - Files: schema indexes, poll/reconciliation services, operator list routes, D1 load suites.
  - Verify: query-plan assertions at INITIAL volumes, one-statement oldest-first claim with certificate anti-join, ≤32 Org shards per 750-ms launch-admission window, exact readiness-signal caps, and operator cursor default 50/max 200.
- [ ] **T10 (P2, human: ~4h / agent: ~1h)** — ticket sizing — keep standard tickets within reviewable slices.
  - Surfaced by: Code Quality / external Claude delta review — JOB-001/JOB-002/JOB-009 combine several independently testable changes.
  - Files: ticket result ledgers and commit sequences defined in JOB-001/JOB-002/JOB-009.
  - Verify: each slice has RED/GREEN evidence; one distinct reviewer certifies the combined ticket revision.
- [ ] **T11 (P1 STOP, human: ~1 day / agent: ~2h)** — E1 frozen check — decouple immutable fixture proof from the mutable repository lockfile.
  - Surfaced by: Architecture/Tests — JOB-001's required manifest+lock change otherwise fails the E1 frozen gate.
  - Files: E1 checker/mutation corpus and superseding E1 QA/handoff; frozen fixture bytes remain unchanged.
  - Verify: original fixture mutation failures still fail, LF/CRLF-safe Git-byte proof passes, and JOB-001's declared consumer dependency does not invalidate frozen v1.
- [ ] **T12 (P1 STOP, human: ~2 days / agent: ~4h)** — device proof/binding — ratify and test the JOB-002 threat model and registry relationship.
  - Surfaced by: Security/Architecture — frozen E1 JSON has no proof field; bearer thumbprint claims and an unlinked worker row are insufficient.
  - Files: JOB-002 schema, transport-auth middleware, enrollment/session services, threat-model vectors, E2 operator decision.
  - Verify: copied token without key, proof replay/tamper/skew/cleanup, route-only shard discovery, atomic tenant code+profile+receipt, DB-enforced target authority key, owner-type migration, multi-profile cardinality, rotation and revocation all fail closed.
- [ ] **T13 (P1, human: ~1 day / agent: ~2h)** — lifecycle authority — make ACK, start, time, generation, and retry allocation explicit.
  - Surfaced by: Architecture/Tests — independent review found incomplete state transitions and race ownership.
  - Files: JOB-003–007 plan-owned repositories/services/tests.
  - Verify: atomic lease+attempt ACK, started-event transition, fresh DB clock at mutation, globally linearized cutoff plus crash-safe tenant fanout, current-generation guard, and one N+1 retry under concurrency.
- [ ] **T14 (P1, human: ~4h / agent: ~1h)** — evidence/DAG — fail fast and keep E5/E6 remainder out of E3 exit.
  - Surfaced by: Evidence integrity/Architecture — PowerShell cleanup could mask failure and E5 was an undeclared completion dependency.
  - Files: focused-command table, E3 gate command, QA requirement map.
  - Verify: missing command and forced native exit both remain failures after cleanup; E3 QA marks downstream D1 slices not certified.
- [ ] **T15 (P1, human: ~4h / agent: ~1h)** — trust/transaction boundary — accept source intent and describe publication durability honestly.
  - Surfaced by: Security/Code Quality — `JobEnvelopeV1` is server-to-worker authority and existing live publications have no durable retry channel.
  - Files: JOB-001 submission DTO/service tests and JOB-005/010–014 receipt/bridge planning.
  - Verify: caller cannot choose authoritative delivery facts; principal+source-scoped idempotency, atomic durable projection, and best-effort live invalidation behavior are tested.
- [ ] **T16 (P1, human: ~1 day / agent: ~2h)** — E1 idempotent retry — persist enrollment/ACK/renew semantic outcomes separately from proof replay.
  - Surfaced by: Protocol/Tests — frozen E1 marks all three operations `idempotent_retry`.
  - Files: enrollment-code receipt fields, `worker_operation_receipts.ts`, JOB-002/003/004 services and tests.
  - Verify: same scope/key/digest plus fresh proof replays the original outcome, changed digest fails, and ACK/renew never reapply or extend twice across response loss/restart.

Review history is retained rather than overwritten. The first independent reviewer accepted
the earlier revision as a blocked plan. A fresh second reviewer then read committed revision
`5b57511e53d42a9c6d11e358379807389a285e87` and returned `REVISE / BLOCKED`: 7 P1 and
3 P2 findings, including device proof, fence-time/revocation, ACK transitions, retry
uniqueness, fail-fast evidence, and the E5 gate dependency. Controller verification added
the E1 lockfile-pinning STOP and the submission trust-boundary correction. After the
amendments, that fresh reviewer re-ran every affected area and returned
`ACCEPT AS BLOCKED PLAN` with no remaining P0/P1/P2 plan finding.

The user-provided Claude review was then provenance-checked. It reviewed the shared branch at
`8e2faa590d4e97a2cbd250c55f4a2ed81a352a33`, before either local planning commit, so its
headline that no implementation plan existed was accurate for that remote revision but stale
for this worktree. Its ordering, RLS/migration, and gate-evidence concerns were already
explicit here. Every ticket named rollback, but delta checking found that JOB-012–014 still
needed explicit pending-receipt flag-off semantics; those are now defined. Its JOB-009 sizing
concern also remained useful; the canonical ticket now has three bounded internal TDD/commit
slices without changing its locked outcome or number.
The suggestion to plan only the startable five or build E6 first was not adopted because the
operator and canonical program design require all of E3 to be planned now, with execution
split at the named `E6-D1-FOUNDATION` partial gate.

JOB-003 review attempt 2 later found four bounded scheduler/certification gaps. Fix-round-2
RED `c5be2a6853a93c1ad73910f1bdcd05c8299f93b6` proved those gaps, but pre-migration
inspection found that its initial two-field lease-scan cursor could not preserve the locked
four-part claim order. Implementation stopped before schema or migration work. Independent
review of the proposed full four-part cyclic cursor at
`0f1953d4f645d7530a9580289b03365911d02a0b` then returned `REJECT / P1 STOP`: stale cyclic
progress can bypass newly eligible older work, hint-first selection also violates global
ordering, JavaScript timestamps lose PostgreSQL microseconds, the physical index had the
wrong priority direction, scheduler bounds were unspecified, and the 750-ms text overclaimed
cumulative database time. No cursor implementation exists. This successor uses exact static-
negative certificates plus global-head selection, corrects the index and signal semantics,
and narrows 750 ms to an enforceable launch-admission window. Independent review of this exact
successor is required before the committed RED is corrected or GREEN resumes.

Two distinct read-only reviewers then rejected exact successor revision
`7cf1d763222b8f453b2aa1eeb19332f73a942722`. The shared P1 was that its opaque hash included
candidate fields that the pre-fetch SQL anti-join could not recompute. They also found
cross-profile capacity wording contrary to Decision #124, the omitted exact grant/startup
allowlist and schema export, missing raw app-role foreign/missing FK equality, non-gating load
numbers, no executable parent-UNIQUE-before-child-FK migration sequence, and contradictory execution status.
This revision resolves those findings by binding one application-computed poll-invariant
authority hash into SQL while comparing every candidate fact by ordinary correlated columns;
scoping capacity to the current logical Organization profile; pinning grants, exports, oracle
tests, load ceilings/distributions, and an explicit generated-migration dependency; and keeping JOB-003
explicitly blocked. Fresh whole-plan and schema/security acceptance of this exact revision is
still required.

Fresh dual review of `b42992bfa9793f5031b80c726cb340f27d01b428` closed those findings but
rejected four remaining exactness gaps: the parsed worker matcher snapshot was not separately
bound from its enrollment hash, neutral-adapter equivalence was only one-way, million-row
ordering did not force the adverse current-certificate prefix/sparse cleanup cases, and two
migration sentences contradicted the then-proposed cross-migration reorder. The next revision
bound the canonical neutral matcher projection, required bidirectional frozen equivalence,
pinned adverse row order plus buffer/row evidence and ceilings, and made that proposed reorder
explicit. Whole-plan review then found that the epic-local reorder had never been promoted
into Decision #19/AGENTS authority, while the schema/security reviewer otherwise accepted the
certificate design. It also found two P2 gate defects: the snapshot-mutation test overclaimed
capacity fields, and absolute p95 numbers on variable `ubuntu-latest` were not reproducible
gates. This revision removes the reorder entirely by using generated `0229` for only the
parent UNIQUE, generated `0230` for the child table/FKs/indexes, and custom `0231` only for
Decision #122 RLS/grants. It limits snapshot-hash mutation coverage to non-capacity matcher
fields, keeps capacity dynamic, treats variable-CI latency as observed, and requires a pinned
`E3-PERF-01` handoff before an exit/SLO claim. Another fresh dual review is required.

Fresh schema/security review accepted exact revision
`9bbd2002033b4f254f11f726af0c0c1493e88435` with no P0/P1/P2, and whole-plan review closed
all prior certificate/migration findings but rejected one remaining P2: `E3-PERF-01` was a
mandatory exit condition without an owner, prospective manifest, executable trigger,
immutable records, or explicit integration-gate consumption. This revision assigns the
independent Integration Gate Owner and distinct Security Gate Owner, freezes the environment
and INITIAL thresholds before any sample, adds the manifest-validating runner and exact
trigger, defines immutable QA/handoff/raw-retention evidence, makes every changed threshold a
new failed-preserving campaign, and pins all performance blobs into the E3 completion gate.
Another fresh dual review of the exact committed text is required.

Whole-plan review accepted exact revision
`349c3cc466ddeb50b98019315dbe18bda8fa3607` with zero P0/P1/P2, and schema/security review
confirmed every prior certificate/migration invariant but rejected three E3-PERF-01 P1s:
the executed source/dependency bytes were not attested at sample time, the benchmark image
digest lacked H-08 signature/provenance-policy verification, and broad environment/child
capture could retain credentials in long-lived evidence. This revision requires an approved
read-only detached checkout, Git-replacement-disabled pre/post whole-tree and critical-input
attestation, frozen-install dependency integrity, exact E6F-06 signature/attestation/policy/
trust-root linkage and negative verification, a closed non-secret evidence schema, fail-closed
child-output redaction, and archive/QA/handoff canary scans. Another fresh exact dual review is
required before RED correction or GREEN.

Exact review of `9d672ad743d08542c769a58988448294db01470e` kept all prior domains closed
but rejected a cryptographic self-reference: the manifest tried to pin the commit/tree that
would contain it. Schema/security review also found that permanent manifest URI strings were
strict in shape but not explicitly secret-safe. This revision instead pins the pre-manifest
evidence parent/tree and exact one-file addition, derives the gate commit/tree after commit,
and records those later in QA/handoff. Both manifest and evidence schemas are non-secret;
artifact/provenance URIs are credentialless content-addressed references with no userinfo,
query, or fragment; access credentials stay out-of-band; and every manifest string receives
recursive credential/canary scanning before commit and execution. Another fresh exact dual
review is required.

Exact review of `bddde5b13503799d9b84fed255ddc66cb0f74f4d` kept the self-reference and
secret-string fixes closed but found two remaining lineage/output P1s. The runner proved only
evidence-parent→manifest, not that implementation→evidence-parent contained no unreviewed
source/config/schema drift; and a prospective output destination cannot already contain the
future archive digest. This revision pins and verifies an exact reviewed evidence-only
implementation→parent path/blob closure while requiring every nonlisted executable/config/
dependency/generated/schema/migration blob to equal the implementation revision. It also
distinguishes digest-bound pre-existing input references from a credentialless approved
output repository/attempt namespace, deriving the final digest URI only after the scanned
archive exists and recording it in QA/handoff. Another fresh exact dual review is required.

Exact dual review of `73675cc621008ea0dcf18f6ae0c430162e7e448e` accepted the complete
static-certificate successor and performance-evidence contract with zero P0/P1/P2 findings.
The whole-plan reviewer accepted the executable migration, matcher, capacity, SQL, fairness,
load, and evidence seams. The independent schema/security reviewer accepted the DDL/RLS/FK,
grant/startup, snapshot-hash, provenance, secret-safety, and evidence-lineage contracts. This
closes the amendment-review block and authorizes only a corrected tests-only RED. Production,
schema, migration, and GREEN work remain unauthorized until the controller independently
reruns that RED and confirms that every failure is intentional and behavior-first.

That authorization is historical, not current. Final review attempt 3 of implementation
candidate `392c3a2da52c3fd812d7b9e2801fe6523f1cc657` returned `needs_changes` and opened
E3-F028–E3-F033: the serving pools were not bound to the migrated owner's advisory domain;
startup could accept missing relations or wrong RLS/policy posture; cleanup was neither
composed nor tuple-bounded; the formal performance CLI could not launch; required payload-free
metrics were absent; and non-platform poll/revoke inverted row-lock order. The binding
fix-round-3 delta above specifies the fresh RED/GREEN and review path. It does not complete
JOB-003, authorize an SLO claim, or waive the formal campaign.

Plan exactness review of docs commit `c1efbbe2177018d72db6bd0d16dc0996b5af8353`
then found six remaining P1 specification gaps: serial migration IDs were treated as order;
handshake peers/close could be abandoned; the 15/22 RLS/ACL certificate was not enumerated;
the tick reused a statement budget; flag-off retained a static route/leasing import chain; and
Node attested its own already-running executable. This revision closes those gaps with the
one-to-one hash-set reconstruction, common abort/settlement/forced-end proof, explicit
15-relation/22-policy plus relation/column ACL manifest, per-statement immutable-deadline
wrapper, flag-on dynamic module boundary, and out-of-band pinned absolute-Node bootstrap above.
The plan P1s are corrected; JOB-003 still remains `needs_changes` pending implementation and
fresh exact independent review.

Security re-review of docs commit `b1773d6743efaead970ca5edfee0d41911e5028c`
found one residual bootstrap substitution: handoff reused the campaign pin while invoking a
different hardcoded verifier path. The distinct Security config, exact verifier realpath/hash,
configured-path invocation, and isolated-verifier mutation RED above correct that plan P1.
Ticket status and evidence gates remain unchanged.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | Not run; not required for this backend planning pass. |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | Not run. |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 5 + JOB-003 successor attempts 1–7 rejected + attempt 8 accepted + final implementation review attempt 3 + fix-plan exactness review + Security bootstrap re-review | `NEEDS CHANGES — PLAN P1S CORRECTED, RE-REVIEW PENDING` | Final candidate review opened E3-F028–E3-F033; exactness review opened six plan P1s and Security re-review of `b1773d6743efaead970ca5edfee0d41911e5028c` opened one verifier-bootstrap P1, all now corrected in the binding delta. Ticket completion/SLO claims remain blocked pending implementation and fresh review. |
| Claude Code | `claude -p` | User-requested outside-model review | 0 | `AUTH BLOCKED` | Claude Code 2.1.126 is installed, but `claude auth status` reports `loggedIn: false`; no Claude review occurred. |
| Claude (user-provided) | pasted review | External plan delta review | 1 | `TRIAGED — STALE BASE` | Reviewed origin `8e2faa590`, not the local plan; three concerns were already closed, while JOB-009 sizing and explicit JOB-012–014 disablement were valid deltas and are now resolved in plan. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | Not run; E3 operator UI follows existing patterns. |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | Not run. |

**VERDICT:** `NEEDS_CHANGES` FOR JOB-003 FINAL REVIEW. The original plan is otherwise
independently review-complete, but JOB-003 must complete the binding fix-round-3 RED/GREEN,
focused/aggregate gates, and fresh independent review before a pass can be recorded;
the operator selected E2 option B plus the metadata-only operator role, approved the E1
checker-only correction, and approved JOB-002's HTTP-header proof/composite binding. Both
corrective gates passed. Post-D1 tickets remain blocked on `E6-D1-FOUNDATION`.

**UNRESOLVED DECISIONS:**
- No unresolved product or architecture choice. JOB-003 retains execution checkpoints at the fix-round-3 tests-only RED, each bounded GREEN review, the whole-candidate review, and the later independent E3-PERF-01 campaign/security handoff.
