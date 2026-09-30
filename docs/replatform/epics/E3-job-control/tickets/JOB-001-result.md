# JOB-001 Result — Submit immutable jobs transactionally

**Status:** `complete`
**Disposition:** `pass`
**Date opened (UTC):** `2026-08-09`
**Epic:** `E3-job-control`
**Plan task:** `JOB-001 — Submit immutable jobs transactionally (M)`
**Implementer:** `Codex /root/job001_impl`
**Reviewer:** `Codex /root/job001_review`
**Start SHA:** 8e2faa590d4e97a2cbd250c55f4a2ed81a352a33

The Start SHA remains the fetched `origin/docs/replatform-program` tip and exact pre-E3
implementation revision. Corrective E1/E2 prerequisite gates were already committed and
passing before this attempt; they were consumed as immutable dependencies.

## Dependency and assignment state

- PRT-003, TEN-003, and TEN-006 have committed passing dependency handoffs.
- E3-F001 and E3-F004 have superseding passing corrective handoffs and are immutable inputs.
- JOB-001 implementation is ready for the required distinct review; it is not complete/pass.
- On assignment, a fresh implementer appends the implementation attempt. A distinct reviewer
  reviews a 40-hex revision that is an ancestor of HEAD, reruns the focused acceptance, and
  alone may change `Status` to `complete` in a separate documentation commit.

## Implementation attempts

### Attempt 1 - 2026-08-10 - Codex `/root/job001_impl`

- Implemented flag-gated, non-owner `aoa_app` submission through exactly one
  `runInTenant(appDb, organizationId, fn)` transaction.
- Added immutable job facts, company-bound attempts, identifier-only ready outbox rows,
  exact principal/source idempotency, and migrations 0216-0218 with C14 guards and
  Decision #122 grants/FORCE RLS.
- Added shared source-command DTOs, strict validation, route/service/repository boundaries,
  transactional principal/source admission, uniform denial, payload-free logging, and no
  placement/lease/worker/cutover behavior.
- Focused acceptance: DB 10/10, required server 34/34, HTTP logging policy 8/8.
- Frozen protocol checker, frozen lock install, affected packages, recursive typecheck, and
  root build passed. Exact `pnpm test:run` was inconclusive on Windows because Vitest worker
  IPC closed before results; the bounded one-worker diagnostic emitted no failures before
  manual termination at approximately 8m27s.
- Implementation revision is the scoped JOB-001 commit containing this ledger update; the
  distinct reviewer must record its 40-hex SHA and independently rerun acceptance.

## Independent review

### Review attempt 1 - 2026-08-10 - Codex `/root/job001_review`

- **Reviewed revision:** `75ae7d5ec46f3fae01afa5b6349f3f5d5f4772c4`
- **Disposition:** `needs_changes`
- **Specification verdict:** fail.
- **Code/security quality verdict:** fail.
- Confirmed that the non-owner `aoa_app` submission path is one `runInTenant` transaction,
  atomic across immutable job + initial attempt + attempt-aware identifier-only outbox; exact
  scoped idempotency, digest conflict, 32-way convergence, hostile tenant denial, flag-off
  isolation, frozen E1 boundary, paired manifest/lock, focused schema/migration/startup/legacy
  grants, affected builds, and typechecks pass.
- **Important I-01:** the route accepts five non-task source identities from an unrelated
  authenticated principal without source-specific proof. An ordinary user is explicitly
  accepted for all six sources, including system-only `service_reconcile` and restricted
  `one_shot`, so persisted requester/executor/source authority facts are not server-authenticated.
- **Important I-02 (H-01):** forced transaction failures emit raw Drizzle query messages and
  parameters through generic error logging, exposing `source_intent` and arbitrary job input
  despite the request-body omission policy.
- **Important I-03:** adding JOB-001 tables to shared live grant constants changes the
  authoritative builders for immutable migrations 0213/0214. Their byte-alignment tests fail,
  and rebuilt 0214 would reference `job_outbox` before 0216 creates it.
- **Important I-04:** exact `AOA_RUN_WIN_INTEGRATION=1 pnpm test:run` completed with 43 failed
  tests (not a timeout and not `ERR_IPC_CHANNEL_CLOSED`). Focused reproduction found 22 server
  tenant/RLS failures and 5 DB failures caused by unsynchronized `job_attempts.company_id`
  fixtures and the changed shared repository surface.
- Windows-local evidence is not formal Linux/DEC-03 certification; nevertheless these are
  deterministic completed failures and block review. No production code was changed.
- Detailed evidence: `.superpowers/sdd/implementation-plan/job-001-review.md`.

## Review-fix attempts

### Fix round 1 - 2026-08-10 - Codex `/root/job001_impl`

- RED commit `f26b912c65e20050871ef9176e40c8daa432bc48` adds the hostile
  source/caller matrix, real failing-transaction log capture, immutable-builder checks,
  and compatible non-vacuous tenant fixture/repository contracts.
- GREEN commit `da9cfffaa04381b6253b9f4793249427ac33772d` binds all six source
  forms to the frozen requester matrix and tenant server state, restricts service
  reconciliation to trusted internal system callers, binds Commander IDs to JWT claims,
  and sanitizes the complete distributed-submission error channel.
- Historical 0213/0214 builder inputs and artifacts are byte-identical; JOB-001 authority
  is versioned only through the 0218 builder/artifact. The exact runtime startup checker
  consumes the versioned table grants and frozen MCP column projection.
- Existing eight-group repository enumeration remains compatible while `jobControl` is a
  deliberate non-enumerable transaction-scoped capability; attempt fixtures carry Company
  identity and tenant isolation/adversarial assertions execute non-vacuously.
- Focused JOB-001, hostile, concurrency, rollback/log, migration, startup, RLS, typecheck,
  frozen install/checker, and build commands pass. The exact Windows full lane is not called
  a pass: it exited 1 in 217.3s with 10 failures after an unrelated embedded-Postgres setup
  failure; a bounded isolated D18 run failed 6/6 before assertions because PostgreSQL could
  not bind localhost (`Permission denied`). Formal Linux/DEC-03 evidence remains pending.
- Status is restored only to `implementation_complete_review_pending`; the distinct reviewer
  alone may certify the ticket or change it to complete/pass.

### Review attempt 2 - 2026-08-10 - Codex `/root/job001_review`

- **Reviewed revision:** `d25c52715355ede4f459f1fc9481eae94042f991`
- **Disposition:** `needs_changes`
- **Specification verdict:** fail.
- **Code/security quality verdict:** fail.
- The four attempt-1 Important findings are resolved on the reviewed revision: all six
  source/caller combinations are bound to authenticated tenant state; the distributed 5xx
  path is H-01-safe; historical 0213/0214 builder output remains byte-identical and current
  authority is versioned through 0218; and tenant repository/company contracts are compatible
  and non-vacuous.
- **Important I2-01:** immutable job rows persist coarse wire principals as executor authority:
  `task_run` stores `agent`, `service_reconcile` stores `service`, and the other four sources
  store fabricated `system` identities. The frozen FND-007 domain matrix instead requires
  `worker|sandbox`, `sandbox`, `worker|sandbox`, `worker|sandbox`, `browser_worker`, and
  `service_instance`. PRT-003 explicitly assigns this domain-role equality to JOB-001/JOB-010,
  and the JOB-001 plan requires server-derived requester/executor facts to be persisted. The
  current source matrix tests do not assert the persisted executor kind/identity, so they pass
  while every source violates that handoff.
- Focused schema/migration/submission/startup/grant/logging/RLS/adversarial tests pass, including
  the targeted 32-way convergence and hostile cross-Organization/Company cases. Frozen check,
  frozen install, affected and recursive typecheck/build all pass.
- Exact `AOA_RUN_WIN_INTEGRATION=1 pnpm test:run` remains honestly non-green: it exited 1 after
  211.4s with the pre-existing Windows worker-protocol cross-version transform failure and an
  embedded-Postgres D18 setup/teardown failure before assertions. The isolated D18 rerun then
  bound `::1`/`127.0.0.1` and passed 6/6 in 9.84s. This review does not call the full lane a
  pass; formal Linux/DEC-03 evidence remains pending.
- No production code was changed. Detailed evidence:
  `.superpowers/sdd/implementation-plan/job-001-review.md`.

### Fix round 2 - 2026-08-10 - Codex `/root/job001_impl`

- RED commit `75c93ccf3310d22ce8b4dd33a361a8bfc19181db` adds persisted-row
  requester/executor assertions for every accepted source and every allowed combination in
  the hostile 4-caller x 6-source matrix. The genuine RED run failed 7 tests because all six
  source classes stored coarse or fabricated executor authority.
- GREEN commit `ff96abd1a554bdddb3ef4ff85021c4a5d2f12581` makes tenant-bound source
  admission return the server-owned domain executor authority. Task, crew, and one-shot use
  `worker`; Commander uses `sandbox`; browser uses `browser_worker`; service uses
  `service_instance`. Opaque IDs come from admitted source-engine state, except the
  authenticated one-shot operation identity. Requester authority remains separately stored.
- No placement, target selection, lease, worker contact, cutover, or E1 change was made. The
  existing executor columns are unconstrained `text` and already represent the frozen roles,
  so no Drizzle migration is required. A backfill was deliberately not invented: historical
  rows are immutable facts and an alternate `worker|sandbox` choice cannot be reconstructed
  safely. Rolling activation must keep the feature flag off until all submission writers run
  this revision.
- Focused schema/migration, submission, hostile, concurrency, builder/grant, logging,
  composite-FK, RLS/adversarial, startup, frozen checker/install, typecheck, and build lanes
  pass. Exact Windows `AOA_RUN_WIN_INTEGRATION=1 pnpm test:run` remains honestly non-green:
  exit 1 after 221s, 3 failed suites and 7 failed tests, all outside JOB-001. Isolated OpenCode
  (3/3), ask-founder (4/4), and D18 (6/6) pass; the known worker-protocol Windows transform
  failure reproduces alone. Formal Linux/DEC-03 evidence remains pending.
- Status is `implementation_complete_review_pending`; only the distinct reviewer may certify
  or mark JOB-001 complete/pass.

### Review attempt 3 - 2026-08-10 - Codex `/root/job001_review`

- **Reviewed revision:** `697bf9f462b7ec834e264b63363e614f6440cc4a`
- **Disposition:** `pass`
- **Specification verdict:** pass.
- **Code/security quality verdict:** pass.
- The attempt-2 executor-authority finding is resolved. Persisted executor roles now equal the
  frozen six-source domain matrix: task, crew, and one-shot use `worker`; Commander uses
  `sandbox`; browser uses `browser_worker`; and service reconciliation uses
  `service_instance`. Persisted requester and executor facts are asserted for every accepted
  source and every allowed cell of the hostile 4-caller x 6-source matrix.
- The opaque IDs are truthful source-engine authority facts, not fabricated delivery targets:
  task uses the tenant-bound heartbeat agent; Commander/browser use admitted internal-run IDs;
  crew uses its admitted agent or its admitted user-owned run as the no-agent fallback;
  one-shot uses the validated operation ID; and service uses the tenant- and generation-bound
  service ID. Submission still performs no placement, lease, worker contact, or cutover.
- All four attempt-1 findings remain closed: source/caller admission is tenant- and
  server-state-bound; the full 5xx path is H-01-safe; historical 0213/0214 builders remain
  byte-identical while 0218 owns current authority; and tenant repository/company contracts
  remain compatible and non-vacuous.
- Fresh focused evidence is green: submission 30/30; persisted authority/hostile target 7/7;
  schema/migration 10/10; required startup/legacy/hygiene lane 40/40; 32-way race 1/1;
  builder/grant/transaction/logging 35/35; repository 3/3; DB composite 16/16; tenant/RLS
  regression 45/45; distributed startup 16/16; frozen checker/install, affected and recursive
  typecheck/build all pass.
- Exact `AOA_RUN_WIN_INTEGRATION=1 pnpm test:run` is honestly **non-green**: exit 1 after
  230.9s with the pre-existing Windows worker-protocol cross-version transform failure and one
  Cursor sandbox timeout. The worker-protocol failure reproduces alone; the Cursor test passes
  alone 1/1. Neither correction boundary touches those packages. This result is not called a
  pass, and formal Linux/DEC-03 evidence remains pending; the ticket-specific focused acceptance
  and regression surface are green.
- No production code was changed by the reviewer. Detailed evidence:
  `.superpowers/sdd/implementation-plan/job-001-review.md`.
