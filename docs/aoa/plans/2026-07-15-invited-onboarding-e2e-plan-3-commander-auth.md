# Plan 3 — In-App Commander CLI Auth (Workstream 3 / Track C)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).
> **Spec:** `2026-07-15-invited-onboarding-e2e-design.md` §6 (v4, Codex-hardened). **Branch:** `feat/invited-onboarding-e2e`. Independent of Plan 2.

**Goal:** Remove the "drop to a terminal" step in the Commander-verify gate — the founder can paste an API key (stored encrypted) or run an in-app Claude/Codex login, all from the app.

**Architecture:** Store the API key via `secretsService`, bound as a `secret_ref` into the Commander AGENT's `adapterConfig.env`; make verify probe the RESOLVED config. In-app login is an async challenge lifecycle built on `spawnTrackedChild`, locked by `(provider, effective auth-home)`, with a durable record + startup reaper. Every route requires an explicit board actor. Device flows are dogfood-verified.

**Tech Stack:** Express 5, Drizzle, Vitest, React, pnpm. `packages/adapters/{claude,codex}-local`, `packages/adapter-utils`.

---

## File Structure

- Modify: `server/src/routes/commander-verify.ts` — board gate + probe the resolved Commander config.
- Create: `server/src/services/commander-key.ts` — `persistCommanderApiKey`.
- Create: `server/src/routes/commander-key.ts` — `POST …/internal-agent/commander-key`.
- Create: `packages/adapters/codex-local/src/server/login.ts` — `runCodexLogin` (streaming); modify claude-local for a streaming login variant.
- Create: `server/src/services/commander-login.ts` — challenge lifecycle (store, lock, reaper); `server/src/routes/commander-login.ts` — start/status/cancel.
- Modify: `ui/src/onboarding/steps/VerifyStep.tsx` — API-key paste + login-URL + poll.
- Modify: `server/src/index.ts` — register the startup reaper + shutdown hook.

---

## Task 1: Board gate + verify probes the RESOLVED Commander config (§6.0, §6.1)

**Files:** Modify `server/src/routes/commander-verify.ts`; test `server/src/__tests__/commander-verify-resolved.test.ts`.

- [ ] **Step 1: Failing test** — (a) a non-board actor (e.g. `{type:"agent"}`) → 401/403 even if `assertRole` would pass. (b) the verify handler loads the Commander agent and calls `testEnvironment` with the **resolved** adapter config (env populated), not `config:{}` — assert the probe received `config.env.ANTHROPIC_API_KEY` when a binding exists (mock `resolveAdapterConfigForRuntime`).

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — require `actor.type==="board"` before any `assertRole`; **load the Commander agent via `internal_agent_config.agent_id`** (`internal_agent.ts:125`) — read-only, do NOT call `ensureCommanderAgent` (mutating). Resolve its config via `secretsService(db).resolveAdapterConfigForRuntime(companyId, agent.adapterConfig, ctx)` (real signature `(companyId, adapterConfig, context)`, `secrets.ts:819`) and pass it to `adapter.testEnvironment({ companyId, adapterType, config: resolved })` (probes read `config.env`). Handle a missing/mismatched config row gracefully.

- [ ] **Step 4: Run, full server suite (touches the auth gate), commit.**

---

## Task 2: `persistCommanderApiKey` + route (§6.1)

> **Codex P1 #8 / P2 #5:** `syncEnvBindingsForTarget` only creates/deletes `company_secret_bindings` rows (`secrets.ts:737`) — it does **not** write the agent. The service must itself **merge the `secret_ref` into the Commander agent's `adapterConfig.env` and persist the agent row**, THEN call the binding sync with that env. Resolve the Commander agent via **`internal_agent_config.agent_id`** (`internal_agent.ts:125`) — do NOT call `ensureCommanderAgent` (mutating; may rewrite config).

**Files:** Create `server/src/services/commander-key.ts` + `server/src/routes/commander-key.ts` (mount in app.ts); modify `VerifyStep.tsx`; tests.

- [ ] **Step 1: Failing unit test** — `persistCommanderApiKey(deps, {companyId, provider:"anthropic", apiKey:"sk-ant-SECRET"})`: (a) the raw key goes to `secretsService.create`/`rotate` (encrypted); (b) the Commander agent (looked up via `internal_agent_config.agent_id`) has its `adapterConfig.env.ANTHROPIC_API_KEY` set to a **`secret_ref`** and the agent row is **persisted**; (c) `syncEnvBindingsForTarget` is called for that agent with the merged env; (d) **no plaintext** anywhere (`JSON.stringify` of both the agent update and the config excludes `sk-ant-SECRET`). Rotate-on-conflict.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** the service (resolve agent via `internal_agent_config.agent_id`; provider→env-var name; `secretsService` write; merge+persist `adapterConfig.env` `secret_ref`; `syncEnvBindingsForTarget`).

- [ ] **Step 4: Route + route tests** — `POST /api/companies/:companyId/internal-agent/commander-key { value, provider }`. **Explicit board-actor check BEFORE `assertRole("founder")`** (agents bypass `assertRole` — Codex #10). Route tests (Codex P2 #7): **agent actor → 401/403; team_member → 403; invalid provider/empty value → 400; success → key in the encrypted vault, not the response.**

- [ ] **Step 5: `VerifyStep` API-key affordance** — in `needs_auth`, a password field + "Save key & re-check" → `POST commander-key` then re-`verify`. RTL test: paste → posts key → re-probes.

- [ ] **Step 6: Run, typecheck, full server suite, commit.**

---

## Task 3: Streaming login runners (§6.2)

**Files:** Create `packages/adapters/codex-local/src/server/login.ts`; modify `packages/adapters/claude-local/src/server/execute.ts` (streaming variant); tests for URL parsing.

- [ ] **Step 1: Failing unit test — URL parsing** — feed sample `claude login` and `codex login` stdout+stderr chunks (including split-across-chunk URLs) to the parser; assert it extracts the verification URL; assert it resolves `no-url` when the process exits without one.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — a streaming runner built on `spawnTrackedChild` (`server-utils.ts:405`, returns `{child, pid, pgid, startedAt, terminate}`). Return a **full contract (Codex P2 #6)**: `{ handle, urlPromise, exitPromise }` where — `urlPromise` resolves on the first verification URL (buffer stdout+stderr across chunk boundaries, bounded buffer, reject on exit-without-URL or a discovery timeout); `exitPromise` resolves with the child's exit code so Task 4's lifecycle can mark `completed`/`failed`; the runner owns the child's `close`/`error` listeners and clears the discovery timeout once the URL is found. `runCodexLogin` (net-new, `codex login`, shared codex home) + a claude variant.

- [ ] **Step 4: Run, verify PASS; commit.**

---

## Task 4: Login challenge lifecycle — durable store, lock, reaper, routes (§6.2)

> **Codex P1 #9/#10/#11 corrections:**
> - **Real function names:** the codex home resolver is **`resolveSharedCodexHomeDir`** (`codex-home.ts:16`), not `resolveCodexHome`. There is **no** repo-level Claude auth-home resolver — define one (the Claude config home). **Completion evidence is provider-specific:** codex → `auth.json` in its home; claude → its own credential file. Do NOT hardcode `auth.json` for both.
> - **Durability:** an in-memory map cannot reap a **detached** child after a hard restart (there's no `TrackedChildHandle` after restart, so `terminate()` is gone), and the heartbeat reaper only *marks DB runs failed* — it does not kill a process. So this task needs (a) a **concrete durable store** and (b) a **terminate-by-PID/PGID primitive**.
> - **Auth scope:** routes are **founder-scoped**, not merely board-gated.

**Files:** Create `packages/db/src/schema/commander_login_challenges.ts` (+ `pnpm db:generate`), `server/src/services/commander-login.ts`, `server/src/routes/commander-login.ts`, `server/src/lib/terminate-process.ts`; modify `server/src/index.ts`; tests.

- [ ] **Step 1: Durable schema + `terminateByPid` primitive (TDD each).**
  - `commander_login_challenges` table: `id`, `companyId`, `provider`, `authHome`, `pid`, `pgid`, `status` (`pending|completed|failed|timeout`), `startedAt`. Migration via `pnpm db:generate`.
  - `terminateByPid(pid, pgid)` in `server/src/lib/terminate-process.ts`: cross-platform kill — POSIX `process.kill(-pgid, "SIGKILL")` (process group), Windows `taskkill /PID <pid> /T /F`. Unit-test the platform branch selection (mock `process.platform` + the killer).

- [ ] **Step 2: Failing lifecycle unit test** — (a) `startChallenge(company, provider)` inserts a durable record `{provider, authHome, pid, pgid, status:"pending", loginUrl}`; (b) a second start for a **different company sharing the same `(provider, authHome)`** is rejected (cross-company exclusion); (c) `getStatus` → `completed` on `exitPromise` code 0 / provider credential file present; (d) `cancel` → `terminateByPid` + record removed; (e) `reapOrphans()` reads persisted rows and `terminateByPid`s any stale child, then clears the rows.

- [ ] **Step 3: Run, verify FAIL.**

- [ ] **Step 4: Implement** — store keyed by `(provider, canonical(effectiveAuthHome))` where effectiveAuthHome = codex → `resolveSharedCodexHomeDir(env)`, claude → the Claude config home resolver (new). Use Task 3's `{handle, urlPromise, exitPromise}`. Persist pid/pgid at start; on `exitPromise`/completion update status; on `cancel`/`reapOrphans` call `terminateByPid`. Bounded timeout.

- [ ] **Step 5: Routes + tests** — `POST …/commander-login/start { provider }`, `GET …/commander-login/:id`, `POST …/commander-login/:id/cancel`. Each: **explicit board actor + `assertRole("founder")`**; tests assert **agent → 401/403 and team_member → 403** (Codex #10), plus start returns `{challengeId, loginUrl}`, status, cancel.

- [ ] **Step 6: Startup reaper + shutdown hook** — call `reapOrphans()` at boot and a shutdown hook in `index.ts` that terminates active challenge children. (The heartbeat reaper marks DB rows; this one actually kills — reuse the boot-sequence location near `heartbeat.ts:2376`.)

- [ ] **Step 7: `VerifyStep` login integration** — `needs_auth`: "Sign in with {provider}" → `start` → show `loginUrl` → poll `status` → on `completed`, auto re-verify. RTL test with mocked routes.

- [ ] **Step 8: Run, full server + UI typecheck, `pnpm db:generate` committed, commit.**

---

## Task 5: Track-C visual + honesty

**Files:** `tests/e2e/onboarding-commander-auth.spec.ts` (visual states) + a `docs/` honesty note.

- [ ] **Step 1: Visual spec** — drive `VerifyStep` to each state via mocked/faked probe: `needs_auth`, API-key paste + validation error, login-URL shown, `completed`. Capture screenshots + baselines. (Fake-claude/codex control scripts drive the states in CI; the real device flow is dogfood-only.)

- [ ] **Step 2: Honesty note** — record in the plan/PR that the live `claude login`/`codex login` device flows are **dogfood-verified, not CI-asserted**; CI covers URL parsing + lifecycle + secret storage + resolved-config verify.

- [ ] **Step 3: Commit.**

---

## Coverage & honesty note (Track C) — what CI asserts vs. what is dogfood-only

**CI-asserted (unit + RTL + Playwright route-mocked e2e):**

- **URL parsing** — `createLoginUrlDetector` (chunk-boundary-safe, single-settle,
  terminator-gated) + `runStreamingLogin` (`{handle, urlPromise, exitPromise}`,
  stdout/stderr, no-url/timeout rejection) — `packages/adapter-utils/*.test.ts`.
- **Provider wrappers** — `runCodexLogin` / `runClaudeLoginStreaming` argv + auth
  home wiring — per-adapter `login.test.ts`.
- **Lifecycle** — `terminateByPid` platform branch; `commander-login` service
  (cross-company lock, same-company idempotency, url-fail → no dangling pending,
  getStatus/cancel/reapOrphans) — `terminate-process.test.ts`,
  `commander-login-service.test.ts`.
- **Routes** — founder gate (agent→401, team_member→403), start/status/cancel,
  409 lock, 502 no-url — `commander-login-route.test.ts`.
- **Secret storage + resolved-config verify** — `commander-key`
  (encrypted, secret_ref into agent env, raw key never echoed) + the verify
  probe reading the *resolved* Commander config — `commander-key*.test.ts`,
  `commander-verify` probe-config.
- **UI states** — VerifyStep `needs_auth`: key-paste re-verify, login-URL shown,
  poll → completed → advance — `VerifyStep.test.tsx` + the route-mocked
  `onboarding-commander-auth.spec.ts`.

**Dogfood-only (NOT CI-asserted — requires a live CLI + a real browser round-trip):**

- The actual `claude login` / `codex login` **device flow** end-to-end: real
  subprocess spawn, the vendor printing a real verification URL, the operator
  completing sign-in in a browser, and the credential file landing in the auth
  home (codex `auth.json` / claude `.credentials.json`) so the *next* verify
  passes. Two constants are best-guess and only confirmable by dogfood: the
  claude credential filename (`resolveClaudeConfigHome` + `.credentials.json`)
  and each provider's exact `login` subcommand/argv. If a dogfood run shows a
  false "failed" after a successful sign-in, fix the credential path in
  `commander-login-runtime.ts` (single-sourced there).

---

## Self-review notes
- §6.0/§6.1 → T1+T2; §6.2 → T3+T4; §6.3 honesty/visual → T5.
- Board-actor gate (not just `assertRole`) is asserted in T1 + every route test (agents bypass `assertRole`).
- Cross-company `(provider, authHome)` exclusion + orphan reaping are explicit tests (T4) — the two round-2/3 P1s.
- Dogfood gate is explicit; do not claim CI proves the device flow.
