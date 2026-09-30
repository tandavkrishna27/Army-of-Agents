# Fix founder-MCP authz bypass across internal-agent.ts (single-sourced role gate)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the founder-MCP-token authz bypass in the remaining `internal-agent.ts` spots (the sibling of the `loadOwnedConversation` fix in PR #194 and the `discussions.ts` fix in PR #195). A founder-created MCP key replays the founder's `userId`, so `getEffectiveRole` returns `"founder"` for the token at three more places — granting it founder-level Commander **tool dispatch**, **capability confirmation**, and (HIGH) a **cross-user conversation list** leak. Fix by extracting ONE board-gated `resolveActorRole` helper and using it everywhere, so the role rule is single-sourced (no drift).

**Branch / base:** `feat/v1-commander-chat` (the commander surface; PR #194 already created `conversation-authz.ts` + fixed `loadOwnedConversation` here, and modified `internal-agent.ts` heavily — so these sibling fixes belong on the same branch to stay coherent and avoid merge conflicts). Worktree: `C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-commander`. The commits land in **PR #194** (or a stacked branch off it). `feat/v1-combined` receives the fix when #194 merges; its standalone exposure is covered then. (Out of scope: re-fixing on v1-combined independently — would conflict with #194's internal-agent.ts changes.)

**Tech Stack:** Express, Drizzle, Vitest, the `getActorInfo`/`permissionService` authz layer.

---

## Background (audited, high confidence — verified on this branch, HEAD 7ae21f3f6)

The identical shape appears at three spots in `server/src/routes/internal-agent.ts`, each gated only by `assertCompanyAccess` (admits mcp actors):
```ts
const isLocalImplicit  = req.actor.type === "board" && req.actor.source === "local_implicit";
const isInstanceAdmin  = req.actor.type === "board" && req.actor.isInstanceAdmin === true;
if (isLocalImplicit || isInstanceAdmin) { /* founder */ }
else { const role = await getEffectiveRole(companyId, actor.actorId); /* ← runs for mcp! */ }
```
- **`:166-186` — chat `/send`** → `userRole` ("the role string used for tool-dispatch authorization"). Founder-MCP token → `"founder"` → founder-level Commander tool dispatch in the SSE chat turn. **Medium-High.**
- **`:402-416` — `/confirm`** → `currentUserRole` for the runtime-tool-trust confirmation (re-fetched fresh to avoid stale-permission execution). Founder-MCP token → `"founder"` → founder-level capability confirmation/execution. **Medium-High.**
- **`:1005-1028` — conversations LIST** → `isFounder`; `if (!isFounder) conditions.push(eq(userId, actor.actorId))`. Founder-MCP token → `isFounder=true` → the `userId` filter is **dropped** → it lists **every user's** Commander conversations in the company. **HIGH (direct cross-user read leak).**

`getActorInfo` maps an mcp actor's `actorId` to `req.actor.userId` (`authz.ts:44`), and `auth.ts:166-173` sets `req.actor.userId = mcpKey.userId` (the founder creator). `local_implicit`/`isInstanceAdmin` are board-only (auth.ts). **Authenticated-multi-user only** (`local_trusted` is single-user loopback board → unchanged). `loadOwnedConversation` (PR #194) already board-gates the conversation-detail case; these are the un-fixed siblings.

---

## File Structure
- **Modify** `server/src/routes/conversation-authz.ts` — add + export a board-gated `resolveActorRole(db, req, companyId): Promise<UserRole>`; refactor `loadOwnedConversation` to use it (single-source the role rule).
- **Modify** `server/src/routes/internal-agent.ts` — replace the 3 inline role resolutions with `resolveActorRole` (list: `isFounder = role === "founder"`).
- **Create** `server/src/__tests__/internal-agent-founder-mcp-authz.test.ts` — route-level authz contract for the 3 spots.
- **Modify** `server/src/__tests__/conversation-authz.role.test.ts` (new or extend) — unit-test `resolveActorRole`.
- Regression: `memory-retrievals-authz.test.ts` (loadOwnedConversation refactor must stay green).

---

### Task 1: Extract the board-gated `resolveActorRole` helper

**Files:** Modify `server/src/routes/conversation-authz.ts`; Test `server/src/__tests__/conversation-authz-role.test.ts`

- [ ] **Step 1: Write the failing unit test**

`server/src/__tests__/conversation-authz-role.test.ts` — import `resolveActorRole`; mock `permissionService.getEffectiveRole`; drive with synthetic `req.actor`. Assert:
- local_implicit board → `"founder"` (no `getEffectiveRole` call).
- instance-admin board → `"founder"` (no call).
- board session, `getEffectiveRole` → "founder" → `"founder"` (call made).
- board session, "team_member" → `"team_member"`.
- **mcp actor (founder userId), `getEffectiveRole` would return "founder"** → `"team_member"` AND `getEffectiveRole` **NOT called**.
- agent actor → `"team_member"` (no call).

Run: `cd server && pnpm vitest run src/__tests__/conversation-authz-role.test.ts` → FAIL (no export yet).

- [ ] **Step 2: Implement `resolveActorRole` + refactor `loadOwnedConversation`**

In `server/src/routes/conversation-authz.ts`:
```ts
import type { UserRole } from "@armyofagents/shared"; // or wherever UserRole is defined — match loadOwnedConversation's import

/**
 * Board-gated effective role for a Commander actor. Founder-equivalence is
 * conferred ONLY to interactive board sessions (local_implicit / instance
 * admin / founder role); MCP & agent BEARER TOKENS are always team_member —
 * a founder-created MCP key replays the founder's userId, which must NOT grant
 * founder reach to a token. Single-sources the rule used by loadOwnedConversation
 * and the internal-agent chat/confirm/list routes.
 */
export async function resolveActorRole(
  db: Db,
  req: Request,
  companyId: string,
): Promise<UserRole> {
  const isBoard = req.actor.type === "board";
  if (isBoard && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
    return "founder";
  }
  if (!isBoard) return "team_member"; // mcp / agent tokens
  const actor = getActorInfo(req);
  const role = await permissionService(db).getEffectiveRole(companyId, actor.actorId);
  return (role as UserRole) ?? "team_member";
}
```
Then refactor `loadOwnedConversation` to derive `isFounderRole` from it:
```ts
export async function loadOwnedConversation(db, req, companyId, convId) {
  const actor = getActorInfo(req);
  const isFounderRole = (await resolveActorRole(db, req, companyId)) === "founder";
  const convConditions = [ eq(id, convId), eq(companyId) ];
  if (!isFounderRole) convConditions.push(eq(userId, actor.actorId));
  // …unchanged…
}
```
(Behavior identical to the PR #194 board-gate — board founder bypasses, mcp/agent scoped — now single-sourced.)

- [ ] **Step 3: Green + regression**

Run: `cd server && pnpm vitest run src/__tests__/conversation-authz-role.test.ts src/__tests__/memory-retrievals-authz.test.ts src/__tests__/founder-messages-access.test.ts` → PASS (helper + loadOwnedConversation behavior unchanged; the last two drive loadOwnedConversation via the real route incl. the founder-MCP→404 + board-founder-reads-others cases). `pnpm tsc --noEmit` clean.

- [ ] **Step 4: Commit**
```bash
git add server/src/routes/conversation-authz.ts server/src/__tests__/conversation-authz-role.test.ts
git commit -m "refactor(commander): extract board-gated resolveActorRole; loadOwnedConversation uses it"
```

---

### Task 2: Apply `resolveActorRole` to the 3 internal-agent spots

**Files:** Test `server/src/__tests__/internal-agent-founder-mcp-authz.test.ts`; Modify `server/src/routes/internal-agent.ts`

- [ ] **Step 1: Write the failing route-level test (review-corrected harness)**

Use the BEST existing harness per spot (do NOT hand-roll):
- **chat `/send` + `/confirm`:** clone the setup in **`server/src/__tests__/confirm-stale-permissions.test.ts`** — it already drives the SSE chat route AND the confirm route via supertest (the SSE "streaming" concern is already solved: the mocked `agentLoopService.chat` async-generator completes immediately and supertest awaits the full response), with `runtimeApprovalService`, `createToolRegistry` (a `requiredRole:"founder"` tool), `executeTool`, `getActorInfo`, `permissionService`, and the DB chains mocked. It already asserts `executeTool` received `expect.objectContaining({ userRole: "team_member" })`. For the new test, flip the actor to `{ type:"mcp", userId: FOUNDER_ID }` with `getEffectiveRole`→"founder" and assert: (a) the demoted role `"team_member"` reaches `executeTool` (confirm) and `agentLoopService.chat`'s first-arg `userRole` (chat — it's a `vi.fn()`, assert `mockChat.mock.calls[0][0].userRole === "team_member"`); (b) `getEffectiveRole` is NOT called.
- **conversations LIST:** mirror **`memory-retrievals-authz.test.ts`**'s `eqSpy` technique — founder-MCP token (`getEffectiveRole`→"founder") → assert `eq(internalAgentConversations.userId, FOUNDER_ID)` IS applied (own-scoped, not list-all) and `getEffectiveRole` NOT called. Board founder → userId condition NOT applied + `getEffectiveRole` called.
- Board-founder controls for all 3 → unchanged behavior.

Run: `cd server && pnpm vitest run src/__tests__/internal-agent-founder-mcp-authz.test.ts` → FAIL (today founder-MCP → founder at all 3). (NOTE: `commander-conversations-api.test.ts` / `commander-confirm-flow.test.ts` are source-TEXT contract anchors, not behavioral proof — they stay green because the `isFounder`/`claimForExecution` identifiers remain; this NEW behavioral test is the actual fix proof.)

- [ ] **Step 2: Replace the 3 inline resolutions**

In `internal-agent.ts`, import `resolveActorRole` from `./conversation-authz.js` and replace each block:
- `:166-186` → `const userRole = await resolveActorRole(db, req, companyId);` (drop the local isLocalImplicit/isInstanceAdmin/getEffectiveRole lines).
- `:402-416` → `const currentUserRole = await resolveActorRole(db, req, companyId);`.
- `:1005-1019` → `const isFounder = (await resolveActorRole(db, req, companyId)) === "founder";`.
Remove the now-dead `isLocalImplicit`/`isInstanceAdmin` locals at each site (keep any still used elsewhere). Keep `actor = getActorInfo(req)` where the userId is still needed (list conditions, confirm calls). **Also remove the now-dead `permissionService` import (internal-agent.ts:28)** — after the 3 replacements it has no remaining callers in the file (verify with a grep; `noUnusedLocals` is off so it won't fail the gate, but it's dead code).

- [ ] **Step 3: Green + regression + typecheck**

Run: `cd server && pnpm vitest run src/__tests__/internal-agent-founder-mcp-authz.test.ts` → PASS.
Run the commander route regression: `cd server && pnpm vitest run src/__tests__/internal-agent-routes-contract.test.ts src/__tests__/commander-conversations-api.test.ts src/__tests__/commander-confirm-flow.test.ts src/__tests__/commander-tool-permissions.test.ts` → green (board/local_implicit behavior unchanged).
`cd server && pnpm tsc --noEmit` clean.

- [ ] **Step 4: Commit**
```bash
git add server/src/routes/internal-agent.ts server/src/__tests__/internal-agent-founder-mcp-authz.test.ts
git commit -m "fix(commander): board-gate chat/confirm/list role resolution (HIGH founder-MCP authz bypass)"
```

---

### Task 3: Verify + push + reviews

- [ ] **Step 1: Full server suite + tsc** (note pre-existing/flaky `*.live.test.ts`).
- [ ] **Step 2: Push** `feat/v1-commander-chat` (updates PR #194).
- [ ] **Step 3: Reviews** — substitute code-reading subagent review of the diff (Codex CLI is rate-limited until Jun 18); re-trigger the Codex bot on PR #194 (`@codex review`) once credits return.

---

## Self-Review

**Spec coverage:** all 3 spots (chat dispatch, confirm, list-leak) → Task 2; single-sourced helper + loadOwnedConversation DRY → Task 1; the HIGH list-leak gets the eqSpy own-scope assertion; board controls each. ✓

**Placeholder scan:** helper + replacements are full code; the route test mirrors a named existing harness (read it first). The `UserRole` import path must match `internal-agent.ts`'s existing import (verify).

**Type consistency:** `resolveActorRole` returns `UserRole`; spot 3 compares `=== "founder"`; `loadOwnedConversation` keeps its signature. The mcp/agent → `"team_member"` matches the existing fallback string.

**Risks:**
- Refactoring `loadOwnedConversation` (PR #194-shipped) to use the helper is behavior-identical; the `memory-retrievals-authz.test.ts` regression gates it. If any subtlety differs (e.g. it needs `team_lead` distinctions the helper flattens), keep `loadOwnedConversation`'s `isFounderRole` derivation but still board-gate — the helper only needs to agree on the founder boolean.
- The chat `/send` and `/confirm` role feeds downstream tool/capability authorization; demoting a founder-MCP token to team_member there is the intended least-privilege outcome — confirm no legitimate founder-MCP automation depends on founder tool dispatch (grep for mcp callers; none found in the prior audit).
- `local_trusted` unaffected (local_implicit board → founder).
- Branch coordination: lands via PR #194; do NOT also patch v1-combined (conflict). The discussions fix (PR #195) is independent and already separate.

## Plan-review resolutions (substitute subagent, `ship-with-fixes` — applied)
- All 3 bypasses confirmed real (LIST = HIGH); `getEffectiveRole` appears exactly 3× in internal-agent.ts (no 4th spot missed); `resolveActorRole` fully fixes them + preserves loadOwnedConversation's founder-boolean semantics (no team_lead nuance lost); team_member floor fails CLOSED downstream (`authorizeToolInvocation` returns FORBIDDEN_ROLE, no crash).
- **Test harness corrected** (Task 2 Step 1): mirror `confirm-stale-permissions.test.ts` for chat/confirm (already drives both routes + asserts `userRole:"team_member"` reaches `executeTool`/`chat`); `memory-retrievals-authz.test.ts` eqSpy for the LIST own-scope.
- **Dead `permissionService` import** removed after the refactor (Task 2 Step 2).
- Regression run includes `founder-messages-access.test.ts` (Task 1 Step 3).
- **Follow-up (out of scope):** the same `local_implicit/isInstanceAdmin → founder; else getEffectiveRole` shape exists in ~12 other route files (routines/issues/agents/access/sidebar-badges/…). Most are board-only-gated (mcp blocked upstream) or intended; audit those that admit mcp via `assertCompanyAccess` AND let the role grant privilege, as a separate sweep.
