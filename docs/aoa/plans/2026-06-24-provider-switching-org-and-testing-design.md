# Provider Switching — Org-Agent Extension + Comprehensive Test Coverage — Design Spec

**Status:** Draft v1
**Date:** 2026-06-24
**Branch:** `feat/provider-switching-org` (stacked on `feat/provider-switching` / PR #221)
**Origin:** post-merge follow-up to the Provider Switching Engine (Phase 1). Builds on `docs/aoa/plans/2026-06-23-provider-switching-engine-design.md`.

---

> **AMENDMENT (2026-06-24, post-review):** the **boot backfill** half of Part A (`org-codex-backfill.ts`)
> was **removed** after review. It rewrote a founder-PINNED model from a boot-time GUESS of a *runtime*
> property (auth mode), clobbering companies on a shared api-key `auth.json` where `gpt-5.3-codex` is
> valid, and had no crew/Commander parity. The **run-time seam** (`resolveRunScopedModel` on the
> heartbeat path) is the sole, correct correction point and stands as shipped. Wherever this spec says
> "+ self-healing backfill" or "boot sweep," read it as historical context — only the run-time
> resolution shipped. See `docs/aoa/evidence/ps-5b-org-runtime-correction.txt` §6.

---

## 1. Goal

Two coupled deliverables:

1. **Org-agent runtime coverage (Part A).** Extend the provider-switching runtime resolution — currently applied only on the crew (`runAoaAgent`) and Commander (`cli-mode`) paths — to **org agents**, which run via the **heartbeat** path. After this, *every* agent (crew, Commander, org) gets the same auth-aware, shell-safe model resolution + self-healing backfill at run time.

2. **Comprehensive, durable test coverage (Part B).** A 4-layer test strategy — unit/contract → real-DB integration → automated Playwright e2e (permanent CI gate) → a repeatable *watched* `/browse` walkthrough on Windows — covering the full provider-switching scenario matrix across **all** agent kinds and **both** live providers (codex + claude).

## 2. Why (evidence from live verification on 2026-06-24)

- PR #221 shipped provider-switching for crew + Commander. Live-verified working: codex and claude both run on crew (`runAoaAgent`) and Commander (`cli-mode`), and directly (`claude -p` / `codex exec` both succeed). The earlier "claude org-blocked" reading was a **transient** failure, not a policy block.
- **The gap:** org agents (`kind: "org"`) are refused by the crew runtime (heartbeat guard, Decision #100) and run via `heartbeat.ts` — which has **no** `resolveModel`/`getProviderStatus` call. So an org codex agent pinned to an API-key-only model (`gpt-5.3-codex`) on a ChatGPT login silently no-ops (HTTP 400 → empty turn). Confirmed: a direct `PATCH` of an org agent to `gpt-5.3-codex` persisted with no runtime correction.
- **The test gap:** the e2e suite is a `test.skip` placeholder; integration is `skipIf(win32)` (CI-only); there is no repeatable UI walkthrough. The unit/contract layer is strong but the upper layers are missing.

## 3. Scope

**In scope:**
- Part A: heartbeat-path runtime resolution for org agents + an org-codex boot backfill sweep.
- Part B: all four test layers, covering crew + Commander + org and both providers, plus a live "watch the correction" scenario in ChatGPT-codex mode.

**Out of scope:**
- No new resolution engine — reuse `resolveModel` / `applyModelResolutionToConfig` / `getProviderStatus` / `realProviderStatusDeps` verbatim.
- No changes to the crew/Commander resolution already shipped in #221.
- Gemini/OpenCode live runs (no local auth) — covered by unit/e2e only, "framework-ready, pending auth," consistent with #221.

---

## Part A — Org-agent runtime extension

### A1 — Heartbeat choke point (the load-bearing change)

Apply resolution to `runScopedConfig` in `server/src/services/heartbeat.ts` **after** the budget/recovery cheap-model swaps (~3544-3575) and **before** `resolveAdapterExecutionContext(runScopedConfig, adapter)` (~3704) — not merely before `adapter.execute` (~3732), since `resolveAdapterExecutionContext` also derives from `runScopedConfig`. Mirroring the crew runner:

```
providerStatus = best-effort getProviderStatus(agent.adapterType, { companyId, adapterConfig: runScopedConfig }, realProviderStatusDeps)   // guarded; fallback authMode "unknown"
runScopedConfig = applyModelResolutionToConfig(agent.adapterType, runScopedConfig, providerStatus, { inheritedEnvOpenAiKey: process.env.OPENAI_API_KEY ?? null })
```

**Edge #5 (critical ordering):** `heartbeat.ts` already mutates `config.model` for budget/recovery runs (`runScopedConfig = {...runScopedConfig, model: recoveryCheapModel}` ~3549, cheap-model swap ~3563). The resolution call MUST run **after** those swaps, so it resolves the model that will actually execute — never a pre-swap value. A dedicated test locks this ordering.

- Best-effort guard: a `getProviderStatus` failure falls back to `authMode: "unknown"` and never breaks a run (same pattern as the crew path).
- `ShellUnsafeModelError` from `applyModelResolutionToConfig` propagates to the heartbeat run's existing failure handling (recorded as a failed run), exactly as on the crew path.
- Company-key strip applies (codex only): the inherited `process.env.OPENAI_API_KEY` is removed unless the agent set its own.

### A2 — Org-codex boot backfill sweep

The existing backfill (`needsAdapterBackfill` + the crew `ensure-*`/seed consumers) only heals crew (`kind: "aoa"`) rows. Org agents are never seeded by that path. Add a **boot sweep** that, on startup, finds `kind: "org"` + `codex_local` agents whose persisted `adapterConfig.model` fails `isCodexCompatibleModel` and rewrites them to `DEFAULT_CODEX_CHAT_MODEL` (`gpt-5.5`) via **shallow-merge** (`{ ...existing, model: DEFAULT_CODEX_CHAT_MODEL }`). Do NOT use `mergeAdapterConfig` (crew-oriented; drops `env`/`cwd`/`promptTemplate`/`timeoutSec`). Reuse `needsAdapterBackfill`'s codex predicate; the only new surface is the org population sweep + its wiring in the `server/src/index.ts` boot all-company loop (~703-769), NOT in `companies.ts` (create-only — existing companies would be missed).

### A3 — Tests (Part A)

- Pure: `applyModelResolutionToConfig` reuse is already covered; add a heartbeat-wiring helper unit test (extract a pure helper if needed for testability, mirroring `runner-model-resolution`).
- **Edge-#5 ordering test:** a budget/recovery model swap followed by resolution yields the resolved-from-swapped-model, not the original.
- Backfill: org-codex predicate + sweep (mock-DB).
- Integration (Layer 2): seed a bad org-codex row → boot sweep → corrected; and an org heartbeat run resolves the model (assert via `onMeta`/persisted config, no real spawn).

---

## Part B — 4-layer test strategy

### Layer 1 — Unit / contract (catalog + extend)

Catalog the existing green unit suite (provider-status parsers, `resolveModel` branches incl. shell-unsafe + auth-aware + opencode slash, validator cross-family + shell-safety, redaction, parity, failure-mapper). **Add:** the heartbeat helper + edge-#5 ordering + org-backfill predicate.

### Layer 2 — Integration (real-DB, embedded-postgres, `skipIf(win32)`, CI Linux)

Extend `provider-switching.integration.test.ts`:
- switch adapter+model via the real route → persisted; assert resolved argv via `onMeta.commandArgs` (no real spawn) — for **crew and org** paths.
- backfill heals a seeded bad row for **crew and org** codex agents.
- managed-home vs shared-home auth-mode (per-agent key → apikey).
- crew ↔ Commander parity (existing).
- **org heartbeat resolution** parity with crew (same input → same resolved model).

### Layer 3 — Automated Playwright e2e (the permanent CI gate)

Replace the `test.skip` placeholder with real specs. The e2e drives the **real UI + server** but asserts only **route/UI-observable** behavior — it does NOT spawn the crew/heartbeat or call a real LLM. Determinism for the auth-dependent surfaces comes from mocking **`getProviderStatus` at the route layer** (so the soft-warn fires predictably) and mocking the **probe adapter** (so test-connection returns a fixed result). The run-time argv correction is NOT an e2e concern — that lives in Layer 2 (integration, via `onMeta.commandArgs`). Specs:
- Onboarding shows codex default `gpt-5.5`; placeholder `e.g. gpt-5.5`.
- Agent config model picker: `Default → gpt-5.5`, family-correct list (per-adapter), `gpt-5.5` present.
- Save: cross-family → `400` inline; shell-unsafe → `400`; auth-mismatch → `warnings[]` renders via `AgentSaveWarnings`.
- **Correction, save-side:** with `getProviderStatus` mocked to chatgpt, saving codex `gpt-5.3-codex` renders the "using `gpt-5.5`" warning; with it mocked to apikey, no warning (passthrough).
- Test-connection probe (mocked adapter) → ✓/✗ result; per-company concurrency → `429`; planted secret redacted.
- Org agent: create + save surfaces (defaults, warnings) behave identically to crew.
- Runs on CI Linux (Windows e2e remains skipped at the playwright-config level, per existing CI policy).

### Layer 4 — Watched `/browse` walkthrough (Windows-local, repeatable, evidence-capturing)

A scripted, re-runnable `/browse` walkthrough (a documented sequence, or a thin browser-skill) that drives the **real running app** and captures a screenshot/log per scenario:
- All save-time/UI surfaces live (defaults, 400s, warning notice, probe).
- **Live crew + Commander + org runs** for **both codex and claude** (all proven runnable on 2026-06-24).
- **Headline correction live:** an org *and* a crew codex agent set to `gpt-5.3-codex`, in **ChatGPT-codex mode**, observed resolving to `gpt-5.5` and completing (vs. the api-key-mode passthrough case for contrast).
- Unit E: a deliberately-broken run surfaces a friendly, redacted reason.
- Output: an evidence bundle (screenshots + the run records/log lines) per scenario.

---

## 4. Master scenario matrix

Every layer maps to this list (✔ = that layer asserts it):

| Scenario | Unit | Integration | e2e | Watched |
|---|---|---|---|---|
| codex chatgpt + `gpt-5.3-codex` → corrected `gpt-5.5` (crew/Commander/**org**) | ✔ | ✔ (argv) | ✔ (save-warn) | ✔ (live) |
| codex apikey + `gpt-5.3-codex` → passthrough | ✔ | ✔ | ✔ | ✔ |
| codex + `gpt-5.5` → runs | ✔ | ✔ | – | ✔ |
| claude + claude model → runs (crew/Commander/**org**) | – | – | ✔ (mocked) | ✔ (live) |
| cross-family save → `400` | ✔ | ✔ | ✔ | ✔ |
| shell-unsafe save → `400` | ✔ | ✔ | ✔ | ✔ |
| auth-mismatch soft-warn → `200 + warnings[]` (UI renders) | ✔ | ✔ | ✔ | ✔ |
| model picker default `gpt-5.5` + family-correct list | ✔ | – | ✔ | ✔ |
| probe: resolved model + `429` cap + redaction | ✔ | ✔ | ✔ | ✔ |
| backfill: bad row → `gpt-5.5` (**crew + org**) | ✔ | ✔ | – | ✔ |
| Unit E: failed run surfaced | ✔ | – | ✔ | ✔ |
| company `OPENAI_API_KEY` never leaks (env-strip) | ✔ | ✔ | – | – |
| **org runtime correction (new)** | ✔ | ✔ | ✔ | ✔ |

## 5. Known edge cases (carry into implementation + tests)

1. **Auth detection "unknown"/lag.** On a company's first codex run the managed `auth.json` may not exist → `authMode: "unknown"` → resolution corrects `gpt-5.3-codex` even for a genuine api-key user (harmless; `gpt-5.5` works on api-key too). Shared with crew.
2. **Company key shapes the managed home.** The codex adapter's `prepareManagedCodexHome` reads `process.env.OPENAI_API_KEY` to decide api-key vs copy-shared; the env-strip keeps the key out of the agent's spawn env but not out of this provisioning. Pre-existing; document, don't fix here.
3. **Save-warn vs runtime can momentarily disagree** if the login changes between save and run. Runtime is the source of truth.
4. **Runtime resolution does NOT fix cross-family** — only codex auth correction. A pre-validator/imported cross-family org row still fails at run; the save-validator is the only cross-family guard. Tests assert this boundary explicitly.
5. **Edge #5 — heartbeat budget/recovery swaps** (A1): resolution must run after the model swaps.
6. **Hot-path cost:** `getProviderStatus` does FS reads per org run; best-effort + guarded, same pattern as crew, acceptable for the heartbeat volume.

## 6. Prerequisites / environment setup

- **ChatGPT-codex mode** for the live correction (Layer 4): run the instance with the per-company managed codex home in subscription mode — clear the stray `OPENAI_API_KEY` from the server env and reset `~/.codex/aoa-instances/<companyId>/auth.json` so it re-copies the shared `auth_mode: chatgpt` login. Verified prerequisite: the shared `~/.codex/auth.json` is `auth_mode: chatgpt`.
- The isolated test instance (`AOA_HOME=C:\Users\TK\.aoa-ps`, port 3100) — keeps `~/.aoa` untouched.

## 7. Decisions (resolved with the user, 2026-06-24)

- **Include org now** — implement the extension + test it together (not a later follow-up).
- **Watch the correction live** in ChatGPT-codex mode.
- **Branching:** keep PR #221 (crew+Commander) mergeable as-is; land Part A + Part B on `feat/provider-switching-org`, stacked on #221, as its own reviewable PR.
- **Reuse the engine** — no parallel resolver; the only new application point is `heartbeat.ts` (after cheap-model swaps ~3575, before `resolveAdapterExecutionContext` ~3704) + the org backfill sweep.

## 8. Logistics

Branch `feat/provider-switching-org` off `feat/provider-switching`. writing-plans will sequence: Part A (heartbeat wiring + edge-#5 test → org backfill sweep) → Layer 2 integration extensions → Layer 3 Playwright e2e (the largest new surface) → Layer 4 watched-walkthrough script + evidence bundle. Each unit gets its full test slice and frequent commits, per the #221 cadence.
