# Wave 4 — re-sequenced on the walking skeleton's verified chain

**Status: TERRAIN. No design, no code.** Supersedes the ordering in
[`WAVE-4-EXECUTION-PLAN.md`](./WAVE-4-EXECUTION-PLAN.md), which was written before the spike and does
not reference it. Produced by a 27-agent probe of six chain links, every blocker-severity claim put
through an adversarial refutation pass, and the load-bearing facts re-verified by hand afterwards.

**Read [`SPIKE-worker-walking-skeleton.md`](./SPIKE-worker-walking-skeleton.md) first.** This document
assumes its nine findings.

---

## 0. Method, and its one defect — stated first because it colours everything below

Six probe agents mapped one chain link each; every `blocker`-severity claim was then handed to an
independent agent whose instructions were to **refute** it.

**Twenty-one of twenty-one blocker claims came back "REFUTED", and none "CONFIRMED".** A refuter that
cannot return "confirmed" is a check that nothing runs — the exact failure class this programme keeps
finding — so that number is **not** evidence the chain is clear.

The cause is a defect in my harness, not in the agents: the verdict schema carried a **binary**
`refuted` boolean, and the prompt told them to refute and to default to refuted when uncertain. So
"the claim is false" and "the claim is true but overstated" collapsed into one value. Reading the
reasoning shows the refuters were doing real work — the first line of one is *"the CORE FACT is true
and I confirmed every line they cite — but the claim is overstated on its lock count"*.

**Therefore: the flags are discarded, and only the reasoning is used.** Every fact below is either
verified by hand (marked OK) or carries the file:line the probe cited.

A future run of this harness should use a three-way verdict (`false` / `overstated` / `confirmed`)
and must not instruct the verifier to prefer one outcome.

## 1. Two corrections to things I asserted earlier in this session

**1.1 — I said the provider question "isn't written down anywhere in the programme". That is
FALSE.** (OK, verified) `packages/sandbox-e2b-provider/` exists and is built: `e2b-provider.ts`,
`transport.ts`, `real-transport.ts`, `mock-transport.ts`, `per-op-adapter.ts`, `capability-matrix.ts`,
`directives.ts`. CLI-001 owns it. A real `SandboxProvider` implementation **exists and ships**.

The genuine gap is far narrower than I stated, and correspondingly smaller: it is **composition and
packaging**, not architecture. See section 3.7.

**1.2 — `check-dependency-graph.mjs`, which I built this session, is blind to the work it is meant to
govern.** (OK, verified) Its sole authority is `docs/replatform/program-design.md`, and that file
contains **zero** occurrences of `DAT-008`, `WRK-008`, and `WRK-009` — three tickets from this
session, two with landed code. It has been passing green while unable to see them.

That is my own guard exhibiting the failure class I built it to catch, which is worth stating plainly
rather than folding into a list. It also means every "no dependency edge exists" conclusion drawn
from that guard — including ones I have relied on — needs re-deriving.

## 2. The chain, corrected

The spike's chain had six hops. The probe found **seven**, and the new one is not a variant of any
existing ticket:

```
identity -> enrolment input -> SESSION ACQUISITION -> matchable hello -> self-model read
                                    (new)                                      |
                                                                               v
                                                       loop composition -> provider transport
```

## 3. Link by link — what is built, what is missing, who owns it

### 3.1 Container identity — NO OWNER

Confirmed and **narrower than F1 stated**. Two custody modes exist; the only production
`DeviceRecordStore` is Windows-gated twice, lives in `worker-keystore` (a package the worker image
never copies), and is injected only by `desktop-host.ts`.

The refutation added a correction that cuts *against* the original framing and is worth keeping:
`MountedSecretKeyStore` has **zero production constructors**, and `generateDeviceKey` is reachable
only from inside the enrolment path. So a shipped `mounted_secret` container holds **no identity and
no key** — F1's "a keypair and nothing to be" was generous. `mounted_secret` in the shipped image is
a config label whose only runtime effect is passing `resolveCustody`.

It also corrected the lock count: `bin/worker-daemon.ts:250`'s mode check is documented **dead code**
(its own comment says the line is unreachable with `mounted_secret` and that the mutation survives).
Two real locks, not four — a barrier that cannot fire was being counted as a barrier, inside a claim
about barriers that cannot fire.

### 3.2 POSIX enrolment input (F5) — NO OWNER

Real, and refined: the rejection is **arm-specific** (`{kind:"path"}` rejects every POSIX absolute
path), and the probe found the Windows-only assumption is a **class of five sites**, two of which are
hard platform gates firing *earlier* than F5 on Linux.

**But it is not next.** It is unreachable until 3.1, because the enrolment block never executes.
Sequencing it first would produce a fix nothing can exercise.

### 3.3 Session acquisition for an already-enrolled device — NO OWNER, NOT PREVIOUSLY NAMED

`createWorkerSessionToken` has exactly two production callers, both **inside the enroll route**, and
`enrollOnce` deliberately discards `result.session` (documented as I13). So there is **no path for an
already-enrolled device to obtain a session** — a restarted worker cannot resume without re-enrolling,
and re-enrolling burns the one-shot profile snapshot (3.4).

This appears in no ticket, no terrain, and not in the E4-D12 open questions. It is a genuine new link.

### 3.4 A matchable worker hello — NO OWNER

The matcher works (proven nightly). The daemon's only producer is `buildDesktopHello`, deliberately
unmatchable. `workers.profile_snapshot` is written **only** at enrolment with no update channel — so
the first hello is **one-shot**: a container that enrols with the desktop hello burns its snapshot on
a permanently unmatchable self-report.

The refuter added that no production `CapacityProbes` implementation exists, so even a correct
builder has no capacity source.

### 3.5 Self-model read — HALF OWNED (WRK-008)

Slice 1 landed the **server** half. The daemon's `ControlPlaneClient` has no method and no path for
`/api/execution-targets/self/placement-profile`. Already recorded in slice 1's result as "a door with
no one walking through it"; the probe confirms it independently.

### 3.6 Loop composition (E4-D12 slice 2) — PARTIALLY OWNED

Two findings that are worse than plumbing and appear in neither the terrain nor the Wave-4 plan:

- **`LeasingLifecycle` is stop-only** (`shutdown.ts:19-24` — `stopLeasing`/`drain`). A daemon handed
  `deps.leasing` composes a **shutdown seam around a loop that was never started**. There is no start
  seam. `bootstrapWorkerDaemon` never calls `.run()` on anything.
- **Three of `PollLoopDeps`' eight required fields have no production producer at all**: `key`
  (derived inside `enrollOnce`, never returned), `session` (see 3.3), and `supervisor.provider`
  (removed by WRK-009 — correctly).

### 3.7 Provider transport — the architecture is DECIDED and MACHINE-ENFORCED; the service does not exist

This is the most important correction in the document.

(OK, verified) **Out-of-process is not a design option — it is already enforced.**
`scripts/lib/staging-manifest-invariants.mjs:448-462` forbids the provider-control credential on
every non-adapter service, and the guarantee spans `environment`, `env_file`, `secrets`, `configs`
and mounts — not just an environment scan. So the real E2B provider **may not run in the worker
container**, on a constraint entirely separate from E4-D01, and one the programme had not named.

`docker-compose.staging.yml` declares the intended counterpart: an `adapter-manager` service holding
the key on `provider-ctl-net`. **It has no Dockerfile, no source, no wire protocol, no worker-side
client, and no env var addressing it.** The compose files also set two provider-address env vars that
nothing reads — the wire *looks* plumbed and is not, the same decoy shape as
`AOA_WORKER_TARGET_PROFILE_ID`.

So: a real provider exists (1.1) and cannot legally run where the daemon is; the service it must
talk to is declared and unbuilt.

## 4. The tracking system cannot see the work

Beyond 1.2, the probe reports (file:line cited, not hand-verified here):

- **21 ticket IDs are named as dependencies of other tickets but have no ticket file anywhere** — all
  of E9's `SVC-001..007`, `BRW-003..008`, `MIG-001`, `MIG-004`, `REL-001/002/003/005`.
- **E9 has no `tickets/` directory**; E5/E7/E8/E9/E10/E11 have **no `implementation-plan.md`**.
- **MIG-005/006/007's `Depends on:` lines still express no dependency on live worker dispatch** —
  the third instance of this programme sequencing work behind a blocker it does not schedule.
- `SPIKE-worker-walking-skeleton.md` is referenced by nothing except WRK-009's documents.

## 5. Recommended sequence — and the honest recommendation

**Do not resume MIG-005/006/007 ACTIVE.** They are sequenced behind a chain with four unowned links,
and their dependency lines do not name it.

Ordered by *what unblocks the most*, with the cheap-and-decisive first:

| # | Work | Why here |
|---|---|---|
| 0 | **Fix the tracking** — add the five missing tickets to `program-design.md`, then re-run `check-dependency-graph.mjs` and re-derive every "no owner" claim | Cheapest, and every other judgement depends on it. My own guard is currently blind (1.2) |
| 1 | **Decide the provider topology deliberately** — adopt the enforced out-of-process model and write the `adapter-manager` contract, or change the invariant | 3.7 makes this a fork nothing else can proceed past. It is a decision, not an implementation |
| 2 | **Container identity** (3.1) | Hard gate on every later link |
| 3 | **Session acquisition** (3.3) + **POSIX input** (3.2) | Both become reachable only after 2 |
| 4 | **Matchable hello** (3.4) | One-shot snapshot means it must be right *before* first enrolment |
| 5 | **Self-model client** (3.5) + **start seam** (3.6) | The smallest remaining pieces |

**The honest recommendation.** The distributed worker path is substantially further from working than
the plan implies: seven links, four with no owner, one enforced-but-unbuilt service, and a tracking
system that cannot see three of this session's tickets. If the goal is a usable product soon, the
worker path should be sequenced deliberately as its own programme with an owner per link — and the
product's near-term capability should not be planned as though live worker dispatch is close.

Steps 0 and 1 are cheap and change what everything else means. They should happen before any more
code lands on this path.
