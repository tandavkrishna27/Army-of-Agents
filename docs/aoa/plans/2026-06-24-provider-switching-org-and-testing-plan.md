# Provider Switching — Org Extension + Comprehensive Testing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend provider-switching runtime resolution to **org agents** (heartbeat path) + self-healing backfill, and build a durable 4-layer test suite (unit → integration → Playwright e2e → watched `/browse` walkthrough) covering crew + Commander + org for both providers.

**Architecture:** Reuse the shipped engine verbatim (`resolveModel` / `applyModelResolutionToConfig` / `getProviderStatus` / `realProviderStatusDeps`). The only new application point is `heartbeat.ts` (org runtime), ordered **after** the existing budget/recovery model swaps. A boot sweep heals org-codex rows. Tests layer up to a CI-gated Playwright suite plus a repeatable local watched walkthrough.

**Tech Stack:** TypeScript, Node, Express 5, Drizzle ORM, Vitest, Playwright, embedded-postgres (real-DB, `skipIf(win32)`), gstack `/browse`.

**Spec:** `docs/aoa/plans/2026-06-24-provider-switching-org-and-testing-design.md`

---

> **AMENDMENT (2026-06-24, post-review):** **Task 2 (Part A2 — the org-codex boot backfill
> `org-codex-backfill.ts` + its `index.ts` wiring) was REMOVED.** A Codex review (finding
> P2(b)) showed it mutates a founder-PINNED model based on a boot-time GUESS of a *runtime*
> property (auth mode): a company sharing an api-key `auth.json` — where `gpt-5.3-codex` is
> valid — had its pinned choice silently clobbered on every restart, and the sweep had no
> crew/Commander counterpart (parity break). The run-time seam (Task 1 / Part A1,
> `resolveRunScopedModel`) corrects at the only correct moment — run time, when the live auth
> mode is known — and is now the **sole** correction path; the persisted row is left exactly
> as the founder pinned it. Removed with Task 2: `org-codex-backfill.ts`, its unit test, and
> integration `case-1/1b/1c` + `case-3`. **Tasks 1, 3 (case-2/3a/3b/test-5), 4, 5 stand as
> shipped.** Honesty trail: `docs/aoa/evidence/ps-5b-org-runtime-correction.txt` §6.

---

## Hard rules (carry into every task)
- **Reuse only** — no new resolver. Import `applyModelResolutionToConfig` from `server/src/services/internal-agent/aoa-agents/runner-model-resolution.ts`, `getProviderStatus` + `type ProviderStatus` from `server/src/adapters/provider-status.ts`, `realProviderStatusDeps` from `server/src/adapters/provider-status-deps.ts`.
- **Edge #5** — in `heartbeat.ts`, resolution runs AFTER the cheap-model swaps (lines ~3544-3575) and BEFORE `resolveAdapterExecutionContext` (~3704) — not merely before `adapter.execute` (~3732) — since the context build also derives from `runScopedConfig`.
- **Best-effort detection** — a `getProviderStatus` throw falls back to `authMode: "unknown"`; never breaks a run. `ShellUnsafeModelError` from `applyModelResolutionToConfig` propagates to the existing run-failure path.
- **Never read the company extraction `OPENAI_API_KEY`** for switching; the env-strip is codex-only and only strips an INHERITED key.
- TDD: failing test → run (fail) → minimal impl → run (pass) → commit. DRY/YAGNI.
- Vitest: `pnpm --filter @armyofagents/server exec vitest run <path>`. e2e: `pnpm test:e2e` (CI Linux; Windows-skipped at config level).

## File-structure map
| File | Task | Responsibility |
|---|---|---|
| `server/src/services/heartbeat.ts` (modify ~3575) | 1 | apply resolution to `runScopedConfig` after budget swaps |
| `server/src/__tests__/heartbeat-provider-resolution.test.ts` (new) | 1 | unit: a pure ordering helper (resolve-after-swap) |
| `server/src/services/heartbeat-provider-resolution.ts` (new) | 1 | tiny pure seam: `resolveRunScopedModel(adapterType, runScopedConfig, status, opts)` wrapping `applyModelResolutionToConfig` (testable; documents edge #5) |
| `server/src/services/internal-agent/aoa-agents/org-codex-backfill.ts` (new) | 2 | boot sweep: org codex rows with incompatible models → `gpt-5.5` |
| `server/src/services/internal-agent/aoa-agents/__tests__/org-codex-backfill.test.ts` (new) | 2 | unit: predicate + sweep (mock-DB) |
| `server/src/index.ts` (modify ~703-769) | 2 | invoke the org sweep in the boot all-company startup loop |
| `server/src/__tests__/provider-switching.integration.test.ts` (modify) | 3 | org argv + org backfill + org-vs-crew parity (`skipIf(win32)`) |
| `tests/e2e/provider-switching.spec.ts` (rewrite) | 4 | real Playwright specs (UI/save-side) |
| `tests/e2e/helpers/seed-company.ts` (reuse) | 4 | existing cleanup/seed helper |
| `docs/aoa/plans/2026-06-24-provider-switching-watched-walkthrough.md` (new) | 5 | repeatable `/browse` walkthrough + evidence bundle |

---

## Task 1 — Heartbeat runtime resolution (Part A1)

**Files:** Create `server/src/services/heartbeat-provider-resolution.ts` + its test; Modify `heartbeat.ts`.

- [ ] **Step 1.1: Write the failing test** — `server/src/__tests__/heartbeat-provider-resolution.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { resolveRunScopedModel } from "../services/heartbeat-provider-resolution.js";

const chatgpt = { adapterType: "codex_local", installed: true, authenticated: true, authMode: "chatgpt" as const, defaultModelResolved: "gpt-5.5" };

describe("resolveRunScopedModel (heartbeat/org path)", () => {
  it("corrects an incompatible codex model on chatgpt to gpt-5.5", () => {
    const cfg = resolveRunScopedModel("codex_local", { model: "gpt-5.3-codex", env: {} }, chatgpt);
    expect(cfg.model).toBe("gpt-5.5");
  });
  it("EDGE #5: resolves the budget-SWAPPED model, not the original (operates on the passed config only)", () => {
    // caller passes the already-swapped runScopedConfig; helper resolves THAT
    const swapped = { model: "gpt-5.3-codex", env: {} }; // pretend a cheap-swap produced an incompatible id
    const cfg = resolveRunScopedModel("codex_local", swapped, chatgpt);
    expect(cfg.model).toBe("gpt-5.5");
  });
  it("strips an inherited company OPENAI_API_KEY (codex) the agent didn't set", () => {
    const cfg = resolveRunScopedModel("codex_local", { model: "gpt-5.5", env: {} }, chatgpt, { inheritedEnvOpenAiKey: "sk-company" });
    expect((cfg.env as Record<string, unknown>).OPENAI_API_KEY).toBeUndefined();
  });
});
```

- [ ] **Step 1.2: Run — expect FAIL** (`Cannot find module '../services/heartbeat-provider-resolution.js'`)

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/heartbeat-provider-resolution.test.ts`

- [ ] **Step 1.3: Implement the pure seam** — `server/src/services/heartbeat-provider-resolution.ts`

```ts
import { applyModelResolutionToConfig } from "./internal-agent/aoa-agents/runner-model-resolution.js";
import type { ResolveModelStatus } from "./internal-agent/model-resolution.js";

/**
 * Heartbeat/org-path model resolution. The CALLER must invoke this on the
 * already-budget-swapped runScopedConfig (edge #5) — this helper is pure and
 * only resolves the config it is handed. Reuses the exact crew helper so org
 * and crew resolution can never diverge.
 */
export function resolveRunScopedModel(
  adapterType: string,
  runScopedConfig: Record<string, unknown>,
  status: ResolveModelStatus,
  opts: { inheritedEnvOpenAiKey?: string | null } = {},
): Record<string, unknown> {
  return applyModelResolutionToConfig(adapterType, runScopedConfig, status, opts);
}
```

- [ ] **Step 1.4: Run — expect PASS** (3 tests). **Step 1.5: Commit**

```bash
git add server/src/services/heartbeat-provider-resolution.ts server/src/__tests__/heartbeat-provider-resolution.test.ts
git commit -m "feat(provider-switching): heartbeat resolution seam (org Part A1)"
```

- [ ] **Step 1.6: Wire into heartbeat.ts** — immediately AFTER the cheap-model fallback try/catch (closes ~line 3575) and BEFORE `resolveAdapterExecutionContext(runScopedConfig, adapter)` (~3704):

```ts
    // Provider-switching (org/heartbeat): resolve the model auth-aware + shell-safe,
    // and strip any inherited company OPENAI_API_KEY before spawn. Runs AFTER the
    // cheap-model swaps above (edge #5) so we resolve the model that will run.
    // Best-effort detection; a failure falls back to authMode "unknown".
    let providerStatus: ProviderStatus;
    try {
      providerStatus = await getProviderStatus(
        agent.adapterType,
        { companyId: agent.companyId, adapterConfig: runScopedConfig },
        realProviderStatusDeps,
      );
    } catch (statusErr) {
      logger.warn({ err: statusErr, runId: run.id }, "[heartbeat] provider status detection failed (best-effort fallback to unknown)");
      providerStatus = { adapterType: agent.adapterType, installed: true, authenticated: false, authMode: "unknown", defaultModelResolved: null };
    }
    runScopedConfig = resolveRunScopedModel(agent.adapterType, runScopedConfig, providerStatus, { inheritedEnvOpenAiKey: process.env.OPENAI_API_KEY ?? null });
```

Add imports at the top of `heartbeat.ts`:
```ts
import { getProviderStatus, type ProviderStatus } from "../adapters/provider-status.js";
import { realProviderStatusDeps } from "../adapters/provider-status-deps.js";
import { resolveRunScopedModel } from "./heartbeat-provider-resolution.js";
```
(Verify relative paths from `server/src/services/heartbeat.ts`: `../adapters/...` and `./heartbeat-provider-resolution.js`. Confirm `agent.adapterType` + `agent.companyId` exist on the heartbeat `agent` object — they do; used throughout this function. `ShellUnsafeModelError` from inside `resolveRunScopedModel` propagates to the existing run try/catch that records a failed run.)

- [ ] **Step 1.7: Run the heartbeat suite for no regression**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/heartbeat-runs-cancel-routes.test.ts src/__tests__/routes-instance-scheduler-heartbeats.test.ts`
Expected: PASS (call out any PRE-EXISTING `@modelcontextprotocol/sdk`/`adapter-acpx-local` failures as unrelated).

- [ ] **Step 1.8: Commit**

```bash
git add server/src/services/heartbeat.ts
git commit -m "feat(provider-switching): apply resolution at heartbeat choke point — org agents (Part A1)"
```

---

## Task 2 — Org-codex boot backfill sweep (Part A2)

**Files:** Create `org-codex-backfill.ts` + test; Modify `server/src/index.ts`.

- [ ] **Step 2.1: Write the failing test** — `server/src/services/internal-agent/aoa-agents/__tests__/org-codex-backfill.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { orgCodexRowNeedsBackfill } from "../org-codex-backfill.js";

describe("orgCodexRowNeedsBackfill", () => {
  it("flags an org codex row pinned to gpt-5.3-codex", () => {
    expect(orgCodexRowNeedsBackfill({ kind: "org", adapterType: "codex_local", adapterConfig: { model: "gpt-5.3-codex" } })).toBe(true);
  });
  it("leaves a compatible org codex row alone", () => {
    expect(orgCodexRowNeedsBackfill({ kind: "org", adapterType: "codex_local", adapterConfig: { model: "gpt-5.5" } })).toBe(false);
  });
  it("ignores crew (aoa) rows — those use the crew backfill", () => {
    expect(orgCodexRowNeedsBackfill({ kind: "aoa", adapterType: "codex_local", adapterConfig: { model: "gpt-5.3-codex" } })).toBe(false);
  });
  it("ignores non-codex org rows", () => {
    expect(orgCodexRowNeedsBackfill({ kind: "org", adapterType: "claude_local", adapterConfig: { model: "gpt-5.5" } })).toBe(false);
  });
  it("leaves an org codex row that set its OWN OPENAI_API_KEY (apikey mode — gpt-5.3-codex is valid)", () => {
    expect(orgCodexRowNeedsBackfill({ kind: "org", adapterType: "codex_local", adapterConfig: { model: "gpt-5.3-codex", env: { OPENAI_API_KEY: "sk-agent" } } })).toBe(false);
  });
});
```

- [ ] **Step 2.2: Run — expect FAIL.** `pnpm --filter @armyofagents/server exec vitest run src/services/internal-agent/aoa-agents/__tests__/org-codex-backfill.test.ts`

- [ ] **Step 2.3: Implement** — `server/src/services/internal-agent/aoa-agents/org-codex-backfill.ts`

```ts
import { eq, and } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents } from "@armyofagents/db";
import { isCodexCompatibleModel, DEFAULT_CODEX_CHAT_MODEL } from "../codex-model.js";

function hasPerAgentOpenAiKey(adapterConfig: Record<string, unknown> | null | undefined): boolean {
  const env = adapterConfig?.env as Record<string, unknown> | undefined;
  return typeof env?.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim().length > 0;
}

export function orgCodexRowNeedsBackfill(
  row: { kind?: string | null; adapterType?: string | null; adapterConfig?: Record<string, unknown> | null },
): boolean {
  if (row.kind !== "org" || row.adapterType !== "codex_local") return false;
  // P1 (Codex review): an org agent with its OWN api key validly runs an
  // api-key-only model (gpt-5.3-codex) in apikey mode — never rewrite it.
  if (hasPerAgentOpenAiKey(row.adapterConfig)) return false;
  const model = typeof row.adapterConfig?.model === "string" ? row.adapterConfig.model : "";
  return model.length > 0 && !isCodexCompatibleModel(model);
}

/** Boot sweep: heal org codex rows in a company whose model a ChatGPT login would reject. */
export async function backfillOrgCodexModels(db: Db, companyId: string): Promise<number> {
  // P1 (Codex review): filter in SQL by kind+adapterType (not select-all-then-filter).
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.kind, "org"), eq(agents.adapterType, "codex_local")));
  let fixed = 0;
  for (const row of rows) {
    if (!orgCodexRowNeedsBackfill(row as never)) continue;
    // P1 (Codex review): SHALLOW-merge — replace ONLY model, preserving the org
    // agent's env/cwd/promptTemplate/timeoutSec/etc. (mergeAdapterConfig is
    // crew-only and keeps only instructions* fields, dropping everything else).
    const existing = (row.adapterConfig as Record<string, unknown> | null) ?? {};
    const next = { ...existing, model: DEFAULT_CODEX_CHAT_MODEL };
    await db.update(agents).set({ adapterConfig: next }).where(and(eq(agents.id, row.id), eq(agents.companyId, companyId)));
    fixed += 1;
  }
  return fixed;
}
```
(Confirm `agents.kind`/`adapterType`/`adapterConfig`/`env` columns exist — they do. Do NOT use `mergeAdapterConfig` here.)

- [ ] **Step 2.4: Run — expect PASS (5 tests).**

- [ ] **Step 2.5: Wire into the BOOT all-company sweep** (P1, Codex review) — `server/src/index.ts`, inside the existing per-company startup loop (~line 703-769) that already runs `ensureCommandStaff`/`ensureAdjutant`/…/`ensureCommanderAgent`. Add `backfillOrgCodexModels(db, row.id)` to that `Promise.all` (best-effort `.catch`), mirroring the sibling ensures. Do NOT wire it in `companies.ts` (that path is create-only — existing companies would be missed). New companies get the safe create-default (`gpt-5.5`) already, so the boot sweep is the right and sufficient hook. Import `backfillOrgCodexModels` at the top of `server/src/index.ts` next to the existing `ensure-*` imports.

- [ ] **Step 2.6: Run bootstrap suites for no regression.**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/aoa-bootstrap-wiring.test.ts`
Expected: PASS. (If `index.ts` isn't unit-testable in isolation, rely on the Task 3 integration test seeding a bad org row + invoking `backfillOrgCodexModels(db, companyId)` directly.)

- [ ] **Step 2.7: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/org-codex-backfill.ts server/src/services/internal-agent/aoa-agents/__tests__/org-codex-backfill.test.ts server/src/index.ts
git commit -m "feat(provider-switching): org codex boot backfill sweep (Part A2)"
```

> **Note:** The env-strip / keyless-codex auth fix (originally Task 2B) has been split to a separate PR due to the multi-layer scope (`adapter-utils/server-utils.ts` spawn re-merge, remote keyless flow, probe alignment). It is tracked separately on `feat/provider-switching-env-strip`.

---

## Task 3 — Integration extensions (Layer 2, `skipIf(win32)`)

**Files:** Modify `server/src/__tests__/provider-switching.integration.test.ts`.

- [ ] **Step 3.1: Add org-path integration cases** (mirror the existing harness; the file already seeds a company + agents). Add inside the existing `describe.skipIf(process.platform === "win32")` block:
  1. **Org backfill:** seed a `kind:"org"` codex agent with `adapterConfig.model = "gpt-5.3-codex"`; call `backfillOrgCodexModels(db, companyId)`; re-read → `model === "gpt-5.5"`; assert `orgCodexRowNeedsBackfill` is now false (fixpoint).
  1b. **Backfill PRESERVES org config (Codex P2):** seed a `kind:"org"` codex agent with `adapterConfig = { model:"gpt-5.3-codex", env:{ FOO:"bar" }, cwd:"/x", promptTemplate:"p", timeoutSec: 30 }`; run the sweep; re-read → `model === "gpt-5.5"` AND `env.FOO === "bar"`, `cwd === "/x"`, `promptTemplate === "p"`, `timeoutSec === 30` all preserved (proves the shallow-merge, not `mergeAdapterConfig`).
  1c. **Skip per-agent-key org row (Codex P1):** seed `kind:"org"` codex `{ model:"gpt-5.3-codex", env:{ OPENAI_API_KEY:"sk-agent" } }`; run the sweep; re-read → `model` UNCHANGED (`gpt-5.3-codex`), fixed count 0.
  2. **Org runtime resolution parity:** for `{ authMode:"chatgpt", defaultModelResolved:"gpt-5.5" }`, assert `resolveRunScopedModel("codex_local", { model:"gpt-5.3-codex" }, status).model === "gpt-5.5"` — and equals the crew helper's output for the same input (parity).
  3. **Org NOT healed by crew backfill:** assert the crew `needsAdapterBackfill` path does not touch the org row (it's org-scoped), proving the two sweeps are distinct.
  4. **Heartbeat WIRING (no-spawn, Codex P2):** the unit test only proves the wrapper calls the helper; this proves `heartbeat.ts` actually invokes it in the correct order — AFTER cheap-swaps (~3575) and BEFORE `resolveAdapterExecutionContext` (~3704). Seed a `kind:"org"` codex agent with `model:"gpt-5.3-codex"`. Instrument/spy on BOTH `resolveAdapterExecutionContext` AND the adapter `execute` call (mirror the no-spawn pattern in `cli-mode-codex-integration.test.ts`). Assert: (a) the model passed to `resolveAdapterExecutionContext` is ALREADY `"gpt-5.5"` (not `"gpt-5.3-codex"`) — this is the critical edge-#5 gate; (b) the model passed to `execute` is also `"gpt-5.5"`. If both assertions pass, the ordering is proven. If a budget/recovery (cheap-model) scenario is feasible to seed, also seed it and assert the same (resolution after the swap, edge #5).

Use the existing seeding/`db.execute` pattern in the file. Each case is a `it(...)` with concrete inserts + asserts (no `it.skip`).

- [ ] **Step 3.2: Run — collects clean on win32 (skipped), passes on CI Linux.**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-switching.integration.test.ts`
Expected on Windows: `skipped` (NOT an import/collection error). Report the exact output.

- [ ] **Step 3.3: Commit** `test(provider-switching): org backfill + runtime parity integration (Layer 2)`

---

## Task 4 — Playwright e2e (Layer 3, CI Linux gate)

**Files:** Rewrite `tests/e2e/provider-switching.spec.ts` (currently a `test.skip` placeholder).

**Harness facts (from `tests/e2e/onboarding-thread-pipeline.spec.ts`):** `@playwright/test`; `cleanupTestCompanies(request, /^E2E-/)` in `beforeEach`; drive the wizard via `getByTestId("step1-next")`, `input[placeholder="Acme Corp"]`, `data-testid` selectors. The LLM round-trip is NOT interceptable (subprocess) — so assert **route/UI** behavior only. On CI there is no codex/claude login → `authMode` resolves "unknown" → `gpt-5.3-codex` deterministically corrects + warns (no mocking needed).

- [ ] **Step 4.1: Replace the placeholder with real specs.** Concrete spec set (each a `test(...)`, not `test.skip`):

```ts
import { test, expect } from "@playwright/test";
import { cleanupTestCompanies } from "./helpers/seed-company";

test.describe("provider-switching: agent config save-side", () => {
  test.beforeEach(async ({ request }) => { await cleanupTestCompanies(request, /^E2E-PS-/); });

  test("codex model picker defaults to gpt-5.5 and lists it", async ({ page, request }) => {
    // create an E2E-PS-* company via the existing onboarding helper / wizard,
    // open an agent config, select Codex adapter, open the model dropdown:
    //   await expect(page.getByRole("button", { name: "Default → gpt-5.5" })).toBeVisible();
    //   await expect(page.getByRole("button", { name: "gpt-5.5", exact: true })).toBeVisible();
  });

  test("saving codex gpt-5.3-codex surfaces a 'using gpt-5.5' warning", async ({ page }) => {
    // set the codex model to gpt-5.3-codex, Save → AgentSaveWarnings notice:
    //   await expect(page.getByRole("alert")).toContainText(/using gpt-5\.5/i);
  });

  test("cross-family (claude adapter + gpt model) is rejected", async ({ request }) => {
    // PATCH /agents/:id with adapterType claude_local + model gpt-5.5 → expect 400
  });

  test("shell-unsafe model is rejected", async ({ request }) => {
    // PATCH with model "gpt-5 && rm" → expect 400
  });

  test("test-connection button runs and renders a result", async ({ page }) => {
    // click "Test environment" → AdapterEnvironmentResult renders (pass OR fail — codex may be absent on CI)
    //   await expect(page.getByTestId("adapter-env-result")).toBeVisible({ timeout: 60_000 });
  });
});
```

**Concrete fill-in instructions (no invention required):**
- **Company creation:** copy the onboarding driving verbatim from `tests/e2e/onboarding-thread-pipeline.spec.ts` lines ~42-110 (lobby → wizard Steps 1-4 → company POSTs), swapping the name prefix to `E2E-PS-`. That leaves you on the company at `/{PREFIX}/...`.
- **Reach agent config:** navigate `/{PREFIX}/agents/all` → open an agent → `getByRole("tab", { name: "Config" }).click()` → `getByRole("button", { name: "Adapter" }).click()`. (These role/name selectors were verified live via `/browse` against this exact UI.)
- **Model picker:** the trigger is `page.getByRole("button", { name: "gpt-5.5" })` (current value); clicking it opens the dropdown with options `Default → gpt-5.5`, `gpt-5.3-codex`, etc. (verified live).
- **Save warning:** after selecting `gpt-5.3-codex` and clicking the top-right `Save`, assert `page.getByRole("alert")` contains `/using gpt-5\.5/i` (the `AgentSaveWarnings` component renders `role="alert"`).
- **Probe:** the button is `getByRole("button", { name: "Test environment" })`; the result region is the `AdapterEnvironmentResult` — assert it becomes visible (pass OR fail; codex may be absent on CI).
- **Cross-family / shell-unsafe (request-only, no UI):** `request.patch('/api/agents/{id}?companyId={cid}', { data: { adapterType: 'claude_local', adapterConfig: { model: 'gpt-5.5' } } })` → `expect(res.status()).toBe(400)`; same for `model: 'gpt-5 && rm'`. Get `{id, cid}` from the company-creation response.

- [ ] **Step 4.2: Run locally to confirm it COLLECTS** (Windows skips e2e at config level): `pnpm test:e2e -- --list` should enumerate the specs without error. On CI Linux the suite runs. Report the list output.

- [ ] **Step 4.3: Commit** `test(provider-switching): real Playwright e2e — save-side scenarios (Layer 3)`

---

## Task 5 — Watched `/browse` walkthrough (Layer 4, local, repeatable)

**Files:** Create `docs/aoa/plans/2026-06-24-provider-switching-watched-walkthrough.md` — a runnable procedure (sequence of `/browse` + `curl` commands) that drives the live app and captures evidence per scenario. (This is a procedure doc, not a Vitest test — it's the "watch it work" deliverable.)

- [ ] **Step 5.1: ChatGPT-codex setup block** — document + script the prereq:
```bash
# Stop any running instance; clear the per-company codex managed home so it re-copies the
# shared ChatGPT login; launch WITHOUT a stray OPENAI_API_KEY so prepareManagedCodexHome
# copies auth_mode:chatgpt (enabling the live correction):
rm -rf "$HOME/.codex/aoa-instances/<companyId>"        # reset managed home
# launch: AOA_HOME=C:\Users\TK\.aoa-ps  PORT=3100  (unset OPENAI_API_KEY)  pnpm aoa onboard --yes --run
```

- [ ] **Step 5.2: Scenario script** — for EACH matrix row, a concrete `/browse`/`curl` step + the evidence to capture (screenshot path + the run-record/log assertion). Cover, in order:
  1. Onboarding default `gpt-5.5` + picker `Default → gpt-5.5` (screenshot).
  2. Save cross-family → 400; shell-unsafe → 400 (curl PATCH, capture status).
  3. Save codex `gpt-5.3-codex` in **ChatGPT mode** → `AgentSaveWarnings` shows "using gpt-5.5" (screenshot).
  4. Test-connection probe → result (screenshot) + concurrency 429 (two concurrent curls).
  5. **Live correction:** a **crew** codex agent and an **org** codex agent set to `gpt-5.3-codex`, mentioned/triggered, observed `succeeded` with `gpt-5.5` (log: resolved model; run record: completed). The org one proves Part A.
  6. Live **claude** crew + Commander runs (reply captured).
  7. Unit E: break a run (e.g. shell-unsafe via a direct config write) → friendly surfaced reason in the log.
- Each step: `# scenario N` + the exact command(s) + `# EVIDENCE: /tmp/ps-N.png + log assertion`.

- [ ] **Step 5.3: Run the walkthrough once, attach the evidence bundle** (screenshots + key log lines) inline in the doc under each scenario. Commit the doc + evidence references.

```bash
git add docs/aoa/plans/2026-06-24-provider-switching-watched-walkthrough.md
git commit -m "docs/test(provider-switching): watched /browse walkthrough + evidence (Layer 4)"
```

---

## Task 6 — Full-suite green + self-review

- [ ] **Step 6.1:** `pnpm --filter @armyofagents/shared exec vitest run && pnpm --filter @armyofagents/server exec vitest run` — all provider-switching + new org suites green; classify any failures vs the `main` baseline (pre-existing: missing closed-source adapters / `@modelcontextprotocol/sdk`).
- [ ] **Step 6.2:** typecheck the touched packages (`pnpm --filter @armyofagents/server build` or `tsc --noEmit`) — no new type errors.
- [ ] **Step 6.3:** Re-read the spec §4 matrix; confirm each row maps to a passing test/scenario across the layers; confirm edge #5 ordering test + org backfill fixpoint + the company-key-never-leaks assertion all exist.
- [ ] **Step 6.4: Commit** any fixups. Then open a stacked PR (`feat/provider-switching-org → main`, noting it builds on #221).
