# Provider-Switching UI Reconnect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Commander and Crew provider+model picks (onboarding + Settings) actually take effect by writing the live `internal_agent_config` fields and re-ensuring the crew on change.

**Architecture:** `internal_agent_config` is the single source of truth — `cliTool`+`model` drive Commander chat, `provider`+`crewModel` drive the AoA crew. A shared `provider-mapping` module is the one place UI and server agree on provider↔cliTool↔adapter. A single `ensureAllCrewAgents` entrypoint (de-duped from boot/create) is re-run on a provider/crewModel change so existing crew rows migrate via the already-merged `shouldRewriteCrewAdapter`/`mergeCrewAdapterConfig`. The dead `companies.*_adapter_config` columns are deprecated in place.

**Tech Stack:** TypeScript (ESM), React + Vite, Express 5, Drizzle ORM (Postgres), Vitest, Playwright, pnpm workspaces.

**Spec:** `docs/aoa/plans/2026-06-28-provider-switching-ui-reconnect-design.md`

**Conventions for every task below:**
- Worktree root: `C:/Users/TK/.aoa/wt/ps-reconnect` (branch `feat/provider-ui-reconnect`).
- Server unit tests: `cd server && pnpm vitest run <path>`. Shared tests: `cd packages/shared && pnpm vitest run <path>`. UI tests: `cd ui && pnpm vitest run <path>`.
- Typecheck before each commit: `pnpm -w typecheck` (or `pnpm --filter <pkg> typecheck`).
- Stage ONLY the files listed per task. Never `git add -A`.

---

## Task 1: Shared provider-mapping module + `AGENT_PROVIDERS` += opencode

**Files:**
- Create: `packages/shared/src/provider-mapping.ts`
- Modify: `packages/shared/src/constants.ts:931`
- Modify: `packages/shared/src/index.ts` (export the new module)
- Test: `packages/shared/src/__tests__/provider-mapping.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/provider-mapping.test.ts
import { describe, it, expect } from "vitest";
import {
  CREW_PROVIDERS,
  COMMANDER_PROVIDERS,
  providerToCliTool,
  providerToCrewAdapter,
  cliToolToProvider,
} from "../provider-mapping.js";
import { AGENT_PROVIDERS } from "../constants.js";

describe("provider-mapping", () => {
  it("CREW_PROVIDERS has all four; COMMANDER_PROVIDERS is anthropic+openai only", () => {
    expect([...CREW_PROVIDERS]).toEqual(["anthropic", "openai", "google", "opencode"]);
    // cli-mode chat only supports claude_cli + codex (no gemini, no opencode path).
    expect([...COMMANDER_PROVIDERS]).toEqual(["anthropic", "openai"]);
    expect(COMMANDER_PROVIDERS).not.toContain("google");
    expect(COMMANDER_PROVIDERS).not.toContain("opencode");
  });

  it("providerToCliTool maps each commander provider to its CLI", () => {
    expect(providerToCliTool("anthropic")).toBe("claude_cli");
    expect(providerToCliTool("openai")).toBe("codex");
  });

  it("providerToCrewAdapter maps each crew provider to its adapter", () => {
    expect(providerToCrewAdapter("anthropic")).toBe("claude_local");
    expect(providerToCrewAdapter("openai")).toBe("codex_local");
    expect(providerToCrewAdapter("google")).toBe("gemini_local");
    expect(providerToCrewAdapter("opencode")).toBe("opencode_local");
  });

  it("cliToolToProvider inverts providerToCliTool (+ opencode legacy + default)", () => {
    expect(cliToolToProvider("claude_cli")).toBe("anthropic");
    expect(cliToolToProvider("codex")).toBe("openai");
    expect(cliToolToProvider("opencode")).toBe("opencode");
    expect(cliToolToProvider(null)).toBe("anthropic");
    expect(cliToolToProvider("weird")).toBe("anthropic");
  });

  it("AGENT_PROVIDERS now includes opencode", () => {
    expect([...AGENT_PROVIDERS]).toEqual(["anthropic", "openai", "google", "opencode"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm vitest run src/__tests__/provider-mapping.test.ts`
Expected: FAIL — cannot find module `../provider-mapping.js`.

- [ ] **Step 3: Create the mapping module**

```ts
// packages/shared/src/provider-mapping.ts
//
// Single source of truth for AoA internal-agent provider mappings. UI and server
// both import these so the provider↔cliTool↔adapter relationship can never drift.
//
// Two surfaces:
//   - Commander (chat): driven by internal_agent_config.cliTool. cli-mode.ts's
//     resolveCliInvocation only builds chat invocations for claude_cli + codex
//     (opencode → returns null + chat() rejects; gemini has no branch). So the
//     Commander picker is anthropic + openai ONLY.
//   - Crew (8 AoA agents): driven by internal_agent_config.provider → crew adapter.
//     resolveCrewAdapterFor (server) is the runtime authority; providerToCrewAdapter
//     is the lightweight label map and MUST agree with it (asserted in a server test).

export const CREW_PROVIDERS = ["anthropic", "openai", "google", "opencode"] as const;
export type CrewProvider = (typeof CREW_PROVIDERS)[number];

export const COMMANDER_PROVIDERS = ["anthropic", "openai"] as const;
export type CommanderProvider = (typeof COMMANDER_PROVIDERS)[number];

// cliTool column may still hold "opencode" on legacy rows; the type stays broad
// even though providerToCliTool only ever produces the two working values.
export type CliTool = "claude_cli" | "codex" | "opencode";
export type CrewAdapterType = "claude_local" | "codex_local" | "gemini_local" | "opencode_local";

/** provider → Commander cliTool (internal_agent_config.cliTool). */
export function providerToCliTool(p: CommanderProvider): "claude_cli" | "codex" {
  switch (p) {
    case "anthropic": return "claude_cli";
    case "openai": return "codex";
  }
}

/** provider → crew adapterType. Mirrors resolveCrewAdapterFor's adapter choice. */
export function providerToCrewAdapter(p: CrewProvider): CrewAdapterType {
  switch (p) {
    case "anthropic": return "claude_local";
    case "openai": return "codex_local";
    case "google": return "gemini_local";
    case "opencode": return "opencode_local";
  }
}

/** cliTool → crew-provider (inverse of providerToCliTool, used to resolve the
 *  COMMANDER agent row's adapter from its CLI — Task 5b). `opencode` is included
 *  for legacy rows; anything unknown/null defaults to anthropic (claude). */
export function cliToolToProvider(cliTool: string | null | undefined): CrewProvider {
  switch (cliTool) {
    case "codex": return "openai";
    case "opencode": return "opencode";
    case "claude_cli":
    default: return "anthropic";
  }
}
```

- [ ] **Step 4: Add opencode to `AGENT_PROVIDERS`**

In `packages/shared/src/constants.ts:931`, change:

```ts
export const AGENT_PROVIDERS = ["anthropic", "openai", "google"] as const;
```
to:
```ts
// NOTE: opencode is a first-class crew provider (resolveCrewAdapterFor handles it).
// AGENT_MODELS_BY_PROVIDER below is dead/unused (no live consumer) — do not extend it.
export const AGENT_PROVIDERS = ["anthropic", "openai", "google", "opencode"] as const;
```

- [ ] **Step 5: Export the module**

In `packages/shared/src/index.ts`, add alongside the other exports (near the `AGENT_PROVIDERS` export at ~line 217):

```ts
export {
  CREW_PROVIDERS,
  COMMANDER_PROVIDERS,
  providerToCliTool,
  providerToCrewAdapter,
  cliToolToProvider,
} from "./provider-mapping.js";
export type { CrewProvider, CommanderProvider, CliTool, CrewAdapterType } from "./provider-mapping.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/shared && pnpm vitest run src/__tests__/provider-mapping.test.ts`
Expected: PASS (4/4).

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @armyofagents/shared typecheck
git add packages/shared/src/provider-mapping.ts packages/shared/src/constants.ts packages/shared/src/index.ts packages/shared/src/__tests__/provider-mapping.test.ts
git commit -m "feat(provider-switching): shared provider-mapping module + opencode in AGENT_PROVIDERS"
```

> ⚠️ Adding opencode to `AGENT_PROVIDERS` widens `AGENT_MODELS_BY_PROVIDER`'s `Record<AgentProvider, …>` type — it will now error for a missing `opencode` key. `AGENT_MODELS_BY_PROVIDER` is dead/unused; change its type annotation to `Partial<Record<AgentProvider, …>>` in the same commit to satisfy the compiler without inventing model lists. Verify with the typecheck step.

---

## Task 2: Add `crewModel` column to `internal_agent_config`

**Files:**
- Modify: `packages/db/src/schema/internal_agent.ts:38`
- Generated: `packages/db/src/migrations/<NNNN>_*.sql` (via `pnpm db:generate`)

- [ ] **Step 1: Add the column**

In `packages/db/src/schema/internal_agent.ts`, immediately after the `model` column (line 38) and its `cheapModel` sibling, add:

```ts
    // Crew model override (provider-switching reconnect). When set + valid for the
    // company's `provider`, resolveCrewAdapterFor uses it instead of the per-provider
    // default. Validated per provider (codex-model.ts) — an invalid value falls back
    // to the default, never breaks a run.
    crewModel: text("crew_model"),
```

Also fix the now-false comment on the `provider` column (lines ~33-37). Replace the "Legacy API-mode settings (dormant … Not read by the dispatch path.)" block with:

```ts
    // Crew provider (provider-switching). READ by resolveCrewAdapterForCompany to
    // pick the crew CLI adapter (claude_local/codex_local/gemini_local/opencode_local).
    // This is the live source of truth for the AoA crew — NOT dormant.
    provider: text("provider").default("anthropic"), // 'anthropic'|'openai'|'google'|'opencode'
    model: text("model").default("claude-sonnet-4-6"), // Commander cli-mode model (codex --model)
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/src/migrations/<NNNN>_*.sql` containing
`ALTER TABLE "internal_agent_config" ADD COLUMN "crew_model" text;` and an updated snapshot.

- [ ] **Step 3: Verify the migration is additive-only**

Run: `git diff --stat packages/db/src/migrations`
Expected: one new `.sql` + one new meta snapshot + journal update. The `.sql` must contain ONLY the `ADD COLUMN "crew_model"` statement (no drops/renames). If it contains anything else, stop and investigate drift.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/internal_agent.ts packages/db/src/migrations
git commit -m "feat(provider-switching): add internal_agent_config.crew_model column"
```

---

## Task 3: Accept `opencode` provider + `crewModel` in both config validators

**Files:**
- Modify: `server/src/routes/internal-agent.ts:60-64` (route-local `updateConfigSchema`)
- Modify: `packages/shared/src/validators/internal-agent.ts:10-14` (shared schema)
- Test: `server/src/__tests__/internal-agent-config-validator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/internal-agent-config-validator.test.ts
import { describe, it, expect } from "vitest";
import { updateInternalAgentConfigSchema } from "@armyofagents/shared";

describe("updateInternalAgentConfigSchema", () => {
  it("accepts provider=opencode", () => {
    const r = updateInternalAgentConfigSchema.safeParse({ provider: "opencode" });
    expect(r.success).toBe(true);
  });
  it("accepts a crewModel string", () => {
    const r = updateInternalAgentConfigSchema.safeParse({ crewModel: "openai/gpt-5.2-codex" });
    expect(r.success).toBe(true);
  });
  it("accepts null crewModel (clear override)", () => {
    const r = updateInternalAgentConfigSchema.safeParse({ crewModel: null });
    expect(r.success).toBe(true);
  });
  it("rejects an unknown provider", () => {
    const r = updateInternalAgentConfigSchema.safeParse({ provider: "mistral" });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/internal-agent-config-validator.test.ts`
Expected: FAIL — `crewModel` accepted? No; `provider=opencode` rejected by current `z.enum(AGENT_PROVIDERS)` only after Task 1… Task 1 already added opencode to `AGENT_PROVIDERS`, so the shared schema accepts opencode; the `crewModel` cases FAIL (unknown key is stripped, not validated — assert presence instead). To make the crewModel assertion meaningful, change the test to assert the parsed output carries it (see Step 1 already uses `success`; add `expect(r.data?.crewModel)` below). Concretely the test fails because `crewModel` is unknown and the shared schema has no such key yet.

- [ ] **Step 3: Add `crewModel` to the shared schema**

In `packages/shared/src/validators/internal-agent.ts`, inside `updateInternalAgentConfigSchema` (after the `model` line ~13), add:

```ts
  crewModel: z.string().optional().nullable(),
```

(The `provider: z.enum(AGENT_PROVIDERS)` line already picks up `opencode` from Task 1.)

- [ ] **Step 4: Fix the route-local schema**

In `server/src/routes/internal-agent.ts`, replace the inline enum + add crewModel. Change lines 62-63:

```ts
  provider: z.enum(["anthropic", "openai", "google"]).optional(),
  model: z.string().optional(),
```
to:
```ts
  provider: z.enum(AGENT_PROVIDERS).optional(),
  model: z.string().optional(),
  crewModel: z.string().nullable().optional(),
```

Add the import at the top of the file (alongside the existing shared imports):

```ts
import { AGENT_PROVIDERS } from "@armyofagents/shared";
```

(If `@armyofagents/shared` is already imported, add `AGENT_PROVIDERS` to that import list instead of a new line.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && pnpm vitest run src/__tests__/internal-agent-config-validator.test.ts`
Expected: PASS (4/4).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @armyofagents/shared typecheck && pnpm --filter @armyofagents/server typecheck
git add server/src/routes/internal-agent.ts packages/shared/src/validators/internal-agent.ts server/src/__tests__/internal-agent-config-validator.test.ts
git commit -m "feat(provider-switching): validators accept opencode provider + crewModel"
```

---

## Task 4: `resolveCrewAdapterFor` model override + read `crewModel`

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts:31-100`
- Test: `server/src/__tests__/resolve-crew-adapter-model-override.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/resolve-crew-adapter-model-override.test.ts
import { describe, it, expect } from "vitest";
import { resolveCrewAdapterFor } from "../services/internal-agent/aoa-agents/resolve-crew-adapter.js";
import { DEFAULT_CODEX_CHAT_MODEL } from "../services/internal-agent/codex-model.js";

describe("resolveCrewAdapterFor model override", () => {
  it("applies a shell-safe claude override for anthropic", () => {
    expect(resolveCrewAdapterFor("anthropic", "claude-opus-4-1").adapterConfig.model).toBe("claude-opus-4-1");
  });
  it("falls back to the anthropic default for a shell-UNSAFE override", () => {
    expect(resolveCrewAdapterFor("anthropic", "evil; rm -rf").adapterConfig.model).toBe("claude-sonnet-4-5-20250929");
  });
  it("applies a codex-compatible override for openai", () => {
    expect(resolveCrewAdapterFor("openai", "gpt-5.5").adapterConfig.model).toBe("gpt-5.5");
  });
  it("rejects a codex-INCOMPATIBLE override → openai default", () => {
    // NOTE (review P0-3): isCodexCompatibleModel ACCEPTS gpt-4o (gpt-family, no
    // "codex"). Genuinely-incompatible = a *-codex id or a non-OpenAI family model.
    expect(resolveCrewAdapterFor("openai", "gpt-5.2-codex").adapterConfig.model).toBe(DEFAULT_CODEX_CHAT_MODEL);
    expect(resolveCrewAdapterFor("openai", "claude-sonnet-4-5").adapterConfig.model).toBe(DEFAULT_CODEX_CHAT_MODEL);
  });
  it("requires slash form for opencode override; bare → default", () => {
    expect(resolveCrewAdapterFor("opencode", "anthropic/claude-sonnet-4").adapterConfig.model).toBe("anthropic/claude-sonnet-4");
    expect(resolveCrewAdapterFor("opencode", "gpt-5.5").adapterConfig.model).toBe("openai/gpt-5.2-codex");
  });
  it("applies a shell-safe gemini override for google", () => {
    expect(resolveCrewAdapterFor("google", "gemini-2.0-flash").adapterConfig.model).toBe("gemini-2.0-flash");
  });
  it("no override → unchanged per-provider defaults", () => {
    expect(resolveCrewAdapterFor("anthropic").adapterConfig.model).toBe("claude-sonnet-4-5-20250929");
    expect(resolveCrewAdapterFor("google").adapterConfig.model).toBe("gemini-2.5-pro");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/resolve-crew-adapter-model-override.test.ts`
Expected: FAIL — `resolveCrewAdapterFor` ignores the 2nd argument (defaults applied always).

- [ ] **Step 3: Implement the override**

In `server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts`, update the import line (currently `import { DEFAULT_CODEX_CHAT_MODEL, isCodexCompatibleModel } from "../codex-model.js";`) to:

```ts
import { DEFAULT_CODEX_CHAT_MODEL, isCodexCompatibleModel, isShellSafeModel, SAFE_MODEL_RE } from "../codex-model.js";
```

Replace the body of `resolveCrewAdapterFor` (lines 30-86) with:

```ts
export function resolveCrewAdapterFor(
  provider: string | null | undefined,
  modelOverride?: string | null,
): CrewAdapter {
  const ov = modelOverride?.trim() || "";
  switch (provider) {
    case "anthropic":
      return {
        adapterType: "claude_local",
        adapterConfig: {
          model: SAFE_MODEL_RE.test(ov) ? ov : "claude-sonnet-4-5-20250929",
          dangerouslySkipPermissions: true,
        },
      };
    case "google":
      return {
        adapterType: "gemini_local",
        adapterConfig: {
          model: SAFE_MODEL_RE.test(ov) ? ov : "gemini-2.5-pro",
        },
      };
    case "opencode":
      return {
        adapterType: "opencode_local",
        adapterConfig: {
          // opencode ids are slash-format `provider/model`; require a slash so a
          // bare codex id can't reach opencode. isShellSafeModel validates each segment.
          model: ov.includes("/") && isShellSafeModel(ov) ? ov : "openai/gpt-5.2-codex",
        },
      };
    case "openai":
    default:
      return {
        adapterType: "codex_local",
        adapterConfig: {
          // codex models must pass isCodexCompatibleModel (rejects *-codex ids and
          // non-OpenAI-family models; gpt-4o IS accepted). At dispatch the value is
          // re-validated by resolveModel — see the note after this task.
          model: isCodexCompatibleModel(ov) ? ov : DEFAULT_CODEX_CHAT_MODEL,
          dangerouslyBypassApprovalsAndSandbox: true,
        },
      };
  }
}
```

> Preserve the existing block comments above each case (the `dangerouslySkipPermissions` / `dangerouslyBypassApprovalsAndSandbox` rationale). They explain WHY the flags exist and must not be deleted.

- [ ] **Step 4: Read `crewModel` in `resolveCrewAdapterForCompany`**

Replace the `resolveCrewAdapterForCompany` select (lines ~94-99) with:

```ts
  const rows = await db
    .select({ provider: internalAgentConfig.provider, crewModel: internalAgentConfig.crewModel })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);
  return resolveCrewAdapterFor(rows[0]?.provider, rows[0]?.crewModel);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && pnpm vitest run src/__tests__/resolve-crew-adapter-model-override.test.ts`
Expected: PASS (7/7).

- [ ] **Step 6: Run the existing resolve-crew-adapter suites (no regression)**

Run: `cd server && pnpm vitest run src/__tests__/resolve-crew-adapter.test.ts src/__tests__/resolve-crew-adapter-opencode.test.ts`
Expected: PASS (unchanged behavior with no override).

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @armyofagents/server typecheck
git add server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts server/src/__tests__/resolve-crew-adapter-model-override.test.ts
git commit -m "feat(provider-switching): resolveCrewAdapterFor honors a validated crew model override"
```

> **Note (review P1-2):** `resolveCrewAdapterFor`'s `adapterConfig.model` is the
> **seed-time** value. At crew dispatch it is re-resolved by
> `applyModelResolutionToConfig` → `resolveModel(adapterType, model, status)`
> (`server/src/services/internal-agent/aoa-agents/runner-model-resolution.ts`,
> `…/model-resolution.ts`) — the *final* authority. A valid override passes through
> unchanged (claude/gemini/opencode pass-through; codex apikey-mode constrains to
> OpenAI-family). This is not a conflict, but the runtime gate has the last word —
> do NOT add a second validation layer in `resolveCrewAdapterFor`. (Optional extra
> coverage: a unit test asserting `applyModelResolutionToConfig` preserves a valid
> override for `codex_local` subscription mode.)

---

## Task 4b: Make a model-only change actually rewrite the row (review P0)

> **Critical gap (confirmed by review):** `shouldRewriteCrewAdapter` returns
> `currentAdapterType !== targetAdapterType || needsAdapterBackfill(...)`. On a
> **model-only** change (same provider/cliTool → same adapter type), it delegates to
> `needsAdapterBackfill`, which for a healthy `claude_local` row checks only
> `dangerouslySkipPermissions` (not the model), and for `codex_local` checks model
> *compatibility* not *equality*. So the new model is **never written** to existing
> rows, and dispatch (`resolveModel`) reads the model off the stale row — it can't
> inject `crewModel`/`model`. Without this task, "honor model picks" only works on a
> brand-new company or a provider switch, NOT on "keep provider, change model".

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts` (`shouldRewriteCrewAdapter`)
- Modify call sites (pass the resolved target config): `ensure-commander.ts:144`,
  `seed-crew-agent.ts:216`, `ensure-extraction-agent.ts:88` (the 3 callers — the
  extraction one is the 7th caller the rest of the plan doesn't otherwise touch)
- Test: extend `server/src/__tests__/resolve-crew-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to server/src/__tests__/resolve-crew-adapter.test.ts
import { shouldRewriteCrewAdapter } from "../services/internal-agent/aoa-agents/resolve-crew-adapter.js";

describe("shouldRewriteCrewAdapter — same-adapter model drift", () => {
  it("rewrites when the model differs on the SAME adapter", () => {
    expect(shouldRewriteCrewAdapter(
      "claude_local", { model: "claude-sonnet-4-5-20250929", dangerouslySkipPermissions: true },
      "claude_local", { model: "claude-opus-4-1", dangerouslySkipPermissions: true },
    )).toBe(true);
  });
  it("does NOT rewrite when the model is identical and the row is healthy", () => {
    expect(shouldRewriteCrewAdapter(
      "claude_local", { model: "claude-opus-4-1", dangerouslySkipPermissions: true },
      "claude_local", { model: "claude-opus-4-1", dangerouslySkipPermissions: true },
    )).toBe(false);
  });
  it("still rewrites on an adapter-type switch (unchanged behavior)", () => {
    expect(shouldRewriteCrewAdapter(
      "claude_local", { model: "x" }, "codex_local", { model: "gpt-5.5" },
    )).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/resolve-crew-adapter.test.ts`
Expected: FAIL — the first case returns `false` (model ignored on same adapter), and
the signature doesn't yet accept a 4th `targetAdapterConfig` arg.

- [ ] **Step 3: Add same-adapter model drift to `shouldRewriteCrewAdapter`**

Replace the function (`resolve-crew-adapter.ts:206-214`) with:

```ts
export function shouldRewriteCrewAdapter(
  currentAdapterType: string | null | undefined,
  currentAdapterConfig: Record<string, unknown> | null | undefined,
  targetAdapterType: string,
  targetAdapterConfig: Record<string, unknown>,
  opts?: { isApiKeyAuth?: boolean },
): boolean {
  if (currentAdapterType !== targetAdapterType) return true;
  // Same adapter, but the resolved model changed (a model-only switch) — rewrite so
  // the new model lands. mergeCrewAdapterConfig's same-adapter branch overrides model.
  const cur = typeof currentAdapterConfig?.model === "string" ? currentAdapterConfig.model : "";
  const tgt = typeof targetAdapterConfig?.model === "string" ? targetAdapterConfig.model : "";
  if (tgt && tgt !== cur) return true;
  return needsAdapterBackfill(currentAdapterType, currentAdapterConfig, opts);
}
```

- [ ] **Step 4: Update all three call sites to pass the resolved target config**

Each caller already has the resolved adapter in scope — pass its `adapterConfig` as
the new 4th argument (BEFORE the `{ isApiKeyAuth }` opts):

- `ensure-commander.ts:144` →
  `shouldRewriteCrewAdapter(current.adapterType, cfg, crewAdapter.adapterType, crewAdapter.adapterConfig, { isApiKeyAuth })`
  (Task 5b later renames `crewAdapter` → `commanderAdapter`; keep them consistent.)
- `seed-crew-agent.ts:216` →
  `shouldRewriteCrewAdapter(current.adapterType, cfg, crewAdapter.adapterType, crewAdapter.adapterConfig, { isApiKeyAuth })`
- `ensure-extraction-agent.ts:88` →
  `shouldRewriteCrewAdapter(current.adapterType, cfg, crewAdapter.adapterType, crewAdapter.adapterConfig, { isApiKeyAuth })`

(Read each call site first to match the exact local variable names; the shape is
identical across all three.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/resolve-crew-adapter.test.ts src/__tests__/resolve-crew-adapter-opencode.test.ts src/__tests__/seed-crew-agent.test.ts src/__tests__/aoa-ensure-commander.test.ts src/__tests__/aoa-ensure-extraction-agent.test.ts`
Expected: PASS. (Existing `shouldRewriteCrewAdapter` callers/tests now pass the 4th
arg — update any test that calls it directly with the old 3/4-arg shape.)

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @armyofagents/server typecheck
git add server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts server/src/services/internal-agent/aoa-agents/ensure-commander.ts server/src/services/internal-agent/aoa-agents/seed-crew-agent.ts server/src/services/internal-agent/aoa-agents/ensure-extraction-agent.ts server/src/__tests__/resolve-crew-adapter.test.ts
git commit -m "fix(provider-switching): rewrite agent row on a same-adapter model-only change"
```

> **Integration coverage (add in Task 5/13 territory):** a real-DB test that sets
> `provider` once, then changes ONLY `crewModel` via the config PATCH, and asserts the
> crew rows' `adapterConfig.model` actually updated. This is the regression guard for
> this whole gap.

---

## Task 5: `ensureAllCrewAgents` helper + de-dupe boot/create

**Files:**
- Create: `server/src/services/internal-agent/aoa-agents/ensure-all-crew.ts`
- Modify: `server/src/index.ts:717-768` (boot loop — marketplace gate + `Promise.all`)
- Modify: `server/src/services/companies.ts:158-193` (create path — sequential awaits)
- Test: `server/src/__tests__/ensure-all-crew.test.ts`

> **Behavior change (review P1-3):** the boot loop currently runs the six ensures via
> `Promise.all` (parallel); `ensureAllCrewAgents` runs them **sequentially**. This is
> intentional (the helper comment explains: sequential prevents Engineer's
> Maker→Engineer rename racing the unique-name index), but it is a real change to
> boot semantics (slightly slower; different failure interleaving). Confirm this is
> acceptable — it is the safer ordering and the create path was already sequential.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/ensure-all-crew.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({ ensureCommanderAgent: vi.fn(async () => { calls.push("commander"); return "c"; }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-command-staff.js", () => ({ ensureCommandStaff: vi.fn(async () => { calls.push("staff"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-adjutant.js", () => ({ ensureAdjutant: vi.fn(async () => { calls.push("adjutant"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-scout.js", () => ({ ensureScout: vi.fn(async () => { calls.push("scout"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-engineer.js", () => ({ ensureEngineer: vi.fn(async () => { calls.push("engineer"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-chronicler.js", () => ({ ensureChronicler: vi.fn(async () => { calls.push("chronicler"); }) }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn() } }));

import { ensureAllCrewAgents } from "../services/internal-agent/aoa-agents/ensure-all-crew.js";

describe("ensureAllCrewAgents", () => {
  beforeEach(() => { calls.length = 0; });

  it("runs all six crew ensures", async () => {
    await ensureAllCrewAgents({} as any, "co-1");
    expect(calls.sort()).toEqual(["adjutant", "chronicler", "commander", "engineer", "scout", "staff"]);
  });

  it("one failing ensure does not abort the rest", async () => {
    const mod = await import("../services/internal-agent/aoa-agents/ensure-scout.js");
    (mod.ensureScout as any).mockRejectedValueOnce(new Error("boom"));
    await ensureAllCrewAgents({} as any, "co-1");
    // scout threw, but the other five still ran
    expect(calls).toContain("commander");
    expect(calls).toContain("engineer");
    expect(calls.length).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/ensure-all-crew.test.ts`
Expected: FAIL — cannot find `ensure-all-crew.js`.

- [ ] **Step 3: Create the helper**

```ts
// server/src/services/internal-agent/aoa-agents/ensure-all-crew.ts
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents } from "@armyofagents/db";
import { logger } from "../../../middleware/logger.js";
import { ensureCommanderAgent } from "./ensure-commander.js";
import { ensureCommandStaff } from "./ensure-command-staff.js";
import { ensureAdjutant } from "./ensure-adjutant.js";
import { ensureScout } from "./ensure-scout.js";
import { ensureEngineer } from "./ensure-engineer.js";
import { ensureChronicler } from "./ensure-chronicler.js";

/**
 * True when this company's AoA crew is governed by an installed marketplace
 * package (non-`@legacy` templateOrigin). When so, the legacy ensure-*
 * seeders must NOT run — the marketplace owns the crew. Mirrors the gate
 * previously inlined in index.ts (boot) and companies.ts (create).
 */
export async function isCrewMarketplaceManaged(db: Db, companyId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.kind, "aoa"),
          sql`${agents.templateOrigin} IS NOT NULL AND ${agents.templateOrigin} NOT LIKE '%@legacy'`,
        ),
      )
      .limit(1);
    return !!row;
  } catch (err) {
    logger.warn({ err, companyId }, "isCrewMarketplaceManaged check failed — defaulting to NOT managed");
    return false;
  }
}

/**
 * Idempotently (re-)seed the full AoA crew for a company. Sequential (not
 * Promise.all) so ensureEngineer's Maker→Engineer rename can never race the
 * other seeds on the unique name index. Each step is independently
 * error-tolerant — one failure must not abort the rest (matches boot/create).
 *
 * Re-running this after a provider/crewModel change migrates existing rows to
 * the newly-resolved adapter via shouldRewriteCrewAdapter + mergeCrewAdapterConfig
 * inside each ensure-*.
 *
 * Callers are responsible for the marketplace gate (isCrewMarketplaceManaged).
 */
export async function ensureAllCrewAgents(db: Db, companyId: string): Promise<void> {
  const steps: Array<readonly [string, () => Promise<unknown>]> = [
    ["commander", () => ensureCommanderAgent(db, companyId)],
    ["command staff", () => ensureCommandStaff(db, companyId)],
    ["adjutant", () => ensureAdjutant(db, companyId)],
    ["scout", () => ensureScout(db, companyId)],
    ["engineer", () => ensureEngineer(db, companyId)],
    ["chronicler", () => ensureChronicler(db, companyId)],
  ];
  for (const [label, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      logger.warn({ err, companyId }, `ensureAllCrewAgents: ${label} failed`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm vitest run src/__tests__/ensure-all-crew.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Refactor the boot loop** (`server/src/index.ts`)

Replace the marketplace-gate-and-`Promise.all` block (the `try { … marketplaceInstalled … } … if (marketplaceInstalled) { … continue; } await Promise.all([ ensureCommandStaff … ensureCommanderAgent … ]);` region, lines ~709-768) with:

```ts
        if (await isCrewMarketplaceManaged(db as any, row.id)) {
          logger.debug({ companyId: row.id }, "crew startup backfill: skipping — marketplace governs");
          continue;
        }
        await ensureAllCrewAgents(db as any, row.id);
```

Add the import near the other aoa-agents imports at the top of `index.ts`:

```ts
import { ensureAllCrewAgents, isCrewMarketplaceManaged } from "./services/internal-agent/aoa-agents/ensure-all-crew.js";
```

Remove the now-unused individual `ensureCommandStaff/ensureAdjutant/ensureChronicler/ensureScout/ensureEngineer/ensureCommanderAgent` imports from `index.ts` **only if** they are not referenced elsewhere in the file (search first: `grep -n "ensureCommandStaff\|ensureAdjutant\|ensureChronicler\|ensureScout\|ensureEngineer\|ensureCommanderAgent" server/src/index.ts`). Keep any that remain referenced.

- [ ] **Step 6: Refactor the create path** (`server/src/services/companies.ts`)

Replace the `if (!mktInstalled) { … six ensure calls … }` block (lines ~158-193) with:

```ts
        if (!mktInstalled) {
          await ensureInternalAgentConfig(db, company.id).catch((err: unknown) => {
            logger.warn({ err, companyId: company.id }, "internal_agent_config seeding failed");
          });
          await ensureAllCrewAgents(db, company.id);
        }
```

Add the import alongside the existing `ensureCommanderAgent` import in `companies.ts`:

```ts
import { ensureAllCrewAgents } from "./internal-agent/aoa-agents/ensure-all-crew.js";
```

Remove the now-unused `ensureCommandStaff/ensureAdjutant/ensureScout/ensureEngineer/ensureChronicler/ensureCommanderAgent` imports from `companies.ts` **only if** unreferenced elsewhere (grep first as in Step 5).

- [ ] **Step 7: Typecheck + run server build sanity + commit**

```bash
pnpm --filter @armyofagents/server typecheck
cd server && pnpm vitest run src/__tests__/ensure-all-crew.test.ts && cd ..
git add server/src/services/internal-agent/aoa-agents/ensure-all-crew.ts server/src/index.ts server/src/services/companies.ts server/src/__tests__/ensure-all-crew.test.ts
git commit -m "refactor(provider-switching): single ensureAllCrewAgents entrypoint; de-dupe boot/create"
```

---

## Task 5b: Commander agent-row adapter follows `cliTool` (not the crew provider)

> **From the design decision (§5.9):** Commander's autonomous (non-chat) runs must
> use Commander's CLI, not the crew CLI. `ensureCommanderAgent` currently seeds the
> Commander row from `resolveCrewAdapterForCompany` (crew `provider`). Switch it to a
> Commander-specific resolver keyed on `cliTool`+`model`.

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts`
- Modify: `server/src/services/internal-agent/aoa-agents/ensure-commander.ts:7,75,83-84,144-151`
- Test: `server/src/__tests__/resolve-commander-adapter.test.ts`
- Update: `server/src/__tests__/aoa-ensure-commander.test.ts` (mock the new resolver)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/resolve-commander-adapter.test.ts
import { describe, it, expect } from "vitest";
import { resolveCommanderAdapterFor } from "../services/internal-agent/aoa-agents/resolve-crew-adapter.js";

describe("resolveCommanderAdapterFor (keyed on cliTool, not provider)", () => {
  it("claude_cli / null → claude_local", () => {
    expect(resolveCommanderAdapterFor("claude_cli", null).adapterType).toBe("claude_local");
    expect(resolveCommanderAdapterFor(null, null).adapterType).toBe("claude_local");
  });
  it("codex → codex_local", () => {
    expect(resolveCommanderAdapterFor("codex", null).adapterType).toBe("codex_local");
  });
  it("honors a valid Commander model override per cliTool", () => {
    expect(resolveCommanderAdapterFor("codex", "gpt-5.5").adapterConfig.model).toBe("gpt-5.5");
    expect(resolveCommanderAdapterFor("claude_cli", "claude-opus-4-1").adapterConfig.model).toBe("claude-opus-4-1");
  });
  it("rejects a cliTool-incompatible model → per-CLI default", () => {
    // claude default model survives validation only on claude; on codex it's rejected.
    expect(resolveCommanderAdapterFor("codex", "claude-sonnet-4-6").adapterConfig.model).not.toBe("claude-sonnet-4-6");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/resolve-commander-adapter.test.ts`
Expected: FAIL — `resolveCommanderAdapterFor` not exported.

- [ ] **Step 3: Add the Commander resolvers**

In `server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts`, add the
shared import and the two functions (right after `resolveCrewAdapterForCompany`):

```ts
import { cliToolToProvider } from "@armyofagents/shared";

/**
 * Resolve the COMMANDER agent row's adapter from its cliTool + model — NOT the
 * crew provider. Reuses resolveCrewAdapterFor (so the per-adapter bypass flags and
 * model validation are identical to the crew), keyed on the Commander surface via
 * cliToolToProvider. So Commander's non-chat runs use the CLI the founder picked
 * for Commander, independent of the crew provider.
 */
export function resolveCommanderAdapterFor(
  cliTool: string | null | undefined,
  modelOverride?: string | null,
): CrewAdapter {
  return resolveCrewAdapterFor(cliToolToProvider(cliTool), modelOverride);
}

export async function resolveCommanderAdapterForCompany(db: Db, companyId: string): Promise<CrewAdapter> {
  const rows = await db
    .select({ cliTool: internalAgentConfig.cliTool, model: internalAgentConfig.model })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);
  return resolveCommanderAdapterFor(rows[0]?.cliTool, rows[0]?.model);
}
```

- [ ] **Step 4: Point `ensureCommanderAgent` at the Commander resolver**

In `server/src/services/internal-agent/aoa-agents/ensure-commander.ts`:
- Change the import (line ~7) from `resolveCrewAdapterForCompany` to
  `resolveCommanderAdapterForCompany` (keep `shouldRewriteCrewAdapter`,
  `mergeCrewAdapterConfig`).
- Line ~75: `const crewAdapter = await resolveCommanderAdapterForCompany(db, companyId);`
  (rename the local to `commanderAdapter` and update its uses at lines ~83-84 insert
  values and ~144-151 in the `shouldRewriteCrewAdapter`/`mergeCrewAdapterConfig`
  rewrite — the migration logic itself is unchanged).

- [ ] **Step 5: Update the existing ensure-commander test**

`server/src/__tests__/aoa-ensure-commander.test.ts` exercises `ensureCommanderAgent`.
If it mocks or asserts `resolveCrewAdapterForCompany`, switch that to
`resolveCommanderAdapterForCompany`. Read the file first; adjust the mock/import so
the Commander row resolves from `cliTool`. Add one assertion: a company with
`cliTool="claude_cli"` + `provider="openai"` seeds the Commander row as
`claude_local` (NOT codex_local) — proving Commander follows its CLI, not the crew.

- [ ] **Step 6: Run tests**

Run: `cd server && pnpm vitest run src/__tests__/resolve-commander-adapter.test.ts src/__tests__/aoa-ensure-commander.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @armyofagents/server typecheck
git add server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts server/src/services/internal-agent/aoa-agents/ensure-commander.ts server/src/__tests__/resolve-commander-adapter.test.ts server/src/__tests__/aoa-ensure-commander.test.ts
git commit -m "feat(provider-switching): Commander agent-row adapter follows cliTool, not crew provider"
```

---

## Task 6: Re-ensure agents on a config change (config PATCH)

> Fires on a crew change (provider/crewModel) **or** a Commander change
> (cliTool/model — Task 5b). `ensureAllCrewAgents` re-runs all six ensures; each
> migrates only its own row (no-op if its adapter already matches).

**Files:**
- Modify: `server/src/routes/internal-agent.ts:788-818` (the config PATCH handler)
- Test: `server/src/__tests__/internal-agent-config-reensure.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/internal-agent-config-reensure.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const ensureAll = vi.fn(async () => {});
const isManaged = vi.fn(async () => false);
vi.mock("../services/internal-agent/aoa-agents/ensure-all-crew.js", () => ({
  ensureAllCrewAgents: ensureAll,
  isCrewMarketplaceManaged: isManaged,
}));

import { maybeReensureAgentsOnConfigChange } from "../routes/internal-agent.js";

const base = { provider: "openai", crewModel: null, cliTool: "claude_cli", model: null } as const;

describe("maybeReensureAgentsOnConfigChange", () => {
  beforeEach(() => { ensureAll.mockClear(); isManaged.mockClear(); isManaged.mockResolvedValue(false); });

  it("re-ensures when crew provider changed", async () => {
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", { ...base, provider: "anthropic" }, { ...base, provider: "openai" });
    expect(ensureAll).toHaveBeenCalledWith({}, "co-1");
  });
  it("re-ensures when crewModel changed", async () => {
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base, crewModel: "gpt-5.5" });
    expect(ensureAll).toHaveBeenCalledTimes(1);
  });
  it("re-ensures when Commander cliTool changed", async () => {
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base, cliTool: "codex" });
    expect(ensureAll).toHaveBeenCalledTimes(1);
  });
  it("re-ensures when Commander model changed", async () => {
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base, model: "claude-opus-4-1" });
    expect(ensureAll).toHaveBeenCalledTimes(1);
  });
  it("does NOT re-ensure when nothing adapter-affecting changed", async () => {
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base });
    expect(ensureAll).not.toHaveBeenCalled();
  });
  it("skips when marketplace-managed", async () => {
    isManaged.mockResolvedValue(true);
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base, provider: "anthropic" });
    expect(ensureAll).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/internal-agent-config-reensure.test.ts`
Expected: FAIL — `maybeReensureAgentsOnConfigChange` is not exported.

- [ ] **Step 3: Add the exported helper + wire it into the PATCH handler**

In `server/src/routes/internal-agent.ts`, add this exported pure-ish helper near the top of the module (after imports, before the router factory). It is exported so it can be unit-tested directly:

```ts
import { ensureAllCrewAgents, isCrewMarketplaceManaged } from "../services/internal-agent/aoa-agents/ensure-all-crew.js";
import type { Db } from "@armyofagents/db";

interface AgentAdapterFields {
  provider: string | null;
  crewModel: string | null;
  cliTool: string | null;
  model: string | null;
}

/**
 * Re-seed the AoA agents after a config PATCH iff any adapter-affecting field
 * changed and they aren't marketplace-managed. Crew rows follow provider/crewModel;
 * the Commander row follows cliTool/model (Task 5b). Running the full
 * ensureAllCrewAgents on any change is safe — each ensure resolves from its own
 * inputs and shouldRewriteCrewAdapter is a no-op when the adapter already matches,
 * so a crew-only change leaves Commander untouched and vice-versa.
 */
export async function maybeReensureAgentsOnConfigChange(
  db: Db,
  companyId: string,
  before: AgentAdapterFields,
  after: AgentAdapterFields,
): Promise<void> {
  const changed =
    before.provider !== after.provider ||
    before.crewModel !== after.crewModel ||
    before.cliTool !== after.cliTool ||
    before.model !== after.model;
  if (!changed) return;
  if (await isCrewMarketplaceManaged(db, companyId)) return;
  await ensureAllCrewAgents(db, companyId);
}
```

Now modify the PATCH handler (lines ~806-816). Replace:

```ts
      const [updated] = await db
        .update(internalAgentConfig)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(internalAgentConfig.companyId, companyId))
        .returning();

      if (!updated) {
        throw notFound("Internal agent config not found");
      }

      res.json(updated);
```

with:

```ts
      // Read the adapter-affecting fields BEFORE the update so we can detect a change.
      const [prior] = await db
        .select({
          provider: internalAgentConfig.provider,
          crewModel: internalAgentConfig.crewModel,
          cliTool: internalAgentConfig.cliTool,
          model: internalAgentConfig.model,
        })
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, companyId))
        .limit(1);

      const [updated] = await db
        .update(internalAgentConfig)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(internalAgentConfig.companyId, companyId))
        .returning();

      if (!updated) {
        throw notFound("Internal agent config not found");
      }

      // Migrate existing agent rows to the newly-resolved adapter when an
      // adapter-affecting field changed (crew: provider/crewModel; Commander:
      // cliTool/model). No-op otherwise. Best-effort: a re-seed failure must not
      // fail the settings save.
      try {
        await maybeReensureAgentsOnConfigChange(
          db,
          companyId,
          { provider: prior?.provider ?? null, crewModel: prior?.crewModel ?? null, cliTool: prior?.cliTool ?? null, model: prior?.model ?? null },
          { provider: updated.provider ?? null, crewModel: updated.crewModel ?? null, cliTool: updated.cliTool ?? null, model: updated.model ?? null },
        );
      } catch (err) {
        logger.warn({ err, companyId }, "agent re-ensure after config PATCH failed");
      }

      res.json(updated);
```

Ensure `logger` is imported in this file (it is used elsewhere in routes; if not, add `import { logger } from "../middleware/logger.js";`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm vitest run src/__tests__/internal-agent-config-reensure.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Guard against schema drift (review P1) + run the contract test**

`validate()` does `req.body = schema.parse(req.body)` and Zod **strips unknown keys**,
and the PATCH uses the **route-local** `updateConfigSchema` (not the shared one). If
`provider:"opencode"`/`crewModel` aren't in that local schema they're silently dropped
and the handler returns 200 with no effect — the exact enum-fracture bug. Add an
assertion to `internal-agent-routes-contract.test.ts` (or a focused route test) that a
PATCH body `{ provider: "opencode", crewModel: "openai/gpt-5.2-codex" }` survives
parsing and is reflected in the returned row (proves the route-local schema accepts
both). Then run:

Run: `cd server && pnpm vitest run src/__tests__/internal-agent-routes-contract.test.ts src/__tests__/internal-agent-config-reensure.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @armyofagents/server typecheck
git add server/src/routes/internal-agent.ts server/src/__tests__/internal-agent-config-reensure.test.ts
git commit -m "feat(provider-switching): re-ensure agents when config PATCH changes provider/crewModel/cliTool/model"
```

---

## Task 7: `rateModelForCliTool` opencode case

**Files:**
- Modify: `server/src/services/internal-agent/run-cost.ts:32-43`
- Test: `server/src/__tests__/run-cost-rate-model.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/run-cost-rate-model.test.ts
import { describe, it, expect } from "vitest";
import { rateModelForCliTool } from "../services/internal-agent/run-cost.js";

describe("rateModelForCliTool", () => {
  it("opencode is priced as openai, not anthropic", () => {
    const r = rateModelForCliTool("opencode", null);
    expect(r.provider).toBe("openai");
  });
  it("codex stays openai", () => {
    expect(rateModelForCliTool("codex", null).provider).toBe("openai");
  });
  it("claude_cli stays anthropic and honors a configured model", () => {
    expect(rateModelForCliTool("claude_cli", "claude-opus-4-1")).toEqual({ provider: "anthropic", model: "claude-opus-4-1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/run-cost-rate-model.test.ts`
Expected: FAIL — opencode falls through `default` → provider `anthropic`.

- [ ] **Step 3: Add the opencode case**

In `server/src/services/internal-agent/run-cost.ts`, in `rateModelForCliTool`'s switch (line ~36), add a case before `claude_cli`. Use the SAME model string the `codex` case uses (`gpt-4.1`, line ~38) for parity — both are OpenAI-on-a-codex-CLI subscription runs and must price identically (review P2):

```ts
    case "opencode":
      return { provider: "openai", model: "gpt-4.1" };
```

> Defensive: opencode is no longer a Commander pick (Task 1/§D2), but a pre-existing
> persisted `cliTool="opencode"` row could still produce a costed run. Confirm
> `gpt-4.1` exists in `cost-model.ts`'s price table (the codex case already relies
> on it); otherwise the estimate falls through to a default rate.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm vitest run src/__tests__/run-cost-rate-model.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @armyofagents/server typecheck
git add server/src/services/internal-agent/run-cost.ts server/src/__tests__/run-cost-rate-model.test.ts
git commit -m "fix(provider-switching): price opencode Commander runs as openai, not anthropic"
```

---

## Task 8: Deprecate the dead `companies.*_adapter_config` columns (comments only)

**Files:**
- Modify: `packages/db/src/schema/companies.ts:24-45`

- [ ] **Step 1: Update the comments (no migration, no behavior change)**

In `packages/db/src/schema/companies.ts`, replace the comment block above `commanderAdapterConfig`/`crewAdapterConfig` (the lines that currently describe the "Task D6" reader, ~24-30) with:

```ts
    // @deprecated NEVER READ at runtime (the "Task D6" reader was never built).
    // Superseded by internal_agent_config.{cliTool,model,provider,crewModel}, which
    // is the live source of truth for Commander + crew. Kept (not dropped) for
    // rollback safety per AoA convention; onboarding no longer writes them.
    commanderAdapterConfig: jsonb("commander_adapter_config")
```

(Leave the column definitions, defaults, and the `crewAdapterConfig` jsonb exactly as they are — comment change only.)

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm --filter @armyofagents/db typecheck
git add packages/db/src/schema/companies.ts
git commit -m "docs(provider-switching): mark companies.*_adapter_config columns deprecated (never read)"
```

---

## Task 9: UI API read-type `AgentConfig` — `crewModel` for hydration

> **Review P0-4:** the UI READ interface is named **`AgentConfig`** (`ui/src/api/internal-agent.ts:36`),
> NOT `InternalAgentConfig` (which does not exist in that file). The WRITE path uses
> the shared `UpdateInternalAgentConfig` (gained `crewModel` in Task 3) — no UI write
> change needed. This task only adds `crewModel` to the READ type so Task 11's
> `useEffect` hydration (`config.crewModel`) typechecks.

**Files:**
- Modify: `ui/src/api/internal-agent.ts:36` (the `AgentConfig` response interface)
- Test: `ui/src/api/__tests__/agent-config-types.test.ts` (type-level)

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/api/__tests__/agent-config-types.test.ts
import { describe, it, expect } from "vitest";
import type { AgentConfig } from "../internal-agent";
import type { UpdateInternalAgentConfig } from "@armyofagents/shared";

describe("UI config types carry crewModel", () => {
  it("AgentConfig (read type) has provider + crewModel", () => {
    const c: Pick<AgentConfig, "provider" | "crewModel"> = { provider: "openai", crewModel: "gpt-5.5" };
    expect(c.provider).toBe("openai");
    expect(c.crewModel).toBe("gpt-5.5");
  });
  it("UpdateInternalAgentConfig (write type) accepts crewModel", () => {
    const u: UpdateInternalAgentConfig = { provider: "opencode", crewModel: "openai/gpt-5.2-codex" };
    expect(u.crewModel).toBe("openai/gpt-5.2-codex");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm vitest run src/api/__tests__/agent-config-types.test.ts`
Expected: FAIL — `AgentConfig` has no `crewModel` (compile error under vitest/tsc).

- [ ] **Step 3: Add `crewModel` to the `AgentConfig` interface**

In `ui/src/api/internal-agent.ts`, in the `AgentConfig` interface (line ~36; it
already has `provider: string | null` at ~39 and `cliTool: string | null` at ~41),
add:

```ts
  crewModel: string | null;
```

(`internalAgentApi.getConfig` returns `AgentConfig`, so Task 11's `config.crewModel`
hydration now typechecks. The write path's `UpdateInternalAgentConfig` already
carries `crewModel` from Task 3.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && pnpm vitest run src/api/__tests__/agent-config-types.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter ui typecheck
git add ui/src/api/internal-agent.ts ui/src/api/__tests__/agent-config-types.test.ts
git commit -m "feat(provider-switching): UI AgentConfig read-type carries crewModel"
```

---

## Task 10: Onboarding writes the live fields (and drops Google from Commander)

**Files:**
- Modify: `ui/src/components/OnboardingWizard.tsx:79-104, 444-475, 891-906`
- Modify: `ui/src/components/__tests__/OnboardingWizard.test.tsx:220-260`

- [ ] **Step 1: Update the onboarding test premise (failing)**

In `ui/src/components/__tests__/OnboardingWizard.test.tsx`, replace the existing
"POSTs /companies with both commanderAdapterConfig and crewAdapterConfig" test
(~lines 220-260) with one asserting the NEW behavior: create is called WITHOUT the
adapter-config keys, and a config PATCH carries the live fields. Use the existing
mock setup in the file; the new assertion body:

```ts
  it("writes live config (cliTool/provider/model/crewModel) via PATCH after create", async () => {
    // ... existing setup that drives the wizard to the Crew step and submits ...
    // create payload must NOT contain the dead adapter-config columns:
    const createPayload = createMock.mock.calls.at(-1)![1];
    expect(createPayload).not.toHaveProperty("commanderAdapterConfig");
    expect(createPayload).not.toHaveProperty("crewAdapterConfig");
    // a config PATCH carries the live fields (commander OpenAI → codex, crew Google → google):
    expect(updateConfigMock).toHaveBeenCalledWith(expect.any(String), {
      cliTool: "codex",
      model: "gpt-5.5",
      provider: "google",
      crewModel: "gemini-2.5-pro",
    });
  });
```

Add `internalAgentApi.updateConfig` to the component's mocked API surface (the test
file already mocks `companiesApi`; mock `internalAgentApi.updateConfig` the same way
and capture it as `updateConfigMock`). Drive step 3 with provider `openai` model
`gpt-5.5` and step 4 with provider `google` model `gemini-2.5-pro`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm vitest run src/components/__tests__/OnboardingWizard.test.tsx`
Expected: FAIL — wizard still POSTs adapter-config columns and never PATCHes config.

- [ ] **Step 3: Use the shared mapping + drop Google from the Commander picker**

In `ui/src/components/OnboardingWizard.tsx`:

Replace the local `Provider`/`PROVIDER_OPTIONS`/`PROVIDER_LABELS`/`providerToAdapter`
block (lines ~79-104) with imports from shared + a label map for the crew set:

```ts
import {
  CREW_PROVIDERS,
  COMMANDER_PROVIDERS,
  providerToCliTool,
  providerToCrewAdapter,
} from "@armyofagents/shared";
import type { CrewProvider, CommanderProvider } from "@armyofagents/shared";

type Provider = CrewProvider; // crew supports all four; commander is a subset
const PROVIDER_LABELS: Record<CrewProvider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (Codex)",
  google: "Google (Gemini)",
  opencode: "OpenCode (multi-provider)",
};
```

`providerToCrewAdapter` replaces the deleted local `providerToAdapter` everywhere
it was used in this file (the step-5 agent default still uses `crewProvider`
mapping — keep that call, just point it at `providerToCrewAdapter`).

In the Commander picker (step 3, line ~901) change the option source from
`PROVIDER_OPTIONS` to `COMMANDER_PROVIDERS`:

```tsx
                      {COMMANDER_PROVIDERS.map((p) => (
                        <option key={p} value={p}>
                          {PROVIDER_LABELS[p]}
                        </option>
                      ))}
```

In the Crew picker (step 4) use `CREW_PROVIDERS` as the option source (same `.map`
shape, all four).

> **Preserve the existing `data-testid`s** when rewriting the pickers — the e2e spec
> (Task 13) and existing tests depend on `commander-provider`, `crew-provider`,
> `commander-model`, `crew-model`, and the step Next buttons (`step3-next` /
> `step4-next` per `OnboardingWizard.tsx`). Change only the option source, not the
> test hooks.

- [ ] **Step 3b: Relax the model-required gate (review P1-4)**

The wizard currently blocks advancing without a model: `handleStep3Next` returns
early on `!commanderModel` (`OnboardingWizard.tsx:447-449`), `handleStep4Next` on
`!crewModel` (`:457`), and the Next buttons are `disabled` without a model
(`:~1579`, `:~1595`). Since the model is now genuinely optional (blank → provider
default via `crewModel.trim() || null`), relax these: drop the `!commanderModel` /
`!crewModel` conditions from both `handleStepNNext` early-returns AND from the
Next-button `disabled` expressions (keep the provider-required checks). This makes
the `|| null` real instead of dead. Update the placeholder text to read
"optional — leave blank for the provider default".

- [ ] **Step 4: PATCH the live fields after create; stop writing dead columns**

In `handleStep4Next` (lines ~452-475), change the `companiesApi.create` call to drop
the adapter-config keys, then add a config PATCH:

```ts
      const company = await companiesApi.create({
        name: companyName.trim(),
      });
      setCreatedCompanyId(company.id);
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

      // Provider-switching: write the LIVE internal_agent_config fields. Commander
      // (cliTool+model) is anthropic|openai only (no google/opencode chat path);
      // crew (provider+crewModel) supports all four. The server re-ensures the crew
      // to the chosen adapter when provider changes from the seeded default.
      await internalAgentApi.updateConfig(company.id, {
        cliTool: providerToCliTool(commanderProvider as CommanderProvider),
        model: commanderModel.trim() || null,
        provider: crewProvider as Provider,
        crewModel: crewModel.trim() || null,
      });
```

Add `import { internalAgentApi } from "@/api/internal-agent";` if not already present.

> The Commander picker only offers `COMMANDER_PROVIDERS` (no google), so
> `commanderProvider` is never `"google"` at this point; the `Exclude<…,"google">`
> cast documents that invariant for `providerToCliTool`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && pnpm vitest run src/components/__tests__/OnboardingWizard.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter ui typecheck
git add ui/src/components/OnboardingWizard.tsx ui/src/components/__tests__/OnboardingWizard.test.tsx
git commit -m "feat(provider-switching): onboarding writes live config; Commander picker drops Google"
```

---

## Task 11: Settings — Crew provider + model controls (and Commander model)

**Files:**
- Modify: `ui/src/components/settings/sections/CommanderSection.tsx:158-340, 691-861`
- Test: `ui/src/components/settings/sections/__tests__/CommanderSection.execution.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/components/settings/sections/__tests__/CommanderSection.execution.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
// Reuse the project's standard test providers (QueryClient + CompanyContext).
// Mock internalAgentApi.updateConfig and getConfig.
import { internalAgentApi } from "@/api/internal-agent";
import { CommanderSection } from "../CommanderSection";
import { renderWithProviders } from "@/test/render"; // existing helper

vi.mock("@/api/internal-agent", async (orig) => {
  const mod = await (orig as any)();
  return {
    ...mod,
    internalAgentApi: {
      ...mod.internalAgentApi,
      getConfig: vi.fn(async () => ({
        cliTool: "claude_cli", provider: "anthropic", model: null, crewModel: null,
        enabledCapabilities: [], notificationPreference: "realtime", contextTokenBudget: 8000,
        budgetMonthlyCents: 5000, spentMonthlyCents: 0, proactiveIntervalMinutes: 240,
        runtimeApprovalsEnabled: true, runtimeAllowAlwaysEnabled: true, vendorCliBypassEnabled: true,
      })),
      updateConfig: vi.fn(async () => ({})),
    },
  };
});

describe("CommanderSection execution tab — crew provider", () => {
  it("saves provider + crewModel when the crew control changes", async () => {
    renderWithProviders(<CommanderSection />);
    await screen.findByLabelText(/crew provider/i);
    fireEvent.change(screen.getByLabelText(/crew provider/i), { target: { value: "openai" } });
    fireEvent.change(screen.getByLabelText(/crew model/i), { target: { value: "gpt-5.5" } });
    fireEvent.click(screen.getAllByRole("button", { name: /save/i })[0]);
    await waitFor(() =>
      expect(internalAgentApi.updateConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        provider: "openai", crewModel: "gpt-5.5",
      })),
    );
  });
});
```

> If the repo has no `@/test/render` helper, follow the pattern in an existing
> `CommanderSection` test (the file's sibling tests already wrap in
> `QueryClientProvider` + `CompanyContext`); reuse that exact wrapper.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm vitest run src/components/settings/sections/__tests__/CommanderSection.execution.test.tsx`
Expected: FAIL — no "Crew provider" control exists.

- [ ] **Step 3: Add crew + commander-model state and extend the save**

In `CommanderSection.tsx`, add state (near the `cliTool` state, line ~158):

```tsx
  const [commanderModel, setCommanderModel] = useState<string>("");
  const [crewProvider, setCrewProvider] = useState<string>("anthropic");
  const [crewModel, setCrewModel] = useState<string>("");
```

Hydrate them in the `useEffect` that syncs from `config` (line ~294):

```tsx
    setCommanderModel(config.model ?? "");
    if (config.provider) setCrewProvider(config.provider);
    setCrewModel(config.crewModel ?? "");
```

Extend `saveExecution` (line ~332):

```tsx
  function saveExecution() {
    saveMutation.mutate({
      executionMode: "cli",
      cliTool,
      model: commanderModel.trim() || null,
      provider: crewProvider as "anthropic" | "openai" | "google" | "opencode",
      crewModel: crewModel.trim() || null,
      runtimeApprovalsEnabled,
      runtimeAllowAlwaysEnabled,
      vendorCliBypassEnabled,
    });
  }
```

- [ ] **Step 4: Render the controls in the Execution tab**

Pass the new state into `ExecutionTabContent` (the `{active === "execution" && (<ExecutionTabContent … />)}` block, line ~433) and add the props to its interface + signature (lines ~691-723). Then, inside `ExecutionTabContent`'s JSX, after the existing "CLI Tool" `<div>` (line ~751), add a Commander-model field and a Crew block:

```tsx
      {/* Commander model (optional) */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block" htmlFor="commander-model">
          Commander model (optional)
        </label>
        <input
          id="commander-model"
          className="w-full max-w-xs rounded-md border border-border bg-transparent px-3 py-2 text-sm"
          placeholder="leave blank for the CLI default"
          value={commanderModel}
          onChange={(e) => setCommanderModel(e.target.value)}
        />
      </div>

      {/* Crew (the 8 AoA agents) */}
      <div className="rounded-md border border-border p-3 space-y-3 max-w-xl">
        <p className="text-xs font-medium text-muted-foreground">AoA Crew</p>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block" htmlFor="crew-provider">
            Crew provider
          </label>
          <Select value={crewProvider} onValueChange={setCrewProvider}>
            <SelectTrigger id="crew-provider" aria-label="Crew provider" className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CREW_PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>{CREW_PROVIDER_LABELS[p]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block" htmlFor="crew-model">
            Crew model (optional)
          </label>
          <input
            id="crew-model"
            aria-label="Crew model"
            className="w-full max-w-xs rounded-md border border-border bg-transparent px-3 py-2 text-sm"
            placeholder="leave blank for the provider default"
            value={crewModel}
            onChange={(e) => setCrewModel(e.target.value)}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Governs the AoA crew agents <strong>and Commander's autonomous (non-chat)
          runs</strong>. Changing the provider re-provisions the crew on the new CLI
          and <strong>discards per-agent crew model/extraArgs customization</strong>.
          Google/Gemini and OpenCode are crew-only (Commander chat supports only
          Claude and Codex).
        </p>
      </div>
```

Add imports + a label map at the top of `CommanderSection.tsx`:

```tsx
import { CREW_PROVIDERS } from "@armyofagents/shared";
const CREW_PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (Codex)",
  google: "Google (Gemini)",
  opencode: "OpenCode",
};
```

Wire the new props through `ExecutionTabContentProps` (add `commanderModel`,
`setCommanderModel`, `crewProvider`, `setCrewProvider`, `crewModel`, `setCrewModel`)
and the call site.

- [ ] **Step 4b: Filter `opencode` out of the existing CLI Tool select (review P0)**

The existing "CLI Tool" `<Select>` in `ExecutionTabContent` maps over `CLI_TOOLS`
(claude_cli / codex / opencode). opencode-as-Commander chat is unimplemented
(`cli-mode.ts` `chat()` rejects it), so stop offering it. Change the option source:

```tsx
            {CLI_TOOLS.filter((t) => t.value !== "opencode").map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
```

(Leave `CLI_TOOLS` itself unchanged — it's exported and may be referenced elsewhere;
this only narrows the Commander picker.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && pnpm vitest run src/components/settings/sections/__tests__/CommanderSection.execution.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the existing CommanderSection suite (no regression)**

Run: `cd ui && pnpm vitest run src/components/settings/sections`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter ui typecheck
git add ui/src/components/settings/sections/CommanderSection.tsx ui/src/components/settings/sections/__tests__/CommanderSection.execution.test.tsx
git commit -m "feat(provider-switching): Settings crew provider+model controls + Commander model"
```

---

## Task 12: Commander model on claude_cli (`cli-mode.ts`) — RISKIEST, do last

> **Review P0/P1 corrections:** the per-CLI arg builder is **`resolveCliInvocation`**
> (`cli-mode.ts:368`), NOT `translateCliInvocation` (which does not exist).
> `config.model` is **NOT in scope** inside it — its params are
> `(cliTool, params, safeContent, resumeCodexSessionId?, systemSplitArgs?,
> vendorCliBypassEnabled?, codexModel?, rawContent?)` and the claude call site
> (`cli-mode.ts:~714`) passes `undefined` for the model. So we must **add a new
> parameter** and thread `config.model` from `chat()`. **opencode is OUT of scope:**
> `resolveCliInvocation`'s `default:` returns `null` (`cli-mode.ts:513-516`) and
> `chat()` rejects opencode — there is no opencode arg array to splice into.
>
> The `claude_cli` branch is marked "BYTE-UNCHANGED": only ADD `--model` when the
> model is set AND shell-safe; when empty, emitted argv is byte-identical to today.
> Deferrable without affecting Tasks 1-11 (codex Commander model already honors
> `config.model` via `runCodexTurn`).

**Files:**
- Modify: `server/src/services/internal-agent/cli-mode.ts` (add helper; add a
  `commanderModel?` param to `resolveCliInvocation` ~line 368; thread it from
  `chat()` ~line 699-716; splice into the systemSplit `:431` and plain `:449`
  claude arg arrays)
- Test: `server/src/__tests__/cli-mode-commander-model.test.ts`

- [ ] **Step 1: Write the failing test (pure arg-builder helper)**

```ts
// server/src/__tests__/cli-mode-commander-model.test.ts
import { describe, it, expect } from "vitest";
import { claudeModelArgs } from "../services/internal-agent/cli-mode.js";

describe("claudeModelArgs (Commander model on claude_cli)", () => {
  it("empty/undefined model → no args (byte-identical default path)", () => {
    expect(claudeModelArgs(null)).toEqual([]);
    expect(claudeModelArgs("")).toEqual([]);
    expect(claudeModelArgs(undefined)).toEqual([]);
  });
  it("shell-safe model → --model <model>", () => {
    expect(claudeModelArgs("claude-opus-4-1")).toEqual(["--model", "claude-opus-4-1"]);
  });
  it("shell-UNSAFE model → no args (never interpolate unsafe input)", () => {
    expect(claudeModelArgs("evil; rm -rf")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/cli-mode-commander-model.test.ts`
Expected: FAIL — `claudeModelArgs` not exported.

- [ ] **Step 3: Add the helper**

At the top of `cli-mode.ts`, extend the existing codex-model import (line ~20) and
add the helper:

```ts
import { resolveCodexChatModel, SAFE_MODEL_RE } from "./codex-model.js";

/** claude CLI: pass --model only for a shell-safe non-empty model; else nothing,
 *  so the default path's argv stays byte-identical. */
export function claudeModelArgs(model: string | null | undefined): string[] {
  const m = model?.trim() ?? "";
  return m && SAFE_MODEL_RE.test(m) ? ["--model", m] : [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm vitest run src/__tests__/cli-mode-commander-model.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Thread the model into `resolveCliInvocation` and splice it**

1. Add a parameter to `resolveCliInvocation` (after `codexModel`, before
   `rawContent` — keep existing call sites compiling by giving it a default):
   `commanderModel?: string | null,`
2. At the `chat()` claude call site (the `resolveCliInvocation(...)` call around
   `cli-mode.ts:699-716` that currently passes `undefined` for `codexModel`), pass
   `config.model` for the new `commanderModel` argument.
3. In **both** claude arg arrays — the systemSplit path (~`:431`) and the plain path
   (~`:449`) — splice `...claudeModelArgs(commanderModel)` immediately before
   `...claudeBypassArgs`:

```tsx
          args: [
            "--mcp-config", configPath,
            "--system-prompt-file", safeSystemPromptPath,
            ...claudeModelArgs(commanderModel),
            ...claudeBypassArgs,
            "--print",
            "--output-format", "stream-json",
            "--include-partial-messages",
            "--verbose",
          ],
```

Do **not** touch the codex or `default:` (opencode→null) branches.

- [ ] **Step 6: Run the cli-mode suite (no regression on the byte-sensitive path)**

Run: `cd server && pnpm vitest run src/__tests__ -t "cli-mode"`
Expected: PASS. Confirm any test asserting the claude default argv is unchanged for
the empty-model case (the splice yields `[]` when `commanderModel` is null/empty).

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @armyofagents/server typecheck
git add server/src/services/internal-agent/cli-mode.ts server/src/__tests__/cli-mode-commander-model.test.ts
git commit -m "feat(provider-switching): honor Commander model on claude_cli (shell-safe --model)"
```

---

## Task 13: e2e — provider switch takes effect through the UI

**Files:**
- Modify: `tests/e2e/provider-switching.spec.ts`

- [ ] **Step 1: Refactor `seedCompanyViaWizard` to accept options (back-compat)**

The real helper is `seedCompanyViaWizard(page, request)` (`provider-switching.spec.ts:31`),
returning `{ companyId, issuePrefix, companyName }`, with **hardcoded** picks
(commander `selectOption({value:"anthropic"})` ~`:72`, crew
`selectOption({value:"openai"})` ~`:80`). Change its signature to:

```ts
async function seedCompanyViaWizard(
  page: Page,
  request: APIRequestContext,
  opts: { commanderProvider?: string; commanderModel?: string; crewProvider?: string; crewModel?: string } = {},
): Promise<{ companyId: string; issuePrefix: string; companyName: string }> {
  const commanderProvider = opts.commanderProvider ?? "anthropic";
  const crewProvider = opts.crewProvider ?? "openai";
  // ... drive wizard, using these for the step-3/step-4 selectOption calls,
  //     and opts.commanderModel/opts.crewModel for the model inputs (default "").
}
```

Defaults preserve the current behavior so the **existing 5 tests keep passing**
unchanged. Use the preserved `data-testid`s (`commander-provider`, `crew-provider`,
`commander-model`, `crew-model`) from Task 10's Step-3 preservation note.

- [ ] **Step 2: Add the two new helpers**

`getAoaCrew` hits the **existing** endpoint `GET /api/companies/:id/agents?kind=aoa`
(`routes/agents.ts:663`; `svc.list({kind:"aoa"})` returns full rows incl.
`adapterType`; in `local_trusted` the e2e runs as the `board` actor so rows are
unredacted):

```ts
async function getAoaCrew(request: APIRequestContext, companyId: string): Promise<Array<{ adapterType: string }>> {
  const res = await request.get(`/api/companies/${companyId}/agents?kind=aoa`);
  expect(res.ok()).toBe(true);
  return (await res.json()).agents ?? (await res.json());
}

async function openCommanderExecutionTab(page: Page, companyPrefix: string): Promise<void> {
  await page.goto(`/${companyPrefix}/settings/commander`);
  // the Execution & Model sub-tab is the default; ensure the crew control is visible
  await page.getByLabel(/crew provider/i).waitFor();
}
```

(Confirm the Settings→Commander route + sub-tab path against `CommanderSection`/
router; adjust the `goto` URL to the real path. `getAoaCrew`'s JSON shape — `{agents:[…]}`
vs a bare array — must match `routes/agents.ts`'s list response; read it and pin one.)

- [ ] **Step 3: Add the two assertions**

```ts
test("onboarding as OpenAI crew → crew agents are codex_local", async ({ page, request }) => {
  const { companyId } = await seedCompanyViaWizard(page, request, {
    commanderProvider: "anthropic", crewProvider: "openai",
  });
  const crew = await getAoaCrew(request, companyId);
  expect(crew.length).toBeGreaterThan(0);
  expect(crew.every((a) => a.adapterType === "codex_local")).toBe(true);
});

test("Settings crew provider change re-ensures the crew", async ({ page, request }) => {
  const { companyId, issuePrefix } = await seedCompanyViaWizard(page, request, {
    commanderProvider: "anthropic", crewProvider: "anthropic",
  });
  await openCommanderExecutionTab(page, issuePrefix);
  await page.getByLabel(/crew provider/i).selectOption("opencode");
  await page.getByRole("button", { name: /^save$/i }).first().click();
  await expect.poll(async () => {
    const crew = await getAoaCrew(request, companyId);
    return crew.length > 0 && crew.every((a) => a.adapterType === "opencode_local");
  }, { timeout: 15_000 }).toBe(true);
});
```

- [ ] **Step 2: Run locally (win32 embedded-postgres override)**

Temporarily flip the `WINDOWS_WITH_EMBEDDED_POSTGRES` guard in
`tests/e2e/playwright.config.ts:15` to `false && …` (LOCAL ONLY — do NOT commit this
flip), then:

Run: `cd tests/e2e && pnpm exec playwright test provider-switching.spec.ts`
Expected: PASS (existing + 2 new cases). Restore the guard before committing.

- [ ] **Step 3: Commit (spec only; NOT the config flip)**

```bash
git add tests/e2e/provider-switching.spec.ts tests/e2e/helpers
git commit -m "test(provider-switching): e2e — onboarding + settings provider switch reach the crew"
```

---

## Final verification (after all tasks)

- [ ] **Full typecheck:** `pnpm -w typecheck` → 0 errors.
- [ ] **Server unit suite:** `cd server && pnpm vitest run` → green.
- [ ] **Shared + UI suites:** `cd packages/shared && pnpm vitest run` and `cd ui && pnpm vitest run` → green.
- [ ] **Migration check:** `pnpm db:generate` produces NO new diff (schema and migrations in sync).
- [ ] **Live smoke (isolated instance):** onboard as OpenAI crew → `GET /api/companies/:id/agents?kind=aoa` shows `codex_local`; change crew provider in Settings → re-fetch shows the new adapter; Commander chat still responds.
- [ ] Hand off to `superpowers:finishing-a-development-branch` (push + PR).

---

## Spec coverage map (self-review)

| Spec § | Task |
|---|---|
| §4 centralized mapping + AGENT_PROVIDERS opencode | T1 |
| §5.5 crew model override + read crewModel | T2 (col), T4 (logic) |
| §5.5 model-only change actually rewrites the row (shouldRewriteCrewAdapter model drift) | T4b |
| §5.3 validators (opencode + crewModel) | T3 |
| §5.4 ensureAllCrewAgents + boot/create de-dupe + re-ensure (provider/crewModel/cliTool/model) | T5, T6 |
| §5.9 Commander agent-row adapter follows cliTool (cliToolToProvider + resolveCommanderAdapterForCompany) | T1, T5b |
| §5.1 onboarding writes live fields; Commander drops google | T10 |
| §5.2 Settings crew control + Commander model | T11 |
| §5.6 Commander model on claude_cli (codex already honors; opencode out of scope) | T12 |
| §5.7 cost opencode | T7 |
| §5.8 deprecate dead columns + comment fixes | T8 (companies), T2 (internal_agent comment) |
| §8 testing (unit/integration/e2e) | per-task tests + T13 |
| UI types | T9 |
