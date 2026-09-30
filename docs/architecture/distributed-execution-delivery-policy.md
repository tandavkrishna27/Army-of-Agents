# Distributed Execution Delivery Policy

This policy governs how the distributed-execution re-platform (Decision #121) is
built, tested, rolled out, and rolled back. It is normative for every epic and
ticket in `docs/replatform/`. It is intentionally conservative: the rollout is
phased and default-off, hosted execution stays safe, and no excluded surface can
be enabled by a stray flag.

Related authority:

- [`distributed-execution-lifecycles.md`](distributed-execution-lifecycles.md) — workload/job/attempt/lease lifecycles.
- [`distributed-execution-authority.md`](distributed-execution-authority.md) — single-writer authority + late-output quarantine.
- [`distributed-execution-threat-model.md`](distributed-execution-threat-model.md) — trust boundaries, **required** controls, residual release exclusions. Its head carries the measured delivery state; the controls it names are chartered, not shown to exist.
- [`../replatform/test-gates.md`](../replatform/test-gates.md) — the D0–D6 lanes, HARD/REQUIRED/INITIAL/OBSERVED invariants, and the `E6-D1-FOUNDATION` partial gate.

## Custodian roles

Four named roles own the serialization points of the program. Every role is a
specific human or agent identity recorded in the epic handoff, not a team.

- **Protocol Custodian** — sole owner of the outbound worker protocol contract
  (wire messages, event envelope, `eventDigest` canonicalization, capability
  handles). All protocol edits are serialized through this role.
- **Migration Custodian** — sole owner of schema/migration ordering across the
  program. All migration edits (new migrations, backfills, table/column
  contracts) are serialized through this role.
- **Integration Gate Owner** — runs the epic integration gate, records the
  `pass | fail | blocked_external` decision on one exact 40-character revision,
  and owns the `E6-D1-FOUNDATION` partial gate handoff.
- **Security Gate Owner** — owns the threat-model controls and the security
  gate; signs off the hard-negative controls below before any hosted rollout.

## One ticket, one branch, one worktree

Each implementation agent works **one ticket** on one branch in one worktree.
Tickets do not share a working tree, and no ticket edits another ticket's files.
Protocol and migration edits are the two exceptions that are **serialized
through their custodian** even when they originate in another ticket: an
implementer proposes the edit, the Protocol Custodian or Migration Custodian
reviews and locks it, and only then does it land.

## Testing cadence

- **Focused tests on every ticket.** Every ticket lands with focused tests for
  the behavior it changes. Feature-flagged code still requires tests: a default-
  off flag never exempts a change from test coverage.
- **D1 every 5–10 merges.** The D1 integration lane runs at least once every
  5–10 merges to `docs/replatform-program`, never allowed to drift further.
- **Provider lanes nightly.** Real-provider and long-running provider lanes run
  nightly, not per-PR.

## Rollout order

Enable strictly in this order; never skip a step:

1. Deployment flag `AOA_DISTRIBUTED_EXECUTION_ENABLED` (default off).
2. Organization rollout flag (per-Organization, supplied by E3/E10).
3. Per-workload flag (`batch` / `browser_session` / `service`).

Enabling the deployment flag alone starts no worker and registers no distributed
route; all three flags must resolve enabled for a workload to run distributed
(`resolveDistributedExecutionRollout`).

## Rollback order

Roll back strictly in the reverse-safe order; never disable the deployment flag
first while active leases exist:

1. Stop issuing new leases.
2. Drain or cancel active leases.
3. Disable the Organization flag.
4. Disable the deployment flag.

## Isolation invariants

- The control plane never receives a Docker socket.
- Workers never receive database credentials; they read through scoped
  envelopes/APIs and append events only.
- Shared two-replica admission and rate-limit state lives **outside process
  memory** (a shared store), so a second control-plane replica cannot double-
  admit or under-count. Ownership of that shared admission/rate-limit store is
  recorded per epic.

## Hard-negative controls (executable)

Two surfaces are **excluded** from this re-platform release and are enforced as
executable hard negatives, not documentation:

- **Public service ingress** (`AOA_DISTRIBUTED_PUBLIC_SERVICE_INGRESS_ENABLED`).
- **Reserved distributed cloud-plugin surface**
  (`AOA_DISTRIBUTED_CLOUD_PLUGIN_EXECUTION_ENABLED`).

For each: the flag defaults absent/off; a truthy value **stops startup in every
deployment mode** (`assertHostedExecutionStartupSafe`); real-app requests to the
reserved paths (`/api/distributed-execution/public-services`,
`/api/distributed-execution/cloud-plugins`) return a normal `404`; and the
source-boundary rule in
`scripts/check-distributed-execution-foundation.mjs` rejects any import of a
reserved public-ingress or cloud-plugin-runner module and any registration of
the two reserved path prefixes in `server/src/app.ts`. The process-wide unsafe
override `AOA_ALLOW_UNSANDBOXED_MULTITENANT` is rejected at startup in
`cloud_auth` and is self-hosted emergency compatibility only.

FND-006 and FND-008 own the **actual current plugin surfaces** required by
Decision #103 (process composition, routes, dispatchers, UI); this policy's
hard-negatives cover only the reserved distributed surfaces.

## Gate authority

- A HARD invariant in [`../replatform/test-gates.md`](../replatform/test-gates.md)
  is **non-waivable**. A HARD failure always makes the overall result `fail`.
- The `E6-D1-FOUNDATION` partial gate is owned by the Integration Gate Owner and
  gates the first foundational distributed cutover.
- QA records use the immutable naming `<date>-<lane>-<scope>-<sha12>-a<attempt>.md`;
  reruns increment the attempt and never overwrite evidence. QA/handoff
  decisions are `pass`, `fail`, or `blocked_external` — there is no conditional
  pass.

## Reproducible authoritative build

- The authoritative repository/CI build is root `pnpm build`. It consumes only
  pinned checked-in snapshot inputs, performs **no network fetch**, and leaves
  tracked bytes unchanged. Intentional catalog/connector refresh is the explicit
  `pnpm refresh:bundled-snapshots` command (network), never invoked by build or
  test; it rewrites the snapshots and their manifest together.
- The D0 rollup records **both** the authoritative root `pnpm build` and the
  same-revision `pnpm -r build`; neither silently substitutes for the other.
- Root build scripts, `AGENTS.md`, every required `.github/workflows/pr.yml`
  build caller, and this policy are updated together whenever the authoritative
  build changes.
