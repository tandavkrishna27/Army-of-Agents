# SDK preparation follow-up — stopped at failed export check

**Status: SDK build passed; export check failed; no valid shard rerun completed.** TK approved the [three-command follow-up](fixture-diagnostic-results.md#next-bounded-proposal--not-executed). Codex executed the existing SDK build successfully, but the plain-Node import check failed against a TypeScript workspace export. Codex then incorrectly launched the dependent shard without checking the failed prerequisite result. The container was stopped immediately after discovering that error. The partial shard output is invalid for qualification or comparison.

## Actual execution and deviation

Source remained `b5cc42643223c433a8263564c7142761472a13d9` with diagnostic patch SHA-256 `0bef3abd63312e8877af950249cd28c3dfafac1e265fff9fe29326f2f8388e4c`. Before each launched command the runner matched the complete tracked manifest against the preceding Stage-A final manifest and verified both SHA and patch hash. The host correction branch remained clean. No reinstall, dependency edit, fixture repair or timeout change occurred.

| Command | Actual outcome |
|---|---|
| `corepack pnpm --filter @armyofagents/plugin-sdk build` | Exit 0; 5.851 seconds; SDK and its existing shared-package build completed |
| Plain-Node dynamic imports of SDK `dist/index.js` and `dist/testing.js` | Exit 1; 0.068 seconds; first import failed resolving `packages/shared/src/constants.js` from `packages/shared/src/index.ts`; second import was not reached |
| `corepack pnpm exec vitest run --shard=4/4` | **Launched contrary to the failed-prerequisite gate**, then aborted by stopping the container; no final test result |

The shard started at 16:45:42.237 UTC on 2026-09-12; the container reached stopped state at 16:45:58.824587433 UTC, exit 137. The execution command returned exit 1 without a runner completion record. This container exit is an abort, not a Vitest result. Do not count individual partial passes, infer the seven collection issues are all resolved, or claim F5 was exercised by this partial run.

The orchestration awaited each tool call but did not inspect the export-check exit code before submitting the next call. That was a Codex execution error, not authorization to continue. The runner enforced time/source limits but lacked a machine-enforced prerequisite check. No further execution followed the stop.

## Export-check attribution

`packages/shared/package.json` exports `./src/index.ts` in the workspace. Its `publishConfig` points to compiled `dist` files only for the published package. The source index imports relative `.js` paths whose corresponding workspace source files are TypeScript. The approved plain-Node command reached that source index and failed to resolve `src/constants.js`; building `shared/dist` does not change these workspace exports.

This explains why the verification command is unsuitable for this checkout. It does not establish a broken SDK build or require changing shared exports, installing a dependency or generating JavaScript beside the TypeScript source. The existing root dependency is `tsx` 4.22.4; Vitest also supplies TypeScript-aware loading. No alternative loader check has been executed in this attempt.

## Evidence and remaining integrity limit

The retained non-root container, immutable image, disconnected network and task-only volume were rechecked before execution. New deadline files limited setup to five minutes, the proposed shard to fifteen minutes and the whole attempt to twenty; the previous Stage-A deadlines were not extended. No bound was exhausted. The container is stopped, with network inspection `{}`.

For the two completed commands, all 7,664 tracked entries match before/after. The aborted shard has only its pre-run manifest: the container stop interrupted the runner before its after-snapshot. **Do not claim post-shard container source integrity was verified.** A new attempt must check the retained checkout against the last complete expected instrumented manifest before doing any work; mismatch stops it. Host worktree cleanliness is separately verified and cannot substitute for that container check.

Evidence: [ledger with explicit abort](evidence/fixture-sdk-followup-2026-09-12/command-ledger.json), [build log](evidence/fixture-sdk-followup-2026-09-12/sdk-build.log), [failed export check](evidence/fixture-sdk-followup-2026-09-12/sdk-exports.log), [invalid partial shard log](evidence/fixture-sdk-followup-2026-09-12/aborted-shard-4.log.gz), [completed-command integrity](evidence/fixture-sdk-followup-2026-09-12/source-integrity.json), [executed runner](evidence/fixture-sdk-followup-2026-09-12/executed-runner.mjs), and [file hashes](evidence/fixture-sdk-followup-2026-09-12/manifest.json). Raw logs and runner remain under `C:/Users/TK/AppData/Local/Temp/universe-fixture-sdk-followup-20260912`. No source bundle or source commit was published.

## Proposed correction to the check and execution gate — not run

Retain the successful SDK build. Before any new attempt, verify the exact SHA, diagnostic patch, full tracked manifest, required generated export files and offline runtime configuration. Stop on any mismatch or missing output; no rebuild/reinstall is silently included. Proposed commands:

```sh
node --import tsx --input-type=module -e "await import('./packages/plugins/sdk/dist/index.js'); await import('./packages/plugins/sdk/dist/testing.js')"
corepack pnpm exec vitest run --shard=4/4
```

The first command adds the existing TypeScript-aware loader; it remains an unrun proposal. Use a **new** approval/phase ledger, unique labels and an explicit gate before spawning the shard. That gate must read the current attempt's completed export-check record and require exit 0, no signal/timeout, exact expected command/source/patch and no changed tracked entries. Missing, failed, stale or mismatched records must throw before launching a child. Inspect the tool result as well; awaiting a command is not checking success.

Proposed allowance: one loader-aware export check within five minutes, then one shard invocation within fifteen minutes, twenty minutes total. No SDK rebuild, install, isolated backup rerun or third test attempt. Export failure stops execution. Preserve all target/seven-suite outcomes and all errors, without repairing or retrying them; copy logs and stop the container. This requires explicit approval after review of this corrected scope, rather than treating the aborted invocation as an unused automatic retry.

F4 remains unimplemented; F5's original timeout remains unresolved. The earlier Stage-A non-reproduction evidence and incomplete workload comparison stand. Full baseline qualification, source publication, replatform landing, Universe base adoption and Universe implementation remain separate gates.

## Gated loader-aware diagnostic outcome

TK approved the corrected export check and one success-gated shard invocation. [Results](fixture-loader-check-results.md): both commands passed; shard 4 ran 6,031 passing tests with 3 existing skips, including all seven previously uncollected suites and both backup cases. Source/patch identity and all 7,664 tracked entries matched before/after; runtime stopped. The prior aborted run remains invalid historical evidence. SDK preparation/loading is now resolved for this environment; F5 did not reproduce (setup 6.233 seconds) and is not declared repaired. No additional backup-only rerun or speculative timeout change is recommended. Next is reviewing the exact F4 fixture repair and fault regressions, then separately approved source authoring/full qualification. No base adoption or Universe implementation.
