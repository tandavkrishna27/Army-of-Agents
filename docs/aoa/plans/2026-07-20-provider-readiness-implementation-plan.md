# Provider Readiness & Authentication — Implementation Plan (Stage A + Runtime Fix)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a centralized Settings → Providers tab that shows install/auth status for every CLI provider, lets a founder authenticate by API key, and makes runtime CLI auth failures visible instead of silent.

**Architecture:** A shared provider *descriptor catalog* replaces the hardcoded `anthropic|openai` enums. The existing generic adapter probe and its outcome classifier are promoted to shared, provider-agnostic services. Probe results are cached in a new table so the tab renders instantly. Company-level API keys resolve through a strict fallback chain (`agent binding → company key → host CLI login`) that never rewrites existing per-agent bindings.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM (Postgres), React + Vite + Tailwind v4, Vitest, Playwright.

**Design doc:** `docs/aoa/plans/2026-07-20-provider-readiness-design.md`

**Scope:** Stage A (framework) + the Stage C runtime fix, which is pulled forward because it fixes the originally-reported bug and is independent. Stage B (wiring interactive login for Gemini/Cursor/OpenCode/Grok) is gated on the Task 17 spike and gets a follow-up plan on this same branch.

---

## Setup

- [ ] **Step 1: Create a short-path worktree**

The OneDrive worktree cannot boot the app (embedded Postgres `initdb` fails — the share path is 261 chars, 1 over Windows `MAX_PATH`, and `initdb.exe` is not long-path aware).

```bash
git config core.longpaths true
git worktree add -b feat/provider-readiness C:/Users/TK/.aoa/wt/providers HEAD
cd C:/Users/TK/.aoa/wt/providers
pnpm install
pnpm build
```

- [ ] **Step 2: Verify the instance boots**

This is a Windows/PowerShell host — inline `VAR=value cmd` is Unix syntax and will not work. Use:

```powershell
$env:AOA_HOME = "C:\Users\TK\.aoa\providers-dev"
$env:PORT = "3488"
$env:AOA_EMBEDDED_POSTGRES_PORT = "54488"
$env:AOA_DEV_LOCAL_IDENTITY = "1"
node scripts\dev-runner.mjs watch
```
Expected: startup banner showing `Server 3488`, `Migrations applied`. Ports 3488/54488 are chosen to avoid the instances already running on 3100/3399 and 54329/54399/54410/54415.

---

## File Structure

**Create:**
- `packages/shared/src/providers/provider-catalog.ts` — UI-safe descriptor metadata (id, label, adapterType, kind, apiKey env/secret/placeholder, install hints, capability flags).
- `packages/shared/src/providers/__tests__/provider-catalog.test.ts`
- `server/src/services/providers/classify-probe.ts` — promoted, provider-agnostic outcome classifier.
- `server/src/services/providers/readiness.ts` — probe + status-cache service.
- `server/src/services/providers/provider-key.ts` — generalized company-level key save.
- `server/src/routes/providers.ts` — the new routes.
- `packages/db/src/schema/provider_readiness_status.ts` — status cache table.
- `ui/src/api/providers.ts` — API client.
- `ui/src/components/providers/ProviderReadinessCard.tsx` — the one shared readiness/auth component.
- `ui/src/components/settings/sections/ProvidersSection.tsx` — the tab.

**Modify:**
- `server/src/services/internal-agent/parse-stream-json.ts` — surface `is_error` results.
- `server/src/services/internal-agent/cli-mode.ts` — surface nonzero exit.
- `server/src/services/commander-verify.ts` — delegate to the shared classifier.
- `server/src/services/secrets.ts` — company-key fallback in runtime resolution.
- `server/src/app.ts` — mount the providers router.
- `ui/src/components/settings/SettingsLayout.tsx`, `ui/src/pages/SettingsPage.tsx` — register the tab.
- `ui/src/components/AgentConfigForm.tsx` — readiness badge.
- `ui/src/onboarding/steps/VerifyStep.tsx` — refactor onto the shared component.

---

## Task 1: Surface CLI `is_error` results (the reported bug)

`handleResultEvent` currently ignores `is_error` / `api_error_status`, so a 401 renders as a successful empty turn.

**Files:**
- Modify: `server/src/services/internal-agent/parse-stream-json.ts:310` (`handleResultEvent`)
- Test: `server/src/__tests__/parse-stream-json.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/__tests__/parse-stream-json.test.ts`:

```ts
describe("result events that carry an API error", () => {
  it("emits an error chunk when is_error is true", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 401,
      duration_ms: 912,
      result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}',
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    });
    const chunks = parseAll([line]);
    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    expect((err as { type: "error"; message: string }).message).toContain("authenticate");
  });

  it("still emits done so the run is finalized exactly once", () => {
    const line = JSON.stringify({
      type: "result", subtype: "success", is_error: true, api_error_status: 401,
      duration_ms: 912, result: "Failed to authenticate. API Error: 401",
      usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0,
    });
    const chunks = parseAll([line]);
    expect(chunks.filter((c) => c.type === "done")).toHaveLength(1);
  });

  it("does not emit an error chunk for a clean result", () => {
    const line = JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      duration_ms: 500, result: "all good",
      usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0,
    });
    const chunks = parseAll([line]);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(chunks.filter((c) => c.type === "done")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/__tests__/parse-stream-json.test.ts -t "carry an API error"`
Expected: FAIL — no `error` chunk is produced.

- [ ] **Step 3: Write minimal implementation**

In `server/src/services/internal-agent/parse-stream-json.ts`, replace the `return [...]` at the end of `handleResultEvent` with:

```ts
  const chunks: AgentStreamChunk[] = [];

  // A `result` event can report subtype:"success" while still carrying an API
  // failure (e.g. auth): claude sets is_error + api_error_status and puts the
  // human-readable reason in `result`. Without this the turn renders as an
  // empty success — no content, no error (the silent-empty-turn bug).
  const isError = event.is_error === true || typeof event.api_error_status === "number";
  if (isError) {
    const raw = typeof event.result === "string" ? event.result.trim() : "";
    chunks.push({
      type: "error",
      // REDACT before this reaches the client: the CLI's error text is
      // attacker/vendor-controlled and can echo credential material.
      message: raw.length > 0 ? redactSecrets(raw) : "The CLI reported an error but gave no detail.",
    });
  }

  chunks.push({
    type: "done",
    summary: {
      runId: "",
      toolsCalled: [],
      durationMs: asNum(event.duration_ms),
      costCents,
      tokenUsage: { inputTokens, outputTokens, cachedInputTokens },
    },
  });

  return chunks;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run server/src/__tests__/parse-stream-json.test.ts`
Expected: PASS, including all pre-existing cases (the `done` invariant must not regress).

- [ ] **Step 5: Run the CLI-mode invariant suites**

Run: `pnpm vitest run server/src/__tests__/cli-mode-done-invariant.test.ts server/src/__tests__/cli-mode.test.ts`
Expected: PASS — exactly one `done` per turn is preserved.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/internal-agent/parse-stream-json.ts server/src/__tests__/parse-stream-json.test.ts
git commit -m "fix(commander): surface CLI api errors instead of empty turns"
```

---

## Task 2: Surface a nonzero CLI exit

If the CLI dies without emitting a parseable result (bad flag, crash), the turn is still silent.

**Files:**
- Modify: `server/src/services/internal-agent/cli-mode.ts:905` (`streamProcessOutput`)
- Test: `server/src/__tests__/cli-mode-exit-code.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/cli-mode-exit-code.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { __testables } from "../services/internal-agent/cli-mode.js";

function fakeProc(exitCode: number, stdout: string) {
  const proc = new EventEmitter() as any;
  proc.stdout = Readable.from([stdout]);
  proc.stderr = Readable.from([]);
  proc.exitCode = exitCode;
  setImmediate(() => { proc.exitCode = exitCode; proc.emit("exit", exitCode); });
  return proc;
}

async function collect(proc: any) {
  const chunks: any[] = [];
  for await (const c of __testables.streamProcessOutput(proc, true)) chunks.push(c);
  return chunks;
}

describe("streamProcessOutput failure handling", () => {
  it("emits an error chunk when the CLI exits nonzero with no content", async () => {
    expect((await collect(fakeProc(1, ""))).some((c) => c.type === "error")).toBe(true);
  });

  it("does not emit an error chunk on a clean exit", async () => {
    expect((await collect(fakeProc(0, ""))).some((c) => c.type === "error")).toBe(false);
  });

  // The `produced` regression: progress output must not mask a failed exit.
  it("still errors when only a thinking/progress chunk preceded a nonzero exit", async () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "x" });
    expect((await collect(fakeProc(1, line + "\n"))).some((c) => c.type === "error")).toBe(true);
  });

  it("does not double-report when an explicit error already arrived", async () => {
    const line = JSON.stringify({
      type: "result", subtype: "success", is_error: true, api_error_status: 401,
      result: "Failed to authenticate.", usage: {}, duration_ms: 1,
    });
    const errs = (await collect(fakeProc(1, line + "\n"))).filter((c) => c.type === "error");
    expect(errs).toHaveLength(1);
  });

  it("errors on signal termination (null exit code)", async () => {
    expect((await collect(fakeProc(null as any, ""))).some((c) => c.type === "error")).toBe(true);
  });

  it("errors when the child emits an error event (spawn failure)", async () => {
    const proc = fakeProc(0, "");
    setImmediate(() => proc.emit("error", new Error("ENOENT")));
    expect((await collect(proc)).some((c) => c.type === "error")).toBe(true);
  });

  it("errors when the process has no stdout", async () => {
    const proc = fakeProc(1, "");
    proc.stdout = null;
    expect((await collect(proc)).some((c) => c.type === "error")).toBe(true);
  });
});
```

Add a separate test asserting `redactSecrets` is applied to the stderr log line.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/__tests__/cli-mode-exit-code.test.ts`
Expected: FAIL — `__testables` is not exported.

- [ ] **Step 3: Implement**

In `cli-mode.ts`, inspect the exit code. **Do not** gate on "any chunk was produced" — a `thinking`/progress chunk followed by exit 1 would still go silent. Gate on whether *meaningful* output arrived (real `text` content or an explicit `error`), and cover the `error` event and signal-termination (`code === null`) paths too:

```ts
  let sawContent = false;   // real assistant text
  let sawError = false;     // an explicit error chunk already emitted
```

Set these in `processLines`/`flushLeftover` when a `text` chunk with non-empty delta, or an `error` chunk, is pushed. Then:

```ts
  const finish = (code: number | null, signalled: boolean) => {
    flushLeftover();
    // Suppress only if an explicit error already reached the client — otherwise
    // a nonzero/aborted exit with no content is the silent-empty-turn bug.
    const failed = signalled || (code ?? 0) !== 0;
    if (failed && !sawError && !sawContent) {
      pending.push({
        type: "error",
        message: signalled
          ? "The CLI was terminated before it produced a response."
          : `The CLI exited with code ${code ?? -1} without producing output.`,
      });
    }
    done = true;
    notify();
  };

  proc.on("exit", (code: number | null) => finish(code, code === null));
  proc.on("error", () => finish(null, true));   // spawn failure / ENOENT
  if (!proc.stdout) { finish(null, true); return; }  // replaces the bare early return
```

Also redact the stderr that is logged today (`cli-mode.ts:958-963` logs up to 2000 raw chars):

```ts
  logger.warn({ service: "commander-cli", stderr: redactSecrets(text).slice(0, 2000) }, "CLI subprocess stderr");
```

At the bottom of the file export the testable seam:

```ts
export const __testables = { streamProcessOutput };
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run server/src/__tests__/cli-mode-exit-code.test.ts server/src/__tests__/cli-mode.test.ts server/src/__tests__/cli-mode-done-invariant.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/cli-mode.ts server/src/__tests__/cli-mode-exit-code.test.ts
git commit -m "fix(commander): surface nonzero CLI exits"
```

---

## Task 2b: Reconcile with the existing `runtime_provider_keys` concept

AoA **already** has a company-scoped provider-key system — `packages/db/src/schema/runtime_provider_keys.ts`, `server/src/services/runtime-provider-keys.ts`, routes in `server/src/routes/secrets.ts`, and a **"Provider Keys" tab** in the Secrets vault. It currently serves *sandbox* providers (E2B). Shipping a second thing also called "provider keys" would leave two competing models and a confusing UI.

Decide and document BEFORE building, so the naming is settled once:

- [ ] **Step 1: Read the existing system**

```bash
sed -n '1,40p' packages/db/src/schema/runtime_provider_keys.ts
sed -n '90,140p' server/src/services/runtime-provider-keys.ts
sed -n '145,215p' server/src/routes/secrets.ts
```

- [ ] **Step 2: Record the decision in the design doc**

Add a "Relationship to runtime_provider_keys" section to `docs/aoa/plans/2026-07-20-provider-readiness-design.md` stating which of these we chose:

- **(A) Separate, renamed (recommended default).** `runtime_provider_keys` stays *infrastructure/sandbox* credentials; CLI credentials live in `company_secrets` under `provider:*` as planned. To remove the collision, the Secrets vault tab is renamed **"Sandbox Providers"**, and the new tab owns the name "Providers". Rationale: CLI credentials are consumed via adapter env resolution, not via the sandbox-provider registry, and they need host-login semantics that `runtime_provider_keys` has no concept of.
- **(B) Extend the existing table.** Add CLI providers to the `runtime_provider_keys` provider enum and reuse its default/status/audit machinery. Avoids a second model, but forces CLI credentials into a schema shaped around sandbox runtimes and still needs the `provider:*` secret for env injection.

- [ ] **Step 3: Apply the rename if (A)**

Update the Secrets vault sub-tab label and any copy referring to it. No schema change.

- [ ] **Step 4: Commit**

```bash
git add docs/aoa/plans/2026-07-20-provider-readiness-design.md ui/src/components/secrets
git commit -m "docs(providers): reconcile with runtime_provider_keys naming"
```

---

## Task 3: Provider catalog (shared descriptors)

**Files:**
- Create: `packages/shared/src/providers/provider-catalog.ts`
- Create: `packages/shared/src/providers/__tests__/provider-catalog.test.ts`
- Modify: `packages/shared/src/index.ts` (re-export)

**Two corrections from review before writing this:**

1. **Cursor and Cursor Cloud share `CURSOR_API_KEY`.** Giving them different secret names (`provider:cursor` vs `provider:cursor_cloud`) means saving one does not satisfy the other, and the fallback becomes ambiguous. Model this explicitly with a `credentialGroup` so both resolve to ONE stored secret.
2. **Several providers accept more than one credential** (Gemini: `GEMINI_API_KEY` / `GOOGLE_API_KEY` / GCA OAuth; Pi: Anthropic or xAI keys). v1 supports exactly one *primary* key per provider — but that must be a stated decision, not an accident, and the descriptor carries `alternativeEnvVars` so the probe/UI can explain the others.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { PROVIDER_CATALOG, getProviderById, getProviderByAdapterType } from "../provider-catalog.js";
import { BUILTIN_ADAPTER_TYPES } from "@armyofagents/shared"; // or the canonical builtin list

/**
 * Adapters that intentionally have NO catalog entry, with the reason. Anything
 * else appearing in the adapter registry must be triaged — this is what makes
 * the test self-enforcing instead of a hand-maintained duplicate list.
 */
const INTENTIONALLY_UNCATALOGUED: Record<string, string> = {
  process: "generic spawn, no auth",
  http: "generic webhook, no auth",
  openclaw: "per-agent endpoint token, not a shared credential",
  openclaw_gateway: "per-agent endpoint token, not a shared credential",
  hermes_local: "PAPERCLIP_API_KEY wire protocol, JWT-injected",
  acpx_local: "embedded; inherits claude/codex credentials",
};

describe("provider catalog", () => {
  // Self-enforcing: adding a credentialed adapter to the registry fails here
  // until it is either catalogued or explicitly excluded with a reason.
  it("catalogues every adapter that is not explicitly excluded", () => {
    const catalogued = new Set(PROVIDER_CATALOG.map((p) => p.adapterType));
    const untriaged = BUILTIN_ADAPTER_TYPES.filter(
      (t) => !catalogued.has(t) && !(t in INTENTIONALLY_UNCATALOGUED),
    );
    expect(untriaged).toEqual([]);
  });

  it("shares one stored secret between providers in the same credential group", () => {
    const cursor = getProviderById("cursor")!;
    const cloud = getProviderById("cursor_cloud")!;
    expect(cursor.credential.apiKey!.envVar).toBe(cloud.credential.apiKey!.envVar);
    // Same env var MUST mean the same secret, or saving one silently fails the other.
    expect(cursor.credential.apiKey!.secretName).toBe(cloud.credential.apiKey!.secretName);
  });

  it("records alternative credentials where a provider accepts several", () => {
    const gemini = getProviderById("google")!;
    expect(gemini.credential.apiKey!.alternativeEnvVars).toContain("GOOGLE_API_KEY");
  });

  it("gives every provider a unique adapterType", () => {
    const types = PROVIDER_CATALOG.map((p) => p.adapterType);
    expect(new Set(types).size).toBe(types.length);
  });

  it("gives every apiKey provider an env var, reserved secret name and placeholder", () => {
    for (const p of PROVIDER_CATALOG) {
      if (!p.credential.apiKey) continue;
      expect(p.credential.apiKey.envVar).toMatch(/^[A-Z0-9_]+$/);
      // Reserved namespace, but NOT necessarily provider:<own id> — providers
      // that share a credential intentionally share one secret name.
      expect(p.credential.apiKey.secretName).toMatch(/^provider:[a-z0-9_]+$/);
      expect(p.credential.apiKey.placeholder.length).toBeGreaterThan(0);
    }
  });

  it("never maps one env var to two different secret names", () => {
    const byEnv = new Map<string, Set<string>>();
    for (const p of PROVIDER_CATALOG) {
      const k = p.credential.apiKey;
      if (!k) continue;
      if (!byEnv.has(k.envVar)) byEnv.set(k.envVar, new Set());
      byEnv.get(k.envVar)!.add(k.secretName);
    }
    for (const [envVar, names] of byEnv) {
      expect(names.size, `${envVar} maps to multiple secrets: ${[...names].join(", ")}`).toBe(1);
    }
  });

  it("reserves the provider: secret namespace (no collision with existing conventions)", () => {
    for (const p of PROVIDER_CATALOG) {
      const name = p.credential.apiKey?.secretName;
      if (!name) continue;
      expect(name.startsWith("llm:")).toBe(false);
      expect(name.startsWith("Commander ")).toBe(false);
    }
  });

  it("gives every provider install hints for all three platforms", () => {
    for (const p of PROVIDER_CATALOG) {
      expect(p.installHint.mac.length).toBeGreaterThan(0);
      expect(p.installHint.win.length).toBeGreaterThan(0);
      expect(p.installHint.linux.length).toBeGreaterThan(0);
    }
  });

  it("only claims selfCompletingLogin where it is actually wired", () => {
    const wired = PROVIDER_CATALOG.filter((p) => p.credential.selfCompletingLogin).map((p) => p.id);
    expect(wired).toEqual(["openai"]);
  });

  it("resolves by id and adapterType", () => {
    expect(getProviderById("anthropic")?.adapterType).toBe("claude_local");
    expect(getProviderByAdapterType("codex_local")?.id).toBe("openai");
    expect(getProviderById("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/providers/__tests__/provider-catalog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the catalog**

Create `packages/shared/src/providers/provider-catalog.ts`:

```ts
/**
 * Provider catalog — the single source of truth for credentialed runtimes.
 *
 * Replaces the hardcoded "anthropic" | "openai" enums. UI-safe: contains only
 * serialisable metadata. Server-side runners (login spawn, authHome resolution)
 * are attached separately in server/src/services/providers/provider-registry.ts.
 *
 * Excluded deliberately: hermes_local (JWT wire protocol, not a user
 * credential), openclaw/openclaw_gateway (per-agent endpoint token), process and
 * http (no auth). acpx_local inherits Claude/Codex and is rendered as such.
 */

export type ProviderKind = "local_cli" | "managed_api";

export interface ProviderApiKeySpec {
  envVar: string;
  /**
   * Reserved namespace — must not collide with `llm:*` or `Commander * API key`.
   * Providers sharing a credential (Cursor + Cursor Cloud both use
   * CURSOR_API_KEY) MUST share this exact name so one save satisfies both.
   */
  secretName: string;
  placeholder: string;
  /**
   * Other env vars this provider also accepts (Gemini: GOOGLE_API_KEY; GCA
   * OAuth). v1 stores only `envVar`; these are surfaced in the UI so a founder
   * authenticated another way understands why the probe still passes.
   */
  alternativeEnvVars?: string[];
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  adapterType: string;
  kind: ProviderKind;
  credential: {
    apiKey?: ProviderApiKeySpec;
    /** True only when an in-app login exists AND can finish without a terminal. */
    selfCompletingLogin: boolean;
    /** Shown when login is not self-completing (copyable). */
    manualLoginCommand?: string;
  };
  installHint: { mac: string; win: string; linux: string; docsUrl?: string };
}

export const PROVIDER_CATALOG: readonly ProviderDescriptor[] = [
  {
    id: "anthropic",
    label: "Claude",
    adapterType: "claude_local",
    kind: "local_cli",
    credential: {
      apiKey: { envVar: "ANTHROPIC_API_KEY", secretName: "provider:anthropic", placeholder: "sk-ant-…" },
      selfCompletingLogin: false,
      manualLoginCommand: "claude auth login",
    },
    installHint: {
      mac: "npm i -g @anthropic-ai/claude-code",
      win: "npm i -g @anthropic-ai/claude-code",
      linux: "npm i -g @anthropic-ai/claude-code",
    },
  },
  {
    id: "openai",
    label: "Codex",
    adapterType: "codex_local",
    kind: "local_cli",
    credential: {
      apiKey: { envVar: "OPENAI_API_KEY", secretName: "provider:openai", placeholder: "sk-…" },
      selfCompletingLogin: true,
    },
    installHint: {
      mac: "npm i -g @openai/codex",
      win: "npm i -g @openai/codex",
      linux: "npm i -g @openai/codex",
    },
  },
  {
    id: "google",
    label: "Gemini",
    adapterType: "gemini_local",
    kind: "local_cli",
    credential: {
      apiKey: {
        envVar: "GEMINI_API_KEY",
        secretName: "provider:google",
        placeholder: "AIza…",
        alternativeEnvVars: ["GOOGLE_API_KEY"], // plus GCA OAuth (GOOGLE_GENAI_USE_GCA)
      },
      selfCompletingLogin: false,
      manualLoginCommand: "gemini auth login",
    },
    installHint: {
      mac: "npm i -g @google/gemini-cli",
      win: "npm i -g @google/gemini-cli",
      linux: "npm i -g @google/gemini-cli",
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    adapterType: "cursor",
    kind: "local_cli",
    credential: {
      apiKey: { envVar: "CURSOR_API_KEY", secretName: "provider:cursor", placeholder: "key_…" },
      selfCompletingLogin: false,
      manualLoginCommand: "agent login",
    },
    installHint: {
      mac: "Install Cursor and enable the `agent` CLI",
      win: "Install Cursor and enable the `agent` CLI",
      linux: "Install Cursor and enable the `agent` CLI",
    },
  },
  {
    id: "cursor_cloud",
    label: "Cursor Cloud",
    adapterType: "cursor_cloud",
    kind: "managed_api",
    credential: {
      // Shares CURSOR_API_KEY with `cursor` — SAME secretName on purpose so a
      // single save satisfies both. Do not "fix" this to provider:cursor_cloud.
      apiKey: { envVar: "CURSOR_API_KEY", secretName: "provider:cursor", placeholder: "key_…" },
      selfCompletingLogin: false,
    },
    installHint: {
      mac: "No install required — managed remote runtime.",
      win: "No install required — managed remote runtime.",
      linux: "No install required — managed remote runtime.",
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    adapterType: "opencode_local",
    kind: "local_cli",
    credential: { selfCompletingLogin: false, manualLoginCommand: "opencode auth login" },
    installHint: {
      mac: "brew install opencode",
      win: "npm i -g opencode",
      linux: "npm i -g opencode",
    },
  },
  {
    id: "grok",
    label: "Grok Build",
    adapterType: "grok_local",
    kind: "local_cli",
    credential: { selfCompletingLogin: false, manualLoginCommand: "grok login" },
    installHint: {
      mac: "npm i -g @xai/grok",
      win: "npm i -g @xai/grok",
      linux: "npm i -g @xai/grok",
    },
  },
  {
    id: "pi",
    label: "Pi",
    adapterType: "pi_local",
    kind: "local_cli",
    credential: {
      apiKey: { envVar: "XAI_API_KEY", secretName: "provider:pi", placeholder: "xai-…" },
      selfCompletingLogin: false,
    },
    installHint: {
      mac: "npm i -g @pi/cli",
      win: "npm i -g @pi/cli",
      linux: "npm i -g @pi/cli",
    },
  },
];

export function getProviderById(id: string): ProviderDescriptor | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

export function getProviderByAdapterType(adapterType: string): ProviderDescriptor | undefined {
  return PROVIDER_CATALOG.find((p) => p.adapterType === adapterType);
}
```

> **Verify install commands against each vendor's current docs during implementation.** If a package name cannot be confirmed, set `installHint.docsUrl` and use a "see docs" string rather than shipping a wrong command.

- [ ] **Step 4: Re-export from shared**

In `packages/shared/src/index.ts` add:

```ts
export * from "./providers/provider-catalog.js";
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/shared/src/providers/__tests__/provider-catalog.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/providers packages/shared/src/index.ts
git commit -m "feat(providers): add shared provider catalog"
```

---

## Task 4: Promote and harden the probe classifier

The classifier lives inside `commander-verify` and uses loose substring matching with three known bugs (§5.2 of the design).

**Files:**
- Create: `server/src/services/providers/classify-probe.ts`
- Create: `server/src/__tests__/classify-probe.test.ts`
- Modify: `server/src/services/commander-verify.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/classify-probe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyProbeOutcome } from "../services/providers/classify-probe.js";
import type { AdapterEnvironmentTestResult } from "@armyofagents/shared";

function result(status: "pass" | "warn" | "fail", codes: string[]): AdapterEnvironmentTestResult {
  return {
    adapterType: "claude_local",
    status,
    testedAt: new Date().toISOString(),
    checks: codes.map((code) => ({ code, level: "warn" as const, message: code })),
  };
}

describe("classifyProbeOutcome", () => {
  it("treats a clean pass as verified", () => {
    expect(classifyProbeOutcome(result("pass", ["claude_hello_probe_passed"])).outcome).toBe("verified");
  });

  it("detects auth-required probes", () => {
    expect(classifyProbeOutcome(result("warn", ["claude_hello_probe_auth_required"])).outcome).toBe("needs_auth");
    expect(classifyProbeOutcome(result("warn", ["grok_auth_required"])).outcome).toBe("needs_auth");
  });

  it("detects a missing binary", () => {
    expect(classifyProbeOutcome(result("fail", ["claude_command_unresolvable"])).outcome).toBe("not_installed");
  });

  // Gap 1: missing-key codes previously fell through to `verified`.
  it("treats a missing API key as needs_auth", () => {
    expect(classifyProbeOutcome(result("warn", ["codex_openai_api_key_missing"])).outcome).toBe("needs_auth");
    expect(classifyProbeOutcome(result("warn", ["cursor_api_key_missing"])).outcome).toBe("needs_auth");
  });

  // Gap 2: "install" substring previously swallowed package-install failures.
  it("does not classify a package install failure as not_installed", () => {
    expect(classifyProbeOutcome(result("fail", ["pi_package_install_failed"])).outcome).toBe("failed");
  });

  // A key-absence hint is NOT proof of subscription auth. The real check only
  // says login "can be used if Claude is logged in"
  // (packages/adapters/claude-local/src/server/test.ts:162-167), so on its own
  // it must NOT read as Ready.
  it("does not treat a subscription hint alone as authenticated", () => {
    expect(classifyProbeOutcome(result("warn", ["claude_subscription_mode_possible"])).outcome).toBe("unknown");
  });

  it("falls back to failed", () => {
    expect(classifyProbeOutcome(result("fail", ["claude_hello_probe_failed"])).outcome).toBe("failed");
  });

  // Gap 3: acpx emits missing-credential checks at info level, so the probe
  // returns status "pass" while unauthenticated. With NO live success signal
  // present, the credential hint must win.
  it("detects missing credentials when nothing proved the provider works", () => {
    expect(
      classifyProbeOutcome(result("pass", ["acpx_claude_credentials_missing"])).outcome,
    ).toBe("needs_auth");
    expect(
      classifyProbeOutcome(result("pass", ["acpx_codex_credentials_missing"])).outcome,
    ).toBe("needs_auth");
  });

  // ── COMPOSITE cases (the P1-3 regression) ────────────────────────────────
  // Real probes emit a missing-key HINT alongside a live success when the
  // provider is authenticated by OAuth / CLI login / subscription instead of a
  // key. Classifying these as needs_auth would tell a working founder to sign
  // in, forever, with no way to clear it.
  it("treats OAuth-backed Gemini as verified despite the missing-key hint", () => {
    expect(
      classifyProbeOutcome(result("warn", ["gemini_api_key_missing", "gemini_hello_probe_passed"])).outcome,
    ).toBe("verified");
  });

  it("treats CLI-login-backed Cursor as verified despite the missing-key hint", () => {
    expect(
      classifyProbeOutcome(result("warn", ["cursor_api_key_missing", "cursor_hello_probe_passed"])).outcome,
    ).toBe("verified");
  });

  it("treats subscription-auth Claude as verified despite no API key", () => {
    expect(
      classifyProbeOutcome(result("warn", ["claude_subscription_mode_possible", "claude_hello_probe_passed"])).outcome,
    ).toBe("verified");
  });

  it("still reports needs_auth when the live probe itself failed auth", () => {
    expect(
      classifyProbeOutcome(result("warn", ["gemini_api_key_missing", "gemini_hello_probe_auth_required"])).outcome,
    ).toBe("needs_auth");
  });

  it("prefers a real auth failure over a live success in the same result", () => {
    expect(
      classifyProbeOutcome(result("warn", ["grok_models_probe_passed", "grok_hello_probe_auth_required"])).outcome,
    ).toBe("needs_auth");
  });

  // ── Never claim Ready without proof (round-2 review) ─────────────────────
  it("does not treat a models-only success as authenticated", () => {
    // grok emits this whenever `grok models` exits 0, even unauthenticated.
    expect(classifyProbeOutcome(result("warn", ["grok_models_probe_passed"])).outcome).toBe("unknown");
  });

  it("reports a hello-probe timeout as unknown, not verified", () => {
    expect(classifyProbeOutcome(result("warn", ["claude_hello_probe_timed_out"])).outcome).toBe("unknown");
    expect(classifyProbeOutcome(result("warn", ["opencode_hello_probe_timed_out"])).outcome).toBe("unknown");
  });

  it("reports a deliberately skipped live probe as unverifiable, not unknown", () => {
    // A custom `command` makes the adapter skip the live probe entirely
    // (packages/adapters/claude-local/src/server/test.ts:173-180). We cannot
    // prove auth, but this is a valid operator choice.
    expect(
      classifyProbeOutcome(result("pass", ["claude_hello_probe_skipped_custom_command"])).outcome,
    ).toBe("unverifiable");
    expect(
      classifyProbeOutcome(result("pass", ["codex_hello_probe_skipped_custom_command"])).outcome,
    ).toBe("unverifiable");
  });

  // COMPOSITE: the realistic custom-command result. These adapters emit a
  // missing-key hint AND the skip code together; if hints were checked first
  // this would wrongly become needs_auth and block onboarding forever.
  it("prefers unverifiable over a credential hint for custom-command setups", () => {
    expect(
      classifyProbeOutcome(result("warn", [
        "codex_openai_api_key_missing", "codex_hello_probe_skipped_custom_command",
      ])).outcome,
    ).toBe("unverifiable");
    expect(
      classifyProbeOutcome(result("warn", [
        "gemini_api_key_missing", "gemini_hello_probe_skipped_custom_command",
      ])).outcome,
    ).toBe("unverifiable");
    expect(
      classifyProbeOutcome(result("warn", [
        "cursor_api_key_missing", "cursor_hello_probe_skipped_custom_command",
      ])).outcome,
    ).toBe("unverifiable");
  });

  it("still reports a real auth failure even with a skipped probe present", () => {
    expect(
      classifyProbeOutcome(result("warn", [
        "claude_hello_probe_skipped_custom_command", "claude_hello_probe_auth_required",
      ])).outcome,
    ).toBe("needs_auth");
  });

  it("reports quota exhaustion as unknown rather than Ready", () => {
    expect(classifyProbeOutcome(result("warn", ["gemini_hello_probe_quota_exhausted"])).outcome).toBe("unknown");
  });

  it("never returns verified without an authoritative success code", () => {
    const noSuccess = result("pass", ["some_adapter_info_note"]);
    expect(classifyProbeOutcome(noSuccess).outcome).not.toBe("verified");
  });
});
```

> **Code strings verified against the adapters** (do not re-invent them):
> - `_hello_probe_passed` — claude `test.ts:249`, codex `:282`, gemini `:227`, cursor `:198`, opencode `:266`, grok `:294`, pi `:291`
> - `_auth_ok` — cursor-cloud `test.ts:121`
> - `_hello_probe_skipped_custom_command` — claude `:173-180`, codex `:174-181`, gemini `:151-158`, cursor `:148-155`
>
> Still confirm `*_hello_probe_timed_out` / `gemini_hello_probe_quota_exhausted` when implementing. The invariant that matters: **no authoritative success ⇒ never `verified`.**

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/__tests__/classify-probe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/src/services/providers/classify-probe.ts`:

```ts
import type { AdapterEnvironmentTestResult } from "@armyofagents/shared";

/**
 * `unknown`      — inconclusive (timeout, unexpected output, quota). Renders
 *                  "Not verified". Never Ready. BLOCKS onboarding.
 * `unverifiable` — a custom `command` deliberately skips the live probe, so we
 *                  cannot check it. Renders "Can't verify (custom command)".
 *                  Blocks onboarding by default but MAY be explicitly waived by
 *                  the founder (Task 13b) — that setup was valid before this
 *                  feature and must stay reachable, without silently being
 *                  recorded as verified.
 */
export type ProbeOutcome =
  | "verified" | "needs_auth" | "not_installed" | "failed" | "unknown" | "unverifiable";

/**
 * Classify a probe result into a recovery outcome.
 *
 * Matching is on explicit code SUFFIXES rather than loose substrings: the old
 * `includes("install")` also matched `pi_package_install_failed`, and missing-key
 * codes matched nothing at all so they silently classified as verified.
 */
/**
 * Semantic precedence, NOT flat suffix matching.
 *
 * Critical: several adapters emit a missing-key HINT even when the provider is
 * genuinely authenticated by another mechanism. Gemini emits
 * `gemini_api_key_missing` at info level while OAuth works; Cursor emits
 * `cursor_api_key_missing` while a CLI login works; Claude treats a missing key
 * as compatible with subscription auth. In all three the SAME result also
 * carries a live `*_hello_probe_passed`.
 *
 * So authoritative execution evidence must outrank credential-presence hints.
 * Ordering them the other way tells a working founder "Needs sign-in" forever —
 * worse than the bug this feature exists to fix.
 */
/**
 * ONLY a live end-to-end execution proves authentication. `_models_probe_passed`
 * is deliberately NOT here: grok emits it whenever `grok models` exits zero,
 * even when `parsedModels.authenticated` is false
 * (`packages/adapters/grok-local/src/server/test.ts:185-214`).
 */
const AUTHORITATIVE_SUCCESS_SUFFIXES = ["_hello_probe_passed", "_auth_ok"];
const AUTH_FAILURE_SUFFIXES = ["_auth_required"];
const MISSING_BINARY_SUFFIXES = ["_command_unresolvable", "_not_installed"];
/** Non-authoritative: only meaningful when there is NO live success signal. */
const CREDENTIAL_HINT_SUFFIXES = ["_api_key_missing", "_credentials_missing"];
/** The probe could not reach a conclusion — never claim this is authenticated. */
const INCONCLUSIVE_SUFFIXES = [
  "_hello_probe_timed_out",
  "_hello_probe_unexpected_output",
  "_hello_probe_model_unavailable",
  "_quota_exhausted",
];

/**
 * The live probe was deliberately SKIPPED because the operator configured a
 * custom `command`. This is a legitimate, user-chosen setup — we simply cannot
 * verify it. It must be distinguished from `unknown` (a transient/inconclusive
 * result): treating it as unknown would permanently block onboarding for
 * configurations that worked before this feature existed.
 * Real codes, verified against the adapters:
 *   packages/adapters/claude-local/src/server/test.ts:175
 *   packages/adapters/codex-local/src/server/test.ts:176
 *   packages/adapters/gemini-local/src/server/test.ts:153
 *   packages/adapters/cursor-local/src/server/test.ts:150
 */
const SKIPPED_BY_DESIGN_SUFFIXES = ["_hello_probe_skipped_custom_command"];

export function classifyProbeOutcome(
  result: AdapterEnvironmentTestResult,
): { outcome: ProbeOutcome; result: AdapterEnvironmentTestResult } {
  const codes = result.checks.map((c) => c.code);
  const endsWithAny = (suffixes: string[]) =>
    codes.some((code) => suffixes.some((s) => code.endsWith(s)));

  // 1. A real runtime auth failure is authoritative and always wins.
  if (endsWithAny(AUTH_FAILURE_SUFFIXES)) return { outcome: "needs_auth", result };

  // 2. Only a live end-to-end success proves the provider actually runs. This
  //    outranks credential-presence hints (OAuth / subscription / CLI login).
  if (endsWithAny(AUTHORITATIVE_SUCCESS_SUFFIXES)) return { outcome: "verified", result };

  // 3. No binary at all.
  if (endsWithAny(MISSING_BINARY_SUFFIXES)) return { outcome: "not_installed", result };

  // 4. Deliberately unprobeable (operator configured a custom command). This MUST
  //    come BEFORE credential hints: a custom-command setup routinely ALSO emits
  //    `*_api_key_missing` (it authenticates by other means and the live probe
  //    never ran). Checking hints first would classify it needs_auth and
  //    reintroduce the permanent onboarding block this outcome exists to fix.
  if (endsWithAny(SKIPPED_BY_DESIGN_SUFFIXES)) return { outcome: "unverifiable", result };

  // 5. Credential hints count only when nothing proved the provider works and
  //    nothing explained why we couldn't check (catches acpx, whose
  //    missing-credential checks are info level).
  if (endsWithAny(CREDENTIAL_HINT_SUFFIXES)) return { outcome: "needs_auth", result };

  // 6. Hard failure.
  if (result.status === "fail") return { outcome: "failed", result };

  // 7. DEFAULT IS NOT "verified". A timeout, a models-only success, or any bare
  //    pass/warn means we never observed a working run. Claiming "Ready" here is
  //    exactly the false-green this feature exists to prevent.
  return { outcome: "unknown", result };
}
```

- [ ] **Step 4: Delegate from commander-verify**

In `server/src/services/commander-verify.ts`, delete the body of `classifyCommanderProbe` and delegate, keeping the exported name and type so callers are untouched:

```ts
import { classifyProbeOutcome } from "./providers/classify-probe.js";

// Widened: the shared classifier can now return `unknown` and `unverifiable`,
// so this union and every consumer must accept them or the types silently
// diverge from runtime behaviour.
export type CommanderVerifyOutcome =
  | "verified" | "needs_auth" | "not_installed" | "failed" | "unknown" | "unverifiable";

export function classifyCommanderProbe(result: AdapterEnvironmentTestResult) {
  return classifyProbeOutcome(result);
}
```

- [ ] **Step 4b: Update the verify route's blocking rule**

`server/src/routes/commander-verify.ts` currently returns `200` only for `verified` and `422` otherwise. `unverifiable` must ALSO return `200` — a custom-command Commander was a valid setup before this feature and must not become permanently unverifiable. `unknown`, `needs_auth`, `not_installed` and `failed` keep returning `422`.

Add route tests asserting exactly that matrix.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run server/src/__tests__/classify-probe.test.ts server/src/__tests__/ -t "commander-verify"`
Expected: PASS. Also run the onboarding step tests: `pnpm vitest run ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx` — Expected: PASS (blocking behaviour unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/providers/classify-probe.ts server/src/services/commander-verify.ts server/src/__tests__/classify-probe.test.ts
git commit -m "refactor(providers): promote and harden probe classifier"
```

---

## Task 5: Status cache table

**Files:**
- Create: `packages/db/src/schema/provider_readiness_status.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Write the schema**

```ts
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

/**
 * Cached result of the last provider readiness probe.
 *
 * SCOPED, not one row per (company, provider). Authentication is
 * configuration-specific: an agent's explicit `adapterConfig.env` binding WINS
 * over the company default key, so "the company default authenticates" does NOT
 * imply "this agent can run". A single unscoped row would let the UI show
 * "Ready" while Commander still 401s on its own revoked binding — the exact bug
 * class this feature exists to eliminate.
 *
 *   scopeType "company_default" -> scopeId null  (company key / host login only)
 *   scopeType "agent"           -> scopeId = agents.id (that agent's real config)
 */
export const providerReadinessStatus = pgTable(
  "provider_readiness_status",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    scopeType: text("scope_type", { enum: ["company_default", "agent"] }).notNull(),
    /** Null for company_default; the agent id for agent scope. */
    scopeId: uuid("scope_id"),
    outcome: text("outcome", {
      enum: ["verified", "needs_auth", "not_installed", "failed", "unknown", "unverifiable"],
    }).notNull(),
    /** Redacted before insert — probe messages can echo credential material. */
    checks: jsonb("checks")
      .$type<{ code: string; level: string; message: string; hint?: string }[]>()
      .notNull()
      .default([]),
    testedAt: timestamp("tested_at", { withTimezone: true }).notNull().defaultNow(),
    testedByUserId: text("tested_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
  },
  (t) => ({
    /**
     * `nullsNotDistinct()` is REQUIRED. Postgres treats NULLs as distinct, so
     * without it every `company_default` row (scope_id IS NULL) is unique and
     * the upsert target never matches — producing duplicate default rows and
     * unstable cache reads. Same pattern as
     * `packages/db/src/schema/plugin_state.ts:68-83`. Requires PostgreSQL 15+.
     */
    scopeUq: unique("provider_readiness_scope_uq")
      .on(t.companyId, t.providerId, t.scopeType, t.scopeId)
      .nullsNotDistinct(),
  }),
);
```

Import `unique` (not `uniqueIndex`) from `drizzle-orm/pg-core`.

- [ ] **Step 1b: Test the NULL-scope upsert explicitly**

Add an integration test that inserts a `company_default` row twice for the same `(company, provider)` and asserts the second call **updates** rather than creating a duplicate, and that `readReadiness` returns exactly one default row.

- [ ] **Step 2: Export it**

Add to `packages/db/src/schema/index.ts`:

```ts
export * from "./provider_readiness_status.js";
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: the **next** migration file (currently `0174_*.sql`, since the repo ends at `0173_shocking_naoko.sql` — do not hard-code the number; a rebase can shift it) creating `provider_readiness_status`.
**Never hand-write the SQL** (CLAUDE.md rule #1).

> **REPO CONVENTION — applies to EVERY schema task in this plan (discovered in Task 5).**
> `packages/db/src/__tests__/migration-idempotency.test.ts` fails CI on any new `CREATE TABLE` / `ALTER TABLE ... ADD COLUMN` that lacks `IF NOT EXISTS`, and drizzle-kit never emits it. So you MUST hand-edit the *generated* file to add `IF NOT EXISTS` (precedent: migration 0080 / PR #121). "Never hand-write the SQL" means **never author a migration by hand instead of generating it** — it does not mean the generated file is untouchable. Run that idempotency test before committing.
>
> Two further gotchas from Task 5:
> - **Do not import the shared barrel into a schema file.** drizzle-kit loads the schema graph through a CJS require hook; `@armyofagents/shared` resolves to `src/index.ts` and dies on its own relative specifier (`MODULE_NOT_FOUND`), breaking `db:generate`. Deep-import instead (e.g. `@armyofagents/shared/probe-outcome`), as `@armyofagents/shared/marketplace` already does. Type-only imports are unaffected.
> - **A drizzle `enum` on a `text` column is type-level only** — it emits no DB CHECK. The database will accept any string, so the writing service must validate; do not rely on the schema to reject a bad value. Inspect the generated SQL to confirm the scoped unique index behaves correctly with NULL `scope_id`.

- [ ] **Step 4: Verify it applies**

Restart the dev instance and confirm the banner reports migrations applied with no error.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/provider_readiness_status.ts packages/db/src/schema/index.ts packages/db/src/migrations
git commit -m "feat(db): add provider_readiness_status cache table"
```

---

## Task 6: Readiness service (probe + cache)

**Files:**
- Create: `server/src/services/providers/readiness.ts`
- Create: `server/src/__tests__/provider-readiness-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { isStale, selectInUseProviders } from "../services/providers/readiness.js";

describe("readiness staleness", () => {
  it("is stale when older than the threshold", () => {
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    expect(isStale(old, 5 * 60_000)).toBe(true);
  });
  it("is fresh inside the threshold", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    expect(isStale(recent, 5 * 60_000)).toBe(false);
  });
  it("treats a missing timestamp as stale", () => {
    expect(isStale(null, 5 * 60_000)).toBe(true);
  });
});

describe("in-use provider selection", () => {
  it("includes Commander's adapter and every live agent adapter", () => {
    const ids = selectInUseProviders({
      commanderAdapterType: "claude_local",
      agentAdapterTypes: ["codex_local", "codex_local", "gemini_local"],
    });
    expect(ids.sort()).toEqual(["anthropic", "google", "openai"]);
  });
  it("ignores adapters with no catalog entry", () => {
    const ids = selectInUseProviders({
      commanderAdapterType: "claude_local",
      agentAdapterTypes: ["process", "http"],
    });
    expect(ids).toEqual(["anthropic"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/__tests__/provider-readiness-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helpers**

Create `server/src/services/providers/readiness.ts`:

```ts
import { getProviderByAdapterType } from "@armyofagents/shared";

export const READINESS_STALE_MS = 5 * 60_000;

export function isStale(testedAt: string | null, thresholdMs = READINESS_STALE_MS): boolean {
  if (!testedAt) return true;
  const t = Date.parse(testedAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > thresholdMs;
}

/**
 * "In use" = Commander's configured adapter, plus any adapter used by at least
 * one non-archived agent. Only these are auto-refreshed on page load; everything
 * else renders from cache until the user presses Test.
 */
export function selectInUseProviders(input: {
  commanderAdapterType: string | null;
  agentAdapterTypes: string[];
}): string[] {
  const types = [
    ...(input.commanderAdapterType ? [input.commanderAdapterType] : []),
    ...input.agentAdapterTypes,
  ];
  const ids = new Set<string>();
  for (const t of types) {
    const descriptor = getProviderByAdapterType(t);
    if (descriptor) ids.add(descriptor.id);
  }
  return [...ids];
}
```

- [ ] **Step 4: Add the DB-backed service functions**

Append to the same file — `readReadiness(db, companyId)` returning cached rows, and `recordReadiness(db, {companyId, providerId, outcome, checks, testedByUserId})` doing an upsert via `onConflictDoUpdate` targeting the **four-column** `provider_readiness_scope_uq` (`companyId, providerId, scopeType, scopeId`) — there is NO `(companyId, providerId)` index, and targeting one fails at runtime on the first write. Follow the service shape in `server/src/services/goals.ts`.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run server/src/__tests__/provider-readiness-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/providers/readiness.ts server/src/__tests__/provider-readiness-service.test.ts
git commit -m "feat(providers): readiness service with status caching"
```

---

## Task 7: Company-level provider key service

**Files:**
- Create: `server/src/services/providers/provider-key.ts`
- Create: `server/src/__tests__/provider-key-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { secretNameForProvider, envVarForProvider } from "../services/providers/provider-key.js";

describe("provider key naming", () => {
  it("uses the reserved provider: namespace", () => {
    expect(secretNameForProvider("anthropic")).toBe("provider:anthropic");
  });
  it("maps providers to their env var", () => {
    expect(envVarForProvider("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(envVarForProvider("openai")).toBe("OPENAI_API_KEY");
    expect(envVarForProvider("google")).toBe("GEMINI_API_KEY");
  });
  it("rejects a provider that cannot take an API key", () => {
    expect(() => envVarForProvider("opencode")).toThrow(/does not support an API key/i);
  });
  it("rejects an unknown provider", () => {
    expect(() => envVarForProvider("nope")).toThrow(/unknown provider/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/__tests__/provider-key-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { getProviderById } from "@armyofagents/shared";

export function secretNameForProvider(providerId: string): string {
  const d = getProviderById(providerId);
  if (!d) throw new Error(`Unknown provider: ${providerId}`);
  if (!d.credential.apiKey) throw new Error(`Provider ${providerId} does not support an API key.`);
  return d.credential.apiKey.secretName;
}

export function envVarForProvider(providerId: string): string {
  const d = getProviderById(providerId);
  if (!d) throw new Error(`Unknown provider: ${providerId}`);
  if (!d.credential.apiKey) throw new Error(`Provider ${providerId} does not support an API key.`);
  return d.credential.apiKey.envVar;
}
```

- [ ] **Step 4: Add the save function**

Add `saveProviderKey(db, { companyId, providerId, value, actorUserId })` that, in ONE transaction, mirrors `server/src/services/commander-key.ts`: create-or-rotate-or-reactivate the `company_secrets` row named `secretNameForProvider(providerId)` with key `envVarForProvider(providerId)`, and write an `activity_log` row `provider.key.<operation>` with `entityId = secretId`. **The raw value is never logged and never returned.**

It must **not** write into any agent's `adapterConfig.env` — that is the difference from `commander-key.ts` and the guarantee behind Task 8's regression test.

- [ ] **Step 5: Run tests + commit**

Run: `pnpm vitest run server/src/__tests__/provider-key-service.test.ts` → PASS

```bash
git add server/src/services/providers/provider-key.ts server/src/__tests__/provider-key-service.test.ts
git commit -m "feat(providers): company-level provider key service"
```

---

## Task 8: Company-key fallback in runtime resolution

**This task changes a shared signature.** `resolveAdapterConfigForRuntime(companyId, adapterConfig, context)` (verified at `server/src/services/secrets.ts:819-826`) has **no adapter context**, and the adapter type cannot be inferred from the config — several adapters share `env`, `model`, `cwd`, `command`. Without threading it in we would have to guess (wrong credential into a CLI), inject every company key (secret over-exposure), or silently skip the fallback (feature appears saved but never applies). So `adapterType` becomes an explicit parameter and every call site passes its already-known value.

**Files:**
- Modify: `server/src/services/secrets.ts` (`resolveAdapterConfigForRuntime`, line 819)
- Modify (call sites, all 6): `server/src/routes/agents.ts:339`, `server/src/routes/agents.ts:564`, `server/src/routes/agents.ts:1894`, `server/src/services/commander-verify.ts:36`, `server/src/services/company-skills.ts:1453`, `server/src/services/internal-agent/aoa-agents/runner.ts:452`
- Create: `server/src/__tests__/provider-key-fallback.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { applyCompanyKeyFallback } from "../services/secrets.js";

describe("company provider key fallback", () => {
  it("fills the env var when the agent has no binding", () => {
    const out = applyCompanyKeyFallback(
      { env: {} },
      "claude_local",
      { ANTHROPIC_API_KEY: "company-key" },
    );
    expect(out.env.ANTHROPIC_API_KEY).toBe("company-key");
  });

  it("NEVER overrides an existing agent binding", () => {
    const out = applyCompanyKeyFallback(
      { env: { ANTHROPIC_API_KEY: "agent-key" } },
      "claude_local",
      { ANTHROPIC_API_KEY: "company-key" },
    );
    expect(out.env.ANTHROPIC_API_KEY).toBe("agent-key");
  });

  it("does not mutate the input config", () => {
    const input = { env: { ANTHROPIC_API_KEY: "agent-key" } };
    applyCompanyKeyFallback(input, "claude_local", { ANTHROPIC_API_KEY: "company-key" });
    expect(input.env.ANTHROPIC_API_KEY).toBe("agent-key");
  });

  it("leaves the config alone when the adapter has no catalog entry", () => {
    const out = applyCompanyKeyFallback({ env: {} }, "process", { ANTHROPIC_API_KEY: "x" });
    expect(out.env).toEqual({});
  });

  // ── Security / correctness (P1-2) ────────────────────────────────────────
  it("NEVER injects another provider's key into this adapter", () => {
    const out = applyCompanyKeyFallback({ env: {} }, "claude_local", {
      OPENAI_API_KEY: "openai-key",
      CURSOR_API_KEY: "cursor-key",
    });
    expect(out.env).toEqual({});
  });

  it("injects only the descriptor's own env var when several keys exist", () => {
    const out = applyCompanyKeyFallback({ env: {} }, "claude_local", {
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
    });
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "anthropic-key" });
  });

  it("treats an explicit empty override as intentional and does not fill it", () => {
    const out = applyCompanyKeyFallback({ env: { ANTHROPIC_API_KEY: "" } }, "claude_local", {
      ANTHROPIC_API_KEY: "company-key",
    });
    expect(out.env.ANTHROPIC_API_KEY).toBe("");
  });

  it("preserves non-env adapter fields", () => {
    const out = applyCompanyKeyFallback(
      { env: {}, model: "sonnet", cwd: "/tmp", command: "claude" },
      "claude_local",
      { ANTHROPIC_API_KEY: "k" },
    );
    expect(out.model).toBe("sonnet");
    expect(out.cwd).toBe("/tmp");
    expect(out.command).toBe("claude");
  });

  it("handles an unknown adapter type without throwing", () => {
    expect(() => applyCompanyKeyFallback({ env: {} }, "totally_unknown", {})).not.toThrow();
  });
});
```

Additionally add an integration test per runtime caller (`agents.ts` ×3, `commander-verify`, `company-skills`, `aoa-agents/runner`) asserting each passes a real adapter type and that a company key actually reaches the spawned subprocess env — the feature is worthless if it is stored but never applied.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/__tests__/provider-key-fallback.test.ts`
Expected: FAIL — `applyCompanyKeyFallback` is not exported.

- [ ] **Step 3: Implement**

Add to `server/src/services/secrets.ts`. Note it takes and returns the **whole config**, not just `{ env }` — returning only env would silently drop `model`, `cwd`, `command` and every other adapter field.

```ts
import { getProviderByAdapterType } from "@armyofagents/shared";

/**
 * Resolution chain step 2 (design D4): apply the company-level provider key ONLY
 * when the resolved agent config has no value for that env var. Per-agent
 * overrides always win and are never rewritten.
 *
 * Exactly ONE descriptor is consulted — the one for this adapter — so a company
 * key for another provider can never leak into this subprocess.
 */
export function applyCompanyKeyFallback(
  config: Record<string, unknown>,
  adapterType: string,
  companyKeys: Record<string, string>,
): Record<string, unknown> {
  const descriptor = getProviderByAdapterType(adapterType);
  const envVar = descriptor?.credential.apiKey?.envVar;
  if (!envVar) return config;

  const env = { ...((config.env as Record<string, string> | undefined) ?? {}) };
  const existing = env[envVar];
  // Treat an explicitly-set empty string as an intentional override: do NOT
  // overwrite it. Only a genuinely absent value falls back.
  if (existing === undefined && companyKeys[envVar] !== undefined) {
    env[envVar] = companyKeys[envVar];
  }
  return { ...config, env };
}
```

Then change the method signature and thread `adapterType` through:

```ts
async resolveAdapterConfigForRuntime(
  companyId: string,
  adapterType: string,
  adapterConfig: Record<string, unknown>,
  context: Omit<SecretConsumerContext, "configPath">,
) {
  const resolved = { ...adapterConfig };
  resolved.env = await this.resolveEnvBindings(companyId, adapterConfig.env, context);
  const companyKeys = await this.resolveCompanyProviderKeys(companyId, adapterType, context);
  return applyCompanyKeyFallback(resolved, adapterType, companyKeys);
}
```

`resolveCompanyProviderKeys` looks up **only** the `provider:<id>` secret for this adapter's descriptor, skips inactive/archived/deleted rows, and records access through the existing `SecretConsumerContext` audit path.

- [ ] **Step 3b: Update all six call sites**

Each already knows its adapter type — pass it, do not infer it:

| Call site | Value to pass |
|---|---|
| `server/src/routes/agents.ts:339` | the agent's `adapterType` |
| `server/src/routes/agents.ts:564` | the route's `:type` param |
| `server/src/routes/agents.ts:1894` | the agent's `adapterType` |
| `server/src/services/commander-verify.ts:36` | **See note below** — `resolveCommanderProbeConfig` has no `cliTool`/adapter argument, so it must gain an `adapterType` parameter supplied by its caller |
| `server/src/services/company-skills.ts:1453` | the adapter selected for the run |
| `server/src/services/internal-agent/aoa-agents/runner.ts:452` | the runner's resolved adapter type |

TypeScript will fail the build until every site is updated — that is the safety net; do not add a default value for `adapterType`, since a default would silently reintroduce the guessing problem.

**Commander call site — signature change required.** `resolveCommanderProbeConfig(db, companyId, actorId)` (`server/src/services/commander-verify.ts:17-41`) does **not** receive `cliTool` or an adapter type, so it cannot compute one locally. The caller already has it: `server/src/routes/commander-verify.ts:36-45` resolves `adapterType` via `resolveCommanderAdapterType` before calling. So:

```ts
// server/src/services/commander-verify.ts
export async function resolveCommanderProbeConfig(
  db: Db,
  companyId: string,
  adapterType: string,   // NEW — supplied by the route, which already resolved it
  actorId: string,
) {
  // …unchanged agent lookup…
  return secretService(db).resolveAdapterConfigForRuntime(companyId, adapterType, adapterConfig, { … });
}
```

Update `server/src/routes/commander-verify.ts` to pass its already-resolved `adapterType`, and update `server/src/__tests__/commander-verify-route.test.ts` plus any direct unit tests of the helper for the new arity.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run server/src/__tests__/provider-key-fallback.test.ts` → PASS
Run the existing secrets suite to confirm no regression: `pnpm vitest run server/src/__tests__/ -t "secrets"` → PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/secrets.ts server/src/__tests__/provider-key-fallback.test.ts
git commit -m "feat(providers): company key fallback in runtime resolution"
```

---

## Task 9: Provider routes

**Files:**
- Create: `server/src/routes/providers.ts`
- Create: `server/src/__tests__/providers-routes.test.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: Write the failing contract test**

Assert the response shape **exactly matches `ProviderStatusRow` in Task 10** (they must not drift):

The shape is **scoped** — one flat outcome per provider is exactly what allowed the false-green (P1-1):

```ts
// GET /companies/:cid/providers
interface ScopedReadiness {
  scopeType: "company_default" | "agent";
  scopeId: string | null;          // agent id for agent scope, null for default
  agentName?: string;              // present for agent scope, for UI labelling
  // Must stay in sync with ProbeOutcome — including `unverifiable`.
  outcome: "verified" | "needs_auth" | "not_installed" | "failed" | "unknown" | "unverifiable";
  testedAt: string | null;
  checks: { code: string; level: string; message: string; hint?: string }[];
}

{ providers: [ { descriptor: ProviderDescriptor,
                 companyDefault: ScopedReadiness,      // always present
                 agents: ScopedReadiness[] } ] }       // in-use agents for this provider
```

`outcome` is `"unknown"` when no cached row exists (never probed). The UI derives the card badge from BOTH: it may only show a plain "Ready" when the company default is `verified` **and** no in-use agent is failing; otherwise it shows the company-default state plus a count/list of agents needing attention. Also assert: `POST /companies/:cid/providers/:id/test` returns `{ outcome, checks, testedAt }`; `POST /companies/:cid/providers/:id/key` returns `{ ok: true, secretId }` and **never** echoes the key; unknown provider → 404; non-founder POST → 403; GET allowed for config-readers.

Follow the mocking style in `server/src/__tests__/issues-responsible-user-routes.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/__tests__/providers-routes.test.ts`
Expected: FAIL — route module missing.

- [ ] **Step 3: Implement the router**

Create `server/src/routes/providers.ts` following the structure of `server/src/routes/goals.ts`:

- `GET /` — merge `PROVIDER_CATALOG` with cached rows from `readReadiness`. Guard `assertCanReadConfigurations`. Returns **both scopes**: the `company_default` outcome plus any `agent`-scoped outcomes for in-use agents (P1-1), so the UI can distinguish "company default works" from "this agent works".

- `POST /:providerId/test?scope=company_default|agent&agentId=…` — resolve descriptor (404 if unknown). For `company_default`, probe with the company key / host login only. For `agent`, probe using **that agent's actual persisted `adapterConfig`** resolved through `resolveAdapterConfigForRuntime` — this is what makes the badge honest. Then `classifyProbeOutcome` → `recordReadiness` into the matching scope row.

  **RBAC (resolves the contradiction Codex flagged):** this endpoint spawns a subprocess *and writes* the cache, so it is not a pure read. Guard it with `assertCanReadConfigurations` for the probe **but** rate-limit per company and treat the cache write as a side effect of an authorized read. Founder-gating it would break the agent-page badge for team leads. Document this choice inline; the design's "writes are founder-gated" rule applies to **credential mutations** (key/login), not probe caching.

- `POST /:providerId/key` — founder-gated (explicit board-actor check → `assertCompanyAccess` → `assertRole(..., "founder")`, matching `commander-key.ts`), call `saveProviderKey`, then re-probe **only the `company_default` scope** and record. It must NOT overwrite agent-scoped rows — an agent with its own revoked binding must stay red (P1-1).

  **Credential-group invalidation:** Cursor and Cursor Cloud share one stored secret (`provider:cursor`), so saving either one changes the credential for BOTH. Re-probe (or at minimum invalidate the cached `company_default` row of) **every descriptor whose `credential.apiKey.secretName` matches the one just written** — otherwise the sibling card keeps showing a stale status derived from the old key. Add a test: saving the Cursor key must not leave Cursor Cloud's cached status stale.

**Redaction (P2):** probe `checks` may echo credential material in messages/hints. Route every result through a redactor **before** it is persisted to `provider_readiness_status` and before it is returned over HTTP. Reuse the existing redaction helper used by the feedback/telemetry pipeline rather than writing a new one.

**Concurrency:** if a probe for the same `(company, provider, scope)` is already running, return `429` rather than spawning a second CLI.

- [ ] **Step 4: Mount it**

In `server/src/app.ts`, next to the other company-scoped routers:

```ts
app.use("/api/companies/:companyId/providers", providerRoutes(db));
```

- [ ] **Step 5: Run tests + commit**

Run: `pnpm vitest run server/src/__tests__/providers-routes.test.ts` → PASS

```bash
git add server/src/routes/providers.ts server/src/app.ts server/src/__tests__/providers-routes.test.ts
git commit -m "feat(providers): provider readiness + key routes"
```

---

## Task 9b: Generalize the interactive login routes

Without this, the Providers tab cannot offer Sign in for Codex — the one provider whose login actually works today. The login *lifecycle* is already provider-agnostic; only the entry points hardcode `"anthropic" | "openai"`.

**Files:**
- Create: `server/src/services/providers/provider-login.ts`
- Modify: `server/src/routes/providers.ts`
- Modify: `server/src/services/commander-login-runtime.ts`
- Create: `server/src/__tests__/provider-login-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveLoginCapability } from "../services/providers/provider-login.js";

describe("provider login capability", () => {
  it("allows login for a self-completing provider", () => {
    expect(resolveLoginCapability("openai").canLogin).toBe(true);
  });
  it("refuses login for a provider whose CLI cannot self-complete", () => {
    const cap = resolveLoginCapability("anthropic");
    expect(cap.canLogin).toBe(false);
    expect(cap.manualCommand).toBe("claude auth login");
  });
  it("refuses login for a provider with no login at all", () => {
    expect(resolveLoginCapability("pi").canLogin).toBe(false);
  });
  it("throws on an unknown provider", () => {
    expect(() => resolveLoginCapability("nope")).toThrow(/unknown provider/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/__tests__/provider-login-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the capability resolver**

Create `server/src/services/providers/provider-login.ts`:

```ts
import { getProviderById } from "@armyofagents/shared";

export interface LoginCapability {
  canLogin: boolean;
  manualCommand?: string;
}

/**
 * A provider may only expose an in-app Sign in button when its CLI login can
 * finish WITHOUT a terminal. Everything else surfaces a copyable command so we
 * never render a button that cannot complete (design §4).
 */
export function resolveLoginCapability(providerId: string): LoginCapability {
  const d = getProviderById(providerId);
  if (!d) throw new Error(`Unknown provider: ${providerId}`);
  return d.credential.selfCompletingLogin
    ? { canLogin: true }
    : { canLogin: false, ...(d.credential.manualLoginCommand ? { manualCommand: d.credential.manualLoginCommand } : {}) };
}
```

- [ ] **Step 4: Add the three login routes**

In `server/src/routes/providers.ts`, add founder-gated:
- `POST /:providerId/login/start` — 400 when `resolveLoginCapability(providerId).canLogin` is false; otherwise delegate to the existing login service, passing the provider id through instead of the hardcoded enum.
- `GET /:providerId/login/:challengeId` — poll status.
- `POST /:providerId/login/:challengeId/cancel` — cancel.

In `commander-login-runtime.ts`, replace the `provider === "openai" ? … : …` ternaries for `resolveAuthHome` / `runLogin` / `credentialFile` with a lookup keyed by provider id, so adding a provider in Stage B is a registry entry rather than a new branch.

- [ ] **Step 5: Assert the cross-tenant conflict is surfaced**

Add a test that a `pending` challenge owned by another company returns **409** and that the route maps it to a readable message (the login slot is keyed `(provider, authHome)` and is host-shared).

- [ ] **Step 6: Verify onboarding still works**

Run: `pnpm vitest run server/src/__tests__/ -t "commander-login"` and `pnpm vitest run ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx`
Expected: PASS — the existing `commander-login/*` routes must keep their contract.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/providers/provider-login.ts server/src/routes/providers.ts server/src/services/commander-login-runtime.ts server/src/__tests__/provider-login-routes.test.ts
git commit -m "feat(providers): generalize interactive login routes"
```

---

## Task 10: UI API client

**Files:**
- Create: `ui/src/api/providers.ts`

- [ ] **Step 1: Implement**

```ts
import type { ProviderDescriptor } from "@armyofagents/shared";
import { api } from "./client";

/** Mirrors the server union exactly. Adding a value here without updating the
 *  badge switch must fail the build — keep the switch exhaustive. */
export type ProbeOutcome =
  | "verified" | "needs_auth" | "not_installed" | "failed" | "unknown" | "unverifiable";

export interface ScopedReadiness {
  scopeType: "company_default" | "agent";
  scopeId: string | null;
  agentName?: string;
  outcome: ProbeOutcome;
  testedAt: string | null;
  checks: { code: string; level: string; message: string; hint?: string }[];
}

export interface ProviderStatusRow {
  descriptor: ProviderDescriptor;
  /** Company key / host login only. */
  companyDefault: ScopedReadiness;
  /** In-use agents on this provider, each probed with its OWN config. */
  agents: ScopedReadiness[];
}

/**
 * A card may only claim plain "Ready" when the company default is verified AND
 * no in-use agent is failing. Otherwise the tab would show green while an
 * agent's own (revoked) binding still 401s — the P1-1 false-green.
 *
 * `unverifiable` agents are deliberately NOT counted as failures — nothing is
 * broken, we simply cannot check a custom command. They still prevent a bare
 * "Ready" claim, but must be surfaced as UNCHECKED, not as errors, or the tab
 * cries wolf on a working setup.
 *
 * Do NOT call these "waived": a waiver is a recorded human decision, and the
 * only place one exists is the onboarding step (Task 13b). Labelling an
 * unprobed agent "waived" would fabricate consent nobody gave.
 */
export function deriveCardStatus(row: ProviderStatusRow): {
  outcome: ProbeOutcome;
  failingAgents: ScopedReadiness[];
  unverifiableAgents: ScopedReadiness[];
  canClaimReady: boolean;
} {
  const failingAgents = row.agents.filter(
    (a) => a.outcome !== "verified" && a.outcome !== "unverifiable",
  );
  const unverifiableAgents = row.agents.filter((a) => a.outcome === "unverifiable");
  return {
    outcome: row.companyDefault.outcome,
    failingAgents,
    unverifiableAgents,
    canClaimReady:
      row.companyDefault.outcome === "verified" &&
      failingAgents.length === 0 &&
      unverifiableAgents.length === 0,
  };
}

export const providersApi = {
  list: (companyId: string) =>
    api.get<{ providers: ProviderStatusRow[] }>(`/companies/${companyId}/providers`),

  /**
   * Probe a specific SCOPE. Omitting `agentId` probes the company default;
   * passing one probes that agent with its own persisted adapterConfig. Task 13's
   * agent badge cannot work without these parameters.
   */
  test: (
    companyId: string,
    providerId: string,
    scope: { scopeType: "company_default" } | { scopeType: "agent"; agentId: string } = { scopeType: "company_default" },
  ) => {
    const qs = new URLSearchParams({ scope: scope.scopeType });
    if (scope.scopeType === "agent") qs.set("agentId", scope.agentId);
    return api.post<ScopedReadiness>(
      `/companies/${companyId}/providers/${providerId}/test?${qs.toString()}`, {},
    );
  },

  saveKey: (companyId: string, providerId: string, value: string) =>
    api.post<{ ok: boolean; secretId: string }>(
      `/companies/${companyId}/providers/${providerId}/key`, { value },
    ),

  // Login (Task 9b). Only offered when descriptor.credential.selfCompletingLogin.
  startLogin: (companyId: string, providerId: string) =>
    api.post<{ challengeId: string; loginUrl: string }>(
      `/companies/${companyId}/providers/${providerId}/login/start`, {},
    ),

  loginStatus: (companyId: string, providerId: string, challengeId: string) =>
    api.get<{ status: "pending" | "completed" | "failed" | "timeout"; loginUrl: string | null }>(
      `/companies/${companyId}/providers/${providerId}/login/${challengeId}`,
    ),

  cancelLogin: (companyId: string, providerId: string, challengeId: string) =>
    api.post<{ ok: boolean }>(
      `/companies/${companyId}/providers/${providerId}/login/${challengeId}/cancel`, {},
    ),
};
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/api/providers.ts
git commit -m "feat(providers): ui api client"
```

---

## Task 11: Shared ProviderReadinessCard component

**Files:**
- Create: `ui/src/components/providers/ProviderReadinessCard.tsx`
- Create: `ui/src/components/providers/__tests__/ProviderReadinessCard.test.tsx`

- [ ] **Step 1: Write the failing test**

Assert, with React Testing Library (follow `ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx`):
- renders the provider label and a status badge for **every** outcome — the switch must be exhaustive over `ProbeOutcome` so a future value fails the build:
  `verified`→"Ready" · `needs_auth`→"Needs sign-in" · `not_installed`→"Not installed" · `failed`→"Check failed" · `unknown`→"Not verified" · `unverifiable`→"Can't verify (custom command)";
- `unverifiable` renders in a neutral tone, **not** the error/red treatment — nothing is broken;
- a card whose company default is verified but which has a failing agent does NOT render a plain "Ready" (uses `deriveCardStatus().canClaimReady`);
- `unverifiableAgents` are listed separately from `failingAgents` under neutral copy such as "Can't be checked (custom command)" — **never** "waived", which would imply a consent the user never gave;
- renders "checked …" only when `testedAt` is set;
- decides the key input via the client's `keyInputState(row)` — **not** by checking `descriptor.credential.apiKey`. Borrowers (Pi, Cursor Cloud) declare their own `apiKey` spec, so the naive check renders a SECOND input writing the owner's secret, and saving either silently overwrites the other. `owned_elsewhere` must render a link to the owner's card; `hidden` (no `envVar`, e.g. OpenCode) renders no input;
- shows a `Sign in` button **only** when `credential.selfCompletingLogin` is true;
- shows the copyable `manualLoginCommand` when login is not self-completing;
- shows the OS install hint when outcome is `not_installed`;
- calls `onTest` when Test is pressed.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run ui/src/components/providers/__tests__/ProviderReadinessCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Props: `{ row: ProviderStatusRow; onTest(): void; onSaveKey(value: string): Promise<void>; onStartLogin?(): void; busy?: boolean }`. Pure presentational — it owns no fetching, so all three surfaces can supply their own handlers. Status badge colours follow the existing `AdapterEnvironmentResult` palette in `ui/src/components/AgentConfigForm.tsx:1169`.

Include the D5 scope labels: "Key saved for this company" under the key input, and "Signed in on this machine (shared by all companies on this host)" under the sign-in action.

- [ ] **Step 4: Run tests + commit**

Run: `pnpm vitest run ui/src/components/providers/__tests__/ProviderReadinessCard.test.tsx` → PASS

```bash
git add ui/src/components/providers
git commit -m "feat(providers): shared readiness card component"
```

---

## Task 12: Settings → Providers tab

**Files:**
- Create: `ui/src/components/settings/sections/ProvidersSection.tsx`
- Modify: `ui/src/components/settings/SettingsLayout.tsx`
- Modify: `ui/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Register the section id**

In `SettingsLayout.tsx` add `"providers"` to the `SettingsSectionId` union and add to the **Operations** group in `SETTINGS_SECTIONS`:

```ts
{ id: "providers", label: "Providers", description: "Install and sign in to your AI CLIs" },
```

- [ ] **Step 2: Wire the route**

In `SettingsPage.tsx` add `"providers"` to `VALID_SECTIONS` and a case to `renderActiveSection()`:

```tsx
case "providers":
  return <ProvidersSection companyId={companyId} />;
```

The `default` branch is an exhaustive `never`, so TypeScript fails the build until this case exists.

- [ ] **Step 3: Implement the section**

`ProvidersSection` fetches `providersApi.list` with TanStack Query, renders a `ProviderReadinessCard` per row, wires `onTest` → `providersApi.test` (invalidating the list), `onSaveKey` → `providersApi.saveKey`, and adds a `Test all` button that fires them sequentially so the machine isn't hammered.

**It MUST also wire the full login lifecycle** (P1-4). The card renders a Sign-in button whenever `selfCompletingLogin` is true, so a missing handler ships a dead button. Mirror the proven lifecycle in `ui/src/onboarding/steps/VerifyStep.tsx:160-194` — do not invent a new one:

```tsx
const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
const activeLoginRef = useRef<{ providerId: string; challengeId: string } | null>(null);

const clearPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

const startLogin = async (providerId: string) => {
  const { challengeId, loginUrl } = await providersApi.startLogin(companyId, providerId);
  activeLoginRef.current = { providerId, challengeId };
  setLogin({ providerId, challengeId, loginUrl, status: "pending" });
  clearPoll();
  pollRef.current = setInterval(() => void poll(providerId, challengeId), 2500);
  void poll(providerId, challengeId); // poll once immediately
};

const poll = async (providerId: string, challengeId: string) => {
  try {
    const { status } = await providersApi.loginStatus(companyId, providerId, challengeId);
    setLogin((p) => (p ? { ...p, status } : p));
    if (status === "completed") {
      clearPoll(); activeLoginRef.current = null; setLogin(null);
      await providersApi.test(companyId, providerId);      // re-probe so the badge updates
      queryClient.invalidateQueries({ queryKey: ["providers", companyId] });
    } else if (status === "failed" || status === "timeout") {
      clearPoll(); activeLoginRef.current = null; setLogin(null);
      setLoginError(`Sign-in ${status}. Try again.`);
    }
  } catch { /* transient — keep polling */ }
};

// Cancel a still-pending challenge on unmount. The login slot is keyed
// (provider, authHome) and is HOST-SHARED, so a stranded pending challenge
// makes every other company on this host receive 409.
useEffect(() => () => {
  clearPoll();
  const active = activeLoginRef.current;
  if (active) {
    void providersApi.cancelLogin(companyId, active.providerId, active.challengeId).catch(() => {});
  }
}, [companyId]);
```

The returned `loginUrl` is rendered as an external link (the user opens it), and a 409 from `startLogin` must render as readable copy — "Another company on this machine is signing in to this provider. Try again shortly." — not a raw error.

- [ ] **Step 4: Verify in the browser**

Start the instance, open `/<PREFIX>/settings?tab=providers`. Expected: a card per provider, cached status rendered immediately with no probe storm.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/settings/sections/ProvidersSection.tsx ui/src/components/settings/SettingsLayout.tsx ui/src/pages/SettingsPage.tsx
git commit -m "feat(providers): settings providers tab"
```

---

## Task 13: Agent config readiness badge

**Files:**
- Modify: `ui/src/components/AgentConfigForm.tsx`

- [ ] **Step 1: Add the badge**

Render a compact readiness badge for **this agent's own scope** — not the provider's company-default status.

Resolution is a **two-key lookup**, in this order:
1. Find the provider row whose `descriptor.adapterType === agent.adapterType` (the agent's *current* adapter — it can be changed in this very form, so read the effective/draft value, not the persisted one).
2. Within that row, find the `agents[]` entry whose `scopeId === agent.id`.

If step 1 finds no provider, the adapter isn't credentialed (`process`, `http`, …) — render nothing. If step 2 finds no entry, show "Not checked" with a Test action calling `providersApi.test(companyId, providerId, { scopeType: "agent", agentId: agent.id })`.

**Badge copy + styling — reuse the canonical mapping from Task 11, do not invent a second one:**
`verified`→"Ready" · `needs_auth`→"Needs sign-in" · `not_installed`→"Not installed" · `failed`→"Check failed" · `unknown`→"Not verified" · `unverifiable`→"Can't verify (custom command)".
`unverifiable` and `unknown` use the neutral tone; only `needs_auth` / `not_installed` / `failed` use the warning/error tone.

- [ ] **Step 1b: Test the badge exhaustively**

Add a table-driven test rendering the agent badge for **all six** outcomes and asserting the expected label and tone, so a future outcome cannot silently render blank.

This distinction is the whole point of P1-1: an agent with its own revoked key binding must read **Needs sign-in** even when the company default is Ready. Showing the company-default badge here would reintroduce the false-green.

Include a link: `Manage in Settings → Providers` → `/<prefix>/settings?tab=providers`.

**Do not modify** the `SecretBindingPicker` (lines ~929-956) or `EnvVarEditor` (lines ~976-990). Those are the per-agent override and must keep working exactly as they do.

- [ ] **Step 2: Regression test**

Add a test asserting the per-agent env binding fields still render and still emit the same `adapterConfig.env` patch shape as before.

Run: `pnpm vitest run ui/src/__tests__/ -t "AgentConfigForm"` → PASS

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/AgentConfigForm.tsx
git commit -m "feat(providers): agent readiness badge"
```

---

## Task 13b: Onboarding waiver contract (end-to-end)

Task 14 requires onboarding state to record **waived**, not **verified**. That flag does not exist today: `advanceOnboarding` sends only `companyId`, `journey`, `requestedState` (`ui/src/api/onboarding.ts:17-21`), the server parses exactly those three (`server/src/routes/onboarding.ts:40-53`), and `onboarding_progress` has no waiver column (`packages/db/src/schema/onboarding_progress.ts:16-27`). Without this task the waiver is unimplementable and Task 14 would silently fall back to recording a normal verification.

**Verified file layout** (there is **no** `validators/onboarding.ts` — the route parses the body inline at `server/src/routes/onboarding.ts:40-53` and delegates to `advanceState` in `server/src/services/onboarding.ts`; the client response type is `FlowProgress = { completedStates }` at `ui/src/api/onboarding.ts:7`). Follow that existing shape — do not introduce a validator module just for this field.

**Files:**
- Modify: `packages/db/src/schema/onboarding_progress.ts` (+ generated migration)
- Modify: `server/src/routes/onboarding.ts` (parse + gate `waived`)
- Modify: `server/src/services/onboarding.ts` (`advanceState` performs the atomic mutation)
- Modify: `ui/src/api/onboarding.ts` (request flag + response type)
- Test: `server/src/__tests__/onboarding-waiver.test.ts` (create)

- [ ] **Step 1: Add the persisted field**

```ts
/**
 * Set when the founder advanced a step WITHOUT the system proving it works —
 * currently only COMMANDER_VERIFIED via a custom-command configuration that
 * cannot be probed. Distinct from a genuine verification so support, telemetry
 * and any future re-check can tell "we confirmed this" from "the user told us
 * to proceed".
 */
waivedStates: jsonb("waived_states").$type<string[]>().notNull().default([]),
```

Run `pnpm db:generate` (never hand-write SQL).

- [ ] **Step 2: Widen the request + response contract (client)**

In `ui/src/api/onboarding.ts`:

```ts
export type FlowProgress = {
  completedStates: OnboardingState[];
  /** States advanced by explicit waiver rather than verification. */
  waivedStates: OnboardingState[];
};

export async function advanceOnboarding(args: {
  companyId: string | null;
  journey: OnboardingJourney;
  requestedState: OnboardingState;
  /** Explicit "Continue without verifying" — server re-validates. */
  waived?: boolean;
}): Promise<FlowProgress | null> { /* …send `waived` in the PATCH body… */ }
```

Both `getOnboardingProgress` and `advanceOnboarding` must read `waivedStates` out of the response (defaulting to `[]`), otherwise the UI cannot tell a waived step from a verified one.

- [ ] **Step 3: Route — parse and gate (server)**

In `server/src/routes/onboarding.ts:40`, extend the inline body parse with `waived?: boolean` (same style as the existing fields). When `waived === true`:

1. **Scope the waiver to the one state it is for.** Reject with `422` unless `requestedState === "COMMANDER_VERIFIED"`. The evidence being checked is a *Commander* probe, so it can only justify the *Commander* step — without this guard a caller with an unverifiable Commander could pass any otherwise-order-valid `requestedState` and have it recorded as waived, corrupting the waiver's meaning everywhere it is read.
2. Re-run the Commander probe **server-side** (reuse `resolveCommanderAdapterType` + `resolveCommanderProbeConfig` + `classifyProbeOutcome`).
3. Accept **only** when the outcome is `unverifiable`. Reject `needs_auth`, `not_installed`, `failed` **and** `unknown` with `422`.
4. Pass `waived` into `advanceState`.

Client-side gating is not sufficient — a founder could otherwise POST `waived: true` to walk past a genuine auth failure, or to waive an unrelated step.

- [ ] **Step 4: Service — one atomic mutation**

The append-and-advance must happen in `advanceState` (`server/src/services/onboarding.ts`), **not** in the route, so the state transition and the waiver record cannot diverge:

```ts
export async function advanceState(db: Db, args: {
  userId: string; companyId: string | null;
  journey: OnboardingJourney; requestedState: OnboardingState;
  waived?: boolean;
}) {
  // …existing transition logic…
  // In the SAME update/transaction that appends requestedState to
  // completedStates, also append it to waivedStates when args.waived is true.
}
```

Return `waivedStates` in the service result so the route's response carries it.

- [ ] **Step 5: Tests**

```ts
it("accepts a waiver when the probe is genuinely unverifiable", async () => { /* → 200, waivedStates contains COMMANDER_VERIFIED */ });
it("rejects a waiver when the probe reports needs_auth", async () => { /* → 422, state NOT advanced */ });
it("rejects a waiver when the probe reports not_installed", async () => { /* → 422 */ });
it("rejects a waiver when the probe reports failed", async () => { /* → 422 */ });
it("rejects a waiver when the probe reports unknown", async () => { /* → 422 — inconclusive is not waivable */ });
it("rejects a waiver for any state other than COMMANDER_VERIFIED", async () => { /* → 422 even when the Commander probe IS unverifiable; state not advanced, waivedStates unchanged */ });
it("does not set waivedStates on a normal verified advance", async () => { /* → waivedStates stays [] */ });
it("appends to completedStates and waivedStates atomically", async () => { /* both updated, or neither */ });
it("returns waivedStates in the progress response", async () => { /* client can distinguish waived from verified */ });
```

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/onboarding_progress.ts packages/db/src/migrations \
        ui/src/api/onboarding.ts server/src/routes/onboarding.ts \
        server/src/services/onboarding.ts server/src/__tests__/onboarding-waiver.test.ts
git commit -m "feat(onboarding): server-validated waiver for unverifiable setups"
```

---

## Task 14: Refactor onboarding VerifyStep onto the shared component

**Files:**
- Modify: `ui/src/onboarding/steps/VerifyStep.tsx`

- [ ] **Step 1: Run the existing tests first (baseline)**

Run: `pnpm vitest run ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx`
Expected: PASS — record the current behaviour before touching it.

- [ ] **Step 2: Refactor**

Replace the inline `not_installed` / `needs_auth` markup with `<ProviderReadinessCard>`, keeping VerifyStep's own logic for: resolving the provider from Commander's `cliTool`, the login poll + unmount-cancel behaviour, and `advanceOnboarding`.

**Two contract changes are required here** (the classifier gained outcomes):

1. Widen the local `Outcome` union at `ui/src/onboarding/steps/VerifyStep.tsx:16` to include `"unknown"` and `"unverifiable"`, and render copy for both:
   - `unknown` → "We couldn't confirm your CLI is signed in. Try again." (blocking)
   - `unverifiable` → "You've configured a custom command, so we can't check it automatically." (waiver, see below)
2. The blocking rule becomes: **`verified` advances automatically. `unverifiable` advances ONLY after an explicit waiver.** Everything else blocks.

**Why a waiver and not an auto-advance.** A custom `command` makes the adapter skip execution rather than observe authentication, and it emits no auth-failure code — so auto-advancing would let `COMMANDER_VERIFIED` be reached without ever proving Commander can run. (This is not a privilege-escalation hole — the route is founder-gated — but it silently converts "unchecked" into "verified", which is the same dishonesty this whole feature exists to remove.) So:

- Render a distinct secondary action: **"Continue without verifying"**, not the primary button.
- Record the distinction: pass a `waived: true` flag through `advanceOnboarding` so the state reflects *waived*, not *verified*. Do not reuse the verified path.
- The Providers tab keeps showing that provider as "Can't verify (custom command)" afterwards — the waiver unblocks onboarding, it does not repaint the status green.

- [ ] **Step 3: Re-run and EXTEND the tests**

Run: `pnpm vitest run ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx`

All pre-existing assertions must still pass unmodified (proving the refactor preserved behaviour). Then ADD:
- `unknown` renders the retry copy and does **not** advance.
- `unverifiable` renders the custom-command copy and does **not** advance on its own.
- clicking "Continue without verifying" advances and calls `advanceOnboarding` with `waived: true`.
- a regression test that a custom-command Commander configuration can complete onboarding via the waiver (the setup this rule protects).
- a test that `needs_auth` never offers the waiver — a genuine auth failure must not be waivable.

- [ ] **Step 4: Commit**

```bash
git add ui/src/onboarding/steps/VerifyStep.tsx
git commit -m "refactor(onboarding): verify step uses shared readiness card"
```

---

## Task 15: E2E coverage

**Files:**
- Create: `tests/e2e/providers-readiness.spec.ts`

- [ ] **Step 1: Write the specs**

Following the patterns in the existing e2e suite:
1. Settings → Providers renders every card **immediately from cache** (fresh cached rows are shown without re-probing), and auto-refreshes only providers that are both **in-use and stale** — matching decision D3. (The earlier "no probe on load" wording contradicted D3 and is wrong.)
2. Pressing `Test` on a provider updates its badge and timestamp.
3. Saving an API key flips the **company-default** badge to Ready.
4. **P1-1 regression:** with a valid company key AND an agent whose own binding is invalid, the company default shows Ready while that agent still shows Needs sign-in. The tab must never show a bare green "Ready" that hides a failing in-use agent.
5. The agent config page shows the agent-scoped readiness badge and links to the tab.
6. **Login lifecycle** (mocked backend): pressing Sign in starts a challenge, polls, re-probes on completion, and cancels the pending challenge when navigating away.
7. **Onboarding regression:** the onboarding Verify step still completes after the shared-card refactor.

- [ ] **Step 2: Run**

Run: `pnpm test:e2e -- providers-readiness`
Expected: PASS. On Windows use `AOA_E2E_FORCE_WINDOWS=1`.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/providers-readiness.spec.ts
git commit -m "test(providers): e2e coverage for readiness tab"
```

---

## Task 16: Full suite + verification

- [ ] **Step 1: Run everything (repo Definition of Done, per AGENTS.md)**

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```
Expected: all three green. `pnpm build` is required — the signature change in Task 8 touches six call sites and a type error there will only surface at build time.

- [ ] **Step 1b: Re-run the Commander contract suites explicitly**

These guard the routes we generalized; run them immediately, not only as part of the full sweep:

```bash
pnpm vitest run server/src/__tests__/commander-verify-route.test.ts \
                server/src/__tests__/commander-key-route.test.ts \
                server/src/__tests__/commander-login-route.test.ts
```
Expected: PASS with contracts unchanged — notably that verify returns `200` only for `verified` and `422` otherwise.

- [ ] **Step 2: Verify against a live instance**

Boot the instance, then confirm end-to-end:
1. Settings → Providers lists every provider with cached status.
2. `Test` on Claude with a logged-out CLI reports **Needs sign-in** (not a silent pass).
3. Send a Commander message with the CLI logged out → the chat now shows a **visible error** (Task 1) instead of an empty turn.
4. An agent with its own API key binding still uses that key (per-agent override preserved).

- [ ] **Step 3: Commit any fixes and push**

```bash
git push -u origin feat/provider-readiness
```

---

## Task 17: Stage B spike (gates the follow-up plan)

Interactive login is only wired for Codex. Before planning Stage B we must know which other CLIs can be driven from a web UI at all.

**Files:**
- Create: `docs/aoa/plans/2026-07-20-provider-login-spike-results.md`

- [ ] **Step 1: Probe each CLI's login**

For each of `gemini`, `agent` (Cursor), `opencode`, `grok`, run its login command in a terminal and record: does it print a URL to stdout? does it self-complete, or block on stdin (paste-code)? where does it write credentials?

```bash
gemini auth login
agent login
opencode auth login
grok login
```

- [ ] **Step 2: Record results**

Write a table with columns: CLI · emits URL? · self-completes? · credential file · **drivable in-app (yes/no)**.

- [ ] **Step 3: Commit**

```bash
git add docs/aoa/plans/2026-07-20-provider-login-spike-results.md
git commit -m "docs(providers): stage B login spike results"
```

- [ ] **Step 4: Write the Stage B plan**

Only for CLIs marked drivable. Any CLI marked not-drivable keeps `selfCompletingLogin: false` and ships the copyable `manualLoginCommand` already built in Task 11 — **never a Sign-in button that cannot finish.**

---

## Deferred to Stage C

- Claude paste-code bridge (lets `claude auth login` self-complete), after which `anthropic` flips to `selfCompletingLogin: true` and the Task 3 test expectation updates to `["openai", "anthropic"]`.
