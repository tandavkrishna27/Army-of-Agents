# Viewer Upgrade — Multi-Surface Live Test Plan

> Goal: on a real running instance with real Claude/Codex agent runs, verify the Viewer Upgrade works on ALL THREE surfaces — Commander, Discussions, Workspace — for both halves of each feature: (1) the **in-place card/chip** in the surface, and (2) **opening it in that surface's viewer**. Report what appears; user verifies.

## Environment (isolated — no collision with other agents/instances)

- **Worktree:** `C:\Users\TK\.aoa\wt\vwr` on branch `feat/viewer-upgrade` (short path avoids OneDrive MAX_PATH). Isolated code — other agents editing the main checkout can't disturb this run.
- **Instance:** `AOA_INSTANCE_ID=vwrtest`, `PORT=3411`, `AOA_EMBEDDED_POSTGRES_PORT=54411` — unique ports + own data dir (`C:\Users\TK\.aoa\instances\vwrtest\db`). Won't collide with any other AoA instance.
- **Mode:** `local_trusted` + `AOA_DEV_LOCAL_IDENTITY=1` (no auth). Commander CLI = Claude (installed + authed). One crew agent for the software department.
- **Durable server:** run by the USER in a terminal (survives; my background server gets reaped ~10-15 min). I drive the UI + report.

## Setup steps (one-time)

1. Worktree + install + (no build needed — tsx runs TS directly).
2. User starts the durable server (command provided).
3. Onboard: company **Viewer QA**, one **software_development** department (enables Workspace), Commander=Claude, one crew agent.
4. **Runtime approvals ON** (default) — so we also exercise the confirm-route fix (`f2a472793`).

---

## Surface 1 — Commander

**Generate:** ask Commander to (a) **create a task**, then (b) **create a document artifact** with markdown content.

**Verify — task (nav ref, Phase 7A):**
- [ ] Approve the runtime-approval card ("Allow once").
- [ ] A **nav chip** appears under Commander's reply (the confirm-route fix — previously absent). ✅ known-good when approvals OFF; this checks the fix ON.
- [ ] Clicking the chip opens a **TaskDetail** tab in the Commander viewer.
- [ ] Auto-open: with viewerControl = `own_output` (default), a `created` task auto-opens ONE tab.

**Verify — artifact (Phase 6 render):**
- [ ] Chip `{kind:"artifact"}` appears; clicking opens the artifact in **SharedContentViewer** (markdown renders).
- [ ] Set viewerControl → **Manual** in Settings; create another artifact → chip appears but does NOT auto-open (governance).

**Evidence:** conversation API `outputRefs` on the message; viewer tab list; screenshot if it renders.

---

## Surface 2 — Discussions

**Put a thing in + generate:** create a Discussion thread, post work, get a **crew agent** to run a task spawned from the thread (autonomy Drive → auto-dispatch, or approve the crew_dispatch). Wait for the run to FINISH.

**Verify — delivery (Phase 7B):**
- [ ] On run finish, a **"Run finished — N result(s)"** entry appears in the thread (the `deliverCrewRunResult` entry; fires even if the task stays in review).
- [ ] That entry shows **clickable ref chips** (`OutputRefChips` on `EntryRow` from `entry.outputRefs`) — the task + its artifacts/outputs.
- [ ] Clicking each chip opens the right **Thread viewer** body: task→TaskDetail, artifact→artifact viewer, output→OutputRefTabBody, discussion→DiscussionRefTabBody, approval→ApprovalDetailCore.

**Verify — hybrid attachment card (Phase 3):**
- [ ] If the crew produced an artifact attached to an entry, the entry shows the **hybrid card** — inline image preview OR pop-to-panel for docs; download preserved.
- [ ] Thread entry content renders as **markdown** (Phase 3 EntryRow → MarkdownBody).

**Also confirm:** codex/claude reports `server:"aoa"` on the crew run (the one Phase-6 gate not yet live-exercised) — check the crew agent actually produces refs.

**Evidence:** discussion entries API `outputRefs` on the run-result entry; the thread viewer tab that opens on chip click.

---

## Surface 3 — Workspace

**Run a real task:** on the software department, create a task with an **isolated workspace**, dispatch it to the crew agent (real code/file work). Wait for the run.

**Verify — Workspace viewer (Phase 4 + reuse):**
- [ ] The task's outputs (detected files / artifacts) appear in the Workspace **OutputsSection**.
- [ ] Timeline **attachment cards** render as hybrid (Phase 4: inline image / pop-to-panel `asset` tab).
- [ ] Opening an output/artifact renders in **WorkProductViewer** (the Workspace content viewer).
- [ ] (Deferred, note only) Workspace does NOT yet ingest delivered navigational refs (7B Workspace ingress was deferred) — so no nav-chip delivery here; that's expected.

**Evidence:** `task_outputs` API for the issue; the Workspace preview tab that opens.

---

## Surface 4 — Phase 5 viewerControl (cross-cutting, already live-verified)

- [x] `/me` GET → `{effectiveLevel:"own_output",source:"company"}`; PATCH "manual" → `{effectiveLevel:"manual",source:"user"}`, persists. (Done 2026-07-19.)
- [ ] Re-confirm the two Settings selects drive auto-open behavior in Surface 1.

---

## Reporting

For each surface, I report: what I generated, what appeared (chip/card + which viewer body opened), API evidence (`outputRefs`/`task_outputs`), and any gap/bug. User verifies each in their own browser. Bugs found → fix in source (atomic commit) → re-verify (the /qa loop).

## Known caveats going in

- My background server gets reaped ~10-15 min → USER runs the durable server.
- Crew scoping from a discussion has historically been gated (extraction off-by-default, scope-draft placeholder fallback) — Surface 2 may need the crew task created/dispatched more directly if the auto-scope pipeline stalls.
- Confirm-route fix (`f2a472793`) is unit-tested; Surface 1 live-verifies it.
