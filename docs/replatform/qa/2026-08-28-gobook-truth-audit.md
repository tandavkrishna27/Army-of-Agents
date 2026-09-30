# GO-BOOK truth audit — 2026-08-28

**Auditor pass:** read `docs/replatform/GO-BOOK.md` top to bottom (2419 lines) and cross-checked
every load-bearing claim against the repo at `C:\e3` tip (`2753a1fe9`, branch
`docs/replatform-program`). Read-only: no git writes, no edit to GO-BOOK. This file is the only
deliverable. Citations are by section-heading / symbol / SHA, never line number.

## Scorecard

| Classification | Count | Meaning |
|---|---|---|
| **CONFIRMED-CURRENT** | 41 | still true; no change |
| **STALE-FIXED** | 6 | was true when written, now resolved/superseded; correction proposed |
| **WRONG** | 0 | none found — every over-claim in the doc is already reconciled |
| **UNVERIFIABLE** | 3 | external CI run-ids / owed live runs; flag for human, no edit proposed |

**Headline:** the go-book has *already been reconciled* for the CI-green fix in its most-read
places (the top-of-file banner, §2.0, §5's "Retired" note, and the Sprint 1/5/5a/5b/6 copy-paste
prompts). The residue is **three §9 copy-paste prompts** the CI-green sweep missed — **two still
literally instruct the session "`verify` is red … do not raise its timeout to make it green"**
(the exact "can't go green" class the requester flagged), and one (the verify-parallelization
prompt) is presented as a live to-do although the work shipped as PR #327. Everything else the
doc claims — every SHA, every `wired`/`unwired` state, the E10-F001 crew-mint correction, the E9
"premature" and E4-F015 "obviated" scoping calls — checks out against source.

---

## Critical stale claims — a reader would act on these wrongly TODAY

These are the "CI can't go green" survivors. All three are in §9 (the copy-paste prompts, the
section a session literally executes). The fix is already written five times over in the sibling
prompts; these three were skipped.

### C-1 · §9 "Sprint 2.75 — WRK-011" prompt — tells the session `verify` is red

**Classification:** STALE-FIXED.
**EVIDENCE:** `verify` is a 4-shard matrix and `ci-required` is green — `.github/workflows/pr.yml`
`verify` job (`strategy.matrix.shard: [1,2,3,4]`, `pnpm exec vitest run --shard=${{ matrix.shard }}/4`)
+ `ci-required` aggregator (`needs: […verify…]`, `R_VERIFY = needs.verify.result`); shipped in
PR #327 (`9d01e5c32`, merge `18d3331f1`). The go-book's own top banner and §2.0 already say
"RESOLVED". The Sprint 1 / 5 / 5a / 5b / 6 prompts were updated to the standard line; this one and
Sprint 4 were not.

```
OLD:
- Commit, push, and report CI honestly — including `verify`, which is red for reasons that
  predate this sprint (§2.0). Do not raise its timeout to make it green.

NEW:
- Commit, push, report CI honestly (`verify` is now a sharded matrix — §2.0 RESOLVED, so `ci-required` should PASS; a red shard is a real failure to own, not an inherited timeout).
```

### C-2 · §9 "Sprint 4 — DAT-008 slices 5 and 7" prompt — tells the session `verify` is red

**Classification:** STALE-FIXED.
**EVIDENCE:** same as C-1 (PR #327 / `9d01e5c32`; `pr.yml` `verify` matrix + `ci-required`).

```
OLD:
- Commit, push, and report CI honestly — including `verify`, red for reasons predating this
  sprint (§2.0). Do not raise its timeout to mask it.

NEW:
- Commit, push, report CI honestly (`verify` is now a sharded matrix — §2.0 RESOLVED, so `ci-required` should PASS; a red shard is a real failure to own, not an inherited timeout).
```

### C-3 · §9 "CI hardening — parallelize `verify`" — a live to-do for work already shipped

**Classification:** STALE-FIXED.
**EVIDENCE:** The prompt's own deliverable ("shard `verify` into a parallel matrix … confirm every
verify shard goes green and ci-required passes for the first time") is done: `pr.yml` `verify` is
the 4-shard matrix; PR #327 (`9d01e5c32` shard + `bd7122e51` / `22a893f59` the two masked-bug
fixes; merge `18d3331f1`). Unlike the "Sprint 9 (first unit)" prompt — which carries a
"★ SHIPPED … historical prompt, kept as the record" banner — this block reads as pending work.
Proposed fix: add the same historical banner under the heading (mirrors the S9-unit-1 precedent).

```
OLD:
### CI hardening — parallelize `verify` (retire the §2.0 timeout before S6)

NEW:
### CI hardening — parallelize `verify` (retire the §2.0 timeout before S6)

> **★ SHIPPED 2026-08-27 (PR #327, `9d01e5c32` shard + `18d3331f1` merge) — historical prompt,
> kept as the record.** `verify` is a 4-shard matrix and §2.0 is RESOLVED; `ci-required` goes
> green. Do not re-run this prompt — the work is done. See §2.0 and the §3.1/§5 "Retired
> 2026-08-27" notes.
```

---

## Full claim ledger, grouped by GO-BOOK section

Notation: **[CC]** CONFIRMED-CURRENT · **[SF]** STALE-FIXED · **[UV]** UNVERIFIABLE.

### Top-of-file banner ("★ In a hurry?")

1. **[CC]** "CI is green. As of 2026-08-27 (PR #327) `verify` is a 4-shard matrix and §2.0 is
   RESOLVED — `ci-required` passes." — `pr.yml` `verify` matrix + `ci-required` aggregator; merge
   `18d3331f1`. Correct.
2. **[CC]** "The §3.1 rows below say 'inherits the §2.0 red' as an accurate record of each
   sprint's ship-time state; that condition is now retired." — this sentence pre-empts the §3.1
   rows honestly; those rows are therefore *not* stale (see Do-NOT-change #1).

### §1 "What we are building, and where it actually stands"

3. **[CC / historical framing]** "no agent has ever run on a distributed worker … 17 epic gate
   clauses name a capability whose production path has zero callers." — This is the pre-Sprint-1
   framing (line-labelled as such by §1.5). It is numerically superseded: `gate-clause-wiring.json`
   now shows `E4-1`, `E4-2`, `E4-4`, `E5-5`, `E11-5` **wired**, so the "17 zero-caller" count has
   dropped. Not corrected here because §1.5 ("CURRENT STATUS, reconciled 2026-08-27") immediately
   supersedes it and the paragraph is explicitly the "pre-Sprint-1 census". Flagged for awareness
   (see Do-NOT-change #5).
4. **[CC]** "`ci-required` is green-capable again as of Sprint 0." — Defensible: on a docs-only PR
   (`changes.outputs.code == 'false'`) `verify`/`e2e`/… are skipped and `ci-required` computes
   green from the always-on gates; Sprint 0 was docs-only. Reads oddly next to §2.0 (verify was
   *timing out* at Sprint 0 for code PRs) but is true for the docs lane it describes. Borderline;
   no edit.

### §1.5 "★ CURRENT STATUS & forward timeline (reconciled 2026-08-27 / updated 2026-08-28)"

5. **[CC]** "the distributed-execution mechanism is BUILT and proven for coding agents." —
   `E4-1-leases-through-protocol` + `E4-2-supervises-sandboxes` are `wired` in
   `gate-clause-wiring.json` on the CLI-006/D2 Step-1 composed-journey evidence. Correct.
6. **[CC]** "E7-1 … blocked only on the staging fleet being deployed → promotes E7-1
   `unwired`→`wired`." — `gate-clause-wiring.json` `E7-1-coding-journey` = `unwired`
   (`expectedReferences: 2`). Correct.
7. **[CC]** "E4-F013 ✅ … and foundation-suite-unrun ✅ (S9-3 …) landed." — `5996eb6dc`
   (E4-F013 ownership-successor) and `0a093e6ae`/`c208acfd7` (foundation-suite-unrun) on-branch;
   `pr.yml` `policy` job's "Distributed execution foundation contracts" step now runs BOTH
   `check-distributed-execution-foundation.mjs` AND `node --test …foundation.test.mjs`. Correct.
8. **[CC]** "E9 gate-clause guard is PREMATURE (… the batch-only capability is a constant …)." —
   `packages/worker-daemon/src/enrollment/hello-provisioning.ts`
   `SUPERVISABLE_WORKLOAD_CAPABILITIES: readonly WorkerCapability[] = ["workload.batch"]`. Correct.
9. **[CC]** "E4-F015 is OBVIATED (the `DispatchRefusalReason` union is already compile-time-pinned
   by the total `DISPATCH_REFUSAL_MESSAGES` Record + `tsc`)." —
   `packages/worker-daemon/src/lifecycle/compose-dispatch.ts`:
   `export const DISPATCH_REFUSAL_MESSAGES: Readonly<Record<DispatchRefusalReason, string>>`. A
   total `Record` over the union → a missing arm is a `tsc` error. Claim is TRUE against source.
   (NB: the finding itself is still `**Status:** open` in
   `epics/E4-worker-daemon/findings.md` and `unowned` in `finding-ownership.json` — that is the
   allowed audit-trail lag, not a go-book error; see Do-NOT-change #4.)
10. **[CC]** "E10-F001 corrected 2026-08-28 — crew RIDES the mint (iff a v1 provider:
    anthropic/openai, not google/opencode)." — `finding-ownership.json` `E10-F001.reason`
    ("CREW RIDES the mint … guard 3 admits IFF the company's crew provider is v1 … per
    resolve-crew-adapter.ts") + commit `14d8063f9`. Correct.
11. **[CC]** "the 12 open findings (`finding-ownership.json` + §5)." — `finding-ownership.json`
    carries 12 keys (E4-F008, E6-F003, E6-F005, E6-F006, E6-F007, E4-F009, E4-F014, E4-F015,
    E10-F001, E11-F001, E11-F002 + the resolved-list is elsewhere). Count matches.

### §2.0 "`verify`: RESOLVED 2026-08-27"

12. **[CC]** "PR #327 … all four `verify` shards pass in 12.8–16.2 min, `ci-required` PASS … now a
    `fail-fast:false` shard matrix of 4 legs; the 60-min cap is unchanged (now a per-shard cap)."
    — `pr.yml` `verify`: `strategy.fail-fast: false`, `matrix.shard: [1,2,3,4]`,
    `timeout-minutes: 60`. Correct.
13. **[CC]** "two real, pre-existing failures … `job-control-module-load-sentinel.mjs` …
    `ReferenceError: normalized` … `redact-sensitive.ts` … capped at 8192 chars." — commits
    `bd7122e51` ("repair two pre-existing failures the verify timeout was masking") + `22a893f59`
    ("cap oversized strings BEFORE the object-depth cutoff"). Correct.
14. **[CC / correctly-labelled history]** The diagnostic table (six 60-min cap-outs) and the
    "accept that Sprints 1-3 land with the required check red" paragraph. — Explicitly kept "for
    the audit trail" under a "RESOLVED" heading, framed by "its 'do not raise timeout-minutes'
    instruction still holds and was honoured". Historical, not live guidance (Do-NOT-change #2).

### §2.1–2.5 (process), §3 (sequence)

15. **[CC]** Boot block `git reset --hard origin/docs/replatform-program` + the five register
    scripts — all five (`check-ticket-graph-coverage`, `check-finding-ownership`,
    `check-guard-inventory`, `check-gate-clause-wiring`, `check-execution-census`) exist in
    `scripts/`. Correct.
16. **[CC]** §3 ASCII sequence rows (S1 WRK-010 … S9 REL). Sprint labels/epic tags match the §3.1
    ship rows and the ticket files under `epics/*/tickets/`.

### §3.1 per-sprint ship table

17. **[CC]** Sprint 1 "SHIPPED `c1c5530f5`" — `git show c1c5530f5` = "WRK-010: adversarial-review
    fixes". On-branch.
18. **[CC]** Sprint 2 "SHIPPED `176eb5f8e … 6b2c27fb9`" — both on-branch (`176eb5f8e` "DEP-010:
    name the authoritative provider port; resolve E6-F008/E6-F004, narrow E6-F003"; `6b2c27fb9`
    "DEP-010: adversarial-review fixes").
19. **[CC]** Sprint 3 "SHIPPED `a62b8e06a …`" — on-branch ("WRK-008 slice 2b Step 0: scoping gate").
20. **[CC]** Sprint 2.5 "SHIPPED `16c7dc705 …`" — on-branch ("WRK-010 slice 2: SessionStore
    near-expiry threshold + renew(current)/bootstrap split").
21. **[CC]** Sprint 2.75 "SHIPPED `5c10a0f32 …`" — on-branch ("WRK-011 Step 0"). `E4-F010` =
    `resolved` in `epics/E4-worker-daemon/findings.md`.
22. **[CC]** Sprint 4 "SHIPPED (slice 5; slice 7 DEFERRED) `bc288f004 …`" — on-branch ("DAT-008
    slices 5+7: designs"). `E5-5-redaction` = `wired` in `gate-clause-wiring.json` (symbol
    `synthesiseRunSecrets`). Correct.
23. **[CC]** Sprint 5 "STEP 1 GREEN … `E4-1`/`E4-2` PROMOTED to `wired` … E7-1 still `unwired`
    … Leg B Part 2 LANDED (Sprint 5b, `36114ca50`)." — `gate-clause-wiring.json` E4-1/E4-2 `wired`,
    E7-1 `unwired`; `36114ca50` on-branch ("Leg B Part 2 — worker redeems a real credential over a
    LIVE fence"). Correct.
24. **[CC]** Sprint 5a "SHIPPED — E7-F001 RESOLVED" — `E7-F001` = `**Status:** resolved` in
    `epics/E7-coding-e2b/findings.md`, `Owner: CLI-007`; absent from `finding-ownership.json`.
    Correct.
25. **[CC]** Sprint 5b "CAMPAIGN HARNESS + RUNBOOK READY; … E7-1 stays `unwired`." —
    `gate-clause-wiring.json` E7-1 `unwired`; `f894eee17` ("Sprint 5b: campaign result") on-branch.
    Correct.
26. **[CC]** Sprint 6 (MIG-009) "SHIPPED `65bbb8a3b …`; `E10-1-drain` … stays `unwired` (count 0)
    … `ci-required` green (§2.0 RESOLVED)." — `65bbb8a3b` on-branch; `gate-clause-wiring.json`
    `E10-1-drain` = `unwired`. This is the one §3.1 row whose CI note was already updated to
    "green"; correct.
27. **[CC]** Sprint 7 unit-1 (BRW-hostspawn-gate) "SHIPPED `eed9fdd35 …`" — `eed9fdd35` (design) +
    `c0297480f` (feat) on-branch; `pr.yml` `policy` has the "Browser-spawn boot-root guard
    (BRW-hostspawn-gate)" step running `check-boot-roots-browser-spawn-free.mjs`. Correct.
28. **[CC]** Sprint 9 unit-1 (REL-FOUNDATION-GATE) "SHIPPED `e8e1975a5 …`" — on-branch;
    `docs/architecture/distributed-execution-release-tests.json` manifest exists. Correct.
29. **[CC]** Sprint 9 unit-2 (REL-003) "VERIFICATION CORE + RUNBOOK SHIPPED; live rehearsal OWED
    `1519b650c …`" — `1519b650c` (design) + `dab65f289` (result) on-branch; `E11-F002` = `owned`
    by REL-003 with `successor: DBR-001` in `finding-ownership.json`. Correct.
30. **[CC]** Sprint 9 unit-3 (foundation-suite-unrun) "SHIPPED … through a `ready_for_review`
    proving PR … the suite is 182/182 green under LF." — `pr.yml` `policy` runs
    `node --test …foundation.test.mjs`; `630e7e9d5` (eol=lf pin) + `0a093e6ae` (ci wiring) +
    `c208acfd7` (result) on-branch. Correct.
31. **[CC]** E4-F013 row "SHIPPED — five-arm chain … DBR-001 stub." — `5996eb6dc` on-branch;
    `finding-ownership.json` E11-F002 has `successor: "DBR-001"`; E4-F013 absent (resolved).
    Correct.

### §4 the sprints (prose + the sequence-at-a-glance table)

32. **[CC]** §4 status table (Sprints 1–9: SHIPPED / PARTIAL / BLOCKED). Every row matches the
    register + findings: S6 "MIG-009 ✅, sinks BLOCKED (E10-F001)"; S7 "BRW-hostspawn-gate ✅,
    features Lane B"; S8 "SVC-001 only, SVC-002.. need service-dispatch enable, E9 guard premature";
    S9 "units 1/2/3 ✅, REL-001/002/005 BLOCKED". All corroborated above.
33. **[CC]** Sprint 6 prose "MIG-005/6/7 are shadow observers … cutover not buildable today
    (E10-F001) … five parity bridges, not three — `jobAuditBridge` also zero-caller." —
    `gate-clause-wiring.json` shows `jobApprovalBridge`/`jobBudgetCostBridge`/`jobOutputBridge`
    (+ `createExecutionTargetRevocationFanout`) all `unwired`; E10-F001 reason corroborates.
    Correct. (`jobAuditBridge` is the un-clause'd fifth per the go-book's own note — consistent.)
34. **[CC]** Sprint 7 prose "`cli-mode.ts` spawns `npx @playwright/mcp` … the guard that 'did not
    exist' now exists and is wired: `check-boot-roots-browser-spawn-free.mjs`." — the guard + its
    `policy` step exist (see #27). Correct.
35. **[CC]** Sprint 8 prose "service dispatch is not reachable at all yet — the daemon is
    batch-only … E9 has no gate-clause entry." — `SUPERVISABLE_WORKLOAD_CAPABILITIES =
    ["workload.batch"]` (#8); `gate-clause-wiring.json` has no `E9-*` clause. Correct.

### §5 known debt

36. **[CC]** "Retired 2026-08-27: the `verify` 60-min timeout drag (§2.0)." + "Retired 2026-08-27
    (S9-3): foundation checker's own suite unrun." + "Retired 2026-08-27 (E4-F013)." — all three
    retirements corroborated by the commits/wiring above. Correct.
37. **[CC]** "dependency-graph regex `[A-Z]{3,4}` cannot match `TRACK`" and "6 ticket families
    invisible to the coverage checker (… `REL-FOUNDATION-GATE`, `BRW-hostspawn-gate` graph-inert by
    design)." — standing debt, consistent with the graph-inert slugs shipped in §3.1. Correct.
38. **[SF · low]** Row "Security guards with no falsifiable test … All protect the DORMANT path —
    **fix before Sprint 3, not after.**" Sprint 3 has SHIPPED; the substantive gate is *before
    live dispatch* (E7-1 / a real distributed run), which has NOT happened, so the debt is still
    validly open — only the milestone name is stale.
    `OLD: fix before Sprint 3, not after.`
    `NEW: fix before live dispatch (E7-1 / a real distributed run), not after — the path is still dormant.`
    EVIDENCE: `gate-clause-wiring.json` `E7-1-coding-journey` = `unwired`; dispatch flag
    default-off (Sprint 3/6 shipped without wiring it live).
39. **[SF · low]** Row "brand-check guard 9 … Three new operator-facing switches **arrive** in
    Sprints 2 and 3 …" — Sprints 2 and 3 shipped; present/future tense is now past. The standing
    fix (extend guard 9 to the `ENV`-map convention) is still valid and `pr.yml` guard 9 still
    matches only literal `process.env.AOA_[A-Z_]+` (confirmed in the brand-check step). Suggest
    re-tensing to past ("arrived in Sprints 2 and 3; two were documented by author discipline, one
    was not"). Low stakes.
40. **[SF · low]** Row "`check-execution-census` … **Sprint 3 adds two.**" — past now (Sprint 3
    shipped). Re-tense to "Sprint 3 added two." Low stakes; the guard behaviour described is still
    accurate.

### §6 registers, §8 decisions

41. **[CC]** §6 "Four guards, all in the always-on `policy` job." — `pr.yml` `policy` runs
    gate-clause-wiring, finding-ownership, ticket-graph-coverage, guard-inventory and
    execution-census (each paired CLI + `node --test`). Correct. The finding-ownership row's
    "since E4-F013 landed … a SHIPPED owner must name a real … successor" matches `5996eb6dc`.
42. **[CC]** §8 D-1..D-5 decisions ledger + the "★ CORRECTION / FOLLOW-ON" notes tracing
    E4-F010 unowned→owned(WRK-011)→resolved. Corroborated by `finding-ownership.json` (E4-F010
    absent = resolved) and `epics/E4-worker-daemon/findings.md` (E4-F010 `resolved`). Correct.

---

## Do NOT change (looks stale, is actually correct) + UNVERIFIABLE (human decision)

1. **§3.1 rows "`verify` inherits the pre-Sprint-N red (§2.0)"** (Sprints 1, 2, 2.5, 2.75, 3, 4).
   These are a **labelled historical record** of each sprint's ship-time CI state, and the
   top-of-file banner explicitly says so ("… as an accurate record of each sprint's ship-time
   state; that condition is now retired"). Leave them. Do not "correct" them to green — that would
   falsify the record.
2. **§2.0 diagnostic block** (the six-row cap-out table + "accept that Sprints 1-3 land with the
   required check red" + the bisect instructions). Explicitly "kept for the audit trail" under a
   heading that reads "RESOLVED 2026-08-27". Historical, not live guidance. Leave it.
3. **The word "red" throughout §1's engine-not-connected framing** — correct in the production
   sense (dispatch is default-off; no real-E2B distributed run has occurred; E7-1 `unwired`). §1.5
   supplies the nuance. Not a CI-status claim.
4. **E4-F015 still `**Status:** open` / `unowned`** while §1.5 calls the guard "OBVIATED." This is
   NOT a contradiction to fix: the go-book statement is a *scoping* call (don't build the guard —
   `tsc` already pins the union, verified at `compose-dispatch.ts` `DISPATCH_REFUSAL_MESSAGES`),
   and a MED finding that no product ticket naturally owns is *allowed* to sit `unowned` with a
   reason. Do not flip the finding to "resolved" on the strength of the go-book prose alone; that
   is a separate finding-lifecycle decision for the human.
5. **§1 pre-Sprint-1 census numbers** ("17 unprovable (no caller)", "no agent has ever run on a
   distributed worker"). Numerically superseded by §1.5 (five clauses now `wired`), but the
   paragraph is explicitly the "pre-Sprint-1 census" and §1.5 reconciles it in place. Leave the
   census as the labelled snapshot; do not retro-edit historical counts.
6. **[UV] External CI run-ids** — `33037143412` (PR #327 verify) and `32995765059` (the keyed
   real-E2B provider lane). These are GitHub Actions run identifiers, not resolvable from the git
   repo. The *code* they attest to is all present on-branch (verify matrix; keyed-lane cite in
   `CLI-006-D2-step1-result.md`). No edit; treat as external evidence taken on trust.
7. **[UV] The owed live-infra runs** — E7-1 staging-canary campaign (measured real-E2B distributed
   journey) and the REL-003 DR staging rehearsal (measured RPO/RTO). The go-book states these as
   OWED / not-yet-run, which is the honest state; there is nothing in the repo that could either
   confirm or refute a run that has not happened. No edit — the doc is correctly honest here.

---

## One-line bottom line

The go-book is substantially truthful and already reconciled for the CI-green fix everywhere a
careful reader lands first. The only genuinely actionable stale text is **C-1/C-2** — two §9
prompts that still tell a session "`verify` is red, don't raise the timeout to make it green" —
plus **C-3**, the verify-parallelization prompt that reads as pending though it shipped as PR #327.
Apply the three OLD/NEW edits above and the doc is clean. No WRONG (never-true) claims were found.
