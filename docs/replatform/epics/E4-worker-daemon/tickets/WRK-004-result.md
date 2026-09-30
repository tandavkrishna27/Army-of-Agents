# WRK-004 Result — Sandbox supervisor and process-tree cancellation

**Status:** `complete`
**Disposition:** `pass`
**Date opened (UTC):** `2026-08-13`
**Epic:** `E4-worker-daemon`
**Plan task:** `WRK-004 — Sandbox supervisor and process-tree cancellation (M; three slices)`
**Implementer:** `Claude subagent (opus) — worktree C:\e3`
**Reviewer:** `Claude adversarial-review Workflow (4 dimensions → dedup → refute-by-default verify; 12 agents) + fix-round verification`
**Start SHA:** `8b8fc013b` (WRK-003 commit)

## Acceptance model

The multi-agent adversarial-review Workflow is the independent check. It weighted the two safety
boundaries (effect-vs-cleanup authority separation; redaction + no-existence-oracle) heavily and
returned **1 confirmed BLOCKING finding** (0 should-fix, 0 nit; the redaction/oracle, lifecycle,
and boundary/metrics dimensions returned clean). The blocking finding is resolved below.

## Dependency and scope state

- Consumes WRK-003 (lease handoff seam) + PRT-003 (frozen). Additive worker-only modules; **no
  server/db/migration change**; frozen `packages/worker-protocol` untouched; runtime deps stay
  exactly `@armyofagents/worker-protocol` + `pino` (node:crypto for the event digest).
- CORE binds ONLY the in-process `createFakeSandboxProvider`. The supervisor is inert until
  WRK-003 hands it a lease (E4-D12); `bin/worker-daemon.ts` stays inert.
- **E4-F003 (resolved):** the `SandboxProvider` port + result/label/authority types are exported
  from `@armyofagents/worker-daemon`'s public API for DEP-000 to import + implement.
- **E4-F002 (resolved):** the port is transport-agnostic; the networked worker→provider driver +
  wire is a named NON-GOAL owned by a later ticket (reconcile with E6-F003).
- **E4-F004 (resolved, no split):** slice B (cleanup authority) fit the ticket bound.

## Security invariants (enforced + independently reviewed clean)

- **Effect vs cleanup separation:** `EffectAuthority` (create/execute/resume/checkpoint) gated on
  an active fence; `withdraw()` on lease loss; `CleanupAuthority` exposes effectful ops only as
  explicit throwers. Abnormal paths withdraw effect BEFORE routing to cleanup.
- **Redaction:** the management projection emits only `{sandboxId, resourceLabelsHash, generation,
  state, providerOpId}` — no command/env/logs/secrets/bytes/grants; labels hashed.
- **No existence oracle:** cross-resource + wrong-generation + genuinely-absent all map to one
  identical `ResourceNotAvailableError`.
- **No local tenant spawn:** the tenant command runs in the sandbox/fake; `no-local-tenant-spawn`
  mocks all spawn APIs and asserts zero calls.
- **Monotonic epoch, idempotent destroy (`cleanupStatus:"failed"` never throws), Unsupported
  ProviderOperation explicit, idempotency replay** — all reviewed clean.

## Independent adversarial review + fix round (1 confirmed BLOCKING, fixed)

**BLOCKING (authority-separation) — create-window containment fail-open.** A cancel / onLeaseLost
/ shutdown arriving while `create` is IN-FLIGHT against a provider that only registers the sandbox
on resolve (the REAL E2B runtime — `sandbox-provider-runtime.ts:409`; the `SandboxProvider`
contract does NOT require an in-flight create to be listable) leaked the created tenant sandbox:
`escalateCleanup` set `run.cleanedUp=true` unconditionally, `list()` returned `[]` (not yet
registered), `converge([])`→"success"; then `create` resolved with a live sandbox and the
post-create cancelled pass short-circuited on the latch → the live tenant sandbox ran past lease
loss with zero worker-side teardown. The **fake's synchronous registration masked it** — the
existing tests couldn't catch it.

**Fixed (both parts):**
- **Fake fidelity** (`fake-provider.ts`): added a `createGate` deferred-registration mode
  modeling the real E2B runtime (create awaits the gate; the sandbox is not listable until it
  resolves). Default synchronous registration preserved for existing tests.
- **Latch** (`supervisor.ts:167-224` `escalateCleanup`): removed the unconditional latch; an empty
  pass (targets `[]`, create in-flight) logs + returns **retryable without latching**; the latch
  is set ONLY with a real target, immediately before `converge` (no interleaving await → genuine
  convergence is never double-run); a re-check after the `list()` await handles concurrent passes.
  Invariant: a created sandbox is ALWAYS reclaimed on cancel/lease-loss, even if an earlier pass
  ran while create was in-flight.
- **Regression test** (`supervisor-cancel-during-create.test.ts`): cancel + onLeaseLost during
  in-flight create (deferred-registration fake) → the created sandbox reaches `destroyed`, process
  tree dead, no leak. Non-vacuous: RED against the old latch showed `expected 'running' to be
  'destroyed'` (a real live leaked sandbox) → GREEN after the fix. No double-destroy (the
  cancel-escalation test still asserts exactly `["cancel","kill","destroy"]`).

## Operator-directed Windows-local evidence (from `C:\e3`; Linux CI = DEC-03 authority)

| Lane | Result |
|---|---|
| `pnpm --filter @armyofagents/worker-daemon exec vitest run` | PASS — **46 files, 188/188** (prior 45/186 + 1 file / +2 tests) |
| `pnpm check:worker-daemon-boundary` + self-test | PASS + 46/46 |
| `pnpm --filter @armyofagents/worker-daemon exec tsc --noEmit` | PASS — exit 0 |
| `npx tsc --listFilesOnly` (packages/worker-daemon) | PASS — 0 files under `src/__tests__` |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` | PASS — zero changed worker-protocol files |
| `pnpm install --frozen-lockfile` | PASS — no-op |
| runtime `dependencies` purity | PASS — exactly `@armyofagents/worker-protocol` + `pino` |

## Decision

WRK-004 is `complete` / `pass`. The sandbox supervisor + monotonic cleanup authority enforce the
containment guarantee (effect/cleanup separation, redaction, no-existence-oracle, no-local-spawn,
process-tree escalation, idempotent cleanup) with the create-window leak closed and a faithful
adversarial fake. Composed-inert per E4-D12 pending live dispatch. **This completes E4 CORE
(WRK-001..004).** WRK-005+ require `E6-D1-FOUNDATION`. Next: **DEP-000..004 → the
E6-D1-FOUNDATION partial gate** (DEP-000 implements the exported `SandboxProvider` port).
