# Verifying the codex review — what I re-opened, and what it changed

The independent report is kept verbatim in `2026-08-25-codex-independent-review.md`. This is the
record of checking it, claim by claim, against the source it cites. **Codex reviewed documents that
had already survived two in-house adversarial rounds.** It found a blocking defect that all of them
missed, including me.

---

## The one that matters: a composed daemon cannot obtain its FIRST session

**Verdict: CONFIRMED. Filed as E4-F012 (HIGH), owned by Sprint 2.5.**

I re-opened all four links:

| Step | Verified at | What it says |
|---|---|---|
| the enrolment session is discarded | `enrollment/enroll-once.ts:310` | ``// `result.session` is dropped here and never returned (I13).`` — verbatim in the source |
| the store starts empty and calls `renew()` first | `identity/session.ts:100-106` | returns current if live, else `forceRefresh()` → `this.#deps.renew()` |
| `renew` takes no arguments | `identity/session.ts:50-55` | `readonly renew: () => Promise<WorkerSession>` |
| the route needs a live bearer | `middleware/worker-session-auth.ts:125-127` | matches `^Bearer\s+…$`, `fail()`s when absent |

So `SessionStore(..., initial = null)` plus a `renew` thunk pointed at the WRK-010 route has
**nothing to present on the first call**. The route renews by construction; it cannot create.

**Why two rounds of review missed it.** Both were asked *"does the seam match?"* — and it does:
same symbol, same package, same zero-argument signature, same return type. The completeness critic
even wrote that the seam is "shape-correct" and it was right. The defect is not in the shape. It is
in the **initial state**: at `t=0` the consumer has no credential, and nothing in three plans
acquires one. Codex found it by tracing the first call rather than the contract.

**And it is a decision, not a fix.** I13 discards the session *on purpose*, so a bearer can never
reach a log line. Every route to a first session either re-opens that or changes the
`SessionStoreDeps` contract — which also falsifies slice 2b's claim that the seam is "ONE injected
thunk — swapping it changes nothing else." Sprint 2.5 must answer it in writing before planning.

---

## Confirmed, and acted on

| Claim | Verdict | What changed |
|---|---|---|
| **The gate table has SIX rows; "four/three" counts a different subset** | **CONFIRMED** | Third correction to that one sentence. Round 2 said *two* under a table implying three; round 3 said *three* — right about the landable subset, wrong as a sentence, because it read as the count of a table with six rows. Gates 5 (`no_session`) and 6 (`no_self_model`) gate dispatch just as hard. Now: **six outstanding on the container, five on the desktop; four and three landable.** Fixed in the plan, in E4-F011, and in the go-book. |
| **Sprint 2.5's Done condition was unreachable — the order is cyclic** | **CONFIRMED** | Sprint 2.5 must show "a production caller", but the only production `SessionStore` construction lived in Sprint 3, which runs after. Resolved by moving the production identity + `SessionStore` wiring **into Sprint 2.5**; Sprint 3 composes on top and re-scopes at its Step 0. |
| **"Sprint 3 — dispatch goes LIVE / first real job" is false** | **CONFIRMED** | E4-F010 already established that the worker refuses 100% of production offers. The sprint headline still claimed otherwise — the plan admitted it later in the same document. Retitled "dispatch gets COMPOSED", with the contradiction called out where the old line stood. |
| **The go-book says the authenticator performs "all ten" guards** | **CONFIRMED** | My own inconsistency: I corrected the §8 decision row to "nine in full, tenth in part" and left the Sprint 1 paragraph saying "all ten". Fixed. |
| **The register table overstates its own guard** | **CONFIRMED, and the worst-tasting one** | §6 said `check-finding-ownership.mjs` fails when "an open finding has no owner". It does not: `status: "unowned"` with a reason is accepted by design, and two findings sit there right now. A **false claim of enforcement**, in the table that lists the guards against false claims of enforcement. Rewritten to say what the guard actually does — make ownerlessness *visible*, not impossible. |
| **`ownerStillOpen` is unvalidated free text** | **CONFIRMED** | `finding-ownership.mjs:118-120` tests only non-emptiness, so `E4-F008`/`E4-F009` (→ WRK-008) and `E6-F003` (→ DEP-010, while its own plan marks it *deferred*) will read as owned by shipped tickets the moment those tickets get result docs. Filed as **E4-F013**, deliberately unowned — it is a hole in the ownership guard, so no product ticket is its natural owner. A checkable fix is proposed in the finding; it needs its own RED test and a deleted-guard mutation. Meanwhile the Sprint 2 and Sprint 3 prompts each carry the transfer duty. |
| **E4-2 would be promoted to `wired` over zero supervised sandboxes** | **CONFIRMED** | Production reaches the supervisor only after an ACK, and the self-check refuses every production offer before that. The plan's own runtime test expects `offerSatisfiesWorker === false`. Caller-count enforcement cannot catch this. The Sprint 3 prompt now names it explicitly. |
| C1, C2, C3, C5, C6, C7, C8, C9, C10 | **VERIFIED by codex, spot-checked by me** | No change needed — these confirm the corrections the two in-house rounds already made, including the platform-physical divergence (C2) and the desktop custody fact (C3). |

---

## What this says about the review process

Three passes, each finding what the last could not, and each blind in a way the next was not:

1. **Per-plan reviewers** check a plan against the code. They found citation errors, uncompilable
   mutants, and vacuous guards — and could not see anything outside their file.
2. **The completeness critic** checks the set against itself. It found that Sprint 1's product would
   have had zero callers — invisible to any single-plan reader — and it verified the seam as
   "shape-correct", which was true and insufficient.
3. **The independent reviewer** shares none of the framing. It traced the *first call* instead of the
   contract, counted the *rows in the table* instead of trusting the sentence under it, and read the
   guard's source instead of the guard's description. Every one of its confirmed findings is a place
   where an in-house reviewer accepted a frame that the documents themselves had established.

The cheapest lesson: **three of the seven confirmed defects are a summary sentence contradicting the
detail directly above it** — the gate count, the "all ten" guards, and the register table. That is
now the most frequent defect in this programme's own documentation, and it is the same shape as the
defect the programme exists to fix, one level up.
