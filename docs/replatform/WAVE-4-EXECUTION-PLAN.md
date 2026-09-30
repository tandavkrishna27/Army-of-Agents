# Wave 4 — consolidated execution plan (Lane A)

> ### ★★★ BLOCKER — a worker cannot hold authority for more than 15 minutes
>
> Verified in code while mapping slice 2b: the enrollment **code route lives 10 minutes**, a
> **session lives 15**, a session is minted **only** by enrollment, and **no device-session
> renewal route exists**. A worker enrolled at T0 is authority-less at T0+15min with no path
> back. This is `E4-F007` — **open, HIGH, and owned by no ticket** — and DSK-001's risk
> register (R1) recommended filing the successor *"now, before DSK-003 is planned"*. DSK-003
> shipped; it never was. **MIG-005/006/007 ACTIVE cannot cut over onto this**, and DSK-003's
> desktop host is by its own design doc "unshippable without it".
> See [`WAVE-4-BLOCKER-worker-session-lifetime.md`](./WAVE-4-BLOCKER-worker-session-lifetime.md).
>
> ### ★★★ EVERY REMAINING DAT-008 SLICE IS BLOCKED, AND ONE IS ALREADY DONE
> 
> §4's table lists slices 6 and 7 as "terrain, design, reviewed — **nothing** needed before
> code". Checked against the tree on 2026-08-24, that row is wrong in both cells:
> 
> | Slice | Plan says | Actually |
> |---|---|---|
> | 5 — worker redemption | next after 2b | **blocked**: needs WRK-008 2b + a composition root |
> | 6 — deferral #3 | ready to build | **DELIVERED** by slice 1 (`ownerAuthoritiesAgree`, wired, 4/4 mutants) |
> | 7 — warm-resume re-resolution | ready to build, "gates MIG-005" | **nothing to attach to** |
> 
> Slice 7 re-resolves a credential *at warm resume*. **The distributed path has no warm
> resume.** There is no pause/resume on a job lease, the supervisor never resumes a sandbox,
> and `provider.restore` / `provider.checkpoint` are reachable only from `effect-authority`,
> whose restore/checkpoint methods are called from **tests only**. The warm-resume machinery
> that does exist (`environment-runtime.ts` U7.7, OAuth connector tokens) is the LEGACY
> `#320` path — a different mechanism for a different credential class.
> 
> **So there is no Wave-4 work that is both unblocked and not already done.** Every
> remaining item sits behind the worker chain: composition root → WRK-008 2b → E4-F007 →
> DAT-008 5 → 7 → MIG-005/006/007. Picking up "the next ready ticket" is not available;
> the two ownership decisions are what unblock the wave.
> 
> ### ★★ INHERITED DEFERRAL #3 NAMES THE WRONG GUARD
> 
> Its text says safety *"rests on the structural exclusion of `owner_desktop` routing"*.
> It does not: `owner_desktop` routing is supported (`job-placement-transaction.ts:300`).
> Safety rests on the FROZEN matcher's per-candidate owner comparison
> (`capabilities.ts:514`) — which had **no falsifiable test** until 2026-08-24, along with
> four sibling placement guards. See `E1-F008`. The mint-side half of deferral #3
> (`ownerAuthoritiesAgree`) was already closed by DAT-008 slice 1 and is mutation-proven,
> so **DAT-008 slice 6 is delivered, not pending** — the plan's "straight to fail-first
> TDD" row for it is out of date.
> 
> ### ★★ THE PROVIDER SEAM IS ONE QUESTION ASKED THREE WAYS — decide it once
>
> `scripts/check-finding-ownership.mjs` (TRACK-003) put the open findings in one place for
> the first time, and three of the four unowned ones turn out to be the same question:
>
> | Item | Asks |
> |---|---|
> | **The composition root** (blocker #3) | who constructs a `SandboxProvider` and hands it to the daemon? |
> | **E6-F008** (MED, open) | `sandbox-provider-contract`'s driver port and worker-daemon's `SandboxProvider` are structurally unrelated — which is authoritative? |
> | **E6-F004** (MED-HIGH, open) | where does `sandbox-fake-provider` import the port FROM, and what does the boundary check allow? |
>
> Answering any one of them in isolation just moves the seam. **E6-F003 (HIGH, open)** is
> the fourth face of it — the networked driver API a worker's provider driver speaks was
> never specified, so there is no worker→provider path even when a provider exists.
>
> All four were filed against tickets that have since SHIPPED (DEP-000, CLI-001), so they
> were carried past their own resolution point with nothing watching. E6-F008 is not
> academic: it was hit head-on designing WRK-008 slice 2, four days after being filed.
>
> **Recommendation: one ticket owns the provider seam** — composition root, port
> reconciliation, fake-provider import source, and the networked driver API — rather than
> four partial answers.

> ### ★ UPDATE — WRK-008 slice 2a landed; two claims in this document are now WRONG
>
> **1. §4.2's "largest single risk in the plan" does not exist.** It warned that composing
> the loop "turns dispatch on unconditionally, for every daemon running that build,
> including both D1 workers, the moment it merges". It cannot. `SupervisorDeps.provider` is
> REQUIRED; worker-daemon implements the `SandboxProvider` port **zero** times; the only
> implementation depends ON worker-daemon (so importing it is an E4-D01 breach *and* a
> cycle); and `sandbox-fake-provider` implements a different port. The shipped entrypoint
> injects nothing and **cannot acquire a provider**, so dispatch is off *by construction*.
> The flag shipped anyway, placed so it can actually fire (it gates composition GIVEN a
> provider). See [`WRK-008-slice-2-result.md`](./epics/E4-worker-daemon/tickets/WRK-008-slice-2-result.md) §3.
>
> **2. §5's "three open questions" were four.** The fourth — *where does the daemon's
> provider come from?* — is larger than the other three and made this slice's own stated
> scope ("compose the loop into `bin/worker-daemon.ts`") **not implementable as written**.
> The composition root lives OUTSIDE `packages/worker-daemon` and **does not exist**;
> choosing where it lives is a package-topology decision with a release dimension
> (DSK-003 also ships a desktop host), and it is not E4's to make alone. **It is now the
> top unowned item in this wave.**
>
> **Slice 2 is therefore 2a (landed) + 2b (open).** 2a made the daemon explain its silence;
> 2b threads the session lifecycle, calls `client.selfModelRead`, and constructs the
> supervisor + poll loop. Step 3 (DAT-008 slice 5) still waits on 2b, for the reason §3
> already gives: it would otherwise land on a path nothing executes.


**As of** `docs/replatform-program` local tip `0293510f8` (`1334c8a90` pushed; the E4-D12 terrain
is committed and awaiting a clean gate before push).
**Scope:** the cutover critical path. Lane B (E8/E9) runs concurrently in `C:\e8` and is not
sequenced here — see [`HANDOFF-lane-b-browser-service.md`](./HANDOFF-lane-b-browser-service.md).

---

## 1. Two blockers, not one — and they are now both mapped

Wave 4's goal is to cut MIG-005/006/007 from shadow to active. Two prerequisites stand in front of
that, and **the plan as written scheduled neither**:

| Blocker | Owner | State |
|---|---|---|
| Deferral #1 — a worker receives no provider credential | **DAT-008** (created this session) | slices 1–4 landed CI-green; 5, 6, 7 open |
| **E4-D12 — the worker does not dispatch at all** | **WRK-008** (created; slice 1 + slice 2a LANDED, 2b open) | terrain done ([`E4-D12-live-dispatch-terrain.md`](./epics/E4-worker-daemon/tickets/E4-D12-live-dispatch-terrain.md)) |

Both were found the same way: a mechanism that looks wired, isn't, and whose absence nothing
detects. That is the programme's signature failure class, now on its third and fourth instance.

## ★ 2. Ownership decision required — recommendation: WRK-008, reopening E4

E4-D12 exists only as prose in `E4-worker-daemon/implementation-plan.md:838`. No ticket, no gate,
no owner, no dependency edge.

**Recommendation: a new ticket `WRK-008` in E4.** The work is a worker-daemon composition plus one
control-plane read route; it is E4's own deferred decision, carrying E4's own decision id. Putting
it anywhere else would separate the ticket from the plan that deferred it.

**Cost, stated plainly: this reopens E4, which currently reports complete.** That is the honest
consequence and it is preferable to parking live-dispatch work in an epic that never designed it.
Same call as DAT-008, same reasoning.

## ★ 3. The sequence — CHANGED, and the change is the point

My earlier advice was "DAT-008 slice 5 next". **That order is wrong**, and the terrain pass is why.

DAT-008 slice 5 puts credential redemption into `createSpecFor` on the supervisor. E4-D12 slice 2
composes that same supervisor and poll loop into the daemon's boot. If slice 5 goes first it lands
on a path nothing executes — **buildable, unit-testable, and unprovable end to end.** Reversing them
costs nothing and turns slice 5 from asserted to demonstrated. It also avoids editing
`supervisor.ts` twice for two different reasons.

```
1. WRK-008 slice 1   control-plane: worker-authenticated read of its own target profiles
2. WRK-008 slice 2a  daemon: decision + flag + provider seam + self-model assembly  [LANDED]
2b. WRK-008 slice 2b  session lifecycle + read + COMPOSE loop/supervisor  <- dispatch goes LIVE
2c. THE COMPOSITION ROOT  a package outside worker-daemon must supply a provider  <- UNOWNED
3. DAT-008 slice 5   worker redemption + env synthesis + canary seeding       <- now provable
4. DAT-008 slice 7   warm-resume re-resolution                                <- gates MIG-005
5. DAT-008 slice 6   deferral #3 on the placement side
6. MIG-005 -> soak -> MIG-006 -> soak -> MIG-007                              <- one at a time
7. MIG-001           Decision #117 target/credential routing
```

**Why 4 before 6:** MIG-005 is both the first sink and the only warm-lease sink. Without slice 7 the
first cutover is the one where key rotation and revocation never reach a running sandbox.

**Why 6 is not one step:** gate clause 3 (a named, tested rollback path) was explicitly NOT ticked
for the three shadow sinks. Each owes its own rollback evidence — three times, not once.

## 4. Planning required, per item

| Item | Planning state | What it needs before code |
|---|---|---|
| WRK-008 slice 1 | terrain ✅ | design doc (small — mirrors DAT-008 slice 4) |
| WRK-008 slice 2 | terrain ✅, **3 open questions** | design must answer them (§5) |
| DAT-008 slice 5 | terrain ✅, design ✅ but **stale in one place** | a design revision — see §4.1 |
| DAT-008 slices 6, 7 | terrain ✅, design ✅, reviewed ✅ | **nothing** — straight to fail-first TDD |
| MIG-005 / 006 / 007 | shadow result docs exist | terrain + design each, plus per-sink rollback evidence |
| MIG-001 | none | full cycle |

Every item runs [`HANDOFF-wave-3-4.md`](./HANDOFF-wave-3-4.md) §1 unchanged: terrain → design
(committed BEFORE code; its SHA is the Start SHA) → review → fail-first TDD → adversarial review →
mutation-test every guard → result doc → push → CI to green.

### ★ 4.1 Review of this plan found DAT-008 slice 5's design is stale

Slice 5's design says the worker seeds every redeemed value as a **redaction canary** before
`provider.create`, closing M7. Terrain since found the seam does not support that as written:
`SupervisorDeps.redactionCanaries` is read **once at `createSupervisor`** (`supervisor.ts:113`,
`events.ts:107`), while a `Supervisor` is long-lived and multi-run (`accept(handoff)`,
`activeRunCount()`). A **construction-time array cannot carry a per-run secret** — and the secret is
resolved per lease, long after construction.

Its own doc comment calls them *"PER-RUN secret canaries"*. They are not; they are per-supervisor.

**So slice 5 needs a design revision before code:** the canary registry has to become per-run, keyed
by lease, which is a change to a DAT-005 artifact rather than a new addition. Cheap to fix, expensive
to discover during implementation — which is exactly what this review pass is for.

### ★ 4.2 Two risks the sequence change introduces, named rather than absorbed

**Between step 2 and step 3 the daemon dispatches with `env: {}`.** A distributed job would start a
CLI with no credential and fail auth. Both the distributed flag and the rollout dial are default-off,
so there is no production exposure — but the intermediate state is real and the step-2 result doc
should say so rather than leave it implied.

**Step 2 makes D1's workers start taking real leases.** The D1 suites currently exercise lease races
through the harness against workers that never dispatch. Turning dispatch on changes what those
suites observe. **This is the largest single risk in the plan**, and it is worse than "must check",
because it was checked:

> **The daemon has NO dispatch gate.** Its whole config surface is `AOA_WORKER_CONTROL_PLANE_URL`,
> enrollment code, key-store mode, target scope, concurrency and timeouts (`config/config.ts:57-66`).
> There is no `AOA_DISTRIBUTED_EXECUTION_ENABLED` equivalent — that flag gates the **control
> plane**, a different process. Composing the loop therefore turns dispatch on **unconditionally,
> for every daemon running that build**, including both D1 workers, the moment it merges.

**So WRK-008 slice 2 has a hard design requirement, not an open question: an explicit worker-side
opt-in flag, default OFF.** Composition must be inert until something deliberately enables it, and
D1 must enable it in its own compose file as a separate, attributable change. Landing dispatch and
enabling it in one commit would make any D1 regression unattributable — the exact property this
branch's integration invariant exists to protect.

## ★ 5. WRK-008 slice 2's three open questions — the real sizing risk

Not plumbing. Each is a behaviour decision that must be made deliberately:

1. **A target with no admin-set placement profile has none.** Fail-closed is almost certainly right,
   but it means **enrolment alone does not produce a dispatchable worker**. That is product-visible
   and someone should assert it on purpose rather than discover it.
2. **Generation bump / revocation mid-run.** `registeredTargetProfile` carries `deviceGeneration`
   and `revokedAt`. A cached self-model is a worker advertising ceilings it no longer holds.
3. **Enroll → profile-read → loop ordering.** A failure at step 2 must not leave a half-started
   daemon holding a session and no loop.

## 6. Standing risks this plan does not remove

- **Gate clause 2 remains PARTIAL** — the shadow divergence rate is real and end-to-end but over a
  seeded corpus. Only a deployment driving real Commander/crew/extraction traffic closes it.
- **The kill switch still has no write path.** Throwing it means hand-executed SQL, instance-wide
  per provider, with no Organization and no sink dimension. "Reversible in seconds" stays half true
  until REL-001/005 own it.
- **Agents with a plain-literal provider key outside strict secret mode cannot be cut over.** Count
  them before MIG-005; the residual is acceptable only if the number is small.
- **D2 and D6 are calendar items, not tasks.** D6 needs three external organizations across the
  *same* fourteen consecutive days, with recruitment lead time in front of it. If that has not
  started it becomes the critical path regardless of code.

## 7. Operating discipline — one rule I broke three times today

`verify` is a 30–40 minute pole and **each push cancels the previous run**. I pushed docs commits
over three consecutive gates, so the last *completed* green PR gate is `4840c04e1` and the
refusal-signal fix has never passed one. Let a gate finish before pushing again. A cancelled run is
not a red one, but it is also not evidence.

Bump `docker/d1/campaign.env` **after the last `server/src` change** in a push, never once per
ticket — and never before a further `server/src` commit lands.
