# Crew-Task Executor (Spec B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **This plan must be adversarially reviewed before execution** (Spec A's plan had 3 blockers caught that way).

**Goal:** Make crew agents (`kind='aoa'`: Scout/Engineer/Planner) actually EXECUTE their assigned tasks — pick up the task, do the work, post a result + artifact, and move the card to its dial-appropriate landing spot — so the board comes alive.

**Architecture:** A task run is a sibling of the existing crew *thread* run, reusing the entire `runAoaAgent` spine. Spec A already routes a crew task assignment to the dispatcher with `payload.issueId` (+ role). Spec B makes the dispatcher/runner DO something with it: a task **trigger directive** tells the agent to fetch its task and work it; the agent uses **four new task tools** (read, comment, artifact, status) to do the work and write back; the **A4 service guard** keeps status transitions honest (crew own-task + dial; Commander = founder-proxy); and a **checkout claim** serializes crew-vs-crew. The agent fetches its own task context via the `get_task` tool (the same "agent fetches context via tools" pattern threads use), so the runner needs only a checkout + a `relatedEntityType` branch.

**Tech Stack:** Express 5, Drizzle ORM, PostgreSQL, vitest. Drizzle ORM only.

**Builds on:** Spec A (`feat/crew-dispatch-hardening`). Fork Spec B from that branch.

---

## Review revisions (adversarial plan review, applied — read before executing each task)

The plan was adversarially reviewed against the real code. Apply these corrections (they override the task bodies below where they conflict):

1. **[BLOCKER · Task 1/4] Dial resolution lives in the TOOL, not the service.** Do NOT read `internalAgentConfig.autonomyLevel` inside `issueService.update` (it's not imported there and it ignores the per-thread override). The crew dial is already plumbed end-to-end as **`ctx.effectiveAutonomy`** (dispatcher → runner mcpParams → bridge → `ToolContext.effectiveAutonomy`; precedent: `advance-phase-tool.ts:26`, `propose-crew-work.ts:154`). So `set_task_status` resolves `effectiveDial = ctx.effectiveAutonomy ?? 0` and passes it INTO `update` via the actor arg: `update(id, data, { actorType:"agent", agentId: ctx.agentId, effectiveDial })`. `update` just forwards `actor.effectiveDial` to the guard. Place the `assertAgentStatusTransition` call **before** `db.transaction(...)` opens (alongside the existing assignable-agent asserts at `issues.ts:1144-1149`), since the guard does an approval-lookup read.
2. **[BLOCKER · Task 6 + File structure] `ensure-planner.ts` does NOT exist.** Planner is seeded in `ensure-command-staff.ts` — its allowlist is the `case "planner"` return of `roleToolAllowlist(...)` (`ensure-command-staff.ts:90`). Task 6 edits: `SCOUT_TOOL_ALLOWLIST` (`ensure-scout.ts:35`), `ENGINEER_TOOL_ALLOWLIST` (`ensure-engineer.ts:40`), and `roleToolAllowlist('planner')` (`ensure-command-staff.ts:90`). `seedCrewAgent`'s allowlist-drift backfill (`seed-crew-agent.ts:185-204`) propagates the new tools to already-seeded crews on next boot — good.
3. **[BLOCKER · completion semantics] Reconcile the dial table with `ROLE_MIN_AUTONOMY`** (`autonomy.ts:29-42`: `scout:1, engineer:1, planner:2`). There are TWO gates: (a) **role-activation** — a crew task does NOT execute at all below the role's min-autonomy (the dispatcher fail-closed gate skips it `skipped_autonomy`); (b) **completion** — how far the running agent may take the card. So: Scout/Engineer execute at dial ≥1 (Assist→in_review, Drive→done); **Planner executes ONLY at Drive (≥2) → done** (it has no in_review tier — never runs at Assist). At dial 0 nothing executes. State this in the A4 tests (the Assist→in_review case applies to scout/engineer only).
4. **[HIGH · Task 2-4] ALL FOUR task tools get a no-capability category, not just `set_task_status`.** `attach_task_artifact` would widen `system_actions` too (the existing `create_artifact` is `category:"action"`, and `derive-capabilities.ts:85` grants `system_actions` if ANY allowlisted tool is `action`). Use the existing **`coordination`** category (it confers no capability per `authorize-tool.ts:26-30` + `derive-capabilities.ts:58`) for `set_task_status`/`post_task_comment`/`attach_task_artifact`; `get_task` can be `query` (also confers nothing). Do NOT invent a new `ToolCategory` union member — `coordination` is the zero-surface fix.
5. **[HIGH · Task 5] Add a post-execute silent-stuck guard in the runner.** Mirror the entry guard at `runner.ts:316-327`: after `adapter.execute`, if `payload.issueId` and the task is still `in_progress` with `executionRunId === runId` (agent exited without calling `set_task_status` — likely for non-claude adapters or a hung run), RELEASE it back to `todo` (or fail loudly) — do NOT return `succeeded` with the card stuck `in_progress`.
6. **[MEDIUM · Task 2] `get_task` must enforce company scope itself.** `issueService.getById(id)` (`issues.ts:807`) has NO `companyId` filter — the tool must check `row.companyId === ctx.companyId` and return not-found otherwise.
7. **[LOW · Task 1] Drop the `isCommander` branch (or wire it right).** It's dead on the real Commander path: Commander's `update_task` (`action-tools.ts:55`) passes NO actor → the guard's `actorType:"system"` default already early-returns (bypasses). If kept for defense-in-depth, resolve Commander via `runtimeConfig.aoa.role === 'lead'` (`ensure-commander.ts:85`) or `internal_agent_config.agentId` — NEVER `agents.role` (which is `'general'`).
8. **[LOW · Task 5] Use a dynamic `await import("../../issues.js")` for the runner checkout** (matches `controller-adjutant-runner.ts:117`) to keep heavy `issues.ts` off the runner's static load graph. (Static is also acyclic — preference, not correctness.)
9. **[NIT] Line refs:** payload spread is `dispatcher.ts:565` (not 504); route guard moved-from block is `routes/issues.ts:79-123` + `ACTIVE_REVIEW_APPROVAL_STATUSES` at line 45.

**Validated by the review (no change needed):** `issueService.update` optional 3rd param breaks none of its 5 real callers; `addComment(taskId, body, {agentId})` (`issues.ts:1670`), `artifactService.create(companyId, createdById, {...})` (`artifacts.ts:37`), `checkout(...)` THROWS on conflict (`issues.ts:1522`, writes `executionRunId`), `taskOutputService.upsertForIssue` (`task-outputs.ts:147`) all exist as assumed; the dispatch path reaches `runAoaAgent` for an `{issueId,role}` wakeup and the role is carried so it isn't fail-closed-skipped.

---

## Locked design (from brainstorm)

| Decision | Choice |
|---|---|
| Scope | Full lifecycle — agent does the work AND moves the card |
| Trigger | Autonomy-gated by the crew dial (Spec A's fail-closed gate already does this for the `{issueId}` wakeup) |
| Completion | Dial-governed: **Assist → IN REVIEW** (founder approves → Done), **Drive → DONE** (agent completes) |
| A4 / Commander | Autonomous crew move ONLY their OWN assigned task, dial-gated. **Commander = founder-proxy** (it's founder-driven via chat, not autonomous) — its `update_task` keeps founder authority |
| Locking | `issueService.checkout` (todo→in_progress) writes `executionRunId = crewRunId`; crew-vs-crew serialization. Spec A made crew dispatcher-only, so NO heartbeat dual-execution risk |
| Tools | `get_task`, `post_task_comment`, `attach_task_artifact`, `set_task_status` |

**Out of scope:** the dedicated Commander autonomy dial (separate backlog item).

## Reuse surface (already built — do NOT rebuild)

- `runAoaAgent` spine + adapter.execute + MCP bridge (`runner.ts`). A `{issueId}` payload already flows through (`dispatcher.ts:504` spreads the whole payload).
- Spec A's chokepoint already enqueues crew task assignments to the dispatcher with `{issueId, role}`; the fail-closed autonomy gate + budget + brakes already protect the path.
- `issueService.checkout(id, agentId, expectedStatuses, checkoutRunId)` (`issues.ts:1398`) — atomic todo→in_progress, writes `executionRunId`.
- `issueService.update(...)` (`issues.ts:1014`) — status transitions.
- `issueService.addComment(taskId, body, {agentId})` (used at `issues.ts:1169`) — task comments.
- `artifactsService.create(...)` + `issues.artifactId` / `taskOutputService` — artifact attach.
- `crewTaskService` / `createDeliverableTasks` — task creation (already produces crew-assigned tasks).
- The tool pattern: `server/src/services/internal-agent/tools/post-entry-tool.ts` (thread-scoped — the template for shape, NOT reuse).

---

## File structure

**New files:**
- `server/src/services/internal-agent/tools/get-task-tool.ts` — read one task's full detail.
- `server/src/services/internal-agent/tools/post-task-comment-tool.ts` — `issue_comments` write.
- `server/src/services/internal-agent/tools/attach-task-artifact-tool.ts` — artifact → `issues.artifactId`/`task_outputs`.
- `server/src/services/internal-agent/tools/set-task-status-tool.ts` — crew status move (own-task + dial-gated).
- `server/src/services/issue-agent-status-guard.ts` — the A4 service-level guard (shared by route + service).

**Modified:**
- `server/src/services/issues.ts` — `update` becomes actor-aware + calls the A4 guard; `assertAgentInReviewReviewPath` moved into the shared guard module.
- `server/src/routes/issues.ts` — imports the moved guard (no behavior change for the route).
- `server/src/services/internal-agent/tool-registry.ts` — register the 4 new tools.
- `server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts` — a `payload.issueId` task-execution directive branch.
- `server/src/services/internal-agent/aoa-agents/runner.ts` — `relatedEntityType:"issue"` branch + checkout claim when `payload.issueId` present.
- `server/src/services/internal-agent/aoa-agents/ensure-scout.ts`, `ensure-engineer.ts`, `ensure-planner.ts` — add the 4 task tools to allowlists.

---

## Task 1: A4 — service-level agent status-transition guard

**Files:** Create `server/src/services/issue-agent-status-guard.ts`; Modify `server/src/services/issues.ts` (`update`) + `server/src/routes/issues.ts`; Test `server/src/__tests__/issue-agent-status-guard.test.ts`.

- [ ] **Step 1: Write the failing test** (assertions — pure guard function):

```ts
// crew agent moving its OWN task per the dial; Commander = founder-proxy
it("autonomous crew agent: own task, Drive → done allowed", async () => { /* assigneeAgentId===me, dial=2, next='done' → ok */ });
it("autonomous crew agent: own task, Assist → in_review allowed, done REJECTED", async () => { /* dial=1, next='done' → throw; next='in_review' → ok */ });
it("autonomous crew agent: NOT own task → rejected", async () => { /* assigneeAgentId!==me → throw */ });
it("Commander (founder-proxy) → allowed to move any task to done", async () => { /* actor is Commander → bypass ownership/dial */ });
it("non-agent actor (board/user) → unaffected", async () => { /* returns without throwing */ });
```

- [ ] **Step 2: Run → FAIL** (`cd ".../AoA-crew-hardening/server" && pnpm exec vitest run src/__tests__/issue-agent-status-guard.test.ts`).

- [ ] **Step 3: Implement.** Move `assertAgentInReviewReviewPath` + `ACTIVE_REVIEW_APPROVAL_STATUSES` from `routes/issues.ts:60-121` into the new `issue-agent-status-guard.ts` (re-export from the route so its import is unchanged). Add:

```ts
// issue-agent-status-guard.ts
export async function assertAgentStatusTransition(input: {
  existing: { id: string; status: string; assigneeAgentId: string | null; companyId: string };
  updateFields: { status?: string; assigneeUserId?: string | null; [k: string]: unknown };
  actor: { actorType: "agent" | "board" | "user" | "system"; agentId?: string | null };
  effectiveDial: number; // 0/1/2 — resolved by the caller (company autonomyLevel; per-thread N/A for tasks)
  isCommander: boolean;   // founder-proxy: bypasses ownership + dial
}, db: Db): Promise<void> {
  if (input.actor.actorType !== "agent") return;          // humans/system unaffected
  const next = typeof input.updateFields.status === "string" ? input.updateFields.status : input.existing.status;
  if (next !== "in_review" && next !== "done") return;     // only gate completion-ish transitions
  if (input.isCommander) return;                            // founder-proxy keeps authority
  // Autonomous crew: must own the task.
  const me = input.actor.agentId ?? null;
  if (!me || input.existing.assigneeAgentId !== me) {
    throw unprocessable("Agent may only transition its own assigned task", { code: "invalid_issue_disposition" });
  }
  // Dial: Assist(1) allows in_review; Drive(2) allows done; below that, nothing.
  if (next === "in_review" && input.effectiveDial < 1) throw unprocessable("Dial is Manual — task not human-reviewable by the agent yet", { code: "invalid_issue_disposition" });
  if (next === "done" && input.effectiveDial < 2) throw unprocessable("Only at Drive may a crew agent complete its own task", { code: "invalid_issue_disposition" });
  // in_review still requires the human/approval review-path (reuse the moved guard).
  if (next === "in_review") await assertAgentInReviewReviewPath({ existing: input.existing, updateFields: input.updateFields, actorType: "agent" }, db);
}
```

In `issues.ts` `update`: thread an `actor` param (default `{ actorType: "system" }` so existing/system callers are unaffected); resolve `effectiveDial` from `internalAgentConfig.autonomyLevel`; resolve `isCommander` (the Commander agent's id — look it up by the company's internal-agent / a kind/role check); call `await assertAgentStatusTransition(...)` before applying the patch. Keep the route-level `assertAgentInReviewReviewPath` as defense-in-depth.

> **Adversarial-review flag (from Spec A's plan review):** `update` is `(id, data)` today with 8 callers. Making `actor` REQUIRED breaks them. So make it OPTIONAL with a `system` default; only the agent-tool callers (the new `set_task_status` tool) pass `{actorType:"agent", agentId}`. Confirm the 8 callers compile.

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(crew): service-level agent status-transition guard (A4)`.

---

## Task 2: `get_task` tool (read one task's full context)

**Files:** Create `get-task-tool.ts`; Modify `tool-registry.ts`; Test.

- [ ] **Step 1: failing test** — `get_task({ taskId })` returns the issue's title/description/status/priority/sourceThread/workspace/assignee for a task in the caller's company; rejects cross-company.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: implement** following the `post-entry-tool.ts` shape (category `query`/`read`; reads `ctx.db`/`ctx.companyId`; calls a read on `issues` joined to project/goal). Register in `tool-registry.ts` (category that grants under a baseline read capability so it doesn't widen `system_actions` — see the adversarial note in Task 4).
- [ ] **Step 4: PASS. Step 5: commit** `feat(crew): get_task tool`.

---

## Task 3: `post_task_comment` + `attach_task_artifact` tools (write results)

**Files:** Create both tool files; Modify `tool-registry.ts`; Test each.

- [ ] **post_task_comment** — wraps `issueService(ctx.db).addComment(taskId, body, { agentId: ctx.agentId })` → an `issue_comments` row. Test: posting a comment as the crew agent writes the row with `authorAgentId`.
- [ ] **attach_task_artifact** — creates an artifact via `artifactsService.create` and links it to the task (`issues.artifactId` + `taskOutputService.upsertForIssue` if present). Respect artifact-version immutability (Decisions #43/#45) — re-runs create a new version, never mutate. Test: attaching sets `issues.artifactId` and a `task_outputs` row.
- [ ] Register both in `tool-registry.ts`. **Commit** `feat(crew): post_task_comment + attach_task_artifact tools`.

---

## Task 4: `set_task_status` tool (dial-gated, guard-enforced)

**Files:** Create `set-task-status-tool.ts`; Modify `tool-registry.ts`; Test.

- [ ] **Step 1: failing test** — `set_task_status({ taskId, status })`: the crew agent moves ITS OWN task; at Drive `done` succeeds, at Assist only `in_review`; not-own-task rejected (the A4 guard fires via the service).
- [ ] **Step 3: implement** — the tool calls `issueService(ctx.db).update(taskId, { status }, { actorType: "agent", agentId: ctx.agentId })` (the actor-aware path from Task 1, which runs `assertAgentStatusTransition`). The tool itself does NOT re-implement the policy — it delegates to the guarded service (single chokepoint).
- [ ] **CAPABILITY GOTCHA (adversarial note):** putting a status-move tool in the broad `action` category auto-grants `system_actions` to the agent (widening its capability set per `derive-capabilities.ts`). Give `set_task_status` (and the other task tools) a **dedicated narrow category** so granting it doesn't widen `system_actions`. Verify in `derive-capabilities.ts` + `authorize-tool.ts`.
- [ ] **Commit** `feat(crew): set_task_status tool (dial-gated via A4 guard)`.

---

## Task 5: task-execution trigger directive + runner `{issueId}` branch

**Files:** Modify `aoa-trigger-prompt.ts` + `runner.ts`; Test both.

- [ ] **Step 1: trigger-prompt test** — `buildTriggerPrompt` with `payload.issueId` set (no threadId) emits a TASK directive (fetch the task via `get_task`, do the work, post a comment + artifact, then `set_task_status`) and a `Task: <id>` context line — NOT the role-map thread directive.
- [ ] **Step 3: implement the directive branch** in `aoa-trigger-prompt.ts` parallel to the `inbox.routing_ambiguous` branch (line 117):

```ts
} else if (typeof payload.issueId === "string" && payload.issueId.length > 0) {
  directive = TASK_EXECUTION_DIRECTIVE;
  ctxLines.push(`Task: ${payload.issueId}`);
} else {
  directive = ROLE_ACTION_DIRECTIVE[agentRoleKey.toLowerCase()] ?? GENERIC_DIRECTIVE;
}
```
with
```ts
const TASK_EXECUTION_DIRECTIVE =
  "You have been assigned a task. Call `get_task` with the task id below to read its full context. " +
  "Do the work the task describes. Post your result with `post_task_comment`, and if you produced a deliverable, attach it with `attach_task_artifact`. " +
  "When the work is complete, call `set_task_status` to move the task forward (the system enforces how far you may take it based on the autonomy dial). " +
  "Do NOT call post_entry / thread tools — this is a task, not a thread.";
```
(Add `issueId?: string` to `AoaTriggerPayload` if not already present.)

- [ ] **Step 4: runner test** — when `payload.issueId` is set, the run row's `relatedEntityType` is `"issue"` and a `checkout` is attempted with the runId.
- [ ] **Step 5: implement runner branch** — at `runner.ts:114`, `relatedEntityType: payload.issueId ? "issue" : payload.entryId ? "discussion" : null` (+ `relatedEntityId`). After the run insert, when `payload.issueId` is set, claim the task:
```ts
if (payload.issueId && runId) {
  try {
    await issueService(db).checkout(payload.issueId, agentId, ["todo", "backlog", "in_progress"], runId);
  } catch (err) {
    // Already owned / claimed by a concurrent run → benign; return succeeded (mirror the entry-claim race at runner.ts:139-151).
    log.info({ issueId: payload.issueId }, "task checkout conflict — another run owns it; skipping");
    if (runId) await db.update(internalAgentRuns).set({ status: "succeeded", completedAt: new Date() }).where(eq(internalAgentRuns.id, runId));
    return { status: "succeeded" };
  }
}
```
(checkout writes `executionRunId = runId` — the single-owner claim. The crew agent then does the work + moves status via the tools.)
- [ ] **Commit** `feat(crew): task-execution trigger directive + runner issueId branch`.

---

## Task 6: wire the task tools onto the crew allowlists

**Files:** Modify `ensure-scout.ts`, `ensure-engineer.ts`, `ensure-planner.ts`; Test (allowlist contains the 4 tools).

- [ ] Add `get_task`, `post_task_comment`, `attach_task_artifact`, `set_task_status` to each crew role's `toolAllowlist`. Confirm `deriveEnabledCapabilities` grants the right (narrow) capability for them and does NOT inadvertently widen `system_actions` (Task 4 gotcha). Test: a seeded Scout/Engineer/Planner has the 4 tools.
- [ ] **Commit** `feat(crew): add task tools to Scout/Engineer/Planner allowlists`.

---

## Task 7: end-to-end integration test + verify

**Files:** Test `server/src/__tests__/crew-task-execution.e2e.test.ts`; verification.

- [ ] **E2E (mocked-adapter)** — assign a task to a crew agent at Drive → the chokepoint enqueues an `{issueId,role}` dispatcher wakeup → the dispatcher (Spec A gates pass) → `runAoaAgent` checks the task out (todo→in_progress, executionRunId set) → assert the run row is `relatedEntityType:"issue"` and the task is `in_progress`. (The adapter is mocked, so the actual tool-calling is asserted at the tool-unit level, not here; this E2E proves the dispatch→checkout wiring.)
- [ ] **Verify:** `tsc --noEmit` (changed files clean; the pre-existing plugin-sdk errors are environmental); full suite green except the known pre-existing failures; grep confirms the 4 tools are registered + on the allowlists.
- [ ] **Commit** `test(crew): crew-task execution E2E + verify`.

---

## Self-review notes

- **Spec coverage:** A4 guard (T1), the 4 tools (T2-T4), trigger+runner wiring (T5), allowlists (T6), E2E (T7). The dial-governed completion is enforced in the A4 guard (T1) + delegated to by `set_task_status` (T4).
- **Reuse honored:** the runAoaAgent spine, checkout, addComment, artifacts, the dispatcher gates — all reused. Only the trigger directive + the 4 tools + the A4 guard + the runner branch are new.
- **Decision #100:** crew run only on the dispatcher (Spec A); the checkout writes `executionRunId` for crew-vs-crew serialization; no heartbeat involvement.
- **Known adversarial-flagged risks to verify in review:** (1) `issues.update` actor threading — make `actor` optional/system-default so the 8 callers don't break; (2) the capability category for the status tool must NOT widen `system_actions`; (3) checkout-conflict must map to a benign `succeeded`, not `failed`; (4) the Commander founder-proxy detection (`isCommander`) must be reliable (how is the Commander agent identified — by role/kind?).
- **NEEDS adversarial plan review before execution** (same as Spec A — that pass caught 3 blockers).
