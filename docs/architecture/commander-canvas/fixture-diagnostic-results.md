# F4/F5 Stage-A diagnostic results

**Status: approved Stage A executed and stopped; F5 timeout not reproduced, workload comparison incomplete.** Both backup tests passed in both planned invocations. Seven other shard-4 suites failed collection because the diagnostic setup omitted the plugin SDK build. This is a preparation-plan omission, not evidence of seven new product defects. No repair, extra prebuild, retry, full qualification or base adoption followed.

## Approval and exact scope

TK supplied [Claude's review](fixture-plan-review-report.md), Codex verified its main verdict with the qualifications in the [handoff](claude-review-handoff.md#f4f5-plan-review-received), and TK explicitly approved Stage A with “lets do it”. Executed against local correction commit `b5cc42643223c433a8263564c7142761472a13d9`, using actual Git objects exported from the clean isolated correction branch. Universe remains pinned at `183e46a9c65fc3105c7e3d125629276814df7dbb`.

The temporary instrumentation changed exactly `packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts` in `/workspace/fixture-diagnostics`: 31 insertions / 13 deletions, consisting of the approved timing helper and wrappers around the original awaits. Assertions, skip rules, hook timeouts, concurrency, database options and await order remained unchanged. The source correction branch was not edited or committed.

Diagnostic patch SHA-256: `0bef3abd63312e8877af950249cd28c3dfafac1e265fff9fe29326f2f8388e4c`. Exported via `git diff --binary` against the correction commit, restored only the diagnostic file, then verified and reapplied with `git apply --check`. These are **commit-plus-patch diagnostics**, not clean-commit qualification.

## Observed results

| Check | Result |
|---|---|
| Offline frozen install and five approved prebuilds | Passed; no downloads or source changes |
| Isolated backup test file | 2 passed, 0 failed/skipped; command 4.026 s |
| Existing shard 4/4 | 5,968 passed, 3 skipped; 7 failed suites during collection; command exit 1, 101.625 s |
| Backup within shard 4 | Both tests passed; fixture duration 7.866 s including test bodies and teardown |
| Timing events | All 13 stages emitted start/end in each invocation; no instrumented stage error |
| Source integrity | All 7,664 tracked entries unchanged by each of the 10 recorded setup/diagnostic commands |
| Runtime | Stopped between the two diagnostics and after final evidence capture; network remained disconnected |
| Full typecheck / full four-shard qualification / root build | Not run in Stage A; no fresh global readiness claim |

The setup interval below runs from the first `data-dir` start to `seed-client-end` end. It excludes test bodies and teardown; it is not the Vitest suite duration.

| Stage | Isolated | Shard 4 |
|---|---:|---:|
| Total setup interval | 2,299 ms | 5,971 ms |
| PostgreSQL initialise | 2,174 ms | 5,778 ms |
| PostgreSQL start | 25 ms | 51 ms |
| Create database | 72 ms | 108 ms |
| Seed client end | 1 ms | 2 ms |
| Stop / shutdown | 625 ms | 1,770 ms |

Directory creation, port allocation and each seed statement also completed; [stage events](evidence/fixture-stage-a-2026-09-12/stage-events.json) retain their individual times and timestamps. PostgreSQL emitted shutdown completion before each `stop` end. Container termination provides the outer cleanup boundary even if any other suite leaves a process behind.

**Interpretation:** initialization was the dominant cost and was slower alongside other tests. Neither run crossed the existing 10-second setup budget. This does not identify the precise stage or cause of the original timeout, prove it was harmless, justify a timeout increase, or close F5. Instrumentation and workload variation also limit direct timing comparison with the earlier uninstrumented failure.

## Why shard 4 was not equivalent to the earlier workload

The seven collection failures resolve to `@armyofagents/plugin-sdk` or `@armyofagents/plugin-sdk/testing`:

| Suite | Previously executed cases absent from this diagnostic |
|---|---:|
| `company-portability-preview-export.test.ts` | 22 |
| `mcp-connector-install.integration.test.ts` | 6 |
| `broker-internal-registry.test.ts` | 11 |
| `plugin-telemetry.test.ts` | 13 |
| `mt-four-actor-journey.integration.test.ts` | 6 |
| `ask-founder-registry.test.ts` | 4 |
| plugin-authoring smoke `tests/plugin.spec.ts` | 1 |
| Total | 63 |

These suites failed before their test bodies ran; “zero failed test bodies” would conceal the failed run. The previous shard had 6,029 passed and 5 skipped, including the two backup cases skipped by failed setup. This diagnostic executes those two backup cases but loses 63 cases at collection: `6,029 + 2 - 63 = 5,968`; only the prior three ordinary skips remain. The counts reconcile; missing collection coverage is not an accepted skip.

Read-only attribution after stopping the runtime:

- `packages/plugins/sdk/package.json` exports runtime entry points from `dist/index.js` and `dist/testing.js`; its build is `pnpm --filter @armyofagents/shared build && tsc`.
- `packages/plugins/examples/plugin-authoring-smoke-example/package.json` typecheck invokes `scripts/build-plugin-sdk-locked.mjs`. The earlier [full typecheck log](evidence/baseline-correction-2026-09-12/final-typecheck.log) records this SDK build in `/workspace/qualified`.
- The prior qualified checkout's SDK `dist/index.js` could be copied read-only from the stopped container. The same path in `/workspace/fixture-diagnostics` was absent. No container restart or new build was needed for these filesystem checks.
- Stage A's five prebuilds omit the SDK, and Stage A intentionally omits full typecheck. Consequently this plan failed to reproduce one required generated dependency. Frozen installation succeeding does not establish that workspace export targets have been built.

Codex owns this setup-plan omission. Do not repair package exports, add dependencies, change the lockfile or weaken assertions to compensate for the missing build output.

## Evidence and integrity

Same retained task container `universe-preparation-e9637db9`, immutable image `node@sha256:b977d0f785d96029d8d4c0790b6bf1c2a4c72e0f26319808e7ba2e9d966a1ac3`, non-root UID/GID 1000, one task-owned `/workspace` volume, no host repository/home/socket mount. Node 24.21.0 and pnpm 9.15.4 reverified. Environment allowlist and fresh `AOA_HOME=/workspace/home/aoa-fixture-diagnostics` matched the approved plan. Network inspections returned `{}` before/during/after.

Setup commands ran from 16:37:14 to approximately 16:37:29 UTC on 2026-09-12, within 15 minutes. Diagnostics started 16:37:40 and 16:37:58 UTC; the last command finished approximately 16:39:40 UTC. Neither 15-minute command bound nor 30-minute diagnostic bound was exhausted. No command retries or third diagnostic occurred. Container stop/restart separated the commands; the final state is stopped. Stops use the retained container's one-second shutdown grace and may force termination of remaining container processes; this is containment, not proof of graceful cleanup by every suite.

Published evidence: [command ledger](evidence/fixture-stage-a-2026-09-12/command-ledger.json), [isolated log](evidence/fixture-stage-a-2026-09-12/isolated.log), [shard summary](evidence/fixture-stage-a-2026-09-12/shard-4.summary.log), [full compressed shard log](evidence/fixture-stage-a-2026-09-12/shard-4.log.gz), [integrity ledger](evidence/fixture-stage-a-2026-09-12/source-integrity.json), [metadata](evidence/fixture-stage-a-2026-09-12/execution-metadata.json) and [file hashes](evidence/fixture-stage-a-2026-09-12/manifest.json). Full initial/final instrumented manifests are compressed alongside them. Logs have ANSI/trailing whitespace removed; original hashes are retained. Bundles, raw patch, original logs and temporary author files remain local at `C:/Users/TK/AppData/Local/Temp/universe-fixture-stage-a-5558c9523949402285269313d571136d`.

## Next bounded proposal — not executed

Before drawing a conclusion from the load comparison, correct the preparation omission. Proposed delta to Stage A: retain the exact source and diagnostic patch, run **one additional existing SDK build and export check**, then **one shard-4 diagnostic**, with no isolated rerun and no other changes.

```sh
corepack pnpm --filter @armyofagents/plugin-sdk build
node --input-type=module -e "await import('./packages/plugins/sdk/dist/index.js'); await import('./packages/plugins/sdk/dist/testing.js')"
corepack pnpm exec vitest run --shard=4/4
```

This is a proposed new execution allowance, not reuse of the spent two-run approval. Before execution, verify source SHA, diagnostic patch hash, tracked manifest, stopped runtime and isolation. Preserve existing ledger files and use new unique command labels. Build plus import-check bound: 5 minutes total; shard bound: 15 minutes; total: 20 minutes. No installation is needed if the retained checkout/cache still match; otherwise stop for a revised setup proposal. Build/import failure blocks the shard. Any unrelated failure is retained and reported, not patched or retried. Require the backup target and the seven previously uncollected suites to be accounted for. Capture the same timings/identity/error evidence and stop the container after copying logs. Do not silently extend the old diagnostic deadline file; record a new approved phase deadline.

F4's proposed repair remains source-supported but unimplemented and untested. F5 remains unresolved; a successful corrected diagnostic would be non-reproduction, not proof of repair. After the workload comparison is valid, review the concrete F4 repair and decide what additional evidence, if any, is justified for F5. No blanket timeout increase, full qualification, source push, base adoption or Universe implementation is authorized by this proposal.

## SDK follow-up disposition

TK approved the bounded SDK build/export-check/shard proposal. [Results and execution deviation](fixture-sdk-followup-results.md): SDK build passed; plain-Node import failed resolving a workspace TypeScript export. Codex then incorrectly launched the dependent shard before inspecting that failure and stopped the container on discovery. Its partial output is invalid; no final shard result or post-abort source manifest is claimed. No additional execution followed. The report proposes a TypeScript-aware loader plus a machine-enforced prerequisite gate, requiring a new bounded approval. F4/F5 repair, full qualification, source publication and base adoption remain open.

## Gated loader-aware diagnostic outcome

TK approved the corrected export check and one success-gated shard invocation. [Results](fixture-loader-check-results.md): both commands passed; shard 4 ran 6,031 passing tests with 3 existing skips, including all seven previously uncollected suites and both backup cases. Source/patch identity and all 7,664 tracked entries matched before/after; runtime stopped. The prior aborted run remains invalid historical evidence. SDK preparation/loading is now resolved for this environment; F5 did not reproduce (setup 6.233 seconds) and is not declared repaired. No additional backup-only rerun or speculative timeout change is recommended. Next is reviewing the exact F4 fixture repair and fault regressions, then separately approved source authoring/full qualification. No base adoption or Universe implementation.
