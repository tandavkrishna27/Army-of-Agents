# Crew Collaboration In-Thread — Design

**Status:** design for review (not yet planned/implemented)
**Origin:** live-thread investigation ("how dose the aoa crew work", QA-Crew-Live, dial Assist). The Adjutant jumped to a scope proposal + approval when the founder wanted the crew to *come into the thread and work together*. Root cause: the Adjutant's only "make work happen" move is `propose_crew_work` (scope into tracked tasks); there is no first-class "bring the crew in to collaborate here" move, and the approval flow then dead-ended.

---

## 1. The principle: two gears, founder-driven

A thread has two distinct "forward" gears. The Adjutant *facilitates and suggests*; it never *imposes* the switch.

- **Gear A — Convene the crew (collaborate in-thread).** The founder calls the crew; the relevant agents come into the thread and contribute (perspectives, research, drafts, artifacts). No approval, no board tasks. This is the **discuss** phase.
- **Gear B — Scope into tasks.** The founder decides it's ready to track; a scope proposal is made, the founder approves the inline card, tasks land on the crew board. This is **scope → assign**.

They are a **sequence, not a guess**: collaborate first (A), formalize later if wanted (B). The bug was the Adjutant skipping A and forcing B.

---

## 2. Decisions (locked with founder)

| # | Decision |
|---|----------|
| D1 | Collaboration has **two modes**, the **Adjutant picks per topic**: **round-table** (everyone weighs in at once) for quick "what do you all think", **relay** (sequenced, agents build on each other + produce artifacts) for working sessions. |
| D2 | Add a **dedicated Reviewer crew agent** that critiques artifacts/plans in-thread (the last relay step). The **founder still gives final approval** — the Reviewer is a first-pass critic, not a gate. Preserves the "founder is gatekeeper" thesis. |
| D3 | Approval source of truth stays the **inline proposal card**. The Adjutant must **point to the card** ("tap Approve to create the N tasks"), never claim it advanced the phase. (Chat-word approval = optional later convenience.) |
| D4 | The Adjutant **stops auto-scoping during discuss**. It converses + convenes; it only **suggests** scoping and calls `propose_crew_work` when the founder explicitly asks. |
| D5 | Collaboration is **never a board task**. Convening shows as "crew weighing in" (entries + presence); only an approved scope proposal creates board tasks, sourced to the thread. |

---

## 3. Feature: `convene_crew` (Gear A)

The plumbing exists: `@mention` dispatches a crew agent into the thread and it self-posts (`requestParticipation` → `runAoaAgent` → `post_entry`, Phase 2). Missing: a first-class "bring the relevant crew in" move.

**New Adjutant tool `convene_crew`:**
- Input: `topic`, `mode` (`round_table | relay`), `roster` (ordered list of roles the Adjutant chose for this topic).
- A **"contribute as a participant" directive** distinct from the doers' default task/artifact directives — convened agents *advise and weigh in* (and produce an artifact when the step calls for it), they do not "go execute a tracked task".
- No phase change, no proposal, no board.

**Round-table** = fan out participation to all roster agents at once; the Adjutant synthesizes after.

**Relay** = moderated sequence. Approach (reuse the existing event-driven controller, no new workflow engine): the Adjutant (already the thread controller, wakes on `thread.entry.created`) dispatches step 1, and on each subsequent wakeup sees "Scout posted research → now Engineer" and dispatches the next via `agent.dispatch`, threading the prior outputs as context. The order emerges from the Adjutant's moderation rather than a hardcoded state machine. A lightweight `conveneSession` marker on the thread (active mode + ordered roster + cursor) keeps it on track and lets the UI show "relay in progress (step 2/4)".

**Trigger / light gate:** founder says "get everyone's take" / "@crew" / "everyone weigh in" → Adjutant convenes a relevant roster. If who/whether is ambiguous, it asks once ("Bring Scout, Engineer, Planner in?"). Optional UI affordance: a "Bring crew in" control / `@crew` mention.

---

## 4. Feature: Reviewer crew agent (D2)

> **Cross-repo dependency (founder note):** the Reviewer agent must be added through the **marketplace repo** (`meteoritelabs/aoa-marketplace-cdn` catalog + its agent bundle/skill) and installed from there — it is a marketplace-distributed crew member, not a hardcoded default-seed agent. This is a coordinated change in BOTH repos (catalog entry there; install/recognition here). Until then, the "review" *behavior* is available as an instruction stopgap (the Adjutant dispatches an existing agent to critique). Build this phase only after the instruction version (Phases 1–2) is validated in testing.

- New role `reviewer` (seed file `ensure-reviewer.ts`, `ROLE_MIN_AUTONOMY`, onboarding bundle, tool allowlist) following the existing crew-agent pattern (`seed-crew-agent.ts`).
- **Directive:** critique the artifact/plan/perspective in-thread — strengths, gaps, risks, concrete fixes — then `post_entry` with the critique. It does **not** approve or create tasks; it advises. The founder remains the approver.
- **Where it sits:** the last step of a relay working session (research → build → structure → **review** → synthesize). The Adjutant can also summon it ad hoc ("@Reviewer check this").
- Min-autonomy: available from Assist (it only posts a critique; same class as Scout).

---

## 5. Feature: Adjutant directive change (D4)

Rewrite `ROLE_ACTION_DIRECTIVE.adjutant` (`aoa-trigger-prompt.ts`): in the **discuss** phase, converse and (when the founder wants the crew) `convene_crew`; only **suggest** scoping ("this is getting concrete — want me to turn it into tracked tasks?") and call `propose_crew_work` **only when the founder explicitly asks** or moves the thread to scope. Optional guard: `propose_crew_work` requires a founder scope signal / scope-phase.

---

## 6. Feature: approval fix (D3)

- The Adjutant must **point to the inline card** when the founder approves in chat ("tap **Approve** on the proposal above and I'll have the 4 tasks created"), and must **never** narrate "moving to assign phase" at a dial where it cannot (Assist). Remove the false-advance behavior.
- (Inline card → `POST …/proposals/:id/approve` already works at any dial and creates the tasks. No gate change needed.)
- Optional later: conversational approval (a `approve_pending_proposal` tool the Adjutant calls when the founder clearly approves).

---

## 7. Feature: legibility (D5)

- Convening renders as "crew weighing in" (perspective entries + presence), visibly **not** the board. Relay shows "step 2/4".
- A scope proposal card reads "Approve → creates N tasks on the board"; after approval those tasks appear on the crew board sourced to this thread.
- A one-line cue that discussion ≠ tracked tasks.

---

## 8. Key files (where the work lands)

- `server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts` — Adjutant directive (D4), convene/relay/reviewer directives.
- `server/src/services/internal-agent/tools/convene-crew.ts` (new) + tool registry + Adjutant allowlist.
- `server/src/services/internal-agent/aoa-agents/ensure-reviewer.ts` (new) + `autonomy.ts` (`reviewer` role) + seeding wiring (`index.ts`).
- `server/src/services/internal-agent/aoa-agents/controller-adjutant-runner.ts` / `thread-orchestration.ts` — relay moderation (dispatch next on wakeup); `conveneSession` marker.
- `packages/db/src/schema/discussions.ts` — `conveneSession` (jsonb, nullable) if we persist relay state.
- `ui/src/components/threads/` — "Bring crew in" affordance, "crew weighing in" / relay-step rendering, the approval-card cue.

---

## 9. Open questions / risks

- **Relay orchestration is the meaty part.** LLM-moderated (Adjutant drives step-by-step on its wakeups) avoids a new workflow engine but leans on the Adjutant's judgment; needs guardrails (max steps, no infinite relay, hop cap reuse). Worth an eng-review before building.
- **Cost:** a relay is N agent runs per convene; round-table is N parallel runs. Need a sane default roster size and a cap.
- **Reviewer scope:** critique-only (no approve power) keeps the founder as gatekeeper. Confirm it never mutates tasks/artifacts.

---

## 10. Rough phasing (for the plan)

1. **Approval fix + directive de-scope (D3, D4)** — small, high-value, stops the broken/confusing behavior immediately.
2. **`convene_crew` round-table (D1 half)** — first real Gear A, reuses @mention fan-out.
3. **Reviewer agent (D2)** — new role, usable standalone (@Reviewer) before the relay.
4. **Relay mode (D1 half) + legibility (D5)** — the orchestration + UI. The biggest lift; eng-review first.

---

## 12. Marketplace sync — STANDING follow-up (founder, 2026-06-03)

Crew agents/instructions/skills are **seeded from the marketplace repo** (`meteoritelabs/aoa-marketplace-cdn`), not only from the local `ensure-*` / directive code. So every agent-definition change made locally this session (and the last few days) must be **mirrored into the marketplace repo** or new installs won't get it. Items to propagate:
- **Adjutant** — new persona + action directive (convene the crew in-thread; do NOT auto-scope; point to the Approve card). `ensure-adjutant.ts` + `aoa-trigger-prompt.ts`.
- **Engineer + Planner** — advise-first thread directives (Planner fix). `aoa-trigger-prompt.ts`.
- **Reviewer agent (Phase 3)** — added as a NEW marketplace crew member (catalog entry + bundle + skill + tool allowlist + autonomy/config).
- **Everything else this session that touched agent definitions:** crew task tools on Scout/Engineer/Planner allowlists (Spec B), the Chronicler agent + bundle, Navigator allowlist/directive, the autonomy 0/1/2 remap, persona-text cleanup — all of it.
- Plus the **skills and config** those agents rely on.

Action: a reconciliation pass that diffs the local crew definitions against the marketplace catalog and lands the deltas there (coordinated change, both repos). Track separately from this doc.

## 11. Deferred — revisit AFTER the Memory rework (founder, 2026-06-03)

The founder is actively reworking Memory; the retrieval/scoping items below are entangled with it, so revisit after it settles (building now = building on shifting ground). Live-verified state: the convene fix (Phases 1+2) shipped + works (Adjutant convened Scout/Engineer in-thread, no scope proposal, no board tasks).

- **Department-scoped retrieval.** Scout searches **company-wide** today. Both the auto-injected context-bundle memory (`crew-context-bundle.ts` → `searchMultiPath(companyId, …)`) and Scout's tools (`find_similar_memory_hnsw`, `search_discussions`, `query_threads`, `find_similar_threads`) filter by `companyId` only (memory can narrow by *layer*, not department). The data IS department-organized (`memory_items.departmentId` + the `domain` layer) and threads CAN be department-scoped (`discussions.scopeType='department'`), but that scope does **not** flow into retrieval. To make "a software thread → the crew searches the software department's knowledge," pass the thread's scope into the context bundle + the search tools.
- **Repo/board routing (which repo does an agent read?).** Separate channel from memory search. Code access goes through **execution workspaces**: task → its project/department → that project's git repo → a worktree of that repo (this is how Engineer read `WelcomeScreen.tsx` in the convene test). With multiple boards/repos, routing is "task → its project → that project's repo." Extending this so the crew can search/read the right repo **during a thread discussion** (not only task execution) is the feature to design. Ties to Memory + workspaces + projects.
- ~~**Planner advise-vs-build.**~~ **DONE (2026-06-03, commits `e899cacc2` + `ab3fb950b`).** Two parts: (1) directive — engineer/planner advise first, build only for a real deliverable; (2) **the real root cause** — Planner's tool allowlist lacked `post_entry` (it had only `create_artifact`/`create_artifact_version`), so it ran on an @mention, could call no tool, and stayed silent. Added `post_entry`. Live-verified: Scout → Engineer → Planner now each weigh in, building on the last (full loose relay). **Was a config gap, not pure instruction.** The DB allowlist was patched live for the test; the code change must propagate via the marketplace repo.
