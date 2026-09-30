# Commander Cockpit — A4: Lead/Member Approval Scoping Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the cockpit Approvals card's blanket **founder-only** gate with **per-source RBAC scoping**, so a team_lead / team_member sees ONLY the approval items they can actually action (matching each action route's server authz — never an un-actionable item [404] or a forbidden one [leak]).

**Architecture:** Backend-only (`cockpitApprovals()` in `server/src/services/cockpit.ts`). The card is already source-agnostic — it renders whatever scoped `approvals[]` comes back. Drop `if (!scope.isFounder) return []`; run each source's query **conditionally** by role (cheaper than query-all-then-filter) + filter memory by the `canApproveMemory` rule replicated in-memory from `scope` (no per-item DB call). No shared-type / frontend / schema change.

**Per-source scoping (each row either MATCHES its action authz or is an intentional, documented UNDER-SHOW — two independent reviews confirmed: no LEAK, no 404):**
| Source | founder | team_lead | member | Action authz | Verdict |
|---|---|---|---|---|---|
| approval (hire) | ✅ all | ✗ | ✗ | `assertBoard` (`approvals.ts:124`) — **board-level, not founder** | **UNDER-SHOW (safe)** — hire is governance; founder-only is the conservative choice. A non-founder board member technically *could* action it but won't see it in the cockpit → safe, never a leak/404. |
| discussion_item | ✅ | ✗ | ✗ | `assertRole("founder")` (`discussions.ts:391`) | MATCH |
| memory_archive | ✅ | ✗ | ✗ | `assertRole("founder")` (`suggestions.ts:53`) | MATCH |
| join_request | ✅ | ✗ (defer grant) | ✗ | `joins:approve` grant (`access.ts:2362`) — grant-gated, not role | **UNDER-SHOW (safe)** — founders always hold the grant (`team.ts:28-29`), so founder visibility is always actionable; a delegated non-founder grant-holder is hidden (acceptable v1 under-show); never a leak. |
| **memory** | ✅ all layers | ✅ `layer≠identity` && `departmentId ∈ leadDepartmentIds` | ✗ | `canApproveMemory` (`permissions.ts:185-205`) | MATCH (byte-identical) |
| **memory_version** | ✅ | ✅ same memory rule (uses parent item's `layer`+`departmentId`) | ✗ | `assertMemoryApproval` on parent item (`memory.ts:630`) → `canApproveMemory` | MATCH — **contingent on Task 0** wiring `itemDepartmentId` into the version shape |
| **runtime_tool_trust** | ✅ own | ✅ own | ✅ own | owner-scoped `userId` — `deny`/`claimForExecution` both `eq(userId, decidedByUserId)` (`runtime-approvals.ts:227,255`) | MATCH |

**Tech Stack:** Express + Drizzle (one service fn + tests). No migration, no UI.

**Scope (v1):**
- IN: drop the blanket gate; conditional per-role queries; memory items + versions scoped to lead's depts (layer≠identity); runtime own-for-everyone; governance sources founder-only; tests.
- OUT → follow-ups: join_request grant-based (`joins:approve`) scoping for delegated leads (needs a per-user perm lookup — founder-only for now); discussion/archive dept-lead scoping (founder-only per current route authz).

**Verified anchors (read before editing):**
- `server/src/services/cockpit.ts` — `cockpitApprovals()` (~:515-560, the `if(!scope.isFounder) return []` + the internal `Promise.all` of the 5 queries + the 4-source mapping). The runtime query already filters `eq(userId, scope.userId)`.
- `server/src/services/cockpit-scope.ts` — `CockpitScope {userId, role, isFounder, leadDepartmentIds}`.
- The rule to replicate: `permissionService.canApproveMemory` (`server/src/services/permissions.ts:185-205`) — founder→true; else team_lead && `layer!=="identity"` && `departmentId` && `isTeamLeadForDepartment`(departmentId). Replicate IN-MEMORY using `scope.role`/`scope.leadDepartmentIds` (no per-item DB call).
- `memory_items` has `departmentId` + `layer`. **BUILD-VERIFY → RESOLVED:** `memoryService.listPending().versions[]` does **NOT** expose `departmentId` today (the version `select` at `memory.ts:1167-1181` omits it; `archives[]` DOES carry it — select alias `itemDepartmentId` at :1215, exposed on the mapped object as `archives[].item.departmentId` — but archive is founder-only anyway). **Decision = option (b):** add `itemDepartmentId: memoryItems.departmentId` to the version `select` (~:1167-1181) AND `itemDepartmentId: row.itemDepartmentId` to the mapped version shape (~:1244-1261) in `memory.ts` listPending — additive, safe (extra field; existing memory-UI consumers unaffected), so leads see their dept's version-edits consistently with items. `canApproveMemory` (`permissions.ts:185-205`) CONFIRMED EXACT: founder→true; else `team_lead && layer!=="identity" && departmentId && isTeamLeadForDepartment` — the plan's in-memory rule mirrors it byte-for-byte (`leadDepartmentIds` = the resolved set of `isTeamLeadForDepartment` depts).
- Tests: `server/src/__tests__/cockpit-approvals.test.ts` — HC1 currently asserts "non-founder → [] + NO sub-queries." A4 CHANGES this (non-founder now runs the runtime query [+ memory if lead]). Update HC1 + add lead/member cases.

---

## Task 0: Expose `itemDepartmentId` on `listPending().versions[]`

**Files:** `server/src/services/memory.ts` (listPending, ~:1154-1261).

- [ ] Add `itemDepartmentId: memoryItems.departmentId` to the version-rows `select` (the block at ~:1167-1181, alongside `itemLayer`).
- [ ] Add `itemDepartmentId: row.itemDepartmentId` to the mapped version object (the `versions = versionRows.map(...)` block at ~:1244-1261, alongside `itemLayer`).
- [ ] This is purely additive (a new property on each version) — existing memory-UI consumers are unaffected. Run `cd server; pnpm vitest run memory` to confirm no listPending test asserts an exact key set. Commit.

---

## Task 1: Per-source scoping in `cockpitApprovals()`

**Files:** `server/src/services/cockpit.ts`.

- [ ] **Replace** the blanket `if (!scope.isFounder) return []` with role-conditional queries:
```ts
const isFounder = scope.isFounder;
const isLead = scope.role === "team_lead";
const canSeeMemory = isFounder || isLead;

const [approvalRows, memPending, discItems, joinRows, runtimeRows] = await Promise.all([
  isFounder ? listPendingApprovals(db, companyId) : Promise.resolve([]),
  canSeeMemory ? memoryService(db).listPending(companyId) : Promise.resolve({ items: [], versions: [], archives: [], totalCount: 0 }),
  isFounder ? listPendingExtractedItems(db, companyId) : Promise.resolve([]),
  isFounder ? db.select({...}).from(joinRequests).where(...pending_approval) : Promise.resolve([]),
  // runtime: ALWAYS (owner-scoped) — every role sees their own pending tool approvals
  db.select({...}).from(internalAgentRuntimeApprovals).where(and(eq(companyId), eq(status,'pending'), gt(expiresAt, now), eq(userId, scope.userId))),
]);
```
- [ ] **TS pitfall (Codex):** a bare `Promise.resolve([])` may infer `never[]`/`unknown[]`, which then fails to feed the typed `.map((x): CockpitApprovalItem => ...)` chains. If `pnpm typecheck` complains, annotate the empty branches to the exact row type — e.g. `Promise.resolve([] as Awaited<ReturnType<typeof listPendingApprovals>>)` for approvals/discItems, and an inline-typed empty for the joinRows branch (matching the `db.select({...})` projection). The memory default already uses the full shape `{ items: [], versions: [], archives: [], totalCount: 0 }` (Codex nit — keep it). Founder output MUST stay byte-identical: do NOT reorder the `Promise.all` array or the final spread; only wrap each founder-only element in `isFounder ? … : <typed empty>`.
- [ ] **Memory item/version dept+layer filter** (replicate `canApproveMemory`):
```ts
const canApproveMem = (layer: string | null, departmentId: string | null) =>
  isFounder || (isLead && layer !== "identity" && !!departmentId && scope.leadDepartmentIds.includes(departmentId));
const memItems = memPending.items.filter((m) => canApproveMem(m.layer ?? null, m.departmentId ?? null));
const memVersions = memPending.versions.filter((v) => canApproveMem(v.itemLayer ?? null, v.itemDepartmentId ?? null /* added to listPending version shape in this slice */));
const memArchives = isFounder ? memPending.archives : []; // archive = founder governance
```
- [ ] **Map** as today, but from the scoped collections: `approvalRows`/`discItems`/`joinRows` (already `[]` for non-founder), `memItems`, `memVersions`, `memArchives`, `runtimeRows`. (Founder behavior is byte-identical to 3c+A1-3.)
- [ ] Keep the existing source mappings (titles/subtitles/relatedEntityId/decisionType). Commit.

---

## Task 2: Tests

**Files:** `server/src/__tests__/cockpit-approvals.test.ts` (update HC1 + add cases).

> **CRITICAL — sequence-mock is POSITIONAL (review B1/B2).** `buildSequenceDb` (`:94-103`) keys rows by the **global `db.select()` call index**. The outer `Promise.all` in `cockpitService.get` is eager and `cockpitApprovals` is slot 6 (runs BEFORE `cockpitPinned` slot 7); its inner `Promise.all` is also eager. **`memoryService.listPending` is a MOCKED SERVICE (`mockMemoryServiceListPending`), NOT a `db.select` — it NEVER consumes a sequence slot.** The only `db.select` inside `cockpitApprovals` for a non-founder is the always-on **runtime** query.
>
> **Post-A4 global select order:**
> - **FOUNDER — UNCHANGED, 12 selects:** `[0]`reminders `[1]`dueTasks `[2]`approvals `[3]`discItems `[4]`joinReqs `[5]`runtime `[6]`pinned `[7]`goalsAtRisk `[8]`companies(budget) `[9]`doneToday `[10]`proactive `[11]`teammates. (All existing founder tests stay green untouched.)
> - **MEMBER — now 7 selects (was 6):** `[0]`reminders `[1]`dueTasks `[2]`**runtime (NEW)** `[3]`pinned `[4]`goalsAtRisk `[5]`doneToday `[6]`proactive. (No approvals/discItems/joinReqs selects — gated off; budget non-founder = no select; teammates member = no select.) **Update the file-header sequence comment (`:29-36`) to this.**
> - **LEAD — same head as member** (`[0]`reminders `[1]`dueTasks `[2]`runtime `[3]`pinned `[4]`goalsAtRisk `[5]`doneToday `[6]`proactive) **plus teammates dept select(s) at the tail** (lead teammates is dept-scoped → fires ≥1 select). `listPending` runs for a lead but via its mock, not a slot. Determine the exact teammates tail empirically by running the test.

- [ ] **Founder (unchanged):** the existing founder suite (all 7 sources, the "all 7 combined" test) must stay green with NO edits — the founder branch runs identical queries/maps. Verify, don't rewrite.
- [ ] **HC1 rewrite — `team_member`:** put the runtime row at slot `[2]` (e.g. `buildSequenceDb([[], [], [runtimeRow], [], [], [], []])`); assert `result.approvals` contains exactly the one `runtime_tool_trust` item (`decisionType:"ternary"`), and NO approval/memory/discussion_item/join_request/memory_version/memory_archive. Keep the assertion **`expect(mockMemoryServiceListPending).not.toHaveBeenCalled()`** (members never see memory). Also add a member test with runtime slot `[2]=[]` → `approvals` empty.
- [ ] **NEW team_lead test:** `mockResolveCockpitScope.mockResolvedValue({ userId:"u-lead", role:"team_lead", isFounder:false, leadDepartmentIds:["dep-a"] })`; `mockReviewFilterFor.mockReturnValue({ projectIds:["dep-a"] })`; mock `listPending` with `items:[ {id:"m-ident",layer:"identity",departmentId:"dep-a",…}, {id:"m-ok",layer:"domain",departmentId:"dep-a",…}, {id:"m-other",layer:"domain",departmentId:"dep-b",…}, {id:"m-nodept",layer:"active_context",departmentId:null,…} ]` and one `versions:[{ itemId:"v-ok", itemLayer:"domain", itemDepartmentId:"dep-a", version:{id:"ver-1"}, … }]` plus one `versions` row in dep-b (excluded) and one `archives` row. Put runtime row at slot `[2]`. Assert: approvals includes **only** `memory:m-ok` + `memory_version:v-ok` + `runtime_tool_trust` — and EXCLUDES `m-ident` (identity), `m-other`/dep-b version (other dept), `m-nodept` (no dept), the archive (founder-only), and any approval/discussion/join. Assert `mockMemoryServiceListPending` **was** called for the lead.
- [ ] **Lead with empty `leadDepartmentIds`:** sees no memory (predicate yields none) + own runtime only.
- [ ] Run `cd server; pnpm vitest run cockpit; pnpm typecheck` green (adjust slot positions empirically if the teammates tail differs). Commit.

---

## Task 3: Verification

- [ ] **Static:** `(cd server && pnpm vitest run cockpit && pnpm typecheck)`; `pnpm --filter @armyofagents/shared typecheck`; `cd ui && pnpm tsc -b` (no UI change, but confirm).
- [ ] **Live (founder path unchanged + runtime own):** the running app's local-board is founder → confirm the Approvals card still shows all sources (no regression) + a seeded runtime row still resolves. (Lead/member sessions can't be produced in local_trusted — every local actor is the implicit founder — so the **lead/member scoping is unit-tested**; the runtime owner-scoping was already live-proven in A1-3. Note this in the report.)
- [ ] **Clean tree; do NOT finish the branch.**

---

## Self-review (run after drafting; fix inline)

- **Show-only-actionable (security core):** each source's cockpit visibility EXACTLY matches its action route's authz — governance (hire/discussion/archive/join) founder-only; memory via the `canApproveMemory` rule (layer≠identity + lead's dept); runtime owner-scoped. No un-actionable item shown (no 404 buttons), no forbidden item leaked.
- **No per-item DB call:** the memory filter replicates `canApproveMemory` in-memory from `scope` (role + leadDepartmentIds already resolved) — O(items), no N+1.
- **Conditional queries:** non-founders skip founder-only source queries (cheaper + matches visibility); runtime always runs (owner-scoped). HC1 test updated accordingly.
- **Founder unchanged:** the founder branch runs the identical queries/maps as 3c+A1-3 — zero behavior change for founders (the existing founder tests must stay green).
- **join_request founder-only (documented):** `joins:approve` is a grant needing a per-user lookup; deferring grant-based lead delegation (founder-only is the safe subset).
- **Bug-watch:** the version dept-scoping needs the item `departmentId` on the version shape — BUILD-VERIFY (else memory_version stays founder-only); the member path must not call `memoryService.listPending` (skip it); lead with empty `leadDepartmentIds` → sees no memory (the filter's `includes` yields none) + own runtime only.
