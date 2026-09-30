# DEP-002 Result — Isolated D1 compose topology + network-segmentation validator

**Status:** `complete` (static/local; live compose bring-up + network-denial deferred to CI)
**Disposition:** `pass` (topology + static validator locally verified; live denial tests are Docker/CI-only, billing-blocked)
**Date opened (UTC):** `2026-08-13`
**Epic:** `E6-deployment-test-harness` (partial: `E6-D1-FOUNDATION`)
**Plan task:** `DEP-002 — Isolated D1 compose topology (E6 §2.3)`
**Implementer:** `Claude subagent (opus) — worktree C:\e3`
**Reviewer:** `Claude adversarial-review Workflow (4 dimensions → dedup → refute-by-default verify; 12 agents) + fix-round verification`
**Start SHA:** `dcd2e1c6c` (DEP-001 commit)

## Acceptance model + CI caveat

Adversarial-review Workflow = the independent check; **5 confirmed findings (0 blocking, 2
should-fix, 3 nit)**, all resolved. The static topology validator, the compose (cross-checked by
the real `docker compose config`), and the app-layer boundaries are Windows-local verified; the
live compose bring-up + network-denial + fake-provider-job tests are Docker/CI-only (guarded by
`AOA_D1_LIVE=1`) and currently **billing-blocked**.

## Scope

- **`docker-compose.d1.yml`** — the D1 topology implementing the §2.3 network-segmentation matrix
  across `data-net`/`control-net`/`worker-net`/`provider-ctl-net` (all `internal`): postgres{data};
  minio{data,control,worker}; control-plane{all 4}; worker-a/worker-b{control,worker,provider-ctl}
  — **NOT data-net**; fake-provider{control,worker,provider-ctl}; toxiproxy in-path on
  worker↔control-plane, worker↔minio, control-plane↔postgres; migrate{data}; test-runner{control}.
  No shared rw volume; `depends_on: service_healthy` (migrate → `service_completed_successfully`);
  two DISTINCT registered target profiles.
- **Static validator** `scripts/check-d1-compose.mjs` + `scripts/lib/d1-compose-invariants.mjs` +
  a dependency-free `scripts/lib/yaml-lite.mjs` parser (cross-checked against
  `docker compose config --format json`). Corpora enforce the full matrix with non-vacuous REJECT
  fixtures. Live denial tests `tests/d1/*.test.mjs` (CI-deferred). DEP-000 fake provider wired as a
  service; Toxiproxy config; two worker profiles validated against the frozen
  `registeredTargetProfileV1Schema`.

## Independent adversarial review + fix round (5 confirmed, all resolved)

The security-relevant checks held: the app-layer control-endpoint allowlist gates on non-spoofable
Docker socket source IPs, and the validator faithfully enforces the declared matrix. Fixes:

- **SHOULD-FIX — control-endpoint boundary had no *static* coverage** (only the CI-deferred live
  test guarded "control-plane must not script the fake"). **Fixed:** new
  `checkFakeProviderCtlAllowlist` invariant — `AOA_FAKE_PROVIDER_CTL_ALLOW` must be non-empty,
  equal exactly `worker-a,worker-b,test-runner`, and exclude control-plane; + a REJECT fixture
  (control-plane-in-allowlist → validator rejects). RED→GREEN.
- **NIT — allowlist failed OPEN when empty/unset.** **Fixed:** extracted `docker/d1/ctl-allowlist.mjs`
  — empty/unset ⇒ deny all (403); explicit `'*'` sentinel to open; else DNS-resolved peers only.
  6/6 unit tests (empty→403, '*'→allow, list→admit/403).
- **SHOULD-FIX — toxiproxy porosity** (worker → `toxiproxy:15432` → postgres, bypassing the
  "worker∉data-net" claim; direct path tested but indirect unprobed). **Resolved per E6-F009**
  (no plan-deviating toxiproxy split): a new `checkWorkersHaveNoDbCredential` static invariant
  asserts worker services carry NO DB credential/DSN (so even reaching the port they can't
  authenticate) + REJECT fixture; the isolation claim is narrowed (banner + `docker/d1/README.md`)
  to *no direct worker→postgres path + no worker DB credentials + E2 FORCE-RLS*, with toxiproxy
  documented as a deliberate multi-homed data-tier bridge; + a CI-deferred live bridge-honesty
  test (worker reaches `:15432` TCP by design but cannot authenticate without `aoa_app` creds).

## Operator-directed Windows-local evidence (from `C:\e3`; compose bring-up = Docker/CI, billing-blocked)

| Lane | Result |
|---|---|
| `node scripts/check-d1-compose.mjs` (real compose vs all invariants) | PASS |
| `node --test scripts/check-d1-compose.test.mjs` | PASS — **29/29** (incl. 3 new REJECT fixtures) |
| `node --test scripts/lib/__tests__/d1-compose-invariants.test.mjs` | PASS — **30/30** |
| `node --test docker/d1/__tests__/ctl-allowlist.test.mjs` (fail-closed) | PASS — 6/6 |
| `docker compose -f docker-compose.d1.yml config` | VALID render (cross-checks the yaml-lite parser) |
| `tests/d1/*.test.mjs` live network-denial + fake-provider-job + bridge-honesty | SKIP locally (Docker/CI, `AOA_D1_LIVE`) — **honestly not run** |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` + `--frozen-lockfile` | PASS + no-op (zero new deps) |

## Decision

DEP-002 is `complete`/`pass` for its locally-verifiable surface: the network-segmentation matrix
(incl. the load-bearing worker∉data-net), the non-vacuous static validator + reject fixtures, the
fail-closed control-endpoint allowlist, the worker-no-DB-credential invariant, and the honest
isolation claim (E6-F009). Live compose bring-up + network-denial are the only DEFERRED items
(Docker/CI, billing-blocked) — not faked. Next: **DEP-003** (migration job + readiness + 0188
cutover-marker preflight — its DB/marker logic is embedded-PG-verifiable on Windows).
