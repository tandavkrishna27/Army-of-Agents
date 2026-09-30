# Commander Codex Model-Pin + Reasoning-Effort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Commander **codex** chat path pin a subscription-supported model (and `model_reasoning_effort=high`) so codex turns stop 400-ing on the unsupported `gpt-5.3-codex` default — which unblocks both codex chat *and* the Phase 4 reasoning block, live.

**Architecture:** The Commander codex spawn writes a per-session `CODEX_HOME/config.toml` that contains **only** the MCP bridge block — no `model` line — so `codex exec` falls back to its compiled-in default `gpt-5.3-codex`, which a ChatGPT/subscription codex account rejects (HTTP 400 → `turn.failed` → empty turn). The codex *adapter* path (`execute.ts`) already solves this by sourcing `config.model` → `--model` and `config.modelReasoningEffort` → `-c model_reasoning_effort`. This plan brings the Commander **cli-mode** path to parity: an enterprise-grade **layered, validated** model resolver (`internal_agent_config.model` when codex-compatible → shared `~/.codex` model → safe `gpt-5.5` default) plus a named `high` effort constant, threaded into the existing codex argv builder. No DB migration, no route change (`agent-loop` already SELECT-*'s the config row and spreads it into `effectiveConfig`).

**Tech Stack:** TypeScript, Express, Drizzle ORM, Vitest, the `@armyofagents/adapter-codex-local` package, the real `codex` CLI (codex-cli 0.130.0).

---

## Background: rigorously verified facts (do not relitigate)

All proven on the real `codex` binary by re-running the EXACT Commander spawn (real per-session `CODEX_HOME` + bridge + argv):

1. **Empty turn = model error, NOT the MCP-bridge stdin-race.** Default per-session home → `400 "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account"` → `turn.failed`. Adding `--model gpt-5.5` → exit 0, real `agent_message`, 0 errors.
2. **Reasoning needs effort.** With gpt-5.5, `model_reasoning_summary=detailed` emits **0** reasoning at `model_reasoning_effort=medium` (the shared `~/.codex` default) but **emits reasoning at `effort=high`** (A/B proven).
3. **Proven argv (Test C, exit 0, 1 reasoning, 1 agent_message, 0 errors):**
   `codex exec --json --dangerously-bypass-approvals-and-sandbox --model gpt-5.5 -c model_reasoning_effort="high" -c model_reasoning_summary=detailed -`
   (the `-c effort` value is JSON-quoted to match `execute.ts:411`; the `summary` flag stays **bare** — quoted `summary` emits nothing, a Phase 4 finding.)
4. **`internal_agent_config.model` defaults to `"claude-sonnet-4-6"`** (a *claude* string) for every company → blindly passing it to codex would 400 differently → **validation is mandatory**.
5. The codex argv is built in ONE place: `resolveCliInvocation` codex case (`cli-mode.ts:437-440`), called by `runCodexTurn` (`cli-mode.ts:905`).
6. `agent-loop.ts:154` `db.select()` (SELECT *) + `effectiveConfig` spread (`agent-loop.ts:291`) → `model` already reaches `cliService.chat(...)` at runtime; only the **type** needs widening.

---

## File Structure

- **Create** `server/src/services/internal-agent/codex-model.ts` — pure resolver `resolveCodexChatModel()` + `isCodexCompatibleModel()` + constants `DEFAULT_CODEX_CHAT_MODEL`, `COMMANDER_CODEX_REASONING_EFFORT`. One responsibility: decide the codex chat model + effort. Pure → unit-testable with no drizzle import.
- **Create** `server/src/__tests__/codex-model.test.ts` — unit tests for the resolver.
- **Modify** `packages/adapters/codex-local/src/server/codex-home.ts` — add `readSharedCodexModel(env)` (reads the shared `~/.codex/config.toml` `model` line). Lives beside `resolveSharedCodexHomeDir`/`ensureCodexAuthInHome` (same shared-home concern).
- **Modify** `packages/adapters/codex-local/src/server/index.ts` — export `readSharedCodexModel`.
- **Create** `packages/adapters/codex-local/src/server/__tests__/codex-home.readSharedCodexModel.test.ts` — unit test the toml parse.
- **Modify** `server/src/services/internal-agent/cli-mode.ts` — widen `chat()` config type (`model?`); thread `codexModel` through `runCodexTurn` (`RunCodexTurnArgs`) → `resolveCliInvocation` → codex argv builder (`--model` + effort + summary).
- **Modify** `server/src/__tests__/cli-mode.test.ts` — argv assertions for first-turn + resumed-turn codex spawns (closes Phase 4 Codex-review finding #1).

No DB migration. No route change. `claude_cli` and `opencode` paths untouched.

---

### Task 1: Pure codex model/effort resolver

**Files:**
- Create: `server/src/services/internal-agent/codex-model.ts`
- Test: `server/src/__tests__/codex-model.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/codex-model.test.ts
import { describe, it, expect } from "vitest";
import {
  resolveCodexChatModel,
  isCodexCompatibleModel,
  DEFAULT_CODEX_CHAT_MODEL,
  COMMANDER_CODEX_REASONING_EFFORT,
} from "../services/internal-agent/codex-model.js";

describe("isCodexCompatibleModel", () => {
  it("accepts ChatGPT-account openai chat families", () => {
    expect(isCodexCompatibleModel("gpt-5.5")).toBe(true);
    expect(isCodexCompatibleModel("gpt-4.1")).toBe(true);
    expect(isCodexCompatibleModel("gpt-4o")).toBe(true);
    expect(isCodexCompatibleModel("o3-mini")).toBe(true);
    expect(isCodexCompatibleModel("o1")).toBe(true);
    expect(isCodexCompatibleModel("chatgpt-4o")).toBe(true);
    expect(isCodexCompatibleModel("  gpt-5.5  ")).toBe(true); // trims
  });
  it("rejects the known-bad GPT-Codex variants (ChatGPT-account 400s) — REVIEW FIX C1/C2", () => {
    // The exact model that 400s on a ChatGPT account; it passed a naive /^gpt-/.
    expect(isCodexCompatibleModel("gpt-5.3-codex")).toBe(false);
    expect(isCodexCompatibleModel("gpt-5-codex")).toBe(false);
    expect(isCodexCompatibleModel("o1-codex")).toBe(false);
    expect(isCodexCompatibleModel("codex-mini")).toBe(false);
  });
  it("rejects non-openai families + empty", () => {
    expect(isCodexCompatibleModel("claude-sonnet-4-6")).toBe(false);
    expect(isCodexCompatibleModel("gemini-2.0")).toBe(false);
    expect(isCodexCompatibleModel("opus")).toBe(false);
    expect(isCodexCompatibleModel("")).toBe(false);
    expect(isCodexCompatibleModel(null)).toBe(false);
    expect(isCodexCompatibleModel(undefined)).toBe(false);
  });
  it("rejects shell-unsafe strings (spawn uses shell:true on Windows) — REVIEW FIX C10/S5", () => {
    expect(isCodexCompatibleModel("gpt-5.5; rm -rf /")).toBe(false);
    expect(isCodexCompatibleModel("gpt-5.5 && calc")).toBe(false);
    expect(isCodexCompatibleModel("gpt-5.5\nmalicious")).toBe(false);
    expect(isCodexCompatibleModel("gpt-5.5`whoami`")).toBe(false);
  });
});

describe("resolveCodexChatModel", () => {
  it("uses config.model when codex-compatible", () => {
    expect(resolveCodexChatModel("gpt-4.1", "gpt-5.5")).toBe("gpt-4.1");
    expect(resolveCodexChatModel("  o3-mini ", "gpt-5.5")).toBe("o3-mini");
  });
  it("falls back to the shared model when config.model is a claude default", () => {
    expect(resolveCodexChatModel("claude-sonnet-4-6", "gpt-5.5")).toBe("gpt-5.5");
  });
  it("VALIDATES the shared model too (not trusted as-is) — REVIEW FIX C1", () => {
    // shared ~/.codex could hold a claude alias or a GPT-Codex model → must not pass it through
    expect(resolveCodexChatModel(null, "claude-3-opus")).toBe(DEFAULT_CODEX_CHAT_MODEL);
    expect(resolveCodexChatModel(null, "gpt-5.3-codex")).toBe(DEFAULT_CODEX_CHAT_MODEL);
    expect(resolveCodexChatModel(null, "gpt-5.5")).toBe("gpt-5.5"); // valid shared still honored
  });
  it("falls back to the safe default when nothing usable is available", () => {
    expect(resolveCodexChatModel(null, null)).toBe(DEFAULT_CODEX_CHAT_MODEL);
    expect(resolveCodexChatModel("claude-sonnet-4-6", "  ")).toBe(DEFAULT_CODEX_CHAT_MODEL);
  });
  it("exposes the proven defaults", () => {
    expect(DEFAULT_CODEX_CHAT_MODEL).toBe("gpt-5.5");
    expect(COMMANDER_CODEX_REASONING_EFFORT).toBe("high");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/codex-model.test.ts`
Expected: FAIL — cannot resolve module `../services/internal-agent/codex-model.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/internal-agent/codex-model.ts

/**
 * Codex chat model + reasoning-effort resolution for the Commander cli-mode
 * path. See docs/aoa/plans/2026-06-16-commander-codex-model-pin-plan.md.
 *
 * Why: the per-session CODEX_HOME/config.toml has no `model` line, so codex
 * falls back to its compiled-in default (gpt-5.3-codex), which a
 * ChatGPT/subscription codex account rejects with HTTP 400 → empty turn.
 * We pin a subscription-supported model + effort=high (effort is required
 * for codex to emit reasoning summaries at all).
 */

/** Proven-on-this-account safe default (Test C). */
export const DEFAULT_CODEX_CHAT_MODEL = "gpt-5.5";

/**
 * effort=high is REQUIRED for codex reasoning summaries (medium emits none —
 * A/B proven). INTENTIONAL hardcode (not a config bypass): mirrors the
 * COMMANDER_MAX_THINKING_TOKENS constant; a Settings field is a future
 * enhancement. NOTE: reasoning is still best-effort per model — like the
 * Claude path, some models emit none; the founder accepted "model-dependent".
 */
export const COMMANDER_CODEX_REASONING_EFFORT = "high";

// Shell-safe charset (spawn uses shell:true on Windows — REVIEW FIX C10/S5):
// the resolved model is interpolated into argv, so reject anything that isn't
// a plain model identifier. Full-string anchor (NOT a prefix test).
const SAFE_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
// OpenAI chat families usable on a ChatGPT/subscription codex account.
const CODEX_FAMILY_RE = /^(gpt-|o\d|chatgpt)/i;
// GPT-Codex variants (…-codex / codex-…) require an API key, NOT a ChatGPT
// login → they 400 on subscription accounts (this is the exact bug). Deny
// them so a stray config/shared value can never reintroduce the 400.
// REVIEW FIX C2: `gpt-5.3-codex` previously passed the naive /^gpt-/ prefix.
const CODEX_INCOMPATIBLE_RE = /codex/i;

export function isCodexCompatibleModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.trim();
  return (
    SAFE_MODEL_RE.test(m) &&
    CODEX_FAMILY_RE.test(m) &&
    !CODEX_INCOMPATIBLE_RE.test(m)
  );
}

/**
 * Layered, VALIDATED resolution (enterprise-grade — explicit product config
 * over ambient host state). Every source is run through
 * {@link isCodexCompatibleModel} so a claude default, a GPT-Codex model, or a
 * shell-unsafe string can never reach codex (REVIEW FIX C1):
 *   1. `internal_agent_config.model` when codex-compatible (it defaults to a
 *      claude string for every company, so validation is mandatory).
 *   2. the user's shared `~/.codex/config.toml` model, ALSO validated (it may
 *      hold a claude/OpenRouter alias or a GPT-Codex model).
 *   3. the safe default `gpt-5.5`, so it can NEVER 400 on an empty/bad config.
 */
export function resolveCodexChatModel(
  configModel: string | null | undefined,
  sharedModel: string | null | undefined,
): string {
  if (isCodexCompatibleModel(configModel)) return configModel!.trim();
  if (isCodexCompatibleModel(sharedModel)) return sharedModel!.trim();
  return DEFAULT_CODEX_CHAT_MODEL;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm vitest run src/__tests__/codex-model.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/codex-model.ts server/src/__tests__/codex-model.test.ts
git commit -m "feat(commander): add codex chat model/effort resolver (layered + validated)"
```

---

### Task 2: Read the shared `~/.codex` model (adapter helper)

**Files:**
- Modify: `packages/adapters/codex-local/src/server/codex-home.ts` (add export after `resolveSharedCodexHomeDir`, ~line 18)
- Modify: `packages/adapters/codex-local/src/server/index.ts:7` (add to the codex-home export line)
- Test: `packages/adapters/codex-local/src/server/__tests__/codex-home.readSharedCodexModel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/adapters/codex-local/src/server/__tests__/codex-home.readSharedCodexModel.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readSharedCodexModel } from "../codex-home.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codexhome-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("readSharedCodexModel", () => {
  it("returns the quoted model value", async () => {
    await fs.writeFile(
      path.join(dir, "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n',
    );
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBe("gpt-5.5");
  });
  it("returns an unquoted model value", async () => {
    await fs.writeFile(path.join(dir, "config.toml"), "model = gpt-4.1\n");
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBe("gpt-4.1");
  });
  it("returns a single-quoted model value — REVIEW FIX C5", async () => {
    await fs.writeFile(path.join(dir, "config.toml"), "model = 'gpt-4.1'\n");
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBe("gpt-4.1");
  });
  it("reads the TOP-LEVEL model, ignoring nested-table model keys — REVIEW FIX C4/S4", async () => {
    await fs.writeFile(
      path.join(dir, "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n[profiles.fast]\nmodel = "gpt-4.1-mini"\n',
    );
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBe("gpt-5.5");
  });
  it("returns null when the only model key lives under a table — REVIEW FIX C4/S4", async () => {
    await fs.writeFile(
      path.join(dir, "config.toml"),
      '# model = "should-ignore"\n[profiles.x]\nmodel = "nested"\n',
    );
    // Only the top-level section is scanned; the commented line is skipped and
    // the nested key is out of scope → null (deterministic, no host coupling).
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBeNull();
  });
  it("returns null when config.toml is missing", async () => {
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBeNull();
  });
  it("returns null when there is no model key", async () => {
    await fs.writeFile(path.join(dir, "config.toml"), "approval_policy = \"never\"\n");
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/adapters/codex-local && pnpm vitest run src/server/__tests__/codex-home.readSharedCodexModel.test.ts`
Expected: FAIL — `readSharedCodexModel` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/adapters/codex-local/src/server/codex-home.ts` immediately after `resolveSharedCodexHomeDir` (line 18):

```ts
/**
 * Read the `model` value from the user's SHARED `~/.codex/config.toml`
 * (resolved via {@link resolveSharedCodexHomeDir} — NOT a per-session
 * managed home). Used as a fallback model source for the Commander codex
 * chat spawn when the AoA config has no codex-compatible model.
 *
 * - Matches the first `model = "..."` (or bare `model = x`) line.
 * - Ignores commented (`#`) lines.
 * - Never throws: returns `null` on a missing file or absent key.
 *
 * IMPORTANT: call with the SERVER process env (not the per-session
 * CODEX_HOME), so it reads the shared home, not the bridge-only managed one.
 */
export async function readSharedCodexModel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const sharedHome = resolveSharedCodexHomeDir(env);
  const target = path.join(sharedHome, "config.toml");
  const content = await fs.readFile(target, "utf8").catch(() => null);
  if (!content) return null;
  // Scan ONLY the top-level section (everything before the first `[table]`
  // header) so a `[profiles.x]`/`[model_providers.x]` `model =` can never be
  // mistaken for the active model (REVIEW FIX C4/S4). Column-0 anchor + single
  // OR double quote handling (REVIEW FIX C5).
  const topLevel = content.split(/^\[/m)[0];
  const m = topLevel.match(/^model\s*=\s*['"]?([^'"\n#]+?)['"]?\s*(?:#.*)?$/m);
  return m ? m[1].trim() : null;
}
```

Then update the export in `packages/adapters/codex-local/src/server/index.ts:7`:

```ts
export { ensureCodexAuthInHome, readSharedCodexModel } from "./codex-home.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/adapters/codex-local && pnpm vitest run src/server/__tests__/codex-home.readSharedCodexModel.test.ts`
Expected: PASS.

- [ ] **Step 5: (Optional) build the adapter — NOT required in dev**

REVIEW FIX (S1): the adapter `package.json` `exports["./server"]` points at `./src/server/index.ts` (TS **source**); only `publishConfig.exports` points at `dist`. So in the dev server (tsx) and in Vitest (workspace resolution), `import("@armyofagents/adapter-codex-local/server")` reads the source directly — the new export is visible immediately, **no build step**. Run `pnpm build` only if you want to refresh `dist` for a publish; it is a harmless no-op for dev/test.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/codex-local/src/server/codex-home.ts packages/adapters/codex-local/src/server/index.ts packages/adapters/codex-local/src/server/__tests__/codex-home.readSharedCodexModel.test.ts
git commit -m "feat(codex-adapter): add readSharedCodexModel helper + export"
```

---

### Task 3: Thread the codex model + effort into the spawn argv

**Files:**
- Modify: `server/src/services/internal-agent/cli-mode.ts`
  - `chat()` config type (line 488-492)
  - `runCodexTurn` call inside `chat()` (line 539-545 block — add `codexModel`)
  - `RunCodexTurnArgs` (line 874-882)
  - `runCodexTurn` → `resolveCliInvocation` call (line 905-912)
  - `resolveCliInvocation` signature (line 329-338) + codex case argv (line 410-449)

- [ ] **Step 1: Widen the `chat()` config type to carry the model**

In `cli-mode.ts`, the `chat()` second parameter (line 488-492) becomes:

```ts
      config: {
        cliTool: string | null;
        executionMode: string;
        vendorCliBypassEnabled?: boolean;
        /** internal_agent_config.model — used (validated) for the codex spawn. */
        model?: string | null;
      },
```

(Runtime value already arrives via `effectiveConfig` spread in `agent-loop.ts:291` — this is a type-only change.)

- [ ] **Step 2: Add `codexModel` to `RunCodexTurnArgs`**

`RunCodexTurnArgs` (line 874-882) gains one field:

```ts
interface RunCodexTurnArgs {
  mcpParams: McpConfigParams;
  prompt: string;
  isWin: boolean;
  resumeSessionId: string | null;
  vendorCliBypassEnabled: boolean;
  /** internal_agent_config.model (validated downstream) — pins the codex model. */
  codexModel?: string | null;
  /** Called with the parsed codex sessionId so the caller can persist it. */
  onSessionId: (sessionId: string | null) => void;
}
```

- [ ] **Step 3: Pass `config.model` into `runCodexTurn` from `chat()`**

In the `chat()` codex branch, the `runCodexTurn({ ... })` call (starts line 539) gains, alongside `vendorCliBypassEnabled`:

```ts
            vendorCliBypassEnabled: config.vendorCliBypassEnabled ?? true,
            codexModel: config.model ?? null,
```

- [ ] **Step 4: Extend `resolveCliInvocation` signature with `codexModel`**

`resolveCliInvocation` (line 329-338) gains a trailing optional param:

```ts
async function resolveCliInvocation(
  cliTool: string,
  params: McpConfigParams,
  safeContent: string,
  resumeCodexSessionId?: string | null,
  systemSplitArgs?: SystemSplitArgs,
  vendorCliBypassEnabled = true,
  codexModel?: string | null,
): Promise<CliInvocation | null> {
```

- [ ] **Step 5: Pass `codexModel` from `runCodexTurn` to `resolveCliInvocation`**

The `resolveCliInvocation("codex", ...)` call (line 905-912) gains the new trailing arg:

```ts
    const invocation = await resolveCliInvocation(
      "codex",
      args.mcpParams,
      args.prompt,
      safeResume,
      undefined,
      args.vendorCliBypassEnabled,
      args.codexModel ?? null,
    );
```

- [ ] **Step 6: Build the codex argv with `--model` + effort + summary**

In the codex case, first extend the dynamic adapter import (line 417-419) to also pull `readSharedCodexModel`, and import the resolver at the top of the file. Add near the other top-of-file imports:

```ts
import {
  resolveCodexChatModel,
  COMMANDER_CODEX_REASONING_EFFORT,
} from "./codex-model.js";
```

Change the dynamic import (line 417-419) to:

```ts
      const { writeCodexMcpConfigToml, ensureCodexAuthInHome, readSharedCodexModel } =
        await import("@armyofagents/adapter-codex-local/server");
```

Then replace the `reasoningArgs`/`codexArgs` block (lines 437-440) with:

```ts
      // MX-chatmodel: pin a subscription-supported model + effort. The
      // per-session CODEX_HOME has no `model` line, so without --model codex
      // falls back to its default (gpt-5.3-codex), which a ChatGPT-account
      // codex rejects with a 400 → empty turn. effort=high is REQUIRED for
      // codex to emit reasoning summaries (medium emits none). The summary
      // flag stays BARE (quoted emits nothing). See codex-model.ts + the plan.
      const sharedCodexModel = await readSharedCodexModel(); // shared ~/.codex, NOT the per-session home
      const resolvedCodexModel = resolveCodexChatModel(codexModel, sharedCodexModel);
      const modelArgs = ["--model", resolvedCodexModel];
      const reasoningArgs = [
        "-c",
        `model_reasoning_effort=${JSON.stringify(COMMANDER_CODEX_REASONING_EFFORT)}`,
        "-c",
        "model_reasoning_summary=detailed",
      ];
      const codexArgs = resumeCodexSessionId
        ? ["exec", "--json", ...codexBypassArgs, ...modelArgs, ...reasoningArgs, "resume", resumeCodexSessionId, "-"]
        : ["exec", "--json", ...codexBypassArgs, ...modelArgs, ...reasoningArgs, "-"];
```

> Note: `readSharedCodexModel()` is intentionally called with **no argument** so it uses the server `process.env` (the shared `~/.codex`), NOT the per-session `CODEX_HOME` set only in `spawnEnv`.

- [ ] **Step 7: Typecheck**

Run: `cd server && pnpm tsc --noEmit` (and `cd packages/adapters/codex-local && pnpm tsc --noEmit` if not covered)
Expected: no type errors. (`config.model` is now in the type; `codexModel` flows end-to-end.)

- [ ] **Step 8: Commit**

```bash
git add server/src/services/internal-agent/cli-mode.ts
git commit -m "feat(commander): pin codex chat model + reasoning effort=high on the spawn"
```

---

### Task 4: Argv assertion tests (first-turn + resumed-turn)

**Files:**
- Modify: `server/src/__tests__/cli-mode.test.ts` (follow the existing codex argv assertion patterns near lines 781 and 1049 referenced by the Phase 4 Codex review)

> This closes Phase 4 Codex-review finding #1: existing tests assert `codex`, `exec`, `--json`, no `-p`, and the trailing `-`, but never that the model + reasoning flags are present and correctly ordered.

- [ ] **Step 1: Read the existing codex argv harness + apply the two REVIEW FIXES it requires**

Read `server/src/__tests__/cli-mode.test.ts`: the `vi.mock("@armyofagents/adapter-codex-local/server", ...)` block (~lines 36-45), the single-spawn `runChat` harness (~line 695, takes `configOverrides`), and the multi-spawn `drainChat` harness (~line 942, used by the turn-2/resume test ~line 1049). Reuse these — do not invent a new harness. **Two prerequisite fixes (from plan review):**

  - **REVIEW FIX S3/C7 — make the resolved model deterministic.** The mock spreads `...actual`, so once exported the test would call the REAL `readSharedCodexModel` and read the host's `~/.codex` (the Task 5 live-verify even sets codex on this machine). Add a stub to the mock object so the resolver deterministically falls through to `DEFAULT_CODEX_CHAT_MODEL`:

    ```ts
    // inside the existing vi.mock("@armyofagents/adapter-codex-local/server", ...) factory:
    readSharedCodexModel: vi.fn(async () => null),
    ```

  - **REVIEW FIX S2 — let `drainChat` inject a config override (needed for the resume argv test).** `drainChat` currently hardcodes `{ cliTool, executionMode: "cli" }`. Widen its signature so the resume test can pass `model`:

    ```ts
    // before: async function drainChat(service, cliTool, content) { ... config = { cliTool, executionMode: "cli" } ... }
    async function drainChat(service, cliTool, content, configOverride = {}) {
      // ...
      const config = { cliTool, executionMode: "cli", ...configOverride };
      // ...
    }
    ```

- [ ] **Step 2: Add a first-turn argv assertion (claude-default config → safe default)**

Drive a fresh (non-resume) codex chat turn with config `model: "claude-sonnet-4-6"` (the default → must NOT be passed to codex). With `readSharedCodexModel` stubbed to `null`, the resolver yields `DEFAULT_CODEX_CHAT_MODEL` deterministically. Assert the captured argv:

```ts
expect(captured).toEqual([
  "exec",
  "--json",
  "--dangerously-bypass-approvals-and-sandbox",
  "--model",
  "gpt-5.5", // claude default rejected → readSharedCodexModel stubbed null → DEFAULT_CODEX_CHAT_MODEL
  "-c",
  'model_reasoning_effort="high"',
  "-c",
  "model_reasoning_summary=detailed",
  "-",
]);
```

- [ ] **Step 3: Add a resumed-turn argv assertion (codex-compatible config → used as-is)**

Using `drainChat(service, "codex", "second message", { model: "gpt-4.1" })` (Step 1's widened harness) with a stored `codexSessionId`, assert:

```ts
expect(captured).toEqual([
  "exec",
  "--json",
  "--dangerously-bypass-approvals-and-sandbox",
  "--model",
  "gpt-4.1", // codex-compatible config.model → used as-is (no shared/default lookup)
  "-c",
  'model_reasoning_effort="high"',
  "-c",
  "model_reasoning_summary=detailed",
  "resume",
  "<the-session-id>",
  "-",
]);
```

- [ ] **Step 3b: Regression guard — the claude_cli argv must NOT receive codex model/reasoning flags (REVIEW FIX S6/C12)**

In the existing claude_cli argv test (the claude spawn-capture), assert the new args never leak into the claude path:

```ts
expect(captured).not.toContain("--model");
expect(captured.join(" ")).not.toContain("model_reasoning_effort");
expect(captured.join(" ")).not.toContain("model_reasoning_summary");
```

- [ ] **Step 4: Run the codex argv tests**

Run: `cd server && pnpm vitest run src/__tests__/cli-mode.test.ts`
Expected: PASS, including the new first-turn + resumed-turn assertions; no regression in the existing codex/claude argv tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/cli-mode.test.ts
git commit -m "test(commander): assert codex spawn argv pins model + effort=high (first + resume)"
```

---

### Task 5: Full verification + live verify on the real codex CLI

**Files:** none (verification only)

- [ ] **Step 1: Full server + adapter suites green**

Run: `cd server && pnpm vitest run` and `cd packages/adapters/codex-local && pnpm vitest run`
Expected: green (note any pre-existing unrelated failures explicitly; do not let them mask regressions).

- [ ] **Step 2: Typecheck the whole touched surface**

Run: `pnpm -w tsc --noEmit` (or per-package `pnpm tsc --noEmit` for `server` + `packages/adapters/codex-local`)
Expected: clean.

- [ ] **Step 3: Live-verify codex chat + reasoning on the running dev server**

On the `:3201` dev server (Docker pgvector), set the company's Commander to codex and send a reasoning-heavy message, then confirm a **real reply** AND a populated **Codex reasoning block**:

```bash
# point the company's internal_agent_config at codex (local_trusted board actor)
# (use the same psql the bundle uses: postgres://postgres:postgres@127.0.0.1:5433/aoa)
psql "postgres://postgres:postgres@127.0.0.1:5433/aoa" -c \
  "update internal_agent_config set cli_tool='codex' where company_id = (select id from companies limit 1);"
```

Then, in the browser at `/<PREFIX>/commander`, send: *"Think step by step: sequence shipping a login, billing, and onboarding page for 3 engineers in 2 weeks, and justify each call."* Confirm:
- the assistant produces a **non-empty** reply (no more empty turn),
- a collapsible **"Thinking"** (`CommanderReasoningBlock`, `data-testid="commander-reasoning"`) renders and is populated,
- the run row records a real model + tokens,
- `0` console errors.

Capture proof via `/browse` screenshot + the network/SSE `event: reasoning`.

- [ ] **Step 4: Restore the dev DB to claude (leave no codex-only state behind)**

```bash
psql "postgres://postgres:postgres@127.0.0.1:5433/aoa" -c \
  "update internal_agent_config set cli_tool=null where company_id = (select id from companies limit 1);"
```

- [ ] **Step 5: Final commit (if any verification tweaks were needed)**

```bash
git add -A
git commit -m "test(commander): verify codex model-pin + reasoning live on real codex CLI"
```

---

## Self-Review

**1. Spec coverage:**
- Empty-turn root cause (missing model line) → Task 1 (resolver) + Task 3 (argv `--model`). ✓
- Enterprise model sourcing (config → shared → default, validated) → Task 1 `resolveCodexChatModel` + Task 2 `readSharedCodexModel`. ✓
- Reasoning needs effort=high → Task 1 constant + Task 3 `-c model_reasoning_effort="high"`. ✓
- Keep `model_reasoning_summary=detailed` bare (Phase 4) → Task 3 argv. ✓
- Validation that config.model (claude default) is not passed to codex → Task 1 `isCodexCompatibleModel` + test. ✓
- argv-ordering test gap (Phase 4 review #1) → Task 4. ✓
- Live proof codex chat + reasoning works → Task 5. ✓

**2. Placeholder scan:** No TBD/"handle errors"/"similar to". Every code step has full code. Task 4 reuses an existing harness whose exact shape must be read first (Step 1) — flagged, not hand-waved. ✓

**3. Type consistency:** `codexModel` is the threaded field name across `RunCodexTurnArgs`, the `runCodexTurn` call, and the `resolveCliInvocation` param. `resolveCodexChatModel(configModel, sharedModel)`, `isCodexCompatibleModel`, `DEFAULT_CODEX_CHAT_MODEL`, `COMMANDER_CODEX_REASONING_EFFORT`, `readSharedCodexModel` are referenced identically in every task. The `chat()` config gains `model?: string | null`; `config.model` reads match. ✓

**Risks / notes:**
- The argv test's resolved model depends on the host's shared `~/.codex` — Task 4 Step 2 pins determinism (stub or empty `CODEX_HOME`). Without that the test is host-dependent.
- `readSharedCodexModel()` MUST be called with no arg (server `process.env`) so it reads the shared home, not the per-session `CODEX_HOME` (only in `spawnEnv`). Called out in Task 3 Step 6.
- Adapter must be rebuilt (Task 2 Step 5) for the server's dynamic `import("@armyofagents/adapter-codex-local/server")` to see `readSharedCodexModel` in dev.
- Effort is a constant, not yet a config field. Future enhancement: a Settings `codexReasoningEffort` column — out of scope; constant mirrors `COMMANDER_MAX_THINKING_TOKENS`.

## Plan-review resolutions (dual review: real Codex CLI + code-reading subagent, both `ship-with-fixes`)

Applied to this plan:
- **C1/C2 (high) — `gpt-5.3-codex` slipped the naive `/^gpt-/` regex; shared model was trusted as-is.** Resolver now uses a family allowlist (`gpt-`/`o\d`/`chatgpt`) **minus** a `/codex/i` denylist (GPT-Codex variants require an API key → 400 on ChatGPT accounts) and validates the shared model too. (Task 1)
- **C10/S5 (security) — model string is interpolated into argv with `shell:true` on Windows.** Resolver adds a full-string safe-charset gate (`/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`), matching the codebase's `validateSessionId` posture. (Task 1)
- **C4/C5/S4 — toml parse robustness.** `readSharedCodexModel` now scans only the top-level section (before the first `[table]`) and handles single + double quotes. (Task 2)
- **S3/C7 + S2 — host-dependent tests.** Stub `readSharedCodexModel` in the existing mock + widen `drainChat` for the resume argv test. (Task 4)
- **S1 — adapter rebuild not needed in dev** (workspace `exports` → source). (Task 2 Step 5 softened)
- **S6/C12 — claude path must stay clean.** Added a regression assertion that codex model/reasoning args never leak into the claude_cli argv. (Task 4 Step 3b)

Reviewed and intentionally **not** changed:
- **C6 (medium) — "silent empty turn on codex failure".** Already handled: `runCodexTurn` (`cli-mode.ts:974-985`) reads `parsed.errorMessage` (from `parse.ts:197` `error` + `:245` `turn.failed`) or a non-zero-exit message and `yield`s `{type:"error"}`. The model-pin prevents the common 400; a future misconfigured model now shows the real reason, not an empty turn. No new task.
- **C3 (high) — "reasoning not guaranteed for every accepted model".** By design: reasoning is best-effort/model-dependent, exactly as the founder accepted for the Claude path (Plan 2). The primary goal (codex chat stops 400-ing) holds regardless; we do not gate the model list on reasoning capability. Documented on `COMMANDER_CODEX_REASONING_EFFORT`.
- **C8 — server launched with `CODEX_HOME`.** Intentional: `resolveSharedCodexHomeDir(process.env)` honors an operator-set `CODEX_HOME` as their shared home; the per-session home is only ever in `spawnEnv`, never `process.env`. Documented on `readSharedCodexModel`.
