# E5 Workspaces & Secrets — findings

Findings filed against Epic E5. Created 2026-09-06 (W5U1); E5 previously had no register, so its
findings lived only inside ticket results and QA snapshots.

Every OPEN finding must have a declaration in `scripts/finding-ownership.json` (the
`check-finding-ownership` guard fails otherwise: a new open finding is born `undeclared_finding`).
`unowned` with a reason is legitimate — it makes an unscheduled item visible rather than impossible.

## E5-F001 — E5-6's register reason names the wrong owner, and the OTHER owner it omits shipped without the symbol and handed the residual to a ticket that never mentions it

**Status:** resolved_by_w16a · **Owner:** — (closed; the ownership entry is deleted in this commit)
**Severity:** MEDIUM (register accuracy plus an orphaned charter; the security substance is
E8-F003's, which is already open)
**Filed:** 2026-09-06 (W5U1), measured at `e1f723df2`.
**Resolved:** 2026-09-07 (W16A, branch `replatform/w16a-register-sentences`), re-measured at
`8075cd7a1`.

> ★ **HOW IT WAS RESOLVED, AND WHAT W16A ADDED TO IT.** `E5-6-denied-egress`'s `reason` now names
> every ticket that passed over this capability and shipped, and says that BRW-004 slice (f) is the
> only REMAINING named candidate rather than the only one there has ever been:
>
> - **CHARTERED (1) — DAT-005**, which BUILT the symbol and booked itself COMPLETE with zero
>   production callers (`DAT-005-result.md:3`). This finding as filed named only DSK-002 and
>   BRW-004 (f); W16A added DAT-005, because a reader planning the wiring should know the symbol's
>   own author shipped it unwired.
> - **CHARTERED (2) — DSK-002**, whose Outcome and acceptance clause (4) require the capability and
>   which shipped having explicitly DECLINED it.
> - **NOMINATED, NEVER CHARTERED — DSK-003.** It was named by DSK-002's *result*
>   (`DSK-002-result.md:168-179`, "belongs with DSK-003"), which is a nomination and not a charter.
>   Its own charter carries no egress requirement at all: the Outcome (`DSK-003-design.md:14-16`)
>   is a least-privilege desktop background host with signed installers, none of the five
>   acceptance clauses (`:20-24`) names egress, a proxy or a broker, and `grep -ni egress` over
>   both DSK-003 documents returns zero hits. It shipped without taking the residual.
>
> ★★ **CORRECTED 2026-09-07 (W16A-FIX), and the correction is the point.** The first version of
> this note and of the register sentence said "**three** chartered tickets". That was an
> overstatement by one — flagged independently by Codex on PR #380 and by an adversarial reviewer,
> and refuted by `scripts/finding-ownership.json` itself, whose `E8-F008` `successor` field already
> said "DAT-005 and DSK-002, **the two tickets that were chartered** to reach this path". Counting a
> nominee as a charter inside the very PR that exists to fix register overstatement is the defect
> eating itself, so the count is now stated as **two chartered plus one nominee who declined by
> silence**. Both spellings are load-bearing: two tickets were *told* to build this and did not;
> one was *asked* to inherit it and never acknowledged it.
>
> One thing this finding said that W16A did NOT copy forward as written: BRW-004 slice (f) is
> described in the register as **deferred**, not "unattempted". `BRW-004-result.md` is on disk
> at Status `gate_review`, covering slices (a)-(d) only, with (f)-(h) recorded not attempted
> (`:15`, `:99`) and the acceptance condition "allowed domains … are enforced" booked `deferred`
> (`:366`). The programme's newest record (`E8-F003`'s successor field) calls that slice "real and
> still open", so calling it *shipped past* would have been a correction that was itself wrong.
>
> **This is a BRANCH STATE.** True on `replatform/w16a-register-sentences`. If that PR is not
> merged, restore the `E5-F001` key in `scripts/finding-ownership.json` and set this back to
> `open`.

**What the register SAID.** `scripts/gate-clause-wiring.json` -> `E5-6-denied-egress`, under "WHAT
WOULD HAVE TO CHANGE for 'wired'" (this text no longer exists in the file):

> "**BRW-004 slice (f) is the only chartered candidate**, is unattempted, and is browser-scoped;
> the org/crew sandbox egress path that E8-F003 measured has no chartered owner at all."

**Measured: "only" is false.** DSK-002's charter names a fence-aware egress path in its outcome
sentence and in an acceptance clause:

- `docs/replatform/epics/E10-desktop/tickets/DSK-002-design.md:15-17` — Outcome: "…mediate
  device-local handles through the DAT-004 broker **plus a fence-aware egress path**."
- The same file's acceptance clause (4), `:25`: "The sandbox cannot read OS credential storage or
  **bypass the broker/proxy**."
- `DSK-002-design.md:198-200` (D5) makes it concrete: "'Governed' means: committing a patch,
  activating a device-local credential, or **performing an egress through the broker**."

The symbol E5-6 declares — `createFenceAwareEgressProxy`, `server/src/services/egress-proxy.ts:146` —
is not browser-scoped: its own header calls it "the FENCE-AWARE egress proxy (server-side,
inert-until-wired)" whose live request channel "is an INERT seam wired at E4-D12", and its step 2 is
`broker.resolve()` — the DAT-004 broker DSK-002's outcome names. So DSK-002's chartered outcome
requires this symbol's capability, and E5-6's `reason` does not mention it.

**And the omission is worse than a missing name — the charter is now ORPHANED.** DSK-002 has
SHIPPED (`DSK-002-result.md` exists, so `check-finding-ownership.mjs`'s own `findCompletedTicketIds`
counts it complete). Its result declines the egress half explicitly:

- `DSK-002-result.md:161-163` — "`sandbox.filtered_egress` is claimed by no mechanism. … It becomes
  reportable when **Lane D's fence-aware egress path exists**; claiming it now is the exact
  over-report D4 forbids."
- `DSK-002-result.md:168-179` — "Lane D shipped the POLICY, not the wiring, and that is a decision.
  … threading one … needs the least-privilege host and **belongs with DSK-003**."

And `grep -n egress docs/replatform/epics/E10-desktop/tickets/DSK-003-*.md` returns **zero hits** in
both DSK-003 documents — and DSK-003 has a result doc too. So the residual was handed to a ticket
that never took it and has since shipped. That is precisely the "carried past its own resolution
point and nothing noticed" shape `scripts/lib/finding-ownership.mjs` was written for, occurring in a
register the ownership guard does not read.

**What is NOT claimed.** E5-6's `unwired` status, its 0 caller count
(`node scripts/check-gate-clause-wiring.mjs --counts` -> `0 createFenceAwareEgressProxy`), its
re-enrolment rationale and its "DO NOT read the D1 grade as evidence" paragraph are all correct and
untouched. Nor is this a second copy of E8-F003: that finding owns the security consequence (a
Critical threat control recorded as delivered while enforcement exists nowhere). This one owns the
narrower fact that the register's account of WHO WOULD WIRE IT names one candidate and there are
two, and the second one's residual has no holder.

**What would close it.** Correct E5-6's `reason` to name both charters and to say that DSK-002's
half is currently held by nobody. Not done by W5U1: its charter forbids changing an existing
clause's declaration. **DONE by W16A** — see the resolution note at the top of this entry, which
also records the chartered ticket this entry missed (DAT-005, the symbol's own author) and, after
W16A-FIX, keeps DSK-003 out of the charter count it never belonged in.

## E5-F002 — The two-header upload contract has a designated single home with zero callers, and the code that actually runs re-derives it differently — including one header it omits

**Status:** open
**Severity:** MEDIUM (a dormant path; the divergence is real and measured, and the shipped variant
is the one never run against a real store)
**Filed:** 2026-09-06 (W5U1), measured at `e1f723df2`.

**What.** `grantPutHeaders` (`packages/worker-daemon/src/lease/artifact-export.ts:140-145`) exists,
by its own docstring, to stop exactly the divergence that exists:

> "This function is that knowledge, lifted out of a test harness and put beside the grant it derives
> from — **because two providers re-deriving it independently is how the second one gets it wrong
> silently.**"

It has **zero non-test callers**: `grep -rn grantPutHeaders --include=*.ts .` returns the definition,
the `packages/worker-daemon/src/index.ts:180` re-export, one comment at `index.ts:173`, and
`artifact-export-sequencer.test.ts`. Nothing in production calls it.

**FOUR independent derivations exist. They do not agree.** (The report named three; re-grepping
the harness found a fourth, identical in header set to #3.)

| # | site | `x-amz-checksum-sha256` is the digest of… | `x-amz-sdk-checksum-algorithm` | other |
|---|---|---|---|---|
| 1 | `artifact-export.ts:140` `grantPutHeaders` — the designated home, **0 callers** | the GRANT's `expectedSha256` (hex->base64) | **sent** | grant headers spread last |
| 2 | `e2b-provider.ts:142` `putGrantBytes` — **the shipped default uploader** | the BYTES BEING UPLOADED | **absent** | also sends `content-type` |
| 3 | `tests/d1/lib/e6f-harness.mjs:1503` `putPresignedBytes` — the D1 harness | the BYTES BEING UPLOADED | **sent** | — |
| 4 | `tests/d1/lib/e6f-harness.mjs:1712` `putPresignedBytesAllowError` — the harness's toxic-truncation variant | the BYTES BEING UPLOADED | **sent** | catches a severed TLS connection |

Two divergences, both measured:

1. **The header set differs.** #2 — the only one that would run in production — omits
   `x-amz-sdk-checksum-algorithm`. #1, #3 and #4 all send it, and #3's own docstring says it sets
   "both … headers **the signed PUT's query demands**".
2. **The checksum SOURCE differs.** #1 signs the server's EXPECTATION; #2, #3 and #4 sign what they
   actually uploaded. #1's docstring anticipates precisely this and calls it out: "A provider that
   hashed what it actually uploaded would produce a PUT the store accepts and a commit the control
   plane refuses `hash_mismatch`." The shipped provider is that provider.

**★ The sharpest part, and it is not in the original report.** The only live-store evidence for this
contract was gathered with derivations **#3/#4**, not #2. `keyed-dat-009-artifact-export.test.ts:28-34`
states it plainly: "It does not perform a real HTTPS PUT. The uploader is **injected**, so the store
half is not exercised here — that half is already live-proven against real MinIO by DAT-002". DAT-002
ran through the D1 harness. So the ONE of the four derivations that would actually execute in
production is the ONLY one missing a header the live-proven path sends, and it has never met a real
store on that path.

**Why MEDIUM.** Nothing calls `exportArtifact` in production
(`createArtifactExportSequencer` measures 0 callers; E5-2 says so), so no byte moves today and no
run is affected. The failure mode when it does move is fail-closed (a rejected PUT, or a
`hash_mismatch` at commit) rather than a silent bad commit. What is at stake is a contract with a
stated single home that the running code does not use, discovered late and far from the cause —
which is the outcome the single home was created to prevent.

**What would close it.** Have `putGrantBytes` call `grantPutHeaders` (spreading its own
`content-type` default and its own byte digest over the result, if the byte digest is the intended
semantics — that choice is DAT-009's, not this filing's), which would also give the designated home
a production caller. Not done here: `putGrantBytes` is on the export path DAT-009 slice 3 owns, and
changing which digest a signed PUT carries is a correctness decision with live-store consequences
that must be re-proven on the keyed lane, not asserted from a filing unit.
