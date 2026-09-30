# WRK-008 slice 2 — Design: compose the daemon so it actually dispatches

**Status:** DESIGN. **Start SHA:** the commit that adds this file.
**Epic:** `E4-worker-daemon`. **Closes:** E4-D12's daemon half (slice 1 closed the control-plane half).
**Terrain:** [`E4-D12-live-dispatch-terrain.md`](./E4-D12-live-dispatch-terrain.md), plus §1 below,
which corrects it.
**Blocks:** DAT-008 slice 5 → deferral #1 → MIG-005/006/007 ACTIVE.

---

## ★ 1. A FOURTH open question the terrain and the plan both missed

[`WAVE-4-EXECUTION-PLAN.md`](../../../WAVE-4-EXECUTION-PLAN.md) §5 lists three open questions, and
my own terrain §5 lists the same three. Re-reading the code to design against them surfaced a
fourth that is larger than all three, and it invalidates how *both* documents describe this slice:

> Terrain §5: *"compose `createPollLoop` + `createSupervisor` into `bin/worker-daemon.ts`"*

**That is not implementable as written.** `SupervisorDeps.provider: SandboxProvider` is REQUIRED,
and:

| Fact | Evidence |
|---|---|
| worker-daemon **defines** the `SandboxProvider` port and implements it **zero** times | `supervisor/provider.ts` is the interface; the only implementer in the package is `__tests__/support/fake-provider.ts` |
| The only real implementation is `E2bSandboxProvider` | `packages/sandbox-e2b-provider/src/e2b-provider.ts:136` — *"implementing worker-daemon's authoritative per-op `SandboxProvider`"* |
| That package **depends on** worker-daemon | its `package.json` deps include `@armyofagents/worker-daemon` |
| So the daemon **cannot** import it | E4-D01 allows `@armyofagents/worker-protocol` + `pino` + Node builtins only; the dependency already points the other way, so reversing it is a cycle as well as a boundary breach |
| `sandbox-fake-provider` is **not** a substitute | it implements the *contract* port `SandboxProviderDriver`, a different port (the open E6-F008 two-ports item), not the per-op `SandboxProvider` |
| `BootstrapDeps` has **no** seam to inject one | it has `leasing?`, `renewal?`, `eventOutbox?`, `reconciler?` — lifecycle seams only |

**The polarity is already correct and must stay that way.** Providers depend on the daemon; the
daemon depends on no provider. Therefore the daemon can never construct its own provider, and the
composition root that supplies one **lives outside this package**. No such root exists today.

## ★ 2. The consequence, which is a better answer than the flag the plan asked for

The plan's §4.2 named the single largest risk in Wave 4:

> *"Composing the loop therefore turns dispatch on **unconditionally, for every daemon running that
> build**, including both D1 workers, the moment it merges."*

**Given §1, that risk does not arise.** The shipped entrypoint is
`bootstrapWorkerDaemon({ env: process.env, proc: process })` — it injects nothing, and it *cannot*
acquire a provider. With no provider there is no supervisor, and with no supervisor there is no
loop. **Dispatch is off by construction, not by a flag**, exactly as `leasing`/`renewal`/`reconciler`
are already inert-by-absence.

That is a stronger guarantee than a flag, and it is the same shape the daemon already uses.

**A flag is still required, and it must be non-vacuous.** Absence-of-provider protects the *current*
binary; it does nothing the day a host is written. So the opt-in gates composition **given** a
provider:

| provider injected | `AOA_WORKER_DISPATCH_ENABLED` | result |
|---|---|---|
| no | anything | inert (no loop) — by construction |
| yes | unset / not `"1"` | inert (no loop) — **by the flag** |
| yes | `"1"` | loop composed, dispatch live |

Row 2 is the flag's whole purpose and it is directly testable with the existing test fake, so this
is not a guard that can never fire. Row 3 is unreachable for the shipped binary today; the test
suite reaches it by injection, which is how every other lifecycle seam here is tested.

**What this slice does NOT do:** write the host. Choosing where the composition root lives
(a new `worker-host` package vs. a bin inside `sandbox-e2b-provider`) is a package-topology decision
with a release/packaging dimension (DSK-003 ships the desktop host), and it is not E4's to make
unilaterally. This slice makes the daemon *composable* and leaves an explicit, typed seam. Stated
plainly so nobody reads "dispatch composed" as "dispatch shipped".

## 3. The other three questions, answered

**Q1 — a target with no admin-set placement profile.** **Fail closed.** The daemon logs an
attributable reason and stays up serving health; it does not poll. The product-visible consequence,
asserted deliberately rather than discovered: **enrolment alone does not produce a dispatchable
worker** — an admin must set a placement profile on the target.

Polling without a self-model is rejected outright: the loop's `measure()` advertises capacity
against ceilings that would otherwise be invented locally, and a worker advertising ceilings no
authority granted is exactly what slice 1's route refuses to serve.

**Q2 — generation bump / revocation mid-run. No client-side refresh, and that is not a gap.**
Verified rather than assumed: `job-leasing.ts` re-checks `worker.deviceGeneration ===
auth.targetGeneration`, `target.deviceGeneration === auth.targetGeneration` and `worker.revokedAt
=== null` on **every** poll and again under the lease lock (`:256-303`, `:443-452`), and the daemon
already treats a `target_revoked` code as **terminal** — the loop stops rather than backing off
(`poll-loop.ts:264,344`). So the authority is the server on every single poll, and a stale cached
self-model cannot buy a lease.

What a stale self-model *can* do is over-advertise local ceilings to the concurrency limiter. That
is a capacity-shaping error, not an authorization one, and the server re-checks placement anyway.
Adding a re-read loop would create a second, weaker authority for something the poll path already
decides — so this slice deliberately adds none, and says so.

**Q3 — ordering.** `enroll → self-model read → compose`. The read needs the session enroll mints,
so the order is forced. A failure at the read leaves the daemon **healthy and inert** rather than
half-started: composition is the last step before signal registration, and the existing degradation
(`deps.leasing ? … : []`) already yields an empty step list. No new failure mode is introduced —
the daemon lands in the state it ships in today.

## 4. What lands

| # | Piece | Where |
|---|---|---|
| 4.1 | `provider?: SandboxProvider` on `BootstrapDeps` | `bin/worker-daemon.ts` |
| 4.2 | `AOA_WORKER_DISPATCH_ENABLED` in the `ENV` map + config | `config/config.ts` |
| 4.3 | Self-model assembly: read → `verifyAndBrandProviderConstraintProfileV1` → `WorkerSelfModel` | new `identity/self-model.ts` |
| 4.4 | `decideDispatchComposition(...)` — the pure decision of whether to compose, and why not | new `lifecycle/compose-dispatch.ts` |
| 4.5 | Wiring 4.4 into `bootstrapWorkerDaemon` | `bin/worker-daemon.ts` |

**4.4 is a pure function returning a decision + reason**, not a boolean, for the same reason
`isSweepEligible` is: the *reason* a worker is not dispatching is the operator-facing answer, and a
boolean throws it away. The refusals — no provider, flag off, no profile — are each mutation-tested.

## 5. Tests

| Area | Test |
|---|---|
| ★ flag off + provider present ⇒ **no loop** | the non-vacuous row of §2's table |
| ★ provider absent ⇒ no loop, whatever the flag says | dispatch cannot be turned on by env alone |
| ★ no placement profile ⇒ fail closed, attributable reason | Q1 |
| flag on + provider + profile ⇒ composed | the positive case |
| The reason is distinct per refusal | a boolean would collapse these; the operator needs which |
| Self-model assembly maps every branded field | no field silently dropped |
| ★ Read failure leaves the daemon healthy and inert | Q3 — not half-started |

## 6. Out of scope, stated

- **The host / composition root** (§2). This slice ships a seam, not a running dispatcher.
- **DAT-008 slice 5** (`env: {}` → redeemed credentials). Next in the sequence; between the two,
  a composed daemon would start a CLI with no credential — which is why no host exists yet.
- **The per-run canary registry** — `WAVE-4-EXECUTION-PLAN.md` §4.1 found `redactionCanaries` is
  per-supervisor, not per-run. That is slice 5's problem and is not pre-solved here.
- **E6-F008**, the two provider ports. §1 documents that they are distinct; it does not merge them.
