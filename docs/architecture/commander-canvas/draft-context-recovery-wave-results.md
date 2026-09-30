# Universe draft, context and recovery wave results

**Status:** Source implementation and Linux migrated-PostgreSQL qualification complete. The remaining B05 producers are still open.

## Delivered scope

This bounded wave implements the ready draft/context/outcome packages that follow the persisted Canvas entry. It does not claim that all of B04 or B05 is complete.

| Planned package | Delivered behavior | Boundary still open |
|---|---|---|
| `E1.3/1.b` | Owner- and destination-authorized durable draft schema for Commander, Task, question, runtime-decision and approval payloads; bounded pending-attempt metadata; company-owned validated attachments; generated migrations 0285/0286 | Production composers still migrate incrementally to the structured payload. Full five-destination UI/UAT and retention policy remain open. |
| `E2.1/1` | Immutable selected/visible reference and viewport capture from the real Universe workspace; server-side company/user/reference resolution; resolved context enters existing Commander context assembly | E2.1/2 continuity/eval corpus, provider-loss rebuild and performance measurements remain open. |
| `E2.2/1` | Read-only Commander and Task outcome reads; `no-store`; canonical Commander submission hash; legacy identity returns unknown; changed intent conflicts before execution; claimed run binding is token-fenced | Distributed worker/output binding remains CMD-gated in E2.2/2. |
| `E1.3/2` (Commander/Task portion) | Retry observes the canonical result before POST. Accepted/completed work settles the frozen draft without sending twice; only a proven missing submission reuses the exact idempotent attempt; observation failure preserves the draft | Question, runtime-decision and approval reconciliation plus complete five-destination recovery UAT remain open. |

## Source checkpoints

- `208dc4188` — capture Universe context and add observation-only outcomes.
- `a3b4d24e8` — bind resolved context and add safe Task retry recovery.
- `f0607b2b0` — persist structured drafts and fence Commander submission identity/retries.
- `df253bfa2` — update the route contract for the new observation endpoint.

The implementation remains in the isolated `codex/universe-interface` worktree. No deployment, merge or push was performed by this wave.

## Verification

- Focused shared/server/UI verification: **147 tests passed** (5 draft validator, 31 Commander identity/outcome/agent-loop, 80 draft/Commander/Task UI recovery, and 31 route-contract tests).
- `pnpm -r typecheck`: **passed** across the workspace.
- `pnpm build`: **passed** across the workspace.
- `pnpm test:run`: completed with **18,093 passed, 98 skipped and 175 failed**. The run is not a green repository certificate. The failures are dominated by the already-recorded Windows Node 24 `require(esm)`/Drizzle cycle and unrelated baseline tests for unfinished worker/session/placement work. The one failure caused by this wave (the internal-agent route-count contract) was corrected and its full 31-test file passes.
- Exact committed source `4b8ae70091f05a0f299f316dc49ab847a7f53da4` was copied into the established non-root Node 24 Linux qualification container and installed from the frozen lockfile/offline cache. The real embedded-PostgreSQL migration/CAS/isolation suite passed **6/6** after applying the complete committed migration chain, including 0285/0286. Focused Linux shared/server/UI qualification passed **227/227** additional tests (8 shared, 132 server and 87 UI), for **233/233** focused Linux tests total. Workspace dependencies needed by the server test graph were built before the rerun; the initial missing `@armyofagents/worker-protocol` dist entry was qualification-environment preparation, not a source failure.

The Linux run qualifies the migrated draft storage and the read-only/identity/recovery source boundary. It does not close the later five-destination UI/UAT, draft-retention decision, or distributed E2.2/2 worker/output binding.

## Review findings resolved

1. Retry no longer treats a transport error as proof that a POST was absent.
2. Reusing a Commander `clientSubmissionId` with changed frozen intent fails before claim/execution.
3. Historical rows without a stored fingerprint remain `unknown`; they are never assumed equal or automatically replayed.
4. `runId` is bound only while the caller still owns the current turn claim token.
5. Draft reads/writes authorize the owning conversation and the concrete destination; unavailable destinations use a disclosure-safe not-found response.
6. Draft attachments must exist in the same company and already satisfy the canonical composer validation gate.

## Next sequence boundary

Do not jump to distributed execution. The next ready work follows the execution graph: complete the remaining B05 producers (`E7.3/1` authorized attention projection and `E4.1/1` durable human originals), then finish the remaining five-destination `E1.3/2` recovery adapters in B06.
