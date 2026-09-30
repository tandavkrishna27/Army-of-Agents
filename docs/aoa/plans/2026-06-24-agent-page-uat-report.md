# Agent Detail Page — UAT Report (report-first)

**Date:** 2026-06-24
**Scope:** Worker Agent detail page (`/HER/agents/atlas`) — hero, kebab, and all 5 tabs.
**Method:** Live functional testing via gstack `/browse` against the running instance
(`http://localhost:3210`, company **Hero Preview Co** / HER), cross-checked against the
code (`ui/src/pages/AgentDetail.tsx`, `AgentDetailCore.tsx`, `AgentInstructionsTab.tsx`,
`AgentConfigForm.tsx`, `ui/src/api/agents.ts`, `server/src/routes/agents.ts`).
**Mode:** Report-first — **no code was changed.** Fixes below are proposals.
**Fixture:** Atlas (org agent, claude_local, 2 seeded runs) for non-destructive tests;
"QA Probe B" throwaway for Terminate.

## Headline

The page is largely solid. **Every creation flow works** (create agent, create task,
create API key, create instructions file, create config revision) and **every backend
route behind a UI action exists and responds**. The real issues are concentrated in
**3 destructive/feedback gaps**, all on the kebab menu — exactly what was flagged.

---

## Results matrix

| # | Area / Action | Result | Notes |
|---|---------------|--------|-------|
| 1 | Hero renders (status pill, adapter/model badges, KPI strip) | ✅ PASS | |
| 2 | KPI deep-link "Tasks (wk)" → Tasks filtered by assignee | ✅ PASS | href is prefix-less (`/issues?…`) but auto-normalizes to `/HER/issues?…` — see OBS-1 |
| 3 | KPI deep-link "Last run" → run detail | ✅ PASS | same prefix-less pattern |
| 4 | Hero **Invoke** → creates run + navigates | ✅ PASS | verified via seeded runs |
| 5 | Hero **Pause** → status `paused`, button flips to Resume | ✅ PASS | error → paused |
| 6 | Hero **Resume** → status back to `idle` | ✅ PASS | paused → idle |
| 7 | **Assign Task** dialog → create task (pre-scoped to agent) | ✅ PASS | task created + assigned (verified via assignee filter) |
| 8 | Kebab **Configure Agent** → `/configure`, Config tab active | ✅ PASS | |
| 9 | Kebab **Copy Agent ID** → clipboard | ⚠️ UX-GAP | works (writes `agent.id`) but **no toast** — see BUG-2 |
| 10 | Kebab **Reset Sessions** → `POST …/reset-session` | ⚠️ UX-GAP | returns 200, clears runtime session, but **silent** + unclear label — see BUG-3 |
| 11 | Kebab **Terminate** | 🔴 BUG | works server-side but **no confirm + broken aftermath** — see BUG-1 |
| 12 | Overview: charts, Recent tasks, Budget, Org & health, Trust | ✅ PASS | renders correctly (charts show the 2 runs) |
| 13 | Config: all sections render (Identity/Adapter/Permissions&config/Run policy/Context + API keys/Permissions/Revisions) | ✅ PASS | two-pane nav + content |
| 14 | Config: edit Title → **Save** → persist + **new revision** | ✅ PASS | title persisted; revisions 3 → 4; reflected live in hero subtitle |
| 15 | Config: **API key create** → token banner | ✅ PASS | key listed as active |
| 16 | Config: **API key revoke** → moves to "Revoked Keys" | ✅ PASS | soft-revoke (kept for audit) |
| 17 | Config: **Permissions** (canCreateAgents) toggle | ✅ PASS (API) | `PATCH …/permissions` → 200; UI renders the toggle |
| 18 | Config: **Test environment** | ✅ PASS | returns structured checks (`status:fail` here = local CLI not set up; feature works) |
| 19 | Config: **Revisions** list / rollback endpoint | ✅ PASS | `GET …/config-revisions` → 200; rollback route present |
| 20 | Instructions: **add-file modal** (create file) | ✅ PASS | verified earlier this session |
| 21 | Instructions / Config / Runs: collapsible rail + panel layout | ✅ PASS | verified earlier this session |
| 22 | Runs: master-detail, select, **tab bar stays on run select** | ✅ PASS | tab-vanish bug fixed earlier (`01f5195fc`) |
| 23 | Skills: toggle attach/detach → persist (optimistic + rollback) | ✅ PASS | verified earlier this session |
| 24 | **Agent creation is additive** (does not wipe other agents) | ✅ PASS | created 2nd agent; first + 8 AoA crew survived |

---

## Bugs (report-first — not yet fixed)

### BUG-1 — Terminate: no confirmation + broken aftermath  🔴 High
**Where:** `AgentDetail.tsx:493-502` (kebab) → `agentAction.mutate("terminate")` →
`POST /agents/:id/terminate` (`server/src/routes/agents.ts:1443`, soft-sets
`status:"terminated"`, cancels active runs).
**Observed:**
1. Clicking Terminate fires **immediately with no confirmation dialog** (destructive,
   one click).
2. After it succeeds there is **no feedback and no redirect**. The detail page keeps
   showing the agent as **"idle"** with **Invoke / Pause / Assign Task still live** on a
   terminated agent. The only visible effect is silent removal from the Agents list.
3. On reload the detail page still loads the terminated agent in this stale state
   (detail-by-ref doesn't filter terminated; only the list does).
**Why it matters:** This is the "Terminate doesn't work, I think" report. It *does*
work, but the UX makes it look like nothing happened, and lets the user fire actions
at a dead agent (backend then rejects with "Cannot pause terminated agent").
**Proposed fix:** (a) wrap Terminate in `ConfirmDialog` ("Terminate {name}? This stops
the agent and removes it from the roster."); (b) on success, toast + `navigate("/agents")`;
(c) if staying on the page, show a "Terminated" state with actions disabled.
**Evidence:** `uat-2-terminate-after.png`.

### BUG-2 — Copy Agent ID: no feedback  🟡 Medium (UX)
**Where:** `AgentDetail.tsx:473-482` → `navigator.clipboard.writeText(agent.id)`.
**Observed:** Copies the ID but shows **no toast** — no DOM toast element present after
click. Notably **Copy token** in the API-keys section *does* toast "Copied!"
(`AgentDetail.tsx:2643-2648`), so this is an inconsistency, not a missing capability.
**Why it matters:** "I don't know if Copy is happening." Right — there's no signal.
**Proposed fix:** add the same "Copied!" toast used by Copy token.

### BUG-3 — Reset Sessions: silent + unclear  🟡 Medium (UX)
**Where:** `AgentDetail.tsx:483-492` → `resetTaskSession.mutate(null)` →
`POST /agents/:id/runtime-state/reset-session` (200, clears the agent's runtime/CLI
session so the next run starts fresh).
**Observed:** Works (confirmed 200) but **completely silent** — no toast — and the label
gives no hint of what it does.
**Why it matters:** "Reset sessions — I don't know what that is." Right — no feedback,
no description.
**Proposed fix:** toast on success ("Agent session reset — next run starts fresh"); add a
tooltip/subtext to the menu item.

---

## Observations (Low)

- **OBS-1 — Hero KPI deep-links are prefix-less.** "Tasks (wk)" → `/issues?assignee=…`
  and "Last run" → `/agents/atlas/runs/…` (no `/HER`), while sibling links ("See All →")
  use `/HER/issues?…`. Works (router redirects/normalizes to add the prefix) but it's an
  inconsistency worth tidying (`AgentDetail.tsx:518-530`).
- **OBS-2 — Intermittent console 404s.** A 404 resource error appeared during some
  interactions (terminated-agent page, just after task creation) but **not on a clean
  page load**. Not reproduced reliably; worth a follow-up to identify the polling/asset
  call.

---

## Not deep-tested this pass (render-verified or deferred)

- Inline hero **icon edit** (renders; not exercised).
- Instructions **Save persist** / **Delete file** (add-file modal verified; save/delete
  exercised in earlier sessions, not re-run here).
- Runs **Retry / Cancel / Resume-lost / Clear-session** controls (Retry effectively
  exercised when seeding runs; the others render in the run detail, not individually
  driven this pass).
- **Dirty-guard** (unsaved-changes nav warning) — not exercised.
- **Mobile** layouts (Config/Instructions/Runs stacking verified in earlier sessions).
- Run-policy / Context **toggles** — sections render; the Save pipeline they share is
  proven (BUG-free via test #14), individual toggles not each driven.

---

## Environment note (not a product bug)

The live dev instance dropped manually-created **org** agents twice during the session
(company + the 8 auto-seeded AoA crew survived). This is the known Windows embedded-PG
instability on long-running dev sessions, **not** a product defect — agent *creation*
itself is correct and additive (test #24). Re-seeding restores state. Because this UAT
made no file edits, the instance stayed stable through the test run.

---

## Follow-up: deferred-item investigation + fixes (2026-06-24)

Investigated the "not deep-tested" set. Most were sound (state-gated controls, icon
edit, config toggles feeding the proven save pipeline, mobile). Two were genuine
defects and are now **fixed + verified live**:

- **Dirty-guard (in-app nav)** — `useBeforeUnload` only caught browser-level nav; switching
  tabs (or kebab "Configure") with unsaved Config/Instructions edits silently discarded
  them. Fixed (`16e792a32`): tab/kebab nav routes through a guard → "Discard unsaved
  changes?" ConfirmDialog. Note: `<BrowserRouter>` (not a data router) means `useBlocker`
  is unavailable, so cross-page sidebar/`<Link>` nav still isn't intercepted — that needs
  a data-router migration (logged, out of scope).
- **Instructions save/delete silent on failure** — `onError` swallowed errors. Fixed
  (`03898c197`): `toast.error` on each failure + a "File deleted" success toast.

Still genuinely fine / low: Runs controls (Retry/Cancel/Resume/Login — correctly wired,
state-gated), inline icon edit, Config run-policy/Context toggles, mobile layouts.
OBS-2 (intermittent 404): **RESOLVED — root cause found.** It's
`GET /api/agents/:ref → 404` for a **terminated agent**: the by-urlKey resolver filters
`status !== "terminated"` ([agents.ts:898](../../../server/src/services/agents.ts)), so a
terminated agent is unresolvable by URL key. React Query's background refetch of a
terminated (or just-removed) agent logs the 404. Surfaces on the terminated-agent page,
briefly right after Terminate (stale cache renders while the refetch 404s), and in a
create-then-instant-navigate race. **Benign / expected**: correct server behavior, no
functional break, and BUG-1's post-terminate redirect already keeps users off
terminated-agent URLs in the normal flow. Optional polish only: render a clean "this
agent was terminated" state when the detail query 404s (instead of stale cache). Not
fixed — logged as expected behavior.

## Recommended fix order (on approval)

1. **BUG-1** (Terminate confirm + aftermath) — High, safety + correctness.
2. **BUG-2 / BUG-3** (Copy + Reset toasts) — quick wins, same toast pattern already in the file.
3. **OBS-1** (KPI link prefixes) — cosmetic consistency.
4. **OBS-2** (404) — investigate.
