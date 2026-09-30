# Universe — baseline retry failure attribution

September 12, 2026. Codex author diagnosis from the approved offline retry. These are findings and proposed dispositions, not source fixes or implementation authorization. The command outcomes and exact execution provenance belong in [baseline preparation results](baseline-preparation-results.md).

## F1 — public DNS dependency in a credential-stripping test

`server/src/__tests__/outbound-url-guard.test.ts:374–384` calls `validateAndResolveFetchUrl("https://user:pass@example.com/path?q=1")` and expects stripped credentials. The test deliberately uses a public-resolving hostname. With external network disabled, it failed at line 377 with `EAI_AGAIN`; the service surfaced that failure at `server/src/services/outbound-url-guard.ts:323`.

**Attribution:** mismatch between this test's external DNS dependency and the approved offline environment. This observation does not establish that URL stripping or private-address rejection is broken. Do not turn the failed case into a skip/pass or enable the network under the existing authorization.

**Recommended later change:** make this particular test supply a deterministic public DNS answer through a test-scoped mock of its imported node:dns/promises lookup, preserving its credential-stripping assertions and leaving the production URL guard intact. Keep DNS/private-address behavior covered by dedicated cases. This is a test-source change requiring its own reviewed scope, not executed here.

## F2 — production-caller assertions require Git metadata

`server/src/__tests__/mcp-connector-install-adversarial.test.ts:1806–1838` uses `git grep` inside `productionCallers()`. Its catch returns `[]` for any Git error, although the comment mentions only no matches. Both ESC-7 assertions therefore fail in the archive snapshot. A direct read-only diagnostic in `/workspace/base` returned `fatal: not a git repository`.

The source caller actually exists: `server/src/services/internal-agent/cli-mode.ts` imports `mergeConnectorEnv` at line 37 and invokes `mergeConnectorEnv(buildScrubbedCliEnv(), ...)` at lines 1477 and 1894. Thus these failed assertions do **not** show that the connector environment scrubber is dead code.

**Attribution:** the approved `git archive` source snapshots preserve tracked files but omit `.git`, which this test requires. Their file-integrity checks do not supply Git metadata.

**Recommended later environment:** use an offline Git bundle or equivalent exact-object clone inside the disposable volume, checked out at each approved SHA. Do not mount the live repository or create a fabricated acceptance commit. Qualify tracked bytes and Git identity, then rerun the affected assertions. An optional separately reviewed test improvement could distinguish Git infrastructure failure from no production match. No Git metadata was added or retry performed under this batch.

## F3 — absent desktop opener exposes unhandled spawn error

`server/src/__tests__/filesystem-routes.test.ts:81–89` calls the real `/api/filesystem/reveal` route for its disposable HOME and checks only that the HTTP response is not 400. In the Linux container, `xdg-open` is absent. Vitest attributed an uncaught `spawn xdg-open ENOENT` to this file after the response assertion.

`server/src/routes/filesystem.ts:198–207` selects the platform opener, calls `spawn`, immediately `unref()`s the child and responds `{ ok: true }`. It attaches no child `error` handler. An asynchronous missing-executable failure therefore is not translated into the 500 response anticipated by the test comment.

**Attribution:** missing desktop utility is an environment condition, but the unhandled child-process error is a source error-handling gap exposed by it. Installing a desktop opener merely to make this run green would hide the missing error path. It is not appropriate to label this solely a container problem or an accepted pass. Vitest warns that an unhandled error can affect confidence in the shard's results even where test assertions passed.

**Recommended later source/test change:** handle opener launch errors explicitly, return an honest failure when launch fails, and test both launch success and asynchronous error with a controlled child-process fixture. Preserve path confinement and instance-admin authorization. Do not require an actual GUI launch during the test suite. This change is outside the approved environment-only retry; no route or test was edited.

## Revision comparison and disposition

The files named in F1–F3 have no diff between source pin `183e46a9c65fc3105c7e3d125629276814df7dbb` and replatform candidate `9200a66c42633019349de937a8b97979acac0f7a`. They precede the candidate's worker-admission audit/control change. The completed retry report must still compare actual failure sets rather than infer candidate outcomes from unchanged files.

Keep the original source pin and the no-implementation gate until the results are reconciled. Record F1/F2 as qualification-environment/test requirements and F3 as an inherited source defect requiring a disposition. These issues do not reopen settled Universe product choices, privacy policy or release scope. Any corrective batch must name the source/test changes, exact base and tests before TK approves it; no automatic source patch, merge, network change or further retry follows from this report.

## Corrective planning follow-up

The [correction plan](baseline-correction-plan.md) maps these findings to exact files, test fixtures, a genuine Git-backed offline checkout and final qualification. It preserves the original source pin and evidence. The proposed correction branch starts from the tested replatform candidate, not main; it is not yet created or adopted into Universe. No finding is marked runtime-resolved by that planning work.
