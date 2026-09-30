# Viewer Upgrade — Phase 7: Tier-3 Navigational Emission + Cross-Surface Delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. TDD per task; checkbox tracking. Read the two investigation findings baked into this plan before executing.

**Goal:** Agents can drive the viewer with **navigational** refs (task/approval/memory_item/url/discussion — "I created task X", "see approval Y"), not just their own artifact output. Two halves:
- **7A (small, testable now):** Commander emits `task`/`memory_item`/`approval` navigational refs from the write-tools that already return those ids. Commander already has every tab body (Phase 6) + delivery pipeline, so this is emission-only.
- **7B (large):** crew runs DELIVER navigational refs to the **Discussions** and **Workspace** surfaces, which today consume no ShowRef at all. Uses **post-run synthesis** (build refs from the runner's known context at relay time) — NOT per-tool-call bridge capture.

**Key investigation facts (server `adfb98379` + UI `a6e1d642`):**
- The MCP bridge (`buildOutputRefs`) fires for crew too, BUT crew refs are discarded (`AoaRunResult` has no refs field) and surface is hardcoded `"commander"`. So crew delivery is a **separate path** — do NOT try to capture per-tool-call crew refs.
- **No MCP tool produces a `discussion` or `url` ref.** Those must be synthesized from runner context (`payload.threadId`, `issues.sourceDiscussionId`, `task_outputs.url`). `task`/`memory_item`/`approval` DO come from tool results.
- `discussion_entries` has **no** `output_refs` column (add one, mirroring `internal_agent_messages.output_refs`). The crew→thread loopback `relayCrewResult` (`server/src/services/crew-result-relay.ts:42`) already inserts an entry + fires `discussion.entry.created`/`thread.entry.created`, and the UI **already refetches the thread on those pokes** — so a ref on that entry rides for free.
- **Workspace output poke is missing:** `heartbeat.run.outputs_detected` is declared but unhandled in `LiveUpdatesProvider.tsx`; `queryKeys.taskOutputs.byIssue` is never invalidated on a live event. Tier-3 must wire it.
- Thread + Workspace consume **no ShowRef** — all payload-typed tabs. Add thin per-surface `openRef(ShowRef)` adapters (NO model merge — locked decision).
- **Reuse (already surface-agnostic, exported, self-fetching):** `TaskDetail` (by issueId), `ApprovalDetailCore` (by approvalId, `embedded`). **Extract from `CommanderViewerPanel.tsx` (file-local, unexported):** `DiscussionRefTabBody`, `OutputRefTabBody`, `MemoryItemRefTabBody`. `OutputRefChips` is nearly surface-agnostic (one `chipLabel` import).
- **Design-matrix corrections:** Thread ALREADY has a rich memory body (`MemoryLinkedViewer`) + artifact/asset/task/url. Workspace ALREADY has asset (Phase 4) + artifact/url. So Thread only needs discussion/approval/output-by-id; Workspace needs task/discussion/approval/memory/output-by-id.
- **RBAC:** `canViewThread` (`server/src/services/threads.ts:115`) already scopes `thread.*` pokes via `filterThreadEventRecipients`. Refs are pointers (opening hits an RBAC-checked REST route). The one new guard: do NOT deliver a **private-thread `discussion` ref onto a company-scoped surface**.

**Tech stack:** Drizzle (`pnpm db:generate`; hand-add `IF NOT EXISTS`), Express, React, Vitest, Zod. Migrations at meta 0174.

**Deferred (intentional):** per-tool-call crew ref capture / bridge surface plumbing for arbitrary tool results (post-run synthesis covers the founder-relevant products without it); freshness/replay auto-open gate (Phase-6 baseline); TTL-ephemeral.

---

# PART 7A — Commander navigational emission (execute first; independently testable)

## Task 1: Emit task / memory_item / approval refs from Commander tool results

**Files:** `server/src/services/internal-agent/output-refs.ts` (extend `buildOutputRefs` switch); tests `output-refs.test.ts`. (Delivery + tab bodies already exist from Phase 6 — task→`TaskDetail`, approval→`ApprovalDetailCore`, memory_item→`MemoryItemRefTabBody`.)

**CRITICAL (Codex P1-1): `buildOutputRefs` runs in the MCP bridge and sees COMMANDER'S internal-agent tool names, NOT the outbound MCP write-tools.** The hyphenated `create-task`/`suggest-memory` in `server/src/mcp/tools/write-tools.ts` are the OUTBOUND server (what external clients call) — Commander never invokes them. Commander's tools are in `server/src/services/internal-agent/tools/` (the same registry whose `create_artifact`/`get_task` `buildOutputRefs` already switches on). The real, verified tool names:
- `create_task` (`action-tools.ts:7`) → `task`, action `created`.
- `update_task` (`action-tools.ts:69`) → `task`, action `referenced`.
- `suggest_memory` (`memory-tools.ts:263`), `write_memory` (`memory-write.ts:36`), `propose_memory_from_thread` (`memory-propose.ts:38`) → `memory_item`.
- `approval_decision` (`approval-tools.ts:123`) → `approval`, action `referenced`. **(Commander has no create-approval tool — it decides on existing approvals; so approval refs are `referenced` only.)**
- `get_task` is ALREADY handled — extend, don't duplicate.

**Read each tool's handler first** to confirm the result shape actually carries the id (`created.id` / `{id,status}` / the approval id). Emit a ref ONLY when the result has a usable id.

- [ ] **Step 1 — failing tests.** In `output-refs.test.ts`, add cases keyed on the REAL tool names: `create_task` → `{v:2, kind:"task", id:<result id>, action:"created", provenance…}`; `update_task` → `kind:"task", action:"referenced"`; `suggest_memory` (and `write_memory`) → `kind:"memory_item", action:"created"`; `approval_decision` → `kind:"approval", action:"referenced"`. Each with a provenance ctx → stamped; 3-arg → `provenance:null`. Use the actual result-shape fixtures from the handlers.
- [ ] **Step 2 — implement.** Add switch cases in `buildOutputRefs` building `task`/`memory_item`/`approval` v2 refs via a small `navRef({kind,id,action}, ctx)` helper (mirrors `artifactRef` but for pointer kinds — no versionId; provenance via `buildProvenance`). Reuse the existing per-ref `nextSeq`/`provenanceBase` plumbing. Validate against `showRefsSchema`. Do NOT emit `discussion`/`url` (no producing tool). Guard each case on the id being present (a failed/empty result emits no ref).
- [ ] **Step 3 — verify + commit.** `pnpm test:run server/src/services/internal-agent/__tests__/output-refs.test.ts server/src/services/internal-agent/__tests__/mcp-bridge-output-refs.test.ts` + `pnpm --filter @armyofagents/server typecheck`. (The refs auto-flow through the Phase-6 merge/lift/deliver/render pipeline — the Commander tab bodies already exist. A quick reasoning check: a `task` ref chip → `openRefTab` `task` branch → `TaskDetail` — already wired.)
```
git commit -m "feat(commander): emit navigational task/memory_item/approval refs from tool results (Tier-3 emission)"
```

**7A checkpoint:** after Task 1, Commander navigational Tier-3 is live and testable end-to-end (Commander creates/updates a task → clickable chip → opens the task viewer). Natural point to pause for a live smoke if desired.

---

# PART 7B — Crew → Thread delivery (Thread-only; on-run-finish; reworked per user decisions + Codex P1s)

> **Locked decisions (user, 2026-07-19):** (1) **Thread-only** — deliver crew refs to the originating Discussion thread; NO Workspace ingress/poke this phase (Workspace already surfaces outputs via `OutputsSection`; its openRef adapter + bodies are deferred). (2) **Deliver on crew run FINISH, even if the task stays in review** — via a NEW distinct "run result" delivery entry, NOT the existing `done`-gated "Completed" relay (keeps Decision #109: technical completion ≠ task completion). (3) **Correlation = honest aggregate** — synthesize the task ref + the task's CURRENT artifacts/outputs, provenance identifying the delivering run/agent/thread; do NOT falsely stamp each product as "created this run" (no schema churn; precise per-run correlation deferred).
>
> **Codex P1s folded in:** P1-3 → new on-finish entry (not done-gated). P1-4 → aggregate semantics, no false run-stamping. P1-5/P1-2 → dropped (Thread-only, no workspace poke). Missing-sources → synthesis emits task + artifacts + task_outputs refs (approval/memory only if a tool actually produced one in-run; not fabricated). P2-1 → field-aware `task_outputs` mapping over the real 9-value zod enum. P2-2 → derive threadId from `issue.sourceDiscussionId`, assert equality. P2-3 → extract `OutputRefTabBody`'s file-local deps too. P2-4 → update the shared `DiscussionEntryV2Schema` + UI type. P3-1 → runId idempotency anchor on the delivery entry.

## Task 2: `discussion_entries.output_refs` column (schema + shared contract)

**Files:** `packages/db/src/schema/discussions.ts` (+ migration), `packages/shared/src/api/threads-contract.ts` (`DiscussionEntryV2Schema` ~L24), `ui/src/api/discussions.ts` (entry type ~L105); tests `migration-idempotency.test.ts` + a contract test.

- [ ] **Step 1 — DB column.** Add `outputRefs: jsonb("output_refs")` (nullable, typed `ShowRef[] | null`, mirroring `internal_agent_messages.output_refs:217`) to `discussion_entries` (`discussions.ts:148`). `pnpm db:generate` → `0175_*.sql`; hand-add `IF NOT EXISTS` to the ADD COLUMN; `migration-idempotency.test.ts` passes.
- [ ] **Step 2 — shared contract (P2-4).** Add `outputRefs: showRefsSchema.nullable().optional()` (or `.nullish()`) to `DiscussionEntryV2Schema` (`threads-contract.ts:24`) AND the UI entry type (`ui/src/api/discussions.ts:105`). Ensure the discussions read route serializes the column. A contract test asserts an entry round-trips `outputRefs`.
- [ ] **Step 3 — commit.** `pnpm --filter @armyofagents/db typecheck` + `@armyofagents/shared typecheck` + the tests.
```
git commit -m "feat(viewer): discussion_entries.output_refs column + shared DiscussionEntryV2 contract"
```

## Task 3: `synthesizeThreadDeliveryRefs` helper (aggregate, field-aware, RBAC-safe)

**Files:** NEW `server/src/services/viewer-ref-synthesis.ts` (+test). Read `packages/db/src/schema/task_outputs.ts` + `packages/shared/src/validators/task-output.ts` (the real 9-value type enum) + `server/src/services/task-outputs.ts` `listForIssue` first.

- [ ] **Step 1 — failing tests.** `synthesizeThreadDeliveryRefs({ db, companyId, issueId, threadId, runId, agentId })` → `ShowRef[]`. Cover: (a) always emits ONE `task` ref (`kind:"task"`, id:issueId, action:"referenced", provenance {surface:"discussion", entityId:threadId, runId, agentId, seq, emittedAt}); (b) each `task_outputs` row maps **field-aware** — `artifact`/`artifact_version` (has artifactId) → `kind:"artifact"` (+versionId); `preview_url`/`pull_request`/`branch`/`commit`/`external_link` (has url) → `kind:"url"`; `detected_file`/`runtime_service`/asset-bearing → `kind:"output"` by output id; malformed/missing supporting field → `kind:"output"` fallback (never crash); (c) the task's artifacts → `kind:"artifact"` refs; (d) dedup via `mergeOutputRefs`; (e) cap at `MAX_OUTPUT_REFS_PER_MESSAGE`; (f) empty issue → just the task ref.
- [ ] **Step 2 — implement.** Inject db reads (task row, `listForIssue` outputs, task artifacts). Field-aware `task_outputs.type` → ref-kind mapping over the ACTUAL enum values. Provenance surface always `"discussion"`, entityId = the passed threadId. **Aggregate semantics** — this returns the task's CURRENT products (not "this run created these"); the provenance identifies WHO delivered (runId/agentId), not per-product authorship. Comment this explicitly.
- [ ] **Step 3 — commit.** `pnpm test:run` the helper test + `@armyofagents/server typecheck`.
```
git commit -m "feat(viewer): synthesizeThreadDeliveryRefs — aggregate task+outputs+artifacts refs (field-aware, capped)"
```

## Task 4: New crew "run result" delivery entry (on run finish, in-review-safe) + runId thread + idempotency

**Files:** `server/src/services/crew-result-relay.ts` (NEW `deliverCrewRunResult` alongside `relayCrewResult` — do NOT change the done-gated one), `server/src/services/internal-agent/aoa-agents/crew-run-outcome.ts` (thread `runId`, call the new delivery), `server/src/services/heartbeat.ts` (legacy caller if it composes the outcome); tests.

- [ ] **Step 1 — thread `runId` (P1-3/P3-1).** `CrewRunSuccessInput` already has `runId` (`crew-run-outcome.ts:57`) but drops it — thread it into a new `deliverCrewRunResult({ db, companyId, issueId, runId, agentId })`. Derive `threadId` from `issue.sourceDiscussionId` (`crew-result-relay.ts:82`), **assert the ref provenance entityId === that threadId** (P2-2). If the issue has no source thread → no delivery (nothing to deliver to).
- [ ] **Step 2 — new on-finish entry.** `deliverCrewRunResult` inserts a NEW `discussion_entries` row on the origin thread — `inputType:'agent'`, a short "Run finished — N outputs" `rawContent`, `extractionStatus:'skipped'`, atomic seq — **regardless of task status** (fires on run finish, in-review included; distinct from the `done`-gated "Completed" entry so both can legitimately exist). Set `outputRefs = synthesizeThreadDeliveryRefs(...)`. Publish the existing `discussion.entry.created` + `thread.entry.created` pokes (UI already refetches). Best-effort (try/catch; never fail the run).
- [ ] **Step 3 — idempotency (P3-1).** Anchor on `runId` — before inserting, check no prior run-result entry exists for this `runId` (e.g. a `sourceInfo.runResultRunId` marker or a unique check) so a retried success side-effect doesn't double-post. Test the retry path yields one entry.
- [ ] **Step 4 — RBAC (P2-2).** The entry lands ONLY on the origin thread (same visibility as the work); `thread.entry.created` is already `canViewThread`-filtered. Test: a private-thread run delivers only onto that private thread; the refs' entityId matches. (Opening any ref re-checks RBAC at the REST route.)
- [ ] **Step 5 — commit.** `pnpm test:run` crew-relay + crew-run-outcome tests + `@armyofagents/server typecheck`.
```
git commit -m "feat(crew): deliver run-result entry with navigational refs on run finish (in-review-safe, idempotent)"
```

## Task 5: Extract the reusable Commander tab bodies into a shared module (P2-3)

**Files:** NEW `ui/src/components/viewers/refBodies/` — move `DiscussionRefTabBody`, `OutputRefTabBody` (+`OutputLinkCard`/`OutputDetailCard`), `MemoryItemRefTabBody`, **AND `OutputRefTabBody`'s file-local deps `ArtifactTabBody` + `AssetRefTabBody`** (Codex P2-3: OutputRefTabBody calls them, so moving only the three won't compile), plus the shared `LoadingBody`/`UnavailableBody` primitives. `CommanderViewerPanel.tsx` re-imports. Tests: `OutputRefTabBodies.test.tsx` stays green (repoint imports).

- [ ] **Step 1 — extract, behavior-preserving.** Move all named components; give each explicit props `{ companyId, refId, viewerKind? }` (no Commander context). Commander re-imports them. `OutputRefTabBodies.test.tsx` + `commanderViewerModel.test.ts` pass unchanged (pure refactor — the gate).
- [ ] **Step 2 — commit.** `pnpm --filter @armyofagents/ui typecheck` + the viewer tests + `pnpm --filter @armyofagents/ui build`.
```
git commit -m "refactor(viewer): extract ref tab bodies (+artifact/asset deps) to shared refBodies module"
```

## Task 6: Thread openRef adapter + delivered-ref chips + missing Thread bodies

**Files:** `ui/src/components/threads/threadViewerModel.ts` (NEW `showRefToThreadTab`), `ui/src/components/threads/EntryRow.tsx` (render chips from `entry.outputRefs`), `ui/src/components/threads/ThreadViewer.tsx` (add discussion/approval/output-by-id bodies), `ui/src/pages/ThreadDetail.tsx` (wire chip→openRef→tab). Tests.

- [ ] **Step 1 — openRef adapter.** `showRefToThreadTab(ref: ShowRef): ThreadViewerTab` mapping the 8 kinds to Thread tabs: artifact→`artifactRefTab`, asset→`asset` tab, task→`taskTab`(`TaskDetail`), memory_item→existing `memory` tab (`MemoryLinkedViewer`), url→`browserTab`; **NEW**: discussion→extracted `DiscussionRefTabBody`, approval→`ApprovalDetailCore embedded`, output(-by-id)→extracted `OutputRefTabBody`. Unit-test the mapping for all 8 kinds. (Recall the design-matrix correction: Thread ALREADY has task/memory/artifact/asset/url bodies — only discussion/approval/output-by-id are new.)
- [ ] **Step 2 — chip rendering.** `EntryRow` renders a chip row from `entry.outputRefs` (reuse `OutputRefChips` — it's nearly surface-agnostic; if it must move, relocate to `ui/src/components/viewers/`), each wired to `openViewerTab(showRefToThreadTab(ref))` via the existing `openAttachmentInViewer`-style seam (`ThreadDetail.openViewerTab`). Surface `entry.outputRefs` through the discussions API/types (from Task 2).
- [ ] **Step 3 — missing bodies.** Add to `ThreadViewer` body switch (`ThreadViewer.tsx:330`): `discussion` (extracted `DiscussionRefTabBody`), `approval` (`ApprovalDetailCore embedded`), `output`-by-id (extracted `OutputRefTabBody`). Reuse — do not rebuild task/memory/artifact/asset.
- [ ] **Step 4 — commit.** thread viewer tests + `@armyofagents/ui typecheck` + build.
```
git commit -m "feat(discussions): delivered-ref chips + openRef adapter + discussion/approval/output tab bodies"
```

## Task 7: Completion gate

- [ ] `pnpm -r typecheck` → PASS.
- [ ] `pnpm test:run` the Phase-7 surface (output-refs, viewer-ref-synthesis, crew-relay, crew-run-outcome, migration-idempotency, threads-contract, threadViewerModel, ThreadViewer, EntryRow, refBodies) → PASS.
- [ ] `pnpm build` → PASS.
- [ ] **Reuse discipline grep:** the extracted bodies have ONE definition each (no copy-paste); `TaskDetail`/`ApprovalDetailCore`/`MemoryLinkedViewer` are imported, not reimplemented.
- [ ] **RBAC (Task 4):** a private-thread run delivers refs ONLY onto that thread; provenance entityId === the origin thread.
- [ ] **No model merge:** the 4 viewer tab models remain separate; only a thin `showRefToThreadTab` adapter was added. (Workspace adapter intentionally deferred.)

---

## Self-Review / risks

- **Biggest risk: Task 3 field-aware mapping** — use the REAL 9-value `task-output.ts` zod enum (artifact/artifact_version/detected_file/preview_url/runtime_service/pull_request/branch/commit/external_link), mapping by which supporting field is populated (artifactId → artifact, url → url, else → output). Handle missing/malformed fields → `output` fallback, never crash.
- **Task 4 must NOT touch the done-gated `relayCrewResult`** — it's a SEPARATE `deliverCrewRunResult`. Two entries (run-result on finish + Completed on done) can both exist; the idempotency anchor is per-run, so a done transition later still posts its own "Completed" entry without a duplicate run-result.
- **Task 5 extraction is behavior-preserving** and gates Task 6's reuse — Commander tests must pass unchanged.
- **Aggregate semantics are intentional** — the delivery lists the task's current products; provenance identifies the delivering run, not per-product authorship. Precise per-run correlation is deferred (would need `internal_agent_runs` linkage on `task_outputs`).
- **Deferred:** Workspace ref ingress + openRef adapter + task/discussion/approval/memory Workspace bodies + the `task.output.created` event (P1-5) — a future Workspace-delivery phase.
- Live dogfood (final test) MUST verify: (a) codex reports `server:"aoa"` (Phase-6 P3-2), (b) a real crew run posts a run-result entry with clickable refs onto its thread, (c) clicking each ref kind (task/artifact/output/discussion/approval) opens the right Thread body.

---

## Execution Handoff

**Subagent-driven**, spec + code-quality review per task. **7A (Task 1) already shipped** (`1a810ee1c`). 7B sequential: 2 (schema) → 3 (synthesis) → 4 (delivery) → 5 (extract) → 6 (thread UI). `pnpm -r typecheck` + suites + `pnpm build` gate it; final live dogfood after Task 7.
