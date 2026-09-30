# Discussions End-to-End — Design / Scope

**Date:** 2026-07-03
**Status:** Draft for review (brainstorming output → to be turned into implementation plans)
**Goal:** Make the Discussions feature *completely functional, correct, and good-grade* — from a human (or inbound) message, through crew collaboration, into scoped work that is assigned, dispatched, executed, and looped back — governed by clear autonomy dials and human guardrails.

---

## 1. Context & current state (keyless `main`, HEAD 75593fd4c)

The core pipeline **already works** on current `main` (the earlier "broken" impression was a 133-commit-stale checkout). Verified live end-to-end:

- Discussion create → entries → **keyless CLI extraction** (no hosted key; only embeddings need a key) → real items → approve → **Tasks + Memory**.
- Scope draft compiles **real items** from pending extracted items; scope accept + apply → tasks.
- Adjutant `@mention` → `propose_crew_work` → scope draft with real items.
- UI: Discussions workspace, Tasks board, live Activity feed all render correctly.

**The gaps this initiative closes** (from the live sweep + code investigation):

1. **Crew Board never auto-populates from a discussion** — tasks land *unassigned* (org board), and Drive autonomy didn't auto-approve/dispatch. Crew board renders fine; the gap is **auto-assignment + dispatch**.
2. **Scope-compiler placeholder** ships dev-TODO titles ("Implement real multi-message scope generation") when a draft compiles with zero pending items (`thread-scope-draft-compiler.ts:94-106`; a test pins it).
3. **Crew has no writable workspace for task execution** — crew tasks run in the server's `process.cwd()`, so a crew Engineer can't do isolated repo work. The worktree provisioner exists but is org/heartbeat-only.
4. **No thread loopback** — `relayCrewResult` fires only from the org heartbeat path, never from the crew runner (`runAoaAgent`), so crew task completion never posts back into the originating discussion.
5. **No crew workspace/repo context in discussions** — participation runs in `process.cwd()`, not the department's repo; and department-scoped threads are visible to *any* crew agent (`adjutant-context.ts:24` TODO).
6. **Deferred-but-inconsistent surfaces** — dead/dirty code (stale docstrings, deprecated-but-live debrief path, gated-off Scribe drain).

---

## 2. Target experience (the north star)

Default autonomy is **Assist**. Example: a founder migrates auth to JWT.

1. **Capture** — founder opens Discussions → New thread, picks a scope (e.g., Backend dept), types/pastes the idea. Or it arrives from MCP/webhook → **Navigator auto-routes** (attach to matching thread / spin off new / drop to Unlisted when unsure, per a confidence threshold).
2. **Round-table** — `@Adjutant` convenes Scout / Engineer / Planner; each posts a real perspective in-thread. Crew context is **scoped to the thread's department** (no cross-department bleed).
3. **Scope in one action** — `@Adjutant scope this` → Adjutant **extracts first** (keyless CLI) → compiles a scope draft from **real items** (never a placeholder). Each task is **role-tagged** (Engineer/Scout/…) by the scoper.
4. **Assist** — tasks are **auto-created + auto-assigned** to the tagged crew → **Crew Board populates immediately**; a **dispatch approval** lands in the **Inbox** (one click → go).
5. **Execution** — on approval, each crew task runs via the AoA dispatcher; the agent gets a **writable git worktree** (software tasks) → does the work → captures results (artifact / task_outputs / run summary).
6. **Loopback** — on completion, results **post back into the originating thread** ("Engineer finished the token endpoint → PR #123"). The founder sees discussion → crew debate → scoped work → done in one place.
7. **Memory** — Memory Keeper proposes memory (decisions/preferences) at phase=done; founder approves → central memory; future discussions retrieve it.
8. **Control** — a **Discussions section in Settings** governs defaults (autonomy, routing, crew on/off, memory-extraction). Any thread can be dialed **Drive** (hands-off) or **Manual** (approve every step).

**The three dials:**
- **Manual** — crew debates + proposes; humans approve every step (create, assign, dispatch).
- **Assist (default)** — auto-scope + auto-assign to the board; humans approve dispatch.
- **Drive** — the whole arc runs end-to-end automatically. *Exception:* memory is always human-gated (see §3).

---

## 3. Design decisions (locked in brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Crew flow automation | **Dial-scaled**: Manual=propose · Assist=auto-create+assign, approve dispatch · Drive=full auto |
| D2 | Task→crew assignment | **Role-tagged by the scoper** (Adjutant/Planner tags a crew role per task → resolves to the crew agent — one agent per role, push). Founder can reassign. **Scope note:** auto-assignment in this initiative is **crew-only**; tasks for **org agents / humans land unassigned for manual routing** — auto-routing to org agents (department pull/pickup) is a **follow-up** (§6). |
| D3 | Default autonomy | **Assist** for new companies, with a Settings control to change it |
| D4 | Crew repo context | Split by need: **participation** = on-demand scope-resolved read/search (agent pulls what it needs; multi-repo & company-wide safe, memory fallback). **execution** = one target repo per task (primary `project_workspace` or picked) with a **writable worktree** |
| D5 | Department scoping | **Context-scoping**: keep the shared crew pool, narrow each run's context (repo/memory/sibling threads) to the thread's department; company-wide threads get broad context |
| D6 | Extraction trigger | **Deliberate** (phase=done / Adjutant scoping / reprocess). Adjutant **extract-then-scope**. **Kill the placeholder stub** so an empty thread never shows a fake card |
| D7 | Inbound routing | **Auto-route with confidence threshold**: attach / spin-off / Unlisted fallback; threshold configurable in Settings |
| D8 | Dispatch approval UX | **Inbox / attention hub** (one-click), consistent with existing approval flows |
| D9 | Approval RBAC | **Anyone in the thread** can trigger scoping + approve dispatch. Guardrails still hold: **budget policies bound spend**, and **crew can't write memory directly** |
| D10 | Crew round-table | **Must-have** — make the Adjutant convening Scout/Engineer/Planner reliable |
| D11 | Execution loop | **Full** — wire the existing writable-worktree provisioner + `relayCrewResult` thread loopback + a crew run-summary into `runAoaAgent` |
| D12 | Memory approval | **Fully human-gated at every autonomy level** (incl. Drive); proposed items queue in the **Inbox** (founder: identity/domain; team-lead: active_context). `working` auto-creates. Loosening at Drive = separate future decision |
| D13 | Voice + Live threads | **Deferred** (separate larger features) |
| D14 | Dead-code cleanup | **Full batch**, but **each removal verified 100% safe** (no live usage) before deleting |
| D15 | Quality bar | **Unit + E2E + live-verified** per piece (matches AoA CI gates) |
| D16 | Settings surface | New **Discussions section**: default autonomy dial · routing behavior + threshold · crew on/off · memory-extraction toggle · extraction-trigger preference |
| D17 | Task naming | **All task titles are agent-authored.** Crew paths already are (proposedTasks / extracted items / no card). The human "Create scope draft" button's derived title (longest entry's first sentence, W2 interim) is a stopgap — the button becomes **"Ask Adjutant to scope"** (async crew run → agent-named draft). Sequenced AFTER the fake-crew-harness CI follow-up (filed during W1c) that unblocks its e2e story. (Locked at W2 eng-review, 2026-07-03) |
| D18 | Crew autonomy column | **Separate column** for crew/discussions autonomy — `internal_agent_config.autonomyLevel` stays Commander-only. One dial must not secretly drive two systems; the crew dial lives in Settings → Discussions, Commander's in Commander settings. **New-company crew default = Assist** (D3 carried onto the new column: tasks auto-create parked + ONE Inbox `crew_dispatch` approval gates any agent execution). (Locked 2026-07-04) **BUILT 2026-07-24** as `internal_agent_config.crew_autonomy_level` (migration `0183`, existing rows backfilled from the shared column). Two deltas from the spec above: the dial also governs **org-agent heartbeat runs** (same question, same answer — see Decision #109 addendum §11), and the control shipped in **Settings → Commander → Execution** rather than a Discussions section, because no Discussions settings section exists yet. Full reader enumeration: Decision #109 addendum §10. |
| D19 | Workspace granularity | **Per-discussion shared workspace** (W3b): all tasks born from one thread share one worktree/branch — work compounds, runs sequentially (visible queueing via W8). Reuses the existing thread-workspace machinery + unique constraint + run-lock as-is. Non-software threads get no workspace; department-scoped threads must narrow to a project (or use its primary repo) before code work dispatches; unscoped threads get **no repo access, honestly stated**. Escape hatch noted: opt-in per-task mode later IF parallel crew coding inside one thread becomes a real pattern. (Locked 2026-07-04) |
| D20 | Routing threshold | **Deterministic similarity gate** (W5): the act-vs-suggest line is embedding-distance math (top-1 distance + gap vs runner-up, re-wiring the orphaned `findSimilarThreadsScored`), fail-closed to suggest/human when embeddings are absent. The Navigator still chooses WHICH thread; the LLM never gates its own authority. In-thread entry routing stays OUT of scope (moving a user's own message is intrusive; suggestion-banner idea for later). (Locked 2026-07-04) |
| D21 | Stale-reply visibility | **Subtle inline notice, deduped per burst** (W8): when epoch-stale suppression discards a superseded agent reply, post one system line ("reply superseded — re-reading latest messages") instead of silence. Behavior unchanged (discard + re-run against the full multi-user conversation is already correct); only the visibility is added. (Locked 2026-07-04) |

---

## 4. Stress-test constraints (edge cases → design rules)

Validated against six adversarial scenarios; the design holds, with these explicit rules:

- **Shared-crew concurrency** — one Engineer, multiple threads: atomic checkout + concurrency clamp serialize execution. **Add a "queued / agent busy" indicator** so an assigned-but-waiting task reads clearly.
- **Mid-flow dial change** — a running task owns its checkout and completes; *new* actions respect the new dial.
- **Budget exhaustion at Drive** — the budget gate stops dispatch and posts a "budget reached" system entry (existing behavior; keep).
- **Human interrupts the round-table** — epoch-stale detection discards stale agent work when a newer human entry lands; hop-cap posts "Agent loop reached hop cap — scope or continue?". **Make this UX graceful/visible.**
- **Permissive RBAC (D9)** — open permission, but **spend is bounded by budget** and **memory can't be agent-written**, so "anyone in the thread" is safe.
- **One entry → task + memory** — task auto-dispatches (per dial), memory always queues for human approval (D12).

---

## 5. Implementation scope (what to build / wire)

Grouped into workstreams. Most of the "hard" machinery already exists and needs **composing**, not building.

### W1 — Crew Board auto-population (the headline fix)
- `propose_crew_work` / `crew-task-service`: ensure each task carries a **role-tagged assignee** that resolves to the crew agent (D2), so tasks land **assigned** (crew board), not unassigned.
- Wire **Assist** to auto-create + auto-assign and raise a **dispatch approval** into the Inbox (D1, D8); **Drive** to auto-dispatch; **Manual** to propose-only.
- Verify the scope-apply path stamps crew assignees.

**STATUS (2026-07-03):**
- **W1a SHIPPED** (PR #265) — controller `create_scope_draft` resolves `assigneeRole`→crew agent + forwards `proposedTasks` → compiler emits assigned task_proposal items (D1 dedup). Crew board auto-populates *assigned*.
- **W1b SHIPPED** (PR #265) — autonomy-gated auto-accept: Manual=draft / Assist=auto-create+assign `planning` (no dispatch) / Drive=`standard`+dispatch. Drive dispatch runs `preflightCrewDispatch` (budget/pause hard-stop; blocked → draft left for manual). Memory stays founder-gated (D12).
- **W1c MERGED** (PR #267, squash `9e6f9be3e`; 7 Codex rounds) — Assist raises a `crew_dispatch` Inbox approval; approving flips the parked `planning` tasks → `standard` + dispatches them (same preflight; blocked → throws + rolls back, approval stays pending); rejecting leaves them parked. Reuses `approvalService` + the generic `approval_request` hub item (no new UI). Tasks-only (memory stays separately gated, D12).

### W2 — Extraction-then-scope + kill the stub
- Adjutant scoping triggers extraction first (D6), so scope drafts compile from real items.
- Remove/replace `titleForGeneratedTask` + `memoryCandidateTitle` placeholders (`thread-scope-draft-compiler.ts:94-106`); derive from summary or suppress the synthetic item when there are zero real items. Update the pinning test (`thread-scope-draft-compiler.test.ts:56`).

**STATUS (2026-07-04): MERGED to main** (PR #270, squash `a8fe3cd8f`; 12 Codex review rounds converged on the range-integrity invariant — a draft exists iff it captures ≥1 piece of content and its accepted range covers exactly the terminally-captured entries; enforced by `rangeEndCap` + the zero-card `no_items` guard + the no-op idempotency-key revive + the in-flight cap/stale-reclaim; proof surface = 8 real-Postgres integration cases + 13 unit cases) — Controller `create_scope_draft` awaits `extractionService.extractThreadEntriesAwait` before compiling: conservative selection (never-extracted entries only — pending/skipped/failed with ZERO items; entries a founder may be mid-review on are untouched; reprocess keeps its delete+re-extract semantics), serial, 25-entry cap + 180s wall-clock deadline (eng-review D2), best-effort/never-throws. The compile then passes `suppressFallbackTask: true` — an extracted-and-empty thread shows **no fake card**. The keyword-stub titles are dead everywhere; the human create-draft route (no synchronous extraction) keeps one fallback card titled from the longest entry's first sentence (≤80) as the D17 interim.

**NEXT-PHASE SEQUENCE (locked 2026-07-04, after the W3-W9 gap-analysis investigation):**
1. **Fake-crew harness** (~1-2d) — extend `fake-crew-llm.ts` (already in CI) with a controller-mode branch mirroring `propose-crew-work.ts` so the W1 pipeline (create_scope_draft → commit → autonomy gate → crew_dispatch approval) is CI-testable; un-skips `team-aoa-crew-dispatch-approval.spec.ts`; unlocks D17. — **DONE** (fake-crew harness PR): control-file-scripted controller-mode fake turn + CI Assist/Drive spec; W1 approve→dispatch now CI-covered.
2. **W3a: relay + run-summary** (~2d) — wire `relayCrewResult` + a crew run-summary comment into `runAoaAgent`'s success/failure paths; closes the founder loop for ALL task types. — **DONE** (feat/w3a-crew-loopback): composed `postCrewRunSuccess`/`postCrewRunFailure` (per-substep best-effort) in `crew-run-outcome.ts`; shared `postRunSummaryComment` (heartbeat delegates); D1-D4 locked; outside-voice-hardened (2 P1 build-blockers fixed pre-build); 55 unit + 4 real-Postgres integration. **Follow-ups:** (a) a crew failure BEFORE `runId` is assigned (pre-run-setup throw) skips the failure card — narrow edge, guard is `payload.issueId && runId`; (b) D2 no-dedup-guard rests on crew_thread tasks always having a `kind='aoa'` assignee — a founder cross-kind reassignment could double-post; (c) generalize the write-back beyond `claude_local` (crew defaults claude_local); (d) [code-review P3] the SUCCESS relay posts "Completed:" even when the agent moved the task back to todo/backlog itself (exit 0, not stuck) — **inherited from heartbeat** (`heartbeat.ts:~4426`, same no-terminal-status-check), so fix org+crew together, not diverged; (e) [code-review P3] cosmetic negative `durationMs`/`costCents` on NTP backward clock skew (wall-clock, not monotonic). **FIXED pre-merge:** code-review P2 — the failure loopback's issue fetch is now company-scoped (`and(id, companyId)`) so a foreign-company wakeup issueId can't write into another company's thread (the SUCCESS relay was already guarded; the FAILURE path, reachable via a checkout-threw catch, was not). `detectedFiles: []` until W3b.
3. **W3b: workspaces** (~1-1.5wk) — per-discussion shared worktree (D19); extract heartbeat's workspace-resolution preamble into a shared helper.
4. **W5+W6 together** — Settings → Discussions section (D16/D18) + similarity-gate threshold (D20) in one settings-flavored effort.
5. **W8** — queued/busy pill + stale-reply notice (D21).
- **W7 WAITS** for the unmerged inbox-hub branches (`feat/inbox-hub` ~50 commits ahead with divergent hub UI copies, `feat/inbox-hub-integration`, `codex/inbox-hub-next-roadmap`) to resolve — collision territory. **W9 last** (its Scribe-drain deletion is preconditioned on live-verified W3).

### W3 — Execution loop (compose existing machinery into `runAoaAgent`)
- **Writable worktree:** compose `resolveThreadDeliverableWorkspace` / `realizeExecutionWorkspace` into the crew runner for `software_development` tasks, **per-discussion shared workspace (D19 — supersedes this section's earlier "one repo per task" phrasing)**. Populate `paperclipWorkspace.cwd` so the adapter runs in the worktree.
- **Thread loopback:** call `relayCrewResult` from the crew runner's success/finally path (D11) so completion posts back to `sourceDiscussionId`.
- **Crew run-summary:** emit a heartbeat-style run-summary `issue_comment` (duration/tokens/cost/files) on crew tasks.
- **Known limitation:** the crew write-back tool bridge is `claude_local`-only today; generalizing it to codex/opencode is a **noted follow-up**, not a blocker (crew defaults to `claude_local`).

### W4 — Crew context + department scoping
- **Participation:** a scope-resolved read/search capability so crew reads the relevant repo(s) on demand (D4-participation); resolve candidate repos from thread scope.
- **Context-scoping:** narrow a crew run's context (repo/memory/sibling threads) to the thread's department (D5); implement the `adjutant-context.ts:24` TODO.

### W5 — Routing
- Navigator auto-route with a confidence threshold: attach / spin-off / Unlisted fallback (D7). Expose threshold in Settings.

### W6 — Settings: Discussions section
- New Settings section (D16): default autonomy · routing behavior + threshold · crew on/off · memory-extraction toggle · extraction-trigger preference. Assist default (D3).

### W7 — Inbox integration
- Dispatch approvals (D8) and memory-approval queue (D12) surface in the Inbox / attention hub.

### W8 — UX affordances
- "Queued / agent busy" task indicator; graceful hop-cap / stale-round-table messaging (from §4).

### W9 — Dead-code cleanup (verified-before-delete, D14)
- Scope stub (W2, already covered); stale `addEntry` docstring (`discussions.ts:889-894`) + schema default (`schema/discussions.ts:176`); stale Decision #91 note re `/internal-agent/confirm`; deprecated-but-live debrief path (`extractFromDebrief` + MCP `debrief-push`) — migrate to Discussions or document; schedule deletion of the gated-off Scribe-drain surface. **Each removal preceded by a usage check.**

---

## 6. Follow-ups (deferred to later efforts, not out of scope forever)

Tracked as explicit follow-up initiatives after this one:

- **Auto-routing scoped tasks to ORG agents** (the founder's *hired*, per-department team) — e.g. a department **queue** that a free org agent **picks up** (pull / load-balances across a department's multiple agents). Deferred deliberately: it drags in the **human side** (agent vs human for a given task), **access/permissions** (which org agent may claim what), and likely a **pickup/claim tool** — all of which need their own design. **Non-blocking:** this initiative auto-assigns **crew** tasks (one agent per role); tasks destined for **org agents / humans land unassigned for manual routing**, exactly as today. Nothing regresses.
- **Voice input** (currently 501) and **Live threads** (`subtype='live'` schema stub) — separate larger features (D13).
- **Loosening memory autonomy at Drive** — separate governance decision (D12).
- **Generalizing the crew write-back bridge** beyond `claude_local` (codex/opencode) — so all crew adapters can post task results (W3).
- Deep execution *quality* (how good the agent's code is) — relies on the existing CLI adapters/execution system.

---

## 7. Quality bar & acceptance (D15)

- **Per change:** unit tests; **key flows:** Playwright E2E; **before "done":** live-verified end-to-end on a real instance.
- **Acceptance (end-to-end):** On a fresh company at Assist — a founder creates a discussion, crew round-tables, converges; `@Adjutant scope` produces real (never placeholder) role-tagged tasks that appear on the **Crew Board assigned**; a dispatch approval appears in the **Inbox**; approving it runs the crew agent in a **writable worktree**; results **post back into the thread** and onto the task card; memory proposals queue for approval. Same flow at **Drive** runs without dispatch clicks (memory still queued); at **Manual** every step is founder-gated.

---

## 8. Risks / open questions

- **Bridge limitation (W3):** non-`claude_local` crew adapters can't call write-back tools yet → their tasks would release back to `todo` via the silent-stuck guard. Mitigation: crew defaults to `claude_local`; generalize later.
- **Concurrency UX:** shared-crew queueing must be legible or it looks stuck.
- **Cleanup safety (D14):** the deprecated debrief path is still live — verify all callers before touching.
- **Sequencing:** W1 (auto-population) is the highest-value, most-visible fix and a natural first plan; W3 (execution loop) is the largest. Suggested order: W1 → W2 → W6/W7 (settings + inbox) → W4 → W3 → W5 → W8 → W9.

---

## 9. Next steps

1. User reviews this scope doc.
2. Turn each workstream into an implementation plan (writing-plans), starting with **W1 (Crew Board auto-population)**.
3. Plan reviews (eng / design / DX / office-hours) per workstream before building.
