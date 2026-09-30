# DAT-008 slice 7 — Design: warm-resume re-resolution — **DEFERRED (no mechanism to attach to)**

**Epic:** `E5-workspaces-secrets`. **Parent:** [`DAT-008-design.md`](./DAT-008-design.md) §4 slice 7
(revision 1 R1) + §8. **Sprint:** 4 (go-book §4 / §9). **Verdict:** **DEFER.**

**Start SHA:** the commit that adds this file. Line references are to `docs/replatform-program` at
**`bd178603f`** (Sprint 3 tip).

---

## 0. The verdict, up front

Slice 7 would re-resolve a handle when a **warm** sandbox resumes, tearing the sandbox down and
recreating it if the redeemed value changed (parent §4 slice 7). It has **nothing to attach to on
the distributed path**, and go-book §4 is explicit: *"If warm resume STILL has no production
mechanism (no lease pause/resume), slice 7 has nothing to attach to — SAY SO and defer it rather
than building against an absent mechanism. Do not invent the mechanism to give slice 7 a target."*
This document is that "say so": the verification, the reason the one live warm-resume mechanism is
the **wrong substrate**, and the precise conditions under which a future slice 7 becomes buildable.

This is the same shape as the two prior "checked before building" catches go-book §2.4 records
(DAT-008 slice 6 already delivered; the original slice 7 having nothing to attach to). Checking
first is cheaper than building against an absent mechanism and discovering it in review.

---

## 1. Verified state — there are TWO sandbox-provider abstractions, and they differ

The confusion slice 7 must not make: the repo has two entirely separate sandbox lifecycles.

### 1a. The distributed (worker-daemon) path — what DAT-008 targets — has NO warm resume

- `EffectAuthority.resume(sandboxId, ctx)` (`packages/worker-daemon/src/supervisor/effect-authority.ts:94-97`)
  calls `this.#provider.restore(...)`. **The method has zero production callers.** A grep of
  `packages/worker-daemon/src` (minus `__tests__`) for `.resume(` / `.checkpoint(` returns only the
  definitions themselves (`effect-authority.ts:96`, `:101`). `supervisor.ts`, `poll-loop.ts`,
  `lease-renewal.ts`, `dispatch-runtime.ts` and `control/*` never call `effect.resume`/
  `effect.checkpoint`.
- **Sprint 3 composed create → execute → destroy, not resume.** `composeDispatchRuntime`
  (`dispatch-runtime.ts:100-199`) and the supervisor's `runLifecycle` (`supervisor.ts:285-435`) drive
  the cold lifecycle only. The prior scope note's *"provider.restore has no production caller"* is
  **STILL TRUE after Sprint 3** — Sprint 3 changed the composition but added no resume driver.
- **There is no distributed lease pause/resume.** The only "pause" in worker-daemon is REL-004
  `drain_paused` (`poll/poll-loop.ts:659-669`; `metrics/metrics.ts:100-103`) — a reversible **poll
  drain** (finish in-flight work, stop polling, later resume polling). It pauses *polling*, not a
  sandbox; there is no sandbox checkpoint→restore anywhere in `worker-daemon/src`.
- **The frozen wire has no pause/resume op.** `WORKER_PROTOCOL_OPERATIONS`
  (`packages/worker-protocol/src/transport.ts:757-768`) is ten ops; none is pause/resume/warm/
  checkpoint/restore. A `checkpoint` **control-command kind** exists in the frozen vocabulary
  (`transport.ts:601-608,636`) but **no production code issues or handles it** — worker-daemon has
  zero `commandKind` references and the server's `job-approval-bridge` issues only
  `product_approval_result` / `runtime_decision_result`. The provider-capability list
  `OPTIONAL_PROVIDER_OPERATIONS = ["checkpoint","restore","health"]` (`capabilities.ts:153`) is a
  capability vocabulary, not a driver.

**On the distributed path, warm resume does not exist. There is no seam, no caller, no wire verb, no
lease lifecycle.** Adding it is the sink-cutover / long-running-lifecycle work, not a DAT-008 slice.

### 1b. The server warm-lease lifecycle — real, wired — is the WRONG substrate

A production warm-resume DOES exist, but on the **legacy / #320 host-executor** substrate, not the
distributed one:
- Resume/reattach: `server/src/services/environment-runtime.ts:485-530` (`providerRuntime.resumeLease`
  → `environmentsSvc.reactivatePausedLease`); E2B side `sandbox-provider-runtime.ts:848-885`
  (`Sandbox.connect` auto-resumes a paused snapshot).
- Pause/checkpoint: `environment-runtime.ts:665-687` (`markLeasePaused`); E2B side
  `sandbox-provider-runtime.ts:813-828` (`sandbox.pause()`).
- Keyed by `agentId` / `commanderConversationId`; reaper-managed
  (`warm-sandbox-reaper.ts`, wired `server/src/index.ts:1475-1489`); heartbeat-wired
  (`heartbeat.ts` → `environment-run-orchestrator.ts` → `acquire-execution-context.ts`).
- It even carries a **re-resolution-on-warm-resume** invariant already:
  `environment-runtime.ts:395-446` (`stripStaleLeaseEnv`, "U7.7 — OAuth connector token re-resolution
  on warm resume") re-injects fresh run env at every stage-in including `resume()`.

**Why this is not slice 7's target.** It is a **different provider interface**
(`SandboxProviderRuntime.resumeLease`/`releaseLease`, `server/src/services/sandbox-provider-runtime.ts`),
on the host-side executor that `DAT-008-terrain.md` §0 explicitly warns is **not the distributed
path** ("the distributed path builds its sandbox in `packages/worker-daemon`"). And it is precisely
the substrate **MIG-005 will replace**: parent §4 slice 7 / R1 hangs slice 7 off *"program-design.md:36
keeps Decision #120's Commander warm-E2B lifecycle authoritative until MIG-005 cuts it over."* Slice 7
exists so that **after** MIG-005 cuts Commander's warm lifecycle onto the **distributed** path, warm
leases re-resolve. Attaching slice 7 to the server lifecycle now would harden the very code MIG-005
is meant to retire, on the wrong abstraction, and would be "inventing the mechanism to give slice 7 a
target" — the thing go-book §4 forbids.

---

## 2. Why deferring is correct, not a shortcut

1. **The distributed warm-lease mechanism does not exist**, and building it is out of DAT-008's
   one-sentence goal (parent §1: *materialise the credential into a distributed sandbox*). A
   distributed pause/resume lifecycle is a lease-lifecycle feature, owned by the sink cutovers /
   long-running-service work (MIG-005 warm-lease era, and E9 service lifecycle), not by a credential
   slice.
2. **Cold-lease re-resolution — the CM-013 clause DAT-008 actually owns — is already free** and
   shipped: a handle is a reference, so every **new** lease re-resolves per redemption (parent §4
   slice 1; DAT-008-result.md acceptance "Re-resolve on every new lease ✅"). Slice 5 makes that real
   on the worker. What slice 7 adds is re-resolution across a **warm resume**, which only matters once
   a warm-resume path exists on the distributed substrate.
3. **The rotation/revocation residual is already bounded and honest.** Parent §8 states it: a key
   rotated while a sandbox executes is picked up at the *next new lease*, and handle revocation
   (`status`/`revokedAt`) makes the *next* redemption fail closed. Until warm resume exists on the
   distributed path, "next lease" is the only resume boundary, and cold re-resolution covers it.

Deferring slice 7 therefore leaves **no distributed capability unprotected** that a warm path would
otherwise expose — because there is no distributed warm path.

---

## 3. What a future slice 7 must have before it can be built (the un-invented preconditions)

Slice 7 becomes buildable when, and only when, the **distributed** path grows a warm-resume
mechanism. Concretely, a future ticket must first land:

1. A distributed **lease pause/resume** (or reuse-by-key) lifecycle: a poll-loop / driver path that
   suspends a sandbox and later resumes it under a fresh lease/fence, driving
   `EffectAuthority.resume()` → `SandboxProvider.restore()` from production — giving those
   currently-zero-caller methods their first caller.
2. A provider that advertises `restore`/`checkpoint` on the distributed port (`e2b-provider.ts`
   already implements `restore()` at `:367-373`, but nothing distributed calls it).
3. The MIG-005 cutover (or its warm-lease predecessor) routing Commander's warm-E2B lifecycle onto
   that distributed path, so a warm resume can actually occur for a job that carries a
   `secretHandles[]` entry.

Only with (1)–(3) present is there a resume boundary at which "redeem again, compare, tear down if
changed" has a place to run. Until then slice 7 has no attach point.

---

## 4. The design, preserved for when the mechanism exists (NOT built now)

Kept verbatim in intent from parent §4 slice 7, so a future ticket inherits the decided behaviour
rather than re-deciding it:

> On warm resume, before the sandbox is handed further work: **redeem again** (through the slice-5
> redemption path). If the redeemed value **differs** from the one the sandbox was created with, the
> sandbox is **not reused** — it is torn down and recreated. Comparing without re-materialising keeps
> the decision cheap and avoids a second injection path into a live sandbox. A **denied**
> re-resolution (revoked handle, replaced fence) tears down and does **not** recreate — the credential
> is gone, so there is nothing to run with. The comparison is over the redeemed value, so the test
> must make the two values **actually differ** (parent §5 "Warm resume" + the MIG-005/006/007
> comparator lesson: a test that rotates nothing proves only that equal values compare equal).

This attaches naturally to slice 5's already-built redemption path: the future slice 7 reuses
`resolveExecutionSecret` + `synthesiseEnv`, adding only the compare-and-teardown decision at the
(not-yet-existing) resume boundary. **Nothing in slice 5 forecloses it** — slice 5's redemption is a
pure function over the handle + fence, callable again at a resume boundary.

---

## 5. Decision & ownership

- **Slice 7 is DEFERRED at Sprint 4.** No code, no test, no `gate-clause-wiring` change. E5 has no
  warm-resume gate clause to promote (the E5 register carries `E5-5-redaction`, wired by slice 5, and
  no `E5-warm-resume` clause exists — so nothing goes falsely green).
- **Ownership:** the distributed warm-lease mechanism (preconditions §3) is owned by the MIG-005
  cutover era / the long-running-lifecycle work, not by DAT-008. When that lands, a successor ticket
  (e.g. `DAT-008-slice-7` re-opened, or a MIG-005-scoped follow-up) builds §4 against the real
  mechanism. This document is the standing record that the work is scoped and blocked on a
  precondition, not forgotten.
- **No finding is filed:** an absent, out-of-scope future mechanism is not a defect in shipped code.
  The parent design already names warm resume as in-scope-for-DAT-008-when-buildable; this document
  records that at `bd178603f` it is not yet buildable.

The `#### DAT-008` node in `program-design.md` covers this file (the coverage checker maps
`DAT-008-slice-7-*.md` → id `DAT-008`); no new node is required and none is added.
