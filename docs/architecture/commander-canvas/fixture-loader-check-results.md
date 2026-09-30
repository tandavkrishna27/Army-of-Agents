# TypeScript-aware export check and gated shard-4 results

**Status: approved diagnostic follow-up passed; full baseline remains unresolved.** TK approved one TypeScript-aware export check followed by one success-gated shard-4 invocation. Both completed successfully. No reinstall, rebuild, fixture repair, timeout change or additional test invocation occurred.

## Exact source and execution

The retained diagnostic checkout is still based on local correction commit `b5cc42643223c433a8263564c7142761472a13d9`, with the same one-file timing patch SHA-256 `0bef3abd63312e8877af950249cd28c3dfafac1e265fff9fe29326f2f8388e4c`. The existing SDK build from the prior attempt was retained. Before each command, the runner required the exact SHA/patch and compared all 7,664 tracked entries to the last complete Stage-A manifest. Those checks passed, including the check after the prior aborted attempt. That restores confidence in the retained tracked source; it does not make the prior partial run valid evidence.

The new runner accepts only the two approved command/label combinations. Before spawning the shard it reads this attempt's export-check result and requires exit 0, no signal or timeout, matching command/source/patch, no changed tracked entries, and a timestamp within this new attempt. Missing, failed or stale records throw before child launch. Codex also inspected the successful export-check tool result before issuing the shard command in a separate tool call. The gate's successful path executed; no additional negative-gate test was included in this bounded attempt.

| Command | Result |
|---|---|
| `node --import tsx --input-type=module -e "await import('./packages/plugins/sdk/dist/index.js'); await import('./packages/plugins/sdk/dist/testing.js')"` | Exit 0, 0.213 seconds; both imports completed |
| `corepack pnpm exec vitest run --shard=4/4` | Exit 0, 114.357 seconds; **6,031 passed / 3 skipped**, no failed suites or unhandled-error summary |
| Files | 647 passed / 1 skipped, 648 total |
| Backup fixture | Both tests passed; fixture duration 9.128 seconds, including tests and teardown |
| Source integrity | All 7,664 tracked entries unchanged before/after both commands |

The seven suites previously blocked at collection all ran and passed: portability preview/export (22), MCP connector install (6), broker registry (11), plugin telemetry (13), four-actor journey (6), founder registry (4), and plugin-authoring smoke (1). Their 63 recovered cases reconcile the prior partial-workload total: `5,968 + 63 = 6,031`. The prior three ordinary skipped tests remain skipped. These are not the two backup tests previously skipped by setup failure; those two now executed successfully.

## Backup timing and interpretation

| Measurement | Isolated Stage A | Stage A with missing SDK | Corrected shard 4 |
|---|---:|---:|---:|
| Setup interval, first stage through seed-client close | 2,299 ms | 5,971 ms | **6,233 ms** |
| PostgreSQL initialise | 2,174 ms | 5,778 ms | **6,038 ms** |
| PostgreSQL start | 25 ms | 51 ms | 57 ms |
| Database creation | 72 ms | 108 ms | 103 ms |
| PostgreSQL shutdown | 625 ms | 1,770 ms | 2,749 ms |

All 13 instrumented stages emitted start/end events. The setup interval excludes test bodies and teardown: the 9.128-second whole-fixture duration is not the 10-second `beforeAll` budget. The complete corrected workload passed with setup below that budget. Initialization remains the dominant measured cost.

**F5 disposition: not reproduced, not repaired.** These observations support sensitivity of initialization time to workload, but do not prove what caused the earlier setup to exceed ten seconds. No timeout increase is justified solely by this pass or by the whole-fixture duration. No further backup-only diagnostic rerun is recommended now. Keep F5 as an observed unresolved qualification concern and rerun the original backup test as part of the later approved full clean-commit qualification after F4 repair; a renewed failure requires attribution, not automatic retries or a timeout bump.

**F4 disposition: still open.** This shard does not repair or requalify the blocked-task fixture that failed in shard 3. Its port selection, swallowed falsy setup rejection and failed-start cleanup still require the proposed narrow fixture correction and regressions.

## Bounds and retained evidence

The existing non-root task container used the same immutable image `node@sha256:b977d0f785d96029d8d4c0790b6bf1c2a4c72e0f26319808e7ba2e9d966a1ac3`, UID/GID 1000, task-only volume and allowlisted environment. Network inspection remained `{}`. No host repository/home/socket mounts, external service sessions or credentials were added.

New phase deadlines enforced five minutes for the export check, fifteen for the shard and twenty overall. The export check began 2026-09-12 17:22:37.591 UTC; the shard began 17:22:44.520 UTC and ended approximately 17:24:38.877 UTC. Neither bound was exhausted. Logs were copied, then the container was stopped and verified stopped/offline. No further runtime command followed the stop.

Evidence: [command ledger](evidence/fixture-loader-check-2026-09-12/command-ledger.json), [export check](evidence/fixture-loader-check-2026-09-12/exports-tsx.log), [shard summary](evidence/fixture-loader-check-2026-09-12/shard-4.summary.log), [full compressed shard](evidence/fixture-loader-check-2026-09-12/shard-4.log.gz), [stage events](evidence/fixture-loader-check-2026-09-12/stage-events.json), [source integrity](evidence/fixture-loader-check-2026-09-12/source-integrity.json), [executed gate](evidence/fixture-loader-check-2026-09-12/executed-runner.mjs), and [file hashes](evidence/fixture-loader-check-2026-09-12/manifest.json). Original logs and runner are retained at `C:/Users/TK/AppData/Local/Temp/universe-fixture-loader-check-20260912`. Published logs remove ANSI/trailing whitespace; original hashes and compressed full before/after manifests are retained.

## Next step

The diagnostic setup/export problem is closed for this retained environment. Prepare and review the exact F4 fixture repair and fault-regression plan, preserving all four business assertions and the accepted failed-start/cleanup requirements. F5 gets no speculative source or timeout change. Only after explicit repair approval should source authoring occur, followed by a separately approved full typecheck, four-shard suite and gated build on the resulting clean commit.

This green diagnostic shard does not replace the earlier failed full baseline, prove all skipped/host/provider obligations, approve source publication or adopt a new Universe base. Correction source remains local, Universe application source remains pinned, and production implementation remains paused.
