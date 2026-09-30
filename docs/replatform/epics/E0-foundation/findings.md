# E0 Findings

New findings use IDs `E0-F001`, `E0-F002`, and so on, and retain their resolution history. A finding records severity, evidence, affected tickets, disposition, and whether it blocks the gate. Findings are never silently deleted; resolved findings retain the resolution link.

## E0-F001 — Ticket-result template vs Task-9 gate-regex format conflict (Start SHA / Disposition)

- **Status:** resolved
- **Severity:** Minor
- **Blocks gate:** No (resolved inline by conforming the ledger to the gate format; template fix tracked below).
- **Discovered during:** FND-001 independent review / controller gate-format pre-check.
- **Evidence:** The Task-9 integration-gate parser in [`../implementation-plan.md`](../implementation-plan.md) Step 1 requires (a) FND-001's Start SHA as a **bare** 40-hex — `^\*\*Start SHA:\*\*\s*([0-9a-f]{40})\s*$` (no surrounding backticks), and (b) each ticket's Disposition as **backtick-wrapped** — `^\*\*Disposition:\*\*\s*` + `` `approved` ``. But [`../../../templates/ticket-result-template.md`](../../../templates/ticket-result-template.md) line 8 renders the Start SHA example **backtick-wrapped** (`**Start SHA:** \`<...>\``). The FND-001 implementer faithfully followed the template (backtick-wrapped Start SHA), and the FND-001 reviewer wrote a bare `approved` Disposition — both would fail the Task-9 regex.
- **Affected tickets:** FND-001 (result ledger), FND-005 (owns `docs/replatform/templates`), all FND-00x result ledgers (format convention).
- **Disposition:** Resolved for FND-001 by editing `tickets/FND-001-result.md` to the gate-conformant format — **bare** Start SHA, **backtick-wrapped** `` `approved` `` Disposition, `` `complete` `` Status — with the review substance (reviewer identity, reviewed revision, approved disposition, attempt-1 row) unchanged. **Convention for all remaining tickets:** implementers write `**Start SHA:** <bare-40-hex>`; reviewers write `**Status:** ` + `` `complete` `` and `**Disposition:** ` + `` `approved` ``; Reviewed revision may be bare or backticked (the gate regex allows optional backticks). **Carry-forward:** FND-005 should correct `ticket-result-template.md` line 8 so its Start SHA example is bare, matching the gate parser. Until then, this convention is authoritative over the template's example.
- **Carry-forward closed (verified 2026-09-03):** `docs/replatform/templates/ticket-result-template.md:8`
  now reads `**Start SHA:** 0000000000000000000000000000000000000000` — bare, not
  backtick-wrapped — and lines 10-12 spell the requirement out in prose. The FND-005
  carry-forward this finding was held open for is done, so the `Status:` is `resolved`.

## E0-F002 — FND-001 shared-checker code-hygiene carry-forward (fold into FND-002)

- **Status:** open
- **Severity:** Minor
- **Blocks gate:** No.
- **Discovered during:** FND-001 code-quality review (disposition `approved`; items explicitly deferred to a later-ticket extension).
- **Evidence / items:** In `scripts/check-distributed-execution-foundation.mjs` at the FND-001 revision `490049551`:
  1. **Dead code on the spine** — the `__test` export (`.mjs:517-523`) is unused; its only purpose is to hold `fileURLToPath` (imported at `.mjs:40`), which nothing consumes. Prune both.
  2. **Defensive gap in forbidden-edge validation** (`.mjs:341`) — a present-but-malformed lifecycle (key exists, `states` missing) referenced by a forbidden edge throws a `TypeError` instead of pushing a clean error; still fails closed (exit 1 via `main`'s catch), but `runCheck(root)` throws for the `node:test` harness rather than returning a structured error. Guard it so it returns a clean error.
  3. **Unpinned mutation branches** in `scripts/check-distributed-execution-foundation.test.mjs` — reachability (unreachable state), non-terminal dead-end, forbidden self-lifecycle edge (`is not cross-lifecycle`), forbidden unknown-lifecycle/state, and reason-only guard drift have working checker logic but no mutation asserting them. Pin these as the corpus grows.
  4. **Prose not parity-checked** (optional future hardening) — the Markdown `Statuses:` enumerations and terminal-immutability prose are not cross-checked against JSON `states`/`terminal` (only the From/To transition tables are). Within the amendment's documented parity scope (edges + guard reasons), so not a defect; candidate hardening as later tickets grow the contract.
- **Affected tickets:** FND-002 (extends the same checker + `.test.mjs`).
- **Disposition:** **Resolved (items 1–3) in FND-002** commit `f5e45cf2b2a3ddf588307e2cba12ec2d183925f6` — dead `__test`/`fileURLToPath` pruned; the forbidden-edge validation now pushes a clean error (no `TypeError`) for a present-but-malformed lifecycle referenced by a forbidden edge; and the five previously-unpinned branches (unreachable state, non-terminal dead-end, forbidden self-lifecycle edge, forbidden unknown-lifecycle/state, reason-only guard drift) are pinned by mutations. Verified by FND-002 spec + code-quality review. **Item 4** (prose/`Statuses:` list not parity-checked) remains **open/optional** — candidate hardening for a later FND ticket as the contract grows.

## E0-F003 — Structural-checker negation/row-pinning hardening (carry into FND-003/FND-007)

- **Status:** open
- **Severity:** Minor
- **Blocks gate:** No.
- **Discovered during:** FND-002 code-quality review (disposition `approved`; both notes make the checker stronger than the plan's substring-only requirement, so neither violates the stated acceptance).
- **Items:**
  1. **Same-sentence negation smuggle** — `requireNegatedMention` (~`.mjs:521`) tests each sentence for *any* negation word, so an affirmative clause appended to a sentence that already carries a negation is missed (probe: `"No AoA database is a peer replica except the worker SQLite which is a peer replica."` passes). The *separate-sentence* affirmation the FND-002 mutation targets IS caught; this is only the same-sentence variant.
  2. **Added contradictory matrix row not rejected** — `validateAuthorityMatrix` (~`.mjs:559`) pins the 7 required rows but does not assert row *count*, so an *added* contradictory authority row passes (removed/drifted required rows ARE caught).
- **Affected tickets:** FND-003 (threat-controls JSON + Markdown parity — reuses negation/row-pinning-style validation), FND-007 (crosswalk CM-*/CP-* row pinning), and any later ticket extending the negation/matrix scans.
- **Disposition:** Item 2 is done. Item 1 is **partly** done, and the part that is not is described below rather than summarised, because two earlier revisions of this entry summarised it wrongly in the closing direction. The status stays `open` for that reason; the residual class is declared `accepted` in `scripts/finding-ownership.json`.
  - **What the checker now refuses.** In `scripts/check-distributed-execution-foundation.mjs`, at **both** scanned sites — `requireNegatedMention` over the authority doc's three needles (`peer replica`, `authoritative state`, `auto-applied`) and FND-007's CM-015 no-auto-bypass clause check — a needle-bearing sentence is split into clauses, and each clause carrying the needle must contain at least one negation word **per mention** of the needle. Two arms:
    - **Clause scoping** (`NEGATION_CLAUSE_SPLIT_RE` + `splitNegationClauses`). Boundaries are punctuation (`;` `,` `|` `.` and the dashes) plus the conjunctions that start a new assertion, **including `and`/`or`/`while`/`so`/`yet`**. Degenerate case (the needle straddles a boundary) falls back to the sentence.
    - **A per-mention negation budget** (`negationDeficit`), vocabulary-free. A boundary list is an enumeration and is always one word short; these invariants are needle-scoped, so a smuggled affirmative has to name the needle again, and one negation is then made to cover only one mention.
    - The two arms are **complementary and neither subsumes the other**, measured: an unlisted joiner (`plus`, `then`, `also`, `whereupon`, or a bare space) is rejected only by the budget; a smuggle that meets its budget (`"No AoA database is a peer replica and it is not authoritative and the worker SQLite is a peer replica"`) is rejected only by the split. Each arm has its own mutation at each site.
  - **★ What the scan does not see.** Both arms count negation **tokens** inside a scope. Neither binds a negation to the mention it has to negate. An appended affirmative clause that carries any word from the negation vocabulary therefore meets its own budget and raises no error — and it raises none **whatever the joiner, including the punctuation the pre-fix splitter already split on**, so **widening the JOINER list does not reach this class** - measured across every probe in the table below, the smuggle passes the budget arm whatever the joiner. Whether some OTHER widening reaches it was not measured, and this sentence does not claim it cannot. Measured against the shipped checker:

    | appended clause | joiner | shipped checker | pre-fix checker (`da1a90597`) |
    |---|---|---|---|
    | `the worker SQLite is a peer replica` | `whereupon` | error | no error |
    | `the worker SQLite is a peer replica` | `and` | error | no error |
    | `the worker SQLite is a peer replica that no operator may disable` | `whereupon` | **no error** | no error |
    | ...same | `and` | **no error** | no error |
    | ...same | `, ` | **no error** | no error |
    | `the worker SQLite is a peer replica which cannot be turned off` | `; ` | **no error** | no error |
    | CM-015: `the operator override auto-bypasses the gate without delay` | `whereupon` | **no error** | no error |

    This is an uncovered class, not a regression: all seven probes raised no error before the change, and two of them raise one now. It is an instance of item 1's own words — an affirmative clause appended to a sentence that already carries a negation, missed. It is held by the two `E0-F003 item 1 KNOWN LIMIT` cases in `check-distributed-execution-foundation.test.mjs`, which assert the miss so that the limit cannot drift into an assumed closure; a positive control (drop the smuggle's own negation token) turns them red, so they are not vacuous.
  - **Why it is not chased.** The rule that would reach it — require each mention to be *preceded* by an unconsumed negation within its scope — rejects correct English of the form `"A peer replica is never created by any AoA database"`, where the negation legitimately follows the mention. Zero false positives on this corpus would be weak evidence for such a rule: **the two documents contain four needle-bearing sentences in total, one per scanned invariant.** An honest uncovered class is preferred to a guard that rejects correct prose.
  - **The same measurement bounds the widening that WAS done.** The `and`/`or`/`while`/`so`/`yet` boundary set produces zero errors on the unmodified corpus — over those same four sentences. That is evidence the exclusion bought no precision *here*; it is not evidence that splitting on `and` is safe for English generally.
  - **Correction — the first fix covered only the `except` instance, and its stated rationale was false.** The revision at `86db5238d` excluded `and`/`or`/`while` from the boundary set with the comment that splitting there "would reject correct prose". Changing one word of the finding's own probe from `except` to `and` re-opened the smuggle **at both scanned invariants**, including on a real corpus sentence (`"Expired or replaced attempts cannot update authoritative state and a replayed attempt may update authoritative state."`). A rationale asserted rather than measured is worse than an unexplained gap: it tells the next reader the hole was considered. The comment defending it is replaced by the measurement and by the size of the measurement.
  - **Item 2 —** `validateAuthorityMatrix` rejects malformed, **duplicate** and **unknown** rows before comparing the expected set. The measured mechanism was wider than the finding stated: the state-keyed `Map` plus an expected-rows-only loop meant an added row was never *read*, **and** a duplicate state was laundered by last-write-wins, so row **order** alone decided whether a contradiction was visible.
  - **No separate row-COUNT clause**, against the finding's literal wording: with unknown rows rejected, duplicates rejected, and every expected row required, the count is *entailed* — a count assertion could never fire on its own, and an unfalsifiable clause is the "check that nothing runs" failure class rather than defence in depth. The exact-set property the item asked for is asserted; only the redundant restatement of it is not.
  - **A THIRD site, found by measuring rather than by reading.** This finding's *Affected tickets* line names "any later ticket extending the negation/matrix scans", and FND-007's CM-015 no-auto-bypass invariant — the one place the pattern *was* applied — carried the same blind spot: its private `crosswalkClauses` splitter was punctuation-only, so a contrastive carve-out with no punctuation stayed inside the negated clause and rode the `never`. Measured at `da1a90597`: the mutated crosswalk produced **zero** checker errors. `crosswalkClauses` had exactly one caller and is deleted; both sites now share `splitNegationClauses`. Two splitters where one is weaker is how this class returns.
  - **Mutation record.** 11 guard clauses, each first shown to pass the unfixed checker and then individually neutered and shown to turn its own test red and nothing else; all restored, restore md5-verified. Those 11 were measured at the preceding revision of this branch and are **not** re-run by the disclosure pass above; the checker's executable logic is byte-identical between the two (the later diff touches comments only), which is why the record still stands. Corpus 206/206.
- **Correction to the prior disposition and to the ownership register.** The sentence "FND-003 applied item-2 exact-set parity for its threat register" was true as written but was read as closing item 2; the `scripts/finding-ownership.json` entry restated it as "Item 2 ... WAS applied by FND-003's exact-set parity", which was **wrong** — and self-contradictory, since the same entry also said both named tickets "shipped without doing so". FND-003 and FND-007 applied the *patterns* to their **own new surfaces** (the DE-01...DE-30 register ID set; the CM-001...CM-015 / CP-001...CP-005 row sets and the CM-015 migration-0188 clause split) and their result docs say so in those words; **neither retrofitted `requireNegatedMention` or `validateAuthorityMatrix`.** Measured at `da1a90597`: mutations of both original sites produced **zero** checker errors. The named remediation window closed with the item undone, not declined. The 2026-08-08 E0 epic-completion handoff carries the same misreading ("applied by FND-003 ... and FND-007 ... count pin") and is left unedited as a frozen record; this register is the live authority.

## E0-F004 — Threat-controls parity fields not in required-field set (carry into FND-004)

- **Status:** resolved
- **Severity:** Minor
- **Blocks gate:** No.
- **Discovered during:** FND-003 code-quality review (disposition `approved`).
- **Evidence:** In `scripts/check-distributed-execution-foundation.mjs` at FND-003 revision `09651fb63`, the JSON crossing fields `threat`/`control`/`verification` are rendered into the Markdown register and value-compared in per-ID parity, but are NOT in `THREAT_CROSSING_REQUIRED_FIELDS`. Because each parity comparison is guarded by `typeof c.<field> === "string"`, **deleting** one of those fields from a JSON crossing yields zero errors (value-drift IS caught; only field-deletion escapes). All 30 crossings already carry these fields, so requiring them keeps the corpus green.
- **Affected tickets:** FND-004 (next to extend the checker), FND-007 (extends fixtures/parity).
- **Disposition:** **Resolved in FND-004** commit `3f10606a5` — `threat`/`control`/`verification` added to `THREAT_CROSSING_REQUIRED_FIELDS` with a field-deletion mutation; corpus stays green. The two smaller notes need no action.

## E0-F005 — FND-005 exclusions test: plan `createApp()` unit-import vs. codebase drizzle-ESM constraint (ratified deviation)

- **Status:** resolved
- **Severity:** Minor
- **Blocks gate:** No.
- **Discovered during:** FND-005 implementation (reported DONE_WITH_CONCERNS) + controller investigation.
- **Evidence:** Plan Task 5 Step 4 specifies `distributed-execution-exclusions.test.ts` proves the reserved `/api/distributed-execution/{public-services,cloud-plugins}` routes 404 "through the real `createApp()` path". But `CLAUDE.md` §Test Patterns documents a drizzle-orm `require(esm)` cycle: **no server unit test can import the real app** (they mock `@armyofagents/db`+`drizzle-orm`); only `*.integration.test.ts` with embedded Postgres import the real app (e.g. `plugin-broker-cloud.integration.test.ts`, Windows-skipped per Issue #114). The implementer's dynamic `import("../app.js")` fails under vitest on every lane, so the two 404 cases are `it.skipIf(!appModule)`-skipped (honestly, not faked), while the `loadConfig()`-throws-on-excluded-sentinel cases run.
- **Why non-blocking:** the reserved-route protection is actually provided by (a) the always-on **source-boundary checker** in `check-distributed-execution-foundation.mjs` (rejects any import of a reserved distributed public-ingress/cloud-plugin-runner module and any registration of the two reserved path prefixes — static, runs in the policy job), and (b) **`loadConfig()` hard-rejects** the excluded sentinels at startup. With no reserved-route code existing (source-boundary-enforced), an unregistered path returning 404 is trivially guaranteed; the runtime 404 proof is redundant.
- **Affected tickets:** FND-005 (this deviation); **FND-006/FND-008** — MUST use `*.integration.test.ts` (embedded PG, Windows-skip, Linux-CI-authoritative) for their real `createApp()`/startup-composition cloud-denial + self-hosted-positive proofs, per this same constraint and the crosswalk.
- **Disposition:** **Ratified by custodian.** Keep the unit test (loadConfig-throws runs; 404 skipped with the documented rationale). No embedded-PG integration test is warranted for a trivial unregistered-route 404. Recorded in FND-005-result.md Deviations.

## E0-F006 — FND-005 build reproducibility: digest-manifest pin vs. committed snapshot bytes (ratified deviation)

- **Status:** resolved
- **Severity:** Minor
- **Blocks gate:** No.
- **Discovered during:** FND-005 implementation (reported DONE_WITH_CONCERNS) + controller investigation.
- **Evidence:** Plan Task 5 Step 8 / hardening amendment say `pnpm build` must "consume only checked-in snapshots whose source URL/version/digest are recorded in a committed manifest." Investigation showed the two snapshot files (`ui/src/aoa-marketplace-snapshot.json`, `ui/src/aoa-connectors-snapshot.json`) were **already `.gitignore`d before FND-005** (`.gitignore:59-61`, "fetched at build time, not committed") and are **not statically imported** by any build (runtime-loaded fallbacks; UI fetches via `/api/marketplace/catalog`, server dynamic-imports at runtime) — so `pnpm -r build` does not consume them as compile inputs. Committing them would reverse a deliberate `.gitignore` decision and add ~1.5 MB of volatile third-party catalog data (with a changing `generatedAt`).
- **Resolution the implementer chose:** keep snapshots gitignored; commit a small `scripts/bundled-snapshots.manifest.json` pinning each snapshot's `file`/`sourceUrl`/`version`/`sha256`/`order`; `prebuild` runs `check-bundled-snapshot-inputs.mjs` (network-free; verifies manifest shape always + a present snapshot's digest); intentional refresh is the new explicit `pnpm refresh:bundled-snapshots`. Verified: `pnpm build` and `pnpm -r build` exit 0, do no CDN fetch, and leave tracked bytes byte-identical (`git status`/`git diff --check` clean). This is the D0-R02 "**split refresh from build**" option (explicitly sanctioned alongside "pin those inputs").
- **Deviation from the plan's literal Step-10 `git add` list:** one file beyond the list — `scripts/bundled-snapshots.manifest.json` — which Step 8's "committed manifest" requirement mandates but the Step-10 list omitted (a plan inconsistency). No `.gitignore` change; snapshot bytes not committed.
- **Affected tickets:** FND-005.
- **Disposition:** **Ratified by custodian.** Achieves the real reproducibility goal (network-free, tracked-byte-clean build) without reversing the pre-existing gitignore or bloating the repo, per D0-R02's split-refresh option. Recorded in FND-005-result.md Deviations.

## E0-F007 — FND-006 test-flip scope deviation + FND-008 carry-forwards (ratified)

- **Status:** open
- **Severity:** Minor
- **Blocks gate:** No.
- **Discovered during:** FND-006 implementation (DONE_WITH_CONCERNS) + spec + code-quality review (both approved; every flip corroborated source-correct).
- **Evidence / items** (FND-006 commit `f916457be`):
  1. **Extra-test-flip scope deviation (ratified):** reversing the pre-FND-006 (U10-era) "plugins allowed in cloud" behavior inverted the expectations of 4 test files beyond the plan's Step-5 `git add` list — `plugin-tenant-routes.test.ts`, `marketplace-install-plugin.test.ts`, `company-plugin-upgrade-rollback.test.ts`, `plugin-lifecycle-upgrade.test.ts` (plus `plugin-worker-manager.test.ts`, which the implementer brief explicitly authorized). All flips are **test-only** (no production code outside the plan's 5 source files: `cloud-plugin-execution.ts`/`plugin-worker-manager.ts`/`plugin-lifecycle.ts`/`app.ts`/`index.ts`), and each flip asserts the CORRECT Decision #103 blocked behavior derived from source (cloud reads project blocked `status="error"`+`PLUGIN_WORKER_BLOCKED_IN_CLOUD`+`CLOUD_PLUGIN_BLOCK_MESSAGE`; install/load throw `CloudPluginExecutionBlockedError`; rollback route 503-before-DB/authz). Ratified — necessary to keep the suite green after a required behavior reversal; mirrors the E0-F006 precedent.
  2. **Stale RW5a comments → FND-008 cleanup:** now-false "stays allowed on cloud"/"inert on cloud" comments remain at `plugin-lifecycle.ts:500-502`, `routes/plugins.ts:332-334`, `services/marketplace-install/plugin-installer.ts:95-101`, `routes/company-plugins.ts:327-330`. Code behavior is correct (centralized gate fires); only comments are stale. 3 of 4 files are outside FND-006's scope (correctly left untouched). **FND-008 re-touches `plugins.ts`/`company-plugins.ts`** — clean up the comments there.
  3. **Linux-CI-authoritative integration verification (open — before Task 9):** the real `createApp()`/startup composition proofs — `plugin-broker-cloud.integration.test.ts`, `cloud-plugin-process-composition.test.ts` (real-app portions), `plugin-tenant-routes.test.ts` — Windows-skip (embedded-PG / drizzle `require(esm)` cycle, E0-F005). The flips are source-derived + typecheck-clean but were NOT executed locally. **Controller must run these (and FND-008's equivalents + the full `pnpm test:run`/`pnpm -r typecheck` DEC-03 baseline) in a short-path detached worktree with embedded Postgres before the Task-9 gate**, since no Linux CI is being triggered (operator directive: run locally).
- **Affected tickets:** FND-006 (deviation), FND-008 (comment cleanup + shares the integration harness), Task 9 (integration + baseline run).
- **Disposition:** Items 1 ratified/closed; item 2 partially resolved in FND-008 (`plugins.ts`/`company-plugins.ts`/`plugin-loader.ts` cleaned; residuals in `plugin-lifecycle.ts`/`marketplace-install/plugin-installer.ts`/`plugin-ui-static.ts` remain, cosmetic/dead-on-cloud); item 3 (Linux-CI integration run) open → Task 9.

## E0-F008 — FND-008 marketplace-install 404 deviation + residual minors (ratified)

- **Status:** open
- **Severity:** Minor
- **Blocks gate:** No (marketplace-install is fail-closed; Decision #103 execution exclusion fully met).
- **Discovered during:** FND-008 implementation (DONE_WITH_CONCERNS) + spec + code-quality review (both approved).
- **Evidence / items** (FND-008 commit `0f04cc747`):
  1. **Marketplace INSTALL orchestrator returns 404, not a 503 stub (ratified acceptable-interim).** In `cloud_auth` the `createMarketplaceInstallRouter` stays UNMOUNTED (`app.ts:740`, off-cloud `if` only) → a request to that one endpoint gets a generic **404** instead of the documented 503 envelope. It is genuinely **fail-closed** (loader `undefined`, no package I/O/import/execution reachable); the PRIMARY install path `POST /plugins/install` DOES return the 503 stub (gate `plugins.ts:955` before `loader.installPlugin`); this is a valid CP-004 "reject before I/O" disposition (marketplace-install is a CP-004 install path, not a CP-003 tool/job/webhook surface); and no test bakes in the 404 as a permanent contract. The 503-stub for this one endpoint would require touching out-of-scope files — **deferred to 1.1**. Ratified non-blocking by custodian; spec + code review concur.
  2. **Residual stale RW5a comments** in `plugin-lifecycle.ts:500-502`, `marketplace-install/plugin-installer.ts:95-101`, `plugin-ui-static.ts:270-273` (all outside FND-008's `git add` set; code behavior correct; comments cosmetically stale in dead-on-cloud paths). Low priority.
  3. **Code-review Minors (non-blocking, safe):** (M1) `company-plugins.ts:470`/`plugins.ts` disable persists the `enabled=false` metadata write then returns 503 in the narrow pre-boot-reconciliation window where a row is still `status:"ready"` — outcome safe (disabled, never enabled/run), self-corrects at boot; (M2) enable + settings routes rely on the `blockActivationInCloud` facade-throw+catch rather than a pure entry gate — functionally correct (503, no effect leak), less uniform than the new uninstall/disable entry gates.
- **Affected tickets:** FND-008; program 1.1 (marketplace-install 503 stub + comment cleanup + M1/M2 uniformity).
- **Disposition:** Item 1 ratified acceptable-interim non-blocking; items 2–3 open, cosmetic/low-priority, deferred to 1.1. None block the E0 exit gate (Decision #103 execution exclusion fully met; the Task-9 integration run confirms on embedded PG).

## E0-F009 — Task-9 embedded-PG integration gate caught 2 defects (fixed)

- **Status:** resolved
- **Severity:** Medium
- **Blocks gate:** No (both fixed + re-verified green before the gate decision).
- **Discovered during:** Task-9 integration gate — the short-path detached worktree (`C:/e0gate`) embedded-Postgres run (`AOA_RUN_WIN_INTEGRATION=1`) of the FND-006/008 cloud-denial integration proofs, which the OneDrive worktree cannot run (embedded-PG MAX_PATH). The unit tests + `pnpm -r typecheck` + independent source-review did NOT catch these — running the DB-backed integration tests locally did (initial run: 84/86; after fix: 86/86).
- **Items (fixed in gate-repair commit):**
  1. **Cloud-denial facade threw synchronously** (`server/src/routes/plugins.ts` `cloudPluginDenialProxy`) — but it backstops the real loader/lifecycle methods, which are **async** (Promise-returning), and the FND-008 integration facade test correctly asserts async rejection (`.rejects`). The sync throw escaped the matcher. **Fix:** the proxy now returns `() => Promise.reject(new CloudPluginExecutionBlockedError())`, matching every awaited/`.catch()` call site and closing a latent non-awaited-caller footgun. The real routes are unaffected (they `await`/catch → 503) — verified by `plugin-tenant-routes.test.ts` 44/44 + `cloud-plugin-process-composition.test.ts` 7/7 still green after the change.
  2. **Stale c2 tenant-isolation assertion** (`server/src/__tests__/plugin-broker-cloud.integration.test.ts`) — expected a c2 JWT calling c1's tool to `404` (company-scoped `getTool` miss), but FND-008's cloud-block **403/-32003** now fires strictly earlier, before the tenant-scoped lookup. The 403 is CORRECT and strictly safer (c2 is denied all plugin dispatch; the response discloses nothing about whether c1 owns the tool). The FND-008 flip updated the c1 assertion but missed this c2 sub-case. **Fix:** the assertion now expects `403/-32003` with the tenant-isolation rationale documented. Code was correct; the test was stale.
- **Affected tickets:** FND-008 (facade code — `plugins.ts`), FND-006/008 test flip (`plugin-broker-cloud.integration.test.ts`). Both files were reviewed at their ticket revisions; this is a Task-9-gate scoped-defect repair (the plan Task 9 explicitly permits "Modify only if verification exposes a scoped defect").
- **Disposition:** **Fixed and re-verified green** (86/86 across the 7 E0 integration files on embedded PG; server typecheck 0; dependency-free checker + mutations pass; E0 unit suites unchanged). Lesson: for cloud-execution-boundary code, run the DB-backed integration tests on a short-path embedded-PG worktree before the gate — unit + typecheck + review are necessary but not sufficient.

## E0-F010 — Eight trust crossings asserted that denials are audited and recorded nothing on the deny path; DE-06's and DE-14's audit clauses were completed on 2026-09-10, DE-13's on 2026-09-13, and the remaining FOUR are enumerated below (DE-12's audit clause was RESOLVED BY AMENDMENT 2026-09-11 under E0-F013 Decision 1 and is struck), so a refused cross-tenant read, a replayed credential and a shed submission are still indistinguishable from traffic that never happened

- **Status:** open — **4 of 8 remain — DE-01, DE-03, DE-04, DE-11 (DE-12 also struck 2026-09-11 by amendment under Decision 1; DE-13 struck 2026-09-13 — its audit conjunct DELIVERED WHOLE by the de13-audit-regrade unit, see its table row). DE-14's audit clause is DELIVERED IN FULL (2026-09-10) — it
  is single-conjunct and both directions of the outcome are logged at the entrypoint; see the
  DE-14 table row. DE-06's audit clause is DELIVERED IN FULL (2026-09-10) and
  DE-06 is struck from this cohort; see "★ THE OBJECT-ACCESS UNIT" at the end of this entry, and
  read the correction there before trusting the older sentence in this entry that adds `E0-F012`'s
  authentication clause to DE-06's exit condition — that sentence contradicts this finding's own
  Resolution condition and the DE-19 precedent, and it is corrected in place.**
  **History, kept because the corrections are only legible against it:** DE-06's audit clause was
  recorded as CLOSED on 2026-09-09 and RETRACTED the same day, because only the rejected-key
  conjunct was wired. On the same day Unit C wired two more deny-site groups — DE-06's
  tuple-integrity fence throw (1 of its 6) and DE-21's agent-key branches (5 disjuncts across 2 of
  its 7 deny branches) — and NEITHER FINDING CLOSED on that, because both clauses are conjunctions
  and a fraction closes nothing. Unit A then wired DE-06's five remaining fence throws and six of
  DE-03's seven, and again nothing closed. What is different on 2026-09-10 is not a larger fraction:
  it is that BOTH of DE-06's audit conjuncts now hold. **DE-21 and DE-03 are unchanged and neither
  closes.**
- **Severity:** HIGH
- **Filed:** 2026-09-08, by W20 (the DE-audit landing unit). Every citation below was measured
  at tip `360d0b0ed`, not inherited.
- **Blocks gate:** No — this is a detection gap, not an enforcement gap. Every crossing named
  here **does deny**; what is absent is the record of the denial.

**The class.** `docs/architecture/distributed-execution-threat-controls.json` gives every crossing
an `audit` clause. The clause fields are, by the register's own note, *"a charter, not a report"* —
but until W20 no crossing's audit clause had been measured against source at all. Eight have now
been, and **all eight are absent**. The shape is identical every time: the enforcement point
returns or throws a refusal, and the refusal reaches the caller as a status code or an exception
with **no row, no metric and no log line** recording that a security control fired.

| Crossing | `audit` clause, verbatim | The line that denies | What records it |
|---|---|---|---|
| DE-01 (Critical) | "query and policy-denial events recorded in the control-plane audit log" | The RLS policy itself — `packages/db/src/migrations/0211_tenant_rls_enforcement.sql:26-28` and 24+ siblings. A read is silently filtered; a write raises 42501. | **Nothing.** No production code handles SQLSTATE 42501 or the string `row-level security policy` — a grep over `server/src` + `packages/*/src` excluding tests returns only prose (e.g. `server/src/services/job-input-staging.ts:25`). The one control-plane audit writer for this path, `jobAuditBridge` (`server/src/services/job-audit-bridge.ts:158`), has **zero production callers** — its only references are its own definition and `server/src/__tests__/job-audit-parity.integration.test.ts:24,42`. |
| DE-03 (High) | "enrollment, session issue, and replay-rejection are audited" | `packages/db/src/repositories/tenant/worker-enrollment.ts:273-276` (`onConflictDoNothing().returning()` → `rows.length === 1`), turned into a refusal at **nine** production call sites. | **Nothing on the job/lease paths.** The refusal returns via `sendWorkerOperationProtocolError` (`server/src/services/worker-protocol-http.ts:76-93`), which writes the HTTP response and nothing else, and the route returns at `server/src/routes/worker-control.ts:436-442` **before** the handler's only `logger.error` at `:444`. |
| DE-04 (Critical) | "claim, fence-generation, and stale-claim rejection are audited" | `packages/db/src/repositories/tenant/job-control.ts:1167` / `:1177` / `:1185` / `:1187` (`guardActiveFence`, 11+ governed mutators call it). | **Nothing.** The one table that looks like it records rejections, `worker_lease_rejections`, is an eligibility-certificate cache whose own header excludes exactly this class — *"Dynamic capacity, liveness, lock, parsing, and **authority failures** are deliberately excluded"* (`packages/db/src/schema/worker_lease_rejections.ts:16-18`), and its single writer (`job-control.ts:2127`) inserts placement certificates, not fence refusals. **★ NARROWED 2026-09-12 by the DE-04+DE-18 fence-denial-audit unit:** the three PRODUCTION worker services now audit the guardActiveFence deny — `acceptEvent` (job-events), `ackControlCommand` (job-control-ack), `renewLease` (job-fencing) each write ONE attributable `security.denied.fence_guard` `activity_log` row via `recordFenceGuardDenial` (`server/src/services/fence-denial-audit.ts`) when the guard refuses (current throws `job-control.ts:1956`/`:1966`/`:1974`/`:1976`), `actorId=workerId` (never the tenant), company+org scoped, crossing keyed by reason (`stale_fence`/`attempt_terminal`→DE-04), drained on the POOL handle after the tenant tx unwinds. Proven RED-first **per owner** by `server/src/__tests__/de-04-18-fence-denial-audit.integration.test.ts` (reverting each owner's drain reds only its arm). ★ Honest scope: the worker services pre-empt `target_revoked`/lease-absent `stale_fence` at their own integrity checks (they throw `JobLeasingError` first — follow-on), so what reaches guardActiveFence through the services is the `attempt_terminal` late claim (the DE-04 double-execution deny); `patch-apply` (recordPatchApplyState) and `secret-broker` (resolveExecutionSecret) are the same sink shape and are the follow-on (need object/secret scaffolding). The DE-04 audit gap is NARROWED, but the formal re-grade + cohort/count re-derivation is DEFERRED (count-cascade avoidance, cf. the DE-13 row). DE-04 stays `partial` and STILL listed in this cohort. (No count or cohort change is taken here.) |
| ~~DE-06 (Critical)~~ — **AUDIT CLAUSE COMPLETE 2026-09-10; STRUCK FROM THIS COHORT** | "object put/get **and** rejected-key attempts are audited" | `server/src/services/artifact-transfer-grant.ts` (upload key outside this org's prefix; download), the `wrong_prefix`/`tenant_mismatch` guards at the head of `commitArtifactVersion` (commit). | **BOTH CONJUNCTS DELIVERED.** ★ *"object put/get"* — a SUCCESSFUL grant now writes one attributable `activity_log` row under the reserved `security.object_access.` namespace: `…artifact_upload_grant` on a granted PUT, `…artifact_download_grant` on a granted GET, carrying WHO (`actor_id` = the authenticated `workerId`), TENANT (the LOCKED LEASE's company), RESOURCE (`job_artifact` + `details.objectKey`, the key that was actually SIGNED) and the exposure window (`details.grantExpiresAt`); the download row additionally carries `details.kind`/`details.sensitivity` read from the committed row, which is DE-11's access half. Writer: `artifact-object-access-audit.ts` `recordObjectAccessGrant`, drained on the POOL handle after the tenant transaction closes. **The record is of ISSUANCE, not REDEMPTION**, and it therefore OVER-reports — the control plane never observes the transfer and no wiring creates a second observation point. ★ *"rejected-key attempts"* — unchanged and delivered as described below. **DE-06 leaves this cohort. It stays `partial` in the register** for its separately-absent `authentication` clause (`E0-F012`), which is the same shape as DE-19. Full evidence, the hot-path bound and the six-mutant matrix are in "★ THE OBJECT-ACCESS UNIT" at the end of this entry and in the register row. *(Historical, kept because the corrections are only legible against it:)* **Half.** ★ The clause is CONJUNCTIVE and only the second conjunct was wired. **Delivered — "rejected-key attempts":** every refusal that RETURNS a `rejected` outcome on either path now writes one attributable row to `activity_log` — `security.denied.artifact_transfer_grant` / `security.denied.artifact_commit` — carrying WHO (the refused `workerId`), TENANT (the LOCKED LEASE's company, never the request's or the manifest's), RESOURCE (`job_artifact` + `details.requestedObjectKey`) and WHY (a per-BRANCH machine code behind the unchanged coarse wire `malformed`). Proven by provocation against real PostgreSQL: `server/src/__tests__/de-06-artifact-denial-audit.integration.test.ts`, observed 9-RED / 4-PASS against the unchanged tree and 13/13 green after, four mutants killed (the file now holds 15 arms: those 13 plus the two that pin the fence-auth gap, both observed RED in their aspirational form before being pinned); the central provocation is CROSS-TENANT at the `organizations` level and the probed tenant's own `activity_log` is asserted empty. **NOT delivered — "object put/get":** a SUCCESSFUL download grant (`artifact-transfer-grant.ts:288-315`, the sole production `presignGet` call site in the tree) presigns, parses and returns while writing NOTHING; a successful upload grant leaves only the operational `recordArtifactGrantIntent` row. The disclosure-relevant event for an object-key threat is exactly the successful GET. **ALSO NOT delivered:** the fence-AUTH refusals — `resolveWorkerFenceContext` throws `JobLeasingError` out of `runInTenant` on both paths and nothing records it (pinned, with the reachability control, by two arms in the same test file). **DE-06 stays `partial`** in the register and stays in this cohort. The historical measurement is kept below because it is what the half-closure was built against. |
| *(DE-06, as measured 2026-09-08)* | — | — | **Partly — and this is the one row in the table where "nothing" would be wrong.** A rejected *commit* does emit a **count-only** metric: `metrics?.artifactOp({operation:"commit", outcome:"rejected", count:1})` (`server/src/services/artifact-commit.ts:246-250`), and the sink is genuinely wired in production (`createPinoJobControlMetrics`, `server/src/index.ts:657-660`). It is **not an audit record**: by deliberate design it carries no organization, no object key, no reason and no actor (`job-control-metrics.ts:15-17` — high-cardinality ids ride the logger spine, never a metric label), so a breach cannot be attributed or reconstructed from it. The *grant* rejections emit nothing at all: `rejected()` (`artifact-transfer-grant.ts:76-85`) only constructs a parsed response object, and although `ArtifactOpOperation` includes `"transfer_grant"` (`job-control-metrics.ts:30`), the sole production `artifactOp` caller is the commit path. |
| DE-11 (High) | "sensitive-artifact access and retention are audited" | ★ corrected 2026-09-11 — the audit controls are NOT absent: retention via `recordRetentionDecision` (`artifact-retention-audit.ts`, drained at `artifact-commit.ts:482`) and access via `recordObjectAccessGrant` (`artifact-object-access-audit.ts`, riding DE-06). `E8-F011` still owns the NON-audit clauses. | ~~**Nothing**, and the code says so: `server/src/services/artifact-commit.ts:172-173`.~~ ★ **CORRECTED 2026-09-11 (E0-F013 Decision 1): BOTH audit halves now have a LIVE WRITER** — retention (`recordRetentionDecision`, drained at `artifact-commit.ts:482`) and access (`recordObjectAccessGrant`, `artifact-object-access-audit.ts`, riding DE-06). The `:172-173` / "LOG LINE" citation is STALE: that range is the generic `deny` rejection-helper closure (`:168-176`), not the retention path, and the actual retention branch at `:277` now reads *"THIS IS NOW AN AUDIT RECORD AND NOT ONLY A LOG LINE."* DE-11 stays in this cohort and stays `partial` for the COVERAGE reason (no production `browser_cookie_state`/`browser_storage_state` producer until BRW-003) plus its non-audit clauses (`E8-F011`: purge-on-completion measured absent; encryption/TTL UNKNOWN) — NOT because the audit controls are absent. Mirrors the corrected narrative at the DE-03/DE-11 re-statement above and the `E0-F013` Group D DE-11 bullet. |
| ~~DE-12 (Critical)~~ — **AUDIT CLAUSE RESOLVED BY AMENDMENT 2026-09-11 (E0-F013 Decision 1); STRUCK FROM THIS COHORT** | "partition, drain, and generation changes are audited" | `packages/db/src/repositories/tenant/job-control.ts:2726` (the `serviceSourceIsAdmitted` generation gate; the older `:1667-1679` cite is stale) | **Nothing** — but ★ corrected 2026-09-10: the old justification (*"no writer anywhere in the tree, `grep -rn "update(services)"` returns zero hits"*) is now FALSE. A writer EXISTS — `bumpServiceGeneration` (`:3135`, a compare-and-set reached via the SVC-005a roll route), joined by `updateServiceDesiredState` (`:3004`) — so generation changes DO occur. ★ FURTHER CORRECTED 2026-09-11 (E0-F013 Decision 1): a roll is now AUDITED — it writes exactly ONE durable `service.generation_roll` `activity_log` row (`company_id` set) via `recordServiceGenerationRollActivity` (`server/src/services/service-control-audit.ts:317`) on the `rolled` verdict only, proven RED-first by `service-generation-rollout.integration.test.ts` R-T11 — so DE-12 conjunct **3c (generation changes are audited) is DELIVERED** and the `logger.info`-only justification above is stale. The clause stays undelivered on its OTHER two conjuncts, **3a (partition)** and **3b (drain)**, vacuous for the narrow reason that a partition detector (3a) and a reconciler-driven producer of the frozen drain/graceful_stop control-command kinds (3b; E9-F008) do not exist — NOT because the reconciler or fences are unbuilt (SVC-002/SVC-003a/SVC-005a shipped). `E0-F011` stays OPEN for those still-absent detector/producer mechanisms (see item 4). Row stays `partial`. ★ DE-12 LEAVES THIS COHORT 2026-09-11: its audit clause is now honest (3c delivered; 3a/3b amended as vacuous by Decision 1). This is resolution BY AMENDMENT, not a whole delivery like DE-06/DE-14 — the crossing stays `partial` in the register and E0-F011 stays open for the unbuilt partition-detector (3a) and drain-producer (3b). |
| ~~DE-13 (High)~~ — **AUDIT CLAUSE DELIVERED WHOLE 2026-09-13; STRUCK FROM THIS COHORT** | "admission, throttle, and quota-breach events are audited" | `server/src/services/org-concurrency.ts:274` (capacity) and `server/src/services/worker-admission-rate-limit.ts:147` (`over_cap`). | **Nothing for the throttle.** `server/src/routes/worker-control.ts:414-416` returns the 429 through the same silent `sendWorkerOperationProtocolError`. The capacity 429 (`server/src/services/job-submission.ts:367`) surfaces only a generic `job_submission_rejected` reason code carrying neither cap nor usage. **★ SUPERSEDED 2026-09-12 by the DE-27 admission-audit unit:** the throttle is NO LONGER silent and the capacity refusal is NO LONGER contentless — `recordWorkerAdmissionDenial` durably records BOTH the `over_cap` throttle (`actorId=workerId`) and the `capacity` refusal (carrying `usage` and `cap`) as attributable `security.denied.worker_admission` `activity_log` rows, so DE-13's audit SITES ("admission, throttle, and quota-breach events") are now WIRED (see the DE-27 row). The DE-13 audit gap is thereby NARROWED, but the formal audit-conjunct re-grade + cohort/count re-derivation is DEFERRED to a dedicated pass (to avoid an unreviewed count cascade, cf. Decision 1). DE-13 stays `partial` and is STILL listed in the E0-F010 cohort pending that pass — its integrity / fair-share conjunct (E0-F012) is absent regardless. (This mirrors the register's DE-13 correction; no count or cohort change is taken here.) **★★★ RE-GRADED 2026-09-13 by the de13-audit-regrade unit (task_7d78a3c5) — the deferred pass has now run, and THE AUDIT CONJUNCT IS DELIVERED WHOLE: DE-13 is STRUCK from this cohort.** Measured at HEAD, per conjunct: **throttle** — the `over_cap` refusal writes its row directly on the pool handle inside `admit()`'s over-cap branch (`worker-admission-rate-limit.ts:167`, current line), production-reached from `pollRateLimiter.admit` in `worker-control.ts`; one row per over-cap poll, `actorId` = the refused worker, `details.count`/`limit`. **admission / quota-breach** — the capacity `usage >= cap` refusal captures an intent in `admitAttemptCapacity` (`org-concurrency.ts:289`, current line) and is drained on the pool handle in a `finally` after the refusing tenant transaction rolls back, at ALL THREE production submit owners (`job-submission.ts:452`, `job-admission-bridge.ts:347`, `service-reconciler.ts:415`); `actorId` = the submitting principal, `details.usage`/`cap` — at this control the admission refusal IS the quota breach, so one row records both event kinds. Proven RED-first by `de-27-admission-audit.integration.test.ts`. The clause is read per-REFUSAL — the reading Decision 1.2c ruled for DE-27's twin clause and the reading this row itself always used — and DE-13's clause carries no cross-replica/partition language, so this is WHOLE DELIVERY, not resolution-by-amendment; no clause text is touched. Honest scope: the `budget` deny, the fail-closed `unavailable` denies, and the released/terminal-attempt second `capacity` return record no row (not fresh quota refusals). DE-13 stays `partial` in the register for its integrity / fair-share conjunct (`E0-F012`), which is absent at HEAD (`job-control.ts:3525` ordering still has no tenant term). Cohort counts move: this cohort 5 → 4; see the E0-F013 status block for the class-wide figures. |
| ~~DE-14 (Critical)~~ — **AUDIT CLAUSE COMPLETE 2026-09-10; STRUCK FROM THIS COHORT** | "the startup safety-assertion outcome is logged" | `assertHostedExecutionStartupSafe` (`server/src/config/distributed-execution.ts`) — measured throwing over a seven-case matrix by W20, and re-measured refusing on all four branches by the unit that closed this row. | **BOTH DIRECTIONS DELIVERED.** The assertion now RETURNS a `HostedExecutionStartupSafetyOutcome` on the pass and throws a `HostedExecutionStartupUnsafeError` carrying its own branch's `reason`/`envName` on the refusal; `loadConfigWithStartupSafetyAudit` (`server/src/config/hosted-execution-startup-audit.ts`) is the single production caller at the entrypoint and turns both into log lines — `distributed_execution.startup_safety.passed` at info, `distributed_execution.startup_safety.refused` at error, then RETHROWN unchanged so the process still dies before serving. **The clause is single-conjunct, so this closes it whole.** *(Historical, kept because the correction is only legible against it:)* **Nothing, in either direction.** `server/src/config/distributed-execution.ts` imported no logger and contained no `logger`/`console` call at all — its only import was `import type { DeploymentMode }` at `:1`. The failure surfaced as an unhandled module-eval crash trace; the success outcome was never recorded. |

**Why this is HIGH and not cosmetic.** Seven of the eight crossings are the ones an operator would
have to reconstruct an incident from. A cross-tenant read denied by RLS produces no error at all —
it returns zero rows — so without an audit record there is no difference, anywhere in the system's
own memory, between "an attacker probed thirty organizations and was refused thirty times" and
"nobody asked". This is the detection half of the same programme lesson that produced
`scripts/check-guard-inventory.mjs`: a control that fires unobserved cannot be shown to have fired.

**What it is NOT.** It is not a claim that any of these controls fail to deny. W20 measured every
one of them denying (DE-01 across 4,460 adversarial operations against real PostgreSQL; DE-14 by
executing the assertion directly). The register rows for those crossings are `partial`, not
`not-delivered`, precisely because the enforcement halves hold.

**★ A WRITER NOW EXISTS, AND NONE OF THESE EIGHT USE IT (2026-09-08).** The E0 denial-audit slice
built `recordSecurityDenial` (`server/src/services/security-denial-audit.ts`) and closed exactly
one crossing's audit clause — **DE-19, in `E0-F013`'s cohort, not this one**. **All eight crossings
in this finding are unchanged and this finding stays open.** Recorded here because the *reason*
this finding gave for `unowned` — "a denial-observation point would have to be built rather than
connected" — is now half-answered: the storage half is built and has a production caller. What is
still true, and is why these eight did not come with it, is stated in the follow-on list under
`E0-F013`. Two things from that slice bear directly on this finding: (1) **DE-01's read half is
confirmed unbuildable by interception** — ★ **the `BYPASSRLS` half of this sentence was MEASURED FALSE on 2026-09-09; see `docs/replatform/MEASUREMENT-de-01-read-half-does-not-need-bypassrls.md`. A cross-tenant read by a non-owner `NOSUPERUSER NOBYPASSRLS` role is achievable two ways, both already shipped in this tree, and `client.ts:325` must NOT be amended. This finding's status and disposition are unchanged.** — PostgreSQL emits no event when an RLS `USING` clause
filters rows, so detecting it needs a `BYPASSRLS` comparator, i.e. exactly the privilege
`packages/db/src/client.ts:325` throws at boot to forbid; **DE-01's WRITE half is different and IS
interceptable**, because a `WITH CHECK` violation raises catchable SQLSTATE `42501`. (2) DE-04,
DE-12 and DE-13's capacity half deny by `throw` **inside the tenant transaction**, so an
in-transaction write of the denial rolls back with it; `recordSecurityDenial` is documented as
requiring a pool-level handle and that separate-transaction lifecycle is not yet built. Neither is
a wiring task.

**★ DE-06 IS HALF DELIVERED (2026-09-09) AND ALL EIGHT REMAIN — a closure claimed and RETRACTED
the same day.** The denial-audit batch wired `recordSecurityDenial` into both artifact
object-operation paths (`artifact-transfer-grant.ts`, `artifact-commit.ts`), and then recorded
DE-06 as CLOSED, struck it from this cohort ("7 of 8 remaining") and enrolled
`E0-de06-artifact-denial-audit` in `scripts/gate-clause-wiring.json`. **All three of those were
wrong, on the same mistake**, and they are reversed above and in `scripts/gate-clause-wiring.json`
(entry removed), `scripts/finding-ownership.json` and the register's `deliveryEvidence`.

**THE MISTAKE, NAMED.** DE-06's clause is verbatim *"object put/get **and** rejected-key attempts
are audited"*. It is a CONJUNCTION, and only the rejected-key conjunct was wired. A successful
DOWNLOAD grant — the disclosure-relevant event for a cross-tenant object-key threat — presigns,
parses and returns from `artifact-transfer-grant.ts:288-315` writing no record at all, and that is
the only production `presignGet` call site in the tree. A conjunctive requirement with one conjunct
satisfied is not satisfied. This programme corrected exactly this reading in the threat register
one day earlier (DE-11's purge clause, DE-23's per-tenant keys) and then committed it here, in the
unit whose subject was scope honesty.

**AND A SECOND GAP, MEASURED WHILE CORRECTING THE FIRST.** `resolveWorkerFenceContext` **throws**
`JobLeasingError("stale_fence" | "target_revoked" | "unauthorized")` out of `runInTenant` on BOTH
paths, so the intent drain never runs and worker-control maps the exception to a protocol error
with no audit writer. The proving test could not see this because its fixture expires a lease whose
tuple still MATCHES, so the refusal lands on the LATER `lockActiveFence` catch — *a test that
appears to cover a branch it cannot reach*. Two arms now drive the actual cases (a lease tuple that
no longer resolves; a revoked target authority), assert the throw FIRST as a reachability control,
and pin that nothing is recorded. **It is not wired here, and the reason is not the transaction:** a
drain point outside `runInTenant` is a `try`/`catch`. It is ATTRIBUTION — `workers` and
`execution_targets` carry `organization_id` only, the lease that carries `company_id` is exactly
what failed to resolve, and `activity_log.company_id` is NOT NULL. **That is Decision 2, which
therefore blocks a FOURTH clause-half.** The two escapes each cost a design decision rather than a
wire: resolving the company from the caller-supplied `jobId` lets a prober choose which of its own
tenants absorbs the record, and the post-resolution tuple-integrity branch
(`worker-fence-context.ts:111-123`, where a `companyId` does exist) sits inside a helper shared by
FOUR services (artifact-commit, artifact-transfer-grant, patch-apply, secret-broker).

**REMAINING WORK TO CLOSE DE-06'S AUDIT CLAUSE**, so the successor unit does not have to re-derive
it: (a) record the SUCCESSFUL download grant and the successful upload grant as object-access
audit rows — new behaviour on a hot path, so it needs its own unit and its own review, and it must
decide whether an issued GET is recorded at issuance or at redemption (the control plane never sees
the redemption); (b) close, or amend, the fence-auth refusal half under Decision 2. ~~Only when both
land, plus the separately-absent `authentication` clause (`E0-F012`), does DE-06 leave this cohort.~~

★ **BOTH (a) AND (b) HAVE LANDED — (b) by Unit C + Unit A on 2026-09-09/10, (a) by the
object-access unit on 2026-09-10.** ★ **AND THE STRUCK SENTENCE ABOVE IS CORRECTED, NOT MERELY
SATISFIED, because it stated the wrong exit condition.** It added `E0-F012`'s `authentication`
clause to DE-06's membership test for THIS cohort. That contradicts three things, each measured
rather than recalled: (1) **this finding's own Resolution condition**, below, which sets the bar at
*"each remaining row's `audit` clause is either delivered against a named record point with a
production caller, or AMENDED"* — the audit clause, and nothing else; (2) **this finding's own
title and subject**, which is crossings whose *audit* clause asserts denials are recorded; and
(3) **the DE-19 precedent applied in the sibling one section down**, where DE-19's audit clause
closed on 2026-09-08, DE-19 was struck from `E0-F013`'s cohort, and DE-19 nevertheless stayed
`partial` in the register precisely because its `authentication`/`revocation`/`integrity` clauses
are separately absent under `E0-F016`. A fourth authority agrees: `scripts/gate-clause-wiring.json`'s
own `$comment` makes **the clause** the unit of claim. Under one reading DE-19's closure was wrong;
under the other, this sentence was. The sentence is the outlier, and it is the one corrected.
**DE-06 therefore leaves this cohort on its audit clause and stays `partial` in the register for
`E0-F012`'s.** If a reviewer prefers the stricter reading, reversing this is one edit — restore
DE-06 to the affected-crossings list and set the count back to eight — but the same reading would
have to reverse DE-19 too.

**Two things the half-closure still changes about how the rest of this cohort should be read**, both
measured rather than inherited:

1. **The "in a transaction" objection is narrower than the paragraph above implies.** DE-06's
   *returning* refusals happen *inside* `runInTenant`, and they are still recordable — because a
   `rejected` outcome is a **RETURN, not a throw**, so the tenant transaction COMMITS. What blocks
   Group B is not "inside a transaction" but "the deny is a `throw` that rolls the transaction
   back". The pattern used here — the refusing branch records an **intent** into a local, the
   transaction returns, and the caller writes the row on the pool handle before responding —
   costs nothing and avoids borrowing a second pool connection while the first is still held,
   which on a small pool would be a self-deadlock **on the refusal path**. Any returning deny
   **that has an FK-valid tenant at its sink** can use it as-is — ★ and that qualifier is not
   decoration: CORRECTION 2 below measures that Group A is false for **all three** of its
   members (DE-16 and DE-21's board half have no `companyId` at their sinks, DE-15 has no tenant
   at all), and none of the sixteen remaining is a drop-in. The transaction was never the axis.
   Attribution is. ★ **And the corollary this list first drew — "a `throw`-shaped deny
   still cannot" — is itself too strong, measured on DE-06's own throwing refusals.** A throw can
   be caught OUTSIDE `runInTenant` and drained there; nothing about the transaction forbids it.
   What actually stops DE-06's `resolveWorkerFenceContext` throws is that no FK-valid company
   exists at those sites, which is Decision 2, not the rollback. So a throwing deny is blocked
   only when its tenant is unresolvable — and that is a different, smaller set than "every throw".
2. **The pool-borrow hazard was not previously named anywhere.** `security-denial-audit.ts` says
   the handle must be pool-level; it does not say that calling it *from inside* an open tenant
   transaction is the way to satisfy that sentence and deadlock anyway. That is now documented in
   `server/src/services/artifact-denial-audit.ts` and is a live constraint for every remaining
   crossing in this class.

- **Affected crossings:** DE-01, DE-03, DE-04, DE-11 — **four remaining** (DE-12 struck 2026-09-11, audit clause resolved by amendment under Decision 1; DE-13 struck 2026-09-13, audit clause delivered whole by the de13-audit-regrade unit — see its table row).
  **DE-14 is struck (2026-09-10):** its clause — "the startup safety-assertion outcome is logged" —
  is SINGLE-CONJUNCT and both DIRECTIONS of the outcome are now recorded at the entrypoint's one
  startup load. See the DE-14 table row above and the register row. It stays `partial` in the
  register for its other clauses — ★ but **NOT for DE-19's and DE-06's reason**, and an earlier
  draft of this bullet said it did. Those two rows each had a MULTI-clause `audit` requirement and
  closed it whole; DE-14's row names exactly **ONE** absent clause — `audit` — and it is the one
  this unit delivered, so `partial` here is about clauses OTHER than audit. The analogy fails, and
  the correction is recorded in the register row and in the gate-clause enrolment as well as here.
  ★ **AND IT PROVES NOTHING
  ABOUT THE OTHER FIVE.** DE-14 was always the cheapest member of this class and `E0-F013` said so
  in terms — it is the one row whose clause asks for a LOG rather than an attributable durable
  record, and the assertion fires before any database pool exists, so a durable row is
  structurally impossible there. Closing it removes a row from the count; it does not move the
  separate-transaction lifecycle, the tenantless-sink question, or any Group B/C/D blocker.
  **DE-06 was struck (2026-09-10):** both conjuncts of its audit clause are delivered — rejected-key
  attempts (every returning refusal on both artifact services, plus all six
  `resolveWorkerFenceContext` throws) AND object put/get (a successful upload or download grant).
  It stays `partial` in the register for `E0-F012`'s separately-absent `authentication` clause,
  which is the DE-19 shape and is not a member of this cohort's test. **DE-03 and DE-11 are NOT
  struck**, and both are re-stated here because each had a half move in the same wave: DE-03's
  clause is "enrollment, session issue, AND replay-rejection" and only replay-rejection is wired;
  DE-11's is "sensitive-artifact ACCESS and RETENTION" and both halves now have a live writer, but
  the coverage caveat holds it open (see the object-access unit below and `E0-F013`'s Group D DE-11
  bullet).
  (DE-11's is carried in detail by `E8-F011`; it is listed here so the class is complete.)
  ★ **DE-11's TWO GROUNDS WERE RE-MEASURED AT SOURCE ON 2026-09-10** by the unit that closed DE-14,
  because an orchestration brief carried the premise that DE-06's closure was DE-11's ONLY
  remaining blocker and that DE-11 could therefore now close whole. **It cannot, and the premise
  was one ground short.** Ground (i) — the access half's missing piece being DE-06's own open
  put/get conjunct — IS discharged, and the register row already said so. Ground (ii) is untouched
  and is what holds DE-11 open: re-run whole-tree at this commit, `browser_cookie_state` and
  `browser_storage_state` appear in `server/` and `packages/` ONLY as a frozen-protocol
  vocabulary entry (`packages/worker-protocol/src/artifacts.ts`), a retention classifier
  (`server/src/services/browser-artifact-retention.ts`), a quarantine type union
  (`packages/worker-daemon/src/lease/quarantine.ts`) and prose. **There is no producer**: no
  production path uploads or commits a credential-bearing kind, `BRW-003c` is design-only with no
  result file on disk, and both the access record and the retention record can therefore only ever
  be about a `log`, a `workspace_patch` or a `screenshot` today. The register was RIGHT and the
  inherited framing was stale — recorded here because the reverse has been true four waves running
  and the direction of the error is not something a reader should have to re-derive.
- **Disposition:** `unowned`. No ticket on disk owns "record a denial" for these five. The
  nearest candidate, `jobAuditBridge`, exists and is caller-less; wiring it is not a code-motion
  task, because the DE-01 case has **no error to intercept** (a filtered read is a successful empty
  read), so a denial-observation point would have to be built rather than connected. Minimum work
  is stated in the ownership manifest entry. NOT `accepted`: HIGH may never be accepted.
- **Resolution condition:** each *remaining* row's `audit` clause is either delivered against a
  named record point with a production caller, or AMENDED to state what the programme intends.
  Amending is a founder decision and is not taken here. Resolve = flip this Status and delete the
  `E0-F010` key in `scripts/finding-ownership.json` in the SAME commit. **FIVE are still open (DE-12 left 2026-09-11 by amendment under Decision 1); a
  HALF-delivered conjunctive clause closes nothing, and the reason DE-06 left on 2026-09-10 is that
  BOTH of its audit conjuncts hold — not that a larger fraction of one does. DE-14 left on the same
  day for the narrower reason that its clause has only one conjunct and both of its DIRECTIONS are
  now recorded.** The `E0-F010` key stays in `scripts/finding-ownership.json`: five crossings remain
  and this finding is open.
- **2026-09-10, Unit A — two rows moved and the cohort did NOT.** The wave that the ruling on
  `E0-F013` Decision 2 unblocked wired the organization-attributable denial sinks: **DE-06**'s five
  remaining `resolveWorkerFenceContext` throws (`:86` proof replay, `:100` in both of its codes,
  `:103`, `:108`, `:121`) and **SIX of DE-03's seven** organization-attested `recordProof`
  refusals (`job-control-ack.ts:93`, `job-events.ts:169`, `job-fencing.ts:133`,
  `job-leasing.ts:546`, `worker-fence-context.ts:68` and `:162`). **`job-leasing.ts:816` (ack) was
  NOT wired** — the frozen JOB-003 ack-flow contract (`job-leasing-contract.test.ts`,
  `exactAckReturnDominance`) leaves no drain point outside the transaction, and amending it is a
  decision this unit did not take; the proving file PINS that site as recording nothing rather than
  dropping it from the count.
  ★ **THAT AMENDMENT IS NOW MEASURED AND FILED (2026-09-10):**
  [`docs/replatform/DECISION-REQUEST-job-003-ack-drain-amendment.md`](../../DECISION-REQUEST-job-003-ack-drain-amendment.md).
  Three results, each run at `c27feeea8` against a 20/20 green baseline and then reverted.
  **(i) The blocker is real and was re-measured, not inherited** — a `.finally(…)` on ack's outer
  return reds the contract with `builder:trusted-service-authority-guard`.
  **(ii) ★ THE OBVIOUS AMENDMENT IS MEASURABLY UNSAFE.** Teaching `exactAckReturnDominance` to
  accept `runInTenant(…).finally(fn)` turns the drain shape green — and ALSO silently stops
  policing the drain callback: a call to one of the four protected ack effects placed inside that
  `.finally` leaves the contract **fully GREEN**, because `collectAckEffects` walks the
  `runInTenant` CALLBACK's body and the drain callback is a sibling scope it never enters. The
  relaxation would have opened a hole in the guard it was relaxing, and it would have shipped
  green. It was caught only by provoking the safety claim instead of arguing it.
  **(iii) A hardened amendment is proven** — extending that same sweep into the drain callback reds
  the protected-effect case while the benign drain stays 20/20, and both evasions (a chained second
  `.finally`, a `return` inside the drain) red without new machinery.
  **The ruling is not taken here**, and note that DE-03 cannot close on it either way: its clause is
  a THREE-way conjunction and neither enrollment nor session-issue has any writer at all.
  ★ **RULED 2026-09-14 (Option B, `docs/replatform/DECISION-REQUEST-job003-ack-drain.md`
  §Decision):** the hardened ack-drain amendment is ADOPTED — the ack-path arms (the three
  `target_revoked` throws + this seventh `recordProof` site) are UNBLOCKED; build pending, nothing
  delivered by the ruling itself. `guardPlatformAuthority`'s two shared-platform throws are NOT
  unblocked by it: they are attributed to **DEFERRED-DECISION: guardPlatformAuthority denial sink**
  (a named, owner-visible future decision). No status moves here; DE-03's enrollment and
  session-issue conjuncts still have no writer. Both rows' full per-site evidence, the four DE-06 sites actually
  PROVOKED versus the two pinned as structurally unreachable, and the mutation matrix are in
  `docs/architecture/distributed-execution-threat-controls.json`.
  **NEITHER CROSSING CLOSES AND THE COHORT STAYS AT EIGHT.** DE-06's clause is
  "object put/get **AND** rejected-key attempts", and the put/get half — a SUCCESSFUL grant — still
  writes nothing at the tree's only production `presignGet` call site. DE-03's clause is
  "enrollment, session issue, **AND** replay-rejection", and only replay-rejection is wired. Two of
  DE-03's nine `recordProof` sites (`worker-enrollment.ts:315`,
  `middleware/worker-session-auth.ts:151`) stay DOUBLY NULL and were deliberately not wired and are
  not claimed. A larger fraction of a conjunction is not a closure.
  *(★ The sentence "THE COHORT STAYS AT EIGHT" was correct on 2026-09-10 when Unit A wrote it and
  is superseded later the same day by the object-access unit below, which delivered the OTHER
  conjunct rather than a larger fraction of the same one. Left standing so the distinction is
  visible.)*

### ★ THE OBJECT-ACCESS UNIT, 2026-09-10 — DE-06's put/get conjunct, and the FIRST closure in this cohort

★ **SUPERSEDED LATER THE SAME DAY by the startup-audit unit: the class stands at THREE closed
(DE-19, DE-06, DE-14) and FOURTEEN open, and THIS cohort is SIX, not seven. The paragraph below was
correct at the moment it was written and is kept because the DE-14 section is only legible against
it. The authoritative count is `E0-F013`'s Status block.**

**The count first, because a skim must not read this as the class being solved.** Of the SEVENTEEN
crossings in the denial-audit class (`E0-F010`'s eight plus `E0-F013`'s nine), **TWO now have a
whole audit clause — DE-19 (2026-09-08) and DE-06 (2026-09-10) — and FIFTEEN remain open.** This
cohort goes from eight to seven. `E0-F013`'s stays at eight. **DE-03, DE-11, DE-20 and DE-21 each
still carry part of a conjunction and NONE of them moves.**

**What was missing, exactly.** DE-06's clause is *"object put/get **and** rejected-key attempts are
audited"*. The rejected-key conjunct was finished across three earlier units. The put/get conjunct
was untouched, and it is the disclosure-relevant one: a SUCCESSFUL download grant — issued at the
tree's **only production `presignGet` call site** — presigned, parsed and returned while writing
nothing at all, so a worker HANDED read access to an object's bytes left the same durable trace as
a worker that asked for nothing. It had been deferred three times, each with a good reason: it is
new behaviour on a success path.

**What the code now does.** A successful grant captures an intent at the two `*_granted` returns
inside `runInTenant` and drains it on the **pool handle** after the transaction closes, via
`recordObjectAccessGrant` (`server/src/services/artifact-object-access-audit.ts`). One
`activity_log` row per grant, under a third reserved namespace `security.object_access.`:
`…artifact_upload_grant` for a PUT, `…artifact_download_grant` for a GET — two action slugs rather
than one plus a jsonb field, so *"how many download URLs were issued in this tenant"* is an
`action` predicate. The row carries WHO (`actor_id` = the authenticated `workerId`, `actor_type` =
`system`), TENANT (`company_id` = the LOCKED LEASE's company, resolved under the worker's own
organization GUC; the frozen grant request carries **no tenancy field at all**, so the record
cannot be aimed), RESOURCE (`job_artifact` + the artifact identity, plus `details.objectKey`, the
key that was actually SIGNED), and `details.grantExpiresAt`, the window in which the capability
works. The download row additionally carries `details.kind` and `details.sensitivity`, read from
the committed `job_artifacts` row the branch had already loaded.

★ **THE SCOPE LIMIT, WHICH MUST TRAVEL WITH EVERY CLAIM MADE ABOUT THIS RECORD.** It records
**ISSUANCE, NOT REDEMPTION**. The bytes move directly between worker and object storage — the whole
purpose of the presigned design — so the control plane has exactly ONE observation point and no
wiring creates a second (only the object store's own access log could, and this tree's
`StorageProvider` port has no such operation). The record therefore **over-reports**: an issued but
never-redeemed GET still writes a row. Over-reporting is the right direction for a disclosure audit
— a missed disclosure is unrecoverable and a spurious one is noise — but **"there is a row" means a
capability was handed out, never that bytes moved.** That limit is asserted by its own arm (the
store's `getObject` is never called and the row exists anyway) rather than left in prose.

★ **THE HOT-PATH COST, MEASURED — because three units deferred this on that risk and a fourth
deferral would have needed a number.** **Reach:** the only caller is the `artifact_transfer_grant`
worker-control operation, and the whole worker-control route graph is registered only inside
`if (opts.distributedExecutionEnabled)` in `server/src/app.ts`, a block that **dynamically imports**
`./routes/worker-control.js` so a flag-off startup never loads the module. The flag is
`AOA_DISTRIBUTED_EXECUTION_ENABLED`, **default false**. **Cost when enabled:** one INSERT per
SUCCESSFUL grant, on the pool handle, awaited before the response, never throwing. The UPLOAD arm
already performed one durable write per grant (`recordArtifactGrantIntent`), so it goes from one
write to two — the same order. ★ **The DOWNLOAD arm becomes a WRITER where it was a reader**, and
that is stated plainly rather than buried: it is the one property a future reviewer should re-weigh
if that path ever serves interactive traffic. **Volume:** one row per artifact transfer — bounded by
artifact count, not by request rate.

**Reds observed, each against named positive controls.**
`server/src/__tests__/de-06-object-access-audit.integration.test.ts` carries **TWELVE** arms at this
PR's HEAD — **re-counted after the last edit**, because the register row for this unit was written
in the same commit that changed the thing it counts — every one provoked through the real leasing /
commit / transfer-grant services against real embedded PostgreSQL under the real `aoa_app` non-owner
role. Against the unchanged tree it was **6 RED / 4 PASS** *at ten arms*, which is what the file held
at that moment; the eleventh (DE-11's kind arm) arrived with the `kind`/`sensitivity` fields and the
twelfth with the Codex fix below, and **each was observed RED against the code it was added for**
rather than against base — which is the narrower claim and is stated as such. 12/12 green after. The
four greens in the RED run are the **named positive controls**: anti-vacuity, the refused-grant
mutation guard, cross-tenant non-disclosure, and the namespace reservation.

★ **THE MUTATION MATRIX, RE-RUN IN FULL AT HEAD — SIX MUTANTS, EACH KILLED, EACH WITH ITS CONTROLS
GREEN.** Every row below is **ONE SNAPSHOT: the same 12-arm file, the same baseline (12/12 green),
one mutant at a time, applied to the shipped source and reverted with an md5-verified restore.**
*(An earlier draft of this table mixed measurements taken at ten, eleven and twelve arms without
per-row labels, so THREE of the six rows — 1, 2 and 4 — carried counts that were true when taken
and stale at HEAD: row 1's "7 of 11 red, the 4 controls green" was an eleven-arm figure, row 2's
GET-dependent set had grown from four to five with DE-11's kind arm, and row 4's "nine controls
green" was a ten-arm figure. Rows 3, 5 and 6 reproduced unchanged. A matrix whose rows come from
different snapshots reads as one measurement and is several, so it was re-run rather than
re-labelled.)*

| # | Mutation | Result at HEAD (12 arms, baseline 12/12 green) |
|---|---|---|
| 1 | delete the drain | **7 red / 5 green.** The 5 survivors are the four named positive controls **plus the redaction arm**, which calls `recordObjectAccessGrant` directly and is therefore drain-independent by construction. |
| 2 | delete **ONLY** the download capture | **exactly the 5 GET-dependent arms red, the PUT arm GREEN** — which is what makes the conjunction asserted per conjunct rather than in aggregate. |
| 3 | collapse the action mapping to always report `upload` | exactly the **2** conjunct-distinguishing arms red, 10 green. |
| 4 | **hoist** the upload capture above the foreign-prefix refusal branch | exactly **ONE** arm red — the mutation guard — with **11** controls green. This is the property the deliberate ABSENCE of a second `response.outcome` check at the drain exists to preserve; a redundant guard would have let this mutation pass. |
| 5 | stop reading `kind`/`sensitivity` off the committed row | exactly the **2** kind-asserting arms red, 10 green, with the PUT arm that asserts `kind` is NULL **still green** — proving the upload null is a real answer and not an unwired field. |
| 6 | **restore the raw `objectKey` to the failure log** | exactly **ONE** arm red — the redaction arm — with **11** controls green. |

★ **POST-REVIEW: ONE CODEX P2, REAL, AND FIXED WITH ITS OWN OBSERVED-RED ARM.** The recorder's
`catch` branch re-listed the intent's fields and wrote `objectKey` **verbatim** to the server log,
while the persisted row's copy of the same value goes through `sanitizeRecord`. The object key's
**suffix is caller-controlled** — the frozen grant schema bounds it only by length and by this org's
attempt prefix — so a worker may legally name a file `whsec_<24 chars>.bin`, and `sanitizeRecord`
really does redact exactly that shape (**MEASURED**: three secret-shaped suffixes come back
`***REDACTED***`, an ordinary `out.bin` comes back intact). A transient FK or connection failure
would therefore have written to the log the one value the durable row deliberately refuses to keep —
the audit's own redaction pass defeated by its own error handler. **This module was the outlier**:
the sibling `security-denial-audit.ts` logs only scalars and never its `details`, so its
`requestedObjectKey` was never exposed. **Fixed structurally, not with a second `sanitizeRecord`
call:** the `catch` now logs the already-sanitized `details`, so there is exactly ONE sanitized
`objectKey` in the module and the two sinks cannot drift. The new arm calls the recorder directly
with a secret-shaped key and a company id that violates the FK — a real constraint, not a stub —
spies the logger, and asserts the raw key is absent from the serialized payload while
`***REDACTED***` is present, with two anti-vacuity assertions that the payload is genuinely about
this write. Observed RED against the unfixed code.

★ **TWO EXISTING ARMS ASSERTED THE VERY ABSENCE THIS CLOSES, and each was observed RED before being
amended.** In `de-06-artifact-denial-audit.integration.test.ts`: the granted-upload positive control
asserted *"nothing at all was appended to the tenant's audit stream"* — true, and exactly this
conjunct's gap — and now asserts `+1` row in the object-access namespace and NOT the denial one, so
the control it exists for is asserted directly instead of inferred from a total count; and the
whole-log namespace sweep asserted every `activity_log` row is a `security.denied.` row and now
asserts every row is in ONE OF THE TWO reserved audit namespaces, with a named positive control that
the object-access namespace is genuinely represented so the widening is not dead allowance. That
file's `denialRowsFor` helper was also narrowed to the denial prefix: it was **action-blind**
(`WHERE entity_id = $1` and nothing else) while all of its call sites read it as "the denial rows"
— harmless only while the denial recorder was the sole artifact-keyed writer. That file holds **21**
arms and this unit amended **two** of them, so its **other NINETEEN** stayed green throughout as the
regression control — the whole rejected-key conjunct, untouched. *(An earlier draft of this sentence
said "its other 20 arms", which was the count while only the FIRST of the two had been amended and
was stale the moment the second was. Re-counted at HEAD: 21 total, 2 amended, 19 untouched.)* The
full denial-audit family is **141/141 green
across twelve suites**, re-run and RE-COUNTED after this unit's last edit: `de-06-object-access-audit`,
`de-06-artifact-denial-audit`, `de-03-worker-replay-denial-audit`, `de-11-retention-audit`,
`de-19-memory-denial-audit`, `de-21-live-events-upgrade-denial-audit`, `artifact-transfer-commit`,
`activity-reserved-namespace`, `cli-008-unit-b-staging-channel`, `e0-f013-denial-disclosure-path`,
`e0-f013-unattributable-denial-sink`, `e0-f013-denial-index-plan`. *(This figure has been re-counted
TWICE rather than carried forward, and both earlier values were true measurements of what existed
when they were taken: "123/123 across ten suites" before the last two suites joined the sweep, then
"140/140 across twelve" before the Codex-fix arm was added. A count edited in the same commit that
changes the thing it counts is this programme's own blocker class, so it is re-run after the last
edit every time.)*

**Enrolled** as `E0-de06-object-access-audit` in `scripts/gate-clause-wiring.json`, whose own
`$comment` — which records the 2026-09-09 enrolment and same-day removal — is updated in the same
commit to say that the release condition it named is met. That removal is **not** retracted: it was
correct on the evidence it had.

**NOT DONE, and left open by this unit:**

- **DE-06's `authentication` clause.** Untouched; `E0-F012`'s. DE-06 stays `partial` in the register.
- **The two PRE-TRANSACTION throws in each artifact service** — a frozen-schema parse failure, and
  `body.workerId !== auth.workerId` — still write nothing. **Measured and excluded, not missed:**
  neither is a "rejected-key attempt", because both refuse before any object key is examined.
  Stated so that silence is not read as coverage.
- **DE-11 does not close**; see `E0-F013`'s DE-11 note below and the register row.
- **DE-14 was measured and NOT wired, and the finding's characterisation of it is corrected**; see
  the DE-14 note immediately below.
- **No other crossing is touched.** DE-01, DE-03, DE-04, DE-12, DE-13 and DE-14 in this cohort, and
  all eight in `E0-F013`, are exactly as they were.

### ★ DE-14 — MEASURED AND NOT WIRED, and "~5 lines. Take it as a freebie" is CORRECTED (2026-09-10)

`E0-F013`'s Group D says of DE-14: *"recordable only as a **log**, and that is all its clause asks
… **~5 lines. Take it as a freebie**; it proves nothing about the mechanism."* The object-access
unit took DE-14 as its second candidate on exactly that sentence, measured it, and **did not wire
it** — because the sentence is wrong for a reason nobody had measured, and shipping it as a freebie
would have put an unbounded log write on a universal boot path.

**What was measured, at HEAD.**

1. **`loadConfig` is NOT memoized.** `server/src/config.ts` `loadConfig` has no cache: it re-reads
   the config file and re-runs `assertHostedExecutionStartupSafe` on **every call**.
2. **There are 64 `loadConfig()` call expressions** in `server/src` outside `config.ts`. **36 files
   reference `loadConfig`; 26 of them CALL it** (routes, services, storage, and tests) — the other
   ten name the identifier only to `vi.mock` it away, so they define a stub and never reach the
   real function. So the assertion does not run "once at startup" — it runs on every one of those
   64 calls, in every process, including test processes. *(An earlier draft of this line said "64
   call expressions … across 36 files", which crossed the two measurements: 36 is the mention
   count, 26 is the call count. Both are recorded here so the difference that caused the error is
   named rather than silently corrected.)*
3. **The one obvious logger cannot be imported there.** `server/src/middleware/logger.ts` has
   module-level side effects — `fs.mkdirSync(logDir, {recursive:true})` and a `pino.transport(...)`
   that spawns a worker thread — so importing it from `config.ts` would create a log directory and a
   transport worker in every process that loads config, including the CLI and migrations.
4. **The failure outcome cannot be moved to the entrypoint.** `server/src/index.ts` calls
   `loadConfig()` at module top level with no `try`/`catch`, so a refusal is an unhandled
   module-eval error and no line after it ever runs. The clause asks for *"the outcome"* and
   `E0-F010`'s own row reads it as both directions — *"Nothing, in either direction"* — so success
   and failure need different sites.

**Therefore DE-14 is a UNIT, not a freebie.** It needs a decision about where a pre-logger,
un-memoized, 64-call-site startup assertion reports its outcome **exactly once** — a once-only
guard, a memoized config, or an injected sink with a default that is silent in library use. None of
that is hard; none of it is five lines; and doing it in the same PR as a new write on the artifact
success path would be two properties in one diff, which is the shape the Decision 2 sink slice
explicitly refused. **DE-14 stays in this cohort, unchanged, and the count above already reflects
that.** What changes is only that the next unit will not be told it is free.

### ★ DE-14 IS CLOSED (2026-09-10) — the unit was taken, and measurement 4 above was WRONG

The section above was the correct call: DE-14 was a unit and it has now been done as one. Three of
its four measurements were re-verified at HEAD by the closing unit and each one SHAPED the design.
**The fourth is refuted, and it is refuted by construction rather than by argument.**

- **1 and 2 STAND, and they are why the recorder is not inside `loadConfig`.** `loadConfig`
  (`server/src/config.ts`) still has no cache — re-read at HEAD — so the assertion still re-runs on
  every call from every route and service. The closing design therefore instruments **the
  entrypoint's single startup call and nothing else**: `loadConfig` gained no logging, so the
  per-request re-runs stay silent and "exactly once" needs no once-only latch, no memoisation and
  no silent default. The call-site census is not restated here because it is not load-bearing for
  that design; measurement 1 alone is.
- **3 STANDS and is why the sink is a parameter.** `server/src/middleware/logger.ts` still has
  module-level side effects — `fs.mkdirSync(logDir, {recursive:true})` at `:26` and a
  `pino.transport(…)` at `:54` — re-measured at HEAD. `config.ts` and
  `config/distributed-execution.ts` are both still logger-free and stay that way: the logger is
  INJECTED at the one call site in `server/src/index.ts`, which already imports it statically.
- **4 IS WRONG.** *"The failure outcome cannot be moved to the entrypoint. `server/src/index.ts`
  calls `loadConfig()` at module top level with no `try`/`catch`, so a refusal is an unhandled
  module-eval error and no line after it ever runs."* Every clause of that is a true observation
  about the tree AS IT WAS, and the conclusion does not follow: **a top-level call is not an
  uncatchable call.** `const config = loadConfigWithStartupSafetyAudit({ load: loadConfig, log:
  logger })` is still one top-level statement, and the `try`/`catch` lives inside the function it
  calls — which logs the refusal and **rethrows it unchanged**, so the module-eval error, the crash
  trace and the refusal to serve are all byte-for-byte what they were. Nothing needed to move; the
  handler needed a frame. The absence of a `try`/`catch` was read as a property of the call site
  rather than of the code, which is the same shape as a zero-caller symbol read as an
  impossibility.

**What was built.** `assertHostedExecutionStartupSafe` now RETURNS a
`HostedExecutionStartupSafetyOutcome` on the pass, and throws a `HostedExecutionStartupUnsafeError`
carrying that branch's own `reason` and `envName` on the refusal — four branches, four codes,
`instanceof Error` and every existing message unchanged. `loadConfig` carries the pass outcome out
on `Config.hostedExecutionStartupSafety` so the record is read off the assertion's return value and
never re-derived from the same environment. `loadConfigWithStartupSafetyAudit`
(`server/src/config/hosted-execution-startup-audit.ts`) is the single production caller and logs
`distributed_execution.startup_safety.passed` at info and `…refused` at error.

**What it does NOT claim.** DE-14's clause asks for a **log** and that is all this delivers: the
assertion fires during config load, before any database pool exists, so a durable attributable row
is structurally impossible at that point and none is written. This closes the cheapest row in the
class and moves no other blocker — not the separate-transaction lifecycle, not the tenantless sink,
not any Group B/C/D item. It also does not touch DE-14's other clauses, and **DE-14 stays `partial`
in the register**.

★ **BUT NOT FOR DE-19's AND DE-06's REASON, AND THIS SENTENCE SAID IT DID.** As first written it
read "exactly as DE-19 and DE-06 do", and the register row and the gate-clause enrolment said the
same. Re-read at HEAD, the analogy fails: DE-19 and DE-06 each carry a SECOND clause that was
MEASURED ABSENT and is owned by another finding (`E0-F016`'s, and `E0-F012`'s `authentication`).
**DE-14's row names exactly ONE absent clause — `audit` — and it is the one this unit just
delivered.** What actually holds the row at `partial` is the register's finding-citation contract:
`scripts/check-distributed-execution-foundation.mjs` clause 4 refuses `delivered` for any crossing
whose id appears as a literal token in a live finding-ownership entry, and `E0-F010`'s entry names
DE-14 throughout. **No status change is taken and none is implied** — whether a Critical row whose
every audited clause now holds should become `delivered` is entangled with `E0-F010`'s own
resolution and with `REL-005` (zero files on disk, declared deferred), and is for whoever resolves
that finding. Recorded in all three places rather than only here, so the machine-readable records
are not weaker than the prose.

**★ ONE CODEX P2 ON PR #416, REAL AND FIXED IN THE SAME BRANCH — and it is this programme's own
failure class, inside a unit whose subject is that failure class.** As first shipped, `loadConfig`
called `readDistributedExecutionDeploymentFlag(process.env)` on its own line **before** the
assertion. That reader throws a **plain `Error`** on a non-boolean value, so
`AOA_DISTRIBUTED_EXECUTION_ENABLED=banana` refused startup ONE LINE TOO EARLY, the entrypoint's
recorder saw an unrelated load failure, and no `…startup_safety.refused` line was written. **The
`env_flag_unparseable` reason code was therefore PRODUCTION-UNREACHABLE for that flag** — a
classified branch nothing could emit, shipped inside the unit that exists to stop exactly that.
Fixed STRUCTURALLY rather than by reordering two independent reads: the assertion already reads the
flag and now RETURNS it, and `loadConfig` derives `distributedExecutionEnabled` from that returned
outcome, so **there is exactly one read** and a refusal cannot outrun its own record.
**Why nothing caught it:** every reason-code arm asserted against the module that OWNS the codes,
where all four are trivially reachable. Only driving the REAL `loadConfig` can see the ordering.
That arm now exists and is the tenth.

**Proven, not declared.** `server/src/__tests__/de-14-startup-safety-audit.test.ts`, **TEN arms —
RE-COUNTED AT HEAD after the review fix, because this paragraph is being edited in the same commit
that changed the thing it counts.** Observed RED against the unchanged tree — the whole suite failed
to collect, because neither the recorder module nor the assertion's new exports existed — and then
killed by **five** mutants applied one at a time to the shipped source and reverted with an
md5-verified restore, each with named survivors: **delete the pass log** → exactly the 2 pass arms
red, 7 green including the PRECISION CONTROL and the refusal arm; **stamp a constant reason** on one
branch → exactly the distinctness arm red, 8 green; **widen the refusal guard to `instanceof
Error`** → exactly the PRECISION CONTROL red, 8 green; **restore the bare `loadConfig()` at the
entrypoint** → exactly the ARMING PATH arm red, 8 green. *(Those four were run against the
nine-arm file, which is what it held at that moment, and are recorded at that count rather than
restated at ten.)* The fifth was run at TEN arms, against the post-review code: **restore the
separate pre-assertion flag read** → exactly the REACHABILITY arm red, **9 green**. The pre-existing
`distributed-execution-policy.test.ts` (17 arms, message- and throw-shape assertions over the same
function) is the named regression control and stayed green throughout, and `config.test.ts`
(18 arms over the real `loadConfig`) is green at HEAD. Enrolled as `E0-de14-startup-safety-audit` in
`scripts/gate-clause-wiring.json` in the same commit.

## E0-F011 — Four crossings are defended by a control whose ARMING PATH is dead: two have zero production callers, one is enabled by an environment variable set in no manifest, and one has a deny that is unreachable-as-a-refusal (its DB column now HAS a writer, but the sole production submitter always supplies a matching generation)

- **Status:** open
- **Severity:** HIGH
- **Filed:** 2026-09-08, by W20 (the DE-audit landing unit). Caller counts below were taken by
  enumerating the single write or construction chokepoint, not by grepping call sites.
- **Blocks gate:** No — but it is the reason four register rows are `partial` rather than
  `delivered`, and each of the four looks delivered from the register.

**The class.** In each case the *receiving* half of the control is fully built, tested and
correct — and the half that would ever arm it does not run in any deployment. This is the
`checks-that-nothing-runs` failure one level up: not a guard with no caller, but an **enforcement
mechanism with no producer**. From the register, and from the owning tickets' acceptance clauses,
all four read as shipped.

1. **DE-05 (Critical) — quarantine of late/lost-ACK output has no producer.** The receiver is
   real and denies correctly (`server/src/services/quarantine-finalize.ts:48,52-54`;
   `packages/db/src/repositories/tenant/job-control.ts:3686` `recordOrphanQuarantine`, whose
   deny lines are `:3707` `target_revoked`, `:3722` and `:3742` `unknown_job`). The producer is three dead
   layers deep: `runOrphanQuarantine` is called only from `startup-reconcile.ts:480`; that runs
   only if `deps.quarantineCandidates` is supplied (`:468`); and its factory
   `createStartupReconciler` (`:292`) has **zero production callers** — every reference outside
   its own module is a test or the barrel re-export at `packages/worker-daemon/src/index.ts:634`.
   Consequence: **no shipped path can ever write a quarantined artifact row.**
2. **DE-07 (Critical) — the secret-handle revocation lever cannot be pulled.** ★ **HALF-CLOSED
   2026-09-09 by founder ruling — the revoke-lever half, and closed by RETIREMENT OF THE DEAD
   COLUMN'S READER (the column itself is RETAINED — see below) plus a narrowed clause, not by
   wiring. The broker-refresh half below is untouched and this item stays open.** As filed: the clause was
   *"lease or fence loss invalidates handles; the broker revokes grants."* The fence half holds
   (`job-control.ts:3005`). The broker half did not: `job_secret_handles.revoked_at` was **read**
   (`job-control.ts:2992`, `isNull(...)`) and declared (`packages/db/src/schema/job_secret_handles.ts:81`),
   and the **single write chokepoint** for that table — `tx.update(jobSecretHandles)` at
   `job-control.ts:3146`, the only such call in the tree — sets exactly
   `lastResolvedAt`, `resolveCount`, `updatedAt` and optionally `appliedPolicyVersion`. It could set
   neither `status` nor `revokedAt`. **No code path anywhere could revoke a handle.**

   ★ **The ruling did not arm it. It retired it, and narrowed the claim to what ships.** Founder
   ruling of 2026-09-09: **device-grained revocation is sufficient**, so the single reader lost
   its `isNull(...)` conjunct and DE-07's `revocation` clause was rewritten to state the
   **device-grained fence cutoff** that actually ships:
   `POST /organizations/:organizationId/workers/:workerId/revoke` → `revokeWorker`
   (`server/src/services/job-operations.ts:302`) → `revokeExecutionTarget` →
   `bumpExecutionTargetGeneration` (`server/src/services/execution-targets.ts:272`, taken at
   `:307`/`:311`), after which every later resolve dies at
   `throw new JobFenceError("target_revoked")` (`job-control.ts:1177`) inside `guardActiveFence`,
   **before the handle row is read**.

   ★ **THE COLUMN ITSELF IS STILL THERE, AND THAT IS DELIBERATE (corrected 2026-09-09).** An
   earlier draft of this entry — and a migration, `0274_jittery_nehzno.sql`, carrying a single
   `ALTER TABLE "job_secret_handles" DROP COLUMN "revoked_at";` — shipped the DROP alongside the
   reader removal. **That was withdrawn**: the migration, its journal entry and its snapshot are
   removed, `db:generate` reports no delta, and `revokedAt` is declared again in
   `packages/db/src/schema/job_secret_handles.ts` marked **VESTIGIAL AND UNREAD**. Reason:
   `scripts/deploy/remote-compose-deploy.sh` rolls the **binary** back when a deploy fails after
   `MUTATION_STARTED` (`on_exit` → `rollback_previous`), and nothing in that sequence
   (`restore_environment` / `rollback_previous` / `restore_current_link`) reverts the database — so
   the N-1 binary would come back up against a schema with no `revoked_at` while still naming it in
   `listActiveExecutionSecretHandles` and in full-row selects, and every secret-handle operation
   would fail with `column revoked_at does not exist`. `docs/replatform/test-gates.md` D5-HA03
   requires rolling deployment and N/N-1 compatibility, so shipping the drop here would have been a
   contract violation. **This release is the EXPAND half.** The CONTRACT half — dropping the column
   once no deployable binary still names it — is filed as **E0-F017**.

   Re-verified at branch tip before removing the reader: zero writers
   tree-wide; the only reader ANDed the column with `status = 'active'` so it could never subtract
   a row `status` had not already admitted; no index, no RLS policy and no per-column grant
   referenced it (`job_secret_handles` carries a whole-table `aoa_app` grant,
   `server/src/db/job-control-legacy-grants.ts:626`; the `revoked_at` entry in that file's column
   matrix at `:667` is **`mcp_api_keys`**, a different table, and is untouched); it appeared in
   exactly one assertion (`server/src/__tests__/secret-broker.integration.test.ts`, which still
   asserts its **presence** and flips to absence in the contract commit); and
   `0250_condemned_warbird.sql:23` added it nullable with no default and no
   backfill, so no row could carry a non-null value.
   **The retirement forecloses nothing:** `status` and its deny —
   `if (h.status !== "active") return "handle_revoked"` in `authorizeSecretResolve`
   (`packages/db/src/repositories/tenant/job-fence.ts:293`) — are retained unchanged, and are the
   surface a future per-handle revocation arms with **one** mutator.
   **The residual is now stated in the register rather than implied:** revocation blast radius is
   the whole device, not one secret. *Still open here:* broker-owned refresh throws unconditionally
   (`server/src/services/execution-secret-brokers.ts:58-61`), which is why DE-07 remains `partial`.
3. **DE-10 (High) — orphan sandbox destruction is armed by nothing committed to this
   repository, twice over.** Server-side: `reconcile-reaper.ts:192` destroys, reached from
   `bin/adapter-manager.ts:228`
   → `reaper-loop.ts` — but only when `resolveReaperConfig` returns `enabled`, which requires
   `AOA_ADAPTER_MANAGER_REAPER_ENABLED` to trim to **exactly** `"1"` (`reaper-loop.ts:55`). A
   whole-tree grep finds that variable in docs, code and one test — and in **zero** deployment
   manifests, so **no committed manifest starts the loop**. Worker-side: WRK-007's restart
   reconciliation is the
   same dead `createStartupReconciler` as (1) — `bootstrapWorkerDaemon` builds an empty step list
   when no reconciler is injected (`packages/worker-daemon/src/bin/worker-daemon.ts:603`, whose
   own comment at `:601` says *"the current default"*), and neither production entry point injects
   one. Consequence: **no startup path reclaims a crashed worker's sandbox** — the worker-side
   half is dead code that no setting can arm — **and nothing records that it was not reclaimed**,
   unconditionally, since no code writes such a record on any path.
   ★ **Amended 2026-09-09 (W22B).** This item read *"disarmed in every deployment"*, *"the loop
   is never started"*, and *"reclaimed only by the provider's own 60s TTL, and nothing in this
   system reclaims it"*. Those are three present-tense absolutes about the **server-side** half
   that a source grep cannot support: `AOA_ADAPTER_MANAGER_REAPER_ENABLED` can be set out of
   band — an orchestrator secret, a `.env`, an operator export — and arms the loop with **no
   repository change at all**. Whether it runs in the deployed system is `UNKNOWN` pending an
   inspection of the running adapter-manager's environment. **The finding's verdict does not
   move**: the destroy half still fails on the worker-side code gap regardless, and the register
   row (`DE-10`, `deliveryStatus: partial`) was corrected in the same direction on the same day —
   this item is the derived half of that correction, and it was missed on the first pass.
4. **DE-12 (Critical) — the submit-time generation deny still cannot refuse in production; its
   "no writer" and "nothing submits `service_reconcile`" premises have since fallen.**
   ★ **Amended 2026-09-10 — re-measured at `a5d27555b`. Two of this item's original premises are
   now FALSE; the item stays OPEN because the deny is still unreachable-as-a-refusal, for a NEW
   reason.** The deny is `serviceSourceIsAdmitted`
   (`packages/db/src/repositories/tenant/job-control.ts:2718`, predicate
   `eq(services.generation, input.generation)` at `:2726`, returning `null` on mismatch), taken at
   `server/src/services/job-submission.ts:239` (`if (!executionPrincipal) throw denial();`, closing
   the `service_reconcile` arm opened at `:232`). *(The originally-cited `job-control.ts:1667-1679`
   / `:1675` deny is stale — no such deny is there at HEAD.)*
   **Premise (i) FELL — `services.generation` now HAS a writer.** `repos.jobControl.bumpServiceGeneration`
   (`job-control.ts:3135`, `.update(services).set({ generation })` as a compare-and-set gated on
   `eq(services.generation, input.expectedGeneration)`), reached from
   `rollServiceGenerationWithinTenant` / `rollServiceGeneration`
   (`server/src/services/service-generation-rollout.ts:274,391`, calling the repo at `:316`) via
   `POST /organizations/:organizationId/companies/:companyId/services/:serviceId/generation` on
   `jobControlRoutes`, mounted at `server/src/app.ts:498` under `distributedExecutionEnabled`
   (SVC-005a). The original sentence looked at the wrong namespace: `repos.services` still exposes no
   `update` (`packages/db/src/repositories/tenant/index.ts:215-226`), but the writer lives on
   `repos.jobControl`. There is now a second `update(services)` too — `updateServiceDesiredState`
   (`job-control.ts:3004`, SVC-007a).
   **Premise (ii) FELL — a `system` principal now submits `service_reconcile`.**
   `reconcileServiceWithinTenant` (`server/src/services/service-reconciler.ts:301`) calls
   `submitJobWithinTenant` with `principal: { kind: "system", id: companyId }` (:309) and
   `source.kind: "service_reconcile"` (:313); `createServiceReconciler` is armed on a timer at
   `server/src/index.ts:1413-1440` inside the same `distributedExecutionEnabled` block. So the
   `service_reconcile` arm at `job-submission.ts:232-239` IS reached in production, refuting the old
   "the only `system` producer is `one-shot-sandbox-cli.ts:293`, which submits `one_shot`." The
   requester-kind gate itself is unchanged (`SOURCE_REQUESTER_KINDS.service_reconcile = ["system"]`,
   `job-submission.ts:104`, enforced `:174`/`:176`).
   **What SURVIVES — the deny still cannot fire.** The sole production submitter (the reconciler)
   reads `services.generation` under a `SELECT ... FOR UPDATE` row lock (`lockServiceForReconcile`,
   `job-control.ts:2746`) and submits the matching `source.generation` in the SAME transaction, so
   the predicate always matches — the mismatch→null→denial branch is never taken. `serviceSourceIsAdmitted`'s
   own docstring states its residual value lives "entirely in the OTHER callers: a replayed
   submission, SVC-007's future controls, a direct call," none of which are production submitters
   today. So the deny is unreachable-as-a-refusal for a NEW reason (one always-matching internal
   caller), not the old one (no caller at all). *(Note: SVC-005a also added a separate,
   genuinely-reachable cross-generation PLACEMENT fence — `predecessor_generation_unwitnessed`,
   `service-reconciler.ts:266-276` — but that is not the submit-time deny DE-12 item 4 cites, so it
   does not flip this clause.)* **This item stays OPEN** for the UNREACHABLE-DENIAL reason established above — the sole production
   submitter (the reconciler) always supplies a matching generation, so the submit-time deny can
   never refuse. It does NOT stay open for the audit conjuncts 3a/3b: those are E0-F013's audit
   clause (dropped vacuous by Decision 1), a separate finding, not E0-F011's arming-path concern. ★ **CORRECTED 2026-09-11 (E0-F013 Decision 1):** the earlier claim that DE-12's
   residual AUDIT clause ("partition, drain, and generation changes are audited") is a
   `logger.info`-only line is STALE. Conjunct **3c (generation changes) is DELIVERED** — a roll writes
   exactly ONE durable `service.generation_roll` `activity_log` row via
   `recordServiceGenerationRollActivity` (`service-control-audit.ts:317`, called at
   `service-generation-rollout.ts:415`), proven RED-first by R-T11. DE-12's live audit residual is now
   only **3a (partition)** and **3b (drain)**, amended as VACUOUS by Decision 1 for want of a partition
   detector (3a) and a reconciler-driven producer of the frozen drain/graceful_stop control-command
   kinds (3b; E9-F008; see register DE-12 and E9-F012 / E9-F009 §3). The register row was FURTHER
   corrected in this direction on 2026-09-11.

**Why each is HIGH.** (1) and (3) are silent data/resource losses — a late result is dropped rather
than quarantined, and an orphan sandbox is billable. (2) meant, as filed, that the only revocation
story for a resolved execution secret was fence expiry; ★ **as of the 2026-09-09 ruling the
operator lever is `revokeWorker`, which is real but DEVICE-GRAINED** — an operator who learns one
handle is compromised must revoke the whole device — and (2) stays HIGH on its broker-refresh
half. (4) ★ **re-measured 2026-09-10:** DE-12's `failureMode` — *"two service instances act as
active simultaneously"* — now HAS controls that exist and run (the armed reconciler, the
`services.generation` writer, and the cross-generation placement fence); ★ **CORRECTED 2026-09-11:** the
generation-change audit (conjunct 3c) is now DELIVERED (`recordServiceGenerationRollActivity`,
R-T11); what remains undelivered is the PARTITION (3a) and DRAIN (3b) audit, amended as vacuous by
Decision 1 — not the control itself. (Previously stated as "no control at
all, only a gate that nothing can reach" — that was true at filing and is false at HEAD.)

**What it is NOT.** None of the four is a *wrong* implementation. Each ticket's own result document
is honest about its scope (`WRK-007-result.md`: *"inert-until-wired (E4-D12)"*;
`CLI-004-result.md` residual risk 2: *"No live periodic reconciliation LOOP"*;
`SVC-001-terrain.md:216-218` explicitly disclaims DE-12). The defect is that the **register**
carried none of that, so four Critical/High crossings read as chartered-and-owned while their
controls could not fire.

- **Affected crossings:** DE-05, DE-07, DE-10, DE-12.
- **Disposition:** `unowned` for the class. Per-item ownership is uneven and is stated in the
  ownership manifest entry: (3)'s server half needs four environment settings and no code (the
  experiment is written out in `docs/replatform/DE-AUDIT-live-experiments.md`); (1) and (3)'s
  worker half need the E4-D12 composition-root wiring, which no ticket on disk carries; (2) needed
  *a revoke mutator or the deletion of the dead clause* and ★ **took the second route on
  2026-09-09** — the READER was removed and the clause now states the device-grained cutoff. ★ The
  column itself is **RETAINED**: `job_secret_handles.revoked_at` is now declared-but-unread, its
  `DROP` was withdrawn from this release (an N-1 binary would still name it), and that `DROP` is the
  contract step, filed as `E0-F017`. So what remains of (2) is only broker-owned refresh; (4) needs
  SVC-002/003/005, none of which are written. NOT `accepted`: HIGH may never be accepted.
- **Resolution condition:** for each item, either the arming path gains a production caller and
  the crossing is re-measured, or the clause is deleted from the register — *a guard that nothing
  can arm is the failure class this programme has already shipped three times.* Resolve = flip this
  Status and delete the `E0-F011` key in `scripts/finding-ownership.json` in the SAME commit.

## E0-F012 — Three crossings name a mechanism that no code anywhere attempts: a capability restriction never passed to the provider, a fair-share scheduler with no tenant term in its ORDER BY, and a "scoped service identity" that is one bucket-wide credential

- **Status:** open
- **Severity:** HIGH
- **Filed:** 2026-09-08, by W20 (the DE-audit landing unit).
- **Blocks gate:** No.

**How this differs from `E0-F011`.** There the mechanism is built and its arming path is dead. Here
there is no mechanism: the clause names a control and the codebase contains no attempt at it. The
distinction matters for remediation — `E0-F011`'s items are wiring or configuration; these are
design work, and one of them may not be expressible at all against the current provider.

1. **DE-09 (Critical), `integrity`: "image and capability restrictions prevent host command
   execution."** The only path that creates a provider sandbox is
   `packages/sandbox-e2b-provider/src/real-transport.ts:98-103`, and it passes exactly
   `{ apiKey, timeoutMs, metadata, envs }` to `sdk.create`. **No capability, user, seccomp or
   isolation configuration is passed at any point.** The one object in the tree that looks like the
   control — `CLI_001_CAPABILITY_MATRIX` (`packages/sandbox-e2b-provider/src/capability-matrix.ts:59`)
   — is a **typed fixture**: its only references outside its own module are the barrel re-exports at
   `packages/sandbox-e2b-provider/src/index.ts:49,55`. It is a declaration, and a declaration is not
   enforcement. ★ Before anyone writes an enforcement point here, the prior question must be settled
   against the pinned e2b SDK and the `e2b/` template definition: **is a capability restriction
   expressible on create at all?** If it is not, this clause is not implementable as written and the
   row must be AMENDED rather than marked delivered. The experiment is written out in
   `docs/replatform/DE-AUDIT-live-experiments.md` (DE-09, experiments 1 and 3).
   *What DE-09 does have* is a structural property — no host-execution path for a tenant command
   exists to refuse — plus real denies on adjacent controls (`effect-authority.ts:88`,
   `cleanup-authority.ts:159,164`, `compose-dispatch.ts:103`, `adapter-manager.ts:120-180`,
   and `GIT_HARDENING_FLAGS` at `snapshot/git-runner.ts:43`). That is why the row is `partial`.
   It is **not** why the `integrity` clause is satisfied; a structural absence is not a capability
   restriction, and it degrades the moment a host-exec path is added.
2. **DE-13 (High), `integrity`: "fair-share scheduling prevents monopolizing capacity."** The
   scheduler's candidate claim orders by
   `asc(jobs.availableAt), desc(jobs.priority), asc(jobs.createdAt), asc(jobs.id)`
   (`packages/db/src/repositories/tenant/job-control.ts:1981`). **There is no tenant term in that
   ordering, and no per-tenant round-robin, weighting or borrow limit anywhere.** What ships is
   per-Organization *admission* (a cap, `server/src/services/org-concurrency.ts:274`) and a poll
   *throttle* (`server/src/services/worker-admission-rate-limit.ts:147`) — both real, both
   measured denying, neither a scheduler. A second organization's first job therefore waits behind
   every in-flight attempt of a backlogged first organization, bounded only by that organization's
   own cap and by attempt duration. That window is precisely DE-13's `failureMode`.
3. **DE-06 (Critical), `authentication`: "scoped service identity; presigned grants signed by the
   broker."** There is one static credential set, constructed twice for two endpoints
   (`server/src/storage/s3-provider.ts:86-102`), and it signs every grant for every tenant. A grep
   for `AssumeRole|STSClient|@aws-sdk/client-sts` across `server/` and `packages/` returns **zero**
   hits, so no per-tenant or per-lease credential scoping exists or is attempted. The *grants* are
   genuinely prefix-bound and short-lived (`artifact-transfer-grant.ts:113,201-202`;
   `artifact-grant-ttl.ts`), which is the half that holds; the *identity* signing them is
   bucket-wide. Whether the deployed credential is in fact bucket-wide is a one-command live check,
   recorded in the handover document.

**Why HIGH.** (1) is the `integrity` clause of a Critical crossing whose `failureMode` is
*"sandboxed code executes a command on the worker host"*, and it may be unbuildable as written —
which is a fact a founder needs, not a gap an engineer can close. (2) means DE-13's stated failure
mode has no control. (3) means a single credential compromise is bucket-wide rather than
tenant-scoped, i.e. the blast radius the clause exists to bound is unbounded.

- **Affected crossings:** DE-06, DE-09, DE-13. (DE-11's encryption and TTL clauses are the same
  class and are carried by `E8-F011`.)
- **Disposition:** `unowned`. DE-09's owner tickets WRK-004 and REL-004 both exist on disk and both
  shipped; neither claimed this clause — `WRK-004-result.md`'s security invariant is *"No local
  tenant spawn: … asserts zero calls"*, which is an accurate description of a test and an
  inaccurate description of an enforced control. DE-13's second owner, REL-002, has zero files and
  is deferred. DE-06's owner DAT-002 shipped and delivered the prefix/fence half. NOT `accepted`:
  HIGH may never be accepted.
- **Resolution condition:** for each item, either the mechanism is built and the crossing
  re-measured, or — for (1) especially — the clause is AMENDED to state what the provider can
  actually enforce. Amendment is a founder decision and is not taken here. Resolve = flip this
  Status and delete the `E0-F012` key in `scripts/finding-ownership.json` in the SAME commit.

## E0-F013 — The audit class, second cohort: nine more crossings assert that denials are audited, and on six of the nine the denial is still not recorded durably — DE-19 was closed on 2026-09-08, DE-20's audit clause was resolved by amendment on 2026-09-11 (Decision 1), and DE-27's audit clause was resolved on 2026-09-12 (admission conjunct delivered + partition amended vacuous); the remaining SIX are enumerated below

- **Status:** open — **6 of 9 remaining in THIS cohort (DE-20 struck 2026-09-11: 4a delivered + 4b amended vacuous by Decision 1; DE-27 struck 2026-09-12: both admission refusals delivered + partition amended vacuous); DE-19 CLOSED 2026-09-08. This cohort is
  UNCHANGED by BOTH 2026-09-10 units — the object-access unit closed DE-06 and the startup-audit
  unit closed DE-14, and both are members of `E0-F010`'s cohort, not this one.**
- ★ **THE AUTHORITATIVE CLASS-WIDE COUNT, as of 2026-09-13 (folding in the 2026-09-11 E0-F013
  Decision 1 update, the 2026-09-12 DE-27 admission-audit delivery, and the 2026-09-13 DE-13
  re-grade by the de13-audit-regrade unit; the
  dated snapshots below each said "ONE closed and SIXTEEN open" and were correct on their own
  date).** The denial-audit class is **SEVENTEEN** crossings — `E0-F010`'s eight plus this cohort's
  nine. **FOUR have a WHOLE `audit` clause, delivered end to end: DE-19 (2026-09-08), DE-06
  (2026-09-10), DE-14 (2026-09-10, later the same day) and DE-13 (2026-09-13 — both of its quota
  deny sites audited per-refusal via `recordWorkerAdmissionDenial`; unlike DE-27 its clause
  carries no cross-replica/partition language, so no amendment was needed — see its `E0-F010`
  table row).** ★ **THREE were RESOLVED with an
  amended-vacuous conjunct — DE-12 (`E0-F010`) and DE-20 (this cohort) on 2026-09-11 under E0-F013
  Decision 1, and DE-27 (this cohort) on 2026-09-12:** each has one conjunct delivered and its
  remaining conjunct(s) amended as vacuous, so each LEAVES its audit-gap cohort while staying
  `partial` in the register. (DE-12's and DE-20's delivered conjuncts predated the ruling and needed
  only the amendment to leave; DE-27's delivered conjunct — the two admission refusals — was WIRED on
  2026-09-12, so its resolution is delivery of one conjunct PLUS the Decision-1 amendment of the
  other.) Resolution-by-amendment is a SEPARATE category
  from whole delivery — the whole-delivered count is FOUR as of 2026-09-13. The "closable ever"
  ceiling is SIXTEEN under convention (ii) — the convention this class already applies, since DE-06
  and DE-14 count as closable though their register rows stay `partial`. An amended-honest clause is
  resolved for ceiling purposes; the unbuilt underlying controls are charged to E0-F011/E0-F014, not
  to this ceiling. 17 − 1 (DE-17, whose 6b escalation half is blocked on an unbuilt post-fence
  carrier / authority-typing mechanism) = 16. This ceiling is DISTINCT from the open count below
  (10 open); of the 16 closable, 7 are already resolved, so 9 more remain closable. `partial`
  status is not decisive — see decision paper §7 and §8 1.7. **SEVEN audit clauses are therefore no longer open (four whole + three amended), and
  TEN remain open** — DE-01, DE-03, DE-04, DE-11 in `E0-F010`, and DE-15, DE-16, DE-17,
  DE-18, DE-21, DE-29 here. **Of those TEN, exactly THREE carried a delivered fraction of a
  conjunction as of 2026-09-11 (★ FOUR since 2026-09-13 — DE-29's wrong-owner-denial conjunct is now delivered, see its row) and none of them counts as closed:** DE-03 (replay-rejection and the
  organization-attested worker-authentication refusals wired; enrollment and session-issue have no
  writer at all), DE-11 (both halves now have a live writer, but the coverage caveat holds it open
  — see the Group D bullet below and the DE-11 re-measurement in `E0-F010`), and DE-21 (five deny
  disjuncts across two of seven branches; the subscribe and replay conjuncts have no writer at
  all). *(DE-20 was a fourth fraction until 2026-09-11; its audit clause is now resolved by
  amendment and it has left the open set.)*
- ★ **THE DERIVATION BELOW IS THE 2026-09-10 RE-COUNT OF THE FRACTIONS; UPDATED 2026-09-11:** DE-20
  has since left the fraction set — its audit clause is now RESOLVED BY AMENDMENT (E0-F013 Decision
  1). The three named fractions above (DE-03, DE-11, DE-21) are facts, but the EXHAUSTIVENESS proof
  below — the ten-module writer census concluding "no other open crossing carries a fraction" — is
  PRE-RULING and is NOT re-derived here: it predates `server/src/services/service-control-audit.ts`
  (`recordServiceGenerationRollActivity`, which writes DE-12's `service.generation_roll` / 3c row),
  so the current inventory is ELEVEN modules, not ten, and DE-12/DE-20 have both left the cohort.
  The post-ruling writer inventory and fraction recount are DEFERRED to the dedicated count
  re-derivation; the enumeration below is kept as the 2026-09-10 derivation, not the current one.
  ★ **THAT "FOUR" WAS RE-COUNTED AT HEAD, NOT DECREMENTED BY ONE (the 2026-09-10 derivation, retained below).** DE-14 was never among the four —
  its clause is single-conjunct, so it had no fraction of a conjunction to carry — so its closure
  moves the open count and leaves the fraction count where it was. That is an observation, not an
  adjustment. **The method: enumerate every module in the tree at this commit that WRITES one of
  this class's audit records — the reserved `security.denied.` / `security.object_access.`
  namespaces and the crossing-specific record points — and map each to the crossing whose `audit`
  clause it serves**, rather than re-reading the previous count. (The generic product writer
  `activity-log.ts` is the sink they all insert through and is not one of them.) All ten, named so
  the enumeration can be checked and not merely trusted —
  `server/src/services/security-denial-audit.ts` (DE-19's deny half, and the shared sink),
  `memory-retrieval-audit.ts` (DE-19's retrieval half, pre-existing),
  `artifact-denial-audit.ts` and `artifact-object-access-audit.ts` (DE-06),
  `worker-denial-audit.ts` (DE-06's fence throws and DE-03's replay/authentication refusals),
  `artifact-retention-audit.ts` (DE-11), `cutover-selection-audit.ts` (DE-20),
  `server/src/realtime/live-events-denial-audit.ts` (DE-21),
  `server/src/config/hosted-execution-startup-audit.ts` (DE-14), and
  `job-audit-bridge.ts` — **which serves NO crossing's audit clause, because its writer still has
  ZERO production callers** (the Disposition bullet in `E0-F010` says so and it was re-checked
  here; only a type import survives). Every other module was checked for a production caller, not
  merely for existence. Subtract the three closed crossings and the four above are what is left:
  **no other crossing in the class has a writer at all**, so there is no fifth fraction to find.
  ★ **DE-15 is the row to check twice, and it is still NOT wired:** the Decision 2 ruling removed
  its STORAGE blocker and its register row says in terms that the wiring did not follow, and the
  drain return in `job-leasing.ts` still writes no row — this unit's own comment at that site pins
  it. A count-only, id-free metric — the DE-29 shape — is not a fraction of an `audit` clause and
  is not counted as one. **A larger fraction of a conjunction is still not a closure; what moved
  DE-06 was the OTHER conjunct, and what moved DE-14 was the only conjunct it had.** *(DE-06 and
  DE-14 are not among the fourteen and are not counted among the four. Both register rows
  nevertheless stay `partial`, and ★ **the two do NOT stay `partial` for the same reason, though
  DE-14's register row said they did until this commit corrected it there too.** DE-06 carries a
  DIFFERENT clause that is separately absent — `authentication`, under `E0-F012` — which is the
  DE-19 shape exactly (DE-19's row stays `partial` under `E0-F016`).
  **DE-14 does not.** Its evidence names exactly ONE absent clause, `audit`, and that clause is now
  delivered; what holds its row at `partial` is the register's finding-citation contract, which
  REFUSES `delivered` for any crossing a live finding names as a literal token
  (`check-distributed-execution-foundation.mjs` clause 4), and `E0-F010`'s ownership entry names
  DE-14 throughout. **No status change is taken here and none should be inferred:** whether a
  Critical row whose every audited clause now holds should become `delivered` is a separate
  question, it is entangled with `E0-F010`'s own resolution and with `REL-005` (zero files on disk,
  deferred), and it is recorded rather than answered so the next unit does not have to re-derive
  it.)*
- **Severity:** HIGH
- **Filed:** 2026-09-08, by W20B (the recovered-audit landing unit). Every citation below was
  measured at tip `4d5507a80` by the landing unit itself, not inherited from the auditor.
- **Blocks gate:** No — a detection gap, not an enforcement gap. Every crossing named here does deny.

**Why a sibling and not an edit to `E0-F010`.** `E0-F010` measured eight crossings and its count is
correct for the cohort it audited. These are **nine** *different* crossings, from the sixteen an
orchestration bug dropped out of W20's landing commit. Folding them in would have required
rewriting that finding's title, table and count in a wave whose whole subject is counts that stop
matching their data. The class is identical; the cohort is not.
*(★ CORRECTION, 2026-09-08. This paragraph said "eight *different* crossings" while the title, the
table, and the affected-crossings list all said nine. Nine is right — DE-15, DE-16, DE-17, DE-18,
DE-19, DE-20, DE-21, DE-27, DE-29 — and the count was re-verified against the table before this
edit. A finding whose subject is counts that stop matching their data had three counts and one of
them was wrong.)*

**★ TWO CORRECTIONS TO THIS FINDING'S OWN CHARACTERISATION (2026-09-08), made by the unit that
closed DE-19.** Both were found by re-measuring the citations rather than re-reading the prose.

1. **The title's clause "on the other four the success path is recorded and the refusal is not" is
   FALSE for DE-16.** It holds for DE-18. *(★ DE-19 has since closed (2026-09-08) and DE-20's legacy 'refusal' arm is now recorded per Decision 1 — `buildCutoverSelectionEvent`, both arms; see the DE-20 row.)* On DE-16 what is recorded is the
   **refusal itself** — `recordCloudPluginBlock` (`server/src/services/cloud-plugin-execution.ts:225-247`)
   emits a `logger.warn` on the deny path carrying `pluginId`, `companyId`, `activationSource`,
   `sink` and `reasonCode` — and the *success* path is not recorded at all. This finding's own
   DE-16 table row says so correctly ("unlike the rest of this table there IS a log line"); it is
   the title that generalises past its data. The **5/4 split is correct** and was re-verified; only
   the description of the four is wrong. The title above has been rewritten to enumerate rather
   than characterise.
2. **DE-29's row header "Nothing, by ordering" applies a different standard than `E0-F010` applied
   to DE-06, on the same evidence.** The row's own body then names the trace: an anonymous
   `metrics?.secretRead({outcome:"denied", count:1})` tick at
   `server/src/services/secret-broker.ts:328`, count-only and compile-closed against ids
   (`job-control-metrics.ts:29`). That is the *same category* as DE-06's rejected-commit metric,
   which `E0-F010` explicitly refused to call "nothing" — "this is the one row in the table where
   'nothing' would be wrong". Read DE-29's "Nothing" as **"nothing attributable"**: the tick is
   real, it carries no handle, owner, company or reason, and it therefore satisfies no clause in
   this class. The substance of the finding is unchanged; the standard is now the same in both
   siblings.

**★ DE-19 IS CLOSED (2026-09-08).** Its audit clause — "context retrieval and denials are recorded
in the retrieval audit" — is delivered against a named record point with a production caller:
`recordSecurityDenial` (`server/src/services/security-denial-audit.ts:125`), called from
`handleMemoryGet`'s `denyMemoryGet` closure (`server/src/mcp/tools/read-tools.ts:297`) on all three
deny branches (`:339` `not_visible`, `:342` `not_approved`, `:351` `actor_filter_denied`). The row
lands in `activity_log` under a reserved `security.denied.*` action namespace and carries WHO
(`actor_type`/`actor_id`), TENANT (`company_id`), RESOURCE (`entity_type`/`entity_id`) and WHY
(`details.reason`). Proven by provoking the real refusal, not by reading a record back:
`server/src/__tests__/de-19-memory-denial-audit.integration.test.ts:298` (attribution), `:322`
(the reason is read from the branch, not stamped), `:337` (positive control — the same path
succeeding writes NO denial row and still writes its `memory_retrievals` success row). Observed
RED against the pre-change tree, and four mutants killed. Enrolled as `E0-de19-denial-audit` in
`scripts/gate-clause-wiring.json` in the same commit. **DE-19 stays `partial` in the threat
register**: its `authentication`, `revocation` and `integrity` clauses are separately absent and
are carried by `E0-F016`. **Not closed within DE-19:** `memory.search`'s refusals, which are the
DE-01 empty-read shape (the in-SQL gate removes rows from a query that then SUCCEEDS, so there is
no discrete refusal event to intercept).

| Crossing | `audit` clause, verbatim | The line that denies | What records it |
|---|---|---|---|
| DE-15 (Critical) | "image admission, scan, and kill events are audited" | `server/src/services/job-leasing.ts:731-740` — the kill-switch drain return. | **Nothing.** The block constructs and returns the poll response and exits the transaction: no repository call, no `activity_log` row, no metric. The `metrics` object in scope records certificate scans, not kill verdicts. |
| DE-16 (Critical) | "blocked plugin routes, dispatch, and reconciliations are audited" | `server/src/services/cloud-plugin-execution.ts:254`; the 503 helper at `server/src/routes/plugins.ts:381`. | **★ PARTLY DELIVERED (updated 2026-09-13), a THREE-part conjunction.** (i) **Routes + BOARD dispatch — DELIVERED** (Decision 3.2, 2026-09-11): the eight `companyId`-bearing 503 route sinks (incl. the board `/plugins/tools/execute` dispatch route + the rollback) write a bounded, tenantless operator-sink row via `recordCloudPluginDenial` → `security.denied.cloud_plugin_execution` (`server/src/services/cloud-plugin-denial-audit.ts`), `company_id` NULL, caller-supplied company in `entity_id`. **★ (i-GAP) the MCP AGENT dispatch path — DELIVERED 2026-09-13** (this unit): `dispatchPluginToolCall` (`server/src/mcp/tools/plugin-broker-tools.ts`, sole prod caller `server/src/mcp/server.ts` tools/call) now writes one durable `security.denied.cloud_plugin_dispatch` row on the cloud block, for the fully-attributable agent-run case only — real FK-valid `company_id` (broker-validated, not caller-supplied), `actor_type="agent"`, `actor_id`=the verified agentId, `entity_type="plugin_tool"`/`entity_id`=the tool name, `details.runId`, crossing DE-16 — via `recordCloudPluginDispatchDenial` (`server/src/services/cloud-plugin-dispatch-denial-audit.ts`), a THIRD shape distinct from the board-route company-NULL per-IP sink and the system-actor reconcile row. A non-agent / run-less blocked call is this service's own actor-gate refusal (rejected next) and records nothing. Proven RED-first by `server/src/__tests__/de-16-dispatch-denial-audit.integration.test.ts` (THE RECORD arm observed RED without the wiring; SCOPE arm asserts the non-agent block writes no row). So all three of "routes, dispatch, and reconciliations" now have an attributable writer. (ii) **Reconciliations — DELIVERED 2026-09-13, atomically + row-locked** (Codex P1+P2 on PR #446, all three findings accepted): each stale row is reconciled by `reconcileOnePluginToBlocked` (`server/src/services/plugin-lifecycle.ts:116`) inside ONE transaction — a **`SELECT … FOR UPDATE` lock-claim** that (a) serializes concurrent replicas so a loser reads the now-blocked row and records nothing (P2 double-write), and (b) captures `priorStatus` from the status read UNDER the lock, not the stale `listInstalled()` snapshot, so a `ready→disabled` change in that window is logged as moving from `disabled` (P2 stale-prior-status on `943d3fed5`) — then `recordCloudPluginReconcileToBlocked` (`server/src/services/cloud-plugin-reconcile-audit.ts`) on the SAME tx, which now **throws** on a failed insert so the flip rolls back and the transition is retried next boot rather than left blocked-but-unaudited (P1; AGENTS.md log-mutations-atomically). Writes ONE durable `activity_log` row per transition — real-tenant `company_id`, `actor_type="system"`, `actor_id="cloud-plugin-boot-reconciliation"`, action `security.reconcile.cloud_plugin_blocked` (reserved, NON-denial namespace), `details.priorStatus`. Proven RED-first by `server/src/__tests__/de-16-reconciliation-audit.integration.test.ts` (7 arms incl. LOCKED-CLAIM + TRUE-PRIOR-STATUS + ATOMIC-ROLLBACK, each observed RED against its own targeted mutation). The prior "no row is written anywhere / process-memory counter resets on restart" (`recordCloudPluginBlock`) is now true only of the lifecycle-activation block sink. DE-16 stays `partial` (all THREE audit-clause conjuncts now have a writer, but the non-audit clauses — TTL/confidentiality unknown, REL-005 zero files — are untouched, and the finding-citation contract holds the register row `partial`). |
| DE-17 (Critical) | "post-fence cleanup and denied escalations are audited" | `packages/adapter-manager/src/owned-op-gate.ts:154-156`; `packages/worker-daemon/src/supervisor/cleanup-authority.ts:127-144,162-165`. | **Nothing.** `owned-op-gate.ts` and `create-gate.ts` contain zero matches for `logger|console.|audit|metric`; the only such matches in `adapter-manager/src/server.ts` are the reaper sweep counter. A whole-tree sweep shows **nothing anywhere catches or logs `CleanupAuthorityDeniedError`** — every reference is a throw site, a class declaration, a barrel re-export or a conformance assertion. |
| DE-18 (Critical) | "placement decisions and generation changes are audited" | `packages/db/src/repositories/tenant/job-control.ts:1177` / `:1167`. | **Partly.** A generation bump does write one durable `execution_target_revocations` row. Every *denial* the fence then produces returns as a protocol error with no row, no metric and no log line. **★ NARROWED 2026-09-12 by the DE-04+DE-18 fence-denial-audit unit:** the `target_revoked → DE-18` fence-arm MAPPING is now wired — a `target_revoked` refusal at guardActiveFence (current throw `job-control.ts:1966`) is keyed to DE-18 (`FENCE_GUARD_CROSSING_BY_REASON`) and written as a `security.denied.fence_guard` row (`actorId=workerId`, company+org scoped, `details.targetGeneration`), `server/src/services/fence-denial-audit.ts`. ★ Reachability, honest: the worker services pre-empt `target_revoked` at their integrity check (`JobLeasingError`), so production worker traffic does NOT reach the DE-18 fence-arm deny at guardActiveFence; the one governed mutator that takes a raw fence with no service pre-check is `completeAttempt` (`job-output-bridge`), which currently has NO production caller (live terminal path is `onAttemptTerminal`→heartbeat projection) — a CURRENTLY-DORMANT / defense-in-depth path, proven RED-first as the one arm exercising `target_revoked→DE-18` in `de-04-18-fence-denial-audit.integration.test.ts`. ★ 2026-09-13 (fence follow-on): the patch-apply/secret-resolve fence catches drain to the same recorder now too, but for `target_revoked` those two are RACE-ONLY (their pre-check covers target state). ★ 2026-09-13 (fence follow-on, slice 2): the admission arm (`job-leasing.ts:poll`) and the session arm (`worker-session-auth.ts` verifyCurrent recheck + shared-platform physical recheck → `security.denied.worker_session`) began recording the generation-cutoff `target_revoked` refusals under DE-18 (`poll_generation_superseded` in `security.denied.worker_poll_authority`; `details.failed` includes `generation_drift`), with non-generation refusals and the `registerProofBoundHeartbeat` branches left as a documented follow-on (Codex P2 x4 on PR #448); proven RED-first over embedded PG (`de-18-admission-session-revoked-audit.integration.test.ts` + a new arm in `worker-session-renewal.integration.test.ts`). ★ 2026-09-13 (slice 3 — that follow-on delivered): `registerProofBoundHeartbeat`'s six refusal branches now audit via a per-branch generation RE-READ of the same authority row each boolean write predicates on (`classifyPlatformHeartbeatRefusal` / `classifyTenantHeartbeatRefusal` → `security.denied.worker_session`, reason `heartbeat_authority_revoked`, `details.branch`), and every poll/session/heartbeat NON-generation authority-currency refusal now records under DE-04's worker-authority-currency arm (register amendment 2026-09-13; poll reason `poll_authority_stale`, session reasons incl. the new `session_credential_drift`) — the crossing derived per-row from the actual failed conjunct list (`deriveWorkerSessionCrossing`), never a composite boolean, and a caller-forgeable `request_generation` claim never mints DE-18. Deliberately still unrecorded: the poll post-authority data-integrity refusals (no crossing's clause) and a heartbeat refusal whose re-read names no failed conjunct (lost race — a documented gap, not a guess). Proven RED-first + guard-deletion mutation coverage (`worker-authority-denial-classifiers.test.ts`). STILL open, split per the 2026-09-14 Option-B ruling (`docs/replatform/DECISION-REQUEST-job003-ack-drain.md`): the ack-path `target_revoked` arms (+ the seventh `recordProof` site) are UNBLOCKED by that ruling — the hardened `.finally` ack-drain amendment is adopted; build pending, nothing delivered yet — while `guardPlatformAuthority`'s two shared-platform throws are attributed to **DEFERRED-DECISION: guardPlatformAuthority denial sink** (a named, owner-visible future decision, not accepted-as-gap; their blocker is the pinned helper/call shape, not the ack drain), plus the placement-filter half (`job-placement-transaction.ts` null-drop is a FILTER, not a presented-request refusal). The DE-18 denial-audit gap is NARROWED; the formal re-grade + cohort/count re-derivation is DEFERRED (cf. the DE-13 row). DE-18 stays `partial` and STILL listed in this cohort. (No count or cohort change is taken here.) |
| ~~DE-19 (Critical)~~ **CLOSED 2026-09-08** | "context retrieval and denials are recorded in the retrieval audit" | `read-tools.ts:339` / `:342` / `:351`, all via the `denyMemoryGet` closure at `:297`. | **Was: Half** — retrieval *was* recorded (`recordMemoryRetrievals` runs after the gate) and **both deny returns sat before it**, so a refused memory read wrote nothing. **Now:** each deny awaits `recordSecurityDenial` (`security-denial-audit.ts:125`), writing one attributable `security.denied.memory_read` row to `activity_log` (WHO/TENANT/RESOURCE/WHY) before returning the same non-disclosing message. Proven by provocation at `de-19-memory-denial-audit.integration.test.ts:298`/`:322`/`:337`. `memory.search`'s refusals remain uncovered — they are the DE-01 empty-read shape. |
| ~~DE-20 (Critical)~~ — **AUDIT CLAUSE RESOLVED BY AMENDMENT 2026-09-11 (Decision 1); STRUCK FROM THIS COHORT** | "cutover selection and rollback transitions are audited" | `buildCutoverSelectionEvent` append at `server/src/services/heartbeat.ts:5388`, before the `shouldSuppressLegacyExecution` gate (cited by symbol; the older `:5399`→`:5451` line numbers were stale). | **RESOLVED BY AMENDMENT (Decision 1).** 4a (cutover selection): DELIVERED for BOTH arms — one unconditional append at heartbeat.ts:5388 (buildCutoverSelectionEvent, TOTAL over RunExecutionOwner, W20-B 2026-09-10) writes a distributed_execution_selection row for distributed AND legacy. 4b (rollback transitions): AMENDED as VACUOUS — createDistributedExecutionDrain (job-distributed-drain.ts:114) has zero production callers, so no rollback transition occurs. Audit clause resolved; DE-20 leaves this cohort and stays `partial` in the register (its revocation clause still has no chartered exit — E0-F014/REL-005). |
| DE-21 (High) | "subscribe, replay, and denial events are audited" | `server/src/realtime/live-events-ws.ts:1077-1079`; the deny decisions are `authorizeUpgrade`'s seven `return null` branches. | **★ PARTLY, since 2026-09-09 (Unit C) — FIVE deny DISJUNCTS, across TWO of the seven branches (and one of those two only by half), and neither of the other two conjuncts.** Now recorded: `:376`'s `key.companyId !== companyId` arm (one of that branch's two arms) and all four `:395` disjuncts, each writing one attributable `security.denied.live_events_upgrade` row filed under the KEY's own company (`agent_api_keys.company_id`, NOT NULL + FK), never the probed one. Still **nothing**: `:376`'s `!key` arm (no key row → no DB-resolved company: Decision 3), the five board/session branches (`:293`/`:304`/`:311`/`:322`/`:358` — `:358` measured and excluded, see Unit C below), and the "subscribe" and "replay" conjuncts, which are not denial events at all and have no writer. **Was, and still is the shape of everything above:** the 403 calls `rejectUpgrade`, whose entire body (`:106-112`) writes an HTTP status line to the socket and destroys it. The file *does* import `logger` (`:15`) and call it at eight sites — including `logger.error` at `:1090`, which fires only when the authorization function **threw**. So an internal fault is loud and an unknown-token probe is still silent. |
| ~~DE-27 (High)~~ — **AUDIT CLAUSE DELIVERED 2026-09-12 (admission conjunct wired + partition amended vacuous by Decision 1); STRUCK FROM THIS COHORT** | "cross-replica admission and partition events are audited" | `server/src/services/worker-admission-rate-limit.ts:admit` (over_cap); `server/src/services/org-concurrency.ts:admitAttemptCapacity` (capacity). | ~~**Nothing recorded yet.**~~ ★ **DELIVERED 2026-09-12 (the admission-audit unit):** under the WEAK reading adopted by Decision 1.2(c), BOTH admission refusals are now durably recorded through the shared recorder `recordWorkerAdmissionDenial` (`worker-admission-denial-audit.ts`), each writing an attributable `security.denied.worker_admission` `activity_log` row (WHO = the specific refused principal — `actor_id` = the refused `workerId` for over_cap, the submitting `principal.id` for capacity, with `principalKind` in `details`; `actor_type` is PER-PATH — `system` for over_cap (the refused worker has no truthful `ActivityActorType`), and for capacity the submitter's TRUTHFUL type via `actorTypeForPrincipalKind`, aligned to the canonical `getActorInfo` (`agent`→agent; the userId-backed `user`/`commander`/`local_board`, each with a userId principal.id, →user; `mcp`→system because its submit-path principal.id is the authentication KEY id, not the owner userId, so recording it as user would misattribute [getActorInfo labels mcp user via the request-time owner userId, which the submit path lacks; full mcp attribution is a filed follow-up]; `worker`/`system`→system) — so a real human/board/Commander denial is a `user` action, not flattened to system — NEVER the org, which is the TENANT only; TENANT = the org (+company for capacity), RESOURCE = the poll-admission bucket / the attempt, WHY = reason `over_cap`\|`capacity` + crossing DE-27). The `over_cap` refusal writes directly on the pool handle (the shared-counter transaction has already committed), ONE row PER over-cap poll — each admission refusal durably recorded, per the founder-ruled weak reading (Decision 1.2(c)) and the DE-03/DE-06/DE-19 per-refusal deny-path pattern; each row carries its own `actorId` (the refused worker) and `details.count`. Per-window coalescing was considered and REJECTED (it would drop refusals the ruling requires be recorded); write-amplification from a looping worker is bounded by the poll rate limit + `activity_log` retention — a deny-path-wide property tracked separately, not a DE-27 deviation. The `capacity` refusal likewise records per-refusal — it captures an intent and is drained on the pool handle after the rolled-back submission transaction closes, at the three submit-path callers (`job-submission.ts`, `job-admission-bridge.ts`, `service-reconciler.ts`). Admission is DB-serialized across replicas, so — as Decision 1.2(c) ruled — no replica identity is required or implied (the zero-hit sweep still stands and is not a gap). The **partition** conjunct stays DROPPED as vacuous (no detector). Proven RED-first by `server/src/__tests__/de-27-admission-audit.integration.test.ts`; enrolled as `E0-de27-admission-audit` in `scripts/gate-clause-wiring.json`. **DE-27 leaves this cohort and stays `partial` in the register** (finding-citation contract + revocation not-delivered-as-named), exactly as DE-06/DE-14 left `E0-F010`. |
| DE-29 (Critical) | "grant routing and wrong-owner denials are audited" | The `SecretResolveRejection` throw in `resolveExecutionSecret` (`packages/db/src/repositories/tenant/job-control.ts`; the original measurement cited `:3122`, since drifted). | **★ WRONG-OWNER-DENIAL CONJUNCT DELIVERED 2026-09-13 (the fence follow-on / secret-resolve denial-audit unit).** Was: **Nothing, by ordering** — the audit UPDATE sat *after* the throw, so on a denial it never ran, and the only trace was the anonymous `secretRead{outcome,count}` tick that made a **wrong-owner denial forensically indistinguishable from a stale fence**. Now: every `SecretResolveRejection` — the pre-decision handle/job misses (`unknown_ref_kind`; an absent/foreign handle probe deliberately records here, since a foreign handle is absent-by-scoping) and every non-admit `authorizeSecretResolve` verdict — writes one durable, attributable `security.denied.secret_resolve` row carrying the REAL machine reason (`owner_binding_incomplete`, `handle_revoked`, …) while the wire stays coarse `malformed` — captured at the inner catch in `secret-broker.ts` (`captureSecretResolveDenial`) and drained on the pool handle after the tenant tx closes (`drainSecretResolveDenialSink`, `server/src/services/secret-resolve-denial-audit.ts`); the guardActiveFence refusals on the same resolve path (and on patch-apply) drain to the DE-04/DE-18 `fence_guard` recorder in the same unit. Proven RED-first through the REAL service over embedded PG (`secret-broker.integration.test.ts`, 4 new arms observed 3-RED/1-control-green against the unchanged wiring). **DE-29 STAYS in this cohort and `partial` in the register**: the grant-routing half of the clause and the separately-absent integrity/revocation clauses (E0-F016-shape) are untouched; NOT enrolled in `gate-clause-wiring.json` (half a conjunctive clause may not be enrolled). No cohort or count change is taken here. |

*(Nine rows; DE-24's audit clause is absent too, but for a different reason — there is no host-side
event to record because there is no host-side updater. It is carried by `E0-F014`.)*

**Why HIGH.** Two of these are worse than the `E0-F010` cohort rather than merely more of it.
DE-27's clause names a fact about the system — "cross-replica". ★ **AMENDED 2026-09-11 (E0-F013
Decision 1.2c):** under the adopted WEAK reading it is **not unwritable** — it is writable. DE-27's
cross-replica **admission** conjunct is ordinary Group B/C audit-write wiring (record the `over_cap`
+ capacity refusals at the two deny sites), needs no replica identity, and CAN be closed by wiring
those deny sites; the **partition** conjunct is dropped as vacuous. ★ **DELIVERED 2026-09-12:** that
wiring was done — both admission refusals are now recorded (see the DE-27 row above) — so DE-27 has
left this cohort, and its HIGH severity is now historical (the enforcement halves always held; it is
`partial` only under the finding-citation contract). DE-21 ships the counter-example to its own gap
in one file: the code knows how to log, and the one path it does not log is the security refusal.

**What it is NOT.** It is not a claim that any of these controls fail to deny. Every crossing here
is recorded `partial` precisely because its enforcement half was measured holding.

### ★ UNIT C, 2026-09-09 — the two halves the Decision 2 paper measured as unblocked are now wired, and NEITHER FINDING CLOSES

**The count first. Nothing is struck from any cohort.** `E0-F010` still carries all eight; the
seventeen-crossing denial-audit class still stands at ONE closed (DE-19) and SIXTEEN open. Unit C
delivered two more FRACTIONS of two clauses that are conjunctions, and a fraction closes nothing.
Striking a row here on this evidence is exactly the error PR #396 existed to correct.

**What was decided, and how.** The Decision 2 options paper (`docs/replatform/DECISION-REQUEST-unattributable-denial-sink.md`,
merged `bb0572f19`) re-measured four queued clause-halves at their deny lines and found two groups
that need a UNIT rather than a RULING. Unit C is that unit. Every line below was re-verified at the
source rather than inherited from the paper, and one of the paper's own suggestions was measured and
REJECTED (`:358`, below).

**(1) DE-06 — `resolveWorkerFenceContext`, 1 throw site of 6.**

- **What now writes:** the post-resolution tuple-integrity branch. One
  `security.denied.worker_fence_resolution` row per refusal, filed under the LOCKED LEASE's company,
  carrying WHO (`actor_id` = the refused `workerId`, `actor_type` = `system`), TENANT, RESOURCE
  (`entity_type` = `job_lease`, `entity_id` = the lease), and WHY (`reason` = `fence_tuple_mismatch`
  plus `details.mismatched`, the residual conjunct that actually fired). The worker's wire answer is
  the unchanged, coarse `stale_fence`.
- **What still writes nothing:** the other FIVE throw SITES — `:75` (proof replay), `:89` (one site,
  two codes: `unauthorized` when there is no authority, `target_revoked` when there is), `:92`
  (target inactive), `:97` (profile drift) and `:110` (no lease resolved). `workers` and
  `execution_targets` carry `organization_id` only, and the lease is what has not resolved. They
  remain Decision 2's.
- **★ THE COMPANY IS NOT ASSERTED, IT IS NARROWED.** `leases.company_id` is declared
  `uuid("company_id")` with NO `.notNull()` (`packages/db/src/schema/leases.ts:28`), and
  `!context.lease.companyId` is the FIRST disjunct of the very condition that throws. The value is
  present because `lockLeaseAckContext` inner-joins `jobAttempts` on
  `eq(jobAttempts.companyId, leases.companyId)` and `jobAttempts.companyId` is NOT NULL, so a
  null-company lease never joins and lands on `:110` instead. That is an argument about a JOIN, not a
  column, so the null disjunct is split into its own throw and the recorder reads a plain `string`.
- **★ WHICH CALLERS THIS REACHES, stated because the helper is shared by four services.** The sink
  parameter is REQUIRED, so **all four** compile against it and **all four** drain it:
  `artifact-commit.ts`, `artifact-transfer-grant.ts`, `patch-apply.ts`, `secret-broker.ts`. The last
  two had NO denial-audit wiring of any kind before this; they still have none for their own
  `rejected(...)` / `{denied: …}` returns — this is one throw site each, not a service-level closure.
- **What is still missing for DE-06 to close:** the "object put/get" conjunct (a SUCCESSFUL grant
  still writes nothing) AND the five residual fence throws. **DE-06 stays `partial` and stays in the
  cohort.** ★ **BOTH LANDED: the five residual fence throws by Unit A (2026-09-10) and the put/get
  conjunct by the object-access unit (2026-09-10). DE-06's audit clause is whole and DE-06 has left
  `E0-F010`'s cohort; it stays `partial` in the register for `E0-F012`'s `authentication` clause.
  See "★ THE OBJECT-ACCESS UNIT" under `E0-F010`. This bullet is kept as written because Unit C's
  own scope claim is only legible against it.**

**(2) DE-21 — `authorizeUpgrade`, FIVE deny disjuncts across TWO of its SEVEN branches.**
*(Counted as disjuncts, not branches, because that is the unit of correction here: `:395` contributes
all four of its disjuncts, `:376` contributes ONE of its two arms, and `:376`'s other arm is
explicitly not delivered. An earlier draft of this section said "4 disjuncts of 7 branches" — it
undercounted `:376`'s arm and read as though whole branches were being claimed. Corrected before
merge.)*

- **What now writes:** `:376`'s `key.companyId !== companyId` arm, and all four `:395` disjuncts
  (`agent_missing`, `agent_key_company_drift`, `agent_terminated`, `agent_pending_approval`). One
  `security.denied.live_events_upgrade` row each, filed under `key.companyId` — the tenant that OWNS
  the credential, never the tenant the probe reached for. `entity_id` is the REQUESTED company, so a
  cross-tenant probe is a row in tenant A naming tenant B, and tenant B's own log stays empty (the
  DE-19 non-disclosure precedent, asserted separately by test).
- **★ THE UNIT OF CORRECTION IS THE DISJUNCT, NOT THE BRANCH.** `:376` was a two-arm `||` whose arms
  differ on exactly the axis this turns on. The `!key` arm — an unknown, revoked or malformed token,
  and the DOMINANT probe case — resolves NO row, so there is no `key.companyId` at all and only the
  caller-supplied path segment is in hand. It is split out and writes nothing. It is Decision 3's,
  with branches 1-4.
- **★ `:358` WAS MEASURED FOR INCLUSION AND REJECTED.** The paper flagged it as possibly holding an
  FK-valid company because `memberships[]` is already SELECTed at `:343-352`. Measured at the line, it
  does not hold, for two independent reasons: **(a)** the branch fires when the actor has no
  `instance_admin` row AND no membership for the requested company, so a session holder with ZERO
  memberships — the shape a probe takes — reaches it with an EMPTY array and no FK-valid company
  whatsoever (pinned by a positive-control arm that provokes exactly that and asserts no row); and
  **(b)** when the array is non-empty its ids are the actor's OTHER tenants, none of which was asked
  for anything or refused anything, so choosing one is an attribution rule, not a wiring gap — the
  same category error §1.3 of the paper names for DE-15. `:358` stays open under Decision 3.
- **What is still missing for DE-21 to close:** the `!key` arm, the five board/session branches, and
  the "subscribe" and "replay" conjuncts, which have no writer at all. **DE-21 stays `partial` and
  stays in the cohort.**

**Evidence.** Both were provoked through the real path against real PostgreSQL and the committed
migration chain, never constructed:
`server/src/__tests__/de-06-artifact-denial-audit.integration.test.ts` (18 arms) and
`server/src/__tests__/de-21-live-events-upgrade-denial-audit.integration.test.ts` (13 arms, new).
Observed against the UNCHANGED tree first: DE-06 3 RED / 15 GREEN, DE-21 7 RED / 6 GREEN. The greens
in each are the NAMED POSITIVE CONTROLS — DE-06's two "THE FENCE-AUTH REFUSAL IS NOT RECORDED" arms
(the five residual throws) and its granted-upload arm; DE-21's `!key`, revoked-key, `:311`, `:358`
and granted-upgrade arms. Both files 18/18 and 13/13 green after, with `de-19-memory-denial-audit`
and `artifact-transfer-commit` re-run unchanged.

**★ A MEASUREMENT THE UNIT OWES ITS OWN TEST.** Of the seven mismatch conjuncts at DE-06's
tuple-integrity branch, only `provider_constraint_hash` can be provoked by a legal row. Five
(`job_id`, `attempt_number`, `target_id`, `target_generation`, `profile_hash`) also appear in
`lockLeaseAckContext`'s WHERE, so drifting one stops the lease JOINING and the refusal lands on
`:110` instead. `target_authority_key` is FK-pinned from both sides
(`leases_target_authority_fk` and `workers_target_authority_fk`, composite on
`(target_authority_key, target_id)`), and an `UPDATE leases SET target_authority_key = …` was
OBSERVED being refused by that FK. So the branch is proven on one conjunct, on both artifact
services, and the other six are compiled but unprovoked here. Stated rather than implied.

### ★ RE-TRIAGE, 2026-09-09, by the denial-audit batch (the unit that HALF-delivered DE-06)

★ **SUPERSEDED 2026-09-10: the class now stands at THREE closed (DE-19, DE-06, DE-14) and
FOURTEEN open — DE-14's closure is later the same day than DE-06's; see "★ DE-14 IS CLOSED" above.
See the authoritative count in this finding's Status block. The paragraph below was correct on
2026-09-09 and is kept because the corrections beneath it are only legible against it.**

**The count first, because a skim must not conclude this class is closed. Of the SEVENTEEN,
ONE is closed — DE-19 (2026-09-08) — and SIXTEEN remain open.** DE-06 was recorded here as the
second closure on 2026-09-09 and that was RETRACTED the same day: its clause is the conjunction
*"object put/get and rejected-key attempts are audited"*, only the rejected-key conjunct was
wired, and a successful download grant — the disclosure-relevant event — still writes nothing.
DE-06's rejected-key half IS delivered and its evidence stands; the crossing does not. See the
`E0-F010` entry above for the full correction and for the second gap (the fence-AUTH refusals)
found while making it. **The heading originally read "the unit that closed DE-06"; it did not.**

The group taxonomy below was re-measured against source rather than inherited, and it is wrong in
three ways. Each correction is stated here; the original text is kept beneath it, unedited, so
the change is visible. **All three corrections stand as measured** — the retraction above changes
the COUNT they are stated against, not the corrections themselves.

**CORRECTION 1 — the taxonomy lost one of the sixteen it was a taxonomy of, and it was the one
that came closest to closing.** The list opening the section names sixteen crossings. Groups A, B,
C and D between them name DE-01, DE-03, DE-04, DE-11, DE-12, DE-13, DE-14, DE-15, DE-16, DE-17,
DE-18, DE-20, DE-21, DE-27 and DE-29 — **fifteen. DE-06 appears in the list and in no group.** A
Critical crossing dropped out of the very structure whose stated purpose was that "a plan that
quietly covers twelve and implies seventeen is this programme's own failure class". It was then the
most tractable crossing in the set — for the half that was wired: those refusals are `return`s
inside a *committing* transaction, their tenant is the locked lease's `companyId` (FK-valid,
resolved under the refusing worker's own org GUC, never caller-supplied), and they needed no new
lifecycle at all. That tractability did NOT extend to the clause's other conjunct or to its
fence-auth throws, which is precisely how "most closable" became "closed" in the first draft.

**CORRECTION 2 — "Group A … `recordSecurityDenial` already fits; only the interception is new" is
false for all three of its members, on three different grounds.**

- **DE-16** — already corrected in place below (synchronous chokepoint; two sinks with no
  `companyId` at all). Left as the finding states it.
- **DE-21** — split, and only half is closable with the existing mechanism. Re-measured at
  `f13f1f4d0` in `server/src/realtime/live-events-ws.ts`: the 403 is produced when
  `authorizeUpgrade` returns `null`, and its `return null` branches divide cleanly. The
  **agent-key branches** (`:376` an unknown key or a key belonging to a DIFFERENT company —
  the cross-tenant probe itself; `:387-393` a terminated / pending-approval / company-mismatched
  agent) resolve an FK-valid prober tenant from `agent_api_keys.companyId`, which is exactly
  DE-19's "write into the tenant that refused, never the tenant that was probed". The
  **board/session branches** (`:302`, `:313`, `:319`, `:425`, `:430`) do not: a board user
  belongs to many companies, so the only company in hand is the one the URL asked for, and
  writing there would put a probe record into the PROBED tenant's own audit stream. Decision 2
  below governs that half. So DE-21 is a partial closure at best today, not a drop-in.
- **DE-15** — **has no tenant to attribute to.** The kill-switch drain at `job-leasing.ts:731-740`
  is a fleet-level verdict about a PROVIDER, returned to a worker poll. `LeaseCandidate.job`
  does carry a `companyId`, but candidates may be empty, and attributing a provider kill verdict
  to whichever job happened to be at the head of the queue is a fabricated attribution, not an
  audit record. DE-15 belongs with Decision 2, not with Group A.

**CORRECTION 3 — Group B's blocker is narrower than "inside the tenant transaction", and the
lifecycle it says does not exist is not needed.** The stated rule is that these denials cannot be
recorded because "an in-transaction write rolls back with it". The operative property is not
*inside a transaction* — it is *the transaction rolls back*. DE-06's **returning** refusals are all
inside `runInTenant` and all of them are now recorded, because a `rejected` outcome is a **RETURN,
not a throw**, so the transaction COMMITS. (Its **throwing** refusals —
`resolveWorkerFenceContext` — are still unrecorded, and for a different reason: not the rollback
but a missing FK-valid tenant. See `E0-F010`.) And the pattern that made it work does not need a
separate-transaction recorder either: the refusing branch records an **intent** into a local, the
transaction unwinds (by return OR by a caught throw), and the caller writes the row on the pool
handle before responding. `server/src/services/artifact-denial-audit.ts` documents it.

★ This is not a theory about DE-04/DE-18. **A `guardActiveFence` refusal — the exact throw those
two crossings turn on — is now recorded durably and attributably at one of its callers**, and the
arm that proves it provokes a real expired lease against real PostgreSQL
(`de-06-artifact-denial-audit.integration.test.ts`, the `guardActiveFence` arm; the throw is caught
inside the tenant transaction, the intent is recorded there, the row is written outside). What
DE-04 and DE-18 still need is the same treatment at the **other 10+ governed mutators' callers**,
which is real work — but it is wiring, not a missing lifecycle.

★ **AND ONE NEW HAZARD THE ORIGINAL TRIAGE COULD NOT HAVE NAMED.** `security-denial-audit.ts` says
`db` must be a pool-level handle. It does not say that calling it *from inside* an open tenant
transaction satisfies that sentence and **borrows a second pool connection while the first is
still held** — a self-deadlock on the refusal path, i.e. an audit that converts a refusal into a
hang. Every remaining crossing in this class whose deny sits inside `runInTenant` hits this, and
the intent-drain pattern is the answer.

**Honest arithmetic, re-derived rather than inherited — and then CORRECTED DOWNWARD.** The original
section closes with "of the seventeen, ONE is closed and at most ELEVEN more are closable end to
end". This section first restated that as **two closed**; the DE-06 retraction puts it back to
**ONE closed (DE-19) and SIXTEEN open**, of which **none is a drop-in with today's mechanism**:
DE-06 needs the successful put/get half plus its fence-auth half; DE-21 is half-blocked and DE-15
fully blocked on Decision 2; DE-16 needs its chokepoint async-ified;
DE-04/DE-18/DE-29 and DE-12's and DE-13's capacity halves need the intent-drain applied at
each governed mutator's caller; DE-03 and DE-13's and DE-27's throttle halves need
`sendWorkerOperationProtocolError` widened to carry a db handle and a tenant; and the six
clause-halves in Group D are unchanged and still not closable at this architecture. **Decision 2
(where a company-less denial goes) is now blocking FOUR clause-halves — DE-03, DE-21's board half,
DE-15, and DE-06's fence-auth refusals — and is the single highest-leverage unblock left in the
class.**

### What the remaining sixteen need (2026-09-08, from the unit that closed DE-19)

*(Superseded in part by the re-triage above; kept verbatim because the corrections are only
legible against it. Its own count of "sixteen" was correct on 2026-09-08 and, after the DE-06
retraction, is STILL sixteen — it was briefly restated as fifteen and that was wrong.)*

Sixteen crossings in this class are still open: **eight here** (DE-15, DE-16, DE-17, DE-18, DE-20,
DE-21, DE-27, DE-29) and **all eight in `E0-F010`** (DE-01, DE-03, DE-04, DE-06, DE-11, DE-12,
DE-13, DE-14). They are not one job. Grouped by what they actually need:

**Group A — the same shape as DE-19: an async deny path, a real tenant, a live DB handle, no
surrounding transaction. `recordSecurityDenial` already fits; only the interception is new.**

- **DE-16** — `recordCloudPluginBlock` (`cloud-plugin-execution.ts:225-247`) is already the
  chokepoint for **ten** production call sites and already emits the right fields. ★ **But it is
  NOT the drop-in the audit-phase measurement claimed.** Three obstacles, all measured at tip
  `921b2c1f9`: (i) it is **synchronous** (`: number`) and one caller,
  `plugin-worker-manager.ts:623` `spawnProcess()`, is a sync function returning `ChildProcess` —
  a durable write cannot be awaited there; (ii) `companyId` is **optional**, and
  `plugin-loader.ts:1285` and `:1777` pass **none at all**, so `activity_log`'s NOT NULL
  `company_id` cannot be satisfied on those two sinks; (iii) `company-plugins.ts:333` blocks
  **before** `assertCompanyAccess`, so its `companyId` is an unvalidated route param and may not
  be a valid FK. Closing DE-16 means async-ifying the chokepoint (or splitting the sync backstop
  off), plus Decision 2 below for the company-less sinks. Cheap, but not one line.
- **DE-21** — `live-events-ws.ts:1078` `rejectUpgrade`. Async, and it ships its own positive
  control (`logger.error` at `:1090` fires only when the authorize function *threw*). Blocked on
  Decision 2: its `companyId` comes from an **unauthenticated URL path segment**.
- **DE-15** — the kill-switch drain return at `job-leasing.ts:731-740`. In a transaction, but a
  *returning* one rather than a rejecting one, so the rollback problem does not bite.

**Group B — blocked on a lifecycle `recordSecurityDenial` does not have: the deny is a `throw`
INSIDE the tenant transaction, so an in-transaction write rolls back with it.** DE-29 is the
proof: the audit UPDATE at `job-control.ts:3139` sits after the throw at `:3122` and never runs.
These need a **separate-transaction** recorder that commits after the refusing transaction has
rolled back — a different lifecycle, not a wiring change.

- **DE-04 + DE-18** — both refuse through `guardActiveFence`
  (`job-control.ts:1167-1187`), which **11+ governed mutators** call. Highest leverage in the
  whole class: one function, two crossings. **This is the right second slice**, once the
  separate-transaction lifecycle exists.
- **DE-29** (`job-control.ts:3122`), **DE-12**'s denial half (`job-submission.ts:239`), and
  **DE-13**'s capacity half (`org-concurrency.ts:271/:298/:318`) join it on the same lifecycle.
- **DE-01's WRITE half** belongs here too and is genuinely closable: an RLS `WITH CHECK` violation
  raises catchable SQLSTATE **`42501`**, and `server/src/db/with-tenant-tx.ts` is the single place
  to catch it.

**Group C — shared interception point, but the point has no tenant context to give.**

- **DE-03**, **DE-13**'s throttle half and **DE-27**'s throttle half all refuse through
  `sendWorkerOperationProtocolError` (`worker-protocol-http.ts:76-93`), which has **20+ call sites
  in `worker-control.ts` alone**. Its signature is `(req, res, operation, code, now)`: **no db
  handle, no org, no company**. Widening it is the work, and DE-03's unenrolled-worker case hits
  Decision 2 head-on.

**Group D — structurally different; no amount of interception closes them at this architecture.
Naming them, because a plan that quietly covers twelve and implies seventeen is this programme's
own failure class.**

- **DE-01's READ half — the hard one.** PostgreSQL emits **no event** when an RLS `USING` clause
  filters rows: the planner ANDs the policy into the predicate, the query **succeeds**, and zero
  rows is a legal, indistinguishable result. Detecting it requires re-running the query without
  the policy and diffing — i.e. a `BYPASSRLS`/owner connection, exactly the privilege
  `packages/db/src/client.ts:325` throws at boot to forbid and `server/src/app.ts:490` calls
  "owner fallback is forbidden". `pgaudit` does not rescue it (it logs statements, not policy
  verdicts) and appears nowhere in this tree. **Recommend AMENDING the clause, not building it.** ★ **CORRECTION, 2026-09-09 (`docs/replatform/MEASUREMENT-de-01-read-half-does-not-need-bypassrls.md`): the words "i.e. a `BYPASSRLS`/owner connection, exactly the privilege `client.ts:325` throws at boot to forbid" are MEASURED FALSE. A cross-tenant read needs no `BYPASSRLS`. Two shapes deliver one with the serving pool's `rolbypassrls=false` and `client.ts:325` still passing — **and they are NOT interchangeable, so read the precondition before adopting either**: (a) a role-targeted `CREATE POLICY ... TO "aoa_operator"` (the `0233` shape, on a FORCE-RLS table) — **no precondition, no privileged role anywhere; this is the portable one**; (b) a narrow `SECURITY DEFINER` function granted to `aoa_operator` alone (the `0268` shape) — **admissible against a FORCE-RLS relation ONLY where the function's owner is itself `SUPERUSER` or `BYPASSRLS`. "Owner-owned" is NOT sufficient: under `FORCE ROW LEVEL SECURITY` the table owner is not exempt from its own policies, and the IDENTICAL function owned by a `NOSUPERUSER NOBYPASSRLS` owner of the same table returns ZERO ROWS — measured as control `ALT-A(iii)`. That failure is SILENT (an empty result, not an error), so a unit that adopts (b) without asserting the precondition in its own test ships a comparator that reports "no divergence" forever. A plain view is (b) in different spelling, with the same precondition (`ALT-A(iv)`).** Amending that guard is WITHDRAWN as a recommendation — and it would falsify DE-01's own `revocation` clause ("the role holds no BYPASSRLS"). What stays true is that a serving-path comparator is undesirable on its own merits, so this clause-half remains undelivered and Decision 1 was RULED 2026-09-11 (1.1c): conjunct 3 (read-side) is amended to a documented DECLINE — a filtered read is a legal empty result, so there is no inline event to record — with a narrow offline verifier chartered-but-unfunded. The clause-half stays undelivered (1a/1b unblocked-but-unwritten) and DE-01 stays `partial` in this cohort.**
  The same shape covers `memory.search` under DE-19 and is why DE-19's closure is scoped to
  `memory.get`.
- **DE-27's cross-replica and partition halves** — `replicaId|replica_id|AOA_CONTROL_PLANE_REPLICA|controlPlaneId`
  returns **zero hits** across `server/src`. ★ **AMENDED 2026-09-11 (E0-F013 Decision 1.2c) — the
  weak reading was adopted; the "no vocabulary / needs a replica identity built first" framing is
  SUPERSEDED and the bullet splits into two conjuncts with different dispositions:** (i) the
  **cross-replica admission** conjunct is ordinary Group B/C audit-write wiring — record the
  `over_cap` refusal (`worker-admission-rate-limit.ts:147`, Group C via
  `sendWorkerOperationProtocolError`) and the capacity refusal (`org-concurrency.ts:274`, Group B
  in-transaction throw); admission is DB-serialized, so no replica identity is required or implied. It
  moves OUT of Group D into the Group B/C work already enumerated and is NOT undeliverable. (ii) the
  **partition** conjunct is DROPPED as vacuous (no partition detector). The consequent effect on this
  section's "Honest arithmetic" is handled at the class-wide settled ceiling (see below and the
  decision paper §7 / §8 1.7); it is not restated per-bullet here.
- **DE-12's "generation changes" half** — ~~`services.generation` has **no writer anywhere**, so
  there is no change to audit. Vacuous until one exists.~~ ★ **CORRECTED 2026-09-11 (E0-F013 Decision
  1): the writer now EXISTS and the change is AUDITED.** `bumpServiceGeneration`
  (`job-control.ts:3135`, the SVC-005a roll route) writes `services.generation`, and a roll writes
  exactly one durable `service.generation_roll` `activity_log` row via
  `recordServiceGenerationRollActivity` (`service-control-audit.ts:317`, called at
  `service-generation-rollout.ts:415`, proven RED-first by R-T11) — so conjunct **3c (generation
  changes are audited) is DELIVERED**, not vacuous. Only **3a (partition)** and **3b (drain)** remain
  vacuous (no partition detector; no reconciler-driven drain producer, E9-F008) and were amended as
  vacuous by Decision 1.
- **DE-20's rollback half** — `createDistributedExecutionDrain` has **zero production callers**
  (`E0-F014`), so there is no rollback transition. Selection is recordable; rollback is prose.
- **DE-11** — ~~the sensitive-artifact access and retention controls are themselves absent
  (`E8-F011`). Nothing decides, so there is nothing to record; `artifact-commit.ts:170-176`
  self-labels as "a LOG LINE, not an audit record".~~ ★ **BOTH HALVES NOW HAVE A LIVE WRITER, AND
  DE-11 STILL DOES NOT CLOSE (2026-09-10).** The "nothing decides" premise was already measured
  STALE for the RETENTION half by Decision 1's options paper, and W20-B wired it
  (`recordRetentionDecision`, `artifact-retention-audit.ts`) — the self-labelling "LOG LINE" comment
  is gone. The **ACCESS** half was then the last piece, and W20-B named its blocker exactly: it
  *"rides DE-06's existing put/get obligation"*. **That obligation is discharged**: a successful
  download grant now writes a `security.object_access.artifact_download_grant` row carrying
  `details.kind` and `details.sensitivity`, read from the committed `job_artifacts` row, so the
  record says WHICH KIND became reachable rather than only that a transfer happened. **DE-11 stays
  `partial` on the SECOND, INDEPENDENT ground W20-B recorded, which this unit does not touch:** the
  **coverage caveat** — nothing in production uploads `browser_cookie_state` or
  `browser_storage_state` because BRW-003 is unbuilt, so on today's traffic both records can only
  ever be about a `log`, a `workspace_patch` or a `screenshot`, and **never once about a
  credential-bearing kind**. Both proving suites provoke a sensitive kind BY HAND and pin it as
  test-provoked in the arm title precisely so it cannot be mistaken for production coverage.
  ★ Two further things stay true and are not claimed: on the UPLOAD arm `kind`/`sensitivity` are
  `null` because the artifact does not exist yet and the frozen grant request carries neither field
  (they are first declared in the COMMIT manifest) — a true answer, not a missing one; and
  `sensitivity` is not a discriminator at all in v1, measured at the frozen schema
  (`artifactSensitivitySchema` is `z.literal("restricted")` and `RESTRICTED_ARTIFACT_KINDS ===
  ARTIFACT_KINDS`), so `kind` is the only field that separates a credential-bearing artifact from a
  log. **DE-11's non-audit gaps are entirely untouched** and remain `E8-F011`'s: purge on job
  completion in particular still has no writer. A mechanism that has never been exercised on its
  subject is not coverage, and a discharged ground is not a discharged clause.
- **DE-17** — ~~technically possible, practically blocked. `packages/adapter-manager` and
  `packages/worker-daemon` run **off the control plane** and hold no control-plane DB handle, so a
  durable row from a `CleanupAuthorityDeniedError` needs a **wire hop** — and
  `packages/worker-protocol` is v1-FROZEN behind a hash-pinned cross-version conformance test. Its
  own ticket, with its own freeze decision.~~ ★ **UN-BUNDLED 2026-09-11 (E0-F013 Decision 1.6): the
  v1 freeze is NOT the blocker** (`extensions[]` is on the worker-event schema at `events.ts:347`, and
  a `critical:false` extension is additive under the freeze). DE-17 splits, but ★ **CORRECTED
  2026-09-11 (Codex P1, verified at source): 6a is NOT deliverable now.** The post-fence cleanup
  (`CleanupAuthority.converge`, `packages/worker-daemon/src/supervisor/cleanup-authority.ts`) runs
  OFF-PLANE in the worker daemon and reports its outcome to NO control-plane sink; the drain
  (`drainWorkerDenial`→`recordSecurityDenial`, `worker-denial-audit.ts:227`, migration `0274`)
  carries DENIALS (DE-03/DE-06), NOT cleanup outcomes — so a CP-side drain FOR CLEANUP OUTCOMES is
  genuinely missing and 6a ALSO needs an unbuilt worker→CP carrier (SIMPLER than 6b — report the
  outcome, no authority-typing — and sequenceable first). **6b (denied escalations)** additionally
  needs authority-typing, blocked on either `E0-F014` (the adapter-manager then reports over its own CP channel, no worker carrier) OR an unbuilt worker self-report carrier. Both halves are hard-blocked, on DIFFERENT unbuilt mechanisms — 6a the cleanup-outcome carrier, 6b authority-typing or a self-report.
- **DE-14** — recordable only as a **log**, and that is all its clause asks ("the startup
  safety-assertion outcome is **logged**"). `assertHostedExecutionStartupSafe` fires at
  `config.ts:198` during config load, **before any DB pool exists**, so a durable row is
  structurally impossible. ~5 lines. Take it as a freebie; it proves nothing about the mechanism.
  *(★ CLOSED 2026-09-10, and BOTH halves of this bullet were wrong in opposite directions. "~5
  lines / a freebie" was corrected on the same day by the object-access unit, which measured
  `loadConfig` as un-memoised with many call sites and the obvious logger as un-importable there;
  and that correction's own fourth measurement — "the failure outcome cannot be moved to the
  entrypoint" — was then refuted by the unit that closed it, because a top-level call is not an
  uncatchable call. What survives unchanged is the FIRST clause: the clause asks only for a log,
  and only a log was delivered. See "★ DE-14 IS CLOSED" under `E0-F010`.)*

**Honest arithmetic: of the seventeen, ONE is closed and at most ELEVEN more are closable end to
end. Five clause-halves are not, and DE-17 is a sixth ~~behind the protocol freeze~~.** ~~Any plan must
state twelve, not seventeen.~~ ★ **RECONCILED 2026-09-11/12 (E0-F013 Decision 1.6 + the settled
ceiling):** "behind the protocol freeze" is refuted — DE-17 is UN-BUNDLED and the v1 freeze is not
its blocker (`extensions[]` is additive under it, `events.ts:347`); ★ CORRECTED 2026-09-11 (Codex P1): 6a is NOT deliverable-now — 6a is blocked on the missing worker→CP cleanup-outcome carrier (the cleanup runs off-plane; the existing drain carries denials, not cleanup outcomes), and 6b on EITHER E0-F014 authority-typing (the adapter-manager reports the escalation over its own CP channel, no worker carrier) OR a worker self-report — different unbuilt mechanisms, 6a the simpler (no authority-typing). The pre-ruling "twelve, not seventeen" is superseded: under
convention (ii) — the one §7 already applies to DE-06/DE-14 — the **closable-ever ceiling is
SIXTEEN** (17 − DE-17, the sole audit clause still blocked on an unbuilt mechanism), DISTINCT from
the open count of **ELEVEN** (see the class-wide count above and the decision paper §7 / §8 1.7; the
count was TWELVE at the 2026-09-11 ruling and dropped by one when DE-27's audit clause was delivered
on 2026-09-12 — the ceiling of SIXTEEN is unchanged, as DE-27 was always within it).
Never quote seventeen as achievable.

### Decisions this slice did not take

1. **(Blocking the plan, not the next slice.) What happens to the clause-halves that cannot be
   delivered as written** — DE-01's read half, DE-27's cross-replica and partition halves,
   DE-12's change half, DE-20's rollback half, and DE-11. Per clause: amend the wording in
   `docs/architecture/distributed-execution-threat-controls.json` to what the programme actually
   intends, or charter the missing machinery. **A mechanism that closes twelve while the register
   still asserts seventeen reads as a solved class and is a false claim of enforcement.**
   ★ **RULED 2026-09-11 (E0-F013 Decision 1)** — see the enacted register + Status block. DE-01
   read-denial conjunct amended to a documented DECLINE (blocker false; offline verifier
   chartered-but-unfunded; stays `partial`); DE-27 weak-reading kept as open Group B/C + partition
   dropped vacuous; DE-12 3c delivered / 3a+3b vacuous; DE-20 4a delivered / 4b vacuous; DE-11
   rescheduled (live writer exists); DE-17 un-bundled but CORRECTED 2026-09-11 (Codex P1) — 6a is NOT deliverable-now: 6a is blocked on the missing worker→CP cleanup-outcome carrier and 6b on EITHER E0-F014 authority-typing (adapter-manager reports over its own CP channel) OR a worker self-report — different unbuilt mechanisms (6a simpler — report the outcome, no authority-typing).
   The historical deferral framing above (including the "DE-12's change half" phrasing) is kept as
   the reasoning trail; the per-clause dispositions here govern.
   ★ **OPTIONS PAPER, 2026-09-10:
   [`docs/replatform/DECISION-REQUEST-undeliverable-clause-halves.md`](../../DECISION-REQUEST-undeliverable-clause-halves.md).**
   It re-measured all six at source rather than inheriting this list, decomposed each clause into
   its CONJUNCTS, and reports **three results that contradict the framing above**, each evidenced at
   a file:line. **(1) TWO OF THE SIX ARE NOT BLOCKED FOR THE STATED REASON.** DE-01's read half:
   the `BYPASSRLS` premise is already measured FALSE in this very entry's own inline correction, so
   the half is deliverable and the objection is a DESIGN cost (a comparator on the hot path of every
   tenant read), not an impossibility. DE-11: the premise *"nothing decides, so there is nothing to
   record"* is **stale** — `resolveStoredRetention` is a live control-plane retention decision at
   `artifact-commit.ts:253`, branched on at `:257`, with `input.appDb` and `ctx.companyId` in scope
   and `recordSecurityDenial` already imported at `:46`; its own comment at `:259-260` records a
   DEFERRAL, not a blocker. ★ **DE-17 IS NOT A THIRD, AND THE PAPER SAYS SO AGAINST ITS OWN FIRST
   DRAFT.** The v1 protocol freeze is genuinely **not** its blocker (`extensions[]` is on the frozen
   worker-EVENT schema, `events.ts:347`, and V1 recognises no critical namespaces, so a
   `critical:false` extension is additive UNDER the freeze) — but the paper's first draft then
   concluded DE-17 was therefore deliverable and recommended a split by channel, and **that was
   withdrawn on review** (Codex P1, PR #407, verified at source). **DE-17 has two harder blockers:** ★ **UN-BUNDLED
   2026-09-11 (E0-F013 Decision 1.6), then CORRECTED the same day after a Codex P1 (verified at source):
   the two blockers named above gate 6b — but 6a is ALSO blocked, NOT deliverable now. The post-fence
   cleanup (`CleanupAuthority.converge`) runs OFF-PLANE in the worker daemon and reports its outcome to
   NO control-plane sink; the existing drain (`drainWorkerDenial`→`recordSecurityDenial`,
   `worker-denial-audit.ts:227`, migration `0274`) carries DENIALS (DE-03/DE-06), not cleanup outcomes.
   So a CP-side drain FOR CLEANUP OUTCOMES is genuinely missing: 6a ALSO needs an unbuilt worker→CP
   carrier — SIMPLER than 6b (report the outcome, no authority-typing) and sequenceable first — while
   6b needs EITHER `E0-F014` authority-typing (the adapter-manager then reports over its own CP
   channel, no worker carrier) OR a worker self-report. Both halves are hard-blocked, on DIFFERENT
   unbuilt mechanisms; the v1 freeze is not the blocker.**
   the fenced worker-event ingest gates on `guardActiveFence` BEFORE any append
   (`job-events.ts` header; `job-control.ts:2592`, in `acceptEvent` at `:2588`, under the
   closed-mutator invariant at `:2585-2587`) and DE-17's scenario is post-fence BY
   DEFINITION, so that carrier rejects exactly the case the row names; and `OwnedLabelsCapability`
   has no operation or scope field while `execute` shares `gateOwnedOp` with `cancel`/`kill`/`destroy`
   (`server.ts:89-98`, `:153-155`), so the only wire denial available is an ownership mismatch and
   auditing it yields a generic authorization log, not a denied-escalation record. **Disproving one
   blocker is not proving deliverability** — and the paper had to relearn that on its own page.
   **(2) TWO CONJUNCT MISCOUNTS, in this
   list's own direction of error.** DE-12's audit clause is a **three**-way conjunction (partition,
   drain, generation changes) and **all three** are vacuous — this list queues one of three, so an
   amendment scoped to "the change half" would leave two vacuous conjuncts standing in a Critical
   row. ★ **CORRECTED 2026-09-11 (E0-F013 Decision 1): conjunct 3c (generation changes) is now
   DELIVERED (`recordServiceGenerationRollActivity`, R-T11); only 3a (partition) and 3b (drain) are
   vacuous — Decision 1 dropped 3a+3b as vacuous and recorded 3c delivered.** And DE-20's OTHER
   conjunct (legacy cutover selection) is ~~**closable today** in `heartbeat.ts`~~ and should be named
   as excluded from the ruling, not swept in with the rollback half. ★ **UPDATE 2026-09-11: it is now
   DELIVERED at HEAD (W20-B, `buildCutoverSelectionEvent`, `heartbeat.ts:5388`, both arms) — it was
   excluded from the ruling and has since closed.** **(3) THE ARITHMETIC ABOVE IS OFF BY ONE.** 17 − 6 = 11, not 12: the sentence subtracts
   *five* and then adds DE-17 as *a sixth* without re-subtracting. **DE-17 does make it eleven.** ★ **(These are
   the PRE-RULING closable figures behind the options-paper's own arithmetic correction; the
   post-ruling closable-ever ceiling is settled at SIXTEEN under convention (ii) — see the reconciled
   Honest-arithmetic note above and the decision paper §7 / §8 1.7 — distinct from the twelve-open
   count.)**
   The paper's §7 shows the working and enumerates the eleven. **It changes no status, no
   `deliveryStatus`, no ownership, no clause text and no gate-clause enrolment, and wires nothing** —
   it exists so this decision can be signed PER CLAUSE, and so that three of the six are not amended
   away on a blocker that measurement does not support.
2. **Where a company-less denial goes.** `activity_log.company_id` is NOT NULL with a cascade FK.
   DE-03 (unenrolled worker), DE-21 (attacker-supplied path segment), DE-01 (wrong or absent org
   GUC) and two of DE-16's sinks can all produce denials with **no resolvable company**. Either
   (a) accept that those record nothing and **say so in the register**, or (b) mint a denial table
   with a nullable company and an `organization_id` — a **schema** decision (Drizzle only,
   `pnpm db:generate`), whose RLS/GRANT posture must be considered rather than guessed (AGENTS.md
   + Decision #122; note the closest analogue, `activity_log`, is deliberately **non-RLS** per
   `0245:15-18`, which is a live-fire question for a table holding cross-tenant evidence).
   ★ **AMENDED 2026-09-09.** **DE-15 joins this list** — a kill-switch drain is a fleet-level
   verdict about a *provider* and has no tenant to attribute to at all — and **DE-21's share of
   this decision is its board/session half only**, not the whole crossing, because its agent-key
   branches DO resolve an FK-valid prober tenant. This decision now blocks **four** clause-halves
   (DE-03, DE-21's board half, DE-15, and — added by this unit's own measurement — DE-06's
   fence-resolution throws; see the authoritative count above) and is
   the highest-leverage unblock left in the class.
   ★ **OPTIONS PAPER, 2026-09-09:
   [`docs/replatform/DECISION-REQUEST-unattributable-denial-sink.md`](../../DECISION-REQUEST-unattributable-denial-sink.md).**
   It re-measured all four sinks at their throw/deny lines rather than inheriting this count.
   **On these four halves, NONE is wholly unblocked by this decision** — an earlier draft of the
   paper claimed two were, and retracted it. What is true: **individual deny sites** inside them are
   already resolvable — DE-06's tuple-integrity throw (`worker-fence-context.ts:122`, FK-valid via
   `lockLeaseAckContext`'s `job_attempts` join, **not** because `leases.company_id` is NOT NULL — it
   is nullable) and DE-21's agent-key sites (`live-events-ws.ts:395`, and `:376`'s
   `key.companyId !== companyId` arm but **not** its dominant `!key` arm), which this decision's own
   2026-09-09 amendment had already excluded from the four. DE-06's fence half stays blocked on its
   other five throws, and **DE-21's board/session half is blocked by Decision 3**, not this one — the
   blocker moves, the half does not clear. It also corrects **"DE-15 has no tenant at all"** — the drain
   return holds a token-attested `organizationId` and 0..N DB-resolved `jobs` rows
   (`job-control.ts:1930-1941`), so its shape is *not singular*, not *absent*. The residue this
   decision genuinely owns is DE-03, DE-15, and five of DE-06's six fence throws — all
   organization-attested, none company-resolvable, because `organization → company` is 1:N
   (`companies.ts:20,87`) — though two DE-03 sites (`worker-enrollment.ts:295`, and `:315` when
   `authoritativeOrganizationId` is null) hold **no organization either**. Six options are costed
   there; the paper recommends a nullable `company_id` plus a new nullable `organization_id` on
   `activity_log`, **plus a `db:generate`-emitted partial `CHECK (company_id IS NOT NULL OR action
   LIKE 'security.denied.%')`** — Drizzle's `check()` primitive is already used across this schema
   and drizzle-kit emits `ADD CONSTRAINT … CHECK` on live tables (`0135:3-4`), so the mitigation
   that keeps the NOT NULL guarantee for the other ~34 writers is free and does **not** engage C14.
   ★ **It also finds a LIVE cross-company read path this decision must account for:**
   `activityService.forIssue` (`services/activity.ts:60-70`) filters only `entityType='issue'` +
   `entityId` — no company predicate — and is served at `GET /issues/:id/activity` behind a check on
   *the issue's* company, while `entityType`/`entityId` are caller-supplied free text on
   `recordSecurityDenial`. So a tenantless denial row is **not** undisclosed by construction, and the
   ruling carries a third acceptance condition to close it with a provocation test. The paper names
   the strongest argument against itself. **It changes no status and wires nothing** — it exists so
   this decision can be signed.

   ★★★ **RULED 2026-09-09 — OPTION (a2), WITH THE CHECK, AND THREE ACCEPTANCE CONDITIONS.**
   The founder ratified the paper's recommendation. **Decision 2 is CLOSED as a decision.** What
   the sink unit landed, and what it deliberately did not:

   **LANDED (the storage half).** `activity_log.company_id` is **NULLABLE**; a nullable
   `organization_id uuid REFERENCES organizations(id) ON DELETE restrict` is added; the partial
   `CHECK (company_id IS NOT NULL OR action LIKE 'security.denied.%')` retains the NOT NULL
   guarantee for **every** product writer and relaxes it only inside the reserved denial namespace.
   All of it is `pnpm db:generate` output from `packages/db/src/schema/activity_log.ts`
   (drizzle `check()`), landed as `0274_activity_log_denial_sink.sql` with **C14 class (a)**
   idempotency guards hand-appended below the generated DDL for replay safety
   (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before each `ADD CONSTRAINT`,
   `CREATE INDEX IF NOT EXISTS`). The migration is **expand-only and N/N-1 compatible**: the old
   binary still writes and reads correctly against the new schema, and both properties are proven
   in `server/src/__tests__/e0-f013-unattributable-denial-sink.integration.test.ts` (arms 5 and 6)
   rather than asserted in prose. The recorder (`security-denial-audit.ts`) accepts
   `companyId: string | null` and an optional `organizationId`, contractually **token-attested or
   DB-resolved, never caller-supplied** — accepting a caller-supplied organization is option (c),
   which was **not** ruled, and whose attack is that a prober chooses its own record's destination.

   **NOT LANDED — THE SINK IS EMPTY.** ★ **No residual sink is wired.** DE-03's **nine** production
   `recordProof` refusals, DE-15's drain return (`job-leasing.ts:731-740`) and DE-06's five
   organization-only fence throws still write **no row**. *(★ This sentence said "eight" and
   contradicted the "nine" three paragraphs below — eight is the count of the nine that sit in
   `server/src/services`, not the count of the refusals. Corrected 2026-09-09 against the nine call
   sites; the same drift was corrected in `security-denial-audit.ts`'s own contract header, where
   it mattered more, because a caller reads the contract and not this entry.)* The ruling removed the STORAGE blocker;
   it did not do the wiring, and nothing in this entry may be read as if it had. Acceptance
   condition **(a)** — a production reader of `security.denied.*` must ship in the same wave — and
   condition **(c)** — closing or fencing `activityService.forIssue`, with a provocation — are both
   **OPEN**. Condition **(b)** is discharged: DE-15's `audit` clause in
   `docs/architecture/distributed-execution-threat-controls.json` was amended in the landing commit
   to say what an organization-attributed drain record does and does not establish.

   ★ **A MEASUREMENT CORRECTION THE PAPER OWES.** The paper's §1.1 count of **nine** DE-03
   `recordProof` refusal sites is right, but two details are wrong and both flatter the ruling.
   Measured at tip: **eight** of the nine are in `server/src/services`; the ninth is in
   `server/src/`**`middleware`**`/worker-session-auth.ts:151`, not `services/`. And the paper places
   that ninth among the **eight** sites that hold a verified organization. It does not: its
   `authoritativeOrganizationId` is typed **`string | null`**, and the `claims.organizationId === null`
   branch at `:183-185` passes an explicit `null`
   for a `platform`-scope worker (whose `claims.organizationId` is null by the invariant at `:72`).
   A platform-scope session refusal is therefore a **THIRD doubly-null site**.

   **The honest per-axis split for DE-03 under (a2):** **SEVEN** sites always carry a non-null,
   token-attested organization — `job-control-ack.ts:93`, `job-events.ts:169`, `job-fencing.ts:133`,
   `job-leasing.ts:546` and `:816`, `worker-fence-context.ts:68` and `:162` — because
   `VerifiedWorkerOperation.organizationId` is `string` and platform scope is refused ahead of it
   (`middleware/worker-operation-proof.ts:6,50`). **TWO** are conditionally doubly-null:
   `worker-enrollment.ts:315` (unrouted enrollment code) and
   `middleware/worker-session-auth.ts:151` (platform scope). And the separate pre-code refusal at
   `worker-enrollment.ts:295` — not one of the nine — has no organization at all.

   ★ **THE TRAP THIS SLICE LAYS FOR THE WIRING UNIT, AND THE FIX IT SHIPPED WITH.** Raised by Codex
   as P2 on PR #403, verified at source, and **fixed in the same commit rather than noted.** An
   `organizationId` reaching `recordSecurityDenial` is HMAC-attested, which makes it trustworthy
   *attribution* — but a signed id is **not** proof that the `organizations` row still exists, and
   the new `activity_log_organization_id_organizations_id_fk` cannot tell the difference. Delete an
   organization, then replay a worker token minted before the delete, and the insert reds **23503**.
   `recordSecurityDenial` never throws, so in the slice's first draft that error landed in the
   swallow: **the one denial class most worth keeping — a replayed credential from a torn-down
   tenant — would have been the one that recorded nothing**, and the doubly-null sink this whole
   ruling exists to open would never have been reached. Unreachable through production callers today
   (`read-tools.ts:298`, `artifact-commit.ts:349` and `artifact-transfer-grant.ts:332` all pass a
   resolved company and no organization), but **this is the PR that adds the FK the wiring unit's
   seven organization-attested DE-03 sites will hit**, so the trap belongs to this slice.
   **What ships:** a 23503 on **that named constraint only** retries ONCE with `organization_id`
   null — the row still satisfies the partial CHECK by construction — and the attested id moves into
   `details.unresolvedOrganizationId` beside `details.organizationAttributionDropped`, so a reader
   still learns WHICH organization was attested and that the FK, not the caller, is why the column is
   null. Degraded attribution beats a lost record. A **company** FK violation is deliberately NOT
   caught: that is a caller bug, not a torn-down tenant, and laundering it into an unattributed row
   would hide it. Proven by **arm 7** of `e0-f013-unattributable-denial-sink.integration.test.ts`
   against real PostgreSQL — the organization is created and then DELETED, not fabricated — observed
   RED against the first draft on `expect(id).not.toBeNull()`, a different failure from every other
   arm, and carrying its own narrowness assertion for the company-FK case.

   ★ **THE TWO P1s CODEX RAISED ON THE SAME REVIEW, AND WHY NEITHER MOVED THIS SLICE.** Both were
   verified at source and both are **real as acceptance conditions this entry already declares
   OPEN** — neither is a defect the diff introduces:
   - *"Ship the denial reader required by the ruling."* Correct that no consumer of `security.denied.*`
     exists in `server/src` or `ui/src`; that is condition **(a)**, named as OPEN two paragraphs
     above. The comment reads "Decision 2 is CLOSED as a decision" as a claim that the conditions are
     discharged. It is not, and the entry says so in the same breath as the closure. Shipping the
     reader *now* would also be the programme's own failure class in reverse: **the tenantless
     namespace is empty** — every one of the three live denial writers passes a resolved company —
     so a reader built today would be a surface with nothing to read and no way to go red. It ships
     with the wiring, against rows that exist.
   - *"Fence the unscoped issue activity reader."* Correct that `activityService.forIssue`
     (`services/activity.ts:60-70`) filters only `entityType='issue'` + `entityId` with no company
     predicate, and is served at `GET /issues/:id/activity` behind a check on *the issue's* company.
     That is condition **(c)**, named as OPEN, and it was found by this decision's own options paper
     before Codex found it. It is **not reachable by this diff**: no production denial writer emits
     `entityType: "issue"` (`memory_item`, `job_artifact`, `job_artifact`), and none writes a
     tenantless row at all. The ruling requires it be closed **with a provocation**, which is a
     fence plus a cross-company probe test — the wiring unit's work, in the wave that first makes a
     tenantless row producible. Deliberately not folded in here: a storage slice that also
     re-scopes a live product read path is two properties in one PR, and the entry would then be
     claiming a fence nobody probed.
3. **Retention and disclosure of a denial record.** (a) Whose log does a cross-tenant denial land
   in? The probed company's `activity_log` discloses to them that they were probed and by whom.
   (b) `activity_log` **cascade-deletes with its company**, so a hostile tenant can destroy the
   evidence of their own probing by deleting their own company. An audit record a suspect can
   delete is not an audit record.

### The reserved namespace is a convention over thirty-four writers, not a chokepoint — and why no guard was shipped for it

Recorded on 2026-09-08, after an adversarial check of the DE-19 slice measured the claim the slice's
own prose made. The commit message and `server/src/services/activity-namespace.ts` described
`activity_log` writes as funnelling through one predicate. **They do not.** Re-derived
independently at `12660dbd6`: there are **thirty-four** direct `db.insert(activityLog)` /
`tx.insert(activityLog)` sites in `server/src`, and `assertUnreservedActivityNamespace` runs at
exactly **two** — `insertActivityLog` (`services/activity-log.ts:35`) and `activityService.create`
(`services/activity.ts:188`) — plus the HTTP route's Zod refinement (`routes/activity.ts:33`) ahead
of the second.

**The property still holds, for a narrower reason than the prose gave.** Those two are the only
writers that accept a caller-supplied `action`. All thirty-two others hard-code it: string
literals, a ternary of literals (`work-question-continuation-terminal.ts:175`), a literal-union
parameter (`user-notes.ts:27`), module-local consts (`marketplace-reconcile.ts:380`,
`seed-commander-review.ts:267`), and one statically-prefixed template (`hub-items.ts:1186`,
`` hub_item.${…} ``, unreachable from this namespace whatever the suffix). The single site typed
`action: string` (`operator-break-glass.ts:277`) is a private dep hook with three internal literal
call sites. Probed live: `logActivity` rejects, `activityService.create` throws, and
`POST /companies/:cid/activity` returns 400 — zero forged rows.

**Decision: no static guard.** A guard that fires when a new direct `insert(activityLog)` appears
without the predicate was considered and declined, on three grounds:

1. **It cannot be precise.** The honest predicate is "this site's `action` expression is
   statically constrained away from `security.denied.`", which needs flow analysis: four of the
   thirty-four pass an identifier or a parameter, and only reading their declarations separates
   them from a genuine free-form writer. A grep-shaped guard must allowlist
   `operator-break-glass.ts:277` **on the day it ships**. A guard that arrives with an exemption
   for a legitimate site teaches its next reader to add the next exemption — the measured failure
   in this programme's scanner history, where a benign `postgres://localhost:5432/dev` hard-failed
   the leak check.
2. **It reds on unrelated edits.** `activity_log` writers are ordinary product code and there are
   thirty-four of them; an inventory-shaped guard goes red on every new one. This repository has
   refused guards of that shape before, and a guard that gets switched off is worse than none
   because it leaves a false claim of enforcement behind.
3. **It buys little.** The hazard is a THIRD writer that takes free-form `action` text. Both of
   today's two are guarded, and a new free-form writer is far likelier to be a new *caller* of
   `insertActivityLog` — already covered — than a fresh direct insert typed `action: string`.

**What was done instead**, because an unenforced rule must at least be stated where it is read:
`activity-namespace.ts`'s docblock now carries the measured counts and the rule in place of the
false chokepoint claim — *a direct `insert(activityLog)` must hard-code its `action`; if the action
comes from the caller, route through `insertActivityLog`* — and says in terms that it is not
mechanically enforced. If a third free-form writer ever appears, this decision should be revisited
with the flow-analysis guard, not the grep one.

- **Affected crossings:** DE-15, DE-16, DE-17, DE-18, DE-21, DE-29 — **six
  remaining** (DE-20 struck 2026-09-11, audit clause resolved by amendment under Decision 1; DE-27
  struck 2026-09-12, admission conjunct delivered + partition amended vacuous). DE-19 is closed (above) and is no longer carried by this finding.
- **Disposition:** `unowned`, for the reason `E0-F010` gives — no ticket on disk owns "record a
  denial" for the remaining six (DE-20 struck 2026-09-11, DE-27 struck 2026-09-12). DE-27's admission
  work, under the WEAK reading adopted by Decision 1.2(c), was ordinary Group B/C audit-write wiring
  (durably record the two admission refusals) and needed NO replica identity — the strong reading
  would have required one, but the ruling did not adopt it, and the wiring is now delivered
  (`recordWorkerAdmissionDenial`, `E0-de27-admission-audit` in gate-clause-wiring.json). NOT
  `accepted`: HIGH may never be accepted.
- **Resolution condition:** each remaining row's `audit` clause is either delivered against a named
  record point with a production caller, or AMENDED to state what the programme intends. Resolve =
  flip this Status and delete the `E0-F013` key in
  `scripts/finding-ownership.json` in the SAME commit.

## E0-F014 — The dead-arming-path class, second cohort: five more crossings are defended by a lever with zero production callers, including the rollback the cutover row calls "atomic" and the immutability check for the evidence ledger whose rule this repository has already broken three times

- **Status:** open
- **Severity:** HIGH
- **Filed:** 2026-09-08, by W20B (the recovered-audit landing unit). Caller counts below were taken
  by the landing unit as whole-tree sweeps excluding `node_modules` and `dist`.
- **Blocks gate:** No — but it is the reason five register rows are `partial` rather than
  `delivered`, and each of the five looks delivered from the register.
- **Progress (2026-09-09):** ★ **Item 3 (DE-22) is CLOSED — one of five. Items 1, 2, 4 and 5 are
  untouched and this finding stays open.** ★ **Later the same day, items 1 and 2 had their register
  CLAUSES amended by founder ruling — no lever gained a caller, no `deliveryStatus` moved, and
  neither item is closed.** Both clauses overstated what the code does (DE-18's missing piece is
  liveness, not a deny; DE-20's *"atomically"* named a transition no code performs while per-job
  cancellation ships and is routed). Read those amendments as the register being made honest, not
  as progress on the wiring. `checkEvidenceImmutability` now has exactly one
  production caller: `scripts/check-evidence-immutability.mjs`, invoked by the `policy` job of
  `.github/workflows/pr.yml` (step *"Evidence-ledger immutability (QA/handoff records are
  write-once)"*) on every non-draft pull request. Do not read this line as movement on the other
  four — nothing about them changed.
  ★ **Progress (2026-09-10): item 1 (DE-18) is now RESOLVED by PR #418 (`2ad742051`) — two of
  five closed, items 2, 4 and 5 remain and this finding STAYS OPEN.** The lever gained a real
  production caller and a red-when-removed test (see item 1's 2026-09-10 amendment below). This is
  the dead-arming-path resolution the finding demanded, not a founder clause amendment. Do not read
  it as movement on items 2/4/5 — nothing about them changed, and the DE-18 register row's own
  clauses were not re-measured here.

**The class, as `E0-F011` states it.** The receiving half of the control is built, tested and
correct, and the half that would ever arm it does not run in any deployment.

1. **DE-18 (Critical) — the revocation fanout has no caller.** The fence denies correctly
   (`job-control.ts:1177`), but `createExecutionTargetRevocationFanout`
   (`server/src/services/execution-target-revocation-fanout.ts:43`) has **zero production callers**:
   the whole tree holds its own declaration, `server/src/__tests__/worker-revocation.integration.test.ts:18,53`,
   and a comment naming it in `scripts/lib/gate-clause-wiring.mjs:10`. Consequence: after a
   revocation the lease stays `offered`/`active` and the `execution_target_revocations` row stays
   `pending` forever, so the job attached to it is **stranded non-terminal with its organization
   concurrency slot still held**.
   ★ **Clause amended 2026-09-09 by founder ruling — the CLAIM was wrong, the lever is still
   unwired, `deliveryStatus` unchanged.** DE-18's `revocation` clause now says in its own words
   what this item measured: the missing thing is **liveness, not a deny**. The authz cutoff already
   fires at `job-control.ts:1177`, and the code states the division at `:1127-1130` — *"the recheck
   is the gate, the fanout is only convergence"* — so no old-generation effect executes while the
   work sits stranded. What the fanout would add is retirement of that stranded work and release of
   the held slot. Wiring it is a **garbage collector, not a security control**.
   ★ **RESOLVED 2026-09-10 by PR #418 (`2ad742051`).** The lever now has a production caller: the
   fanout is composed inside the `distributedExecutionEnabled && distributedExecutionDatabases`
   block and `await revocationFanout.tick()` runs INSIDE the already-running MIG-002
   `convergenceTick` (`server/src/index.ts`) — reusing that timer, driven by a real producer (the
   live `POST .../workers/:workerId/revoke` route writes the `status:'pending'`
   `execution_target_revocations` rows it drains), so it is honest wiring, not a GO-BOOK-forbidden
   count-flip. Guarded red-when-removed by `de-18-revocation-fanout-wiring.test.ts`; convergence
   behaviour proven end-to-end in `worker-revocation.integration.test.ts`. ★ Review of PR #418 also
   surfaced and fixed a **pre-existing JOB-007 completeness gap** the wiring would otherwise have
   made live (Codex P1): the fanout converged only by live lease, so a reaper-minted lease-less
   retry pinned to the revoked target (via `allocateRetry`, minted `capacityClaimState:'held'`) was
   stranded — record marked `completed` while it held an org slot forever. The fanout now converges
   by pinned ATTEMPT too (nonterminal attempts pinned to `placementTargetGeneration <=
   revokedGeneration` with no live lease → terminalize + release capacity + cancel job
   `target_revoked`), with its own red→green integration case. `E3-18-revocation` in
   `scripts/gate-clause-wiring.json` was promoted `unwired → wired` on that evidence. **This item's
   dead-arming-path concern is closed; `E0-F014` stays OPEN on items 2, 4 and 5.**
2. **DE-20 (Critical) — the rollback lever cannot be pulled, and the row's own word is "atomically".**
   `createDistributedExecutionDrain` (`server/src/services/job-distributed-drain.ts:114`) has **zero
   production callers** — declaration, two test files, and the same `gate-clause-wiring.mjs:10`
   comment. Removing an organization from the rollout dial therefore does not cancel an in-flight
   distributed run; it only changes what the *next* wake resolves.
   ★ **Clause amended 2026-09-09 by founder ruling, and the amendment NARROWS this item; the lever
   is still unwired and `deliveryStatus` is unchanged.** *"Atomically"* is **dropped** from DE-20's
   `revocation` clause, because it described a transition no code performs. But *"the rollback lever
   cannot be pulled"* was too broad as written: **per-job cancellation ships and is routed** —
   `POST /organizations/:organizationId/companies/:companyId/jobs/:jobId/drain`
   (`server/src/routes/job-control.ts:218`, on the router mounted at `server/src/app.ts:498`) →
   `operations.drainJob` (`server/src/services/job-operations.ts:291`) →
   `reconciliation.requestCancellation({graceful:true})`, alongside JOB-006's operator cancel at
   `server/src/routes/worker-control.ts:988`. What has zero production callers is the **org-wide
   sweep bound to the rollout dial**, and that is what stays absent.
3. **DE-22 (High) — ★ CLOSED 2026-09-09. As filed: the evidence ledger's immutability check had
   never run, and the rule it would enforce was already broken in this repository's history.**
   `checkEvidenceImmutability` (at filing `scripts/check-distributed-execution-foundation.mjs:2633`;
   **the line was already stale when filed — it is `:2757`, denying at `:2763` and `:2765`**) had
   **zero production callers**: its declaration, a comment at `:2323`, and five call sites inside
   its own test file. ★ The landing unit measured the consequence rather than asserting it:
   `docs/replatform/artifact-policy.md:54,67` makes a QA record "write-once from its first commit",
   and `git log --follow` over
   `docs/replatform/epics/E5-workspaces-secrets/qa/2026-08-24-d0-e5-exit-gate-audit-a1.md` returns
   **two** commits — `6fc46988a` created it and `4379a2c53` rewrote it in place (+24/−4), inserting
   a paragraph that begins *"This record originally said […]. That is wrong."* while the record's
   own `Supersedes` field at tip still reads `— (E5 has no prior QA record; this is the first)`.
   The correction bypassed the Supersedes mechanism entirely, on a branch that merged CI-green,
   months after the deny function landed. Two further pairs were found by the auditor.

   ★ **CLOSED by mechanism, not by amendment.** `scripts/check-evidence-immutability.mjs`
   materialises both revisions' `qa/`+`handoffs/` records out of git blobs and calls the deny; the
   `policy` job of `.github/workflows/pr.yml` invokes it on every non-draft PR, handed the base
   through `EVIDENCE_IMMUTABILITY_BASE: ${{ github.event.pull_request.base.sha }}` (an `env:`
   binding, not an expression spliced into the shell, so the command is byte-identical under
   `scripts/ci-local.mjs`). **Proof that a previously-succeeding
   operation now fails:** committing an in-place edit to
   `docs/replatform/epics/E0-foundation/qa/2026-08-08-d0-e0-completion-3a469b6bec68-a1.md` — the
   exact move that merged CI-green in `4379a2c53` — turned the guard from exit 0 to exit 1 with
   *"base record … was modified after commit"*. **Positive control:** the same command on the
   un-mutated tree exits 0 over 29 base records, so this is not an always-deny. The RED case is
   real history, not a fixture: `scripts/check-evidence-immutability.test.mjs:50` replays
   `6fc46988a → 4379a2c53`, and `:64`/`:74` are its green controls (unchanged ledger passes; a new
   record added passes). Two further traps are closed: an **empty base** revision made the
   underlying deny return zero errors — a disarmed run indistinguishable from a clean one — and is
   now refused (`scripts/check-evidence-immutability.mjs:149`, test at `:99`); and
   `check-evidence-immutability.test.mjs:158` asserts pr.yml still names the caller, so deleting
   the caller goes red. It reads both sides out of git blobs rather than the worktree, which also makes it correct
   on a Windows checkout with `core.autocrlf=true`. **Scope, honestly:** this closes the *docs
   ledger* half of DE-22 only. The row stays `partial` — its redaction-on-transmit clause and the
   runtime `job_events` store's append-only property (code discipline, not a grant: `aoa_app`'s
   UPDATE/DELETE still succeed) are untouched, and REL-005 still has zero files on disk.
4. **DE-24 (Critical) — the update admission that would run on a host is not connected to one.**
   `evaluateUpdateAdmission` (`scripts/lib/update-admission.mjs:79-119`) is fail-closed and
   well-tested, and its only non-test reference is the *promotion-time* verifier map at
   `scripts/lib/release-manifest.mjs:66`. The host-side function that would refuse a tampered update
   before apply, `planUpdateSwap` (`packages/worker-keystore/src/install-layout.ts:236-251`),
   **verifies nothing** — `admitted`, `compatible` and `healthConfirmed` are injected booleans on its
   input type (`:210-216`) — and has **zero non-test callers**, as does `runDrainBeforeSwap`
   (`packages/worker-daemon/src/update/drain-before-swap.ts:102`). There is no code path by which an
   enrolled desktop host refuses a tampered update, and no host-side event to audit.
5. **DE-28 (Critical) — quarantine has no producer, so a live deployment shows zero quarantine
   traffic.** This is `E0-F011` item 1 reached from the other side: the *receiver* denies correctly
   (`job-control.ts:3741-3743`, `:3701-3708`; `quarantine-grant.ts:91`), and no shipped path can
   write a quarantined artifact row, because `runOrphanQuarantine` sits three layers behind the
   zero-production-caller `createStartupReconciler`. ★ **An operator must not read that silence as
   the control working.**

**Why HIGH.** (1) strands jobs and holds concurrency slots. (2) means the cutover row's stated
rollback guarantee is prose. (3) means the programme's own evidence discipline is unenforced and has
already failed silently, which is the exact `checks-that-nothing-runs` shape this repository keeps
paying for. (4) means the desktop supply-chain control stops at the release directory.

**What it is NOT.** None of the five is a wrong implementation, and (3) is not an accusation of bad
faith — the in-place correction it names was made in good faith and improved the record. The defect
is that nothing could tell the difference.

- **Affected crossings:** DE-18 *(resolved 2026-09-10)*, DE-20, DE-22 *(closed 2026-09-09)*, DE-24, DE-28.
- **Disposition:** `unowned`, and unevenly. (3) was the cheapest and is **done** — it went exactly
  the predicted way. ★ **(1) DE-18 is now also done (PR #418, 2026-09-10) — see item 1's amendment.**
  (2) and (5) need composition-root wiring no ticket on disk carries.
  (4) needs a host binary that does not exist. NOT `accepted`: HIGH may never be accepted.
- **★ Next, for whoever picks this up (grouped, so it needs no re-measuring).** ★ **(1) DE-18 is
  DONE — do NOT redo it (PR #418, 2026-09-10).** The scheduler this bullet asked for was wired: the
  fanout ticks inside the running MIG-002 `convergenceTick` (a garbage collector draining
  `execution_target_revocations`, not a deny — the authz cutoff already fires at
  `job-control.ts:1177`, stated at `:1127-1130`), and review additionally fixed the lease-less
  pinned-attempt gap. Nothing about (1) is owed. *(Historical, kept because the correction is only
  legible against it: it needed a scheduler draining `status='pending'` rows; the clause amendment
  was already done 2026-09-09.)* **(2) DE-20**'s
  lever AND its store are complete (`job-distributed-drain-store.ts:68` ships real SQL post-MIG-009)
  — it needs a real trigger on the rollout-dial-off path that actually invokes `drainAll`;
  ★ `GO-BOOK.md:2901` forbids composing it in `index.ts` merely to move the caller count.
  ★ **The word *"atomically"* has been DROPPED from the clause (2026-09-09) and the clause now
  records that per-job cancellation already ships at `routes/job-control.ts:218`→`:227`; only the
  org-wide sweep is owed.** *Needs mechanism built:* **(5) DE-28/E0-F011 item 1** needs a
  durable enumeration of quarantine candidates (none exists) **plus** composition-root wiring for
  the zero-caller `createStartupReconciler` — two problems, not one. **(4) DE-24** needs a host
  updater binary that does not exist *and* real verification inside `planUpdateSwap`, whose
  `admitted`/`compatible`/`healthConfirmed` are injected booleans — wiring it as-is would be a
  vacuous green.
- **Resolution condition:** each lever gets a production caller and a test that goes red when the
  caller is removed, or the clause it arms is AMENDED. **(3) met this on 2026-09-09 and (1) met it
  on 2026-09-10 (PR #418 — production caller + red-when-removed test); THREE remain (items 2, 4, 5),
  so this finding stays open.** Resolve = flip this Status and delete the `E0-F014` key in
  `scripts/finding-ownership.json` in the SAME commit.

## E0-F015 — Three crossings are `not-delivered` on measurement: one has no tenant parameter anywhere in its code path, one has every deny line behind a zero-caller factory, and one has a conformance suite that has never been run against the thing it certifies

- **Status:** open
- **Severity:** HIGH
- **Filed:** 2026-09-08, by W20B (the recovered-audit landing unit).
- **Blocks gate:** No, but read the severities: two of the three crossings are Critical.

**Why these are `not-delivered` and not `partial`.** `partial` requires at least one clause enforced
by a named line that was exhibited denying **on a path that ships**. These three have none.

1. **DE-23 (Critical) — the backup/restore crossing has no tenant dimension at all.** This is not a
   missing check; it is a missing *parameter*. `runDatabaseRestore` (`packages/db/src/backup-lib.ts:1056`)
   takes `{connectionString, backupFile, connectTimeoutSeconds}` (`:37-41`) and is therefore
   **structurally incapable** of a tenant decision; it pipes the whole dump into psql or, on the
   fallback, executes every statement unconditionally (`:1073-1075`). The backup is instance-wide:
   the default `auto` engine short-circuits at `:613` into `runPgDumpBackup` (`:618`), which runs
   `pg_dump` with `--clean --if-exists --no-owner --no-privileges` over the full DSN (`:388-393`) —
   no `-n`, no `--table`, no organization filter — and `RunDatabaseBackupOptions` has no
   organization field. ★ So the row's `failureMode`, *"a restore exposes or reintroduces another
   tenant's data"*, is **the default behaviour of the only documented invocation**. The one line the
   owning design nominates as the guard, `manifest-reconciliation.ts:103-105`, returns the string
   `"wrong_prefix"` inside a result struct — a classification, not a denial — runs *after* the
   restore has written the object, and sits in functions with zero production callers.
2. **DE-25 (High) — every folder-grant deny is behind a factory nothing calls.** The refusals are
   real and well-tested (`folder-grant-binding.ts:81,83,86,89`; `folder-grant.ts:148,151`) and every
   one is reached only through `createFolderGrantService` (`folder-grant.ts:66`), whose whole-tree
   caller census is its own declaration plus two test files. The module says so about itself at
   `:7-8`: it *"is INERT until a capture/reconcile path reads it"*. Daemon-side is worse than inert:
   `buildWorkspaceManifest` (`snapshot/build-manifest.ts:308`) is also zero-production-caller **and**
   does not confine its walk to a granted base. The `integrity` clause has no line at all —
   `detectIsolationMechanism` (`enrollment/isolation-capabilities.ts:86`) is never called in
   production and the single production site hardcodes `isolation: "none"`
   (`bin/worker-daemon.ts:536`), for which `capabilitiesForIsolation` returns `[]` (`:50`).
   `folder_grants` declares `revoked_at` (`packages/db/src/schema/folder_grants.ts:39`) and **no
   expiry column**, and `offlinePolicy: "cancel"` is written into every assignment
   (`job-leasing.ts:391`) and read by nothing.
3. **DE-26 (Critical) — the real-provider conformance run has never happened, and the mock it was
   run against is already known to diverge in exactly the way the row names.**
   `runSandboxIsolationConformance` (`packages/sandbox-provider-contract/src/isolation-contract.ts:89`)
   has exactly **two call sites, both keyless doubles** — the hostile fake, and
   `sandbox-e2b-provider/src/__tests__/conformance.test.ts:46` over a `MockE2bTransport`, whose own
   header says it runs *"with NO key and NO network"*. The one lane that touches real E2B
   (`.github/workflows/keyed-e2b-conformance.yml:79`) runs a file that never imports the suite, is
   `workflow_dispatch`-only, and is not in `ci-required`. ★ And the divergence is not hypothetical:
   `ListInput.ownershipSelector` is a **required** port field
   (`packages/worker-daemon/src/supervisor/provider.ts:288`); the fake honours it; the real provider
   forwards only `{pageSize, pageToken}` to the transport
   (`packages/sandbox-e2b-provider/src/e2b-provider.ts:412-414`) and returns **every sandbox in the
   E2B account**. The codebase already says so twice in its own comments
   (`packages/adapter-manager/src/reconcile-reaper.ts:104-106`; `owned-op-gate.ts:201-206`).
   **This is the `E8-F003` shape verbatim** — a field accepted, typed, required, honoured by the
   double, and inert in the real implementation — and it is the strongest available argument that a
   conformance suite run only against doubles cannot close a real-provider crossing.

**Why HIGH.** (1) is a Critical crossing whose stated failure mode is the code's normal behaviour.
(3) is a Critical crossing whose entire verification story is a suite that has never met its subject,
against a provider already measured dropping a required isolation input.

- **Affected crossings:** DE-23, DE-25, DE-26.
- **Disposition:** `unowned`. (1)'s successor is scoped but unbuilt (`DBR-001-design.md`, status
  "scoping"); (2)'s owner tickets shipped the pure functions and no caller; (3)'s owner `DEP-008`
  **explicitly scopes the real-provider half out** in its own design and repeats it in its result's
  residual risk, and `REL-004` names no `DE-` id at all — so DE-26's exit is chartered by two written
  tickets neither of which owns the control. Existence is not chartering. NOT `accepted`: HIGH may
  never be accepted.
- **Resolution condition:** (1) a restore entrypoint that takes a tenant and refuses a cross-tenant
  apply; (2) a production caller plus an anti-orphan directory-walk test in the style of
  `scripts/check-guard-inventory.mjs`; (3) one keyed run of the certified suite against the real
  transport, recorded per-check — the experiment is cheap, needs only the existing repo secret, and
  is written out in `docs/replatform/DE-AUDIT-live-experiments.md`. Resolve = flip this Status and
  delete the `E0-F015` key in `scripts/finding-ownership.json` in the SAME commit.

## E0-F016 — Two crossings assert a revocation or authority property their code does not have: capabilities that narrow "immediately" except for the one principal whose role rides a ten-minute token, and a context authority declared to end with a lease that is never consulted

- **Status:** open
- **Severity:** HIGH
- **Filed:** 2026-09-08, by W20B (the recovered-audit landing unit).
- **Blocks gate:** No.

**The class.** Not a missing mechanism (`E0-F012`) and not a dead lever (`E0-F011`/`E0-F014`), but a
clause whose *wording* is stronger than the code — where the honest remedies are "build it" **or**
"amend the sentence", and amending is a founder decision.

1. **DE-30 (Critical), `revocation`: "membership or enrollment changes IMMEDIATELY narrow
   capabilities."** For user, mcp and worker principals this holds, and holds well:
   `admittedUserRequester` (`packages/db/src/repositories/tenant/job-control.ts:1441-1467`) re-reads
   the organization membership with `status = 'active'` (`:1453`) and the company membership
   (`:1462`) inside the submission transaction, and the gate tests the **server-derived** kind
   (`server/src/services/job-submission.ts:174`, refusing at `:176`), never the client's claim.
   **The commander principal does not go through it.** The branch at `job-control.ts:1570-1577`
   accepts `input.principalRole` — a claim carried on the run JWT — provided the
   Organization→Company edge exists, and that JWT's TTL defaults to **600 seconds**
   (`server/src/agent-auth-jwt.ts:180`). A commander whose role is narrowed keeps the old scope for
   up to ten minutes. The clause says "immediately".
   *Secondary, and cheap:* nothing on the submission lane tests the requester-side revocation at
   all — deleting the `status='active'` predicate at `:1453` turns nothing red today.
2. **DE-19 (Critical), `authentication` and `revocation`: "a worker session with tenant/job/lease/fence
   authorization" and "context authority ends with the lease and fence."** Neither exists on the lane
   that ships. The distributed worker lane is **not instantiated** — `packages/worker-protocol`
   carries no memory or context field, and `worker-daemon`/`worker-networked-host` hold zero
   references to `AOA_API_KEY`, `AOA_API_URL` or `/mcp` — so the sandbox→MCP-broker lane is the only
   measurable one, and there the bearer is an agent JWT with a TTL and **no line anywhere checks run
   status on a memory read**. The token therefore outlives the run it was issued for. The
   `integrity` clause ("workers cannot write memory") is likewise unenforced: the outbound MCP
   fallthrough is not gated by the per-agent tool allowlist. There is also **no database backstop** —
   migration `0211` ENABLEs and FORCEs RLS on eight distributed-kernel tables and `memory_items` is
   not among them, so "never direct memory-table access" rests entirely on application code.

**Why HIGH.** (1) is a Critical crossing whose whole subject is that server-derived scope beats
self-asserted claims, and the one principal that still carries a role in a token is the one with the
broadest reach. (2) means a captured sandbox credential remains a valid reader of company memory for
its full token lifetime after the run that justified it has ended.

- **Affected crossings:** DE-19, DE-30.
- **Disposition:** `unowned`. (1) has two honest resolutions and they are different decisions:
  re-derive the commander requester through `admittedUserRequester` (dropping the `principalRole`
  token claim from the trust decision), or amend the clause to read "immediately for user/mcp/worker
  principals; bounded by the commander run-JWT TTL for the commander principal". (2) is `DAT-007`'s
  deferred half — its result document is explicit that the remote-reach core is blocked — and
  `REL-001`, the ticket that would close it at release level, has zero files. NOT `accepted`: HIGH
  may never be accepted.
- **Resolution condition:** each clause is either delivered against a named line or AMENDED to state
  the bound the code actually provides. **Do not leave a field asserting "immediately" while the code
  does not.** Resolve = flip this Status and delete the `E0-F016` key in
  `scripts/finding-ownership.json` in the SAME commit.

## E0-F017 — The CONTRACT half of DE-07's column retirement: `job_secret_handles.revoked_at` is now declared-but-unread, and the DROP that was withdrawn from this release still has to happen

- **Status:** open
- **Severity:** MED
- **Filed:** 2026-09-09, by the unit that withdrew the drop from the DE-07 ruling PR.
- **Blocks gate:** No.

**What shipped, and what did not.** The DE-07 founder ruling (see `E0-F011` item 2) retired
`job_secret_handles.revoked_at` as a revocation lever. The **EXPAND** half shipped: the column's only
reader — the `isNull(jobSecretHandles.revokedAt)` conjunct in `listActiveExecutionSecretHandles`
(`packages/db/src/repositories/tenant/job-control.ts`) — is removed, which is safe because
`status = 'active'` beside it was already the strictly stronger predicate. Nothing in the tree reads
the column now, and nothing ever wrote it. The **CONTRACT** half — the `DROP COLUMN` — did **not**
ship, and the migration that carried it (`0274_jittery_nehzno`) was removed from this branch along
with its journal entry and snapshot.

**Why the drop was withdrawn.** `scripts/deploy/remote-compose-deploy.sh` runs `rollback_previous`
from `on_exit` when a deploy fails after `MUTATION_STARTED`, and **nothing** in that sequence
(`restore_environment` → `rollback_previous` → `restore_current_link`) reverts the database. The
rollback therefore returns the **N-1 binary** to a **post-migration schema**. With the drop applied,
that binary comes back up still naming `revoked_at` — in `listActiveExecutionSecretHandles` and in
Drizzle's explicit full-row column lists — and every secret-handle operation fails with
`column revoked_at does not exist`. `docs/replatform/test-gates.md` D5-HA03 requires rolling
deployment and N/N-1 compatibility, so shipping a destructive DDL beside its reader removal is a
contract violation, not merely a risk. It was also caught only after the same PR had first shipped
the drop unguarded and then "fixed" it with `DROP COLUMN IF EXISTS` — an idempotency guard that
makes **replay** safe and does nothing whatever for **rollback**.

**Why this is filed rather than just deferred.** A vestigial column with a comment is exactly the
kind of thing that survives forever. The precondition is objective and checkable, so it is written
down here instead of trusted to memory.

### ★★ The merged commit's TITLE claims a drop the commit does not contain

`deb13d01f` — *"Four founder rulings executed: **DE-07 column drop**, DE-18/DE-20 clause amendments,
capabilityProven disclosure, E6-F020 scope boundary (#393)"* — is the commit this finding was filed
from. **There is no column drop in it.** Migration `0274_jittery_nehzno` was removed from the branch
before merge (with its journal entry and snapshot), and `revokedAt: timestamp("revoked_at", …)` is
still declared at `packages/db/src/schema/job_secret_handles.ts:101`; what the commit actually does
to that file is **add** the twenty-line vestigial comment above the declaration. Its message **body**
repeats the same claim (*"`job_secret_handles.revoked_at` is DELETED … `pnpm db:generate` produced
0274"*), so both halves of the commit message are stale and **the diff is the only accurate record**.

**How it happened.** The PR body was rewritten when the ruling was split into an expand step and a
contract step; the PR **title** was not. A squash merge takes its subject from the PR title, so the
stale title became the permanent commit subject.

**It cannot be repaired.** `deb13d01f` is merged on `docs/replatform-program`; rewriting it would
rewrite every descendant. **This note is the repair** — and it is placed here, rather than in a
commit-hygiene document, because this finding is where someone reading about the withdrawn drop
actually arrives. **The drop is deferred, not done**; the precondition and resolution condition below
are what govern it.

★ **The process lesson, in one line.** A PR title goes stale the moment scope changes mid-PR, and it
becomes the **permanent** squash-commit title — so it must be re-read against the diff at merge time,
not written once at open time.

- **Affected crossings:** DE-07 (the `revocation` clause; the column is not what enforces it —
  device-grained revocation via `revokeWorker` → `bumpExecutionTargetGeneration` → the
  `target_revoked` deny at `job-control.ts:1177` is), DE-29 (clause (b), same chokepoint).
- **Precondition for the contract step:** **no deployable binary still names the column.** Concretely:
  the release that carries the reader removal has been promoted, and the oldest binary any rollback
  path can restore is at or after it — i.e. the N-1 rollback window for that release has closed.
  Until then the declaration stays.
- **Disposition:** `unowned`. No shipped ticket owns `job_secret_handles`' column set; `DAT-004`
  (which added the column in `0250`) has a result document on disk, and naming a completed ticket
  would be the false-ownership claim `E4-F013` exists to refuse.
- **Resolution condition:** one `db:generate` migration dropping `revoked_at` (Drizzle schema edit
  only — never hand-authored DDL), landed in a release **after** the one carrying this PR, together
  with: the schema comment deleted, the `revoked_at` entry in the
  `server/src/__tests__/secret-broker.integration.test.ts` column assertion flipped back to
  `.not.toContain("revoked_at")`, and DE-07 + DE-29's `deliveryEvidence` updated from
  "declared but unread" to "dropped". Resolve = flip this Status and delete the `E0-F017` key in
  `scripts/finding-ownership.json` in the SAME commit.

### Decision 2, Unit B — the reader and the disclosure path (`E0-F013` acceptance conditions (a) and (c))

Landed 2026-09-09, in the SAME WAVE as the sink, because the ruling says both halves must ship
together or it becomes the failure it exists to fix. Unit B touched **no file Unit A owns** — not
the `activity_log` schema, not a migration, not `security-denial-audit.ts`, not the threat-controls
JSON. It changes **no crossing status and no finding status**: the residue Decision 2 owns (DE-03,
DE-15, five of DE-06's six fence throws) is Unit A's, and none of it is claimed here.

**(c) THE DISCLOSURE PATH — measured LATENT, then closed anyway.** The paper found
`activityService.forIssue` reading `activity_log` with **no company predicate**, served at
`GET /issues/:id/activity` behind a check on *the issue's* company, while `entityType`/`entityId`
are caller-supplied free text on the denial recorder.

- **Blast radius, measured before choosing** (the paper asked for this, and the answer changes
  nothing about whether to fix it, only about how to describe it). All three production callers of
  `recordSecurityDenial` **hard-code** their `entityType`: `memory_item`
  (`mcp/tools/read-tools.ts`), `job_artifact` (`services/artifact-commit.ts`,
  `services/artifact-transfer-grant.ts`). **None types `issue`.** So no denial row reachable through
  `forIssue` exists today, and `company_id` is still NOT NULL, so no tenantless row exists either.
  The denial-namespace exposure was **LATENT, not LIVE** — one future writer, or one
  caller-chosen `entityType`, away. It is fixed now because the ruling removes the second of the two
  things that were accidentally containing it.
- ★ **But the cross-company read itself was LIVE and was observed.** The provocation test was run
  against the unchanged tree and the planted tenant-B row **came back to a tenant-A reader**. The
  latency is in *reaching* the reader with a denial row, not in the reader.
- **Fix: `forIssue` is now scoped by company** (`services/activity.ts`, `routes/activity.ts` passes
  `issue.companyId` — the same company the gate above it authorized). Chosen over the paper's other
  option (bar the denial namespace from entity types an unscoped reader keys on) because that would
  have to be enforced inside `security-denial-audit.ts` — **Unit A's file this wave** — and it
  protects only the rows it knows about, leaving `forIssue` cross-tenant for every other writer.
  Scoping the reader fixes the reader, which is where the defect is.
- **It is also the defence against the nullable column, by construction:** a NULL `company_id` never
  satisfies `company_id = $1`, so a tenantless denial row is invisible to this reader the moment
  Unit A lands, with no further change.
- ★ **THIS IS A SITE FIX, NOT A CLASS FIX, and the difference is stated rather than implied.** The
  second company-unscoped reader — `inspectMarketplaceReconciliation`
  (`services/marketplace-reconcile.ts`) — **is untouched**. It is instance-wide by design (its
  operation spans many companies, so there is no single company to scope it to). It was measured
  separately and does **not** disclose denial rows: every row it selects is then filtered by exact
  `action` equality against three `marketplace.reconciliation_*` literals, and only surviving rows
  reach `started`/`terminal` and therefore its output. That is containment by **downstream
  construction**, not by this change, and it would stop holding if a future reader used those rows
  unfiltered.

**(a) THE READER for `security.denied.*`.** The paper measured that **no production reader of that
namespace existed anywhere** — three writers, a namespace guard and prose. Shipped:
`GET /api/instance/security-denials` (`routes/activity.ts` →
`activityService.securityDenials`), cross-tenant, newest-first, filterable by crossing / surface /
actor / resource / tenant / `since`, page size clamped 1–500 (default 100) in the service, with a
keyset cursor (`before`/`beforeId`) for the tail.

★ **A CLAIM THIS ENTRY PREVIOUSLY MADE AND THAT WAS FALSE, corrected rather than quietly dropped.**
This paragraph, the service doc comment, the routes comment, the PR body and the unit report all
said the clamp meant "a query string cannot become an unbounded scan". It does not. It bounds the
RESULT SET. Raised as a P2 by review, then measured on real Postgres (embedded-pg + the committed
migration chain, 60,300 rows: 60,000 ordinary product rows and 300 denials, `ANALYZE`d):

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM activity_log WHERE action LIKE 'security.denied.%' ORDER BY created_at DESC LIMIT 100;

Limit  (cost=1806.98..1807.23 rows=100 width=168) (actual time=2.928..2.935 rows=100.00 loops=1)
  ->  Sort  (cost=1806.98..1807.78 rows=320 width=168) (actual time=2.927..2.930 rows=100.00 loops=1)
        Sort Key: created_at DESC
        Sort Method: top-N heapsort  Memory: 50kB
        ->  Seq Scan on activity_log  (cost=0.00..1794.75 rows=320 width=168) (actual time=2.864..2.887 rows=300.00 loops=1)
              Filter: (action ~~ 'security.denied.%'::text)
              Rows Removed by Filter: 60000
```

The LIMIT sits above a Sort which sits above a full sequential scan: 60,000 rows are read and
discarded to produce a 100-row page. ★ A FALSE CLAIM OF ENFORCEMENT IS WORSE THAN A MISSING CHECK,
so all five surfaces are reworded to "bounds the result set" and the index is filed below rather
than implied. (A `since` bound does narrow it — the planner reaches
`activity_log_company_created_idx` for the `created_at >=` predicate — but the default
incident-response call has no `since`.)

**NOT DONE — the missing index, and why it is NOT added here.** ★ **RESOLVED 2026-09-10 by Unit B-2
below (migration `0276`), which is where the measured before/after plans are.** The paragraph is kept
as written because its reasoning — *why* it was deferred, and to whom — is the record of a deliberate
hand-off rather than an oversight, and the hand-off completed. `activity_log` wants a partial index
supporting the denial prefix in newest-first order, e.g. on `(created_at DESC)`
`WHERE action LIKE 'security.denied.%'`. It is not added in this unit because
`packages/db/src/schema/activity_log.ts` is **Unit A's file this wave** — Unit A is editing that
exact `(table) => ({...})` index block (adding `organizationId`, `activity_log_organization_idx` and
the `activity_log_company_or_denial_check`) and owns migration `0274`. A second index migration
generated from Unit B would collide on both the hunk and the migration number, and the right shape
for the index is a question that should be answered once `organization_id` exists. Owner: the wave
that owns the schema file. Until then the reader is correct and slow, which is stated, not hidden.

- **Who can read it:** the **operator plane** only — `assertCanManageInstanceSettings`, which reads
  `req.actor.operator` (or the `local_implicit` self-hosted board) and deliberately **not**
  `isInstanceAdmin`, which cloud_auth clamps to false to kill the data-plane bypass. It is
  unreachable by any company member, founders included, in every deployment mode.
- ★ **THE DISCLOSURE QUESTION — FOLLOWING DE-06's PRECEDENT, AND SAYING SO.** Both live writers
  attribute a cross-tenant refusal to the **actor's own** tenant, never the probed one, and DE-06's
  test asserts the **probed** tenant's `activity_log` is EMPTY. This reader follows that precedent:
  it adds **no per-company denial feed**, so the probed tenant still learns nothing about having
  been probed or by whom. Whether a probed tenant is *entitled* to know is Decision 3's question and
  is **not** pre-empted here.
  - ★ **UPDATE 2026-09-11 — Decision 3 RULED (founder); Q3 IMPLEMENTED for the tenant-facing readers
    (slice 1).** The founder ruled best-practice throughout
    (`docs/replatform/DECISION-REQUEST-denial-retention-and-disclosure.md`, ★ RULED block): Q1 ratify
    actor-attribution + probed tenant stays blind; **Q3 — also do NOT disclose a `security.denied.*`
    row to the actor's OWN tenant.** This PR implements Q3 for **five** tenant-facing `activity_log`
    readers — the four the paper's §3 census named (`activityService.list`, `homeService.summary`,
    `cockpitTeammatesActivity`, `morningDigest`) PLUS `activityService.forIssue` (GET
    `/issues/:id/activity`), added after a Codex P2 on PR #429 flagged it as a fifth tenant reader:
    `recordSecurityDenial` accepts `entityType:'issue'`, so the disclosure boundary must not depend on
    "no writer files a denial under an issue" — all five now go through ONE shared
    `notDenialNamespace()` predicate exported beside `SECURITY_DENIAL_ACTION_PREFIX`
    (`server/src/services/activity-namespace.ts`),
    proven RED-first per reader by
    `server/src/__tests__/e0-f013-denial-own-tenant-disclosure.integration.test.ts`. The operator
    reader (`activityService.securityDenials` / `GET /instance/security-denials`) is deliberately
    untouched and still returns the row. **This closes ONLY the "prober is informed via its own
    tenant's feeds" corner of the disclosure axis.** It does **not** close `E0-F013`, which stays
    **open**: Decision 3's other slices — the fourteen tenant-less deny sites (Q3-sites, an
    operator-only sink WITH a write bound, **pending slice 2**) and retention (Q4 lifetime + Q5
    tamper-resistant delete, **pending slice 3**) — are unshipped, and `DE-16`/`DE-21` remain
    `partial` in their cohorts with their conjuncts (subscribe/replay, reconciliations) untouched.
    No count is struck and no crossing status changes.
  - ★ **UPDATE 2026-09-11 — Decision 3.2 (Q3-sites) IMPLEMENTED — slice 2 (`decision3-tenantless-sink`).**
    The **fourteen** tenant-less deny sites now record to the OPERATOR-ONLY sink (`company_id NULL`,
    caller-supplied company in `entity_id`) with the founder's required write bound. Sites: the six
    `authorizeUpgrade` board/session/`!key` branches
    (`server/src/realtime/live-events-ws.ts`, via `live-events-tenantless-denial-audit.ts`, surface
    `security.denied.live_events_upgrade_unattributed`) and the eight plugin-cloud-gate branches
    (seven `rejectBlockedCloudExecution` caller-supplied-company sites in `server/src/routes/plugins.ts`
    + `server/src/routes/company-plugins.ts` rollback, via `cloud-plugin-denial-audit.ts`, surface
    `security.denied.cloud_plugin_execution`). The bound (`server/src/services/bounded-denial-recorder.ts`)
    caps rows per `(surface, coarse-source-key)` window and aggregates the remainder into a
    suppressed-count row; the coarse key is the remote address (hashed), **never** the caller-supplied
    company/entity id an attacker varies at will. Memory is bounded (`maxKeys` eviction flushes pending
    counts). M1 is in-memory / process-local (resets on restart; a durable / cross-replica bound is the
    named follow-up). Proven RED-first by `server/src/__tests__/bounded-denial-recorder.test.ts` (flood
    M≫N → ≤ N+1 rows + a recorded suppressed count) and
    `server/src/__tests__/decision3-tenantless-sink.integration.test.ts` (each site writes a real
    operator-sink row against Postgres; the operator reader surfaces them; the tenant feed does not).
    ★ **NARROW — this closes NOTHING else.** `E0-F013` stays **open** (slice 3 retention Q4/Q5 pending).
    `DE-21` stays `partial`: its `subscribe`/`replay` conjuncts still have no writer, and the five
    agent-key branches were already Class 1. `DE-16` stays `partial`: as of this
    slice (2) its `reconciliations` conjunct was untouched — **★ that conjunct is now DELIVERED
    (2026-09-13, the DE-16 reconciliation-audit unit): `reconcileCloudBlockedPlugins` writes a durable,
    real-tenant `security.reconcile.cloud_plugin_blocked` `activity_log` row per reconciled plugin via
    `recordCloudPluginReconcileToBlocked` (`server/src/services/cloud-plugin-reconcile-audit.ts`), proven
    by `server/src/__tests__/de-16-reconciliation-audit.integration.test.ts`** — but the **nine**
    no-company residue sinks are Decision 2's already-ruled remainder (not wired here), the
    lifecycle-activation block sink still needs a unit, the MCP agent dispatch path
    (`dispatchPluginToolCall`) is un-audited (follow-on, distinct real-company+agent-actor shape), and the
    four untraced sinks (§4.3) remain unmeasured. No count is struck and no crossing status changes.
  - ★ **FOLLOW-ON FILED 2026-09-13 (E0-F013) — the MCP agent plugin-dispatch deny writes no durable
    row.** The DE-16 reconciliation-audit unit delivered the RECONCILIATIONS conjunct and, while
    measuring the "dispatch" conjunct, confirmed the board tool-dispatch route is audited
    (`recordCloudPluginDenial`) but the **MCP agent broker path is NOT**: `dispatchPluginToolCall`
    (`server/src/mcp/tools/plugin-broker-tools.ts:176`) returns a `forbidden` envelope on the cloud
    block (its sole production caller is the `tools/call` handler at `server/src/mcp/server.ts:689`)
    and writes nothing to `activity_log`. This is a **DISTINCT SHAPE** from the eight board sinks
    Decision 3.2 wired: it carries a REAL FK-valid `companyId` and a VERIFIED agent run
    (`agentId`/`runId` from the run-JWT), so its record is a normal company+agent-attributed row, NOT a
    tenantless (`company_id` NULL) operator-sink row, and it must NOT reuse `recordCloudPluginDenial`'s
    per-IP bounded operator sink. Not folded into the reconciliations delivery; tracked here under
    `E0-F013`. DE-16 stays `partial` partly on this gap.
  - ★ **UPDATE 2026-09-11 — Decision 3.3 (retention): Q5 IMPLEMENTED WHOLE, Q4 PARTIAL (window recorded, enforcing purge deferred to E0-F018) — slice 3 (`decision3-retention`).**
    **Q5 (tamper) is delivered WHOLE.** A `security.denied.*` denial record now SURVIVES the deletion of
    the company it incriminates — a founder can no longer erase the operator plane's only copy of their
    own probing by deleting their own tenant. Two changes: (1) the `activity_log.company_id` FK moves
    from `ON DELETE cascade` to `ON DELETE set null`
    (`packages/db/src/schema/activity_log.ts`, migration `0280_classy_warstar.sql` — activity_log FK ONLY,
    by `db:generate`), making the COMPANY axis agree with `organization_id`'s existing `restrict`; (2)
    `companyService.remove` (`server/src/services/companies.ts`) no longer blanket-deletes the company's
    `activity_log` rows — it NULLs the `security.denied.*` rows (the partial CHECK
    `company_id IS NOT NULL OR action LIKE 'security.denied.%'` admits a null company for exactly these)
    and deletes the ordinary rows BEFORE the company delete, so the FK's set-null never fires on a
    non-denial row (which would violate the CHECK and make the company undeletable). Proven RED-first by
    `server/src/__tests__/e0-f013-denial-retention-survives-delete.integration.test.ts`: a company with
    BOTH a real (recorder-planted) denial row and an ordinary row is deleted; the denial row survives with
    `company_id NULL` and is still returned by `activityService.securityDenials`, the ordinary row is gone,
    and the delete succeeds. Observed RED against the pre-slice-3 blanket delete (the denial-survival and
    operator-reader arms both failed). **Q4 (lifetime) is delivered AS A RECORDED WINDOW, purge DEFERRED.**
    `SECURITY_DENIAL_RETENTION_DAYS = 365` is now a named, documented policy constant
    (`server/src/services/activity-namespace.ts`) — the explicit window the founder's ruling required,
    replacing "unbounded, and nothing says so". The bounded, record-leaving purge is NOT wired here: a
    recurring host exists (the sweeper block in `server/src/index.ts`), but the founder's "a purge that
    itself leaves a record" half collides with the partial CHECK — an instance-wide purge has no single
    company, so its durable purge-audit row carries a NULL `company_id` under a NON-`security.denied.`
    action, which the CHECK rejects. Making that record legal is a further schema sub-decision, filed as
    **E0-F018** (unowned) rather than half-built. The constant is declared-and-unenforced and says so.
    ★ **NARROW — this closes NOTHING else.** `E0-F013` stays **open**: `DE-16`/`DE-21` remain `partial`
    with their conjuncts untouched, and the fourteen tenant-less sinks (slice 2) plus the disclosure
    readers (slice 1) are unaffected here. No count is struck and no crossing status changes.
- **Why an operator query rather than a UI** (the ruling invited the narrower answer): the evidence
  is instance-wide and its audience is one operator working an incident. A company-scoped UI is the
  one shape that would answer Decision 3 by accident, in the direction that discloses. Documented at
  `docs/api/activity.md`.
- **Forward-compatible with Unit A on purpose:** the reader projects every column the schema object
  carries (`getTableColumns`) rather than a hand-written list, so the nullable `company_id` and the
  new `organization_id` appear the moment they land, with no compile-time coupling to a column that
  does not exist yet. Rows with a NULL `company_id` are visible **only** here — no company-scoped
  reader can match them.
- ★ **THE TAIL — a second false-completeness surface, raised as a P1 by review and FIXED rather than
  documented away.** As first shipped, the reader's only temporal filter was `since`, a **lower**
  bound, with the order newest-first and no `before`, cursor or offset. Past `limit` matching rows
  the OLDEST evidence was therefore unreachable through the only production reader of the namespace:
  moving `since` earlier only ever adds NEWER rows. That is **evidence written and unreachable** —
  the exact failure acceptance condition (a) exists to prevent — reappearing in the tail, so it is
  part of the condition and not a follow-up.
  - **Fix:** a keyset cursor, `before` + `beforeId`, over a total order (`created_at DESC, id DESC`).
    Keyset rather than OFFSET because `created_at` is **not unique** — one `INSERT ... SELECT` of
    denial rows shares a single `now()` — and a timestamp-only cursor SKIPS the rest of a tie with
    `<` or repeats it forever with `<=`. Half a cursor (`beforeId` without `before`) is a `400`, not
    a silently ignored filter.
  - ★ **AND THE CURSOR IS EMITTED, NOT INFERRED — a defect found while fixing the first one.**
    Postgres orders these rows at MICROSECOND precision; `created_at` reaches a client as JSON,
    where it is a `Date` truncated to MILLISECONDS. Measured on the same embedded Postgres, **40
    rows written by 40 separate statements produced 40 distinct microsecond timestamps and only 21
    distinct millisecond ones** — so a cursor built from `createdAt` would have skipped 19 of 40
    rows silently, with a `200` and no error. That is the same "unreachable evidence" failure
    wearing a pagination name, so the reader emits an explicit full-precision `cursor` field
    (`to_char(... 'US')`) and `before` is carried as **text** end to end, never parsed into a
    `Date`, and cast to `timestamptz` in SQL.

**Which of the two P1/P2 review findings was substantive:** both. Neither was a false alarm, and
neither was answered by argument.

**PROOF — one file, provocation not read-back:**
`server/src/__tests__/e0-f013-denial-disclosure-path.integration.test.ts` (real Postgres, real
route, real service, real `recordSecurityDenial`). Both halves are asserted **against the same
planted row**, which is what makes "we hid it" distinguishable from "we lost it".

- **OBSERVED RED against the unchanged tree** on exactly the provocation arm, with all three named
  positive controls green — the same-tenant row still returned, the planted row present in the table
  by raw SQL, and the route answering 200. The cross-company read is real, not inferred from the
  predicate. ★ **The count that observation was reported with — "1 failed / 3 passed" — belonged to
  the 4-arm (c)-only stage and is corrected here:** the file is now **11 arms**, and the equivalent
  measurement on it is mutant 1 below, **1 failed / 10 passed**. A stale arm count in an evidence
  claim is the same species of defect as the scan claim above, so it is corrected rather than
  carried.
- **Mutants killed, each reding the arms it should and no others, re-run against the 11-arm file:**
  1. drop the company predicate in `forIssue` → **1 failed / 10 passed**, the failure being exactly
     *"★ THE PROVOCATION"*;
  2. widen the namespace predicate to `LIKE '%'` → *only* "returns only the reserved namespace" reds;
  3. remove the operator gate → *only* "closed to a company member" reds;
  4. disable the cursor predicate → **2 failed / 9 passed**, both cursor arms and nothing else. Two
     arms is correct rather than imprecise: the microsecond arm pages through the same cursor, so a
     dead cursor legitimately reds it too;
  5. truncate the emitted `cursor` from microseconds to milliseconds (`'US'` → `'MS'`) →
     **1 failed / 10 passed**, *only* the microsecond arm. This is what stops a future reader
     deleting the `cursor` field as redundant with `createdAt`;
  6. remove the half-cursor refinement → **1 failed / 10 passed**, *only* "half a cursor is refused".
- 11/11 green on the shipped tree.

**NOT DONE, and left open:** (i) the marketplace reader (above) is contained, not scoped; (ii) the
missing denial-prefix index, filed above and owned by the wave that owns the schema file — the
reader is correct and does a seq scan per page. No finding, crossing or register entry is closed or
amended by this unit.

> ★ **STATUS OF THOSE TWO, 2026-09-10.** (ii) is **DONE** — Unit B-2 below, migration `0276`, with
> the plan change measured and pasted. (i) is **STILL OPEN and unchanged**: `inspectMarketplaceReconciliation`
> is contained by downstream exact-`action` equality, not scoped, and Unit B-2 did not touch it.

### ★ UNIT B-2, 2026-09-10 — the two acceptance conditions Unit B owed, discharged; and the premise for one of them was already stale

Unit B shipped the reader and scoped `forIssue`. It left two items, and this unit was briefed to do
both. ★ **ONE OF THEM WAS ALREADY DONE, AND SAYING SO IS THE FIRST DELIVERABLE.** The brief for this
unit described the tail defect — *"no `before`/cursor bound; past 500 matching rows the oldest
incident evidence is unreachable"* — as outstanding. It is not. It was raised as a P1 **during**
review of PR #402 and fixed inside that same PR: `before`/`beforeId`, a total order
(`created_at DESC, id DESC`), an emitted microsecond `cursor`, and a `400` on half a cursor are all
present at `743c30f08` and covered by three arms. The squashed commit message still carries the
pre-review body, which is where the stale premise came from. ★ **The stale artefact is a COMMIT
MESSAGE that describes the first commit of a PR rather than the PR** — worth naming as a defect
shape, because it will recur on every squash-merged PR that is fixed under review.

**So this unit did not rebuild it.** It verified it instead — the cursor arms were run and are green,
and the mutation table below leaves them alone. An exoneration needs more evidence than a
conviction, so the verification is a run, not a reading of the diff.

#### (a), second half — THE INDEX. Migration `0276`.

A **partial** index, `(created_at DESC, id DESC) WHERE action LIKE 'security.denied.%'`, generated
by `pnpm db:generate` from `packages/db/src/schema/activity_log.ts`. The only hand edit is
`IF NOT EXISTS` — C14 class (a), exemplars 0189/0195/0240/0274. Drizzle reported *"No schema
changes, nothing to migrate"* on a re-run, so the snapshot and the schema agree.

★ **THE NAMESPACE RIDES THE PREDICATE, NOT THE KEY.** Indexing `(action)` would not serve
`LIKE 'prefix%'` as a range without `text_pattern_ops`, and even where it could it would leave the
`Sort` in place. Putting the namespace in the index predicate makes the filter free; keying on the
reader's own total order makes the ordering free.

★ **`nullsFirst()` IS LOAD BEARING, AND IT WAS NEARLY SHIPPED WRONG.** Bare `DESC` in a query means
`DESC NULLS FIRST`; drizzle's bare `.desc()` emits `DESC NULLS LAST` **for an index**. The first
generated version of `0276` used the default. Measured, that version removes the Seq Scan and
**keeps the Sort** — a half-fix that looks like a fix in every summary that says "the index is
used". The counterfactual plan is pasted below so the next person does not re-learn it.

**MEASURED ON REAL POSTGRES** (embedded-pg + the committed migration chain; 60,300 rows — 60,000
ordinary product rows and 300 denials; `ANALYZE`d). The query is the one
`activityService.securityDenials` emits.

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM activity_log WHERE action LIKE 'security.denied.%'
ORDER BY created_at DESC, id DESC LIMIT 100;

-- BEFORE (no denial index) -------------------------------------------------
Limit  (cost=1862.87..1863.12 rows=100 width=192) (actual time=5.487..5.495 rows=100.00 loops=1)
  Buffers: shared hit=1098
  ->  Sort  (cost=1862.87..1863.60 rows=291 width=192) (actual time=5.486..5.490 rows=100.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 50kB
        ->  Seq Scan on activity_log  (cost=0.00..1851.75 rows=291 width=192) (actual time=5.396..5.434 rows=300.00 loops=1)
              Filter: (action ~~ 'security.denied.%'::text)
              Rows Removed by Filter: 60000
              Buffers: shared hit=1098
Execution Time: 5.516 ms

-- AFTER (migration 0276, DESC NULLS FIRST) ---------------------------------
Limit  (cost=0.27..176.48 rows=100 width=192) (actual time=0.005..0.017 rows=100.00 loops=1)
  Buffers: shared hit=6
  ->  Index Scan using activity_log_denial_created_idx on activity_log  (cost=0.27..470.75 rows=267 width=192) (actual time=0.004..0.013 rows=100.00 loops=1)
        Index Searches: 1
        Buffers: shared hit=6
Execution Time: 0.026 ms

-- COUNTERFACTUAL (same index, drizzle's DEFAULT `.desc()` = DESC NULLS LAST) --
Limit  (cost=556.62..556.87 rows=100 width=192) (actual time=0.081..0.087 rows=100.00 loops=1)
  ->  Sort  (cost=556.62..557.40 rows=314 width=192) (actual time=0.080..0.082 rows=100.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 50kB
        ->  Index Scan using activity_log_denial_created_idx on activity_log  (... rows=300.00 loops=1)
```

★ **THE DEEP PAGE — the plan the NOT-DONE entry was actually about.** "Deep paging is O(table) per
page" was a claim about the *cursor* query, not the first page, so that is the one that had to
change. The keyset row-value comparison moves from a per-row `Filter` to an `Index Cond` — a seek:

```
... AND (created_at, id) < ('2026-09-09T19:16:28.765028Z'::timestamptz, '96c006b0-…'::uuid)

-- BEFORE ------------------------------------------------------------------
Limit → Sort → Seq Scan on activity_log
  Filter: ((action ~~ 'security.denied.%') AND (ROW(created_at, id) < ROW(…)))
  Rows Removed by Filter: 60251
  Buffers: shared hit=1098          Execution Time: 3.208 ms

-- AFTER -------------------------------------------------------------------
Limit → Index Scan using activity_log_denial_created_idx on activity_log
  Index Cond: (ROW(created_at, id) < ROW(…))
  Buffers: shared hit=2 read=2      Execution Time: 0.034 ms
```

**What the index does NOT do,** stated because the previous version of this claim was overstated in
five places: it does not make the reader *safe*, it does not bound the result set (`clampDenialLimit`
does), and `CREATE INDEX` is not free — a partial index still scans the whole heap to build, holding
a `SHARE` lock that blocks writes to `activity_log` for the duration. `CONCURRENTLY` is unavailable
because drizzle's migrator runs each file in a transaction. That is written into `0276` rather than
omitted.

#### (c), the tenantless half — the case that could not be tested before, and can be now

Unit B proved (c) against a **tenant-B** row. That row is excluded because `company_id = $A` is
**false** for it. A **tenantless** row is excluded for a different reason — `company_id = $A` is
**NULL**, and SQL's three-valued logic drops it. Unit B's shipped comment asserted that difference
(*"a NULL `company_id` never satisfies `company_id = $1`"*) and no arm exercised it, because
`company_id` was still `NOT NULL` when it was written: the tenantless namespace was **empty**, so
any such arm would have passed vacuously. `0274` made the column nullable, so the arm can now fail,
which is the only thing that makes it worth adding.

Six arms added to `e0-f013-denial-disclosure-path.integration.test.ts`, all against a row planted
through the **real** `recordSecurityDenial` with `companyId: null`, typed `issue` against tenant A's
issue id:

1. the plant, with a positive control asserting `company_id IS NULL` in the table by raw SQL;
2. ★ the tenantless provocation — `GET /issues/:id/activity` does not disclose it;
3. the **second** company-scoped door, `GET /companies/:companyId/activity`, does not either
   (fencing one reader is not fencing the room);
4. ★ **the complement** — the operator reader **does** return it. "Invisible everywhere" would be a
   failure, not a success: that is evidence written and unreachable, the exact defect condition (a)
   exists to prevent. Hidden and reachable are asserted against the **same** row;
5. narrowing the operator reader to one tenant **excludes** the tenantless row rather than adopting
   it — an `OR company_id IS NULL` "be helpful" filter would attribute an unattributable refusal to
   a named tenant;
6. ★ **DE-06's invariant re-asserted rather than assumed** — the **probed** tenant (A, the target of
   both probes) still owns **zero** denial rows. Nothing here adds a per-company denial feed.

**No arm depends on any unlanded unit.** `0274` is in the committed chain at this commit and
`recordSecurityDenial`'s `companyId` is already typed `string | null`, so every row these arms need
can be written today.

#### ★★★ THE FALSE CLAIM OF ENFORCEMENT THIS UNIT SHIPPED, AND WHAT REPAIRED IT

**The defect.** The first version of this unit put the same causal sentence on three surfaces —
`docs/api/activity.md`, the `securityDenials` comment in `server/src/services/activity.ts`, and the
plan file's own header — saying in effect: *changing the action prefix, the sort columns or the sort
direction silently reverts the plan to `Sort <- Seq Scan` with no error and **no failing test**,
which is why the plan file asserts the plan.* The header additionally claimed the file planned *"the
two queries the reader really emits"*.

**The measurement. It did not.** Dropping `desc(activityLog.id)` from `securityDenials`' `ORDER BY`
— the exact "sort columns" drift the sentence names, and the loss of the total order both the keyset
cursor and the index shape depend on — left **both suites 23/23 GREEN**. Neither file noticed. The
plan file never imported `activityService`: `FIRST_PAGE_SQL` and `deepPageSql()` were
**hand-transcribed string literals**. It was EXPLAINing a **copy** of the reader's query, and after
any drift the copy is no longer the query — which is precisely the moment the guard is needed. The
matched pair the prose warned about was unguarded by the artefact the prose named as its guard.

**Two things were wrong, not one.**

1. *The guard.* Fixed by derivation: the plan file now builds both plans from
   `activityService(db).securityDenials(...)` via drizzle's `getSQL()`/`toSQL()`, so there is no
   second copy to drift away from. (Parameterized `EXPLAIN` is sound here because node-postgres
   issues one-shot extended-protocol queries, so Postgres plans with the values bound and folds them
   to constants before testing predicate implication — and the positive control proves that
   empirically rather than by argument.)
2. *The claim.* The sentence was also **factually wrong about one of its three drifts**, and
   deriving the SQL does not fix that. Measured: dropping the `id` tiebreaker **does not change the
   plan at all** — `created_at DESC` alone is a *prefix* of the index key order, so Postgres keeps
   `Limit <- Index Scan`. What silently breaks is the total order the cursor needs. A plan assertion
   cannot see it, however faithfully derived. So a **MATCHED PAIR** arm was added, comparing the
   `ORDER BY` the reader emits against `pg_indexes.indexdef` — the index's own rendering, not a
   third transcription. All three surfaces now carry the corrected, per-drift claim.

This is the `checks-that-nothing-runs` class in its exact form:
**a false claim of enforcement is worse than a missing check.** The distinguishing detail worth
carrying forward is that the guard's *inputs* were the copy, not its assertions — the assertions
were right, the subject was wrong. A guard that reads its subject from a literal is a guard against
the literal.

#### Proof — observed red, per arm, with the positive controls named

24 green on the shipped tree (17 in the disclosure file, 7 in the plan file, which gained the matched
-pair arm). Mutants, each reding the arms it should and no others:

| # | Mutation | Result |
|---|---|---|
| 1 | `forIssue`: `company_id = $1` → `OR company_id IS NULL` | **1 failed / 16 passed** — *only* the tenantless provocation. ★ Unit B's cross-tenant provocation stayed **GREEN**, which is the proof the new arm tests a property the existing 11 did not. |
| 2 | `forIssue`: drop the company predicate entirely | 2 failed / 15 passed — both provocations, nothing else. |
| 3 | `securityDenials`: `companyId` filter widened with `OR IS NULL` | 1 failed / 16 passed — *only* "narrowing … excludes the tenantless row". |
| 4 | `securityDenials`: add `company_id IS NOT NULL` to the base predicate | 1 failed / 16 passed — *only* "★ THE TENANTLESS ROW IS REACHABLE". |
| 5 | remove migration `0276` (the `.sql` file) | 7 failed / 0 passed in the plan file — `applyPendingMigrations` throws on the missing file, so `assertSetupOk` reds every arm. (It was 4/2 when `0275` was the tail of the chain and the failure was the absent index rather than an absent file. Recorded because the *shape* of the red changed and only the reason makes it legible.) |
| 6 | `0276`: `DESC NULLS FIRST` → drizzle's default `DESC NULLS LAST` | 4 failed / 3 passed — the half-fix is caught, now by the matched-pair arm as well as the plan arms. |
| **7** | ★★★ **`securityDenials`: drop `desc(activityLog.id)` from the `ORDER BY`** | **BEFORE the fix: 0 failed / 23 passed — the defect above.** AFTER: **1 failed / 23 passed in the plan file — *only* the matched-pair arm**, with the message `reader: created_at desc` / `index : created_at desc, id desc`. ★ The **drop-and-degrade positive control stayed GREEN** under this mutant, which is what proves the two are not wrongly coupled: the plan really is unchanged, and the arm that reds is the one that reads the two artefacts against each other. |
| 8 | `securityDenials`: sort direction `desc(created_at), desc(id)` → `asc, asc` | **BEFORE: 0 failed / 6 passed.** AFTER: 4 failed / 3 passed — the plan arms and the matched pair. The positive control's final "restored" assertion also reds, honestly: an `ASC` reader cannot walk this index at all, so there is no good plan to restore to. |
| 9 | `securityDenials`: action prefix `security.denied.` → `security.refused.` | **BEFORE: 0 failed / 6 passed.** AFTER: 5 failed / 2 passed. |

★ **Mutants 7, 8 and 9 are the three drifts the prose claims to guard, and MEASURED, ALL THREE WERE
UNGUARDED** — each was run against the pre-fix file, restored from git, and each came back
**6/6 green** (7 additionally green across both suites, 23/23). Not two of three: three of three. The
first draft of this entry guessed that mutant 8 was "guarded by accident because the transcription
pinned the direction"; that guess was **wrong and was corrected by running it**, which is the same
discipline the entry is about. The transcribed literal is inert with respect to *every* reader-side
change, because the file did not import the reader at all. What the pre-fix file did guard is the
INDEX side only — mutants 5 and 6.

★★★ **A PHANTOM MUTANT, RECORDED BECAUSE IT WENT GREEN AND SHOULD NOT HAVE.** Mutant 5 was first
attempted by deleting the index migration's entry from `packages/db/src/migrations/meta/_journal.json`. **The
suite passed all 6 arms with the entry gone.** Two separate reasons, both worth knowing:

- `@armyofagents/db` resolves through `dist/` in some paths, and `dist/migrations` is a **copy** made
  by the package's `build` script. Editing `src/migrations` leaves the copy the suite reads untouched
  — the mutation was inert and the green was phantom.
- After removing the entry from **both** journals it *still* passed. Removing the `.sql` **file** is
  what finally reds it. ★ **A JOURNAL ENTRY IS NOT WHAT MAKES A MIGRATION APPLY** — `applyPendingMigrations`
  falls through to a manual reconcile that picks the file up from the folder. Anyone mutating a
  migration to observe red must delete the **file**, and must delete it from whichever tree the
  suite actually loads.

This is the same failure class as *a check that nothing runs*: an unobserved mutation is not
evidence, and the only reason it was caught here is that the mutant was expected to red and did not.

#### The plan guard, and why it cannot pass vacuously

`server/src/__tests__/e0-f013-denial-index-plan.integration.test.ts` asserts the **plan** rather than
a wall-clock time (a timing threshold on a shared runner is a flake generator, and a fast query
proves nothing about a table two orders of magnitude larger). Its arms assert the **absence** of
`Seq Scan` and `Sort`, and an absence assertion is worthless unless the presence is achievable on
that data on that machine. So one arm **drops the index, re-plans the identical query on the
identical rows, and requires the documented bad plan to appear**, then restores the index from the
definition Postgres itself reports. If the good and bad plans were indistinguishable at 40,000 rows,
that arm fails and the file certifies nothing.

★ **AND ITS SUBJECT IS THE READER, NOT A COPY OF THE READER.** Both plans are built from
`activityService(db).securityDenials(...)` through drizzle's `getSQL()`, and the deep page is built
by handing the reader back its own emitted `cursor` + `id` — which is how a client pages. The file
holds no SQL literal for the query under test. See the false-claim section above for what happened
when it did.

One mechanical note, recorded because it cost a run: a drizzle query builder is a **thenable**, so
returning one from an `async` helper makes `await` execute it and hand back **rows**. The deep-page
helper returns the builder boxed in an object for that reason. A helper that silently turns a query
into a result set is the same defect class in miniature.

#### NOT DONE, and left open

- **(i) `inspectMarketplaceReconciliation` is still contained, not scoped.** Unchanged by this unit.
  It remains a site fix, not a class fix, and this unit did not widen it into one.
- **The index's BUILD cost is unmeasured at production scale.** A partial index still scans the whole
  `activity_log` heap to build, holding a `SHARE` lock that blocks writes for the duration;
  `CONCURRENTLY` is unavailable because drizzle's migrator runs each file in a transaction. Only the
  resulting *plan* is measured, never the build.
- **The plan guard runs against embedded-postgres at 40,000 rows, not production scale.** The
  degradation arm proves the plans are distinguishable *at that size on that machine*; it does not
  extrapolate.
- **Other `activity_log` readers outside this router were not audited.** This unit's claims cover
  `activityService.list`, `forIssue` and `securityDenials`. Whether any other reader of that table
  has the same shape of defect is not answered here.
- **Decision 3 is not pre-empted.** No per-company denial feed was added; the probed tenant still
  learns nothing, and arm 6 above is what holds that line.
- **No finding is closed, no crossing changes status, no cohort count is struck, and no
  `deliveryStatus` is upgraded by this unit.** E0-F013 stays open.

---

### Unit W20-B — the two clause-halves Decision 1 measured as deliverable, wired (`E0-F013`). Neither finding closes.

**Date:** 2026-09-10. **Base:** `6b39c77f6`. **Scope:** DE-11 conjunct 5b (retention audit) and
DE-20 conjunct 4a (cutover selection audit). **Production code + two integration suites + register
evidence.** No clause text amended, no ownership moved, no `deliveryStatus` upgraded, no gate-clause
enrolment, no cohort count struck.

#### What the code now does

- **DE-11 (5b).** `resolveStoredRetention` (`artifact-retention-authority.ts:49-58`) is a live
  control-plane retention decision called at `artifact-commit.ts:272` and branched on at `:276`.
  That branch previously emitted a `logger.warn` whose own comment said *"This is a LOG LINE, not an
  audit record — DE-11 claims retention is audited and nothing audits it"*. It now captures a record
  intent (`:295`) drained after the tenant transaction closes, on the pool handle, at the
  `recordRetentionDecision(input.appDb, retention.intent)` call in the outer drain (`:482` at this
  PR's HEAD — the call is the citation, the number only a hint) —
  gated on `response.outcome === "committed"`, because the decision runs *before* the mutator and
  three refusal branches sit after it. Recorder: `artifact-retention-audit.ts`, writing one
  `activity_log` row per OVERRIDE carrying company (the locked lease's), organization
  (token-attested), worker, artifact, kind, **and both `declaredRetention` and `storedRetention`**.
- **DE-20 (4a).** One `appendRunEvent` at `heartbeat.ts:5388` (seq from the in-process counter), placed AFTER `canaryExecutionOwner`
  is assigned and BEFORE `shouldSuppressLegacyExecution` (`:5457`) reads it, writing a
  `distributed_execution_selection` event for **both** arms. Before this, a distributed selection
  wrote a `distributed_execution_handoff` row and a legacy selection wrote **nothing durable** — so
  "the cutover selected legacy" was indistinguishable, in the database, from "this run was never a
  cutover candidate". The builder (`cutover-selection-audit.ts`) is total over `RunExecutionOwner`,
  so "both arms are audited" is a property of the type, not of a reviewer remembering a second call
  site. Best-effort, because that `try`'s only handler is a `finally` and a throw would reach
  `executeRun`'s outer catch, which promotes a deferred wake — an audit write must never become a
  double-execution lever.

#### The namespace decision, stated because it was a real choice

A retention override is **not a refusal**. Filing it under `security.denied.` would make *"count the
denial rows"* stop answering *"count the refusals"* — the exact property the denial reservation in
`activity-namespace.ts` exists to hold. So it gets its own reserved prefix, `security.retention.`,
enforced at the same two writers that accept a caller-supplied `action`. The partial CHECK from
migration `0274` does **not** cover the new prefix, deliberately: a retention row always has an
FK-valid company, and a company-less retention decision should be refused by the database.

#### ★★★ NEITHER FINDING CLOSES, and both are conjunctions

- **DE-11 stays `partial`, on two independent grounds.** (i) Its clause is *"sensitive-artifact
  ACCESS **and** RETENTION are audited"* and only the retention half is delivered; the access half's
  missing piece is **DE-06's** own open successful-put/get conjunct. (ii) **The coverage caveat:**
  nothing in production uploads `browser_cookie_state`/`browser_storage_state` (BRW-003 unbuilt), so
  the record is live but has never once been about a credential-bearing kind. The proving test
  provokes that kind **by hand** and pins it as test-provoked in the arm title.
- **DE-20 stays `partial`.** Its clause is *"cutover selection **and** rollback transitions"*. The
  rollback conjunct is **vacuous and untouched**: `createDistributedExecutionDrain`
  (`job-distributed-drain.ts:114`) still has **zero production callers**, re-measured by a
  comment-stripping census over `server/src`. That conjunct is **Decision 1's to rule on** and
  `E0-F014`'s to own; this unit did not amend it, did not touch the separately-amended `revocation`
  clause, and did not move DE-20 out of any cohort.

#### Reds observed, each against a named positive control

Each suite carries **10 arms** at this PR's HEAD (`de-11-retention-audit.integration.test.ts` and
`de-20-cutover-selection-audit.integration.test.ts`). Both were 9 at `ede424371`; the Codex-fix
commit added the tenth to each — and in each case **the tenth arm is the one that proves that
commit's fix**. Re-counted at HEAD on external review, because the register row for each was edited
in the same commit that added the arm and was not re-counted then.

- **DE-11**: checking `artifact-commit.ts` out at base **reds 3 recording arms, 6 controls green**
  — a complete account of the suite **as it stood for that run** (9 arms). The tenth (the
  idempotent-replay arm) was added afterwards and was **not** re-run against base; it was observed
  RED against the unfixed post-review code, which is the narrower claim.
  Dropping the `committed` gate reds **only** the refused-commit arm. Moving the action into
  `security.denied.` reds **only** the three namespace-asserting arms. The pre-existing DE-06 suite's
  *"a COMMITTED artifact writes NO denial row"* arm stays green as the regression control.
- **DE-20**: dropping the legacy `reason` reds the legacy arm with the distributed arm green;
  replacing the builder call reds **only** the position arm; **relocating** the append to after the
  suppression branch reds **only** the append-before-suppression assertion.

#### ★★★ Citation staleness, measured — and this unit shipped the defect once itself

Re-measuring at source found that **the Decision 1 paper's own corrected citations are already
stale**, including one its correction table marked *"✔ EXACT"*:

| Cited | Where the paper put it | Where it is now (`6b39c77f6` unless a row says otherwise) |
|---|---|---|
| upload-prefix deny | `artifact-transfer-grant.ts:113` → paper: `:180-184` | `:187` |
| download committed-row check | `:201-202` → paper: `:295`/`:300`/`:302` | `:296`/`:299`/`:304`/`:306` |
| `wrong_prefix`/`tenant_mismatch` — the two guards at the head of `commitArtifactVersion` | `job-control.ts:2750`/`:2751` — **paper: "✔ EXACT"** | `:3109`/`:3110` at `6b39c77f6` (359-line drift), and `:3120`/`:3121` at this PR's HEAD — **moved again by this unit's own JSDoc.** ★ Cite the two guards, not the numbers |
| the "LOG LINE" comment | register: `artifact-commit.ts:172-173` → paper: `:259-260` | `:263-265` (now removed) |
| suppression gate / return / execute | register: `:5399`/`:5451`/`:5453` | `:5457`/`:5509`/`:5511` — **shifted by this unit's own edit** |
| lease-candidate eligibility, `offerLease`, CHECK — cite the `eq(jobAttempts.placementLeaseEligible, true)` terms and the `if (!attempt) return null`, not the numbers | register: `:1947`, `:2318-2328`, `job_attempts.ts:95-112` | `:2306`, `:2669`+`:2680-2687` at `6b39c77f6`; `:2317`, `:2680`+`:2691-2698` at this PR's HEAD — **shifted again by this unit's own JSDoc**, which moved every line in `job-control.ts` below `:631`. `job_attempts.ts:95-135` unmoved |

All corrected in the register, with the correction itself recorded there rather than silently applied.

★ **And the failure class caught this unit in the act.** The first draft of the DE-20 rollback arm
asserted `heartbeat.ts` does not contain `createDistributedExecutionDrain` — and it went **red
against this very PR**, because the wiring's own comment names the symbol while explaining that it
has no callers. **A prose match is not a caller census.** Replaced with a comment-stripping census
carrying its own anti-vacuity control. Separately, the byte scan caught a **U+200B** this unit had
inserted into a comment to avoid closing a block comment — the invisible-byte defect, found before
push rather than after.


#### Post-review: two Codex P2 findings, both real, both fixed with their own observed-red arms

Neither was a style note; both were defects in this unit's own new code, and both are in the
"a check that passes for the wrong reason" family this programme keeps re-learning.

1. **An idempotent commit replay would have duplicated the retention record — and worse.**
   `commitArtifactVersion` answers `outcome: "committed"` in **two** cases: it inserted the row
   (its `replayed: false` return, `job-control.ts:3162` at this PR's HEAD), or the artifact was
   **already** committed and it returned the existing row unchanged (its `replayed: true` return,
   `:3176`). The first gate checked only the outcome. So an ordinary transport retry
   would mint a second row — and a replay declaring a **different** retention class would mint a row
   asserting a `declared`/`stored` pair **that was never decided for the persisted artifact**, since
   nothing in that call wrote anything. The row alone cannot distinguish the two cases, so the
   mutator now returns an explicit `replayed` boolean (the one production consumer is
   `artifact-commit.ts`) and its `if (row.replayed) retention.intent = null` statement (`:389` at
   this PR's HEAD) drops the intent on a replay. The `logger.warn` is deliberately
   kept: a worker re-declaring a class the control plane does not honour is still worth seeing
   operationally; it is just not a new *decision*.

2. **The selection append took its seq from a `max(seq)` read, which collides on the legacy arm.**
   The first draft copied `markRunHandedOffToDistributed`'s max-based form. That is correct *there*
   — it sits outside `executeRun` and cannot see the in-process counter — and wrong *here*. At the
   append site the counter is already `2` (the "run started" lifecycle event consumed `1`) while the
   durable max is `1`, so `projectionSeqBase(1) + 1` **also** yields `2` and leaves the counter
   untouched; the next `seq++` event reuses `2`. `(run_id, seq)` is a **non-unique** index, so
   nothing errors — the rows silently interleave and a resume-by-seq reader can drop one, which is
   exactly what `projectionSeqBase`'s own doc comment was written about. ★ It bites **only the legacy
   arm**, because the distributed arm returns at the suppression seam and never appends again — i.e.
   precisely the arm this change adds. Fixed to `seq++`, which also removes a DB round-trip.

Each fix carries a new arm, **observed RED against the unfixed code before the fix was restored**:
the replay arm asserts one row across three commits of the same artifact (the third declaring a
different class), and the seq arm asserts the call site uses `seq++` and **not** `projectionSeqBase`
— with an anti-vacuity control that `markRunHandedOffToDistributed` genuinely still uses the
max-based form, so the arm asserts a *difference between two real call sites* rather than a property
no site has.

★ **One process note, recorded because it is the same failure class again.** The first attempt at
this register edit was written through a shell command whose backticks were **substituted by the
shell**, silently deleting the words `` `replayed` `` from the middle of a sentence — leaving
"*the mutator now reports  and artifact-commit.ts…*". It was caught by reading the landed bytes
back rather than trusting the "0 anchors missed" report. **An anchor that matched is not a
replacement that landed.**

★★ **And the closing claim of that same commit was false, which is worse than the defect it was
closing.** Commit `030e71152`'s message ends *"Citations shifted by these fixes were re-measured
across all five surfaces that carry them"*, and the PR body carried the same sentence. **They were
not.** `artifact-commit.ts` kept `job-control.ts:3148`/`:3160` in three places — the pre-JSDoc
numbers — while the register, in the same commit, had the post-JSDoc `:3162`/`:3176` right. So the
tree disagreed with itself, and the sentence asserting the sweep is the reason nobody looked. **A
FALSE CLAIM OF VERIFICATION IS WORSE THAN A MISSING ONE**: an unmeasured citation invites the next
reader to measure it; one asserted as re-measured tells them not to bother. Corrected on external
review 2026-09-10; the commit message is immutable, so this paragraph and the PR body are the
retraction. Every citation this unit touched is now stated **by symbol**, with the line kept only
as a hint.

#### NOT DONE, and left open

- **DE-11's access half.** Untouched. It rides DE-06's existing put/get obligation.
- **DE-20's rollback conjunct (4b).** Untouched, and deliberately left for Decision 1 / `E0-F014`.
- **An AGREEING retention declaration writes nothing.** Exception-based auditing by design (the
  stored value is on `job_artifacts.retention`), but it means "no row" must not be read as "no
  commit". Stated in the recorder header and asserted by its own arm.
- **Neither writer has ever run in a deployment.** DE-20's cutover has zero deployment hits and the
  browser upload path does not exist; both records are proven in CI only.
- **The DE-06 and DE-28 rows carry the same stale `artifact-transfer-grant.ts:113` citation.** Not
  corrected here — this unit measured DE-11 and DE-20 and will not amend rows it did not audit.
- **The register's `E0-F013` Group-D arithmetic is untouched.** Whether DE-11 or DE-20 leave any
  cohort is Decision 1's call, not this unit's.
- **No finding is closed, no crossing changes status, no cohort count is struck, and no**
  **`deliveryStatus` is upgraded by this unit. E0-F013 stays open.**

## E0-F018 — Decision 3.3 Q4's retention window is declared but NOT enforced: `SECURITY_DENIAL_RETENTION_DAYS = 365` names the bound, and nothing purges `security.denied.*` rows past it, because the founder-required "purge that itself leaves a record" collides with the partial CHECK

- **Status:** open
- **Severity:** MEDIUM
- **Filed:** 2026-09-11, by the Decision 3 slice 3 unit (`decision3-retention`), which shipped Q4 as
  a recorded window and Q5 whole (see the Decision 3.3 slice-3 update above).
- **Blocks gate:** No — a retention-enforcement gap, not an enforcement-of-denial gap. Denial
  evidence is now durably recorded (slices 1/2) and tamper-resistant against a company delete (Q5,
  this slice); what is missing is the periodic *bounding* of how long it lives.

**What was shipped, and what was not.** The founder ruled Q4 explicitly (2026-09-11): the lifetime of
a `security.denied.*` record is **bounded**, "with a purge that itself leaves a record." Slice 3
delivered the **window** — `SECURITY_DENIAL_RETENTION_DAYS = 365`, a named + documented policy
constant in `server/src/services/activity-namespace.ts` — replacing the prior "unbounded, and nothing
says so." It did **not** deliver the **purge**. The constant is declared-and-unenforced, and both it
and this finding say so; A FALSE CLAIM OF ENFORCEMENT IS WORSE THAN A MISSING CHECK, so nothing reads
the constant to delete rows yet.

**Why the purge was deferred rather than bolted on.** It is not "wire a cron" — a suitable recurring
host already exists (the sweeper block in `server/src/index.ts` that schedules `scheduleTtlSweeper` /
`scheduleCleanupRetrySweeper` / `registerHeartbeatWatchdogSweeper`; the orphaned
`startPluginLogRetention` in `plugin-log-retention.ts` is the exact batched-delete-past-a-window
shape to copy). The blocker is the founder's **"a purge that itself leaves a record"** half. A purge
of `security.denied.*` rows older than the window is an instance-wide operation with **no single
company**, so its durable purge-audit row would carry a NULL `company_id` under a
NON-`security.denied.` action — and the partial CHECK `activity_log_company_or_denial_check`
(`company_id IS NOT NULL OR action LIKE 'security.denied.%'`, migration `0274`) **rejects** exactly
that row. Making the record legal needs one of: (a) a further CHECK change on `activity_log` admitting
a company-less purge/retention namespace, or (b) a separate operator-audit store for
purge events. Both are schema/audit-namespace sub-decisions beyond this slice's scope, and (a) is
adjacent to the Decision-2 CHECK the founder has already ruled on — so it is filed, not guessed.

**Also unaddressed by the window alone:** M1 of any purge is process-local like the slice-2 write
bound; a durable/cross-replica retention job (one leader, not one-per-replica) is part of the same
follow-up.

- **Disposition:** `unowned`. No shipped ticket owns the `activity_log` retention sweeper or the
  purge-record CHECK question; naming a completed ticket would be the false-ownership claim `E4-F013`
  exists to refuse. It waits on a decision on HOW a company-less purge leaves a durable record (CHECK
  amendment vs. separate store), then the batched sweeper wired into the existing host.
- **Resolution condition:** a bounded purge of `security.denied.*` rows with `created_at` older than
  `SECURITY_DENIAL_RETENTION_DAYS`, in capped batches, hooked into a recurring host, that (1) purges a
  row older than the window, (2) keeps a row younger than it, (3) purges NOTHING outside the
  `security.denied.` namespace, and (4) writes a durable record of the purge — each proven RED-first —
  plus the schema decision that makes (4) legal under the partial CHECK. Resolve = flip this Status and
  delete the `E0-F018` key in `scripts/finding-ownership.json` in the SAME commit.
