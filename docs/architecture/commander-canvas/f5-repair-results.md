# F5 repair and clean baseline qualification

**September 13, 2026. Fixture correction and full baseline verification passed at `fcab5a112`.** TK approved this bounded batch. Repository typecheck, all four shards (24,276 tests passed; 76 unchanged ordinary skips), and the gated build completed successfully. This qualifies the exact repaired candidate, not a newer upstream revision or a Universe release.

## Correction and targeted evidence

Local source commit `fcab5a112aeac8385733f528396e65d258c02dfb` is on `codex/universe-f5-fixture-repair`, parent `4aebfa0f4aaf011cfd85347246c18d3cbde305ba`. Exactly three database-package test files changed. Production backup code, PostgreSQL flags, global concurrency/timeouts, dependencies and both original backup test bodies remain unchanged.

The helper applies a thirty-second setup policy with a thirty-five-second runner backstop. Disposal waits for raw startup to settle, blocks later phases, and stops a late successful server before removing owned directories. Cleanup has its own twenty-five-second deadline within the existing thirty-second hook. A failed stop or uncertain startup retains directories and reports failure. A permanently stuck initializer still requires the external container stop boundary; this helper does not claim to cancel embedded-postgres's private child process.

| Check | Result |
|---|---|
| Initial test-first run | Expected missing-helper module failure; scaffolding evidence only |
| Initial helper cases | 16 passed |
| Remove post-await disposal guard | One intended regression failed; 15 passed; no unhandled error |
| Wait on expired public startup instead of raw startup | One intended regression failed, with an additional assertion-promise handling warning in the negative test |
| Correct negative test's outcome observation; repeat that mutation | One intended regression failed; 15 passed; no unhandled error |
| Restore candidate helper and rerun | 16 passed; no unhandled error |
| Database package typecheck | Passed, including final test/helper source |
| Real backup/restore and existing F4 helper checks | 14 passed: both original backup cases and 12 F4 cases |

The extra final-step disposal case was added because removal of only the post-await guard can otherwise be masked by the next-step guard. The negative-test correction observes promise outcomes before asserting after clock advancement; it does not weaken the lifecycle expectation. All initial failures are preserved. These were bounded test-harness refinements, not new product scope or retries of a real infrastructure failure. The targeted batch completed in about eighty seconds, within its ten-minute allowance.

Targeted tests used the retained exact-base checkout plus the three approved files. Its final per-file hashes match the subsequent local source commit. Full qualification uses a fresh actual Git clone, fetches the incremental source bundle and checks out that exact commit; it does not qualify a diagnostic patch. No source push, replatform landing, Universe base adoption or feature implementation occurred.

## Full qualification evidence

| Stage | Result | Seconds |
|---|---|---|
| install | Passed | 5.220 |
| build0 | Passed | 1.989 |
| build1 | Passed | 1.237 |
| build2 | Passed | 1.721 |
| build3 | Passed | 1.121 |
| build4 | Passed | 1.249 |
| build5 | Passed | 5.905 |
| exports | Passed | 0.557 |
| typecheck | Passed | 91.126 |
| shard1 | 6,318 passed / 12 ordinary skips | 253.389 |
| shard2 | 6,131 passed / 33 ordinary skips | 191.430 |
| shard3 | 5,768 passed / 28 ordinary skips | 98.651 |
| shard4 | 6,059 passed / 3 ordinary skips | 103.401 |
| build | Passed | 70.074 |

All 14 command results are accepted, with zero test failures or unhandled runner errors. The complete test identity comparison found 16 added lifecycle cases, no removed cases, unchanged ordinary skip identities, and no duplicate files across shards. Both previously blocked real backup cases ran successfully. All tracked-source snapshots match the pristine committed checkout. Existing live-provider/browser/host skips remain qualification gaps for their owning slices; this offline run does not certify those integrations.

The initial evidence comparison counted the old backup suite's two setup-blocked cases as ordinary skips because Vitest marks their assertions `skipped` inside a `failed` suite. The checker now distinguishes failed-suite setup blocks and explicitly verifies both became passed. The remaining 76 skip identities match exactly; no test result was altered. The successful UI build still emits a large-bundle warning (chunks above 3,000 kB); this correction does not change UI source or claim to resolve that warning.

Runtime: immutable Node image `node@sha256:b977d0f785d96029d8d4c0790b6bf1c2a4c72e0f26319808e7ba2e9d966a1ac3`. Non-root UID/GID 1000, offline network, task-volume-only mount, no host repository/home/socket mounts. The container is stopped after verification.

The first shard-3 attempt ended when the container stopped at `2026-09-12T21:14:42.923287867Z` (exit 255, OOMKilled false). No result JSON or completion summary was written. Its truncated log and pre-run snapshot are preserved as incomplete evidence, not passed or failed assertions. The cause of that container stop is not established. On TK's continuation, only this incomplete shard was restarted, then shard 4 and build; earlier accepted commands were retained. The original 150-minute verification deadline was not reset, and no test timeout or concurrency setting changed. This is a resumed qualification, not an uninterrupted single process run.

Evidence: [summary](evidence/f5-repair-2026-09-13/summary.json), [command ledger](evidence/f5-repair-2026-09-13/command-ledger.json), [source integrity](evidence/f5-repair-2026-09-13/source-integrity.json), [repair integrity](evidence/f5-repair-2026-09-13/repair-integrity.json), [manifest](evidence/f5-repair-2026-09-13/manifest.json). The packet retains compressed full logs, targeted negative controls, interrupted output, runners and test identities.

## Upstream movement and integration boundary

The observed remote replatform head advanced from `9200a66c42633019349de937a8b97979acac0f7a` to `7b0d01c02276ced3a542b5c74f08e428e7a57fc0`. That one commit adds a citation-integrity guard, tests, inventories, workflow wiring and corrected register anchors across nine files. Its `server/`, `ui/` and `packages/` diff is empty, including the backup fixture. This read-only delta check does not qualify the new workflow or adopt that revision.

A later remote check during verification found `06a37345229fd23837764106350318cdb61b3445` after `7b0d01c`: nine more files add fence-denial audit recording and its integration tests, including changes in job events, control acknowledgement, fencing and output completion. Unlike the preceding guard-only commit, this is a production server delta. It does not touch the three F5 fixture files, but this baseline run does not test it. The combined upstream delta must be reviewed and verified on whichever exact integration revision TK accepts.

The full run remains pinned to the source correction on the older candidate. A passing result supports that exact input. Before landing/adoption, refresh the remote identity, review any additional delta, run applicable new guards and verify the actual merged candidate. All correction branches remain local; Universe application source remains pinned to `183e46a9c65fc3105c7e3d125629276814df7dbb`.

## Author review

Reviewed setup progression, late completion, per-query disposal checks, cleanup ordering, stop failure, uncertain startup, original assertion equality and final targeted hashes. No independent Claude review is claimed. Passing the deterministic cases does not prove a maximum disk-latency bound; the clean full workload and gated build remain the baseline evidence.

## Next decision, without another general planning round

Prepare the landing/adoption action against the current replatform head, preserving these four local correction commits in order: `0912b3742` (outbound URL fixture), `b5cc42643` (filesystem opener), `4aebfa0f4` (F4 lifecycle), `fcab5a112` (F5 lifecycle). Their combined delta is nine files; only the filesystem opener changes production behavior. Publication/PR/merge and actual base adoption require TK's separate decision. Do not merge into ongoing replatform work during this evidence update.

Once the actual integration candidate and applicable upstream guards are verified, record the exact accepted base, close the first-batch DESIGN consistency disposition, and bring the E1.1 shared canvas/panel-controller batch for explicit implementation approval. The 31-slice plan remains reviewed; distributed Commander, provider/media, storage, browser/profile and host integrations retain their named qualification gates. No Universe feature code was started here.
