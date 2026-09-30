# F4 repair — author review and bounded execution results

**Latest readiness (September 13):** [Base integration and adoption](base-integration-results.md) are complete with full local qualification, required PR CI and exact source comparison. The existing Universe branch now contains the verified replatform landing. TK's requested discussion and explicit batch approval remain before feature implementation. Earlier dated preparation results below are historical.

**Historical local qualification (September 13):** The [F5 repair and full baseline verification](f5-repair-results.md) passed at local source `fcab5a112`: repository typecheck, all four test shards (24,276 passed, 76 unchanged ordinary skips) and build. An interrupted shard-3 attempt is preserved separately and excluded from totals. No source drift or new skipped cases. Correction publication/landing, exact Universe base adoption and feature implementation remain unapproved. The remote replatform delta requires its own integration checks; no general epic replanning. Older dated records below are historical.

**September 12, 2026: bounded F4 repair checks passed. Full corrected-baseline qualification and Universe implementation remain open.**

TK instructed Codex to perform the review rather than sending this packet to Claude, and to go ahead. Codex treated this as authorization for the reviewed F4 source-authoring/targeted-check batch, not base adoption or Universe features. The initial commentary stated that boundary before work. No new independent Claude review is claimed or required for this completed round. Prior reviews remain historical evidence.

## Author review verdict

Reviewed [consolidated readiness](consolidated-plan-readiness.md) and the [exact F4 proposal](f4-fixture-repair-plan.md) against the blocked-task source, existing port allocator, installed-library rejection/stop evidence and latest diagnostic results. No blocking design finding was identified. Startup errors must throw irrespective of their value; disposal must track successful startup rather than constructor existence; real task assertions remain separate from controlled lifecycle faults. Pending startup is serialized with disposal but not cancellable by a hook timeout. No F5 source change is justified by non-reproduction.

**Universe planning verdict:** the assembled plan is sufficient to proceed through its named engineering gates and approved batches. No further unchanged external review round is required by this turn. It is not a blanket declaration that all V1 runtime bindings or the first production implementation base are ready. The remaining gate register still applies. The typecheck-configuration correction below is a verification-harness defect discovered during execution, and is retained openly.

## Source identity and exact change

Local branch `codex/universe-f4-fixture-repair` was created in the agreed `.worktrees` directory from `b5cc42643223c433a8263564c7142761472a13d9`, descending from replatform candidate `9200a66c42633019349de937a8b97979acac0f7a`. No original checkout or branch was reset.

Resulting local commit: **`4aebfa0f4aaf011cfd85347246c18d3cbde305ba`**. It changes only:

- `server/src/__tests__/helpers/blocked-task-fixture.ts`: injected test lifecycle with stage/cause propagation, successful-start tracking, serialized/idempotent disposal and visible cleanup errors.
- `server/src/__tests__/blocked-task-fixture.test.ts`: 12 deterministic lifecycle/occupied-port cases.
- `server/src/__tests__/blocked-task-scan.integration.test.ts`: real PostgreSQL adapter, existing free-port probe and thrown setup failure; removes the falsy setup-error protocol and ignored cleanup errors.

The complete business suite after `describe.skipIf` was compared byte-for-byte to the original with only its five setup-error guards removed. **Four test cases and all eight assertion expressions are preserved.** Migration/seed behavior and platform/hook bounds remain unchanged. No backup test, timeout, production service, schema, dependency or lockfile changed. No source was pushed. [Commit identity](evidence/f4-repair-2026-09-12/commit-identity.json) confirms all three committed blobs equal the tested bytes.

## Observed checks

| Check | Observed outcome |
|---|---|
| Fresh offline frozen install | Passed; no tracked source change |
| Six explicit prebuilds, including plugin SDK | All passed |
| TypeScript-aware SDK export import | Passed before any tests |
| Initial test-first bootstrap | Expected missing-helper collection failure; scaffolding evidence only |
| Deliberately swallow startup rejection | Unit run failed with resolved-promise/fail-closed assertions, as required |
| Deliberately stop after unsuccessful startup | Unit run failed no-stop assertions, as required |
| Restored exact helper | **12 tests passed**, 0 skipped; 0.939 seconds command wall time |
| Initial explicit test-file typecheck | Failed, exit 2; temporary config omitted server ambient declarations and project type resolution; not accepted as green |
| Corrected strict test-file typecheck | **Passed**, exit 0; 12.569 seconds |
| Combined original real-DB fixtures | **11 tests passed across three files**, 0 skipped; 11.878 seconds |
| Integrity | All expected source entries unchanged before/after every command; final three source blobs match the local commit |

The integration run executed blocked-task (4), runtime-provider-key (5), and original backup/restore (2). It retained normal concurrency and included both server and DB projects. PostgreSQL shutdown was observed; the container was then stopped and verified offline. This sample demonstrates successful co-execution, not absence of every possible port race or reproducibility of the earlier F5 timeout.

## Temporary typecheck configuration correction

The original external `/workspace/evidence/f4-types.json` included only three test paths. The server's ordinary config includes `src`, including `src/types/express.d.ts`, whereas this override omitted it. Its location outside the project also failed to load the intended ambient Node types. Diagnostics included missing Request actor declarations and EventEmitter methods in existing imports and the new test. No subsequent integration command launched on that failure; the container was stopped and logs retained.

Within this bounded repair/check scope, Codex corrected only the external verification configuration: include `/workspace/f4-repair/server/src/types/**/*.d.ts`, explicitly load `types: ["node"]` using the server and root project `node_modules/@types` directories. `strict`, `noEmit`, checked source and repository config remain unchanged; no error suppression, dependency install or source workaround. One newly named corrected check passed. This is a recorded adjustment to the plan's exact command sequence, not an erased failure or an additional general planning round.

The corrected runner explicitly permits that one failed-config transition, then requires a successful corrected typecheck before integration. Source/attempt/timeout checks remain. No broad failed-prerequisite bypass was introduced. Both configurations and both runners are published, with hashes. Actual successful config SHA-256: `2ae1e934281d9fe3c7f3e15d46a89f7127400da7c9bea311de6b29314d795390`.

## Environment, scope and evidence

Fresh Git-backed checkout `/workspace/f4-repair` used the host-exported b5 Git bundle. The immutable image was `node@sha256:b977d0f785d96029d8d4c0790b6bf1c2a4c72e0f26319808e7ba2e9d966a1ac3`, user/group 1000, network `{}`, one task volume and no host repository/home/socket mounts. The runner passed only PATH, HOME, COREPACK_HOME, XDG_CACHE_HOME, CI, LANG and a fresh AOA_HOME. No real application database, provider session, credential or network download was used.

Original source manifest: 7,664 entries; final repaired manifest: 7,666 entries. Setup began 18:12:17 UTC; final integration began 18:15:01 UTC and completed approximately 18:15:13 UTC. Five-minute unit command bounds, 15-minute type/integration bounds and the 15-minute setup/60-minute checks budgets were not exhausted. Expected negative mutations remained isolated and were removed before green tests and the local commit. Full source manifests distinguish bootstrap, each negative mutation and final source; repeated identical manifests are stored once with hash references.

Retained host evidence: `C:/Users/TK/AppData/Local/Temp/universe-f4-repair-20260912`. Published: [command ledger](evidence/f4-repair-2026-09-12/command-ledger.json), [unit pass](evidence/f4-repair-2026-09-12/green.log), [negative swallowed rejection](evidence/f4-repair-2026-09-12/red-swallow.log), [negative stop](evidence/f4-repair-2026-09-12/red-stop.log), [failed config check](evidence/f4-repair-2026-09-12/types.log), [corrected typecheck](evidence/f4-repair-2026-09-12/types-corrected.log), [integration summary](evidence/f4-repair-2026-09-12/integration.summary.log), [full integration log](evidence/f4-repair-2026-09-12/integration.log.gz), [source integrity](evidence/f4-repair-2026-09-12/source-integrity.json), [evidence hashes](evidence/f4-repair-2026-09-12/manifest.json).

## What is next

**Next engineering action is the full clean-commit qualification in Task 4 of the F4 plan, after its separate execution approval.** Use actual repair commit `4aebfa0f4aaf011cfd85347246c18d3cbde305ba`, all four shards, repository typecheck and the gated build. The targeted tests above do not replace that full check. The source repair is kept local for review and is not integrated into replatform or Universe.

F5 remains a full-qualification concern; no further backup-only diagnostic is recommended. A passing full baseline supports an exact landing/adoption proposal, not automatic base movement. DESIGN consistency, provider/worker/authority bindings, actual-host regression and UAT remain with their owning slices. Universe still uses application pin `183e46a9c65fc3105c7e3d125629276814df7dbb`; the premature draft is untouched. Production implementation remains paused.

Full repository `pnpm -r typecheck`, all four shards and `pnpm build` were **not run in this bounded targeted batch**. They are the separate next qualification, so this report does not claim the repository Definition of Done or full baseline acceptance.
