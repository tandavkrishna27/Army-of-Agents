# JOB-009 Result - Resolve authoritative hybrid placement

**Status:** `complete`
**Disposition:** `pass`
**Date opened (UTC):** `2026-08-10`
**Epic:** `E3-job-control`
**Plan task:** `JOB-009 - Resolve authoritative hybrid placement (L; three bounded internal slices)`
**Implementer:** `Codex /root/job009_impl`
**Reviewer:** `Codex /root/job009_review`
**Start SHA:** 91d074bb9f79abe99aa8efaa6f9a99e0a937650e
**Reviewed revision:** 4c82de037698932ac051aa33977f4c18960d1d5c
**Implementation candidate:** 372f150c9364d86caa63eb15edaa500ba44b7021

The Start SHA is the reviewed JOB-002 completion revision and the exact JOB-009 assignment
boundary. JOB-001/JOB-002, E1's frozen v1 protocol, and the E2 tenant kernel are immutable
inputs. Independent review attempt 3 reproduced the fix-round acceptance on the exact reviewed
revision and certified this ledger `complete` / `pass`.

## Dependency and scope state

- JOB-001 and JOB-002 are `complete` / `pass`; their reviewed interfaces are consumed without
  modification of the frozen E1 wire package.
- The existing `execution_targets` table remains the sole target registry. Placement reads
  registered server authority and the proof-bound JOB-002 worker/profile facts; worker hello
  can only reduce that authority.
- Every job/attempt read and placement write occurs in exactly one
  `runInTenant(appDb, organizationId, fn(repos))` transaction. The operator reader is limited
  to bounded null-Organization target/profile metadata and receives no job identifier,
  requirements, payload, credential, or tenant-policy value.
- This ticket does not issue a lease or fence, reserve/claim capacity, contact a provider or
  worker, execute an effect, mutate rollout policy, create a second registry, or perform E10
  cutover. Dynamic health/capacity are read-only eligibility inputs.

## Implementation attempt 1 - 2026-08-10 - Codex `/root/job009_impl`

### TDD and commit boundaries

- Slice A genuine RED `519967fc3ff22698b6b4695fbfc1ae2f20c5c912`; GREEN
  `d8505cc9d714ce0186cf273b7ec15f8065d1d01a`.
  - RED command:
    `$env:AOA_RUN_WIN_INTEGRATION='1'; pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-placement.integration.test.ts`.
    The committed characterization failed because registered placement authority, immutable
    attempt facts, and the bounded registry readers did not yet exist.
  - Characterized the one registry's tenant/operator boundary and added immutable attempt
    placement columns, registered target profile/provider ceilings, and the proof-bound full
    hello snapshot needed to intersect worker claims with server authority.
  - Drizzle generated `0223_job_placement_authority.sql`; Decision #122 custom migration
    `0224_job_placement_authority_grants.sql` adds only the required existing-role grants.
    Both include C14 guards and are covered by real journal replay plus idempotency tests.
- Slice B genuine RED `6e54a971ddbffbbab9337793a5c5d395d3bcad8e`; GREEN
  `dbd805c665019590e7562dc097fa5e6e3808df6b`.
  - RED command:
    `pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-placement.property.test.ts`.
    The committed matrix failed against the absent deterministic policy.
  - Added a side-effect-free deterministic policy for rollout, immutable requirements and
    fallback, target scope/class/status/generation/locality, membership/credential ownership,
    registered profile/provider ceilings, and proof-bound worker hello intersection.
  - Stable ordering makes decisions byte-equivalent across enumeration order. Twenty fixed
    seeds and all six frozen source kinds exercise required/preferred/forbidden behavior and
    managed-cloud, Organization-dedicated, owner-desktop, and legacy outcomes.
- Slice C genuine RED `d1f362b82cfe237d732bf00b8e82587634783cde`; GREEN
  `a1a65b30bd13d8e774de6b16e8d17ac5a9735e26`.
  - RED command:
    `$env:AOA_RUN_WIN_INTEGRATION='1'; pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-placement.integration.test.ts`.
    The committed persistence/concurrency cases failed against the absent transaction service.
  - Added bounded platform candidate discovery and one tenant transaction that locks and
    validates the job/attempt, evaluates bounded candidates, and persists one atomic immutable
    selected/legacy/queued/failed decision.
  - Identical concurrent writers converge on the stored row; a different immutable digest
    cannot rewrite it. Current generation/status/profile changes fail closed. Forced final
    write failure rolls back. No lease, capacity reservation, contact, or execution row is
    created.
- Aggregate-boundary correction `684f5edf388956c47e7124a58b2a16c08be5e97a`.
  - Restored the legacy heartbeat resolver's narrow projection; rich placement profile reads
    remain in the JOB-009 repository only.
  - Made the embedded-PG placement suite fail closed on Linux and require the explicit
    `AOA_RUN_WIN_INTEGRATION=1` opt-in only on Windows.
  - Expanded the exact serving-role startup allowlist only for the registered target placement
    columns. No broad table/role grant or owner fallback was introduced.

### Authority, compatibility, and failure behavior

- An attempt records one immutable decision with disposition, execution owner, target/class/
  scope/generation, profile and provider-constraint hashes, fallback, bounded reason, rollout
  mode, lease eligibility, input/policy digests, and decision time. The schema's atomic check
  permits no partial placement tuple.
- Flag off records no distributed placement: legacy stays authoritative and lease-ineligible.
  Shadow may record the attributable selection, but it is also lease-ineligible and performs
  no assignment/capacity/provider/audit effect.
- Required targets never widen when offline, draining, revoked, unmapped, over a registered or
  provider ceiling, generation/profile changed, owner-mismatched, or locality-incompatible.
  Queue/fail outcomes follow the immutable fallback and use stable payload-free reason codes.
- Tenant target lookup makes foreign and missing identifiers indistinguishable. Platform
  discovery returns only null-Organization registry metadata under the bounded non-owner
  operator role. Owner-desktop eligibility requires current owner membership and the matching
  personal credential/target binding; local-only data cannot select cloud.
- Frozen E1 source/schema bytes are unchanged. No applied migration was edited. The new schema
  is Drizzle-authored, C14 guarded, and the custom role-grant migration follows Decision #122.

## Operator-directed Windows-local evidence

All database integration commands ran from `C:\e3` with
`AOA_RUN_WIN_INTEGRATION=1`. Linux CI remains the formal DEC-03 authority.

| Command / lane | Result |
|---|---|
| `$env:AOA_RUN_WIN_INTEGRATION='1'; $env:NODE_OPTIONS='--max-old-space-size=8192'; pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-placement.property.test.ts src/__tests__/job-placement.integration.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts` | PASS - 3 files, 28/28 (12 property, 13 embedded-PG integration, 3 exact-grant contract) |
| `pnpm --filter @armyofagents/db exec vitest run src/__tests__/migration-idempotency.test.ts` | PASS - 1 file, 5/5 |
| `$env:AOA_RUN_WIN_INTEGRATION='1'; pnpm --filter @armyofagents/server exec vitest run src/__tests__/distributed-execution-startup.integration.test.ts` | PASS - 1 file, 14/14 |
| `$env:AOA_RUN_WIN_INTEGRATION='1'; pnpm --filter @armyofagents/server exec vitest run src/__tests__/integration-test-hygiene.test.ts src/__tests__/e2-serving-role-correction.integration.test.ts` | PASS - 2 files, 22/22; exact correction-causing regressions |
| `$env:AOA_RUN_WIN_INTEGRATION='1'; pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-submission.integration.test.ts src/__tests__/worker-enrollment.integration.test.ts src/__tests__/worker-enrollment-rls.contract.test.ts src/__tests__/execution-target-resolver.test.ts src/__tests__/execution-target-resolver-scope.test.ts src/__tests__/tenant-adversarial.property.integration.test.ts src/__tests__/tenant-rls-enforcement.integration.test.ts src/__tests__/tenant-context-middleware.test.ts src/__tests__/tenant-app-db-startup.test.ts` | PASS - 9 files; all tests green |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870ce7509d8baa75409e0ab19da375c88a` | PASS |
| `pnpm check:worker-protocol-boundary` | PASS |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm --filter @armyofagents/db --filter @armyofagents/shared --filter @armyofagents/server typecheck` and `pnpm --filter @armyofagents/db --filter @armyofagents/shared --filter @armyofagents/server build` | PASS |
| `pnpm -r typecheck` | PASS - 24/25 workspace projects |
| `pnpm build` | PASS - 24/25 workspace projects |
| `$env:AOA_RUN_WIN_INTEGRATION='1'; pnpm test:run` at candidate `684f5edf388956c47e7124a58b2a16c08be5e97a` | **FAIL (honestly labeled Windows-local aggregate)** - exit 1 after 233.4s; 2 failed suites and 9 failed tests. Visible failures are the known frozen-E1 `cross-version.test.ts` Windows collection SyntaxError, D18 embedded-PG setup/afterAll timeout cascade, and OpenCode full-load timeouts. No JOB-009 placement, E2 serving-role, or integration-hygiene test failed. |

The aggregate failure is not represented as a waiver or a full-suite pass. The focused
placement, exact-grant, migration/C14, tenant/role, frozen-boundary, typecheck, and build lanes
above are the implementer's evidence. A distinct reviewer must reproduce the acceptance on
the reviewed revision and make the ticket disposition.

## Independent review

### Review attempt 1 - 2026-08-10 - Codex `/root/job009_review`

- **Reviewed revision:** `aa2b9a81355db1dec125c35bb53be21d4683360c`
- **Assignment base:** `91d074bb9f79abe99aa8efaa6f9a99e0a937650e`
- **Code candidate ancestor:** `684f5edf388956c47e7124a58b2a16c08be5e97a`
- **Disposition:** `needs_changes`
- **Specification verdict:** fail.
- **H-01 verdict:** pass for the implemented tenant/operator query boundaries.
- **H-03 verdict:** fail because the database accepts a lease-eligible shadow decision.
- **H-04 / secret-containment verdict:** pass for reviewed placement projections and evidence.
- **Migration/compatibility verdict:** fail.

The complete Start-to-review diff and all named dependencies were independently inspected.
The candidate is an ancestor of the reviewed revision. No frozen E1 file changed, no second
target table or lease/capacity/provider/worker effect was added, and the tracked worktree was
clean before review edits. The committed focused matrix is meaningful: tenant/platform rows
remain bounded and locked through decision persistence; false hello/profile/provider/limit/
locality/status/generation/member failures close; identical writers converge; rollback is
atomic; all six sources and 20 fixed order seeds are deterministic; and platform discovery
cannot read jobs.

Six Important blockers prevent certification:

- **Important I-01 — JOB-001/JOB-009 contract mismatch.** JOB-001 persists
  `{workloadType, requiredCapabilities}` plus `{policyId, policyVersion, requestedTarget}`;
  JOB-009 requires frozen `JobCapabilityRequirementsV1` plus exact
  `{providerDemand, credentialOwnerPrincipalId}`. A temporary probe using the exact JOB-001
  objects returned `[false,false]`, so real submitted jobs fail placement while the green
  integration suite uses synthetic direct inserts.
- **Important I-02 — no registered-profile producer.** The new registry profile/hash/provider
  columns have no production writer anywhere in the reviewed tree. JOB-002 enrollment stores
  the worker hello but never ratifies these target facts; therefore every real target remains
  null/unmapped and ineligible.
- **Important I-03 — Decision #117 credential/target binding is bypassed.** JOB-009 never
  consumes the existing pinned-target / personal-credential `executionTargetSlug` resolver.
  Owner ID alone cannot bind a personal credential to one target, and required/preferred/
  forbidden target identity is unrepresentable, creating a second route-by-credential policy.
- **Important I-04 — replay digests omit placement authority.** Stored input/policy digests do
  not cover requirements, fallback, credential/target binding, provider demand, or rollout.
  A temporary embedded-PG probe changed provider demand after placement and received the old
  selected decision instead of `placement_already_decided`.
- **Important I-05 — rollout/default-off authority is caller supplied.** The public placement
  transaction accepts arbitrary enabled/mode/reason fields and does not consume the established
  deployment → Organization → workload resolver. The reason is also unbounded and can be
  persisted verbatim on flag-off.
- **Important I-06 — shadow lease eligibility is not constrained.** A temporary real-PG probe
  successfully wrote a complete `selected + shadow + placement_lease_eligible=true` tuple. The
  same schema check permits true for legacy/queued/failed, contrary to shadow no-lease and H-03
  defense-in-depth requirements.

Fresh Windows-local evidence: committed placement/property/integration/grant **28/28**;
migration-idempotency **5/5**; tenant/RLS/serving-role/hygiene **52/52**; the actual startup
file `distributed-execution-db-startup.integration.test.ts` **14/14**; JOB-001/JOB-002 bundle
**65/65** plus worker-session auth **2/2**; frozen E1 checker/boundary/install pass; affected
and recursive typecheck/build pass. The implementation ledger's
`distributed-execution-startup.integration.test.ts` path does not exist and must be corrected.
Exact `AOA_RUN_WIN_INTEGRATION=1 pnpm test:run` exited 1 after 237.3s with seven visible
aggregate failures (adapter/MCP timeouts and a runtime-service assertion among them); no
committed JOB-009 focused test failed. This is not a waiver or full-suite pass. Linux CI remains
DEC-03 formal authority.

All three adversarial probes were temporary and removed. The reviewer changed no production
code. Detailed ignored evidence is in
`.superpowers/sdd/implementation-plan/job-009-review.md`. A fresh implementer fix round must
commit genuine REDs for all six findings and return a new exact ancestor revision for re-review.

## Fix round 1 - 2026-08-10 - Codex `/root/job009_impl`

### TDD boundary

- Review evidence revision:
  `b791a7d4957fee488c26bc2649621d2fbaba5ee0`.
- Genuine consolidated RED:
  `11849e0f59b184e8dbc8a3d6041cc00f8173bba1`.
- Minimal GREEN / new implementation candidate:
  `03005fcfacf7b924aae76d9c81666a5487039ce2`.
- Each Important finding had a failing committed acceptance before production edits:
  exact JOB-001 submitted facts could not enter placement; no production profile writer
  existed; Decision #117 credential/target binding was bypassed; a one-field authority
  mutation replayed an old decision; caller-authored rollout could enable placement; and
  PostgreSQL accepted invalid lease-eligibility tuples.

### Resolution of review findings

- **I-01:** JOB-009 now server-normalizes the exact JOB-001 persisted
  `{workloadType, requiredCapabilities}` requirements and
  `{policyId, policyVersion, requestedTarget}` request. All six HTTP/service submission
  sources reach placement without caller-authored provider or credential facts; malformed
  and tampered stored facts fail closed.
- **I-02:** one bounded tenant-admin/platform-admin writer ratifies registered profile and
  provider constraints on the existing `execution_targets` registry, verifies frozen E1
  shape/digest plus scope/owner/generation mapping, and stores canonical hashes. Tenant writes
  use `runInTenant`; platform writes use the existing operator administration authority.
  Worker hello cannot write or widen registry authority, revoked/disabled/unmapped rows close,
  and exact column grants are asserted at startup. Real tenant and platform
  registration/update -> JOB-002 enrollment/heartbeat -> JOB-009 placement paths pass.
- **I-03:** the transaction consumes `chooseExecutionTargetRow`, the existing Decision #117
  credential/pin/slug resolver. The normalized immutable identity policy represents required,
  preferred, and forbidden targets. Two same-owner targets, pin mismatch, missing/foreign
  binding, personal-to-shared denial, requested identity, and explicit fallback all pass.
- **I-04:** one canonical digest now binds the exact submitted hashes/requirements/request,
  normalized requirements/provider demand/fallback, credential identity/kind/slug/pin,
  resolved target identity, rollout mode/reason, and selected generation/profile/provider
  hashes. Byte-equivalent retries converge; the committed 20-field mutation matrix rejects
  every changed authority fact with `placement_already_decided`. No old decision is rewritten.
- **I-05:** public raw rollout input is ignored. The trusted placement service resolves the
  deployment -> Organization -> workload gate through
  `resolveDistributedExecutionRollout`, captures only closed reason codes, and binds the result
  into the canonical digest. Deployment/Organization/workload-off never opens the operator
  reader and persists only tenant-local legacy/no-active state; a forged caller value cannot
  enable active or shadow placement.
- **I-06:** Drizzle schema plus generated migration `0225` enforce
  `placement_lease_eligible = (placement_disposition = 'selected' AND placement_mode = 'active')`.
  Only C14 replay guards were appended to generated schema DDL. Decision #122 custom migration
  `0226` contains only exact profile-writer column grants. Direct real-PostgreSQL and service
  negatives cover every invalid disposition/mode/eligibility combination.

The end-to-end profile test exposed one real JOB-002 integration gap: proof-bound heartbeat
updated target liveness but not the exact worker row, while JOB-009 correctly uses the older of
both timestamps. The bounded fix updates the proof-bound target and worker in the same owning
transaction after rechecking target, worker, generation, key, thumbprint, and profile facts.
It does not change trust/capabilities, contact a worker/provider, or widen revocation authority.

### Fix-round Windows-local evidence on candidate
`03005fcfacf7b924aae76d9c81666a5487039ce2`

All embedded-PostgreSQL commands ran from `C:\e3` with
`AOA_RUN_WIN_INTEGRATION=1`. Linux CI remains the formal DEC-03 authority.

| Command / lane | Result |
|---|---|
| JOB-009 property, embedded-PG placement, and exact-grant contract | PASS - 3 files, 35/35 (14 property, 18 integration, 3 grants) |
| Combined JOB-001/JOB-002/JOB-009 focused regression during GREEN | PASS - 5 files, 84/84 |
| Migration idempotency / C14 | PASS - 1 file, 5/5 |
| Correct startup path `distributed-execution-db-startup.integration.test.ts` | PASS - 1 file, 14/14 |
| JOB-001/JOB-002, resolver, worker-session, tenant/RLS regression bundle | PASS - 10 files, 96/96 |
| Integration hygiene and serving-role correction | PASS - 2 files, 22/22 |
| Frozen E1 checker at `b7a842870ce7509d8baa75409e0ab19da375c88a`, protocol boundary, and frozen install | PASS |
| Affected db/shared/server typecheck and build | PASS |
| `pnpm -r typecheck` and root `pnpm build` | PASS - 24/25 workspace projects |
| Exact `$env:AOA_RUN_WIN_INTEGRATION='1'; pnpm test:run` after root build | **FAIL (honestly labeled Windows-local aggregate)** - exit 1 after 106.1s; no aggregate was emitted because Vitest terminated with unhandled `ERR_IPC_CHANNEL_CLOSED`. The visible precursor was `ask-founder-dogfood.integration.test.ts` embedded-Postgres setup failure; no JOB-009 focused failure was emitted. |

The full-lane failure is neither a waiver nor a pass. The candidate adds no lease/fence,
capacity reservation/claim, provider/worker contact, execution effect, cutover, second registry,
or frozen E1 change. Status and disposition remain `review_pending`; only a fresh distinct
reviewer may append review attempt 2 and certify the ticket.

## Independent review attempt 2 - 2026-08-10 - Codex `/root/job009_review`

- **Reviewed revision:** `bc93203be9c5b93f0bc52eb08de2b20aede23205`
- **Scoped fix boundary:**
  `aa2b9a81355db1dec125c35bb53be21d4683360c..bc93203be9c5b93f0bc52eb08de2b20aede23205`
- **Canonical RED:** `11849e0f59b184e8dbc8a3d6041cc00f8173bba1`
- **Canonical GREEN:** `03005fcfacf7b924aae76d9c81666a5487039ce2`
- **Disposition:** `needs_changes`
- **Specification verdict:** fail.
- **H-01 verdict:** pass for tenant/platform query, RLS, and non-disclosure boundaries; the
  owner-authority race below independently fails canonical placement acceptance.
- **H-03 verdict:** pass for one persisted decision and the selected+active-only database
  eligibility invariant within JOB-009; JOB-003 lease certification remains separate.
- **H-04 verdict:** pass for reviewed projections, logs, and evidence.
- **Migration/compatibility verdict:** pass for 0225/0226, C14 replay, role grants, and frozen E1.
- **Determinism/owner-authority verdict:** fail.

Review attempt 2 confirms that fix round 1 materially closes I-01 through I-06. Exact JOB-001
facts reach the normalizer; tenant/platform administrators can ratify existing-registry
profiles without worker authority; Decision #117 credential/slug/pin routing is consumed;
canonical authority mutations reject replay; rollout is resolved at the trusted service; and
PostgreSQL rejects every invalid disposition/mode/lease-eligibility tuple. The proof-bound
heartbeat changes update exact target/worker liveness atomically and the committed revocation
race matrix passes.

Two new Important blockers prevent certification:

- **Important I-07 - production pre-resolution is candidate-order dependent.**
  `chooseExecutionTargetRow` uses `.find()` over unordered tenant plus platform snapshots
  before `decideJobPlacement` performs its stable sort. A temporary exact-resolver probe with
  two eligible `pooled_gvisor` targets selected A for `[A,B]` and B for `[B,A]`. The committed
  20-seed property test shuffles only the downstream pure policy, so it does not prove the real
  transaction's deterministic target or digest. Define explicit target precedence plus a stable
  total-order tie-breaker and add a multi-match production transaction test.
- **Important I-08 - owner membership removal can commit before an owner placement.** Fix
  round 1 removed the membership `.for("share")` lock while retaining target/worker locks. A
  temporary embedded-PG probe paused the real transaction after tenant snapshot, committed an
  owner membership suspension in another transaction, then resumed placement; the attempt still
  persisted `selected` on that owner target with `leaseEligible=true`. Keep membership authority
  stable through persistence (or use an equivalent atomic authority version/predicate) and add
  a real concurrent suspension/deletion negative.

Fresh Windows-local evidence on the reviewed revision: placement/property/grants **35/35**;
exact JOB-001/JOB-002 production paths **50/50**; remaining resolver/session/tenant/RLS bundle
**46/46** (combined **96/96**); startup/serving-role/hygiene **36/36**; migration/C14 **5/5**;
frozen E1 checker/boundary/install pass; affected and recursive typecheck/build pass. Exact
`AOA_RUN_WIN_INTEGRATION=1 pnpm test:run` exited 1 after 283.48 seconds: 4 failed files / 9
failed tests, with 2,046 files and 19,119 tests passing. Visible failures were the known Windows
frozen-consumer SyntaxError, D18 embedded-PG setup/afterAll timeout cascade, and three OpenCode
adapter timeouts; no committed JOB-009 focused test failed. This is not a waiver or full-suite
pass; Linux CI remains DEC-03 formal authority.

Both adversarial probes were temporary and removed. The reviewer modified no production code.
Detailed ignored evidence is in `.superpowers/sdd/implementation-plan/job-009-review.md`. A
fresh implementer fix round must commit genuine RED/GREEN evidence for I-07 and I-08 and return
a new exact revision for independent review.

## Fix round 2 - 2026-08-10 - Codex `/root/job009_impl`

### TDD boundary

- Review-attempt-2 evidence revision:
  `c2270ced81949c9da26f2a41909b159e0042cc74`.
- Genuine consolidated RED:
  `d3b4f50cbcf3ce9348d2482261c098b4864f8141`.
- Minimal GREEN / new implementation candidate:
  `372f150c9364d86caa63eb15edaa500ba44b7021`.
- I-07 RED exercised all candidate permutations and the real tenant+platform placement path;
  the production path selected different targets from equivalent candidate sets because the
  Decision #117 pre-resolver received database enumeration order.
- I-08 RED used deterministic PostgreSQL barriers. Suspension/deletion committed after the
  tenant snapshot but before the final attempt write, yet the old code persisted an active,
  lease-eligible owner placement.

### Resolution of review findings

- **I-07:** the combined tenant/platform registry snapshot is now copied and ordered before
  invoking the unchanged Decision #117 `chooseExecutionTargetRow`. The one explicit comparator
  uses registered profile scope priority, then registered target class priority, then slug and
  target ID tie-breaks. Explicit pin and credential-bound target semantics remain owned by the
  existing resolver. All permutations across pooled/shared, Organization-dedicated, owner,
  equal-priority/equal-slug, and tenant+platform composition converge on byte-identical trusted
  resolution and persisted placement.
- **I-08:** for an owner-desktop selection, the same final conditional `UPDATE job_attempts`
  now contains an `EXISTS` predicate for the exact Company, Organization, owner principal, and
  active membership. Missing/foreign/deleted/suspended authority makes the selected update
  affect zero rows. The transaction then persists the same payload-free, lease-ineligible
  unavailable disposition used when authority is initially absent; it never exposes whether a
  membership existed. If placement's final statement wins first, later removal may commit and
  the immutable old attempt remains historical for JOB-003's mandatory authority recheck/fence.
  No membership UPDATE grant, owner fallback, lease/fence, or authority-version rewrite was
  added.

### Fix-round-2 Windows-local evidence on candidate
`372f150c9364d86caa63eb15edaa500ba44b7021`

All embedded-PostgreSQL commands ran from `C:\e3` with
`AOA_RUN_WIN_INTEGRATION=1`. Linux CI remains the formal DEC-03 authority.

| Command / lane | Result |
|---|---|
| JOB-009 property, embedded-PG placement, and exact-grant contract | PASS - 3 files, 39/39 (15 property, 21 integration, 3 grants) |
| JOB-001/JOB-002, resolver, worker-session, tenant/RLS regression bundle | PASS - 10 files, 96/96 |
| Migration idempotency / C14 | PASS - 1 file, 5/5 |
| Correct startup path `distributed-execution-db-startup.integration.test.ts` | PASS - 1 file, 14/14 |
| Integration hygiene and serving-role correction | PASS - 2 files, 22/22 |
| Frozen E1 checker at `b7a842870ce7509d8baa75409e0ab19da375c88a`, protocol boundary, and frozen install | PASS |
| Affected db/shared/server typecheck and build | PASS |
| `pnpm -r typecheck` and root `pnpm build` | PASS - 24/25 workspace projects |
| Exact `$env:AOA_RUN_WIN_INTEGRATION='1'; $env:NODE_OPTIONS='--max-old-space-size=8192'; pnpm test:run` after root build | **FAIL (honestly labeled Windows-local aggregate)** - native exit 1 after 271.8s. The captured output reached failure block 17/17 but the tool elided the aggregate summary. Visible non-JOB-009 failures include the D18 embedded-PostgreSQL setup cascade and `runtime-service-control.test.ts` stop-confirmation failure; no JOB-009 focused failure was emitted. No passed-file/test totals are inferred from truncated output. |
| Supplemental default-environment JSON reporter (not the integration-enabled gate) | **FAIL** - 2,138 files: 2,136 passed / 2 failed; 19,618 tests: 18,840 passed / 1 failed / 777 pending. Failures were the frozen cross-version Windows collection SyntaxError and OpenCode FU-23. |

The full-lane failure is neither a waiver nor a pass. The new candidate adds no schema,
migration, grant, frozen-E1, lease/fence, capacity, contact, execution, second-registry, or
cutover change. Status and disposition return only to `review_pending`; a fresh distinct
reviewer must inspect the Start-to-candidate diff, rerun focused acceptance at the reviewed
revision, append review attempt 3, and alone may certify JOB-009.

## Independent review attempt 3 - 2026-08-10 - Codex `/root/job009_review`

- **Reviewed revision:** `4c82de037698932ac051aa33977f4c18960d1d5c`
- **Scoped fix boundary:**
  `bc93203be9c5b93f0bc52eb08de2b20aede23205..4c82de037698932ac051aa33977f4c18960d1d5c`
- **Canonical RED:** `d3b4f50cbcf3ce9348d2482261c098b4864f8141`
- **Canonical GREEN:** `372f150c9364d86caa63eb15edaa500ba44b7021`
- **Disposition:** `pass`
- **Specification verdict:** pass.
- **H-01 verdict:** pass - exact tenant transaction, platform-operator projection, RLS, and
  foreign/missing non-disclosure boundaries reproduced.
- **H-03 verdict:** pass for JOB-009 - exactly one immutable decision, no lease creation or
  capacity claim, and lease eligibility only for `selected + active`; JOB-003 remains the lease
  authority owner.
- **H-04 verdict:** pass - bounded reason codes and reviewed logs expose no job payload,
  credential, membership-existence, or platform-to-tenant detail.
- **Migration/compatibility verdict:** pass - no fix-round schema/grant/E1 change; 0225/0226,
  C14 replay, startup role audit, default-off behavior, and frozen v1 integrity remain green.

The reviewer independently reproduced I-07 across all 720 permutations of the six mapped
candidate classes, platform plus tenant composition, equal-slug ID ties, explicit pins, and
credential-bound slug precedence. The resolver receives an isolated sorted copy; a temporary
probe additionally proved caller enumeration is not mutated. Invalid registered authority
continues to sort after mapped authority and then fail closed in the unchanged normalizer.

I-08 was reproduced with real PostgreSQL barriers. Remove-first suspension and deletion both
produce the same payload-free, null-target, lease-ineligible unavailable decision. Placement-
first suspension and a temporary placement-first deletion probe both preserve the already-won
immutable historical decision for JOB-003's mandatory recheck. Foreign and absent membership
are indistinguishable, a non-owner target is unaffected, replay converges on the stored digest,
and the selected-owner write's exact Company/Organization/principal/active-membership predicate
cannot leave a partial target tuple or existence oracle. Both temporary probes were removed;
the reviewer changed no production code.

Fresh Windows-local evidence on the exact reviewed revision, from `C:\e3` with
`AOA_RUN_WIN_INTEGRATION=1` where applicable (Linux CI remains DEC-03 formal authority):

| Command / lane | Result |
|---|---|
| JOB-009 property, embedded-PG placement, and exact-grant contract | PASS - 3 files, 39/39 |
| Temporary caller-copy plus placement-first deletion adversarial probes | PASS - 3 selected tests; probes removed |
| Exact JOB-001 submission and JOB-002 enrollment/profile/heartbeat path | PASS - 2 files, 50/50 |
| Resolver, worker-session, tenant-context/RLS/adversarial bundle | PASS - 8 files, 46/46 |
| Startup, serving-role correction, and integration hygiene | PASS - 3 files, 36/36 (startup 14/14) |
| Migration idempotency / C14 | PASS - 1 file, 5/5 |
| Frozen E1 checker at `b7a842870ce7509d8baa75409e0ab19da375c88a`, protocol boundary, and frozen install | PASS |
| `pnpm -r typecheck` and root `pnpm build` | PASS - build covers 24/25 workspace projects |
| Exact integration-enabled Windows aggregate | **FAIL, honestly labeled** - 2,138 files: 2,046 passed / 4 failed / 88 skipped; 19,618 tests: 19,130 passed / 2 failed / 486 skipped. JOB-009 passed 21/21. Failures were the known frozen-consumer Windows collection `SyntaxError`, ask-founder embedded-PG cleanup `EBUSY`, one startup timeout under aggregate load (the isolated startup lane passed 14/14), and one UI discussion interaction timeout. |

No Critical, Important, specification, H-01, H-03, or H-04 blocker remains. The aggregate
failure is not called a pass or a waiver; none of its four failures is in the reviewed JOB-009
scope, and every affected security/transaction lane passed independently. The reviewed revision
is a 40-hex ancestor of this reviewer evidence commit. JOB-009 is `complete` / `pass`.
