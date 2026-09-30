# Commander Bundle — Full E2E + Capability Audit Plan

**Goal:** Exhaustively verify every user flow of the Commander bundle (chat + content viewer + cockpit) against the **real running app on real Postgres in a real browser**, and produce a capability report: **what it does · what's working · what's NOT working · what to build next** — every claim backed by evidence, nothing guessed.

**Branch/worktree:** `feat/v1-commander-chat` in `AoA-commander`. **DB:** Docker pgvector `aoa-pin-verify` @ `127.0.0.1:5433/aoa`.

---

## Method — five evidence streams (most→least authoritative)

1. **Live browser drive** of the full flow matrix against a booted instance + rich seed (the primary evidence; screenshots per surface).
2. **Existing Commander Playwright E2E** run against the Docker DB on Windows (deterministic, fake-claude): `commander-viewer.spec.ts`, `commander-viewer-persistence.spec.ts`, `commander-team-tab.spec.ts`. (Windows e2e RUNS when `DATABASE_URL` is set — playwright.config.ts:13.)
3. **Component/unit suites** (breadth): the ui commander/cockpit/viewer tests (already green: ui 2598) + server cockpit/internal-agent (5852). Re-confirm the bundle slice.
4. **Targeted new E2E** for any critical flow uncovered by 1–3.
5. **Code-grounded inventory** (the 3 inventory reports) — the spec of what *should* exist; cross-checked against 1–4.

A flow is **✅ working** only if seen working in stream 1 or 2; **❌ broken** if seen failing; **🔌 needs-config** if it requires a real CLI/integration absent in the harness (record the scaffolding state); **🚧 deferred** if the code shows an intentional Phase-2/disabled stub.

---

## Review fixes — APPLIED (must follow during execution; override anything below that conflicts)

A code-grounded review (2026-06-15) found pitfalls that would produce FALSE results. Mandatory corrections:

- **[A1] Running card → seed `internal_agent_runs`, NOT `heartbeat_runs`.** `reapOrphanedRuns` (heartbeat.ts:1867) marks any `queued/running` heartbeat row `failed` at boot (no companyId filter, immediate at startup). Seed a row in `internal_agent_runs` (`status:'running'`, `triggerType`/`triggerSource` notNull, `relatedEntityType:'task'`, `relatedEntityId:<issueId>`, `agentId` nullable) — `liveRunsForCompany` UNIONs it and the reaper never touches it.
- **[A2] NEVER run the manual `:3201` instance and the Playwright `:3199` instance against the Docker DB at the same time.** `AOA_INSTANCE_ID` does NOT scope DB rows; both instances run startup backfills + heartbeat reapers over ALL companies. **Sequence:** (1) run the Playwright specs first (they boot/teardown their own `:3199` throwaway), (2) THEN boot `:3201` + seed for the live drive. The self-review "isolation" claim is RETRACTED — isolation is by *sequencing*, not instance id.
- **[A3] Pass explicit spec paths** — `pnpm test:e2e tests/e2e/commander-viewer.spec.ts tests/e2e/commander-viewer-persistence.spec.ts tests/e2e/commander-team-tab.spec.ts` (bare `test:e2e` runs all 20 specs).
- **[A4] Every per-user seed row uses `userId='local-board'`** (the only local_trusted actor; auth.ts:24). Applies to user_entity_pins (FK→authUsers: the `local-board` user is created at first boot → **seed AFTER booting once**), internal_agent_reminders, due/assigned issues, proactive notifications, runtime approvals.
- **[A5] `join_requests` needs a parent `invites` row** (`inviteId` notNull FK) **and** `requestIp` (notNull). Seed an invite first.
- **[B3] The cockpit conversation zone is CHAT-fed, not seed-fed** — it only fills from a live chat turn that emits refs (J5/fake-claude). Score it under J5, not the seeded J9 pass.
- **[B4/C5] Non-expiring/valid TTLs:** runtime approvals `expiresAt` = far future (else expire mid-audit → false ❌); proactive notifications keep `readAt/dismissedAt = NULL` (a prior browser view marks them read → empties the card); Budget pulse needs `companies.budgetMonthlyCents>0` + `cost_events` (agentId notNull) with `occurredAt` in the **UTC** month.
- **[C1] Write the fake-claude control file before EVERY live chat send** (`os.tmpdir()/aoa-e2e-fake-claude-control.json`; no env var needed — default path matches). Without it each turn emits the inert default.
- **[C2] Boot env trim + banner assertion:** drop `AOA_MIGRATION_AUTO_APPLY` (dev:watch sets it). Assert banner substance, not a literal string: `Server  3201` (no "(requested…)" suffix = not bumped), `Deploy  local_trusted (private)`, `Mode  external-postgres | vite-dev-middleware`, and the **Memory** line = `pgvector (semantic)` [C4 precondition — if it says text-only, scope memory rows to non-vector fields].
- **[C3] Teammates activity:** `activity_log.actorId` has no FK → a synthetic `actorId:'teammate-1'`, `actorType:'user'` works (no authUsers needed); only constraint is `actorId != 'local-board'`.
- **[B1] Viewer content-types:** the fake-claude/seed artifact is markdown only. Seed at least one non-markdown artifact version (e.g. an image or code file) to exercise the PDF/image/code renderers, OR tag those rows 🔌 not ✅.
- **[B2] Add MemoryContextStrip** (`ui/src/components/commander/MemoryContextStrip.tsx`, per-agent contextMode) to J1.
- **[B5] J10 "test CLI connection"** resolves the PATH binary — with fake-claude prepended it reports the FAKE cli; record which binary resolved so the ✅ isn't misleading.

---

## Setup

### S1. Boot the app (live, for me + the user to inspect)
Git Bash, background:
```
cd "/c/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-commander"
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5433/aoa" PORT=3201 HOST=127.0.0.1 \
AOA_DEPLOYMENT_MODE=local_trusted AOA_VITE_HMR_PORT=3211 AOA_INSTANCE_ID=commander-e2e \
AOA_MIGRATION_AUTO_APPLY=true pnpm dev
```
- **Chat executability:** prepend the fake-claude fixture dir to PATH so Commander's `claude_cli` resolves to the deterministic fake CLI (`tests/e2e/fixtures/fake-claude`), OR rely on the real `claude` binary (present in this env). Decide at boot; record which. The fake CLI is scripted via a control file (`helpers/fake-claude.ts`).
- Health: `GET http://127.0.0.1:3201/api/health` → `{status:"ok"}`; `GET /api/companies` lists the seeded company. Confirm the startup banner shows `Server: 3201 | external-postgres | local_trusted` (not port-bumped).
- Browser: `http://127.0.0.1:3201`. Use `/browse` (gstack canonical) per user CLAUDE.md.

### S2. Seed rich data (a fresh "Commander E2E Co" so every surface is populated)
Throwaway `server/src/e2e-seed.ts` (model on `a4-live-verify.ts`/`demo-seed.ts`), seeding:
- Company (budgetMonthlyCents set) + 2 departments + a founder (local-board) + a lead + a member (authUsers + user_roles).
- Agents (≥2: one idle, one with a running heartbeat_run) for the Running card.
- Tasks across states: in_review (Review card), assigned-to-user todo/in_progress (My tasks), due-today (Today), completed-today (Done today), blocked (deps).
- Discussions: one with pendingItemCount>0, one with extractionStatus=failed (Discussions card) + pending extracted items (approvals: discussion_item).
- Memory: pending agent items at identity/domain(dep-a)/active_context, a pending version, an archive suggestion (approvals: memory/memory_version/memory_archive).
- Goals: one at_risk (Goals-at-risk).
- cost_events this UTC month + a budget incident (Budget pulse).
- runtime approvals (pending, non-expired) for local-board (approvals: runtime_tool_trust ternary).
- join_requests pending_approval (approvals: join_request) + an approvals-table hire row (approvals: approval).
- user_entity_pins (Pinned card) + proactive notifications (Proactive findings) + activity_log human rows (Teammates).
- Artifacts with versions (viewer) + an issue artifact.
Clean up at the end (delete by companyId + authUsers).

---

## Flow matrix (deduped from the 3 inventories — ~100 flows in 12 journeys)

> Each flow gets a row in the report: **[id] flow — evidence stream — result (✅/❌/🔌/🚧) — note**.

### J1 — Commander chat: messaging & streaming (chat inv. 1–8, 26, 35)
Send text; SSE streaming content; thinking spinner; tool_call running indicator → settles on tool_result; copy message; stop/cancel stream; options_prompt chips; auto-scroll; empty-state prompt chips + recent-chats. *(needs CLI/fake-claude.)*

### J2 — Multi-chat sidebar CRUD (chat inv. 9–17) — API-backed, no LLM
New chat; switch; pin/unpin; rename; archive; hard-delete; drag-reorder (→ "Arranged" flat list); Reset order (→ date groups); search filter; date grouping; owner-scoped reorder.

### J3 — Composer rich input (chat inv. 2–3, 4–6) — no LLM
`/skill` slash → picker → select → colored token; `+` menu → "Use a skill"; token hover card; backspace deletes token; paste-as-plaintext; multiline (Shift+Enter); send expands token → `use_skill` directive; disabled @-mention / voice / attach ("coming soon").

### J4 — Action confirmations (chat inv. 4) *(needs CLI emitting action_confirm)*
Allow once → Confirmed; Always allow → trust rule created (+ visible in settings); Deny → Rejected; allowAlways hidden when `runtimeAllowAlwaysEnabled=false`.

### J5 — Output refs + viewer open (viewer inv. 1–5, 18–19) *(refs via fake-claude createArtifactTurn/queryArtifactsTurn)*
Chip under message (created accent vs referenced muted, version badge); click chip → artifact tab; desktop auto-open on created; mobile badge-only; multiple refs accumulate (stale-closure safety); cockpit conversation zone open; home "Recent from this conversation".

### J6 — Viewer tabs & panel (viewer inv. 6–17, 20) — mixed
Artifact tab (version resolution, content-type render, error state); task tab (TaskDetail embedded, close); reply tab (open-in-viewer); browser tab (markdown link); tab switch; close → focus neighbor/home; collapse → rail → expand+focus; resizable geometry (session-only); per-conversation tab state; hard-reload clears tabs; collapse persists.

### J7 — Cockpit: default-on cards render + interactions (cockpit inv. cards 1–7) — seeded, no LLM
Pinned (open/unpin); Running (open task / ask); Review (open/ask/pin); My tasks (grouped, open/ask/pin); Today (reminders + due, ask/open/pin); Discussions (pending + failed badges, open/ask); Approvals (see J8). Each: renders with data, hides when empty.

### J8 — Cockpit Approvals: 7 sources × actions × 3 roles (cockpit inv. §3) — seeded
Per source render + chip + full-page link + Ask: approval, memory, memory_version, memory_archive, discussion_item, join_request, runtime_tool_trust. Binary (Approve/Deny) vs ternary (Always/Once/Deny). Each action → correct API → item clears + toast. **Role-scoping (A4)** — founder=all 7; lead=dept memory+memory_version+own runtime; member=own runtime only. *(roles via the e2e-seed user_roles + service-level assertion already proven; live-confirm founder in browser; lead/member via the seed script's cockpitService.get like a4-live-verify.)*

### J9 — Cockpit opt-in + config + zones (cockpit inv. §4–7) — seeded
Config popover: "Show cards" hide/show; "Optional" enable each of 5 opt-in (Goals-at-risk, Budget pulse, Done today, Proactive findings, Teammates activity) → mounts immediately; prefs persist to localStorage; conversation zone; All-clear empty state; collapse/expand rail + badge.

### J10 — Settings / config (chat inv. 10) — API-backed
Capabilities toggle+save; approvals toggles; test CLI connection; notifications pref; budget/cost; proactive interval; tool-permission matrix (founder); runs history.

### J11 — Proactive & greeting (chat inv. 9) *(partial — backend timer)*
Greeting on empty chat; finding count; proactive findings → cockpit card / inbox. (No "run now" button — record.)

### J12 — Mobile / responsive (chat inv. 32–34; viewer inv. 10–11) — via /browse resize
Commander sheet open/close; sessions drawer; viewer mobile pill + sheet + badge; cockpit collapses; capacity arbitration (viewer vs cockpit on <1920px).

---

## Execution order
1. S1 boot + S2 seed; confirm health + company.
2. **Stream 2:** run the 3 commander Playwright specs against the Docker DB; record pass/fail.
3. **Stream 1:** `/browse` the live app through J2,J3,J7,J8,J9,J10,J12 (no-LLM journeys) + J1,J4,J5,J6 with fake-claude/real-claude; screenshot each surface; record per-flow result.
4. **Stream 3:** re-run ui commander/cockpit/viewer component suites + the a4-style service script for J8 role-scoping.
5. **Stream 4:** write 1–2 new specs only if a critical flow is uncovered + observed-broken.
6. Compile the **capability report** (works/doesn't/next) with evidence per row. Tear down (kill server, drop seed, remove throwaway scripts).

---

## Report template (the deliverable)
Per surface (Chat / Viewer / Cockpit), a table: **Feature | Status (✅ works / ⚠️ partial / ❌ broken / 🔌 needs-config / 🚧 deferred) | Evidence (stream + screenshot/spec) | Note**. Then:
- **What it can do** (capability narrative per surface).
- **What's working** (✅ rows).
- **What's NOT working** (❌/⚠️ rows — with repro + root cause).
- **Needs-config** (🔌 — real CLI/integration to exercise fully).
- **Build next** (🚧 deferred/disabled signals, ranked): @-mention, voice, file-attach, inbound-routing UI, autonomy surface, dept-lead budget, per-user crew running scope, viewer Phase-2 task/goal refs + branching, proactive "run now", join-grant lead scoping, etc.

---

## Self-review (run before executing)
- **No-guesswork:** every report row cites a stream (live/spec/unit) — none inferred from code alone unless tagged 🚧 (intentional deferral) or 🔌 (needs-config, with the scaffolding state verified live).
- **Coverage:** all 12 journeys map to the 3 inventories' full flow lists (chat 35 / viewer 20 / cockpit 48); spot-check none dropped.
- **Roles:** J8 covers founder live + lead/member via the seed script (local_trusted can't mint non-founder browser sessions — same constraint as A4; service-level assertion is the honest substitute).
- **Isolation:** custom port 3201 + fresh AOA_INSTANCE_ID + throwaway company → no collision with the user's :3100 instance; teardown restores the DB.
- **Safety:** read-mostly; the only writes are the throwaway seed (cleaned up). No commits to app code unless a fix is wanted after the report.
