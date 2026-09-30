# DECISION REQUEST — the JOB-003 ack-drain amendment, completed: what one ruling unblocks, what it does not, and the second amendment hiding behind the register's phrase "both blocked"

**Answers:** the blocked-arm residue the register's DE-18 row and DE-04's worker-authority-currency
arm both carry at HEAD: *"STILL open: `guardPlatformAuthority`'s two shared-platform throws and the
ack-path `target_revoked` arms (frozen JOB-003 contract pins their call shape — the same amendment
the ack-drain needs)"* (`docs/architecture/distributed-execution-threat-controls.json`, DE-18 row),
and the E0-F010 trail in `docs/replatform/epics/E0-foundation/findings.md` that pins the seventh
`recordProof` site.
**Date:** 2026-09-14. **Measured at:** `5237b057a` (the `docs/replatform-program` branch HEAD this
paper ships on).
**Status:** RULED 2026-09-14 — Option B (see the Decision block). **Changes no finding's status and wires no code.**
This paper COMPLETES and does not replace
[`DECISION-REQUEST-job-003-ack-drain-amendment.md`](./DECISION-REQUEST-job-003-ack-drain-amendment.md)
(2026-09-10, still OPEN): that paper measured the ack drain-point blocker and its safe amendment;
this one establishes which of the still-blocked audit arms that amendment actually unblocks, and
asks for the one ruling that settles all of them. Every experiment below was applied to a scratch
copy of the two files involved, run, and **reverted**; the tree this paper ships in contains none
of it.

---

## THE HEADLINE — THE REGISTER'S "BOTH BLOCKED ON THE ACK-DRAIN DECISION" IS HALF-PRECISE, AND POLL IS THE PROOF

The register files two groups of unaudited denial arms under one blocker, "the open JOB-003
ack-drain founder decision." Measured at HEAD, that phrase is precise for one group and imprecise
for the other, and the imprecision matters because it changes what a ruling buys:

1. **The ack-body arms are blocked by exactly what the filed paper says** — the frozen ack-flow
   contract closes every drain point outside the ack `runInTenant` transaction
   (`exactAckReturnDominance`, re-measured in the 2026-09-10 paper, rows (a)–(c4)). The hardened
   amendment that paper proves — accept `runInTenant(…).finally(fn)` as ack's outer return AND
   sweep the drain callback for the four protected ack effects — gives ack the same
   intent-then-drain shape poll already has. For these arms the ack-drain ruling is **necessary
   and, with one reviewed-allowlist registration (precedented by `pollAuthorityCurrencyIntent`,
   PR #448), expected to be sufficient**.
2. **The two `guardPlatformAuthority` throws are NOT blocked by the missing ack drain, and the
   poll path proves it.** Poll already possesses the one drain shape the contract admits — the
   `finally` on its retry `try`, draining a per-request sink via `drainWorkerDenial`
   (`server/src/services/job-leasing.ts`, the poll loop's `finally`) — and the guard's two throws
   are **still unrecorded on the poll path**. The sink is written at exactly two poll sites (the
   `!lockedAuthority || !proofRecorded` replay disjunct and the `!currentAuthority` comma-expression
   throw); the guard's throws set no intent, so poll's drain is a no-op for them. Their true
   blocker is that **no denial intent can be threaded out of the helper at all**: the frozen
   contract pins the helper's parameter list at three (`helperParameters.length !== 3` →
   `builder:trusted-service-authority-guard` in `job-leasing-contract.test.ts`), pins the poll
   call expression to exactly `guardPlatformAuthority(repos, pollInput.auth, lockedAuthority)`
   (`builder:physical-from-authority-guard`), and audits the helper body
   (`auditDynamicMetaprogramming(helperBody)`, the direct-throw pins, the 30-conjunct
   `exactPlatformChecks`). §2 walks every out-of-band route and names the check that reds it.
   **Ruling the filed ack-drain amendment leaves these two arms exactly as gated as they are
   today.**

So the open decision is really two rulings, and this paper asks for both at once so the register's
blocked-arm note can finally resolve to something determinate: **(i)** rule the filed 2026-09-10
paper (its own options (a)/(b)/(c) stand as written — this paper adds no new measurement to them
and endorses its author's constraint that only the hardened form is takeable); **(ii)** rule what
happens to the two guard throws, for which the options are a second, wider amendment (§3 option A),
an explicit deferral (§3 option B), or accept-the-gap (§3 option C).

**Recommendation (one, §4): rule the filed paper's hardened amendment now, and DEFER the guard-sink
amendment under a register note that names it as a further amendment, not a permanent gap** —
option B.

---

## §1 — The blocked arms, enumerated at HEAD

All code citations are to `server/src/services/job-leasing.ts` (the service factory's body) and
`server/src/__tests__/job-leasing-contract.test.ts` (the frozen JOB-003 contract), by symbol.
Counts below are determinate: they are throw-site counts read from the named function bodies at
HEAD, not cohort or convention figures.

### 1.1 The two `guardPlatformAuthority` throws (shared by poll AND ack)

The helper is declared once, in the service body, and pinned there
(`declarations.length !== 1` / `helperBinding.statement.parent !== serviceBody` →
`builder:trusted-service-authority-guard`). Its two throws:

- **G1 — the platform-scope fallthrough**: `if (locked.target.scope !== "platform") throw new
  JobLeasingError("target_revoked")` — pinned as `helperBody.statements[1]`, required to
  *directly* throw (`directlyThrowsFromGuard` on `platformScopeReject`).
- **G2 — the 30-conjunct platform physical-authority recheck**: the single validation `if` inside
  the `operatorDb.transaction` callback, whose OR-expression is pinned conjunct-for-conjunct
  (`exactPlatformChecks`, `expectedPlatformChecks.length === 30`) and which is also required to
  directly throw.

Both throws serve, per the register's 2026-09-13 amendments, DE-18 when the failed conjunct is the
generation cutoff and DE-04's worker-authority-currency arm otherwise — the same per-conjunct
classification discipline the poll admission arm and `registerProofBoundHeartbeat` already follow.
Neither records anything today, on either path.

### 1.2 The ack-body `target_revoked` arms

Three throw statements directly in the ack `runInTenant` callback:

- **A1** — the authority gate: `throw new JobLeasingError(authority ? "target_revoked" :
  "unauthorized")` after `!authority || !ackAuthorityCurrent({…})` (the `if` the contract pins as
  `exactAckReject`).
- **A2** — the inactive/unnormalizable current target: `if (!target || target.status !== "active")
  throw new JobLeasingError("target_revoked")`.
- **A3** — the liveness-touch failure: `if (!await repos.jobControl.touchWorkerLeaseProfile({…}))
  throw new JobLeasingError("target_revoked")`.

Plus the **seventh `recordProof` refusal** (`if (!proofRecorded) throw new
JobLeasingError("unauthorized")` — the DE-03 site the E0-F010 trail pins as "NOT wired" and the
2026-09-10 paper answers). The ack path's other refusals (`malformed` receipt-digest mismatch,
`stale_fence`, `attempt_terminal`) are receipt/fence-integrity refusals outside the register's
blocked-arm note and outside this paper's question.

### 1.3 What blocks which — the load-bearing distinction

| Arm group | Drain point exists? | Intent can reach a sink? | Blocker |
|---|---|---|---|
| A1–A3 + seventh `recordProof` (ack body) | **No** — every drain shape reds `exactAckReturnDominance` (measured, 2026-09-10 paper rows (a)/(b)/(c1)) | Yes, once a drain exists — same comma-expression + registered-pure-classifier pattern poll uses at its `!currentAuthority` throw | **The ack-drain amendment**, exactly as filed |
| G1–G2 (helper, both paths) | **Yes on poll** (retry-`try` `finally`), no on ack | **No, on either path** — §2 | **The pinned helper/call shape** — a different, unfiled amendment |

The register's DE-18 row and DE-04 arm should carry this distinction whatever the ruling; §5's
consequential edits state it.

---

## §2 — Why no out-of-band drain exists for G1/G2 (each route, and the check that refuses it)

The 2026-09-10 paper measured the drain-point routes for ack. This section does the same job for
the *intent-threading* routes out of the guard. Routes 2.1 and 2.2 were **run** (see the
measurement table below); routes 2.3–2.5 are refuted by the checker's own text, cited by symbol,
because each fails a check whose predicate is unconditional — running them would exercise the same
lines the citation names.

- **2.1 A fourth (sink) parameter** — reds twice, independently: `helperParameters.length !== 3`
  (the guard-helper shape branch of `builder:trusted-service-authority-guard`) and, at the poll
  call site, `guardCall.arguments.length !== 3` → `builder:physical-from-authority-guard`.
  **Run as arm (g-a): observed RED.**
- **2.2 A wrapping `try`/`catch` capture at the poll call site** — the binding
  `const guardedAuthority = …` must be a *direct* statement of the tenant callback body
  (`directBinding(tenantBody, name)` behind `builder:attempt-local-source:<name>`, and
  `builder:physical-from-authority-guard` resolves the call through that binding); moving it into
  a `try` block removes the direct binding, and the `let` the wrap forces reds independently
  (`binding:reassigned:guardedAuthority`). **Run as arm (g-b): observed RED, seven violations.**
- **2.3 A comma-expression intent write inside the guard** — the throw-shape pins
  (`directlyThrowsFromGuard`) would tolerate it, but the write needs a sink the guard can see, and
  the guard closes over **service** scope while every honest sink is **per-request**
  (`createWorkerDenialSink()` inside `poll`). A service-scope shared sink is not a contract
  violation; it is a *correctness* violation — concurrent polls would cross-attribute denials —
  and the recorder discipline this wave established (★★★ auditing atomically with, or at least
  attributably to, the refusal it describes) rules it out without needing a red.
- **2.4 Attaching intent to the thrown error object** — `Object.assign` inside the helper body is
  swept by `auditDynamicMetaprogramming(helperBody)` (called immediately after the helper is
  resolved); and even a plain subclass-with-field would need a *read* point, which does not exist:
  poll's `catch` is the frozen classifier/exhaustion/continue triple (the same triple PR #405's
  earlier revision broke and CI caught), and the `finally` has no binding to the in-flight error.
- **2.5 AsyncLocalStorage or module state** — module-scope mutable state written from inside the
  authority helper is the same cross-request attribution hazard as 2.3 with extra machinery, and
  imports into `job-leasing.ts` feed whole-file sweeps (`auditClassifierWrites(file)`,
  `binding:protected-value-escape`) that exist precisely so no unreviewed conduit appears beside
  the authority chain. Nothing here is *provably* red without trying each spelling; the point is
  that every spelling is an unreviewed conduit into the most-pinned helper in the codebase, which
  is the thing the freeze exists to prevent — if this route is ever wanted, it is option A by
  another name and needs the same review.

### The measurements

Baseline and both run arms used `pnpm exec vitest run src/__tests__/job-leasing-contract.test.ts`
in `server/`, at `5237b057a` in a fresh worktree; each arm was reverted (`git checkout --`) and
the file's md5 re-verified against the pre-arm hash before the next.

| # | Arm | Result |
|---|---|---|
| 0 | unmodified | **20 pass** (baseline) |
| g-a | 4th parameter `denialSink?: { intent?: unknown }` on the helper + a 4th argument at both call sites | **1 fail / 19 pass** — exactly the two predicted violations: `builder:physical-from-authority-guard`, `builder:trusted-service-authority-guard` |
| g-b | poll's guard call rebound as `let guardedAuthority` and wrapped in `try { … } catch (guardError) { throw guardError; }` (a rethrow-only wrap — the *minimum* shape a capture needs) | **1 fail / 19 pass** — seven violations: `builder:attempt-local-source:guardedAuthority`, `builder:physical-from-authority-guard`, `binding:reassigned:guardedAuthority`, `binding:protected-value-escape`, `binding:mutated-authority-or-context`, `builder:trusted-common-authority-current`, `candidate:canonical-chain-dominates-return` |

Row (g-b) understates nothing: the wrap that reds seven checks *does not even capture anything
yet* — it rethrows unconditionally. Any version that reads the error before rethrowing is a
superset of it.

---

## §3 — Options for the guard throws (G1/G2)

The ack-body arms have no options section of their own: their options are the filed paper's
(a)/(b)/(c), unchanged, and this paper adds nothing to them except the sufficiency expectation in
§1.3, which the wiring unit must prove by observing its own red first.

### (A) A second amendment: admit a denial-intent holder into the guard

Widen, in one reviewed commit against the contract file: the helper-shape pin (3 → 4 parameters,
the 4th pinned by name and by the property it may receive), both call-expression pins (the poll
pin in `builder:physical-from-authority-guard`; the ack ternary is not separately pinned today,
but the amendment should pin it rather than leave the new argument unchecked there), and — the
lesson the 2026-09-10 paper bought — **a sweep of the new argument's flow for the protected
names**, with the sweep's own red observed before the amendment merges (the (c1) discipline: the
obvious version of *this* amendment would also ship green while opening a hole, e.g. if the holder
could alias `repos`). Then classify per-conjunct inside the guard (a pure registered classifier in
the mold of `pollAuthorityCurrencyIntent`) and drain: poll's existing `finally` covers G1/G2 on
poll; ack coverage additionally requires the filed ack-drain amendment.
**Cost:** the widest relaxation on the table — a caller-supplied mutable collaborator enters the
platform-authority helper, the exact *shape* the contract elsewhere refuses on purpose
(`service:no-context-or-guard-injection` exists because an injectable collaborator is a
substitutable one). The hazard is weaker here — substituting a sink loses audit rows, never
authority — but the review must argue that explicitly, and the 30-conjunct helper is the worst
possible place to be wrong. **Buys:** the last two unaudited authority-denial arms on the worker
poll/ack surface.

### (B) ★ Defer: rule the ack drain now, file the guard-sink amendment as its own future decision

Rule the filed paper (hardened form), wire the ack-body arms, and amend the register's DE-18/DE-04
blocked-arm notes to say what §1.3 measured: the guard throws are gated on a **separate, unfiled
guard-sink amendment**, not on the ack-drain decision — a named deferral with a named unblocker,
not a permanent gap. G1 is a scope-integrity fallthrough (it fires only when
`locked.target.scope` is none of organization/owner/platform — a row-integrity refusal, the same
class the register already leaves unrecorded at poll's two post-authority data-integrity throws);
G2 is real but is the *same* physical-authority recheck the session arm now audits from
`worker-session-auth.ts` (`security.denied.worker_session`, shared-platform physical recheck,
2026-09-13), so a shared-platform worker losing authority mid-lease already leaves a durable trail
one surface over. That materially lowers the marginal value of amending the guard *now*, without
pretending the arms are covered.
**Cost:** DE-18 and DE-04 keep one honestly-named partial arm each until someone files option A.
**Buys:** the ack-body arms now, no relaxation of the guard, and a register that names the true
blocker.

### (C) Accept-the-gap: decline both amendments for these arms

Register amendment marking G1/G2 and A1–A3 as permanently unaudited at the deny site, with the
session-arm adjacency (option B) as the compensating trail. The filed paper's own option (c)
already establishes that DE-03 cannot close on any ruling here (its enrollment and session-issue
conjuncts have no writer at all), so declining is cheap for DE-03 — but A1–A3 are DE-18/DE-04
arms whose siblings (poll admission, session, heartbeat) were all just wired, and permanently
excepting the ack copies of the *same refusals* would make the crossing's audit clause
shape-dependent: recorded when the worker polls, invisible when it acks. That is the
"checks-that-nothing-runs" failure class wearing an audit hat.
**Cost:** a permanent, structurally arbitrary hole in two Critical/High crossings. **Buys:** no
contract motion at all.

### (D) Out-of-band, no amendment — refuted

§2. Not an honest option; listed so the ruling is a choice among real ones.

---

## §4 — Recommendation: **(B)**, with the filed paper ruled in its hardened form

One recommendation, two clauses, one reasoning:

1. **Rule `DECISION-REQUEST-job-003-ack-drain-amendment.md` as its own §3(a) — amend, hardened,
   never minimal.** Its (c1) measurement stands: the naive amendment ships green with a hole. The
   wiring unit that follows must observe the sweep's red first, register the ack classifier in the
   reviewed-call allowlist beside `pollAuthorityCurrencyIntent`, and prove A1–A3 + the seventh
   `recordProof` site RED-first over embedded PG in the DE-03/DE-18 integration suites.
2. **Defer the guard-sink amendment (option B), and fix the register's blocker attribution in the
   same commit that wires the ack arms.** The guard arms should not ride into the most-pinned
   helper in the codebase as a side effect of an ack-path ruling; if they are wanted, option A is
   a paper of its own with its own provocations. The session-arm adjacency means the deferral
   costs observability at the *deny site*, not observability of the *event class*.

The strongest argument against this recommendation is that deferral has a way of becoming
acceptance — the programme's own record shows named follow-ons aging. The mitigation is mechanical
and included in §5: the register note names the unblocker, and the deferral is filed as a task, not
a sentence.

---

## §5 — Consequential edits if (B) is ruled (none taken by this paper)

1. The wiring unit for the ack arms lands the hardened contract amendment (its own red observed),
   the drain, the registered classifier, and the RED-first integration arms — one reviewed PR.
2. The same PR corrects the register's DE-18 row and DE-04 worker-authority-currency arm: the
   guard throws' blocker becomes "the unfiled guard-sink amendment (see
   DECISION-REQUEST-job003-ack-drain.md §3(A))", and the ack-arm sentence is deleted rather than
   qualified.
3. E0-F010's trail gains the ruling reference; DE-03's status does not move (enrollment and
   session-issue conjuncts still have no writer — unchanged from the filed paper's (c) analysis).
4. A follow-on task is filed for option A so the deferral has an owner-visible handle.

---

## DECISION BLOCK — RULED

> "Option B. Adopt the hardened `.finally` ack-drain amendment as measured in the filed 2026-09-10
> paper (`DECISION-REQUEST-job-003-ack-drain-amendment.md`), unblocking the ack-path audit arms
> (the 3 target_revoked throws + the seventh recordProof site). The guard-sink amendment for
> guardPlatformAuthority's two shared-platform throws is DEFERRED as a named, owner-visible future
> decision — not accepted-as-gap; the register must attribute those arms to the deferred guard-sink
> decision, not to JOB-003."

- **Ruling on `DECISION-REQUEST-job-003-ack-drain-amendment.md` (its §3 (a)/(b)/(c)):** (a) — amend,
  hardened form, per the ruling above.
- **Ruling on the guard throws (this paper's §3 (A)/(B)/(C)):** (B) — deferred as the named future
  decision **DEFERRED-DECISION: guardPlatformAuthority denial sink** (this paper's §3(A) is its
  option space).
- **Signature / date:** Ruled by the founder via Claude session, 2026-09-14.
