# E4-D12 — live worker dispatch (the worker self-model) · terrain

**Status: TERRAIN ONLY. No design, no code.** Sizing pass requested before any work stacks behind
this. Line references are to `docs/replatform-program` at `1334c8a90`.

**Why this document exists.** While terrain-mapping DAT-008 slice 5 (worker-side credential
redemption) I found that **the worker daemon does not dispatch work at all**. That makes E4-D12 a
second, unowned blocker on MIG-005/006/007 ACTIVE, sitting beside inherited deferral #1 — the same
shape, discovered the same way.

---

## ★ 0. Headline, and a correction to my own first read

**The blocker is real. My first estimate of its SIZE was wrong, in the expensive direction.**

I initially reported that closing this needs a change to the FROZEN enroll response — an E4-D02
STOP requiring the Protocol/Schema Custodian plus D0-T04 evidence. **That is not required.** The
data the worker needs already exists server-side, is already written through a live route, and is
already exercised by the D1 lane. What is missing is a **read channel** and the **boot composition**
— neither of which touches `packages/worker-protocol`.

Recording the wrong estimate rather than quietly replacing it, because "this needs a frozen
protocol change" is exactly the kind of claim that reshapes a programme's sequencing if nobody
checks it.

## 1. What is actually inert — six verified facts

| # | Fact | Evidence |
|---|---|---|
| 1 | `createPollLoop` has **no production caller** | only its definition (`poll-loop.ts:469`) + an `index.ts` re-export |
| 2 | `createSupervisor` has **no production caller** | only its definition (`supervisor.ts:151`) |
| 3 | The daemon's `leasing?` dependency is optional and **nothing supplies it** | `bin/worker-daemon.ts:91` |
| 4 | Its own comment says why | `:85-89` — *"NOT wired at runtime yet: starting a real loop needs the worker's server-assigned self-model … which the as-built JOB-002 enroll response does not deliver (only a provider ref)"* |
| 5 | `AOA_WORKER_TARGET_PROFILE_ID` — set on **both** D1 worker containers — is **read by no daemon source file** | `docker-compose.d1.yml:297,339`; zero hits in `packages/worker-daemon/src` |
| 6 | The frozen enroll response carries `workerId, targetId, deviceGeneration, providerConstraints` (a **ref**) and is `.strict()` | `transport.ts:197-208` |

~~So the D1 lane's workers enroll, poll, and exercise the control-plane routes.~~ **CORRECTED —
that sentence is FALSE and it under-stated the gap.** The D1 workers do not enroll either:
`bin/worker-daemon.ts:250` gates the whole enrolment block on
`config.keyStoreMode === "os_keychain"`, and both D1 workers set
`AOA_WORKER_KEY_STORE_MODE: "mounted_secret"` (`docker-compose.d1.yml:312,348`). The container entry
injects no identity/receipt stores at all. The D1 workers boot, serve `/healthz`, and do nothing
else — as `tests/d1/e6f-03-networked-smoke.test.mjs:8-9` states outright: *"There is NO live
worker-daemon loop — the harness plays the worker with HTTP calls + real proofs."*

**Consequence for sizing:** "default OFF" in D1 is currently indistinguishable from "cannot enrol",
so a flag-off gate there would prove nothing. Fact 5 is worth dwelling on: the compose file looks like it provisions a profile, and
nothing consumes it. A reader checking "is dispatch wired?" by looking at the topology would
conclude yes.

## 2. What the loop actually needs — three fields, and only two are missing

`PollLoopDeps.self: WorkerSelfModel` (`poll/capacity.ts:112-116`):

| Field | Source | State |
|---|---|---|
| `report: WorkerHelloV1` | the worker's own self-report | ⚠️ **CORRECTED — buildable locally, IRRELEVANT locally.** See below. |
| `registeredTargetProfile: RegisteredTargetProfileV1` | **server authority** | ❌ not delivered |
| `verifiedProviderConstraints: VerifiedProviderConstraintProfileV1` | **server authority**, branded | ❌ not delivered (enroll gives a *ref*) |

> ★ **THE `report` ROW WAS THE SIZING ERROR IN THIS DOCUMENT.** The worker's local hello is not what
> the server matches on. The server runs the matcher over its OWN stored copy,
> `workers.profile_snapshot` (`job-leasing.ts:562-565,725-727`), whose only two writers are
> `request.hello` at enrolment (`worker-enrollment.ts:444,470`). **There is no update channel.** And
> the daemon's only production hello builder is `buildDesktopHello`, whose header says it exists to
> emit a desktop that *"can never be matched work"*. So a daemon can assemble a perfect
> `WorkerSelfModel`, self-check correctly, and be offered nothing — forever. Composing the loop does
> not, by itself, produce a worker that receives work.

## ★ 3. Both missing artifacts ALREADY EXIST server-side and are already written

This is the finding that changes the size.

- `execution_targets.registeredProfile` is stored, and `execution-target-resolver.ts:8,25` parses
  it with the frozen `registeredTargetProfileV1Schema`. **Placement reads it on every decision.**
- It is written by a live route: `PUT /organizations/:orgId/execution-targets/:targetId/placement-profile`
  (`routes/execution-targets.ts:277-279`), whose body is exactly
  `{ registeredProfile, providerConstraintProfile }` (`:45-48`), guarded by `assertOrgAdmin`.
- **The D1 lane already provisions it** — its seeds assert a 64-hex `registeredProfileHash`
  (`tests/d1/e6f-01-lease-races.test.mjs:152`, `e6f-03`, `e6f-04`). The provisioning mechanism is
  live and exercised, not theoretical.

**And the worker does not need the server to vouch for the constraint profile.**
`verifyAndBrandProviderConstraintProfileV1(profile, sha256Fn)`
(`packages/worker-protocol/src/capabilities.ts:246-266`) re-derives the profile's own digest from
canonical bytes and returns the branded type only on a match — *"a field mutation that reuses the
old digest yields null"*. So the worker brands it **locally**; the channel only has to deliver
bytes, and a tampered profile fails closed at the worker.

> **Therefore the gap is a READ CHANNEL plus BOOT COMPOSITION. Not a protocol change.**

## ★ 4. Why no frozen change is needed — the DAT-008 precedent applies exactly

The instinct is to add the profile to the enroll response. That response is `.strict()` inside the
FROZEN package, so that route *would* be an E4-D02 STOP. It is also unnecessary:

1. **E4's own WRK-005 non-goals** already assign *"the live … transport ops and their server
   routes"* to the owning epic (`E4-worker-daemon/implementation-plan.md:830-833`).
2. **DAT-004, DAT-005 and DAT-008 all declared their request shapes "Not a frozen wire op"** and
   live control-plane-side. DAT-008 shipped exactly this shape in this session: a
   `/worker-control/execution-secrets/resolve` route with a **local** descriptor pinning audience,
   size ceiling and timeout, using frozen *schemas* over a non-frozen *transport*.
3. **A worker-authenticated surface to `execution-targets` already exists and is live.**
   `requireWorkerHeartbeatAuthority` + the proof-bound `VerifiedTargetPrincipal` path already
   authenticate a worker to its own target row, addressed with **no org or slug in the URL** so a
   caller *"can never address another tenant's row"* (`execution-targets.ts:334-341`).

A worker-facing read of its own target's two profiles has an existing, correctly-scoped auth home.

## 5. Size — two slices, plus the questions that decide the second

**Slice 1 — control plane (small).** A worker-authenticated read returning
`{ registeredProfile, providerConstraintProfile }` for the caller's own target, with a local
descriptor. Mirrors DAT-008 slice 4 almost line for line. The auth middleware exists; the storage
exists; the schemas exist.

**Slice 2 — daemon + boot composition (the real work).** Client method + vendored path (E4-D04
parity test), self-model assembly, local branding via
`verifyAndBrandProviderConstraintProfileV1`, then compose `createPollLoop` + `createSupervisor`
into `bin/worker-daemon.ts` and supply `leasing`. **This is the first time the daemon dispatches
anything**, so it is where the risk is, not slice 1.

> ★ **CORRECTION (WRK-008 slice 2 design).** The sentence above — *"compose `createPollLoop`
> + `createSupervisor` into `bin/worker-daemon.ts`"* — is **not implementable as written**,
> and this terrain missed why. `SupervisorDeps.provider` is REQUIRED; worker-daemon
> implements the `SandboxProvider` port **zero** times; the only implementation
> (`E2bSandboxProvider`) lives in a package that **depends on** worker-daemon, so importing
> it is an E4-D01 breach *and* a dependency cycle; and `sandbox-fake-provider` implements the
> *contract driver* port, not this one. **The daemon can never construct its own provider**,
> so the composition root lives outside the package — and none exists. That is a FOURTH open
> question, larger than the three below, and it is the reason slice 2 split into 2a/2b.

**Open questions slice 2 must answer — these are the sizing risk, not the plumbing:**

- **A target with no admin-set profile has none.** Enrolment alone does not produce a dispatchable
  worker. What does the daemon do — refuse to lease (fail closed), or poll without a self-model?
  Fail-closed is almost certainly right, but it means **enrolment is not sufficient for a working
  worker**, which is a product-visible statement someone should make deliberately.
- **Generation change / revocation mid-run.** `registeredTargetProfile` carries `deviceGeneration`
  and `revokedAt`. When does the worker re-read? A cached self-model across a generation bump is a
  worker advertising ceilings it no longer holds.
- **Ordering against enroll.** Enroll mints the session; the profile read needs it. So the boot
  order is enroll → profile read → loop. A failure at step 2 must not leave a half-started daemon.

## 6. Who else is blocked by this

- **MIG-005 / MIG-006 / MIG-007 ACTIVE** — a cutover routes work to a worker. No worker dispatches.
  This is *in addition to* DAT-008, not instead of it.
- **DAT-008 slice 5** — buildable and unit/contract-testable, but **not exercisable end to end**
  until this lands.
- **CLI-002's live sandbox path** and **DSK-001's design** both reference the self-model
  (`DSK-001-design.md:341`).

## 7. Ownership — unowned, exactly like deferral #1

E4-D12 appears **only as prose**, in `E4-worker-daemon/implementation-plan.md:838`. There is no
ticket, no gate, no owner, and no dependency edge from MIG-005/006/007 to it. The plan sequences
three cutovers behind a blocker it does not schedule — **for the second time in this programme.**

The first instance (deferral #1) was resolved by adding a ticket. The same answer likely applies,
but it is the Integration Gate Owner's call, and it is a live decision rather than a formality:
E4 is otherwise complete, so a new ticket either **reopens E4** or lands in whichever epic owns
live dispatch.

## 8. Traps

- **Do not conclude "frozen change needed" from the enroll response alone.** §4. I did, and it was
  wrong. Check whether the data already has a home before assuming the wire must carry it.
- **`AOA_WORKER_TARGET_PROFILE_ID` is a decoy.** It is in the D1 compose and no source file reads
  it. Do not build on it without checking a consumer exists.
- **A caller is not a caller until you trace it to a boot root.** Both `createPollLoop` and
  `createSupervisor` look wired — they are exported, typed, and heavily tested.
- **The worker brands the constraint profile itself.** Do not design a "trusted delivery" channel
  for something the frozen verifier already re-derives from canonical bytes.
