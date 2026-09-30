# CLI-001 — E2B capability-matrix disposition

**Status:** no-key core pinned + CI-lint enforced; the **verified** limit column is
completed by the keyed real-E2B lane (`E2B_API_KEY` present). This is the
human-readable mirror of the typed fixture
`packages/sandbox-e2b-provider/src/capability-matrix.ts`, which the static lint
`src/__tests__/capability-matrix.test.ts` enforces (no required case may be marked
unsupported; only optional `checkpoint`/`restore`/`health` may be unsupported, and
only with a recorded fallback).

## Pinned provider-control surface

| Pin | Value | Verified by |
|---|---|---|
| Template alias | `aoa-base` (keyed lane may override via `e2b_template`; `base` installs CLIs per-run) | keyed lane |
| Image | `e2b/base` | keyed lane |
| Policy version | `cli-001-v1` | no-key core (shape) |
| Max concurrent sandboxes | 50 | keyed lane (number) |
| Default TTL | 60 000 ms | no-key core (shape) + keyed lane (enforcement) |
| Max TTL | 3 600 000 ms | keyed lane |

The no-key core pins the disposition **shape**; the keyed lane confirms the real
E2B account/plan limits and TTL enforcement.

## Operation dispositions

| Operation | Required | Supported | Fallback | Verified by |
|---|---|---|---|---|
| `create` | ✅ | ✅ | — | no-key core |
| `execute` | ✅ | ✅ | — | no-key core |
| `cancel` | ✅ | ✅ | — | no-key core |
| `kill` | ✅ | ✅ | — | no-key core |
| `destroy` | ✅ | ✅ | — | no-key core |
| `list` | ✅ | ✅ | — | no-key core |
| `inspect` | ✅ | ✅ | — | no-key core |
| `reconcile_cleanup` | ✅ | ✅ | — | no-key core |
| `health` | optional | ✅ | — | no-key core |
| `checkpoint` | optional | ❌ | destroy + recreate from the pinned template (no live snapshot); E2B beta pause deferred to CLI-004/keyed lane | keyed lane |
| `restore` | optional | ❌ | recreate from the pinned template + replay the workspace snapshot (DAT-001); E2B beta resume deferred to CLI-004/keyed lane | keyed lane |

`checkpoint`/`restore` are the ONLY unsupported entries — both genuinely optional,
both with a recorded fallback. Marking them unsupported makes the DEP-000 contract
suite naturally exercise BOTH negotiation branches (advertised `health` works;
unadvertised `checkpoint`/`restore` raise `UnsupportedProviderOperation`). The
keyed lane may flip them on once E2B beta pause/resume is verified.

## Isolation / fencing / TTL / kill / inspect / cleanup cases

All required; all supported. The no-key core proves them in-process over the mock
transport; the keyed lane reruns the provider-agnostic subset against real E2B.

| Case | Title | Verified by |
|---|---|---|
| §2.1 | effect-authority withdrawal (terminal + idempotent) | no-key core + keyed lane |
| §2.2 | effect ops unrepresentable under cleanup authority | no-key core + keyed lane |
| §2.3 | no existence oracle (uniform `ResourceNotAvailableError`) | no-key core + keyed lane |
| §2.4 | monotonic cleanup convergence (bounded destroy retries) | no-key core (keyed: CLI-004) |
| §2.5 | zero-byte management projection (redaction non-vacuous) | no-key core + keyed lane |
| §2.6 | network denial + no bypass (frozen classes) | no-key core (keyed: CLI-004/006) |
| §2.7 | no provider-credential / customer-byte leak | no-key core + keyed lane |
| §2.8 | bounded lifecycle faults (TTL / kill / crash / outage) | no-key core (keyed: real TTL now, rest CLI-004) |

The transport-fault-dependent cases (§2.4 destroy-failure ceiling, §2.6 egress
classification, §2.8 crash/outage) rely on synthetic fault directives the real
transport ignores; their real-infra equivalents belong to CLI-004 (real cleanup
reconciliation) and CLI-006 (live tenant canary). The keyed lane runs the
provider-agnostic subset (§2.1/§2.2/§2.3/§2.5/§2.7) plus real TTL enforcement plus
the managed-secret rehearsal (old-key denial, cleanup-survives-rotation,
tenant-probe-fails, kill-switch).
