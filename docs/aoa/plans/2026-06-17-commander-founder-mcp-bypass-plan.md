# Restrict Conversation-Ownership Founder Bypass to Board Actors

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close Codex's re-review P2 on `conversation-authz.ts:37` — a founder-created MCP (or agent) token currently gets the founder *read-anyone* bypass on Commander conversation routes. Restrict the founder bypass to interactive **board** actors so token-backed callers are always owner-scoped (they see only their own `userId`'s conversations), limiting token blast radius and enforcing least privilege.

**Architecture:** A one-condition change in the now-single-sourced `loadOwnedConversation` guard fixes all 6 conversation routes at once (the 5 internal-agent routes + memory-retrievals). The `local_implicit` and `instance_admin` bypasses are already board-gated; only the `getEffectiveRole`-based founder bypass currently runs for non-board actors. No schema change.

**Tech Stack:** Express, Drizzle, Vitest, the `getActorInfo`/`permissionService` authz layer.

---

## Background (verified against the code)

- `auth.ts:160-173`: an authenticated MCP key sets `req.actor = { type:"mcp", userId: mcpKey.userId, … }`. `mcpKey.userId` is the **creator** (`mcp/server.ts:337` `createKey(companyId, req.actor.userId, …)`).
- `getActorInfo` (`authz.ts:38-49`): for `type:"mcp"`, `actorId = req.actor.userId ?? "mcp-user"`. So a founder-created key → `actorId = founder's userId`.
- `loadOwnedConversation` (`conversation-authz.ts`): `isLocalImplicit`/`isInstanceAdmin` are board-gated (keep), but the `else` branch runs `getEffectiveRole(companyId, actorId)` for **any** remaining actor — including MCP. A founder's userId → `"founder"` → `isFounderRole = true` → the `userId` predicate is skipped → reads **any** conversation.
- **Pre-existing** (the extraction `d0f1ddb3e` was byte-identical) → affects all 6 conversation routes. **Only matters in `authenticated` multi-user** (`local_trusted` is single-user). Not a non-founder escalation — it's the founder's own delegated credential keeping founder reach; the risk is blast radius (token leak/over-share) + least privilege.
- **Confirmed no breakage:** no test asserts MCP founder-access to these routes; no prod MCP code calls them (grep). Agents are already owner-scoped (their `actorId` never matches a `conversation.userId`).

---

### Task 1: Restrict the founder bypass to board actors

**Files:**
- Modify: `server/src/routes/conversation-authz.ts` (the `isFounderRole` branch)
- Modify: `server/src/__tests__/memory-retrievals-authz.test.ts` (add the founder-MCP case)

- [ ] **Step 1: Write the failing test (founder-backed MCP token must be owner-scoped)**

In `memory-retrievals-authz.test.ts`, add a case using a **founder-role MCP actor** — `req.actor = { type:"mcp", userId: FOUNDER_ID, … }` with the mocked `getEffectiveRole` returning `"founder"` for `FOUNDER_ID` — hitting `GET /companies/:companyId/conversations/:conversationId/memory-retrievals` for a conversation owned by a DIFFERENT user. Assert:
- the response is **404** (not the rows) — the MCP token is owner-scoped, not founder-bypassed; and
- via the existing `eqSpy`, `eq(internalAgentConversations.userId, FOUNDER_ID)` **was** called (the `userId` predicate is applied for the MCP actor — proving the scope).
Add a companion positive case: the same founder-MCP token on a conversation it **owns** (`conversation.userId === FOUNDER_ID`) → rows (self-management still works).
**Codex plan-review P2:** also assert the mocked `getEffectiveRole` was **NOT called** for the founder-MCP actor (proves the role-based founder path is fully board-gated, not merely that the `userId` predicate was applied). Conversely, assert it **was** called for a board founder.

Run: `cd server && pnpm vitest run src/__tests__/memory-retrievals-authz.test.ts`
Expected: FAIL — today the MCP founder actor bypasses ownership and gets rows / no `userId` predicate.

- [ ] **Step 2: Tighten the guard**

In `server/src/routes/conversation-authz.ts`, replace the `isFounderRole` resolution with a board-gated version:

```ts
  const isBoard = req.actor.type === "board";

  let isFounderRole: boolean;
  if (isLocalImplicit || isInstanceAdmin) {
    isFounderRole = true;
  } else if (isBoard) {
    const role = await permissionService(db).getEffectiveRole(companyId, actor.actorId);
    isFounderRole = role === "founder";
  } else {
    // MCP / agent tokens are never founder-equivalent for conversation ownership.
    // A founder-created token is owner-scoped (sees only its own userId's
    // conversations), limiting token blast radius (Codex re-review P2). Interactive
    // founder access (read-anyone) is via board sessions only.
    isFounderRole = false;
  }
```

(`isLocalImplicit`/`isInstanceAdmin` are already `req.actor.type === "board"` checks, so loopback + instance-admin board access is unchanged. The `getEffectiveRole` lookup now runs only for board actors.)

**Codex plan-review P3 (documented):** `isInstanceAdmin` is set ONLY on `type:"board"` actors in `auth.ts` (loopback `:24`, session `:64`, board_key `:136`); MCP/agent actors never carry it. So a non-board `instance_admin` shape does not exist and the board gate cannot silently demote one. Add a one-line code comment to that effect so a future change to the actor shape re-examines this gate.

- [ ] **Step 3: Green + regression**

Run: `cd server && pnpm vitest run src/__tests__/memory-retrievals-authz.test.ts` → PASS (incl. the new founder-MCP cases).
Run: `cd server && pnpm vitest run src/__tests__/internal-agent-routes-contract.test.ts src/__tests__/internal-agent-reorder-auth.test.ts src/__tests__/commander-conversations-api.test.ts` → green (board founders + non-founders unchanged; the 5 internal-agent conversation routes behave identically for board actors).
Run: `cd server && pnpm tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/conversation-authz.ts server/src/__tests__/memory-retrievals-authz.test.ts
git commit -m "fix(commander): restrict conversation founder-bypass to board actors (Codex re-review P2)"
```

---

### Task 2: Verify + push + reply on the Codex thread

- [ ] **Step 1: Full server suite + typecheck**

Run: `cd server && pnpm vitest run` (report totals; note pre-existing unrelated failures) + `pnpm tsc --noEmit` clean.

- [ ] **Step 2: Push** (`git push` — branch already tracks origin).

- [ ] **Step 3: Reply on the Codex thread** (comment id `3425937316`, via the replies API — factual, no performative thanks):
```bash
gh api -X POST repos/MeteoriteLabs/AoA/pulls/194/comments/3425937316/replies \
  -f body="Fixed in <sha>. The founder bypass in loadOwnedConversation now requires req.actor.type === \"board\"; MCP/agent tokens (incl. founder-created keys) are always owner-scoped, so a token sees only its own userId's conversations (404 otherwise). Verified no prod MCP flow / test relies on token founder-access to these routes; board founder + non-founder behavior is unchanged. Added a founder-MCP-token test asserting 404 + the userId predicate. Note: getEffectiveRole is used the same way in discussions.ts / cockpit-scope.ts / marketplace-installs.ts — auditing those for the same property as a separate follow-up."
```

- [ ] **Step 4: Re-trigger Codex** (`gh pr comment 194 --body "@codex review"`) so it re-reviews the new head.

---

## Out of scope (flagged follow-up)

`getEffectiveRole` drives founder-equivalent decisions in `discussions.ts`, `cockpit-scope.ts`, and `marketplace-installs.ts` too. The same "founder-created MCP token resolves to founder" property likely applies there. This PR scopes to the conversation finding Codex raised; a separate task should audit those three surfaces and decide whether token-backed founder access should be board-gated consistently. (Spawn a background task.)

---

## Self-Review

**Spec coverage:** founder-MCP bypass closed → Task 1 (board-gated `isFounderRole` + founder-MCP 404 test + self-owned positive test) ✓; verify/push/reply/re-trigger → Task 2 ✓; broader pattern flagged → Out-of-scope ✓.

**Placeholder scan:** the guard change is full code; the test reuses the existing `eqSpy`/actor harness (read it first).

**Type consistency:** `req.actor.type === "board"` matches the `Actor` union (`express.d.ts`); `isFounderRole` stays a boolean; the `userId` predicate is unchanged.

**Risks:**
- A founder who *only* uses an MCP token (no board login) to manage OTHER users' conversations would now get 404 — intended; verified no such flow exists. Self-owned conversations still work (owner predicate matches).
- `local_implicit` (loopback `local_trusted`) is `type:"board"` → unchanged (founders keep full access in single-user mode).
- The change is in the shared guard, so it applies to all 6 conversation routes uniformly — the regression run (route-contract + reorder-auth + conversations-api) gates board-actor behavior.
