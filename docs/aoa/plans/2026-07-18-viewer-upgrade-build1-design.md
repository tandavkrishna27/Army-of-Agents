# Viewer Upgrade — Build 1 (A / D / E) Design Spec

**Status:** Draft for founder review — revised after Codex independent review (2026-07-18)
**Date:** 2026-07-18
**Baseline audited:** `origin/main` at `a490fc57d` (PR #291 + #292 merged)
**Scope type:** Design specification; feeds an implementation plan
**Master scope:** [Viewer Upgrade — Master Scope](./2026-07-18-viewer-upgrade-master-scope.md)
**Surfaces:** Commander, Discussions, Workspace, Memory (agent-drive on the first three; Memory re-evaluated per §11)

> **Revision note.** A Codex review found the first draft treated cross-surface delivery as "add a callback," under-specified the ref contract, dropped `versionId`, and mis-phased (cards before a data source; URL hardening as a no-op). This revision locks the versioned contract, makes delivery a first-class per-surface channel, treats TTL as its own slice, splits URL hardening into a security slice, and reorders the phases. Items still requiring code confirmation are marked **[investigate]** and are resolved by the Phase-0 sub-agent investigation before the implementation plan is finalized.

---

## 1. Outcome

One coherent viewer experience across all four surfaces, plus agents that can drive it — **without regressing** any existing viewer, and **without breaking** persisted Commander refs.

- Content appears in threads as a **hybrid adaptive card** (inline-expand small / pop-to-panel large), with a defined loading/error state.
- **Discussions** thread bubbles render markdown (plain text today). Workspace timeline **already** renders GFM markdown — verify, do not rebuild.
- A single **versioned, backward-compatible `ShowRef`** contract lets an agent say "show this," carried by a real **per-surface delivery channel** (persist + live-deliver + replay + authorize), resolved by an **async, controller-level `openRef()` adapter** per surface.
- Agents can **show their own output** (persisted, then TTL-ephemeral as a separate slice) and **navigate you to existing entities** (task/discussion/approval/memory/URL), governed by a **`viewerControl`** setting with a company ceiling + per-user override, with **focus arbitration** for concurrent refs.
- URL opening is **scheme-safe across every browser constructor and iframe**, from one isomorphic validator.

## 2. Scope boundaries

### In scope
- Versioned `ShowRef` contract (backward-compatible with `CommanderOutputRef`) + validators + Codex-local mirror.
- Per-surface **delivery channel** (persist + live + replay + authz) for Discussions and Workspace; Commander reuses its existing SSE ref path.
- Per-surface async `openRef()` adapters + an explicit **mapping matrix** (§4).
- New tab bodies where a surface lacks them (see §4 — these are real work, not mappings).
- Markdown rendering in **Discussions** thread bubbles (Workspace already has it).
- Hybrid adaptive card (metadata-driven size decision, loading/error states).
- Agent-drive: Tier 2 (own persisted output) + Tier 3 (navigational) across Commander + Discussions + Workspace, with focus arbitration.
- `viewerControl` schema (company + per-user + guardrail), server-side resolver, validators, Settings UI.
- URL scheme-safety **security slice** across all constructors + the dev-server iframe.
- TTL-ephemeral artifacts as a **separate lifecycle slice** (§3.7).
- Regression protection for the four viewer models + the hub browser + persisted refs.

### Out of scope (later builds / master scope)
- In-place editing (Build 2 / B). Office & Google (Build 3 / C). True never-persisted transport. Agent-controlled *live* browsing. Re-homing the attachment/asset pipeline (reused from the composer).

## 3. Architecture

### 3.1 The versioned `ShowRef` contract (extends, does not replace)

`ShowRef` is a **superset** of the existing `CommanderOutputRef` (`packages/shared/src/commander-output-refs.ts`). Legacy `v:1` refs (kind `"artifact"`, no provenance) MUST continue to validate and render unchanged.

```ts
// packages/shared/src/viewer-show-ref.ts (new; re-exports/extends commander-output-refs)
type ShowRefKind =
  | "artifact" | "asset" | "output"          // content, SharedContentViewer-backed
  | "task"                                     // entity, embed
  | "discussion" | "approval" | "memory_item" // entity, navigational
  | "url";                                     // navigational, scheme-gated

type ShowRef = {
  v: 2;                          // loader accepts v:1 (legacy artifact-only) AND v:2
  kind: ShowRefKind;
  id: string;                    // entity id; for "url", the target URL
  versionId?: string;            // PRESERVED — required for version-pinned artifact viewing
  versionNumber?: number;        // PRESERVED
  title?: string;                // PRESERVED; display label derives from title (label is NOT required)
  mimeType?: string;             // PRESERVED — lets resolveViewer skip a metadata round-trip
  viewerKind?: string;           // hint; STORED IN TAB STATE (and allowed on artifact-version metadata)
  action?: "created" | "referenced";
  toolCallId?: string;
  provenance?: {                 // REQUIRED for durable/replayed delivery + auto-open correctness
    agentId?: string;
    surface: "commander" | "discussion" | "workspace";
    entityId: string;            // conversation / discussion / task id the ref belongs to
    runId?: string;
    messageId?: string;
    seq: number;                 // ordering + dedupe key
    emittedAt: string;           // ISO
  };
};
```

Contract rules:
- **Backward compatibility:** the loader validates `v:1` (existing shape) and `v:2`. No existing persisted `output_refs` row may fail validation or lose semantics. Explicit compat tests (§6).
- **`versionId`/`versionNumber` preserved** — version-pinned tabs keep working (`commanderViewerModel.ts`, `CommanderViewerPanel.tsx` version selection).
- **`viewerKind` is stored in tab state** (and may also be persisted on the artifact version metadata). It is NOT a transient that vanishes after `openRef`. It feeds `resolveViewer`'s existing `metadata.viewerKind` safelist at render.
- **`reply` is NOT a ShowRef kind.** It stays a Commander-local, in-memory presentation (`reply` tab), out of the durable cross-surface contract. This resolves the Memory/reply inconsistency.
- **Provenance is required for anything auto-openable.** `action:"created"` alone is insufficient across durable/replayed events — provenance (`agentId`, `surface`, `entityId`, `seq`, `emittedAt`) is what lets the client decide "own fresh output, right surface, not a stale replay."
- **Dedupe/ordering** by `(surface, entityId, seq)`. Per-message cap stays 20; see focus arbitration (§3.8).
- Any kind addition is mirrored in the codex-local `LiftedOutputRef` (`packages/adapters/codex-local/src/server/parse.ts`).

### 3.2 Rendering inputs per kind (an id is not enough)

| Kind | What the ref carries | What the adapter fetches | Notes |
|---|---|---|---|
| artifact | id + versionId + mimeType? | artifact/version via `artifactsApi.get` | version-pinned; existing path |
| asset | id + mimeType? + filename? | asset **metadata** (filename/contentType/size) | Confirmed: the general `assets` table has **no** metadata-by-id route (only `GET /assets/:id/content` streams bytes). **Add `GET /assets/:id/meta`** returning `{assetId, contentType, originalFilename, byteSize, sha256}` (thin read over existing columns, mirroring the `/content` guard; precedent = `GET …/memory/assets/:id`) + `assetsApi.getMeta` client fn. |
| output | task_output id | task output via existing API | maps to SharedContentViewer |
| task | task id | `TaskDetail` (access-checked) | full embed exists; new tab body on Thread/Workspace (§4) |
| discussion | discussion id | discussion via `discussionsApi.get` | Commander embeds full `ThreadDetail`; Thread/Workspace need a body (§4) |
| approval | approval id | `ApprovalDetailCore` | new tab body on Thread/Workspace (§4) |
| memory_item | memory id | memory item (view-only) | never routes through the editors or DOCX short-circuit |
| url | the URL | none | scheme-gated (§3.9); confirmation for agent refs |

### 3.3 Per-surface async `openRef()` adapter (controller-level)

`openRef` is **not** a pure `(state, ref) => state` reducer. Navigational kinds require effects (confirmation prompts, hydration fetches), and Workspace tabs hold fully-hydrated objects. Signature:

```ts
// per surface, controller-level
async function openRef(ref: ShowRef): Promise<void>
// hydrate as needed → run effects (confirm/authz) → then reduce into THIS surface's tab state
```

- **Commander** — extend `openInputRefTab`/`openRefTab` to switch on `ref.kind`; preserve `useCommanderViewer.readState()` at-call-time reads, keyed remounts, and version selection.
- **Thread (Discussions)** — map `ShowRef` → `ThreadOpenRequest`; respect embed-delegation (`ThreadDetail.onOpenRequest` forwards upward when hosted in a hub).
- **Workspace** — map `ShowRef` → `WorkspacePreviewTab` via `WorkspaceLayout.openPreviewTab`; never touch legacy `activeMode`, changes/file/logs.
- **Memory** — content kinds only; never the editors/DOCX short-circuit; preserve composite `{id,kind}` key.

**Invariant:** an adapter only opens safe kinds. Bespoke tabs (Memory DOCX, memory editors, scope-item workbenches, changes/file/logs, graph) are unreachable via `ShowRef`.

### 3.4 The mapping matrix (locks "navigational" vs "embed" per surface)

For each surface × kind: **E** = embed tab (exists) · **N** = new tab body to build · **R** = route-navigate (leave surface) · **C** = card-only · **X** = rejected/not-a-target.

Confirmed against code (investigation, HEAD a490fc57d):

| Kind | Commander | Discussions | Workspace | Memory |
|---|---|---|---|---|
| artifact | E | E | E | X |
| asset | **N** | E | **N** | E |
| output/task_output | **N** | E (`task_output`) | E (detected-output; `task_output` **N**) | X |
| task | E | E | **N** | X |
| discussion | E (full embed) | self (n/a) | **N** or R | X |
| approval | E | **N** | **N** | X |
| memory_item | **N** (view) | E (`memory`) | **N** (view) | E |
| url | E | E | E | X |

**N cells are the real Build-1 tab-body work.** The investigation corrected the draft: **Discussions is cheaper than assumed** (it already has asset/`task_output`/`memory`/task bodies — only `approval` is new), and **Workspace is the concentration of new work** (it has artifact/browser/output-detected only; task/asset/discussion/approval/memory are all new). Commander needs asset/output/memory_item bodies. This supersedes the earlier "reuse existing embeds everywhere" claim.

### 3.5 Cross-surface delivery channel (the real cost)

Commander refs ride `tool_result` events in the Commander SSE (works today). Discussions and Workspace have **no equivalent** — they use thread entries / live-events / refetch and comments / heartbeat runs respectively. Each needs a delivery channel meeting this contract:

- **Persist** the ref durably, tied to its `provenance.entityId` (so reload/replay works).
- **Live-deliver** via the surface's existing realtime path (thread live-events; workspace runtime channel).
- **Replay** on load from persistence, ordered by `seq`, deduped.
- **Authorize** every delivered ref against the viewing user (self-securing entity kinds still re-fetch access-checked).
- **Idempotent** on `(surface, entityId, seq)`.

**Storage + realtime (confirmed by investigation — locked):**
- **Discussions (smallest change):** add a `discussion_entries.output_refs jsonb` column (mirrors `internal_agent_messages.output_refs`). Live delivery reuses the existing **`thread.entry.created` poke → react-query refetch** — the ref arrives on the entry via the REST refetch; no socket payload change. Envelope-RBAC (`canViewThread`, `live-events-ws.ts`) already scopes delivery per-thread, so this surface is the strongest for privacy. Net-new = 1 column + serializer + renderer.
- **Workspace:** reuse **`task_outputs`** (already models `artifactId`/`assetId`/`url`/`title`/`metadata`, issue-scoped, `createdByAgentId`) for product refs, and **`issue_comments.metadata`** for inline-in-timeline refs. Comment-attached refs ride the existing **`activity.logged` / `issue.comment_added`** poke for free; a `task_outputs` insert needs **one new company-broadcast poke `task.output.created {companyId, issueId, outputId}`** — the only net-new realtime primitive in the whole build.
- **Commander:** unchanged path (rides `tool_result` SSE); only the contract migrates to v:2.
- **Authorization asymmetry (design-critical):** artifact/task/approval fetch routes gate at **company** granularity (`assertCompanyAccess`); discussions gate at **per-thread** visibility (`canViewThread`). A ShowRef pointing at an artifact created inside a **private thread** is only company-gated on fetch. If cross-surface refs must honor thread-level privacy, the **delivery layer must gate on `canViewThread` at emit/deliver time** (as `thread.*` events already do) — not rely on the fetch route.

### 3.6 Hybrid adaptive card

- A pointer has no intrinsic size, so the card **fetches lightweight metadata first** (kind + contentType + byteSize/length) and then decides inline-expand vs pop-to-panel against a **measurable threshold** (e.g. images ≤ N px tall inline; text ≤ N KB inline; documents/large → panel). Thresholds live in one shared constant.
- Defined **loading** and **error** states (metadata fetch pending / failed → compact card with retry).
- Navigational kinds always present as a card (never inline-expand).

### 3.7 TTL-ephemeral artifacts — a separate lifecycle slice (§Phase 5)

Not a flag. A lifecycle over the existing immutable-version model:

- **Level:** ephemeral at the **artifact** level (a whole artifact marked ephemeral with `expiresAt`), so version immutability and current-version pointers are untouched.
- **Cleanup:** **archive**, not hard-delete, by default (reuses existing archive semantics); a later sweep may hard-delete archived-ephemeral past a grace window.
- **Shared assets:** ephemeral cleanup must **not** delete an asset referenced by a non-ephemeral artifact (refcount/leave-asset).
- **Promotion:** "Save/promote" clears the ephemeral flag (authz = who can create durable artifacts).
- **Exclusion:** ephemeral artifacts are filtered from durable artifact **lists/search/query** surfaces.
- **Races:** promote-vs-sweep, expiry-while-tab-open (open tab shows an "expired" affordance, doesn't crash), current-version repair.
- **Activity:** ephemeral create/expire/promote are logged.

### 3.8 Focus arbitration (concurrent refs)

- Auto-open opens **at most one** tab per delivery batch; additional refs become badged cards, never 20 tabs.
- A background/other-agent ref never steals focus from the surface you're actively in.
- Multi-agent contention resolves to the most recent `emittedAt` for the surface you're viewing; others queue as cards.

### 3.9 `viewerControl` setting + resolver (company ceiling + per-user override)

```ts
type ViewerControlLevel = "manual" | "own_output" | "full";
```

- `manual` — card only, never auto-open. `own_output` *(default)* — auto-open own fresh output; nav stays a card. `full` — auto-open nav too (URL always confirms).

**Authority model:**
- **Company ceiling (policy):** `internal_agent_config.viewerControlLevel` + optional `companies.viewerControlGuardrail` (clamps the permissive value). Company sets the maximum.
- **Per-user preference:** confirmed there is **no** generic `user_preferences` table. Add a new **`viewer_preferences`** table cloning the `sidebar_preferences` trio — `(userId, companyId)` + `uniqueIndex`, `viewerControlLevel text` nullable; service with `onConflictDoUpdate`; route `GET/PATCH/POST …/companies/:cid/viewer-preferences/me` (`requireBoardUserId` + `assertCompanyAccess`); client `viewerPreferencesApi`. Tunes *within* the company ceiling — a teammate can dial down, never past it.
- **Per-surface override:** `discussions.viewerControl` / `projects.viewerControl` nullable columns (explicit columns following the autonomy precedent — **not** `executionWorkspacePolicy` jsonb; this is locked).
- **Resolution (server-side, at display-eligibility time):** `company default → project/dept override → discussion override → per-user preference → guardrail clamp`. Mirrors `agent-completion-policy.ts`, returns an auditable snapshot. Unscoped fallback = `own_output` clamped by guardrail.
- The guardrail is **required** (acceptance depends on it), not optional.

### 3.10 URL scheme-safety — one isomorphic validator, every path

`toSafeBrowserUrl` in a **shared isomorphic package** (server validation reuses it): allow `http`/`https` + `about:blank` + (see below on relative); reject `javascript:`/`file:`/`data:`/`blob:`/protocol-relative/control-chars/others. Specify return type, schemeless-host normalization, and same-origin detection.

Applied at **every** browser entry, not just agent refs:
- `BrowserViewer.normalizeUrl` **and** its `initialUrl` path (currently trusts `initialUrl` before submit-time normalization).
- `WorkspacePreviewPanel` `BrowserTabView.normalizeUrl` **and** the un-sandboxed dev-server `<iframe>` (add a `sandbox` attribute).
- Tab constructors `openBrowserTab` (`commanderViewerModel`), `browserTab` (`threadViewerModel`, **`hubViewerModel`**).
- **Same-origin/relative policy is consistent across all paths** — not just agent refs. Agent-emitted `url` additionally requires confirmation. (Relative same-origin under `allow-same-origin allow-scripts` runs as the app; the policy rejects/loads it uniformly rather than per-caller.)

## 4. New tab bodies required (real Build-1 work)

Per the matrix (§3.4), these do **not** exist and must be built: Workspace `task`/`discussion`/`approval`/`memory_item`; Discussions `output`/`approval`/`memory_item`; Commander `memory_item`. Each reuses the corresponding full-fidelity component (`TaskDetail`, `ApprovalDetailCore`, discussion embed, memory view) inside the surface's own tab shell. **[investigate]** confirms the exact inventory.

## 5. Delivery phases (one branch, phased — reordered per review)

### Phase 0 — Lock contracts (design/types; no runtime behavior)
Versioned `ShowRef` type + validators + Codex-local mirror; the per-surface delivery **contract** + confirmed storage sites **[investigate]**; the mapping matrix confirmed against code; `viewerControl` semantics (authority/resolution/columns) + resolver signature; the `toSafeBrowserUrl` API. **Exit:** typecheck + contract tests; legacy `v:1` refs validate; no runtime behavior change.

### Phase 1 — URL hardening security slice (self-contained, user-visible security)
`toSafeBrowserUrl` wired into every constructor + `initialUrl` + both iframes (add sandbox to the dev-server iframe). **Exit:** every browser path rejects `javascript:`/`file:`/`data:`; dev-server iframe sandboxed; no legitimate navigation regresses.

### Phase 2 — Commander onto the new contract (no behavior change)
Migrate Commander emission/rendering to `ShowRef v:2` with provenance; preserve version-pinned tabs, chips, Viewer Home, Cockpit zone. **Exit:** Commander behaves identically; old persisted refs still open; compat tests green.

### Phase 3 — Durable, manual-only refs + cards, one surface at a time
Markdown in Discussions bubbles; hybrid card; the delivery channel + new tab bodies for **Discussions**, then **Workspace**. Manual-only (no auto-open yet). **Exit:** an agent-emitted ref persists, replays on reload, and renders as a card the user can open, on each surface; no bespoke tab regresses.

### Phase 4 — Settings UI + focus arbitration, then enable Tier 2 auto-open
`viewerControl` UI (company + per-user + per-surface) and focus arbitration land **before** auto-open is enabled. Then `own_output` auto-open turns on. **Exit:** setting is inspectable/changeable; concurrent refs don't spawn tab storms; auto-open honors resolution.

### Phase 5 — TTL-ephemeral lifecycle (own migration + worker slice)
Ephemeral flag + `expiresAt`, sweeper/worker, list/search exclusion, shared-asset safety, promote, expired-tab UX, activity. **Exit:** ephemeral artifacts auto-archive, never delete a shared asset, exclude from lists, and survive the race cases in §6.

### Phase 6 — Tier 3 navigational + confirmations
task/discussion/approval/memory_item/url kinds across the three surfaces; nav auto-open only at `full`; URL confirmation. **Exit:** access-checked navigation on all three surfaces; URL safety verified.

### Phase 7 — Re-evaluate Memory
Only build the Memory `memory_item` view targets if the contract/使用 justifies it; otherwise defer. **Exit:** explicit keep/defer decision with rationale.

## 6. Regression guardrails (must not break)

Original 10 (Memory DOCX short-circuit; two memory editors; Commander preview vs full embed; Workspace parallel-**thin-wrapper** renderer + legacy mode + changes/file/logs; scope-item workbenches; per-model tab-close focus; Commander live-ref staleness `readState`; `onOpenRequest` embed delegation; keyed remounts; Memory composite key) **plus** review additions:

11. **Old persisted `output_refs`** validate + open (v:1 compat).
12. **Version-pinned tabs** unaffected by `versionId` handling.
13. **Commander chips / Viewer Home / Cockpit Conversation Zone** unchanged.
14. **Inbox Hub browser** (`hubViewerModel` `browserTab`) covered by scheme-safety.
15. **Dev-server iframe** sandboxed + scheme-gated (separate path).
16. **`BrowserViewer.initialUrl`** gated (not only submit).
17. **`EntryRow` multiple raw-text render sites** (human/self/agent/system/scope-proposal/optimistic/mention-chip/link-click) all covered by the markdown change.
18. **Provider/parser chain** (MCP envelope, Claude stream parse, Codex-local mirror, SSE, persistence validation, historical reload) round-trips the new contract.
19. **TTL races** (promote-vs-sweep, expiry-while-open, expired history card, shared asset, current-version repair, search exclusion, activity).
20. **Focus arbitration** (no 20-tab storm; no cross-surface focus theft).

## 7. Security

- Entity ShowRef kinds self-secure via access-checked re-fetch as the viewing user.
- URL: one isomorphic scheme validator across all paths + same-origin/relative policy + agent-ref confirmation; no domain allowlist (forward-compatible with CDP agent browsing).
- Agent-facing show/navigate tool registered through `resolveCommanderToolPolicy` (RBAC + optional `requiresConfirmation`).
- ShowRefs only lifted for `mcp__*` tool names (existing anti-spoof); nav auto-open gated by `viewerControl`.

## 8. Test strategy

Unit: `ShowRef` v1+v2 validation + compat; `toSafeBrowserUrl` (accept/reject table incl. protocol-relative + control chars + about:blank + same-origin); `resolveViewerControl` (full order incl. per-user + guardrail); each adapter kind→tab mapping; TTL expiry + refcount; focus arbitration.
Component: hybrid card metadata-decision + loading/error; Discussions markdown across all `EntryRow` sites; no bespoke tab reachable via ShowRef.
Contract/API: delivery persist/replay/authz/idempotency per surface; asset metadata endpoint; access-checked re-fetch denies cross-user/company; URL confirm gating; ephemeral sweeper + list exclusion.
Integration: agent shows own output (all three); nav to task/discussion/approval/memory; auto-open honors `viewerControl` at each level + per-user; reload replays refs; provider round-trip incl. Codex-local mirror + historical reload.
Regression: all 20 guardrails.

## 9. Locked decisions (were "open" in draft)
- `viewerControl`: company ceiling + per-user override + per-surface **explicit columns** (not jsonb), guardrail **required**, server-resolved.
- `ShowRef`: versioned superset of `CommanderOutputRef`, `versionId`/provenance preserved, `reply` excluded, backward-compatible loader.
- TTL: artifact-level, archive-not-delete, its own phase.
- URL: isomorphic shared validator, all paths, consistent same-origin policy.

## 10. Resolved (investigation, HEAD a490fc57d)
- **Delivery storage:** Discussions → new `discussion_entries.output_refs jsonb` + existing `thread.entry.created` poke; Workspace → `task_outputs` (+ `issue_comments.metadata` for inline) + one new `task.output.created` poke. (§3.5)
- **Asset metadata:** none exists; add `GET /assets/:id/meta`. (§3.2)
- **Tab-body matrix:** confirmed — Discussions only lacks `approval`; Workspace lacks task/asset/discussion/approval/memory; Commander lacks asset/output/memory_item. (§3.4)
- **Per-user pref:** new `viewer_preferences` table cloning the `sidebar_preferences` trio. (§3.9)
- **v:2 round-trip surface = 6 files that must change together:** `packages/shared/src/commander-output-refs.ts` (contract+Zod), `packages/adapters/codex-local/src/server/parse-shared.ts` (`LiftedOutputRef` mirror), `parse-stream-json.ts` + `codex-local/parse.ts` (lift gates), `server/src/services/internal-agent/conversation.ts` (persist validator), and the emit/render sites (`internal-agent.ts` route + `InternalAgentPanel.tsx`). `buildOutputRefs`/`mergeOutputRefs` are kind-agnostic except hard-coded `v:1` literals.

## 11. Acceptance gates
1. `pnpm -r typecheck` / `pnpm test:run` / `pnpm build` pass.
2. Every phase exit gate met with evidence.
3. All 20 regression guardrails covered.
4. Legacy `v:1` refs validate and open; version-pinned tabs intact.
5. Scheme-safety verified across BrowserViewer (+initialUrl), Workspace preview, hub, dev-server iframe.
6. `viewerControl` resolves at every level incl. per-user + guardrail; default experience needs no settings change; settings UI ships before auto-open.
7. Delivery channel persists/replays/authorizes refs on Discussions + Workspace.
8. TTL ephemeral archives (not deletes shared assets), excludes from lists, survives race cases.
9. No agent path reaches a bespoke tab; focus arbitration prevents tab storms.
10. A11y + responsive on card + panel across densities.
