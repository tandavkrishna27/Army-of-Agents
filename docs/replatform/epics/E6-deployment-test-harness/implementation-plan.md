# E6 — Deployment and Distributed Test Harness — Implementation Plan (PARTIAL: `E6-D1-FOUNDATION`)

**Plan status:** `partial-draft` — this document covers **only** the five
`E6-D1-FOUNDATION` tickets (DEP-000, DEP-001, DEP-002, DEP-003, DEP-004) and the
named `E6-D1-FOUNDATION` partial gate. DEP-005 through DEP-009 (network/clock
harness, staging manifests, observability baseline, managed-provider isolation
conformance, and two-replica HA) are **out of scope** here and are owned by the
later full-E6 plan revision. Nothing in this partial plan passes D1, E6, or a
release lane.

**Scope note (forward dependencies not yet built):** DEP-000 depends on WRK-004
and DEP-001 depends on WRK-001; the E4 worker daemon does **not exist yet**
(`packages/worker-daemon` is absent; E4 is `backlog`). `E6-D1-FOUNDATION` closure
additionally requires JOB-003 (E3, currently `needs_changes`) and WRK-004. No
DEP ticket in this plan is assignable until its named upstream ticket has a
committed passing handoff. These STOPs are recorded in §0 and the execution
boundary; they are not improvised away.

**Goal:** Build the dormant, deterministic distributed **test harness** that lets
the durable job-control plane (E3) and the worker daemon (E4) be exercised end to
end without any live cloud provider: a fixture-driven networked fake sandbox
provider, separately-signed least-privilege control-plane and worker images, an
isolated Docker Compose topology (PostgreSQL, MinIO, one control-plane replica,
≥2 profiled workers, fake provider, Toxiproxy, runner), a privileged migration
job with a liveness/readiness/dependency contract and the fail-closed 0188
populated-cutover preflight, and path-filtered + merge-train CI lanes with
retained failure evidence — culminating in the independent `E6-D1-FOUNDATION` QA
record and handoff.

**Approved architecture:** The control plane remains the sole executor of tenant
effects; the harness never adds a second job/attempt/lease authority, provider
registry, or memory/task store. The fake provider is **provider-neutral** — it is
addressed by opaque provider ID, exposes only the frozen `PROVIDER_OPERATIONS`
vocabulary, and carries **no E2B fields** in any common contract (CAV-002). All
distributed behavior stays behind `AOA_DISTRIBUTED_EXECUTION_ENABLED=false`; the
harness images, compose stack, migration job, and merge-train lane are additive
and dormant until an operator opts in. Real E2B/managed-provider conformance is
the CLI-001/D2 gate, **not** an E6-D1-FOUNDATION prerequisite. Application startup
**never** runs migrations and **never** synthesizes the durable 0188 marker.

**Tech stack:** TypeScript, Node 24 / pnpm 9.15.4 workspaces, Express 5,
PostgreSQL 16, Drizzle ORM, E1 `@armyofagents/worker-protocol` (frozen v1),
Vitest, `embedded-postgres`, Docker + Docker Compose, MinIO, Toxiproxy, cosign
(test roots), an SBOM generator (syft/CycloneDX), and GitHub Actions.

---

## 0. Planning record, freeze, and dependency gates

| Item | Recorded value |
|---|---|
| Frozen `origin/main` | `003492988269a91eadfadb352bff7f413fa61adb` — the crosswalk execution freeze (same anchor as E0–E3); present locally and an ancestor of `origin/main`. |
| Planning baseline SHA | `d24dd68a755f49019833112af1bc248e17f8a193` — `C:\e3` tip of `codex/epic-e3-job-control` (cumulative E0–E3). This is the **planning** revision only; each DEP ticket's `Start SHA` is its actual assignment SHA once its E4 upstream lands. |
| E0 completion | `pass` — `docs/replatform/epics/E0-foundation/handoffs/2026-08-08-epic-completion-3a469b6bec68-a1.md`. |
| E1 completion (frozen protocol + consumer checker) | `pass` at reviewed `01ad1ab554fe25c5178c7552ec047d4df45b7dcf`. `@armyofagents/worker-protocol` v1 is frozen and consumed unchanged. |
| E2 completion (tenant kernel, **TEN-002**) | `pass` at reviewed `7843b86e25eb1ff9c520308aef7f123fec6997a7`. Non-owner `aoa_app` + metadata-only `aoa_operator`, FORCE RLS on the eight new-path tables, and `runInTenant` are available. |
| E3 (**JOB-003** lease/ACK) | `needs_changes` at planning time. `E6-D1-FOUNDATION` **closure** requires JOB-003 `complete`. Not a blocker to *planning* DEP tickets, but a blocker to the gate. |
| E4 (**WRK-001** worker package, **WRK-004** sandbox supervisor) | **Not present / `backlog`.** `packages/worker-daemon` does not exist. DEP-000 (needs WRK-004's provider-driver port) and DEP-001 (needs WRK-001's worker package + entrypoint) are **blocked** until E4 lands. |
| `E6-D1-FOUNDATION` | **Not present / not passed.** It is a named partial gate, never a ticket-result substitute, and does not certify E6 or D1. |
| Planning worktree | `C:\e3` (short path — deep-OneDrive MAX_PATH boot failure is a known hazard); dependencies installed with `pnpm install --frozen-lockfile`. |
| Formal test authority | **Linux CI under DEC-03.** Windows short-path evidence is operator-directed local evidence and must be labeled `operator-directed windows-local`. Docker/compose/image lanes have **no** Windows-local substitute for the formal Linux lane. |
| Planning baseline smoke | `pnpm build` passes at the planning SHA. `pnpm test:run` on Windows exits with the already-recorded worker-protocol cross-version `ERR_IPC_CHANNEL_CLOSED` transform artifact; planning context only, never gate evidence or a waiver. |

### STOP — E4 worker daemon must land before DEP-000/DEP-001

DEP-000's networked fake provider implements **the provider-driver port that
WRK-004 owns** (the supervisor that consumes create/execute/cancel/kill/destroy/
list/inspect/reconcile_cleanup + checkpoint/restore/health). DEP-001's worker
image packages **the `packages/worker-daemon` daemon and entrypoint that WRK-001
scaffolds**. Neither the port nor the package exists at planning time. DEP-000 and
DEP-001 may be *planned* against the frozen `capabilities.ts` vocabulary now, but
**assignment is blocked** until WRK-001/WRK-004 have committed passing handoffs.
Inventing a second provider-driver interface or a worker runtime inside E6 is a
STOP requiring an E4 amendment, not an E6 improvisation.

### RESOLVED — provider-neutrality and the shared contract suite

The DEP-000 fake provider and the reusable provider-contract suite use **opaque
provider IDs only** and no E2B-specific fields (CAV-002). The single conformance
suite authored here (`@armyofagents/sandbox-provider-contract`) is the suite E2B
consumes later at CLI-001/D2; E6 runs it only against the fake. Recorded E2B
runtime/TTL/resource/concurrency/template/persistence limits stay behind the
accepted caveat and are **not** required for this gate.

### Execution boundary

| Boundary | Tickets | Assignment rule |
|---|---|---|
| **Blocked on E4** | DEP-000, DEP-001 | Not assignable until WRK-004 (DEP-000) and WRK-001 (DEP-001) have committed passing handoffs. Plannable now against frozen E1 `capabilities.ts`. |
| **Blocked on DEP predecessors** | DEP-002, DEP-003, DEP-004 | DEP-002 needs DEP-000 + DEP-001 + TEN-002 (TEN-002 passed). DEP-003 needs DEP-002 + TEN-001 (passed). DEP-004 needs DEP-002 + FND-005 (passed). Respect the DAG in §8. |
| **Gate, blocked** | `E6-D1-FOUNDATION` | Requires DEP-000–004 **and** JOB-003 **and** WRK-004 on one revision, plus the independent QA record and passing handoff over E6F-00–E6F-08. |
| **Out of scope (later E6 plan)** | DEP-005–DEP-009 | Not in this partial plan. |

### NOT in scope (this partial plan's non-goals)

- No DEP-005 network/clock fault *scripting* (Toxiproxy is *wired* by DEP-002; its
  fault campaigns and clock control are DEP-005 + DEP-006). This plan only proves
  the proxy is in-path and the boundaries hold.
- No DEP-006 staging manifests, autoscaling, or managed provider-control secret
  injection; no DEP-008 hostile/reference-provider isolation conformance; no
  DEP-009 two-replica HA or shared admission store.
- No real E2B, Firecracker, or any managed provider execution or claim (CAV-002);
  the fake is provider-neutral and implements only the frozen registered ops.
- No release-root signing, vulnerability policy, or attestation breadth — DEP-001
  uses **test roots** only; REL-004 later replaces them.
- No second job/attempt/lease authority, provider registry, tool registry, memory
  store, or task store.
- No public worker ingress, realtime durability claim, desktop packaging, or
  mobility.
- No change to E1 v1 wire protocol. An unavoidable wire change is an additive
  versioned field only and is a STOP requiring the Protocol/Schema Custodian.
- No RLS retrofit of legacy Company tables (CAV-005) and no unsafe owner-pool
  bridge in any new path (the marker table is written only by `aoa_operator`).

---

## 1. Consumed as-built interfaces / what already exists and is reused

### Frozen E1 protocol — consume, do not edit

| Interface | E6-D1-FOUNDATION use |
|---|---|
| `packages/worker-protocol/src/capabilities.ts` | `PROVIDER_OPERATIONS` (`create, execute, cancel, kill, destroy, list, inspect, reconcile_cleanup, checkpoint, restore, health`), `CORE_PROVIDER_OPERATIONS` (8 mandatory), `OPTIONAL_PROVIDER_OPERATIONS` (`checkpoint, restore, health`), `providerConstraintProfileV1Schema` + `verifyAndBrandProviderConstraintProfileV1`, `registeredTargetProfileV1Schema`, `workerSatisfiesRequirements`. The fake provider (DEP-000) advertises and honors exactly this vocabulary; no new op is invented. |
| `packages/worker-protocol/src/canonical-json.ts` | `canonicalizeJsonV1`, `canonicalEventDigestInputV1`, `verifyWorkerEventDigestV1` (SHA-256 injected). DEP-000 recomputes and asserts `eventDigest` for every scripted event so fixture replays are byte-deterministic. |
| `packages/worker-protocol/src/events.ts`, `states.ts`, `transport.ts` | `WorkerEventV1`/batch shapes, lifecycle transition predicates, and the 10 transport operations. The fake replays fixture `expectedEvents`, and the smoke job (DEP-002) exercises enroll/poll/lease_ack against the real control-plane surface. |
| Frozen-consumer baseline `tests/fixtures/worker-protocol-consumers/v1/` + `scripts/check-frozen-worker-protocol-consumer.mjs` | Any new leaf package that imports `@armyofagents/worker-protocol` keeps the frozen source-SHA/dependency proof green. |

### FND-004 golden-journey fixtures — the corpus DEP-000 scripts from

| Interface | E6-D1-FOUNDATION use |
|---|---|
| `tests/fixtures/distributed-execution/*.json` (9 fixtures) + `schema-v1.json` | The validated golden journeys the fake provider replays. Fixture shape: `steps[]` (`{action, at?, emits?[]}`), `failureInjection` (`{point, effect}` or `null`), `expectedEvents[]` (with `eventDigest`), `cleanup` (`resource_bound_cleanup`), and `expected` (`{terminalState, artifacts[], auditActions[], forbiddenEffects[]}`). |
| `scripts/check-distributed-execution-foundation.mjs` | Meta-validates the schema, validates every fixture, and verifies digests. `GJ_FIXTURES` is the enumerated corpus; the canonicalizer/`computeEventDigest` are exported. DEP-000/DEP-004 keep this checker green and reuse its exports. |

### E2 tenant kernel + E3 job control — the harness exercises, never replaces

| Interface | Files | Reuse rule |
|---|---|---|
| Distributed flag + startup safety (FND-005) | `server/src/config/distributed-execution.ts`, `server/src/config.ts` | `AOA_DISTRIBUTED_EXECUTION_ENABLED` gates everything; `assertHostedExecutionStartupSafe` is the "exit on invalid trust configuration" template. The harness never enables authority — it only exercises the dormant path. |
| Bounded serving/operator pools | `server/src/db/distributed-execution-databases.ts`, `packages/db/src/client.ts` (`createTenantAppDbConnection`, `createOperatorDbConnection`, `RequiredMigrationIdentity`, `loadRequiredMigrationIdentity`) | The migration job (DEP-003) runs as a **privileged** role distinct from `aoa_app`/`aoa_operator`; the control plane opens only the non-owner serving pool after readiness. |
| Tenant RLS roles/tables/GUC | `server/src/db/rls-tenant.ts` (`TENANT_APP_ROLE="aoa_app"`, `OPERATOR_ROLE="aoa_operator"`, `TENANT_GUC="aoa.organization_id"`, `TENANT_RLS_TABLES`), `server/src/db/tenant-context.ts` (`runInTenant`), `server/src/db/with-tenant-tx.ts` | DEP-003's marker table follows the C14/Decision #122 custom-RLS migration pattern: `aoa_operator` write, `aoa_app` read, tenants none. The smoke job's tenancy assertions (E6F-04) run through `runInTenant`. |
| Worker-facing control-plane surface (JOB-002/003) | `server/src/routes/worker-control.ts` (`/api/worker-control/enroll|poll|leases/:id/ack`), `server/src/services/worker-enrollment.ts`, `server/src/services/job-leasing.ts`, `server/src/services/job-submission.ts`, `server/src/services/job-placement.ts` | DEP-002's fake-provider job and DEP-000's networked fake drive **these** endpoints. The harness adds no new control-plane route (event/control ingestion remains E4/JOB-005+). |
| Migration 0188 | `packages/db/src/migrations/0188_organizations.sql` | The one-way-door org migration DEP-003's populated-cutover preflight guards. DEP-003 does **not** modify 0188; it adds the operator-gated snapshot/marker machinery around it. |

### Existing infra the DEP tickets extend

| Concern | Files | Reuse rule |
|---|---|---|
| Combined image (to split) | `Dockerfile`, `scripts/docker-entrypoint.sh` | DEP-001 produces **separate** `docker/control-plane/` and `docker/worker/` images. The combined `Dockerfile` and `docker.yml` stay untouched until REL-004. |
| Multi-service compose template | `docker-compose.research.yml` (two networks, `service_healthy` gating, `AOA_E2E_FAKE_*` control-file/invocations-JSONL pattern) | DEP-002's `docker-compose.d1.yml` mirrors its structure; it is the closest existing model for deterministic startup + fake-harness wiring. |
| CI gate suite + aggregator | `.github/workflows/pr.yml` (`changes` detector, `policy`, `ci-required`), `docker.yml` | DEP-004 extends `changes` path-classing and routes new conditional jobs through `ci-required` (never a trigger-level `paths:` or an independently-required check). |
| Dependency-boundary checker template | `scripts/check-worker-protocol-boundary.mjs` + `scripts/lib/worker-protocol-boundary.mjs` | DEP-000 adds an analogous fake-provider boundary check ("no tenant/server/db code on the host worker"). |
| Health surface | `server/src/routes/health.ts` (`/api/health`) | DEP-003 splits it into liveness / readiness / dependency-health and adds the schema-compatibility serving gate. |

---

## 2. Harness shape and isolation rules

### 2.1 Provider-neutral fake sandbox provider (DEP-000)

- **Two new leaf packages, no server/db import:**
  `@armyofagents/sandbox-fake-provider` (the networked fake + fixture runtime +
  invocation ledger) and `@armyofagents/sandbox-provider-contract` (the
  parameterized, provider-neutral conformance suite). Both are pure leaves whose
  runtime deps are limited to `@armyofagents/worker-protocol`, `zod`, and Node
  built-ins. A boundary check (`scripts/check-sandbox-fake-provider-boundary.mjs`)
  statically rejects any import of `@armyofagents/server`, `@armyofagents/db`,
  `drizzle-orm`, or tenant modules — this is the machine-checkable form of
  "without invoking tenant code on the host worker".
- **Addressing + inspection.** The fake exposes a small loopback HTTP control
  plane: a *control* channel (`POST /script` loads a validated golden fixture by
  provider ID; `POST /reset`; `GET /invocations` returns the append-only
  invocation ledger) and a *driver* that implements WRK-004's provider-driver
  port and is addressed by `providerId`. Every driver call appends
  `{providerId, op, args-digest, checkpoint, faultInjected, ts}` to the ledger;
  tests inspect it via `GET /invocations`.
- **Fixture-driven scripting.** For each of `create/execute/event/hang/cancel/
  crash/checkpoint/destroy`, behavior is read from the FND-004 fixture's `steps[]`
  + `failureInjection`. A fault is injectable **at each lifecycle checkpoint** by
  matching `failureInjection.point` to the checkpoint and applying
  `failureInjection.effect`. Scripted events are emitted with a recomputed
  `eventDigest` via `verifyWorkerEventDigestV1`, so two replays of one fixture are
  byte-identical.
- **Determinism + reset isolation.** A fake clock and deterministic id/digest
  fixtures make each replay reproducible; `reset` restores zero invocations and
  zero live resources, and the `list`/`inspect` projection reports zero resources
  after `reconcile_cleanup` (the E6F-02 "zero provider resources" invariant).

### 2.2 Separate signed least-privilege images (DEP-001)

- **Control-plane image** (`docker/control-plane/Dockerfile`): server + UI only.
  **No** `docker-cli`, **no** worker daemon, **no** agent CLIs. Non-root user,
  read-only root filesystem, pinned base **by digest**
  (`node:lts-trixie-slim@sha256:…`), `HEALTHCHECK` → `/api/health`, and OCI labels
  exposing health/version/source metadata (`org.opencontainers.image.revision` =
  the recorded source SHA).
- **Worker image** (`docker/worker/Dockerfile`): the `packages/worker-daemon` daemon
  only (WRK-001). **No** UI, **no** `@armyofagents/server`, **no** DB/drizzle
  tooling. Non-root, read-only root, pinned base by digest, local health/metrics
  endpoint only.
- **Supply chain (test roots).** `docker/images/build.sh` builds both
  reproducibly from the recorded source revision; `docker/images/sbom.sh` emits a
  minimum SBOM per image; `docker/images/sign.sh` signs each image digest with a
  **test** cosign key and attaches source provenance. `docker/images/allowlist.json`
  records the accepted signed digests.
- **Admission verification.** `scripts/verify-image-admission.mjs` (pure logic in
  `scripts/lib/image-admission.mjs`) verifies signature + provenance against the
  test root and admits **only** allowlisted digests; it rejects a tampered or
  unsigned digest fail-closed. DEP-002's compose consumes only admitted digests.
- **Deps-stage parity.** The `pr.yml` Dockerfile-deps validator is **extended** to
  cover both new Dockerfiles: each image's `deps` stage must `COPY` exactly its
  own dependency closure and no more. The worker image's closure is fixed by
  **E4-D01** to exactly `worker-daemon` + `worker-protocol` + the `pino` runtime
  dep (zod transitive); it does **not** copy `adapter-utils` and must not pull
  server/db/shared/drizzle.

### 2.3 Isolated D1 compose topology (DEP-002)

Network segmentation matrix (enforced by both a static validator and live denial
tests):

| Service | `data-net` | `control-net` | `worker-net` | `provider-ctl-net` |
|---|---|---|---|---|
| `postgres` | ✅ | — | — | — |
| `minio` | ✅ | ✅ (declared S3 API) | ✅ (declared S3 API) | — |
| `control-plane` (1 replica) | ✅ | ✅ | ✅ | ✅ **declared provider API only** |
| `worker-a`, `worker-b` (≥2, distinct profiles) | **❌** | ✅ (control-plane API) | ✅ | ✅ (fake execute API) |
| `fake-provider` | — | ✅ declared API | ✅ | ✅ control endpoint (workers only) |
| `toxiproxy` | in-path on worker↔control-plane, worker↔minio, control-plane↔postgres | | | |
| `migrate` (DEP-003) | ✅ privileged | — | — | — |
| `test-runner` | — | ✅ | — | — |

- **Worker cannot reach PostgreSQL:** workers are **not** attached to `data-net`;
  a live TCP-connect from a worker to `postgres:5432` must be refused.
- **Control plane reaches provider only via declared API:** the control plane may
  hit the fake's declared API but **not** its control endpoint
  (`/script`,`/reset`) — those are worker-side/test-runner-side only.
- **No shared writable volume:** each service owns its named volume or mounts
  read-only; a static `docker inspect`-style check asserts no two services share
  one `rw` mount.
- **Deterministic startup:** `depends_on: { condition: service_healthy }`;
  `migrate` completes before `control-plane` serves (readiness gate, DEP-003);
  `worker-a`/`worker-b` enroll against distinct registered target profiles.

### 2.4 Migration job + readiness contract + 0188 preflight (DEP-003)

- **Privileged migration job, separated from app startup.** A dedicated container
  command (`docker/control-plane/migrate-entrypoint.sh` → `packages/db/src/
  migrate-job.ts`) applies schema migrations under a **privileged** migration role
  (not `aoa_app`/`aoa_operator`), is **idempotent**, and **never loops
  destructively** (bounded retries, fail-closed exit). App startup runs **no**
  migrations.
- **Liveness / readiness / dependency health, distinguished.**
  `/api/health` → liveness (process up); a new `/api/ready` → readiness = applied
  migration identity is **compatible** with the image's
  `loadRequiredMigrationIdentity()` **and** dependency health (PostgreSQL + MinIO
  reachable). The control plane **serves no tenant/app route until ready** (503
  from a readiness middleware, not a crash). Worker readiness (consumed from
  WRK-001's local health surface) requires a valid session **and** provider
  health.
- **0188 populated-cutover preflight — fail-closed, operator-gated.** The first
  populated single-tenant→`cloud_auth` flip runs, in order, in the migration job
  (never at app startup):
  1. Require **explicit operator opt-in** (`AOA_0188_CUTOVER_OPT_IN=1`) **and**
     the **exact candidate SHA** (`AOA_0188_CANDIDATE_SHA` == the image's recorded
     source revision). Missing/either mismatched → **STOP, no marker**.
  2. Take a snapshot to the object store, **checksum-validate** it. Snapshot or
     checksum failure → **STOP, no marker**.
  3. **Restore** the snapshot into an **isolated pre-cutover database** and verify
     it restores cleanly (restore-validation). Failure → **STOP, no marker**.
  4. Write the **durable 0188 marker** row (only now), keyed by candidate SHA with
     snapshot ref + checksum + verified-at.
  5. **Verify** the marker by read-back. Verify failure → **STOP** (do not deploy).
  6. **Idempotent repeat:** a second invocation with a present, verified marker for
     the same candidate SHA is a no-op success.
  Application startup **reads** the marker but can **never write or synthesize**
  it; marker absence → refuse cutover, stay single-tenant. The marker table is
  written only by `aoa_operator` (custom RLS migration, C14/Decision #122;
  slug `distributed_cutover_marker`), read-only for `aoa_app`, invisible to
  tenants.

### 2.5 CI lane routing rule (DEP-004)

- **Path classification, not trigger filters.** Extend the existing `changes` job
  to emit path-class outputs (`protocol`, `schema`, `fixtures`, `provider`,
  `compose`). **Never** add a trigger-level `paths:`/`paths-ignore:` to `pr.yml`
  (a skipped required check passes silently) and **never** make a conditional job
  an independently-required check — route the verdict through `ci-required`.
- **Mandatory consumers.** A protocol/schema/fixtures/provider change **must**
  trigger its consumer job (`distributed-contract`); `ci-required` requires it to
  pass **only when** its trigger class changed, exactly like the existing
  `verify`/`e2e` docs-only skip pattern.
- **Merge-train with evidence.** A separate `d1-merge-train.yml` (merge_group /
  push-to-main) brings up `docker-compose.d1.yml`, runs a bounded E6F subset, and
  on failure **retains** distributed logs, events, DB-state dump, and MinIO object
  manifests via `actions/upload-artifact`. Its config is statically validated on
  every PR by `scripts/check-ci-lanes.mjs`.

---

## 3. TDD, evidence, and commit protocol for every ticket

1. The controller creates `tickets/DEP-00X-result.md` with the exact **bare
   40-hex** Start SHA, `Status` and `Disposition` **backtick-wrapped**, named
   implementer/reviewer, acceptance checklist, and command ledger. The Start SHA
   is the actual assignment SHA (after the E4 upstream lands for DEP-000/001).
2. A fresh implementer writes focused tests first and commits/records a **genuine
   RED** on unchanged behavior. The controller rejects false REDs (import/build-
   order/env-setup artifacts).
3. The implementer makes the smallest GREEN change, runs the focused acceptance
   plus affected-package typecheck/build, updates `findings.md`, and commits.
4. A **DISTINCT reviewer** checks the reviewed 40-hex revision (an ancestor of
   HEAD), reruns the focused command, appends review attempt 1 with a plain
   `git commit`, and alone flips `Status` → `complete`.
5. Any harness isolation-invariant failure (no-tenant-code-on-worker, worker↔DB
   reachability, control-plane→provider-control reachability, shared-rw-volume,
   marker auto-synthesis, unsigned/tampered image admitted) is a **non-waivable
   `fail`**. A dependency/protocol/frozen-main contradiction is a **STOP + plan
   amendment**, never an improvised implementation.

Shared PowerShell helpers (identical to the E3 lane so red/green run from `C:\e3`):

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
```

Affected-package gates (each through `Invoke-NativeGate`): `pnpm --filter
@armyofagents/{sandbox-fake-provider,sandbox-provider-contract,db,shared,server,ui}
{typecheck,build}`.

**Lane classification (DEC-03).** Pure leaf-package and `node --test` script lanes
run **locally on Windows** (no PG, no Docker). Embedded-PostgreSQL integration
lanes run locally only when wrapped in `Invoke-E3Integration { … }` (which exports
`AOA_RUN_WIN_INTEGRATION=1`) with `embedded-postgres` `--encoding=UTF8 --locale=C`.
**Docker/image/compose live lanes have no Windows-local substitute** and are the
formal **Linux CI** authority; a local Linux docker host is operator-directed
evidence only.

Tests are hermetic: fake clock, deterministic UUID/digest fixtures, embedded
PostgreSQL, in-process/loopback fakes — **no live provider, network egress,
customer data, or real credential**. Every focused result records command, exit
code, test count, duration, platform, and exact revision.

| Ticket | Exact focused command (lane) |
|---|---|
| DEP-000 | **Local + CI:** `Invoke-NativeGate 'DEP-000 fake' { pnpm --filter @armyofagents/sandbox-fake-provider exec vitest run }; Invoke-NativeGate 'DEP-000 contract' { pnpm --filter @armyofagents/sandbox-provider-contract exec vitest run }; Invoke-NativeGate 'DEP-000 boundary' { node scripts/check-sandbox-fake-provider-boundary.mjs }; Invoke-NativeGate 'DEP-000 foundation' { node scripts/check-distributed-execution-foundation.mjs }` |
| DEP-001 | **Local (pure):** `Invoke-NativeGate 'DEP-001 admission' { node --test scripts/lib/__tests__/image-admission.test.mjs }`. **Linux/CI only (docker):** `Invoke-NativeGate 'DEP-001 images' { bash docker/images/build.sh && node --test docker/images/__tests__/image-contents.test.mjs docker/images/__tests__/image-startup-smoke.test.mjs }` |
| DEP-002 | **Local (static):** `Invoke-NativeGate 'DEP-002 compose-config' { node scripts/check-d1-compose.mjs; node --test scripts/lib/__tests__/d1-compose-invariants.test.mjs }`. **Linux/CI only (compose up):** `Invoke-NativeGate 'DEP-002 topology' { node --test tests/d1/network-denial.test.mjs tests/d1/fake-provider-job.test.mjs }` |
| DEP-003 | **Local (pure):** `Invoke-NativeGate 'DEP-003 preflight' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/cutover-0188-preflight.test.ts src/__tests__/readiness-liveness.test.ts }`. **Local (embedded PG):** `Invoke-E3Integration { Invoke-NativeGate 'DEP-003 db' { pnpm --filter @armyofagents/db exec vitest run src/__tests__/distributed-cutover-marker-schema.integration.test.ts src/__tests__/migration-idempotency.test.ts }; Invoke-NativeGate 'DEP-003 server' { pnpm --filter @armyofagents/server exec vitest run src/__tests__/migration-readiness.integration.test.ts src/__tests__/migration-rollback-startup.integration.test.ts } }` |
| DEP-004 | **Local (pure):** `Invoke-NativeGate 'DEP-004 ci-lanes' { node scripts/check-ci-lanes.mjs; node --test scripts/lib/__tests__/ci-lanes.test.mjs scripts/lib/__tests__/d1-evidence-bundle.test.mjs }`. **Linux/CI only:** the `d1-merge-train.yml` deliberate-failing-fixture proof + evidence-artifact retention. |

---

## 4. Ticket implementation tasks

### DEP-000 — Deterministic fake sandbox provider (M, ≤3 agent-days, FOUNDATION)

**Depends on:** WRK-004 (provider-driver port — **not built**, E4), FND-004
(fixtures — built). **Blocked on E4.**

**Outcome:** A networked fake provider that scripts create/execute/event/hang/
cancel/crash/checkpoint/destroy behavior from validated golden fixtures, is
addressable by provider ID, exposes an inspectable invocation ledger, injects a
failure at each lifecycle checkpoint, and packages a provider-neutral contract
suite shared with E2B.

**Ticket non-goals:** real E2B/managed provider behavior; a second provider-driver
port (WRK-004 owns it); event/control **ingestion** on the control plane (E4/
JOB-005+); Toxiproxy fault scripting (DEP-005); image/compose packaging (DEP-001/
002).

**Files:**
- Create leaf `packages/sandbox-provider-contract/{package.json,tsconfig.json,
  vitest.config.ts}` and `src/{index.ts,vectors.ts,checkpoints.ts}` —
  `runSandboxProviderContract(makeDriver, options)` exporting the provider-neutral
  conformance suite (opaque provider IDs, no E2B fields; loads `GJ_FIXTURES` from
  `tests/fixtures/distributed-execution/` and the core/optional op vectors).
- Create leaf `packages/sandbox-fake-provider/{package.json,tsconfig.json,
  vitest.config.ts}` and `src/{index.ts,control-server.ts,fake-driver.ts,
  fixture-runtime.ts,invocation-ledger.ts}` — the loopback control server
  (`/script`,`/reset`,`GET /invocations`), the driver implementing WRK-004's port
  addressed by `providerId`, the fixture-step interpreter with per-checkpoint
  `failureInjection`, and the append-only ledger.
- Create `scripts/check-sandbox-fake-provider-boundary.mjs` (+ reuse
  `scripts/lib/worker-protocol-boundary.mjs` helpers) rejecting server/db/drizzle/
  tenant imports; wire into the `policy` job.
- Create tests: `packages/sandbox-fake-provider/src/__tests__/{fixture-determinism,
  reset-isolation,invocation-inspection,checkpoint-fault-injection}.test.ts`;
  `packages/sandbox-provider-contract/src/__tests__/contract-self.test.ts`
  (runs the suite against the fake in-process).

**Interfaces:** The driver honors the frozen `PROVIDER_OPERATIONS` vocabulary and
returns cleanup **status**, never throwing (`{cleanupStatus:"success"|"failed"}`
mirror). Control API: `POST /script {providerId, fixtureId}` (fail-closed on a
fixture that does not schema-validate), `POST /reset`, `GET /invocations →
{providerId, op, argsDigest, checkpoint, faultInjected, seq, ts}[]`. Every scripted
event carries a recomputed `eventDigest` (`verifyWorkerEventDigestV1`).

**Acceptance (incl. failure behavior):** a test addresses a fake by `providerId`,
scripts a fixture, and reads the exact invocation ledger; a fault injected at each
of the lifecycle checkpoints (`create/execute/event/hang/cancel/crash/checkpoint/
destroy`) yields the fixture's declared `failureInjection.effect` deterministically;
two replays of one fixture produce byte-identical ledgers and event digests;
`reset` restores zero invocations and, after `reconcile_cleanup`, `list`/`inspect`
reports **zero** provider resources; an unschema-valid fixture is **rejected**
(fail-closed) rather than partially scripted; an unknown op is rejected; the
boundary check proves **no** server/db/tenant import (no tenant code on the host
worker).

**Compatibility / rollback:** two additive leaf packages under `packages/*`
(auto-included by `pnpm-workspace.yaml`); no runtime wiring into server/db. Removing
them is inert. No migration.

**Observable signals:** the invocation ledger (per-op, per-checkpoint, fault flag,
seq); deterministic replay digests; the `list`/`inspect` zero-resource projection;
the boundary-check pass/fail line in `policy`.

**RED → GREEN:**
- RED: `fixture-determinism.test.ts` (two replays diverge before the runtime
  exists); `checkpoint-fault-injection.test.ts` (each checkpoint fault not yet
  honored); `reset-isolation.test.ts` (residual invocations/resources);
  `invocation-inspection.test.ts` (ledger missing/incomplete);
  `contract-self.test.ts` (core-op conformance unmet); boundary check RED if a
  forbidden import is present.
- GREEN: implement the two packages; run the DEP-000 focused command (local + CI)
  and the two leaf typecheck/build gates. Foundation checker stays green.

**Evidence / commit:** `tickets/DEP-000-result.md`; one commit
`feat(deploy-harness): deterministic fixture-driven fake sandbox provider`. Maps
E6F-02, E6F-05 (no-tenant-code seam).

**Internal TDD/commit slices (one ticket, one final reviewer):** A — the
provider-neutral contract package + core/optional op vectors + `contract-self`
against a minimal driver; B — the fake driver + fixture-step interpreter + per-
checkpoint `failureInjection` + event-digest recompute; C — networked control
server + invocation ledger + reset-isolation + boundary check. Each slice ≤1
agent-day and independently green; the distinct reviewer reruns the combined
suite and alone completes the ticket.

---

### DEP-001 — Separate signed control-plane and worker images (M, ≤3 agent-days, FOUNDATION)

**Depends on:** WRK-001 (worker package + entrypoint — **not built**, E4),
FND-005 (root build-input pinning — built). **Blocked on E4.**

**Outcome:** Pinned, non-root, read-only-root control-plane and worker images with
distinct dependencies/permissions, a minimum SBOM, source provenance, test-root
signing, and an admission verifier that D1 uses to accept only recorded signed
digests and reject tampered/unsigned ones.

**Ticket non-goals:** release-root signing, vulnerability policy, attestation
breadth (all REL-004); compose topology (DEP-002); the worker daemon's runtime
behavior (WRK-001/004).

**Files:**
- Create `docker/control-plane/{Dockerfile,entrypoint.sh}` — server+UI, pinned
  base **by digest**, non-root, read-only root, `HEALTHCHECK /api/health`, OCI
  revision/version/source labels; **no** docker-cli/worker/agent CLIs.
- Create `docker/worker/{Dockerfile,entrypoint.sh}` — `packages/worker-daemon` daemon
  only, pinned base by digest, non-root, read-only root, local health/metrics;
  **no** UI/server/db/drizzle.
- Create `docker/images/{build.sh,sbom.sh,sign.sh,allowlist.json,provenance.sh}`
  (reproducible build, min SBOM, test-root cosign signing, recorded signed digests,
  provenance label injection).
- Create `scripts/verify-image-admission.mjs` + pure `scripts/lib/image-admission.mjs`
  (verify signature+provenance against the test root; admit only allowlisted
  digests; reject tampered/unsigned fail-closed).
- Modify `.github/workflows/pr.yml` Dockerfile-deps validator to cover both new
  Dockerfiles (each `deps` stage copies exactly its dependency closure); wire the
  admission-lib test into `policy` and the image jobs into DEP-004's lanes.
- Create tests: `scripts/lib/__tests__/image-admission.test.mjs` (node --test:
  allow recorded digest, reject tampered digest, reject unsigned, provenance
  mismatch); `docker/images/__tests__/{image-contents,image-startup-smoke}.test.mjs`
  (assert tooling exclusion, non-root user, read-only root, health/version/source
  metadata, reproducible source linkage — **built-image lane, Linux/CI only**).

**Interfaces:** `image-admission.mjs` → `evaluateAdmission({digest, signature,
provenance, allowlist, trustRoot}) → {admitted:boolean, reason}`. Images expose
`org.opencontainers.image.revision` = recorded source SHA; `/api/health` (control
plane) and local `/metrics`/`/health` (worker).

**Acceptance (incl. failure behavior):** the control-plane image contains **no**
Docker or worker tooling and the worker image contains **no** UI/server/DB
tooling (image-contents test); both run non-root on a read-only root; both expose
health/version/source metadata; the admission verifier **admits** a recorded
signed digest and **rejects** one tampered digest and one unsigned digest
(fail-closed, non-zero); a build missing the provenance label **fails**; a
worker-image `deps` stage that would pull server/db **fails** the extended
deps-validator.

**Compatibility / rollback:** additive `docker/control-plane/`, `docker/worker/`,
`docker/images/`, and one CI validator extension; the combined `Dockerfile` and
`docker.yml` are untouched (REL-004 owns the release cutover). Test roots only —
never release trust. No migration.

**Observable signals:** SBOM artifacts per image; the signed-digest allowlist; the
admission verifier's admit/reject reason lines; image labels (revision/version/
source); the deps-validator pass/fail.

**RED → GREEN:**
- RED: `image-admission.test.mjs` (tampered/unsigned currently admitted or
  verifier absent); `image-contents.test.mjs` (combined tooling still present /
  images not yet split); startup-smoke RED (no image).
- GREEN: author both Dockerfiles + supply-chain scripts + admission lib; run the
  local admission lane always, and the **Linux/CI** image build+contents+smoke
  lane. Extend and keep the deps-validator green.

**Evidence / commit:** `tickets/DEP-001-result.md`; one commit
`feat(deploy-harness): split signed least-privilege control-plane and worker images`.
Maps E6F-06, E6F-05 (topology least-privilege inputs).

**Internal TDD/commit slices:** A — control-plane image + entrypoint + deps-
validator extension + contents test; B — worker image + boundary/deps closure +
contents test; C — SBOM/provenance/test-root signing + admission verifier +
allow/deny + startup smoke. Each ≤1 agent-day, independently green; one distinct
reviewer completes.

---

### DEP-002 — D1 Docker Compose topology (M, ≤3 agent-days, FOUNDATION)

**Depends on:** DEP-000, DEP-001, TEN-002 (tenant kernel — passed).

**Outcome:** An isolated-network Compose stack with PostgreSQL, MinIO, one
control-plane replica, ≥2 workers with distinct registered profiles, the fake
provider, Toxiproxy, and a test runner; no shared writable volume; worker cannot
reach PostgreSQL; control plane reaches provider control only through declared
APIs; deterministic startup.

**Ticket non-goals:** the migration job/readiness gate content (DEP-003 provides
the `migrate` service body + readiness); Toxiproxy fault campaigns and clock
control (DEP-005/006); the CI merge-train job (DEP-004); the second control-plane
replica (DEP-009).

**Files:**
- Create `docker-compose.d1.yml` (`name: aoa-d1`) — the four segmented networks
  and the services in §2.3; `depends_on: {condition: service_healthy}`; per-service
  named volumes / read-only mounts; consumes only DEP-001 admitted image digests.
- Create `docker/d1/{.env.example,toxiproxy.json,worker-a.profile.json,
  worker-b.profile.json,minio-init.sh,README.md}` — env, proxy definitions,
  two **distinct** registered target profiles, MinIO bucket bootstrap.
- Create `scripts/check-d1-compose.mjs` + pure `scripts/lib/d1-compose-invariants.mjs`
  (static: assert network attachment matrix, no worker on `data-net`, no shared
  `rw` volume, control-plane→provider-control not wired, images are admitted
  digests) — runnable **locally**.
- Create tests: `scripts/lib/__tests__/d1-compose-invariants.test.mjs` (node
  --test, local); `tests/d1/network-denial.test.mjs` and
  `tests/d1/fake-provider-job.test.mjs` (**Linux/CI, compose up**: worker→postgres
  TCP refused; control-plane→fake control endpoint refused but declared API
  reachable; one submit→placement→lease→ACK→fake-execute job succeeds).

**Interfaces:** `d1-compose-invariants.mjs` →
`evaluateComposeInvariants(parsedCompose) → {violations: string[]}` (empty =
pass). Worker profiles are `registeredTargetProfileV1`-shaped and distinct
(different capability/slot/locality mix so placement can pick between them).

**Acceptance (incl. failure behavior):** the static validator passes on the
committed compose and **fails** if a worker is attached to `data-net`, if two
services share an `rw` volume, if the control-plane is wired to the provider
control endpoint, or if any image is an unadmitted digest; live, a worker's TCP
connect to `postgres:5432` is **refused**, the control-plane's connect to the fake
control endpoint is **refused** while its declared API is reachable, and one
fake-provider job completes end to end; startup is deterministic (no service
serves before its `service_healthy` deps).

**Compatibility / rollback:** additive `docker-compose.d1.yml` + `docker/d1/` +
one static validator; existing compose files untouched; the stack is dormant until
explicitly brought up. No migration.

**Observable signals:** `docker compose config` render; the invariant validator's
violation list; per-service health transitions; the network-denial test outcomes;
the single fake-provider job's terminal state.

**RED → GREEN:**
- RED: `d1-compose-invariants.test.mjs` against a deliberately-wrong fixture
  compose (worker on `data-net`, shared volume) must flag violations before the
  lib exists; `network-denial.test.mjs`/`fake-provider-job.test.mjs` RED with no
  stack.
- GREEN: author `docker-compose.d1.yml` + `docker/d1/*` + the invariant lib; run
  the local static lane always and the **Linux/CI** live lane.

**Evidence / commit:** `tickets/DEP-002-result.md`; one commit
`feat(deploy-harness): isolated D1 compose topology with network-denial proofs`.
Maps E6F-03, E6F-05, E6F-01 (two-profile placement substrate).

**Internal TDD/commit slices:** A — networks/services/volumes + static invariant
lib + wrong-fixture RED; B — two distinct worker profiles + fake-provider + MinIO
init + admitted-image wiring; C — Toxiproxy in-path + live network-denial + one
fake-provider job. Each ≤1 agent-day; one distinct reviewer completes.

---

### DEP-003 — Migration job and readiness contract (M, ≤3 agent-days, FOUNDATION)

**Depends on:** DEP-002, TEN-001 (passed).

**Outcome:** Privileged migrations separated from application startup; distinct
liveness/readiness/dependency health; and the preserved fail-closed populated-
instance migration-0188 snapshot/marker preflight (operator opt-in + candidate
SHA, snapshot-before-marker, checksum + isolated restore-validation, marker
verify, idempotent).

**Ticket non-goals:** rewriting migration `0188` itself; enabling any real
Organization/workload cutover (E10 MIG owns authority transfer); dropping the
sentinel org (`0210`); worker-daemon health internals (WRK-001).

**Files:**
- Create `packages/db/src/schema/distributed_cutover_markers.ts` + export in
  `schema/index.ts`; generate the normal migration + the custom RLS migration
  (slug **`distributed_cutover_marker`**; `aoa_operator` write, `aoa_app` read,
  tenants none; C14/Decision #122 idempotent role/GRANT/ENABLE/FORCE/POLICY only).
- Create `packages/db/src/migrate-job.ts` (privileged, idempotent, non-destructive
  migration runner, distinct from `src/migrate.ts` app path) and
  `docker/control-plane/migrate-entrypoint.sh`.
- Create `server/src/services/cutover-0188-preflight.ts` (orchestrator; injected
  object-store + pg-dump/restore ports) and `server/src/services/
  cutover-0188-preflight-state.ts` (pure fail-closed state machine).
- Create `server/src/services/schema-compatibility.ts` (compare applied migration
  identity vs `loadRequiredMigrationIdentity()`); create
  `server/src/routes/readiness.ts` (`/api/ready`); modify
  `server/src/routes/health.ts` (add `/live` liveness; keep `/api/health`) and add
  a readiness-gate middleware in `server/src/app.ts` that 503s tenant/app routes
  until ready.
- Create tests: `server/src/__tests__/cutover-0188-preflight.test.ts` (pure:
  no-opt-in, snapshot failure→no marker, checksum mismatch, isolated restore-
  validation failure, marker-write failure, marker-verify failure, idempotent
  repeat, unavailable object store/provider); `server/src/__tests__/
  readiness-liveness.test.ts` (liveness up while readiness down; dependency
  health); `packages/db/src/__tests__/distributed-cutover-marker-schema.integration.test.ts`
  (embedded PG: marker table + RLS matrix); `server/src/__tests__/
  migration-readiness.integration.test.ts` (old schema→503, new→ready; failed
  migration non-destructive; app startup never writes the marker);
  `server/src/__tests__/migration-rollback-startup.integration.test.ts`
  (incompatible newer schema → refuse serve).

**Interfaces:** `cutover-0188-preflight-state.ts` → a deterministic transition
function over `{optIn, candidateSha, imageSha, snapshotResult, checksumResult,
restoreValidationResult, markerWriteResult, markerVerifyResult}` →
`{action:"proceed"|"stop", markerWritten:boolean, reason}`. Readiness →
`{live:true, ready:boolean, schemaCompatible:boolean, dependencies:{postgres,
minio}}`. Marker row: `{candidateSha, snapshotRef, snapshotChecksum, verifiedAt}`.

**Acceptance (incl. failure behavior, verbatim contract):** the control plane does
**not** serve before a compatible schema (readiness 503, not crash); worker
readiness requires valid session/provider health; failed migrations do **not**
loop destructively (idempotent, bounded, fail-closed exit). The first populated
single-tenant→`cloud_auth` flip requires **explicit operator intent + exact
candidate SHA**, takes and **checksum-validates** a snapshot **before** writing the
durable `0188` marker, **validates that snapshot by restoring it to an isolated
pre-cutover database**, **verifies the marker**, and is **idempotent**. Missing
opt-in, snapshot/restore-validation failure, marker-write failure, or verification
failure **stops before deployment/cutover with no marker written**; **application
startup cannot auto-bypass** the gate (startup reads, never writes/synthesizes,
the marker). Unavailable object store/provider → stop, no marker. Rollback-startup:
an incompatible newer schema refuses to serve.

**Compatibility / rollback:** additive marker table + custom RLS migration + two
readiness routes + one startup middleware; the preflight is **opt-in** and dormant
unless the operator sets opt-in + candidate SHA; single-tenant deployments never
trigger it; `pnpm db:migrate` behavior for non-cutover migrations is unchanged;
flag-off leaves app startup unchanged except the additive readiness split.

**Observable signals:** `/api/ready` JSON (ready/schemaCompatible/dependencies);
the migration-job exit code + step log (opt-in → snapshot → checksum → restore-
validate → marker-write → marker-verify); the durable marker row; the readiness-
gate 503s while incompatible.

**RED → GREEN:**
- RED: `cutover-0188-preflight.test.ts` (each fail-closed case currently proceeds
  or writes a marker); `readiness-liveness.test.ts` (readiness not distinguished);
  `distributed-cutover-marker-schema.integration.test.ts` (table/RLS absent);
  `migration-readiness.integration.test.ts` (serves before compatible schema; app
  startup writes marker); `migration-rollback-startup.integration.test.ts`
  (serves on incompatible newer schema).
- GREEN: schema + custom RLS migration (generate via the C14 recipe), migrate-job
  entrypoint, preflight state machine + orchestrator, schema-compat + readiness
  routes + startup gate. Run the DEP-003 pure lane locally, the embedded-PG lane
  via `Invoke-E3Integration`, and the live migration-job container on **Linux/CI**.

**Evidence / commit:** `tickets/DEP-003-result.md`; one commit
`feat(deploy-harness): privileged migration job, readiness contract, and 0188 cutover preflight`.
Maps E6F-07, E6F-03 (readiness in the smoke).

**Internal TDD/commit slices:** A — liveness/readiness/dependency split + schema-
compatibility serving gate; B — privileged migration-job entrypoint separated from
app startup + marker schema/RLS; C — the fail-closed 0188 preflight state machine +
snapshot/checksum/isolated-restore-validation/marker-verify + idempotent repeat.
Each ≤1 agent-day; one distinct reviewer completes.

---

### DEP-004 — Focused and merge-train CI lanes (M, ≤3 agent-days, FOUNDATION)

**Depends on:** FND-005 (passed), DEP-002.

**Outcome:** Path-filtered unit/contract jobs whose protocol/schema paths trigger
their mandatory consumers, plus a D1 distributed merge-train job that retains
distributed logs, events, database state, and object manifests on failure.

**Ticket non-goals:** release/publish workflows (`release.yml`/`docker.yml` stay
as-is); the full D1 fault volume (owning tickets + D1); adding a trigger-level
`paths:` filter (forbidden — routes through `ci-required`).

**Files:**
- Modify `.github/workflows/pr.yml`: extend the `changes` job to emit `protocol`,
  `schema`, `fixtures`, `provider`, `compose` path-class outputs; add a
  `distributed-contract` job (runs the DEP-000 contract + fixture-determinism +
  foundation checker + DEP-003 preflight suites) gated on those classes; add it to
  `ci-required.needs` and to the aggregator verdict (required **only when** its
  class changed, mirroring the `code`-gated pattern).
- Create `.github/workflows/d1-merge-train.yml` (`merge_group` + push-to-main):
  bring up `docker-compose.d1.yml`, run a bounded E6F subset, upload the evidence
  bundle on failure via `actions/upload-artifact`.
- Create `scripts/collect-d1-evidence.mjs` + pure `scripts/lib/d1-evidence-bundle.mjs`
  (assemble logs/events/DB-state/object-manifest bundle) and
  `scripts/check-ci-lanes.mjs` + pure `scripts/lib/ci-lanes.mjs` (assert every
  protocol/schema/provider path class maps to a mandatory consumer in
  `ci-required`, no trigger-level `paths:`/`paths-ignore:`, merge-train uploads
  the required evidence on failure).
- Create the deliberate-failing-fixture proof: `tests/d1/fixtures/
  deliberate-failure.mjs` + `tests/d1/evidence-retention.test.mjs` (assert the
  evidence bundle is assembled on failure).
- Create tests: `scripts/lib/__tests__/{ci-lanes,d1-evidence-bundle}.test.mjs`
  (node --test, local: valid config passes; a protocol path with no consumer
  fails; a trigger-level `paths:` fails; a merge-train missing evidence-upload
  fails; the bundle contains logs/events/DB-state/object-manifest sections).

**Interfaces:** `ci-lanes.mjs` → `evaluateCiLanes({workflows, requiredNeeds}) →
{violations: string[]}`. `d1-evidence-bundle.mjs` → `buildEvidenceBundle(inputs) →
{sections:{logs,events,dbState,objectManifests}, manifest}`.

**Acceptance (incl. failure behavior):** a protocol/schema/provider path change
triggers `distributed-contract`, and `ci-required` marks it required for that PR; a
docs-only PR skips it (and `ci-required` allows the skip); the static ci-lanes
validator **fails** if a protocol/schema path has no mandatory consumer, if any
trigger-level `paths:`/`paths-ignore:` is present on `pr.yml`, or if the merge-train
lacks evidence-upload-on-failure; the deliberate-failing fixture turns the
merge-train red and the evidence bundle (distributed logs, events, DB-state,
object manifests) is **retained**.

**Compatibility / rollback:** additive `changes` outputs, one new conditional job
routed through `ci-required`, one new workflow, and static validators; no
trigger-level path filter; `release.yml`/`docker.yml` untouched. No migration.

**Observable signals:** the `changes` path-class outputs; `ci-required`'s verdict
line naming `distributed-contract`; the merge-train artifact bundle on failure; the
ci-lanes validator's violation list.

**RED → GREEN:**
- RED: `ci-lanes.test.mjs` (a fixture workflow with an unconsumed protocol path /
  a trigger-level `paths:` / a merge-train missing evidence-upload must flag
  violations before the lib exists); `d1-evidence-bundle.test.mjs` (bundle missing
  a required section); `evidence-retention.test.mjs` RED with no collector.
- GREEN: extend `changes`; add `distributed-contract` + wire `ci-required`; author
  `d1-merge-train.yml` + evidence collector; author the validators. Run the local
  pure lane always; prove the merge-train + deliberate-failing fixture on
  **Linux/CI**.

**Evidence / commit:** `tickets/DEP-004-result.md`; one commit
`feat(deploy-harness): path-filtered contract lanes and D1 merge-train with retained evidence`.
Maps E6F-07 (retained failure evidence), and the CI substrate for E6F-01..06.

**Internal TDD/commit slices:** A — `changes` path-class extension + static
ci-lanes validator + node --test; B — `distributed-contract` mandatory-consumer
job + `ci-required` wiring; C — `d1-merge-train.yml` + evidence collection/
retention + deliberate-failing-fixture proof. Each ≤1 agent-day; one distinct
reviewer completes.

---

## 5. Existing-infra crosswalk (what DEP extends vs leaves authoritative)

| Concern | Existing authority | DEP disposition |
|---|---|---|
| Sandbox provider seam | `server/src/services/sandbox-provider-runtime.ts` (`SandboxRuntimeProvider`; in-process `fake`, `e2b`, `gvisor`) | DEP-000 adds a **networked, fixture-driven, invocation-inspectable** fake implementing WRK-004's port; it does **not** replace the in-process CI stand-in or invent a second registry. |
| Container image | combined `Dockerfile` (+ `docker-cli`, server, UI, CLIs) | DEP-001 adds **split** least-privilege images; the combined image + `docker.yml` remain for existing single-image deploy until REL-004. |
| Compose stacks | `docker-compose.yml` (prod), `docker-compose.research.yml` (E2E), `docker-compose.quickstart.yml` | DEP-002 adds `docker-compose.d1.yml`; existing stacks untouched. |
| Migration path | `pnpm db:migrate` = `tsx packages/db/src/migrate.ts`; `0188_organizations.sql`; `loadRequiredMigrationIdentity()` | DEP-003 adds a **privileged** `migrate-job.ts` + readiness gate + fail-closed 0188 preflight; `0188` itself and normal `db:migrate` are unchanged. |
| CI gate | `pr.yml` (`changes`,`policy`,`ci-required`), `docker.yml` | DEP-004 extends `changes`, adds one conditional consumer + a merge-train workflow; **no** trigger-level path filter; verdict via `ci-required`. |
| Fixtures + digest checker | `tests/fixtures/distributed-execution/`, `scripts/check-distributed-execution-foundation.mjs` | DEP-000/DEP-004 reuse and keep green; no fixture schema change. |

---

## 6. Failure-mode coverage and observable signals

| Failure mode | Owning ticket(s) | Detection / signal |
|---|---|---|
| Tenant/server/db code reachable from the host worker/fake | DEP-000 | `check-sandbox-fake-provider-boundary.mjs` fail-closed in `policy`. |
| Non-deterministic fixture replay / residual resources after cleanup | DEP-000 | determinism + reset-isolation suites; `list`/`inspect` zero-resource projection (E6F-02). |
| Fault not honored at a lifecycle checkpoint | DEP-000 | per-checkpoint fault-injection suite over `failureInjection`. |
| Combined tooling in an image / root user / writable root | DEP-001 | image-contents test (Linux/CI); non-root + read-only-root assertions. |
| Unsigned/tampered image admitted | DEP-001 | `image-admission` allow/deny (node --test) — fail-closed. |
| Worker reaches PostgreSQL / control-plane reaches provider control | DEP-002 | static invariant validator + live network-denial (E6F-05). |
| Shared writable volume | DEP-002 | static `rw`-mount uniqueness check. |
| Control plane serves before compatible schema | DEP-003 | readiness 503 + `migration-readiness` integration test. |
| Destructive migration loop | DEP-003 | idempotent non-destructive migrate-job; rollback-startup test. |
| 0188 marker synthesized without opt-in/snapshot/restore-validate/verify | DEP-003 | pure preflight state machine (each fail-closed case) + app-startup-never-writes assertion (E6F-07). |
| Protocol/schema change with no mandatory consumer / silent trigger-skip | DEP-004 | `check-ci-lanes.mjs` fail-closed in `policy`. |
| Merge-train failure loses evidence | DEP-004 | evidence-bundle lib + `upload-artifact` on failure + deliberate-failing-fixture proof. |

Retention: gate summaries live in Git permanently; controlled raw distributed
logs/events/DB-state/object manifests are retained on failure per the merge-train
lane. High-cardinality tenant identifiers stay in access-controlled logs, never
in metric labels.

---

## 7. Gate traceability — `E6-D1-FOUNDATION`

### 7.1 E6F requirement → owning evidence

| Requirement (`test-gates.md`) | Owning evidence |
|---|---|
| **E6F-00** scope + dependency closure | DEP-000–004 on one revision **plus** TEN-002 (passed), JOB-003 (E3 — must be `complete`), WRK-004 (E4 — must be `complete`). The controller records each upstream QA/handoff path + SHA in the gate record. |
| **E6F-01** 100 submit→placement→lease→ACK races across ≥2 registered profiles, one winner each | DEP-002 two distinct worker profiles + JOB-001/009/003 control-plane path; the gate campaign runs 100 races on the live stack. |
| **E6F-02** 25 fake-provider create→execute→kill/destroy fault cases, deterministic reset, zero resources | DEP-000 fixture-driven fake + per-checkpoint fault injection + `list`/`inspect` zero-resource projection. |
| **E6F-03** one networked end-to-end smoke (PG, MinIO, control plane, worker, fake provider, runner) | DEP-002 stack + DEP-003 readiness + the single fake-provider job. |
| **E6F-04** zero cross-Organization reads/existence disclosures in the available submit/enroll/placement/lease paths | E2 `runInTenant` + JOB-001/002/003 tenancy; the gate's hostile cross-Org matrix on the live stack. |
| **E6F-05** topology boundaries (no shared rw volume; no worker DB reach/credential; no control-plane/worker-host tenant-command execution; only declared provider-control access) | DEP-002 network-denial + static invariants; DEP-000 no-tenant-code boundary; DEP-001 least-privilege images. |
| **E6F-06** pinned images from recorded source, non-root/read-only-root, test-root signature/provenance verify, reject one tampered digest | DEP-001 build + admission verifier + image-contents/startup. |
| **E6F-07** migration/readiness behavior + retained evidence from one deliberate failing fixture | DEP-003 readiness + fail-closed preflight; DEP-004 merge-train evidence retention + deliberate-failing fixture. |
| **E6F-08** explicit non-certification list | The QA record lists renewal/fence loss, event ingestion/outbox, cancellation/retry, artifact/secret/quarantine, full D1 fault volume, real-provider isolation, two-replica HA, and release signing policy as **not certified** — owned by their tickets + full D1/D2. |

### 7.2 Closure dependencies (must be `complete`/`pass` on one revision)

- **TEN-002** (E2 tenant kernel) — passed at `7843b86e25eb1ff9c520308aef7f123fec6997a7`.
- **JOB-003** (E3 lease/ACK) — currently `needs_changes`; **must be `complete`**
  before the gate can run.
- **WRK-004** (E4 sandbox supervisor / provider-driver port) — **not built**;
  **must be `complete`** (it also unblocks DEP-000/001 assignment).
- **DEP-000–004** — all `complete` on the **same main revision**.

### 7.3 Independent gate procedure (Integration Gate Owner)

1. The Integration Gate Owner **implemented/reviewed no DEP ticket** and is
   distinct from the Security Gate Owner.
2. Freeze one implementation candidate after all five DEP reviewer-completed
   ledgers **and** the TEN-002/JOB-003/WRK-004 closure exist on one revision.
3. Build workspace packages, then run the focused DEP lanes (§3) once more on the
   frozen revision, then bring up `docker-compose.d1.yml` from DEP-001 **admitted
   image digests** only.
4. Run the gate campaign (Linux CI is the DEC-03 authority; a Linux docker host
   locally is operator-directed evidence only):

   ```powershell
   $env:AOA_RUN_WIN_INTEGRATION='1'
   $env:AOA_E6F_LEASE_RACES='100'; $env:AOA_E6F_TARGET_PROFILES='2'
   $env:AOA_E6F_PROVIDER_FAULTS='25'
   try {
     Invoke-NativeGate 'E6-D1-FOUNDATION races (E6F-01)'   { node --test tests/d1/e6f-01-lease-races.test.mjs }
     Invoke-NativeGate 'E6-D1-FOUNDATION faults (E6F-02)'  { node --test tests/d1/e6f-02-provider-faults.test.mjs }
     Invoke-NativeGate 'E6-D1-FOUNDATION smoke (E6F-03)'   { node --test tests/d1/e6f-03-networked-smoke.test.mjs }
     Invoke-NativeGate 'E6-D1-FOUNDATION tenancy (E6F-04)' { node --test tests/d1/e6f-04-tenancy.test.mjs }
     Invoke-NativeGate 'E6-D1-FOUNDATION topology (E6F-05)'{ node --test tests/d1/network-denial.test.mjs }
     Invoke-NativeGate 'E6-D1-FOUNDATION images (E6F-06)'  { node --test docker/images/__tests__/image-contents.test.mjs }
     Invoke-NativeGate 'E6-D1-FOUNDATION failure (E6F-07)' { node --test tests/d1/evidence-retention.test.mjs }
   }
   finally {
     Remove-Item Env:AOA_E6F_LEASE_RACES,Env:AOA_E6F_TARGET_PROFILES,Env:AOA_E6F_PROVIDER_FAULTS,Env:AOA_RUN_WIN_INTEGRATION -ErrorAction SilentlyContinue
   }
   ```

   The suites emit the ordered race seeds + single-winner proofs, the 25 fault
   cases with deterministic reset and zero post-reconciliation resources, the
   networked smoke trace, the cross-Org zero-disclosure matrix, the topology
   denial results, the image policy proofs, and the retained deliberate-failure
   evidence bundle. Run the E6F-04/E6F-05 subset three consecutive times.
5. Any isolation-invariant or tenancy failure is a **non-waivable `fail`**, never
   conditional.
6. The Gate Owner writes an immutable
   `qa/<UTC-date>-e6-d1-foundation-<scope>-<sha12>-a<attempt>.md` (Lane
   `E6-D1-FOUNDATION`; Result `pass|fail|blocked_external`; Failure class
   `none|product|harness|provider|environment`; the E6F-00..08 assertions table
   with Class `REQUIRED|HARD|INITIAL|OBSERVED`, required vs observed, and evidence
   links). The distinct Security Gate Owner verifies the raw archive and writes
   `handoffs/<UTC-date>-e6-d1-foundation-<sha12>-a<attempt>.md` (Gate slug
   `e6-d1-foundation`; Decision `pass|fail|blocked_external`; pinning each DEP
   ticket-result blob SHA + reviewed implementation SHA + latest disposition, the
   TEN-002/JOB-003/WRK-004 closure evidence, and the QA record blob). Both are
   write-once; a rerun is a new attempt with `Supersedes`.
7. Only a `pass` QA **and** `pass` handoff on the **same** revision unblock JOB-004
   through JOB-008, JOB-011 through JOB-014, and WRK-005 onward. This gate does
   **not** certify the event outbox, full failure harness, staging, managed-provider
   isolation, two-replica HA, or release readiness (E6F-08).

---

## 8. Controller sequence and parallelization

```text
WAIT FOR committed passing E4 handoffs: WRK-001 (image) + WRK-004 (provider port)
WAIT FOR JOB-003 complete (E3)

FOUNDATION (this plan):
  DEP-000 (fake provider) ----+
                              +--> DEP-002 (compose) --> DEP-003 (migration/readiness)
  DEP-001 (split images) -----+           |
                                          +--> DEP-004 (CI lanes + merge-train)

  all five DEP reviews + TEN-002/JOB-003/WRK-004 closure
     -> independent E6-D1-FOUNDATION QA + handoff
     -> unblocks JOB-004..008, JOB-011..014, WRK-005+
```

DEP-000 and DEP-001 are independent of each other (fake-provider packages vs image
build) and may run in parallel worktrees once E4 lands; DEP-002 joins them and
depends on TEN-002; DEP-003 follows DEP-002; DEP-004 follows DEP-002 and may run in
parallel with DEP-003 (different file areas: CI/workflows vs migration/readiness).
Because DEP-002/003/004 touch overlapping compose/CI surface, the default single-
worktree sequence serializes DEP-002 → DEP-003 → DEP-004 to avoid compose/workflow
merge repair.

| Step | Modules touched | Depends on |
|---|---|---|
| Fake provider | `packages/sandbox-fake-provider`, `packages/sandbox-provider-contract`, `scripts/*boundary*` | WRK-004, FND-004 |
| Split images | `docker/control-plane`, `docker/worker`, `docker/images`, `scripts/*admission*`, `pr.yml` deps-validator | WRK-001, FND-005 |
| Compose topology | `docker-compose.d1.yml`, `docker/d1`, `scripts/*d1-compose*`, `tests/d1` | DEP-000, DEP-001, TEN-002 |
| Migration/readiness | `packages/db/schema+migrate-job`, `server/routes/{health,readiness}`, `server/services/cutover-0188-preflight*` | DEP-002, TEN-001 |
| CI lanes | `pr.yml`, `d1-merge-train.yml`, `scripts/*ci-lanes*`, `scripts/*d1-evidence*` | FND-005, DEP-002 |

### Commit/evidence boundaries

- One implementer code commit per ticket (`feat(deploy-harness): …`); the reviewer
  follow-up commit contains the append-only review result and is the only commit
  that completes the ticket (plain `git commit`, never `--no-verify`).
- Migration slugs are fixed per ticket: **DEP-003 = `distributed_cutover_marker`**
  (+ `distributed_cutover_marker_rls`); the coalesced drizzle diff is recorded
  once and never renumbered by a later ticket.
- `findings.md` uses stable `E6-F<nnn>` IDs (never deleted); `decisions.md` uses
  `E6-D<nn>` / `#<product>` promotion. A behavior-changing plan edit after
  execution begins requires a `decisions.md` entry + an Integration-Gate-Owner-
  reviewed amendment.

---

## 9. Planner self-review

- All five DEP-000..004 canonical outcomes, dependencies, acceptance (incl. failure
  behavior), and tests are represented; each is `M, ≤3 agent-days` with A/B/C
  slices, and none claims the exemption reserved for parity/matrix tickets.
- Forward dependencies are honored as hard STOPs: DEP-000/DEP-001 are blocked on
  WRK-004/WRK-001 (E4 absent), and the gate is blocked on JOB-003 + WRK-004 — no
  ticket invents the missing worker port, worker package, or a second provider
  registry.
- Provider-neutrality is preserved end to end (opaque provider IDs, frozen op
  vocabulary, no E2B fields; CAV-002); test roots only for DEP-001 (REL-004 owns
  release roots); the 0188 preflight is fail-closed and app-startup can never
  synthesize the marker.
- Every ticket names a focused test lane with exact commands and labels which are
  Linux/CI-only (docker/compose/image) vs runnable locally (pure leaf, `node
  --test`, or embedded-PG via `Invoke-E3Integration`); Linux CI under DEC-03 is the
  formal authority.
- The `E6-D1-FOUNDATION` gate maps E6F-00..08 to owning evidence, states the
  TEN-002/JOB-003/WRK-004 closure, and specifies the independent QA record +
  handoff (slug `e6-d1-foundation`) with the explicit non-certification list — it
  is neither D1 promotion nor E6 completion.
- CI conditional execution routes through `ci-required` (no trigger-level `paths:`,
  no independently-required conditional check), preserving the aggregator-gate
  invariant.
