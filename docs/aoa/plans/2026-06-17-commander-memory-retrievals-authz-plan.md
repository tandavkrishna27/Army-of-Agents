# Commander Memory-Retrievals Authz + Recall-Audit Completeness Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the two confirmed Codex P2 findings on PR [#194](https://github.com/MeteoriteLabs/AoA/pull/194): (1) the conversation `memory-retrievals` endpoint has no owner/founder guard (cross-user IDOR in authenticated multi-user mode); (2) the automatic Commander recall path doesn't record `conversationId`, so the Memory cockpit card's audit surface misses auto-recalled memory.

**Architecture:** Single-source the conversation-ownership authz: extract the existing `loadOwnedConversation` (currently a closure in `internal-agent.ts`) into a shared route module and reuse it in `memory-retrievals.ts` — duplicating a security guard risks drift, so DRY matters here. For #2, the `conversationId` is already available in the recall input (`agent-loop.ts:230` passes `conversation.id`); the `commander_context` audit call simply omits it — a one-line add. No schema change.

**Tech Stack:** Express, Drizzle ORM, Vitest, the existing `assertCompanyAccess`/`permissionService` authz layer.

---

## Background: both findings verified against the code

- **#1 (IDOR):** `memory-retrievals.ts:45-55` (conversation endpoint) guards with **only** `assertCompanyAccess(req, companyId)`. The analogous `/internal-agent/conversations/:convId/messages` route (`internal-agent.ts:1274`) calls `loadOwnedConversation` (def at `:110-143`), which enforces ownership in the WHERE clause (founder-equivalent bypass, else `userId` match) and throws 404 on mismatch. The issue endpoint (`:32-42`) is correctly company-scoped (tasks are company resources) and stays as-is.
- **#2 (audit gap):** `memory-recall.ts:472-485` (`triggeredBy:"commander_context"`) records **no** `conversationId`; the explicit `query_memory` tool (`memory-tools.ts:117-127`, `commander_query`) does. `agent-loop.ts:226-234` calls `recall({ … conversationId: conversation.id, scope: contextScope })`, so `input.conversationId` is populated. `listRetrievalsForConversation` (`memory.ts:1384`) filters by `companyId + conversationId` only (not `triggeredBy`), so once the audit row carries `conversationId` it shows in the card. One-line fix.

---

## File Structure

- **Create** `server/src/routes/conversation-authz.ts` — `loadOwnedConversation(db, req, companyId, convId)` (moved from internal-agent.ts, `db` becomes a param).
- **Modify** `server/src/routes/internal-agent.ts` — import the shared helper; delete the local closure; update its 5 call sites to pass `db`.
- **Modify** `server/src/routes/memory-retrievals.ts` — owner-guard the conversation endpoint; fix the stale RBAC doc comment.
- **Modify** `server/src/services/internal-agent/memory-recall.ts` — add `conversationId` to the `commander_context` audit call.
- **Create** `server/src/__tests__/memory-retrievals-authz.test.ts` — route owner-guard contract.
- **Modify** `server/src/__tests__/commander-memory-recall.test.ts` — assert the auto-recall audit row carries `conversationId`.

No DB migration. No UI change. The issue (task) memory-retrievals endpoint is intentionally untouched.

---

### Task 1: Extract `loadOwnedConversation` into a shared module

**Files:**
- Create: `server/src/routes/conversation-authz.ts`
- Modify: `server/src/routes/internal-agent.ts` (def `:110-143`, call sites `:1188,1209,1230,1252,1274`)

- [ ] **Step 1: Create the shared helper (move the body verbatim; `db` becomes the first param)**

```ts
// server/src/routes/conversation-authz.ts
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { internalAgentConversations } from "@armyofagents/db";
import { permissionService } from "../services/index.js";
import { getActorInfo } from "./authz.js";
import { notFound } from "../errors.js";

/**
 * Resolve a Commander conversation the actor is allowed to read, enforcing
 * ownership in the WHERE clause (not a separate 403) so non-owners can't
 * distinguish "exists" from "forbidden". Founder-equivalents (local_implicit
 * board, instance admin, founder role) bypass the userId scope; everyone else
 * is scoped to their own userId. Throws 404 on mismatch.
 *
 * Single-sourced authz: shared by internal-agent.ts (archive/pin/rename/delete/
 * messages) and memory-retrievals.ts (the conversation retrieval-audit endpoint).
 */
export async function loadOwnedConversation(
  db: Db,
  req: Request,
  companyId: string,
  convId: string,
) {
  const actor = getActorInfo(req);
  const isLocalImplicit =
    req.actor.type === "board" && req.actor.source === "local_implicit";
  const isInstanceAdmin =
    req.actor.type === "board" && req.actor.isInstanceAdmin === true;

  let isFounderRole: boolean;
  if (isLocalImplicit || isInstanceAdmin) {
    isFounderRole = true;
  } else {
    const role = await permissionService(db).getEffectiveRole(companyId, actor.actorId);
    isFounderRole = role === "founder";
  }

  const convConditions = [
    eq(internalAgentConversations.id, convId),
    eq(internalAgentConversations.companyId, companyId),
  ];
  if (!isFounderRole) {
    convConditions.push(eq(internalAgentConversations.userId, actor.actorId));
  }

  const [existing] = await db
    .select()
    .from(internalAgentConversations)
    .where(and(...convConditions));

  if (!existing) throw notFound("Conversation not found");
  return existing;
}
```

> Verify the import paths resolve from `routes/` (mirror internal-agent.ts: `permissionService` from `../services/index.js`, `getActorInfo` from `./authz.js`, `notFound` from `../errors.js`, `internalAgentConversations` from `@armyofagents/db`). Adjust if internal-agent.ts imports them from different paths.

- [ ] **Step 2: Rewire internal-agent.ts to use the shared helper**

- Add at the top with the other route imports: `import { loadOwnedConversation } from "./conversation-authz.js";`
- **Delete** the local `async function loadOwnedConversation(req, companyId, convId) { … }` (lines ~110-143, including its `// ── Conversation ownership helper ──` comment block).
- Update the 5 call sites (`:1188, 1209, 1230, 1252, 1274`) from `loadOwnedConversation(req, companyId, convId)` → `loadOwnedConversation(db, req, companyId, convId)`.

- [ ] **Step 3: Typecheck + regression-test the refactor (behavior must be unchanged)**

Run: `cd server && pnpm tsc --noEmit`
Run: `cd server && pnpm vitest run src/__tests__/internal-agent-routes-contract.test.ts src/__tests__/internal-agent-reorder-auth.test.ts`
Expected: clean + green — the archive/pin/rename/delete/messages ownership behavior is identical (pure move).

**Behavior-lock (Codex #2):** if the existing suite doesn't already assert it, add one focused case through a real call site (e.g. the messages route) that an existing conversation owned by a DIFFERENT non-founder user returns **404** (not 403, not rows) after the extraction — locks the existence-leak-safe property to the shared helper.

**Import-cycle hard-check (Codex #7):** `conversation-authz.ts` imports `permissionService` from `../services/index.js`. If that introduces a circular import (services barrel → … → routes) — surfaced as a tsc error or an undefined-at-load failure in the route-contract test — import `permissionService` from its direct module path (e.g. `../services/permissions.js`) instead. Don't leave it to chance; confirm the route module loads.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/conversation-authz.ts server/src/routes/internal-agent.ts
git commit -m "refactor(commander): extract loadOwnedConversation to a shared route module"
```

---

### Task 2: Owner-guard the conversation `memory-retrievals` endpoint

**Files:**
- Test: `server/src/__tests__/memory-retrievals-authz.test.ts`
- Modify: `server/src/routes/memory-retrievals.ts`

- [ ] **Step 1: Write the failing authz test**

Mirror the harness used by `internal-agent-routes-contract.test.ts` / `internal-agent-reorder-auth.test.ts` (mock `@armyofagents/db` + drizzle; drive the express handler with synthetic `req.actor`). **Do NOT mock `loadOwnedConversation`** (Codex #6 — that would prove wiring, not authz); drive the route against realistic mocked DB rows (a conversation row with a known `userId`) and observe the status/body outcome. Cover **every actor class** (Codex #1) for `GET /companies/:companyId/conversations/:conversationId/memory-retrievals`:
- **founder role** → rows for any conversationId in the company.
- **`local_implicit` board** (loopback) → rows (founder-equivalent bypass).
- **instance-admin board** → rows (founder-equivalent bypass).
- **non-founder board user whose `userId` === the conversation owner** → rows.
- **non-founder board user whose `userId` ≠ the owner** → **404** (not 403, not rows) — the existence-leak-safe path.
- **`agent` / `mcp` token actor** (non-founder) → **404** (its `actorId` is not a user id, so it never matches `conversation.userId`; only founder-equivalent agents/keys would pass) — lock this so the behavior is intentional and matches the `/conversations/:id/messages` guard.
- **Issue endpoint distinction (Codex #3):** add an explicit test that `GET /issues/:issueId/memory-retrievals` returns rows for a non-founder non-owner-of-anything actor (company-scoped, NO owner guard) — documents that this is intentional so a future reviewer doesn't over-restrict it.

Run: `cd server && pnpm vitest run src/__tests__/memory-retrievals-authz.test.ts`
Expected: FAIL (the conversation endpoint currently returns rows for a non-owner / agent actor).

- [ ] **Step 2: Add the guard**

In `server/src/routes/memory-retrievals.ts`:
- Import: `import { loadOwnedConversation } from "./conversation-authz.js";`
- In the conversation handler (`:45-55`), after `assertCompanyAccess(req, companyId)` and before `svc.listRetrievalsForConversation(...)`, add:

```ts
    // Per-user conversation: enforce owner/founder access (not just company
    // membership) — mirrors the /internal-agent/conversations/:id/messages guard.
    // Throws 404 on mismatch (no existence leak). The issue endpoint stays
    // company-scoped: tasks are company resources, not per-user.
    await loadOwnedConversation(db, req, companyId, conversationId);
```

- Fix the stale file-header RBAC comment (`:24-26`): replace "No additional gating — retrievals are scoped to the resource…" with a note that the **conversation** endpoint additionally enforces conversation ownership (founder bypass), while the **issue** endpoint is company-scoped.

- [ ] **Step 3: Green + no regression**

Run: `cd server && pnpm vitest run src/__tests__/memory-retrievals-authz.test.ts` → PASS.
Run: `cd server && pnpm tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/memory-retrievals.ts server/src/__tests__/memory-retrievals-authz.test.ts
git commit -m "fix(commander): owner-guard the conversation memory-retrievals endpoint (Codex P2 #1)"
```

---

### Task 3: Record `conversationId` on auto-recall (Codex P2 #2)

**Files:**
- Modify: `server/src/services/internal-agent/memory-recall.ts` (the `commander_context` audit call, `:472-479`)
- Modify: `server/src/__tests__/commander-memory-recall.test.ts`

- [ ] **Step 1: Extend the recall test to assert the audit row carries conversationId**

In `commander-memory-recall.test.ts`, drive the **real `commander_context` caller shape** (Codex #4) — `commanderMemoryRecallService(db).recall({ … conversationId: "<conv>", scope: { conversationId: "<conv>" } })`, mirroring how `agent-loop.ts:226-234` calls it — and assert the recorded `recordMemoryRetrievals` payload includes `conversationId: "<conv>"` AND `triggeredBy: "commander_context"`. Add a second case where `conversationId`/`scope.conversationId` are BOTH absent and assert the audit row records `conversationId: null` (documents the contract: the row is still written, just invisible to the conversation card — so a future caller that forgets conversationId is caught by the present-case test, not silently accepted). If `recordMemoryRetrievals` is mocked, assert the mock's call args; otherwise assert the inserted row.

Run: `cd server && pnpm vitest run src/__tests__/commander-memory-recall.test.ts`
Expected: FAIL on the new conversationId assertion (currently null/absent).

- [ ] **Step 2: Pass conversationId in the commander_context audit call**

In `memory-recall.ts`, the `recordMemoryRetrievals(db, { … triggeredBy: "commander_context", … })` call (`:472-479`) — add the field:

```ts
          await recordMemoryRetrievals(db, {
            companyId: input.companyId,
            agentId: input.agentId ?? null,
            taskId: input.scope?.taskId ?? null,
            runId: null,
            conversationId: input.conversationId ?? input.scope?.conversationId ?? null,
            triggeredBy: "commander_context",
            query,
            items: itemsForAudit,
          }).catch((err) => { /* unchanged */ });
```

> `recordMemoryRetrievals` already accepts `conversationId` (used by the `commander_query` path at memory-tools.ts:123). Confirm the audit input type includes it; if `RecordMemoryRetrievalsInput` lacks `conversationId`, add the optional field there too (it's already persisted to `memory_retrievals.conversationId`).

- [ ] **Step 3: Green**

Run: `cd server && pnpm vitest run src/__tests__/commander-memory-recall.test.ts` → PASS.
Run: `cd server && pnpm tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/internal-agent/memory-recall.ts server/src/__tests__/commander-memory-recall.test.ts
git commit -m "fix(commander): record conversationId on auto-recall so the Memory card shows it (Codex P2 #2)"
```

---

### Task 4: Full verification + reply on the Codex threads

- [ ] **Step 1: Full server suite + typecheck**

Run: `cd server && pnpm vitest run` (report totals; note pre-existing unrelated failures).
Run: `cd server && pnpm tsc --noEmit` → clean.

- [ ] **Step 2: Push**

```bash
git push   # feat/v1-commander-chat is already tracking origin
```

- [ ] **Step 3: Reply on the two Codex inline threads (not a top-level comment)**

Use the replies API on each comment id (from `gh api repos/MeteoriteLabs/AoA/pulls/194/comments`):
```bash
gh api -X POST repos/MeteoriteLabs/AoA/pulls/194/comments/3425385811/replies \
  -f body="Fixed — the conversation endpoint now calls loadOwnedConversation (extracted to a shared module) so non-owner non-founder actors get 404, matching the /conversations/:id/messages guard. The issue endpoint stays company-scoped by design. Commit <sha>."
gh api -X POST repos/MeteoriteLabs/AoA/pulls/194/comments/3425385814/replies \
  -f body="Fixed — the commander_context auto-recall path now records conversationId (it was already available in the recall input), so the Memory cockpit card shows auto-recalled retrievals, not just explicit query_memory calls. Commit <sha>."
```
(No gratitude/performative language — state the fix + commit, per receiving-code-review.)

- [ ] **Step 4: Report**

Summarize: both findings fixed, the shared-authz extraction, test counts, the codex thread replies, commit SHAs.

---

## Self-Review

**Spec coverage:** #1 owner-guard → Task 1 (extract) + Task 2 (apply + test) ✓; #2 conversationId on auto-recall → Task 3 (+ test) ✓; thread replies → Task 4 ✓.

**Placeholder scan:** Task 1's helper body is the verbatim move; Task 2/3 give exact insertions. Tests reference the existing harness to read first (Task 2 Step 1) — flagged, not hand-waved.

**Type consistency:** `loadOwnedConversation(db, req, companyId, convId)` signature is identical across the shared module, the 5 internal-agent.ts call sites, and the memory-retrievals.ts call. `conversationId` field name matches schema (`memory_retrievals.conversationId`) + the recall input + the existing `commander_query` usage.

**Risks:**
- The extraction touches a security-critical file (internal-agent.ts) across 5 call sites — Task 1 Step 3's regression run (route-contract + reorder-auth tests) gates it; behavior is a pure move (no logic change).
- `notFound` 404 (vs 403) is intentional (existence-leak prevention) — preserved.
- If `RecordMemoryRetrievalsInput` doesn't already type `conversationId`, add the optional field (the column already exists) — called out in Task 3 Step 2.
- Local-trusted single-user deployments see no behavior change (founder-equivalent bypass); the guard only affects authenticated multi-user.

---

## Codex plan-review resolutions (`ship-with-fixes` — applied)

- **#1 (P1) all actor classes** → Task 2 Step 1 now tests founder / local_implicit / instance-admin / non-founder owner / non-founder non-owner (404) / **agent·mcp token (404)**.
- **#6 (P3) no tautology** → Task 2 Step 1 explicitly does NOT mock `loadOwnedConversation`; it drives the route against mocked DB rows and observes status/body.
- **#2 (P2) 404 behavior-lock** → Task 1 Step 3 adds a non-owner-existing-conversation → 404 (not 403/rows) assertion through a real call site post-extraction.
- **#3 (P2) issue endpoint stays company-scoped** → Task 2 Step 1 adds an explicit positive test that the issue endpoint is NOT owner-guarded (intentional).
- **#4 (P2) require conversationId on the real auto-recall path** → Task 3 Step 1 drives the real `commander_context` caller shape and asserts the recorded `conversationId`; a both-absent case documents the null contract.
- **#5 (P2) recall-input contract visible** → covered by the present-case test in Task 3 (asserts the concrete agent-loop call records conversationId); not forcing the type to required (would risk other callers) — the test is the contract guard.
- **#7 (P3) import-cycle** → Task 1 Step 3 adds a hard load-check; fall back to the direct `permissionService` module path if the services barrel cycles.
