# E3 — Durable Job Control — Findings

Planning and execution findings for JOB-001 through JOB-014. Findings are append-only;
resolution changes disposition but does not remove the original evidence.

## E3-F001 — E2 legacy-table grant prose is ahead of migration 0211

**Date:** 2026-08-09
**Status:** `resolved_by_corrective_E2_gate`
**Severity:** P1 STOP — locked-decision/as-built contradiction
**Affected tickets:** all E3 execution; directly JOB-001/JOB-010 through JOB-014

**Finding:** E2 QA prose says the non-owner `aoa_app` role is granted full DML on legacy
tables, but the as-built `packages/db/src/migrations/0211_tenant_rls_enforcement.sql` grants
it only `jobs`, `job_attempts`, `leases`, `workers`, `services`, `service_instances`,
`job_artifacts`, and `job_secret_handles`. E3 therefore cannot call the existing legacy
assignment/approval/budget/cost/audit/output services in the same non-owner tenant
transaction unless their exact tables receive additional grants. Falling back to the owner
pool would bypass the E2 serving-role contract and split the transaction.

**Independent-review correction:** Locked E2-D03 requires one non-owner application role,
full legacy-table DML grants, a flag-on whole-app serving connection, and privileged
migration separation. Migration 0211 and `server/src/index.ts` do not implement that
contract. The draft's least-privilege per-parity grants are a different architecture and
cannot resolve a locked E2 dependency by E3 planner fiat.

**Disposition:** STOP. The operator must choose one reviewed architecture and commit a
corrective E2 gate/handoff before E3 assignment: (A) correct E2 to its locked D03 contract;
(B) approve a successor that permits bounded parity-table grants on `aoa_app` while retaining
application-layer Company isolation for CAV-005; or (C) approve a successor with a distinct
non-owner `aoa_bridge` role/pool for legacy bridges while `aoa_app` remains the RLS-enforced
new-path role. If none is acceptable, order a dedicated E2 security/migration audit rather
than improvising. No E3 ticket is assignable meanwhile.

**Operator decision (2026-08-10):** Option B is selected. Amend E2-D03 with bounded traced
legacy-table grants on `aoa_app`, retain application-layer Company isolation for CAV-005,
and include E3-F002's metadata-only `aoa_operator` role in the same corrective E2 gate and
superseding handoff. Options A and C are not authorized.

**Resolution evidence (2026-08-10):** Independent review attempt 3 passed the corrected
serving/operator boundary at `7843b86e25eb1ff9c520308aef7f123fec6997a7`. Prerequisite
result, corrective E2 QA, and the superseding completion handoff are `complete`/`pass` in
reviewer evidence commit `6b1af52a4db8a0fa41514db564e8cb622b02e1ba`.

## E3-F002 — Platform-worker operator policy was described by E2 but not implemented

**Date:** 2026-08-09
**Status:** `resolved_by_corrective_E2_gate`
**Severity:** P1 — expected JOB-002 behavior but role model unresolved
**Affected tickets:** JOB-002, JOB-009, JOB-003

**Finding:** E2-D04/E2-D06 describe null-Organization `platform` worker rows as readable via
a distinct operator role/dedicated policy. Migration 0211 contains only the `aoa_app`
tenant policy (`organization_id = current_setting(...)::uuid`), so `aoa_app` correctly sees
and writes no null-Org worker row, but no application-serving operator policy exists yet.
Using the privileged owner connection for platform enrollment/session checks would violate
the non-owner serving contract.

**Disposition:** E2-D04/D06 make the missing operator-only behavior legitimate JOB-002
scope, but a new role/pool must be reconciled with E2-D03's “one non-owner application
role” during E3-F001 resolution. The draft candidate is a dedicated
NOSUPERUSER/NOBYPASSRLS `aoa_operator` role with least-privilege null-Org policies/grants for
both `workers` and `execution_targets`, an explicit fail-closed operator connection, and
tenant non-enumeration tests via a Decision #122 custom migration. The role cannot access
any job/attempt/lease/event/artifact/secret table. Platform polling authenticates the target
and captures a server-verified worker/target/generation principal snapshot through this
metadata-only path, then enters the selected Organization through the approved tenant/bridge
role and `runInTenant` before reading or leasing a job. The in-transaction fence guard must
recheck revocation/generation against authority visible through the chosen E3-F001 grant
model. This candidate is not authorized until the operator resolves E3-F001.

**Operator decision (2026-08-10):** Approve the proposed NOSUPERUSER/NOBYPASSRLS
`aoa_operator` role and fail-closed pool, limited to null-Organization platform target,
enrollment-route, device-proof, and revocation metadata. It receives no access to jobs,
attempts, leases, events, artifacts, or secrets. Implementation remains blocked until the
combined E2 corrective gate passes.

**Resolution evidence (2026-08-10):** The same reviewed revision proves the metadata-only
operator seam, masked-owner denial, exact effective-authority audit, target-resolver grant,
flag-off non-superuser safety, and awaited shutdown. JOB-002 still owns future enrollment,
proof, credential, routing, status, and revocation writes.

## E3-F003 — Current task checkout mechanism differs from historical shorthand

**Date:** 2026-08-09
**Status:** `resolved_by_canonical_ticket_text`
**Severity:** P2 documentation drift; no implementation blocker
**Affected ticket:** JOB-010

**Finding:** Repository guidance summarizes atomic issue checkout as `SELECT FOR UPDATE NO
WAIT`, while current `server/src/services/issues.ts` implements the single-winner behavior
with an atomic conditional update plus replay/stale-owner rules.

**Disposition:** JOB-010's canonical acceptance text explicitly says the observable
single-winner contract is authoritative and the plan must not freeze a stale SQL detail.
E3 reuses `issueService.checkout` and its current tests/service contract. No program-design
amendment is required.

## E3-F004 — Frozen-consumer checker pins the mutable repository lockfile

**Date:** 2026-08-10
**Status:** `resolved_by_corrective_E1_gate`
**Severity:** P1 STOP — frozen dependency gate conflicts with required consumer declaration
**Affected tickets:** JOB-001 and therefore all downstream E3 tickets

**Finding:** JOB-001 must declare `@armyofagents/worker-protocol: workspace:*` in
`server/package.json` and regenerate `pnpm-lock.yaml` under AGENTS §7. The as-built
`scripts/check-frozen-worker-protocol-consumer.mjs` hashes the current whole-repository
lockfile and compares it with the immutable E1 fixture's `lockfileIntegrity`. A legitimate
new server importer therefore makes the frozen check fail even though E1 source and frozen
bundle bytes remain unchanged. The same checker hashes working-tree bytes and currently
false-fails on a Windows CRLF checkout while the Git blobs still match the recorded hashes.

**Disposition:** STOP. The E1 Protocol/Schema Custodian must keep the frozen fixture
byte-identical but correct the checker to validate immutable source-SHA blobs or a protocol-
relevant dependency snapshot, including recorded Zod/esbuild versions instead of current
installed versions; fail if the source commit is unavailable; retain/extend its mutation
corpus; make Git-byte verification line-ending safe; and commit superseding QA/handoff
evidence. Changing the fixture, omitting
the consumer manifest dependency, or bypassing the check is not authorized.

**Operator decision (2026-08-10):** Approve the checker-only correction exactly as scoped
above. Frozen protocol/schema/bundle fixture bytes remain unchanged. JOB-001 remains blocked
until the Protocol/Schema Custodian commits superseding passing E1 QA and handoff evidence.

**Resolution evidence (2026-08-10):** Independent review attempt 3 passed the corrected
checker at `01ad1ab554fe25c5178c7552ec047d4df45b7dcf`. The prerequisite result, corrective
E1 QA, and superseding completion handoff are `complete`/`pass` in reviewer evidence commit
`db8afd27ab134ad741a96d2ef7f157c306690c44`. Frozen source/fixture trees are unchanged.

## E3-F005 — Device proof and worker-to-target binding are not frozen E1 interfaces

**Date:** 2026-08-10
**Status:** `approved_pending_JOB-002_implementation`
**Severity:** P1 STOP — security contract and schema binding unresolved
**Affected tickets:** JOB-002, JOB-009, JOB-003 and every governed worker operation

**Finding:** E1's strict enrollment request contains the request envelope and `hello`, but
no device public key, proof, or returned session field. The prior plan promised a thumbprint-
bound session without a proof transcript or per-request possession check; a copied bearer
token would therefore retain authority. The E2 `workers` row also has no target FK and its
deferred `owner_user_id` is `uuid`, while `authUsers.id` and
`execution_targets.owner_user_id` are `text`.

**Disposition:** The revised plan proposes, but does not approve, versioned HTTP header
proof using a device key while leaving E1 JSON unchanged, fresh per-request proof/replay
enforcement, bootstrap-only treatment of `worker_token_hash`, and a many-logical-workers-to-
one-execution-target composite `target_authority_key` binding that DB-enforces platform/same-
Org/same-owner compatibility, plus owner-ID type/FK correction. Durable proof-ID records have
explicit operator-role ownership, expiry indexes, retention, bounded cleanup, and restart
coverage. An opaque routing table discovers the candidate shard, while Organization/owner
code consumption, profile creation, and replay receipt commit in one `runInTenant`; platform
facts commit in one operator transaction. Unenrolled legacy targets keep
their current heartbeat credential; enrollment upgrades that target's heartbeat auth without
transferring execution authority. The operator must ratify that
threat model and exact binding, or choose an additive versioned E1 change with custodian
review. Pure bearer sessions are rejected.

**Operator decision (2026-08-10):** Approve versioned Ed25519 HTTP-header possession proof,
fresh proof-ID/time-window enforcement, separate durable semantic replay receipts, and the
database-enforced composite target-authority binding/owner-ID correction. Frozen E1 JSON
remains unchanged; an additive E1 wire change is not authorized.

## E3-F006 — Lifecycle, fence-time, revocation, and retry allocation were incomplete

**Date:** 2026-08-10
**Status:** `resolved_in_plan`
**Severity:** P1 plan correctness
**Affected tickets:** JOB-003 through JOB-007

**Finding:** The first draft did not atomically name both lease and attempt ACK transitions,
did not assign the later running transitions, accepted an ambiguous `now`, did not require a
current target-generation recheck, and had no unique/locked retry-attempt allocation.

**Disposition:** The plan now assigns ACK to lease `offered→active` plus attempt
`offered→leased`, assigns `attempt_started` to attempt/job running transitions, uses database-
fresh `clock_timestamp()` inside conditional mutation, makes a globally locked generation
cutoff immediately invalidate every governed guard, durably fans platform revocation into
separate `runInTenant` cancellation transactions, and adds a locked unique
`(organization_id, job_id, attempt_number)` allocator with concurrency/crash tests. Durable
same-key/same-digest operation receipts make enrollment/ACK/renew lost-response retries replay
without reapplying; a fresh device proof ID remains mandatory.

## E3-F007 — Evidence commands could false-green and the exit gate depended on E5

**Date:** 2026-08-10
**Status:** `resolved_in_plan`
**Severity:** P1 evidence integrity / program DAG
**Affected tickets:** all ticket ledgers and the E3 integration gate

**Finding:** PowerShell command chains used `;` and cleanup cmdlets, so a later successful
cmdlet could mask a failed native process. The E3 exit gate also required joined E5 artifact-
byte evidence even though E5 is a parallel/downstream lane and full D1 promotion occurs only
after E3/E5/E6 contributions exist.

**Disposition:** Every native process now runs through a fail-fast wrapper that makes errors
terminating and checks both invocation success and native exit code, with cleanup in
`finally`; missing-command and nonzero-native probes both propagate. E3 exit proves only E3-owned D1 contributions, including fenced
artifact authorization/metadata; it explicitly leaves artifact bytes and remaining provider-
resource proof to the later joined D1 gate.

## E3-F008 — Submission trusted a delivery envelope and publication durability was overstated

**Date:** 2026-08-10
**Status:** `resolved_in_plan`
**Severity:** P1 trust boundary / transaction semantics
**Affected tickets:** JOB-001, JOB-005, JOB-010 through JOB-014

**Finding:** `JobEnvelopeV1` contains server-authoritative delivery identities, hashes,
policy, and placement facts, so it is unsafe as external submission input. The first draft
also called existing live publications retryable without naming a durable publication outbox.

**Disposition:** External sources now use a bounded `SubmitJobCommand`; the server derives
authority and JOB-003 constructs E1 delivery from stored facts. Idempotency is principal/
source scoped with principal kind+ID in the unique key. Required legacy mutations and receipt state remain atomic, while current live
publications are explicitly best-effort invalidations; any correctness-critical delivery must
name a durable outbox.

## E3-F009 — External Claude review used the pre-plan shared-branch revision

**Date:** 2026-08-10
**Status:** `resolved_in_plan`
**Severity:** P2 review provenance / ticket sizing
**Affected ticket:** JOB-009; E3 plan review record

**Finding:** The user-provided Claude review inspected
`origin/docs/replatform-program` at `8e2faa590d4e97a2cbd250c55f4a2ed81a352a33`, where the
E3 folder still contained only its README. Its statement that E3 had no implementation plan
was therefore true for that shared revision but did not assess the local plan added by
`5b57511e5` and hardened by `173b89685`. The review's ordering, E2 RLS/composite-FK/C14,
and gate-evidence concerns were already closed in the local plan. Every ticket named
rollback, but JOB-012 through JOB-014 lacked explicit disablement behavior for accepted
events whose cost/audit/output projection receipt was still pending. Its observation that
canonical JOB-009 could hide more than three agent-days of work was also actionable.

**Disposition:** Keep JOB-009 as the locked canonical ticket, but divide its execution into
three explicit internal TDD/commit slices of no more than one agent-day: authority/schema
normalization, pure deterministic placement policy, and transactional persistence/concurrency.
Each slice records RED/GREEN evidence; a single distinct reviewer certifies the combined
ticket revision. For JOB-012 through JOB-014, flag-off first blocks new distributed
admission/leasing, then permits every already accepted projection to reach a terminal receipt;
the rollback gate refuses bridge disablement while a receipt is pending. Do not adopt the
proposed five-ticket-only plan or E6-first reordering: the operator and canonical program
design require all fourteen E3 tickets to be planned now, while execution stops at the named
`E6-D1-FOUNDATION` boundary.

## E3-F010 — Enrollment upgrade paths could restore or retain bearer authority

**Date:** 2026-08-10
**Status:** `resolved_in_JOB-002_implementation`
**Severity:** P1 authority downgrade / secret retention
**Affected tickets:** JOB-002 and every later worker-authenticated operation

**Finding:** Final JOB-002 conformance checks found two downgrade paths before Slice C GREEN
was committed. The existing legacy token-rotation service could repopulate
`execution_targets.worker_token_hash` after a target had enrolled a proof-bound worker, and
the first local semantic-retry draft placed the returned bearer session in the retained JSON
receipt. The former could restore bootstrap bearer authority; the latter contradicted the
approved plan's prohibition on stored raw code/session material.

**Disposition:** Enrollment clears the bootstrap token, and legacy rotation now uses one
conditional update with an atomic `NOT EXISTS` current enrolled-worker guard. Semantic
receipts store only bounded E1 response/action facts. A retry must present a fresh valid
device proof, revalidates the current worker/target/generation/key/profile/membership inside
the owning transaction, and mints a new equivalent short-lived session. Tenant and platform
rollback tests cover the final receipt boundary; revocation/rotation/transfer and no-session-
at-rest regressions pass. No nonconforming Slice C GREEN revision was committed.

## E3-F011 — JOB-002 review found transport, shared-target, replay, and fixture gaps

**Date:** 2026-08-10
**Status:** `resolved_in_JOB-002_fix_round_1_pending_review`
**Severity:** P1 H-01/H-04, migration, and evidence correctness
**Affected ticket:** JOB-002

**Finding:** Independent review attempt 1 found seven blockers: production HTTP request logs
could serialize worker credentials; Organization profiles on a shared platform target could
not retire or heartbeat global state safely; a global worker UUID collision exposed raw 23505
details; enrollment omitted bounded expired-proof cleanup; worker-control failures did not use
frozen `ProtocolErrorV1`; migration 0219 failed exact replay; and stale E2 worker fixtures
failed before their tenant assertions.

**Disposition:** Fix round 1 added genuine RED at
`894b84cbfd79132759daf43784d2381fbeb92246` and GREEN at
`988c2a8af24a1b24b1b9b896aae94e696dda53e4`. Credential routes now have strict safe request/
error logging; a shared platform target must first have current proof-bound platform physical
authority, while tenant heartbeat records profile liveness only and sessions recheck global
revocation; collisions and all HTTP failures close in frozen protocol vocabulary; proof
cleanup is ordered and bounded; 0219 replay is guarded; and E2 fixtures establish valid
target/device facts before non-vacuous H-01 assertions. Focused lanes pass, but the ticket
remains review-pending until a distinct reviewer independently certifies the candidate.

## E3-F012 — JOB-002 review attempt 2 found revocation, protocol-error, and replay-cleanup races

**Date:** 2026-08-10
**Status:** `resolved_in_JOB-002_review_attempt_3`
**Severity:** P1 authority/replay correctness
**Affected ticket:** JOB-002 and every later worker-authenticated operation

**Finding:** Independent review attempt 2 confirmed the seven attempt-1 corrections, then
found three remaining blockers with temporary adversarial probes. First, an Organization
session bound to a shared platform target rechecks global physical authority during
authentication, but heartbeat later commits tenant-profile liveness without rechecking that
global authority; revocation between those steps therefore loses the race. Second, a
heartbeat request with no bearer fails before the route marks the response as worker protocol
v1, so it emits the generic HTTP error rather than frozen `ProtocolErrorV1`. Third, enrollment
deletes only the oldest 100 expired proof rows before inserting a proof. If the colliding
expired proof is outside that batch, the unique insert fails and rolls back the cleanup, so
every retry repeats the same failure forever.

**Disposition:** Fix round 2 added genuine RED at
`e66f173918eda336c0340a447ae8eab0862b2c0a` and GREEN at
`d9c8aa5db73f4218ae02f1ee505623c4ffd7e509`. Shared-platform physical heartbeat now
linearizes with revocation in one bounded operator transaction and conditionally updates only
physical liveness after rechecking every pinned authority fact; tenant profiles and global
trust/capability metadata are not mutated. The heartbeat route marks protocol context before
Authorization parsing and lookup. Proof recording deletes only the exact expired collision
by fresh database clock, independently of bounded housekeeping, and preserves unexpired
replay authority. Deterministic both-order row-lock tests, frozen-envelope early failures,
positions 1/100/101/301, restart, and concurrent-replica tests pass. Focused, RLS,
startup, frozen-E1, typecheck, and build lanes pass. The exact Windows full lane remains
honestly non-green for visible non-JOB-002 contention/Windows collection failures and is not
waived. JOB-002 is `implementation_complete_review_pending` until a distinct reviewer
independently certifies the candidate.

**Review-attempt-3 closure:** Distinct reviewer `Codex /root/job002_review` reviewed exact
revision `5a9870b89dbab1b626f825ec8e8261a6f77bd641` and independently reproduced all three
closures. Deterministic revoke-first and heartbeat-first row-lock tests proved that shared
platform liveness and revocation linearize and that the revoked principal cannot write again;
an additional temporary probe proved a caller-requested status change cannot mutate global
trust/status or tenant-profile liveness. Missing bearer, malformed bearer, and lookup failure
all produced descriptor-allowed frozen `ProtocolErrorV1`. Expired collisions at the committed
1/100/101/301 positions, an additional final-row collision, unexpired replay, restart, and
concurrent replicas all behaved as specified while cleanup remained bounded. No Critical,
Important, or specification blocker remains; JOB-002 review attempt 3 passed.

## E3-F013 - JOB-009 needed proof-bound profile authority without widening legacy resolution

**Date:** 2026-08-10
**Status:** `resolved_in_JOB-009_implementation_pending_review`
**Severity:** P1 authority boundary / compatibility evidence
**Affected ticket:** JOB-009

**Finding:** The E2 registry had the correct target identity/generation/scope and JOB-002
persisted a hash of the worker hello, but authoritative placement also needs the registered
profile/provider ceilings and the proof-bound full hello that can only narrow those ceilings.
Legacy target rows do not contain that authority and cannot be inferred safely. JOB-002 also
leaves a freshly proof-bound worker in `enrolled`; its heartbeat path updates liveness but does
not promote trust status. During aggregate verification, the first implementation additionally
widened the pre-existing heartbeat resolver projection to the new profile columns, which broke
the E2 serving-role fixture and coupled legacy resolution to placement-only authority. Its
Windows integration skip expression also allowed Linux to skip the suite, which violated the
fail-closed test-hygiene contract.

**Disposition:** JOB-009 extends the one `execution_targets` registry with an atomic registered
profile/provider-constraint snapshot and stores the proof-bound full hello on the existing
worker row; it creates no second registry or wire field. Legacy rows without an explicit
registered placement profile remain ineligible/queued rather than receiving inferred
privilege. A current proof-bound `enrolled` worker or `active` worker may be considered only
when every target/generation/profile/key/thumbprint/hello fact still matches; hello can only
reduce server authority. Rich profile reads live in the JOB-009 bounded tenant/operator
repositories, while the legacy heartbeat resolver retains its original projection. Serving
role grants add only the exact new target-profile columns, and the integration suite runs by
default on Linux while Windows requires `AOA_RUN_WIN_INTEGRATION=1`. Focused placement,
role/RLS, migration/C14, frozen-E1, typecheck, and build lanes are green. The exact Windows
aggregate remains honestly non-green for visible non-JOB-009 collection/contention/timeouts;
DEC-03 Linux CI remains formal authority and a distinct reviewer must still certify JOB-009.

## E3-F014 - JOB-009 review exposed producer, registry, resolver, replay, rollout, and lease-invariant gaps

**Date:** 2026-08-10
**Status:** `resolved_in_JOB-009_fix_round_1_pending_review`
**Severity:** P1 authority integration / H-03 defense in depth
**Affected ticket:** JOB-009 and the JOB-001/JOB-002 seams it consumes

**Finding:** Independent review attempt 1 found six Important blockers. JOB-009 parsed a
synthetic job shape rather than JOB-001's exact persisted requirements/request; the registered
target profile columns had no production authority writer; placement recreated routing without
Decision #117 credential/pin/slug resolution; replay digests omitted immutable placement
authority; rollout mode/reason were caller supplied; and PostgreSQL admitted lease-eligible
shadow, legacy, queued, and failed decisions. These gaps made the synthetic focused matrix
green while real submitted jobs and real enrolled targets could not safely become eligible.

**Disposition:** Fix round 1 committed genuine RED at
`11849e0f59b184e8dbc8a3d6041cc00f8173bba1` and GREEN at
`03005fcfacf7b924aae76d9c81666a5487039ce2`. The trusted server now normalizes the exact
JOB-001 persisted source objects for all six sources, ratifies canonical E1 profile/provider
hashes through bounded tenant-admin and platform-admin writers on the existing target registry,
and consumes `chooseExecutionTargetRow` for Decision #117 personal credential, bound slug, and
pin authority. One canonical digest binds every submitted, normalized, credential, resolver,
rollout, and selected-profile authority fact; byte-equivalent replay converges and a committed
20-field mutation matrix rejects drift. Rollout is resolved inside the trusted service through
the established deployment -> Organization -> workload gate using only closed reasons, and
flag-off never opens the operator reader. Generated Drizzle migration `0225` plus C14 guards
enforces lease eligibility iff selected+active; custom Decision #122 migration `0226` adds only
the exact profile-writer column grants.

The real registration -> JOB-002 enrollment/heartbeat -> JOB-009 placement test also showed
that proof-bound heartbeat updated only target liveness while placement correctly requires both
target and worker liveness. The bounded correction updates the exact proof-bound worker in the
same owning transaction after rechecking generation/key/thumbprint/profile facts; it does not
change status/trust/capabilities or contact the worker. Focused placement/grant **35/35**,
JOB-001/JOB-002/tenant/RLS **96/96**, serving-role/hygiene **22/22**, migration/C14 **5/5**,
startup **14/14**, frozen protocol, typecheck, and build lanes pass locally. The exact Windows
full lane exited 1 after 106.1 seconds without an aggregate because Vitest's IPC channel closed
after an unrelated embedded-Postgres setup failure; it is recorded as non-green and not waived.
JOB-009 remains `review_pending` until a fresh distinct reviewer certifies the new candidate.

## E3-F015 - JOB-009 pre-resolution order and owner-membership races

**Date:** 2026-08-10
**Status:** `resolved_in_JOB-009_fix_round_2_pending_review`
**Severity:** P1 placement determinism / owner authority linearization
**Affected ticket:** JOB-009 and JOB-003's later authority recheck

**Finding:** Independent review attempt 2 found two Important blockers after confirming the
first fix round. The real transaction passed unordered tenant-plus-platform snapshots to the
existing Decision #117 resolver, so equivalent multi-match candidate sets could select a
different trusted target before the downstream pure policy sorted anything. Separately, owner
membership was read earlier in the tenant transaction but was not part of the final conditional
placement write. A suspension or deletion could therefore commit after the snapshot and before
the attempt update, while the old code still persisted an active, lease-eligible owner target.

**Disposition:** Fix round 2 committed genuine RED at
`d3b4f50cbcf3ce9348d2482261c098b4864f8141` and GREEN at
`372f150c9364d86caa63eb15edaa500ba44b7021`. A registered-authority comparator now orders the
combined candidate snapshot by scope/class priority plus slug/ID total-order tie-breaks before
the unchanged Decision #117 resolver runs; explicit pin and credential-bound target precedence
remain resolver-owned. All candidate permutations, equal-priority ties, tenant/platform
composition, and database enumeration changes converge on the same persisted placement.

The same final conditional attempt `UPDATE` now requires current active membership for the
exact Company, Organization, and owner principal when selecting an owner-desktop target.
Remove-first affects zero selected rows and persists only the stable unavailable,
lease-ineligible decision without a membership-existence oracle or partial tuple;
placement-first remains an immutable historical decision for JOB-003 to recheck/fence.
Delete/suspend, foreign/missing authority, retries, and non-owner targets are covered by
deterministic real-PostgreSQL barriers. No membership UPDATE grant, schema/migration, owner
fallback, lease/fence, or second registry was added. Focused JOB-009/grant **39/39**,
JOB-001/JOB-002/tenant/RLS **96/96**, startup **14/14**, serving-role/hygiene **22/22**,
migration/C14 **5/5**, frozen protocol, typecheck, and build lanes pass locally. The exact
Windows integration-enabled full lane remains honestly non-green with 17 visible failure
blocks in truncated output, none emitted from JOB-009; it is not waived. JOB-009 remains
`review_pending` until a fresh distinct reviewer certifies the candidate.

## E3-F016 - JOB-003 aggregate verification exposed receipt-grant and lifecycle-fixture drift

**Date:** 2026-08-10
**Status:** `resolved_in_JOB-003_implementation_pending_review`
**Severity:** P1 fail-closed startup authority / deterministic regression evidence
**Affected ticket:** JOB-003

**Finding:** JOB-003 migration `0228` correctly granted tenant-serving DML on the new forced-
RLS `worker_operation_receipts` table, but the exact runtime startup authority allowlist still
expected no access to that table. The real server therefore failed closed at startup before
later negative cases could exercise `aoa_operator`. The same aggregate lane also found two
older test fixtures that seeded `active` leases without the newly required `activated_at`
fact, causing setup failures before their tenant and composite-integrity assertions.

**Disposition:** A genuine grant-contract RED was committed at
`a20758916ba18ddd9475e17ca6df9ccd595c6386` and GREEN at
`0c52ecbf1044cc1eadccfbaeb4de0fd2d8798428`. `JOB_LEASING_NEW_PATH_GRANTS` is a versioned
JOB-003 delta consumed by the fail-closed startup checker; immutable E2 grant constants and
applied migrations remain unchanged. The exact startup suite now passes 14/14, including all
role/grant/ownership drift denials. Fixture-only commits
`a1ade69e727d51ed4b8b28db1f3f4ab8adfeb8c5` and
`ee8a1005fa2a0d97f2dfcb68dbce1aa6b88f83a8` supply activation timestamps to legitimate
active-lease seeds. The adversarial tenant suite passes 11/11 across 4,460 operations and the
composite-integrity suite passes 9/9. JOB-003 remains review-pending for independent review.

## E3-F017 - JOB-003 review exposed platform composition, capacity, receipt-expiry, and upgrade gaps

**Date:** 2026-08-10
**Status:** `partially_resolved_in_JOB-003_review_attempt_2_followups_open`
**Severity:** P1 durable leasing correctness / compatibility
**Affected ticket:** JOB-003

**Finding:** Independent review attempt 1 found four Important blockers. The approved
operator-owned platform poll/outbox path exists only as uncomposed factories while HTTP proof
middleware rejects platform principals, so platform workers cannot poll and ready outbox rows
are never drained. Poll capacity counts all live leases against each candidate's one workload
slot limit and terminates the scan, allowing one batch lease or an incompatible head row to
hide valid browser work. ACK's bounded cleanup can leave the exact expired semantic receipt
outside the first 100 rows, after which an expiry-blind lookup replays stale success. Finally,
migration `0227` adds `activated_at` and an unconditional active-state check without an
idempotent compatibility step, so an E2-valid pre-upgrade active lease fails the migration.

**Disposition:** `needs_changes`. Real-PostgreSQL probes independently reproduced the
mixed-workload `no_work`, stale receipt replay behind 101 older expired rows, and SQLSTATE
23514 migration failure. The platform composition gap is also direct from the production call
graph: scheduler/outbox factories are consumed only by the focused test. A fresh implementer
round must add genuine RED coverage and (1) compose the flag-on-only operator-principal,
fair/bounded 32-shard/750-ms poll and outbox runtime while every job read remains in
`runInTenant`; (2) enforce independent applicable workload capacity and continue past
ineligible candidates; (3) validate/delete the exact expired receipt independently of bounded
housekeeping using database time; and (4) make the 0226-to-0227 upgrade compatible via a
C14-permitted idempotent data correction or narrowly proven legacy branch. Add non-vacuous
cross-tenant receipt RLS evidence before certification. Frozen E1, default-off behavior, and
the JOB-003 scope boundary must remain unchanged.

**Resolution:** Consolidated RED `6b722932e25a5e275dd3fa93d6c7b347b4e0bf7d` and GREEN
`ef972af6fde478f9e39fd36c36c23591a72c3eac` implement the independently accepted Decision
#124 successor, class-aware/no-head-of-line capacity, exact current receipt expiry, idempotent
populated-E2 migration backfill, and non-vacuous receipt RLS probes. Scheduler/legacy-authority
RED `8ce0547b68953fd1d4d8a0aa9d7180fb51b9a54e` and GREEN
`a61f028bd1fab392a08be879c7275a80a95e08cb` close the production composition and retired-token
writer gaps. All focused matrices pass locally; JOB-003 remains review-pending.

**Review attempt 2:** Exact revision `a48faac86cf3a875e5a16c487d91e88d9f78d6fd`
passes the original platform composition, mixed-class/provider capacity, exact receipt expiry,
populated upgrade, and cross-Organization receipt probes. The finding remains partially open:
E3-F021 through E3-F023 show that the composed scheduler is not bounded across target IDs or
all admitted Organizations and that restart/lost-hint pull recovery can still starve work
beyond the fixed candidate window.

## E3-F018 - Platform-physical ACK has no approved durable tenant-shard authority

**Date:** 2026-08-10
**Status:** `resolved_in_JOB-003_review_attempt_2`
**Severity:** P1 STOP - H-01/H-02 tenant routing authority / frozen transport compatibility
**Affected tickets:** JOB-003 and later platform-session lease operations

**Finding:** JOB-003 review requires the platform-worker scheduler and outbox path to be
composed, but the approved single platform-physical session cannot durably route an ACK into
the mandatory tenant transaction. The frozen strict Lease ACK v1 body contains worker, job,
attempt, lease, fence, and timestamp facts but no Organization identifier; the current ACK URL
is lease-only. A platform-scoped worker session is structurally bound to
`organizationId: null`. No durable lease-to-Organization locator exists, and Decision #123 /
E3-F002 deliberately deny `aoa_operator` access to jobs, attempts, leases, outbox rows, and
operation receipts. An in-memory offer map is not restart-safe, a bounded tenant scan can miss
the ACK before its deadline, an unbounded scan creates a tenant oracle, and widening operator
lease access violates H-01. The existing Organization-scoped logical worker sessions on a
shared platform target are routable because their authenticated session carries the tenant,
but that is different from the plan's single platform-session scheduler prose.

**Independent review:** A distinct reviewer confirmed the STOP against the frozen E1 schemas,
current proof middleware, routes, grants, migrations, and call graph. Directly adding an
Organization field to the strict v1 JSON is incompatible. An unsigned header or query value
would not be authoritative; a signed/versioned path could only be a routing hint and still
does not by itself solve the platform-physical-worker to tenant-logical-worker binding.

**Recommendation:** Amend JOB-003 so tenant job poll/offer/ACK uses the existing
Organization-scoped logical session even when its physical target is platform-scoped. Keep
the platform-scoped session limited to physical registry and lifecycle control. This preserves
the frozen wire schema, makes the authenticated Organization select `runInTenant`, retains the
tenant logical worker identity used by lease foreign keys, and adds no operator job metadata.
The flag-on scheduler can still discover admitted Organization shards fairly and durably, but
must issue tenant work only through the corresponding Organization-scoped session.

If one platform-physical session must serve many tenants, an explicit architecture amendment
is required instead: a dedicated tenant-written locator containing only a domain-separated
hash of the opaque lease ID, candidate Organization, and expiry, inserted atomically with the
offer; FORCE RLS; own-Organization `aoa_app` DML; exact-lookup-only operator authority; no raw
lease, fence, job, or payload; and complete tuple/fence/deadline revalidation inside the
selected `runInTenant` transaction. That option must also define physical-to-logical worker
binding, revocation linearization, uniform missing/foreign behavior, retention, cleanup, and
exact startup-grant audits. It has residual operator-visible activity metadata and is therefore
not the preferred option.

**Disposition:** No fix-round RED or production change was started after this contradiction
was found. On 2026-08-10 the operator approved the recommended Organization-scoped-session
amendment as the production design. Decision #124 and the JOB-003 plan now require tenant
poll/offer/ACK and every later tenant worker operation to authenticate through the logical
Organization profile; the platform-scoped session remains physical-control-only. No lease
locator or E1 change is authorized. JOB-003 remains `needs_changes` until a fresh TDD fix
round and distinct review prove the amendment plus E3-F017; JOB-010 remains paused until that
review closes.

Implementation RED `6b722932e25a5e275dd3fa93d6c7b347b4e0bf7d` and GREEN
`ef972af6fde478f9e39fd36c36c23591a72c3eac`, followed by scheduler/legacy-authority RED/GREEN
`8ce0547b68953fd1d4d8a0aa9d7180fb51b9a54e` /
`a61f028bd1fab392a08be879c7275a80a95e08cb`, now enforce the approved logical-session design.
Platform sessions remain physical-control-only; no locator, operator job access, or frozen E1
change was added. The prior `needs_changes` disposition is now resolved in implementation,
pending a fresh distinct JOB-003 review; JOB-010 remains paused until that review passes.

**Review attempt 2 resolution:** The distinct reviewer confirmed the approved Decision #124
logical-Organization session design at exact revision
`a48faac86cf3a875e5a16c487d91e88d9f78d6fd`. Platform physical sessions remain control-only;
tenant poll/offer/ACK is routed by authenticated logical Organization authority, with no
locator, operator tenant-job access, or frozen E1 change. This finding is resolved, although
JOB-003 remains `needs_changes` for E3-F021 through E3-F024.

## E3-F019 - Initial Decision #124 guard and platform-profile liveness were not implementable

**Date:** 2026-08-10
**Status:** `resolved_in_JOB-003_review_attempt_2`
**Severity:** P1 H-02 cutoff linearization / platform logical-profile availability
**Affected ticket:** JOB-003, with bounded JOB-002/JOB-009 synchronization seams

**Finding:** Independent review of the first E3-F018 amendment revision found two blocking
defects before implementation. First, an outer operator `FOR SHARE` transaction held across
`runInTenant` conflicts with JOB-003's tenant `FOR UPDATE` on the same null-Organization
platform target. Real PostgreSQL showed the current tenant UPDATE policy returns zero rows;
widening it would grant unsafe global mutation authority, while a widened probe deadlocked
with SQLSTATE 57014. Removing only the inner row lock still leaves a stale-commit window if
the operator connection dies before the tenant transaction commits, and operator→app nesting
opposes the existing app→operator pool order. Second, a real Organization logical profile on
a platform target is inserted with `workers.last_seen_at = NULL`, while its heartbeat updates
only physical operator metadata. The prior JOB-003 freshness predicate therefore rejected the
first real poll; seeded workers hid the circular prerequisite.

**Disposition:** Decision #124 and JOB-003 now specify an app-outer advisory handoff. Operator
locks physical target→worker `FOR SHARE`; while held, the app transaction acquires a shared
transaction-scoped advisory lock and plain-rechecks the target; operator validation commits;
the app retains the lock through tenant commit. Every platform authority writer locks
target→worker `FOR UPDATE`, takes the matching exclusive advisory lock, then changes status,
generation, device binding, or registered profile. Lock timeout, connection/process failure,
guard-first/cutoff-first, static writer inventory, and no-grant-widening tests are mandatory.
For liveness, a fresh session-bound device proof plus guarded fresh physical worker/target
heartbeat authorizes the platform logical operation; tenant `last_seen_at` is updated after
success for observability but is not a prior prerequisite. The physical worker's proof-bound
admissibility is exactly `enrolled|active`, checked independently by closed inline disjunctions
in poll authority, ACK authority, and the physical guard rather than a shared mutable set. Each
logical rejection dominates its operation's lease effects. Last-seen-only heartbeat never
changes authority status, while `draining`, `revoked`, unknown, non-null `revoked_at`, or any
other noncurrent fact denies. Real enrollment→physical
heartbeat→logical poll/ACK and stale-physical cases are mandatory. No production or test edit
may begin until the distinct reviewer accepts this successor plan revision.

The distinct JOB-003 reviewer accepted the complete amended plan at exact revision
`2e9217c1e900d42547fd8a1f432efc60f1af71f3` after the exact focused command, helper API/key,
0227 backfill, runtime test inventory, and stale cross-tenant polling prose were corrected.
This acceptance authorizes a fresh TDD fix round; it is not a JOB-003 implementation pass.

Implementation GREEN `ef972af6fde478f9e39fd36c36c23591a72c3eac` realizes the app-outer
shared-advisory handoff, exclusive-writer inventory, connection-loss rollback, and physical-
heartbeat/logical-session liveness rules without grant widening. The accepted DB and server
matrices pass locally. This resolves implementation feasibility but is not a review pass.

**Review attempt 2 resolution:** Exact revision
`a48faac86cf3a875e5a16c487d91e88d9f78d6fd` passed both lock orders, operator-connection-loss
rollback, target-to-worker/shared-advisory handoff, and platform physical-heartbeat/logical-
profile liveness without role/grant widening. The live call graph has no discovered authority
writer bypass. This finding is resolved; E3-F024 separately records that the required static
regression inventory is too weak to certify future bypass detection.

## E3-F020 - Outbox readiness lost PostgreSQL sub-millisecond precision

**Date:** 2026-08-10
**Status:** `resolved_in_JOB-003_review_attempt_2`
**Severity:** P1 durable scheduling liveness / deterministic local evidence
**Affected ticket:** JOB-003

**Finding:** A combined embedded-PostgreSQL run intermittently published an older ready hint
but skipped the newly inserted ready row. The repository sampled database time, converted it
to a JavaScript `Date`, and rebound that millisecond value as the readiness cutoff. PostgreSQL
retained microseconds on `available_at`, so a row at `.123456` could compare after a caller
cutoff of `.123000` even though the claim statement itself ran later. The same precision gap
applied to both outbox and job availability predicates.

**Disposition:** Deterministic RED `617661bc294bb7030a6bd7f41ab85927edfe07e5`
sets both availability facts to a sampled millisecond plus 500 microseconds, waits until the
database clock is later, passes the truncated JavaScript timestamp, and keeps a true future
row as a negative control. GREEN `d7f726ca65430551420a6ed6db764138d06c0d1a`
uses one database-native, stable, index-friendly `statement_timestamp()` cutoff for both
ready predicates while retaining caller time for durable claim/update timestamps and the
stale threshold. The focused regression passes and the complete H-03 lane passes 14/14 on
three consecutive fresh runs. No fence-time predicate, E1 wire field, grant, or migration
changed. JOB-003 remains review-pending.

**Review attempt 2 resolution:** The distinct reviewer reran the deterministic microsecond
eligibility/future-negative matrix at exact revision
`a48faac86cf3a875e5a16c487d91e88d9f78d6fd` and inspected both job and outbox predicates.
Database-native `statement_timestamp()` supplies the readiness cutoff without a JavaScript
millisecond round trip. This finding is resolved.

## E3-F021 - Ready-scheduler hint memory is unbounded across execution targets

**Date:** 2026-08-10
**Status:** `resolved_in_plan_pending_JOB-003_corrected_RED_and_implementation`
**Severity:** P1 Important - bounded scheduler contract / process-memory liveness
**Affected ticket:** JOB-003

**Finding:** `server/src/services/job-ready-scheduler.ts` stores an Organization map whose
values are target maps whose values are attempt sets. `maxHintsPerShard` is checked only
against one target's attempt set. Neither target-map cardinality nor the aggregate hints for
an Organization has a limit or expiry, and only `take(organizationId, targetId)` removes a
target entry. Outbox delivery is committed after the scheduler accepts the hint, so a hint
for an offline, revoked, or historical target is not durably retried and may remain in memory
indefinitely.

**Review evidence:** A read-only built-runtime probe configured
`maxOrganizationShards: 1, maxHintsPerShard: 1` and published 1,000 distinct valid target and
attempt UUID pairs in one Organization. All 1,000 calls returned accepted and `size()` returned
`{ organizations: 1, hints: 1000 }`. Existing tests bound duplicate/one-target sets and reject
a second full Organization but do not vary target cardinality within one Organization.

**Disposition:** JOB-003 remains `needs_changes`. The successor removes attempt IDs from the
process scheduler and stores one coalesced Organization/target readiness bit. The plan pins
finite-integer startup validation, Organizations `32/32` default/hard cap, targets per
Organization `128/1024`, global signals `1024/1024`, TTL `30,000/300,000 ms`, monotonic expiry,
duplicate-no-extension semantics, and retryable cap rejection. The leasing-facing API receives
only a boolean that can shorten `no_work` retry latency; it cannot affect selection. Exact
revision `73675cc621008ea0dcf18f6ae0c430162e7e448e` passed distinct whole-plan and
schema/security review with zero P0/P1/P2 findings. Corrected tests-only RED and implementation
remain pending; this finding is not yet closed in production.

## E3-F022 - Lost-hint pull recovery can starve compatible work beyond 256 candidates

**Date:** 2026-08-10
**Status:** `resolved_in_plan_pending_JOB-003_corrected_RED_and_implementation`
**Severity:** P1 Important - H-03 scheduling liveness / no head-of-line blocking
**Affected ticket:** JOB-003

**Finding:** Each poll initializes its lexical cursor and scan count anew, examines at most
256 ready candidates, and then returns `no_work`. SQL selection filters durable placement and
readiness but cannot filter worker-advertised workload slots, dynamic capabilities, resource
fit, or class/provider capacity; those permanently incompatible candidates are rejected later.
The next request therefore scans the same oldest 256 again. A hint accepted before restart is
already marked delivered while scheduler memory is process-local, so restart or hint loss
removes the only path that could prefer a later compatible attempt.

**Review evidence:** A temporary real-PostgreSQL probe queued 256 older batch attempts, used a
poll advertising `batchSlots=0` and `browserSessionSlots=1`, and queued a compatible browser
attempt at position 257. The poll returned `no_work` instead of the browser offer. The probe
was run once and completely removed. The existing no-head-of-line test has only two
incompatible heads and does not cross the scan bound or restart the scheduler.

**Disposition:** JOB-003 remains `needs_changes`. Both two- and four-field cyclic cursors are
rejected. The successor always begins at the global canonical head, hoists authenticated
Organization-scoped logical-profile provider/class/resource capacity into SQL, and never
reads cross-profile physical capacity (WRK-003 owns that later boundary). It anti-joins only
exact static-ineligibility certificates. One application-computed poll-invariant authority
hash is passed as a bound value; every candidate-specific workload/placement/digest fact is
matched by ordinary correlated SQL columns, so PostgreSQL need not reproduce
`canonicalizeJsonV1`. One database-native statement returns at most 256 uncertified rows;
only evaluated static-negative predecessors are bulk-upserted. Dynamic capacity/live counts,
locked rows, races, timeouts, parsing, envelope, and authority failures are never certified.
One row per worker/attempt survives restart; stale/terminal/offline state has bounded tenant
cleanup and cascades. Exact revision `73675cc621008ea0dcf18f6ae0c430162e7e448e`
passed distinct whole-plan and schema/security review with zero P0/P1/P2 findings. Corrected
tests-only RED and implementation remain pending; this finding is not yet closed in production.

## E3-F023 - Outbox ticks enumerate all Organizations and have no real 750-ms DB budget

**Date:** 2026-08-10
**Status:** `resolved_in_plan_pending_JOB-003_corrected_RED_and_implementation`
**Severity:** P1 Important - bounded traversal / scheduler availability
**Affected ticket:** JOB-003

**Finding:** Runtime startup queries and materializes every active admitted Organization on
every tick. The outbox worker then deduplicates and sorts that full collection before slicing
at most 32. The tick has no elapsed deadline, statement timeout, or cancellation budget; the
750-ms value controls only interval cadence. Organization discovery is therefore O(all
Organizations), and sequential tenant claims can exceed 750 ms without stopping at a cursor.
This does not satisfy the locked at-most-32-Organization and at-most-750-ms database-work
contract.

**Disposition:** JOB-003 remains `needs_changes`. The successor pushes keyset/limit selection
into the database reader (at most two reads and 32 combined shards), keeps a single-flight
lexical rotation, and defines 750 ms precisely as a monotonic launch-admission window checked
before every page/transaction/publication launch. Already-launched work may finish later;
`statement_timeout` is defense only, not a cumulative or hard-wall claim. The cursor advances
past an attempted slow/failed shard and durable claims retry through visibility timeout. Exact
revision `73675cc621008ea0dcf18f6ae0c430162e7e448e` passed distinct whole-plan and
schema/security review with zero P0/P1/P2 findings. Corrected tests-only RED and implementation
remain pending; this finding is not yet closed in production.

## E3-F024 - Platform-authority writer inventory does not fail on new bypasses

**Date:** 2026-08-10
**Status:** `resolved_in_fix_round_2_RED_pending_final_review`
**Severity:** P1 Important - H-02 cutoff regression certification
**Affected ticket:** JOB-003

**Finding:** The mandatory static writer-inventory test reads four broad source files and
only asserts that each file contains the exclusive guard helper symbol somewhere. It does not
bind each status, generation, device-binding, or registered-profile mutation to target-to-
worker row locks and the exclusive advisory, and it does not discover mutation sites in
unlisted files. Generic worker-enrollment mutation methods remain available. Adding an
unguarded mutation in a listed file beside an existing helper, or in another file, leaves the
test green.

**Review evidence:** The distinct review found no bypass in the current live production call
graph, and the real guard-first, cutoff-first, operator-loss, and liveness tests pass. The
blocker is the explicitly required proof that every current writer is inventoried and that a
new bypass makes the static contract fail.

**Disposition:** Fix-round-2 RED `c5be2a6853a93c1ad73910f1bdcd05c8299f93b6`
replaced the substring assertion with an exhaustive AST/exact allowlist over the current 17
mutation sites. It passes the current graph and independently fails injected new-file,
unguarded, and wrong-order writers while preserving only the exact last-seen exemption. The
certificate successor adds a separate protected-job/placement writer inventory. Final
implementation review must rerun both; JOB-003 remains `needs_changes` for other findings.

## E3-F025 - Two-field lease scan cursor contradicts the locked job-claim order

**Date:** 2026-08-10
**Status:** `superseded_after_rejected_four_field_amendment`
**Severity:** P1 STOP - durable scheduling semantics / restart-safe fairness
**Affected ticket:** JOB-003

**Finding:** Fix-round-2 RED correctly required restart-safe progress beyond 256 incompatible
attempts, but its proposed worker cursor stored only `(created_at, id)`. The locked claim index
and repository order are `(available_at ASC, priority DESC, created_at ASC, id ASC)`. A
two-field cursor cannot identify a continuation in that total order. Reordering claims to
`(created_at, id)` would regress availability and priority semantics; looking up omitted
cursor facts through a referenced job would be deletion/mutation unstable and would turn a
tenant-local pagination value into an unnecessary existence dependency.

**Disposition:** Implementation stopped before editing `workers`, generating migration
`0229`, or changing the leasing repository/service. A replacement four-field cursor was
planned at `0f1953d4f645d7530a9580289b03365911d02a0b`, but distinct review rejected it: stale
cyclic progress can skip newly eligible older work indefinitely, hint-first selection also
violates oldest-first, JavaScript `Date` loses PostgreSQL microseconds, the existing index has
priority ASC rather than DESC, bounds were unpinned, and 750-ms wording overclaimed. All
cursor columns and `scan_cursor_only` semantics are now removed from the successor. E3-F022
tracks the static-negative-certificate replacement; independent exact-text review remains
required before RED correction or GREEN.

## E3-F026 - Static-certificate successor lacked SQL-comparable validity and exact gate seams

**Date:** 2026-08-10
**Status:** `resolved_in_plan`
**Severity:** P1 Important - certificate correctness / tenant authority / executable evidence
**Affected ticket:** JOB-003

**Finding:** Two distinct read-only reviewers rejected exact plan revision
`7cf1d763222b8f453b2aa1eeb19332f73a942722`. The certificate digest mixed poll authority
with candidate-specific fields while the selection contract required a pre-fetch SQL
anti-join; PostgreSQL had neither the inputs nor an approved `canonicalizeJsonV1` equivalent
to recompute that digest. The plan also described provider totals as target-wide even though
Decision #124 limits JOB-003 to the authenticated Organization logical profile, omitted the
new certificate DML from the exact startup grant allowlist and omitted the schema export,
left foreign-versus-missing composite-FK oracle equality implicit, reported million-row
performance without ceilings/distributions, lacked an executable parent-UNIQUE-before-child-
FK migration sequence, and simultaneously called JOB-003 assignable and review-blocked.

**Disposition:** Candidate-specific certificate validity is now ordinary correlated SQL
equality over the complete tenant/job/attempt/worker/target/workload/placement/digest tuple.
Only one exact poll-invariant logical-worker/current-target/physical-authority/version object
is application-canonicalized after locks and passed as a bound hash, so any mutable authority
rotation invalidates old rows without database JSON hashing. Capacity is explicitly current-
Organization + logical-worker + target; cross-profile physical totals remain WRK-003. The
JOB-003 inventory now includes `schema/index.ts`, the exact legacy-grant allowlist, its
contract/startup tests, raw `aoa_app` foreign/missing equality probes for both composite FKs,
million-row structural gates and adverse distributions, and a two-step generated migration
sequence that creates the parent UNIQUE before generating/applying the child FKs. The execution
table and terminal review sentinel now
keep JOB-003 blocked. GREEN remains unauthorized until fresh whole-plan and schema/security
reviewers accept the exact corrected revision with no P0/P1/P2 finding.

Fresh re-review of `b42992bfa9793f5031b80c726cb340f27d01b428` closed the original SQL,
scope, grant, oracle, load-ceiling, FK-order, and status findings but found three remaining
exactness defects: the poll hash bound only the enrollment authorization hash rather than the
parsed stored matcher snapshot; the neutral-adapter proof was one-way and could still certify
a false negative; and the load shapes did not force a current-certificate prefix or sparse/
tail cleanup. It also found two stale sentences inconsistent with the proposed cross-migration
reorder. The next plan revision added a separately canonicalized neutral static-matcher profile
hash, bidirectional frozen-matcher equivalence, fixed-hash snapshot mutation coverage,
999,744-row head saturation plus fully certified no-work, and sparse/tail cleanup with buffer/
row evidence.

Schema/security review accepted exact revision
`1d716e7fe0d2800a0b8819584d1d35b24ce30d68`, but whole-plan review correctly rejected its
epic-local cross-migration reorder because Decision #19/AGENTS did not authorize that exception.
It also found that snapshot coverage incorrectly included dynamic capacity and that absolute
p95 thresholds on variable `ubuntu-latest` were not reproducible gates. The final correction
uses generated `0229` solely for the logical-worker parent UNIQUE, then generated `0230` for
the certificate table/child FKs/indexes, and custom `0231` solely for Decision #122 RLS/grants;
no generated statement is reordered or hand-authored. Snapshot-hash mutation coverage now
targets every non-capacity static matcher field while proving capacity-only changes leave the
static hash unchanged and remain dynamic. Million-row correctness, row/buffer/index, memory,
and no-unbounded-scan checks are blocking; variable-CI latency is observed. A reproducible
pinned `E3-PERF-01` handoff is mandatory before the E3 exit gate or any production-capacity/
SLO claim. Status remains pending fresh exact dual re-review; no RED correction or GREEN is
authorized.

Exact re-review of `9bbd2002033b4f254f11f726af0c0c1493e88435` accepted every migration,
certificate, static-hash, capacity, SQL, RLS/grant, oracle, and load-shape correction. The
schema/security reviewer returned `ACCEPT`; the whole-plan reviewer rejected one remaining
P2 because `E3-PERF-01` was mandatory but had no named owner, prospective threshold manifest,
exact runner trigger, immutable artifact paths, or integration-gate consumption. The plan now
assigns the independent Integration Gate Owner plus a distinct Security Gate Owner; freezes
the environment and INITIAL numeric thresholds in a committed manifest before samples; adds
the manifest-validating `scripts/run-e3-perf-01.mjs` trigger; requires content-addressed raw
evidence retained >=180 days plus immutable performance QA/handoff attempts; and pins those
blobs into the overall E3 gate. Any environment/threshold mismatch fails, and any prospective
threshold change requires a new reviewed manifest and full campaign while retaining the prior
failure. Status remains pending another fresh exact dual review; implementation remains
unauthorized.

Exact whole-plan review accepted `349c3cc466ddeb50b98019315dbe18bda8fa3607`, while the
schema/security reviewer rejected three benchmark-harness P1s without reopening any
certificate invariant: executed runner/test/config/dependency/schema/migration bytes were not
attested immediately around sampling; the benchmark image digest was not bound to verified
H-08 signature/provenance policy and trust roots; and broad environment/child-output capture
could leak credentials into >=180-day evidence. The corrected plan runs only from a
read-only detached checkout in the approved E6F-06 image; disables Git replacement processing;
verifies clean pre/post whole-tree bytes plus a critical input/blob closure and frozen-install
integrity; and records/negatively tests the image attestation, verification policy, and trust
roots. It replaces environment dumps with a closed non-secret descriptor schema, redacts child
output/commands before persistence, and requires injected environment/DB/argv/stdout/stderr
canaries to be absent from every console/file/archive/QA/handoff artifact. Status remains
pending fresh exact dual review; RED correction and GREEN remain unauthorized.

Exact review of `9d672ad743d08542c769a58988448294db01470e` found the three prior harness
P1s materially closed but rejected two final P1s: a manifest cannot contain the hash/tree of
the future commit that contains that manifest, and permanent artifact/attestation URI strings
were not explicitly secret-safe or included in the canary matrix. The corrected manifest pins
the clean evidence-parent revision/tree and its own sole added path; the runner derives and
verifies the resulting single-parent gate commit/tree and one-file diff, while later QA/handoff
pins the actual gate/manifest blobs. Strict manifest and evidence schemas permit only
credentialless content-addressed URIs, reject userinfo/query/fragment/presigned references,
keep access credentials out-of-band, and recursively scan every manifest string for credential
patterns and generated canaries before commit and execution. Status remains pending fresh
exact dual review; implementation remains unauthorized.

Exact review of `bddde5b13503799d9b84fed255ddc66cb0f74f4d` found the containing-commit
self-reference and permanent-string secret issues closed but identified two final P1s. The
manifest/runner did not constrain the implementation-to-evidence-parent interval, so an
intervening unreviewed source/config/schema change could be executed; and a prospective output
destination could not already be digest-addressed before the archive existed. The correction
pins the exact evidence-only implementation-to-parent path/mode/blob/review closure, rejects
every unlisted delta, and requires every executable/config/dependency/generated/schema/
migration blob to equal the implementation revision. Pre-existing inputs remain digest-bound;
the output uses an approved credentialless repository plus immutable attempt namespace, then
derives its digest-addressed final URI only after scan/hash. Contract tests cover intervening
code/config/migration, unlisted evidence, output-namespace drift, and successful future-output
derivation. Status remains pending fresh exact dual review; RED correction and GREEN remain
unauthorized.

Final exact dual review of `73675cc621008ea0dcf18f6ae0c430162e7e448e` returned
`ACCEPT` from both the whole-plan reviewer and the independent schema/security reviewer with
zero P0/P1/P2 findings. The plan defect is resolved. Only a corrected tests-only RED is now
authorized; implementation and ticket completion remain pending.

## E3-F027 - Broad verification exposed stale authority fixtures and operator-error leakage

**Date:** 2026-08-11
**Status:** `resolved_in_candidate_review_pending`
**Severity:** P1 Important - fail-closed operator loss / exact repository authority surface
**Affected ticket:** JOB-003

**Finding:** The first full Windows aggregate against the static-certificate implementation
candidate exposed two JOB-003-adjacent mismatches hidden by the required 10-file matrix. The
operator-loss fixture returned only three target fields, so the accepted 30-fact H-02 guard
correctly rejected the decoy before the fixture could inject post-callback operator loss; the
service also allowed non-domain operator transport/commit errors to escape instead of mapping
them to `internal_unavailable`. Separately, the TEN-003 unit still assumed every enumerable
tenant repository offered generic `insert`, contradicting the accepted authority hardening
that removes generic `workers.insert` and permits worker creation only through the audited
enrollment path.

**Disposition:** The tests-only fixture commit
`eed83fbff28a99790fbfc36aca8ef1cc2054f181` supplies the complete current-target authority
snapshot and asserts the exact read-only worker repository surface; a distinct reviewer
returned `ACCEPT` with zero P0/P1/P2. Production candidate
`63f9e409d017258aad899c5f955c54c0b09d954a` wraps only the operator transaction boundary,
preserves all `JobLeasingError` authority decisions, and maps other operator infrastructure
failures to `internal_unavailable`. Focused operator-loss plus tenant-context tests pass 9/9,
the whole contract passes 15/15, and the final exact server matrix passes 136/136. The broad
aggregate itself remains honestly non-green for separately recorded setup/load effects and was
not rerun. Final review attempt 3 subsequently returned `needs_changes` for E3-F028–E3-F033;
this finding does not mark a pass or completion.

## E3-F028 - Bounded pools are not bound to one advisory-lock authority domain

**Date:** 2026-08-11
**Status:** `resolved` — resolving revision `d2040591f` (JOB-003 final acceptance 2026-08-12;
`JOB-003-result.md` is `complete`). AMENDED IN PLACE 2026-09-03: this block read
`needs_changes` — the contemporaneous review-3 disposition — while the
`E3-F028–E3-F033 — RESOLVED` roll-up below already recorded the resolution. The register
contradicted itself and `check-finding-ownership.mjs` read the losing side, so its correct
answer here was luck rather than evidence. The original disposition is superseded, not
deleted; the roll-up keeps the full per-item detail.
**Severity:** P0 STOP - H-02 revocation linearization / split-brain authority
**Affected ticket:** JOB-003

**Finding:** Exact review of `392c3a2da52c3fd812d7b9e2801fe6523f1cc657` found that
`server/src/db/distributed-execution-databases.ts:285-304` authenticates and audits the app and
operator pools independently, but never proves that they address the same PostgreSQL database
and transaction-advisory-lock domain. The startup call also does not bind them to the owner
pool whose database received migration/bootstrap. Two separately valid migrated copies can
therefore pass. Platform poll/ACK can release operator row locks and retain an app shared
advisory lock that cannot conflict with a cutoff's operator exclusive advisory lock, allowing
stale tenant work to commit after revocation finishes.

**Required disposition:** Fail startup unless an unpredictable transaction-advisory
contention handshake proves the owner, app, and operator sessions share the same canonical
database/lock domain. Add a negative startup integration using two fully valid databases.
This is Critical and keeps JOB-003 `needs_changes`.

**Accepted disposition (2026-08-12):** The F028 phrase “ownerDb-only ledger” denotes owner
authority and exact transport provenance, not literal execution on the retained shared legacy
pool. Literal `input.ownerDb.transaction` was found unconstructible for the required startup
bound: postgres.js can queue its `begin()` acquisition behind a saturated pool through a plain
promise, Drizzle's async `execute()` hides the underlying query cancellation handle, and before
the first timeout/PID statement returns production has no exact backend identity to cancel.
Ending that client would settle the work only by violating the locked requirement that the
legacy owner pool remain available to the server.

Each open therefore uses a dedicated `max=1` owner-authority participant cloned losslessly from
the parsed `input.ownerDb` postgres.js authentication and transport, including multi-host
host/port pairs, socket/path, TLS/`ssl`, `sslnegotiation`, passwordless/string/password-function
forms, and every other domain-affecting option. The participant and every control receive their
own distinct unique non-secret per-open/per-session `application_name` at connection startup;
connect, statement, idle-in-transaction, and disposal are bounded and awaited. The migration
ledger and owner advisory phases run only on the participant. Before PID registration, a
separately cloned bounded owner control may discover only the participant's unique tagged
session; every discovery/cancel query explicitly excludes the querying control's own tag, PID,
and full identity, then binds/cancels the exact participant PID + `backend_start` + role +
database + application-tag tuple. Active identity lasts through full `COMMIT`/`ROLLBACK`;
teardown history is separate. Cleanup cannot depend on a shared owner slot. Its final verifier
control checks all prior participant, serving, and control identities and locks, then calls and
awaits its own bounded `end({ timeout: 5 })`; it never polls for its own disappearance while
connected. The awaited end is production's closure proof, and tests or admin observation after
end externally prove its PID disappeared. The legacy pool is never ended; zero legacy PIDs is
valid, while any existing legacy PID must be idle, out of transaction, and free of advisory
locks. Every per-open dedicated participant/control PID and operation must be gone/settled
before return. Drizzle remains mandatory: raw postgres.js `Query.cancel()`, internal Drizzle
session clients, and private pool state are not accepted seams. This is an authority/transport
clarification, not widened privilege: app/operator still receive no `drizzle` access, and no
role, grant, schema, migration, or serving authority changes.

**Accepted security tightening (2026-08-12):** This paragraph controls where it conflicts
with the accepted disposition above. Custom owner `options.socket` callbacks and explicit
owner/app/operator multi-host inputs are rejected before callback/client/pool allocation.
Supported owner transport is one native TCP host/port pair or one native Unix path, with
passwordless/string/password-function and TLS options preserved without ambient
reinterpretation. Every configured endpoint is a stable logical PostgreSQL authority;
client-side rotation is unsupported and HA belongs behind that endpoint. This reverses the
prior socket/multi-host acceptance because postgres.js may await a custom socket before its
connect timer and may rotate later work to an authority the one-time certificate never
attest. Keeping ledger, authority, and advisory checks in separate bounded transactions is
accepted only inside this explicit stable-endpoint trust boundary.

On abort, normal owner `end({ timeout: 5 })`, every allocated serving
`close({ timeoutSeconds: 5 })`, and exact cancellation are memo-started before participant
settlement is awaited; all cancellation, transaction, and close tasks are awaited. Controls
and the final verifier have one absolute five-second acquisition/query/poll deadline. Its
single causal timer may first-call-wins invoke and await `end({ timeout: 0 })`; work-first
completion clears the timer and invokes and awaits normal `end({ timeout: 5 })`. Emergency
zero-time disposal is invalid elsewhere. This closes blackholed acquisition and
all-settled-before-close hangs without changing roles, grants, schema, or serving authority.

## E3-F029 - Startup exact-authority audit omits required relations and RLS posture

**Date:** 2026-08-11
**Status:** `resolved` — resolving revision `d2040591f`/`820515991` (JOB-003 final acceptance 2026-08-12;
`JOB-003-result.md` is `complete`). AMENDED IN PLACE 2026-09-03: this block read
`needs_changes` — the contemporaneous review-3 disposition — while the
`E3-F028–E3-F033 — RESOLVED` roll-up below already recorded the resolution. The register
contradicted itself and `check-finding-ownership.mjs` read the losing side, so its correct
answer here was luck rather than evidence. The original disposition is superseded, not
deleted; the roll-up keeps the full per-item detail.
**Severity:** P1 Important - H-01 fail-closed startup / exact grant and RLS authority
**Affected ticket:** JOB-003

**Finding:** `server/src/db/distributed-execution-databases.ts:108-140` validates only catalog
relations that exist. It does not require every allowlisted relation to be present and does
not inspect `relrowsecurity`, `relforcerowsecurity`, or policy role/`USING`/`WITH CHECK` facts.
A partial database missing `worker_lease_rejections`, or a database with the expected DML
grants but RLS disabled, can pass before the distributed routes start.

**Required disposition:** Compare actual and expected relation sets, attest the exact RLS/
FORCE/policy posture for tenant tables, and add missing-table and RLS-disabled startup
negatives. The focused migration/RLS tests remain useful but do not close wrong-database
startup behavior.

**Accepted disposition (2026-08-11):** The E3-F029 certificate must compare PostgreSQL 18 raw
catalog facts exactly. A non-null ordinary-table owner ACL expands to the eight owner privileges
`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, and `MAINTAIN`, all
reported by `aclexplode` with `is_grantable=false`. `execution_targets.relacl` and
`mcp_api_keys.relacl` are both non-null and owner-only: each contains exactly those eight owner
tuples and no app, operator, or PUBLIC table tuple. Their reviewed serving grants remain exact
column ACLs, including the four exact app `SELECT` privileges on `mcp_api_keys`. Relations with
direct table-level serving grants contain the owner tuples plus only the reviewed direct
serving-role tuples. Only the actual
`pg_class.relowner` OID normalizes to `RELATION_OWNER`; no synthetic owner, unexpected grantee,
or privilege is filtered, and PostgreSQL-version drift fails closed. The legacy non-superuser
flag-off fixture belongs in a third fully migrated database so its broad grants and
`execution_targets` ownership cannot contaminate the main exact-certificate database or the
second advisory-domain database. This is a strict catalog-fact/test-isolation correction, not
new authority: no migration, role-grant, schema, or production-filtering change is authorized.
JOB-003 remains `needs_changes`; GREEN stays paused until the separate tests-only oracle/fixture
correction is independently accepted.

## E3-F030 - Certificate cleanup is uncomposed and Cartesian rather than tuple-bounded

**Date:** 2026-08-11
**Status:** `resolved` — resolving revision `cdfa70731` (JOB-003 final acceptance 2026-08-12;
`JOB-003-result.md` is `complete`). AMENDED IN PLACE 2026-09-03: this block read
`needs_changes` — the contemporaneous review-3 disposition — while the
`E3-F028–E3-F033 — RESOLVED` roll-up below already recorded the resolution. The register
contradicted itself and `check-finding-ownership.mjs` read the losing side, so its correct
answer here was luck rather than evidence. The original disposition is superseded, not
deleted; the roll-up keeps the full per-item detail.
**Severity:** P1 Important - H-03 bounded storage / certificate stability
**Affected ticket:** JOB-003

**Finding:** The locked per-admitted-shard cleanup has no production caller; the transaction
at `server/src/services/job-outbox-worker.ts:117-125` only claims outbox rows. The dormant
implementation at `packages/db/src/repositories/tenant/job-control.ts:971-981` hardcodes its
selection limit to 256, then deletes by independent worker, target, and attempt `IN` sets.
Those predicates expand selected tuples into a Cartesian set and can delete unselected current
certificates and far more than the requested batch. `Math.min` hides rather than bounds the
actual delete. Without invocation, stale terminal/retired/offline/mismatched rows persist and
the promised `O(workers x pending attempts)` lifecycle bound is false.

**Required disposition:** Invoke one cleanup within each admitted-shard budget, use
`boundedLimit`, delete only exact selected composite tuples, return the actual count, and add
dense multi-worker/multi-attempt PostgreSQL plus runtime-composition regressions.

## E3-F031 - E3-PERF-01 has no executable real campaign adapter

**Date:** 2026-08-11
**Status:** `resolved` — resolving revision `d24dd68a7` (JOB-003 final acceptance 2026-08-12;
`JOB-003-result.md` is `complete`). AMENDED IN PLACE 2026-09-03: this block read
`needs_changes` — the contemporaneous review-3 disposition — while the
`E3-F028–E3-F033 — RESOLVED` roll-up below already recorded the resolution. The register
contradicted itself and `check-finding-ownership.mjs` read the losing side, so its correct
answer here was luck rather than evidence. The original disposition is superseded, not
deleted; the roll-up keeps the full per-item detail.
**Severity:** P1 Important - executable evidence / H-04 and H-08 attestation
**Affected ticket:** JOB-003

**Finding:** `scripts/run-e3-perf-01.mjs:1174-1198` recognizes the locked campaign CLI and
then unconditionally rejects it with `campaign_launcher_attestation`. No production adapter
constructs the exported engine's Git, dependency, image-provenance, redaction, child, archive,
store, and retention interfaces. The nominal real-CLI test at
`scripts/run-e3-perf-01.test.mjs:194-227` explicitly expects a nonzero campaign exit; all
successful orchestration tests use synthetic self-attested harness facts. The exact future
campaign command can therefore never reach sampling or immutable evidence publication.

**Required disposition:** Wire the approved real launcher and make a hermetic real-CLI success
fixture prove recomputed provenance, child execution, fail-closed redaction, archive canary
scan/hash, immutable upload, retention receipt, and final pass/fail record. The million-row
campaign remains correctly unrun and is not waived.

## E3-F032 - Required payload-free leasing and scheduler telemetry is absent

**Date:** 2026-08-11
**Status:** `resolved` — resolving revision `b369ae7e5`/`c4b401047`/`cdfa70731`/`d99945874` (JOB-003 final acceptance 2026-08-12;
`JOB-003-result.md` is `complete`). AMENDED IN PLACE 2026-09-03: this block read
`needs_changes` — the contemporaneous review-3 disposition — while the
`E3-F028–E3-F033 — RESOLVED` roll-up below already recorded the resolution. The register
contradicted itself and `check-finding-ownership.mjs` read the losing side, so its correct
answer here was luck rather than evidence. The original disposition is superseded, not
deleted; the roll-up keeps the full per-item detail.
**Severity:** P1 Important - plan alignment / starvation and storage observability
**Affected ticket:** JOB-003

**Finding:** The locked plan requires certificate hit/miss/upsert/cleanup counts, scan-limit
exhaustion, head restarts, certificate cardinality, readiness rejection/expiry, and launch-
window overshoot without tenant payload. The scan/upsert at
`server/src/services/job-leasing.ts:603-653` and scheduler expiry/rejection at
`server/src/services/job-ready-scheduler.ts:73-105` emit nothing, while
`server/src/index.ts:601-604` discards the outbox tick result. No production telemetry surface
or non-secret field contract exists.

**Required disposition:** Add bounded payload-free metrics for every locked signal and
non-vacuous tests that reject job input, requirements, fence, proof, and credential fields.

## E3-F033 - Non-platform poll and revoke invert target/worker lock order

**Date:** 2026-08-11
**Status:** `resolved` — resolving revision `d99945874` (JOB-003 final acceptance 2026-08-12;
`JOB-003-result.md` is `complete`). AMENDED IN PLACE 2026-09-03: this block read
`needs_changes` — the contemporaneous review-3 disposition — while the
`E3-F028–E3-F033 — RESOLVED` roll-up below already recorded the resolution. The register
contradicted itself and `check-finding-ownership.mjs` read the losing side, so its correct
answer here was luck rather than evidence. The original disposition is superseded, not
deleted; the roll-up keeps the full per-item detail.
**Severity:** P2 Minor - control-plane contention / bounded revoke availability
**Affected ticket:** JOB-003

**Finding:** Non-platform poll locks worker then target in
`packages/db/src/repositories/tenant/job-control.ts:715-749`; revoke updates target then workers
in `packages/db/src/repositories/tenant/worker-enrollment.ts:519-533`. Concurrent operations
can form a lock cycle. The revoke's 750 ms transaction-local lock timeout bounds one attempt,
but sustained polling can repeatedly fail a control-plane cutoff.

**Required disposition:** Use one target/worker order with revalidation and add a contention
test. This Minor does not change the Critical/Important disposition above.

## JOB-003 final-review fix-round-3 disposition record

**Date:** 2026-08-11
**Ticket status:** `needs_changes`
**Canonical design:** `implementation-plan.md` → “JOB-003 final-review fix round 3 — binding
delta for E3-F028–E3-F033”

This record plans, but does not implement or resolve, the six final-review findings:

- **E3-F028:** `openDistributedExecutionDatabases` must accept the already-migrated owner
  `Db` plus an exact checked-in migration-hash ledger. A losslessly cloned, uniquely tagged,
  bounded per-open owner-authority participant reads
  `drizzle.__drizzle_migrations`; DB serial IDs are non-authoritative, and a one-to-one DB-hash
  set join reconstructs checked-in order before the canonical digest. Missing/extra/duplicate
  rows fail, while a correctly repaired row with a later/out-of-order ID passes. No best-effort
  timestamp mapping or app/operator journal grant is allowed. The literal legacy owner pool is
  retained, may have zero backends, and is not a startup-work or cleanup-acquisition dependency.
  With fixed pool/connect/statement/lock/idle/close deadlines, one secret random signed-bigint
  probe must prove owner-exclusive contention blocks app/operator shared locks while held and
  app/operator can
  hold shared locks together after release. One common abort controller rejects every barrier;
  all participant transactions roll back/settle before postgres.js forced bounded end, after
  which recorded backend PIDs/advisory locks must disappear. Two valid databases, loss at
  every lock phase, exact max-four app/operator saturation, and every timeout are mandatory REDs.
- **E3-F029:** startup relation sets are derived exactly from every table and column grant
  constant, including column-only `mcp_api_keys`/`execution_targets`; every expected relation
  must exist as an ordinary table while every unexpected effective privilege remains denied.
  A checked-in explicit 15-relation/14-FORCE/1-non-FORCE/22-policy catalog certificate lists
  every row and per-table count, requires permissive policies, and compares the installed
  PostgreSQL `pg_get_expr` deparse including implicit text casts. It checks every
  `aclexplode(relacl)` and every user-column `aclexplode(attacl)` tuple with grantor, grantee,
  privilege, and grantable bit. Under PostgreSQL 18, every non-null ordinary-table owner ACL
  contributes exact non-grantable `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`REFERENCES`/
  `TRIGGER`/`MAINTAIN` owner tuples. `execution_targets.relacl` and `mcp_api_keys.relacl` are both
  non-null and owner-only, each with exactly those eight owner tuples and no app, operator, or
  PUBLIC table tuple; their serving grants remain column-level, including the four exact app
  `SELECT` privileges on `mcp_api_keys`. Table-level serving grants add only reviewed direct
  serving-role tuples beside the owner tuples. Only the actual
  `pg_class.relowner` OID normalizes to `RELATION_OWNER`; nothing unexpected is filtered and
  PostgreSQL-version drift fails closed. The legacy non-superuser flag-off fixture uses a third
  migrated database, isolated from both the exact-certificate and advisory-domain databases.
  The two certificate
  tables remain FORCE RLS with one exact app tenant policy and exact non-grantable app CRUD;
  `execution_targets` remains RLS enabled and explicitly not FORCE with its exact three current
  policies. This correction authorizes no migration, role grant, schema, or production filtering;
  JOB-003 remains `needs_changes` and GREEN remains paused pending independent acceptance of the
  separate tests-only oracle/fixture correction.
- **E3-F030:** cleanup selects with `.limit(boundedLimit)` and `FOR UPDATE SKIP LOCKED`, deletes
  only the selected `(organization_id, worker_id, attempt_id)` tuples, uses `RETURNING` as the
  true count, and rolls the tenant transaction back if the count exceeds the bound. Correctness
  triggers are non-pending attempts, terminal jobs, revoked workers, disabled/offline targets,
  or exact target/placement/current generation/profile/provider/binding drift; age is never a
  correctness predicate. Cleanup runs once inside the existing transaction for every actually
  visited admitted shard, including empty/pending shards, without extending the deadline or
  changing cursor/page bounds. Before each cleanup select/delete/cardinality, DB-time, claim,
  and delivery statement, the immutable tick deadline is recomputed and a descending
  transaction-local timeout installed; no DB/publisher/shard launches at zero. Dense Cartesian,
  concurrency, descending-timeout, and no-post-deadline REDs are required.
- **E3-F031:** the campaign CLI must use an unselectable module-private production capability
  factory. Only process/artifact/store/clock seams exist in direct hermetic tests. Production
  starts through the pinned E6F-06 runner image's credentialless read-only bootstrap config,
  which verifies an absolute Node/runner/manifest path and digest before JavaScript starts.
  PATH Node/wrappers, NODE preloads, Git overrides, AWS endpoint/config/static credentials,
  proxies, and custom CAs are absent from the minimal parent environment; real-entry negatives
  fail before a JS marker. The independent Security handoff has its own out-of-band pinned
  bootstrap whose runner path/hash and resolved realpath must be exactly
  `scripts/verify-e3-perf-01-handoff.mjs`; it invokes that configured path, never a hardcoded
  sibling. Mutating only the verifier while the campaign runner remains valid fails before
  verifier module load. Production then
  recomputes Git/detached lineage, fixed executable digests/environment, E6F-06 provenance,
  child NDJSON/redaction, archive scan/hash, immutable S3 Object Lock COMPLIANCE upload, exact
  readback/retention, and sanitized QA/failure evidence. The existing AWS SDK is sufficient.
  A separate Security-owner command re-fetches the exact version and writes the handoff; all
  security negatives and failure retention are blocking. Ordinary tests use tiny fixtures;
  the external million-row campaign remains mandatory before any SLO/capacity claim.
- **E3-F032:** one closed synchronous nonthrowing metrics interface and frozen no-op exposes
  only whitelisted numeric/boolean/closed-scope events for exact claim-query certificate
  hit/miss/saturation, scan exhaustion, upsert/cleanup, head restart, per-shard cardinality,
  scheduler capacity/expiry/cardinality, and outbox budget/elapsed/overshoot. The repository
  returns bounded SQL-observed counts from the tenant claim statement plus exact `RETURNING`
  counts; no candidate-length inference or privileged/global scan is allowed. IDs, hashes,
  errors, arbitrary labels, payload, proof, fence, and credentials are forbidden. Flag-off
  dynamically loads neither `worker-control`/leasing nor metrics/scheduler/outbox; module mocks
  that throw on resolution prove the entire static import chain is absent. The metrics GREEN
  boundary includes `index.ts`, `app.ts`, and `routes/worker-control.ts`.
- **E3-F033:** non-platform poll must move its worker profile touch after authority locking,
  lock/revalidate target before worker, and retain that target→worker order shared with revoke.
  A real PostgreSQL barrier proves poll/revoke settles within the existing 750 ms bound without
  `40P01` and without stale lease effects. Platform ordering remains Decision #124's bounded
  logical-worker/app plus physical target→worker/operator and advisory handoff; it is not
  weakened.

The fix is divided into tests-only RED, startup authority GREEN, cleanup/lock-order GREEN,
metrics GREEN, performance-launcher GREEN, and final evidence/review commits. E1 bytes,
schema/migrations, grants, owner fallback, and a selectable production test adapter are STOP
conditions. `tickets/JOB-003-result.md` remains `needs_changes` until a distinct reviewer
certifies the implemented candidate; the later formal performance QA and independent Security
handoff remain separate required evidence.

Plan exactness re-review of docs commit `c1efbbe2177018d72db6bd0d16dc0996b5af8353`
opened the six P1 clarifications above. The canonical amendment now closes each at design
level without widening E1, schema/migrations, grants, production test seams, or evidence
claims. JOB-003 and E3-F028–E3-F033 remain `needs_changes` until implementation and fresh
independent review; this planning correction is not a ticket pass.

Security re-review of `b1773d6743efaead970ca5edfee0d41911e5028c` found that the handoff
reused the campaign bootstrap but invoked a different hardcoded script. The distinct Security
bootstrap/realpath/digest contract above closes that plan P1 without changing ticket status or
claiming implementation.

## Resolution round — JOB-003 final acceptance, 2026-08-12 (findings F028 through F033)

> ★ **RE-HEADED 2026-09-03, prose unchanged.** This section was `## E3-F028–E3-F033 —
> RESOLVED (…)`: a heading that named six findings and was addressable as none of them. That
> one idiom caused three distinct failures in a single day — a false-positive duplicate in
> `check-register-id-uniqueness.mjs`, the same false positive independently hit by another
> track (its EN dash escapes the `[—-]` class in `parseFindings`), and, worst, **six stale
> per-finding `Status:` lines — including a P0 STOP — masked by this roll-up**, which no
> parser can associate with its members. The ownership guard read the stale side, excluded
> them, and was correct only by luck.
>
> The **prose is the valuable part and none of it is lost**; only the heading changed, so it
> is no longer id-shaped and no extractor claims it. Each member now carries its own amended
> `Status:` and resolving revision. `check-register-id-uniqueness.mjs` refuses the id-range
> heading form from here on (`id_range_heading`).

All six final-review-3 findings are resolved on the cumulative branch and JOB-003 is
`complete` / `pass` (see `tickets/JOB-003-result.md` § "Final acceptance — 2026-08-12").

- **E3-F028 (C-01)** — RESOLVED `d2040591f`. CSPRNG per-boot advisory key; owner-exclusive
  `pg_advisory_xact_lock` vs all 8 serving pools failing `pg_try_advisory_xact_lock_shared`;
  separate-database → `distributed_execution_advisory_domain` fail-closed; owner pool bound in
  `index.ts`. Real separate-database rejection test present. Independently re-verified.
- **E3-F029 (I-01)** — RESOLVED `d2040591f`/`820515991`. `assertExactCatalogCertificate`
  compares exact relation inventory + `relrowsecurity`/`relforcerowsecurity` + policy
  role/`USING`/`WITH CHECK`; disabled-RLS/disabled-FORCE-RLS/missing-relation/policy-tamper
  negatives present. Independently re-verified.
- **E3-F030 (I-02)** — RESOLVED `cdfa70731` (F030). Tuple-exact bounded cleanup composed per
  admitted shard through the outbox worker; no Cartesian `IN` expansion.
- **E3-F031 (I-03)** — RESOLVED `d24dd68a7` (F031). Executable campaign adapter + git-lineage
  binding + NDJSON evidence validation + Security handoff verifier; 20/20.
- **E3-F032 (I-04)** — RESOLVED `b369ae7e5`/`c4b401047`/`cdfa70731`/`d99945874` (F032).
  Payload-free telemetry module + leasing/scheduler/outbox emission + startup threading.
- **E3-F033 (M-01)** — RESOLVED `d99945874` (F033). Target-then-worker lock order in poll+revoke.

Fresh HEAD execution (`cf03460f1`): 5 files / 141 assertions PASS, with the honestly-labeled
Windows-local `postgres` teardown artifact recorded in the ticket ledger. Linux CI = DEC-03
authority. This resolves the epic's JOB-003 blocker set; the E3 integration/exit gate is a
separate step.

---

## E3-F034 — The 100-claimer poll test sits on the lock-timeout threshold, and its failure CORRUPTS THE NEXT TEST

**Status:** `resolved_in_E3-F034_test_determinism_fix` · **Owner:** E3 / JOB-003 · **Severity:** MEDIUM (CI reliability on a required check)
**Filed:** 2026-09-03, from a red `verify (4)` on PR #340 that was attributed rather than assumed.
**Resolved:** 2026-09-03 on `claude/e3-f034-and-ownership-guard` — see **THE FIX** at the end of this entry.
★ Every `file:line` below is the citation AS FILED and several have since moved; the analysis is
kept verbatim because it is the record of the defect, and THE FIX names the current shapes.

**What.** `job-leasing.integration.test.ts:1467` *"gives exactly one of 100 concurrent claimers one
opaque offer"* fires **100 concurrent `service.poll()`** through `Promise.all` at a **single**
`execution_targets` row. Each poll takes that row `FOR UPDATE`
(`repositories/tenant/job-control.ts:1819-1821`) and holds it to COMMIT of the transaction opened at
`services/job-leasing.ts:542` — with ~8-10 further round trips inside. The app pool is capped at
**24** (`:829`) and `lock_timeout` is **750 ms**, a connection GUC (`packages/db/src/client.ts:107`).
A 55P03 is not absorbed: `job-leasing.ts:796` re-throws anything that is not a `HeadRestartConflict`.

So the test passes only while ~24 queued waiters all clear 750 ms. In the observed failure **93 polls
succeeded and 7 timed out** — it is not broken, it is **on the threshold**, and slower storage tips it.

★★★ **THE PART THAT MATTERS MORE THAN THE FLAKE: THE FAILURE CASCADES.** `Promise.all` rejects on
the first rejection and **does not cancel the other 99 polls**, which keep running and keep mutating
the database. The NEXT test — *"chooses the oldest compatible attempt…"* (`:1493`) — calls
`resetRuntimeRows()` and seeds three jobs while those stragglers are still in flight. **Its three
polls are `await`ed SEQUENTIALLY (`:1508`, `:1512`, `:1516`), so it cannot be self-contending**: its
failure is entirely imported. That is why one flaky test reports as **two** failures, and why six of
the seven 55P03s in the log carry the *second* test's name — which is precisely what makes each
occurrence look larger and less explicable than it is.

★★★ **AND THE CASCADE IS ITSELF NON-DETERMINISTIC — added 2026-09-03 after a FOURTH occurrence.**
This raced **four times in one day** across the programme's lanes, and the failures did not look
alike: at `a83886308` it produced **ONE** failure with **no cascade at all**, and on PR #340 it
produced **TWO**. Whether the stragglers reach the next test's fixture depends on where in the
24-slot pool queue the first rejection landed and how far the survivors had got — so the *shape of
the report* changes between occurrences of the SAME bug. **That is why each sighting looked unlike
the last and was re-diagnosed from scratch.** A reader matching a new red against this entry should
match it on the ASSERTION STRING and the `55P03` on `lockWorkerLeaseAuthority`, never on the failure
COUNT: one failure and two failures are the same defect.

**Evidence — non-determinism and pre-existence are PROVEN, not inferred.**

| claim | proof |
|---|---|
| non-deterministic | Run `33723015836` **attempt 2**, same head sha `dd03516d5`, no code change → `conclusion=success`. A same-commit re-run that passes is a demonstration, not an inference. |
| pre-existing | Run `33628981726`, branch `docs/replatform-program` @ `811ee7ede`, **2026-09-02** — the identical two FAIL lines, the identical `expected null to be 'a3100000-…0010'`, plus `55P03` and `lockWorkerLeaseAuthority` in the raw job log (job `100246991655`). Predates PR #340's code commits and is on a different branch. |
| not caused by PR #340 | The suspected transaction (`job-input-staging.ts` `runInTenant`) touches only `job_artifacts` and `activity_log`; neither has a trigger (zero hits across 272 migration `.sql` files), neither's FKs reach `execution_targets`, and `job_artifacts`' RLS policy (`0211:86-88`) is a bare `current_setting` comparison with no subquery. Decisively, **every server integration test file spawns its OWN embedded postgres** (root `vitest.config.ts:3-14`; `mkdtemp` + `allocateEmbeddedPgPort` per file), so cross-file lock contention is impossible. |

**★ What the environment actually did, stated correctly.** An earlier pass of this investigation
claimed *"the failing run's environment was not worse"* by comparing **one** checkpoint out of 45.
Measured across all of them, the opposite holds: median checkpoint fsync **2.493 s** in the failing
job vs **1.193 s** in the passing one (n=45 / n=44), and the `Duration` line's own decomposition
shows **test time +62.5 s (+17.9%)** even though the aggregate was lower (collect dropped ~50 s). The
“leasing file ran faster” datum is circular — a file whose tests abort at 750 ms finishes sooner.
**The trigger is slow storage, and the design is what converts slow storage into a red gate.**

**★ The one honest coupling to PR #340, measured rather than waved away.** vitest 3.2.6 shards by
**SHA-1 hash of the file path**, not sorted order, so adding any test file re-shuffles assignment
arbitrarily. `cli-008-unit-b-staging-channel.integration.test.ts` migrated ONTO shard 4 (absent from
the passing shard-4 log), bringing an entire additional embedded-postgres cluster and its initdb
fsync storm; `job-input-staging.integration.test.ts` grew 8→12 tests. Together **~+7.1 s** of shard-4
work against a **+62.5 s** test-time delta — small, almost certainly not the cause, and **non-zero**.
Any commit that adds a test file produces this same perturbation class.

**Fix options, for the owner to choose — deliberately NOT applied in PR #340**, which is a CLI-008
staging change and must not carry an edit to an E3 acceptance gate:

1. **Fix the cascade first; it is the cheap half and it is unambiguous.** Await the stragglers before
   the test returns, so a failure cannot leak transactions into the next test's fixture. Note that a
   naive `Promise.all` → `Promise.allSettled` swap also changes what the test *asserts* (rejections
   stop being failures), so the settle must be added **alongside** the existing assertions, not
   instead of them. This alone converts every future occurrence from two confusing failures into one
   attributable one.
2. **Move the test off the threshold**: raise `lock_timeout` for this suite via
   `createTenantAppDbConnection`'s `lockTimeoutMs`, or raise the pool cap, or lower the claimer
   count. ★ Each weakens what the test proves — it exists to show that exactly one of many
   concurrent claimers wins — so whichever is chosen should say in the test what was traded.
3. **Do nothing but record it.** Acceptable only with this finding in place; the failure mode is
   already two sightings old and cost a full investigation to attribute the second time.

★ **Why this is filed rather than shrugged off.** “It is just a flake” has twice been the wrong
answer on this programme ([[e7-cli-001-execution]]: two “flakes” were misdiagnoses). What makes this
one safe to call non-deterministic is not that it *looks* like a flake — it is a same-commit re-run
that went green and a dated prior sighting on another branch, both pulled from raw logs. An
unrecorded flake on a required check is a trap for whoever hits it next.

---

### ★ THE FIX (2026-09-03) — what was done, what property was preserved, and how that is known

**Option 1 (the cascade) and option 2 (the threshold) were BOTH taken; option 3 was not.** Two
changes, in `job-leasing.integration.test.ts` and one new test helper. **No production code changed.**

**1 — the cascade, structurally.** `Promise.all` is replaced by `settleAllClaimers`
(`server/src/__tests__/helpers/settle-all-claimers.ts`), which awaits **every** claimer to
settlement and only then re-throws. This is deliberately NOT the bare `Promise.allSettled` swap this
entry warned against: a rejected claimer is **still a failure** — the helper re-throws it, names how
many rejected, their index and their SQLSTATE, and carries the first reason as `cause`. What changes
is only *when* the verdict is reported, which is exactly the difference between one attributable
failure and two confusing ones. Nothing from the race can still be in flight when the next test seeds.

**2 — the threshold, by removing an assertion the test never meant to make.** The race now runs on
its **own** `createTenantAppDbConnection`, with the **same role**, the **same `max: 24` pool** and the
**same 100 claimers** — so the DATABASE-level overlap, which is the thing that makes it a race, is
bit-for-bit unchanged — and with `lockTimeoutMs` / `statementTimeoutMs` /
`idleInTransactionSessionTimeoutMs` raised to 20 s. Every other test in the file keeps production's
750 ms.

★ **A MEASURED CORRECTION TO THIS ENTRY'S OWN DIAGNOSIS.** `lock_timeout` was **not the only** cap.
Read back live from the pool, the session GUCs are `lock_timeout=750ms`,
`statement_timeout=5000ms`, `idle_in_transaction_session_timeout=5000ms` — a waiting `FOR UPDATE`
spends its wait inside its own *statement*, and a poll transaction sits idle between round trips
while the transactions ahead of it commit. **Raising `lock_timeout` alone, as option 2 proposed,
would have moved the abort from `55P03` to `57014` / `25P03` rather than removed it.** All three are
raised together.

**WHAT PROPERTY IS PRESERVED, AND HOW THAT IS KNOWN.** The test asserts: of N concurrent claimers on
one placed attempt, exactly **1** `offer` and **N-1** `no_work`; each loser's body carries exactly
`{correlationId, outcome, protocolVersion, retryAfterMs, serverTime}` and nothing else; the winner's
body carries the seeded `jobId` and a well-formed fence token; and the database ends at
`leases=1, offered=1, queued=1`. **Not one of those clauses mentions latency, and the claimer count,
the pool cap, the single contended row and every assertion are unchanged.** What is dropped is an
assertion the test made *by accident and never in its name* — that 23 serialized poll transactions
complete inside 750 ms on whatever storage the runner has. That was an ENVIRONMENT property; this
entry's own measurement (median checkpoint fsync 2.493 s vs 1.193 s) is what made it fail.

**THE ANTI-REGRESSION PROBLEM, AND THE ANSWER TO IT.** A test that passes because the race no longer
occurs is indistinguishable from one that passes because it stopped testing — and the threshold
defect *cannot be reproduced on demand*, so timing can never be the evidence. Both halves are
therefore pinned as PROPERTIES:

| half | pinned by | mutation that reds it |
|---|---|---|
| the cascade | `settle-all-claimers.test.ts`, with no database: an early rejection must not be REPORTED until a still-pending straggler has settled | reverting the helper to `Promise.all` — **4 of its 5 tests red**, the property test with `expected false to be true` (the straggler had not settled) |
| the budget | the test reads `current_setting('lock_timeout' / 'statement_timeout' / 'idle_in_transaction_session_timeout')` back **from the live session** and asserts each clears a floor DERIVED from the pool cap (`(CONTENDED_POOL_MAX - 1) x 500 ms = 11,500 ms`) | dropping the three options — reds with `expected 750 to be greater than or equal to 11500`, and `expected 5000 ...` twice. Raising the pool cap without raising the budget also reds, because the floor is derived from it |

**AND THE INVARIANT ITSELF IS STILL LIVE — measured, and it does NOT live where this entry implied.**
Mutating the code the entry cites and re-running:

| mutation | result |
|---|---|
| remove `FOR UPDATE` on the `execution_targets` row (`job-control.ts:1819-1821`, the line this entry names) | **GREEN** |
| ...and on the `workers` row in the same `lockWorkerLeaseAuthority` | **GREEN** |
| ...and the claim head's `FOR UPDATE ... SKIP LOCKED` on `job_attempts` | **GREEN** |
| ...and the `status = 'pending'` conjunct in `offerLease`'s CAS `UPDATE` | **GREEN** |
| ...and the `status = 'pending'` filter in the candidate read | ★ **RED** — 99 of 100 claimers reject with `internal_unavailable`, the losers having tried to mint a second lease against the `leases` uniqueness backstop |

★ **So the three `FOR UPDATE`s SERIALIZE; they do not EXCLUDE.** The single-winner property is
carried by the `status = 'pending'` qualification — in the candidate read and in `offerLease`'s
compare-and-swap `UPDATE`, under Postgres row-write locking and EPQ re-qualification — with the
`leases` unique constraint as the last backstop. Anyone reading this entry to learn *where* the
race is decided would have been sent to the wrong three lines. **A positive control was run before
believing any of the greens** (a `throw` at the top of `offerLease` → 100 / 100 reject), because four
green mutations in a row is exactly the shape of a mutation that never reached the code under test.

**★ THE ADJACENT CASE WAS FIXED TOO, AND IT WAS NOT IN THIS ENTRY.** *"activates exactly once across
100 concurrent ACKs"* has the identical shape one test over: 100 concurrent `service.ack()` through
`Promise.all`, every one taking the same `execution_targets` and `workers` rows `FOR UPDATE` in the
same `lockWorkerLeaseAuthority` and holding them to COMMIT. It has simply not been the one CI was
observed failing. Closing a defect on the case that motivated it while leaving the identical adjacent
case open is this programme's own named recurring mistake (GO-BOOK 1.9.5), so both are fixed. The
rest of the file was counted rather than assumed: the other `Promise.all` races are 2-way, or fixture
seeding on the 4-connection `admin` pool, or already `Promise.allSettled`; the only other repo-wide
`Promise.all(Array.from(...))` in an integration test is `worker-admission-rate-limit` at N=12 against
a single atomic upsert — 11 waiters on one statement, not 23 on a ten-round-trip transaction.

**WHAT WAS DELIBERATELY NOT DONE.** The service still re-throws `55P03` (`job-leasing.ts:796`).
Absorbing it as a retry or as `no_work` would make the test deterministic by construction rather than
by margin, and is arguably the correct production answer — but it is a behaviour change inside the
frozen JOB-003 authority chain, it needs its own gate analysis, and the workload that provokes it
(one worker polling its own target 100 times at once) is a test construction, not a production one.
Recorded here rather than half-taken.

**Verification.** All **39** tests in `job-leasing.integration.test.ts` plus the **5** new helper
tests pass locally on Windows (`AOA_RUN_WIN_INTEGRATION=1`). Typechecking the touched files produces
**147** errors before the change and **147** after — the file carries pre-existing branded-type
errors and is outside `server/tsconfig.json`, so the delta is the only honest signal.
`server/src/__tests__` is eslint-ignored, so no lint gate applies to it (measured, not assumed).

---

## E3-F035 — `listPendingControlCommands` has no caller, and its docstring asserts a consumer that does not exist

**Status:** resolved · **Owner:** JOB-015 (`epics/E3-job-control/tickets/JOB-015-result.md`, slices (b)+(e))
**Severity:** MEDIUM (latent; a capability that looks built and cannot fire).
**Filed:** 2026-09-03, by BRW-004 (E8) terrain mapping, re-measured in E3 at `203853b3a`.

> ★ **The `Severity:` workaround this entry carried is RESOLVED and has been removed (2026-09-03).**
> This entry was deliberately written with an *unbolded* `Severity:` — matching E4's register rather
> than E3's own house style — because `parseFindings` put `**` after the colon in the bolded form, so
> its capture never fired. **That defect is fixed**: the regex now reads the bolded, unbolded and
> backticked forms alike, an OPEN finding whose severity is unreadable or off-vocabulary is a hard
> failure, and `NOT_ACCEPTABLE` is derived from a `SEVERITY_VOCABULARY` table rather than a
> hand-written `["HIGH","CRITICAL"]` that had silently omitted the entire P-scale. This entry is
> restored to E3's `**Severity:**` house style, and **both spellings now parse to MEASURED `MEDIUM`.**
>
> The scope this note recorded was right and is kept for the record: **82 of 108 findings across nine
> registers** parsed as UNKNOWN (E0 9/9, E1 8/9, E2 15/15, E3 34/34, E7 11/11, E4 2/17, E6 2/9,
> E10 1/2; E11 clean). It was a **DEAD LEVER, not a breach** — every `accepted` entry is genuinely
> LOW/MINOR in its text and no HIGH was ever waved away. The registers still disagree with each other
> about house style; that is deliberate (E3 and its neighbours use a P0/P1/P2 STOP scale, the rest
> HIGH/MEDIUM/LOW), and the remedy chosen was to teach the checker the real vocabulary rather than
> rewrite 108 severity values across frozen-evidence epics.

**What.** `packages/db/src/repositories/tenant/job-control.ts:498-503` is a complete, correct
repository method with **zero production callers** — and its own docstring names the consumer:

> `/** Un-ACKed control commands for a lease, in monotonic sequence — the "return`
> ` * pending controls until ACK" read the poll/renew path surfaces. */`

**The poll/renew path does not surface it.**

**Measured at `203853b3a`** (`grep -a`, excluding `node_modules` and `dist/`):

| Claim | Measured |
|---|---|
| non-definition references to `listPendingControlCommands` | **1** — `server/src/__tests__/job-fence-surface.contract.test.ts:114`, a name-inventory contract test |
| the renew path calls it | **no.** `job-control.ts:2477-2484` runs its own inline query with a different projection (`reason` only) and a narrower filter (`command_kind IN ('cancel','graceful_stop')`), collapsed to `cancelRequested: Boolean(pendingCancel)` at `:2495`, with `extensions: []` hardcoded at `:2496` |
| the poll path calls it | **no.** The poll response carries lease offers; it has no control field |
| `commandKind` anywhere in `packages/worker-daemon/src` | **0** |
| production callers of `decideControlReceiverV1` — the E1 replay/gap/conflict/stale classifier that `job_control_commands.ts:33` says the worker uses against this sequence | **0.** The only non-`worker-protocol` reference is that comment |

**Why this is filed at MEDIUM and not shrugged off.** It is not an unused helper. It is a **false
claim of enforcement** — this programme's own named worst failure class — written into the docstring
of the method that would implement the thing it claims. Someone auditing "do queued control commands
reach the worker?" finds a method whose name *and* comment both answer yes. The measurable
consequence: of the five kinds `job_control_commands_kind_check` admits, **three are persisted and
never delivered** (`drain`, `product_approval_result`, `runtime_decision_result`); only `cancel` and
`graceful_stop` reach a worker, and only as an undifferentiated boolean.

**Not live.** Nothing currently depends on delivery of the three undelivered kinds: JOB-011's approval
bridge has zero production callers and is flag-gated off, and no browser or service job is dispatched.
It becomes live the moment either ships.

**Two epics are already blocked by it, independently.** E8/BRW-004 cannot satisfy "denial/timeout
fails closed" (the decision is produced and durably recorded by the 30 s sweep at
`server/src/index.ts:2106-2136`, then never delivered), and E9/SVC-001 hit the same wall from the
other side and wrote the workaround into schema prose at
`packages/db/src/schema/service_generations.ts:61-67`.

**Disposition — RESOLVED by JOB-015 slices (b)+(e).** Closed the way the disposition required:
the method **acquired a real caller**, not a corrected docstring.

- `renewLease` now sources BOTH halves of its control read from
  `repository.listPendingControlCommands(...)` — the `cancelRequested` boolean (identical value:
  the first un-ACKed `cancel`/`graceful_stop` in sequence order is exactly what the narrower inline
  query returned) and the new `dev.aoa.job/control-v1` response extension. The inline duplicate query
  is gone. Deliberately routed through the PUBLIC interface method rather than a shared private
  helper: a private helper would have removed the duplication and left the finding open.
- `extensions: []` is no longer hardcoded. The projector is a **required** parameter on
  `renewLease`, so a future caller cannot silently reintroduce the empty array — the type checker
  asks for it.
- `drain`, `product_approval_result` and `runtime_decision_result` now have a delivery CHANNEL.
  ★ **No command travels it end to end from a PRODUCTION-QUEUED row.** `drain` is the only kind with a worker-side applier (`dispatch-runtime.ts` composes `pollLoop.stopLeasing()`) and has **no production writer at all**; the two kinds that DO have writers have no applier. The
  two result kinds have a delivery path and a fail-closed terminal but **no applier yet**, so they
  are counted `control_command{outcome="unhandled"}` and stay pending for redelivery. That residue is
  E8/BRW-004's and E9/SVC-001's to close and is stated in `JOB-015-result.md`, not hidden here.
- `decideControlReceiverV1` has its first production caller
  (`packages/worker-daemon/src/lease/control-commands.ts`).

The pin that proves this was ever broken is `server/src/__tests__/job-015-control-delivery-pin.test.ts`
plus the `job-control-commands.integration.test.ts` block "JOB-015 control-command delivery ...";
both were verified RED against the pre-fix `extensions: []` line and green after.

**A sibling defect this finding did not name, fixed in the same commit.**
`controlCommandAckV1Schema` is `.strict()` and carries `commandSeq`, and its docstring says the worker
"echoes the command ID + sequence" — but `ackControlCommand` matched on
`(organizationId, leaseId, commandId)` and threw the sequence away. A frozen validation field the
server never checked, the same class as this finding. The echoed sequence is now part of the ACK's
WHERE clause; a mismatch matches zero rows and the command stays pending.

---

## E3-F036 — A required check whose verdict depends on the npm registry: `/adapters/install` is really installed, under a budget 4× shorter than the operation's own

**Status:** open — NARROWED, not closed. The INSTANCE was fixed when this was filed. The CLASS now
has a guard for ONE of its two carriers: `scripts/check-ci-timeout-budgets.mjs` covers required-lane
JOB and STEP budgets in `pr.yml` (see the 2026-09-04 addendum below). The carrier this finding's own
instance rode — a *test* inside the vitest suite that awaits the network — is still unguarded, and
E3-F036's own repro would NOT be caught by the new guard.
**Severity:** MEDIUM (CI reliability on a required check; no production defect)
**Filed:** 2026-09-04, from the reproducible red on the integration tip `c48259358`.

**What was red.** `verify (3)` and therefore `ci-required` failed on the untouched base tip
`c48259358` (run `33799234615`), and re-running the failed jobs on both open PRs reproduced it.
The failing test is `server/src/__tests__/adapters-routes-instance-admin.test.ts` →
*"not 403 install as instance admin"* → `Test timed out in 30000ms`.

**The mechanism, measured.** That test POSTs `/api/adapters/install`, and the route
(`server/src/routes/adapters.ts:417`) calls `execNpm(["install", "--no-save", spec])` INLINE — a real
network install against `registry.npmjs.org`, awaited before the handler can produce the status code
the test reads. `execNpm` (`server/src/utils/npm-spawn.ts:19`) gives that install **120_000 ms**;
vitest's `testTimeout` (`vitest.config.ts:18`) gives the test **30_000 ms**. **The budget is
inverted: the test is allowed a quarter of what the operation it awaits is allowed.** So the verdict
of a required check is a function of npm-registry latency on a GitHub runner — something outside
this repository, unversioned, and not reproducible from the commit.

The log says so precisely: the file reported `3 tests | 1 failed` at `31768ms`. The FIRST install (cold
npm cache) crossed 30 s; the SECOND, in the same file seconds later against a now-warm cache, passed.
Same runner, same registry, same commit, different verdict.

**Two hypotheses were tested. The one that named this commit is REFUTED.**

*H-B (shard reshuffling).* This repo's vitest shards by SHA-1 of the path
(`BaseSequencer.shard`, vitest 3.2.6), so any new test file redistributes every shard, and
`c48259358` added one (`packages/sandbox-e2b-provider/src/__tests__/keyed-cli-008-unit-d-invocation.test.ts`).
Replaying that exact algorithm over the collected 2,538-spec set gives:

- `adapters-routes-instance-admin.test.ts` — **shard 3 BEFORE, shard 3 AFTER** (index 1772 → 1773).
  It did not move.
- **Exactly one** file changed shard: `server/src/__tests__/cli-008-unit-b-staging-channel.integration.test.ts`,
  **3 → 4** — i.e. shard 3 lost an integration test and got *lighter*.
- The new file is `describe.skip` without `E2B_API_KEY` (`:59-60`), which `verify` does not set, so it
  adds ~0 s wherever it lands.
- Shard count is still 4; `scripts/test-inventory.json` moved by one pinned count and nothing else.
- Wall-clock agrees: `verify (3)` ran 14, 14, 13, 15, 15, 14, 14 minutes over the seven green
  predecessors and **16 minutes** on the red run — and two 30 s timeouts account for a minute of that.
  **There is no time jump at `c48259358`.**

*H-A (registry latency).* Confirmed, with the correction above that it is not "latency" alone but an
inverted budget that makes ordinary latency fatal.

**The correlation with `c48259358` is spurious**, and one datum reported as "same commit green then
red" is a misreading worth recording: the green run one minute earlier (`33799136579`, 19:54Z) is on
`da6e8ffec`, the PARENT — not on `c48259358`. The genuine evidence for non-determinism is inside the
red run itself: two identical operations, one over budget and one under, 30 s apart.

**The fix, and why not a bigger timeout.** Raising `testTimeout` would hide a real slowdown and keep
the external dependency; deleting the tests would drop the authz coverage. Neither is the shape.
What these tests prove is an **authz** property — who the `/adapters/install` gate admits — which does
not need a package to actually be installed. So the tests now pin npm to **offline mode against an
empty cache** for their duration (`npm_config_offline`, `npm_config_cache` under the per-test
`tmpHome`). `npm install --no-save x` then fails immediately with `ENOTCACHED`, the route still
returns a non-403 status, and the assertion is untouched. Measured: the file goes from ~31.8 s in CI
(2 tests) to **0.97 s for 3 tests**, with zero network.

**It also recovers coverage.** The two tests were `skipIf(win32)` because a real install locked the
temp dir (EBUSY on cleanup). Offline mode installs nothing, so that reason is gone: **both tests now
run on Windows**, verified locally at 3/3 green. The advisory Windows lane gains two tests rather than
losing any.

**Positive control.** The fix was made to fail on purpose. Dropping `operator: true` from the
`instanceAdmin` actor reds it — `AssertionError: expected 403 not to be 403` — so the offline pin did
not neuter the assertion; the gate is still what is being measured. A second control removed the
`npm_config_offline` line and the same file went from 3.7 s to 9.0 s of wall clock on a warm-cached
developer machine, i.e. the removed cost is exactly the network.

**★ The class, and why it is filed rather than closed.** This is the SECOND required-check failure in
two days whose verdict depended on something outside the repository. **E3-F034** was the first: a
100-claimer poll test sitting on a 750 ms Postgres `lock_timeout`, where the deciding variable was
runner fsync speed (median 2.493 s vs 1.193 s on the slow runner). This one's deciding variable is
npm-registry response time. They are one class:

> **A required check whose verdict is a function of something the commit does not contain.**

Both instances present identically — an intermittent red that clears on re-run — and the standing
response to both has been *"re-run until green."* That response is **indistinguishable from ignoring a
real regression**, which is the operational cost: the same signal is produced by an environment blip
and by a genuine performance defect, and the gate gives you no way to tell them apart. This programme
already has a name for the neighbouring failure — a check that nothing runs — and this is its mirror:
a check that runs, but decides on evidence the repository does not own.

The instance is closed here. The class is not: **there is no guard that would refuse a new required
test which reaches the network or wall-clock-races an external service.** Nothing enumerates such
tests today, so a third instance would be found the same way the first two were — by a red on the
integration branch, days after it landed.

**Disposition.** `unowned`, on the record. Every E3 ticket has shipped, and the class remediation
(an inventory of required-lane tests that touch the network or an external clock, plus a guard that
refuses additions to it) is a CI-platform decision with a blast radius across four shards — not a line
in a job-control ticket. Force-fitting it onto a shipped owner would read as owned by nobody
(E4-F013). It blocks nothing today; it costs a false red every few days and it trains the reflex that
turns a real regression into a re-run.

---

### ★ Addendum (2026-09-04) — the class gets a guard for one of its two carriers, and the fix that leaked is measured

Filed by the track chartered to close the CLASS rather than a fourth instance. Everything below is
measured from the GitHub Actions jobs API over **13 `pr.yml` runs on `docs/replatform-program`**
(`33757510288` … `33882094462`, 2026-09-03 12:50Z → 2026-09-04 14:09Z), 12 job instances each.

#### 1. The leak, counted

E6-F014's fix raised the cap on `policy`. **Nine jobs in `pr.yml` run `pnpm/action-setup`** — `policy`,
`brand-check`, `verify` (a 4-shard matrix), `lint`, `e2e`, `migrations`, `e2e-pgvector`,
`distributed-contract`, `browser` — so one of nine exposures on the required lane was closed. Repo-wide
the step appears **21 times across 12 workflows**; the other 12 uses are on non-required lanes and are
NOT addressed here.

#### 2. Why a job cap is the wrong instrument — the measurement that settles it

Split each job's wall clock into WORK (total minus `Setup pnpm`) and the setup step:

| | p50 | max | max/p50 |
|---|---|---|---|
| WORK, worst-spread job of the nine (`browser` 51/59/105 s) | 59 s | 105 s | **1.78×** |
| WORK, tightest job of the nine (`lint` 48/56/61 s) | 56 s | 61 s | 1.09× |
| `Setup pnpm`, all nine | 4 s | **431 s** | **~108×** |

Ranking every step in the workflow by spread (max − p50), **the nine `Setup pnpm` rows are the nine
largest**, at 191–426 s. The tenth is `verify :: Run tests` at 173 s, which is real work. So one job
`timeout-minutes` is a single number asked to bound two distributions that differ by two orders of
magnitude in variance — and it therefore hides a work regression by the entire size of whatever
infrastructure allowance is folded into it. `verify` was the extreme case: a 60-minute cap over a
worst measured shard-work of 1092 s, i.e. **~42 minutes of undeclared slack**, which is the same shape
as the hang that cap once masked for weeks.

#### 3. ★★★ It is an EPISODE, not a trend — which strengthens the case rather than weakening it

E6-F014's own withdrawn "still growing" reading warned that a sample drawn from an episode describes
the episode. Measuring the population says the same thing about the slowdown itself. Per run, the
number of the 12 job instances whose `Setup pnpm` exceeded 60 s:

| run (started) | p50 setup | max setup | jobs > 60 s |
|---|---|---|---|
| 5 runs, 09-03 12:50Z → 19:54Z | 4 s | 5–12 s | **0** |
| `33840970676` 09-04 05:34Z | 174 s | 424 s | 10 |
| `33842573550` 09-04 06:34Z | 297 s | 431 s | 10 |
| `33847376840` 09-04 07:08Z | 193 s | 425 s | 12 |
| `33869236742` 09-04 11:42Z | 81 s | 423 s | 7 |
| 4 runs, 09-04 12:10Z → 14:09Z | 4–6 s | 8–22 s | **0** |

**The slowdown is a ~6-hour window on 2026-09-04, with 4 s either side of it.** If the cost were a
permanent 400 s the honest answer would be to raise every cap once and move on. Because it is an
intermittent episode that leaves no trace in any commit, a single cap is precisely the wrong
instrument: it silently absorbs the episode when it fits, and when it does not it kills the job and
GitHub names an innocent step.

**A control fell out of the same data.** Comparing each job's WORK inside the episode against outside
it: `verify` 857 s vs 909 s, `e2e` 1003 vs 989, `policy` 71 vs 73, `browser` 60 vs 59, `lint` 56 vs 57.
Identical within noise, in both directions. **The episode was in the registry fetch, not in the
runners** — so it did not contaminate the work budgets derived from the same window.

#### 4. What shipped

- **One exposure DELETED rather than capped.** `brand-check` never ran `pnpm install`; its single
  `pnpm exec node scripts/check-forbidden-tokens.mjs` was equivalent to plain `node`, because that
  script imports only `node:` builtins. The `Setup pnpm` step existed to make `pnpm exec` resolvable
  and bought nothing while exposing a required check to registry latency (3 s median, 234 s worst,
  measured here). Step removed, `pnpm exec` dropped, cap 10 → 5. **Nine exposures → eight.**
- **The budget is SPLIT on the remaining eight.** Each `Setup pnpm` step carries its own
  `timeout-minutes: 8`, and each job's cap is now
  `ceil((workBudgetSeconds + setupAllowanceSeconds) / 60)` from `.github/ci-timeout-budgets.json`.
  A slow registry now fails *by name*, in a step whose name is the diagnosis.
  ★★★ **CORRECTED 2026-09-05.** This bullet first continued "*and the job cap bounds only the work,
  which is the part the commit owns*". **That was false as shipped and is withdrawn.** GitHub's job
  `timeout-minutes` covers every step, so the allowance is **additive and unreserved**: when the
  setup step runs at its 4 s p50, the work may spend the whole cap minus 4 s. Measured worst work
  against cap-minus-p50-setup: `lint` 596 s vs 61 s (**9.8×**), `distributed-contract` 9.3×, `policy`
  7.5×, `migrations` 7.4×, `browser` 6.8×, `e2e-pgvector` 2.8×, `verify` 2.0×, `e2e` 1.9×. Nothing at
  runtime compares realized work to `workBudgetSeconds` — it is a declared bound the derivation and
  the ceilings use, not an enforced one. **The magnitudes improved; the shape did not**, and the
  shape is what §2 above indicts a combined cap for. Doing better needs a runtime work-duration
  check, which is not built and is not claimed here.
- **Caps are derived, and seven go DOWN:** `policy` 12→11, `lint` 15→10, `migrations` 15→11,
  `browser` 20→12, `distributed-contract` 20→10, `e2e-pgvector` 25→18, `verify` 60→37. **One goes
  up:** `e2e` 30→33.
  ★ `e2e` was the thinnest real exposure of the nine, not `brand-check`: at the worst measured work
  (1046 s) plus the worst measured setup (431 s) it had 323 s of margin against its 1800 s cap.
  `brand-check` — the job that *looked* worst, 12 s of work behind a 10-minute cap — had 153 s of
  margin, less in absolute seconds but never close to failing. **The job with the most alarming ratio
  was not the job most likely to fail**, and the ratio is what the eye reaches for.
- `setupAllowanceSeconds` is **480 s** uniformly, the smallest whole minute above every one of the 156
  observations. Adopting it changes no past outcome; it is sized on the episode's worst, which is
  deliberately conservative and is said here so the number is not mistaken for a typical cost.
- ★ **A cold pnpm store was checked for and headroom left for it.** Every run in the window had a
  warm `actions/setup-node` `cache: pnpm`: `Install dependencies` measured 8–14 s and `Setup Node.js`
  7–23 s in every job. A branch with no cache to fall back on pays more, so each work budget carries
  at least ~56 s above its measured worst work, and the three tightest jobs were widened for it
  (`policy` 150→170, `migrations` 150→170, `lint` 110→120) **without moving a single derived cap** —
  650 s and 600 s still round to 11 and 10 minutes. This is not a measurement of a cold run; it is
  headroom sized against one, and it is recorded as such in the manifest.

#### 5. The guard, and the red it produced

`scripts/check-ci-timeout-budgets.mjs` (+ `scripts/lib/ci-timeout-budgets.mjs`, 21-case corpus in
`scripts/check-ci-timeout-budgets.test.mjs`), wired into `policy`. It refuses: a required-lane job
running `pnpm/action-setup` with no budget entry; a `Setup pnpm` step with no cap of its own; a job or
step cap that is not the derived value; a work budget below its own measurement or **more than 2× it**;
a measurement with fewer than 5 samples, no ISO date, or no run ids; a stale budget for a job that no
longer fetches pnpm; and a required-lane job carrying a cap that is neither budgeted nor exempt with a
stated reason. A scan that matches nothing FAILS rather than reporting clean.

**It failed once on the real, unmodified tip before anything was edited: 17 findings across all 9
jobs** — 8 × `setup_step_uncapped`, 8 × `job_cap_mismatch`, 1 × `job_missing_budget`. Two live
mutations were then made against the fixed tree and restored: raising `verify` back to 60 alone gives
`job_cap_mismatch`; raising the cap **and** the work budget together to make it "legal" gives
`work_budget_unjustified` — so passing requires editing `measuredMaxWorkSeconds`, which is a dated
claim about reality sitting in the diff where review can argue with it.

#### 5b. ★★★ The claim "the escape hatch is closed" was FALSE, and this is what the ceiling added

This addendum first ended §5 with "*so the escape hatch is closed*". Review refuted it. **The ceiling
applied to `workBudgetSeconds` alone.** `setupAllowanceSeconds` was validated as a positive finite
number and nothing else: there was no `measuredMaxSetupSeconds` field anywhere — the 431 s figure
lived only in unchecked `$comment` prose — and none of the 14 finding codes concerned the size or the
provenance of the allowance. So this diff **passed the guard**, reproduced before anything was fixed:

```
setupAllowanceSeconds: 480 -> 3000   (all eight jobs; it is ONE uniform number)
+ the eight job caps re-derived        policy 11m -> 53m, verify 37m -> 79m
+ the step cap re-derived              8m -> 50m, on all eight
=> evaluateCiTimeoutBudgets: ok = true, findings = []
```

That was **strictly easier** than the work-budget raise the guard already refused, and **strictly
more damaging**, because the allowance is uniform: one edit moves eight job caps and neuters eight
step caps at once. The true statement about the shipped state was: *the WORK dial cost a
re-measurement; the INFRASTRUCTURE dial cost nothing.*

**What the ceiling added (2026-09-05) — and see 5c for what it did NOT add.** The manifest gains a
`setupAllowance` block carrying the same shape as a work measurement — `measuredMaxSetupSeconds: 431`, `measuredSampleSize: 156`
(13 runs × the 12 job instances that then ran the step), `measuredOn`, and the 13 run ids — declared
**once**, because the measurement is workflow-wide and a per-job copy would be a per-job claim the
evidence does not support. ★ That measurement was **re-derived first-hand from the Actions jobs API
on 2026-09-05**, not carried forward on trust: exactly **156** steps named `Setup pnpm`, min 3 s, max
**431 s** (run `33842573550`, job `verify (4)`), **zero** observations above 480 s and zero above the
646.5 s ceiling. One reconciliation fell out of it: the "4 s p50" quoted above is the **quiet-window**
p50; across all 156 including the episode the median is **5 s**. Both are true of different
populations, and every ratio quoted here is unchanged at either value to the precision given. Four new clauses read it: `setup_measurement_incomplete`,
`setup_allowance_below_measurement`, `setup_allowance_unjustified`, and the ceiling
`MAX_SETUP_ALLOWANCE_FACTOR = 1.5` — **tighter** than the work budget's 2×, because growth in a
third-party fetch is the signal this file exists to surface rather than something to grow into, and
because this one number is additive into all eight caps. 480 s sits at 1.11× its measurement — i.e.
well inside the 1.5× ceiling, which is the residue 5c states. **No cap in the manifest changed**, so the live evidence in §6 below still describes the shipped caps.

The refuting diff is now a test. Six new cases (corpus part **(C)**) were run against the
pre-correction library: **6 of 6 RED**, then green after the fix, and the library restored and
re-verified. One of them — "raising the allowance PAST ITS CEILING costs a dated re-measurement" — opens with a **positive control**,
because an assertion that a finding code is *absent* passes vacuously against a build that never
emits it, which is exactly how the hole shipped.

#### 5c. ★★★ The replacement claim was ALSO false: a raise INSIDE the ceiling is free

§5b ended by saying the allowance now carries "the same discipline as a work measurement", and the
register entry, the GO-BOOK row, the manifest and the library all went further and said **raising a
cap now costs a re-measurement in the same diff on BOTH dials**. Second review refuted that too, and
it is **computable from the shipped manifest without running anything**. It is withdrawn here and
**not replaced with a third claim**.

Both clauses compare a **declared** number to a measurement **declared in the same file**:
`work_budget_unjustified` tests `workBudgetSeconds <= 2 x` the DECLARED `measuredMaxWorkSeconds`,
`setup_allowance_unjustified` tests `setupAllowanceSeconds <= 1.5 x` the DECLARED
`measuredMaxSetupSeconds`. **No clause compares any number to a PREVIOUSLY COMMITTED value.** So the
shipped numbers are not a floor for the next diff — only the ceilings are, and the room below them is
large. MEASURED 2026-09-05 by evaluating the library against the real `pr.yml` with every declared
number pushed to its own ceiling and **no `measured*` field edited**:

| number | declared | its ceiling | free |
|---|---|---|---|
| `verify` work | 1700 s | 2184 s | +484 s |
| `e2e` work | 1500 s | 2092 s | +592 s |
| `e2e-pgvector` work | 600 s | 776 s | +176 s |
| `browser` work | 200 s | 210 s | +10 s |
| `migrations` work | 170 s | 178 s | +8 s |
| `policy` work | 170 s | 176 s | +6 s |
| `distributed-contract` work | 120 s | 128 s | +8 s |
| `lint` work | 120 s | 122 s | +2 s |
| `setupAllowanceSeconds` | 480 s | 646.5 s | **+166.5 s, uniform across all eight** |

Taking all of it: the eight derived job caps go **142 min → 187 min** in total (`verify` 37→48,
`e2e` 33→46) and every step cap **8→11**, and the guard prints **OK**. This also corrects §5b's
closing sentence — the two numbers are *not* "as tight as the measurements allow"; 480 sits at 1.11×
its measurement against a 1.5× ceiling, and `verify`'s budget at 1.56× against a 2× ceiling.

**No clause was added for it, deliberately.** Pinning a budget to its previous value **cannot** be a
clause in this guard: `evaluateCiTimeoutBudgets` is pure over ONE commit's `pr.yml` plus the
manifest and has no access to the prior revision of either. That is a separate, diff-aware
instrument. It is not built, and describing the hole exactly is what this section is for.

#### 5d. ★★ A second miss, found in the same read: a required-lane job with NO cap

The coverage clause reads `if (job.timeoutMinutes === null) continue`. So a required-lane job that
arrives with **no `timeout-minutes` at all** is neither budgeted, nor exempt, nor flagged — it
inherits GitHub's **360-minute** default, while every job cap in `pr.yml` **sums to 159 minutes**.
That is the exact shape the clause was written for ("instance ten" arriving with a number nobody
justified), **missed when the number is absent rather than wrong**.

MEASURED 2026-09-05: deleting `brand-check`'s `timeout-minutes` **and** its exemption together
yields `{ok: true, findings: []}`. All eleven required-lane jobs carry a cap today, so this is a hole
in the guard, not a defect in the tree. A job that runs `pnpm/action-setup` is still caught by
`job_missing_budget` either way.

Both misses are pinned by disclosure tests (corpus part **(D)**) that assert the guard *passes* those
diffs and that the figures quoted in prose are the figures the manifest implies. Each opens with a
**positive control**, because asserting `ok: true` proves nothing unless the same harness can produce
a red for the same inputs. Four mutations were made and restored (removing the null-cap skip;
stripping the disclosure from the library, the register and the GO-BOOK; moving a cap). **25/25 pass.**

★ Codex was **unavailable** for an outside adversarial pass on this round (usage limit; retry
2026-09-07), so 5c and 5d are the result of a first-hand re-read, not an external verdict.

#### 6. ★ What this does NOT close — stated plainly

1. **This finding's own instance would not be caught.** The guard reasons about jobs and steps in
   `pr.yml`. E3-F036's defect was a *vitest test* awaiting a network install under a shorter budget
   than the install's own. **The test-level inventory this finding asked for still does not exist**,
   and a new test that reaches the network is still admitted silently. That is the larger half of the
   class and it remains `unowned`.
2. **The cause of the episode is undiagnosed.** Nothing here explains why `pnpm/action-setup` went
   4 s → 431 s for six hours. E6-F014's free lead — PR **#321**, `pnpm/action-setup` 6.0.9 → 6.0.10,
   still open and untested — was **not** tested by this track. Splitting the budget makes the next
   episode legible; it does not prevent one.
3. **12 of the 21 repo-wide uses are untouched** (non-required lanes: `release.yml`,
   `release-smoke.yml`, `cross-platform-weekly.yml` ×2, five `keyed-e2b-*`, `llm-evals.yml`,
   `catalog-audit.yml`, `thread-v2-e2e.yml`).
4. ★ **The job cap still does not bound the work — by design of GitHub's `timeout-minutes`, not by
   oversight, but it is a real residue and it is NOT closed.** The allowance is additive and
   unreserved; the ratios are in §4 above (worst: `lint` at 9.8×). Each declared number is compared
   against a measurement declared beside it, but the only lever that would bound REALIZED work is a
   runtime comparison of the work duration against `workBudgetSeconds` — a
   post-`Run tests` step that reads the step durations and fails the job when work overran its own
   budget. That is a different mechanism (a report becoming a gate, after the fact) and is not built.
   Until it is, `workBudgetSeconds` is a **declared** number used by the derivation and the ceilings,
   not one compared against a running job, and this addendum should not be read as saying otherwise.
   ★ Two smaller ones in the same family. **An `exempt` job's cap is not derived at all** — the
   exemption waives the pnpm allowance and asks only for a reason, so a job that stops fetching pnpm
   may carry any `timeout-minutes`. It cannot be used as a shortcut (a job that still runs
   `pnpm/action-setup` gets `job_missing_budget` exempt or not), but the three exempt jobs' 5-minute
   caps rest on their stated reasons, not on arithmetic. And **a required-lane job with no
   `timeout-minutes` at all is skipped by the coverage clause entirely** — see 5d.
   ★ **A raise inside either ceiling is not seen either** — see 5c for the measured room. Neither
   number is "as tight as its measurement allows"; each is only inside its own ceiling.
5. **Other network steps are inside "work", not separately allowanced** — `playwright install` in
   `e2e`/`browser` (spread 9 s and 34 s) and `Initialize containers` in `migrations`/`e2e-pgvector`
   (spread 11–13 s). Two orders of magnitude below the pnpm step, so they do not yet earn their own
   allowance; the manifest records where to put one if they ever do.
6. ~~**No live CI evidence at the time of writing.**~~ **SUPERSEDED — the caps are now proven live.**
   Run **`33902312371`** on `claude/ci-timeout-class` is **fully green including `ci-required`**, with
   every job inside both its new cap and its declared work budget:

   | job | total | `Setup pnpm` | work | budget | cap | headroom |
   |---|---|---|---|---|---|---|
   | `policy` | 78 s | 4 s | 74 s | 170 s | 11 m | 582 s |
   | `lint` | 61 s | 7 s | 54 s | 120 s | 10 m | 539 s |
   | `migrations` | 67 s | 3 s | 64 s | 170 s | 11 m | 593 s |
   | `browser` | 59 s | 3 s | 56 s | 200 s | 12 m | 661 s |
   | `e2e-pgvector` | 304 s | 4 s | 300 s | 600 s | 18 m | 776 s |
   | `e2e` | 999 s | 4 s | 995 s | 1500 s | 33 m | 981 s |
   | `verify` (4 shards) | 727–953 s | 3–7 s | 724–946 s | 1700 s | 37 m | 1267–1493 s |
   | `brand-check` | 10 s | **absent** | 10 s | exempt | 5 m | 290 s |

   `brand-check` recording **no `Setup pnpm` step at all** is the deletion confirmed in CI rather than
   argued from the file. ★ What this run does **not** prove: it landed in a quiet window (setup 3–7 s),
   so **the 8-minute step cap has never actually fired.** Its first real test is the next episode.

**Disposition:** stays `unowned`. Items 1, 2 and 4 are the open remainder, and none of them is a line
in a job-control ticket.

## E3-F037 — A handed-off distributed attempt writes NO cost event, and E3-15's register reason asserts the opposite

**Status:** open
**Severity:** HIGH (arming the rollout dial produces spend no budget policy can see, cap or pause)
**Filed:** 2026-09-06 (W5U1), measured at `e1f723df2`. Filed from a 35-agent dormancy audit; every
number below was re-measured by hand in this worktree before filing, in both directions.

**What the register SAID, and no longer says.** `scripts/gate-clause-wiring.json` → `E3-15-budget`,
as filed:

> "Parity bridge with zero callers; **budget/cost still flow through the legacy cost-event path**.
> Wire at sink cutover (Sprint 6)."

The second clause is the load-bearing one, and it is false for exactly the runs the rollout dial
creates. It was printed as the standing answer to "what happens to money when a run goes
distributed" on every green `policy` run.

> ★ **UPDATE 2026-09-07 (W16A, branch `replatform/w16a-register-sentences`).** That sentence is
> GONE. `E3-15-budget`'s `reason` now states the measured consequence — a handed-off distributed
> run is UNBILLED, with the four writer sites, the suppression return, and the three blind
> controls cited by `file:line` — and it names this finding as still open. Every measurement
> below was re-derived at `8075cd7a1` before the rewrite; all of it held, including the two
> `updateRuntimeState` call sites, the four `insert(costEvents)` sites, and `priceAcceptedUsage`
> at zero production references.
>
> **This finding stays OPEN.** See the amended "What would close it" below: correcting the
> sentence removes the MISREPRESENTATION, not the unbilled spend, and the unbilled spend is what
> the title's first clause names and what sets the HIGH severity.
>
> **W16A-FIX (same PR) additionally moved the operator warning to where an operator reads** —
> `CLI-006-staging-canary-runbook.md` §2.1 — because a warning shelved in a CI register is a check
> nobody runs. See the amendment under "Why this is HIGH" below.

**Measurement 1 — every `cost_events` writer in the repository.**

```
grep -rn "insert(costEvents)" server/src packages --include=*.ts | grep -v __tests__ | grep -vi "\.test\."
```

FOUR, and none of them serves a handed-off run:

| writer | reached by |
|---|---|
| `server/src/services/heartbeat.ts:2653` (inside `updateRuntimeState`) | the LEGACY executor only — see measurement 2 |
| `server/src/services/costs.ts:69` (`costService.createEvent`) | `routes/costs.ts`, `aoa-agents/runner.ts` (crew), and `job-budget-cost-bridge.ts` |
| `server/src/services/one-shot-cli-budget.ts:182` (`recordOneShotCliCost`) | `one-shot-sandbox-cli.ts` (extraction) and `job-budget-cost-bridge.ts` |
| `server/src/services/company-portability.ts:3203` | bundle import |

**Measurement 2 — heartbeat's one writer sits entirely on the legacy side of the suppression return.**

- `updateRuntimeState` is declared at `heartbeat.ts:2622`; its `db.insert(costEvents)` is at `:2653`.
- Its ONLY two call sites are `:5805` (the success path, after `adapter.execute` returns) and `:6013`
  (the outer failure handler).
- The CLI-006 suppression return is `heartbeat.ts:5451` — `return; // CLI-006-SUPPRESSION-RETURN`,
  inside `if (shouldSuppressLegacyExecution(canaryExecutionOwner))`.
- A `return` is not a throw, so it reaches neither `:5805` nor the catch at `:6013`. A handed-off run
  therefore writes no `cost_events` row, does not increment `agents.spentMonthlyCents` or
  `companies.spentMonthlyCents`, and never reaches `checkBudgetAlerts` (`:2676`, also inside
  `updateRuntimeState`) — so the agent-pause-on-exceed path cannot fire either.

**Measurement 3 — the distributed path bills NOWHERE ELSE. Checked, because "it must be billed
somewhere" is the assumption that would make this finding wrong.**

- `job-budget-cost-bridge.ts` is the designated authority (its header: "A distributed attempt's
  ACCEPTED usage event must be priced by the EXISTING budget/cost authority EXACTLY ONCE"). Its
  entrypoint `priceAcceptedUsage` has references in exactly two files, **both tests**
  (`job-budget-cost-parity.integration.test.ts`, and `jobBudgetCostBridge` itself in
  `job-distributed-drain.integration.test.ts`). `node scripts/check-gate-clause-wiring.mjs --counts`
  measures `jobBudgetCostBridge` at **0**.
- Nothing on the conversion path applies a SPEND gate before dispatch either:
  `grep -n budget run-execution-owner.ts job-convert-orchestrator.ts job-admission-bridge.ts
  heartbeat-distributed-rollout.ts` returns ONE hit, and it is a comment about an Organization
  **concurrency-slot** budget, not money.
- The pre-run cost read that DOES survive the handoff is `resolveCheapFallbackModel`
  (`heartbeat.ts:4792`, guarded at `:4791`, both before the return). It only downgrades the model in the workload; it caps
  nothing, and it reads a `cost_events` sum that distributed runs never add to — so it gets
  *quieter*, not louder, the more distributed spend there is.

**Why this is HIGH rather than a documentation nit.** The register sentence is the artefact a later
AGENT reads before arming `AOA_DISTRIBUTED_EXECUTION_ROLLOUT`. Taken at face value it says the money
question is already answered. Measured, arming the dial to `canary` for an
Organization converts every eligible task run into spend that no `budget_policies` row, no agent
`budgetMonthlyCents` pause, and no company hard-stop can observe — because the ledger they all read
never receives a row. The defect is not that the bridge is dormant (that is honestly declared and
correct); it is that the register's stated CONSEQUENCE of the dormancy is the opposite of the
measured one.

> ★ **AMENDED 2026-09-07 (W16A-FIX) — THE OPERATOR WAS NEVER READING THIS FILE.** As filed, this
> paragraph said the register sentence is what "an operator **or** a later agent" reads before
> arming. Half of that is wrong, and it is the half that decides where a warning belongs:
> `scripts/gate-clause-wiring.json` is a CI register, printed on green `policy` runs and read by
> whoever is auditing the gate. The document an **operator** follows to arm the dial is
> `epics/E7-coding-e2b/tickets/CLI-006-staging-canary-runbook.md` ("Audience: the OPERATOR"),
> §2.1 *The rollout dial (canary mode)* and §3 step 3 — and until W16A-FIX it said **nothing about
> billing**. Measured, not assumed: `grep -nic 'budget|cost|billing|spend|unbilled'` over that
> runbook returned exactly **2** hits, and both are something else — `:20` "authorize the real E2B
> spend" (the operator/session boundary on handling `E2B_API_KEY`) and `:211` "the same org
> budget", which §2.5(c) is using for the **concurrency-slot** cap, not money. W16A's
> first pass wrote "READ IT BEFORE ARMING AOA_DISTRIBUTED_EXECUTION_ROLLOUT" into the register,
> which addresses a reader who is not there. The warning now lives in the runbook at §2.1 and is
> cross-referenced from §3 step 3; the register keeps the derivation and points at it.
>
> **A SECOND arming document, found by asking who else could arm without the runbook.**
> `docs/deploy/environment-variables.md`'s `AOA_DISTRIBUTED_EXECUTION_ROLLOUT` row is a complete
> arming instruction on its own — the JSON shape, "edits take effect LIVE — no restart", and its own
> "Rolling distributed execution back" section — so a reader who never opens the runbook can still
> arm the dial. That row now carries a one-sentence POINTER to this finding and to the runbook box.
> Deliberately a pointer and not a second copy: a second copy is a second thing to keep true, which
> is how the sentence this finding is about got written in the first place.
>
> **The finding is unchanged in severity, status and every measurement** — this amendment is about
> where the consequence is published, not what it is.

**Not claimed.** Nothing here says the dial is armed. E7-F018 measures that no checked-in
configuration arms it, and that is unchanged: this is a precondition on arming, not a live leak.
The bridge itself is correct code (JOB-012); the defect is the register's account of what its
absence costs.

**What would close it. ★ AMENDED 2026-09-07 (W16A) — the original sentence offered a DISJUNCTION,
and the second arm of it was wrong.** As filed it read: *"Either wire `jobBudgetCostBridge` into the
accepted-usage path (Sprint 6 sink cutover, as the clause already schedules), or — cheaply and
immediately — correct E3-15's `reason` so it states the measured consequence."* W16A has now done
the second arm, and doing it made the error visible: correcting the sentence removes the
misrepresentation and changes **nothing** about the measured defect this finding's title leads with
— a handed-off attempt still writes no `cost_events` row, and every control in Measurement 2 is
still blind to it. Closing a HIGH finding about unbilled spend on a prose edit would be the
false-claim-of-enforcement move this programme's guards exist to refuse. The two records already
disagreed on this point and the manifest was the correct one: `scripts/finding-ownership.json`
called the same edit a **"Cheapest partial close"** and added "HIGH may never be `accepted` and is
not being accepted".

**So: this closes only when `jobBudgetCostBridge` (or an equivalent) is called on the accepted-usage
path, so that a distributed-owned run produces a `cost_events` row the budget controls read.** The
prose half is DONE and is not a reason to close anything. Ownership is unchanged and still
`unowned`: the sink cutover that would wire the bridge has no ticket (MIG-007 §3.3 — "None is
promoted by this ticket").

> ★ **AMENDED 2026-09-18 (post-E7-1) — THE ACCEPTED-USAGE SEAM THIS CLOSURE NAMES IS EMPTY ON THE
> DEPLOYED PATH, so wiring alone does not close it.** The sentence above names an accepted-usage
> *wiring* seam. Re-measured at HEAD, that seam has nothing to wire to: the deployed distributed
> worker composes its supervisor **without** `observeRun` — `makeSupervisor({…})` at
> `packages/worker-daemon/src/lifecycle/dispatch-runtime.ts:187` passes no `observeRun`, and the
> comment above it (`:180-182`) states *"observeRun stays absent"*. A `usage` event is emitted ONLY
> inside `if (deps.observeRun)` (`packages/worker-daemon/src/supervisor/supervisor.ts:873`, emit at
> `:882`). So a real distributed attempt — **the proven E7-1 run included** — emits NO `usage` event,
> and `priceAcceptedUsage` (which requires token `units`) has nothing to price. The E7-1 verifier
> records the same producer gap in its own words — *"observeRun is uncomposed"*
> (`server/src/cli/verify-e7-1-distributed-run.ts:65-68`) — and the terminal projector already carries
> it: *"`observeRun` is default-off (E4-D12), so a real canary attempt may emit no usage at all"*
> (`server/src/services/canary-terminal-projection.ts:221`), leaving `costUsd: null` by construction
> (`:242-245`).
>
> **Consequence for closure — it is a TWO-part producer+consumer problem, not a one-line wiring.**
> Calling `priceAcceptedUsage` on an empty seam produces no `cost_events` row; feeding it zero /
> wall-clock units would mint a ~$0 row while the real model spend happened inside the sandbox on the
> Company's provider key — the very spend this HIGH finding is about — a hollow close, not a real one.
> So closure requires BOTH **(1)** the deployed worker to emit usage evidence (compose `observeRun`,
> or an equivalent producer — CLI-008 Unit F territory) AND **(2)** the bridge wired to price it. This
> is the SAME structural-reachability root that **E7-F018** (HIGH, open) measures for the output /
> `capabilityProven` arm — *"no producer can move either counter"*; the budget arm shares it. "Wire at
> sink cutover" understates the work: the consumer (bridge) is ready, the producer (usage event) is
> not, and it has no ticket either. **Severity (HIGH), Status (open) and ownership (`unowned`) are
> unchanged** — this amendment sharpens what closing it requires; it closes and reclassifies nothing.

## E3-F038 — The wiring register's census is not closed, and three symbols the guard's own header names have no clause at all

**Status:** open
**Severity:** MEDIUM (the register under-reports its own subject; no wrong `wired` claim results)
**Filed:** 2026-09-06 (W5U1), measured at `e1f723df2`.

**What.** `scripts/lib/gate-clause-wiring.mjs:7-10` enumerates the symbols the register exists to
surface — the 2026-08-25 exit-gate audit's fourteen named examples of "the clause names a
capability, a ticket delivered the mechanism, and no boot root reaches it". Three of the fourteen
have **no entry in `scripts/gate-clause-wiring.json`**, so the register is silent about them on
every green run:

| symbol named in the header | clause in the register | measured production callers |
|---|---|---|
| `jobAuditBridge` (`server/src/services/job-audit-bridge.ts:158`) | **none** | **0** |
| `createResultCommitter` (`packages/worker-daemon/src/patch/result-commit.ts:66`) | **none** | **0** (was 1 before this unit's checker fix — the 1 was a string; see E4-F018) |
| `openEventOutboxStore` (`packages/worker-daemon/src/events/event-outbox-store.ts:197`) | **none** | 2 |

`jobAuditBridge` is the sharpest of the three because it is not an oversight of category: its
**three sibling bridges each have a clause** — `jobApprovalBridge` (E3-5-product-approval),
`jobBudgetCostBridge` (E3-15-budget), `jobOutputBridge` (E3-17-output) — all `unwired`, all at 0
callers, all with the same "wire at sink cutover (Sprint 6)" disposition. The fourth bridge, in the
same shape and the same sprint, is simply absent. The auditor who reported this named only
`jobAuditBridge`; re-measuring the whole header list against the register found the other two.

**Reproduction, one command per row:**

```
grep -c jobAuditBridge scripts/gate-clause-wiring.json          # -> 0
grep -c createResultCommitter scripts/gate-clause-wiring.json   # -> 0
grep -c openEventOutboxStore scripts/gate-clause-wiring.json    # -> 0
```

**Why it matters, stated at its real size.** This is NOT a false `wired` claim — the register makes
no claim at all about these three, which is why nothing is red. The cost is the one the guard's own
header names: `unwired` entries are "REPORTED ON A GREEN RUN, so a dormant capability stays visible
instead of silently passing as complete". A capability with no entry gets neither the check nor the
visibility. `jobAuditBridge` is dormant audit projection for the distributed path; a reader
enumerating "what is dormant" from the green-run `DORMANT, on the record:` line gets a list that is
three short, and one of the three is a bridge whose siblings are all listed.

`openEventOutboxStore` is a different case within the same gap and is called out separately so it is
not mis-scheduled: it has 2 real callers (`dispatch-runtime.ts:118` and its own `deps.openStore`
type at `:92`) and would enrol `wired`, not `unwired` — E4-4's reason already asserts in prose that
"composeDispatchRuntime opens the outbox store", which is exactly the kind of unchecked sentence
W4U1 filed `providerCapabilityClaims` to stop.

**★★★ AND THE `jobAuditBridge` HALF WAS ALREADY NOTICED TWICE, AND FILED ZERO TIMES.** This
is the part that makes it worth a register entry rather than a one-line clause addition. Both
Sprint 6 cutover designs name the gap and both state that a finding HAS BEEN FILED for it:

- `MIG-005-cutover-design.md:183` — "`jobAuditBridge` | **none** | `unwired`, **tracked by NO
  clause**"; `:356` — "The `jobAuditBridge` no-clause gap is filed as a finding"; `:402` lists
  `findings.md` + `scripts/finding-ownership.json` among the files that ticket MODIFIES; `:513`
  — "filed as a finding here; owner = whoever wires the audit bridge".
- `MIG-007-cutover-design.md:268`, `:443`, `:474`, `:586` — the same four statements.

`grep -rn jobAuditBridge docs/` at this tip returns those design lines and **no findings register
entry anywhere** (before this one). MIG-005 has SHIPPED —
`MIG-005-006-007-shadow-result.md` is on disk, so `findCompletedTicketIds` counts MIG-005
complete — with the filing it declared still not done. This is `scripts/lib/finding-ownership.mjs`'s
own headline failure, verbatim: *"the failure is not that nobody noticed. It is that NOTICING HAD NO
CONSEQUENCE"* — and it happened in the interval between the two guards, where a claim of having
filed something is itself unchecked.

**Not claimed.** No clause entry is added here. Enrolling a clause is a declaration about an epic's
gate, and W5U1's charter is explicitly "do not wire any dormant clause"; three new declarations
authored by a filing unit would be the register drifting in the other direction. What is recorded is
that the census is open.
