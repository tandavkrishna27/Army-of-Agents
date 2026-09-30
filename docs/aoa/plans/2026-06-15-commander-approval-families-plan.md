# Commander Cockpit — Approval Families (extend 3c card) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extend the existing founder-scoped cockpit **Approvals** card with four more sources: **join-requests**, **memory version queue**, **memory archive queue**, and **runtime tool-trust** (a 3-way allow-once / allow-always / deny). Purely additive to the 3c source-discriminated `CockpitApprovalItem[]` aggregation — no new `CockpitData` field, no schema change.

**Architecture:** Add 4 `source` discriminants + per-source mapping in `cockpitApprovals()` (still `if (!scope.isFounder) return []` — founder-only; lead/member scoping is a SEPARATE deferred slice). join_requests + runtime add new queries; memory versions + archives reuse the EXISTING `memoryService.listPending()` (which already returns `{items, versions, archives}` — 3c only used `items`). Extend `CockpitApprovalItem` with `relatedEntityId?` (versionId/suggestionId) + `decisionType?: "binary" | "ternary"`. The card renders 3 buttons (Always / Once / Deny) for `ternary`, 2 (Approve / Deny) otherwise; the dispatcher gains an `allowAlways` mutation.

**Tech Stack:** Express + Drizzle (2 new read queries + reuse memory queue), React (card 3-way branch + dispatcher). No schema/migration.

**Scope (v1):**
- IN: the 4 sources, founder-scoped, with approve/deny (+ allow-always for runtime); display title/subtitle; open-full-page + Ask; tests.
- OUT → follow-ups: lead/member approval scoping (A4 — keep founder-only here); any source whose action API proves gnarly (see memory-archive build-verify — defer just that source if needed, the others are clean).

**Verified anchors (read before editing):**
- 3c pattern: `server/src/services/cockpit.ts` — `cockpitApprovals(db,companyId,scope)` (~:505-550, founder gate `if(!scope.isFounder) return []`; internal `Promise.all` of `listPendingApprovals` + `memoryService(db).listPending(companyId)` + `listPendingExtractedItems`; maps each to `CockpitApprovalItem`); `approvalTitle`/`approvalSubtitle` (~:176-188). `packages/shared/src/cockpit.ts` `CockpitApprovalSource` (~:20) + `CockpitApprovalItem` (~:22-30). `ui/src/components/commander/cockpit/CockpitApprovalsCard.tsx` (`SOURCE_LABELS` ~:20, `fullPageRoute` ~:27, `ApprovalRow` ~:36-122). `ui/src/components/commander/cockpit/useCockpitApprovalAction.ts` (`invalidateAll`/`approveItem`/`denyItem` + the approve/deny mutations).
- Sources: `join_requests` (`status='pending_approval'`, `requestType` human|agent, `requestingUserId`/`agentName`, companyId) — actions `accessApi.approveJoinRequest(companyId,id)`/`rejectJoinRequest(companyId,id)` (`ui/src/api/access.ts:102-109`). `internal_agent_runtime_approvals` (`status='pending'`, `expiresAt`, `toolName`, companyId) — 3-way `POST /companies/:cid/internal-agent/confirm {confirmId, decision}` (`server/src/routes/internal-agent.ts:35-49,343`); decisions `["allow_once","allow_always","deny"]` (`packages/shared/src/constants.ts:952`). Memory: `memoryService.listPending` `.versions` (→ `memoryApi.approveVersion(companyId,itemId,versionId)`/`rejectVersion`, `ui/src/api/memory.ts:143-146`) + `.archives` (`{item, suggestion}`).
- **RESOLVED action APIs (Codex-verified — both clean, ship all 4):** (a) **memory-archive** → `suggestionsApi.accept(companyId, suggestionId)` / `suggestionsApi.dismiss(companyId, suggestionId)` (`ui/src/api/suggestions.ts:9-12`); the server accept executes the `archive_memory` action. NOT deferred. (b) **runtime confirm** → `internalAgentApi.confirmAction(companyId, confirmId, decision)` already exists (`ui/src/api/internal-agent.ts:309`, wraps `POST …/internal-agent/confirm`) — do NOT add a module.
- **Full-page routes:** use `/memory/explore` (NOT `/memory`, which redirects) for memory/memory_version/memory_archive (Codex #5; matches `PendingReviewPill.tsx:31`).

---

## Task 1: Shared type extension

**Files:** `packages/shared/src/cockpit.ts`.

- [ ] Extend `CockpitApprovalSource`:
```ts
export type CockpitApprovalSource =
  | "approval" | "memory" | "discussion_item"
  | "join_request" | "memory_version" | "memory_archive" | "runtime_tool_trust";
```
- [ ] Extend `CockpitApprovalItem` (additive optionals — existing items unaffected):
```ts
  relatedEntityId?: string;            // memory_version: versionId · memory_archive: suggestionId
  decisionType?: "binary" | "ternary"; // "ternary" → runtime_tool_trust (Always/Once/Deny); default binary
```
Shared typecheck clean. Commit. (No `CockpitData` change — same `approvals: CockpitApprovalItem[]` array; no fan-out.)

---

## Task 2: Backend — 4 new sources in `cockpitApprovals()`

**Files:** `server/src/services/cockpit.ts`; tests `server/src/__tests__/cockpit-approvals.test.ts` (extend) + maybe `cockpit-approval-families.test.ts`.

- [ ] **Imports:** add `joinRequests`, `internalAgentRuntimeApprovals` from `@armyofagents/db`; `gt` from `drizzle-orm` (confirm). Keep the founder gate.
- [ ] **Two new queries** in the internal `Promise.all` (after the existing 3):
  - join_requests: `select {id, requestType, requestingUserId, agentName} from joinRequests where companyId AND status='pending_approval'`.
  - runtime: `select {id, toolName, params, expiresAt} from internalAgentRuntimeApprovals where companyId AND status='pending' AND gt(expiresAt, new Date()) AND eq(userId, scope.userId)` — **MUST filter by `userId` (Codex #1 BLOCKER):** the confirm route is owner-scoped, so a founder seeing OTHER users' pending tool approvals would 404 on confirm. Show only the viewer's OWN pending tool confirmations (every shown row is actionable). (runtime tool-trust is inherently per-user; this is correct even within the founder-only card.)
- [ ] **Map all 4** into the returned array:
  - `join_request`: `{source:"join_request", id:j.id, title: j.requestType==="agent" ? (j.agentName ?? "Agent join request") : (j.requestingUserId ?? "User join request"), subtitle: j.requestType==="agent" ? "Agent join" : "User join"}`.
  - `memory_version` (reuse `memPending.versions`): `{source:"memory_version", id:v.itemId, relatedEntityId:v.version.id, title:v.itemTitle, subtitle:[v.itemLayer,v.itemCategory].filter(Boolean).join(" · ")+" (edit)"}`.
  - `memory_archive` (reuse `memPending.archives`): `{source:"memory_archive", id:a.item.id, relatedEntityId:a.suggestion.id, title:a.item.title, subtitle:"Suggested for archival"}`. (SHIP it — `suggestionsApi.accept/dismiss` is the confirmed action API, Codex #2.)
  - `runtime_tool_trust`: `{source:"runtime_tool_trust", id:r.id, title:r.toolName, subtitle:"Tool execution approval", decisionType:"ternary"}`.
- [ ] **Stub coupling (Codex #3 — precise):** `cockpitApprovals` now fires **2 more** `db.select` (joinRequests + runtime) inside its internal Promise.all. In `cockpit-approvals.test.ts`, insert **two empty arrays** for joinRequests + runtime into EVERY **founder** `buildSequenceDb` sequence (positioned with the other cockpitApprovals sub-queries — i.e. before the pinned slot that follows), and update the sequence comments. Feed the mocked `memoryService.listPending` non-empty `versions`/`archives` fixtures (currently `[]`) for the mapping tests. **Non-founder** sequences stay at 6 selects (cockpitApprovals returns before sub-queries) — keep/add an assertion that `memoryService.listPending` is NOT called and the founder-only `[]` holds.
- [ ] **Unit tests:** founder gets join_request + memory_version + memory_archive + runtime items mapped with the right source/title/relatedEntityId/decisionType; runtime excludes expired (`gt(expiresAt)`); non-founder → `[]` (no new sub-queries). Commit.

---

## Task 3: Frontend — labels, routes, dispatcher (3-way), card buttons

**Files:** `CockpitApprovalsCard.tsx`, `useCockpitApprovalAction.ts`; tests.

- [ ] **BUILD-VERIFY first** (per anchors): confirm (a) the memory-archive accept/reject API + (b) the runtime `confirmAction` UI api (add `ui/src/api/internal-agent.ts` `confirm(companyId,{confirmId,decision})` if missing, mirroring the route). Quote what you find before wiring.
- [ ] **`SOURCE_LABELS`** += `join_request:"Join request"`, `memory_version:"Memory edit"`, `memory_archive:"Archive"`, `runtime_tool_trust:"Tool trust"`.
- [ ] **`fullPageRoute`** += join_request → the access/join-requests page (verify the route), memory_version/memory_archive → `/memory`, runtime_tool_trust → (no full page / `/settings` runtime approvals if one exists; else omit the external-link button when no route).
- [ ] **`useCockpitApprovalAction`** — extend `approveItem`/`denyItem`/`invalidateAll` for the 4 sources (join → accessApi; memory_version → memoryApi.approveVersion/rejectVersion with `item.relatedEntityId!`; memory_archive → the verified accept/reject; runtime → confirm with `allow_once`/`deny`). Add an **`allowAlways`** mutation (runtime only → confirm `allow_always`). Invalidate `queryKeys.cockpit` always + the source-specific keys (join-requests, memory pending/list, runtime). Return `{approve, deny, allowAlways}`.
- [ ] **`ApprovalRow`** — branch on `item.decisionType === "ternary"`: render **Always** (allowAlways) + **Once** (approve) + **Deny** (deny); else the existing Approve/Deny. `busy` includes `allowAlways.isPending/isSuccess`. Keep the Ask↩ + open-full-page.
- [ ] `cd ui ; pnpm tsc -b` clean. Commit.

---

## Task 4: Tests + verification

- [ ] **Component tests** (`CockpitApprovalsCard.test.tsx` extend): a `runtime_tool_trust` item renders 3 buttons (Always/Once/Deny) + Always→allowAlways(allow_always), Once→approve(allow_once), Deny→deny; a binary item still renders 2; each new source dispatches the right API (mock the apis); SOURCE_LABELS render.
- [ ] **Static + unit:** `(cd server && pnpm vitest run cockpit && pnpm typecheck)`; `(cd ui && pnpm vitest run src/components/commander/ && pnpm tsc -b)`; `pnpm --filter @armyofagents/shared typecheck`.
- [ ] **Live (reuse Docker DB + app, local-board=founder):** seed one row per source — a `join_requests` (pending_approval, requestType human), a `memory_items`+`memory_item_versions` (approved item + pending version), a `suggestions` (archive_memory pending) + its memory item, an `internal_agent_runtime_approvals` (pending, expiresAt future). `GET /cockpit` → assert `approvals` contains all 4 new sources with correct shape (+ runtime has `decisionType:"ternary"`). Browser: Approvals card shows them; the runtime row shows 3 buttons; click Once/Deny → row resolves (DELETE/confirm). Screenshot. Also seed an EXPIRED runtime row → assert it's NOT in approvals.
- [ ] **Clean tree; do NOT finish the branch.**

---

## Self-review + Codex review (both applied)

**Codex review — 5 findings, all applied:**
1. BLOCKER — runtime query MUST filter `eq(userId, scope.userId)` (confirm route is owner-scoped; cross-user rows would 404). Applied in Task 2.
2. IMPORTANT — do NOT defer memory_archive; wire `suggestionsApi.accept/dismiss` (Task 3). All 4 sources ship.
3. IMPORTANT — stub sequences: +2 empty slots (join/runtime) in every founder sequence; non-founder stays 6 + assert listPending not called (Task 2).
4. NICE — `internalAgentApi.confirmAction(companyId, id, decision)` already exists; use it (no new module).
5. NICE — full-page routes use `/memory/explore` (not `/memory`).

- **Additive + founder-only:** new sources extend the same `approvals[]` array (no `CockpitData` change); the `!scope.isFounder → []` gate is unchanged (lead/member scoping is the deferred A4 slice).
- **Reuse:** memory versions/archives reuse the existing `memoryService.listPending` (no new query); only join_requests + runtime add selects. Card/dispatcher/type all extended (not rewritten).
- **3-way correctness:** `decisionType:"ternary"` only on runtime; Always=allow_always, Once=allow_once, Deny=deny → `POST /internal-agent/confirm`. Binary sources unaffected.
- **Expiry:** runtime query filters `gt(expiresAt, now)` (expired approvals never shown). Verified live (seed an expired row → absent).
- **relatedEntityId:** memory_version carries versionId, memory_archive carries suggestionId — the dispatcher uses `item.relatedEntityId!` for those; other sources don't set it.
- **Stub coupling:** cockpit-approvals.test.ts gets +2 selects (join/runtime) + non-empty versions/archives fixtures; non-founder still `[]` with no sub-queries.
- **Bug-watch:** the memory-archive + runtime-confirm action APIs are BUILD-VERIFIED (defer memory_archive if its API is unclear); the join-request full-page route exists; the runtime row with no full-page route hides the external-link button gracefully.
