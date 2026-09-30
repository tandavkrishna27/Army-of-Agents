# D1 isolated test-harness compose topology (DEP-002)

`docker-compose.d1.yml` (`name: aoa-d1`) is the **dormant, additive** distributed
test harness for the durable job-control plane (E3) + worker daemon (E4). It is
never brought up by an existing lane; the DEP-004 merge-train (Linux/CI) and
opt-in operators are the only consumers. Existing `docker-compose*.yml` files are
untouched.

## Network-segmentation matrix (plan §2.3)

| Service | data-net | control-net | worker-net | provider-ctl-net |
|---|:--:|:--:|:--:|:--:|
| `postgres` | ✅ | — | — | — |
| `minio` | ✅ | ✅ | ✅ | — |
| `control-plane` | ✅ | ✅ | ✅ | ✅ |
| `control-plane-b` | ✅ | ✅ | ✅ | ✅ |
| `worker-a` | **—** | ✅ | ✅ | ✅ |
| `worker-b` | **—** | ✅ | ✅ | ✅ |
| `fake-provider` | — | ✅ | ✅ | ✅ |
| `toxiproxy` | ✅ | ✅ | ✅ | — |
| `migrate` | ✅ | — | — | — |
| `test-runner` | — | ✅ | — | — |

All four networks are `internal: true` (no external egress).

**Worker ↔ data isolation (what is actually enforced).** This harness does **not**
claim "full network isolation" of workers from the data tier. The enforced boundary
is the conjunction of three things:

1. **No _direct_ `worker → postgres:5432` route** — `worker-a` / `worker-b` are not
   on `data-net`, so a direct TCP connect to `postgres:5432` is refused. Enforced
   statically (`scripts/check-d1-compose.mjs`: worker ∉ data-net) and live
   (`tests/d1/network-denial.test.mjs`: direct-connect refused).
2. **Workers carry no DB credential** — no `DATABASE_URL`, no `*_DATABASE_URL`, no
   `aoa_app`/postgres user/password env on a worker. Enforced statically (new FIX C
   invariant) so that even by reaching postgres _indirectly_, a worker cannot
   authenticate. See "toxiproxy is a data-tier bridge" below.
3. **E2 `FORCE` RLS** gates any actual data access at the database.

**toxiproxy is a deliberate multi-homed data-tier bridge.** Per plan §2.3 there is a
**single** toxiproxy attached to `data-net` + `control-net` + `worker-net`, and its
`control-plane → postgres` proxy listens on `0.0.0.0:15432`. A worker can therefore
open a TCP connection to `toxiproxy:15432 → postgres:5432` **by design** — this port
is TCP-reachable from workers and isolation does **not** rely on hiding it. What
stops a worker from reading tenant data through that bridge is boundary (2) (no
credential to authenticate) plus (3) RLS, **not** an unreachable port. The
`AOA_D1_LIVE`-gated `tests/d1/network-denial.test.mjs` documents this honestly:
`toxiproxy:15432` accepts the TCP connection, but a worker cannot authenticate to
postgres without `aoa_app` credentials.

## Toxiproxy in-path links

Toxiproxy sits in-path on the three declared links; clients are configured to
address the proxy, never the upstream directly:

| Proxy | listen | upstream | client env |
|---|---|---|---|
| `control-plane-to-postgres` | `:15432` | `postgres:5432` | control-plane `DATABASE_URL` |
| `worker-to-control-plane` | `:13100` | `control-plane:3100` | worker `AOA_WORKER_CONTROL_PLANE_URL` |
| `worker-to-control-plane-b` | `:13101` | `control-plane-b:3100` | DEP-009 per-replica worker link (independently cuttable) |
| `worker-to-minio` | `:19000` | `minio:9000` | worker `AOA_WORKER_S3_ENDPOINT` |

**DEP-009 — two-replica control-plane HA.** `control-plane-b` is an interchangeable
second replica over the SAME PostgreSQL + object store. It is a byte-faithful clone of
`control-plane` differing only by its own state volume (`d1-control-plane-b-state`) and by
adding `control-plane-b` to `AOA_ALLOWED_HOSTNAMES`. It shares the SAME
`AOA_WORKER_SESSION_SIGNING_KEY` (cross-replica session portability) and is gated on the
same one-shot `migrate` job (it runs no migrations). It deliberately does **not**
`depends_on control-plane` — the replicas are independent so cutting one (via the
`worker-to-control-plane-b` proxy) never gates the other. Correctness is 2-replica-free:
every control-plane mutation runs inside one `runInTenant` PostgreSQL transaction over
`FOR UPDATE [SKIP LOCKED]` / partial-unique indexes / advisory locks, so PostgreSQL is the
single writer and two replicas racing the same job yield exactly one winner. The genuine
process-local gaps DEP-009 closes are the PG-backed shared rate limiter (per-org fixed
window) and submit-time org-capacity admission — both DB-backed and fail-closed.

The privileged `migrate` job talks to `postgres` **directly** (data-net, not via
toxiproxy).

## Distinct worker target profiles

`worker-a` and `worker-b` register **distinct** `registeredTargetProfileV1` profiles
(`worker-a.profile.json` = `managed_cloud`/`platform`/`shared_isolated`;
`worker-b.profile.json` = `organization_dedicated`/`organization`/
`organization_isolated`) with different capability/locality mixes, so JOB placement
can pick between them (E6F-01 substrate). The `providerConstraints.digest` +
`policyHash` are format-valid placeholders; the concrete provider-constraint profile
is registered at harness bring-up.

## Images (DEP-001 admitted digests)

`control-plane`, `worker-a/b`, and `migrate` consume DEP-001 **admitted signed
digests** injected via `${AOA_D1_CONTROL_PLANE_IMAGE}` / `${AOA_D1_WORKER_IMAGE}`
(see `.env.example` + `docker/images/allowlist.json`). Digests are **never**
hardcoded in the compose file. `fake-provider` is built from
`fake-provider.Dockerfile` (wraps the DEP-000 package). The container build +
`scripts/verify-image-admission.mjs` admission check are Linux/CI-only.

## Deterministic startup

`depends_on` uses long-form conditions only. Long-running services gate on
`service_healthy`; the run-to-completion `migrate` job gates dependents on
`service_completed_successfully`. `control-plane` waits for `migrate` to complete
(schema applied) **and** `postgres`/`minio`/`toxiproxy` healthy before it serves;
workers wait for `control-plane` + `fake-provider` + `toxiproxy` healthy.

**One-shot job.** `migrate` runs to completion and has no long-lived healthcheck;
the static validator exempts exactly `migrate` from the "every service has a
healthcheck" rule and requires its dependents (control-plane) to use
`service_completed_successfully`. `test-runner` is instead a long-running idle
in-stack utility (it must stay up so the host-driven live lane can `docker compose
exec` into it as an allowlisted control-endpoint peer), so it carries a trivial
healthcheck like every other long-running service.

## Control-endpoint boundary (application-layer, by necessity)

The fake provider serves its **declared API** (`/invoke`, `/replay`, `/healthz`) on
`:8080` and its **control endpoint** (`/script`, `/reset`, `/invocations`) on
`:8081`. The plan requires the control endpoint be reachable by workers +
test-runner but **not** by the control-plane.

Because the plan also places `control-plane` on all three of the fake's networks
(`control-net`, `worker-net`, `provider-ctl-net`), that boundary **cannot** be
expressed by Docker network segmentation alone — every network the fake is on, the
control-plane is on too. It is therefore enforced at the **application layer**: the
control-endpoint server (`fake-provider-entry.mjs`) applies a **peer allowlist**
(`AOA_FAKE_PROVIDER_CTL_ALLOW=worker-a,worker-b,test-runner`) and returns `403` to
any other peer, including the control-plane. This divergence is recorded in the
DEP-002 result for the reviewer / a possible plan amendment (drop control-plane
from `provider-ctl-net` to make it a pure network boundary).

**Fail-closed posture (FIX B).** The decision lives in `docker/d1/ctl-allowlist.mjs`
(pure, unit-tested by `docker/d1/__tests__/ctl-allowlist.test.mjs`). An **empty or
unset** `AOA_FAKE_PROVIDER_CTL_ALLOW` **denies all** control-endpoint requests
(`403`); opening the endpoint requires the **explicit sentinel**
`AOA_FAKE_PROVIDER_CTL_ALLOW='*'`. Peer identification stays the sound
`socket.remoteAddress` (resolved against docker DNS), never a spoofable header.

**Static coverage (FIX A).** Previously only the `AOA_D1_LIVE`-gated `403` test
guarded this boundary (it skips locally and in the billing-blocked CI), so a regression
adding `control-plane` to the allowlist would pass every gate that runs.
`scripts/lib/d1-compose-invariants.mjs` now statically asserts the `fake-provider`
service declares a **non-empty** `AOA_FAKE_PROVIDER_CTL_ALLOW` equal to
`worker-a,worker-b,test-runner`, and that **`control-plane` is not among its values**.

## Verification

- **Local / CI static (no Docker):** `node scripts/check-d1-compose.mjs` and
  `node --test scripts/check-d1-compose.test.mjs`.
- **Linux/CI live (compose up):** `node --test tests/d1/network-denial.test.mjs
  tests/d1/fake-provider-job.test.mjs` with `AOA_D1_LIVE=1` (skips cleanly without
  Docker). Bring-up: `cp docker/d1/.env.example docker/d1/.env` (set admitted
  digests) → `docker compose -f docker-compose.d1.yml up`.
