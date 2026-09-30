# Provider Switching Engine (Phase 1) — Design Spec

**Status:** Draft v2 (revised after two independent code reviews)
**Date:** 2026-06-23
**Branch:** `feat/provider-switching`
**Origin:** systematic-debugging investigation → brainstorming → adversarial spec review (architecture lens + QA/security lens)

---

## 1. Goal

A founder (or department team-lead) can change an AoA agent's **provider** (Claude / Codex / Gemini / OpenCode) and **model** from the existing per-agent config, and have **both** the crew path *and* Commander reliably run that provider with a *compatible, shell-safe* model — or get a clear, in-product reason when they can't. No silent failures, no broken-by-default switches, no two code paths disagreeing.

This is **Phase 1: the engine**. **Phase 2** (the Providers page with install/login/API-key actions) layers on top and is out of scope (see §11).

## 2. Why (evidence)

A 2026-06-23 systematic-debugging session proved "switching providers doesn't work" was a stack: expired Claude token (user-fixed), a wrong Codex default model, no adapter↔model validation, and silent run failures. Proven working after manual fixes: Claude (Adjutant) replied; Codex/`gpt-5.5` (Scout) replied via the real `PATCH /agents/:id?companyId=` route. Routing already honors the selected adapter — the gaps are **correctness, consistency across the two run paths, and observability**.

**Key architectural facts established by review (these reshape the design):**
- The runner does **not** assemble `--model`; each adapter's `execute.ts` **and** `test.ts` read `config.model`. The only true choke point is **mutating `config.model` in `runner.ts:~319` before `adapter.execute`**.
- Codex runs against a **managed per-company `CODEX_HOME`** (`resolveManagedCodexHomeDir(env, companyId)`, `codex-local/src/server/codex-home.ts`). By default its `auth.json` is **copied from the shared `~/.codex` login** — the separately-installed Codex CLI / ChatGPT subscription. It is written as an **api-key** `auth.json` **only** when a *per-agent* `adapterConfig.env.OPENAI_API_KEY` is explicitly set on that agent (`execute.ts:280-289` reads `env.OPENAI_API_KEY`, which is seeded **only** from `buildAoaEnv` + `adapterConfig.env` — verified: it never spreads `process.env` and never reads a company-level key). `config.toml` (for the default model) is read from the **shared** `~/.codex`. **This per-agent key is NOT the company-level extraction/embedding `OPENAI_API_KEY`** — Decision #91 reserves that solely for the Provider SDK, and the CLI/provider-switching path must never read or depend on it. Auth-mode detection must be **company-scoped** and read exactly these sources.
- Commander's `server/src/services/internal-agent/cli-mode.ts` is a **second** model-resolution path (via `codex-model.ts`) with its own `CODEX_HOME`. It must be unified with the crew path or they diverge.
- **`server/src/services/internal-agent/codex-model.ts` already exists** and implements: family classifier + API-key-only detection + shell-safety (`SAFE_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`, line 27), and `resolveCodexChatModel` with a validated `gpt-5.5` safe default (`DEFAULT_CODEX_CHAT_MODEL`, line 13). **We extend and reuse this — not reinvent it.**
- The bad default `gpt-5.3-codex` is **persisted** at `resolve-crew-adapter.ts:66,74` and `agents.ts:270-273`; `needsAdapterBackfill` (`resolve-crew-adapter.ts:113-128`) **skips `codex_local`**, so existing rows never self-heal.
- A model-aware probe endpoint **already exists**: `POST /companies/:companyId/adapters/:type/test-environment` (`agents.ts:460`), gated by `assertCanReadConfigurations` (≈`agents.ts:117/94`, the `agents:create` permission). We **extend it**, not add a parallel one.

## 3. Scope

**In scope (Phase 1):** company-scoped provider-status detection; unified, shell-safe, auth-aware model resolution applied to **both** crew (`runner.ts`) and Commander (`cli-mode.ts`); tiered save-time validation; a model-aware test-connection probe (extending the existing endpoint); source-default fix + backfill of bad persisted models; visible run failures (coordinated, split-out). RBAC + audit + secret-redaction throughout.

**Provider coverage:** framework for all four. **Claude + Codex live-tested**; **Gemini + OpenCode** unit/integration-tested, live lanes "framework-ready, pending auth."

**Out of scope:** Providers page + install/login/API-key actions (Phase 2, §11); thread hop-cap reset (separate); replacing CLI adapters with API adapters (forbidden — Decision #91).

## 4. Components — decomposed into shippable units

Review-mandated decomposition. Dependency: **C depends on B**; A/D/E are independent. Ship order A → B → C → D, E in parallel.

### Unit A — Provider-status detection (read-only, no spawn)
**New:** `server/src/adapters/provider-status.ts`
```
type ProviderAuthMode = "subscription" | "chatgpt" | "apikey" | "unknown";
interface ProviderStatus {
  adapterType; installed: boolean; authenticated: boolean;
  authMode: ProviderAuthMode; defaultModelResolved: string | null; detail?: string; // redacted
}
getProviderStatus(adapterType, { companyId, adapterConfig }): Promise<ProviderStatus>
```
- **Codex (company-scoped):** resolve the **managed** home via `resolveManagedCodexHomeDir(env, companyId)`; if a **per-agent** `adapterConfig.env.OPENAI_API_KEY` is explicitly set on that agent → `authMode: "apikey"`; else parse the managed `auth.json` `auth_mode` (the shared ChatGPT login). **The company-level extraction/embedding `OPENAI_API_KEY` is never consulted** (non-goal — see §7; covered by a test). `defaultModelResolved` = `readSharedCodexModel()` (shared `~/.codex/config.toml`, e.g. `gpt-5.5`). The detected mode MUST equal the mode the run will actually use.
- **Claude:** `~/.claude/.credentials.json` → `subscription` vs `apikey`; best-effort validity note (no token material).
- **Gemini / OpenCode:** installed + authenticated best-effort; `unknown` mode acceptable.
- Pure parsing where possible; never emits secrets; `detail` redacted via `SENSITIVE_ENV_VALUE_PATTERNS`.

### Unit B — Unified, shell-safe, auth-aware model resolution (load-bearing)
**Reuse + extend** `codex-model.ts`; apply at the real choke points.
- Generalize to `resolveModel(adapterType, requestedModel, status): { model?: string; note?: string }`:
  1. **Shell-safety (hard, all tiers):** if `requestedModel` fails `SAFE_MODEL_RE` → throw a typed error. Unknown ≠ unsafe.
  2. **Empty/"Default":** provider default — for Codex, `resolveCodexChatModel(...)` (validated, falls back to `gpt-5.5`); gemini → omit (its internal default is `auto`); claude → its default; opencode → its `provider/model` default.
  3. **Known-incompatible with auth mode** (e.g. an API-key-only Codex model on `chatgpt`): **substitute the safe default + set `note`** (this is what `resolveCodexChatModel` already does — runtime correction, so even a stale persisted bad model self-heals).
  4. **Compatible-known or safe-unknown:** pass through.
- **Apply at BOTH paths:** mutate `baseConfig.model` in `runner.ts:~319` *before* `getServerAdapter(...).execute(config)` (covers all crew spawners: dispatcher, controller, thread-participation, sub-agent, memory-extraction — all route through `runAoaAgent`); and route Commander's `cli-mode.ts:~462` through the **same** resolver so chat and crew never disagree.
- **Source-default fix:** `resolve-crew-adapter.ts:66,74` and `agents.ts:270-273` stop hardcoding `gpt-5.3-codex` (codex → empty/omit so resolution applies; opencode → a valid `openai/...` slash-format default, not a bare codex id).
- **Backfill (blocker fix):** extend `needsAdapterBackfill` to detect `codex_local` rows whose `model` is known-incompatible (e.g. `gpt-5.3-codex`/`*-codex` on a non-apikey home) and rewrite to empty/omit on boot. Runtime correction (step 3) is the safety net; backfill cleans persisted rows so the UI shows the truth.

### Unit C — Tiered save-time validation
- **Pure cross-family + shell-safety check** → `packages/shared/src/validators/agent.ts` (a refinement on `adapterConfig`/`updateAgentSchema`), so it applies automatically to **create, update, and import** (no per-route duplication). Family is inferred by model-id shape, handling **opencode `provider/model` slash-format** and **gemini `auto`**. Hard-block (`400`) only the unambiguous cross-family mismatch and shell-unsafe strings.
- **Auth-mode soft-warn** (needs `provider-status`) stays in `server/src/routes/agents.ts`, applied at **all three** `assertAdapterConfigConstraints` call sites (≈`929` create, `1077`, `1317` update): returns `200` + `warnings[]` (e.g. "`gpt-5.3-codex` needs an API-key Codex login; we'll run `gpt-5.5` instead"). Never hard-blocks a compatible/unknown-safe model.

### Unit D — Model-aware test-connection probe (extend, don't duplicate)
- **Extend** `POST .../adapters/:type/test-environment` (`agents.ts:460`) to accept an optional `model` and run the one-token probe with the resolved model. Reuse its existing RBAC (`assertCanReadConfigurations`) — **decision flagged for the user (§10)**: keep that, or tighten to founder/team-lead.
- **Harden:** a per-company in-flight **concurrency cap + hard timeout ceiling** (model on the heartbeat clamp, CLAUDE.md §D5); run provider `stdout/stderr` through `SENSITIVE_ENV_VALUE_PATTERNS` redaction before returning `{ ok, latencyMs?, error? }`; inject the spawn via a `deps.run` seam so it's unit-testable without real auth.

### Unit E — Visible run failures (split out)
- Surface non-`succeeded` runs in `thread-participation-runner.ts` (the controller path already propagates errors; this one returns `""`). Map known errors (auth/model/CLI-missing) to friendly, **redacted** text. **Coordinated with the already-flagged silent-swallow background task** — Unit E does not block the engine; ship independently.

## 5. Data flow

```
Edit agent config → PATCH /agents/:id?companyId=  [RBAC unchanged]
  → Unit C: pure cross-family + shell-safety (shared validator; 400 on violation)
          + auth-mode soft-warn (route, uses Unit A; 200 + warnings[])
  → persist (atomic; versioned via agent_config_revisions)
  → (optional) Unit D probe → ✓/✗ live
Boot: Unit B backfill rewrites known-bad persisted codex models.
Run (crew via runner.ts AND Commander via cli-mode.ts):
  → Unit B resolveModel(...) mutates config.model (shell-safe, auth-aware, corrected)
  → spawn → success: agent posts via MCP | failure: Unit E surfaces redacted reason
```

## 6. Error handling
- **Save:** `400` only for cross-family or shell-unsafe; otherwise `200` + optional `warnings[]`.
- **Resolution:** shell-unsafe → typed throw (never spawns); incompatible-known → corrected + `note`.
- **Probe / Run:** never surface raw provider text; redact via `SENSITIVE_ENV_VALUE_PATTERNS`; bounded timeout + concurrency cap on the probe.

## 7. Security & governance
- **Shell-safety is mandatory** (`SAFE_MODEL_RE`) at resolution, before any spawn — closes the `shell:true`-on-Windows injection surface (`server-utils.ts:343`).
- **Probe abuse control:** per-company concurrency cap + timeout ceiling; reuse/extend existing RBAC.
- **Secret hygiene:** provider stdout/stderr and status `detail` redacted through value-pattern redaction (not just key-name); unit test asserts a planted `sk-...` is stripped.
- **RBAC + audit:** changes founder/team-lead-gated per existing agent-route authz; versioned via `agent_config_revisions`.
- **Auth boundary (documented):** provider logins are instance-level — the separately-installed CLIs' own logins (e.g. the shared ChatGPT Codex login, the Claude CLI login). The **only** per-scope override is a deliberate **per-agent** `adapterConfig.env.OPENAI_API_KEY`. The **company-level extraction/embedding `OPENAI_API_KEY` (Decision #91) is never used to run agents** — provider-switching MUST NOT read or depend on it (enforced by a test in Unit A). Phase 2 stores any user-entered keys in encrypted `company_secrets`, injected only at spawn.

## 8. Testing strategy (every type) — with the review's additions

| Type | Coverage |
|---|---|
| **Unit** | `resolveModel` all branches incl. **shell-unsafe hard-reject** and incompatible-correction; auth-mode parser (**managed home**, per-company-key override); family classifier incl. **opencode `openai/...` slash** + **gemini `auto`**; error→friendly mapper incl. **secret-redaction (`sk-...` stripped)**; provider-status parsers |
| **Service** | `agents.update`: cross-family `400`, shell-unsafe `400`, auth-mismatch `200+warnings`, compatible/unknown-safe allowed (mock-DB sequence pattern) |
| **Route-contract** | PATCH 400/200+warnings; **extended** test-environment probe shape (with `model`); RBAC (authorized vs forbidden); create + import paths honor the shared validator |
| **Schema-contract** | `updateAgentSchema`/`adapterConfig` refinement; probe + provider-status response shapes |
| **Migration-integration** | no DDL — assert "no schema change"; **but a backfill integration test** (seed bad `gpt-5.3-codex` row → boot ensure-* → assert corrected) |
| **Real-DB integration** | switch adapter+model via real route → persisted; assert the **resolved argv** via `onMeta.commandArgs` (no real spawn); **parity test**: crew `runner.ts` and Commander `cli-mode.ts` resolve the **same** model for the same config; **managed-home vs shared-home** auth-mode test (shared says chatgpt, per-company key forces apikey) |
| **e2e (Playwright)** | **CI lane (fake-crew + mocked probe):** change provider/model + save persists; cross-family `400` inline; auth-mismatch warning renders. **Soak lane (`AOA_E2E_REAL_PROVIDER`, live config):** probe ✓ for Claude/Codex. Gemini/OpenCode pending auth |
| **Visual** | config form: transparent default, disabled incompatible option, warning, probe ✓/✗ (Linux-gated) |
| **Probe robustness** | concurrency-cap / timeout test for the probe |

## 9. Decisions (resolved post-review)
- **Reuse `codex-model.ts`** (classifier, `SAFE_MODEL_RE`, `resolveCodexChatModel`) and **unify crew + Commander** on it — do not build a parallel resolver. (Supersedes v1's "omit `--model`, inherit config.toml": runtime resolution now *corrects* to the validated `gpt-5.5` default, which also self-heals stale rows.)
- **Validation tiers:** hard-block = cross-family **or** shell-unsafe; soft-warn = auth-mismatch; allow = compatible/unknown-**safe**.
- **Probe = extend the existing `test-environment` endpoint**, not a new one.
- **Backfill required** even though no DDL is.

## 10. Open decisions for the user
1. **Probe RBAC:** keep the existing `assertCanReadConfigurations` (consistent with the sibling endpoint) or tighten provider changes + probe to founder/team-lead only? (Recommend: keep existing for the probe; provider/model *changes* already follow agent-route authz.)
2. **Codex default presentation:** runtime resolves to `gpt-5.5` (validated). UI shows "Default → gpt-5.5 (your Codex config)". OK, or surface the raw config.toml value verbatim?

## 11. Phase 2 (out of scope, designed-for)
Providers page: detect→login→models flow; install guide; "Log in" surfacing the exact `codex login`/`claude /login` command (interactive OAuth completes in the user's terminal — not automatable); API-key entry into encrypted `company_secrets`, injected at spawn, founder-gated, never logged. Consumes Phase-1 provider-status + probe + validation directly.

## 12. Logistics
Branch `feat/provider-switching` (off `main`). writing-plans will sequence: Unit A → B (incl. source-default fix + backfill) → C → D, with E in parallel; each unit gets its full test slice and frequent commits. Live verification reuses the Docker UTF-8 Postgres + onboarded company from the investigation.
