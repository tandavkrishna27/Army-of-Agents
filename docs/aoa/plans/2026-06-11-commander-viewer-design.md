# Commander Content Viewer — Phase 1 Design (v2)

**Date:** 2026-06-11 (v2 — post cross-review amendment, same day)
**Branch:** `feat/v1-commander-chat` (worktree `AoA-commander`, base `feat/v1-combined` @ `469ea6e44`)
**Status:** Approved design, pre-implementation. v1 was reviewed by Claude (Fable 5) + Codex cross-review; all findings verified against code and folded in (see §11).

---

## 1. Purpose

Integrate the shared content viewer (already used by Workspace, Memory, and Discussions) into the Commander chat page, so a founder can **see** the work products Commander creates or references — without leaving the conversation.

Today, Commander tool results are reduced to a name + status in the UI; structured results (including artifact IDs from `create_artifact`) are discarded, unpersisted, and unrenderable. The viewer component stack is ready; Commander simply has no content source feeding it. This design adds that source (persisted **output refs**), the UI handles (**chips**), and the rendering surface (**viewer panel**).

Vocabulary: **chip** (clickable handle under a Commander reply) → opens a **tab** (rendered document in the right-side panel) → panel collapses to a **rail/strip** (thin right-edge tab rail).

## 2. Locked product decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Phase 1 scope | Viewer panel + artifact chips (persisted tool-result refs) + home tab + "open reply in viewer" pop-out. `get_task` artifact chips included. |
| 2 | Auto-open | Panel **always auto-expands** when a `created` ref arrives (desktop). No exceptions for user-collapsed state. |
| 3 | Layout | Collapsible right panel with **always-visible thin rail** (~28px: ⌂ + open-tab icons + chevron). Expanded default ~40% width, **drag-to-resize** (min 320px, max 60%); width persists for the page session only. Discussions (`ThreadViewer`) pattern. |
| 4 | Tab memory | Per-conversation while the page is open (switching chats restores that chat's tabs). Hard reload starts clean. No storage. |
| 5 | Home tab (⌂) | Two groups: **"Recent from this conversation"** (refs aggregated from currently loaded messages — last history page; honest about pagination) above **"Recent in company"** (existing REST `GET /companies/:companyId/artifacts`, verified `server/src/routes/artifacts.ts:21`). Capital-D Documents system excluded until P2. |
| 6 | Mobile (<1024px) | Panel is a full-screen Sheet; rail becomes a floating tab pill. Exception to #2: creation **badges/pulses the pill** — never auto-opens the sheet. |
| 7 | Persistence approach | **JSON `outputRefs` column on `internal_agent_messages`** + enriched SSE. No refs table (promotion path documented in §10). |
| 8 | Host gating | Commander page only. `AgentPanelContent` gains `enableViewerPanel` prop; only `Commander.tsx` passes `true`. The unused `w-80` docked `InternalAgentPanel` variant stays viewer-free. |
| 9 | New tool (v2) | Add **`query_company_artifacts`** — Commander currently has no company-wide artifact listing (`query_artifacts` is thread-scoped, `artifact-query.ts:22-31`). Without it, "what artifacts do we have?" conversations can't chip. |
| 10 | Provider coverage (v2) | **All CLI providers get chips in P1.** Refs travel inside the MCP result envelope (§3c); both stdout parsers (claude stream-json + codex JSONL) lift them. Without the codex parser change, codex/opencode runs would get no chips at all — not even on reload. |
| 11 | Bug fix in scope (v2) | Fix the **existing tool-status bug**: claude parser emits `tool_result.name = tool_use_id`, the UI matches by tool *name* (`InternalAgentPanel.tsx:626-644`), so spinners never settle until `done`. The same `tool_use_id → name` correlation map refs need also fixes this. |

## 3. Backend design

### Execution-model reality (what v1 got wrong)

API-mode execution was removed (Decision #91): **every Commander turn routes through `cliModeService`** (`agent-loop.ts:78-81`), which spawns a CLI subprocess plus the **MCP bridge as a separate OS process** (`cli-mode.ts:135-170`; session context passed via env). All tools execute inside the bridge process via the shared `executeTool` (`tool-registry.ts:264`, called from `mcp-bridge.ts:49`). The server process only ever sees tool activity through the subprocess's stdout, parsed by:

- **claude:** `parse-stream-json.ts` — `tool_call` chunks carry the real `{id, name, input}` (`:187`); `tool_result` chunks carry `name = tool_use_id` and `result.data` = the bridge's JSON envelope as a string (`:256-267`).
- **codex/opencode:** `packages/adapters/codex-local/src/server/parse.ts` — tool results are inspected only for confirm markers (`:145-148`) and otherwise dropped.

Therefore refs cannot be computed in agent-loop (it forwards chunks unchanged, `:291-294`) and cannot use in-process accumulators (process boundary). They must **ride the data that already crosses the boundary**: the MCP result envelope.

### 3a. `CommanderOutputRef` (type + zod schema in `packages/shared/src/`)

```ts
interface CommanderOutputRef {
  v: 1;                              // ref schema version
  kind: "artifact";                  // P1. P2 extends: "asset" | "task" | "thread" | "file" | "document"
  id: string;                        // artifactId
  versionId?: string | null;
  versionNumber?: number | null;     // chip "v2" badge (when known)
  title?: string | null;             // chip label (when known); fallback: "<kind> <short-id>"
  action: "created" | "referenced";  // created → auto-open; referenced → click-only
  toolCallId?: string | null;
  mimeType?: string | null;          // viewer-resolution hint only — viewer still fetches artifact/version
}
```

Rules: **max 20 refs/message** (`created` survives trimming first); dedupe by `(kind, id, versionId)` with `created` winning. `title`/`versionNumber` are best-effort — chips fall back to kind + short id; the viewer resolves real display names at open time (it fetches the artifact anyway, as `ThreadViewer` does). Refs carry IDs + labels only — never content. Title strings capped at 200 chars; id/versionId/toolCallId/mimeType capped at 256.

The zod schema (`commanderOutputRefSchema`) lives beside the type in `packages/shared` and is the single validator used at the persistence boundary.

### 3b. Ref-builder (new file `server/src/services/internal-agent/output-refs.ts`)

`buildOutputRefs(toolName: string, params: unknown, result: ToolResult): CommanderOutputRef[]` — pure, no DB. **Params are part of the signature** because several tools return IDs only while their params carry the title (all verified):

| Tool | data provides | params provide | Ref |
|------|---------------|----------------|-----|
| `create_artifact` | `artifactId`, `versionId` (`create-artifact-tool.ts:87-91`) | `title` (required), `type` | `created` |
| `create_artifact_version` | `versionId`, `versionNumber` (`artifact-create-version.ts:92`) | `artifactId` (required) | `created` |
| `attach_task_artifact` | artifact/version ids per its return | `title` (required), `type` | `created` |
| `query_artifacts` | rows `{artifactId, title, type, currentVersionId, status}` (`artifact-query.ts:47-53`) — map `currentVersionId → versionId` | — | `referenced` per row |
| `query_company_artifacts` (new, §3f) | rows shaped like `query_artifacts` | — | `referenced` per row |
| `get_task` | `artifactId` iff non-null (`get-task-tool.ts:81`) | — | `referenced`; title = task title fallback |
| anything else | — | — | `[]` |

Defensive: malformed `params`/`data` → skip ref, never throw. `read_file` stays excluded (P2 `file` kind).

### 3c. Ref transport — the envelope path (replaces v1 §3c)

1. **Bridge (origin):** `executeAndFormat` (`mcp-bridge.ts:43-63`) already returns `JSON.stringify({success, data, summary, error?})` to the subprocess. It additionally calls `buildOutputRefs(tool.name, args, result)` and, when non-empty, includes `outputRefs` in that envelope. (Bridge and server share the builder via normal `server/src` imports; the bridge entrypoint is spawned from the same package.)
2. **Parsers (lift):**
   - *claude* (`parse-stream-json.ts`): maintain a `tool_use_id → toolName` map from `tool_use` blocks (`:180-188`). In the `tool_result` branch (`:250-267`): set `chunk.name` to the **real tool name** via the map (= the §2#11 bug fix), `try`-parse `fullText` as JSON, lift `outputRefs` (lenient — absent/unparseable ⇒ none), attach to the chunk. **Revision (T4 review):** the lift is gated to `mcp__`-prefixed tool names — built-in tools (Bash/Read) must never be interpreted as envelopes.
   - *codex* (`packages/adapters/codex-local/src/server/parse.ts:145-148`): in the existing `tool_result`/`mcp_tool_call` branch, also `try`-parse the item's result text, lift `outputRefs`, and emit a `tool_result` chunk carrying `{name, refs}` (today this branch emits only confirm chunks). **Revision (T5 review):** the lift is gated to `mcp_tool_call` items only (built-ins arrive as `tool_result` items); screen also enforces int-positive versionNumber, id ≤ 256, cap 20.
3. **Agent-loop (accumulate + persist):** while forwarding chunks (`agent-loop.ts:291-294`), collect refs off `tool_result` chunks; apply dedupe + cap across the turn; pass to `appendMessage` with the assistant message (`:302-305`).
4. **Route (SSE):** forward `{ name, refs? }` in the existing `tool_result` event (`routes/internal-agent.ts:248-250`). `refs` omitted when empty — backward compatible, no new event type. Client auto-open trigger: live ref with `action === "created"`.

One data path, all providers, no IPC, no shared memory, no new event types.

### 3d. Persistence path

- Schema: add `outputRefs: jsonb("output_refs")` to `internalAgentMessages` (`packages/db/src/schema/internal_agent.ts:191-204`), beside `toolCalls`/`toolResults`. `pnpm db:generate` (Drizzle only). Additive + nullable = safe.
- Service: `MessageInput` (`conversation.ts:8-17`) gains `outputRefs?: unknown`; `appendMessage` (`conversation.ts:46-59`) validates via `commanderOutputRefSchema` (invalid refs dropped, message always saves) and inserts the column.
- Write site: the assistant persist in `agent-loop.ts:302-305` passes the turn's accumulated refs.
- Read: the conversation messages endpoint (`routes/internal-agent.ts:622-671`, default 50 / max 200) includes `outputRefs` in its projection; client `AgentMessage` (`ui/src/api/internal-agent.ts:23`) gains `outputRefs`.

Not touched: the existing-but-unwritten `toolResults` column; no new tables; no new endpoints.

### 3e. Why a JSON column, not a refs table (unchanged rationale)

- Refs are **presentation anchors** — read with their message, never queried across conversations in P1.
- Entities and audit live in the right layers already: `artifacts`/`artifact_versions` (normalized, immutable, source-attributed) and `activity_log`/`internal_agent_runs` (audit). A refs table would duplicate audit duty.
- Repo pattern: `internal_agent_messages` already carries jsonb (`toolCalls`).
- Owner-scoped conversations give multi-user isolation for free; hard-delete cascades for free.
- Summarization never deletes message rows (`conversation.ts:154` writes `summarizedContext` on the conversation).
- Promotion path if P2 needs indexed ref queries: backfill scan, zero data loss.

### 3f. New tool: `query_company_artifacts` (v2)

Read-only query tool (category `query`, `requiredRole: "team_member"`, no confirmation), mirroring the REST list route's behavior: company-scoped via `ctx.companyId`, optional `type`/`status` filters, `limit` default 20 / max 50, ordered by `updatedAt` desc. Returns rows `{artifactId, title, type, currentVersionId, status, updatedAt}` — same shape family as `query_artifacts` so the ref-builder mapping is shared. Registered alongside existing artifact tools in the tool registry.

## 4. Frontend design

### 4a. New components (`ui/src/components/commander/viewer/`)

| File | Job |
|------|-----|
| `CommanderViewerPanel.tsx` | Right-edge shell: collapsed rail ⇄ expanded resizable panel; hosts tab bar + active tab body. Width persists for the page session only. |
| `CommanderViewerHome.tsx` | ⌂ tab: "Recent from this conversation" (refs from currently loaded messages) + "Recent in company" (REST artifacts list). |
| `OutputRefChips.tsx` | Chip row under assistant bubbles: type icon + title (fallback: kind + short id) + version badge; `created` gets accent treatment. Click → focus existing tab or open new. |
| `useCommanderViewer.ts` | State hook: `Map<conversationId, TabState>`, expand/collapse, active tab, `openRef()`. Pure logic exported for unit tests (pattern: `commanderInputModel.ts`). |

Rendering reuses the existing viewer stack unchanged: `ViewerTabs` + `SharedContentViewer` + `resolveViewer`. Artifact tabs fetch the artifact + version via the existing artifacts API and feed `inlineTextContent` (or asset URL) — `ThreadViewer.tsx:531-535` pattern. The ref's `mimeType` is a hint only; the fetch is the source of truth.

### 4b. Integration (`InternalAgentPanel.tsx` + `Commander.tsx`)

- `AgentPanelContent` gains `enableViewerPanel?: boolean`; chat column + viewer panel wrap in a flex row.
- **Live:** SSE `tool_result.refs` accumulate onto the streaming message's local state → chips render immediately → every `created` ref auto-expands the panel (if collapsed) and focuses its tab. The done-state handler (`:626-644`) now works because `name` is the real tool name (§2#11).
- **History:** `outputRefs` must survive **both** mapping paths (verified they drop unknown fields today): `serverToLocal` (`:239-247`) and the history-load mapping (`:423-431`); `LocalMessage` gains `outputRefs`.
- Reply pop-out: hover affordance on assistant bubbles ("⧉ Open in viewer") opens a markdown tab with the message text as `inlineTextContent`. Client-only.
- `Commander.tsx` passes `enableViewerPanel` (one-line change).

### 4c. Required states

- Tab loading skeleton; unavailable state (deleted artifact or 403 → one "no longer available" message + retry); home tab empty state; panel expansion respects existing `shouldAutoScroll`.

## 5. Multi-user & RBAC model

- **Zero new authorization surface.** Refs are pointers, not capability grants. Content loads through existing artifact/asset endpoints, which authorize the requester at fetch time. (The new `query_company_artifacts` tool enforces `ctx.companyId` scoping exactly like its siblings.)
- Refs are born under the requester's authority — the bridge receives the session's company/user/role/capabilities via env (`cli-mode.ts:147-152`) and `executeTool` gates on them.
- Isolation by construction: refs ride owner-scoped conversations/messages. SSE refs go only to the requesting user's stream.
- Rendering safety inherited: chip titles are escaped React text (and capped at 200 chars in the builder); html/svg render inside `SharedContentViewer`'s sandboxed iframes.

## 6. Failure behavior

Prime directive: **chips must never break chat.**

- Builder: malformed params/data → skip ref, log, never throw. Envelope assembly wraps ref-building in try/catch — a ref bug cannot fail a tool call.
- Parsers lift refs leniently: absent/unparseable → no refs, chunk otherwise unchanged.
- `appendMessage` zod-validates **per ref**; invalid refs are dropped individually, the message always saves.
- Client ignores unknown `kind`/`v` values (P2 forward-compat). Version-skew (old server/new client or reverse): chips simply don't appear.

## 7. Testing

- **Server pure:** `output-refs.test.ts` — per-tool mapping incl. params-sourced fields (`title` from `create_artifact` params, `artifactId` from `create_artifact_version` params, `currentVersionId → versionId` rename), dedupe precedence, 20-cap, malformed tolerance.
- **Parser tests:** claude — correlation map fixes `tool_result.name` (done-state fix) + refs lift from envelope; codex — refs lift from `tool_result`/`mcp_tool_call` items emits chunks.
- **Bridge:** `executeAndFormat` includes `outputRefs` in the envelope; ref-build failure doesn't fail the tool call.
- **Server contract:** SSE `tool_result` `{name, refs?}`; `appendMessage` validates + persists `outputRefs`; `query_company_artifacts` company-scoping + filters.
- **UI pure:** `commanderViewerModel.test.ts` — tab reducer, auto-open predicate (created × desktop vs mobile-badge), streaming ref accumulation.
- **UI component:** `OutputRefChips` render/click (incl. title-fallback); collapsed-rail render; history mappings carry `outputRefs`.
- **Automated E2E (added post-review, user decision):** Playwright spec driving the real UI — chatting with Commander via the composer, asserting the full interaction loop (chips, auto-open, collapse/rail, reload persistence, referenced-no-auto-open, home tab groups, reply pop-out, mobile pill, spinner settle). Deterministic: the `claude` binary resolves (via PATH) to a scripted fake replaying canned stream-json whose tool_result content mirrors the real bridge envelope and refs point at a REST-seeded artifact — production paths everywhere except the LLM and the MCP bridge process (bridge covered by unit tests). Runs on Linux CI; Windows e2e remains config-skipped per repo status.

## 8. Change inventory

| Layer | Changes |
|-------|---------|
| `packages/shared` | + `CommanderOutputRef` type + `commanderOutputRefSchema` (zod) |
| `packages/db` | + `outputRefs` jsonb on `internalAgentMessages`; `pnpm db:generate` migration |
| `packages/adapters/codex-local` | `src/server/parse.ts` — lift refs from tool result items, emit `tool_result` chunks |
| `server` | + `services/internal-agent/output-refs.ts` (builder); + `tools/artifact-query-company.ts` (new tool, §3f) + registry registration; `mcp-bridge.ts` (envelope gains `outputRefs`); `parse-stream-json.ts` (correlation map + refs lift); `agent-loop.ts` (accumulate refs → persist); `conversation.ts` (`MessageInput.outputRefs` + validated insert); `routes/internal-agent.ts` (SSE `{name, refs?}` + messages projection) |
| `ui` | + 4 files under `components/commander/viewer/`; `InternalAgentPanel.tsx` (prop-gated row layout, chips, SSE accumulation incl. fixed done-state, auto-open, pop-out, both history mappings); `Commander.tsx` (prop); `api/internal-agent.ts` (types) |

No feature flag — additive everywhere; ship direct.

## 9. Out of scope for Phase 1

- Editing inside the viewer (artifact versions are immutable; iteration happens through Commander → new version).
- Inline thumbnails/previews inside chat bubbles.
- `read_file` refs, task/memory/thread attachment refs, `task_outputs` index refs.
- Capital-D Documents system anywhere (chips or home tab).
- True canvas-style streaming of replies.
- Live-LLM E2E (a key-gated real `claude_cli` round trip) — the deterministic fake-CLI E2E IS in scope (§7); only the live variant stays a follow-up.

## 10. Phase 2 roadmap (recorded, not designed)

- New ref kinds: `asset`, `task`, `thread`, `file`, `document`.
- Thread tools return attachment refs → "pull a discussion and see its attachments" becomes fully seamless.
- `get_task`/task tools surface `task_outputs` (files, preview URLs, PRs).
- Memory assets; Documents in home tab; canvas streaming.
- Refs-table promotion (backfill from JSON) only if backlink-style queries materialize as a product surface.
- Forward the tool_use `id` in `tool_call`/`tool_result` SSE events so the UI can correlate exactly (eliminates the parallel same-name settle quirk; T4 review recommendation).

## 11. Review log (v1 → v2)

v1 was cross-reviewed (Claude Fable 5 + OpenAI Codex, independent passes; ~75% finding overlap, zero contradictions), then every finding was verified against source. Key corrections folded into v2:

1. v1 hooked ref-building in an execution path that no longer exists (API mode removed, Decision #91) → §3c rewritten around the MCP bridge envelope + stdout parsers.
2. The MCP bridge is a separate OS process → in-memory accumulators impossible; refs ride the result envelope.
3. Codex/opencode parsers dropped tool results entirely → parser extension in scope (Decision #10).
4. Ref-builder field mismatches per tool → params-aware builder signature; per-tool table corrected with verified field names.
5. Claude parser emits `tool_use_id` as `tool_result.name` → correlation map; fixes a live UI spinner bug (Decision #11).
6. `MessageInput`/`appendMessage`/`serverToLocal`/history-mapping all drop unknown fields → each named explicitly in §3d/§4b.
7. `query_artifacts` is thread-scoped → new `query_company_artifacts` tool (Decision #9, §3f).
8. Home tab group renamed "Recent from this conversation" (pagination-honest).
