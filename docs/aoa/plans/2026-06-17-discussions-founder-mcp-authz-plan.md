# Fix HIGH founder-MCP authz bypass in discussions.ts (threads)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close a confirmed HIGH-severity authz bypass on the discussions/threads surface: `buildActor()` in `server/src/routes/discussions.ts` grants the founder/role bypass to **non-board bearer tokens** (a founder-created MCP key replays the founder's `userId` → resolves to "founder"), letting that token read other users' private threads, perform privileged writes, and dispatch agents. Restrict the role lookup to interactive **board** actors so MCP/agent tokens are confined to `team_member` (owner/participant-scoped) — the same pattern shipped for the conversation guard in PR #194 (`conversation-authz.ts`, commit `7ae21f3f6`).

**Branch / base:** `fix/discussions-founder-mcp-authz` off `feat/v1-combined` (the live integration branch; `discussions.ts`/`threads.ts` are identical to the commander branch, so this is the right independent base — NOT folded into the commander PR #194, a different surface). Worktree: `C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-v1`.

**Tech Stack:** Express, Drizzle, Vitest, the `getActorInfo`/`permissionService` authz layer, `threadService`.

---

## Background (audited, high confidence)

`buildActor(req, companyId)` (`discussions.ts:597-613`):
```ts
const info = getActorInfo(req);
const isHuman = req.actor.type === "board";
if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
  return { userId: info.actorId, role: "founder", isHuman };   // board-only sources
}
if (req.actor.type === "agent") {
  return { userId: info.actorId, role: "team_member", isHuman: false };
}
const perms = permissionService(db);
const role = await perms.getEffectiveRole(companyId, info.actorId);  // ← runs for mcp too!
return { userId: info.actorId, role, isHuman };
```
- `getActorInfo` maps an mcp actor's `actorId` to `req.actor.userId` (`authz.ts:44`); `auth.ts:160-173` sets `req.actor.userId = mcpKey.userId` (the founder creator). So a founder-created MCP token → `getEffectiveRole` → `"founder"`.
- The role flows into `threadService`'s `Actor`, which founder-bypasses `canViewThread`/`assertCanView` (read ANY thread incl. other users' private/unclaimed — `threads.ts:119-127,342-391`), `assertCanEdit` (transfer/add-participant/edit-plan/spin-off — `threads.ts:398-418`), and the founder-only `routeItem`/`assignScopeItems` service gates (`threads.ts:1225,1671`; `routeItem` also inserts an `agentWakeupRequests` row → dispatch/spend, `threads.ts:1701-1712`).
- Reachable: the discussions router has NO `assertBoard`; `assertCompanyAccess` admits an mcp actor whose companyId matches. The vulnerable routes are the **buildActor-only** ones (no `assertRole`): T.1 phase L0/L1, T.2 claim, T.3 transfer, T.4 addParticipant, T.7 scope GET, T.8 scope/plan PUT, spin-off, T.R1 routing PATCH, T.L1 links POST, T.L2 links GET, entries GET. (The `assertRole`-gated routes are already safe — `assertRole`→`getUserIdFromRequest` returns null for non-board → unauthorized before `getEffectiveRole`.)
- **Authenticated-multi-user only.** `local_trusted` takes the `local_implicit` branch (single-user loopback) → unchanged.

---

### Task 1: Gate `buildActor`'s role lookup on board actors

**Files:**
- Modify: `server/src/routes/discussions.ts` (`buildActor`, ~597-613)
- Test: `server/src/__tests__/discussions-founder-mcp-authz.test.ts` (new)

- [ ] **Step 1: Write the failing test (review-corrected harness — this is the part that matters)**

**Do NOT mirror `c2-thread-list-entries.test.ts`** — that test exercises the Commander internal-agent TOOL (`thread.listEntries`), not the HTTP route; it never builds `req.actor` or calls `buildActor`, so a test modeled on it would be **tautological** (passes pre- and post-fix). Instead mirror **two** patterns:
- The route-driving + actor/permission mocking pattern from the conversation-authz fix that shipped in PR #194: `git show 7ae21f3f6:server/src/__tests__/memory-retrievals-authz.test.ts` — it uses `supertest` to drive the REAL express route, mocks `permissionService`/`getActorInfo`/`assertCompanyAccess`, does NOT mock the guard, and asserts `getEffectiveRole` is/ isn't called per actor.
- The Drizzle sequence-DB pattern for the `threadService` reads: `server/src/__tests__/discussions-getbyid-plan.test.ts` (`seqDb`).

Drive **buildActor-only** routes (confirmed un-`assertRole`-gated): **entries GET** (read) and **`routeItem` PATCH** (write). The threads surface enforces role INSIDE `threadService` via extra DB reads, so queue the right sequences:
- **Read — founder-MCP denied (404):** actor `{ type:"mcp", userId: FOUNDER_ID }`, mocked `getEffectiveRole` → "founder" (must NOT be reached). entries GET → `entriesSince` → `getByIdInternal` → `assertCanView` (threads.ts ~342/426/536). Queue: (a) the thread row, (b) `threadParticipants` → `[]`, (c) `userRoles` → `[]` → `canViewThread` returns false for a `team_member` non-participant → **404**. Assert status 404 AND `getEffectiveRole` **not called**.
- **Read — board founder allowed (200):** actor `{ type:"board", … }`, `getEffectiveRole` → "founder". Queue the thread row → `assertCanView` early-returns at the founder check (~threads.ts:353) → **200**. Assert `getEffectiveRole` **is** called.
- **Write — founder-MCP denied:** `routeItem` PATCH with the mcp founder actor → the founder-only gate throws `notFound` BEFORE any DB read for a `team_member` (threads.ts ~1671) → denied. (No participant mocking needed for this case.) Assert denied + `getEffectiveRole` not called.
- **Board non-founder** (`type:"board"`, "team_member") → scoped as before (sanity, unchanged).

Run: `cd server && pnpm vitest run src/__tests__/discussions-founder-mcp-authz.test.ts`
Expected: FAIL — today the founder-MCP token resolves to "founder" and is allowed (200 / write succeeds).

- [ ] **Step 2: Apply the fix**

In `buildActor` (`discussions.ts`), insert a non-board guard BEFORE the `getEffectiveRole` call (after the agent branch):
```ts
    if (req.actor.type === "agent") {
      return { userId: info.actorId, role: "team_member", isHuman: false };
    }

    // Non-board bearer tokens (mcp) are NEVER founder/team_lead for thread
    // access: a founder-created MCP key replays the founder's userId, which
    // would otherwise resolve to "founder" via getEffectiveRole and grant
    // read-anyone + privileged writes + agent dispatch on the threads surface.
    // Confine them to team_member (participant/owner-scoped). Interactive
    // founder access is via board sessions only. (Mirrors conversation-authz.ts.)
    if (req.actor.type !== "board") {
      return { userId: info.actorId, role: "team_member", isHuman: false };
    }

    const perms = permissionService(db);
    const role = await perms.getEffectiveRole(companyId, info.actorId);
    return { userId: info.actorId, role, isHuman };
```
(The `local_implicit`/`isInstanceAdmin` board founder branch stays first and unchanged — those are board sources; `getEffectiveRole` now runs only for board sessions.)

- [ ] **Step 3: Green + regression**

Run: `cd server && pnpm vitest run src/__tests__/discussions-founder-mcp-authz.test.ts` → PASS.
Run: `cd server && pnpm vitest run "src/__tests__/c2-thread-*.test.ts" "src/__tests__/c2-inbox-attach-to-thread.test.ts" "src/__tests__/c2-workspace-request-for-thread.test.ts"` → green (board founder/member + agent behavior unchanged).
Run: `cd server && pnpm tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/discussions.ts server/src/__tests__/discussions-founder-mcp-authz.test.ts
git commit -m "fix(discussions): confine non-board tokens to team_member in buildActor (HIGH founder-MCP authz bypass)"
```

---

### Task 2: Verify + PR into feat/v1-combined

- [ ] **Step 1: Full server suite + typecheck**

Run: `cd server && pnpm vitest run` (report totals; note pre-existing unrelated/flaky live failures, e.g. `*.live.test.ts` that need a real CLI/DB) + `pnpm tsc --noEmit` clean.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin fix/discussions-founder-mcp-authz
```

- [ ] **Step 3: Open PR into `feat/v1-combined`**

`gh pr create --base feat/v1-combined --head fix/discussions-founder-mcp-authz` with a body describing the HIGH founder-MCP bypass, the board-gate fix (mirrors PR #194 `conversation-authz`), the authenticated-multi-user-only impact, and the test coverage. Trigger codex review (`@codex review`).

---

## Self-Review

**Spec coverage:** board-gate the role lookup → Task 1 Step 2; founder-MCP-denied + board-founder-allowed + getEffectiveRole-not-called tests → Task 1 Step 1; regression on existing thread tests → Step 3; PR → Task 2. ✓

**Placeholder scan:** the fix is full code; the test references the existing c2-thread harness to read first (flagged, not hand-waved — the threads route/threadService mock shape must be mirrored).

**Type consistency:** `buildActor` still returns `{ userId, role, isHuman }`; `req.actor.type === "board"` matches the `Actor` union; `role: "team_member"` is a valid role string (same as the agent branch).

**Risks:**
- A founder who manages threads ONLY via an MCP token (no board login) would now be team_member-scoped (can't act on others' threads) — intended; the audit found no prod flow relying on token founder-access to threads. Confirm via the regression run + a quick grep for mcp callers of the discussions routes.
- `local_implicit`/instance-admin board paths are first + unchanged → `local_trusted` single-user unaffected.
- The fix is one branch in one helper; the buildActor-only routes all inherit it. The `assertRole`-gated routes are already safe (documented).
- Broader sweep (other `getEffectiveRole` callers beyond the 4 audited) is out of scope here; cockpit-scope + marketplace-installs were audited clean (assertBoard-gated).
