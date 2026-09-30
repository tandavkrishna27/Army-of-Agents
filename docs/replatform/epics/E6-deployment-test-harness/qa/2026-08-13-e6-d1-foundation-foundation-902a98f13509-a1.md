# E6-D1-FOUNDATION — QA gate record

**Lane:** `E6-D1-FOUNDATION`
**Result:** `blocked_external`
**Failure class:** `environment`
**Frozen revision:** `902a98f13509` (branch `docs/replatform-program`)
**Date (UTC):** `2026-08-13` · **Attempt:** `a1`
**Author:** controller (single-operator; adversarial-review-Workflow acceptance model — NOT an
independent Integration Gate Owner; see §Disposition)

## Why `blocked_external` (not `pass`, not `fail`)

The E6-D1-FOUNDATION campaign (plan §7.3 step 4) requires bringing up `docker-compose.d1.yml`
from DEP-001 **admitted image digests** and running E6F-01..07 on the **live stack** (Linux CI is
the DEC-03 authority). This host has **no Docker daemon**, and the org's **GitHub Actions is halted
on a billing/spending-limit failure**, so the live Docker/compose campaign cannot execute. This is
an **environment** blocker — there is no observed **product** or **harness** defect. Per plan §7.3
step 5, an isolation/tenancy *failure* would be a non-waivable `fail`; none was observed — the live
matrix simply could not run. Result is therefore `blocked_external`, not `pass` and not `fail`.

## E6F-00 — scope + dependency closure (REQUIRED) — MET (all constituents complete on one revision)

| Constituent | Disposition | Evidence |
|---|---|---|
| DEP-000 fake provider + contract suite | `complete`/`pass` | `tickets/DEP-000-result.md` @ `aff1b11c5` |
| DEP-001 signed least-privilege images + admission | `complete`/`pass` (live build CI-deferred) | `tickets/DEP-001-result.md` @ `dcd2e1c6c` |
| DEP-002 D1 compose topology + validator | `complete`/`pass` (live bring-up CI-deferred) | `tickets/DEP-002-result.md` @ `3eacdb59a` |
| DEP-003 migration job + readiness + 0188 preflight | `complete`/`pass` (live container CI-deferred) | `tickets/DEP-003-result.md` @ `5ed94af50` |
| DEP-004 CI lanes + ci-lanes validator | `complete`/`pass` (live merge-train CI-deferred) | `tickets/DEP-004-result.md` @ `902a98f13` |
| TEN-002 (E2 tenant kernel) | `pass` | passed @ `7843b86e2` |
| JOB-003 (E3 lease/ACK) | `complete`/`pass` | `E3-job-control/tickets/JOB-003-result.md` @ `d3a490a18` |
| WRK-004 (E4 sandbox supervisor / provider port) | `complete`/`pass` | `E4-worker-daemon/tickets/WRK-004-result.md` @ `3d8719faf` |

All DEP-000..004 + TEN-002 + JOB-003 + WRK-004 are complete and present on the single frozen
revision `902a98f13509`. **E6F-00 dependency closure is satisfied.**

## E6F-01..08 assertions table

| E6F | Assertion | Class | Owning evidence | Observed on `902a98f13509` |
|---|---|---|---|---|
| **E6F-00** | scope + dependency closure | REQUIRED | this record §E6F-00 | **MET** (all 8 constituents complete on one revision) |
| **E6F-01** | 100 submit→placement→lease→ACK races across ≥2 profiles, one winner each | REQUIRED | DEP-002 2 profiles + JOB-001/009/003 path; live campaign | **DEFERRED (live stack)** — JOB-003's 100-claimer single-offer race proven on embedded-PG at acceptance; the 100-race live-stack campaign needs docker-compose.d1.yml (billing-blocked) |
| **E6F-02** | 25 fake-provider create→execute→kill/destroy fault cases, deterministic reset, zero resources | REQUIRED | DEP-000 fixture-driven fake + per-checkpoint fault + zero-resource projection | **LOCALLY PROVEN** — `@armyofagents/sandbox-fake-provider` vitest 15/15 (fault-injection, reset-isolation, determinism, zero-resource after reconcile) |
| **E6F-03** | one networked end-to-end smoke (PG, MinIO, control-plane, worker, fake provider, runner) | REQUIRED | DEP-002 stack + DEP-003 readiness + fake job; live | **DEFERRED (live stack)** — needs the running compose (billing-blocked) |
| **E6F-04** | zero cross-Organization reads/existence disclosures in submit/enroll/placement/lease | HARD | E2 `runInTenant` + JOB-001/002/003 tenancy; live hostile matrix | **LOCALLY PROVEN (invariant) / live matrix DEFERRED** — E2 adversarial suite (11/11, 4,460 ops), JOB-002/003 RLS + FK-oracle denial, DEP-003 marker RLS (aoa_app `permission denied`, tenant-invisible) all pass on embedded-PG; the live-stack hostile cross-Org matrix (×3) needs the stack |
| **E6F-05** | topology boundaries (no shared rw volume; no worker DB reach/credential; no local tenant-command execution; only declared provider-control access) | HARD | DEP-002 network-denial + static invariants; DEP-000 no-tenant-code; DEP-001 least-privilege | **STATIC PROVEN / live denial DEFERRED** — DEP-002 static validator PASS (worker∉data-net, no shared rw, no worker DB credential, fail-closed control-endpoint allowlist), DEP-000 boundary checker, DEP-001 worker-image closure; the live TCP-denial tests need the stack |
| **E6F-06** | pinned images from recorded source, non-root/read-only-root, signature/provenance verify, reject one tampered digest | HARD | DEP-001 build + admission + image-contents | **STATIC PROVEN / built-image DEFERRED** — dockerfile-static (digest-pin, non-root, read-only, HEALTHCHECK, OCI label) + fail-closed image-admission (47/47); the real `docker build` + image-contents/startup need Docker |
| **E6F-07** | migration/readiness behavior + retained evidence from one deliberate failing fixture | REQUIRED | DEP-003 readiness + fail-closed preflight; DEP-004 evidence retention | **LOCALLY PROVEN / live retention DEFERRED** — DEP-003 pure preflight (fail-closed) + embedded-PG readiness/rollback (6/6) + marker RLS (6/6); DEP-004 evidence-bundle assembly (3/3, +1 Docker skip); the live merge-train artifact retention needs Docker |
| **E6F-08** | explicit non-certification list | OBSERVED | this record §E6F-08 | **RECORDED** (see below) |

## E6F-08 — explicit non-certification (NOT certified by this gate; owned by their tickets / D1/D2)

Session renewal / lease-fence loss (E4-F007, WRK-005); event ingestion / durable outbox (WRK-006);
cancellation / retry lifecycle; artifact / secret materialization / quarantine (E5); the full D1
fault volume (Toxiproxy campaigns); real-provider (E2B/gVisor) isolation (E7); two-replica HA
(DEP-005..009); release signing / vulnerability policy (E11); and the real-provider conformance of
the DEP-000 driver port (E6-F008, CLI-001/D2).

## Locally-proven evidence run (frozen `902a98f13509`, Windows; Linux CI = DEC-03 authority)

| Lane | Result |
|---|---|
| E6F-02 — `@armyofagents/sandbox-fake-provider` vitest | PASS — 4 files, 15/15 |
| E6F-05 (static) — `node scripts/check-d1-compose.mjs` + corpus | PASS |
| E6F-06 (static) — `dockerfile-static` + `image-admission` | PASS — 47/47 |
| E6F-07 (local) — `evidence-retention` bundle assembly | PASS — 3/3 (+1 Docker-gated skip) |
| E6F-04 (invariant) — E2 adversarial + JOB-002/003 + DEP-003 marker RLS (embedded-PG) | PASS (recorded in the constituent ledgers) |
| E6F-00 — all 8 constituent result ledgers present on one revision | PASS |
| DEP focused lanes (§3) + frozen-worker-protocol + `--frozen-lockfile` | PASS (per each DEP ledger) |

## Disposition

**E6-D1-FOUNDATION is `blocked_external` (environment).** All constituent tickets (DEP-000..004,
TEN-002, JOB-003, WRK-004) are `complete`/`pass` on one revision, and every locally-provable E6F
assertion (E6F-00, E6F-02, and the static/embedded-PG substrates of E6F-04/05/06/07) passes. The
**live Docker/compose gate campaign** (E6F-01, E6F-03, and the live matrices of E6F-04/05/06/07,
including the ×3 E6F-04/05 repeat) **cannot run** — no Docker daemon locally and CI halted on the
GitHub Actions billing outage.

Per plan §7.3 step 7, this gate does **NOT** unblock JOB-004..008 / JOB-011..014 / WRK-005+: those
require a `pass` QA **and** a `pass` independent Security-Gate-Owner handoff on the same revision,
which in turn require (a) the live campaign to execute (blocked on billing/Docker) and (b) an
independent Integration Gate Owner + Security Gate Owner distinct from the implementer (single-
operator model). **To close the gate:** restore GitHub Actions billing, run the live campaign on
Linux CI over this frozen revision (or a superseding one), and record the independent QA + handoff.

**Supersedes:** none (first attempt).
