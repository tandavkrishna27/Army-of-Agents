---
title: Memory — UI & Retrieval Reference
summary: Memory explorer layout, semantic retrieval configuration, and feedback detector details
---

Deep implementation detail for the memory system. For the data model, lifecycle rules, and approval gates see `CLAUDE.md` §Memory System and the schema at `packages/db/src/schema/memory_items.ts`.

## Memory UI

The memory explorer is a **3-pane layout**:

- **Left pane:** folder tree. Collapsed state shows `MemoryFolderRail` — 5 shortcut icons + 4 layer icons + expand button.
- **Center pane:** item list. Three view modes: **List** (default) / **Table** / **Cards**. View mode persists via `localStorage["aoa:memory:view-mode"]`.
- **Right pane:** item detail. Tabbed — multiple items open simultaneously. Tabs backed by URL (`?tabs=…&active=…`) so deep-links and browser back/forward work correctly.

## Semantic Retrieval

Uses **pgvector** for embedding-based similarity search.

| Property | Value |
|----------|-------|
| Embedding model | OpenAI `text-embedding-3-small` |
| Dimensions | 1536 |
| Similarity metric | Cosine |
| Index type | HNSW (partial — skips NULL embedding rows) |
| Cosine threshold | 0.85 |
| Word-overlap threshold | 0.6 (fallback scoring) |

**Fallback chain:**
1. HNSW index (when pgvector is installed and index exists)
2. Sequential scan (when pgvector installed but index missing)
3. `ilike` text search (when no OpenAI API key — no embeddings generated)

**Background worker (`processEmbeddingQueue`):** processes in batches of 10 items, up to 3 retry attempts tracked per item via `embeddingRetries` counter (no delay between attempts — retries happen on the next queue run).

**pgvector absent entirely:** if the pgvector extension is not installed, the `embedding` column is not queryable. The retrieval code gates vector queries on pgvector availability and falls through to `ilike` text search in that case.

## Memory Feedback Detectors

The `memory_feedback_patterns` table tracks recurring edits made by founders to agent-produced content. Six pattern types are valid in the schema; four have active detector functions:

| Pattern type | Active detector | What it catches |
|-------------|----------------|----------------|
| `tone_correction` | ✅ | Founder consistently rewrites agent tone or voice |
| `format_change` | ✅ | Founder consistently restructures output format |
| `content_addition` | ✅ | Founder consistently adds the same type of missing content |
| `terminology_change` | ✅ | Founder consistently replaces specific terms |
| `content_removal` | — | Founder consistently trims agent output (type valid, no detector yet) |
| `structure_change` | — | Founder consistently reorganizes output structure (type valid, no detector yet) |

Suggestions are generated after **≥3 occurrences** of the same pattern (Decision #46). Detectors read `activity_log` rows with `action = "brief_item.updated"`, following the `brief → debrief → sourceInfo.agentId` chain to resolve which agent produced the original content. Results are grouped by agent in the Memory Feedback UI.

## Commander Recall Runtime

Commander automatic prompt recall uses the same multi-path memory retrieval service as task-agent heartbeat context, then applies Commander-specific policy before injecting memory into the system prompt. AoA memory remains the product source of truth; Commander is a conductor over `memory_items`, not a separate memory store.

Default policy:

- `identity`: enabled company-wide
- `domain`: enabled with scope awareness
- `active_context`: scoped only
- `working`: current-scope only
- strictness: `balanced`
- timeout: 3000ms

Structured UI/runtime scope:

- Commander chat accepts `contextScope` with surface, route, department, project, goal, task, memory-folder, and conversation fields.
- Server code normalizes the scope and passes it through automatic recall, context assembly, and the Commander MCP tool bridge.
- UI route-derived scope sends only UUID-shaped stable entity IDs; slug-like route refs remain route text only.

Role and scope floor:

- `founder` can see all approved, unexpired Commander-visible memory.
- `team_lead` can see approved shared durable memory and scoped memory that matches the current Commander context.
- `team_member` cannot see `identity`; durable and working memory must be shared or match the current scope.
- Pending, rejected, archived, and expired items are never injected into the prompt.

Automatic recall is audited as `commander_context`. Explicit `query_memory` searches use the same Commander policy, can search more broadly than automatic recall, and are audited separately as `commander_query` with shown and filtered hits.

Prompt labels are model-visible so Commander knows what it is using:

```text
- [working/scoped/approved/expires 2026-06-07/task] Current onboarding concern: User is evaluating UI context.
```

## Commander Working Memory

Commander can create, update, and forget temporary `working` memory without a durable-memory approval because it is scoped, visible, reversible, and expires. These tools use `source: "commander"`, `layer: "working"`, `status: "approved"`, and `visibility: "scoped"`.

Default expiry:

- task scope: 7 days
- conversation scope: 14 days
- project or goal scope: 30 days
- founder-created company-level working memory: 7 days

Non-founders must provide project, goal, task, or conversation scope to create working memory. Forgetting working memory archives it by setting `status = "archived"` rather than hard-deleting the row.

Durable `identity`, `domain`, and `active_context` memory remains approval-gated at Commander L0 autonomy. Commander may propose durable memory through `suggest_memory`; those items are attributed to `source: "commander"` but remain `status: "pending"` until approved.

Deferred or rejected for this slice:

- Context Steward / Memory Keeper sub-agent is deferred.
- Settings UI for role-by-role memory visibility is deferred.
- Durable auto-approval is rejected at L0 autonomy.
- Broad automatic working-memory injection is rejected; automatic `working` recall must remain current-scope only.
