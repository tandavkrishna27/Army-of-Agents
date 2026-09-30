# Thread Chat Experience — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task is TDD (fails-first) and commits on pass. **This plan was produced from three live investigations + a design discussion; the decisions in "Locked design" are settled — do not relitigate them.**

**Goal:** Make threads feel like a real group chat — multiple humans and agents conversing, where the system knows when to wait vs. respond (governed by the autonomy dial), agents are pulled in with full context (never "start blind"), and all activity is visible live (humanized "typing/working" pills in chat + a live kanban).

**Architecture:** Connect existing-but-unwired machinery rather than rebuild. Collapse the thread strangler to ONE pipeline (the controller) so `@mention`/`agent.dispatch` stop being dropped; wire the already-built `requestParticipation` so the Adjutant can actually pull in Scout/Engineer/Planner; inject thread history + summary + memory into every crew run (the heartbeat + Commander paths already do this — the crew path doesn't); refine the dial into a chat experience (Manual = answer-when-addressed, Assist = converse, Drive = converse + advance; a direct `@mention` always answers, founder-driven); and feed/mount the already-built presence pill + extend the kanban "Live" query to see crew runs.

**Tech Stack:** Express 5 + Drizzle ORM + PostgreSQL + vitest (server); React + Vite + Tailwind + TanStack Query + a WebSocket LiveUpdates provider (ui). Drizzle ORM only — never raw SQL.

**Branch:** Fork `feat/thread-chat-experience` from `feat/crew-task-executor` (this builds directly on Spec B + the autonomy-dial fix). Run in the AoA-crew-hardening worktree.

---

## Locked design (from the investigations + discussion — settled)

| Decision | Choice |
|---|---|
| Agent count | **Keep all 8.** Collapse nothing. (Role-model collapse is a deferred follow-up, NOT this plan.) |
| Persona files | **Clean the drifted bundles LOCALLY** (Adjutant SOUL "quiet observer" → director; Engineer SOUL retired-"Dispatcher" ref). The durable fix is a **marketplace-catalog re-seed FOLLOW-UP** (catalog is source-of-truth on fresh seed). |
| Navigator + Chronicler | Stay exactly as they are (only the persona-text cleanup). |
| Pipeline | **Collapse to ONE** — the controller path owns thread conversation; peer-wake retained ONLY for non-thread wakeups (task assignment, inbox routing). |
| The dial = the experience | **Manual** = answers only when @mentioned (no proactive); **Assist** = proactively converses with the team (no advancing to scope/tasks); **Drive** = converses AND advances (scope→assign→done). |
| Direct @mention | **Always answers, at every dial** (founder-driven, like Commander — bypasses the activation gate). The dial governs *proactive* wake + *advancing*, not direct address. |
| Latency | A direct @mention bypasses the 30s debounce (near-instant). Ambient (unaddressed) human chatter keeps the debounce. |
| Context | **Inject** thread history (last N entries) + the Chronicler summary + relevant memory into every crew run. No agent starts blind. |
| Typing/feel | Humanized presence pill ("Scout is researching…", "Planner is writing the plan…", "Engineer is creating an artifact…") via the EXISTING `threadWorkingAgents`/`PresenceStrip`. **Placeholder loader now; real loader is a follow-up.** No token-streaming in v1. |
| Kanban | Goes live for crew: the "Live" pill + live card moves, including the Crew Board. |

**Out of scope (explicit follow-ups, captured as chips at execution):** (1) marketplace-catalog re-seed of the cleaned bundles; (2) the real loader asset; (3) true token-by-token streaming (Commander-SSE reuse); (4) role-model collapse to ~5 agents; (5) the controller-path mention fix already chipped is SUBSUMED by Phase 1 here.

---

## Plan corrections (adversarial review — APPLIED; these OVERRIDE the task bodies below)

The plan was adversarially reviewed against the real code (3 blockers + 6 risks found). These corrections override the task text where they conflict. Read before executing each task.

**B1 [Task 2.1] — `requestParticipation` double-posts; the runner does NOT return reply text.** `requestParticipation` (`thread-orchestration.ts:651-698`) posts whatever its `participantRunner` RETURNS as the agent's `inputType:"agent"` entry. But `runAoaAgent` returns `AoaRunResult = {status,…}` with NO text — the agent self-posts via the `post_entry` MCP tool *during* its run (its directive, `aoa-trigger-prompt.ts:45`). So wiring `runAoaAgent` as the runner → the agent posts its real reply AND `requestParticipation` posts a SECOND empty entry. **Fix:** Task 2.1 ALSO edits `requestParticipation` to SKIP the entry-insert when the runner returns empty (`""`/sentinel), mirroring `controller-adjutant-runner.ts` (returns `{status}`, agent self-posts). Real signature: `participantRunner({threadId, agentId, prompt}) => Promise<string>` — return `""`.

**B2 [Task 3.1] — DELETE the dispatcher activation-gate edit; it's a NO-OP for controller-path mentions.** Controller-path mentions go `requestParticipation → runAoaAgent` DIRECTLY; `runAoaAgent` has NO activation gate (it only forwards `effectiveAutonomy` to the MCP bridge for *tool-level* gating, `runner.ts:235`). So a @mentioned agent on a controller thread ALREADY runs at any dial — "@mention always answers" is free; no dispatcher edit needed. Rewrite Task 3.1 as: a TEST confirming a controller-path @mention RUNS at Manual (incl. Planner, min-autonomy 2 — exempt by design); only IF legacy-thread mentions must also be exempt, edit the dispatcher and say so explicitly. The Manual-vs-Assist distinction lives ENTIRELY in Task 3.2 (proactive suppression at `fireAdjutantWakeup`), not the activation gate.

**B3 [Tasks 1.2/1.3] — wrong signature + no prompt source + a real double-drive Task 1.3 can't fix as written.** (a) Real signature `(threadId, {agentId, prompt}, opts)` — NO `agentName`/`reason`/`hopBudget`. (b) `processMentions(db, companyId, threadId, entryId, mentions, opts?)` gets only parsed mentions, NOT the entry text, and never fetches the thread row → Task 1.2 MUST add a `discussions` lookup (for `useControllerPath`) + fetch the entry `rawContent` to build `prompt`. (c) DOUBLE-DRIVE: `@Scout …` arms the 30s debounce (→ Adjutant via `runController`) AND calls `processMentions` (→ Scout via participation) — both fire-and-forget on one entry. Task 1.3's "debounce only arms for unaddressed" CANNOT work as written: `onEntryCreated`'s event payload `{id,discussionId,authorAgentId,inputType,createdBy}` carries NO text (`thread-events.ts:57-63`). **Fix:** parse mentions inside `discussions.addEntry`, add `hasCrewMention: boolean` to the `EntryCreatedEvent` payload, and have `onEntryCreated` skip arming the debounce when `hasCrewMention` is true (mentioned agent answers directly; proactive Adjutant does not also fire). Reconcile the two hop caps: the unified controller path uses `HOP_CAP=5` (`thread-orchestration.ts:162`); retire `MAX_HOP_COUNT=3` (`thread-events.ts:46`) for the thread path.

**R1 [Task 4.2] — `fetchMemoryContext` is a PRIVATE heartbeat closure (NOT liftable).** Use `memoryService(db).searchMultiPath(companyId, queryText, {limit})` (`memory.ts:378`) instead — it already guards the semantic path behind `getDbCapabilities().hasVectorSupport` and its keyword/temporal paths never touch the (absent) `embedding` column → degrades gracefully on this instance. Phase 4 stays Medium IF you reuse `searchMultiPath` (it becomes Large if you try to extract the private heartbeat closures).

**R2/R3 [Task 5.6] — publish `issue.status_changed` at the REAL crew-move chokepoints, company-broadcast fan-out.** `issueService.update`'s status path is clean BUT crew moves bypass it: `checkout` flips `→in_progress` via a raw write; the silent-stuck guard writes `→todo` (`runner.ts:371-373`); `set_task_status` has its own path. Publish at `set_task_status` + those raw writes (or centralize a `setStatus` first), else the event misses the very moves it exists to show. Use the COMPANY-broadcast fan-out (NOT the thread-envelope RBAC path); register the new type in `LiveUpdatesProvider.handleLiveEvent`.

**R4 [Tasks 1.1, 3.x] — dispatcher fixture migration spans ~18 suites,** not just `aoa-dispatcher.test.ts`: also `dispatcher-autonomy-effective`, `dispatcher-autonomy-failclosed`, `strangler-flag`, `aoa-wakeup-dispatch`, `p3-effective-autonomy`, `crew-autonomy`. Budget for all.

**R5 [Task 5.5] — `internal_agent_runs` has NO `startedAt` (use `createdAt`) and the status enum has NO `'queued'` (runner inserts `'running'`).** UNION filter = `status = 'running' AND related_entity_type = 'task'`; surface `createdAt` as the elapsed anchor.

**R6 [Task 3.3] — the "discuss-only" mute is the ADJUTANT DIRECTIVE (`ensure-adjutant.ts:44`), NOT `thread-events.ts:210` (which is `phase !== "done"` and lets the controller drive in scope/assign).** The DOERS are already conversational across phases. Re-target Task 3.3 at `ensure-adjutant.ts:44`: scope the directive so a DIRECT @mention of the Adjutant still answers in scope/assign (its PROACTIVE post still pauses outside discuss). Minimal text change, not a gate change.

**Confirmed-valid (no change):** the dropped-mention bug is real + live (1 stranded `queued` row right now); agents DO start blind (IDs-only prompt — Phase 4 premise holds); `post_entry` is NOT dial-gated, so a Manual @mention posts-but-can't-advance (the dial model is coherent — V4); presence signatures + `PresenceStrip` liftability + the kanban blind spot + persona drift all verified exactly as the tasks assume (V5–V9).

## Ground-truth references (from the investigations — cite, don't re-derive)

- Strangler skip that drops mentions: `server/src/services/internal-agent/aoa-agents/dispatcher.ts:386-399` (`if (threadRow?.useControllerPath) return;` — returns WITHOUT a terminal status → wakeups stranded `queued`).
- Controller drive (Adjutant-only, inline): `server/src/services/thread-events.ts:204-219`; 30s debounce `thread-events.ts:49` (`DEFAULT_DEBOUNCE_MS`).
- The unwired turn-taking primitive: `server/src/services/thread-orchestration.ts:565` (`requestParticipation`) + its `participantRunner` DI stub that throws "participant runner not wired (P1-T6 seam)". Hop cap `HOP_CAP=5` `thread-orchestration.ts:162`.
- Controller-adjutant runner (the factory to generalize): `server/src/services/internal-agent/aoa-agents/controller-adjutant-runner.ts:54-123`.
- Crew prompt builder (where context must be injected): `server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts:108-164`; runner `server/src/services/internal-agent/aoa-agents/runner.ts` (persona at ~188, `buildTriggerPrompt` call ~252, `onLog` no-op ~330).
- Context assembly to REUSE: `server/src/services/heartbeat.ts:3048-3112` (`fetchMemoryContext`, `fetchDependencyOutputs`, `buildRunInputBundle`); `server/src/services/internal-agent/context-assembly.ts:96-163` (memory ranking + `addSection` + token budget).
- Presence infra (built, FE-wired): `server/src/services/live-events.ts:247-312` (`threadWorkingAgents`, `broadcastThreadPresence`); fed today ONLY at `heartbeat.ts:2611`/`4119`. UI: `ui/src/context/LiveUpdatesProvider.tsx:856-863` (parses `workingAgents`), `ui/src/components/threads/OriginCard.tsx:777-867` (`PresenceStrip` — orphaned), `ui/src/pages/ThreadDetail.tsx:141-155` (subscribes, renders only ConnectionPill).
- Chat bubbles already exist: `ui/src/components/threads/ThreadTab.tsx` + `EntryRow.tsx`.
- Autonomy gate (just unified on effectiveAutonomy): `dispatcher.ts:415-426` + `assertAgentStatusTransition` in `server/src/services/issue-agent-status-guard.ts`. `ROLE_MIN_AUTONOMY` `autonomy.ts:29-42` (scout/engineer=1, planner=2, adjutant/chronicler=0).
- Kanban live pill: `ui/src/components/KanbanBoard.tsx:172-180` driven by `liveIssueIds`; source `liveRunsForCompany` `server/src/routes/agents.ts:1715-1725` (queries `heartbeat_runs` ONLY — the blind spot). Crew Board `ui/src/components/crew/CrewBoard.tsx:180-186` (no liveIssueIds/agents).

---

## File structure (what changes, and why)

**Server — new:**
- `server/src/services/internal-agent/aoa-agents/crew-context-bundle.ts` — assembles the dynamic context (thread history + summary + memory + task/artifact) for a crew run. One responsibility: "what should this agent know going in."
- `server/src/services/internal-agent/aoa-agents/thread-participation-runner.ts` — the `participantRunner` factory wiring `requestParticipation` → `runAoaAgent` for any crew agent (generalizes `controller-adjutant-runner.ts`).

**Server — modified:**
- `dispatcher.ts` — terminalize the controller-path skip (Task 1.1); @mention always-answers gate bypass (Task 3.1); proactive-wake dial gate (Task 3.2).
- `thread-events.ts` — @mention fast-path (no debounce) + route mentions through the controller (Tasks 1.2/1.3); gate the proactive Adjutant wake at Assist (Task 3.2).
- `thread-orchestration.ts` — wire `participantRunner` default to the new runner (Task 2.1).
- `aoa-trigger-prompt.ts` + `runner.ts` — inject the context bundle into the prompt (Phase 4).
- `runner.ts` — feed `threadWorkingAgents` + activity status (Phase 5).
- `live-events.ts` — add an `activity` field to presence (Task 5.2) + an `issue.status_changed` event (Task 5.6).
- `routes/agents.ts` — `liveRunsForCompany`/`liveRunsForIssue` UNION `internal_agent_runs` (Task 5.5).
- `issues.ts` — publish `issue.status_changed` on `setStatus` (Task 5.6).
- `onboarding-assets/adjutant/SOUL.md`, `onboarding-assets/engineer/SOUL.md` — persona cleanup (Task 0.2).

**UI — modified:**
- `ui/src/pages/ThreadDetail.tsx` + `ui/src/components/threads/ThreadTab.tsx` — mount `PresenceStrip` near the conversation; optimistic "summoning…" chip (Phase 5).
- `ui/src/components/threads/PresenceStrip.tsx` (lift out of OriginCard, or export) — render humanized activity + placeholder loader.
- `ui/src/context/LiveUpdatesProvider.tsx` — parse `activity` + handle `issue.status_changed` (invalidate issues list).
- `ui/src/components/KanbanBoard.tsx` — show agent name + elapsed on the live pill (Task 5.5).
- `ui/src/components/crew/CrewBoard.tsx` + `ui/src/pages/Issues.tsx` + `ui/src/pages/ProjectDetail.tsx` — pass crew `liveIssueIds` + `agents`; subscribe to live updates (Tasks 5.5–5.7).

---

## Phase 0 — Branch + persona cleanup (low-risk warm-up)

### Task 0.1: Create the branch
- [ ] `git -C "<worktree>" checkout feat/crew-task-executor && git -C "<worktree>" checkout -b feat/thread-chat-experience`. Confirm clean tree. (No code; setup only.)

### Task 0.2: Reconcile drifted persona bundles (LOCAL; marketplace follow-up filed)

**Files:** Modify `server/src/onboarding-assets/adjutant/SOUL.md`, `…/adjutant/AGENTS.md`, `…/adjutant/HEARTBEAT.md`, `server/src/onboarding-assets/engineer/SOUL.md`. Test `server/src/__tests__/persona-bundle-coherence.test.ts` (new).

- [ ] **Step 1 (failing test):** assert the Adjutant bundle text no longer contains the contradictory "quiet observer"/"never interrupt"/"runs every ~4h via sweep" framing and DOES describe the discuss-phase director role; assert the Engineer bundle no longer references "Dispatcher" (a retired role). Read the files in the test and grep their contents.
```ts
// persona-bundle-coherence.test.ts
import { readFileSync } from "node:fs"; import { join } from "node:path";
const root = join(__dirname, "..", "onboarding-assets");
it("Adjutant SOUL matches its runtime director role", () => {
  const soul = readFileSync(join(root, "adjutant", "SOUL.md"), "utf8").toLowerCase();
  expect(soul).not.toMatch(/quiet observer|never interrupt/);
  expect(soul).toMatch(/discuss|director|orchestrat/);
});
it("Engineer bundle does not reference the retired Dispatcher role", () => {
  const soul = readFileSync(join(root, "engineer", "SOUL.md"), "utf8").toLowerCase();
  expect(soul).not.toMatch(/dispatcher/);
});
```
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** edit the bundles. Adjutant: rewrite the "quiet observer / 4h sweep" passages to the discuss-phase director identity (it drives the conversation in `discuss`, proposes work via `propose_crew_work`, routes to doers, advances phase at Drive, stays silent when there's nothing to add). Engineer: replace "tasks are created by the Dispatcher" with the real source (tasks come from the founder/Adjutant `propose_crew_work` chokepoint). Keep edits minimal + factual; do NOT change tool lists or behavior — text only.
- [ ] **Step 4:** run → PASS. Confirm `ensure-adjutant`/`ensure-engineer` tests still pass (no behavior change).
- [ ] **Step 5:** commit `chore(crew): reconcile drifted Adjutant/Engineer persona text (local; marketplace re-seed follow-up)`.
- [ ] **Step 6:** controller files a follow-up chip: "Re-seed cleaned persona bundles into the marketplace catalog (source of truth on fresh seed); verify Chronicler + all 8 crew exist in the catalog."

---

## Phase 1 — One pipeline: @mentions never dropped

### Task 1.1: Terminalize the controller-path skip (no orphaned `queued`)

**Files:** Modify `dispatcher.ts:386-399`. Test `server/src/__tests__/dispatcher-controller-skip-terminal.test.ts` (new, positional-seq harness like `aoa-dispatcher.test.ts`).

- [ ] **Step 1 (failing test):** a queued wakeup whose thread is `useControllerPath=true` and which is NOT going to be handled by the controller-mention path (Task 1.2 handles real mentions) must be terminalized with a distinct status, not left `queued`. Assert `db._sets` records `status: "skipped_controller_path"` + `finishedAt` for that wakeup (mirroring the other skip branches at `dispatcher.ts:432`/`490`/`519`).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** change the skip block to write a terminal status before returning:
```ts
if (threadRow?.useControllerPath) {
  await db.update(agentWakeupRequests)
    .set({ status: "skipped_controller_path", finishedAt: new Date() })
    .where(eq(agentWakeupRequests.id, w.id));
  logger.child({ subagent: "aoa-dispatcher" }).debug({ wakeupId: w.id }, "peer-wake skipped: controller-path thread");
  return;
}
```
- [ ] **Step 4:** PASS + migrate any positional fixtures the extra `.set()` shifts.
- [ ] **Step 5:** commit `fix(crew): terminalize controller-path peer-wake skip (no orphaned queued wakeups)`.

### Task 1.2: Route `@mention`/`agent.dispatch` through the controller (the core fix)

**Files:** Modify `server/src/services/threads.ts` (`processMentions` ~:182) + `server/src/services/thread-events.ts`. Test `server/src/__tests__/controller-mention-dispatch.test.ts` (new).

- [ ] **Step 1 (failing test):** when an entry on a `useControllerPath=true` thread @mentions a crew agent, the mentioned agent is dispatched via the controller participation path (a run is driven), NOT left as a stranded peer-wake wakeup. Mock the thread as controller-path; assert the participation runner is invoked for the mentioned agent (not a peer-wake insert that the dispatcher later skips).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** in `processMentions`, branch on the thread's `useControllerPath`: for a controller-path thread, instead of (only) inserting a peer-wake `agent_wakeup_requests` row, call `threadOrchestrationService(db).requestParticipation(threadId, { agentId, agentName, reason: mentionText, hopBudget })` (Phase 2 wires the runner this consumes). For a non-controller (legacy) thread, keep the existing peer-wake insert. Keep the peer-wake row for audit if cheap, but the controller path is what actually drives the run. (`requestParticipation` already posts the agent's reply as an `inputType:"agent"` entry + enforces the hop cap.)
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `fix(crew): dispatch @mentions through the controller on controller-path threads`.

### Task 1.3: `@mention` fast-path — bypass the 30s debounce

**Files:** Modify `thread-events.ts` (the `onEntryCreated`/debounce path, ~:243) + `threads.ts` `processMentions`. Test extend `controller-mention-dispatch.test.ts`.

- [ ] **Step 1 (failing test):** an entry that @mentions an agent triggers an IMMEDIATE participation dispatch (no 30s timer); an entry with NO mention still arms the 30s debounce for the proactive Adjutant. Assert the mention path fires synchronously (no `setTimeout(30_000)` gating it) and the no-mention path schedules the debounce.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** make the mention dispatch (Task 1.2) fire on entry-create directly (it already runs in `processMentions`, which is called inline at `routes/discussions.ts:239` — confirm it is NOT gated by the debounce; the debounce is a separate `thread-events` concern for the *proactive* Adjutant). Ensure the proactive Adjutant debounce only arms for UNADDRESSED human entries (no crew @mention present) — if the entry @mentions someone, that someone answers directly and the ambient-Adjutant timer does not also fire a duplicate.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(crew): direct @mention answers immediately (skips the ambient debounce)`.

---

## Phase 2 — Wire the doers (`requestParticipation`)

### Task 2.1: Wire `participantRunner` → `runAoaAgent`

**Files:** Create `server/src/services/internal-agent/aoa-agents/thread-participation-runner.ts`; Modify `server/src/services/thread-orchestration.ts` (the `participantRunner` DI default, near `:565`). Test `server/src/__tests__/thread-participation-runner.test.ts` (new).

- [ ] **Step 1 (failing test):** `makeThreadParticipationRunner(db)` returns a runner that, given `{ threadId, agentId, prompt }`, calls `runAoaAgent(db, agentId, { companyId, source: "thread.participation", threadId, entryId, mention, effectiveAutonomy })` and returns the agent's run result; and `requestParticipation` uses it (no longer throws "not wired"). Mock `runAoaAgent`; assert called with the right payload incl. `threadId` + `effectiveAutonomy` (resolved thread ?? company).
- [ ] **Step 2:** FAIL ("participant runner not wired").
- [ ] **Step 3:** implement the factory mirroring `controller-adjutant-runner.ts:54-123` but parameterized by `agentId` (not hardcoded Adjutant). Resolve `effectiveAutonomy = thread.autonomyLevel ?? company.autonomyLevel` (same as the dispatcher). Set `thread-orchestration.ts`'s default `participantRunner` to `makeThreadParticipationRunner(db)`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(crew): wire requestParticipation to runAoaAgent (Adjutant can pull in Scout/Engineer/Planner)`.

### Task 2.2: Verify hop-cap + loop-guard end to end

**Files:** Test `server/src/__tests__/thread-participation-hopcap.test.ts` (new). No source change expected (the cap exists).

- [ ] **Step 1 (failing-or-confirming test):** drive `requestParticipation` `HOP_CAP+1` times; assert at the cap it posts the "scope it / keep going?" card and does NOT run another sub-agent (no infinite ping-pong); assert an agent's reply entry does not itself re-trigger participation (loop-guard on `inputType:"agent"`).
- [ ] **Step 2:** run; if it passes, good (regression lock); if it reveals a gap, fix minimally in `thread-orchestration.ts`.
- [ ] **Step 5:** commit `test(crew): thread participation hop-cap + agent-entry loop-guard`.

---

## Phase 3 — Dial-as-experience (Manual / Assist / Drive; @mention always answers)

### Task 3.1: Direct `@mention` bypasses the activation gate (founder-driven)

**Files:** Modify the dispatch/participation path so a `source` of `thread_mention`/`thread.participation` is NOT autonomy-gated for ACTIVATION (the human addressed it). Likely `dispatcher.ts:415-426` (gate) + the participation runner. Test `server/src/__tests__/mention-bypasses-activation-gate.test.ts` (new).

- [ ] **Step 1 (failing test):** at company dial = Manual (0), a DIRECT @mention of Scout (min-autonomy 1) DOES dispatch/run (founder-driven); but a PROACTIVE wake (source `thread.event`, no mention) of Scout at Manual does NOT (Task 3.2). Assert run-vs-skip per source.
- [ ] **Step 2:** FAIL (today the gate skips Scout at Manual regardless of mention).
- [ ] **Step 3:** treat direct-address sources (`thread_mention`, `thread.participation`) as activation-exempt — i.e. the autonomy gate's role-activation check is skipped for a direct mention (mirroring the Commander `aoa.role==='lead'` exemption already added). Keep the COMPLETION gate (in_review/done tiers) and the ADVANCE gate (Drive) intact — only ACTIVATION is exempted for direct address.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(crew): a direct @mention always answers (activation-gate exempt; founder-driven)`.

### Task 3.2: Gate the PROACTIVE Adjutant wake at Assist (Manual = no proactive)

**Files:** Modify `thread-events.ts` `fireAdjutantWakeup` (~:131). Test `server/src/__tests__/proactive-wake-dial.test.ts` (new).

- [ ] **Step 1 (failing test):** the proactive Adjutant debounce wake fires only when `effectiveAutonomy >= 1` (Assist+); at Manual (0) the proactive wake is suppressed (no Adjutant run on ambient chatter). Direct @mention path (Task 3.1) is unaffected.
- [ ] **Step 2:** FAIL (today the Adjutant wakes at any dial because the controller path bypasses the gate).
- [ ] **Step 3:** in `fireAdjutantWakeup`, resolve `effectiveAutonomy = thread.autonomyLevel ?? company.autonomyLevel` and return early (no run) when `< 1`. (This is the "Manual = answer only when addressed" behavior.)
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(crew): proactive thread participation requires Assist+ (Manual answers only when @mentioned)`.

### Task 3.3: Keep the crew conversational through phases at Drive

**Files:** Modify `ensure-adjutant.ts` directive + the `thread-events.ts:210` `phase != done` gate as needed. Test `server/src/__tests__/drive-advances-not-silences.test.ts` (new).

- [ ] **Step 1 (failing test):** at Drive, after a thread advances `discuss → scope`, the crew is NOT silenced — the relevant doer (Planner on scope, Engineer on assign) is still dispatchable and the Adjutant may still respond to direct address. Assert a `@mention` in a `scope`-phase thread at Drive still dispatches; assert the hard "phase != discuss → silent" rule does not block the doers (only the Adjutant's PROACTIVE posting may pause).
- [ ] **Step 2:** FAIL if the `phase=='discuss'`-only rule silences everything.
- [ ] **Step 3:** scope the silence: the Adjutant's "only act in discuss" is about its PROACTIVE orchestration, not a global mute. Direct @mentions (Task 3.1) and doer participation must work in any non-`done` phase. Adjust the directive text + the `thread-events.ts:210` gate so it only suppresses the proactive Adjutant in non-discuss phases, not the whole crew.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `fix(crew): Drive keeps the crew conversational across phases (only proactive Adjutant pauses post-discuss)`.

---

## Phase 4 — Context injection (no agent starts blind)

### Task 4.1: Build the crew context bundle (thread history + summary)

**Files:** Create `server/src/services/internal-agent/aoa-agents/crew-context-bundle.ts`. Test `server/src/__tests__/crew-context-bundle.test.ts` (new).

- [ ] **Step 1 (failing test):** `buildCrewContextBundle(db, { companyId, threadId?, issueId?, agentId, tokenBudget })` returns a string section containing: for a thread — the last N (default 20) entries rendered as `"<author>: <text>"` + the Chronicler `summaryText`/routingTerms; for a task — the task title/description/acceptance + the upstream artifact body (truncated). Capped to `tokenBudget` (reuse `context-assembly.ts` token estimate `ceil(len/4)`). Assert content present + cap respected.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** implement it reusing existing reads: thread entries via the same query `thread.listEntries` uses; summary via `thread-get-summary` logic; task via `issueService.getById` + artifact read. Mirror `context-assembly.ts`'s `addSection` + budget pattern. Pure-ish (db in, string out).
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(crew): crew context bundle (thread history + summary + task/artifact)`.

### Task 4.2: Inject relevant memory into the bundle

**Files:** Modify `crew-context-bundle.ts`. Test extend `crew-context-bundle.test.ts`.

- [ ] **Step 1 (failing test):** the bundle includes relevant company/goal/working memory items (reusing `fetchMemoryContext` from `heartbeat.ts:3055` or `context-assembly.ts`'s ranker). With memory present, the section lists them; with none (or embeddings unavailable — current QA state), it degrades gracefully (no crash, empty memory section). Assert both.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** lift `fetchMemoryContext`/the ranker into the bundle (or call it). Degrade to text/empty when embeddings/pgvector are absent (the live instance has no `embedding` column) — do not require semantic retrieval.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(crew): inject relevant memory into the crew context bundle`.

### Task 4.3: Wire the bundle into the trigger prompt

**Files:** Modify `server/src/services/internal-agent/aoa-agents/runner.ts` (before `buildTriggerPrompt` ~:252) + `aoa-trigger-prompt.ts:108-164` (accept + render a `contextBundle` section). Test extend `aoa-trigger-prompt.test.ts` + `aoa-runner-*.test.ts`.

- [ ] **Step 1 (failing test):** `buildTriggerPrompt({ ..., contextBundle })` renders the bundle as a `## Context` section between the persona and the `## This wakeup` block; and `runAoaAgent` calls `buildCrewContextBundle` and passes the result. Assert a thread-mention run's prompt now CONTAINS the prior entries + summary (not just `Thread: <id>`).
- [ ] **Step 2:** FAIL (today the dynamic block is IDs only — see the live `prompt_snapshot` evidence).
- [ ] **Step 3:** add an optional `contextBundle?: string` to `BuildTriggerPromptArgs`; render it. In `runner.ts`, build the bundle (best-effort; never throw — wrap like the prompt snapshot) and pass it. Respect `redactAndCapPrompt`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(crew): inject context bundle into the crew trigger prompt (agents no longer start blind)`.

---

## Phase 5 — Presence/typing + kanban live

### Task 5.1: Feed `threadWorkingAgents` from the crew runner

**Files:** Modify `runner.ts` (around `adapter.execute` ~:295). Test `server/src/__tests__/runner-thread-presence.test.ts` (new).

- [ ] **Step 1 (failing test):** when `payload.threadId` (or a mention's thread) is set, `runAoaAgent` calls `threadWorkingAgents.add(threadId, agentId, name)` + `broadcastThreadPresence` BEFORE `adapter.execute`, and `.remove()` + broadcast in a `finally` AFTER. Assert add/remove called (mirror `heartbeat.ts:2611`/`4119`).
- [ ] **Step 2:** FAIL (runner imports only `publishLiveEvent`).
- [ ] **Step 3:** import + call them; resolve the thread id from `payload.threadId` or the mention's discussion. `finally` guarantees removal even on throw.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(crew): conversational runs flip the thread working-agents presence (the pill now lights for chat)`.

### Task 5.2: Humanized activity status

**Files:** Modify `live-events.ts` (add `activity?: string` to the presence entry, ~:166) + `runner.ts` (set it). Test extend `runner-thread-presence.test.ts`.

- [ ] **Step 1 (failing test):** the presence entry carries a humanized `activity` derived from the role/directive — `scout`→"researching", `planner`→"writing the plan", `engineer`→"creating an artifact", default→"typing". Assert the broadcast payload includes it.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** add `activity` to `PresenceEntry`/`ThreadWorkingAgentsStore.add`; compute from `agentRoleKey` in the runner. (v1: a static map by role; richer per-tool activity is a follow-up.)
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(crew): humanized agent activity in thread presence (researching/writing/creating)`.

### Task 5.3: Mount + render the presence pill in the thread view (placeholder loader)

**Files:** Create `ui/src/components/threads/PresenceStrip.tsx` (lift from `OriginCard.tsx:777-867` or export it); Modify `ui/src/pages/ThreadDetail.tsx` + `ui/src/components/threads/ThreadTab.tsx`; Modify `ui/src/context/LiveUpdatesProvider.tsx` to surface `activity`. Test `ui/src/components/threads/__tests__/PresenceStrip.test.tsx` (if UI tests exist; else a render smoke test).

- [ ] **Step 1:** lift/export `PresenceStrip` so it can mount outside `OriginCard`. Render it in `ThreadTab` (near the composer/conversation) reading `workingAgentsByThread[threadId]`. Show `"<AgentName> is <activity>…"` with a small placeholder animated loader (a simple pulsing dot row — TODO marker: "replace with founder-provided loader").
- [ ] **Step 2:** verify in the running UI (or a render test): when an agent is working, the pill appears with the activity text; clears when done.
- [ ] **Step 5:** commit `feat(ui): show humanized agent-typing pill in the thread (placeholder loader)`.
- [ ] **Step 6:** controller files a follow-up chip: "Swap placeholder thread loader for the founder-provided loader asset."

### Task 5.4: Optimistic "summoning…" chip on @mention send

**Files:** Modify `ui/src/components/threads/ThreadTab.tsx` (the send/`addEntryMutation`). 

- [ ] **Step 1:** on send, if the composed text @mentions an agent, optimistically render a transient "Summoning {names}…" chip immediately (client-only), replaced by the real presence pill when `thread.presence` arrives (or cleared after a timeout). Optimistically insert the user's own entry too (today it only invalidates).
- [ ] **Step 5:** commit `feat(ui): optimistic summoning chip + own-entry on @mention send`.

### Task 5.5: Kanban "Live" pill sees crew runs

**Files:** Modify `server/src/routes/agents.ts` `liveRunsForCompany` (~:1715) + `liveRunsForIssue` (~:1826). Modify `ui/src/components/KanbanBoard.tsx:172-180` to render agent name + elapsed. Test `server/src/__tests__/live-runs-includes-crew.test.ts` (new).

- [ ] **Step 1 (failing test):** `liveRunsForCompany` returns issues with an active `internal_agent_runs` row (`status IN ('running','queued') AND related_entity_type='task'`), surfacing `{ issueId: related_entity_id, agentId, agentName, startedAt }` — UNION the existing `heartbeat_runs` query. Assert a crew-executing task appears in the result.
- [ ] **Step 2:** FAIL (today heartbeat_runs only → crew tasks invisible).
- [ ] **Step 3:** add the `internal_agent_runs` UNION to both route helpers (Drizzle). Extend the response shape with `agentName`/`startedAt`. UI: render `"{agentName} · {elapsed}"` in the existing pill when present.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(crew): kanban Live pill reflects crew (internal_agent) runs, not just heartbeat`.

### Task 5.6: Live card moves (board updates when an agent moves a card)

**Files:** Modify `server/src/services/issues.ts` (publish on `setStatus`/`update` status change) + `live-events.ts` (add `issue.status_changed`) + `ui/src/context/LiveUpdatesProvider.tsx` (invalidate `queryKeys.issues.list` on it). Test `server/src/__tests__/issue-status-event.test.ts` (new).

- [ ] **Step 1 (failing test):** an `issueService.update` that changes `status` publishes an `issue.status_changed` LiveEvent `{ issueId, companyId, status }`. Assert published.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** publish the event in the status-change path; add the type to `live-events.ts`; in `LiveUpdatesProvider`, on receipt invalidate the issues list query so the card moves columns live. (Interim fallback if WS plumbing is heavy: add `refetchInterval: 5000` to the issues queries in `Issues.tsx`/`ProjectDetail.tsx`/`CrewBoard.tsx` — but prefer the event.)
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(crew): publish issue.status_changed → board updates live when agents move cards`.

### Task 5.7: Crew Board gets live data

**Files:** Modify `ui/src/components/crew/CrewBoard.tsx:180-186`.

- [ ] **Step 1:** pass `liveIssueIds` (from `liveRunsForCompany`, Task 5.5) + the `agents` map into the Crew Board's `<KanbanBoard>` (today both are `undefined`); subscribe to live updates (Task 5.6) so it refreshes. Render assignee names instead of UUID slices.
- [ ] **Step 5:** commit `feat(ui): Crew Board shows live crew activity + agent names`.

---

## Phase 6 — Verify + live QA

### Task 6.1: Full regression
- [ ] `cd "<worktree>/server" && pnpm exec vitest run` — only the known pre-existing `agent-in-review-guard` baseline failure may remain; zero new failures. `tsc --noEmit` clean on changed files. Grep-confirm no orphaned `requestParticipation`/presence wiring.

### Task 6.2: Live multi-party chat QA (the proof)
- [ ] Restart the instance (loads all changes). On a fresh thread, with real `claude_local` crew, verify:
  - **Manual:** ambient human post → no agent jumps in; `@Scout` → Scout answers (founder-driven) with a "Scout is researching…" pill, and its reply has the prior thread context (not "no precedent / blind").
  - **Assist:** human posts a topic → Adjutant proactively joins; `@Engineer` → Engineer participates; cards do not advance to scope.
  - **Drive:** conversation advances discuss→scope→assign with the crew staying conversational; the kanban shows the task go `todo→in_progress→done` LIVE with an "Engineer · elapsed" pill.
  - **Two participants:** confirm a second human + an agent can both post in the same thread coherently (hop-cap prevents agent ping-pong storms).
  - Capture before/after evidence (DB wakeup statuses: no stuck `queued`; prompt_snapshot now contains context; presence broadcasts observed).
- [ ] Final whole-branch review (subagent) + `superpowers:finishing-a-development-branch`.

---

## Self-review (run after writing — done)

**Spec coverage:** every Locked-design row maps to a task — keep-8/persona-clean (0.2), one-pipeline/@mention-not-dropped (1.1–1.3), wire-doers (2.1–2.2), dial-as-experience + @mention-always-answers (3.1–3.3), context-injection (4.1–4.3), typing/activity pill + kanban live (5.1–5.7), QA (6). Follow-ups (marketplace re-seed, real loader, streaming, role collapse) are explicitly out-of-scope + chipped.

**Placeholder scan:** the only intentional placeholder is the loader UI in Task 5.3, explicitly marked + chipped as a follow-up per the user's instruction ("I'll give you the loader… use something for now"). No TBDs in logic tasks.

**Type/name consistency:** `buildCrewContextBundle` / `contextBundle` (4.1→4.3); `makeThreadParticipationRunner` / `participantRunner` (2.1); `threadWorkingAgents.add/remove` + `activity` (5.1→5.3); `liveRunsForCompany` shape `{issueId,agentId,agentName,startedAt}` (5.5→5.7); `issue.status_changed` (5.6→5.7) — consistent across tasks.

**Sequencing note:** Phase 1 (mentions reach an agent) and Phase 2 (the agent that's reached actually runs) are mutual prerequisites for any live chat; Phase 3 (dial) and Phase 4 (context) make the runs *correct*; Phase 5 makes them *visible*. Build in order; QA only meaningful after Phase 4.
