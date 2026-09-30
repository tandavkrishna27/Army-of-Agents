# Viewer Upgrade — Phase 6: Commander v2 EMISSION (provenance) + carry-forwards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. TDD per task; checkbox tracking.

**Goal:** Commander stops emitting v1 artifact refs and emits **v2 refs with provenance** (Tier-2 "own output" now carries who/where/when), and the four Phase-2 carry-forwards are closed: (1) `mergeOutputRefs` provenance-precedence, (2) v1/v2 same-artifact double-card, (3) the asset/output/memory_item dead-click (real Commander tab bodies), (4) silent malformed-ref drops → debug log.

**Why now:** v2 emission is the foundation Tier-3 (Phase 7) builds on, and the carry-forwards only become observable once v2 refs actually flow. No auto-open behavior changes — `shouldAutoOpen`/`pickAutoOpenRef` are version-agnostic (`ref.action === "created"`), and the viewer renders v2 artifact identically (Phase 2). The persist boundary already accepts v2 (`conversation-output-refs.test.ts:103`).

**Architecture (from investigation `a37180b3` + Codex plan-review 0.144.1):**
- `buildOutputRefs(toolName, params, result)` (`server/src/services/internal-agent/output-refs.ts:67`) is the only AoA **builder**, called only by `executeAndFormat` at `mcp-bridge.ts:96` where **`toolContext` is in lexical scope**. BUT it is **not** the sole thing that can INJECT refs: both adapters lift an `outputRefs` envelope from **any** `mcp__*`/`mcp_tool_call` result — Claude at `parse-stream-json.ts:278` (and Commander also runs a Playwright MCP server, `cli-mode.ts:218`), Codex at `parse.ts:197` + `parse-events.ts:97` — none checks `server === "aoa"`. So a non-AoA MCP result can inject forged refs + provenance + `action:"created"` (which Phase-5 auto-open trusts). **Task 4 hardens this: lift only from the AoA server.**
- Provenance fields at emission (built at the call site from `toolContext`): `surface: "commander"` (const), `entityId = toolContext.contextScope?.conversationId`, `runId` (**must be threaded** — see below), `agentId = toolContext.agentId ?? null` (null for Commander), `messageId: null` (message persists post-turn — not knowable at emission), `emittedAt = new Date().toISOString()`, `seq` via a **per-ref** `nextSeq()` callback backed by a module-level counter in the bridge subprocess (per-turn: bridge respawns/exits per turn — codex `cli-mode.ts:615`, claude `:805`, bridge `:371`).
- **`runId` gap (Codex P1):** the run row is created at `internal-agent.ts:164` but never threaded to chat → `AOA_RUN_ID` is unset → the bridge sets `runId: null` (`mcp-bridge.ts:269`). The bridge **already reads** `AOA_RUN_ID`; we just have to set it. Task 1 threads `run.id` → `ChatInput.runId?` (`agent-loop.ts:66`) → CLI MCP env (`cli-mode.ts:625`).
- **`provenance: null` fallback** when `conversationId` is null (schema forbids empty `entityId`). Edge-only: `cli-mode.ts:600` already rejects a missing conversation, so this is defensive; still handle + test it.

**Tech stack:** Drizzle (no schema change this phase), Express, React, Vitest, Zod. Repo migrations at meta 0174.

**Deferred (intentional):** Tier-3 navigational emission (task/discussion/url) + cross-surface delivery channels + Workspace/Thread tab bodies + openRef adapters → Phase 7. TTL-ephemeral → later. `messageId` backfill at persist → `null` is fine. **Freshness/replay auto-open gating** (Codex P2.2 — an idempotent replay reattaches old `created` refs at `agent-loop.ts:135` and can re-auto-open stale output; Build-1 design §84 wants provenance to distinguish fresh-vs-replay) → **explicitly deferred**; Task 6 adds a documented regression test capturing current (replay-can-reopen) behavior so the future gate has a baseline.

---

## Task 1: v2 emission with provenance (+ thread runId, widen UI type, flip gate tests)

**Files:** `server/src/services/internal-agent/output-refs.ts`, `server/src/services/internal-agent/mcp-bridge.ts`, `server/src/services/internal-agent/agent-loop.ts` (`ChatInput`), `server/src/routes/internal-agent.ts` (pass `run.id`), `server/src/services/internal-agent/cli-mode.ts` (set `AOA_RUN_ID` env from `ChatInput.runId`), `ui/src/api/internal-agent.ts` (`AgentMessage.outputRefs` type); tests `output-refs.test.ts`, `mcp-bridge-output-refs.test.ts`.

- [ ] **Step 1 — thread `run.id` to the bridge env (Codex P1.2).** `internal-agent.ts` already creates the run at ~L164; pass `run.id` into `svc.chat(...)` (~L228). Add `runId?: string` to `ChatInput` (`agent-loop.ts:66`), thread it to the CLI MCP param/env builder (`cli-mode.ts:~625`) so `AOA_RUN_ID` is set. The bridge already reads it (`mcp-bridge.ts:269`) — no bridge change. Add a test asserting a Commander run's emitted provenance carries `runId === <run row id>`.
- [ ] **Step 2 — provenance base + per-ref seq (Codex P1.3).** In `mcp-bridge.ts`, add a module-level `let refSeqCounter = 0` and a `nextSeq = () => refSeqCounter++`. At the `executeAndFormat` call site build a `provenanceBase` from the in-scope `toolContext`: `surface:"commander"`, `entityId: toolContext.contextScope?.conversationId ?? null`, `runId: toolContext.runId ?? null`, `agentId: toolContext.agentId ?? null`, `messageId: null`, `emittedAt: new Date().toISOString()`. Pass BOTH `provenanceBase` and `nextSeq` into `buildOutputRefs`. **`seq` is allocated PER REF inside the builder via `nextSeq()`** — not once at the call site (a single `query_artifacts` emits many refs; each must get a distinct, contiguous seq).
- [ ] **Step 3 — emit v2 in the builder.** Add a 4th param `ctx?: { provenanceBase: {...} | null; nextSeq: () => number }`. `artifactRef(...)` (`output-refs.ts:31`) becomes v2: `v:2, kind:"artifact", …, provenance: ctx?.provenanceBase ? { ...ctx.provenanceBase, seq: ctx.nextSeq() } : null`. Keep `action` semantics. **All five cases** now emit v2. Preserve `versionId`/`title`/`mimeType`/`viewerKind` where the source has them. Validate built refs against `showRefsSchema` before returning. When `ctx` is absent (3-arg unit calls) → `provenance: null` v2 refs (NOT v1).
- [ ] **Step 4 — widen the UI persisted-message type (Codex P2.3).** `ui/src/api/internal-agent.ts:31` `AgentMessage.outputRefs: CommanderOutputRef[]` → `ShowRef[] | null`. Removes the unsafe cast at `InternalAgentPanel.tsx:445`.
- [ ] **Step 5 — flip the gate tests.** `output-refs.test.ts:18` (`v:1`) → `v:2` + `provenance:null` (3-arg). `output-refs.test.ts:149` (v1-only `commanderOutputRefsSchema`) → `showRefsSchema`. Add: with a provenance ctx → `v:2, provenance.surface==="commander", entityId===conversationId, runId===runId`, and **a multi-row `query_artifacts` yields distinct contiguous `seq`** (guards P1.3). Add: null conversationId → `provenance:null`. `mcp-bridge-output-refs.test.ts:40` → assert `v:2` + provenance present when the bridge has a contextScope.
- [ ] **Step 6 — verify + commit.** `pnpm test:run` the four internal-agent ref tests → PASS. `pnpm --filter @armyofagents/server typecheck` + `pnpm --filter @armyofagents/ui typecheck`.
```
git commit -m "feat(commander): emit v2 output refs with provenance (surface/entity/run/per-ref-seq); thread runId; widen UI type"
```

---

## Task 2: mergeOutputRefs provenance-precedence + v1/v2 double-card coalescing

**Files:** `server/src/services/internal-agent/output-refs.ts` (`refKey`, `mergeOutputRefs`), `ui/src/components/commander/viewer/commanderViewerModel.ts` (`refKey` twin ~L205, `mergeRefs` ~L212); UI `ui/src/components/commander/viewer/OutputRefChips.tsx` (key ~L19), `ui/src/components/commander/viewer/CommanderViewerHome.tsx` (key ~L75). Tests `output-refs.test.ts`, `commanderViewerModel.test.ts`.

Root cause (investigation B5): `refKey = ${r.v}|${r.kind}|${r.id}|${r.versionId}` includes `v`, so the same artifact as a legacy-replayed v1 ref + a fresh v2 ref → two map entries → two cards + duplicate React keys (`OutputRefChips.tsx:19` / `CommanderViewerHome.tsx:75` omit `v`).

- [ ] **Step 1 — failing tests.** In `output-refs.test.ts`: two refs, same `(kind,id,versionId)`, one `v:1` one `v:2` created → `mergeOutputRefs` yields **ONE** entry (the v2, richer). Two `v:2` refs same key, different `provenance.emittedAt` → the **newer emittedAt wins**. Created-beats-referenced still holds. In `commanderViewerModel.test.ts`: same coalescing for the UI `mergeRefs` twin.
- [ ] **Step 2 — implement FIELD-WISE merge (Codex P2.1).** Drop `v` from the dedup identity: `refKey = ${r.kind}|${r.id}|${r.versionId ?? ""}` (both server + UI twin). On collision, do NOT keep one whole object and discard the other — merge field-wise so the strongest action AND the richest provenance both survive: (a) result `action` = `created` if either is created; (b) result `provenance` = the **v2** one, and if both are v2, the one with the **newer `provenance.emittedAt`** (a real emittedAt beats null); a v1 colliding with a v2 keeps the v2 provenance regardless of action; (c) result `title`/`mimeType`/`viewerKind`/`versionId` = first non-empty (backfill); (d) result `v` = 2 if either is v2. Keep the 20-cap logic. This fixes the case Codex flagged: `v1-created` + `v2-referenced` must yield `{action:"created", provenance:<v2's>}`. Add **permutation tests** (both input orders) for v1-created+v2-referenced and v2+v2 differing emittedAt.
- [ ] **Step 3 — fix React keys (Codex P3).** `OutputRefChips.tsx:19` and `CommanderViewerHome.tsx:75`: use a robust key `${ref.v}|${ref.kind}|${ref.id}|${ref.versionId ?? "latest"}` (include `kind`, not just `v`).
- [ ] **Step 4 — verify + commit.** `pnpm test:run` the two test files + `pnpm --filter @armyofagents/server typecheck` + `pnpm --filter @armyofagents/ui typecheck`.
```
git commit -m "fix(commander): coalesce v1/v2 same-artifact refs + provenance-precedence (emittedAt); harden React keys"
```

---

## Task 3: asset/output/memory_item Commander tab bodies (kill the dead-click)

**Files:** NEW `server/src/routes/assets.ts` meta route; NEW UI api clients `ui/src/api/assets.ts` (or extend), reuse existing `task-outputs`/`memory` clients; `ui/src/components/commander/viewer/commanderViewerModel.ts` (`ViewerTab.kind` union L14 + `openRefTab` default L74); `ui/src/components/commander/viewer/CommanderViewerPanel.tsx` (`TabBodySwitch` L436 + 3 new body components). Tests: new-route contract test + `commanderViewerModel.test.ts` open-behavior cases.

Investigation C8/C9: `output` (`GET /task-outputs/:id`, `task-outputs.ts:77`) and `memory_item` (`GET /companies/:cid/memory/:id`, `memory.ts:316`) read routes **already exist** — UI-only. `ui/src/api/memory.ts:52` `memoryApi.get` already exists (Codex P3); only `taskOutputsApi.get` is missing. **`asset` needs a new meta route** (only `GET /assets/:id/content` raw-stream exists — note it is **NOT** company-prefixed: `assets.ts:374` is `/assets/:assetId/content`).

- [ ] **Step 1 — asset meta route (TDD).** Add `GET /assets/:assetId/meta` to `server/src/routes/assets.ts` (mirror the content route's path shape + access assertion) returning `{ id, originalFilename, contentType, byteSize, createdAt }` from `svc.getById`. Contract test: returns meta, 403 cross-company, 404 missing. Do NOT return objectKey/sha256.
- [ ] **Step 2 — widen the tab model (Codex P2.6).** `ViewerTab` (`commanderViewerModel.ts:11-14`): add `"asset"|"output"|"memory_item"` to `kind`, AND add optional `viewerKind?` + `mimeType?` fields to `ViewerTab` so the v2 hints survive into the body (they're currently dropped). `openRefTab` (`:74` default): replace the no-op with real dispatch — `asset:${id}`/`output:${id}`/`memory_item:${id}` (mirror `discussion`/`approval` at L65-71), carrying `viewerKind`/`mimeType` from the ref onto the tab. `commanderViewerModel.test.ts` cases: each kind now opens (not no-op) + carries the hints.
- [ ] **Step 3 — tab bodies (fix the asset sketch per Codex P1.4).** In `CommanderViewerPanel.tsx`, add to `TabBodySwitch` (L436) three bodies mirroring `ArtifactTabBody` (L59-104):
  - `AssetRefTabBody` — `useQuery(["commander-viewer-asset", refId], () => assetsApi.getMeta(refId))` → `resolveViewer({ contentType, filename: originalFilename, assetId: refId, metadata })` (resolveViewer derives the content URL from `assetId` — `viewer-registry.ts:136`) → `<SharedContentViewer viewer={viewer} filename={filename} />`. **No `src` prop** (it doesn't exist). Pass the tab's `viewerKind` hint into the resolver metadata.
  - `OutputRefTabBody` — `useQuery([..., refId], () => taskOutputsApi.get(companyId, refId))`. `TaskOutput` is polymorphic (`packages/shared/src/types/task-output.ts:24`: artifact-version / asset / url / other). Branch: artifact-version → route through `resolveViewer`/artifact fetch; asset → same as AssetRefTabBody; url → `openBrowserTab`-style external link (scheme-gated); other → a compact detail card. Define each branch — not a stub.
  - `MemoryItemRefTabBody` — `useQuery([..., refId], () => memoryApi.get(companyId, refId))` → render layer/content/status (reuse an existing `ui/src/components/memory/` detail view if one fits, else a compact read view).
  - Add only `taskOutputsApi.get` (memoryApi.get + assetsApi may need `getMeta`).
- [ ] **Step 4 — component tests (Codex P2.5).** Add `TabBodySwitch`/body tests for all three: success render, loading state, **404 → friendly "not available"** (mirror `DiscussionRefTabBody`'s 404 handling — no white screen), 403. For `OutputRefTabBody`, test each `TaskOutput` branch (artifact-version / asset / url / other) picks the right render.
- [ ] **Step 5 — verify + commit.** New-route test + `commanderViewerModel.test.ts` + the body component tests + `pnpm --filter @armyofagents/server typecheck` + `pnpm --filter @armyofagents/ui typecheck` + `pnpm --filter @armyofagents/ui build`.
```
git commit -m "feat(commander): asset/output/memory_item viewer tab bodies (+ GET assets/:id/meta, viewerKind hints) — no more dead-click"
```

---

## Task 4: trust-gate the ref lift to the AoA MCP server (Codex P1.1) + observability (P2.4)

**Files:** `server/src/services/internal-agent/parse-stream-json.ts` (claude lift ~L278), `packages/adapters/codex-local/src/server/parse.ts` (~L197), `packages/adapters/codex-local/src/server/app-server/parse-events.ts` (~L97), `server/src/services/internal-agent/cli-mode.ts` (~L1138), `server/src/services/internal-agent/output-refs.ts` (builder catch ~L126). Tests: `parse-stream-json-refs.test.ts`, codex parse tests.

**Security:** all three lift sites accept an `outputRefs`/mirror envelope from ANY mcp tool result — not just AoA's server. Commander also runs a Playwright MCP (`cli-mode.ts:218`). A non-AoA MCP can inject forged refs + provenance + `action:"created"` → Phase-5 auto-open trusts it. Gate the lift to the AoA server ONLY.

- [ ] **Step 1 — Claude gate.** `parse-stream-json.ts:278` currently lifts when `resolvedName.startsWith("mcp__")`. Narrow to the AoA server prefix specifically (confirm the exact AoA server name — likely `mcp__aoa__…`; read how the AoA MCP server is registered in `cli-mode.ts` to get the canonical prefix). Non-AoA `mcp__*` tools (Playwright, etc.) → do NOT lift. Also switch the whole-array `showRefsSchema.safeParse` to **per-ref** validation (Codex P2.4: today one malformed entry drops all siblings — codex + persistence already validate per-ref; make claude match). Add a regression test: a Playwright-named mcp result with an `outputRefs` envelope → lifted refs = `[]`.
- [ ] **Step 2 — Codex gates.** `parse.ts:197` + `parse-events.ts:97` lift on `mcp_tool_call` without checking `item.server`. Gate to `item.server === "aoa"` (confirm the AoA server id the codex adapter sees). Regression test: non-`aoa` server mcp_tool_call → no refs lifted.
- [ ] **Step 3 — observability (P2.4).** Add a non-fatal debug log at each drop point — `cli-mode.ts:~1138` (silent `.flatMap(→[])`), `parse-stream-json.ts` per-ref drop, and **the builder's own silent catch `output-refs.ts:126`** (returns `[]` on any throw — the bridge's outer error log never sees builder failures). Name the dropped ref's `kind`/`id` + zod issue (or the builder error). Match each file's existing stderr/logger idiom. Do NOT change drop control flow.
- [ ] **Step 4 — verify + commit.** `pnpm --filter @armyofagents/server typecheck` + `pnpm --filter @armyofagents/adapter-codex-local typecheck` + the parse tests + the new injection-regression tests.
```
git commit -m "fix(commander): lift output refs only from the AoA MCP server (block cross-MCP injection) + per-ref claude validation + drop-logging"
```

---

## Task 5: Completion gate

- [ ] **Step 1:** `pnpm -r typecheck` → PASS.
- [ ] **Step 2:** `pnpm test:run` the full internal-agent + viewer surface: `server/src/services/internal-agent/__tests__/output-refs.test.ts server/src/services/internal-agent/__tests__/mcp-bridge-output-refs.test.ts server/src/services/internal-agent/__tests__/mcp-bridge-output-refs-throw.test.ts server/src/services/internal-agent/__tests__/conversation-output-refs.test.ts server/src/services/internal-agent/__tests__/parse-stream-json-refs.test.ts` + the new assets-meta contract test + `ui/src/components/commander/viewer/commanderViewerModel.test.ts ui/src/components/commander/viewer/OutputRefChips.test.tsx ui/src/components/InternalAgentPanel.outputRefs.test.tsx` → PASS.
- [ ] **Step 3:** `pnpm build` → PASS.
- [ ] **Step 4 — emission is now v2:** `git grep -n "v: 1" server/src/services/internal-agent/output-refs.ts` shows NONE in the builder (only the discriminated-union type may reference v:1). The old "emission stays v1" gate is intentionally removed.
- [ ] **Step 5 — no auto-open regression:** confirm `shouldAutoOpen`/`pickAutoOpenRef` still version-agnostic (they read `ref.action` only); Phase-5 tests green.
- [ ] **Step 6 — deferred-freshness baseline (Codex P2.2):** add ONE documented regression test capturing current behavior — a replayed persisted `created` ref (via the `agent-loop.ts:135` reattach path) is still eligible for auto-open (no freshness/provenance gate yet). The test name + comment must say this is the intended baseline for a future replay-gate, so the deferral is explicit and tracked, not forgotten.
- [ ] **Step 7 — injection blocked:** a non-AoA MCP `outputRefs` envelope lifts to `[]` across claude + codex (the Task-4 regression tests) — confirm they run in the gate.

---

## Self-Review / risks

- **seq uniqueness:** the bridge counter is per-subprocess (≈ per-turn). Adequate for ordering hint; resets on restart (acceptable — seq is not a global key). Document it in a comment.
- **provenance:null path:** any Commander run without a conversationId (rare/edge) emits v2 refs with `provenance:null` — fully valid, renders + auto-opens identically. Test it.
- **Double-card coalescing** drops the `v` from `refKey` — verify no consumer relied on v-in-key (grep `refKey`). The Phase-2 addition of `v` was over-cautious; same `(kind,id,versionId)` IS the same artifact.
- **Tab bodies** must not crash on a deleted/inaccessible entity — the `useQuery` error state should show a friendly "not available" (mirror how `DiscussionRefTabBody` handles a 404), not a white screen.
- Biggest task is 3 (new route + 3 bodies + union widening). Land it last before the gate.

---

## Execution Handoff

**Subagent-driven**, spec + code-quality review per task (Task 3 especially — new route auth + tab-body error states). `pnpm -r typecheck` + the internal-agent/viewer suites + `pnpm build` gate it; no running app required (live dogfood happens in the Phase-7 → final test).
