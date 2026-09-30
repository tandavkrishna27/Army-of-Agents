# C0 — the staging-deploy pipeline: scope + decomposition (v2, post-adversarial-review)

**Status:** scope · **v2 (2026-08-28)** · **Worktree:** `C:\e3` · **Branch:** `docs/replatform-program`
**Purpose:** turn "C0 — deploy the staging fleet" into an actionable decomposition. **v2 folds a
three-reviewer adversarial pass that overturned v1's central premise** (§9): C0 is **not** the top of the
critical path — an unbuilt *execution substrate* sits above it. Read-only terrain; nothing here deploys.

> **★ THE CORRECTION (verified against source).** v1 said "C0 is mostly OPERATOR/infra work, not code …
> the fastest path needs no new session code." **That is wrong for the E7-1 campaign.** The staging fleet
> as expressed in `docker-compose.staging.yml` **cannot execute a canary run even when perfectly
> deployed**, because its provider-execution broker (`adapter-manager`) has **zero implementation** and the
> containerized worker→provider wire it depends on (**E6-F003**) is **open, unshipped code (DEP-011)**. The
> real bottleneck is **unbuilt code, not undeployed infrastructure.** This RE-OPENS the session-buildable
> frontier — the "well is dry / one operator action away" framing (this doc's v1, the E7-1 campaign plan
> §5, and GO-BOOK §1.5) was incomplete.

---

## 0. TL;DR — the true critical path

```
TIER 0  (session/CODE — the real frontier, was invisible):
  build `adapter-manager` (broker service + image + admission)  +  ship DEP-011 (E6-F003 worker→provider wire)
        ↓
TIER 1  (operator/infra — C0 proper): provision stores + role logins + 2 images + E2B key + host
        → bring up the minimal fleet via `docker compose up` (NOT swarm — §3)
        ↓
TIER 2  (optional session automation): the deploy pipeline (C0a) — makes Tier 1 repeatable
        ↓
  E7-1 campaign (arm · Company e2b key · enroll worker · cap>1 · dispatch 1 task)
        → `pnpm verify:e7-1-distributed-run <runId>`  (evidence-verifier A — SHIPPED)
        → operator cites A's green  →  flip E7-1-coding-journey → wired
```

**The single most important correction:** the E7-1 campaign is blocked on **TIER 0 (unbuilt code)** before
C0 (deploy) is even relevant. Deploying the fleet is necessary but **nowhere near sufficient**.

---

## 1. TIER 0 — the unbuilt execution substrate (F1/F2, verified against source)

The staging topology's whole point is the **provider-control boundary**: the E2B key lives ONLY on
`adapter-manager`, and workers reach the provider *through* it (never holding the key). Both halves of that
path are unbuilt:

- **`adapter-manager` is a manifest fiction — ZERO implementation.** A repo-wide search (`adapter.?manager`,
  case-insensitive, non-docs) returns only 6 files: `docker-compose.staging.yml`, the static checker
  (`check-staging-manifest.mjs` + `staging-manifest-invariants.mjs` + its test), the render test, and the
  `finding-ownership.json` entry that documents the gap. **No code in `packages/` or `server/src/`, no
  Dockerfile in `docker/`, no CI build/sign/admit.** Its image `ghcr.io/…/aoa-adapter-manager:staging` is
  never built (`docker/images/` builds only `control-plane` + `worker` metadata). `finding-ownership.json`
  E6-F003 says it outright: *"adapter-manager has zero implementation; no worker dispatches."*
- **The containerized worker→provider wire (E6-F003) is open, unshipped.** Staging forbids `E2B_API_KEY` on
  any worker (a hard `PROVIDER-CONTROL VIOLATION`, `staging-manifest-invariants.mjs checkProviderControlBoundary`),
  so a staging worker cannot construct a key-backed provider (the desktop lane DEP-010 wired) and MUST reach
  a networked provider — the E6-F003 wire, **owned by DEP-011, which has a design doc only, no result doc**
  (unshipped). E6-F003 is `status:"owned"`, HIGH, "stays open until DEP-011 ships."
- **The containerized worker is structurally inert today.** `compose-dispatch.ts decideDispatchComposition`
  refuses with `no_provider` (the bare daemon may not construct a provider — E4-D01) / `dispatch_disabled`;
  DEP-010's `checkDispatchDefaultOff` **forbids** `AOA_WORKER_DISPATCH_ENABLED` / `AOA_WORKER_SANDBOX_PROVIDER`
  on any staging worker, so the operator can't even enable dispatch without editing the manifest (reddening
  the always-on `policy` gate). The staging worker env carries **no provider URL at all** (contrast
  `docker-compose.d1.yml`, whose workers point at a real built `fake-provider:8080` — the ONLY topology in
  which the journey has ever run; the D1 "40/40 green" and keyed-conformance lanes honestly do **not**
  promote E7-1, runbook §5).

**Consequence:** a perfectly-provisioned minimal fleet can go through the *arming* motions (dial, Company
key, enroll a worker) but the placed canary attempt **cannot be leased+executed** — no provider path to
E2B — so it never produces `execution_owner="distributed"` with real E2B output, evidence-verifier A
correctly refuses, and E7-1 cannot promote.

**TIER 0 tickets:** (a) an `adapter-manager` implementation — **no owning ticket exists today** (the
manifest declares a service nothing builds); (b) **DEP-011** (E6-F003) — exists as a scoping stub, needs
building. Both are session/code work and are the honest highest-leverage next step.

## 2. TIER 1 terrain — the deploy path (verified; correct, just downstream of Tier 0)

- **No staging-deploy path exists.** `deploy-testing.yml` → `remote-compose-deploy.sh` composes ONLY
  `docker-compose.yml` (hardcoded `-f`); nothing deploys the staging manifest, which is render/CI-validated
  only (`check-staging-manifest.mjs`, the render test). `staging.md` "Deferred" confirms.
- **16 `AOA_STAGING_*` inputs** + an (undeclared) enrollment-code secret; external DBs/S3/realtime; E2B key
  isolated to `adapter-manager`.

## 3. The deploy-engine decision — CORRECTED: compose-up, NOT swarm (automation-review HIGH 1)

v1 recommended `docker stack deploy` (swarm) as "least-surprising." **That is wrong:** `docker stack deploy`
**silently ignores `depends_on`**, and every CP/worker gates on the migrate one-shot via
`depends_on: { migrate: { condition: service_completed_successfully } }` — so swarm **breaks the
migrate-first gate** (this doc's own §7.5 load-bearing invariant), booting app processes before migrations.
Swarm is also **net-new operational surface** (repo-wide `docker stack`/`docker swarm` = zero hits), which
the compose-based `remote-compose-deploy.sh` (`docker compose up --wait`) cannot mirror.

**Corrected recommendation:** bring up the campaign-minimal fleet with **plain `docker compose up --wait`**
— it preserves migrate-first AND mirrors the existing single-node script. The `deploy.update_config`/
`rollback_config` rolling-update semantics (swarm-only) are production-hardening, not campaign-enabling;
defer them. **Any trim to the topology must be a SEPARATE overlay file, never an in-place edit of
`docker-compose.staging.yml`** (its static checker `checkServiceSet` requires exactly the 8-service set +
both failure domains → an in-place trim reds the always-on `policy` gate — review F5).

## 4. TIER 1 inputs — the operator's provisioning contract (corrected)

- **The four DB URLs are ONE database + four role-scoped logins, not four databases** (terrain-review MED 1,
  verified): `DATABASE_URL` (owner), `AOA_APP_DATABASE_URL` (`aoa_app`), `AOA_OPERATOR_DATABASE_URL`
  (`aoa_operator`), `AOA_STAGING_MIGRATION_DATABASE_URL` (privileged) all address one logical DB by role
  (E2-D03/D10; `openDistributedExecutionDatabases`). **★ Non-obvious fail-closed step:** the migrations
  create `aoa_app`/`aoa_operator` **NOLOGIN**, and the LOGIN grant (`provision-d1-serving-roles.mjs`) is
  "STRICTLY gated behind `AOA_D1_PROVISION_SERVING_ROLES` … never runs on a non-D1 deploy." So the staging
  operator MUST grant LOGIN + passwords to those serving roles (matching the app/operator URLs) — else
  `assertHostedExecutionStartupSafe` **fails closed** ("NEVER falls back to the owner pool") and the fleet
  won't boot.
- **Only 2 of the 3 images are buildable** (review F3): `docker/images/` builds `control-plane` + `worker`
  metadata; `adapter-manager` has no Dockerfile/metadata (Tier 0). "Build + push + admit the 3 images" is
  impossible until Tier 0 ships adapter-manager.
- **Image-admission is UNWIRED on every deploy path** (automation-review HIGH 2): `verify-image-admission.mjs`
  is a SUPERSEDED orphan (`guard-inventory.json`); REL-004-result: "the gate is not yet on the publish
  path." So "admit" is a **manual operator step today**, OR C0a wires the LIVE `check-release-admission.mjs`
  (which exists) against **pinned `@sha256:` digests** (the manifest's mutable `:staging` tag defaults
  bypass digest-based admission entirely).
- **The enrollment-code secret is undeclared in the manifest** (both reviews): workers read
  `/run/secrets/worker-enrollment-code` but the manifest has no `secrets:`/bind-mount. It must be wired
  either way; a compose `secrets:` (file source) mounts it under plain `compose up` — this does NOT force
  swarm. C0-OP supplies the 10-min-TTL code out-of-band at enroll time.

## 5. Decomposition (the three tiers)

- **TIER 0 — E7-1-EXEC (session/code; the real frontier):** implement `adapter-manager` (the provider-control
  broker: hold the E2B key, broker worker→E2B execution; needs a NEW ticket + Dockerfile + admission
  metadata) and **ship DEP-011** (the E6-F003 worker→adapter-manager networked-provider wire). This is what
  actually unblocks the campaign; it is substantial and buildable now.
- **TIER 1 — C0-OP (operator):** provision one Postgres DB + four role logins (§4), the S3/realtime stores,
  the signing key, the 2 buildable images, the E2B key (operator-only, Decision #104), a host; wire the
  enrollment `secrets:`; `docker compose up --wait` a campaign-minimal overlay (1 CP + adapter-manager +
  1 worker + migrate); health-verify.
- **TIER 2 — C0a (optional session automation):** a real staging-deploy pipeline for repeatability
  (REL-003 DR, ongoing canary) — a `write-staging-compose-env.mjs` with **three-tier** validation
  (fail-closed on the ~11 required; require the 3 image vars as pinned `@sha256:` digests; treat
  `S3_REGION`/`E2B_DOMAIN` as defaulted-optional — review F5/MED5), a `compose up`-based deploy script, and
  a `workflow_dispatch` `deploy-staging.yml`. The env-writer has a real test precedent to mirror
  (`aoa-docker-layout.test.ts` execs `write-compose-env.mjs`); the deploy-script *body* has only
  string-assertion + `bash -n` precedent, so its behavioral dry-run harness is net-new. Ticket: a
  **graph-inert slug** (optional/off-critical-path, like the recent guard units) or a new **REL-006** in E11
  with a `#### REL-006` node + edges added atomically (do NOT reuse REL-003/005 or the shipped DEP-006).

## 6. STOP flags + security

1. **The E2B key is operator-only (Decision #104).** The SESSION never enters/reads/stores/logs it. Note the
   nuance (automation MED 4): the operator-RUN automation, mirroring `write-compose-env.mjs`, *does* serialize
   secrets into a mode-0600 on-host `.env` — same blast radius as the shipped single-node deploy. If that is
   undesirable for the provider-control key, carve `AOA_STAGING_E2B_API_KEY` OUT of the env-writer
   (presence-check only) and inject it into `adapter-manager` directly (matching the manifest's "orchestrator
   secret store, never baked" intent). Either way the *session* never handles the value — pick one and state it.
2. **The session builds automation; the operator provisions + runs the live deploy + holds every secret.**
3. **Migrate-first is load-bearing** — honor `depends_on: service_completed_successfully` (which is why §3
   rejects swarm).
4. **Don't gold-plate.** Tier 2 (the full pipeline) and the 2-domain swarm rolling-update are downstream of
   getting one canary run; Tier 0 (the execution substrate) is the actual blocker.

## 7. Sequencing to the campaign (corrected)

`[TIER 0: build adapter-manager + ship DEP-011]  →  [TIER 1: C0-OP provision + compose-up minimal fleet]
 →  E7-1 campaign  →  pnpm verify:e7-1-distributed-run  →  cite A's green  →  flip E7-1 → wired`
Tier 2 (C0a automation) is parallel/after Tier 1; not on the campaign's minimal critical line.

## 8. Open question the review surfaced (for the human)

**Could a degraded topology sidestep Tier 0 for a FIRST proof?** The only built real-E2B path is the
**desktop lane** (a key-backed worker constructs its own provider, DEP-010). A key-backed worker pointed at
the staging control-plane could produce `execution_owner="distributed"` + real E2B output **without**
adapter-manager — but it **collapses the provider-control boundary** (the E2B key on a worker), which is the
staging manifest's whole security thesis and a hard static violation. So it would be a *lesser* proof (the
journey runs; the cloud provider-control isolation does not). Whether that degraded proof is acceptable to
promote E7-1, or whether promotion must wait for the real containerized path (Tier 0), is a **decision for
the human** — it is the difference between "an agent ran on a distributed worker" and "the cloud
provider-control boundary works." The scope's recommendation: Tier 0 is the honest path; note the degraded
option exists but do not promote E7-1 on it without an explicit decision.

## 9. Review round — three-agent adversarial pass (2026-08-28)

Three reviewers (terrain skeptic · minimal-fleet critic · automation/security), each verified against source.

- **CRITICAL (minimal-fleet critic), verified by my own grep:** the fleet cannot execute — `adapter-manager`
  zero implementation + E6-F003/DEP-011 unbuilt. **Inverted v1's premise → Tier 0 added; §0 reframed.**
- **HIGH (automation) — swarm breaks migrate-first.** Verified (`depends_on: service_completed_successfully`
  in the manifest; swarm ignores `depends_on`). → §3 flipped to `compose up`.
- **HIGH (automation) — image-admission unwired.** Verified (orphan `verify-image-admission.mjs`;
  REL-004 result). → §4 marks "admit" manual, or wire the live `check-release-admission.mjs` on pinned digests.
- **MED (terrain) — 4 DB URLs = 1 DB + role logins; NOLOGIN serving-role grant is a fail-closed operator
  step.** Verified (`provision-d1-serving-roles.mjs` D1-only). → §4.
- **MED (automation) — "validate all 16" mis-specified** (5 have defaults; pin the 3 image digests). → §5 three-tier.
- **MED (automation) — §5.1/§6.1 E2B-key wording** (the operator automation *does* write the value; the
  session does not). → §6.1 clarified.
- **MED (both) — enrollment secret undeclared; compose `secrets:` suffices (not a swarm discriminator).** → §4.
- **MED (automation) — ticket placement:** graph-inert slug or a new REL-006 w/ node+edges. → §5.
- **Corrected a reviewer conflict:** `write-compose-env.mjs` IS tested (`aoa-docker-layout.test.ts` execs it) —
  the terrain skeptic was right; the automation reviewer's "no test at all" was wrong. The deploy-script
  *body* is only string-asserted (a fair narrower point). → §5.
- **F4 (minimal-fleet) — the CP/worker SIZING (1+1) is correct** but moot until Tier 0. Confirmed.

**Net:** v1's terrain and deploy mechanics were sound; its *premise* (deploy is the blocker) was not. The
campaign is gated on unbuilt execution-substrate code (Tier 0) first, then the operator deploy (Tier 1),
then the campaign. The session-buildable frontier is **not** dry — Tier 0 is real, substantial code.
