---
title: Staging deployment topology (DEP-006)
summary: The two-control-plane / four-worker staging deployment manifest — failure domains, rollout order, worker drain, autoscaling limits, and the provider-control credential boundary.
---

# Staging deployment topology

`docker-compose.staging.yml` is the **deployment-intent** manifest for the distributed
worker re-platform's staging tier. It is **additive and dormant**: no self-contained CI
lane brings it up, and it is never the default deploy. Its config contract is enforced
two ways:

- **Static (always-on):** `node scripts/check-staging-manifest.mjs` (+ its `node --test`
  corpus) runs in the `policy` job of `.github/workflows/pr.yml` on every PR. It parses
  the manifest with the dependency-free `yaml-lite` parser and asserts the full DEP-006
  contract via `scripts/lib/staging-manifest-invariants.mjs`.
- **Live render (Linux/CI):** `tests/d1/e6f-12-staging-render.test.mjs` (SKIPs off
  `AOA_D1_LIVE=1`) runs `docker compose -f docker-compose.staging.yml config` with the
  real compose engine and cross-checks the same invariant module. It is a **render**
  validation, not a full external-store bring-up.

> **Not a live-test topology.** Contrast with `docker-compose.d1.yml`, which embeds
> postgres/minio/toxiproxy/a fake provider for the hermetic D1 live-test stack. Staging
> uses **external** database, object storage, realtime, and admission stores.

## Topology

```
                        migrate (one-shot)          adapter-manager
                        run migrations, exit         (provider-control surface)
                              │                             │ provider-ctl-net
        depends_on ──────────┴───────────┐                 │  (egress → E2B API)
        service_completed_successfully    │            E2B_API_KEY (injected)
                                          ▼
  ┌── failure domain A ──────────┐  ┌── failure domain B ──────────┐
  │  control-plane               │  │  control-plane-b             │
  │  worker-a1   worker-a2       │  │  worker-b1   worker-b2       │
  └──────────────────────────────┘  └──────────────────────────────┘
        control-net (internal mesh) + store-egress-net (→ external DB / object store)
```

| Service | Failure domain | Networks | Role |
|---|---|---|---|
| `migrate` | shared | `store-egress-net` | Privileged one-shot: runs migrations against the external DB, then exits. |
| `control-plane` | domain-a | `control-net`, `store-egress-net` | App control plane replica A. |
| `control-plane-b` | domain-b | `control-net`, `store-egress-net` | Interchangeable app control plane replica B. |
| `worker-a1`, `worker-a2` | domain-a | `control-net`, `store-egress-net` | Worker daemons (no DB / provider credential). |
| `worker-b1`, `worker-b2` | domain-b | `control-net`, `store-egress-net` | Worker daemons (no DB / provider credential). |
| `adapter-manager` | shared | `control-net`, `provider-ctl-net` | The provider-control surface — the ONLY holder of `E2B_API_KEY` and the ONLY service on `provider-ctl-net`. |

External stores are declared as injected endpoint **pointers** under the top-level
`x-external:` key (`database`, `object-store`, `realtime`, `admission-store`) — never
embedded services. The realtime + admission stores are shared across both domains; the
DEP-009 shared admission counter (`worker_admission_rate_limits`) is a single logical
DB, so a burst split across replica A and replica B observes one limit.

## Rollout order (migration-first, N/N-1)

1. **`migrate` runs first.** Every control-plane and worker `depends_on` the `migrate`
   one-shot with `condition: service_completed_successfully`. App processes run **no**
   migrations. (§2.1; mirrors DEP-003.)
2. **N/N-1 rolling update.** Control planes and workers declare a `deploy.update_config`
   with `parallelism: 1` (at most one version-skewed replica at a time) and a bounded
   `order` (`start-first` surge / `stop-first` unavailability) + `max_failure_ratio`. The
   shared `AOA_WORKER_SESSION_SIGNING_KEY` keeps a mixed-version fleet interchangeable, so
   a worker session minted at either replica verifies at the other during the roll. (§2.2)
3. **Rollback** uses the symmetric `deploy.rollback_config`.

## Worker drain

Each worker sets a bounded `stop_grace_period` (`120s`), a `stop_signal` (`SIGTERM`), and
a documented **drain hook** label (`x-drain-hook`): on `SIGTERM` the worker stops polling,
finishes or relinquishes in-flight leases within the visibility timeout, and exits 0 — no
in-flight lease is hard-killed. Any lease that exceeds the grace is reclaimed by the
DEP-005 reaper. (§2.3)

## Autoscaling limits

Each scalable service (both control planes, all four workers, the adapter-manager)
declares explicit, **bounded** min/max replica labels (`x-autoscaling-min` /
`x-autoscaling-max`): no unbounded replica count. The static check pins the ceiling
(`AUTOSCALE_REPLICA_CEILING`) and asserts `1 ≤ min ≤ max ≤ ceiling`. (§2.7)

## Shared admission (no process-memory fallback)

Both control planes set `AOA_DISTRIBUTED_EXECUTION_ENABLED=true`, which is the only path
on which the DEP-009 fail-closed shared admission limiter is wired. The limiter and the
submit-time org-capacity admission are DB-backed (the external `admission-store`); the
manifest carries **no** process-local / in-memory admission env or flag, and no second
admission counter. A process-local fallback is a static contract violation. (§2.4)

## Provider-control credential boundary

The provider-control credential `E2B_API_KEY` is:

- **Injected**, not baked — supplied from the orchestrator secret store as a `${…}`
  interpolation (or a `/run/secrets/…` mount), so it is **rotatable without an image
  rebuild**.
- Present **only** on the `adapter-manager` surface, which is the **only** service on
  `provider-ctl-net` (the egress path to the provider control API).
- **Absent** from every control-plane process env, every worker/tenant surface, and — by
  reusing DEP-008's egress-bypass posture and DEP-005 redaction — from protocol, metadata,
  logs, and support bundles.

Real-provider **rotation overlap/cutoff, old-key denial, revocation, and post-rotation
cleanup reconciliation** are **not** rehearsed here. They are contracted against DEP-008's
`runSandboxIsolationConformance` hostile reference and **deferred to CLI-001/D2** (which
owns the real-E2B provider and co-owns crosswalk rows CM-010 / CM-012). DEP-006 owns the
manifest-boundary expression + the static absence assertions only. (§2.5, D3)

## Deferred

- **Real multi-host / external-store bring-up.** DEP-006 renders + statically/CI-validates
  the manifest; the live external-store staging deployment is deferred to the deploy
  pipeline (`scripts/deploy/*`) / a REL ticket. (§4.1)
- **Real-E2B provider-control rotation/revocation runtime.** See the provider-control
  boundary section above (CLI-001/D2).
