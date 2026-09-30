# Discussions Feature Set — Full Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to run this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This is a REPORT-ONLY verification plan, not a code-build plan.** Steps are "do X in the UI → observe Y → check Z in DB/logs → record pass/fail", NOT failing-test-first code. **Make no code fixes during the pass** — log every finding and triage at the end (Task 18).

**Goal:** Exhaustively verify every discussion/thread flow — and every meaningful combination — on a freshly-seeded `feat/v1-combined` instance driven through the real UI with live `codex_local` crew, answering definitively whether convene → round-table → relay actually advances.

**Architecture:** An isolated git worktree off `feat/v1-combined` runs a fully isolated AoA instance (its own embedded-postgres port, data dir, storage, secrets — keyed by `AOA_INSTANCE_ID=qa-disc`) on dedicated ports so it never disturbs the other live sessions. We seed via the real onboarding wizard (Commander = codex, Crew = codex), then walk the A–L flow matrix + 5 combinations + the convene/relay deep-dive. Each flow is exercised in the browser via `/browse`, then confirmed under the hood with `psql` on the QA DB and the server dispatch/run logs.

**Tech Stack:** React/Vite UI (port 5373) · Express + Drizzle server (port 3300) · embedded-postgres (port 54440) · `codex_local` adapter (codex CLI, authed at `~/.codex/auth.json`) · gstack `/browse` (real Chromium) · `psql`.

---

## Conventions (read once, used by every task)

**Absolute paths** (the repo lives under a path with a space — "Claude Data" — so always quote and always use absolute paths; never rely on a `cd`):

| Name | Value |
|---|---|
| `V1` (trunk worktree) | `C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-v1` |
| `QA` (new QA worktree) | `C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-qa` |
| `INSTANCE_ROOT` | `C:\Users\TK\.aoa\instances\qa-disc` |
| `QA_CONFIG` | `C:\Users\TK\.aoa\instances\qa-disc\config.json` |
| `SERVER_LOG` | `C:\Users\TK\.aoa\instances\qa-disc\logs\` (pino file logs) + the captured background stdout |

**Endpoints:**
- **UI (drive everything here):** `http://localhost:5373` — Vite dev server; proxies `/api` and `/_plugins` → `http://localhost:3300`.
- **API (health/direct):** `http://localhost:3300`
- **DB:** `postgres://paperclip:paperclip@127.0.0.1:54440/paperclip`

**DB query helper — `qa-sql.mjs`** (psql is NOT on PATH here; use the `postgres@3.4.8` package that ships in the worktree). Created in Task 2 at `QA\qa-sql.mjs`:
```js
import postgres from "postgres";
const sql = postgres("postgres://paperclip:paperclip@127.0.0.1:54440/paperclip", { max: 1 });
const rows = await sql.unsafe(process.argv[2]);
console.table(rows);
await sql.end();
```
Run any check with `pnpm -C "<QA>" exec node qa-sql.mjs "<SQL>"`. **Throughout this doc, every `psql "...:54440/paperclip" -c "<SQL>"` line means: run `<SQL>` via this helper.** Ports in use elsewhere on this machine (orphan worktree instances): 54301/54330/54430 — QA deliberately uses **54440**.

**Captured IDs** — after seeding (Task 3), record these into the findings doc and reuse them in every query:
- `COMPANY_ID` (companies.id), `COMPANY_PREFIX` (the URL slug), the 8 crew `agents.id` by name.

**`/browse` usage:** invoke the `/browse` skill (real Chromium). Standard loop = navigate → snapshot (read live labels/selectors) → click/fill → screenshot for evidence. Never use `mcp__claude-in-chrome__*`. When a step says "observe", capture a screenshot into the findings doc as evidence.

**Live-crew timing:** dispatched `codex_local` agents spawn a real `codex exec` subprocess (~20s–2min each). After an action that should trigger a crew run, **poll** `agent_wakeup_requests` + `heartbeat_runs` (or watch the thread) rather than asserting instantly. Round-table convene fans out to multiple agents in parallel (dispatcher `drainPhase3` = `Promise.allSettled`).

**Findings ledger** — maintain one markdown file `QA\docs\aoa\plans\discussions-verification-FINDINGS.md` with a running table; every verification step appends a row:

| # | Group | Flow | Expected | Actual | Pass/Fail | Severity | Evidence |
|---|---|---|---|---|---|---|---|

Severity scale: **S1** blocks the feature · **S2** major degradation · **S3** minor/cosmetic · **S4** nit. Evidence = screenshot filename + psql output snippet + log line ref.

---

## Task 1: Isolated QA worktree + commit spec & plan

**Files:**
- Create worktree: `QA` (branch `qa/discussions-verify` off `origin/feat/v1-combined`)
- Copy into `QA\docs\aoa\plans\`: `2026-06-03-discussions-verification-design.md` (spec) + `2026-06-03-discussions-verification.md` (this plan)

- [ ] **Step 1: Fetch latest trunk** (another session pushes to `feat/v1-combined` — base off the remote ref)

```bash
git -C "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-v1" fetch origin
```
Expected: fetch completes; `origin/feat/v1-combined` updated.

- [ ] **Step 2: Create the isolated worktree off the freshest trunk**

```bash
git -C "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-v1" worktree add "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-qa" -b qa/discussions-verify origin/feat/v1-combined
```
Expected: `Preparing worktree (new branch 'qa/discussions-verify')` + `HEAD is now at <sha>`.

- [ ] **Step 3: Copy the spec + this plan into the QA worktree** (they are uncommitted in `V1`; bring them onto the qa branch)

```bash
cp "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-v1\docs\aoa\plans\2026-06-03-discussions-verification-design.md" "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-qa\docs\aoa\plans\2026-06-03-discussions-verification-design.md"
cp "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-v1\docs\aoa\plans\2026-06-03-discussions-verification.md" "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-qa\docs\aoa\plans\2026-06-03-discussions-verification.md"
```

- [ ] **Step 4: Commit ONLY those two files on the qa branch** (NEVER `git add -A` — worktrees carry unrelated uncommitted work)

```bash
git -C "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-qa" add docs/aoa/plans/2026-06-03-discussions-verification-design.md docs/aoa/plans/2026-06-03-discussions-verification.md
git -C "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-qa" commit -m "docs(qa): discussions verification spec + plan

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: one commit on `qa/discussions-verify`. **Do NOT commit anything to `feat/v1-combined`.**

- [ ] **Step 5: Install deps in the worktree** (worktrees do not share `node_modules`)

```bash
pnpm -C "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-qa" install
```
Expected: install completes. Note: the repo pins `embedded-postgres@18.1.0-beta.16` (patched) and `overrides` strip `sqlite3` — both expected.

---

## Task 2: Stand up the fresh isolated instance (postgres :54440 → server :3300 → vite :5373)

**Files:**
- Create: `QA_CONFIG` (`C:\Users\TK\.aoa\instances\qa-disc\config.json`) — pins the embedded-postgres **port** (54440) and every instance path under `~/.aoa/instances/qa-disc/`. (The instance-id alone isolates data dirs, but a config file is the **only** way to move the postgres port off the shared default 54329, and once a config file exists its Zod path defaults would otherwise point back at the `default` instance — so every path is pinned explicitly.)

- [ ] **Step 1: Write the isolated instance config** (create the dir, then the file)

```bash
mkdir -p "C:\Users\TK\.aoa\instances\qa-disc"
```
Then create `C:\Users\TK\.aoa\instances\qa-disc\config.json` with EXACTLY this content:
```json
{
  "$meta": { "version": 1, "updatedAt": "2026-06-03T00:00:00.000Z", "source": "configure" },
  "database": {
    "mode": "embedded-postgres",
    "embeddedPostgresDataDir": "~/.aoa/instances/qa-disc/db",
    "embeddedPostgresPort": 54440,
    "backup": { "enabled": false, "intervalMinutes": 60, "retentionDays": 30, "dir": "~/.aoa/instances/qa-disc/data/backups" }
  },
  "logging": { "mode": "file", "logDir": "~/.aoa/instances/qa-disc/logs" },
  "server": { "deploymentMode": "local_trusted", "exposure": "private", "host": "127.0.0.1", "port": 3300, "allowedHostnames": [], "serveUi": true },
  "auth": { "baseUrlMode": "auto" },
  "storage": { "provider": "local_disk", "localDisk": { "baseDir": "~/.aoa/instances/qa-disc/data/storage" }, "s3": { "bucket": "paperclip", "region": "us-east-1", "prefix": "", "forcePathStyle": false } },
  "secrets": { "provider": "local_encrypted", "strictMode": false, "localEncrypted": { "keyFilePath": "~/.aoa/instances/qa-disc/secrets/master.key" } }
}
```
Why `local_trusted`: loopback is the trust boundary, so the MCP-inbound (Flow A) and board actor (convene) paths work without a Bearer token, and onboarding doesn't require external auth. `exposure: private` is required by the config schema's `superRefine` for `local_trusted`.

- [ ] **Step 2: Boot the server (it starts embedded-postgres :54440 and auto-applies migrations)** — run in the background; capture stdout to a log file.

From `QA\server`, launch with these env vars (Bash tool, `run_in_background: true`):
```bash
AOA_INSTANCE_ID=qa-disc \
AOA_CONFIG="C:\Users\TK\.aoa\instances\qa-disc\config.json" \
AOA_MIGRATION_AUTO_APPLY=true \
PORT=3300 \
pnpm -C "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-qa\server" exec tsx src/index.ts
```
PowerShell equivalent for the env vars (if using the PowerShell tool): set `$env:AOA_INSTANCE_ID="qa-disc"`, `$env:AOA_CONFIG="C:\Users\TK\.aoa\instances\qa-disc\config.json"`, `$env:AOA_MIGRATION_AUTO_APPLY="true"`, `$env:PORT="3300"` then run the `pnpm ... exec tsx src/index.ts`.

Expected log lines (in order): `Using embedded PostgreSQL because no DATABASE_URL set (dataDir=...qa-disc\db, port=54440)` → migrations applied (`applied (empty database)` or `applied (pending migrations)`, last migration `0137_...`) → server `listening` on `3300`.

- [ ] **Step 3: Verify server health**

```bash
curl -s http://localhost:3300/api/health
```
Expected: HTTP 200 with a JSON health/ok body (or the app's health shape). If 000/refused, re-check the boot log for an embedded-postgres start failure (port already in use → another instance grabbed 54440; pick a different free port in the config + `PORT`).

- [ ] **Step 4: Verify the QA DB is reachable and empty**

```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT count(*) AS companies FROM companies;"
```
Expected: `companies = 0` (fresh DB). If the table is missing, migrations didn't run — fix before continuing.

- [ ] **Step 5: Boot the Vite UI on 5373, pointed at the QA server**

From `QA\ui`, launch in the background:
```bash
VITE_BACKEND_PORT=3300 pnpm -C "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-qa\ui" exec vite --port 5373
```
Expected: Vite prints `Local: http://localhost:5373/`. (`VITE_BACKEND_PORT=3300` makes the `/api` proxy target the QA server, not the default 3100.)

- [ ] **Step 6: Confirm the UI loads via /browse**

`/browse`: navigate to `http://localhost:5373`. Expected: the app shell renders (onboarding / lobby — no company yet). Screenshot → evidence. Record in the findings ledger: **instance up (server 3300, vite 5373, db 54440)**.

---

## Task 3: Seed via the onboarding wizard (Commander + Crew = codex) — also Flow-Group A (onboarding smoke)

**State:** Fresh instance, no company. Driving the **real** onboarding wizard tests onboarding end-to-end AND auto-seeds the 8-agent crew.

- [ ] **Step 1: Start onboarding**

`/browse`: from `http://localhost:5373`, begin "Create company" / onboarding. **Snapshot each wizard step first** to read the actual field labels (labels are the source of truth), then fill.

- [ ] **Step 2: Fill company identity**

Company name: `QA Disco Co`. Vision/Mission: short real sentences (e.g. Vision "Prove the discussions pipeline end-to-end."; Mission "Ship a verified thread→convene→scope→task loop."). Advance.

- [ ] **Step 3: Function type + deployment**

Choose a function type that enables the crew/threads experience (default/general or `software_development` if offered). Deployment mode should already be `local_trusted` (matches the config). Advance.

- [ ] **Step 4: Commander (internal agent) = codex**

At the Commander/provider step, select the **codex** execution mode/provider (CLI-mode; no API key needed). Advance.

- [ ] **Step 5: Crew = codex**

At the crew step, accept the **default crew** and ensure the crew adapter resolves to **codex_local** (select codex if prompted per-crew). Complete the wizard.

- [ ] **Step 6: Land in the company** — capture IDs

`/browse`: confirm redirect into the new company (Home). Read the URL → record `COMPANY_PREFIX`. Then:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT id, name, deployment_mode FROM companies;"
```
Record `COMPANY_ID`.

- [ ] **Step 7: VERIFY the crew exists, is codex, and is correctly roled** (core seed assertion)

```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT name, kind, status, adapter_type FROM agents WHERE company_id='<COMPANY_ID>' AND kind='aoa' ORDER BY name;"
```
Expected: **8 rows** — Adjutant, Chronicler, Engineer, Memory Keeper, Navigator, Planner, Reviewer, Scout — each `kind='aoa'`, `adapter_type='codex_local'`, `status` idle/active (not `terminated`/`pending_approval`). Then confirm the real role key lives on the trigger (not the hardcoded `runtimeConfig.aoa.role='member'`):
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT a.name, t.config->>'role' AS trigger_role FROM agents a JOIN aoa_agent_triggers t ON t.agent_id=a.id WHERE a.company_id='<COMPANY_ID>' ORDER BY a.name;"
```
Expected: each agent's `trigger_role` matches its name (adjutant/scout/engineer/navigator/planner/memory_keeper/chronicler/reviewer).

- [ ] **Step 8: Record Flow-Group A onboarding result** — ledger rows: *onboarding wizard completes*, *company created*, *8 crew agents seeded as codex_local*, *roles resolve via trigger.config.role*. Any missing/extra agent or wrong adapter = **S1**.

---

## Task 4: Flow-Group A — Create (write · paste · voice · MCP inbound · first-entry arms Adjutant)

**State:** Company seeded. UI "Discussions" in the sidebar. Set the **company dial** for now to **Assist** (Settings → Commander/autonomy, or the thread dial) so first-entry proactive Adjutant can fire; note exact location in evidence.

- [ ] **Step 1: Create a thread via WRITE**

`/browse`: Discussions → New (Write mode). Title `A-write`, body: "We need to decide the launch channel for the beta." Submit.
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT id,title,phase,use_controller_path,autonomy_level FROM discussions WHERE company_id='<COMPANY_ID>' ORDER BY created_at DESC LIMIT 1;"
```
Expected: a `discussions` row, `phase='discuss'`, `use_controller_path=true` (new threads take the controller path). Record `THREAD_A` id. Then:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT input_type,extraction_status,seq,author_agent_id FROM discussion_entries WHERE discussion_id='<THREAD_A>' ORDER BY seq;"
```
Expected: one entry `input_type='write'`, `seq=1`, `author_agent_id IS NULL` (human-authored).

- [ ] **Step 2: First-entry arms the proactive Adjutant**

After Step 1, watch for an Adjutant run (Assist dial → Adjutant may converse). Poll:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT agent_id,source,status,reason,payload->>'threadId' AS thread,requested_at FROM agent_wakeup_requests WHERE company_id='<COMPANY_ID>' ORDER BY requested_at DESC LIMIT 10;"
```
And grep the server log for the Adjutant controller run:
```bash
# search SERVER_LOG for the thread id
```
Expected (Assist): an Adjutant controller run fires for `THREAD_A`; eventually a crew-authored entry appears (`author_agent_id` = Adjutant's id). Record whether it fired and how long it took. (At **Manual** it must NOT fire — that's Group K; note here as the contrast baseline.)

- [ ] **Step 3: Create a thread via PASTE** — New → Paste mode, paste a multi-line blob (e.g. a fake meeting note). Submit. Verify a `discussions` row + `discussion_entries.input_type='paste'`. Record `THREAD_A_PASTE`.

- [ ] **Step 4: Create a thread via VOICE** — New → Voice mode → record a short clip (or use the upload affordance) → confirm Whisper transcription populates `raw_content` and `input_type='voice'`, `source_info` carries the transcription model. If no mic in the harness, record as **blocked/Not-Testable** with reason, severity S3.

- [ ] **Step 5: Create a thread via MCP inbound** — POST a JSON-RPC create to the inbound MCP endpoint (local_trusted → no Bearer needed):
```bash
curl -s -X POST http://localhost:3300/api/companies/<COMPANY_ID>/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<create-discussion-or-inbound-tool>","arguments":{"content":"Inbound from MCP: evaluate pricing tiers."}}}'
```
First list tools to get the exact inbound tool name:
```bash
curl -s -X POST http://localhost:3300/api/companies/<COMPANY_ID>/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
Expected: the MCP write routes per Decision #14 — authenticated write may create directly; anonymous routes through Discussion/Inbox. Verify the resulting `discussion_entries.input_type='mcp'` (or an inbox item, depending on the tool). Record the actual routing. (Deep inbox routing = Group I.)

- [ ] **Step 6: Record Group A** — 5 ledger rows (write/paste/voice/mcp/first-entry-arms). Missing input mode = **S2**; first-entry-arm failing at Assist = **S1** (it's the spine of the whole experience).

---

## Task 5: Flow-Group B — Adjutant (answer · follow-up · silence-when-idle · Manual vs Assist)

**State:** Use `THREAD_A` (Assist).

- [ ] **Step 1: Adjutant answers a direct question** — `/browse`: in `THREAD_A`, post "Adjutant, what are the open questions before we can decide?" Wait for the Adjutant run. Expected: a crew entry by the Adjutant answering. Confirm `author_agent_id` = Adjutant, and that it is a normal chat entry (NOT a `systemNotice`).
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT seq,author_agent_id,left(raw_content,80) FROM discussion_entries WHERE discussion_id='<THREAD_A>' ORDER BY seq;"
```

- [ ] **Step 2: Adjutant answers a follow-up** — post a follow-up referencing its answer ("Good — focus on the first one."). Expected: a contextual follow-up reply (the crew-context-bundle injects the last ~20 entries, so it should build on prior turns). Record continuity (does it reference earlier content?).

- [ ] **Step 3: Silence-when-idle** — post a pure acknowledgment ("Thanks.") that warrants no action. Expected: at Assist the Adjutant should NOT spam a reply to a no-op. Record whether it stays silent or over-posts (over-posting = **S2/S3** noise).

- [ ] **Step 4: Manual vs Assist contrast** — flip the thread dial to **Manual** (thread header dial), post another substantive message. Expected: NO proactive Adjutant run (enforced in `fireAdjutantWakeup` + the controller runner's `effectiveAutonomy < 1` belt-and-suspenders). Verify no new `agent_wakeup_requests` proactive row for this entry. Flip back to Assist. Record both.

- [ ] **Step 5: Record Group B** — 4 ledger rows. Manual producing a proactive post = **S1** (dial invariant broken). System-notice rendering of a chat reply = **S2**.

---

## Task 6: Flow-Group C — @mention (Scout · Engineer · Planner · Reviewer · Navigator · autocomplete)

**State:** New thread `C-mentions` (Write). @mention dispatch flows through the controller participation path (dial-exempt for activation — a direct mention answers even at Manual).

- [ ] **Step 1: Mention autocomplete** — type `@` in the composer. Expected: an autocomplete listing the crew (Scout/Engineer/Planner/Navigator/Memory Keeper/Chronicler/Reviewer/Adjutant). Screenshot. Missing names = **S2**.

- [ ] **Step 2: @Scout** — post "@Scout research the top 3 competitors' onboarding." Wait. Expected: Scout dispatched → a Scout-authored reply. Verify:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT agent_id,source,status,payload->>'threadId' AS thread FROM agent_wakeup_requests WHERE company_id='<COMPANY_ID>' ORDER BY requested_at DESC LIMIT 5;"
```
and a new `discussion_entries` row with `author_agent_id` = Scout. Record dispatch→reply latency.

- [ ] **Step 3: @Engineer** — "@Engineer draft a one-page tech approach." Expected: Engineer reply (Engineer is the artifact role — may also produce an artifact; full artifact path is Group G). Record.

- [ ] **Step 4: @Planner** — "@Planner sequence the work into steps." Expected: Planner reply proposing sequence/steps. Record.

- [ ] **Step 5: @Reviewer** — "@Reviewer critique the plan so far." Expected: Reviewer reply with critique (the role added in the reconciliation). Record. Reviewer never replying = **S2** (newest role; high-value to confirm live).

- [ ] **Step 6: @Navigator** — "@Navigator where should this go?" Expected: Navigator reply (routing perspective). Record. (Inbox routing depth = Group I.)

- [ ] **Step 7: Record Group C** — 6 ledger rows (autocomplete + 5 agents). A mention that never dispatches = **S1** for that agent.

---

## Task 7: Flow-Group D — ⭐ Convene (round-table parallel · per dial)

**State:** New thread `D-convene` (Write), dial **Assist** first. This is the headline feature; the **relay** question gets its own deep-dive in Task 16 — here we confirm round-table fan-out works.

- [ ] **Step 1: Trigger a convene ("team's take")** — post: "I'd like the team's take on whether we launch in EU or US first." This should make the Adjutant CONVENE the relevant crew via `agent.dispatch` (round-table).

- [ ] **Step 2: Observe parallel fan-out (round-table)** — poll the wakeup queue immediately:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT agent_id,source,status,coalesced_count,dedup_key,payload->>'threadId' AS thread,requested_at FROM agent_wakeup_requests WHERE company_id='<COMPANY_ID>' AND payload->>'threadId'='<THREAD_D>' ORDER BY requested_at;"
```
Expected: **multiple** queued rows (one per convened agent), each `dedup_key = '<agentId>:<THREAD_D>:queued'`, dispatched ~together (round-table = `Promise.allSettled` parallel drain). Confirm in `SERVER_LOG`: `agent.dispatch` rows + a parallel drain (`drainPhase3`).

- [ ] **Step 3: Observe the round-table replies land** — `/browse`: watch the thread fill with several distinct crew entries (independent takes). Verify:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT seq,author_agent_id,left(raw_content,60) FROM discussion_entries WHERE discussion_id='<THREAD_D>' AND author_agent_id IS NOT NULL ORDER BY seq;"
```
Expected: ≥2 distinct `author_agent_id`s posting takes. Each take should reflect thread context (crew-context-bundle injects last-20 entries + summary + memory). Screenshot the multi-agent round table.

- [ ] **Step 4: Hop-cap holds** — confirm no runaway: dispatch hop_count is capped at 3 and the queued dedup prevents duplicate same-agent queued rows. Verify no agent has >1 simultaneously-`queued` row for the thread, and no infinite re-queue in `SERVER_LOG`.

- [ ] **Step 5: Convene per dial** — repeat the convene trigger on a **Drive** thread (new thread `D-convene-drive`, dial Drive). Expected: convene still fans out (Drive = more autonomous). At **Manual** (new thread, dial Manual) a "team's take" request should NOT auto-convene proactively (founder-driven only). Record all three dials.

- [ ] **Step 6: Record Group D** — rows for round-table fan-out, parallel timing, hop-cap, and the 3 dials. Round-table not fanning out = **S1** (this is the marquee flow). Defer the advance/relay verdict to Task 16.

---

## Task 8: Flow-Group E — Scope → tasks (suggest scope · propose_crew_work card · approve → tasks · Drive auto-approve · Manual/Assist card-approve)

**State:** Use `THREAD_D` (it has a real discussion to scope) or a fresh `E-scope` thread with a couple of substantive entries.

- [ ] **Step 1: Move toward scope** — post "Okay, let's turn this into work." Expected: the Adjutant/Planner proposes scope — a **scope_proposal** entry (`discussion_entries.input_type='scope_proposal'`, `proposal_status='pending'`) surfaced as a **propose_crew_work card** in the UI.
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT id,input_type,proposal_status,left(raw_content,80) FROM discussion_entries WHERE discussion_id='<THREAD_E>' AND input_type='scope_proposal' ORDER BY seq;"
```
Expected: exactly one `pending` proposal (the one-pending-per-thread unique index enforces this). Screenshot the card.

- [ ] **Step 2: Approve the card → tasks materialize** — `/browse`: click Approve on the card (as founder). Expected: `proposal_status` → `approved`, and tasks are created.
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT id,title,status,task_scope,source FROM issues WHERE company_id='<COMPANY_ID>' ORDER BY created_at DESC LIMIT 10;"
```
Expected: new `issues` rows linked to this thread (crew work → `task_scope='crew'`). Record count + titles + that they trace to the thread.

- [ ] **Step 3: Drive auto-approve** — on a **Drive** thread, drive it to scope. Expected: at Drive, the scope proposal auto-approves (no founder click) and tasks materialize directly. Verify `proposal_status='approved'` without a UI click + tasks created. Record.

- [ ] **Step 4: Manual / Assist require card-approve** — on a Manual or Assist thread, confirm the proposal stays `pending` until the founder clicks Approve (no auto-materialize). Verify a `pending` proposal with zero tasks until approval. Record.

- [ ] **Step 5: Stale-proposal guard** — (spot-check) confirm approving an out-of-date proposal can't materialize stale tasks (the approve handler checks `proposalCursorSeq` vs `entrySeq`). If reproducible, post a new entry after the proposal, then approve — expect a guard/refresh, not stale tasks. Record behavior; severity S2 if stale tasks slip through.

- [ ] **Step 6: Record Group E** — rows for suggest-scope, card, approve→tasks, Drive auto-approve, Manual/Assist gate, stale-guard. Tasks not materializing on approve = **S1**.

---

## Task 9: Flow-Group F — Crew board (every agent task shows · source badge · artifact chip · slide-over · crew-vs-org scoping)

**State:** Tasks now exist (Group E). The Crew Board is the flat all-crew tracker.

- [ ] **Step 1: Crew board renders all crew tasks** — `/browse`: open the Crew Board. Expected: every crew-scoped task from Group E shows as a card. Cross-check count vs:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT count(*) FILTER (WHERE task_scope='crew') AS crew, count(*) FILTER (WHERE task_scope='org') AS org FROM issues WHERE company_id='<COMPANY_ID>';"
```

- [ ] **Step 2: Card chrome** — each card shows owner avatar, **source badge** (resolves to the thread/agent origin), and an **artifact chip** when an artifact is attached. Screenshot a card with each element. Missing source badge resolution = **S3**.

- [ ] **Step 3: Slide-over** — click a card → the full slide-over opens (task detail; workspace mode if software task). Verify it loads detail without error.

- [ ] **Step 4: Crew-vs-org scoping** — confirm crew tasks do NOT leak into the org Tasks board and vice-versa (the server predicate + `taskScope` default 'org'). Open the org Tasks list; confirm crew tasks are absent. Also confirm Home/company-stats issueCount excludes crew tasks (Lobby fix). Record.

- [ ] **Step 5: Record Group F** — rows for board completeness, chrome, slide-over, scoping isolation. Crew/org leak = **S2**.

---

## Task 10: Flow-Group G — Task exec (dispatched agent: get_task → comment → artifact → set_status · dial-gated transitions)

**State:** Pick one crew task from the board. This exercises a full live `codex_local` agent run end-to-end.

- [ ] **Step 1: Dispatch the task** — trigger the task's agent (Drive thread tasks may auto-dispatch; otherwise use the task's run/dispatch affordance). Watch `heartbeat_runs`:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT id,agent_id,status,created_at FROM heartbeat_runs WHERE company_id='<COMPANY_ID>' ORDER BY created_at DESC LIMIT 5;"
```
Expected: a run for the task's agent, transitioning queued→running→completed.

- [ ] **Step 2: get_task → comment** — the agent should read the task context and post a run-summary comment (auto run-summary uses `issue_comments`). Verify:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT issue_id,left(body,80),created_at FROM issue_comments WHERE issue_id='<TASK_ID>' ORDER BY created_at DESC;"
```
Expected: a comment (duration/tokens/cost/outcome/files). Record.

- [ ] **Step 3: artifact** — if the task produces a deliverable, confirm an `artifacts` + `artifact_versions` row (immutable v1) and the task's `artifact_id`/`task_outputs` link.
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT a.id,a.type,av.version_number,av.source FROM artifacts a JOIN artifact_versions av ON av.artifact_id=a.id WHERE a.company_id='<COMPANY_ID>' ORDER BY av.created_at DESC LIMIT 5;"
```

- [ ] **Step 4: set_status + dial-gated transitions** — verify the agent advanced the task status, and that the transition respected the dial (e.g. auto-move to review/done at Drive vs awaiting-approval at Assist). Cross-check `issues.status`. Record.

- [ ] **Step 5: Record Group G** — rows for run lifecycle, comment, artifact capture, dial-gated status. A crew run that errors out (codex spawn/auth) = capture the log + **S1** (blocks all exec).

---

## Task 11: Flow-Group H — Chronicler (thread summary card updates · routingTerms)

**State:** Threads with several entries (D/E have many).

- [ ] **Step 1: Summary card present + updates** — `/browse`: in `THREAD_D`, confirm the Chronicler thread-summary card renders and reflects recent content. Cross-check:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT left(summary_text,120), summary_next, summary_updated_at, routing_terms FROM discussions WHERE id='<THREAD_D>';"
```
Expected: `summary_text` populated, `summary_updated_at` recent, `routing_terms` a non-empty `string[]` of key entities. Record whether the card matches the DB.

- [ ] **Step 2: Summary advances on new entries** — post 2 more substantive entries, wait for the Chronicler sweep, re-query. Expected: `summary_updated_at` advances and `routing_terms` grows/adjusts. The Chronicler runs in the background and is **excluded from presence pills** (verify it doesn't show as "typing").

- [ ] **Step 3: Record Group H** — rows for card render, summary freshness, routingTerms, background-not-in-presence. Stale/empty summary after many entries = **S2**.

---

## Task 12: Flow-Group I — Navigator / Inbox (inbound → attach / promote / defer · routing dial · suggest_new banner)

**State:** Use the MCP-inbound path (Group A Step 5) to produce inbox items.

- [ ] **Step 1: Inbound creates an inbox item** — send an MCP/anonymous inbound that should route through the Inbox (not direct task). Confirm an inbox/unlisted item appears.

- [ ] **Step 2: Navigator routes over cards** — the Navigator decides attach-to-existing-thread vs promote-to-new vs defer-to-human, choosing over the thread routing cards (`routing_terms` snapshots). Watch the Navigator run + the `agent_wakeup_requests` for the Navigator. Record its decision and that it used Option-A snapshot routing.

- [ ] **Step 3: Attach** — verify an inbound that matches an existing thread gets attached (a new `discussion_entries` row on the matched thread, with the attach race-guard preventing double-attach). Record.

- [ ] **Step 4: Promote** — verify `promote_inbox_to_thread` creates a new thread from an unmatched inbound. Record the new `discussions` row.

- [ ] **Step 5: Defer to human** — verify `defer_inbox_to_human` (escalated guard) routes an ambiguous item to a human and the sweep reclaim moves routing→pending / escalated→human + cancels the wakeup. Record.

- [ ] **Step 6: suggest_new banner** — in the UnlistedLane, confirm the `suggest_new` banner appears when the Navigator suggests a new thread. Screenshot.

- [ ] **Step 7: Record Group I** — rows for inbound, attach, promote, defer, reclaim, banner. Inbound silently dropped = **S1**.

---

## Task 13: Flow-Group J — Memory (Memory Keeper proposes · Commander recall · extraction)

**State:** Threads with decisions/insights.

- [ ] **Step 1: Memory Keeper proposes** — drive a thread to a clear decision ("Decision: we launch EU first."). Expected: the Memory Keeper proposes a memory item (status `pending` — agents cannot write memory directly; founder approves). Verify:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT layer,status,left(content,80),conversation_id FROM memory_items WHERE company_id='<COMPANY_ID>' ORDER BY created_at DESC LIMIT 5;"
```
Expected: a `pending` proposal (it must NOT be auto-approved into identity/domain). Record. (Note: Memory feedback requires ≥3 occurrences — a single edit shouldn't propose; out of scope to force here.)

- [ ] **Step 2: Founder approves** — `/browse`: approve the pending memory item in the Memory UI. Verify `status` → approved and it's scoped to the right layer. Record.

- [ ] **Step 3: Extraction** — confirm thread entries flow through LLM extraction → `discussion_extracted_items` (decision/task/insight/...). Reprocess an entry if extraction is manual-only:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT type,status,title FROM discussion_extracted_items i JOIN discussion_entries e ON i.discussion_entry_id=e.id WHERE e.discussion_id='<THREAD_E>' ORDER BY i.created_at DESC;"
```
Record extracted items + statuses.

- [ ] **Step 4: Commander recall (memory-recall — newly ported)** — open Commander, ask it to recall something established in the thread/memory (e.g. "What did we decide about launch region?"). Expected: Commander recalls the approved memory (`memory_items.conversation_id` linkage from migration 0137). Record whether recall surfaces the right item — this is the freshly-ported feature, verify it works live.

- [ ] **Step 5: Record Group J** — rows for propose (pending), approve, extraction, Commander recall. Agent auto-writing approved memory = **S1** (governance breach).

---

## Task 14: Flow-Group K — Dial cross-cut (Manual / Assist / Drive across flows · thread override vs company dial)

**State:** Re-exercise the key flows under each dial; confirm the dial is a single unified experience knob (`effectiveAutonomy = thread.autonomyLevel ?? company`).

- [ ] **Step 1: Company dial vs thread override** — set company dial to Manual (Settings). Create a thread, override its dial to Drive. Verify the thread behaves Drive (effectiveAutonomy uses the thread override). Then a thread with no override behaves Manual. Verify via behavior + `discussions.autonomy_level` (null = inherit).

- [ ] **Step 2: Manual = no proactive crew** — on a Manual thread, confirm NO proactive Adjutant/convene/scope auto-fires (only direct @mentions answer). Verify zero proactive `agent_wakeup_requests` for Manual-thread entries.

- [ ] **Step 3: Assist = converse + propose, gate actions** — confirm Adjutant converses and proposals appear but tasks require approval (Group E Step 4 already shows this; cross-link).

- [ ] **Step 4: Drive = auto-advance** — confirm convene + scope auto-approve + task dispatch chain runs with minimal clicks (Group E Step 3 / Group G; cross-link).

- [ ] **Step 5: Record Group K** — rows for override precedence + each dial's behavior across convene/scope/exec. Dial leak (Manual acting autonomous, or Drive needing manual clicks) = **S1**.

---

## Task 15: Flow-Group L — UI / chat (bubbles · typing/presence pills · summoning chip · live kanban)

**State:** Any active thread with crew.

- [ ] **Step 1: Bubbles** — confirm human vs agent messages render distinctly (agent bubbles styled/aligned correctly, not as system notices). Screenshot.

- [ ] **Step 2: Typing / presence pills** — when an agent is dispatched, confirm a typing/presence pill appears for that agent and clears when done. Confirm the background Chronicler does NOT appear as typing. Screenshot mid-run.

- [ ] **Step 3: Summoning chip** — confirm the convene/summoning chip appears while the crew is being convened (the "bringing them in" affordance). Screenshot.

- [ ] **Step 4: Live kanban** — with the Crew Board open in one view, trigger a task status change (Group G) and confirm the board updates live (LiveEvents) without a manual refresh. Record.

- [ ] **Step 5: Record Group L** — rows for bubbles, pills, chip, live kanban. Broken live updates = **S2**; bubble/system-notice regression = **S2**.

---

## Task 16: ⭐ Convene / Relay DEEP-DIVE (does relay advance or stall?)

**State:** New thread `RELAY` (Write). This is the primary open question: does a **relay** (sequential, build-on-last) advance on its own, or stall after step 1 because the Adjutant's "exit on no new HUMAN input" heuristic treats agent posts as non-human?

- [ ] **Step 1: Kick off a relay** — post a prompt that implies a sequence: "Let's relay this: @Scout research, then Engineer drafts from Scout's findings, then Planner sequences from the draft." Dial **Assist** or **Drive** (record which). Goal: get the Adjutant to run a **moderated sequence** (relay), not just a parallel round-table.

- [ ] **Step 2: Capture the FULL dispatch trace** — immediately and repeatedly snapshot the wakeup queue + log for this thread:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT requested_at,agent_id,source,status,reason,dedup_key FROM agent_wakeup_requests WHERE company_id='<COMPANY_ID>' AND payload->>'threadId'='<THREAD_RELAY>' ORDER BY requested_at;"
```
Grep `SERVER_LOG` for: each `agent.dispatch`, every `fireAdjutantWakeup` (entry-created → Adjutant re-wake), and the controller runner's `effectiveAutonomy` / `no-pending` / `no proactive Adjutant` lines.

- [ ] **Step 3: Determine advance vs stall** — map the timeline of entries:
```bash
psql "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip" -c "SELECT seq,author_agent_id,created_at,left(raw_content,60) FROM discussion_entries WHERE discussion_id='<THREAD_RELAY>' ORDER BY seq;"
```
Decision criteria — record EXACTLY one verdict with evidence:
  - **ADVANCES:** after Scout posts (an *agent* entry), the Adjutant re-wakes and dispatches Engineer (building on Scout), then Planner — **with no human nudge between steps**. Evidence: `fireAdjutantWakeup` firing on agent-authored entry-created, sequential `agent.dispatch` rows, each agent's entry referencing the prior.
  - **STALLS:** the first step runs, then nothing advances until a human posts again. Evidence: after Scout's entry, the Adjutant run logs an early-exit ("no new human input"/`no-pending`) and no Engineer dispatch appears until a human posts.

- [ ] **Step 4: Probe the stall hypothesis directly** — if it stalled, post a single human nudge ("continue") and see if exactly one more step advances per human nudge (confirming the relay needs a human to advance each hop). Record the pattern (1 human input → 1 hop).

- [ ] **Step 5: Cross-check the gate** — confirm whether `thread-events.ts: fireAdjutantWakeup` fires on agent-authored `discussion.entry.created` events, or only on human ones, and whether `effectiveAutonomy ≥ 1` was met. Capture the exact log lines as the root-cause evidence (this is the input to the Fix A vs Fix B decision — do NOT fix here).

- [ ] **Step 6: Record the convene/relay verdict** — a dedicated section in the findings doc: round-table = (works?/how), relay = (advances?/stalls + root cause), with the full dispatch trace attached. This answers the spec's primary question definitively.

---

## Task 17: Flow COMBINATIONS (no combo left out)

**State:** Fresh threads per combo so traces don't tangle.

- [ ] **Combination 1 — Full pipeline** — new thread → convene (team's take) → scope proposal → approve → crew board → task exec → artifact. Walk the whole chain in one thread; record each handoff fired and the final artifact exists. This is the end-to-end spine; any break = **S1** at the breakpoint.

- [ ] **Combination 2 — MCP → Navigator route → convene → scope** — MCP inbound → Navigator promotes/attaches → convene on the resulting thread → scope. Confirm an externally-originated item can traverse the full crew loop. Record.

- [ ] **Combination 3 — @mention DURING an active convene** — start a convene (Task 7), and while agents are mid-dispatch, @mention a specific agent. Expected: the mention is honored without corrupting the round-table (no dropped dispatches, no dedup collision). Verify the queue has both the convene rows and the mention row, all resolving. Record.

- [ ] **Combination 4 — Dial change mid-thread (Manual → Assist → Drive)** — in one thread, start Manual (post, confirm no proactive), switch to Assist (post, confirm converse+propose), switch to Drive (confirm auto-advance). Confirm each transition takes effect immediately on the next entry (effectiveAutonomy recomputed per run). Record.

- [ ] **Combination 5 — Two concurrent threads** — run an active convene/relay in thread X and a separate @mention chain in thread Y at the same time. Verify NO cross-talk (each agent's context bundle is thread-scoped), NO dropped dispatches, and dedup keys are per-`threadId` so they don't collide. Cross-check the queue groups cleanly by `payload->>'threadId'`. Record.

- [ ] **Record Combinations** — 5 ledger rows. Cross-talk or dropped dispatch under concurrency = **S1**.

---

## Task 18: Findings report + prioritized triage + teardown

- [ ] **Step 1: Compile the matrix** — assemble the full findings ledger into the report: every A–L flow + every combination + the convene/relay verdict, each with flow · expected · actual · pass/fail · severity · evidence. Confirm **no matrix cell is unrecorded** (the "no gaps" contract). Any Not-Testable cell must state why.

- [ ] **Step 2: Prioritized fix triage** — produce a ranked list: all S1 first (feature-blockers), then S2, S3, S4. For the convene/relay finding specifically, frame the decision: **Fix A** (instruction tweak — teach the Adjutant that agent posts can advance a relay) vs **Fix B** (thin controller that re-dispatches the next relay step). Recommend, but do NOT implement (report-then-decide).

- [ ] **Step 3: Write the report** — save to `QA\docs\aoa\plans\discussions-verification-FINDINGS.md` (already the running ledger; finalize it). Commit on `qa/discussions-verify` ONLY (never `feat/v1-combined`), staging just that file:
```bash
git -C "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-qa" add docs/aoa/plans/discussions-verification-FINDINGS.md
git -C "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-qa" commit -m "docs(qa): discussions verification findings + triage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Present findings to the user** — summarize: the matrix pass/fail tally, the convene/relay verdict, and the top fixes. **Stop here for the decide-together step** — do not start fixes.

- [ ] **Step 5: Teardown (after user reviews)** — stop the background server + vite processes; the isolated instance data lives under `C:\Users\TK\.aoa\instances\qa-disc\` (delete it only when the user confirms they're done — it's the evidence trail). Optionally remove the worktree once findings are committed/pushed: `git -C "<V1>" worktree remove "<QA>"` (only if clean; node_modules on Windows may need a manual folder delete, as seen before).

---

## Self-review notes (coverage check)

- **Spec matrix A–L:** A=Task 4, B=Task 5, C=Task 6, D=Task 7, E=Task 8, F=Task 9, G=Task 10, H=Task 11, I=Task 12, J=Task 13, K=Task 14, L=Task 15. ✅ all 12 groups have a task.
- **Onboarding-as-first-flow:** Task 3. ✅
- **Convene/relay deep-dive (primary focus):** Task 16, with round-table fan-out separately in Task 7. ✅
- **5 combinations:** Task 17 (1:1). ✅
- **Isolated fresh instance / dedicated ports / fresh DB / no global server kill:** Tasks 1–2. ✅
- **Browser-driven + psql + log verification:** every flow task pairs a `/browse` action with a psql/log check. ✅
- **Report-only + findings format + triage:** Conventions ledger + Task 18. ✅
- **Live codex crew:** Task 3 seeds codex_local; Tasks 7/10/16 exercise real `codex exec` runs. ✅
