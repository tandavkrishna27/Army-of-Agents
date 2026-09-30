# Provider Switching Engine (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make changing an agent's provider/model from config reliably run that provider on a compatible, shell-safe model across both the crew (`runner.ts`) and Commander (`cli-mode.ts`) paths, with validation, a test-connection probe, backfill of bad persisted models, and visible failures — never touching the company-level extraction key.

**Architecture:** Reuse the existing `codex-model.ts` resolver and apply it at the single crew choke point (`runner.ts` mutates `config.model` before `adapter.execute`) and at Commander (`cli-mode.ts`). Add company-scoped provider-status detection, a pure cross-family + shell-safety validator, an extended test-environment probe, a one-time backfill, and surfacing of failed runs. Decomposed into Units A–E; **C depends on B**, others independent.

**Tech Stack:** TypeScript, Node, Express 5, Drizzle ORM, Vitest (unit/service/contract/integration), Playwright (e2e), embedded-postgres (real-DB integration, `skipIf(win32)`).

**Spec:** `docs/aoa/plans/2026-06-23-provider-switching-engine-design.md`

---

## Hard rules (carry into every task)
- **Never read the company-level extraction `OPENAI_API_KEY`** (`process.env.OPENAI_API_KEY`, the Provider-SDK key) for provider-switching. Only the CLI login (`auth.json`) and a per-agent `adapterConfig.env.OPENAI_API_KEY` are in scope. A test in Unit A and Unit B locks this.
- **Shell-safety is mandatory** before any spawn: a model failing `SAFE_MODEL_RE` is rejected, regardless of validation tier.
- TDD: failing test first, minimal impl, green, commit. DRY/YAGNI.
- Run from repo root unless noted. Vitest invocation: `pnpm --filter <pkg> exec vitest run <path>` (server pkg name `@armyofagents/server`, shared `@armyofagents/shared`, codex adapter `@armyofagents/adapter-codex-local`). If a filter name differs, `cd <pkgdir> && pnpm exec vitest run <relpath>`.

## File-structure map
| File | Unit | Responsibility |
|---|---|---|
| `server/src/adapters/provider-status.ts` (new) | A | company-scoped detect: installed/authenticated/authMode/defaultModelResolved |
| `server/src/adapters/__tests__/provider-status.test.ts` (new) | A | parsers + "never reads company key" |
| `server/src/services/internal-agent/model-resolution.ts` (new) | B | `resolveModel()` — generalizes `codex-model.ts` across providers |
| `server/src/services/internal-agent/codex-model.ts` (modify) | B | export `SAFE_MODEL_RE`, `classifyAuthCompatibility` helpers for reuse |
| `server/src/services/internal-agent/aoa-agents/runner.ts` (modify ~389) | B | mutate `baseConfig.model` via `resolveModel`; strip stray `OPENAI_API_KEY` |
| `server/src/services/internal-agent/cli-mode.ts` (modify ~462) | B | route Commander codex model through the same resolver (parity) |
| `server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts` (modify) | B | fix codex/opencode defaults; extend `needsAdapterBackfill` |
| `server/src/routes/agents.ts` (modify 270-287, 289-312, 3 call sites) | B,C,D | create-default fix; generalized validation; extend probe |
| `packages/shared/src/validators/agent.ts` (modify) | C | pure cross-family + shell-safety refine on create/update schemas |
| `server/src/services/internal-agent/aoa-agents/thread-participation-runner.ts` (modify ~183) | E | surface failed runs |

---

## Task 1 (Unit A): Provider-status detection — pure parsers

**Files:**
- Create: `server/src/adapters/provider-status.ts`
- Test: `server/src/adapters/__tests__/provider-status.test.ts`

- [ ] **Step 1.1: Write failing tests for the Codex auth-mode parser + "company key ignored"**

```ts
// server/src/adapters/__tests__/provider-status.test.ts
import { describe, it, expect } from "vitest";
import { parseCodexAuthMode, type ProviderAuthMode } from "../provider-status.js";

describe("parseCodexAuthMode", () => {
  it("returns 'apikey' when a per-agent OPENAI_API_KEY is present", () => {
    expect(parseCodexAuthMode({ agentEnvApiKey: "sk-xyz", authJson: { auth_mode: "chatgpt" } }))
      .toBe<ProviderAuthMode>("apikey");
  });
  it("returns 'chatgpt' from the managed auth.json when no per-agent key", () => {
    expect(parseCodexAuthMode({ agentEnvApiKey: null, authJson: { auth_mode: "chatgpt" } }))
      .toBe("chatgpt");
  });
  it("returns 'apikey' from auth.json OPENAI_API_KEY field with no agent key", () => {
    expect(parseCodexAuthMode({ agentEnvApiKey: null, authJson: { OPENAI_API_KEY: "sk-x" } }))
      .toBe("apikey");
  });
  it("returns 'unknown' for an empty/missing auth.json", () => {
    expect(parseCodexAuthMode({ agentEnvApiKey: null, authJson: null })).toBe("unknown");
  });
  it("IGNORES the company/server process.env.OPENAI_API_KEY entirely", () => {
    // Even if the server env has a key, detection must not treat it as the agent's auth.
    expect(parseCodexAuthMode({ agentEnvApiKey: null, authJson: { auth_mode: "chatgpt" }, serverEnvApiKey: "sk-company" }))
      .toBe("chatgpt");
  });
});
```

- [ ] **Step 1.2: Run — expect FAIL (module not found)**

Run: `pnpm --filter @armyofagents/server exec vitest run src/adapters/__tests__/provider-status.test.ts`
Expected: FAIL "Cannot find module '../provider-status.js'".

- [ ] **Step 1.3: Implement the parser + types (pure core)**

```ts
// server/src/adapters/provider-status.ts
export type ProviderAuthMode = "subscription" | "chatgpt" | "apikey" | "unknown";

export interface ProviderStatus {
  adapterType: string;
  installed: boolean;
  authenticated: boolean;
  authMode: ProviderAuthMode;
  defaultModelResolved: string | null;
  detail?: string;
}

interface CodexAuthInputs {
  agentEnvApiKey: string | null;   // ONLY adapterConfig.env.OPENAI_API_KEY (per-agent, opt-in)
  authJson: Record<string, unknown> | null; // managed CODEX_HOME/auth.json contents
  serverEnvApiKey?: string | null; // accepted but DELIBERATELY ignored (company key guard)
}

export function parseCodexAuthMode(inputs: CodexAuthInputs): ProviderAuthMode {
  // Per-agent opt-in key wins (the adapter writes an api-key auth.json for it).
  if (inputs.agentEnvApiKey && inputs.agentEnvApiKey.trim().length > 0) return "apikey";
  const j = inputs.authJson;
  if (!j) return "unknown";
  if (typeof (j as { auth_mode?: unknown }).auth_mode === "string") {
    return ((j as { auth_mode: string }).auth_mode === "apikey") ? "apikey" : "chatgpt";
  }
  if (typeof (j as { OPENAI_API_KEY?: unknown }).OPENAI_API_KEY === "string") return "apikey";
  return "unknown";
  // serverEnvApiKey intentionally unused — company-level key must never influence auth mode.
}
```

- [ ] **Step 1.4: Run — expect PASS**

Run: `pnpm --filter @armyofagents/server exec vitest run src/adapters/__tests__/provider-status.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 1.5: Commit**

```bash
git add server/src/adapters/provider-status.ts server/src/adapters/__tests__/provider-status.test.ts
git commit -m "feat(provider-switching): codex auth-mode parser (Unit A) — company key ignored"
```

## Task 2 (Unit A): `getProviderStatus` — company-scoped, managed-home aware

**Files:**
- Modify: `server/src/adapters/provider-status.ts`
- Test: `server/src/adapters/__tests__/provider-status.test.ts`

- [ ] **Step 2.1: Write failing test (inject file/home readers via deps)**

```ts
import { getProviderStatus } from "../provider-status.js";

describe("getProviderStatus (codex)", () => {
  const deps = {
    resolveManagedCodexHomeDir: () => "/managed/home",
    readAuthJson: async () => ({ auth_mode: "chatgpt" } as Record<string, unknown>),
    readSharedCodexModel: async () => "gpt-5.5",
    isInstalled: async () => true,
  };
  it("reports chatgpt + defaultModelResolved from the SHARED config, managed home for auth", async () => {
    const s = await getProviderStatus("codex_local",
      { companyId: "c1", adapterConfig: { env: {} } }, deps);
    expect(s.authMode).toBe("chatgpt");
    expect(s.defaultModelResolved).toBe("gpt-5.5");
    expect(s.installed).toBe(true);
    expect(s.authenticated).toBe(true);
  });
  it("a per-agent OPENAI_API_KEY flips to apikey", async () => {
    const s = await getProviderStatus("codex_local",
      { companyId: "c1", adapterConfig: { env: { OPENAI_API_KEY: "sk-agent" } } }, deps);
    expect(s.authMode).toBe("apikey");
  });
});
```

- [ ] **Step 2.2: Run — expect FAIL (`getProviderStatus` undefined).**

Run: `pnpm --filter @armyofagents/server exec vitest run src/adapters/__tests__/provider-status.test.ts`

- [ ] **Step 2.3: Implement `getProviderStatus` with injected deps (real deps wire to `codex-home.ts`)**

```ts
// append to server/src/adapters/provider-status.ts
interface ProviderStatusDeps {
  resolveManagedCodexHomeDir: (env: NodeJS.ProcessEnv, companyId: string) => string;
  readAuthJson: (homeDir: string) => Promise<Record<string, unknown> | null>;
  readSharedCodexModel: () => Promise<string | null>;
  isInstalled: (adapterType: string) => Promise<boolean>;
}

export async function getProviderStatus(
  adapterType: string,
  ctx: { companyId: string; adapterConfig: Record<string, unknown> },
  deps: ProviderStatusDeps,
): Promise<ProviderStatus> {
  if (adapterType === "codex_local") {
    const env = (ctx.adapterConfig.env ?? {}) as Record<string, unknown>;
    const agentEnvApiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY : null;
    const home = deps.resolveManagedCodexHomeDir(process.env, ctx.companyId);
    const authJson = await deps.readAuthJson(home);
    const authMode = parseCodexAuthMode({ agentEnvApiKey, authJson });
    const installed = await deps.isInstalled(adapterType);
    return {
      adapterType, installed,
      authenticated: authMode !== "unknown",
      authMode,
      defaultModelResolved: await deps.readSharedCodexModel(),
    };
  }
  // claude/gemini/opencode: best-effort installed/authenticated, authMode "unknown" acceptable (Phase 1).
  const installed = await deps.isInstalled(adapterType);
  return { adapterType, installed, authenticated: installed, authMode: "unknown", defaultModelResolved: null };
}
```

- [ ] **Step 2.4: Run — expect PASS.** Then **Step 2.5: Commit**

```bash
git add server/src/adapters/provider-status.ts server/src/adapters/__tests__/provider-status.test.ts
git commit -m "feat(provider-switching): getProviderStatus — managed-home aware (Unit A)"
```

## Task 3 (Unit B): Promote shell-safety + family/auth classifiers for reuse

**Files:**
- Modify: `server/src/services/internal-agent/codex-model.ts` (export helpers)
- Create: `server/src/services/internal-agent/model-resolution.ts`
- Test: `server/src/services/internal-agent/__tests__/model-resolution.test.ts`

- [ ] **Step 3.1: Write failing tests for `resolveModel`**

```ts
// server/src/services/internal-agent/__tests__/model-resolution.test.ts
import { describe, it, expect } from "vitest";
import { resolveModel, ShellUnsafeModelError } from "../model-resolution.js";

const chatgpt = { authMode: "chatgpt" as const, defaultModelResolved: "gpt-5.5" };

describe("resolveModel", () => {
  it("THROWS on a shell-unsafe model regardless of tier", () => {
    expect(() => resolveModel("codex_local", "gpt-5 & calc.exe", chatgpt)).toThrow(ShellUnsafeModelError);
  });
  it("corrects an API-key-only codex model on chatgpt to the safe default", () => {
    const r = resolveModel("codex_local", "gpt-5.3-codex", chatgpt);
    expect(r.model).toBe("gpt-5.5");
    expect(r.note).toMatch(/not supported.*ChatGPT/i);
  });
  it("passes a compatible codex model through unchanged", () => {
    expect(resolveModel("codex_local", "gpt-5.5", chatgpt).model).toBe("gpt-5.5");
  });
  it("empty model on codex resolves to the validated default", () => {
    expect(resolveModel("codex_local", "", chatgpt).model).toBe("gpt-5.5");
  });
  it("claude passes a claude model through; gemini 'auto' is allowed (omit)", () => {
    expect(resolveModel("claude_local", "claude-sonnet-4-5-20250929", { authMode: "subscription", defaultModelResolved: null }).model)
      .toBe("claude-sonnet-4-5-20250929");
    expect(resolveModel("gemini_local", "auto", { authMode: "unknown", defaultModelResolved: null }).omitModelFlag).toBe(true);
  });
});
```

- [ ] **Step 3.2: Run — expect FAIL.**

Run: `pnpm --filter @armyofagents/server exec vitest run src/services/internal-agent/__tests__/model-resolution.test.ts`

- [ ] **Step 3.3: Export reusable helpers from `codex-model.ts`**

In `server/src/services/internal-agent/codex-model.ts`, change the two `const` regexes to exported and add a small predicate (keep existing functions intact):

```ts
export const SAFE_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
// (was: const SAFE_MODEL_RE = ...). CODEX_FAMILY_RE / CODEX_INCOMPATIBLE_RE stay internal;
// expose a predicate instead:
export function isShellSafeModel(model: string | null | undefined): boolean {
  return !!model && SAFE_MODEL_RE.test(model.trim());
}
```

- [ ] **Step 3.4: Implement `resolveModel`**

```ts
// server/src/services/internal-agent/model-resolution.ts
import { isShellSafeModel, isCodexCompatibleModel, resolveCodexChatModel } from "./codex-model.js";

export class ShellUnsafeModelError extends Error {
  constructor(model: string) { super(`Unsafe model identifier: ${JSON.stringify(model)}`); this.name = "ShellUnsafeModelError"; }
}
export interface ResolveModelStatus { authMode: "subscription" | "chatgpt" | "apikey" | "unknown"; defaultModelResolved: string | null; }
export interface ResolvedModel { model?: string; omitModelFlag: boolean; note?: string; }

export function resolveModel(adapterType: string, requested: string | null | undefined, status: ResolveModelStatus): ResolvedModel {
  const m = (requested ?? "").trim();
  if (m && !isShellSafeModel(m)) throw new ShellUnsafeModelError(m);

  if (adapterType === "codex_local") {
    // Reuse the proven Commander resolver: validates compatibility, falls back to gpt-5.5.
    const resolved = resolveCodexChatModel(m || null, status.defaultModelResolved);
    const note = (m && !isCodexCompatibleModel(m))
      ? `"${m}" is not supported on a ChatGPT Codex login; using ${resolved}.` : undefined;
    return { model: resolved, omitModelFlag: false, note };
  }
  if (adapterType === "gemini_local") {
    return (!m || m === "auto") ? { omitModelFlag: true } : { model: m, omitModelFlag: false };
  }
  // claude_local / opencode_local / others: empty → omit (adapter applies its own default); else pass through.
  return m ? { model: m, omitModelFlag: false } : { omitModelFlag: true };
}
```

- [ ] **Step 3.5: Run — expect PASS.** **Step 3.6: Commit**

```bash
git add server/src/services/internal-agent/codex-model.ts server/src/services/internal-agent/model-resolution.ts server/src/services/internal-agent/__tests__/model-resolution.test.ts
git commit -m "feat(provider-switching): resolveModel reuses codex-model.ts (Unit B core)"
```

## Task 4 (Unit B): Apply `resolveModel` at the crew choke point + env-strip hardening

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts` (~319-393)
- Test: `server/src/services/internal-agent/aoa-agents/__tests__/runner-model-resolution.test.ts` (new)

- [ ] **Step 4.1: Write failing test (pure helper extracted for testability)**

Extract a pure helper so the runner mutation is unit-testable without spawning:

```ts
// runner-model-resolution.test.ts
import { describe, it, expect } from "vitest";
import { applyModelResolutionToConfig } from "../runner-model-resolution.js";

const status = { authMode: "chatgpt" as const, defaultModelResolved: "gpt-5.5" };
describe("applyModelResolutionToConfig", () => {
  it("rewrites an incompatible codex model to the safe default", () => {
    const cfg = applyModelResolutionToConfig("codex_local", { model: "gpt-5.3-codex", env: {} }, status);
    expect(cfg.model).toBe("gpt-5.5");
  });
  it("strips a stray (company) OPENAI_API_KEY when the agent did NOT set one", () => {
    const cfg = applyModelResolutionToConfig("codex_local", { model: "gpt-5.5", env: {} }, status,
      { inheritedEnvOpenAiKey: "sk-company" });
    expect((cfg.env as Record<string, unknown>).OPENAI_API_KEY).toBeUndefined();
  });
  it("KEEPS a per-agent OPENAI_API_KEY the agent set itself", () => {
    const cfg = applyModelResolutionToConfig("codex_local", { model: "gpt-5.5", env: { OPENAI_API_KEY: "sk-agent" } }, status,
      { inheritedEnvOpenAiKey: "sk-company" });
    expect((cfg.env as Record<string, unknown>).OPENAI_API_KEY).toBe("sk-agent");
  });
});
```

- [ ] **Step 4.2: Run — expect FAIL.**

Run: `pnpm --filter @armyofagents/server exec vitest run src/services/internal-agent/aoa-agents/__tests__/runner-model-resolution.test.ts`

- [ ] **Step 4.3: Implement the pure helper**

```ts
// server/src/services/internal-agent/aoa-agents/runner-model-resolution.ts
import { resolveModel, type ResolveModelStatus } from "../model-resolution.js";

export function applyModelResolutionToConfig(
  adapterType: string,
  baseConfig: Record<string, unknown>,
  status: ResolveModelStatus,
  opts: { inheritedEnvOpenAiKey?: string | null } = {},
): Record<string, unknown> {
  const next = { ...baseConfig };
  const resolved = resolveModel(adapterType, next.model as string | undefined, status);
  if (resolved.omitModelFlag) delete next.model; else next.model = resolved.model;

  if (adapterType === "codex_local") {
    const env = { ...((next.env as Record<string, unknown>) ?? {}) };
    const agentSetKey = typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim().length > 0;
    // Env-strip hardening: the company/extraction key must never reach the CLI.
    // Only a key the AGENT set in its own adapterConfig.env survives.
    if (!agentSetKey && opts.inheritedEnvOpenAiKey) delete env.OPENAI_API_KEY;
    next.env = env;
  }
  return next;
}
```

- [ ] **Step 4.4: Run — expect PASS.**

- [ ] **Step 4.5: Wire it into `runner.ts` before `config` is built (~line 389)**

Add, just above `const isClaudeFamily = ...`:

```ts
// Provider-switching (Unit B): resolve model auth-aware + shell-safe, and strip
// any inherited company OPENAI_API_KEY before spawn. getProviderStatus is the
// real detector (Unit A); resolveModel throws on shell-unsafe — caught by the
// existing run try/catch and surfaced via Unit E.
const providerStatus = await getProviderStatus(agent.adapterType,
  { companyId: agent.companyId, adapterConfig: baseConfig }, realProviderStatusDeps);
const resolvedBaseConfig = applyModelResolutionToConfig(agent.adapterType, baseConfig, providerStatus,
  { inheritedEnvOpenAiKey: process.env.OPENAI_API_KEY ?? null });
```
Then replace `baseConfig` with `resolvedBaseConfig` in the two `config = ...{ ...baseConfig ... }` branches at 391-393.

- [ ] **Step 4.6: Run the existing runner test suite to confirm no regression**

Run: `pnpm --filter @armyofagents/server exec vitest run src/services/internal-agent/aoa-agents/__tests__/`
Expected: PASS (existing + new).

- [ ] **Step 4.7: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/runner-model-resolution.ts server/src/services/internal-agent/aoa-agents/runner.ts server/src/services/internal-agent/aoa-agents/__tests__/runner-model-resolution.test.ts
git commit -m "feat(provider-switching): resolve model + strip company key at crew choke point (Unit B)"
```

## Task 5 (Unit B): Commander parity + source-default fix + backfill

**Files:**
- Modify: `server/src/services/internal-agent/cli-mode.ts` (~462)
- Modify: `server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts`
- Modify: `server/src/routes/agents.ts` (`applyCreateDefaultsByAdapterType` 270-273)
- Test: `server/src/services/internal-agent/aoa-agents/__tests__/resolve-crew-adapter.test.ts`

- [ ] **Step 5.1: Write failing tests for the default fix + backfill predicate**

```ts
import { describe, it, expect } from "vitest";
import { resolveCrewAdapterFor, needsAdapterBackfill } from "../resolve-crew-adapter.js";

describe("resolve-crew-adapter (provider-switching fixes)", () => {
  it("codex default is no longer the API-key-only gpt-5.3-codex", () => {
    const a = resolveCrewAdapterFor("openai");
    expect(a.adapterType).toBe("codex_local");
    expect(a.adapterConfig.model).not.toBe("gpt-5.3-codex"); // empty or gpt-5.5
  });
  it("opencode default is a valid provider/model slash id, not a bare codex id", () => {
    const a = resolveCrewAdapterFor("opencode");
    expect(String(a.adapterConfig.model)).toMatch(/\//);
  });
  it("backfill flags an existing codex row pinned to gpt-5.3-codex", () => {
    expect(needsAdapterBackfill("codex_local", { model: "gpt-5.3-codex" })).toBe(true);
  });
  it("backfill leaves a compatible codex row alone", () => {
    expect(needsAdapterBackfill("codex_local", { model: "gpt-5.5" })).toBe(false);
  });
});
```

- [ ] **Step 5.2: Run — expect FAIL.**

- [ ] **Step 5.3: Implement the fixes**

In `resolve-crew-adapter.ts`: change the codex case (line 74) `model: "gpt-5.3-codex"` → `model: DEFAULT_CODEX_CHAT_MODEL` (import from `../codex-model.js`, = `gpt-5.5`); change the opencode case (line 66) to `model: "openai/gpt-5.2-codex"` (the valid `DEFAULT_OPENCODE_LOCAL_MODEL`). Extend `needsAdapterBackfill`:

```ts
import { DEFAULT_CODEX_CHAT_MODEL, isCodexCompatibleModel } from "../codex-model.js";
// ...inside needsAdapterBackfill, before `return false;`:
if (adapterType === "codex_local") {
  const model = typeof adapterConfig?.model === "string" ? adapterConfig.model : "";
  // A persisted codex model that a ChatGPT login would reject needs rewriting.
  return model.length > 0 && !isCodexCompatibleModel(model);
}
```
In `agents.ts:271-273` (`applyCreateDefaultsByAdapterType`): change `next.model = DEFAULT_CODEX_LOCAL_MODEL` → `next.model = DEFAULT_CODEX_CHAT_MODEL` (import from codex-model). In `cli-mode.ts:462`, leave as-is if it already calls `resolveCodexChatModel`; otherwise route its model through `resolveModel("codex_local", ...)` so chat == crew.

- [ ] **Step 5.4: Add the backfill rewrite where `needsAdapterBackfill` is consumed**

Find the boot-time consumer of `needsAdapterBackfill` (grep: the ensure-* / seed path that calls it) and ensure that when it returns true for codex, the row's `adapterConfig.model` is rewritten to `DEFAULT_CODEX_CHAT_MODEL` via `mergeAdapterConfig`. (The existing call already rewrites via `resolveCrewAdapterForCompany`; the codex case now produces `gpt-5.5`.)

- [ ] **Step 5.5: Run — expect PASS.** **Step 5.6: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts server/src/routes/agents.ts server/src/services/internal-agent/cli-mode.ts server/src/services/internal-agent/aoa-agents/__tests__/resolve-crew-adapter.test.ts
git commit -m "fix(provider-switching): codex/opencode default models + codex backfill (Unit B)"
```

## Task 6 (Unit C): Pure cross-family + shell-safety validator

**Files:**
- Modify: `packages/shared/src/validators/agent.ts`
- Test: `packages/shared/src/validators/agent.test.ts` (new or extend)

- [ ] **Step 6.1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { createAgentSchema, updateAgentSchema } from "./agent.js";

describe("agent schema adapter↔model cross-family + shell-safety", () => {
  it("rejects claude_local + a gpt model (cross-family)", () => {
    expect(createAgentSchema.safeParse({ name: "x", adapterType: "claude_local", adapterConfig: { model: "gpt-5.5" } }).success).toBe(false);
  });
  it("rejects codex_local + a claude model", () => {
    expect(updateAgentSchema.safeParse({ adapterType: "codex_local", adapterConfig: { model: "claude-sonnet-4-5-20250929" } }).success).toBe(false);
  });
  it("rejects a shell-unsafe model", () => {
    expect(updateAgentSchema.safeParse({ adapterType: "codex_local", adapterConfig: { model: "gpt-5 && rm" } }).success).toBe(false);
  });
  it("allows opencode_local + openai/<model> slash format", () => {
    expect(updateAgentSchema.safeParse({ adapterType: "opencode_local", adapterConfig: { model: "openai/gpt-5.2-codex" } }).success).toBe(true);
  });
  it("allows gemini_local + 'auto' and an unknown-but-safe model", () => {
    expect(updateAgentSchema.safeParse({ adapterType: "gemini_local", adapterConfig: { model: "auto" } }).success).toBe(true);
    expect(updateAgentSchema.safeParse({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.6" } }).success).toBe(true);
  });
});
```

- [ ] **Step 6.2: Run — expect FAIL.**

Run: `pnpm --filter @armyofagents/shared exec vitest run src/validators/agent.test.ts`

- [ ] **Step 6.3: Implement a pure family classifier + parent-schema refine**

Add to `agent.ts` (pure, no imports from server):

```ts
const SAFE_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
function modelFamily(model: string): "claude" | "openai" | "gemini" | "unknown" {
  const m = model.includes("/") ? model.split("/").pop()! : model; // opencode openai/<id>
  if (/^claude-/i.test(m)) return "claude";
  if (/^(gpt-|o\d|chatgpt)/i.test(m)) return "openai";
  if (/^gemini-|^auto$/i.test(m)) return "gemini";
  return "unknown";
}
const ADAPTER_FAMILY: Record<string, "claude" | "openai" | "gemini"> = {
  claude_local: "claude", codex_local: "openai", opencode_local: "openai", gemini_local: "gemini",
};
function refineAdapterModel(val: { adapterType?: string; adapterConfig?: Record<string, unknown> }, ctx: z.RefinementCtx) {
  const at = val.adapterType; const model = val.adapterConfig?.model;
  if (!at || typeof model !== "string" || model.length === 0) return;
  if (!SAFE_MODEL_RE.test(model.includes("/") ? model.split("/").pop()! : model)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["adapterConfig", "model"], message: `Unsafe model identifier: ${model}` });
    return;
  }
  const fam = modelFamily(model); const expected = ADAPTER_FAMILY[at];
  if (expected && fam !== "unknown" && fam !== expected) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["adapterConfig", "model"],
      message: `Model "${model}" (${fam}) does not match adapter ${at} (${expected}).` });
  }
}
```
Apply AFTER `.omit/.partial/.extend` (ZodEffects caveat — the artifact T2 lesson): wrap the exported schemas:
```ts
export const createAgentSchema = _createAgentBase.superRefine(refineAdapterModel);
export const updateAgentSchema = _createAgentBase.omit({ permissions: true }).partial()
  .extend({ /* existing extends */ }).superRefine(refineAdapterModel);
```
(Rename the current object to `_createAgentBase`; if any consumer uses `createAgentSchema.shape`, expose `_createAgentBase` for that — grep `createAgentSchema.shape` / `.omit` / `.extend` first and repoint to `_createAgentBase`.)

- [ ] **Step 6.4: Run — expect PASS. Then run the full shared + server route suites for ZodEffects regressions.**

Run: `pnpm --filter @armyofagents/shared exec vitest run` then `pnpm --filter @armyofagents/server exec vitest run src/__tests__/`
Expected: PASS (watch for any `.shape`/`.omit` break — repoint to `_createAgentBase`).

- [ ] **Step 6.5: Commit**

```bash
git add packages/shared/src/validators/agent.ts packages/shared/src/validators/agent.test.ts
git commit -m "feat(provider-switching): cross-family + shell-safety agent validator (Unit C)"
```

## Task 7 (Unit C): Auth-mismatch soft-warn at the route (all 3 call sites)

**Files:**
- Modify: `server/src/routes/agents.ts` (`assertAdapterConfigConstraints` 289-312; called at ~929, ~1077, ~1317)
- Test: `server/src/__tests__/agents-adapter-validation.contract.test.ts` (new)

- [ ] **Step 7.1: Write failing route-contract test (mock provider-status)** — assert PATCH returns `200` with `warnings[]` for an API-key-only codex model on a chatgpt login, and `400` for cross-family (delegated to Unit C schema). Use the existing route-contract harness pattern (`appAs(role)` + supertest).
- [ ] **Step 7.2: Run — expect FAIL.**
- [ ] **Step 7.3: Generalize `assertAdapterConfigConstraints`** — keep the opencode runtime check; add: when `adapterType` is codex/claude/gemini and a `model` is set, call `getProviderStatus` and if `resolveModel(...).note` is present, attach a `warnings` entry to the response (do NOT throw). Apply at all three call sites by returning warnings up to the handler.
- [ ] **Step 7.4: Run — expect PASS. Step 7.5: Commit** `feat(provider-switching): auth-mismatch soft-warn on agent save (Unit C)`

## Task 8 (Unit D): Model-aware test-connection probe (extend test-environment)

**Files:**
- Modify: `server/src/routes/agents.ts` (test-environment handler 460-537)
- Modify: each adapter `test.ts` (accept resolved model)
- Test: `server/src/__tests__/adapter-test-environment.contract.test.ts` (new) + redaction unit test

- [ ] **Step 8.1: Write failing tests**: (a) probe accepts `{ model }`, runs through `resolveModel` (inject a fake runner via `deps.run`) and returns `{ ok, latencyMs }`; (b) a planted `sk-ant-...` in fake stderr is **stripped** from the returned `error` (assert via `SENSITIVE_ENV_VALUE_PATTERNS`); (c) RBAC: `assertCanReadConfigurations` (keep existing — §10 decision) — authorized 200, unauthorized 403; (d) a per-company in-flight cap rejects the 2nd concurrent probe with 429.
- [ ] **Step 8.2: Run — expect FAIL.**
- [ ] **Step 8.3: Implement**: thread `req.body.model` through `resolveModel` into the adapter `testEnvironment` call; add a per-company concurrency guard (model on `HEARTBEAT_MAX_CONCURRENT_RUNS_*`, a small in-memory `Map<companyId, count>` + hard timeout ceiling); pipe `result.error`/stderr through value-pattern redaction before responding.
- [ ] **Step 8.4: Run — expect PASS. Step 8.5: Commit** `feat(provider-switching): model-aware test-connection probe + cap + redaction (Unit D)`

## Task 9 (Unit D / UI): client + config form wiring

**Files:**
- Modify: `ui/src/api/agents.ts` (probe payload includes `model`)
- Modify: `ui/src/components/AgentConfigForm.tsx` (Test connection button; disable incompatible models; show transparent default + warnings)
- Test: component test + e2e (Task 11)

- [ ] **Step 9.1–9.4:** TDD a component test asserting: the model dropdown disables incompatible models (from provider-status), shows "Default → gpt-5.5 (your Codex config)", surfaces save `warnings[]`, and the Test-connection button calls the probe and renders ✓/✗. Commit `feat(provider-switching): auth-aware model picker + test-connection (Unit D UI)`.

## Task 10 (Unit E): Surface failed crew runs in the thread

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/thread-participation-runner.ts` (~183)
- Test: extend its existing test (inject `deps.runAgent` returning `{ status: "failed", errorMessage }`)

- [ ] **Step 10.1: Write failing test** — a failed run no longer returns `""` silently; it surfaces a redacted, friendly reason (posts a system entry or returns a typed failure the caller renders). Coordinate with the already-flagged silent-swallow background task (don't double-implement).
- [ ] **Step 10.2–10.5:** implement an error-mapper (auth/model/CLI-missing → friendly + redacted), wire it, run, commit `feat(provider-switching): surface failed crew runs in thread (Unit E)`.

## Task 11: Integration + e2e + parity

**Files:**
- Create: `server/src/__tests__/provider-switching.integration.test.ts` (embedded-postgres, `skipIf(win32)`)
- Create: `tests/e2e/provider-switching.spec.ts` (CI lane) + a `*.real-provider.spec.ts` soak lane

- [ ] **Step 11.1: Real-DB integration** — switch an agent adapter+model via the real route; assert persisted + that `resolveModel` yields the expected argv via `onMeta.commandArgs` (no real spawn); a **managed-home vs shared-home** case (shared chatgpt, per-agent key → apikey); a **backfill** case (seed `gpt-5.3-codex` → boot ensure-* → assert corrected to `gpt-5.5`); a **parity** case (crew `runner.ts` and Commander resolve the same model for the same config).
- [ ] **Step 11.2: e2e CI lane (fake crew + mocked probe)** — change provider/model + save persists; cross-family `400` inline; auth-mismatch warning renders. **Soak lane** (`AOA_E2E_REAL_PROVIDER=1`) — probe ✓ for Claude/Codex.
- [ ] **Step 11.3: Visual** — config form states (Linux-gated).
- [ ] **Step 11.4: Commit** `test(provider-switching): integration + e2e (CI + soak) + parity + backfill`

## Task 12: Full-suite green + self-review

- [ ] **Step 12.1:** `pnpm --filter @armyofagents/shared exec vitest run && pnpm --filter @armyofagents/server exec vitest run` — all green.
- [ ] **Step 12.2:** lint/build: `pnpm -w build` (or the repo's verify script).
- [ ] **Step 12.3:** Re-read the spec §3/§7/§9 hard rules; confirm: company key never read (test exists), shell-safety hard-rejects, crew↔Commander parity test passes, backfill test passes.
- [ ] **Step 12.4: Commit** any fixups.
