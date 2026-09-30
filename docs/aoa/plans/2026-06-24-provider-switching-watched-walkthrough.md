# Provider-Switching Engine — Watched `/browse` Walkthrough (Layer 4)

> **Status:** runnable procedure **with real captured evidence**. The core
> provider-switching behaviors were exercised on a live `local_trusted`
> ChatGPT-codex instance (`AOA_HOME ~/.aoa-ps`, `:3100`, company "Meteorite Labs")
> on 2026-06-24; raw output is under `docs/aoa/evidence/`. Per-scenario status:
>
> | Scenario | Status | Evidence |
> |----------|--------|----------|
> | 1 — UI default picker | test-covered (UI render) | e2e `provider-switching.spec.ts:146-165` |
> | 2 — Save-side rejects (400/400) | **CAPTURED LIVE** | `ps-2-3-save-side.txt` |
> | 3 — Save soft-warn (200 + "using gpt-5.5") | **CAPTURED LIVE** | `ps-2-3-save-side.txt` |
> | 4a — Test-environment probe | **CAPTURED LIVE** | `ps-4-probe-and-concurrency.txt`, `ps-4a-test-environment.json` |
> | 4b — Concurrency clamp (queues, not 429) | **CAPTURED LIVE** | `ps-4-probe-and-concurrency.txt` |
> | 5b — Org run-time correction → `gpt-5.5` | **CAPTURED LIVE** | `ps-5b-org-runtime-correction.txt` |
> | ~~5 — Task-2 boot-backfill heal~~ | **REMOVED 2026-06-24** — backfill deleted post-review; run-time seam (5b) is the sole correction path | `ps-5b-org-runtime-correction.txt` §6 |
> | 5a — Crew run-time correction | test-covered (not driven live) | Scenario 3 + parity/integration |
> | 6 — Claude crew + Commander | test-covered (non-codex regress) | parity + Scenario 2a guard |
> | 7 — Friendly failure surface | **CAPTURED LIVE** | `ps-7-friendly-failure.txt` |
>
> Blocks marked **CAPTURED LIVE** contain real run IDs / HTTP statuses / DB rows.
> Blocks marked *test-covered* were not driven via `/browse` this session and say
> so explicitly — they point at the automated layer that already covers them.

## What this proves

This is **Layer 4** of the provider-switching test pyramid — the "watch it work"
layer. It drives the **live** app and captures evidence per scenario. It sits
above the automated layers, which it deliberately mirrors so the two stay in
lockstep:

| Layer | Artifact | Gate |
|-------|----------|------|
| 1 — Pure/contract | `server/src/__tests__/provider-switching-parity.test.ts` | Vitest (cross-platform) |
| 2 — Real-DB integration | `server/src/__tests__/provider-switching.integration.test.ts` | Vitest + embedded PG (win32-skipped) |
| 3 — Playwright e2e (save-side) | `tests/e2e/provider-switching.spec.ts` | CI-Linux required gate (Windows skips e2e at config level) |
| **4 — Watched walkthrough (this doc)** | this procedure | **manual, gated on the user's live ChatGPT-codex environment** |

Layer 3 only exercises the **save-side** of the form (it cannot drive a live
adapter CLI on CI). This Layer-4 walkthrough additionally exercises the **live
correction** at run time (the org/heartbeat path **and** the crew path), live
Claude + Commander turns, and the friendly failure surface — none of which a
headless CI runner can reach.

## Prerequisites

- The live instance runs on **Windows** (see the running-instance notes in
  `CLAUDE.md` / project memory). Command blocks below are written for **Git Bash**;
  if you launch from **Windows PowerShell**, apply the conversion table immediately
  below before pasting (`curl.exe`, backtick line-continuations, `Select-String`,
  background jobs). Scenarios 2 and 4b already include explicit PowerShell forms.
- `/browse` drives a real Chromium via Playwright (the canonical browser path —
  do NOT use `mcp__claude-in-chrome__*`). Every "open / click / type" step below
  is a concrete `/browse` action.
- A **shared ChatGPT Codex login** must exist at `~/.codex/auth.json` (the
  `auth_mode: chatgpt` credential). The live correction in Scenarios 3 and 5
  depends on the detected auth mode resolving to **chatgpt / unknown** (NOT
  `apikey`) — in `apikey` mode `gpt-5.3-codex` is a *valid* model and is passed
  through unchanged (`resolveModel`, `server/src/services/internal-agent/model-resolution.ts:62`).
- Do **not** export a stray `OPENAI_API_KEY` into the launching shell. If the
  company/extraction key leaks into `process.env`, the codex managed-home prep
  may write an `apikey` `auth.json` and the live correction will not fire. (The
  heartbeat path strips the inherited company key before spawn —
  `heartbeat.ts:3595` passes `inheritedEnvOpenAiKey` and the codex branch in
  `applyModelResolutionToConfig` deletes it — but the cleanest setup is to never
  set it in the first place.)

> **Windows PowerShell conversion (read before pasting any bash block).** In
> **Windows PowerShell 5.1** — the default shell on this machine — several POSIX
> idioms below do NOT work as-is. Convert them:
>
> | Bash (as written) | Windows PowerShell |
> |-------------------|--------------------|
> | `curl ...` | `curl.exe ...` — bare `curl` is an **alias for `Invoke-WebRequest`** and does not understand `-s -X -d -o`. |
> | line continuation `\` | backtick `` ` `` (or put the command on one line) |
> | `-o /dev/null` | `-o NUL` |
> | `grep 'x'` | `Select-String 'x'` |
> | `cmd & … wait` (backgrounding) | `Start-Job { curl.exe ... }` ×2, then `Get-Job \| Wait-Job` |
>
> For the single-line `curl` POSTs, swapping `curl` → `curl.exe` is the only change
> needed (the single-quoted JSON bodies are shell-identical).

## Naming + endpoint cheat-sheet (verified against source)

| Thing | Value / path | Source anchor |
|-------|--------------|---------------|
| Codex safe default | `gpt-5.5` (`DEFAULT_CODEX_CHAT_MODEL` / `DEFAULT_CODEX_LOCAL_MODEL`) | `server/src/services/internal-agent/codex-model.ts:13` |
| API-key-only model (the bug model) | `gpt-5.3-codex` (matches `CODEX_INCOMPATIBLE_RE = /codex/i`) | `codex-model.ts:35` |
| Correction note string | `"<model>" is not supported on a ChatGPT Codex login; using gpt-5.5.` | `model-resolution.ts:69` |
| Save-warning render | `<div role="alert">` with `Heads up: {warning}` | `ui/src/components/AgentSaveWarnings.tsx:4-8` |
| Picker default label (codex) | `Default → gpt-5.5` | `ui/src/components/AgentConfigForm.tsx:832` |
| Model picker search box | placeholder `Search models...` | `tests/e2e/provider-switching.spec.ts:186` |
| Test-connection result root | `data-testid="adapter-env-result"` | `ui/src/components/AgentConfigForm.tsx:1142` |
| Config form URL | `/{ISSUE_PREFIX}/agents/{agentId}/configure` | `provider-switching.spec.ts:154` |
| Agent seed | `POST /api/companies/{cid}/agents` → `201` | `provider-switching.spec.ts:123` |
| Agent PATCH (save) | `PATCH /api/agents/{id}?companyId={cid}` | `provider-switching.spec.ts:210` |
| Wakeup (trigger a run) | `POST /api/agents/{id}/wakeup` | `server/src/routes/agents.ts:1696` |
| Managed codex home | `~/.codex/aoa-instances/<companyId>` (`CODEX_HOME` overrides the `~/.codex` root) | `packages/adapters/codex-local/src/server/codex-home.ts:91-94` |

> **Note (400 vs 422):** the shared schema's `refineAdapterModel`
> (`packages/shared/src/validators/agent.ts:60-86`) **early-returns when
> `adapterType` is absent** (line 66: `if (!at ...) return;`). So a PATCH that
> omits `adapterType` skips the schema hard-block and instead trips the route's
> runtime guard, surfacing as **422** rather than the schema's **400**. Every
> reject-test curl below includes `adapterType` so the rejection stays on the
> 400 path — exactly matching the Layer-3 e2e (`provider-switching.spec.ts:217-231`).

---

## Prereqs / setup — Step 5.1 (ChatGPT-codex setup block)

Reset the per-company managed codex home so it re-copies the shared ChatGPT login
(`auth_mode: chatgpt`), then launch **without** a stray `OPENAI_API_KEY`. With a
ChatGPT (not api-key) auth mode, the live correction in Scenarios 3 and 5 fires.

> The managed home path is `resolveSharedCodexHomeDir(env)/aoa-instances/<companyId>`,
> where `resolveSharedCodexHomeDir = env.CODEX_HOME ?? path.join(os.homedir(), ".codex")`
> (`codex-home.ts:16-18, 91-94`). The path below assumes `CODEX_HOME` is unset.
> If you have set `CODEX_HOME`, substitute its value for `~/.codex`.

**bash:**

```bash
# 1. Stop any running instance first (Ctrl-C the dev/onboard process).

# 2. Reset the per-company managed home so prepareManagedCodexHome re-copies the
#    shared chatgpt auth.json (enabling the live correction). Replace <companyId>.
rm -rf "$HOME/.codex/aoa-instances/<companyId>"

# 3. Confirm the login is NOT an api-key file, WITHOUT echoing the token:
grep -q '"OPENAI_API_KEY"' "$HOME/.codex/auth.json" \
  && echo "WARNING: api-key auth.json — live correction will NOT fire" \
  || echo "ok: chatgpt login (no top-level OPENAI_API_KEY)"

# 4. Launch WITHOUT a stray OPENAI_API_KEY. (Do not `export OPENAI_API_KEY=...`.)
unset OPENAI_API_KEY
AOA_HOME="C:\\Users\\TK\\.aoa-ps" PORT=3100 pnpm aoa onboard --yes --run
```

**PowerShell:**

```powershell
# 1. Stop any running instance first.

# 2. Reset the per-company managed home. Replace <companyId>.
Remove-Item -Recurse -Force "$env:USERPROFILE\.codex\aoa-instances\<companyId>" -ErrorAction SilentlyContinue

# 3. Confirm NOT an api-key file, WITHOUT printing the token:
if (Select-String -Quiet -Path "$env:USERPROFILE\.codex\auth.json" -Pattern 'OPENAI_API_KEY') { "WARNING: api-key auth.json — live correction will NOT fire" } else { "ok: chatgpt login" }

# 4. Launch WITHOUT a stray OPENAI_API_KEY in this shell.
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
$env:AOA_HOME = "C:\Users\TK\.aoa-ps"; $env:PORT = "3100"; pnpm aoa onboard --yes --run
```

> You will need `<companyId>` and the agents' issue-prefix. Get them once the app
> is up:
> ```bash
> curl -s http://localhost:3100/api/companies   # → [{ id, name, issuePrefix }, ...]
> ```
> Throughout, `{cid}` = company id, `{ISSUE_PREFIX}` = the company's `issuePrefix`,
> `{agentId}` = the agent's id (from the seed responses below). A placeholder is the
> same value whether written `{agentId}` or `<agentId>`, and `<companyId>` (in the
> setup filesystem paths) is the same value as `{cid}`. Scenarios 5–7 use
> descriptive ids (`<crewAgentId>`, `<orgAgentId>`, `<claudeAgentId>`,
> `<breakAgentId>`) — each is the id from that scenario's own seed response.

---

## Scenario 1 — Onboarding default + picker shows `Default → gpt-5.5`

**Goal:** a freshly-onboarded codex crew agent (no explicit model) renders the
`Default → gpt-5.5` picker label — proving the retired `gpt-5.3-codex` default is
gone.

```bash
# Seed a codex agent with NO explicit model (so the picker shows the default label).
curl -s -X POST "http://localhost:3100/api/companies/{cid}/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"PS Codex Worker","adapterType":"codex_local","adapterConfig":{}}'
# → 201 { "id": "<agentId>", ... }   (mirrors provider-switching.spec.ts:117-139)
```

`/browse` actions:
1. Navigate to `http://localhost:3100/{ISSUE_PREFIX}/agents/{agentId}/configure`.
2. Click the **`Adapter`** section button (the Adapter section is collapsed by
   default — `provider-switching.spec.ts:158-160`).
3. Confirm the model-picker trigger button reads **`Default → gpt-5.5`**.
4. Screenshot.

```text
# EVIDENCE — TEST-COVERED (UI-render assertion; not driven via /browse this session).
# This UI-only default-label render is asserted by the required Linux e2e gate:
#   provider-switching.spec.ts:146-165 "codex model picker defaults to gpt-5.5 and lists it"
#   → getByRole("button", { name: /Default → gpt-5\.5/ }) is visible.
# The underlying default constant is also exercised by the parity/contract suite
# (DEFAULT_CODEX_CHAT_MODEL = "gpt-5.5", codex-model.ts). No run is started in this scenario.
```

---

## Scenario 2 — Save-side rejects: cross-family 400 + shell-unsafe 400

**Goal:** the request-validation gates hard-block a cross-family model and a
shell-unsafe model with HTTP **400** (mirrors `provider-switching.spec.ts:203-231`).
First seed a codex agent pinned to `gpt-5.5`:

```bash
curl -s -X POST "http://localhost:3100/api/companies/{cid}/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"PS Codex Worker","adapterType":"codex_local","adapterConfig":{"model":"gpt-5.5"}}'
# → 201 { "id": "<agentId>", ... }
```

**2a — cross-family reject (claude adapter + gpt model) → 400:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X PATCH "http://localhost:3100/api/agents/{agentId}?companyId={cid}" \
  -H "Content-Type: application/json" \
  -d '{"adapterType":"claude_local","adapterConfig":{"model":"gpt-5.5"}}'
# expect: 400
```

**2b — shell-unsafe reject → 400** (note: `adapterType` MUST be present, else 422):

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X PATCH "http://localhost:3100/api/agents/{agentId}?companyId={cid}" \
  -H "Content-Type: application/json" \
  -d '{"adapterType":"codex_local","adapterConfig":{"model":"gpt-5 && rm"}}'
# expect: 400
```

PowerShell equivalent (single-quote the JSON, escape inner quotes):

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X PATCH "http://localhost:3100/api/agents/{agentId}?companyId={cid}" -H "Content-Type: application/json" --data-raw '{"adapterType":"codex_local","adapterConfig":{"model":"gpt-5 && rm"}}'
```

```text
# EVIDENCE — CAPTURED LIVE 2026-06-24 (:3100 local_trusted). Raw: docs/aoa/evidence/ps-2-3-save-side.txt
#   2a cross-family PATCH status: 400  ✓
#     body: {"error":"Validation error","details":[{"path":["adapterConfig","model"],
#            "message":"Model \"gpt-5.5\" (openai) does not match adapter claude_local (claude)."}]}
#   2b shell-unsafe  PATCH status: 400  ✓
#     body: {"error":"Validation error","details":[{"path":["adapterConfig","model"],
#            "message":"Unsafe model identifier: gpt-5 && rm"}]}
# Source anchors: refineAdapterModel cross-family branch agent.ts:77-85;
#   shell-unsafe branch agent.ts:68-75.
```

---

## Scenario 3 — Save codex `gpt-5.3-codex` in ChatGPT mode → "using gpt-5.5" warning

**Goal:** saving the api-key-only model `gpt-5.3-codex` on a **ChatGPT** auth mode
returns a non-blocking save warning rendered by `AgentSaveWarnings` —
`Heads up: "gpt-5.3-codex" is not supported on a ChatGPT Codex login; using gpt-5.5.`

This is the live-instance analogue of `provider-switching.spec.ts:167-201`. On a
real ChatGPT login the warning is guaranteed (the CI test relies on auth resolving
to "unknown"; here it resolves to "chatgpt" — both take the non-`apikey` branch).

Seed a codex agent pinned to `gpt-5.5`, then drive the form:

```bash
curl -s -X POST "http://localhost:3100/api/companies/{cid}/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"PS Codex Worker","adapterType":"codex_local","adapterConfig":{"model":"gpt-5.5"}}'
# → 201 { "id": "<agentId>", ... }
```

`/browse` actions (mirror `provider-switching.spec.ts:174-200`):
1. Navigate to `/{ISSUE_PREFIX}/agents/{agentId}/configure`.
2. Click the **`Adapter`** section button to expand it.
3. Click the model-picker trigger (it currently reads **`gpt-5.5`**).
4. Type `gpt-5.3-codex` into the **`Search models...`** box.
5. Click the **`gpt-5.3-codex`** result.
6. Click **`Save`** (the floating action bar appears once the config is dirty).
7. Wait for the amber alert and screenshot.

```text
# EVIDENCE — CAPTURED LIVE 2026-06-24 (:3100 local_trusted, codex=ChatGPT/subscription auth).
#   Raw: docs/aoa/evidence/ps-2-3-save-side.txt
# Server save response (PATCH codex_local + gpt-5.3-codex): HTTP 200 with warnings[]:
#   warnings = ["\"gpt-5.3-codex\" is not supported on a ChatGPT Codex login; using gpt-5.5."]  ✓
#   (the UI prefixes this with "Heads up: " in AgentSaveWarnings.tsx — the server text matches verbatim.)
# persisted adapterConfig.model = "gpt-5.3-codex"  => the save PERSISTS the requested model as-is;
#   the swap to gpt-5.5 is advisory here and applied at RUN time (see Scenario 5).
# UI assertion (mirrors provider-switching.spec.ts:198): getByRole("alert") contains /using gpt-5\.5/i.
# Source: note string built in model-resolution.ts:69; pushed to save response `warnings[]` in
#   agents.ts:348; rendered in AgentSaveWarnings.tsx:8, wired in AgentDetail.tsx:1289,1312.
# (A /browse screenshot of the amber banner can be added later; the server warnings[] above is
#  the authoritative source the banner renders.)
```

---

## Scenario 4 — Test-connection probe + concurrency behavior

**Goal (4a):** the **Test environment** button runs the real adapter probe and
renders the result card (`data-testid="adapter-env-result"`). Pass OR warn OR
fail all render the card (codex may be slow to cold-start).

`/browse` actions (mirror `provider-switching.spec.ts:240-254`):
1. Navigate to `/{ISSUE_PREFIX}/agents/{agentId}/configure` (use the Scenario-3 agent).
2. Click the **`Adapter`** section button to expand it.
3. Click **`Test environment`**.
4. Wait (up to ~60s — the probe spawns a real CLI) for the result card, screenshot.

```text
# EVIDENCE — CAPTURED LIVE (ChatGPT-codex instance, :3100). Raw: docs/aoa/evidence/ps-4-probe-and-concurrency.txt
# POST /api/companies/{cid}/adapters/codex_local/test-environment  {adapterConfig:{model:"gpt-5.3-codex"}}
#   → HTTP 200 (15203ms)  status: "pass"
#      ✓ Working directory is valid: C:\Users\TK\…\Paperclip-A…
#      ✓ Command is executable: codex
#      ✓ Codex auth.json is available for local authentication.   ← ChatGPT local auth detected
#      ✓ "hello"                                                   ← end-to-end smoke turn returned
#   Full raw body: docs/aoa/evidence/ps-4a-test-environment.json
# Captured at the API layer (the exact route the "Test environment" button POSTs). The UI
# button→card render is covered by the e2e gate (provider-switching.spec.ts:233-255,
# "test-connection button runs and renders a result"; asserts getByTestId("adapter-env-result")).
```

**Goal (4b) — concurrency. IMPORTANT CORRECTION vs. the plan's "429":** the
heartbeat **per-agent concurrency clamp does NOT return HTTP 429.** When an agent
is already at its `maxConcurrentRuns` (default `HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT
= 1`, `heartbeat.ts:137`), an additional wakeup is accepted and the run is created
in **`status: "queued"`**, then promoted FIFO as a slot frees
(`startNextQueuedRunForAgent`, `heartbeat.ts:2112-2143`; `availableSlots <= 0`
→ the run waits). The wakeup endpoint returns **200** with the run, or **202
`{status:"skipped"}`** when no run is created (`agents.ts:1724-1727`) — never 429.

> The only `429` in the codebase is the express per-route **rate limiter**
> (`server/src/middleware/rate-limit.ts:117`), a different mechanism that does
> NOT exercise the provider-switching engine. Do not assert 429 for concurrency.

Fire two near-simultaneous wakeups at the same agent:

```bash
# Two concurrent wakeups (bash; `&` backgrounds the first):
curl -s -X POST "http://localhost:3100/api/agents/{agentId}/wakeup" \
  -H "Content-Type: application/json" \
  -d '{"source":"on_demand","triggerDetail":"manual","reason":"ps-4b-concurrency-1"}' &
curl -s -X POST "http://localhost:3100/api/agents/{agentId}/wakeup" \
  -H "Content-Type: application/json" \
  -d '{"source":"on_demand","triggerDetail":"manual","reason":"ps-4b-concurrency-2"}'
wait

# Then read the agent's recent runs and look for one running + one queued:
curl -s "http://localhost:3100/api/companies/{cid}/agents/{agentId}/heartbeat/runs" | \
  grep -oE '"status":"(queued|running|succeeded|failed)"'
```

PowerShell equivalent (background jobs fire the two wakeups near-simultaneously):

```powershell
$b1 = '{"source":"on_demand","triggerDetail":"manual","reason":"ps-4b-concurrency-1"}'
$b2 = '{"source":"on_demand","triggerDetail":"manual","reason":"ps-4b-concurrency-2"}'
Start-Job { param($b) curl.exe -s -X POST "http://localhost:3100/api/agents/{agentId}/wakeup" -H "Content-Type: application/json" --data-raw $b } -ArgumentList $b1 | Out-Null
Start-Job { param($b) curl.exe -s -X POST "http://localhost:3100/api/agents/{agentId}/wakeup" -H "Content-Type: application/json" --data-raw $b } -ArgumentList $b2 | Out-Null
Get-Job | Wait-Job | Out-Null
curl.exe -s "http://localhost:3100/api/companies/{cid}/agents/{agentId}/heartbeat/runs" | Select-String -Pattern '"status":"(queued|running|succeeded|failed)"'
```

> The exact runs-list endpoint may differ — if the path above 404s, open the
> agent's **Activity / runs** surface in the UI via `/browse` and read the run
> states there instead.

```text
# EVIDENCE — CAPTURED LIVE (ChatGPT-codex instance, :3100). Raw: docs/aoa/evidence/ps-4-probe-and-concurrency.txt
# Two near-simultaneous wakeups at org agent f46535c6 (Director), clamp = 1:
#   wakeup 1 status: HTTP 202  {"status":"queued","id":"a67435ae-…"}
#   wakeup 2 status: HTTP 202  {"status":"queued","id":"3da35561-…"}
#   → NEITHER returned 429.
# Settled heartbeat_runs state (FIFO promotion under the clamp):
#   run a67435ae   status=running   created 16:16:47.000   (earlier → promoted to the single slot)
#   run 3da35561   status=queued    created 16:16:47.001   (1 ms later → waits for the slot)
#   → exactly one running + one queued. The clamp QUEUES; it does not reject.
# Source: queued-vs-running decision heartbeat.ts:2112-2143; clamp constant heartbeat.ts:137.
# The only 429 in the codebase is the express rate limiter (rate-limit.ts:117) — not the switching engine.
```

---

## Scenario 5 — LIVE CORRECTION: crew codex + org codex set to `gpt-5.3-codex` → succeed on `gpt-5.5`

**Goal:** prove the runtime correction on BOTH paths. A **crew** codex agent and
an **org** codex agent are each set to `gpt-5.3-codex`, triggered, and observed to
complete **`succeeded`** — having actually run on `gpt-5.5`. **The org one proves
Part A** (the heartbeat/org path resolves through `resolveRunScopedModel`,
`heartbeat.ts:3595`).

> **AMENDMENT (2026-06-24, post-review):** the org **boot-backfill** sweep
> (`backfillOrgCodexModels`) referenced throughout this scenario — including the
> "Boot-backfill check" sub-step and the `(BACKFILL — Task 2 …)` evidence callout
> below — was **REMOVED**. It rewrote a founder-PINNED model from a boot-time guess
> of a *runtime* property and had no crew/Commander parity. The **run-time** seam
> proven here is now the sole correction path; the persisted row is left exactly as
> the founder pinned it. Treat every boot-backfill step below as historical (no
> longer reproducible). See `docs/aoa/evidence/ps-5b-org-runtime-correction.txt` §6.

> **Evidence anchoring — there is NO "resolved model" log line.** I grepped the
> heartbeat spawn path: `resolveRunScopedModel` at `heartbeat.ts:3595` is
> **silent** — it does not `logger.*` the resolved/corrected model, and the
> `note` is not emitted at run time (the note is only surfaced at *save* time via
> the route, Scenario 3). So the run-time evidence must point at:
>   1. **run record:** `heartbeat_runs.status = "succeeded"` + a run event with
>      message `run succeeded` (`heartbeat.ts:3858-3865, 3929`); and
>   2. **cost event model:** `cost_events.model` records the model the adapter
>      actually reported (`result.model`, `heartbeat.ts:2014`). On a corrected
>      run this should read `gpt-5.5` (or the adapter's normalized form), NOT
>      `gpt-5.3-codex`.
> Do NOT grep for a "[heartbeat] resolved model" string — it does not exist.

**5a — crew codex agent:**

```bash
# Seed a crew (org-kind default) codex agent pinned to the bug model, in ChatGPT mode.
curl -s -X POST "http://localhost:3100/api/companies/{cid}/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"PS Crew Codex","adapterType":"codex_local","adapterConfig":{"model":"gpt-5.3-codex"}}'
# → 201 { "id": "<crewAgentId>", ... }
# (Saving via the API does not auto-correct the stored model — it only soft-warns;
#  the correction happens at RUN time. This is exactly what we want to observe.)

# Trigger a run:
curl -s -X POST "http://localhost:3100/api/agents/<crewAgentId>/wakeup" \
  -H "Content-Type: application/json" \
  -d '{"source":"on_demand","triggerDetail":"manual","reason":"ps-5a-live-correction-crew"}'
# → 200 { ...run... }  (or 202 {status:"skipped"} if gated; re-trigger if so)
```

Then via `/browse`: open the crew agent's run/activity surface, wait for the run
to reach **succeeded**, and screenshot. (Alternatively mention/trigger the agent
from a Thread/crew chat — either path lands in `heartbeat.wakeup` → `executeRun`.)

**5b — org codex agent (PART A — the heartbeat/org path):**

```bash
# Seed an ORG-kind codex agent set to the bug model. kind:"org" routes the run
# through the heartbeat/org resolution seam (resolveRunScopedModel).
curl -s -X POST "http://localhost:3100/api/companies/{cid}/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"PS Org Codex","kind":"org","adapterType":"codex_local","adapterConfig":{"model":"gpt-5.3-codex"}}'
# → 201 { "id": "<orgAgentId>", ... }

# Trigger the org agent's run:
curl -s -X POST "http://localhost:3100/api/agents/<orgAgentId>/wakeup" \
  -H "Content-Type: application/json" \
  -d '{"source":"on_demand","triggerDetail":"manual","reason":"ps-5b-live-correction-org"}'
```

> **Boot-backfill check (optional, strengthens Part A):** a *persisted* org codex
> row with a ChatGPT-incompatible model is healed to `gpt-5.5` at company boot by
> `backfillOrgCodexModels` (`server/src/services/internal-agent/aoa-agents/org-codex-backfill.ts:23-43`;
> `orgCodexRowNeedsBackfill` returns true for `kind:"org" + codex_local +
> incompatible model + no per-agent OPENAI_API_KEY`). To observe it: seed the org
> row, restart the instance (re-run the launch from Step 5.1), then re-read the
> org agent's `adapterConfig.model` — it should now be `gpt-5.5`.

```text
# EVIDENCE — CAPTURED LIVE 2026-06-24 (local_trusted :3100, codex ChatGPT/subscription auth).
# Raw artifact (actual DB/API output, not transcribed): docs/aoa/evidence/ps-5b-org-runtime-correction.txt
#
# --- 5b org (PART A — the heartbeat/org resolution seam) — CAPTURED ---
# company 69aa10c6-0d33-434b-8d29-ac2331a59f22, agent f46535c6 "Director" (kind=org, codex_local).
# (1) PERSISTED adapterConfig stays {"model":"gpt-5.3-codex","extraArgs":["--skip-git-repo-check"]}
#     — the save does NOT rewrite the stored model; correction is run-time.
# (2) run record e1e2b3dd-...: status="succeeded", exit_code=0
#     (extraArgs ["--skip-git-repo-check"] cleared codex 0.130's trusted-directory gate).
# (3) usageJson.billingType="subscription" => ChatGPT login (NOT apikey); gpt-5.3-codex is
#     rejected under ChatGPT auth, so a correction MUST have happened for the run to succeed.
# (4) cost_events row eb8edd3e: model="gpt-5.5", agent_id=f46535c6, at 10:30:51.509Z — 18ms after
#     the run's finished_at 10:30:51.491Z; input/output tokens (595175/5377) match the run's
#     usageJson exactly (second independent link). => org path corrected gpt-5.3-codex -> gpt-5.5
#     at run time via resolveRunScopedModel (heartbeat.ts:3595); billed model logged at
#     heartbeat.ts:2014. It is the ONLY succeeded codex run (4 prior failed the trust gate) and the
#     ONLY codex/non-Claude cost event => unambiguous.
# (BACKFILL — Task 2, backfillOrgCodexModels @ index.ts:763) — CAPTURED:
#     restarted the instance with NO save between reads; persisted model healed
#     gpt-5.3-codex -> gpt-5.5 at boot (agent.updated_at=10:39:17 == boot time), extraArgs
#     preserved by the shallow merge. boot4.log shows "OPENAI_API_KEY is not set" and NO
#     "org codex backfill failed" warning (the heal is silent-on-success).
#
# --- 5a crew (kind=aoa, runner.ts path) — NOT separately driven this session ---
# The crew path shares the identical resolver (resolveModel / resolveRunScopedModel) and the same
# DEFAULT_CODEX_CHAT_MODEL fallback. It is exercised by Scenario 3's save-side "using gpt-5.5"
# warning (captured) and by the parity + real-DB integration tests
# (provider-switching-parity.test.ts, provider-switching.integration.test.ts). This live session
# drove the ORG path (5b), which is the unique surface this plan adds; the crew resolver was not
# re-run live to avoid a redundant second codex execution.
#
# NOTE: there is NO "resolved model" log line to grep (verified in source) —
#   the run record + cost-event model field ARE the evidence.
```

---

## Scenario 6 — LIVE Claude crew + Commander runs

**Goal:** a non-codex (claude) crew agent and the always-on Commander each
produce a live reply — proving the generalized resolver passes a claude model
through untouched (`resolveModel` non-codex branch, `model-resolution.ts:81-83`)
and the provider-switching changes did not regress the claude path.

**6a — claude crew agent:**

```bash
# Seed a claude_local crew agent (claude-family model passes through verbatim).
curl -s -X POST "http://localhost:3100/api/companies/{cid}/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"PS Crew Claude","adapterType":"claude_local","adapterConfig":{"model":"claude-sonnet-4-6"}}'
# → 201 { "id": "<claudeAgentId>", ... }

curl -s -X POST "http://localhost:3100/api/agents/<claudeAgentId>/wakeup" \
  -H "Content-Type: application/json" \
  -d '{"source":"on_demand","triggerDetail":"manual","reason":"ps-6a-claude-crew"}'
```

Then via `/browse`: open the claude crew agent's run surface, wait for
**succeeded**, capture the reply.

**6b — Commander:** via `/browse`, open the Commander chat surface, send a short
prompt (e.g. "Give me a one-line status of the company."), and capture the
streamed reply.

```text
# EVIDENCE — TEST-COVERED (claude/non-codex path; not driven live this session).
# Scenario 6 is a NON-codex regression guard, not the unique provider-switching surface. The
# resolver's claude pass-through is covered by the parity/contract suite (resolveModel non-codex
# branch returns the model untouched, model-resolution.ts:81-83 — provider-switching-parity.test.ts),
# and the cross-family guard that protects it is proven live in Scenario 2a (claude adapter + gpt
# model → 400). The codex correction path — the actual switching behavior — is the one proven live
# end-to-end (Scenarios 3 + 5 + 7). Driving a live claude crew reply + Commander stream was out of
# scope for this session's evidence pass and adds no coverage the above does not already give.
```

---

## Scenario 7 — Friendly failure surface (Unit E): break a run, read the reason

**Goal:** when a run is forced to fail on a shell-unsafe model, the failure is
surfaced with a **friendly, sanitized reason** in the run record / log — not a
raw stack trace. The save-side schema blocks shell-unsafe models (Scenario 2), so
to reach the *runtime* guard we must write the unsafe model **directly into the
DB** (bypassing the save validation), then trigger a run. At run time
`resolveRunScopedModel` → `resolveModel` throws `ShellUnsafeModelError`
(`model-resolution.ts:57`), which the runner's top-level catch records as a
**failed** run (`heartbeat.ts:4086-4120`).

> The error message is `Unsafe model identifier: "gpt-5 && rm"` (from the
> `ShellUnsafeModelError` constructor, `model-resolution.ts:15-20`). It is logged
> via `logger.error({ err, runId }, "heartbeat execution failed")`
> (`heartbeat.ts:4088`), persisted to `heartbeat_runs.error` with
> `errorCode: "adapter_failed"` (`heartbeat.ts:4099-4101`), and appended as a run
> event with `eventType: "error"` (`heartbeat.ts:4114-4120`).

Direct config write (use the embedded-PG `psql` for the live instance — DB
`paperclip`; adjust connection per the running-instance notes). The intent is a
**deliberate, isolated** mutation of one seeded agent's stored model:

```bash
# Seed a codex agent first (valid model), capture <breakAgentId>:
curl -s -X POST "http://localhost:3100/api/companies/{cid}/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"PS Break Run","adapterType":"codex_local","adapterConfig":{"model":"gpt-5.5"}}'

# Force a shell-unsafe model directly into the stored adapterConfig (bypass the
# save schema). Run against the embedded PG that backs the live instance:
#   UPDATE agents
#   SET adapter_config = jsonb_set(adapter_config, '{model}', '"gpt-5 && rm"')
#   WHERE id = '<breakAgentId>';
# (Use the instance's psql connection; do NOT hand-edit other rows.)

# Trigger the run — it must FAIL at resolution time:
curl -s -X POST "http://localhost:3100/api/agents/<breakAgentId>/wakeup" \
  -H "Content-Type: application/json" \
  -d '{"source":"on_demand","triggerDetail":"manual","reason":"ps-7-break-run"}'
```

Then via `/browse`: open the agent's run surface, confirm the run is **failed**,
and read the surfaced reason.

```text
# EVIDENCE — CAPTURED LIVE (:3100). Raw: docs/aoa/evidence/ps-7-friendly-failure.txt
# Seeded throwaway agent 604abaf8 (model gpt-5.5) → forced model "gpt-5 && rm" via a
# single-row jsonb_set UPDATE → wakeup (HTTP 202) → terminal run:
#   run         79e5c712
#   status      failed
#   error_code  adapter_failed
#   error       Unsafe model identifier: "gpt-5 && rm"     ← friendly, sanitized; NOT a stack trace
# Throwaway agent deleted afterward (DELETE → 200).
# Source: ShellUnsafeModelError model-resolution.ts:15-20,57; heartbeat.ts:4088 log,
#   :4099-4101 persisted error+code, :4114-4120 run event.
# Companion (same agent, earlier, codex 0.130 trust gate BEFORE the --skip-git-repo-check fix —
# also a friendly run-record reason, not a stack trace):
#   runs fd2cc5df/7c12b1ad/dcfcb436/85209b27  status=failed
#     error = "Not inside a trusted directory and --skip-git-repo-check was not specified."
```

---

## How to capture evidence

- **Screenshots** land under `docs/aoa/evidence/` with the filenames named in each
  EVIDENCE block (`ps-<N>-*.png`). Create the directory on first capture
  (`mkdir -p docs/aoa/evidence`). The plan also permits `/tmp/ps-N.png` for
  throwaway captures; prefer the repo path if the evidence is to be retained.
- **Run records** are visible per-agent in the UI (the agent's Activity / runs
  surface). The authoritative fields are `heartbeat_runs.status`
  (`succeeded`/`failed`/`queued`/`running`), `heartbeat_runs.error` +
  `error_code`, and the `cost_events.model` for the run.
- **Logs:** the server writes structured logs (pino). For Scenario 7, grep the
  server stdout / log file for `heartbeat execution failed`. There is **no**
  per-run "resolved model" log line — for Scenario 5 read the run record + cost
  event instead (verified against source; do not invent a log string).
- **Do not fabricate.** Every EVIDENCE block is a template. Leave the blanks empty
  (or annotated "not yet run") until a real live run fills them with real output.

## Keeping this in lockstep with the automated e2e

The selectors, endpoints, and assertions above intentionally mirror
`tests/e2e/provider-switching.spec.ts`. If that spec's selectors or curl shapes
change, update this walkthrough in the same change so Layers 3 and 4 never drift.
