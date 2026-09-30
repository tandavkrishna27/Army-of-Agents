# Round-2 completeness critic — verbatim

> This is the critic agent's report as returned, unedited. It is kept verbatim because its value
> is in the specific mechanical links it traces, and a summary of it would lose exactly the detail
> that makes it checkable. The summary lives in
> `2026-08-25-round-2-cross-plan-review.md`; this is the evidence.
>
> Its instruction was: *do not re-review the plans line by line — ask what is missing across the
> set.* Paths appear as absolute `C:\e3\...` because that is the worktree it read.

---

## Verdict

The set is **not coherent**. Three of the defects are cross-plan and none of them is visible from inside a single plan. One of them makes Sprint 3's plan red on arrival; one leaves the whole point of Sprint 1 with zero callers after all three sprints ship. The two seams themselves are *shape-correct* — that part is genuinely good and I say why at the end.

---

## 1. Sprint 2 falsifies a Sprint 3 guard and a Sprint 3 acceptance case, on arrival

This is the expensive one, and it is mechanical.

`C:\e3\docs\replatform\epics\E6-deployment-test-harness\tickets\DEP-010-design.md` Step 3 and §5 add `provider: deps.provider` to the `bootstrap({...})` call in `C:\e3\packages\worker-keystore\src\bin\desktop-host.ts` (today that call site passes `env`, `proc`, `identityStore`, `receiptStore`, `logFilePath` and **no `provider` key at all** — verified at tip).

`C:\e3\docs\replatform\epics\E4-worker-daemon\tickets\WRK-008-slice-2b-design.md` then:

- Step 8b asserts **`"provider" in call === false`** on that same call. After Sprint 2 the key is present (value `undefined`), so `in` is `true`. The assertion fails.
- Step 9b ships `scripts/check-boot-roots-provider-free.mjs`, which "fails if any of them passes a `provider` key". After Sprint 2 `desktop-host.ts` does. This guard goes into the **always-on `policy` job** (`C:\e3\.github\workflows\pr.yml:124-126`), so it is red on every PR including docs-only ones.
- §5 states, as a fact of the tree: *"Deliberately NOT modified: `packages/worker-keystore/src/bin/desktop-host.ts`. It passes no `provider` today and this slice does not add one."* Sprint 2 adds one. 2b's §2 gate table also still says the desktop's gate 1 is "**no** — E4-D01 makes it unconstructable here", which stops being true the moment DEP-010 lands the resolver.

2b was written against the pre-DEP-010 tree and the go-book runs it after. The fix is small but must be made **before Sprint 3 starts, not discovered in it**: 9b's declared property has to become *"no boot root constructs a provider unconditionally; the shipped default resolves to `{kind:"none"}`"*, and 8b's case becomes `call.provider === undefined` under an explicitly-built env with `AOA_WORKER_SANDBOX_PROVIDER` removed. Note that reformulation is strictly weaker than what 2b promised, which is itself the honest content of E4-F011 — see §4.

## 2. WRK-010 slice 2 is unscheduled, and Sprint 3 wires the wrong `renew`

`grep` for "WRK-010 slice 2" returns **three lines, all inside `WRK-010-design.md` itself** (`:7`, `:801`, `:802`). There is no node in `C:\e3\docs\replatform\program-design.md`, no ticket file in `C:\e3\docs\replatform\epics\E4-worker-daemon\tickets\`, and no mention anywhere in `C:\e3\docs\replatform\GO-BOOK.md`. Sprint 1 is server-side only by its own §9.

Meanwhile 2b §4 wires the seam to a different function:

```
renew: () => enroller.renew({hello, code, idempotencyKey}).session
```

`Enroller.renew` is the **enrollment replay** (`C:\e3\packages\worker-daemon\src\enrollment\enroll.ts:119`), whose module header at `:4-17` says in as many words that *"there is NO dedicated renew route/audience"* and that the replay *"only succeeds while the code route is live"* (`CODE_TTL_MS` = 10 min).

So after Sprints 1, 2 and 3 all ship exactly as written: the device-proof renewal route exists on the server with **zero callers**, and the composed daemon still loses authority at the ten-minute code-route boundary. The go-book's Sprint 3 gate — *"Gate to start: Sprints 1 and 2 green. Without WRK-010 a composed worker dies at T0+15min"* — reads as if Sprint 1 removes that ceiling. It does not; Sprint 1 plus an unwritten slice 2 does.

Compounding it: WRK-010 Step 7 flips **E4-F007 to `resolved`**. The finding's own statement of the defect ("a wired worker goes authority-less at T0+15min") remains true of every worker after Sprint 3. Closing it there converts a live problem into a settled one — the exact failure `scripts/lib/finding-ownership.mjs:23-25` says a false ownership claim causes.

**Minimum fix:** create the WRK-010 slice-2 node and ticket file now, and sequence it as Sprint 3's step 1 (before the composition), or state in the go-book that Sprint 3 ships with the code-replay renew and E4-F007 stays open until slice 2.

## 3. Inside that seam there IS a real incompatibility, and nobody owns it

Even if slice 2 were scheduled, the store 2b composes cannot drive the route WRK-010 builds.

`SessionStore.ensureFresh` (`C:\e3\packages\worker-daemon\src\identity\session.ts:103-107`) returns the current session while `now() < expiresAtMs` and calls `forceRefresh()` **only once it is absent or already expired** — its own docblock says "This is NOT a near-expiry renewal scheduler".

WRK-010 §0(b) establishes the opposite requirement: renewal is **rolling** — the shipped authenticator calls `verifyWorkerSessionToken`, which fails `claims.exp <= nowSeconds` at `C:\e3\server\src\middleware\worker-session-auth.ts:100`. A renewal presented by an expired session is refused, always.

So a `renew` thunk pointed at the WRK-010 route from the store 2b composes fires exactly when the credential it must present is already dead. WRK-010 R2 names this ("`SessionStore.ensureFresh` currently refreshes only when **already** expired — that needs a near-expiry threshold") and assigns it to slice 2. 2b Step 2 composes `SessionStore` unchanged and never mentions it. Same for WRK-010's **≥5-minute headroom invariant** (§3.5(i), §9, R7), which is unenforceable from a store that only fires post-expiry — and whose absence opens the ~4.9-minute proof-replay window WRK-010 §3.5(i) computes.

This is a genuine signature-level seam defect: one plan's product requires a live credential, the other plan's consumer only asks for one after the credential dies.

## 4. E4-F011 is owned by a plan that never mentions it

`C:\e3\scripts\finding-ownership.json` declares E4-F011 (HIGH) `owned` by **DEP-010**, with `ownerStillOpen` reading *"it closes when DEP-010 ships with a guard proving the shipped desktop default constructs no provider."* The go-book §4 Sprint 2 repeats the demand: *"the shipped desktop default constructs no provider at all, and a guard asserts it. Prove that, not merely that the flag is off."*

`grep -n "F011" DEP-010-design.md` returns **zero hits**. DEP-010's §2 "Findings disposition — all three, explicitly" covers E6-F008/F004/F003 only, and its §5 Files table touches `epics/E6-deployment-test-harness/findings.md` — while E4-F011 lives at `C:\e3\docs\replatform\epics\E4-worker-daemon\findings.md:220`.

Substantively DEP-010 *does* satisfy the conditions (Step 4's lock, Step 6's "the loader is never called", Step 7's control/reset cases, Step 10's static invariant). What it does not do is the thing the finding actually asks for: **state in writing which root(s) get a provider and what the flag defaults to there**, and close the entry. So E4-F011 survives Sprint 2 as an open HIGH owned by a shipped ticket, carrying an `ownerStillOpen` string that has gone false — and `lib/finding-ownership.mjs:118` only checks that string is non-empty, so nothing fails.

**E4-F008 has the identical shape one epic over.** The register says it is owned by WRK-008 because *"a rotated provider-constraint digest going stale on a long-lived worker must be reconciled against in-flight leases when 2b composes the loop."* `WRK-008-slice-2b-design.md` never mentions E4-F008 — not in §9's findings table (F009/F010/F011 only), not in §11's out-of-scope list. It ships, gets a result doc, and the finding rots in place.

**And E4-F010 (HIGH) is unowned** — `node scripts/check-finding-ownership.mjs` at tip prints `UNOWNED, on the record: E4-F010`. Which makes **GO-BOOK.md §8's closing sentence factually wrong**: *"the register reports **zero unowned findings** for the first time in the programme."* It reports one, it is HIGH, and it is the one the go-book itself says Sprint 5 cannot pass without. That is an error in the document that sequences the work, in the paragraph headed "do not relitigate".

## 5. Acceptance arithmetic

**What becomes true if all three ship as written.** A worker that already holds a live session can trade it plus a device proof for a fresh 15-minute one, on a route that never touches the enrollment-code table, refusing revoked/disabled/stale-generation/platform-physical callers, absent when distributed execution is off — proven against embedded PostgreSQL, and called by nothing. Exactly one file in the tree may construct a sandbox provider, one composition root can inject one behind an env opt-in, and the daemon still cannot import one. And the daemon finally composes a real poll loop, supervisor, lease-renewal driver and durable event outbox, giving `createPollLoop`, `createSupervisor` and `createEventOutboxDrain` their first production callers in the programme's history — behind a flag that is still default-off.

**What a reader wrongly concludes.** That a worker can now take a job. It cannot. Three clauses across the set read as "distributed execution works" while remaining vacuous:

- **go-book Sprint 3 "Done when: with a provider injected **and** the flag on, a worker leases, executes, and reports."** This is unachievable by the plan that runs Sprint 3, and 2b says so itself: §1.1(c) and E4-F010 establish that `poll-loop.ts:538` self-checks each offer against the worker's own hello, and the only production hello builder (`packages/worker-daemon/src/enrollment/desktop-hello.ts`) emits `sandbox.*` capabilities with a 64-zero `policyHash`, so `offerSatisfiesWorker` is `false` for **100% of offers** — independently of the server-side `workers.profile_snapshot` gap. 2b's own acceptance row 12 downgrades E4 clause 1 to *"Reachability only"*. The go-book's headline for the sprint and the sprint's own plan disagree about whether a job can run.
- **`E4-1-leases-through-protocol` promoted to `wired`.** 2b Step 10 mitigates by "the nuance goes in the reason fields, not hidden". It is hidden: `evaluateGateClauseWiring` (`C:\e3\scripts\lib\gate-clause-wiring.mjs:81-88`) validates a `wired` entry by `count > 0` **only** — it neither requires nor reads a `reason` — and the green run prints reasons for the DORMANT list alone (`C:\e3\scripts\check-gate-clause-wiring.mjs:130-136`). After Sprint 3 the register asserts a leasing capability that cannot lease, with the caveat in a field no code path reads. That is the aggregation failure the register was built to prevent, re-committed one level down.
- **WRK-010's plan-node acceptance** (`program-design.md:636`): *"A worker with a valid device proof obtains a fresh session with no enrollment code and no human step."* Satisfied by an integration test playing the worker. Same shape as the 17 zero-caller clauses the audit found.

**Order, answered directly.** Nothing in Sprint 2 needs Sprint 3 first. But note that DEP-010's *primary* inertness proof — §4.1's structural lock, "nothing consumes `compose === true`, `bin/worker-daemon.ts:347-349` has no `else`" — is true **only until Sprint 3**, and DEP-010 says so ("this is the load-bearing one — it is the mutation slice 2b will make for real"). Sprint 2's headline acceptance is provable exactly once and then expires, and nothing in the set replaces it. After Sprint 3, the shipped desktop's inertness rests on four **environment variables** (`AOA_WORKER_SANDBOX_PROVIDER`, `AOA_WORKER_DISPATCH_ENABLED`, `AOA_WORKER_EVENT_OUTBOX_PATH`, plus a live session) and **zero structural gates**. E4-F011's "two gates" becomes "no gates". Someone should write that sentence down before Sprint 2, not after Sprint 3.

Unlisted-but-required work Sprint 3 inherits from Sprint 2: DEP-010 Step 2 makes `decideDispatchComposition`, `DISPATCH_REFUSAL_MESSAGES` and the input/refusal types a **public export** of `packages/worker-daemon`. 2b Step 4 retires `no_self_model_reader` from `DispatchRefusalReason` and Step 7 replaces `hasSelfModelReader` with `hasWorkerIdentity`, adds `hasEventOutboxPath` and swaps `selfModel` for `selfModelRead` (verified against `C:\e3\packages\worker-daemon\src\lifecycle\compose-dispatch.ts:22-49`). So Sprint 3 breaks Sprint 2's published surface and must edit or delete `public-surface-dispatch.test.ts` and DEP-010's Step 8 "reports `no_self_model_reader`" case. 2b §5 lists neither, and §5 presents itself as exhaustive.

## 6. Registers through the full sequence

One hard red, one misaimed guard, one silent docs gap.

**Hard red (Sprint 3, always-on job).** 2b Step 9 adds `scripts/lib/__tests__/d1-dispatch-declared.test.mjs` and `scripts/lib/__tests__/boot-roots-provider-free.test.mjs` — two new `*.test.mjs`. `C:\e3\scripts\check-execution-census.mjs:3-8` *"FAILS when a `*.test.mjs` file exists on disk with no entry in the census manifest"*, and it runs in `policy` at `pr.yml:324`. 2b's Step 11 checker list and §5 file list name neither `scripts/test-execution-census.json` nor the census checker. The irony is that **DEP-010 clocked this exact hazard — for itself**: §0.1's last row says *"this ticket adds no new `.mjs` test file, only cases. If that ever changes, `scripts/test-execution-census.json` needs a new entry."* The note is correct and it is in the wrong plan. (2b's `scripts` test-inventory bump 46→48 is covered by its `--write`.)

**Misaimed guard.** 2b Step 9a's headline argument is that a checker parsing only `AOA_WORKER_DISPATCH_ENABLED` *"would have stayed green straight through the event it exists to catch"*, so its declaration must cover four gates including `providerUrl: "http://fake-provider:8080"`. But DEP-010's resolver (Step 6) reads `AOA_WORKER_SANDBOX_PROVIDER` and `AOA_WORKER_E2B_TEMPLATE` and **never reads `AOA_WORKER_PROVIDER_URL`** — a full-tree grep finds that name only at `C:\e3\docker-compose.d1.yml:304` and `:343` plus 2b's own prose. So after Sprint 2 the real D1 provider gate is a variable 9a does not declare, and 9a repeats the mistake it was written to avoid. DEP-010's Step 10 invariant does cover `AOA_WORKER_SANDBOX_PROVIDER` but only against `docker-compose.staging.yml`; D1 is a separate file with a separate guard. 9a's declaration has to be authored **after** Sprint 2 fixes the variable's name.

**Silent docs gap, cumulative.** brand-check guard 9 (`pr.yml:650-663`) matches only literal `process.env.AOA_[A-Z_]+`, and `C:\e3\packages\worker-daemon\src\config\config.ts:63-79` reads through the `ENV` map, so 2b's new `AOA_WORKER_EVENT_OUTBOX_PATH` will be undocumented with **no guard firing** — and 2b's §5 does not list `docs/deploy/environment-variables.md`. DEP-010 §8.6 identifies precisely this hole for its own two switches and adds the rows by hand. Across the set that is three new operator-facing switches, two documented by discipline and one not at all. Neither plan proposes closing the hole (e.g. extending guard 9 to the `ENV`-map convention), which is the standing fix.

## 7. What is genuinely coherent, and why I am confident

Both handoffs are **shape-correct**, and I checked them against the code rather than against the prose.

The Sprint 1 → Sprint 3 seam is a single symbol in a single package: `SessionStoreDeps.renew`, declared `readonly renew: () => Promise<WorkerSession>` at `C:\e3\packages\worker-daemon\src\identity\session.ts:52-55`. WRK-010 §9 names exactly that field as slice 2's target; 2b Step 2 injects exactly one thunk into it and asserts "the WRK-010 seam is ONE injected thunk — swapping it changes nothing else". Same name, same package, same zero-argument signature, same return type. Both plans also independently caught and corrected the same false fact — that `IdentityLifecycle.acquireSession()` was the seam — which is a good sign the two authors read the same disk. Every defect in §2 and §3 is scheduling and lifecycle, not signature.

The Sprint 2 → Sprint 3 seam is likewise exact: DEP-010 D1 names `SandboxProvider` at `C:\e3\packages\worker-daemon\src\supervisor\provider.ts:330` as the one authoritative port, `E2bSandboxProvider` already implements it, and 2b consumes `SupervisorDeps.provider` typed to that same port through the already-present `BootstrapDeps.provider` seam. No adapter is needed on the path Sprint 3 uses, the direction (`per-op → driver`, harness only) is stated once and not reversed, and the dependency arrow `worker-keystore → sandbox-e2b-provider → worker-daemon` stays a DAG. I also confirmed `check-gate-clause-wiring.mjs`'s `SOURCE_ROOTS` includes `packages`, so DEP-010's `expectedReferences` mechanic for `E7-1-coding-journey` will behave as it predicts (measured count today: `0  E2bSandboxProvider`), and Sprint 3 adds no references to that symbol, so the declaration survives the sequence untouched.

**Four edits I would make before Sprint 1 starts**, all cheap and all in docs: create the WRK-010 slice-2 node and ticket file and place it in the sequence; correct GO-BOOK §8's "zero unowned findings"; add to DEP-010 an explicit E4-F011 disposition and the `epics/E4-worker-daemon/findings.md` edit to close it; and add to WRK-008 slice 2b a "written against the pre-DEP-010 tree" preamble listing the four assertions Sprint 2 invalidates (8b's `"provider" in call`, 9b's declared property, §2's gate-1 desktop row, 9a's `providerUrl` gate) plus the census-manifest and env-doc bumps. None of that is implementation work; all of it is the difference between finding these in a session and finding them in CI.