# DECISION REQUEST — E9-F002: the 240-second service-run ceiling, and the never-re-minted effect authority behind it

**Date:** 2026-09-18
**Decision:** **E9-F002 / SVC-008 §9.1** — *"The daemon's per-run effect authority (the OwnedLabelsCapability) is minted once and never re-minted on lease renewal, so a `service` workload is capped at ~240 seconds. Do we (a) re-materialize secrets on the supervise tick, (b) mint a fresh capability on lease renewal, or (c) accept the ceiling and amend E9's acceptance language — and does the founder accept that re-mint ALONE still does not buy an unbounded service?"*
**Register under discussion:** `docs/replatform/epics/E9-service-agents/findings.md` — **E9-F002** (`open`, `unowned`, HIGH, "NARROWED" §1.6). Ownership tracked in `scripts/finding-ownership.json`. The three options are stated but not settled in `docs/replatform/epics/E9-service-agents/tickets/SVC-008-design.md` §9.1.
**Findings this paper reads and does NOT move:** **E9-F002** (the ceiling), and, as downstream context it neither opens nor closes, **E9-F007** (silent-worker overlap), **E7-F034** (the E2B stop-primitive defect).
**Status changes made by this document:** **NONE.** No finding is closed, narrowed, re-owned or re-dispositioned; no `scripts/finding-ownership.json` key is touched; no acceptance language in the E9 README is edited; no `scripts/gate-clause-wiring.json` enrolment is added; no register clause is moved. **Choosing among the options below IS the decision being requested**, so this paper does not pre-empt it by making any of them. **Production code proposed:** none.

> **Provenance note.** All line numbers below were re-grepped at HEAD `85ba9a2b7` (the tip of `origin/docs/replatform-program`), not inherited from the SVC-008 design, whose measurement was taken at `afebb0e51` and whose citations have since drifted. Where a claim rests on code this paper did not open (the E2B SDK's real behaviour), it is labelled a *code reading, not a provider measurement*, as SVC-008 §9.4/§9.5 label their own.

---

## 0. The settled fact, stated first

**A `service` workload on this fleet is a 240-second service.** Not by policy, not by a tunable, but as the arithmetic consequence of an effect-authority window that is minted once and never renewed. The number is derived, so raising a workload budget cannot move it — and the four-minute cap is exactly why the 72-hour D4 service-continuity canary (E9 README §12 exit gate; Mandatory planning brief) cannot be run: *"it cannot be run against a 240-second service"* (E9-F002 §1.6).

| Constant | Value | Source (re-grepped at HEAD) |
|---|---|---|
| `OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS` | `5 * 60_000` = **300 s** | `server/src/services/owned-labels-mint.ts:46` |
| `RUN_TEARDOWN_HEADROOM_MS` | `60_000` = **60 s** | `packages/worker-daemon/src/lifecycle/run-op-deadline.ts:42` |
| `RUN_OP_DEADLINE_CEILING_MS` | `TTL − headroom` = **240 s** | `run-op-deadline.ts:45-46` (`OWNED_LABELS_CAPABILITY_TTL_MS − RUN_TEARDOWN_HEADROOM_MS`) |
| service-arm run budget | `Math.max(floor, ceiling)` = **240 s** | `resolveRunOpDeadlineMs`, `run-op-deadline.ts:84-86` |

The teardown headroom is not decoration: `destroy` must run **while the capability still verifies**, or the worker cannot tear its own sandbox down and leaves a billable orphan (`run-op-deadline.ts:16-21` header; the supervisor records exactly this as `recordOrphan(run, "cap_expired_before_happy_destroy")` per SVC-008 §1.3(b)). So the ceiling sits one full teardown-window under the capability's own expiry, on purpose.

### 0.1 ★ Disambiguate "authority" — the 240 s driver is the CONTROL-PLANE-minted capability, not the daemon gate

The word "authority" is overloaded in this lane, and the wrong one is the intuitive one. **The 240 s ceiling is NOT the daemon-side in-memory `EffectAuthority` gate** — that gate (shipped by SVC-008a; `startProcess`/`processStatus`/`signalProcess` on it) is *withdrawn on lease loss* when the renewal driver closes the fence-close proxy and calls `Supervisor.onLeaseLost` (SVC-008 §4.5), and it tracks the lease, which is renewable. **The 240 s driver is the control-plane-minted, Ed25519-signed `OwnedLabelsCapability`** that gates a networked `create` at the adapter-manager, whose `expiresAt = min(authorityNow + shortTtlMs, leaseDeadline)` (`mintOwnedLabelsCapability`, `owned-labels-mint.ts:92`) — and which, unlike the lease, is **never re-issued**. Confusing the two leads a reader to conclude "the lease renews, so the run can continue," which is true of the lease and false of the capability that actually authorizes teardown.

---

## 1. The mechanism, verified at source

**Minted once, on one route.** The capability is attached to a secret-resolve reply only on the positive gate `outcome.outcome === "resolved" && outcome.seam === "sandbox_local_only"` and only when a control-plane signing key is configured; every other outcome is returned **unchanged**, and the function **never throws** (`applyOwnedLabelsCapability`, `owned-labels-mint.ts:110-118`). That function is invoked from exactly one place in the request path — `server/src/services/secret-broker.ts:381` — reached by the resolve route `POST /worker-control/execution-secrets/resolve` (`server/src/routes/worker-control.ts:718`), which serializes it into the reply at `worker-control.ts:773-774`.

**Never re-minted on renewal — confirmed by whole-file grep.** `ownedLabelsCapability` appears in `server/src/routes/worker-control.ts` **only** at `:773-774` (inside the resolve route). The lease-renewal route `POST /worker-control/leases/:leaseId/renew` (`worker-control.ts:516`) verifies the device proof and calls `renewal.renew({ auth, request })` (`:542`) — it extends the lease deadline and re-checks the fence, and it **does not mint, resolve secrets, or re-issue the capability**. So a run that outlives the 300 s TTL reaches teardown with an **expired** capability, whatever its lease says.

**The service workload carries no runtime budget, so it falls to the ceiling.** `resolveRunOpDeadlineMs` reads `workload.maxRuntimeSeconds` (`run-op-deadline.ts:87`); `serviceWorkloadV1Schema` has no such field (only `gracefulStopSeconds`, a stop budget). The shipped service arm therefore returns the ceiling directly: `if (handoff.offer.job.workloadType === "service") return Math.max(floorMs, ceilingMs);` (`run-op-deadline.ts:84-86`) = **240 s**. The arm's own comment (`:66-83`) records that it deliberately does **not** use SVC-008 §3.3's stated `profile.maxContinuousRuntimeSeconds` source, because that field was *measured absent from the worker side of the wire* (the envelope carries only a provider-constraint reference; the only readers are server-side `job-placement.ts` and `job-leasing.ts`). The ceiling is the honest bound regardless — it is exactly the window in which the run's authority can still tear its own sandbox down.

**Net:** mint-once (300 s, lease-clamped) − 60 s teardown headroom, with no renewal path = a hard 240 s wall on any `service` run, above which the only outcome is a billable orphaned sandbox.

---

## 2. Why re-mint ALONE does not buy an unbounded service — three constraints that survive it

The temptation is to read §1 as "add a re-mint and services are unbounded." That is false: the capability window is the *first* ceiling, not the only one. Even with §9.1 answered, three independent constraints remain, and none of them is E9-F002's to lift.

- **§9.2 — placement demand-narrowing.** `boundedDemand` derives a run's demanded runtime as `Math.min(600, provider.maxContinuousRuntimeSeconds)` (`server/src/services/job-placement.ts:193,198`), and `providerDemandFits` refuses any candidate whose `maxContinuousRuntimeSeconds < demand.maxRuntimeSeconds` (`:502,509`). This is a demand *assertion*, not a runtime enforcement — but it cuts the wrong way for the intuition: **raising** a service's demanded runtime **narrows** the eligible fleet. A service demanding a seven-day runtime is placeable only on workers advertising seven days of continuous runtime. Lifting the clamp for `service` is a control-plane change (SVC-002/SVC-003), not this decision.
- **§9.4 — the E2B sandbox TTL is fixed at create, with no extension operation.** `transport.setTimeout` is called from exactly one place, the create path's TTL application (`packages/sandbox-e2b-provider/src/e2b-provider.ts:419`, `#ttl(ctx)`; header at `:9`), and the frozen provider port has **no** TTL-extension operation. A sandbox is born with a lifetime of `ctx.deadlineMs` and cannot be stretched afterward. So even a re-minted capability that raised the budget above the sandbox's create-time TTL would hit this next. **This is a code reading, not a real-E2B measurement** — the isolation conformance suite runs keyless doubles (E0-F015).
- **§9.5 — the process-supervision primitive's real-E2B behaviour is unverified.** SVC-008a shipped the port surface (`startProcess`/`processStatus`/`signalProcess` behind `processSupervisionMode`, `packages/worker-daemon/src/supervisor/provider.ts:680-713`; on the E2B provider at `e2b-provider.ts:348-773`). But whether the pinned E2B SDK actually exposes a detached background launch, what its handle carries (a pid?), and whether an in-sandbox signal to it is reachable were **not verified against a real E2B account or an installed SDK** (SVC-008 §9.5(i); same E0-F015 keyless-doubles caveat). A service that can never be reported *healthy* is not a service (SVC-008 §3.1a) — so a live `healthy` still rests on an unmeasured transport, independent of the capability window. Ownership of that port is E4/CLI's, not E9's (§9.5(ii)).

**The one-sentence version for the founder:** answering §9.1 removes the *first* wall; §9.2/§9.4/§9.5 are the *next* three, and each belongs to a different owner. A ruling that treats re-mint as "and then services are unbounded" would be wrong on its own terms.

---

## 3. Scope, stated honestly — this is a lease/runtime-half decision

The service **control plane is built.** What is not exercised is a service job actually *leased and supervised end-to-end*.

| Capability | State | Evidence |
|---|---|---|
| Create a service + its immutable generation-1 definition | **SHIPPED** (SVC-007a) | `createService` `server/src/services/service-management.ts:415`; route `POST …/services` `server/src/routes/job-control.ts:434`→`:450` |
| Write `services.generation` (generation roll) | **SHIPPED** (SVC-005a) | `tickets/SVC-005a-result.md`; README §11 |
| Desired-state transitions | **SHIPPED** (SVC-007a) | `canTransitionServiceDesiredState` armed; README §9 |
| Desired-state → converge one instance + one job, never two | **SHIPPED** (SVC-002) | `createServiceReconciler`; `service_instances_live_service_uq` |
| Health projection (event → `service_instances.status`) | **SHIPPED** (SVC-003a) | `tickets/SVC-003a-result.md`; README §7 |
| Liveness deadline (clock-driven `lost`) | **SHIPPED** (SVC-003b) | `tickets/SVC-003b-result.md`; README §8 |
| Capability widening + daemon service supervisor | **SHIPPED** (SVC-008a/008b) | `SUPERVISABLE_WORKLOAD_CAPABILITIES` now includes `workload.service`; `runServiceLifecycle` |
| **A service job LEASED + supervised end-to-end** | **UNEXERCISED** | E9-F002 T0 is green only at the placement-reachability layer; **no service job is leased anywhere in any suite** (README §9, §11: "the DAEMON half of 'created, supervised, projected' is still unexercised") |

So E9-F002's resolve criterion is a **conjunction**, and only one conjunct holds: *"T0 green on a shipped daemon (a service job observed leased) AND blocker (3) answered rather than deferred, OR E9's acceptance language amended"* (`scripts/finding-ownership.json`; E9-F002 §1.6). T0 is green. Blocker (3) — the never-re-minted capability — is **bounded, not answered**: SVC-008b made the supervise loop stop on `capExpiresAt − RUN_TEARDOWN_HEADROOM_MS` so no service run orphans a sandbox, but it did **not** re-mint (SVC-008 §9.1 unruled). And E9's acceptance language is unamended. **Neither disjunct holds, so E9-F002 stays `open`** — this decision is what closes it, in one of the three ways below. It is a lease/runtime-half decision; the "no service leased e2e" gap is what remains, and it is real.

---

## 4. The three options (SVC-008 §9.1)

The unit of the ruling is E9-F002, because the four-minute cap and its two honest resolutions (fix the mechanism, or amend the claim) stand or fall together.

### Option (a) — re-materialize secrets on the supervise tick (the daemon re-mints)

- **Mechanism.** On each tick, when `capExpiresAt` is within the teardown window, the supervisor re-calls the resolve route it already reaches, re-deriving the capability. The plumbing exists: the route is `POST /worker-control/execution-secrets/resolve` (`worker-control.ts:718`), the mint is a pure function of the resolve outcome (`applyOwnedLabelsCapability`, `owned-labels-mint.ts:110-118`), and the supervisor already knows how to rebuild per-run authorities (SVC-008 §4.1).
- **Cost.** It re-runs a **full secret resolution on a schedule**, which **widens the blast radius of a compromised worker from one materialization to N**. That is an unruled security question — nobody has decided that a long-running worker should re-fetch secrets on a timer.
- **OWNER.** The daemon supervisor (SVC-008b's lane) can *build* it, but the security judgement (blast-radius widening) is a **founder/security ruling**, not a ticket decision.

### Option (b) — mint a fresh capability on lease renewal (the server re-issues)

- **Mechanism.** Bind the capability's refresh to the already-shipped renewal path: `POST /worker-control/leases/:leaseId/renew` (`worker-control.ts:516`) would re-issue the capability when it extends the lease. Architecturally the cleaner fit — the capability is *already* lease-clamped (`min(now + TTL, leaseDeadline)`, `owned-labels-mint.ts:92`), so refreshing it on renewal is coherent with what it already is.
- **Cost.** It is a **server-side change to the renew route**, which SVC-008 §9.1 states plainly is *"not SVC-008's to make."* It also **fixes long batch runs**, which carry the *identical* orphan today (a >5-min batch run hits the same expired-capability teardown).
- **OWNER.** Control-plane / the worker-control renew route. The natural inheritor named in E9-F002 §1.6 is **SVC-003** (its Outcome is the lease/ownership authority question) — but SVC-003 has **no ticket file on disk**, so it cannot yet be named `successor` without failing the ownership guard's existence bar. A ruling for (b) should either create that ticket file or explicitly assign the renew-route change.

### Option (c) — accept the ceiling and ship a four-minute service

- **Mechanism.** No code. Amend E9's acceptance language to say a service is dispatchable **only within the effect-authority window**, and correct **DE-12's `deliveryEvidence`** to carry that reason (E9-F002 §1.6, §3).
- **Cost.** A "service" on this fleet is then, by ruling, a four-minute service — and *"that sentence is the finding"* (E9-F002 §1.6). The **72-hour D4 continuity canary stays unrunnable**, and E9's exit gate (README §12) does not close for service continuity. This is a **founder-level amendment to the epic**, not a ticket decision.
- **OWNER.** Founder, over the E9 README acceptance language + the DE-12 register row.

**A rider the ruler should carry regardless of choice:** option (b) also repairs the identical long-batch orphan; option (a) is the only one that keeps the change daemon-local but is the only one that opens a new security surface; option (c) is the only one that requires no engineering but is the only one that concedes the canary. And under **any** of (a)/(b), §2's three downstream constraints still stand between "capability re-minted" and "unbounded service."

---

## 5. Recommendation

**Recommended: (b) — mint a fresh capability on lease renewal — framed as the founder's choice.** The reasoning follows; the founder may weigh the security and scope trade-offs differently.

**Why (b) over (a).** Both fix the four-minute cap. (a) keeps the change inside the daemon but pays for it with an unruled security regression — re-resolving secrets on a timer widens a compromised worker's reach from one materialization to N, and no one has decided that is acceptable. (b) refreshes a value that is *already* lease-clamped, on the path that *already* re-verifies the fence and extends the lease, and it costs nothing new in blast radius. It also clears an orphan that batch runs suffer today, so it pays down two problems with one change.

**Why not (c) as the primary answer.** (c) is honest and cheap, and it may be the right *interim* posture — but it terminates the 72-hour D4 canary and, with it, the service-continuity half of E9's exit gate, which gates REL-005 (Mandatory planning brief). Accepting a four-minute "service" as the terminal design is a larger concession than the mechanism warrants, given (b) is a bounded, well-scoped route change.

**★ The strongest argument against the recommendation.** (b) is *"not SVC-008's to make"* and its natural owner (SVC-003) has no ticket file — so recommending (b) recommends work with no home, and the register-accuracy guard is right to refuse a `successor` that does not exist on disk. If the founder is unwilling to open SVC-003 (or reassign the renew-route change) now, then (c) as an **explicit interim** — with the acceptance language and DE-12 corrected so the four-minute limit is *disclosed rather than silent* — is the more honest short-term posture, and (b) becomes the follow-on. What is not defensible is leaving E9-F002 open, the canary unrunnable, and the ceiling **undisclosed** in the acceptance language, which is the status quo. And whichever is chosen, §2 means the ruling must not be read as "and then services are unbounded": the E2B TTL (§9.4), the placement demand clamp (§9.2), and the unverified real-E2B primitive (§9.5) are the next three walls, owned elsewhere.

---

## 6. Stale records this paper notes for cleanup (not applied here)

Two in-tree records disagree with the code at HEAD. This paper records them for a follow-up; it edits neither.

- **`server/src/index.ts:1463-1469`** — the SVC-002 reconciler comment states `services` *"has ONE insert in the tree and ZERO production callers — there is no route by which a human or an agent can create a service (SVC-007 owns that). So on every real deployment this tick reads an empty window and converges nothing."* **STALE.** SVC-007a shipped `createService` (`server/src/services/service-management.ts:415`) and `createServiceWithinTenant` (`:360`), registered at the `POST …/services` route (`server/src/routes/job-control.ts:434`, calling `createService` at `:450`, audited as `service.create` per `:395`). A route now creates a service and `services` has a production insert path. The comment's *conclusion* — the tick still converges nothing on a default deployment — remains true, but for a **different** reason (no `service_generations` definition writer runs until SVC-005's rollout on a real deployment; README §6/§11), not because "no route creates a service." Fix: re-state the reason, do not keep the false premise.
- **The "SVC-003 missing" framing.** Records that treat SVC-003's *work* as unbuilt are stale: its health projection and liveness deadline **shipped** as SVC-003a (`docs/replatform/epics/E9-service-agents/tickets/SVC-003a-result.md`) and SVC-003b (`…/SVC-003b-result.md`). SVC-003 is **PARTLY SHIPPED**, open only on remaining conjuncts (graceful stop, checkpoint request, bounded-lease-renewal total) — *open ≠ missing*. The accurate residual to preserve: a standalone SVC-003 *ticket file* under `docs/replatform/epics/*/tickets/` still does not exist, which remains the correct basis for the ownership-guard existence bar and is **why E9-F002 cannot yet name SVC-003 as `successor`**. Fix the framing to distinguish "work shipped incrementally as 003a+003b" from "ticket file absent" — not to claim SVC-003 is done.

---

## 7. What this paper is not

It changes **no** finding status, **no** ownership, **no** `scripts/finding-ownership.json` key, **no** acceptance language in the E9 README, **no** DE-12 register clause, and **no** gate-clause enrolment. It wires nothing and proposes no production code. It exists so the SVC-008 §9.1 ruling that E9-F002 §1.6 names as unmade can be signed — with the mechanism treated as measured (the 240 s cap and its never-re-minted authority), the three downstream constraints treated as separate walls owned elsewhere, and the two stale records flagged for a follow-up that is not this document.

---

## ▣ DECISION — E9-F002 / SVC-008 §9.1, the service-run ceiling

**Awaiting founder ruling.** Choosing among the options below IS the decision requested; this paper makes none of them.

- ☐ **Option (a)** — Re-materialize secrets on the supervise tick (daemon re-mints). *Daemon-local; opens an unruled security surface — a compromised worker re-resolving secrets on a timer widens blast radius 1→N.*
- ☐ **Option (b) ★ (RECOMMENDED)** — Mint a fresh capability on lease renewal (`worker-control.ts:516`). *Server-side, "not SVC-008's to make"; needs an owner (open SVC-003's ticket file or assign the renew-route change). Also fixes the identical long-batch orphan.*
- ☐ **Option (c)** — Accept the ceiling; amend E9's acceptance language + DE-12 `deliveryEvidence` to say a service is dispatchable only within the effect-authority window. *No code; concedes the 72-hour D4 canary. Founder-level epic amendment. Defensible only as an explicit, disclosed interim.*
- ☐ **Rider (record with whichever is chosen)** — Re-mint ALONE does not buy an unbounded service: §9.2 placement demand-narrowing (`job-placement.ts:198,509`), §9.4 the create-time-fixed E2B TTL with no extension op (`e2b-provider.ts:419`), and §9.5 the unverified real-E2B process primitive (`provider.ts:680-713`) are the next three walls, each owned outside E9. Do not read this ruling as making services unbounded.

**On close:** flip E9-F002's Status and DELETE its `scripts/finding-ownership.json` key in the SAME commit only when the chosen disjunct actually holds — (a)/(b) landed and a service run observed past 240 s, OR (c)'s acceptance-language + DE-12 amendment committed. A design or a decision paper is not a supervisor; half a conjunctive clause may not be enrolled (E9-F002 §1.6).
