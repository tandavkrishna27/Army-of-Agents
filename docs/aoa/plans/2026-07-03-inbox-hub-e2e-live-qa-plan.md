# Inbox / Approvals Hub — Live E2E QA Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or execute inline via /browse. Steps use checkbox (`- [ ]`) syntax. This is a **live exploratory + scripted QA sweep driven from the real UI in a browser** — NOT a code-writing plan. Every scenario: set up → drive the UI → observe → capture evidence → mark PASS/FAIL. Do NOT "fix as you go" — record failures via the Bug Protocol (§Bug Protocol) and keep sweeping so we get full coverage, then triage.

**Goal:** Verify every Inbox/Approvals hub feature and user scenario works end-to-end by driving a real running AoA instance from a browser — covering hub navigation, all approval types + side effects, W5 runtime-decision permissions (the "create a task, run it, watch the permission land, answer it, run proceeds" loop), crew-dispatch autonomy, notifications/toasts, suggestions, lifecycle actions, and RBAC.

**Architecture:** Run one isolated `local_trusted` AoA instance from this worktree on a pinned port + embedded Postgres (Windows harness from memory `qa-isolated-main-instance`). Drive it with gstack `/browse` (real Chromium via Playwright — the canonical browser path per user CLAUDE.md; never `claude-in-chrome`). Runtime-decision scenarios need real authed `claude`/`codex` CLIs on the machine (both confirmed authed this session) + `AOA_RUNTIME_DECISION_ROUTING=1`. Scenarios that can't be driven from UI alone (trust-rule seeding, forced timeouts, budget hard-stop) use a documented API/SQL/env side-door, flagged per scenario.

**Tech Stack:** AoA (React/Vite UI, Express server, Postgres/Drizzle, local-CLI adapters). gstack `/browse`. `pnpm` workspace. Embedded Postgres. `gh`/`curl` for API side-doors.

**Source of truth:** the feature matrix in the task record for this plan (19 hub semantic types across 3 lanes; approval types `hire_agent`/`crew_dispatch`/`approve_ceo_strategy`/`budget_override_required`; runtime-decision kinds/answers/timeout-policies/trust-rules; crew autonomy 0/1/2). File:line references inline below.

---

## Conventions

- **Instance base URL:** `http://localhost:$QA_PORT` (default `QA_PORT=3399`). Company-scoped routes are `/<companyPrefix>/...`.
- **Evidence:** every scenario captures at least one artifact into `docs/aoa/qa/inbox-hub-<date>/` — a `/browse` screenshot (`SHOT-<scenario-id>.png`) and/or the observed JSON from a `curl` read. Reference the file in the checkbox result.
- **Result tag:** end each scenario by writing one line to `docs/aoa/qa/inbox-hub-<date>/RESULTS.md`: `<scenario-id> — PASS|FAIL|BLOCKED — <one line> — <evidence file>`.
- **Two founders:** the sweep uses the single `local_trusted` synthetic board user for founder actions. RBAC scenarios (§9) that need a non-founder are BLOCKED-documented (local_trusted has no second human) unless run in an `authenticated` instance — noted in that scenario.
- **Never fix inline.** See Bug Protocol.

### Verified mechanisms (from plan review — use these exact paths)
- **Company create/PATCH:** `POST /api/companies`, `PATCH /api/companies/:id` accepts `requireBoardApprovalForNewAgents` (`companies.ts:126/165`; default = `deploymentMode!=="local_trusted"` at `:134`). Onboarding via `Lobby.tsx openOnboarding()`.
- **Agent create:** `POST /api/companies/:cid/agents` accepts `adapterType` + `runtimeConfig.runtimeDecisionRoutingEnabled` (`agents.ts:1198`). **Runtime toggle is API-only — no UI toggle** → Phase 1.3 must seed agents via API.
- **Runtime-decision answer (Phase 6 — CONFIRMED UI-DRIVABLE):** `RuntimeDecisionPanel` in `HubViewer.tsx:260-370` renders **Allow once / Allow always / Deny** (permission) and a textarea+Send (work_question); wired to `POST /api/companies/:cid/agent-runtime-decisions/:id/answer` (`agent-runtime-decisions.ts:113`). Trust-rule list/revoke API at `agent-runtime-decisions.ts:30-37`. The `viewerKind:"reserved"` label is a taxonomy marker, NOT a blocker.
- **Snooze IS implemented** (matrix "future" was WRONG): `HubViewer.tsx:194-196` button + `hub-items.ts:273-278` `snooze()`/`unsnooze()`. Test it in Phase 2 (added below).
- **Thread autonomy:** `threads.ts:171-177` `setAutonomyLevel()` PATCH.
- **Hub route:** `/<prefix>/inbox-hub/:lane/:itemId` lanes `waiting|notifications|suggestions`, legacy `/inbox`→redirect (`App.tsx:209-211`, `InboxHub.tsx:32-42,113`).

---

## Bug Protocol

When a scenario FAILs:
- [ ] Capture: screenshot + the failing network response (`/browse` console/network or `curl`) + server log tail (`docs/aoa/qa/inbox-hub-<date>/LOG-<scenario-id>.txt`).
- [ ] Write a bug entry to `docs/aoa/qa/inbox-hub-<date>/BUGS.md`:
  ```
  ## BUG-<n> — <title>
  Scenario: <scenario-id>
  Severity: BLOCKER | MAJOR | MINOR
  Repro: <exact UI steps>
  Expected: <...>  Actual: <...>
  Evidence: SHOT-..., LOG-...
  Suspected file: <file:line if known>
  ```
- [ ] Classify severity: **BLOCKER** = launch-blocking (founder can't complete the core loop); **MAJOR** = feature broken but has a workaround; **MINOR** = cosmetic/copy.
- [ ] Do NOT fix now. Continue the sweep. Triage happens after full coverage (§Triage).

---

## Phase 0 — Environment bring-up

### Task 0.1: Build the workspace
**Files:** repo root (this worktree `C:/Users/TK/.aoa/wt/inbox-hub`).

- [ ] **Step 1: Install + build all packages** (server/adapters/db/shared must be built before the server boots).

Run:
```bash
cd "C:/Users/TK/.aoa/wt/inbox-hub"
pnpm install
pnpm -r build
```
Expected: build completes with no errors across `@armyofagents/*`.

- [ ] **Step 2: Confirm CLIs authed** (runtime-decision scenarios depend on these).

Run:
```bash
claude --version 2>&1 | head -1; codex --version 2>&1 | head -1; codex login status 2>&1 | head -1
```
Expected: claude prints a version; `codex-cli 0.130.0`; `Logged in using ChatGPT`. If claude is NOT authed, §6 claude scenarios become BLOCKED (codex path still runs).

### Task 0.2: Isolated instance config
**Files:** Create `C:/Users/TK/.aoa/wt/inbox-hub/.aoa-qa/config.json` (git-ignored scratch), pin PG dataDir + port.

- [ ] **Step 1: Write the worktree-local config** (pins an isolated embedded-PG dataDir + port so this QA instance can't collide with the dev instance).

```bash
mkdir -p "C:/Users/TK/.aoa/wt/inbox-hub/.aoa-qa/pgdata"
cat > "C:/Users/TK/.aoa/wt/inbox-hub/.aoa-qa/config.json" <<'JSON'
{
  "deploymentMode": "local_trusted",
  "database": { "embedded": { "port": 54399, "dataDir": "C:/Users/TK/.aoa/wt/inbox-hub/.aoa-qa/pgdata" } }
}
JSON
```
Expected: file exists. (If the config schema differs, read `server/src/config` / `docs/deploy/database.md` and adapt keys — verify against `docs/deploy/env-vars` at execute time.)

- [ ] **Step 2: Verify the port + dataDir are free** (no other AoA instance on 54399/3399).

```bash
netstat -ano | grep -E '54399|3399' || echo "ports free"
```
Expected: `ports free`.

### Task 0.3: Launch the instance
**Files:** server entrypoint (`server/src/index.ts` / the `pnpm start`/`dev` script — confirm in root `package.json`).

- [ ] **Step 1: Boot with all QA env in one shot** (background process; runtime-decision flag ON).

```bash
cd "C:/Users/TK/.aoa/wt/inbox-hub"
AOA_CONFIG="C:/Users/TK/.aoa/wt/inbox-hub/.aoa-qa/config.json" \
AOA_INSTANCE_ID="qa-inbox-e2e" \
PORT=3399 \
AOA_RUNTIME_DECISION_ROUTING=1 \
pnpm start   # or the correct prod/serve script from package.json (NOT the dev watcher)
```
Run in background. Expected: log shows server listening on 3399 + embedded PG on 54399 + migrations applied.

- [ ] **Step 2: Health check.** (Verified route: `/api/health` — `server/src/app.ts:254`, `server/src/routes/health.ts`. Start script: `node dist/index.js` = `pnpm --filter @armyofagents/server start` after `pnpm -r build`; honors PORT/AOA_CONFIG/AOA_INSTANCE_ID/AOA_RUNTIME_DECISION_ROUTING — `server/src/config.ts:33-74`. Config shape in 0.2 confirmed: `deploymentMode` + `database.embedded.{port,dataDir}`.)
```bash
curl -s http://localhost:3399/api/health
```
Expected: 200 / ok JSON. If not, tail the server log, fix the launch (not the product), retry.

### Task 0.4: Connect the browser
**Files:** gstack `/browse` binary.

- [ ] **Step 1: Open the app in a real browser and confirm it renders.**

Use `/browse` to goto `http://localhost:3399` and screenshot.
Expected: AoA lobby / company selector renders (LobbyShell). Save `SHOT-0.4-lobby.png`.

- [ ] **Step 2: Create the evidence dir.**
```bash
mkdir -p "C:/Users/TK/.aoa/wt/inbox-hub/docs/aoa/qa/inbox-hub-2026-07-03"
: > "C:/Users/TK/.aoa/wt/inbox-hub/docs/aoa/qa/inbox-hub-2026-07-03/RESULTS.md"
: > "C:/Users/TK/.aoa/wt/inbox-hub/docs/aoa/qa/inbox-hub-2026-07-03/BUGS.md"
```

---

## Phase 1 — Fixtures

### Task 1.1: Company A (loopback-trusted, hire auto-idle)
- [ ] **Step 1:** From the UI, run the create-company flow (onboarding wizard). Name `QA-Loopback`. Accept `local_trusted` defaults (`requireBoardApprovalForNewAgents=false`).
- [ ] **Step 2:** Record its `companyPrefix` (from the URL after selecting it). Expected: lands on Home with empty-state cards.
- [ ] Evidence: `SHOT-1.1-companyA-home.png`. Result line.

### Task 1.2: Company B (board-approval ON, for hire-approval scenarios)
- [ ] **Step 1:** Create a second company `QA-BoardApproval`. This one needs `requireBoardApprovalForNewAgents=true`. In `local_trusted` the create default is false, so set it explicitly:
```bash
# side-door: flip the flag via API (companyId from the UI or GET /api/companies)
curl -s -X PATCH http://localhost:3399/api/companies/<companyB_id> \
  -H 'content-type: application/json' \
  -d '{"requireBoardApprovalForNewAgents": true}'
```
(Verify the PATCH route/field name against `server/src/routes/companies.ts` at execute time; if not settable via API, note BLOCKED and use an `authenticated`-mode instance for §3.1.)
- [ ] Evidence: the PATCH response showing the flag true. Result line.

### Task 1.3: Agents
- [ ] **Step 1 (Company A):** Hire a `codex_local` agent `Scout-Codex` with `runtimeConfig.runtimeDecisionRoutingEnabled=true`, `executionTarget=local`. Via UI Agents → New; set the runtime-decision toggle if the form exposes it, else via API:
```bash
curl -s -X POST http://localhost:3399/api/companies/<companyA_id>/agents \
 -H 'content-type: application/json' \
 -d '{"name":"Scout-Codex","adapterType":"codex_local","runtimeConfig":{"runtimeDecisionRoutingEnabled":true,"contextMode":"standard"}}'
```
Expected: agent created `idle` (Company A auto-idle). Confirm on Agents page.
- [ ] **Step 2 (Company A):** Hire a `claude_local` agent `Scout-Claude` with the same `runtimeConfig` (skip if claude not authed — mark its scenarios BLOCKED).
- [ ] Evidence: `SHOT-1.3-agents.png`. Result lines.

---

## Phase 2 — Hub shell, navigation, lifecycle (no external agent needed)

These use **seeded hub items** so we exercise the shell deterministically. Seed via the API side-door (matrix §8.3 `seedHubItem` is a test helper; the live equivalent is `POST` to the hub route or a direct producer — confirm the live create path in `server/src/routes/hub-items.ts` / `hub-source-producers.ts`). If no live create endpoint exists, seed 1 real approval (§3) and 1 real notification (§5 run) instead and run these against those.

### Task 2.1: Lanes + legacy redirect
- [ ] Navigate `/<prefixA>/inbox` → assert auto-redirects to `/<prefixA>/inbox-hub/waiting`. (matrix §2.1)
- [ ] Click each lane tab: **Waiting on you**, **Notifications**, **Suggestions**. Assert URL slug changes (`waiting`/`notifications`/`suggestions`) and the list filters to that lane's semantic types.
- [ ] Evidence: `SHOT-2.1-lanes.png` (one per lane). Result line.

### Task 2.2: Status filter tabs
- [ ] Toggle **Open / Resolved / Archived** tabs; assert `?status=` in URL persists across a lane switch. Assert Open shows active items, Resolved/Archived empty initially.
- [ ] Evidence + result.

### Task 2.3: Grouping + density
- [ ] Change group mode (`auto`/`source`/`scope`/`type`/`none`) — assert the list regroups. (matrix §2.2)
- [ ] Toggle density comfortable↔compact — assert card layout changes.
- [ ] Evidence + result.

### Task 2.4: Lifecycle — resolve / archive / undo
- [ ] On a seeded/real **notification** item: click Resolve → item leaves Open list, toast appears with **Undo**. Click Undo (within deadline) → item returns to Open. (matrix §2.3)
- [ ] Archive a different item → moves to Archived tab. Undo from there → back to Open.
- [ ] Evidence: `SHOT-2.4-resolve-undo.png`. Result.

### Task 2.4b: Snooze (CONFIRMED implemented)
- [ ] On an open item, click **Snooze** (`HubViewer.tsx:194`), pick a future time. Assert item hides from Open; reappears at/after the snooze time (or via unsnooze). (`hub-items.ts:273-278`)
- [ ] Evidence: `SHOT-2.4b-snooze.png`. Result.

### Task 2.5: Claim / release
- [ ] On a board-owned item (an approval), click Claim → shows current-user avatar / claimedBy. Release → back to pool. (matrix §2.3)
- [ ] Evidence + result.

### Task 2.6: Optimistic concurrency (409)
- [ ] Open the same item in two `/browse` tabs. Resolve in tab 1. In tab 2 (stale `version`), attempt Resolve → expect a 409 / "item changed, refresh" handling, not a silent success. (matrix §2.3 `expectedVersion`; side-door `bumpHubItemVersionForTest` if needed to force the mismatch.)
- [ ] Evidence: network 409 + UI message. Result.

### Task 2.7: Bulk actions + read state
- [ ] Multi-select 2+ items, bulk Resolve. Assert per-item results (all resolve, or partial with a 409 reported). (matrix §2.3)
- [ ] Open an unread item; assert `readAt` set (badge/bold clears).
- [ ] Evidence + result.

---

## Phase 3 — Approvals + side effects

### Task 3.1: Hire-agent approval (Company B)
- [ ] **Trigger:** In Company B (board-approval ON), hire an agent `PendingHire` via Agents → New.
- [ ] **Observe:** Agent shows `pending_approval`; Inbox **Waiting on you** shows an `approval_request` item "Approve hire: PendingHire". (matrix §3.1, `agents.ts:784`)
- [ ] **Act (approve):** Open the item → ApprovalDetail → Approve. Assert: agent flips to `idle`; hub item → Resolved; activity log entry exists.
- [ ] Evidence: `SHOT-3.1-hire-approve.png` + agent status after. Result.
- [ ] **Reject variant:** Hire `PendingHire2`, Reject the item. Assert agent stays `pending_approval`, item Resolved (rejected), and (if a resubmit affordance exists) resubmit returns it to pending. (matrix §3.2)
- [ ] Evidence + result.

### Task 3.2: RBAC on approval
- [ ] Confirm the Approvals surface + Approve/Reject actions are founder/board-gated (matrix §3.3, `HUB_AUTHORITY_BY_TYPE.approval_request="founder"`). In `local_trusted` the only actor is the synthetic board user → this is a code-read confirmation + a note that a true non-founder denial needs an `authenticated` instance. Mark PARTIAL/BLOCKED accordingly.
- [ ] Result line documenting the limitation.

### Task 3.3: budget_override_required (if reachable)
- [ ] If a UI path raises `budget_override_required` (crew budget preflight, §7.3), capture it here; else defer to §7.3. Result note.

---

## Phase 4 — Discussions → crew dispatch (autonomy 0/1/2)

Requires the discussion→scope-draft pipeline. **Extraction is off by default + needs a local CLI**; per the matrix, with 0 extracted items the scope-draft compiler emits a PLACEHOLDER (`thread-scope-draft-compiler.ts` fallback). So for a REAL scope draft, extraction must produce items. Two paths: (a) enable extraction with an authed CLI + valid config; (b) if that's not feasible in the sweep, test the autonomy GATING with the placeholder path and clearly note the extraction dependency. Decide at execute time; record which path was used.

### Task 4.1: Manual (autonomy 0)
- [ ] Create a discussion in Company A, set thread autonomy = **Manual (0)**. Post an entry describing 2-3 tasks. Trigger scope-draft (crew propose).
- [ ] **Observe:** a `scope_proposal` / `discussion_pending` item in **Waiting on you**; NO tasks auto-created; founder must accept each card. (matrix §7.1)
- [ ] Evidence: `SHOT-4.1-manual.png`. Result.

### Task 4.2: Assist (autonomy 1) — the one crew_dispatch approval
- [ ] Set a thread autonomy = **Assist (1)**; produce a scope draft.
- [ ] **Observe:** tasks auto-created + assigned as `work_mode: planning` (non-dispatchable, amber "Planning" pill on IssuesList); Inbox raises **ONE** `crew_dispatch` `approval_request` "Dispatch N crew tasks?". (matrix §7.1/§7.2)
- [ ] **Act (approve):** approve it → assert tasks flip `planning→standard` + dispatch wakeups enqueue (task rows go active / heartbeat runs appear). Hub item → Resolved. (matrix §7.2, `approvals.ts` crew_dispatch side effect)
- [ ] Evidence: `SHOT-4.2-assist-approve.png` + task work_mode before/after. Result.
- [ ] **Reject variant:** new Assist thread → Reject the crew_dispatch → tasks stay `planning`, item Resolved(rejected). Result.

### Task 4.3: Drive (autonomy 2)
- [ ] Set thread autonomy = **Drive (2)**; produce a scope draft.
- [ ] **Observe:** tasks auto-created as `standard` + auto-dispatched; NO Inbox approval raised (crew_dispatch skipped); heartbeat runs start. (matrix §7.1)
- [ ] Evidence: `SHOT-4.3-drive.png`. Result.

### Task 4.4: Preflight budget hard-stop
- [ ] Set Company A `monthBudgetCents` low and drive spend at/over it (side-door: set budget via Settings→Budget or API; simulate spend via a cost_event insert if no natural spend). On an Assist approve, assert preflight throws → approval STAYS pending with a "budget blocked" message, tasks stay planning. (matrix §7.3, `crew-budget.ts`)
- [ ] Evidence + result. (Mark BLOCKED if spend can't be forced without deep seeding.)

---

## Phase 5 — Notifications lane + toasts + preferences

### Task 5.1: run_complete / run_failed
- [ ] **Trigger:** dispatch a trivial task to `Scout-Codex` (Company A) that succeeds → after the run, **Notifications** lane shows `run_complete`. Then dispatch a task designed to fail (e.g., agent config pointed at a bad command) → `run_failed`. (matrix §1.2, heartbeat emit)
- [ ] Evidence: `SHOT-5.1-run-notifs.png`. Result.

### Task 5.2: Realtime toast + bridge
- [ ] With the Inbox open in `/browse`, trigger an event (approve an item / a run completes) and assert a **toast** appears without reload (LiveEvents→toast bridge, matrix §2.5). Assert the toast Undo works where applicable.
- [ ] Evidence: `SHOT-5.2-toast.png`. Result.

### Task 5.3: extraction_failed
- [ ] In a discussion, submit an entry with extraction enabled but a broken CLI/config → assert `extraction_failed` notification + actionable guidance copy (classified `not_installed`/`not_authed`/etc., matrix §5.2). Result.

### Task 5.4: Preferences — quiet hours + digest  ⚠️ LIKELY BLOCKED (no settings UI)
- [ ] Plan review found **no Notifications settings UI** (quiet hours / digest are fetched at `InboxHub.tsx:156-157,708` but not configurable in-app). First: confirm there's genuinely no Settings→Notifications tab (`SettingsLayout`). If confirmed → mark **BLOCKED (no UI)** and exercise the mechanism via the `notification_preferences` API/side-door if one exists (`GET/PUT /api/companies/:cid/notification-preferences` — verify), else record as a coverage gap → candidate for the W2 backlog. Do NOT count as a product bug (it's unbuilt UI, not broken UI).
- [ ] Evidence: the file check + any side-door result. Result line (BLOCKED expected).

---

## Phase 6 — Runtime decisions (W5) — THE HEADLINE LOOP

This is the "create a task, run the relevant one, watch the permission come in, answer it, run proceeds" flow the user explicitly called out. Requires: `AOA_RUNTIME_DECISION_ROUTING=1` (set in Phase 0), agent `runtimeConfig.runtimeDecisionRoutingEnabled=true`, local target, authed CLI. (matrix §4.5 — all four gates.)

### Task 6.1: codex_local command permission — ALLOW ONCE
- [ ] **Trigger:** Create a task in Company A assigned to `Scout-Codex` whose instructions force a **risky network command** (e.g., "run exactly: `powershell -Command \"Invoke-WebRequest -Uri https://example.com -UseBasicParsing | Out-Null\"` as your only action"). Dispatch it. (Under `untrusted` policy a benign command auto-approves; a network command prompts — protocol doc §2.)
- [ ] **Observe:** within seconds, **Waiting on you** shows an `agent_runtime_decision` permission item with the command + cwd + reason; the task/run enters `waiting_on_human`. (matrix §4.1)
- [ ] **Act:** open it → **Allow once**. Assert: decision → answered→relayed; the codex run PROCEEDS and completes; hub item → Resolved. (matrix §4.2, `allow_once→accept`)
- [ ] Evidence: `SHOT-6.1-permission-allow.png` (the permission card) + run-complete after. Result. **This is the crown-jewel scenario — if it fails, BLOCKER.**

### Task 6.2: codex_local — DENY
- [ ] New task, same risky command → permission item → **Deny**. Assert: decision→relayed(decline); the command is rejected; run reflects the refusal (errorMessage / fails or continues without the command). (matrix §4.2, `deny→decline`)
- [ ] Evidence + result.

### Task 6.3: codex_local — ALLOW ALWAYS → trust rule → auto-answer on repeat
- [ ] New task, risky command → permission item → **Allow always**. Assert: decision→relayed(acceptForSession) AND a trust rule is created (commandHash+riskClass). (matrix §4.3)
- [ ] **Repeat:** dispatch the SAME command again → assert it is **auto-answered (no new Inbox prompt)** by the trust rule; the run proceeds without founder action. (matrix §4.3 auto-answer)
- [ ] Evidence: `SHOT-6.3-allow-always-then-auto.png` (prompt count stays 1). Result.

### Task 6.4: codex_local — file-change approval + trust boundary
- [ ] New task instructing the agent to **write a file inside cwd** (e.g., `notes.txt`). Assert a file-change permission item appears (path shown); **Allow once** → file written, run proceeds. (matrix §4 codex fileChange; W5c driver enriches path from item/started.)
- [ ] **Out-of-tree variant:** instruct a write to `../../etc/passwd` (or an absolute out-of-cwd path). Assert it is **declined without prompting** the founder (approval-bridge `validatePathInRoot`). Evidence that NO Inbox item appeared for it. Result.

### Task 6.5: claude_local command permission (if claude authed)
- [ ] Repeat 6.1 (allow-once) for `Scout-Claude` (claude_local via PreToolUse hook). Assert the same Inbox permission loop works for the claude adapter. (matrix §4.6 W5b) BLOCKED if claude not authed.
- [ ] Evidence + result.

### Task 6.6: Timeout / SLA (permission → deny on expiry)
- [ ] Trigger a permission item and **do not answer**. Per policy the permission decision denies on timeout (default `deny`; W5c uses `escalate`-visible + 300s SLA). To avoid a real long wait, use the side-door to set `expiresAt` in the near past and run the expiry worker (`agent-runtime-decisions.listDueForExpiry`), OR document the real-time behavior. Assert: item reflects expiry, decision→expired, timeout policy applied (run denied/parked), and the SLA/escalate visual (row stays visible) shows. (matrix §4.4)
- [ ] Evidence + result.

### Task 6.7: Cancel mid-approval
- [ ] Trigger a permission item (run blocked). **Cancel the run** (from the task/agent run view). Assert: `requestPermissionBounded` throws cancelled → decision declines/cancels, the codex child is terminated, the run unwinds (no hang), and the hub item resolves. (matrix §4; W5c cancel→teardown coupling.)
- [ ] Evidence + result.

### Task 6.8: Gating OFF — no prompt
- [ ] On an agent with `runtimeDecisionRoutingEnabled=false` (or with `AOA_RUNTIME_DECISION_ROUTING` unset — would need a relaunch; simplest: a second agent with the per-agent flag off), dispatch the same risky command. Assert: **NO** Inbox permission item appears (routing gated off); the run behaves per the unsupervised path. (matrix §4.5 — proves the gate actually gates.)
- [ ] Evidence + result.

### Task 6.9: Blocked-run visibility gap (known dead-end — verify + record)
- [ ] While a run is `waiting_on_human` (from 6.1), open that task in the **task detail / workspace view**. The investigation found NO blocked-status indicator there (only the Inbox shows it). Confirm: is there any indicator in TaskSlideOver/WorkspaceView/agent run view? Record PASS if surfaced, FAIL(MAJOR) if the task looks idle with no hint. (This is a UX dead-end candidate, not a crash.)
- [ ] Evidence + result.

---

## Phase 7 — Suggestions lane

### Task 7.1: suggestion / proactive / stale_work  (trigger is side-door, not a UI button)
- [ ] Plan review: no on-demand "generate suggestions" UI button found — the engine runs on **Home load + 4h cycle**. So the trigger is: load Home (natural) OR invoke the suggestion service via API/worker if exposed (verify a route exists; if not, rely on Home-load). Assert items land in the **Suggestions** lane across categories (goal_gap, pipeline_bottleneck, stale_work, etc.). (matrix §1.2, §6)
- [ ] For a suggestion with an action affordance (e.g., "Create routine", "Pause agent"), click it → assert the action fires. Note any category whose card has NO action (the "suggestion categories not fully implemented in UI" dead-end). (matrix §3 dead-ends)
- [ ] Evidence: `SHOT-7.1-suggestions.png`. Result.

---

## Phase 8 — Autopilot (W3), Steward curation (W4), Org reporting (W6)

### Task 8.1: Steward curation metadata  (observe-only; setting fields is side-door)
- [ ] No confirmed UI to set `priority`/`slaAt` on a hub item. Observe curation reasons on a **naturally** urgent/SLA item if one arises; otherwise set the fields via a side-door (`hub-curation` write path / direct SQL on the `notifications` row) and assert the card shows "Urgent priority is set" / "SLA is due in N minutes" (`hub-curation.ts:83`). (matrix §6.2)
- [ ] Evidence + result.

### Task 8.2: Autopilot rules  ⚠️ LIKELY BLOCKED (no settings UI)
- [ ] Plan review found backend (`hub-autopilot.ts` service + route) but **no Autopilot settings UI**. Confirm no Settings tab; if confirmed → mark **BLOCKED (no UI)**, optionally exercise the rule engine via the `hub-autopilot` API side-door to prove the backend auto-resolves + audits, and record the missing UI as a W3 backlog candidate. Not a product bug. (matrix §6.1)
- [ ] Result (BLOCKED expected).

### Task 8.3: Org reporting (W6)
- [ ] W6 is API-level (matrix §6.3 — "not yet UI-integrated"). Confirm via `GET /api/companies/:cid/org-hierarchy` (or the real route) that org agents resolve to a first-human ancestor. Mark as API-verified (not a UI scenario).
- [ ] Evidence: the JSON. Result.

---

## Phase 9 — Cross-cutting

### Task 9.1: Deep links + viewers
- [ ] From each waiting-lane item type, click through to its viewer: approval→ApprovalDetail, discussion_pending/scope_proposal→DiscussionDetail (with `#entry:` scroll), agent_runtime_decision→its viewer. Assert each deep link resolves and back-nav returns to the lane. (matrix §2.4)
- [ ] Evidence + result.

### Task 9.2: Reconciliation (terminal items close)
- [ ] For an approval already decided out-of-band (e.g., approve via API), load the Inbox and assert the sweep closes the hub item (no stale "pending" row). (matrix §1.4 reconciliation; note the "sweep not realtime" debt — if it needs a Home load to close, record that.)
- [ ] Result.

### Task 9.3: Empty states
- [ ] Resolve/clear a lane to empty; assert a sensible empty state renders (not a blank/broken panel). Evidence + result.

---

## Coverage checklist (every matrix row → scenario)

- [ ] Hub lanes/filters/grouping/density/read-state/legacy-redirect → 2.1–2.3, 2.7
- [ ] Lifecycle resolve/archive/undo/claim/release/snooze/bulk/409 → 2.4–2.7
- [ ] Approval hire (approve+reject+resubmit) → 3.1; RBAC → 3.2; budget_override → 3.3/7.4; ceo_strategy → (note if no UI trigger)
- [ ] Crew autonomy Manual/Assist/Drive + crew_dispatch approve/reject + preflight budget → 4.1–4.4
- [ ] Notifications run_complete/run_failed/extraction_failed + toast bridge + quiet hours + digest → 5.1–5.4
- [ ] Runtime decisions: allow_once/deny/allow_always+trust-rule/file-change+trust-boundary/claude/timeout-SLA/cancel/gating-off/blocked-visibility → 6.1–6.9
- [ ] Suggestions categories + actions → 7.1
- [ ] Steward curation / Autopilot / Org reporting → 8.1–8.3
- [ ] Deep links / reconciliation / empty states → 9.1–9.3

---

## Triage (after full coverage)

- [ ] Compile `BUGS.md` → group by severity.
- [ ] BLOCKERs (esp. the 6.1 permission loop, 3.1 hire, 4.2 crew_dispatch) → fix immediately on a fix branch, re-run the failing scenario.
- [ ] MAJOR/MINOR → file as issues / spawn tasks; do NOT fix in this sweep.
- [ ] Write a one-page `SUMMARY.md`: pass rate per phase, blocker list, launch-readiness verdict for the Inbox surface.

---

## Verification

- [ ] `RESULTS.md` has one line per scenario (PASS/FAIL/BLOCKED).
- [ ] Every FAIL has a `BUGS.md` entry with evidence.
- [ ] The crown-jewel loop (6.1) captured end-to-end with screenshots.
- [ ] `SUMMARY.md` written with the launch-readiness verdict.

## Scope Guard

**In scope:** live UI-driven verification of the Inbox/Approvals hub and everything that surfaces into it (approvals, runtime decisions, crew dispatch, notifications, suggestions, curation, lifecycle). **Not in scope:** fixing bugs found (triage only), non-hub surfaces (Memory/Budget/Marketplace except where they raise hub items), performance/load testing, `authenticated`-mode multi-human RBAC (documented BLOCKED where it needs a 2nd human). **Do not** run this against the user's dev instance — isolated QA instance only.
