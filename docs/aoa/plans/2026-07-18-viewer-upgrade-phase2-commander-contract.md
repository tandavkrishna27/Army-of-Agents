# Viewer Upgrade — Phase 2: Commander Accepts + Renders ShowRef v2 — Scope (corrected)

> **Status:** Scoped + Codex-reviewed, **not yet executed.** This is the corrected scope after two Codex passes revealed the v2 work is a single coupled unit. Full task-by-task TDD steps are generated at execution time (subagent-driven).

**Goal:** Make Commander **accept and render** v2 `ShowRef`s end-to-end. Commander still **emits only v1 `artifact`** refs (v2 emission with provenance is Phase 3). This is the smallest *safe* v2 slice: accepting v2 without rendering it is unsafe (the UI would mis-render a v2 ref as a broken artifact tab), so accept + render must land together.

**Why it's one unit (confirmed against HEAD a490fc57d):**
- `cli-mode.ts:1131` yields codex `CodexParsedChunk` straight through as `AgentStreamChunk` (`yield chunk`). Widening the codex `LiftedOutputRef` mirror alone breaks this assignment — the mirror cannot ship independently.
- `commanderViewerModel.openRefTab` (L48) hardcodes `kind:"artifact"`. If the accept-side validators widen to v2 without UI routing, a v2 ref (from a third-party MCP tool envelope or pre-seeded data) persists → replays → mis-renders. So UI routing must land with acceptance.
- Good news: the by-kind routing already exists in `openInputRefTab` (task→`openTaskTab`, discussion/approval tabs exist), so rendering v2 is *reuse*, not new viewers.

## Scope

**In:** accept + carry + persist + render v2 across the Commander pipeline. **Out (Phase 3):** v2 *emission* (new kinds + provenance in `buildOutputRefs`, needs conversation/run context threaded through the MCP bridge); Discussions/Workspace delivery channels + tab bodies; TTL; Tier 3.

## Touch-points + Codex fixes baked in

1. **Codex mirror** `packages/adapters/codex-local/src/server/parse-shared.ts` — widen `LiftedOutputRef` + `liftOutputRefs` to v2. **Fixes:** v1 lifted refs stay **byte-identical** to today (do NOT add `viewerKind`/`provenance` keys to v1 — build v1/v2 conditionally); `action` required for both; v1 id-cap 256 / v2 id-cap 2048; **if `provenance` is present but malformed, REJECT the ref** (`continue`) — never null-normalize it; absent provenance → `null` (v2 optional). Test import uses `../parse-shared.js` (NodeNext). Tests: v1 deep-equality (9 fields, no v2 keys), v2 deep-equality incl. provenance, reject unknown-kind / missing-action / present-but-malformed-provenance. Parity test: `src/server/__tests__/appserver-parse-events.test.ts`. Filter: `@armyofagents/adapter-codex-local`.
2. **cli-mode boundary** `server/src/services/internal-agent/cli-mode.ts:1131` — the codex→pipeline seam. After widening, `LiftedOutputRef` (`v:1|2`) is not assignable to the `ShowRef` union. Re-validate the chunk's refs **per-ref via `showRefSchema`** (NOT `showRefsSchema.safeParse` on the array — it's all-or-nothing; validate each, keep successes) so the yielded chunk carries a proper `ShowRef[]`. Add a codex v2-handoff test.
3. **Pipeline types → `ShowRef[]`** — `output-refs.ts` (`artifactRef`/`refsFromRows`/`buildOutputRefs`/`collectChunkRefs`/`mergeOutputRefs`/`refKey`), `agent-loop.ts` (`AgentStreamChunk.refs` L55, `turnRefs` L529, replay L123/L138), **`mcp-bridge.ts:94-96`** (Codex-caught miss — also declares `CommanderOutputRef[]`). `buildOutputRefs` **body unchanged** (still builds v1 artifact). `mergeOutputRefs` compiles on the union (both members have `kind`/`id`/`versionId?`/`title?`/required `action`); **add `v` to `refKey`** and define provenance-precedence on merge (most-recent wins) + test.
4. **Accept-side validators** — `parse-stream-json.ts:281` `commanderOutputRefsSchema` → `showRefsSchema`; `conversation.ts:82` `commanderOutputRefSchema` → `showRefSchema`. (`showRefSchema` already accepts the exact v1 shape — existing v1 tests stay green.)
5. **UI render routing** — `commanderViewerModel.openRefTab` switches on `ref.kind` and dispatches to the existing constructors (artifact→`openRefTab`/artifact tab, task→`openTaskTab`, discussion/approval→their tab bodies), instead of hardcoding `kind:"artifact"`. Widen the UI ref type (`CommanderOutputRef` → `ShowRef`) where `onLiveRef`/`openRefTab` flow (`InternalAgentPanel.tsx`). Reuse the `openInputRefTab` kind-dispatch pattern (L78+).
6. **Emission stays v1** — `buildOutputRefs` unchanged; a gate test greps that no `v: 2` / non-artifact kind is emitted.

## Tests (Codex-required)
Mirror v1/v2 deep-equality + reject cases; cli-mode v2 handoff; `parse-stream-json-refs.test.ts` v2 lift case; `conversation-output-refs.test.ts` v2 persist case; `output-refs` v2 collect/merge/provenance-precedence; UI `commanderViewerModel` v2-kind routing; the emission-stays-v1 gate. Gate runs **full `pnpm test:run`** + `pnpm build` + `pnpm -r typecheck` (the server typecheck is the hard consistency gate). Note: `pnpm test:run server/src/services/internal-agent` does NOT cover `server/src/__tests__/` agent-loop/codex integration tests — run the full suite.

## Backward-compat invariant
Every existing persisted v1 `output_refs` row validates + renders; `buildOutputRefs` output byte-shape unchanged; version-pinned tabs/chips/Viewer Home/Cockpit zone unaffected.

## Execution note
Land as: (Task 1) mirror + tests; (Task 2) the cohesive server widening — pipeline types + mcp-bridge + cli-mode boundary + validator swaps + server tests (must compile together, `pnpm --filter @armyofagents/server typecheck` is its gate); (Task 3) UI routing + tests; (Task 4) full gate. Subagent-driven, spec + code-quality review per task.
