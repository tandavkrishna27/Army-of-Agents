# Memory Page Redesign — Layer-First Tree (Phase 6.2) Design Spec

**Status:** Designed 2026-05-03. Awaiting user review.
**Predecessor:** Phase 6 memory redesign (folder-first explorer, shipped through 6.1e on `memory` branch as of `33dbef5`).
**Successors:** Phase 6.2a / 6.2b / 6.2c implementation plans (to be written from this spec).

---

## 1. Problem statement

The memory explorer shipped in Phase 6 (folder-first) hides the V2 architecture from the founder. The 4 memory layers (`identity` / `domain` / `active_context` / `working`) have radically different lifecycles:

- **Identity:** permanent, always in agent context.
- **Domain:** semi-permanent, department-scoped.
- **Active Context:** temporary, goal-scoped, has `expiresAt`.
- **Working:** ephemeral, task-scoped, auto-archives at 7 days.

In the current explorer, layer is invisible. The founder cannot tell why one item sticks around forever and another disappears next week. The seeded subfolders (Decisions / Policies / References / Files) replicate the `category` field as folders, padding the tree without adding information. Pinned and Pending Review virtual folders ship but have no equivalent for cross-cutting flows like "what changed lately?" or "where are my archived items?".

Three secondary gaps:
- The MemoryHome page tiles by department but the explorer (and the architecture) is layer-shaped — split-brain mental model.
- User-created folders exist in the schema (`memory_folders`, `seedKey`) but have no UI affordance.
- Active goals are first-class entities elsewhere in the app, but in Memory they're invisible — a founder can't see what context is loaded for goal X.

## 2. Goals + non-goals

**Goals:**
- Make layer the primary navigation hierarchy.
- Show goal-level context first-class (under Active Context).
- Add user-created folders with deletion protection and unlimited nesting depth.
- Surface common cross-cutting flows (Pinned / Pending / Recent / Archived) as tree shortcuts.
- Replace dept tiles on MemoryHome with layer tiles.
- Reserve a pane in the Home view for a future graph visualization.

**Non-goals (v1 of layer-first):**
- Drag-and-drop reorganization. Kebab actions only.
- Bulk item movement. Single-item only.
- User-extensible layers. The 4 layers are system-defined.
- Goal-hierarchy nesting (vision → mission → goal) inside Active Context. Flat list of active goals only.
- Per-task tree nodes inside Working. Working stays a flat item list.
- Mobile / narrow-viewport adaptation. Desktop first.
- Layer-aware search ranking. Search treats layers equally.
- Implementing the Home graph viz. Reserved slot only.

## 3. Tree structure

```
🏠 Home                          → Center: home dashboard. Right: graph slot.
📌 Pinned                        → Items with founderPinnedToTop = true
📋 Pending Review (count)        → Items with status = 'pending', amber chip if >0
🕒 Recent                        → Last 14 days, sorted by updatedAt
📦 Archived                      → status = 'archived'
─────────────────────────────────
🪪 Identity                      [expanded by default]
  🏛️ Company
    📂 (user folders, unlimited nesting)
🏢 Domain                        [expanded by default]
  📁 Engineering (count)
    📂 Q3 Planning (user)
      📂 OKR Drafts (user)
    📂 API Migration (user)
  📁 Marketing (count)
🎯 Active Context (count)        [collapsed by default]
  🎯 Goal: Ship in EU (count)    ← every goal with status='active', even 0-item
    📂 (user folders allowed)
  🎯 Goal: Q3 OKRs (count)
⚡ Working (count)                [collapsed by default; FLAT — no task subtree]
```

**Rules:**
- Empty scopes always show with `(0)` count badge — predictable structure trumps cleanliness.
- User folders: unlimited nesting depth. Default collapsed. Soft-warn (tooltip only) at depth > 6 levels.
- User folders cannot be created at: layer-root level, scope-root level, or anywhere under `Working`.
- Pinned / Pending / Recent / Archived = virtual filters computed at query time. No DB rows.
- Selecting an item or folder auto-expands its ancestor chain in the tree.
- When the founder switches to a different scope, the previously-expanded user folders inside the old scope stay expanded (so coming back is fast).

## 4. Layout (4-pane, resizable + collapsible)

```
┌─────────┬───────────┬───────────────┬──────────────────┐
│ AoA     │ Memory    │ Center pane   │ Right pane       │
│ Sidebar │ Tree      │               │                  │
│ (50px)  │ (240px)   │               │                  │
└─────────┴───────────┴───────────────┴──────────────────┘
```

**Pane assignments by tree selection:**

| Tree selection | Center pane | Right pane |
|---|---|---|
| `🏠 Home` | Home dashboard (banner + quick-jump + layer tiles + recents) | Reserved for future graph viz (visible empty slot) |
| Layer / scope / user folder | Items in that scope, grouped by category | Auto-collapsed if no item selected |
| Item URL (`?item=...`) | Items in the parent folder | Item viewer / editor |

**Pane behaviors:**
- All three right-of-sidebar panes are resizable (drag dividers) and collapsible (chevron in pane header).
- Right pane auto-collapses when no item is selected (in non-Home contexts) and slides open when an item is clicked.
- On Home, right pane stays visible with the graph placeholder so the founder remembers it's a future feature.

**Standalone `/memory` route:** kept. Lands on the explorer with `🏠 Home` selected (replaces today's standalone MemoryHome page). No breaking change to AoA sidebar `Memory` link.

## 5. File list — category grouping

When a non-virtual scope (layer / dept / goal / user folder) is selected, the center pane shows items in that scope grouped by `category`, with collapsible sections.

```
DOMAIN / ENGINEERING (12)               [search: search this folder]
─────────────────────────────────────
▼ Decisions (4)
  📄 Auth strategy                      decision · today
  📄 Database choice                    decision · 1w
▼ References (3)
  📄 API standards                      reference · 2d
▶ Policies (2)                          ← collapsed by default if >0 items but layer != Identity
▶ Insights (2)
▶ Procedures (1)
```

**Default expansion of category groups:**
- All categories with items expanded by default for the first 3 (sorted by item count desc).
- Categories beyond the top 3 collapse by default. Founder expands manually.
- This is the sensible default for a long file list. May need tuning via UX feedback.

**User folders inside category groups:** when items in a scope live in a user folder, the folder appears as a sub-group nested inside its category:

```
▼ Decisions (4)
  ▼ 📂 Q3 Planning (2)
    📄 Pricing tier choice
    📄 Hiring freeze
  📄 Untagged decision A
  📄 Untagged decision B
```

Clicking a user folder in the tree drills the file list to that folder's items only (one less click for power flows).

**Item row anatomy:**
- Icon (per category or asset mime)
- Title
- Category badge (colored chip)
- `expiresAt` chip (active_context only — see §7)
- Modified-relative timestamp (today / 2d / 1w / 3mo / 1y)

**Search:** existing per-Phase 6.1d behavior. Filter input above the file list, debounced, scoped to the current selection.

## 6. MemoryHome dashboard (center pane when Home selected)

Replaces today's standalone MemoryHome page. Same content, embedded in the explorer's center pane:

- **Pending banner** — self-hides at 0; amber when > 0.
- **Quick-jump button** — opens `MemoryQuickSwitcher` (existing component).
- **Layer tiles** — grid of 4: Identity / Domain / Active Context / Working. Each tile shows item count + pending count. Click → `/memory/explore?layer=<layer>` opens that layer expanded + selected.
- **Recents strip** — last 10 items by updatedAt, same as today.

Drops:
- Department tiles. Founders who want by-dept browse the tree (`Domain → <Dept>`) — one extra click, one consistent mental model.

The right pane on Home is a visible-but-empty placeholder reading "Memory graph view — coming soon." Reserved space, no auto-collapse.

## 7. Active Context items: `expiresAt` visualization

Active context items have an `expiresAt: Date | null`. When set, a chip on the right of the file-list row shows a countdown:

| Days remaining | Chip color | Text |
|---|---|---|
| > 7 days | muted gray | "expires Jun 14" |
| ≤ 7 days | amber | "expires in 5d" |
| ≤ 1 day | red | "expires today" |
| < 0 (already past) | n/a | item has been auto-archived; only visible from `📦 Archived` shortcut |

**Auto-archive trigger:** existing memory lifecycle service (`server/src/services/memory-lifecycle.ts` or similar) already runs periodic `expiresAt < now()` archival. No change needed here.

## 8. User-folder CRUD + MCP scoping

**Creation:**
- Tree node hover-kebab and right-click both expose `+ New folder` action.
- Allowed parents: any scope under Identity / Domain / Active Context (and any user folder beneath those).
- Disallowed parents: Working layer (and anything under it), layer-root nodes, scope-root nodes.
- Founder picks display name + optional emoji icon (defaults to 📂).
- New folder writes a `memory_folders` row with `seedKey: NULL`, `path: "<parent.path>/<slug>"`, `displayName`, `icon`, `companyId`, `departmentId` (inherited from parent).
- Slug is auto-derived from displayName (lowercase, dashed). Conflict on `(companyId, path)` unique index → reject with "folder name already exists at this level".

**Deletion:**
- Allowed iff `seedKey IS NULL`.
- If folder contains items, founder confirms via dialog: "Move N items to parent folder?" — items are reparented to the folder's parent (their `folderPath` is updated to the parent's path). No orphans.
- If folder contains sub-folders, recursive: dialog wording adjusts to "This folder has 3 sub-folders containing N items. They'll be moved up one level on delete." Reparenting is one-level-up, not flat-to-scope-root, to preserve user organization.

**Rename:**
- `displayName` is editable inline (double-click or kebab → Rename).
- `path` stays stable for MCP idempotency. Rename only updates displayName.
- If the founder genuinely wants to move the folder elsewhere, that's "delete + create new" — no silent path migrations in v1.

**Edit icon:**
- Inline emoji picker on the folder node. Updates `memory_folders.icon`.

**MCP scoping:**
- Existing memory MCP tools accept a `scope` parameter. Today: layer + departmentId.
- Extend the schema to also accept `folderPath`. When provided, filter items where `memory_items.folderPath = '<path>'` OR `memory_items.folderPath LIKE '<path>/%'` (so a path includes its descendants).
- All addressable scopes have the shape: `companyId / layer / scopeId? / folderPath?`. Path is the source of truth.

## 9. Item movement between layers

Founder triggers via kebab → "Change layer". Free movement between any two layers, with a confirmation dialog handling the field mutations:

| From → To | Behavior on save |
|---|---|
| any → Working | Prompt for `taskId`. Item gets 7-day TTL (existing service handles archival). |
| Working → any | `taskId` cleared. No TTL on remaining target. |
| any → Active Context | Prompt for `goalId` + optional `expiresAt`. |
| Active Context → any | `goalId` + `expiresAt` cleared. |
| any → Identity | Confirm "permanent layer — agent context will always include this." |
| any → Domain | Prompt for `departmentId` if not already set. |

**Folder path:** when layer changes, item's `folderPath` is cleared (it was scoped to the old layer's tree). The dialog includes a "new home folder" picker so the founder lands in a deliberate spot.

**Audit trail:** every layer change creates a new `memory_item_versions` row with a `layer changed: <from> → <to>` changelog note. The new layer + cleared/set fields are captured in the version snapshot.

**Bulk movement:** out of scope.

## 10. Schema impact

**No migration for 6.2a / 6.2b / 6.2c.** All required columns and indexes already exist:
- `memory_folders.seedKey` — deletion protection metadata.
- `memory_items.layer` / `goalId` / `taskId` / `expiresAt` / `folderPath` — V2 schema columns.
- `memory_items_folder_path_idx` — B-tree index on `(companyId, folderPath)` already in `memory_items.ts:105`. Sufficient for prefix queries via `LIKE '<path>/%'`.
- `memory_item_versions` — audit trail table ships, version writer service exists.

**Behavioral changes in 6.2b (no schema impact):**
- The existing `DELETE /memory/folders/:id` route + service unconditionally deletes today. Phase 6.2b adds a `seedKey IS NULL` precondition (returns 403 with "Cannot delete seeded folder" otherwise) and a reparenting pass for child items + sub-folders.

**Phase 6.2d** (deferred) introduces a new shared `MemoryScope` + `ActorContext` type set in `packages/shared/src/types/memory.ts`. No DB schema changes — pure type + service-layer additions. The optional `sharedWithAgentIds` column may land later as part of the tagged-sharing feature, separately from 6.2d core.

**Existing data:** items with `folderPath: "engineering/Decisions"` (etc., from seeded subfolders) keep their value. The new tree just doesn't render that path level — items appear in their dept's flat list grouped by category. The seeded `memory_folders` rows remain for historical / MCP-path-resolution purposes; they're simply not surfaced as tree nodes.

If a founder wants to move legacy items into a user folder, the existing kebab → "Move to folder" action handles it (already shipped in Phase 6.1b).

## 11. Memory access model (deferred to Phase 6.2d)

**Status:** Sketched here for context. Implementation deferred to its own slice + brainstorm + decisions-doc entry. Phases 6.2a / 6.2b / 6.2c ship without these changes; today's access model continues to work (workers get heartbeat-built context, Commander + external MCP have full access).

### 11.1 Why scope memory access for workers

This is **not just a security concern** — it's good agent design. A worker agent given access to all 47 domain items across 5 departments will:
- Spend tokens loading irrelevant context (cost concern).
- Suffer attention dilution — the model wastes capacity filtering noise instead of solving the task (quality concern).
- Drift off-goal as stray items from other departments pull on its reasoning (correctness concern).

Curated memory views produce sharper agents. The same logic motivates why we made layers visible in the UI: knowledge has a topology, and surfacing the right slice for the right consumer is foundational, not a veneer.

### 11.2 Three consumer classes (sketch)

| Consumer | Default access | Identity passed |
|---|---|---|
| **External MCP** (`/companies/:cid/mcp`) | Full company DB. All layers, all depts, all folders. | `mcp_api_keys` Bearer token → `actor = "mcp"` |
| **Commander** (internal-agent) | Full company DB. Founder's assistant. | board session → `actor = "board"` |
| **Worker agent** (heartbeat-driven adapter) | Restricted: Identity (all) + Domain[its.departmentId] + Working[its.taskChain] + tagged-shared (future). | heartbeat context → `actor = "agent"` with `agentId` + `departmentId` |

External MCP + Commander are admin-grade — they see everything. Worker agents are autonomous executors with curated views.

### 11.3 Sketch of the unified `MemoryScope` type (deferred)

```typescript
// packages/shared/src/types/memory.ts
export type MemoryScope = {
  layer?: 'identity' | 'domain' | 'active_context' | 'working';
  departmentId?: string;
  folderPath?: string;          // exact + prefix match: '<path>' or '<path>/%'
  goalId?: string;              // narrows active_context
  taskId?: string;              // narrows working
};

export type ActorContext =
  | { kind: 'mcp'; companyId: string }                     // external, full
  | { kind: 'board'; companyId: string; userId: string }   // Commander, full
  | { kind: 'agent'; companyId: string; agentId: string;
      departmentId: string | null; taskChainIds: string[] }; // worker, scoped
```

Service layer would intersect ceiling (from `ActorContext`) with caller-supplied `MemoryScope`. Worker passing a foreign `departmentId` → empty + warn. No escalation possible.

### 11.4 Open questions for the 6.2d brainstorm

- **Worker default scope precise rules.** Active Context items: included if their `goalId` belongs to one of the worker's task-chain goals? Or excluded entirely until tagged?
- **`sharedWithAgentIds` design.** Per-agent UUID grants vs. tag-based grants vs. a `sharedWithRoles` enum. Founder UX for opting in.
- **Read audit log.** When and what to log. Where it surfaces (Commander? Settings? Inbox?).
- **Migration path for existing MCP clients.** Today they pass `{ layer }` only. After 6.2d, if they pass nothing they get full access (admin-grade). Should we require an explicit `MemoryScope: {}` to signal "I want everything"?
- **Heartbeat context package builder.** Today bakes a fixed set of items per task. After 6.2d, should it route through the same enforcement as MCP, or stay pre-baked? Tradeoff: dynamic = always-fresh, baked = lower latency on heartbeat trigger.

### 11.5 What ships in 6.2 (without 6.2d)

- The `MemoryScope.folderPath` parameter is **wired up at the UI layer in 6.2a** (the file list filters items in the selected scope by `folderPath` exact match) and **at the user-folder route layer in 6.2b** (folder listings nest under their parent path).
- No service-layer ceiling enforcement.
- No `ActorContext` plumbing.
- External MCP + Commander + workers behave exactly as today.
- 6.2d picks up the architectural work after its own brainstorm.

## 12. Sidebar entry + routing

- AoA sidebar `🧠 Memory` link → `/<companyPrefix>/memory` (unchanged).
- `/memory` redirects to `/memory/explore` (the standalone MemoryHome at `/memory` is replaced; `MemoryHome.tsx` becomes a panel component, not a page).
- `/memory/explore` is the explorer. With no query params → tree shows with `🏠 Home` selected (default). Center pane = home dashboard, right pane = graph placeholder.
- `/memory/explore?layer=domain` → opens with Domain layer expanded + selected.
- `/memory/explore?folder=<path>&dept=<id>` → opens with that scope selected.
- `/memory/explore?item=<id>&type=memory_item|asset` → opens with that item's parent scope expanded and the item loaded in the right pane.
- `/memory/legacy` (the old filter-list view) → kept as a safety net for one minor version. Removed in 6.3.

## 13. Phased delivery

The redesign is too large for a single slice. Three user-facing slices ship first; the architectural access-model work is deferred to its own slice + brainstorm.

### Phase 6.2a — Layer tree + Home rebuild
**Goal:** New tree component; home tiles. Read-only redesign — no folder mutations, no item movement.
**Touch:** `MemoryTreeV2`, `LayerTilesPanel`, route swap to embed home in explorer, file-list category grouping, empty states, `expiresAt` chip.
**Tasks:** 5–6, similar shape to 6.1d (1000-line plan).

### Phase 6.2b — User folder CRUD
**Goal:** Full create / rename / delete for user folders. UI affordances + service-layer behavior changes.
**Touch:** `CreateUserFolderDialog`, kebab menu extensions on tree nodes, `memoryFoldersService` (seedKey-enforced delete + reparenting + recursive sub-folder reparenting), folder-tree rendering of nested user folders, file-list filtering by folderPath when a user folder is selected.
**Out of scope here:** unified `MemoryScope` type, access ceiling, MCP / Commander / heartbeat changes — all deferred to 6.2d.
**Tasks:** 4–5.

### Phase 6.2c — Item movement + polish
**Goal:** ChangeLayerDialog. Audit trail wiring. Soft-warn for deep nesting. Final polish pass.
**Touch:** `ChangeLayerDialog`, `memory.changeLayer` service, version-row writes, kebab additions, deep-nesting tooltip.
**Tasks:** 3–4.

### Phase 6.2d — Memory access model (deferred — needs its own brainstorm)
**Goal:** Wire up the access-curation model from §11. Consumer-aware permission ceilings; unified `MemoryScope` filter type; worker-default scoping; tagged-sharing future hook.
**Touch:** `packages/shared/src/types/memory.ts` (new types), `server/src/services/memory.ts` (enforcement layer), `server/src/mcp/tools/memory*.ts` (route through enforcement), `server/src/services/internal-agent/tools/memory.ts` (Commander), `server/src/services/heartbeat-context.ts` (worker package builder).
**Decisions to lock first:** the open questions in §11.4. Brainstorm session before plan-writing.
**Tasks:** TBD after brainstorm — likely 5–6.

Each slice ships independently and is mergeable. 6.2a → 6.2b → 6.2c is the user-facing shipping order. 6.2d can land any time after, including after a few weeks of using 6.2a-c — gives founder time to discover what scoping they actually want.

## 14. Test plan per slice

**Existing baseline:** 20 memory-related server tests + 6 memory UI tests. Strong coverage of the V2 schema, folder seeds, asset routes, file-import without pgvector, lifecycle / archival, projection, multipath retrieval. All slices below extend this pattern (one test file per source file touched).

### Phase 6.2a tests
- **`MemoryTreeV2.test.tsx`** — virtual folder rendering (Pinned / Pending / Recent / Archived counts), default expansion (Identity + Domain expanded; Active + Working collapsed), goal nodes with 0-item display, ancestor-chain auto-expand on selection.
- **`LayerTilesPanel.test.tsx`** — tile counts match item-by-layer aggregation; pending counts surface; click → navigate to `/memory/explore?layer=<id>`.
- **`expiresAtChip.test.tsx`** — color tier transitions at the documented thresholds (>7d / ≤7d / ≤1d / expired).
- **`MemoryFileList.test.tsx` extension** — collapsible category groups; default-expand top-3 by count; expanded state preserved per scope.
- **Browser smoke** — full layout verification (4 panes, resize, collapse, Home dashboard renders, layer click navigation works).

### Phase 6.2b tests
- **`memory-folders-service.test.ts` extension** — `remove()` rejects when `seedKey IS NOT NULL`, with explicit "cannot delete seeded folder" error; reparenting moves child items' `folderPath` to parent on delete; recursive sub-folder reparenting one-level-up.
- **`memory-folders-routes.test.ts` extension** — DELETE returns 403 on seeded folder; DELETE returns 200 + reparented items on user folder.
- **`CreateUserFolderDialog.test.tsx`** (new) — slug derivation, conflict rejection, parent-path inheritance.
- **`MemoryFileList.test.tsx` extension** — when a user folder is selected as the scope, the file list filters items where `folderPath = <user-folder-path>`.

### Phase 6.2c tests
- **`memory-change-layer.test.ts`** (new server) — field clearing per transition (Working→other clears taskId; Active→other clears goalId+expiresAt); version-row creation with correct changelog note; folderPath cleared on layer change.
- **`ChangeLayerDialog.test.tsx`** (new UI) — per-layer prompt rendering (taskId for Working, goalId+expiresAt for Active, departmentId for Domain), confirmation flow, dialog dismissal preserves state.
- **Browser smoke** — change-layer flow end-to-end on each transition.

### Phase 6.2d tests (post-brainstorm)
Sketch only — full test plan written when 6.2d is brainstormed:
- **`memory-scope-filter.test.ts`** — `MemoryScope.folderPath` exact + prefix match; AND-ing semantics; backward compat with today's `FindSimilarScope` callers.
- **`memory-access-ceiling.test.ts`** — per-actor default access (mcp = full, board = full, agent = restricted); worker escalation attempt (foreign departmentId) → empty + warn; worker narrowing within ceiling.
- **`heartbeat-context.test.ts` extension** — worker memory now flows through enforcement; existing in-context memory behavior preserved.
- **MCP tool integration tests** — `memory.search` / `memory.list` / `memory.suggest` accept the new `MemoryScope` shape and honor caller identity.

### Test infrastructure expectations
- All new server tests use the existing mock pattern from `server/src/__tests__/` (Proxy-based `@armyofagents/db` stub, sequence-based mock DBs). No drizzle-orm ESM cycle workarounds needed beyond the established pattern.
- All new UI tests use vitest + React Testing Library + `MemoryRouter` + `QueryClientProvider`, mocking `../api/*` and `../context/CompanyContext`. No new infra.

## 15. Risks + open questions

- **Default category-group expansion** (top-3 by count) is a guess. Will need usage observation; may switch to "all expanded" or "remember per-scope expansion state".
- **Working layer flat list** with no task subtree may be confusing if a single task chain has many items. Punt: revisit if user feedback complains.
- **Goal hierarchy** flat list ignores vision/mission. If founders want to filter "items related to Mission X", they'll need that as a separate filter — out of scope for now.
- **MCP `folderPath` performance** — prefix matching on a `text` column is a sequential scan unless we add a B-tree index. Index addition is a 1-line schema bump in 6.2b.
- **Migration of legacy `engineering/Decisions` folder paths** — left as-is. Founders can re-organize manually. Do not auto-migrate (risk of breaking existing item ↔ folder associations they relied on).

## 16. Appendix — visual reference

ASCII layout of the explorer with Home selected:

```
┌────┬──────────────┬────────────────────────────┬────────────────┐
│ A  │ FOLDERS      │  ⚠️  3 items waiting       │ Memory graph   │
│ o  │              │     for your review        │ — coming soon  │
│ A  │ 🏠 Home  ◀   │                            │                │
│    │ 📌 Pinned    │  [🔍 Search across …]      │  [empty slot]  │
│ S  │ 📋 Pending(2)│                            │                │
│ i  │ 🕒 Recent    │  ── LAYERS ──              │                │
│ d  │ 📦 Archived  │  ┌──────────┬──────────┐   │                │
│ e  │ ─── ─        │  │🪪 Identity│🏢 Domain │   │                │
│ b  │ 🪪 Identity  │  │ 3        │ 47       │   │                │
│ a  │   🏛️Company  │  │           │ 2 pend  │   │                │
│ r  │ 🏢 Domain    │  └──────────┴──────────┘   │                │
│    │   📁Eng (12) │  ┌──────────┬──────────┐   │                │
│    │   📁Mkt (3)  │  │🎯 Active  │⚡ Working │   │                │
│    │ 🎯 Active(2)▶│  │ 9 (3 exp)│ 5 (7d ttl)│   │                │
│    │ ⚡ Working ▶ │  └──────────┴──────────┘   │                │
│    │              │                            │                │
│    │              │  ── RECENT ──              │                │
│    │              │  📄 Auth strategy   today  │                │
│    │              │  📄 Brand voice    yesterd.│                │
│    │              │  📄 ...                    │                │
└────┴──────────────┴────────────────────────────┴────────────────┘
```

ASCII layout with `Domain → Engineering → Q3 Planning` selected:

```
┌────┬──────────────┬────────────────────────────┬────────────────┐
│ A  │ FOLDERS      │ DOMAIN/ENG/Q3 PLANNING (5) │ Item viewer    │
│ o  │              │                            │ (auto-collapsed│
│ A  │ 🏠 Home      │ [🔍 search this folder]    │  when no item) │
│    │ 📌 Pinned    │                            │                │
│ S  │ 📋 Pending(2)│ ▼ Decisions (3)            │                │
│ i  │ 🕒 Recent    │   📄 Pricing tier   today  │                │
│ d  │ 📦 Archived  │   📄 Hiring freeze  3d     │                │
│ e  │ ───          │ ▼ References (1)           │                │
│ b  │ 🪪 Identity  │   📄 EU compliance  1w     │                │
│ a  │   🏛️Company  │ ▶ Policies (1)             │                │
│ r  │ 🏢 Domain    │                            │                │
│    │   📁Eng (12) │                            │                │
│    │     📂Q3 ◀   │                            │                │
│    │       📂OKR  │                            │                │
│    │     📂API M. │                            │                │
│    │   📁Mkt      │                            │                │
│    │ 🎯 Active(2)▶│                            │                │
│    │ ⚡ Working ▶ │                            │                │
└────┴──────────────┴────────────────────────────┴────────────────┘
```

---

**End of design spec.**
