# Thread v2 (Crew) — Per-Release Manual QA Checklist

Run this against a live instance with the crew agents (Adjutant, Engineer, Scout)
configured with a real `claude_local` adapter + valid credentials, before tagging
a release that touches the thread-v2 / crew path. The automated E2E lane
(`.github/workflows/thread-v2-e2e.yml`) is advisory; this checklist is the
authoritative per-release gate for the real-LLM loop.

## Preconditions

- [ ] Instance running locally or on a staging host (not production).
- [ ] `enableIsolatedWorkspaces` set as intended for your test scenario (on for workspace path checks, off is fine for facilitation-only checks).
- [ ] Company has crew agents seeded: **Adjutant**, **Engineer**, **Scout** — all with `adapterType = 'claude_local'` and valid credentials (`ANTHROPIC_API_KEY` in env or adapter config).
- [ ] A **software-development** project exists (required for the Engineer workspace / build path — sections 2 and 7).
- [ ] Confirm all three agents show `status = 'idle'` (not `pending_approval`, not `terminated`) before starting.

---

## 1. Facilitation loop (Adjutant)

- [ ] Navigate to **Discussions** in the sidebar and click **+ Discussion** to create a new thread. New threads default to `useControllerPath = true` — confirm by checking the thread's `use_controller_path` column is `true` in the DB, or by observing that the inline-drain path fires (not the legacy sweep-adjutant path).
- [ ] Post a vague human entry: "we should improve onboarding". Within approximately 1 minute the Adjutant posts a reply in-thread (a facilitation entry with `inputType = 'agent'`). Confirm it is NOT silent.
- [ ] Continue the conversation: reply "let's add a guided checklist; start with the empty-state". The Adjutant should converge toward a **Scope Proposal** card (rendered as `data-testid="scope-proposal-card"`) rather than continuing to ask open-ended questions indefinitely.
- [ ] With the scope proposal showing the `data-testid="scope-proposal-active-badge"` label ("Active Proposal"), post another human message BEFORE approving. Confirm the Adjutant does NOT immediately re-run and spam another entry — the stale-run suppression (kill-test) holds: the existing scope proposal stays visible and the conversation stays coherent. The new human entry sets `pendingRun = true`, and the next controller run supersedes the prior one.

---

## 2. Scope approval → deliverable build (Engineer)

- [ ] In the scope proposal card (`data-testid="scope-proposal-card"`), click the edit pencil on one task title (`data-testid="scope-proposal-task-0"`). Change the title to something specific. Then click **Approve** (`data-testid="scope-proposal-approve"`).
- [ ] Confirm deliverable tasks are created in the DB (`issues` table) with `source_discussion_id` set to this thread's ID and `status` in (`todo`, `backlog`, `in_progress`). In the UI, navigate to **Team → Crew Board** (sidebar item, routes to `/team?tab=tasks`) and confirm the tasks appear.
- [ ] If no explicit agent is assigned, confirm the task is assigned to the **Engineer** agent (the default builder). If no Engineer agent exists in the company, confirm the task is flagged as needing a worker (unassigned, status `backlog`).
- [ ] The Engineer's task dispatches a heartbeat run: a `heartbeat_runs` row appears with `agent_id = <Engineer id>`. The Engineer works in the thread's workspace and posts the result back into the thread as an `agent` entry.
- [ ] Open the execution workspace for the task (TaskSlideOver → Workspace tab). Confirm the workspace starts from a clean state (no dirty residue from a prior unrelated run) and that the build output is real (not a placeholder).

---

## 3. Stale-proposal guard

- [ ] Create a fresh thread and drive it to a scope proposal (see section 1). Do NOT approve.
- [ ] Post a new human entry in the same thread (anything — this advances `entrySeq`).
- [ ] Now try to approve the now-stale proposal (its `proposalCursorSeq` is behind the thread's current `entrySeq`). Confirm the approve action is **rejected** — the UI or API returns an error indicating the proposal is out of date, and no tasks are materialized. The thread continues normally without the stale tasks appearing.

---

## 4. Failure card

- [ ] Cause a deliverable task to fail: assign an impossible shell command to the Engineer, or kill the heartbeat run process mid-run. Wait for the run to reach `status = 'failed'`.
- [ ] Confirm a **crew failure card** (`data-testid="crew-failure-card"`) appears in the thread as a system entry (`sourceInfo.type = 'crew_failed'`). The card shows the task title and error message (`data-testid="crew-failure-error"`). The thread does NOT show a silent `failed` status with no explanation.
- [ ] Click **Retry** (`data-testid="crew-failure-retry"`): confirm the task is re-queued and a new heartbeat run starts.
- [ ] In a separate run: click **Skip** (`data-testid="crew-failure-skip"`): confirm the task transitions to `cancelled` and no retry fires.
- [ ] In a separate run: click **Reassign** (`data-testid="crew-failure-reassign"`): confirm the task detail opens (TaskSlideOver) so the assignee can be changed.

---

## 5. Hop-cap card

- [ ] Create a thread and drive agent-to-agent dispatch chains (via `agent.dispatch` in the Adjutant's tool calls) until the hop counter hits the configured cap (default: 3 hops) without a human entry intervening.
- [ ] Confirm a **hop-cap decision card** (`data-testid="hop-cap-decision-card"`) appears in the thread as a system entry (`sourceInfo.type = 'hop_cap_reached'`) showing the hop count and cap. The card message reads: "The crew has reached the hop cap without a human checkpoint. Scope the work to create deliverables, or reply to let the crew continue."
- [ ] No additional silent agent round fires after the hop-cap entry.
- [ ] Post a human reply in the thread. Confirm the hop counter resets (next controller run finds a fresh human entry and the Adjutant responds normally without immediately hitting the cap again).

---

## 6. Budget + pause gates

- [ ] Navigate to **Budget** (Company → Budget). Set a company budget hard-stop at or below the current cumulative spend for this company.
- [ ] Post a human entry in a thread. Confirm no agent run fires and an in-thread system entry appears explaining the crew is paused due to budget. The entry should be `inputType = 'system'` and reference the budget constraint. No `heartbeat_runs` row is created.
- [ ] Remove or raise the budget limit. Confirm the crew resumes on the next human entry.
- [ ] Separately: toggle `crewPaused = true` on a specific thread (via the DB or the thread settings, if exposed). Post a human entry. Confirm no agent runs fire for that thread. Toggle back and confirm the crew resumes.

---

## 7. Presence + typing

- [ ] Open a thread where the Engineer has an active heartbeat run (task in `in_progress`). Confirm the thread's presence strip shows the **agent working indicator** (`data-testid="agent-working-indicator"`) — e.g. "Engineer working" — scoped to THAT thread only.
- [ ] Open a different thread simultaneously. Confirm the agent-working indicator does NOT appear in the unrelated thread (the `workingAgentsByThread` map is keyed by thread ID).
- [ ] While a human is typing in the thread (from another browser session or tab), confirm the typing indicator (`data-testid="typing-indicator"`) still appears and is scoped to humans only — not contaminated by agent presence.

---

## 8. Personas

Test all three crew roles in the same release:

- [ ] **Adjutant** facilitates — it posts clarifying questions, summaries, and scope proposals (`inputType = 'scope_proposal'`). It does NOT create tasks directly, does NOT build artifacts, and does NOT advance the phase without founder approval.
- [ ] **Engineer** builds — when dispatched on a deliverable task, it ships working output (a real file or artifact), runs a verification pass, and posts the result back into the thread. It does NOT act as a facilitator.
- [ ] **Scout** researches — when dispatched by the Adjutant for investigation (via `agent.dispatch` with Scout's agent ID), it cites internal sources (memory items, existing discussions) or performs a search. It posts a research summary entry (`inputType = 'agent'`) and does NOT create tasks or attempt to build artifacts.
- [ ] Confirm all three use distinct "voices" — different tone, structure, and tool usage — confirming the instruction prompts are differentiated.

---

## 8. Work-as-Tasks (crew chokepoint) — release additions

The unified work=task model: every piece of crew work is born as an inline scope card through the single `crew-task-service` chokepoint, gated by the per-thread autonomy pill (L0/L1/L2).

- [ ] **Autonomy pill renders correctly.** On a thread, open the autonomy pill and set each level. The label must read **Manual** (0) / **Assist** (1) / **Drive** (2) — NOT "Semi"/"Auto", and **L0/Manual must render** (no blank/"Auto off"). The picker offers `Off / Manual / Assist / Drive`.
- [ ] **Propose at convergence.** Drive a thread to convergence (see §1). The Adjutant calls `propose_crew_work` → an inline **scope card** (`inputType = 'scope_proposal'`, `proposal_status = 'pending'`) appears in the thread chat.
- [ ] **L0/L1 — human approves.** With the thread at Manual or Assist, the card stays pending. Tap **Approve** → tasks appear on the **Team → Crew Board**, each stamped `origin_kind = 'crew_thread'` (confirm in DB or that they render on the board).
- [ ] **L2 — auto-approve.** Set the thread to **Drive**, drive to convergence. The same card is written and **auto-approved** (no manual tap); tasks appear on the board and the assignees are dispatched (`heartbeat_runs` rows). The card remains visible in-thread as the audit record.
- [ ] **One-pending guard (no duplicate cards).** Rapidly click the phase-advance control while the Adjutant is proposing. Confirm **exactly one** pending scope card exists (the partial-unique index `discussion_entries_one_pending_scope_proposal_idx` holds) — never two.
- [ ] **Budget gates dispatch, not the card.** At Drive with crew budget exhausted (or crew paused), confirm the scope card is **still written** (human can approve later) but auto-dispatch is **skipped** with an in-thread reason. Raising budget + approving then dispatches normally.
- [ ] **Crew board grouping + agent filter.** The board groups tasks by source thread (`crew-board-group-<threadId>`). Selecting an agent in `crew-board-agent-filter` re-queries and narrows to that agent's crew tasks.
- [ ] **Per-task audit card.** Click a task card on the crew board → the audit card opens (Sheet) showing the run's tool calls, token cost, and outcome (`crew-audit-tools`, `crew-audit-cost`, `crew-audit-outcome`).
- [ ] **Result relay.** When a crew task completes successfully, its result posts back into the originating thread as an `agent` entry (best-effort — a relay failure never fails the run).
- [ ] **Planner is a normal worker.** Assign a "write the plan" task to the **Planner** (via a `propose_crew_work` task with `assigneeRole = 'planner'`). It runs like any worker, creates a plan artifact (`create_artifact`), and posts back — it is NOT a special phase-advance trigger.
- [ ] **Dispatcher retired.** A newly-created company seeds **no Dispatcher** agent (Command Staff = Navigator + Planner + Memory Keeper). Confirm inbound routing/branching still works via the **Navigator** (`attach_to_thread` / `spin_off_thread`). Commander's ad-hoc `create_task` (non-thread) is unaffected.
- [ ] **Archive UX.** Hover a thread row in the Discussions sidebar → the kebab reveals **Archive**; archiving moves the thread into the **Archived** column on the discussions board.

---

## Sign-off

| Field | Value |
|-------|-------|
| Commit SHA | |
| Date | |
| Instance URL / environment | |
| Tester | |
| All sections pass? | [ ] Yes |

Notes / exceptions:

---

*This checklist is generated from the thread-v2 implementation. If UI labels or card test-ids change, update this checklist in the same PR that changes the component.*
