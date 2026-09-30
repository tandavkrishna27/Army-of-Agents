# E7-1 staging-canary campaign — operator-ready plan (assembled + source-verified)

**Date:** 2026-08-28 · **Worktree:** `C:\e3` · **Branch:** `docs/replatform-program` · **Tip:** `2753a1fe9`
**Scope:** read-only planning/prep. Assembles the existing E7-1 material into an operator-ready campaign
plan and identifies the session-buildable de-risk. **Nothing was edited/committed; no skill run.**

**Sources assembled (not re-derived):** `epics/E7-coding-e2b/tickets/CLI-006-staging-canary-runbook.md`
(the runbook), `CLI-006-campaign-result.md`, `CLI-006-seam-plan.md`, `CLI-007-result.md`; GO-BOOK §1.5,
§4 "Sprint 5", §9 "Sprint 5b"; `docker-compose.staging.yml`; `.github/workflows/deploy-testing.yml`;
`docs/deploy/staging.md`. **Every runbook claim below was re-verified against source at `2753a1fe9`
(the runbook was written at `07f80a165`) — see §1. No drift found.**

---

## 0. TL;DR + the headline STOP flag

- **E7-1 is code-complete and honestly `unwired`.** CLI-007 (Sprint 5a) removed the last code blocker
  (the canary now mints a real Company credential); the campaign harness + runbook are ready. What is
  owed is purely an **operator-dispatched, real-E2B run of the DISTRIBUTED journey** on a live staging
  fleet. (`gate-clause-wiring.json:69-75`; `CLI-006-campaign-result.md` §4; GO-BOOK §1.5.)
- **★ HEADLINE STOP FLAG: the campaign is gated on a fleet deploy that is NOT a quick operator action and
  is NOT ticketed.** `docker-compose.staging.yml` is a deployment-INTENT manifest, render-checked only;
  the live deploy pipeline (`deploy-testing.yml` → `scripts/deploy/remote-compose-deploy.sh`) deploys the
  **single-node `docker-compose.yml` app**, never the fleet. Bringing up the 2-control-plane / 4-worker /
  adapter-manager fleet against **16 external `AOA_STAGING_*` inputs** (3 Postgres DBs, S3 ×4, realtime,
  signing key, 3 image digests, E2B key+domain) is a real multi-host / external-store stand-up. It is
  deferred "to the deploy pipeline (`scripts/deploy/*`) / a REL ticket" (`docs/deploy/staging.md`
  "Deferred") — **and no such ticket is scoped today.** **The honest next step is that deploy-pipeline
  task, not the campaign.** (Detail in §5.)
- **The session-buildable de-risk (§4):** the arming path has ~6 SILENT legacy-fallback traps — each one
  lets the operator spend real E2B and get a *legacy* run mistaken for the distributed journey. The
  highest-value session unit is **(A) a post-run evidence verifier** that mechanizes the promotion rule
  (refuse unless `execution_owner="distributed"` + dispatched job id + no leaked key), and **(B) a
  pre-spend readiness check** that fails closed if the substrate is not armed. Both are net-new,
  unit-testable now, and reuse `createCanaryPreflight`. **Worth building — but as the first unit *of* the
  deploy/campaign work, not divorced ahead of a fleet that cannot exercise them.**

---

## 1. Verification at tip `2753a1fe9` (the runbook was written at `07f80a165`)

Every arming fact in `CLI-006-staging-canary-runbook.md` was re-opened against source. **All hold; no
drift.**

| Runbook claim | Verified at source (`2753a1fe9`) | ✓ |
|---|---|---|
| ENABLED flag gates the map, checked FIRST; default false | `config/distributed-execution.ts:22-24,40`; startup needs APP+OPERATOR DB URLs `:50-58` | ✅ |
| ROLLOUT parser accepts `mode ∈ {shadow,active,canary}`; unset ⇒ all `off`; `canary`→placement as `active`; rollback = delete key / set `active`; bad live edit fails CLOSED to legacy | `config/distributed-execution-rollout-source.ts:35,134,159,282,240-254,289-300` | ✅ |
| Preflight enumerates every Company under the Org; requires `currentKeyGeneration !== null` else `credential_authority_not_moved`; plus `assertClosure`; fail-closed on error | `services/canary-preflight.ts:128-201` (`:150-156`, `:170-185`, `:191-200`) | ✅ |
| Key generation = default `e2b` `runtime_provider_keys` row → `company_secret_versions` current version → `<secretId>:<version>`; null when no BYO key | `services/e2b-credential-authority-wiring.ts:20-50` | ✅ |
| Fleet = 2 control planes + 4 workers + adapter-manager + migrate; `AOA_DISTRIBUTED_EXECUTION_ENABLED=true` on BOTH control planes; ROLLOUT **absent**; `E2B_API_KEY` ONLY on adapter-manager (injected from `AOA_STAGING_E2B_API_KEY`) | `docker-compose.staging.yml:60,108,158,196,235,273,316`; `:68,114`; ROLLOUT 0 matches; `:322` | ✅ |
| Distributed fleet NOT deployed; `deploy-testing.yml` = single-node app | `deploy-testing.yml` → `scripts/deploy/remote-compose-deploy.sh:93` composes ONLY `docker-compose.yml`; staging compose is render-checked (`scripts/check-staging-manifest.mjs`), not deployed | ✅ |
| Worker enrollment code TTL = 10 min | `services/worker-enrollment.ts:22` (`CODE_TTL_MS = 10 * 60_000`) | ✅ |
| Concurrency-cap trap: at cap=1 the run counts against itself → 429 → `convert_failed` → SILENT legacy | `CLI-006-seam-plan.md` §"Task 5" (R4); `services/org-concurrency.ts:82-94,136-144`; `admitAttemptCapacity` | ✅ |
| E7-1 `unwired` (symbol `E2bSandboxProvider`, `expectedReferences:2`); E4-1/E4-2 `wired` on evidence (never real E2B) | `gate-clause-wiring.json:33,39,69-75` | ✅ |
| CLI-007 SHIPPED — resolved E7-F001 (guards 2+4); canary mints a real Company `provider_key` | `CLI-007-result.md` §1 | ✅ |

---

## 2. The prerequisite chain (in order; in-place / owed / operator-only)

The canary run resolves distributed ownership only if **all** of these are simultaneously true; any one
missing silently resolves the run back to **legacy** (fail-closed everywhere — never a double-execute).

| # | Prerequisite | State | Who | Source of truth |
|---|---|---|---|---|
| **a** | **Distributed fleet deployed** — `docker-compose.staging.yml` stood up against real external DB/S3/realtime with all 16 `AOA_STAGING_*` set | **OWED — the blocker.** Manifest exists + is render/CI-checked; live bring-up is deferred and unticketed | **Operator-only** (infra), but the *deploy path itself is an owed session/deploy-pipeline task* — see §5 | `docs/deploy/staging.md` "Deferred"; `deploy-testing.yml`; `remote-compose-deploy.sh:93` |
| **b** | **E2B key placed** — `AOA_STAGING_E2B_API_KEY` in the orchestrator secret store, interpolated onto **adapter-manager only** | Owed (comes with the fleet) | **Operator-only.** A provider secret — **never handled by the session** (Decision #104) | `docker-compose.staging.yml:322`; runbook §2.4 |
| **c** | **Canary Org armed** — `AOA_DISTRIBUTED_EXECUTION_ROLLOUT={"organizations":{"<ORG>":{"mode":"canary","workloads":["batch"]}}}` on BOTH control planes (ENABLED already `true` there) | Owed (config; ROLLOUT absent from the manifest by design) | **Operator-only** (touches control-plane env) | `distributed-execution-rollout-source.ts:159,282`; runbook §2.1 |
| **d** | **Company provider key provisioned** (CLI-007 preflight) — a **default `e2b` `runtime_provider_keys`** row with a `current` secret version, for **every** Company under the canary Org, so `currentKeyGeneration !== null` | Owed (per-Company, at campaign time) | **Operator** via board surface: `POST /companies/:cid/secrets` (`name:"provider:e2b"`, `managedMode:"aoa_managed"`) → `POST /companies/:cid/runtime-provider-keys` (`provider:"e2b"`, `isDefault:true`) | `canary-preflight.ts:150-156`; `e2b-credential-authority-wiring.ts:20-50`; runbook §2.2 |
| **e** | **Enrolled worker** — a staging worker target `active` with a ratified placement profile; enrollment code (10-min TTL) written to `AOA_WORKER_ENROLLMENT_CODE_FILE` | Owed (comes with the fleet + one enroll call) | **Operator:** `POST /organizations/:oid/execution-targets/:tid/enrollment-codes` (board actor, `execution_target:manage`) | `worker-enrollment.ts:22`; runbook §2.3 |
| **f** | **Org concurrency cap > 1** — LOAD-BEARING. At cap=1 the suppressed run counts against itself → 429 → `convert_failed` → **silent legacy fallback**; the canary never happens | Owed (config; use `cap=2` on an idle Org) | **Operator** | `CLI-006-seam-plan.md` §"Task 5" (R4); `org-concurrency.ts:82-94,136-144`; runbook §3 step 5 |
| **g** | **Fresh Org, no legacy `environment_leases`** — else the preflight's `assertClosure` needs MIG-008 reconciliation records, which have **no route/job wiring today** → `reconciliation_incomplete` → legacy | Owed (selection constraint) | **Operator** (pick a fresh Org) | `canary-preflight.ts:169-185`; runbook §2.2(a) |

**In-place already:** ENABLED=true on both control planes (`:68,114`); the entire distributed *mechanism*
(E0–E6 built; E4-1/E4-2 wired on evidence); the canary credential path (CLI-007). The gap is purely
**infrastructure (a/b/e) + config (c/d/f/g) that only exist once the fleet is live.**

---

## 3. The exact operator steps + evidence criteria

**Precondition (owed, §5): the fleet is deployed and reachable.** Then, in order (runbook §3):

1. **Pick a FRESH canary Org** (no legacy `environment_leases`), ≥1 Company. *(prereq g)*
2. **Provision the default `e2b` key** for every Company under it (the two `POST`s in prereq d).
3. **Arm the rollout dial** — add the canary JSON (prereq c) to BOTH control planes; roll them.
4. **Enroll the worker(s)** (prereq e); confirm the target is `active` with a ratified placement profile.
5. **Set the Org concurrency cap `> 1`** (prereq f — `cap=2` on an idle Org).
6. **Create ONE coding task** in a canary-Org `software_development` project and watch it traverse:
   **create** (task→job convert) → **schedule** (placement + the CLI-007 mint) → **lease** (a staging
   worker leases the attempt) → **stage** → **execute** (the coding CLI authenticates with the redeemed
   Company key **inside** the E2B sandbox) → **stream** → **produce** (patch) → **review** (projector) →
   **cancel** (fence-revoking) → **audit** (JOB-008, redacted).
7. **Capture the evidence** (below).
8. **Verify non-canary isolation** — a sibling non-canary Org's run stays byte-identically legacy.

### Evidence that proves the DISTRIBUTED journey (what a citation MUST contain — runbook §4)

- The staging **run id / URL** + the canary **`organizationId`**.
- **`heartbeat_runs.execution_owner = "distributed"`** with `distributed_job_id` / `distributed_attempt_id`
  set — **and the legacy `adapter.execute` did NOT run for that run.** ← *the load-bearing discriminator.*
- The attempt reached a **durable terminal state**; the projector wrote run events + a run-summary comment.
- The sandbox authenticated with the **redeemed Company key** (real output) and **no `E2B_API_KEY` /
  redeemed value appears in any log or event** (the S4 redaction canary catches a planted leak — DAT-008
  slice 5).
- **Cancel** reached a durable terminal (fence-revoking); a late worker result is rejected `stale_fence`.
- JOB-008 operator inspection shows the canary's rows **tenant-scoped + redacted**.

### What does NOT promote E7-1 (the primitives, proven separately)

The **keyed provider lane** (`keyed-e2b-conformance.yml`; cited GREEN run
[32995765059](https://github.com/MeteoriteLabs/AoA/actions/runs/32995765059)) proves the provider/adapter
**primitives** on real E2B but never runs create/schedule/lease/review — it does **not** promote E7-1.
Neither does a **D1 fake-provider** run (`d1-merge-train.yml`), nor any **local harness** (incl. Leg B
Part 2 — embedded-PG, synthetic key, no sandbox). (`CLI-006-campaign-result.md` §3; runbook §5.)

> The D1/D2 **volume gates** (≥120 real-E2B jobs, ≥20 per class ×6, three consecutive passing runs, p95
> cancel ≤30s — `test-gates.md` D2 §113-122) are a **separate** operator campaign record; a single golden
> journey does not discharge them. Cite them separately if/when run. (runbook §4.)

---

## 4. What is SESSION-BUILDABLE to de-risk it (the real planning value)

**Why it matters:** every prerequisite in §2 that is missing produces a **SILENT legacy fallback** — the
run completes, real E2B spend may be incurred by the *legacy* path, and the operator can mistake a legacy
run for the distributed journey. This is the programme's central vacuous-green trap "at its highest-stakes
moment" (§9). The `canary-preflight.ts` module gates only **half** the arming surface (credential
authority + reconciliation, prereqs d/g); it does **not** check the dial (c), the concurrency cap (f), or
worker enrollment (e). So there is a genuine, mechanizable gap.

### (A) Post-run evidence verifier — *the promotion-gate mechanization (highest value)*

- **What:** a script/test `verify-e7-1-distributed-run <runId>` that reads the dispatched run and
  **refuses success unless** `heartbeat_runs.execution_owner="distributed"` **and** `distributed_job_id`
  is set **and** the attempt is durably terminal **and** a redaction scan of the run's events/logs finds
  no `E2B_API_KEY`/redeemed value. Exit non-zero (with the failing clause) otherwise.
- **Why it's the top pick:** it directly defends the false-promotion path — it is the difference between
  "operator eyeballs a column" and "a gate refuses to flip `E7-1` on a legacy fallback." It mechanizes
  runbook §4 + §5 into the promotion step itself.
- **Buildable now?** Yes — a pure reader over `heartbeat_runs` + a log/event scan; unit/embedded-PG
  testable with fixtures (a distributed row passes; a legacy row and a planted-leak row each fail).
  Needs no live fleet to *write or test*; only its *execution input* (a real run) is operator-time.

### (B) Pre-spend readiness check — *fails closed before the operator authorizes E2B spend*

- **What:** `canary-readiness <orgId>` that, against the live control-plane DB/env, asserts all of:
  (1) `AOA_DISTRIBUTED_EXECUTION_ENABLED=true`; (2) ROLLOUT contains `<orgId>` in `canary` mode with
  `batch`/`*`; (3) **reuses `createCanaryPreflight().check({organizationId})` verbatim** for prereqs d+g;
  (4) Org concurrency cap `> 1` (prereq f — the R4 trap); (5) ≥1 enrolled target `active` with a ratified
  placement profile (prereq e). Exit non-zero + name the missing clause.
- **Why:** turns the runbook's manual arming checklist into code that fails closed **before** spend — it
  catches exactly the invisible-at-operator-altitude traps (cap=1, ROLLOUT typo, missing default key).
- **Buildable now?** The logic is session-buildable + unit-testable now (it reuses the existing preflight
  and the two config parsers). Its **execution is an operator step** (needs the live substrate), so the
  session builds+tests it; the operator runs it as step 0 of the campaign.

### Verdict — worth it, but scoped as a rider, not a standalone pre-fleet session

Both are genuinely useful and low-risk, and (A) is the honest safeguard on the highest-stakes flip. **But
neither is on the critical path** — the critical path is the fleet deploy (§5), which dwarfs them, and
GO-BOOK §1.5 is explicit that "the well is nearly dry" and the frontier is operator + Lane B, "not more
session units." Building a readiness/evidence pair **ahead of** a fleet that cannot exercise them is
seat-belt-before-car. **Recommendation:** land (A) and (B) as the **first unit of the deploy/campaign
work** (the deploy-pipeline task should inherit them as its acceptance harness), ranking (A) above (B)
(promotion honesty > arming convenience). If a session is spent here before the operator leg, (A) is the
single highest-value thing to build. Do **not** spin a standalone session to build them divorced from the
fleet.

---

## 5. The gating prerequisite (a), examined — is it a quick operator action?

**No.** Three independently-verified facts make the fleet deploy an **owed deploy-pipeline task**, not a
config flip:

1. **No deploy path exists.** `deploy-testing.yml` deploys via `scripts/deploy/remote-compose-deploy.sh`,
   which composes **only** `docker-compose.yml` (`:93`; archive validation requires `docker-compose.yml`
   at `:350,380,564,575,585`). Nothing in `.github/` or `scripts/` deploys `docker-compose.staging.yml`;
   it is referenced only by render-checkers (`check-staging-manifest.mjs`, `d1-merge-train.yml`).
2. **The manifest is intent-only + explicitly deferred.** `docs/deploy/staging.md` "Deferred": *"Real
   multi-host / external-store bring-up … deferred to the deploy pipeline (`scripts/deploy/*`) / a REL
   ticket."* GO-BOOK §1.5 lists E7-1 as 🟡 OWED, *"blocked only on the staging fleet being deployed."*
3. **The infra surface is large.** 16 distinct `AOA_STAGING_*` inputs: three separate Postgres DBs (app
   `AOA_STAGING_APP_DATABASE_URL`, operator `AOA_STAGING_OPERATOR_DATABASE_URL`, migration), S3 (endpoint,
   bucket, region, presign), realtime URL, worker session signing key, three image digests
   (control-plane / worker / adapter-manager), and the E2B key+domain — a real external-store, multi-host
   stand-up.

**And it is unticketed:** no REL ticket concretely owns "deploy `docker-compose.staging.yml` live" — the
existing E11 tickets are REL-003 (DR rehearsal), REL-004 (release gates), REL-FOUNDATION-GATE, DBR-001.
The deferral points at a *class* of work (deploy pipeline / a REL ticket), not a scoped one.

## 6. The operator/session boundary + the promotion rule (stated plainly)

- **The SESSION may:** verify wiring against source (done, §1); build/repair harnesses that run without
  live staging or a real key (unit, embedded-PG); prepare these exact steps; build the §4 preflight +
  evidence verifier; and, once a dispatched run exists, **read its evidence.**
- **Only the OPERATOR may:** stand up / reach the staging substrate, place the `E2B_API_KEY`, arm the
  canary Org, authorize the real E2B spend, and dispatch the run. **The `E2B_API_KEY` is a provider
  secret — NEVER ask the session to enter or handle it (Decision #104).** The session STOPS at the live
  substrate boundary.
- **The promotion rule (the vacuous-green trap):** promote `E7-1-coding-journey` → `wired` in
  `scripts/gate-clause-wiring.json` **ONLY** on a **cited, dispatched, real-E2B run that completed the
  DISTRIBUTED journey** (create/schedule/lease/review) end-to-end on the staging substrate — **never** on
  the keyed provider lane, a D1 fake-provider run, or a local/embedded-PG harness. Until then, **E7-1
  stays `unwired`** and the honest end-state is *"campaign harness + runbook ready, staging run owed"* — a
  legitimate, respected outcome, not a failure. When cited: flip the clause with the run id in the
  `reason`, update `CLI-006-campaign-result.md` §"E7-1 disposition" + GO-BOOK §3.1/§4, run the five
  registers, commit, push. (runbook §5; GO-BOOK §9 "Sprint 5b".)

## 7. STOP flags

1. **★ The campaign is gated on an unscoped, non-trivial fleet-deploy task (§5).** The honest highest-
   leverage next step is **the deploy-pipeline work to make `docker-compose.staging.yml` deployable**
   (extend `remote-compose-deploy.sh` for the multi-service staging compose + provision the 16
   `AOA_STAGING_*` external stores, or a Terraform/manual multi-host stand-up), **not the campaign.** The
   campaign is a downstream consumer of that task.
2. **Do not fake a green.** No mock/keyed-lane/D1/embedded-PG run promotes E7-1 (§6). If no dispatched
   distributed-journey run exists, E7-1 stays `unwired`.
3. **Silent legacy fallback is the failure mode to fear, not a loud error.** cap=1 (f), a missing default
   `e2b` key (d), a ROLLOUT typo/absence (c), an unenrolled worker (e), or a legacy-lease-holding Org (g)
   each resolve the run to legacy with nothing surfacing at operator altitude. The §4 readiness check
   exists to make these fail closed *before* spend; the evidence verifier exists to catch a fallback
   *after*.
4. **Never let the session touch the `E2B_API_KEY`** (Decision #104) — it lives only on adapter-manager,
   injected from the orchestrator secret store.

---

*Prepared read-only at `2753a1fe9`. This plan cites living documents by path:line and §id; every path was
opened, not assumed.*
