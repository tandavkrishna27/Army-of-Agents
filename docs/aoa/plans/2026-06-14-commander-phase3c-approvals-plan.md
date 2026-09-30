# Commander Phase 3c (Approvals card) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the cockpit **⚑ Approvals** card — a unified standing-approvals queue across **3 source-families** (the `approvals` table = agent hires + task/artifact/strategy · memory suggestions · discussion extracted-items) with **inline approve/deny** + ↗ open-full-page, served through the existing batched `/cockpit` endpoint.

**Architecture:** Extend `/cockpit` with an `approvals: CockpitApprovalItem[]` array built by a new founder-scoped aggregation in `cockpitService` (3 parallel pending-queries → unified items with a `source` discriminator + the ids each approve action needs). The frontend adds `CockpitApprovalsCard` (default-on) to the existing card registry; rows carry a compact inline **Approve/Deny** (mirroring `MemoryApprovalActions`) that dispatches to the right per-source API by `source`, optimistically clears, toasts, and invalidates `queryKeys.cockpit` + the source's own keys. Live updates ride the existing cockpit invalidation + refetch.

**Tech Stack:** Express + Drizzle (read queries; **NO schema change**), React + react-query. Reuses existing approve/deny endpoints + API clients for all 3 sources.

**Scope (locked with founder): CORE 3, founder-scoped.**
- IN: the 3 source-families above, founder-only (the act-gates for approvals + discussion-items are founder-only server-side; memory is mostly founder), inline approve/deny + ↗ + Ask↩.
- OUT → **follow-ups (after the whole bundle, per the founder):** join-requests + tool-trust/runtime approval families; memory **version/archive** approval queues (3c uses only the new-pending `memory_items.items`); the team_lead-can-approve-active_context-memory scoping refinement; Pinned card + `user_entity_pins`; opt-in cards; "In this conversation" zone; Brief-me; suggestion-engine harden; Google epic; mobile tab-bar. **No DB schema change this slice.**

**Verified anchors (read before editing):**
- Existing cockpit engine (3b): `packages/shared/src/cockpit.ts` (`CockpitData`); `server/src/services/cockpit.ts` (the `Promise.all` batch + `resolveCockpitScope`/`scope.isFounder`); `server/src/services/cockpit-scope.ts`; `ui/src/components/commander/cockpit/CommanderCockpitPanel.tsx` (`COCKPIT_REGISTRY` with `isActive`/`render`); the card files (e.g. `CockpitReviewCard.tsx` compact pattern); `ui/src/api/cockpit.ts`.
- **Sources (pending queries):** `approvals` status in (`pending`,`revision_requested`) — `server/src/services/sidebar-badges.ts:15-24` (the actionable-approvals count) + schema `packages/db/src/schema/approvals.ts:13`; linked issue title via `issue_approvals` (`server/src/routes/approvals.ts:111-120`). Memory pending — `server/src/services/memory.ts:1154` `listPending(companyId)`. Discussion extracted-items pending — `packages/db/src/schema/discussions.ts:289` (`discussion_extracted_items.status`); join to `discussions` for `companyId` + `discussionId`.
- **Approve/deny actions (reuse, frontend):** `ui/src/api/approvals.ts:4-24` (`approve`/`reject`); `ui/src/api/memory.ts:120-146` (`approve`/`reject`); `ui/src/api/discussions.ts:213-235` (`approveItems`/`rejectItems`, batched per discussion).
- **Compact inline UI precedent:** `ui/src/components/memory/MemoryApprovalActions.tsx:14-75` (h-7 Approve/Reject + toast + invalidate). Toast: `useToast().pushToast`. ↗ routes: `/approvals/:id`, `/memory`, `/discussions/:id` (via `useNavigate`, auto-prefixed).
- Server test pattern: the 3b cockpit tests (`server/src/__tests__/cockpit-*.test.ts`) — vi.hoisted + mocked sub-services.

---

## Task 1: Shared `CockpitApprovalItem` type + extend `CockpitData`

**Files:** Modify `packages/shared/src/cockpit.ts`.

- [ ] **Step 1:** Add the unified item + the new array:
```ts
export type CockpitApprovalSource = "approval" | "memory" | "discussion_item";
export interface CockpitApprovalItem {
  source: CockpitApprovalSource;
  /** approval id | memory item id | discussion extracted-item id */
  id: string;
  /** discussion_item only — needed for the batched approveItems endpoint */
  discussionId?: string;
  title: string;
  subtitle: string;
}
```
Add to `CockpitData`: `approvals: CockpitApprovalItem[];`.
- [ ] **Step 2:** Export `CockpitApprovalSource` + `CockpitApprovalItem` from the package root `packages/shared/src/index.ts` (the explicit cockpit-type export list ~:1001 — Codex #6: types only in `cockpit.ts` aren't importable from `@armyofagents/shared`). Shared typecheck clean. Commit.
```bash
git add packages/shared/src/cockpit.ts
git commit -m "feat(shared): CockpitApprovalItem + approvals on CockpitData (Phase 3c)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend — founder-scoped approvals aggregation (TDD the scope)

**Files:** Modify `server/src/services/cockpit.ts`; test `server/src/__tests__/cockpit-approvals.test.ts`.

- [ ] **Step 1: Failing scope test** — assert founder gets the 3 sources queried + a non-founder gets `[]` (security):
```ts
// non-founder scope → approvals aggregation returns [] and queries NOT run
// founder scope → all 3 source queries run; items mapped with correct source discriminator
```
(Use the 3b mocked-service pattern: mock the 3 sub-queries; assert call/no-call by scope.)

- [ ] **Step 2: Implement `cockpitApprovals(db, companyId, scope)`** — **founder-only** (act-gates for approvals + discussion-items are founder-only server-side; the lead-active_context-memory case is a documented follow-up):
```ts
async function cockpitApprovals(db, companyId, scope): Promise<CockpitApprovalItem[]> {
  if (!scope.isFounder) return []; // founder-only display (strict subset → safe). lead/member → follow-up.
  const [approvals, memPending, discItems] = await Promise.all([
    // approvals: status in (pending, revision_requested) for companyId (+ linked issue title via issue_approvals)
    listPendingApprovals(db, companyId),
    // memory: listPending returns { items, versions, archives, totalCount } (NOT an array, Codex #2) —
    // 3c uses .items (new agent-suggested pending memory_items); versions/archives → follow-up.
    memoryService(db).listPending(companyId),
    // discussion items: extracted_items has discussionEntryId (NOT discussionId, Codex #3) — join
    // discussion_extracted_items -> discussion_entries (discussionId) -> discussions (companyId).
    listPendingExtractedItems(db, companyId),
  ]);
  return [
    ...approvals.map((a) => ({ source: "approval" as const, id: a.id, title: titleFor(a), subtitle: subtitleFor(a) })),
    ...memPending.items.map((m) => ({ source: "memory" as const, id: m.id, title: m.title, subtitle: `${m.layer}${m.category ? ` · ${m.category}` : ""}` })),
    ...discItems.map((d) => ({ source: "discussion_item" as const, id: d.id, discussionId: d.discussionId, title: d.title, subtitle: d.type })),
  ];
}
// listPendingExtractedItems: SELECT i.id, e.discussion_id AS discussionId, i.title, i.type
//   FROM discussion_extracted_items i
//   JOIN discussion_entries e ON e.id = i.discussion_entry_id
//   JOIN discussions d ON d.id = e.discussion_id
//   WHERE d.company_id = $companyId AND i.status = 'pending'
```
Wire it into `cockpitService.get`'s `Promise.all` and the returned `CockpitData.approvals`. (Confirm `memoryService.listPending` return shape + the discussion-item columns when wiring.)

- [ ] **Step 3:** Update the 3b `cockpit-service.test.ts` for the new `approvals` field (the `Promise.all` shape changed). Run server cockpit tests → green. Commit.

---

## Task 3: Frontend — `CockpitApprovalsCard` + inline approve/deny dispatcher

**Files:** Create `ui/src/components/commander/cockpit/CockpitApprovalsCard.tsx` + `ui/src/components/commander/cockpit/useCockpitApprovalAction.ts`; modify `CommanderCockpitPanel.tsx` (registry).

- [ ] **Step 1: The action dispatcher hook** — one place that maps `source` → the right API + the source's invalidation keys, with toast + cockpit invalidation (mirrors `MemoryApprovalActions`):
```ts
// useCockpitApprovalAction.ts — approve(item) / deny(item) by source
// approval        → approvalsApi.approve(item.id) / reject(item.id)        + invalidate approvals.list
// memory          → memoryApi.approve(companyId, item.id) / reject(companyId, item.id) + invalidate memory.pending/list
// discussion_item → approve: discussionsApi.approveItems(companyId, item.discussionId!, { items: [{ itemId: item.id, action: "approved" }] })
//                   reject:  discussionsApi.rejectItems(companyId, item.discussionId!, [item.id])  // Codex #4: reject takes an itemIds array
// ALWAYS: pushToast on success/error + invalidate queryKeys.cockpit(companyId)
```
- [ ] **Step 2: The card** (compact, ~280px) — header (⚑ Approvals · count); rows show `title` + a small `source` chip/`subtitle`; per row: **Approve** + **Deny** (h-7, `MemoryApprovalActions` styling) wired to the dispatcher, an **Ask ↩** (`onAsk`), and a **↗** opening the full page per source (`/approvals/:id` | `/memory` | `/discussions/:discussionId`). Optimistic: disable the row while pending; the cockpit invalidation removes it on success. `data-testid="cockpit-card-approvals"`.
- [ ] **Step 3: Thread `companyId` + register.** The registry `render` props are currently `{ data } & CockpitInteractions` and do NOT include `companyId` (Codex #5). Add `companyId: string` to the render-prop type, pass it at every `c.render({ data: cockpitData, companyId, ...interactions })` call site, and add `approvals: []` to `EMPTY_DATA` (else `CockpitData` requiring `approvals` breaks the panel). Then register: defaultOn true; `isActive: (d) => d.approvals.length > 0`; `render: ({ data, companyId, onOpenFullPage, onAsk }) => <CockpitApprovalsCard items={data.approvals} companyId={companyId} onOpenFullPage={onOpenFullPage} onAsk={onAsk} />`. `cd ui ; pnpm tsc -b` clean. Commit.

---

## Task 4: Tests + verification

**Files:** `ui/src/components/commander/cockpit/CockpitApprovalsCard.test.tsx`.

- [ ] **Step 1: Component tests** (mock the 3 api clients): card renders the unified items with correct source labels; clicking **Approve** on each source calls the RIGHT api (`approvalsApi.approve` for `approval`, `memoryApi.approve` for `memory`, `discussionsApi.approveItems` with `discussionId` for `discussion_item`); **Deny** likewise; the card is absent when `approvals` is empty (show-only-active).
- [ ] **Step 2: Static + unit** — `cd ui ; pnpm vitest run src/components/commander/` green; `pnpm tsc -b` clean; server: `pnpm vitest run cockpit` green (incl. the new approvals scope test); server typecheck clean.
- [ ] **Step 3: Live (pgvector)** — verify `/cockpit` returns an `approvals` array (founder); seed a pending approval if feasible (an agent hire in board-approval mode, or skip if env friction) and confirm it appears + Approve clears it; else assert the endpoint shape (`approvals` present) + the card registers + the viewer/3b regression stays green. Screenshot. (Multi-human founder-vs-member scoping is unit-tested, not e2e-able locally.)
- [ ] **Step 4:** Tear down; clean tree; do NOT finish the branch.

---

## Self-review (run after drafting; fix inline)

- **Scope:** Core 3 only (approvals/memory/discussion-items), founder-scoped; join-requests + runtime + lead-memory + the other 3c cards explicitly deferred to follow-ups. No schema change.
- **Security:** the aggregation returns `[]` for non-founders (unit-tested) → the cockpit shows a STRICT SUBSET (founders only) = safe, no escalation. The per-source approve endpoints enforce their EXISTING gates (Codex-verified): discussion-items = founder (`assertRole`); memory = `assertMemoryApproval` (founder, + lead for dept non-identity); approvals = **board-level** (`assertBoard`, NOT founder-only — a pre-existing server gate; the cockpit's founder-only *display* is stricter, not looser, so it introduces no new exposure). No new auth surface.
- **Reuse:** approve/deny via the existing api clients (no new endpoints); inline UI mirrors `MemoryApprovalActions`; one dispatcher keyed by `source` (single place to get the action+invalidation right per source).
- **Type consistency:** `CockpitApprovalItem` (T1) is built by the service (T2), shaped into the card (T3), exercised by the dispatcher + tests (T3/T4); `source` discriminator drives both the action and the ↗ route.
- **Live:** approvals ride the existing cockpit invalidation + 8s refetch; approve/deny invalidates `queryKeys.cockpit` for the optimistic clear ("the clear is the dopamine").
- **Bug-watch:** the discussion approve is BATCHED per discussion (needs `discussionId` on the item); confirm `memoryService.listPending` shape; the registry render must thread `companyId` to the card.
