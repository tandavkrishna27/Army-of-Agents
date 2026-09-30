# Crew Dispatch Hardening (Spec A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four live safety holes in AoA's existing crew (`kind='aoa'`) **dispatch** so the crew-task executor (Spec B) can be built on a sound foundation.

**Architecture:** Three of these are standalone bug fixes; one (A1) is a routing correction. The keystone is a single **kind-aware enqueue chokepoint** that every assignment site routes through (crew → dispatcher with role stamped; org → heartbeat), fixing A1's silent drops and A2's enqueue-side role stamp together. The crew-role lookup lives in a **leaf module** so it can be shared by the chokepoint and the dispatcher without dragging the `issues`/`heartbeat` graph into either. The remaining changes are surgical dispatcher edits (autonomy fail-closed, budget pre-flight, run-count brake).

**Tech Stack:** Express 5, Drizzle ORM, PostgreSQL, vitest. Server in `server/src/`, schema in `packages/db/src/schema/`. Drizzle ORM only — never raw SQL.

> **Revised after adversarial plan review (2026-06-01).** Changes from v1: A4 (service-level status guard) **deferred to Spec B** (it belongs with the crew status tool and carries a Commander-actorType policy decision); `resolveCrewRole` extracted to a leaf module + validated against the `CrewRole` set; the bogus "PATCH-1250 assignment" anchor removed (PATCH assignment flows through `update`→`dependency_unblocked`, already covered); budget import path corrected; dispatcher tests use **module-mocks** to avoid the positional-sequence harness breaking; the comment-mention crew-drop surface (`routes/issues.ts:553`) explicitly marked **deferred, not fixed**.

---

## Context — the four holes (all proven live by adversarial review)

| ID | Hole | Root cause (file:line) | Live symptom today |
|----|------|------------------------|--------------------|
| **A1** | Crew-assigned tasks silently dropped | Assignment sites call `heartbeat.wakeup()` with no kind check; `heartbeat.ts:4355` refuses `kind='aoa'` (`heartbeat.skipped.aoa_kind`, returns null). | Assign / auto-approve / dependency-unblock a crew task → it never dispatches. The Drive auto-approve path (`crew-task-service.ts:206`) is one of these. |
| **A2** | Autonomy dial bypassed for task wakeups | `dispatcher.ts:407` only gates `if (payloadRole && …)`; assignment payloads carry no `role`, so the gate is skipped. | Reassign a task to a crew agent at Manual → it executes. |
| **A3** | No budget cap on the crew path | Dispatcher has no pre-spend check; `getInvocationBlock` (`budgets.ts:315`) has zero callers. | A per-agent hard-stop budget is advisory for crew runs. |
| **A5** | Runaway brake inert for CLI crew | `dispatcher.ts:435` counts only `costCents>0` runs; CLI crew runs report $0; the T1.9 run-count brake was never built. | A crew dispatch/mention loop has no working brake. |

**Deferred to Spec B (not in this plan):**
- **A4** (agent self-complete guard) — belongs at the service layer *next to* the crew status tool, and decides Commander's actorType. Tracked for Spec B.
- The comment-`@mention` crew-drop at `routes/issues.ts:553` (and the dual-dispatch nuance at `:1266`) — a separate A1-class surface; **explicitly out of scope here.** This plan fixes the **assignment** sites, not comment-mention sites.

**Spec A vs Spec B.** This plan hardens dispatch. It does **not** build the executor (no `{issueId}` runner branch, no task trigger directive, no checkout claim, no new task tools, no A4 guard — all Spec B). After Spec A, a crew-assigned task routes correctly to the dispatcher and is gated by dial/budget/brake, but still **no-ops** when run (no task directive yet). Expected, not a regression.

**Decision #100 respected.** A1 routes crew to the AoA dispatcher (via `enqueueAoaMentionWakeup`), never the heartbeat.

---

## File structure

**New files:**
- `server/src/services/internal-agent/aoa-agents/resolve-crew-role.ts` — **leaf** module (imports only `drizzle-orm` + `@armyofagents/db`). Exports `resolveCrewRole(db, agentId): Promise<CrewRole | null>` — resolves the agent's crew role from `aoaAgentTriggers.config.role`, **validated against the `CrewRole` set** (unknown/absent → `null`). Imported by both the chokepoint and the dispatcher; importing it drags NO service graph into the dispatcher.
- `server/src/services/issue-assignee-wakeup.ts` — the kind-aware enqueue chokepoint. Exports `enqueueIssueAssigneeWakeup(db, input)`.

**Modified files:**
- `server/src/services/issue-assignment-wakeup.ts` — `queueIssueAssignmentWakeup` keeps its early-return guards, takes `db`, delegates to the chokepoint (A1).
- `server/src/routes/issues.ts` — CREATE assignment (~1022) routes through the chokepoint (A1). **PATCH assignment is NOT a separate site** — it flows through `svc.update`→`dependency_unblocked`, covered below.
- `server/src/services/crew-task-service.ts` — `approveAndDispatch` loop (~199-211) → one chokepoint call per `(assignee, issueId)` (A1).
- `server/src/services/dependencies.ts` — `fireWakeups` (~23-33) routes through the chokepoint; `WakeTask` gains `companyId` (A1).
- `server/src/services/issues.ts` — the `dependency_unblocked` wakeup (~1290-1298) routes through the chokepoint (A1).
- `server/src/routes/discussions.ts` — scope-approval dispatch (~1417-1431) routes through the chokepoint (A1).
- `server/src/routes/routines.ts:777` — pass `db` (not `heartbeat`) to `queueIssueAssignmentWakeup` (A1 signature change).
- `server/src/services/internal-agent/aoa-agents/dispatcher.ts` — fail-closed autonomy gate (A2), budget pre-flight (A3), run-count brake (A5).

**Test files (new):**
- `server/src/__tests__/resolve-crew-role.test.ts` (A1/A2 leaf)
- `server/src/__tests__/issue-assignee-wakeup.test.ts` (A1)
- `server/src/__tests__/crew-task-service-dispatch.test.ts` (A1)
- `server/src/__tests__/dispatcher-autonomy-failclosed.test.ts` (A2)
- `server/src/__tests__/dispatcher-budget-preflight.test.ts` (A3)
- `server/src/__tests__/dispatcher-run-count-brake.test.ts` (A5)

**Test files to MIGRATE (the dispatcher edits shift its mock sequence):**
- `server/src/__tests__/aoa-dispatcher.test.ts` — A2/A3 are handled by **module-mocking** `resolve-crew-role.js` + `budgets.js` in this suite (so they add no real `db.select` to the positional sequence). A5 adds one real `internalAgentRuns` select → the affected fixtures (those reaching the rate-brake) must add a slot. This migration is a step inside the relevant tasks below, not a free pass.
- `server/src/__tests__/issues-planning-mode.integration.test.ts:72,87` — call `queueIssueAssignmentWakeup({ heartbeat, … })`; update to the new `db` signature (A1).

Test pattern reference: `server/src/__tests__/aoa-dispatcher.test.ts` (`makeSeqDb`/`makeConcurrencyDb` positional mocks; `db._sets` captures every `update().set()` — assert `_sets.find(s => s.status === …)`; `runAoaMock` is mockable). `server/src/__tests__/inbox-attach.test.ts` (service `vi.mock` patterns).

---

## Task 1: A1/A2 — leaf role resolver + kind-aware enqueue chokepoint

**Files:**
- Create: `server/src/services/internal-agent/aoa-agents/resolve-crew-role.ts`
- Create: `server/src/services/issue-assignee-wakeup.ts`
- Test: `server/src/__tests__/resolve-crew-role.test.ts`, `server/src/__tests__/issue-assignee-wakeup.test.ts`

- [ ] **Step 1: Write the failing test for the leaf resolver**

```ts
// server/src/__tests__/resolve-crew-role.test.ts
import { describe, it, expect } from "vitest";
import { resolveCrewRole } from "../services/internal-agent/aoa-agents/resolve-crew-role.js";

function makeDb(rows: Array<{ config: Record<string, unknown> | null }>) {
  return { select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }) } as any;
}

describe("resolveCrewRole", () => {
  it("returns the first VALID CrewRole found across the agent's triggers", async () => {
    expect(await resolveCrewRole(makeDb([{ config: { role: "engineer" } }]), "a1")).toBe("engineer");
  });
  it("returns null when no trigger carries a role", async () => {
    expect(await resolveCrewRole(makeDb([{ config: {} }]), "a2")).toBeNull();
  });
  it("returns null for an UNKNOWN role string (e.g. the 'member' template default)", async () => {
    expect(await resolveCrewRole(makeDb([{ config: { role: "member" } }]), "a3")).toBeNull();
    expect(await resolveCrewRole(makeDb([{ config: { role: "typo" } }]), "a4")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-threads/server" && pnpm exec vitest run src/__tests__/resolve-crew-role.test.ts`
Expected: FAIL — `Cannot find module '.../resolve-crew-role.js'`.

- [ ] **Step 3: Write the leaf resolver**

```ts
// server/src/services/internal-agent/aoa-agents/resolve-crew-role.ts
import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { aoaAgentTriggers } from "@armyofagents/db";
import { ROLE_MIN_AUTONOMY, type CrewRole } from "./autonomy.js";

const KNOWN_ROLES = new Set<string>(Object.keys(ROLE_MIN_AUTONOMY));

/**
 * A1/A2: resolve a crew agent's role for the autonomy gate. The role lives in
 * aoaAgentTriggers.config.role (NOT runtimeConfig.aoa.role, which is the literal
 * "member" template default — dispatcher.ts:403). Kind-agnostic on purpose: an
 * assignee's role must resolve regardless of which trigger kind carries it
 * (the Adjutant's is a 'sweep' trigger, Scout/Engineer's is 'mention'). The
 * result is VALIDATED against the CrewRole set so an unknown/garbage role (incl.
 * "member") returns null and fails closed consistently with an absent role.
 */
export async function resolveCrewRole(db: Db, agentId: string): Promise<CrewRole | null> {
  const rows = await db
    .select({ config: aoaAgentTriggers.config })
    .from(aoaAgentTriggers)
    .where(eq(aoaAgentTriggers.agentId, agentId));
  for (const r of rows) {
    const role = (r.config as Record<string, unknown> | null)?.role;
    if (typeof role === "string" && KNOWN_ROLES.has(role)) return role as CrewRole;
  }
  return null;
}
```

- [ ] **Step 4: Run it (passes)** — same command. Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for the chokepoint**

```ts
// server/src/__tests__/issue-assignee-wakeup.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockResolveAgentKinds = vi.fn();
const mockEnqueueAoa = vi.fn().mockResolvedValue(undefined);
const mockHeartbeatWakeup = vi.fn().mockResolvedValue(undefined);
const mockResolveCrewRole = vi.fn();

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ resolveAgentKinds: mockResolveAgentKinds, enqueueAoaMentionWakeup: mockEnqueueAoa }),
}));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => ({ wakeup: mockHeartbeatWakeup }) }));
vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({ resolveCrewRole: mockResolveCrewRole }));

import { enqueueIssueAssigneeWakeup } from "../services/issue-assignee-wakeup.js";

describe("enqueueIssueAssigneeWakeup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("crew → dispatcher enqueue with role stamped, NOT heartbeat", async () => {
    mockResolveAgentKinds.mockResolvedValue(new Map([["a1", "aoa"]]));
    mockResolveCrewRole.mockResolvedValue("engineer");
    await enqueueIssueAssigneeWakeup({} as any, { companyId: "co", agentId: "a1", issueId: "i1", source: "assignment", reason: "issue_assigned", mutation: "create" });
    expect(mockHeartbeatWakeup).not.toHaveBeenCalled();
    expect(mockEnqueueAoa).toHaveBeenCalledWith("co", "a1", expect.objectContaining({
      source: "assignment", reason: "issue_assigned",
      payload: expect.objectContaining({ issueId: "i1", mutation: "create", role: "engineer" }),
    }));
  });

  it("org → heartbeat, NOT dispatcher", async () => {
    mockResolveAgentKinds.mockResolvedValue(new Map([["a2", "org"]]));
    await enqueueIssueAssigneeWakeup({} as any, { companyId: "co", agentId: "a2", issueId: "i2", source: "assignment", reason: "issue_assigned" });
    expect(mockEnqueueAoa).not.toHaveBeenCalled();
    expect(mockHeartbeatWakeup).toHaveBeenCalledWith("a2", expect.objectContaining({ payload: expect.objectContaining({ issueId: "i2" }) }));
  });

  it("crew with null role → enqueues without a role key (dispatcher fail-closes it)", async () => {
    mockResolveAgentKinds.mockResolvedValue(new Map([["a3", "aoa"]]));
    mockResolveCrewRole.mockResolvedValue(null);
    await enqueueIssueAssigneeWakeup({} as any, { companyId: "co", agentId: "a3", issueId: "i3", source: "assignment", reason: "issue_assigned" });
    expect("role" in mockEnqueueAoa.mock.calls[0][2].payload).toBe(false);
  });
});
```

- [ ] **Step 6: Run it (fails — chokepoint missing)** — Expected: FAIL.

- [ ] **Step 7: Write the chokepoint**

```ts
// server/src/services/issue-assignee-wakeup.ts
import type { Db } from "@armyofagents/db";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";
import { resolveCrewRole } from "./internal-agent/aoa-agents/resolve-crew-role.js";
import { logger } from "../middleware/logger.js";

export interface AssigneeWakeupInput {
  companyId: string;
  agentId: string;
  issueId: string;
  source: "assignment" | "automation";
  reason: string;
  mutation?: string;
  extraPayload?: Record<string, unknown>;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
}

/**
 * A1+A2 chokepoint. Callers must apply their own dispatch eligibility guards
 * (status!=='backlog', shouldDispatchIssueWakeup(workMode)) BEFORE calling —
 * this function only does kind-aware enqueue. All service factories are called
 * lazily inside the body (the issues↔heartbeat import cycle is eval-safe only
 * because of this; never call a factory at module top level).
 */
export async function enqueueIssueAssigneeWakeup(db: Db, input: AssigneeWakeupInput): Promise<void> {
  const issuesSvc = issueService(db);
  const kinds = await issuesSvc.resolveAgentKinds([input.agentId]);
  const isAoa = kinds.get(input.agentId) === "aoa";
  const basePayload: Record<string, unknown> = {
    issueId: input.issueId,
    ...(input.mutation ? { mutation: input.mutation } : {}),
    ...(input.extraPayload ?? {}),
  };

  if (isAoa) {
    const role = await resolveCrewRole(db, input.agentId);
    await issuesSvc.enqueueAoaMentionWakeup(input.companyId, input.agentId, {
      source: input.source,
      reason: input.reason,
      payload: role ? { ...basePayload, role } : basePayload,
    });
    return;
  }

  await heartbeatService(db)
    .wakeup(input.agentId, {
      source: input.source,
      triggerDetail: "system",
      reason: input.reason,
      payload: basePayload,
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issueId, source: input.reason },
    })
    .catch((err) => logger.warn({ err, issueId: input.issueId, agentId: input.agentId }, "failed to wake org assignee"));
}
```

- [ ] **Step 8: Run both new suites (pass)**

Run: `cd ".../server" && pnpm exec vitest run src/__tests__/resolve-crew-role.test.ts src/__tests__/issue-assignee-wakeup.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/resolve-crew-role.ts server/src/services/issue-assignee-wakeup.ts server/src/__tests__/resolve-crew-role.test.ts server/src/__tests__/issue-assignee-wakeup.test.ts
git commit -m "feat(crew): leaf crew-role resolver + kind-aware assignee-wakeup chokepoint (A1/A2 core)"
```

---

## Task 2: A1 — route every ASSIGNMENT site through the chokepoint

Sites (assignment only — comment-mention sites are explicitly out of scope): CREATE (`routes/issues.ts:1022`), crew-task-service auto-approve (`:206`), dependency unblock (`dependencies.ts:26` + `issues.ts:1292`), scope-approval (`discussions.ts:1421`), and the shared `queueIssueAssignmentWakeup`. **PATCH assignment is already covered** — it flows through `svc.update`→`dependency_unblocked`.

**Files:** as listed in File structure (A1 modified files) + `server/src/__tests__/crew-task-service-dispatch.test.ts`, and the integration-test caller update.

- [ ] **Step 1: Write the failing test (crew-task-service routes per-task)**

```ts
// server/src/__tests__/crew-task-service-dispatch.test.ts
import { describe, it, expect, vi } from "vitest";
const mockEnqueueAssignee = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/issue-assignee-wakeup.js", () => ({ enqueueIssueAssigneeWakeup: mockEnqueueAssignee }));
import { dispatchCreatedCrewTasks } from "../services/crew-task-service.js";

describe("crew-task-service dispatch", () => {
  it("enqueues one wakeup PER task (carrying issueId), skipping null assignees and planning-mode tasks", async () => {
    const created = [
      { id: "i1", assigneeAgentId: "scout", workMode: "standard" },
      { id: "i2", assigneeAgentId: "engineer", workMode: "standard" },
      { id: "i3", assigneeAgentId: null, workMode: "standard" },
    ];
    await dispatchCreatedCrewTasks({} as any, "co", created as any);
    expect(mockEnqueueAssignee).toHaveBeenCalledTimes(2);
    expect(mockEnqueueAssignee).toHaveBeenCalledWith({} as any, expect.objectContaining({ issueId: "i1", agentId: "scout", reason: "crew_task_auto_approved" }));
  });
});
```

- [ ] **Step 2: Run it (fails — not exported)** — Expected: FAIL.

- [ ] **Step 3: Implement `dispatchCreatedCrewTasks` + rewire `approveAndDispatch`**

In `crew-task-service.ts`, add (top-level export) and replace the loop at `:199-211`:
```ts
import { enqueueIssueAssigneeWakeup } from "./issue-assignee-wakeup.js";
import { shouldDispatchIssueWakeup } from "../routes/issues-planning-mode-dispatch.js";

export async function dispatchCreatedCrewTasks(
  db: Db,
  companyId: string,
  createdTasks: Array<{ id: string; assigneeAgentId: string | null; workMode: string | null }>,
): Promise<void> {
  for (const t of createdTasks) {
    if (!t.assigneeAgentId) continue;
    if (!shouldDispatchIssueWakeup({ workMode: t.workMode })) continue;
    await enqueueIssueAssigneeWakeup(db, {
      companyId, agentId: t.assigneeAgentId, issueId: t.id,
      source: "automation", reason: "crew_task_auto_approved",
    });
  }
}
```
Replace the old `for (const assigneeAgentId of distinctAssignees) { await hb.wakeup(...) }` block with `await dispatchCreatedCrewTasks(db, args.companyId, createdTasks);` (`db` = the service closure var; `args.companyId` per `crew-task-service.ts:140`).

- [ ] **Step 4: Run it (passes)** — Expected: PASS.

- [ ] **Step 5: Rewire the remaining assignment sites (rely on Task-1 chokepoint coverage)**

`routes/issues.ts` CREATE (`:1017-1035`): replace the `heartbeat.wakeup(issue.assigneeAgentId, {... mutation:"create"})` block with:
```ts
void enqueueIssueAssigneeWakeup(db, {
  companyId: issue.companyId, agentId: issue.assigneeAgentId, issueId: issue.id,
  source: "assignment", reason: "issue_assigned", mutation: "create",
  requestedByActorType: actor.actorType, requestedByActorId: actor.actorId,
}).catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on create"));
```
(Keep the surrounding `!wakeSkippedReason && issue.assigneeAgentId && shouldWakeAssignedAgent` guard.)

`services/dependencies.ts` `fireWakeups` (`:23-33`): add `companyId` to `WakeTask` (`:11-15`) and to every `tasksToWake` construction site (the `resolveDependencies` caller has `companyId`/`existing.companyId` in scope). Replace the body:
```ts
for (const wake of tasks) {
  if (!shouldDispatchIssueWakeup({ workMode: wake.workMode })) continue;
  await enqueueIssueAssigneeWakeup(db, {
    companyId: wake.companyId, agentId: wake.agentId, issueId: wake.issueId,
    source: "automation", reason: "dependency_unblocked",
  });
}
```

`services/issues.ts` `dependency_unblocked` wakeup (`:1290-1298`): replace the `heartbeat.wakeup(wake.agentId, {... reason:"dependency_unblocked", payload:{issueId}})` with `enqueueIssueAssigneeWakeup(db, { companyId: existing.companyId, agentId: wake.agentId, issueId: wake.issueId, source: "automation", reason: "dependency_unblocked" })`.

`routes/discussions.ts` scope-approval (`:1417-1431`): replace `heartbeat.wakeup(task.assigneeAgentId, ...)` with `enqueueIssueAssigneeWakeup(db, { companyId, agentId: task.assigneeAgentId, issueId: task.id, source: "assignment", reason: "deliverable_created", mutation: "create" })`. Keep the existing `shouldDispatchIssueWakeup({ workMode: task.workMode })` guard.

`services/issue-assignment-wakeup.ts` `queueIssueAssignmentWakeup`: change the input from `{ heartbeat; issue; … }` to `{ db; issue; … }`. **Keep** the early-return guard (`!assigneeAgentId || status==='backlog' || !shouldDispatchIssueWakeup(...)`), then delegate:
```ts
return enqueueIssueAssigneeWakeup(input.db, {
  companyId: input.issue.companyId, agentId: input.issue.assigneeAgentId, issueId: input.issue.id,
  source: "assignment", reason: input.reason, mutation: input.mutation,
  requestedByActorType: input.requestedByActorType, requestedByActorId: input.requestedByActorId,
}).catch((err) => { logger.warn({ err, issueId: input.issue.id }, "failed assignee wake"); if (input.rethrowOnError) throw err; return null; });
```
(`input.issue` must include `companyId` — add it to the interface and the caller's object.) Then:
- `routes/routines.ts:777`: pass `db` instead of `heartbeat`.
- `server/src/__tests__/issues-planning-mode.integration.test.ts:72,87`: update the call to the `db` signature (pass the test db, drop the fake `heartbeat`). Mock `enqueueIssueAssigneeWakeup` if these assert on dispatch.

- [ ] **Step 6: Run the full server suite**

Run: `cd ".../server" && pnpm exec vitest run`
Expected: PASS. If `issues-planning-mode.integration.test.ts` fails, it is because its call wasn't migrated to the `db` signature — fix it.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/issues.ts server/src/services/crew-task-service.ts server/src/services/dependencies.ts server/src/services/issues.ts server/src/services/issue-assignment-wakeup.ts server/src/routes/discussions.ts server/src/routes/routines.ts server/src/__tests__/crew-task-service-dispatch.test.ts server/src/__tests__/issues-planning-mode.integration.test.ts
git commit -m "fix(crew): route all assignment dispatch sites through kind-aware chokepoint (A1)"
```

---

## Task 3: A2 — fail-closed autonomy gate

Phase-3 only processes `kind='aoa'` agents, so EVERY wakeup here is crew. Resolve the role from `payload.role` OR the leaf `resolveCrewRole`, and treat an unresolved role as **not active below Drive (L2)**.

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/dispatcher.ts:406-420`
- Test: `server/src/__tests__/dispatcher-autonomy-failclosed.test.ts` (new) + migrate `aoa-dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

Module-mock the leaf so it adds NO real `db.select` to the harness sequence:
```ts
// dispatcher-autonomy-failclosed.test.ts — reuse aoa-dispatcher.test.ts's makeConcurrencyDb harness
vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({ resolveCrewRole: vi.fn() }));
// assertions:
// 1) company autonomy 0, payload has no role, resolveCrewRole→null  → _sets contains {status:'skipped_autonomy'}, runAoaMock NOT called.
// 2) company autonomy 0, resolveCrewRole→'engineer' (min 1)         → skipped_autonomy.
// 3) company autonomy 2, resolveCrewRole→null                       → NOT skipped; proceeds to claim/dispatch.
```

- [ ] **Step 2: Run it (fails)** — Expected: FAIL (today no-role wakeups run at Manual).

- [ ] **Step 3: Implement the fail-closed gate**

Replace `dispatcher.ts:406-420`:
```ts
// A2: Phase-3 only handles kind='aoa'. Resolve the role and FAIL CLOSED — an
// unresolved/unknown role must NOT be a free pass (treat it as Drive-only).
const payloadRole = (w.payload as Record<string, unknown> | null)?.role as string | undefined;
const resolvedRole = (payloadRole && (Object.keys(ROLE_MIN_AUTONOMY) as string[]).includes(payloadRole))
  ? (payloadRole as CrewRole)
  : await resolveCrewRole(db, w.agentId);
const roleActive = resolvedRole
  ? isRoleActiveAtAutonomy(resolvedRole, companyCfg.autonomyLevel)
  : companyCfg.autonomyLevel >= 2; // no role → only at Drive
if (!isInboxRouting && !roleActive) {
  await db.update(agentWakeupRequests)
    .set({ status: "skipped_autonomy", finishedAt: new Date() })
    .where(eq(agentWakeupRequests.id, w.id));
  logger.child({ subagent: "aoa-dispatcher" }).info(
    { agentId: w.agentId, role: resolvedRole ?? null, autonomy: companyCfg.autonomyLevel, companyId: w.companyId },
    "aoa wakeup skipped: autonomy gate (fail-closed)",
  );
  return;
}
```
Add imports at the top of `dispatcher.ts`: `import { resolveCrewRole } from "./resolve-crew-role.js";` and ensure `ROLE_MIN_AUTONOMY` is imported from `./autonomy.js` (it already imports `isRoleActiveAtAutonomy`/`CrewRole`).

- [ ] **Step 4: Migrate the existing dispatcher suite**

In `aoa-dispatcher.test.ts`, add at the top: `vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({ resolveCrewRole: vi.fn().mockResolvedValue(null) }));`. Because the resolver is module-mocked, it adds no real `db.select`, so the positional `_selectOrder` sequences are unchanged. Run the suite to confirm.

- [ ] **Step 5: Run both (pass)**

Run: `cd ".../server" && pnpm exec vitest run src/__tests__/dispatcher-autonomy-failclosed.test.ts src/__tests__/aoa-dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/dispatcher.ts server/src/__tests__/dispatcher-autonomy-failclosed.test.ts server/src/__tests__/aoa-dispatcher.test.ts
git commit -m "fix(crew): fail-closed autonomy gate — unresolved role is not a free pass (A2)"
```

---

## Task 4: A3 — budget pre-flight in the dispatcher

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/dispatcher.ts` (before the atomic claim at ~467)
- Test: `server/src/__tests__/dispatcher-budget-preflight.test.ts` (new) + migrate `aoa-dispatcher.test.ts`

- [ ] **Step 1: Write the failing test (module-mock budgetService)**

```ts
// dispatcher-budget-preflight.test.ts
const mockGetInvocationBlock = vi.fn();
vi.mock("../services/budgets.js", () => ({ budgetService: () => ({ getInvocationBlock: mockGetInvocationBlock }) }));
// 1) getInvocationBlock→"Agent budget exceeded" → _sets has {status:'skipped_budget'}, runAoaMock NOT called.
// 2) getInvocationBlock→null → proceeds.
```

- [ ] **Step 2: Run it (fails)** — Expected: FAIL (no budget call on this path today).

- [ ] **Step 3: Implement the pre-flight**

Insert immediately before `const claimed = await db.update(agentWakeupRequests)...` (~467):
```ts
// A3: pre-spend budget hard-stop (per-agent + company). Returns a reason string
// when blocked, null when clear.
const budgetBlock = await budgetService(db).getInvocationBlock(w.agentId, w.companyId);
if (budgetBlock) {
  await db.update(agentWakeupRequests)
    .set({ status: "skipped_budget", finishedAt: new Date() })
    .where(eq(agentWakeupRequests.id, w.id));
  logger.child({ subagent: "aoa-dispatcher" }).warn(
    { agentId: w.agentId, companyId: w.companyId, reason: budgetBlock },
    "aoa wakeup skipped: budget hard-stop",
  );
  return;
}
```
Add at the top of `dispatcher.ts`: `import { budgetService } from "../../../budgets.js";` (three levels up from `internal-agent/aoa-agents/` to `services/`).

- [ ] **Step 4: Migrate the existing dispatcher suite**

In `aoa-dispatcher.test.ts`, add `vi.mock("../services/budgets.js", () => ({ budgetService: () => ({ getInvocationBlock: vi.fn().mockResolvedValue(null) }) }));`. Module-mocked → no real `db.select` added → positional sequences unchanged.

- [ ] **Step 5: Run both (pass)** — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/dispatcher.ts server/src/__tests__/dispatcher-budget-preflight.test.ts server/src/__tests__/aoa-dispatcher.test.ts
git commit -m "fix(crew): pre-spend budget hard-stop in dispatcher Phase-3 (A3)"
```

> Follow-up (Spec A polish, not blocking): make a budget *breach* also cancel queued crew wakeups so the next tick doesn't re-dispatch. The pre-flight above already prevents new spend each tick — the load-bearing guarantee.

---

## Task 5: A5 — run-count brake (the missing T1.9)

Keep the cost-only spend brake. ADD a run-COUNT brake counting ALL crew runs (incl. $0 CLI), catching loops the spend brake can't see. This one DOES add a real `db.select`, so the affected existing fixtures must add a slot.

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/dispatcher.ts` (after the spend brake ~451; add the constant)
- Test: `server/src/__tests__/dispatcher-run-count-brake.test.ts` (new) + migrate `aoa-dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// dispatcher-run-count-brake.test.ts (full makeConcurrencyDb fixture — the count select
// is a NEW slot after the spend-brake slot; number the sequence accordingly)
// 1) all-runs window count >= limit (all costCents=0) → _sets has {status:'skipped_rate_limit'}, runAoaMock NOT called.
// 2) count < limit → proceeds.
```

- [ ] **Step 2: Run it (fails)** — Expected: FAIL (only the $0-blind spend brake exists today).

- [ ] **Step 3: Implement the count brake**

Add a constant near `DEFAULT_CREW_RATE_LIMIT`:
```ts
// A5: run-COUNT brake (the never-built T1.9). Counts ALL crew runs — the cost-only
// brake is blind to $0 CLI runs, exactly what a runaway crew loop produces.
export const DEFAULT_CREW_RUN_COUNT_LIMIT = { windowMinutes: 5, maxRunsPerWindow: 40 };
```
Immediately after the existing spend-brake block (after `:451`):
```ts
const countWindowStart = new Date(Date.now() - DEFAULT_CREW_RUN_COUNT_LIMIT.windowMinutes * 60_000);
const allWindowRuns = await db
  .select({ id: internalAgentRuns.id })
  .from(internalAgentRuns)
  .where(and(
    eq(internalAgentRuns.companyId, w.companyId),
    gt(internalAgentRuns.createdAt, countWindowStart),
  )) // NO costCents filter — count every run
  .then((r: Array<{ id: string }>) => r.length);
if (runRateExceeded(allWindowRuns, DEFAULT_CREW_RUN_COUNT_LIMIT.maxRunsPerWindow)) {
  await db.update(agentWakeupRequests)
    .set({ status: "skipped_rate_limit", finishedAt: new Date() })
    .where(eq(agentWakeupRequests.id, w.id));
  logger.child({ subagent: "aoa-dispatcher" }).warn(
    { agentId: w.agentId, allWindowRuns, limit: DEFAULT_CREW_RUN_COUNT_LIMIT.maxRunsPerWindow, companyId: w.companyId },
    "aoa wakeup skipped: run-count brake (T1.9)",
  );
  return;
}
```

- [ ] **Step 4: Migrate the existing dispatcher fixtures**

This adds a `db.select` between the spend-brake select and the agent-row select. In `aoa-dispatcher.test.ts`, every fixture whose run reaches the brake region must insert one more select result (returning a small count, e.g. `[]` or under-limit) at that position and bump `_selectOrder` expectations by 1. Update each affected fixture; run the suite to confirm.

- [ ] **Step 5: Run both (pass)** — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/dispatcher.ts server/src/__tests__/dispatcher-run-count-brake.test.ts server/src/__tests__/aoa-dispatcher.test.ts
git commit -m "fix(crew): add run-count brake for $0 CLI runs (A5 / T1.9)"
```

---

## Task 6: Verify

- [ ] **Step 1: Typecheck** — `cd ".../server" && pnpm exec tsc --noEmit` → no errors.
- [ ] **Step 2: Full suite** — `cd ".../server" && pnpm exec vitest run` → all green, including the migrated `aoa-dispatcher.test.ts` and all 6 new test files. (If the dispatcher suite is red, the A5 slot migration or the A2/A3 module-mocks were not applied — fix before claiming done.)
- [ ] **Step 3: Sanity grep** — `grep -rn "heartbeat.wakeup\|hb.wakeup" server/src/routes/issues.ts server/src/services/crew-task-service.ts server/src/services/dependencies.ts server/src/services/issue-assignment-wakeup.ts server/src/routes/discussions.ts` → the only remaining matches are the comment-mention paths (intentionally deferred). No bare assignment-assignee wakeups remain.

---

## Self-review notes (author, post-review)

- **Spec coverage:** A1 (Tasks 1-2), A2 (Task 3), A3 (Task 4), A5 (Task 5), verify (Task 6). A4 deferred to Spec B (with the crew status tool + Commander policy). ✓
- **Decision #100:** A1 routes crew to the dispatcher only. ✓
- **Import hygiene:** `resolveCrewRole` is a leaf (drizzle + db schema only); the dispatcher imports it without pulling the `issues`/`heartbeat` graph. The chokepoint's `issues↔heartbeat` cycle is eval-safe because every factory is called inside the function body. ✓
- **Test reality:** A2/A3 use module-mocks (no positional-sequence shift); A5 adds one real select → its task migrates the affected fixtures. Task 6 will be red if that migration is skipped — called out, not a free pass. ✓
- **Explicitly out of scope (not regressions):** the executor (`{issueId}` runner branch, task directive, checkout, task tools), A4's service guard, and the comment-`@mention` crew-drop at `routes/issues.ts:553`. ✓
- **Type consistency:** `enqueueIssueAssigneeWakeup(db, input)` and `resolveCrewRole(db, agentId): Promise<CrewRole|null>` are used identically across Tasks 1-4. `WakeTask` gains `companyId`; `queueIssueAssignmentWakeup` input swaps `heartbeat`→`db` and gains `issue.companyId`. ✓
