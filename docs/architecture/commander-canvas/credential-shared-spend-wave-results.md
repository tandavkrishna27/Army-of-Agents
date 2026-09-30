# B11 credential and shared-spend foundation results

Date: 2026-09-20  
Execution sequence: B11 (`E8.1/1.c`, `E8.1/1.d`)

## Delivered

- Persistent `general` versus `voice_media` secret resolution scope.
- One common resolver guard that denies restricted credentials before legacy
  system/plugin/routine exemptions and before vault access.
- Exact provider-connection, capability-path, company, secret, binding,
  verification, terms, sharing and actor checks.
- Atomic restricted-secret, pending-connection and capability-binding creation.
- Company-scoped Budget capacity reservations with immutable operation identity,
  finite maximum exposure, typed admission outcomes, extensions, canonical charge
  settlement, conservative unknown exposure and durable stop requests.
- One company Budget authority lock used by reservations, policy mutation and all
  production canonical cost writers, including portability cost imports.
- Required activity records for credential creation and reservation state changes.

No paid voice or media consumer is enabled by this wave. Provider qualification,
session ownership, output publication and UI remain in later sequenced waves.

## Canonical cost-writer inventory

| Writer | Participation |
| --- | --- |
| `costService.createEvent` | Locks company Budget authority before posting. |
| heartbeat cost posting | Locks in the transaction that posts cost and updates rollups. |
| one-shot/distributed authoritative cost bridge | Locks before posting and rollup. |
| company portability cost import | Locks per imported batch. |
| development seed helpers | Excluded: development-only fixture population, not a runtime admission path. |

## Qualification evidence

- Pure policy tests cover generic-path denial, exact binding checks, owner sharing,
  provider readiness, capability mismatch, missing policies, unbounded exposure,
  cap denial and tightest-cap admission.
- A migrated PostgreSQL run proved that two simultaneous 60-cent voice/media
  reservations against a 100-cent hard cap admit exactly one operation.
- The same run proved unknown exposure remains held, immutable operation replay,
  canonical-charge-only idempotent settlement, generic resolver denial, successful
  verified exact resolution and denial after final binding deletion.
- Shared, database and server TypeScript checks pass.

The Windows Vitest process still cannot collect the Drizzle-backed integration
suite because of the already-recorded Node 24/Drizzle ESM loader cycle. The same
scenarios were therefore executed against a freshly migrated embedded PostgreSQL
instance through the server runtime, rather than being represented as a Vitest pass.

