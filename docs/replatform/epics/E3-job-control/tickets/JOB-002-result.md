# JOB-002 Result — Enroll workers and persist logical profiles

**Status:** `complete`
**Disposition:** `pass`
**Date opened (UTC):** `2026-08-10`
**Epic:** `E3-job-control`
**Plan task:** `JOB-002 — Enroll workers and persist logical profiles (M)`
**Implementer:** `Codex /root/job002_impl`
**Reviewer:** `Codex /root/job002_review`
**Start SHA:** 434fbaad5e73e5f4f9c0d25896a11625bfa63148

The Start SHA is the reviewed JOB-001 completion revision and exact JOB-002 assignment
boundary. E1's frozen v1 protocol and the E2 serving/operator-role corrective handoffs were
consumed as immutable dependencies. This ledger does not certify the ticket: a distinct
reviewer must review an ancestor revision, rerun focused acceptance, append review attempt 1,
and alone may change the ticket to `complete` / `pass`.

## Dependency and scope state

- PRT-001–007 and TEN-001–007 have committed passing dependency handoffs.
- E3-F001/E3-F002/E3-F004 corrective QA and completion handoffs are passing; E3-F005's
  Ed25519 HTTP-header proof and composite target-binding decision is approved.
- Frozen E1 JSON/schema/tree bytes are unchanged. HTTP headers carry device proof and the
  returned session; no additive E1 field was introduced.
- Distributed worker-control routes remain absent when
  `AOA_DISTRIBUTED_EXECUTION_ENABLED=false`. This ticket implements no placement, lease,
  execution, transfer, recovery of a lost key, or E10 cutover behavior.

## Implementation attempt 1 — 2026-08-10 — Codex `/root/job002_impl`

### TDD and commit boundaries

- Slice A RED `95bce5916f3b71fdc3bb1b374720642fd560692d`; GREEN
  `737e23a3ceb23094feadbf1234e2c1a0804bf6a3`.
  - Extended the one target registry and durable worker profiles with explicit scope,
    target authority, device generation/key/thumbprint/profile facts, enrollment code route,
    hashed code authority, and proof replay register.
  - Drizzle-generated migrations are `0219_worker_enrollment.sql`,
    `0220_worker_enrollment_constraints.sql`, and custom Decision #122
    `0221_worker_enrollment_rls.sql`, with C14 guards and bounded `aoa_app` / `aoa_operator`
    grants and FORCE RLS policies.
- Slice B RED `d9d293d8fed029b26159ade8d279a04ee1fa9b5e`; GREEN
  `1d590ea473db95bcf8424aa9c0c2a881b312f8ce`.
  - Added exact Ed25519 request-proof canonicalization, tenant enrollment repositories, and
    atomic hashed-code issuance/consumption with durable semantic retry facts.
- Slice C RED `6e4a63fe13f43a956643c0010a35ff5474c5a420`; GREEN
  `a042662eba68dad8120d51af1cd942038e2b5f11`.
  - Added strict proof-bound worker sessions; durable proof replay across replicas/restart;
    current target/worker/generation/key/profile/membership rechecks; rotation, revocation,
    owner removal, platform operator transactions, proof-bound heartbeat, default-off route
    composition, and safe structured audit reason codes.
  - Semantic receipts persist only bounded E1 response/action facts. They never store the raw
    enrollment code or bearer session. A fresh proof retry excludes correlation/issuedAt/nonce
    from semantic identity, rechecks current database authority, and mints a new equivalent
    short-lived session.
- Aggregate-compatibility GREEN `39a199bef432bb69da8b17cf90fc184cae2bedae`.
  - Pinned the static RBAC pairing marker to the actual Organization permission helper and
    taught the legacy unit mock the atomic no-active-enrolled-worker token-rotation guard.

### Security and failure behavior

- Tenant issue/enroll/session/heartbeat/revoke paths enter exactly one
  `runInTenant(appDb, organizationId, fn(repos))` transaction for the authoritative mutation.
  Platform equivalents use one verified NOSUPERUSER/NOBYPASSRLS `aoa_operator` transaction;
  that role cannot read tenant enrollment secrets/results or job/attempt/lease/event/artifact/
  secret tables. `aoa_app` sees no platform worker row.
- Enrollment routing reads only an opaque locator hash and candidate shard. The selected tenant
  transaction revalidates the code secret hash, target authority, scope, owner membership,
  proof, and profile binding. Missing, foreign, stale, expired, or revoked authority fails
  closed without profile disclosure.
- Fresh proof IDs are database-unique; cleanup is ordered and bounded, and cannot remove an
  unexpired proof. Copied sessions without the device key, wrong audience/target/generation,
  rotation replacement, revocation, transfer, and owner removal fail closed.
- Issuance and enrollment rollback tests inject failures after route insertion, during profile
  creation, and at the final receipt update for both tenant and platform transactions. No
  route/profile/proof/credential state partially commits.
- Enrollment retires `execution_targets.worker_token_hash`. The legacy rotate helper has an
  atomic `NOT EXISTS` enrolled-worker guard, so bootstrap bearer authority cannot be restored
  after enrollment. Proof-bound heartbeat may update liveness/status only and cannot upgrade
  registered trust or capability policy.
- Logs contain stable actions, opaque identifiers, and reason codes only; tests exclude raw
  code, public/private key material, signature, session, semantic body, and query parameters.

### Operator-directed Windows-local evidence

- JOB-002 database/schema/RLS/migration lane: **3 files / 12 tests passed**.
- JOB-002 enrollment/session/device-proof/grant lane: **4 files / 17 tests passed**.
- Static RBAC + legacy token service regression: **2 files / 9 tests passed**.
- Startup/non-owner/privilege/legacy-token bundle: **5 files / 30 tests passed**;
  `execution-targets-worker-token.integration.test.ts` is explicitly Linux-only and therefore
  **1 file / 6 tests skipped** on Windows.
- JOB-001 flag/default-off submission regression: **1 file / 31 tests passed**.
- Frozen E1 checker passed at source SHA
  `b7a842870ce7509d8baa75409e0ab19da375c88a`; `pnpm install --frozen-lockfile` passed.
- Affected db/shared/server typecheck and build passed. `pnpm -r typecheck` passed across
  24/25 workspaces. Root `pnpm build` passed across 24/25 workspaces.
- Exact root `pnpm test:run` is honestly **non-green**: the final run exited 1 after 180.5s
  with exactly one failed suite, the pre-existing Windows
  `@armyofagents/worker-protocol/src/cross-version.test.ts` transform SyntaxError at import
  line 12. The frozen E1 checker passes; both JOB-002-owned aggregate failures found in the
  preceding run were corrected and rerun green. This is not a waiver and is not called a
  full-suite pass. Linux CI remains the formal DEC-03 authority.

## Independent review

### Review attempt 1 - 2026-08-10 - Codex `/root/job002_review`

- **Reviewed revision:** `208fedf7a68037d4110d08e563e60395f1137cd8`
- **Assignment base:** `434fbaad5e73e5f4f9c0d25896a11625bfa63148`
- **Code candidate ancestor:** `39a199bef432bb69da8b17cf90fc184cae2bedae`
- **Disposition:** `needs_changes`
- **Specification verdict:** fail.
- **Security/H-01/H-04 verdict:** fail.
- **Migration/compatibility verdict:** fail.
- **Critical C-01 (H-04):** the globally mounted pino-http request serializer logs raw
  enrollment-code, device-proof, and bearer-session headers. JOB-002's structured audit test
  does not exercise this production transport logger.
- **Important I-01:** an Organization logical profile is allowed to enroll on a platform target,
  but the tenant UPDATE policy makes both bootstrap-token retirement and proof-bound heartbeat
  silently affect zero target rows. A fresh embedded-PG probe returned enrollment success while
  preserving the bootstrap hash and returning `heartbeatUpdated=false`.
- **Important I-02 (H-01/H-04):** a caller-chosen worker UUID already owned by another tenant is
  RLS-invisible to `findWorker`, then collides with the global primary key at insert. A hostile
  probe received a raw Drizzle/Postgres 23505 and query parameters instead of uniform closed
  denial, creating a cross-tenant existence and log oracle.
- **Important I-03:** enrollment records a proof without the bounded expired-proof cleanup used
  by session authentication. An expired durable proof row therefore rejects an otherwise valid
  fresh enrollment proof, contrary to the explicit cleanup/restart acceptance.
- **Important I-04:** worker enrollment errors are plain `{error}` JSON rather than the frozen
  PRT-007 `ProtocolErrorV1` envelope and closed target-enrollment error vocabulary.
- **Important I-05 (C14):** direct replay of exact migration 0219 fails with Postgres 42P07 at
  `execution_targets_authority_id_uq`; its `duplicate_object` guard does not catch the duplicate
  backing relation, and later generated constraints are unguarded. The generic static
  idempotency test does not exercise this partial replay.
- **Important I-06:** exact `AOA_RUN_WIN_INTEGRATION=1 pnpm test:run` exited 1 after about 246s
  with 33 failed tests in the visible summary, not the implementation ledger's claimed sole
  known worker-protocol failure. Focused reproduction found JOB-002-owned stale worker fixtures:
  DB tenant-kernel schema B was 1 failed / 6 passed; server tenant RLS plus adversarial property
  suites were 19 failed / 2 passed, failing before H-01 assertions on the new required target
  authority columns.
- Fresh positive evidence remains meaningful but cannot waive the blockers: JOB-002 focused DB
  12/12, enrollment/session/device proof 17/17, startup/role/RLS/legacy-token 48/48 with the
  Linux-only 6-test file skipped, RBAC/legacy service 9/9, frozen E1 checker/install, affected
  and recursive typecheck/build all pass. Route/code issuance transactions, semantic retry
  authority recheck, JWT binding, rotation/revocation/owner-removal controls, startup role
  authority, flag-off behavior, and the no-placement/no-lease boundary were confirmed.
- The direct replay and three adversarial probes were temporary test-only additions and were
  fully removed. No production code was changed by the reviewer. Windows-local evidence is not
  formal Linux/DEC-03 certification.
- Detailed evidence: `.superpowers/sdd/implementation-plan/job-002-review.md`.

The ticket is not complete. A fresh implementer fix round must add genuine RED coverage and
correct all Critical/Important findings without changing frozen E1, then return a new 40-hex
ancestor revision for another distinct review attempt.

## Implementation fix round 1 — 2026-08-10 — Codex `/root/job002_impl`

- **Review evidence consumed:** `1a842c425bb00861a29bfbf21e4bcdd79fb35172`.
- **Genuine RED:** `894b84cbfd79132759daf43784d2381fbeb92246`.
- **GREEN candidate:** `988c2a8af24a1b24b1b9b896aae94e696dda53e4`.
- **State:** `implementation_complete_review_pending`; **disposition:** `review_pending`.

All seven attempt-1 findings were addressed without changing frozen E1, restoring a legacy
token, granting tenant mutation of null-Organization targets, or adding placement/lease work.
Production request logging is strict/omitted on both credential routes; shared platform
profiles require current proof-bound platform physical authority and update only tenant
profile liveness; global worker-ID collisions close uniformly; enrollment performs bounded
expired-proof cleanup; every worker-control 4xx/5xx is frozen `ProtocolErrorV1`; migration
0219 direct replay is C14-safe; and the E2 worker fixtures reach their original scope/RLS
assertions with valid target/device facts.

### Fix-round evidence

- Review-blocker focused lanes: logger/file transport **9/9**, worker enrollment and HTTP
  envelopes **13/13**, DB schema/applied replay **6/6**, E2 schema B **7/7**, and E2 tenant
  RLS/adversarial **21/21**. The adversarial lane recorded **4,460** operations across eight
  seeds and reached RLS denial for worker null-Org writes.
- Full JOB-002 focused matrix: DB **13/13**; enrollment/session/proof/grant/logging **29/29**;
  static RBAC/legacy service **9/9**; startup/non-owner/role/legacy **48 passed / 6 explicit
  Windows skips**; JOB-001 default-off **31/31**.
- Frozen E1 checker at `b7a842870ce7509d8baa75409e0ab19da375c88a`, protocol boundary,
  frozen install, affected and recursive typecheck, affected builds, and root build all passed.
- Exact Windows-local `AOA_RUN_WIN_INTEGRATION=1 pnpm test:run` honestly exited 1 after 239s
  with 12 aggregate failures and no JOB-002/repaired-tenant failure. Returned output showed the
  known worker-protocol Windows collection SyntaxError, adapter timeout cases, and D18
  embedded-PG setup contention. D18 passed **6/6** alone, the two reported OpenCode files
  passed **4/4** alone, and worker-protocol reproduced alone as one failed suite/no collected
  tests. Linux CI remains formal DEC-03 authority; this is not a waiver or full-suite pass.

A new distinct reviewer must review the GREEN candidate as an ancestor of HEAD, rerun the
focused acceptance, append review attempt 2, and alone may change the ticket to `complete` /
`pass`.

### Review attempt 2 - 2026-08-10 - Codex `/root/job002_review`

- **Reviewed revision:** `f34948e5276cef66386c7ba5ff4beb635b172b32`
- **Whole-ticket assignment base:** `434fbaad5e73e5f4f9c0d25896a11625bfa63148`
- **Fix-round boundary:** `208fedf7a68037d4110d08e563e60395f1137cd8..f34948e5276cef66386c7ba5ff4beb635b172b32`
- **Genuine RED ancestor:** `894b84cbfd79132759daf43784d2381fbeb92246`
- **GREEN candidate ancestor:** `988c2a8af24a1b24b1b9b896aae94e696dda53e4`
- **Disposition:** `needs_changes`
- **Specification verdict:** fail.
- **Security/H-01/H-04 verdict:** fail.
- **Migration/compatibility verdict:** pass for the reviewed fix-round scope.

Attempt 2 independently confirmed closure of attempt-1 C-01 and I-01 through I-06: file-
transport logs omit credential/semantic payloads on all committed success/error cases; shared
platform enrollment requires the same proof-bound physical key/generation and never gives the
tenant target-mutation authority; foreign UUID collisions close uniformly without SQL leakage;
0219/0220 replay and 0221 builder/file alignment pass; repaired E2 fixtures reach every
original RLS assertion non-vacuously; semantic receipts store no session; bootstrap bearer
restoration stays atomically blocked; and frozen E1/default-off/no-placement/no-lease boundaries
remain intact. Three fresh Important blockers nevertheless prevent certification:

- **Important I2-01 — shared-platform revocation loses the post-authentication heartbeat race.**
  `authenticate()` verifies the tenant profile and then global platform physical authority in
  separate transactions. `registerProofBoundHeartbeat()` subsequently updates only the tenant
  profile and does not recheck global authority. A temporary embedded-PG probe authenticated a
  current principal, revoked/incremented the global target, then called heartbeat with that
  principal: it returned `true` and mutated profile liveness. Revocation must win atomically at
  the mutation boundary without giving the tenant authority to mutate the global target.
- **Important I2-02 — heartbeat missing-bearer denial is not frozen `ProtocolErrorV1`.**
  `requireWorkerHeartbeatAuthority` rejects a missing bearer before setting
  `res.locals.workerProtocolV1`; a temporary HTTP probe failed `protocolErrorV1Schema` and
  received the generic HTTP envelope. Mark the worker-protocol route before all parsing/lookup
  failures and prove every heartbeat 4xx/5xx is descriptor-allowed and protocol-safe.
- **Important I2-03 — bounded cleanup can permanently strand a valid proof.** The committed
  test places the colliding expired proof inside the first 100 ordered deletions. A temporary
  probe moved that collision to row 101. Enrollment then failed unauthorized; because cleanup
  and insert share the transaction, the unique violation rolled back the 100 deletions and
  retries repeat forever. Delete/replace the exact expired collision independently of bounded
  housekeeping, never an unexpired proof, and test restart/retry beyond the limit.

Fresh Windows-local evidence against the reviewed revision:

- JOB-002 DB/schema/RLS/replay/idempotency: **3 files / 13 tests passed**.
- Enrollment/session/device-proof/RLS-builder/log transport: **6 files / 28 tests passed**.
- Grant/RBAC/legacy rotation contracts: **3 files / 12 tests passed**.
- E2 schema-B fixture: **1 file / 7 tests passed**; tenant RLS/adversarial: **2 files /
  21 tests passed**, recording **4,460** hostile operations across eight seeds.
- Startup/non-owner/operator/legacy bundle: **5 files / 48 tests passed**, with the one
  Linux-only file / six tests explicitly skipped on Windows.
- JOB-001/default-off submission regression: **1 file / 31 tests passed**.
- Frozen E1 checker, frozen install, affected-package and recursive typecheck/build, diff
  hygiene, frozen E1 zero-diff, and all reviewed/RED/GREEN ancestry checks passed.
- Exact `AOA_RUN_WIN_INTEGRATION=1 pnpm test:run` honestly **failed** after 240.3s. Visible
  failures were the existing Windows worker-protocol collection SyntaxError and D18
  embedded-Postgres setup failures; D18 reproduced alone as a setup failure and the frozen
  protocol reproduced alone as one failed suite with no tests collected. No repaired
  JOB-002/E2 focused suite failed. This is not a full-suite pass or waiver; Linux CI remains
  formal DEC-03 authority.

All three adversarial probes were temporary test-only edits and were fully removed. The
reviewer modified no production code. Detailed evidence is in
`.superpowers/sdd/implementation-plan/job-002-review.md`.

The ticket remains incomplete. A fresh implementer fix round must add genuine RED coverage
for I2-01 through I2-03 and return a new 40-hex ancestor revision for another independent
review attempt.

## Implementation fix round 2 - 2026-08-10 - Codex `/root/job002_impl`

- **Review evidence consumed:** `987b0d75de7fae827d4b60fc239222cfb2522c6b`.
- **Genuine RED:** `e66f173918eda336c0340a447ae8eab0862b2c0a`.
- **GREEN candidate:** `d9c8aa5db73f4218ae02f1ee505623c4ffd7e509`.
- **State:** `implementation_complete_review_pending`; **disposition:** `review_pending`.

The three attempt-2 blockers are corrected without role, migration, frozen-E1, placement,
lease, or cutover expansion. Shared-platform heartbeat now uses one bounded `aoa_operator`
transaction and one conditional physical-target update that rechecks the pinned target,
authority, generation, worker, key, thumbprint, and profile facts at the mutation boundary.
It updates only physical liveness; it does not mutate the tenant profile or global trust and
capability metadata. Deterministic revoke-first and heartbeat-first row-lock tests prove that
revocation and heartbeat linearize, and that the old principal cannot write again after
revocation. Same-Organization heartbeat retains the tenant transaction path.

The heartbeat route marks worker protocol v1 before Authorization parsing or lookup, so
missing bearer, malformed bearer, and early lookup failures emit only frozen PRT-007
`ProtocolErrorV1`. Proof recording now removes only the exact matching expired collision by
fresh database clock before the conflict-safe insert, while the separate ordered cleanup
remains bounded. Tests cover expired collisions at positions 1, 100, 101, and 301, an
unexpired collision, restart semantics, and concurrent replicas with exactly one proof
effect.

### Fix-round-2 evidence

- New early HTTP protocol lane: **1 file / 3 tests passed**.
- Full enrollment integration plus early protocol lane: **2 files / 20 tests passed**.
- JOB-002 DB schema/operator-policy/idempotency lane: **3 files / 13 tests passed**.
- Enrollment/session/proof/RLS/logging lane: **6 files / 27 tests passed**.
- Grant/RBAC/legacy-target lane: **3 files passed, 12 tests passed / 6 explicit Windows
  skips**.
- Startup/non-owner/operator/legacy bundle: **5 files passed, 48 tests passed / 6 explicit
  Windows skips**.
- E2 schema-B fixture: **1 file / 7 tests passed**; tenant RLS/adversarial: **2 files / 21
  tests passed**, recording **4,460** hostile operations across eight seeds.
- JOB-001 default-off submission regression: **1 file / 31 tests passed**.
- Frozen E1 checker at `b7a842870ce7509d8baa75409e0ab19da375c88a`, frozen install,
  affected-package typecheck/build, recursive typecheck, root build, diff hygiene, frozen-E1
  zero-diff, and assignment/RED/GREEN ancestry checks all passed.
- Exact Windows-local `AOA_RUN_WIN_INTEGRATION=1 pnpm test:run` honestly exited 1 after
  253.4s with 13 aggregate failures. Visible failures were outside the repaired JOB-002
  lanes: embedded-Postgres startup contention/D18, distributed-startup timeouts,
  runtime-service-control timing, and the known frozen worker-protocol Windows collection
  SyntaxError. Isolated D18 passed **6/6**, runtime-service-control passed **59/59**, and the
  startup bundle passed as stated above; the frozen-protocol file alone still reproduces one
  failed suite with no tests collected. This is not a full-suite pass or waiver. Linux CI
  remains formal DEC-03 authority.

A distinct reviewer must review the new evidence revision, rerun focused acceptance, append
review attempt 3, and alone may change the ticket to `complete` / `pass`.

## Independent review attempt 3 — 2026-08-10 — Codex `/root/job002_review`

### Revision and independence

- **Reviewed revision:** `5a9870b89dbab1b626f825ec8e8261a6f77bd641`.
- **Whole-ticket base:** `434fbaad5e73e5f4f9c0d25896a11625bfa63148`.
- **Scoped fix boundary:**
  `f34948e5276cef66386c7ba5ff4beb635b172b32..5a9870b89dbab1b626f825ec8e8261a6f77bd641`.
- Genuine RED `e66f173918eda336c0340a447ae8eab0862b2c0a` and GREEN
  `d9c8aa5db73f4218ae02f1ee505623c4ffd7e509` are ancestors of the reviewed revision.
- Reviewer `Codex /root/job002_review` is distinct from implementer
  `Codex /root/job002_impl`. The reviewer changed no production code. Two temporary
  adversarial test probes were applied, executed against ephemeral embedded PostgreSQL, and
  fully reverted before evidence edits.

The review reread the canonical ticket and approved plan, E3-F005/E3-F010/E3-F012, the
implementation brief/report/result, frozen PRT-006/007 contracts, E2 operator/RLS decisions,
and the complete whole-ticket and fix-round diffs. Static and dynamic review covered H-01 and
H-04, bounded role authority, Drizzle/C14/Decision #122, atomic enrollment, semantic replay,
device proof, session claims, revocation/rotation/owner removal, bootstrap retirement,
production log transport, default-off composition, frozen E1 compatibility, and the absence
of placement/lease behavior.

### Attempt-2 blocker closure

| Finding | Independent attempt-3 result |
|---|---|
| I2-01 — shared-platform revocation race | **Closed.** Deterministic revoke-first and heartbeat-first row-lock interleavings passed. The conditional operator mutation requires the exact active target, generation, physical worker/profile, public key, thumbprint, and non-revoked facts. It writes only physical `last_seen_at`/`updated_at`; the revoked principal cannot write again. A temporary probe requested `offline` and proved global status/trust and tenant-profile liveness do not change. |
| I2-02 — early heartbeat errors outside PRT-007 | **Closed.** Missing bearer, malformed bearer, and lookup failure all parse as frozen `ProtocolErrorV1`, use only descriptor-allowed codes, and reveal no SQL/query facts. Protocol context is installed before every early failure branch. |
| I2-03 — expired replay collision outside cleanup batch | **Closed.** Committed positions 1/100/101/301, unexpired replay, restart, and two-replica contention passed. A temporary final-row collision also passed. Exact expired deletion uses the database clock and is separate from bounded ordered cleanup; an unexpired replay is never deleted. |

All attempt-1 corrections remain closed. File-transport capture covers successful and rejected
enrollment/heartbeat paths without raw enrollment code, bearer, proof, signature, public key,
semantic body, query, or error-property leakage. Foreign/absent UUID errors remain uniform and
protocol-safe. Route plus code issuance and enrollment commits are atomic in their owning role
transactions. Semantic receipts contain response/action facts, not a reusable session, and a
fresh proof plus current authority are required on retry. Bootstrap authority cannot be
restored while an active enrolled worker exists. Session claims remain short-lived and bound
to audience, worker, target, generation, device, and profile. Heartbeat cannot upgrade trust.

Actual non-owner app/operator role tests pass, including RLS/FORCE and bounded privilege
assertions. The exact applied 0219/0220 migrations replay and 0221's builder/file contract
align. The repaired E2 fixtures reach all original assertions non-vacuously. Frozen E1 has
zero whole-ticket diff, distributed execution remains default-off, and the ticket adds no
placement, polling, lease, ACK, event, executor, or cutover behavior.

### Fresh verification evidence

All integration commands ran from `C:\e3` with `AOA_RUN_WIN_INTEGRATION=1` against the exact
reviewed revision. Windows-local evidence is operator-directed; Linux CI remains the formal
DEC-03 authority.

| Command / lane | Result |
|---|---|
| Enrollment integration + early heartbeat protocol errors | PASS — 2 files, 20/20; both-order row locks, revoked-principal denial, cleanup boundaries/concurrency, and every early frozen error branch |
| DB worker schema + operator policy + migration idempotency | PASS — 3 files, 13/13; real 0219/0220 replay and role/RLS assertions |
| Enrollment/session/device proof/RLS/log transport policy | PASS — 7 files, 35/35 |
| Grant/RBAC/legacy target contracts | PASS — 3 files, 12/12 |
| Temporary physical-liveness-only status-mutation probe | PASS — global status remained `active`; only global physical liveness changed; tenant logical-profile liveness remained unchanged |
| Temporary final-row expired-collision probe | PASS — exact expired collision was removed beyond the cleanup batch and enrollment succeeded |
| E2 tenant-kernel schema-B | PASS — 1 file, 7/7 |
| E2 tenant RLS + hostile property suite | PASS — 2 files, 21/21; 4,460 operations across eight seeds and every operation class reached |
| Startup/non-owner/operator/legacy roles | PASS — 5 files, 43/43 plus config 18/18; one Linux-only file / 6 tests explicitly skipped on Windows |
| JOB-001 default-off submission regression | PASS — 1 file, 31/31 |
| Frozen E1 checker at `b7a842870ce7509d8baa75409e0ab19da375c88a` | PASS |
| `pnpm install --frozen-lockfile` | PASS |
| Affected db/shared/server typecheck and build | PASS |
| `pnpm -r typecheck` | PASS — 24/25 workspace projects |
| `pnpm build` | PASS — 24/25 workspace projects |
| Exact `AOA_RUN_WIN_INTEGRATION=1 pnpm test:run` | **FAIL (honestly labeled Windows-local aggregate)** — exit 1 after 243.1s: the known frozen worker-protocol Windows collection SyntaxError and four opencode adapter timeouts; no JOB-002 focused failure |
| Isolated three opencode files from the aggregate | PASS — 3 files, 8/8 |
| Isolated frozen cross-version file | FAIL — one suite, no tests collected, same known Windows transform `SyntaxError` at `cross-version.test.ts:12` |
| Diff hygiene, frozen E1 zero diff, and reviewed/RED/GREEN ancestry | PASS |

The non-green aggregate is not represented as a pass or waiver. Its four timing failures pass
immediately in isolation, and the remaining frozen-protocol Windows collection condition is
independently reproduced and predates JOB-002. Formal Linux certification remains downstream.
No H-01 or H-04 failure occurred in the focused or hostile acceptance lanes.

### Attempt-3 disposition

There are **zero Critical findings, zero Important findings, and zero specification blockers**
on the reviewed revision. E3-F012 is resolved. JOB-002 satisfies its approved acceptance and
is therefore `complete` / `pass`. This is ticket certification only; it is not the independent
E3 integration gate and does not authorize a push.
