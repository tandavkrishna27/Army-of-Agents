# WRK-017 — a CI-exercised first container-enrol on d1 (WRK-015 Part 2, split out)

**Epic:** E4 · **Plan node:** `docs/replatform/program-design.md`, `#### WRK-017`
**Depends on:** WRK-015 (POSIX enrolment input, SHIPPED) · WRK-014 (container identity, SHIPPED inert) · **Size:** M–L · **Status:** `built` (2026-09-03; see [`WRK-017-result.md`](./WRK-017-result.md)) — filed as `scope` on 2026-08-28 when it was split from WRK-015 at its Step-0 gate

> **Implementer's answers to the three open questions below (2026-09-03).**
> **OQ#3 — org-scope `worker-b` was chosen**, per the cheaper-lever note in (c). Two reasons beyond
> cost: the org enrol path is already live-proven end to end by `e6f-03` (the harness enrols an
> org-scope target through the same route), whereas the platform authority repo has never executed;
> and org scope needs no operator-DB authority rows at all, so OQ#1's question does not arise.
> `worker-a` stays `mounted_secret` as the negative control.
> **OQ#2 — a committed ticket fixture**, mounted READ-ONLY into BOTH the migrate job (which decodes
> it to learn which code to authorize) and the worker (which presents it). One artifact read twice,
> so there is no runtime hand-off to get wrong and the whole coupling is checkable BEFORE merge.
> **OQ#1 — moot**, for the reason under OQ#3.
> **(f) ordering — the migrate-time seed**, as the design preferred: no merge-train restructure.
> The 10-minute TTL is handled by seeding a longer expiry (an explicit input, `AOA_D1_SEED_ENROLMENT_TTL_MINUTES`)
> rather than by racing it; the rationale is stated at the seed and in the result doc.
**Terrain of record:** [`WAVE-4-RESEQUENCE.md`](../../../WAVE-4-RESEQUENCE.md) §3.2 · [`SPIKE-worker-walking-skeleton.md`](../../../SPIKE-worker-walking-skeleton.md) F5
**Reconciliation:** [`qa/2026-08-28-worker-dispatch-chain-reconciled.md`](../../../qa/2026-08-28-worker-dispatch-chain-reconciled.md) (link 3.2)

---

## Why this exists (the split)

WRK-015 was authored in two parts: **Part 1 — the POSIX enrolment-input validator** (the chartered
security core) and **Part 2 — a CI-exercised first container-enrol on d1**. Part 1 SHIPPED under WRK-015
(the platform-aware `assertLocalAbsolutePath`; see `WRK-015-result.md`). WRK-015's own **Step 0 gate**
(§3, §4, §8 Q1) said: *confirm the d1 harness can enrol a worker; if it has no enrol flow and adding one is
large, STOP and land Part 1 alone, filing Part 2 as a successor.* A source-cited investigation (recorded in
`WRK-015-result.md` §Part-2 / Step-0) found the enrol flow **absent and large**. This is that successor.

## What Part 2 wanted to prove

Switch **one** d1 worker (`worker-a`, `docker-compose.d1.yml`) from `mounted_secret` to the container path
(`AOA_WORKER_KEY_STORE_MODE: "file_record"`, `AOA_WORKER_STATE_DIR: "/worker"`, and a compose
`command: ["node","dist/bin/container-host.js"]` override — **NOT** an image-CMD repoint, which would
crash-loop every still-`mounted_secret` container because `container-host.ts` injects stores unconditionally
and `resolveCustody("mounted_secret", stores)` refuses → `exit(1)`), have the d1 merge-train ENROL it in CI,
and assert a persisted `DeviceIdentityRecord`+receipt in its volume — with `worker-b` left on
`mounted_secret` as the regression control. This proves WRK-014 + WRK-015 end to end on the one stack that
actually boots worker containers in CI (`d1-merge-train.yml` `docker compose up -d --wait`).

## Step 0 finding — the d1 harness has NO worker-enrol flow (why this is its own ticket)

Verified against source (`tests/d1/lib/e6f-harness.mjs`, `docker-compose.d1.yml`, `.github/workflows/d1-merge-train.yml`, `server/src/services/worker-enrollment.ts`, `server/src/routes/worker-control.ts`):

- **No d1 test ever boots a real worker-daemon enrol.** The harness header states it outright: "There is NO
  live worker-daemon loop: enroll/poll/ack are ordinary authenticated HTTP calls the harness makes itself."
  Both containers boot `mounted_secret` and idle as `docker exec` network vantage points; the
  `/enrollment-code` file is "only the SOURCE at load (not read)" and no volume even mounts it.
- **Target registration is org-scope only, via direct superuser SQL, with fresh random UUIDs, AFTER `up`.**
  `seedScenario` inserts `execution_targets` with `scope='organization'` and `targetId = uuid()` — never the
  container profile ids (`worker-a` = platform-scope `11111111-…`). There is **no platform-scope seed**.
- **`worker-a` is `platform` scope** (`docker/d1/worker-a.profile.json`, compose `AOA_WORKER_TARGET_SCOPE:
  "platform"`). The platform mint path `issuePlatformCode` runs on the **operator DB** via a distinct
  authority repo (`acquirePlatformTargetAuthorityExclusive` / `retireBootstrapCredential`) that the org-scope
  harness has **never exercised**, and it has **no HTTP route** (only `issueTenantCode` does, and that needs a
  board session the d1 harness cannot obtain). No test-only mint/register route exists (only `_test/reap`).
- **No ticket-file delivery mechanism into the container** — no `docker cp`, no init container, no volume, no
  ticket-encoder helper in the harness.
- **A first-boot enrol failure is terminal for `up --wait`** — the workers have no `restart:` policy, and a
  `file_record` enrol failure that isn't the narrow already-had-identity network case calls `proc.exit(1)`
  (`bin/worker-daemon.ts`). Seeding runs only via `docker compose exec` AFTER the stack is up, so a single
  `up --wait` cannot both seed and enrol.

## The concrete work this ticket must land (a–g)

- **(a) — DONE (WRK-015).** The Part-1 POSIX validator; without it a `/worker/...` ticket path crashes at
  `assertLocalAbsolutePath` before any read.
- **(b) Compose switch** — `worker-a` → `file_record` + `AOA_WORKER_STATE_DIR: /worker` +
  `command: ["node","dist/bin/container-host.js"]`, plus a Dockerfile build-stage
  `test -f …/dist/bin/container-host.js` guard. (`worker-b` stays `mounted_secret` — control.)
- **(c) Register the target** as an ACTIVE `execution_targets` row with a ratified `registered_profile` +
  `registered_profile_hash` + `provider_constraint_profile`. **★ Cheaper-lever choice (implementer, verify
  first):** switching **`worker-b` (org-scope)** instead of `worker-a` (platform-scope) may be materially
  smaller — the existing `seedScenario` superuser-SQL path already registers ORG-scope targets and mints via
  `issueTenantCode` on the **app** DB, so it would AVOID the operator-DB platform-authority machinery
  (`issuePlatformCode` / `acquirePlatformTargetAuthorityExclusive` / `retireBootstrapCredential`) that a
  platform seed needs and that the harness has never touched. The org path leaves only the (unavoidable)
  ordering + ticket-delivery work below. Trade-off: `worker-a`'s `platform` scope is the campaign's real
  target class, so a platform seed is higher-fidelity; pick org-`worker-b` if the goal is just "a real
  container enrols in CI," platform-`worker-a` if the goal is to exercise the platform authority path too.
- **(d) Mint a code bound to that target** — insert `worker_enrollment_code_routes`
  (`candidate_organization_id = NULL` for platform) + `worker_enrollment_codes` (secret hash), on the
  operator side. New platform-scope inserts. Bounded by the single-use code's **10-minute TTL**.
- **(e) Deliver the ticket file** into the container at `/enrollment-code` containing
  `aoa_tkt_<base64url(JSON{v:1,targetId:"1111…",code:"aoa_enr_…"})>` — a **new** mechanism (a committed
  fixture volume, an init step, or a migrate-time write), plus a ticket-encoder in the harness/seed.
- **(f) Ordering** — resolve the seed-vs-enrol chicken-and-egg. Two candidate shapes: a **migrate-time seed**
  (the privileged `migrate` job has direct `aoa` postgres access and runs before control-plane/workers — it
  could deterministically seed target+code+routes and the ticket could be a committed fixture), or a **phased
  bring-up** (postgres/migrate/control-plane up → seed+mint+write ticket → `up worker-a`). The migrate-time
  path is preferable (no merge-train restructure) but must handle the 10-min TTL and the operator-DB
  authority rows; both are **unproven** and are the bulk of this ticket's risk.
- **(g) A new `tests/d1` assertion** — `worker-a` persisted a `DeviceIdentityRecord`+receipt to its volume
  and enrolled; `worker-b` (control) did not. A re-boot short-circuits (no second enrol).

## Guards this will touch (not WRK-015's set)

The Dockerfile + `docker-compose.d1.yml` change → `dockerfile-static.test.mjs`, `check-d1-compose.mjs` /
`d1-compose-invariants.mjs` (worker-a's network attachments, no shared rw volume, the profile mount),
`check-image-deps-stages`. The `command:` override reuses WRK-014's already-declared `container-host.ts` boot
root → `check-boot-roots-provider-free` stays green. Staging is untouched (the staging canary is a separate,
campaign-time operator step — WRK-015 §9, `staging-manifest-invariants.mjs` NOT touched here).

## Sequencing

Independent of the dispatch chain (DEP-012/DEP-011 + `AOA_WORKER_DISPATCH_ENABLED` + an outbox): this reaches
ENROL only, like WRK-015. It can land any time after WRK-015; it is NOT on the critical path to E7-1 (the
campaign enrols one worker at campaign time via the CLI-006 runbook, not via this CI proof), but it closes the
last "no real container has ever enrolled in CI" gap and would catch a regression in the WRK-014/WRK-015
custody+validator path that the component tests cannot.

## Open questions for the implementer

1. Does the migrate-time seed have write authority for the operator-DB platform-authority rows the enrol
   branch reads (`acquirePlatformTargetAuthorityExclusive`, `retireBootstrapCredential`)? Trace the exact rows.
2. Is a committed ticket fixture acceptable (a throwaway target id + a code whose secret hash is seeded), or
   must the code be minted live (then the ticket must be written into the container post-seed, forcing a
   phased bring-up)?
3. Which worker to enrol? `worker-b` (org-scope) reuses the existing org seed + `issueTenantCode` and avoids
   the operator-DB platform-authority path — the cheaper lever (see (c)); `worker-a` (platform-scope) is the
   campaign's real target class but needs the un-exercised platform seed. If `worker-b` is switched, keep
   `worker-a` `mounted_secret` as the negative control (and vice-versa) — one enrolling, one not.
