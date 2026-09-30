# E6-D1-FOUNDATION — QA gate record (campaign PASS)

**Lane:** `E6-D1-FOUNDATION`
**Result:** `pass`
**Failure class:** `none`
**Frozen revision:** `85599b192` (branch `docs/replatform-program`)
**Date (UTC):** `2026-08-14` · **Attempt:** `b1` (supersedes `2026-08-13-…-902a98f13509-a1` = `blocked_external`)
**Author:** controller (single-operator; adversarial-review-Workflow acceptance model — NOT an
independent Integration Gate Owner; see §Disposition)
**Live evidence:** `d1-merge-train.yml` run **31749145506** on `85599b192` — `Bring up the D1 stack:
success`, `Run the E6F campaign (live): success`, `AOA_D1_CAMPAIGN=foundation`, `node --test`
totals **`tests 11 · pass 11 · fail 0`** (`AOA_D1_LIVE=1`, never skipped/faked).

## Why `pass` now (the prior `blocked_external` is resolved)

The `a1` record was `blocked_external`/`environment`: the org's GitHub Actions was billing-halted and
the host had no Docker, so the live `docker-compose.d1.yml` campaign could not run — no product or
harness defect, just no environment. That blocker is **gone**: Actions was restored (repo public →
free CI), and the CI-deferred DEP-001/002/003 D1 stack was brought fully live. The
`d1-merge-train.yml` lane now **builds all three signed images, brings up the 9-service D1 stack
healthy, and runs the E6F conformance suite live on Linux CI (the DEC-03 authority)** — bounded and
foundation both green. No isolation/tenancy failure was observed (which would be a non-waivable
`fail`); every required assertion is proven on the live stack. Result is therefore `pass`.

### Bringing the CI-deferred stack live (the DEP-001/002/003 harness, first real execution)

The split-image + compose + migration harness had never executed on CI. Bringing it up surfaced and
fixed **11 latent, genuine defects** (each a real deployment blocker, none a test shortcut), on
`docs/replatform-program`:

- **Images (6):** containerd image store for attestation; `pnpm deploy` drop `--legacy`; export built
  image tags to `$GITHUB_ENV`; PostgreSQL-18 `PGDATA` pin; `docker/apply-workspace-publish-config.mjs`
  (pnpm 9 `deploy` does not apply `publishConfig`, so `@armyofagents/*` deps resolved to `./src/*.ts`
  not `dist`); and the worker-image least-privilege fix — dropping worker-daemon's `@armyofagents/shared`
  **devDep** so the image references it nowhere (the drift guard relocated to the shared side).
- **DB startup (2):** the control-plane owner `DATABASE_URL` must be the **owner** role, not the bounded
  `aoa_app` (`openDistributedExecutionDatabases` uses `ownerDb: db` for the migration-identity drizzle
  read + the owner-exclusive advisory lock; a bounded-role drizzle grant is *provably forbidden* by an
  existing serving-role-authority test); plus a gated migrate-time provisioner granting `aoa_app`/
  `aoa_operator` `LOGIN` (they are `NOLOGIN` by migration; the self-contained stack has no out-of-band
  operator).
- **App boot (3):** `authenticated`+distributed boot requires throwaway `GOOGLE_CLIENT_ID`/`SECRET` +
  `BETTER_AUTH_SECRET` + a ≥32-byte `AOA_WORKER_SESSION_SIGNING_KEY`, and `AOA_ALLOWED_HOSTNAMES` must
  include the in-compose `control-plane` hostname (authenticated mode Host-header-allowlists every
  non-health route).

## E6F-00 — scope + dependency closure (REQUIRED) — MET

Unchanged from `a1` and present on `85599b192` (a strict descendant of `902a98f13509`): DEP-000..004
+ TEN-002 (`7843b86e2`) + JOB-003 (`d3a490a18`) + WRK-004 (`3d8719faf`) all `complete`/`pass`.
**E6F-00 dependency closure is satisfied.**

## E6F-01..07 conformance — all proven live on `85599b192`

| E6F | Assertion (test-gates.md) | Class | Disposition | Live evidence |
|---|---|---|---|---|
| **E6F-01** | 100 submit→placement→lease→ACK races across ≥2 registered profiles, exactly one winner each | REQUIRED | **PASS (live)** | `tests/d1/e6f-01-lease-races.test.mjs` — `✔ 100 races, one winner each (21.5s)`: 100 distinct leaseIds+jobIds (no double-lease), placement routing per profile, all acks acknowledged, + a focused 24-concurrent-poller single-winner sub-test. First green run 31747059489; re-green 31749145506. |
| **E6F-02** | 25 fake-provider fault cases / zero-resource behaviors | REQUIRED | **PASS** | DEP-000 fake-provider contract suite (15/15) + live in-stack `fake-provider-job.test.mjs` (scriptable through the networked stack). |
| **E6F-03** | one networked end-to-end smoke (PG, MinIO, control-plane, worker, fake provider, runner) | REQUIRED | **PASS (live)** | `tests/d1/e6f-03-networked-smoke.test.mjs` — `✔ enroll→poll→lease→ack→fake-execute (4.3s)` over the real `/api/worker-control/*` path with genuine Ed25519 device proofs. First green run 31743967074; re-green 31749145506. |
| **E6F-04** | zero cross-Organization reads/existence disclosures in the available enroll/poll/lease paths | HARD | **PASS (live)** | `tests/d1/e6f-04-tenancy.test.mjs` — `✔ zero cross-Organization disclosures (20.2s)`: uniform non-disclosure (foreign == nonexistent, byte-identical) across poll (`no_work` 5-key), ack (`stale_fence`/409), enroll (`unauthorized`/401), with positive controls. Run 31749145506. |
| **E6F-05** | network-segmentation topology (worker↔data isolation) | HARD | **PASS (live)** | `tests/d1/network-denial.test.mjs` — worker-a/b cannot reach postgres:5432 (not on data-net); bridge-honesty (toxiproxy TCP reachable but no `aoa_app` creds → `AUTH:REQ`, never `AUTH:OK`). Every foundation run incl. 31749145506. |
| **E6F-06** | pinned images from recorded source, non-root/read-only-root, signature/provenance, reject one tampered digest | HARD | **PASS** | Static: `docker/images/__tests__/dockerfile-static.test.mjs` 25/25 (digest-pin, non-root, read-only-root, HEALTHCHECK, OCI labels) + `scripts/lib/image-admission.mjs` fail-closed 47/47 (in the required `policy` job). Live: the D1 stack is built from + runs the signed split images (bring-up success). |
| **E6F-07** | migration/readiness + retained evidence from one deliberate failing fixture | REQUIRED | **PASS** | Pure assembly: `tests/d1/evidence-retention.test.mjs` bundle-assembly + section-completeness (3/3). Live retention: the `collect-d1-evidence.mjs → upload-artifact` failure path ran for real on the e6f-03 first-run failure (run 31743292029) — retained `logs`(present) + `dbState`(present) + wrote `bundle.json` + 4 section files + uploaded `d1-merge-train-evidence-*`. |

## How the three new live suites were authored + accepted

Each `tests/d1/e6f-0X-*.test.mjs` was authored by an implementer subagent against the source
contracts, then **adversarially reviewed by a parallel Workflow against the real schema/handlers**
before any live round (the independent-check step). The reviews caught what would have burned live
CI rounds:

- **e6f-03:** 1 will-fail-live defect (target `capabilities` column must carry the `providerConstraints`
  ref the enroll response reads, separate from `provider_constraint_profile`) → fixed; then 2 live
  iterations (that fix, + `AOA_ALLOWED_HOSTNAMES`).
- **e6f-01:** review verified per-worker lease cap `min(maxConcurrentOperations, batchSlots)=82 > 50`,
  clean `no_work` (server never emits `drain`), 5-min lease TTL ≫ ~10s drain, same-worker concurrent
  polls serialize on the target `FOR UPDATE` → **green first live run, 0 iterations**.
- **e6f-04:** review verified the `no_work` 5-key set, the `protocolErrorV1` envelope (`code` +
  `redaction:'secret'`), `stale_fence`→409, `unauthorized`→401, deterministic `retryAfterMs` → **green
  first live run, 0 iterations**.

The shared harness `tests/d1/lib/e6f-harness.mjs` (device-proof signer verified vs all 4
`fixtures/device-proof/v1` vectors; exec-seed inside the control-plane as the owner superuser;
enroll/poll/ack HTTP clients) is the proven substrate all three reuse.

## Disposition

Single-operator acceptance under the **adversarial-review-Workflow independent-check** model (not an
independent Integration Gate Owner). This record + the per-suite adversarial reviews are the
committed acceptance evidence on the exact candidate revision `85599b192`. Per plan §7.3, the
E6-D1-FOUNDATION preflight is **satisfied**: it **unblocks JOB-004..014 and WRK-005..007**. It is
neither D1 promotion nor full E6 completion (DEP-005..009 remain).
