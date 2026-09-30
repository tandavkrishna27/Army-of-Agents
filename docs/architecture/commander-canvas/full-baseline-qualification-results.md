# Universe — full corrected-baseline qualification

**Later disposition:** The approved [F5 repair and full qualification](f5-repair-results.md) are complete and passing. The dated record below is historical evidence, not the current execution status.

**Subsequent diagnostic:** [F5 attribution completed](f5-attribution-results.md) with a passing instrumented shard and measured storage waits. It does not supersede the failed qualification below. The proposed diagnostic allowance in this historical report has now been used.

**September 13, 2026. Verdict: not qualified. One backup-fixture setup failure remains; build was correctly blocked. The Universe plan does not need another general review round.**

TK authorized returning to the baseline run to reach the implementation discussion. This executed Task 4 of the [F4 qualification plan](f4-fixture-repair-plan.md), not source fixes, source publication/adoption, provider execution or Universe feature implementation. Codex reviewed the completed results and retained the failure. No retries followed.

## Observed results

| Check | Result |
|---|---|
| Fresh offline frozen installation | Passed |
| Six prerequisite package builds and SDK export loading | Passed |
| Repository `pnpm -r typecheck` | Passed, 98.465 seconds |
| Shard 1 | 6,318 passed; 12 ordinary skips; exit 0 |
| Shard 2 | 6,131 passed; 33 ordinary skips; exit 0 |
| Shard 3 | 5,768 passed; 28 ordinary skips; exit 0 |
| Shard 4 | 6,041 passed; 3 ordinary skips; **one failed setup hook prevented two backup tests from running**; exit 1 |
| Combined tests | **24,258 passed; 76 pre-existing skips; 2 additional cases blocked by the failed backup setup** |
| Build | **Not run: failed-test prerequisite** |
| Source integrity | All 7,666 tracked entries unchanged before/after each command; clean committed source throughout |

The failed suite is `packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts`, `beforeAll` at line 41: **Hook timed out in 10000ms**. Vitest reports its two unexecuted cases as skipped, but they are **failure-blocked coverage**, not accepted skips. Zero failed test bodies is not a passing suite. There were no separate Vitest unhandled-error reports. The runner's broad `unhandled: true` safety flag includes failed-hook timeouts; it is not a claim of an additional unhandled rejection. The outer 30-minute command deadline did not fire.

The four JSON reports contain 2,602 distinct test files, with no file appearing in two shards. Derived file disposition is 2,591 passing, 10 wholly skipped and one failed. Full per-test identities and all non-passing cases are retained; counts reconcile across every shard rather than relying on previous shard placement.

### Required repair regressions

| Fixture | Observed full-suite result |
|---|---|
| Outbound URL guard | 79 passed |
| Filesystem route and launch errors | 14 passed |
| New blocked-task lifecycle/port cases | 12 passed |
| Original blocked-task real-database cases | 4 passed |
| Runtime provider-key fixture | 5 passed |
| Newer replatform admission-audit cases | 9 passed |
| Original backup/restore cases | **Both blocked by setup timeout** |

F1/F2/F3/F4 checks succeeded in this run; F5 remains the sole observed failing suite. This is not a guarantee against all fixture races or qualification of live providers.

## What the backup evidence establishes

The unchanged fixture creates temporary directories, chooses a port, initializes PostgreSQL, starts it, creates the test database and seeds two schemas inside the default ten-second setup hook. The current log shows initialization progressing through bootstrap and post-bootstrap, then **`syncing data to disk ...`** as the last target-specific output before the timeout. No target-specific initialization completion or server-ready message appears before the failed suite result.

That narrows the observed failure to initialization not completing within the hook budget. It does **not** measure the exact duration of disk synchronization or prove why it was slow. Concurrent filesystem/CPU load is a hypothesis, supported by the prior [phase timings](fixture-loader-check-results.md): initialization grew from 2.174 seconds in isolation to 6.038 seconds in the diagnostic shard. Those earlier successful samples never established that the ten-second budget was sufficient under every full workload.

No backup assertion, global timeout, worker concurrency, skip guard or product source was changed. No speculative timeout increase or immediate green-seeking rerun was performed. The container stop bounds late asynchronous fixture work; it does not prove the fixture itself cleaned up successfully after timeout.

## Skip accounting

All 76 ordinary skips come from unchanged source conditions or explicit existing placeholders. [The test identity record](evidence/full-baseline-2026-09-13/test-identities.json.gz) names each case; [summary](evidence/full-baseline-2026-09-13/summary.json) includes all 78 non-passing cases, including the two failure-blocked backup cases.

| Category | Cases | Disposition |
|---|---:|---|
| Keyed E2B/export/invocation/egress/provider conformance | 31 | Credentials and real-provider execution excluded from this offline run |
| Real browser containment and teardown | 14 | Browser opt-in not enabled; includes platform-specific teardown arm |
| Windows-only environment case folding | 2 | Linux runtime |
| Real CLI/agent acceptance and app-server opt-ins | 8 | No installed/authenticated live CLI or acceptance environment |
| Production-capacity load lane | 9 | Dedicated performance opt-in/database absent |
| Intentional historical contract placeholders | 3 | Two provider-login **service** assertions and one relocated TOOLS.md routing assertion; provider isolation belongs at the route seam and is covered by active route tests, so these two are not evidence that cross-provider isolation is broken |
| Real-home provider-auth fixture | 1 | Explicit existing harness limitation; source cites separate parity/spawn coverage |
| Unimplemented/deferred advisory or viewer coverage | 6 | Four inbound-routing tests explicitly skipped even inside their live gate; two Inbox history-viewer tests await replacement viewer |
| Docker execution target | 1 | Docker availability guard is false inside the isolated runtime; no host Docker socket mounted |
| Real browser Back navigation | 1 | Explicit JSDOM limitation; separate browser/E2E coverage required |

These skips cannot certify browser, provider, performance or deferred UI behavior. They are not newly added exclusions and do not erase owning-slice qualification gates.

## Identity, environment and evidence

- Qualified input: local repair commit **`4aebfa0f4aaf011cfd85347246c18d3cbde305ba`**, parent `b5cc42643223c433a8263564c7142761472a13d9`, descendant of replatform candidate `9200a66c42633019349de937a8b97979acac0f7a`. Actual Git bundle clone, detached at the exact commit; no patched source or instrumentation.
- Universe remains pinned to application source `183e46a9c65fc3105c7e3d125629276814df7dbb`. Its application-path diff is empty. All source corrections remain local; the premature draft remains untouched.
- Remote `docs/replatform-program` was read during this run and still equalled `9200a66c42633019349de937a8b97979acac0f7a`. No fetch/rebase/merge/adoption occurred. A later moving head requires its own delta review.
- Runtime: immutable `node@sha256:b977d0f785d96029d8d4c0790b6bf1c2a4c72e0f26319808e7ba2e9d966a1ac3`; UID/GID 1000; network `{}`; one task volume; no host repository, home or Docker socket mount. Fresh checkout `/workspace/full-baseline-20260913` and fresh task AOA_HOME. Environment allowlist retained from the approved plan.
- Thirteen commands ran once. Setup began 19:09:11 UTC September 12; final shard ended approximately 19:23:01 UTC (September 13 local time). Setup/verification and per-command bounds were respected. Stop/restart separated shards; final runtime is stopped and disconnected.
- JSON and default reporters were added solely to retain exact test identities outside the checkout; test selection, timeouts and concurrency were unchanged. The setup runner and shard runner are both preserved. Before any shard, failure classification was refined to inspect runner/failure-summary diagnostics rather than treating expected fault-test console errors as infrastructure failures. No failed command was bypassed. Build's gate requires every previous command accepted.

Evidence: [command ledger](evidence/full-baseline-2026-09-13/command-ledger.json), [source integrity](evidence/full-baseline-2026-09-13/source-integrity.json), [failed shard log](evidence/full-baseline-2026-09-13/shard4.log.gz), [focused backup excerpt](evidence/full-baseline-2026-09-13/backup-excerpt.txt), [test files](evidence/full-baseline-2026-09-13/test-files.json), [evidence hashes](evidence/full-baseline-2026-09-13/manifest.json). All command logs and full JSON reports are compressed alongside these indexes. The focused excerpt removes terminal colors and trailing whitespace; raw compressed logs remain unmodified. Raw host evidence remains under `C:/Users/TK/AppData/Local/Temp/universe-full-baseline-20260913`; the source bundle is retained privately and is not published.

## Next bounded action and implementation discussion

**Planning remains assembled and reviewed. Baseline qualification is incomplete because of one observed fixture failure.** No new all-epic review is called for.

1. Recommend one focused F5 attribution batch against this exact source and unchanged full shard-4 workload: use the previously reviewed stage-timing approach to record initialization/start/seed/teardown boundaries and correlate initialization with bounded resource observations. Preserve the original ten-second budget and all backup assertions. No repeated isolated backup run to obtain a green result. This is a proposed subsequent diagnostic allowance, not execution performed or authorized by the completed run.
2. If the measured stage confirms a legitimate initialization budget mismatch, prepare a local fixture-only budget/lifecycle correction with measured rationale and late-start cleanup tests. If it reveals a hang/resource defect, fix that cause instead. No blanket global timeout/concurrency change. Review the concrete evidence and smallest correction before authoring it.
3. Requalify the resulting clean commit through the full required checks and gated build. The existing failed run stays in the record. Only a complete pass supports base adoption.
4. The concrete eventual integration path is a corrections PR targeting **`docs/replatform-program`**, followed by adoption of the verified landed source into the existing **`codex/universe-interface`** branch while retaining its documents. Codex can prepare the evidence/PR after authorization; TK remains acceptance owner. The actual replatform landing actor/path must be recorded before landing, and remote drift or a changed merged tree requires renewed delta verification. No source push or merge has been made.
5. Then settle the first-batch DESIGN consistency disposition and explicit E1.1 implementation approval. The first batch is registry/lifecycle, shared panel frame and pointer/resize/focus behavior; real React Flow/host tests belong to that implementation. Distributed Commander, voice/media, browser/profile/host and other integration gates remain with their slices. Nothing in this result authorizes feature coding.

**Author review:** command results, hook failure, source manifests, four-shard identities, unchanged skip conditions and the exact local/remote ancestry were checked. Readiness is not overstated: the plan is ready to guide work; the baseline is not yet ready to adopt.
