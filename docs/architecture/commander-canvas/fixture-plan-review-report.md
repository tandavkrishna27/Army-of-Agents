# Universe — review: F4/F5 fixture-repair plan (Stage A diagnostic)

**Reviewed documentation head (SHA):** `de72b8f4d480ab805258848b8d5fe665b6ea1e27` ("plan bounded F4 F5 fixture investigation"), local == `origin/codex/universe-interface`.
**Universe source pin:** `183e46a9c65fc3105c7e3d125629276814df7dbb`. **Tested replatform candidate:** `9200a66c42633019349de937a8b97979acac0f7a`. **Local correction commit (not in repo):** `b5cc42643223c433a8263564c7142761472a13d9` (descendant of the candidate).
**Change:** docs-only across the 3 commits since the last review (0 non-docs); adds `fixture-repair-plan.md` (153L), `baseline-correction-results.md`, `baseline-correction-review-report.md`, `fixture-static-evidence.json`, and the executed F1/F2/F3 evidence dir. Review-only: no tests/edits/containers.

## Verdict

**Yes — Stage A is sufficiently concrete for TK to approve as a bounded diagnostic.** It names one patchable test file, an exact non-mutating stage-timing helper, two invocations, exact bounds (15 min/command, 30 min total), exact source/patch identity, preserved timeouts/assertions, full-container cleanup between runs, and an honest stop-for-repair-selection gate. Every F4/F5 source and evidence claim I could check is **accurate**, and the F4/F5 files are **blob-identical between the candidate and the local correction source** (verified). The staging (A diagnostic → B gated repair → C gated qualification) is clean, and the plan does **not** claim runtime readiness — the baseline remains not-green. **No Critical/High/Medium findings**; three LOW items and one review limitation.

---

## Verification (all confirmed)

**Blob-identity — "these paths are unchanged in the local correction source":** all 10 named files (`blocked-task-scan.integration.test.ts`, `backup-lib-non-system-schemas.test.ts`, `embedded-pg-port.ts`, `migrated-database.ts`, `runtime-provider-keys-with-secret.integration.test.ts`, `client.ts`, the three `vitest.config.ts`, and `patches/embedded-postgres@18.1.0-beta.16.patch`) have **git-blob SHAs at candidate `9200a66c` identical to `fixture-static-evidence.json`'s recorded blobs at the correction commit.** So the correction touched only the F1/F2/F3 files; the F4/F5 files are byte-identical. **CONFIRMED.**

**F4 source (at candidate = correction):**
- `blocked-task-scan.integration.test.ts:38` `const PORT = 58000 + Math.floor(Math.random() * 1000)` — random, **no probe**. `setupError` (36) via `catch (err) { setupError = err }` (92-93); `if (setupError) return`/`throw` (119/125). A `reject()` with **`undefined`** ⇒ `setupError = undefined` ⇒ falsy ⇒ `beforeEach` proceeds to `db.execute` on an unset db. **Truthiness loss CONFIRMED in tracked source.** `afterAll(…, 60_000)` (108).
- `embedded-pg-port.ts`: `allocateEmbeddedPgPort` probes `listen(port,"127.0.0.1")`/close (28-31); comment 15-16 explicitly acknowledges "a tiny TOCTOU window… between closing the probe socket and embedded-pg binding" — the **close-to-bind race**. So the probe reduces, not eliminates, collisions. **CONFIRMED.**
- Patch changes only `LC_MESSAGES_LOCALE`/env inheritance, **not** the `reject()`/stop listener. **CONFIRMED** (matches "the patch does not touch the early-close rejection or stop listener").
- Published collision evidence (`fixture-collision.log`): `runtime-provider-keys` binds **58293** at 16:06:36; `blocked-task-scan` at 16:06:41 → "could not bind … Address already in use … port 58293." **CONFIRMED.**

**F5 source + evidence:**
- `backup-lib-non-system-schemas.test.ts:41` `beforeAll(async () => {…})` with **no timeout arg**; `allocatePort` (12/44), `pg.start()` → `pgStarted=true` (47-48), `afterAll` `if (!pgStarted) return; await pg.stop()` (60-62). **CONFIRMED.**
- `packages/db/vitest.config.ts` has **no** `hookTimeout` → Vitest's **10s default**; root `vitest.config.ts` sets `hookTimeout: 30_000` (18) but does not apply to the DB project. **CONFIRMED** the plan's "root timeout is not evidence the DB project inherited it; the effective limit is 10s."
- Published `final-shard-4.summary.log:709` `Error: Hook timed out in 10000ms.` at `backup-lib-non-system-schemas.test.ts:41` `beforeAll` (2 tests skipped, 10004ms). Prior candidate passed the backup suite in **7.660s**. **CONFIRMED** — a 7.66s→>10s swing strongly suggests load variance against a too-tight default (which the diagnostic is designed to measure).

**Library-internals evidence (F4 lost-error + stale exit-listener):** the `reject()` (index.js:192-193) and `stop()` `exit`-listener (214/226) claims come from **installed `node_modules` in the stopped container** (SHA-256 recorded), not from tracked git — see LOW-1.

---

## Requirement-by-requirement

### F4 checks — sound (source-verified; fix robust)
- **Random-port collision:** verified (line 38, no probe; 58293 collision in evidence). Proposed fix adopts `allocateEmbeddedPgPort()`; the plan repeatedly states the probe "does not eliminate the subsequent bind race" and "must not be described as a complete concurrency guarantee." Honest about the probe's limits.
- **Installed-library rejection with no value + truthiness loss:** the tracked-test consequence (`undefined` → falsy `setupError` → unset-db access) is verified; the fix throws from `beforeAll` with a named stage and preserves the cause (incl. `undefined`), removing all `if (setupError)` branches so setup can't be mistaken for success.
- **Stale exit-listener cleanup:** fix records `pgStarted=true` only after `start()` resolves and does not call `stop()` on the already-closed failed-start child — robust whether or not the exact library internals match.

### F5 checks — sound (diagnostic-first, honest)
- **Preserves the effective 10s hook limit + assertions:** Stage A runs "with the unchanged project timeouts, concurrency, test assertions and skip rules"; "No hook-timeout increase or third run"; preserves all four blocked-task + both backup assertions. The 10s is verified as the DB-project default.
- **Captures each setup await:** the `stage()` helper wraps every existing await (data-dir, backup-dir, port, initialise, start, create-database, 5 seed SQL calls, seed-client-end, teardown stop) **without reordering** and without changing resolution/rejection/timeout.
- **Isolated vs unchanged shard load:** two runs — `--project=@armyofagents/db backup-lib…` (isolated) and `--shard=4/4` (recreates the observed load; F5 was on shard 4) — "a diagnostic contrast, not a retry to obtain a green score."
- **Late work after timeout, no pretend-cancellation:** "stop the entire isolated container so a timed-out hook cannot leave late-starting PostgreSQL processes competing with the next run. **A Promise timeout is not cancellation.**" Correct handling of the exact hazard.

### Stage/process challenges — satisfied
- **Stage boundaries:** A = diagnostic only ("makes no production or committed fixture repair"); B = "proposed repair boundary, not executable yet"; C = clean-commit qualification + adoption. "Stage A is proposed for approval, not already authorized… Stage B/C are not bundled into Stage A." Clean.
- **Exact patch/source identity:** correction SHA `b5cc4264` + hashed cumulative diagnostic patch against it + recorded HEAD/patch-hash/tracked-file hashes; blob SHAs recorded and verified against the candidate.
- **Two-run/time limits:** 2 commands, 15 min each, 30 min total, "No hook-timeout increase or third run."
- **Cleanup:** stop container between runs; "Do not delete DB directories or kill processes by port on the host"; forced termination recorded distinctly.
- **Regression requirements (Stage B):** a comprehensive fault table (occupied port, start-rejects-undefined, start-rejects-Error, failure-after-start, successful F4, F4-with-competing-fixture, F5 real backup, F5 partial setup), with "One pass is not a proof of eliminating every race."
- **Evidence justifies the direction:** F4 direction is source-justified and fault-tested; **F5 direction is explicitly withheld** ("the pending F5 cause makes a complete combined implementation diff unjustified today; this is an explicit evidence gate") — the correct posture (measure first).
- **Diagnostic vs gated repair vs qualification distinguished:** yes, unambiguously.

**Regression/scope:** slice counts 69/69, docs-only, over-claim scan clean; accepted V1/V2, UX/privacy/version and DESIGN/host obligations explicitly unchanged; baseline correctly reported **not green** (24,242 passed / 4 failed / 78 skipped; two failed suites; build not run).

---

## Findings (severity-ranked)

**No Critical/High/Medium.**

- **[LOW-1 — evidence provenance] F4's library-internals root cause rests on `node_modules` inspection I cannot verify from git.** The `start()` `reject()`-with-no-value (index.js:192-193) and `stop()` stale-`exit`-listener (214/226) come from the stopped container's installed `embedded-postgres` (SHA-256 recorded), not tracked source. The **tracked-test** truthiness-loss consequence is verified, and the F4 fix (throw-on-any-error; don't-stop-failed-child) is robust regardless of the exact library behavior. Note the provenance; the Stage-B repair review should re-read the pinned installed dependency at implementation.
- **[LOW-2 — F4 skips a runtime diagnostic] F4 proceeds to a proposed Stage-B repair on static evidence, unlike F5 (which gets Stage A).** Justified — the F4 source cause is verified in tracked source and the fix throws on any error + is fault-injection-tested. But `baseline-correction-results.md` itself notes "the exact asynchronous fixture path producing an unset database without a truthy setupError still needs focused inspection." So the Stage-B repair review should confirm the fix covers the **observed** unset-db path, not only the modeled one (the throw-on-any-error design makes this likely, but confirm at review).
- **[LOW-3 — F5 diagnostic reproducibility] A 2-run diagnostic may not reproduce a load-dependent timeout.** The prior 7.660s pass vs the now-`>10s` timeout strongly points to **load variance against the too-tight 10s DB-project default**, for which a *measured fixture-local budget increase* would be the legitimate fix (not a mask). The plan correctly measures first and permits "a fixture-local budget… with measured justification" while refusing a blind bump/rerun-until-green — but TK should expect a plausible outcome of "non-reproduction / raise the fixture-local hook budget with evidence," which is a fix, not a defect. The plan handles both branches.
- **[LIMITATION — review-only] I did not re-run tests or read `node_modules`.** I verified all tracked F4/F5 source anchors, the 10-file blob-identity vs the candidate, the patch content, the DB-project 10s-default config, and the published collision/shard evidence excerpts; I relied on the published evidence for the runtime observations (58293 collision, 10004ms hook timeout, 24,242/4/78 counts). The baseline remains **not green / unresolved**; the corrected result is a future, approval-gated output.

---

## Standing caveats (unchanged; not defects)
- Planning + static-review only; code sketches uncompiled; the diagnostic, the F4 repair boundary and the F5 repair are proposals awaiting explicit per-stage approval.
- **Approving Stage A authorizes only the bounded backup diagnostic (one test-file patch, two runs, cleanup between).** F4/F5 source repair (Stage B) and clean-commit qualification + base adoption + Universe implementation (Stage C) remain separate, later approvals. Accepted product/privacy/version/scope decisions are preserved. No edits, installs, tests, container starts, provider calls, branch changes, commits or merges are authorized by this review.

*Reviewed doc head `de72b8f4d480ab805258848b8d5fe665b6ea1e27`; source pin `183e46a9c65fc3105c7e3d125629276814df7dbb`; tested candidate `9200a66c42633019349de937a8b97979acac0f7a`.*
