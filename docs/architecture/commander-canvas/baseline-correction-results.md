# Baseline correction execution results

**Status: approved correction batch executed; full baseline NOT green.** TK explicitly approved the isolated three-file correction and bounded offline checks after the reviewed plan at `8503adb40dd6e53350b8775336866a2d00d87bdd`. The original F1/F2/F3 cases now pass. Two different fixture failures block build and base adoption. No additional fix or retry was performed.

## Source and publication boundary

| Resource | Exact identity / disposition |
|---|---|
| Universe documentation branch | `codex/universe-interface`, still application source pin `183e46a9c65fc3105c7e3d125629276814df7dbb` |
| Correction parent | Tested replatform candidate `9200a66c42633019349de937a8b97979acac0f7a`; not main |
| Isolated correction branch | `codex/universe-baseline-corrections` in `.worktrees/universe-baseline-corrections` |
| DNS test commit | `0912b3742` (full value in execution metadata) |
| Exact qualified correction commit | `b5cc42643223c433a8263564c7142761472a13d9` |
| Source publication | Both correction commits remain local. No source push, PR, merge or base adoption occurred. This report/evidence is published only on the established documentation branch. |

Net correction diff: **three files, 139 insertions / 10 deletions**. `outbound-url-guard.test.ts` replaces external DNS with a module-scoped fixture while retaining real guard behavior. `filesystem-routes.test.ts` controls child-process launch and verifies failure, success, later errors and permission/path denials. `filesystem.ts` waits for launch, returns a generic failure on launch error and keeps the error handler attached after success. Existing path confinement, instance-admin authorization and command selection are preserved. No dependency, lockfile, schema, protocol or Universe feature change.

## Targeted evidence

| Step | Result |
|---|---|
| Offline frozen install and five prebuilds | Passed in genuine Git-backed candidate checkout |
| F2 unchanged ESC-7 assertions | 2 passed; 152 cases outside the requested filter not run at this step; all 154 ran in the combined check |
| F1 entire DNS/URL test file | 79 passed offline; production URL guard unchanged |
| F3 red regression on unchanged route | 3 expected failures / 11 passed; wrong success response, generic catch response and absent persistent listener demonstrated before source edit |
| F3 green route file | 14 passed, no unhandled errors |
| Combined three test files | 247 passed, zero skips/failures/unhandled errors |
| Internal Codex source review | No actionable findings; read-only review, not an independent runtime run or Claude source review |

Logs: [DNS](evidence/baseline-correction-2026-09-12/dns-fixture.log), [Git caller discovery](evidence/baseline-correction-2026-09-12/git-callers.log), [red](evidence/baseline-correction-2026-09-12/opener-red.log), [green](evidence/baseline-correction-2026-09-12/opener-green.log), [combined](evidence/baseline-correction-2026-09-12/combined.log), [internal review](evidence/baseline-correction-2026-09-12/internal-review.txt).

## Clean exact-commit qualification

The final run used a fresh offline clone at `/workspace/qualified`, detached at the correction commit above, verified against the author worktree HEAD with clean Git status. The earlier patched checkout was not used as final commit proof. Root `test:run` is `vitest run`; the approved four direct Vitest shards partition that suite.

| Check | Passed | Failed tests | Skipped tests | Exit | Result |
|---|---:|---:|---:|---:|---|
| Offline frozen install + five prebuilds | — | — | — | 0 each | Passed |
| Full workspace typecheck | — | — | — | 0 | Passed, 89.299 seconds |
| [Shard 1](evidence/baseline-correction-2026-09-12/final-shard-1.summary.log) | 6,318 | 0 | 12 | 0 | Passed |
| [Shard 2](evidence/baseline-correction-2026-09-12/final-shard-2.summary.log) | 6,131 | 0 | 33 | 0 | Passed |
| [Shard 3](evidence/baseline-correction-2026-09-12/final-shard-3.summary.log) | 5,764 | 4 | 28 | 1 | Blocked-task fixture collision and teardown timeout |
| [Shard 4](evidence/baseline-correction-2026-09-12/final-shard-4.summary.log) | 6,029 | 0 | 5 | 1 | Backup fixture setup timeout; failed suite despite zero failed test bodies |
| Total | **24,242** | **4** | **78** | **Failed** | Two failed suites; no Vitest unhandled-error summary |
| Root build | — | — | — | Not run | Blocked by failed shards, as approved |

The previous unmodified candidate had 24,238 passed / 3 failed / 76 skipped and one unhandled opener error. The corrected tree adds seven test cases. The three original failing cases pass, the opener unhandled error is absent, four previously passing blocked-task cases fail, and two backup cases are skipped by failed setup. These explain the full count delta; the two new skips are not accepted exclusions. [Skip comparison](evidence/baseline-correction-2026-09-12/skip-comparison.json) preserves the unchanged prior skip inventory plus that failed-setup addition. The candidate's nine admission-audit tests still pass.

## Newly observed blockers

### F4 — actual collision between concurrent database fixtures

At 16:06:36 UTC, `runtime-provider-keys-with-secret.integration.test.ts` started a PostgreSQL fixture listening on port **58293**. At 16:06:41 UTC, `blocked-task-scan.integration.test.ts` tried the same port; PostgreSQL reported both loopback binds already in use and could not create its TCP sockets. See [collision excerpt](evidence/baseline-correction-2026-09-12/fixture-collision.log) and full shard 3 log.

The blocked-task test chooses `58000 + Math.floor(Math.random() * 1000)` at line 38 without probing. Its `beforeEach` then reached `db.execute` with an undefined database, and `afterAll` exceeded 60 seconds. The port collision is established; the exact asynchronous fixture path producing an unset database without a truthy setupError still needs focused inspection. Do not pretend all fixture failure propagation has been diagnosed.

The test is unchanged between the candidate and correction, and all four cases passed in the previous candidate run. This evidence identifies a fixture reliability problem exposed by this run, not a new blocked-task product regression. It nevertheless blocks baseline acceptance. The existing `server/src/__tests__/helpers/embedded-pg-port.ts` probes available ports and is already used by `startMigratedDatabase`; the blocked-task fixture has not adopted it. That helper reduces collision risk but explicitly retains a bind-after-probe race, so adoption must not be described as a complete concurrency guarantee.

### F5 — backup test database setup exceeded its hook budget

`packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts:41` timed out in `beforeAll` after 10 seconds. Vitest marks its suite failed and both test bodies skipped. Its initialisation includes a temporary directory, port allocation, embedded PostgreSQL startup, database creation and seeding. The test has no explicit setup timeout override. It is unchanged by these corrections and its two cases passed in 7.660 seconds in the previous candidate run.

The available evidence establishes a setup timeout, not why this setup exceeded the budget. Do not assert the backup logic is broken or dismiss it as harmless load variance. A focused run with fixture-stage timing and teardown inspection is needed before selecting a change. Increasing the timeout or rerunning until green is not an authorized correction here.

## Integrity, bounds and retained evidence

- Same immutable image `node@sha256:b977d0f785d96029d8d4c0790b6bf1c2a4c72e0f26319808e7ba2e9d966a1ac3`; Node 24.21.0, Corepack 0.36.0, pnpm 9.15.4. Non-root UID/GID 1000, allowlisted environment, fresh AoA home for each checkout, one task-owned volume, no host repository/home/socket mounts or provider credentials. Network inspected as `{}` before/during/after.
- Initial offline setup, targeted checks and the final sequence stayed within their 15/30/150-minute limits. Final install began 15:57:12 UTC; final shard ended around 16:09:35 UTC. No retries, extra source edits or build after failure. The only failed pre-transfer comparison was Git object-ID abbreviation length (host nine characters, Linux eight), resolved by comparing the same diff with explicit `--abbrev=9`; content and test scope did not change.
- Every recorded command checked all **7,664 tracked files/symlinks** before/after; zero changed source entries. Final Git status remained clean. Full exact-commit initial/final manifests and per-command integrity hashes are retained. Suite-owned temporary databases and loopback servers ran inside the container; no provider trial or real user database was involved.
- Logs were copied before stopping the container; it is stopped and retained. Local raw evidence and bundles: `C:/Users/TK/AppData/Local/Temp/universe-baseline-correction-4569c9cd96b4437db667b4a62ad82118`. Bundles and raw source patches are local only. Published logs remove ANSI formatting/trailing whitespace; a credential-shaped scan found no matches requiring redaction. Routine expected test logger warnings remain evidence, not unhandled test errors.

See [24-command ledger](evidence/baseline-correction-2026-09-12/command-ledger.json), [test summary](evidence/baseline-correction-2026-09-12/test-summary.json), [source integrity](evidence/baseline-correction-2026-09-12/source-integrity.json), [execution metadata](evidence/baseline-correction-2026-09-12/execution-metadata.json), [runner](evidence/baseline-correction-2026-09-12/run-correction.mjs) and [published file hashes](evidence/baseline-correction-2026-09-12/manifest.json). Full shard output is available in the corresponding `.log.gz` beside each readable summary.

## Next decision

Preserve the correction branch locally. No source-base adoption or Universe implementation is ready to approve from this failed run. Recommend a separately scoped fixture investigation: inspect setup/error/teardown in the blocked-task and backup fixtures, qualify available-port allocation with the known competing fixture, and measure backup setup before selecting any timeout change. Then review the proposed repair and request its exact source/test scope before another full qualification. Current approval permits diagnosis/reporting of these new failures, not fixes, reruns, skips, broader test configuration or remote source publication.

The accepted V1/V2 scope, UX/privacy decisions, DESIGN/React Flow/host/provider obligations and separate replatform landing responsibility are unchanged.

## Subsequent static investigation and planning

The [F4/F5 plan](fixture-repair-plan.md) adds a source-level explanation of the previously unresolved F4 setup propagation: the installed library rejects with `undefined` after an early child close, which the fixture's truthiness check loses. Its stop method can then wait for an already-fired exit event. This was verified by reading the installed dependency from the stopped qualified container, without running it again; the earlier result remains historical evidence. F5 still needs stage timings. The plan proposes a bounded diagnostic stage followed by evidence-based repair selection, review and separately approved qualification; it does not claim either fixture is fixed.
