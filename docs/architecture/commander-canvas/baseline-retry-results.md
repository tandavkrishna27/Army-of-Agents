# Universe — approved offline baseline retry results

September 12, 2026. **The authorized retry is complete; BASE qualification is not green and implementation remains paused.** TK answered “yes” to the exact environment correction proposed in [the first attempt's report](baseline-preparation-results.md). This authorized one container-only pnpm correction and one repeat of the existing offline command sequence, not source changes, dependency changes, another corrective retry or source-base adoption.

## Result and recommendation

The missing direct pnpm command is resolved. Both source revisions pass the five approved prebuilds and full recursive workspace typecheck. All four Vitest shards ran for each revision. Both have the same three failed test identities and one unhandled error. The candidate adds nine passing admission-audit tests; there is **no observed candidate-only failure in these runs**, but neither run is a clean baseline. Root build was not run because tests failed, as required by the approved dependency order.

| Revision | Passed tests | Failed tests | Skipped tests | Unhandled errors | Typecheck | Root build |
|---|---:|---:|---:|---:|---|---|
| Existing pin `183e46a9c65fc3105c7e3d125629276814df7dbb` | 24,229 | 3 | 76 | 1 | Pass | Not run — failed tests |
| Candidate `9200a66c42633019349de937a8b97979acac0f7a` | 24,238 | 3 | 76 | 1 | Pass | Not run — failed tests |

These are Vitest's reported assertion counts. In particular, the unhandled error means the affected shard cannot be accepted merely because other assertions passed. Skips are not passes, and no inference is made about their unexecuted behavior.

**Recommendation:** retain the current source pin for now. Reconcile the [three attributed findings](baseline-retry-findings.md), prepare the exact source/test/environment corrective scope, and qualify that scope before proposing base integration. The newer candidate's change has useful passing evidence, but this report does not approve its adoption or waive inherited failures. Do not begin E1.1 under this preparation authorization. The separate [DESIGN gaps](design-state-coverage.md), including actual-host panel behavior, remain open.

## Command and shard evidence

Every command is recorded with SHA, cwd, UTC start, elapsed seconds and exit status in the [retry ledger](evidence/base-preparation-retry-2026-09-12/checks-results.json). The [test summary](evidence/base-preparation-retry-2026-09-12/test-summary.json) contains exact failure identities and aggregate counts. All ten prebuild commands exited 0; both `corepack pnpm -r typecheck` commands exited 0 (87.965 seconds for the pin, 88.206 seconds for the candidate). No timeout occurred. Each revision completed its attempt in under 12 minutes, within its 150-minute bound.

| Revision / shard | Passed | Failed | Skipped | Exit | Elapsed seconds | Readable evidence |
|---|---:|---:|---:|---:|---:|---|
| Pin / 1 | 6,297 | 1 | 12 | 1 | 252.452 | [Shard 1](evidence/base-preparation-retry-2026-09-12/base-shard-1.summary.log) |
| Pin / 2 | 6,137 | 0 | 33 | 0 | 154.066 | [Shard 2](evidence/base-preparation-retry-2026-09-12/base-shard-2.summary.log) |
| Pin / 3 | 5,762 | 0 | 28 | 0 | 92.354 | [Shard 3](evidence/base-preparation-retry-2026-09-12/base-shard-3.summary.log) |
| Pin / 4 | 6,033 | 2 | 3 | 1 | 103.883 | [Shard 4, plus one unhandled error](evidence/base-preparation-retry-2026-09-12/base-shard-4.summary.log) |
| Candidate / 1 | 6,315 | 1 | 12 | 1 | 251.660 | [Shard 1](evidence/base-preparation-retry-2026-09-12/candidate-shard-1.summary.log) |
| Candidate / 2 | 6,131 | 0 | 33 | 0 | 160.752 | [Shard 2](evidence/base-preparation-retry-2026-09-12/candidate-shard-2.summary.log) |
| Candidate / 3 | 5,768 | 0 | 28 | 0 | 94.339 | [Shard 3](evidence/base-preparation-retry-2026-09-12/candidate-shard-3.summary.log) |
| Candidate / 4 | 6,024 | 2 | 3 | 1 | 103.381 | [Shard 4, plus one unhandled error](evidence/base-preparation-retry-2026-09-12/candidate-shard-4.summary.log) |

Adding a file changes shard allocation. Compare full failure identities and total coverage, not corresponding shard counts alone. The candidate's `server/src/__tests__/de-27-admission-audit.integration.test.ts` appears in shard 3 with nine passing tests. This is evidence for those cases, not completion of every replatform dependency or Universe qualification.

## Failure disposition

| Finding | Observed on both revisions | Meaning and next work |
|---|---|---|
| F1: one URL credential-stripping test | `EAI_AGAIN example.com` | It invokes public DNS in the offline environment. Propose a deterministic test-scoped DNS mock; do not weaken the production URL guard or count this as passed. |
| F2: two connector production-caller assertions | `productionCallers()` returns `[]` | `git grep` cannot run in an archive without Git metadata. The production caller exists in source. Propose an isolated exact-SHA Git checkout from an offline bundle for later qualification. |
| F3: one unhandled child-process error | `spawn xdg-open ENOENT`, attributed to `filesystem-routes.test.ts` | The utility is absent, and the route fails to handle asynchronous launch errors. This is an inherited source error-handling gap exposed by the environment. Propose a reviewed route/error-path regression fix; installing an opener only to hide this error is not the recommendation. |

The [diagnosis](baseline-retry-findings.md) gives source locations and the precise boundaries of each conclusion. All named failure-related files are unchanged between the pin and candidate. No test or source file was changed, excluded, skipped manually or retried again.

## Skipped and unproved coverage

There are 76 skipped tests on each revision, spread across wholly skipped and partially executed files. The per-file lines are preserved in the readable shard evidence, including provider-key trials, browser containment/teardown, real-output and inbound-routing cases, Docker-target integration, opt-in load cases and platform-specific checks. This report does not claim to have executed them or infer that all skips share one reason.

The approved root suite did start its **own disposable embedded PostgreSQL and loopback server fixtures**, including fixture schema/migration setup. That is more specific evidence than the initial preparation proposal anticipated. It is not a separately provisioned migration rehearsal, an exhaustive tenant-role suite, a live database operation or provider qualification. No user database, host repository, Docker socket, provider credential or real application instance was connected. Existing fixture successes do not close the separate migration/role/host obligations or demonstrate Universe's not-yet-built runtime.

React Flow, the new Universe controller/persistence, actual-host mock interactions, voice/media sessions and provider/browser qualifications were not implemented or tested by this batch. DESIGN and the known Task-controls issue remain tracked separately. Production implementation and any base merge/rebase still need explicit approval.

## Environment correction and integrity

The same immutable Linux amd64 image and isolated volume from the first attempt were reused: `node@sha256:b977d0f785d96029d8d4c0790b6bf1c2a4c72e0f26319808e7ba2e9d966a1ac3`, Node 24.21.0, Corepack 0.36.0, pnpm 9.15.4. The non-root user created `/workspace/home/bin`, ran `corepack enable --install-directory /workspace/home/bin pnpm`, and checked direct pnpm in both snapshot directories. Both returned 9.15.4; [setup output](evidence/base-preparation-retry-2026-09-12/shim-setup.log) is preserved. Child PATH then included that directory. Setup completed in seconds, below its 10-minute bound.

Network inspection returned `{}` before and after the retry. No package download, install, new dependency, lockfile regeneration, credential or host modification was used. Original attempt logs were preserved under their original directory; retry logs have a separate directory. The source manifests were checked again before and after the run: 7,662 tracked entries for the pin and 7,664 for the candidate, zero changed file bytes or symbolic-link targets. Tests created only disposable fixture/generated state. The task container was stopped after logs were copied; the volume remains retained for evidence, not running.

Raw local logs are retained under `C:/Users/TK/AppData/Local/Temp/universe-preparation-e9637db9a984480e8382feca62ead552/retry-logs`. Published `.summary.log` files retain suite results and terminal failure/count sections, with ANSI and trailing whitespace removed. Matching `.log.gz` files contain full output with ANSI formatting removed. A credential-shaped-value scan found no matches requiring redaction. [Raw log inventory](evidence/base-preparation-retry-2026-09-12/raw-log-inventory.json) records original hashes/lengths; [published manifest](evidence/base-preparation-retry-2026-09-12/manifest.json) hashes the readable and compressed evidence. The extraction does not replace failed exits with successful ones.

## Next checkpoint

The environment correction is complete, so do not ask to repeat that unchanged correction. The [bounded corrective plan](baseline-correction-plan.md) is now drafted and source-reviewed, covering F1/F2/F3 with the exact proposed base, file ownership, targeted regressions and final baseline/build checks. [Independent review is received and author-verified](baseline-correction-review-report.md); explicit execution approval is next. This does not replace the failed results above. Any source fix must be reviewed and explicitly approved before execution; no such implementation scope is authorized here. Once accepted evidence is available, separately present a source-base adoption action and E1.1's implementation batch. Codex remains author, TK acceptance owner, and TK-managed Claude the independent technical reviewer for material changes.
