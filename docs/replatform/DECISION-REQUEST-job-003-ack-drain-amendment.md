# DECISION REQUEST — amend the frozen JOB-003 ack-flow contract so the ack path can drain a denial record

**Answers:** the pinned residue of `DE-03` recorded at `server/src/services/job-leasing.ts` above
the ack `runInTenant` call, and mirrored in `E0-F010` ("SIX of DE-03's seven organization-attested
`recordProof` refusals now record… THE SEVENTH WAS NOT WIRED").
**Date:** 2026-09-10. **Measured at:** `c27feeea8`.
**Status:** RULED 2026-09-14 — option (a), adopted in its hardened form, by the founder's Option-B
ruling recorded in [`DECISION-REQUEST-job003-ack-drain.md`](./DECISION-REQUEST-job003-ack-drain.md)
§Decision (the ruling text lives there and is not duplicated here). The ack-path audit arms are
UNBLOCKED; the build (the hardened contract amendment + wiring) has not shipped yet.
**Changes no finding's status and wires no code.**
Every experiment below was applied to a scratch working tree, run, and **reverted**; the tree this
paper ships in contains none of it (`git checkout --` + md5 verification after each arm).

---

## THE HEADLINE — THE BLOCKER IS REAL, THE OBVIOUS AMENDMENT IS UNSAFE, AND A HARDENED ONE IS PROVEN

Three things were measured, in this order, and the middle one is the reason this is a decision
request rather than a patch.

1. **The blocker is real, and it was re-measured rather than inherited.** Chaining `.finally(…)`
   onto the ack method's outer `return runInTenant(…)` makes `job-leasing-contract.test.ts` fail
   with `builder:trusted-service-authority-guard` — 1 failed / 19 passed, against a 20/20 green
   baseline at the same commit. The prose in `job-leasing.ts` and in PR #405's message said this
   would happen; it does.
2. **★ THE OBVIOUS AMENDMENT IS MEASURABLY UNSAFE, and it was only caught by testing the safety
   claim instead of arguing it.** The minimal change — teach `exactAckReturnDominance` to accept
   `runInTenant(…).finally(fn)` as the outer return — makes the contract green on the drain shape
   (20/20). It **also silently stops policing the drain callback**: with that amendment in place, a
   call to one of the four PROTECTED ack effects (`activateLeaseAck`, `findOperationReceipt`,
   `lockLeaseAckContext`, `touchWorkerLeaseProfile`) placed *inside* the `.finally` callback leaves
   the contract **GREEN, 20/20**. The reason is structural, not incidental: `collectAckEffects`
   walks `ackBody`, and `ackBody` is the *`runInTenant` callback's* body — the `.finally` callback
   is a sibling scope the sweep never enters. The amendment would have opened a hole in the exact
   guard it was being asked to relax, and it would have shipped green.
3. **A hardened amendment closes that hole, and it was proven by the same provocation.** Sweeping
   the outer call's single argument for the protected names as well makes the same
   protected-effect-in-the-drain case **RED** (1 failed / 19 passed), while the benign drain shape
   is **GREEN, 20/20**.

**Recommendation: amend, but only in the hardened form, and only as its own unit with the sweep's
own red observed first.** A `.finally`-shaped amendment without §3's sweep must not be taken.

---

## 1. WHAT THE CONTRACT ACTUALLY PINS, AND WHAT IS INCIDENTAL

`exactAckGateFlow` (in `job-leasing-contract.test.ts`) is a conjunction. Two of its conjuncts are
the dominance properties this paper touches:

- `exactAckEffectDominance` — every call to a protected ack effect is a statement **directly in**
  the `runInTenant` callback body and sits **after** the authority guard `if`.
- `exactAckReturnDominance` — **every return other than the one outer `runInTenant` return** sits
  after that same guard.

The second names the outer return only in order to **exclude** it from the set it polices, and it
identifies it by requiring `unwrappedCall(statement.expression) === ackTenantCall` on a return whose
parent is the ack method body. `unwrap` strips `await`, parens, `as` and `!` — never a member call —
so `return runInTenant(…).finally(fn)` resolves to the `.finally` call, matches nothing, and the
whole conjunct collapses. A wrapping `try`/`finally` fails differently and for the same reason: the
return's parent becomes the try block, not the method body.

**So the property being protected is dominance; the exact syntactic shape of the outer return is the
identification mechanism, not the property.** That is what makes an amendment conceivable at all.
It is also why the poll path is not a precedent to copy: poll hangs its drain on a `finally` of its
**retry `try`**, and ack has no retry `try` to hang one on.

---

## 2. THE MEASUREMENTS

All four arms below were run at `c27feeea8` with `vitest run server/src/__tests__/job-leasing-contract.test.ts`.
Baseline at that commit, unmodified: **20 passed / 20**.

| # | Source shape (ack) | Contract checker | Result |
|---|---|---|---|
| 0 | unmodified | unmodified | **20 pass** (baseline) |
| a | `return runInTenant(…).finally(() => { void ackDenialDrainProbe; })` | unmodified | **1 fail / 19 pass** — `builder:trusted-service-authority-guard` |
| b | same as (a), benign body | `.finally` accepted as the outer return | **20 pass** |
| c1 | `.finally(() => { … lockLeaseAckContext() … })` | (b)'s naive amendment | **20 pass ← THE HOLE** |
| c1′ | same as c1 | (b) **+ the drain-argument sweep** | **1 fail / 19 pass** |
| c1″ | benign drain body | (b) + the sweep (positive control) | **20 pass** |
| c3 | `.finally(fn).finally(fn)` | (b) + the sweep | **1 fail / 19 pass** |
| c4 | `.finally(() => { if (…) return; … })` | (b) + the sweep | **1 fail / 19 pass** |

Rows (c3) and (c4) are the two evasions worth naming: a **chained** second `.finally` is refused
because the accepted shape requires the receiver to unwrap to `ackTenantCall` itself, and a
**`return` inside the drain callback** is refused because `collectAckReturns` already walks the whole
method body while `directAckStatement` refuses any node inside a function that is not the
`runInTenant` callback. Neither needed new machinery; both were checked rather than assumed, because
(c1) had just shown that "the checker surely still sees that" is not a measurement.

The hardened amendment, in full, is the naive one plus this — placed after `outerAckTenantReturn` is
resolved and before `exactAckEffectDominance` is computed:

> if the outer return's call is not `ackTenantCall` itself (i.e. it is the accepted drain form),
> walk that call's single argument for the same protected names and the same computed-access
> escape, and set `invalidAckEffectUse` on a hit.

`invalidAckEffectUse` is an existing input to `exactAckEffectDominance`, so nothing new is invented:
the drain callback is simply brought inside a sweep that already exists.

---

## 3. WHAT THE RULING IS BEING ASKED FOR

The contract is FROZEN, and the freeze is live rather than decorative — PR #405's own message
records an earlier revision that put a drain in poll's `catch`, broke the frozen
classifier/exhaustion/continue triple, and was caught by CI. This paper therefore asks for a
decision, not a patch:

**(a) AMEND, hardened.** Accept `runInTenant(…).finally(fn)` as the ack method's outer return **and**
extend the protected-effect sweep into that drain callback in the same commit. Then wire DE-03's
seventh site the way the other six are wired. Cost: one contract relaxation plus one contract
widening, both in one file, with (c1) as the arm that proves the widening is load-bearing.

**(b) AMEND, minimal.** Not recommended, and named only so the ruling is a choice: it is measurably
(c1)-unsafe.

**(c) DECLINE, and amend the clause instead.** DE-03's clause is *"enrollment, session issue, and
replay-rejection are audited"* and is a **three-way conjunction**; six of seven replay-rejection
sites record today and **neither enrollment nor session-issue has any writer at all**. So DE-03
cannot close on this ruling whatever it says. Declining costs one deny site out of seven on one of
three conjuncts, and the site stays pinned by its existing arm in
`de-03-worker-replay-denial-audit.integration.test.ts`, which asserts the throw first so the pin
cannot pass by vacuity.

**This paper does not take (a).** It is filed because a frozen cross-cutting contract is not a thing
a denial-audit unit should widen on its own judgment, and because the safety argument for widening
it turned out to be false in its obvious form.

---

## 4. TWO CORRECTIONS TO THE RECORD THIS PAPER IS ABOUT

1. **The in-source note's line citation was stale, and fixing it demonstrated why.** The comment
   above the ack `runInTenant` call said *"`job-leasing.ts:816`'s `recordProof` refusal"*. At
   `c27feeea8` that `recordProof` call was at `:878`, with its refusal `throw` at `:886`. The
   commit filing this paper rewrote that comment — and **the added paragraph pushed the same two
   lines to `:891` and `:899`, re-measured at this branch's HEAD.** It moved them TWICE: the first
   draft of the correction landed them at `:889`/`:897`, and rewriting that draft to drop its own
   line numbers moved them two lines further. A corrected number would have been stale in the diff
   that corrected it, twice over. The comment therefore now carries **no line number at
   all**, only the symbol and the enclosing method, and so does this paper. The refusal itself was
   always described correctly; only the number rotted.
2. **The blocker claim itself is TRUE.** It was re-measured (row (a)) rather than inherited, because
   four consecutive papers found the record naming a wrong blocker. This one names the right blocker
   — and understates the problem, since the naive fix for it is unsafe.
