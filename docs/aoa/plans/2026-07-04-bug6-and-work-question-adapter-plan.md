# BUG-6 Codex Supervised Fix + work_question Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the supervised (`codex app-server`) path so a ChatGPT-auth Codex account never silently completes an empty turn and falsely reports success (Part A), and wire the missing `ask_founder` MCP tool caller so an org/heartbeat agent can synchronously ask the founder a question via the existing runtime-decision machinery (Part B).

**Architecture:** Two independent parts in one document, Part A first (bug fix), Part B second (feature). Part A resolves a Codex-compatible chat model and delivers it to the supervised path via the managed `config.toml` (mirroring how `writeCodexMcpConfigToml` already writes that file), then hardens the accumulator so a zero-work turn with an error is an honest failure. Part B adds a single new MCP tool (`ask_founder`) that calls the already-DB-backed `agentRuntimeDecisionService.createPrompt({kind:"work_question"})` + `waitForAnswer`, guarded to agent-actor-with-active-run only, and teaches the hub panel to render option buttons. No schema change in either part.

**Tech Stack:** TypeScript, Node, Express 5, Drizzle ORM, Vitest, React + TanStack Query. Codex adapter package `@armyofagents/codex-local`.

---

## Repo rules that constrain this plan (read before coding)

- **Drizzle ORM only.** Neither part changes schema — do NOT run `pnpm db:generate`.
- **Preserve the billing guard.** Every codex spawn keeps `unsetEnvKeys: ["OPENAI_API_KEY"]`. Part A must NOT touch that.
- **No hosted-API calls.** Part A only writes a model string into a local config file; Part B only reads/writes DB rows. Neither adds a provider call.
- **Test patterns.** Server tests live in `server/src/__tests__/`; mock `@armyofagents/db` + `drizzle-orm` with Proxy table stubs + no-op operators; mock the service factory (`agentRuntimeDecisionService`) rather than importing drizzle internals. Adapter tests live under `packages/adapters/codex-local/src/server/__tests__/`. `agent-runtime-decisions.ts` emits via the **top-level** `logger` (`../middleware/logger.js`), not `logger.child()` — a service test that touches that path must mock the logger with top-level `info/warn/error/debug`. Part B's tool test mocks the service, so it does not hit that logger.
- **GIT-RACE LESSON.** File-coupled tasks are committed **sequentially by one committer**. Every commit step uses **explicit-path** `git add <files>` (never `-A` / `.` / `-u`), then `git diff --cached --stat` to confirm only the intended files are staged.

### File-coupling map (what MUST be sequential vs parallelizable)

Part A:
- **A1 → A2 → A3 → A4** all touch the `codex-local` adapter and are a single dependency chain (model must exist before it can be delivered; delivery must exist before the caller threads it). Commit sequentially, one committer. A1 also introduces the per-home config-write serializer and wraps the **existing** `writeCodexMcpConfigToml` in it — a behavior-preserving hardening of a pre-existing latent race, in the same file, same commit.
- **A5** (`resolve-crew-adapter.ts`, server) is **file-disjoint** from A1–A4 and may be done in parallel by a second worker, but its commit must still be its own explicit-path commit.
- **A6** (`parse-events.ts` M1 hardening + its test) is **file-disjoint** from A1–A5 (different file) and may parallelize; commit on its own.

Part B (all after Part A merges, or on a separate branch):
- **B1** (`ask-founder-tool.ts`, new file) and **B2** (`index.ts` registration) are **file-coupled at the registry** — B2 imports B1. Sequential: B1 then B2.
- **B3** (`RuntimeDecisionPanel.tsx` + its test) is **file-disjoint** (UI) and may parallelize with B1/B2.
- **B4** (docs + CLAUDE.md + decisions note) is last, after B1–B3 land.

---
---

# PART A — BUG-6: supervised codex turn completes EMPTY and falsely reports success

**Root cause (confirmed live):**
1. **Primary.** The supervised `codex app-server` path fires `turn/start` with **no model**. codex 0.130 falls back to `gpt-5.3-codex`, which a ChatGPT-auth account rejects with HTTP 400 → the turn ends with zero items. Live-proven: writing `model = "gpt-5.5"` into the managed `config.toml` made codex run gpt-5.5 with real sampling.
2. **Compounding.** The accumulator's `turn/completed` handler unconditionally clears the error frame, so the fatal 400 is masked as success (zero items, exit 0, false "succeeded").

**Delivery-mechanism decision (documented per the spec's requirement):** Use **(ii) — write `model = "<resolved>"` into the managed `config.toml` before spawn.** Justification from the code read:
- The exec path (`execute.ts:443`) delivers the model as a `--model` CLI arg to `codex exec`. The supervised path spawns `codex app-server` (no per-turn CLI arg surface), so the exec mechanism does not port directly.
- The app-server protocol doc (`docs/adapters/codex-appserver-protocol.md:38`) documents `turn/start` params as exactly `{ threadId, approvalPolicy, input }` — it does **NOT** confirm a `model` param. The spec instructs: if the doc does not confirm a `turn/start` model param, prefer (ii). So we do **not** add a model field to `turn/start`.
- (ii) is the PROVEN mechanism (live) and reuses the existing managed-home config writer pattern (`codex-config-toml.ts` / `writeCodexMcpConfigToml`), which already owns `<managedHome>/config.toml`, is idempotent, and preserves unrelated content. The app-server child runs with `env.CODEX_HOME = managedCodexHome` (`execute.ts:326`), so it reads that same file.

**Model resolution — via a package-LOCAL mirror (verified constraint):** the canonical `resolveCodexChatModel(configModel, sharedModel)` lives at `server/src/services/internal-agent/codex-model.ts:91` (returns `DEFAULT_CODEX_CHAT_MODEL = "gpt-5.5"` for empty/incompatible), but **the codex-local adapter package CANNOT import it** — `packages/adapters/codex-local/package.json` has no dependency on the server package, and there is NO shared re-export of the resolver anywhere reachable (verified: only `@armyofagents/adapter-utils` is a prod dep). A direct `server/src/...` import would fail module resolution. So A3 **unconditionally** adds a thin package-local mirror `packages/adapters/codex-local/src/server/resolve-chat-model.ts` that replicates the SAME three-line layered resolution (config → shared → `"gpt-5.5"`) + `isCodexCompatibleModel`, with a "keep in sync with `server/src/services/internal-agent/codex-model.ts`" header — the same intentional-duplication pattern that already exists between `codex-model.ts` and `packages/shared/src/validators/agent.ts`. The adapter package already exports `DEFAULT_CODEX_LOCAL_MODEL = "gpt-5.5"` (its `index.ts:4`), so the default is single-sourceable from there. `configModel` = `config.model` (`execute.ts:216`); `sharedModel` = `readSharedCodexModel(process.env)` from the package-local `./codex-home.ts:33`. **Preserve api-key mode:** only resolve + write the model when `billingType === "subscription"` (no OpenAI key), so a valid api-key `gpt-5.3-codex` is never rewritten.

## Files (Part A)

- Modify: `packages/adapters/codex-local/src/server/codex-config-toml.ts` — add exported `writeCodexModelConfigToml(managedHomeDir, model)` (new function) AND a module-level per-home serializer `withCodexHomeConfigLock(homeDir, fn)` that wraps BOTH `writeCodexModelConfigToml` and the existing `writeCodexMcpConfigToml` (the managed home is per-COMPANY — `prepareManagedCodexHome(..., agent.companyId, ...)` at `execute.ts:318` — so concurrent runs in one company share `<home>/config.toml`; two un-serialized read-strip-rewrite writers can lose each other's section and drop the `model =` line → re-introduce BUG-6).
- Create test: `packages/adapters/codex-local/src/server/__tests__/codex-config-toml.model.test.ts` (model writer + idempotency + preservation + **concurrent MCP+model serialization**).
- Modify: `packages/adapters/codex-local/src/server/app-server/driver.ts` — no change needed (model is NOT threaded to `turn/start`; delivery is via config.toml). *(No task; documented so a worker does not "fix" the driver.)*
- Modify: `packages/adapters/codex-local/src/server/execute-app-server.ts:60-78,85-101,153-175` — add `model?: string` + `managedCodexHome: string` to `RunAppServerTurnInput`; write the model config before spawn.
- Create test: `packages/adapters/codex-local/src/server/__tests__/execute-app-server.model-config.test.ts`
- Create: `packages/adapters/codex-local/src/server/resolve-chat-model.ts` — package-local mirror of `resolveCodexChatModel` + `isCodexCompatibleModel` (cross-package import of the server-side canonical is impossible; see "Model resolution" above).
- Modify: `packages/adapters/codex-local/src/server/execute.ts:216,739-753` — resolve the model (local mirror) + pass `model` + `managedCodexHome` into `runAppServerTurn`.
- Create test: `packages/adapters/codex-local/src/server/__tests__/execute-appserver-model-routing.test.ts`
- Modify: `server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts:201-213` — heal an EMPTY model on chatgpt-auth codex_local (Case 3).
- Modify test: `server/src/__tests__/` — add a case to the existing resolve-crew-adapter test suite (located in Task A5).
- Modify: `packages/adapters/codex-local/src/server/app-server/parse-events.ts:175-186` — M1 hardening.
- Modify test: `packages/adapters/codex-local/src/server/__tests__/appserver-parse-events.test.ts:208-224` — update the existing transient-error test + add two cases.

---

### Task A1: `writeCodexModelConfigToml` — write a top-level `model = "..."` line into the managed config.toml

**Files:**
- Modify: `packages/adapters/codex-local/src/server/codex-config-toml.ts` (append a new exported function after `writeCodexMcpConfigToml`, ~line 159)
- Test: `packages/adapters/codex-local/src/server/__tests__/codex-config-toml.model.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/codex-local/src/server/__tests__/codex-config-toml.model.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  writeCodexModelConfigToml,
  writeCodexMcpConfigToml,
} from "../codex-config-toml.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-model-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function readToml(): Promise<string> {
  return fs.readFile(path.join(home, "config.toml"), "utf8");
}

describe("writeCodexModelConfigToml", () => {
  it("writes a top-level model line into a fresh config.toml", async () => {
    await writeCodexModelConfigToml(home, "gpt-5.5");
    expect(await readToml()).toContain('model = "gpt-5.5"');
  });

  it("is idempotent — a second write does not duplicate the model line", async () => {
    await writeCodexModelConfigToml(home, "gpt-5.5");
    await writeCodexModelConfigToml(home, "gpt-5.5");
    const toml = await readToml();
    expect(toml.match(/^model = /gm)?.length ?? 0).toBe(1);
  });

  it("rewrites the model line to a new value without stacking", async () => {
    await writeCodexModelConfigToml(home, "gpt-5.5");
    await writeCodexModelConfigToml(home, "gpt-4o");
    const toml = await readToml();
    expect(toml.match(/^model = /gm)?.length ?? 0).toBe(1);
    expect(toml).toContain('model = "gpt-4o"');
    expect(toml).not.toContain('model = "gpt-5.5"');
  });

  it("preserves an existing [mcp_servers.aoa] block written by the MCP writer", async () => {
    await writeCodexMcpConfigToml(home, {
      command: "node",
      args: ["/tmp/bridge.js"],
      env: { AOA_API_KEY: "k" },
    });
    await writeCodexModelConfigToml(home, "gpt-5.5");
    const toml = await readToml();
    expect(toml).toContain("[mcp_servers.aoa]");
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('model = "gpt-5.5"');
  });

  it("escapes a double quote in the model value (defensive)", async () => {
    await writeCodexModelConfigToml(home, 'gp"t');
    expect(await readToml()).toContain('model = "gp\\"t"');
  });

  it("serializes concurrent MCP + model writes without losing either section", async () => {
    // The managed home is per-COMPANY, so two concurrent runs (Decision #5 allows
    // up to 50) race on <home>/config.toml. Both writers read-strip-rewrite; the
    // per-home lock must serialize them so neither section is lost. Fire both at
    // once and assert BOTH the [mcp_servers.aoa] block AND the model line survive.
    await Promise.all([
      writeCodexMcpConfigToml(home, {
        command: "node",
        args: ["/tmp/bridge.js"],
        env: { AOA_API_KEY: "k" },
      }),
      writeCodexModelConfigToml(home, "gpt-5.5"),
    ]);
    const toml = await readToml();
    expect(toml).toContain("[mcp_servers.aoa]");
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('model = "gpt-5.5"');
    // Exactly one of each — no duplicated/torn sections.
    expect(toml.match(/^model = /gm)?.length ?? 0).toBe(1);
    expect(toml.match(/\[mcp_servers\.aoa\]/g)?.length ?? 0).toBe(1);
  });
});
```

> **Note:** the concurrency test asserts serialization at the write layer. Because JS is single-threaded, an *un-serialized* pair of `await`-interleaved read-strip-rewrites is what loses a section — the lock makes each write's read observe the prior write's result. Run the test a few times locally to be confident it is deterministic (it should be: the lock imposes a total order).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run packages/adapters/codex-local/src/server/__tests__/codex-config-toml.model.test.ts`
Expected: FAIL — `writeCodexModelConfigToml is not a function` / not exported (and, once added without the lock, the concurrency test would be the one proving the lock is required).

- [ ] **Step 3: Write minimal implementation**

In `packages/adapters/codex-local/src/server/codex-config-toml.ts`, first add a module-level per-home write serializer near the top of the file (after the imports), then append the strip helper + `writeCodexModelConfigToml` after `writeCodexMcpConfigToml` (after line 159), and finally wrap BOTH writers' bodies in the lock.

Add the serializer (module scope):

```ts
/**
 * Serialize ALL config.toml mutations for a given managed home. The home is
 * per-COMPANY (`prepareManagedCodexHome(..., companyId, ...)`, execute.ts:318),
 * so concurrent heartbeat runs in one company share `<home>/config.toml`. Both
 * writers here do read-strip-rewrite; without serialization a concurrent
 * MCP-write + model-write can each read before the other's write lands and drop
 * the other's section — dropping the `model =` line silently re-introduces BUG-6
 * under concurrency (Decision #5 allows up to 50 concurrent runs). This is an
 * in-process, per-managed-home promise chain keyed by the resolved absolute path.
 * The stored tail swallows errors so one failed write never wedges the chain; the
 * caller still receives the real (possibly rejecting) promise.
 */
const configTomlWriteChains = new Map<string, Promise<unknown>>();
function withCodexHomeConfigLock<T>(
  managedHomeDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(managedHomeDir);
  const prev = configTomlWriteChains.get(key) ?? Promise.resolve();
  // Run fn AFTER prev settles (success OR failure): `.then(fn, fn)`.
  const run = prev.then(fn, fn);
  configTomlWriteChains.set(key, run.then(() => {}, () => {}));
  return run;
}
```

> `path` is already imported in this file (used by `writeCodexMcpConfigToml`'s `path.join`). If not, add `import path from "node:path";`.

Then the strip helper + model writer. Reuse the existing `tomlString` helper (line 59):

```ts
/**
 * Strip any existing top-level `model = ...` line(s) from the config.toml body,
 * BEFORE the first `[table]` header so we never touch a `[profiles.x]` /
 * `[model_providers.x]` model key (mirrors readSharedCodexModel's top-level-only
 * scan in codex-home.ts). Lines inside/after any table header are preserved.
 */
function stripTopLevelModelLine(existing: string): string {
  const lines = existing.split(/\r?\n/);
  const kept: string[] = [];
  let inTable = false;
  for (const line of lines) {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) inTable = true;
    if (!inTable && /^\s*model\s*=/.test(line)) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return kept.join("\n");
}

/**
 * Write/merge a top-level `model = "<model>"` line into
 * `<managedHomeDir>/config.toml` so a supervised `codex app-server` run (which
 * has no per-turn --model CLI surface) uses the resolved chat model instead of
 * codex's compiled-in default (gpt-5.3-codex, which 400s on a ChatGPT login).
 *
 * Idempotent + non-destructive: reads any existing config.toml, strips a prior
 * top-level `model =` line, preserves everything else (incl. the MCP bridge
 * block written by writeCodexMcpConfigToml), then prepends the fresh model line.
 * auth.json is never touched.
 */
export async function writeCodexModelConfigToml(
  managedHomeDir: string,
  model: string,
): Promise<void> {
  return withCodexHomeConfigLock(managedHomeDir, async () => {
    await fs.mkdir(managedHomeDir, { recursive: true });
    const target = path.join(managedHomeDir, "config.toml");

    let existing = "";
    try {
      existing = await fs.readFile(target, "utf8");
    } catch {
      existing = "";
    }

    const preserved = stripTopLevelModelLine(existing);
    const modelLine = `model = ${tomlString(model)}`;
    const body =
      preserved.trim().length > 0 ? `${modelLine}\n\n${preserved}\n` : `${modelLine}\n`;

    await fs.writeFile(target, body, "utf8");
  });
}
```

Finally, wrap the **existing** `writeCodexMcpConfigToml` body in the same lock so the two writers share one serialization chain. Find its current body (starts ~line 139: `export async function writeCodexMcpConfigToml(managedHomeDir, spec) { ... }`) and wrap the entire body:

```ts
export async function writeCodexMcpConfigToml(
  managedHomeDir: string,
  spec: CodexMcpBridgeSpec,
): Promise<void> {
  return withCodexHomeConfigLock(managedHomeDir, async () => {
    // ...EXISTING BODY UNCHANGED (mkdir → read → strip [mcp_servers.aoa] → rewrite)...
  });
}
```

> This is a behavior-preserving change (single-run behavior is identical; only concurrent-run torn/lost writes are eliminated). Do NOT alter the strip/rewrite logic inside — only indent it into the `withCodexHomeConfigLock` callback. Keep the existing `writeCodexMcpConfigToml` tests green (they exercise the single-writer path).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run packages/adapters/codex-local/src/server/__tests__/codex-config-toml.model.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/codex-local/src/server/codex-config-toml.ts \
        packages/adapters/codex-local/src/server/__tests__/codex-config-toml.model.test.ts
git diff --cached --stat
git commit -m "feat(codex): writeCodexModelConfigToml + per-home config-write lock (BUG-6 fix 1; hardens the shared per-company config.toml against concurrent MCP+model writes)"
```

---

### Task A2: thread the resolved model into `runAppServerTurn` and write it before spawn

**Files:**
- Modify: `packages/adapters/codex-local/src/server/execute-app-server.ts:25-42` (imports), `:60-78` (`RunAppServerTurnInput`), `:88-101` (destructure), `:153` (before spawn)
- Test: `packages/adapters/codex-local/src/server/__tests__/execute-app-server.model-config.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/codex-local/src/server/__tests__/execute-app-server.model-config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAppServerTurn } from "../execute-app-server.js";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-appserver-model-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function fakeDeps() {
  const client = {
    close: vi.fn(),
  };
  return {
    spawnAppServerClient: vi.fn(() => ({ client, terminate: vi.fn() })),
    driveCodexAppServer: vi.fn(async () => ({
      summary: "ok",
      usage: null,
      errorMessage: null,
      errorCode: null,
      sessionId: "t1",
      timedOut: false,
      clearSession: false,
    })),
    createAppServerResultAccumulator: vi.fn(() => ({
      onNotification: vi.fn(),
      result: () => ({ summary: "ok", usage: null, errorMessage: null, errorCode: null }),
    })),
  };
}

const baseInput = () => ({
  runId: "run-1",
  command: "codex",
  cwd: process.cwd(),
  env: {} as Record<string, string>,
  prompt: "do work",
  timeoutSec: 0,
  graceSec: 20,
});

describe("runAppServerTurn — model config delivery", () => {
  it("writes model into <managedCodexHome>/config.toml before spawn when model is set", async () => {
    const deps = fakeDeps();
    await runAppServerTurn(
      { ...baseInput(), model: "gpt-5.5", managedCodexHome: home, deps },
    );
    const toml = await fs.readFile(path.join(home, "config.toml"), "utf8");
    expect(toml).toContain('model = "gpt-5.5"');
    // The config write happens BEFORE the spawn.
    expect(deps.spawnAppServerClient).toHaveBeenCalledTimes(1);
  });

  it("does NOT write a config.toml when model is undefined (api-key mode preserved)", async () => {
    const deps = fakeDeps();
    await runAppServerTurn(
      { ...baseInput(), managedCodexHome: home, deps },
    );
    const exists = await fs
      .stat(path.join(home, "config.toml"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run packages/adapters/codex-local/src/server/__tests__/execute-app-server.model-config.test.ts`
Expected: FAIL — `model` / `managedCodexHome` not in `RunAppServerTurnInput` (type error) and no config.toml written.

- [ ] **Step 3: Write minimal implementation**

In `packages/adapters/codex-local/src/server/execute-app-server.ts`:

Add the import (after line 42):

```ts
import { writeCodexModelConfigToml } from "./codex-config-toml.js";
```

Extend `RunAppServerTurnInput` (inside the interface, after the `deps?` field near line 77):

```ts
  /**
   * Resolved codex-compatible chat model for the supervised path. When set (and
   * managedCodexHome is provided), written into <managedCodexHome>/config.toml
   * before spawn so a ChatGPT-auth account does not fall back to gpt-5.3-codex
   * (which 400s → empty turn). Left undefined in api-key mode, where the
   * compiled-in default is valid. (BUG-6 fix 1.)
   */
  model?: string;
  /** The adapter-owned CODEX_HOME the app-server child reads config.toml from. */
  managedCodexHome?: string;
```

Add to the destructure (after `onWarn,` near line 99):

```ts
    model,
    managedCodexHome,
```

Immediately before `const spawned = deps.spawnAppServerClient({` (line 153), insert:

```ts
  // BUG-6 fix 1: deliver the resolved chat model to the supervised path via the
  // managed config.toml (codex app-server has no per-turn --model flag). Only
  // when both are present — api-key mode leaves model undefined so the valid
  // compiled-in default (or a per-agent config) is untouched.
  if (model && managedCodexHome) {
    await writeCodexModelConfigToml(managedCodexHome, model);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run packages/adapters/codex-local/src/server/__tests__/execute-app-server.model-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/codex-local/src/server/execute-app-server.ts \
        packages/adapters/codex-local/src/server/__tests__/execute-app-server.model-config.test.ts
git diff --cached --stat
git commit -m "feat(codex): write resolved model to config.toml before supervised spawn (BUG-6 fix 1)"
```

---

### Task A3: resolve the model in `execute.ts` and pass it to `runAppServerTurn`

**Files:**
- Modify: `packages/adapters/codex-local/src/server/execute.ts:28-37` (imports), `:739-753` (bridged call)
- Test: `packages/adapters/codex-local/src/server/__tests__/execute-appserver-model-routing.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/codex-local/src/server/__tests__/execute-appserver-model-routing.test.ts`. This drives `execute` with the injectable `deps.runAppServerTurn` (already supported, `execute.ts:45-51`) and a minimal `ctx`, asserting the resolved model + managedCodexHome are threaded through:

```ts
import { describe, expect, it, vi } from "vitest";
import { execute } from "../execute.js";

/** Build a minimal AdapterExecutionContext that routes to the bridged path. */
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "Scout" },
    runtime: {},
    config: { command: "codex", model: "", ...(overrides.config as object ?? {}) },
    context: {},
    onLog: vi.fn().mockResolvedValue(undefined),
    onMeta: undefined,
    authToken: null,
    onSpawn: undefined,
    executionTarget: { type: "local" as const },
    // Routing flag: forces the bridged (app-server) path.
    runtimeDecisionRoutingEnabled: true,
    runtimeDecisionBroker: undefined,
    ...overrides,
  } as any;
}

describe("execute — supervised model routing (BUG-6 fix 1)", () => {
  it("resolves gpt-5.5 for an empty config model and threads model + managedCodexHome to runAppServerTurn", async () => {
    const runAppServerTurn = vi.fn().mockResolvedValue({
      summary: "ok",
      usage: null,
      errorMessage: null,
      errorCode: null,
      sessionId: "t1",
      timedOut: false,
      clearSession: false,
    });

    await execute(makeCtx({ config: { command: "codex", model: "" } }), {
      runAppServerTurn,
    });

    expect(runAppServerTurn).toHaveBeenCalledTimes(1);
    const arg = runAppServerTurn.mock.calls[0][0];
    // Empty/incompatible config model → resolveCodexChatModel default.
    expect(arg.model).toBe("gpt-5.5");
    // managedCodexHome must be a non-empty string (the adapter-owned home).
    expect(typeof arg.managedCodexHome).toBe("string");
    expect(arg.managedCodexHome.length).toBeGreaterThan(0);
  });

  it("passes a codex-compatible config model through unchanged (gpt-4o)", async () => {
    const runAppServerTurn = vi.fn().mockResolvedValue({
      summary: "ok",
      usage: null,
      errorMessage: null,
      errorCode: null,
      sessionId: "t1",
      timedOut: false,
      clearSession: false,
    });

    await execute(makeCtx({ config: { command: "codex", model: "gpt-4o" } }), {
      runAppServerTurn,
    });

    expect(runAppServerTurn.mock.calls[0][0].model).toBe("gpt-4o");
  });

  it("leaves model undefined in api-key mode (OPENAI_API_KEY present)", async () => {
    const runAppServerTurn = vi.fn().mockResolvedValue({
      summary: "ok",
      usage: null,
      errorMessage: null,
      errorCode: null,
      sessionId: "t1",
      timedOut: false,
      clearSession: false,
    });

    await execute(
      makeCtx({
        config: {
          command: "codex",
          model: "gpt-5.3-codex",
          env: { OPENAI_API_KEY: "sk-live" },
        },
      }),
      { runAppServerTurn },
    );

    // api-key mode: a valid gpt-5.3-codex is preserved; model NOT forced/rewritten.
    expect(runAppServerTurn.mock.calls[0][0].model).toBeUndefined();
  });
});
```

> **Note for the worker:** if `execute` reaches a real filesystem/command-resolvable check that fails under the test harness, guard the test by pointing `config.cwd` at `process.cwd()` and keeping `executionTarget.type: "local"`. `ensureCommandResolvable` is called for local targets (`execute.ts:366-368`); if it throws in CI, set `config.command` to a resolvable command (`"node"`) — the bridged path never actually spawns it because `deps.runAppServerTurn` is stubbed. Adjust the stub command in `makeCtx` if needed and record it in the commit.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run packages/adapters/codex-local/src/server/__tests__/execute-appserver-model-routing.test.ts`
Expected: FAIL — `arg.model` is `undefined` (execute does not yet resolve/pass a model on the bridged path).

- [ ] **Step 3: Write minimal implementation**

In `packages/adapters/codex-local/src/server/execute.ts`:

**3a. Create the package-local mirror** `packages/adapters/codex-local/src/server/resolve-chat-model.ts`. The canonical resolver lives at `server/src/services/internal-agent/codex-model.ts` but the adapter package cannot import from `server/src` (verified: no dependency, no shared re-export). This is a faithful copy of the compatible-model gate + layered resolver, with a keep-in-sync header — the same intentional-duplication pattern that already exists between `codex-model.ts` and `packages/shared/src/validators/agent.ts`:

```ts
/**
 * Package-local mirror of the codex chat-model resolver.
 *
 * CANONICAL SOURCE: server/src/services/internal-agent/codex-model.ts
 * (resolveCodexChatModel / isCodexCompatibleModel / the family+incompatible
 * regexes). The codex-local adapter package has no dependency on the server
 * package and there is no shared re-export, so this is an INTENTIONAL, faithful
 * duplication — keep the two in sync. Mirrors the existing codex-model.ts ↔
 * packages/shared/src/validators/agent.ts duplication pattern.
 *
 * Why it exists: a supervised `codex app-server` run with no model falls back to
 * the compiled-in gpt-5.3-codex, which a ChatGPT/subscription account rejects
 * with HTTP 400 → empty turn (BUG-6). We resolve a compatible model and deliver
 * it via config.toml.
 */
import { DEFAULT_CODEX_LOCAL_MODEL } from "../index.js"; // "gpt-5.5"

// Shell-safe identifier (argv interpolation guard). Full-string anchor.
const SAFE_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
// OpenAI/Codex naming families: gpt-*, o<N>*, chatgpt*, codex-*.
const CODEX_FAMILY_RE = /^(gpt-|o\d|chatgpt|codex)/i;
// GPT-Codex variants (…-codex / codex-…) are API-key-only → 400 on a ChatGPT
// login. Deny so a stray config/shared value can never reintroduce the 400.
const CODEX_INCOMPATIBLE_RE = /codex/i;

export function isCodexCompatibleModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.trim();
  return SAFE_MODEL_RE.test(m) && CODEX_FAMILY_RE.test(m) && !CODEX_INCOMPATIBLE_RE.test(m);
}

/**
 * Layered, validated resolution: config → shared ~/.codex/config.toml → the safe
 * default (gpt-5.5). Every source is validated so a claude default, a GPT-Codex
 * model, or a shell-unsafe string can never reach codex.
 */
export function resolveCodexChatModel(
  configModel: string | null | undefined,
  sharedModel: string | null | undefined,
): string {
  if (isCodexCompatibleModel(configModel)) return configModel!.trim();
  if (isCodexCompatibleModel(sharedModel)) return sharedModel!.trim();
  return DEFAULT_CODEX_LOCAL_MODEL;
}
```

> Before writing, grep to confirm `DEFAULT_CODEX_LOCAL_MODEL` is exported from `packages/adapters/codex-local/src/index.ts` and equals `"gpt-5.5"` (verified at index.ts:4). If for any reason it is absent, inline `const DEFAULT_CODEX_LOCAL_MODEL = "gpt-5.5";` in this file and note it. **Add a matching unit test** `packages/adapters/codex-local/src/server/__tests__/resolve-chat-model.test.ts` asserting: `resolveCodexChatModel("", null) === "gpt-5.5"`, `resolveCodexChatModel("gpt-5.3-codex", null) === "gpt-5.5"` (incompatible→default), `resolveCodexChatModel("gpt-4o", null) === "gpt-4o"`, and shared-fallback (`resolveCodexChatModel("", "gpt-4o") === "gpt-4o"`).

**3b. Wire it into `execute.ts`.** Add imports (with the other `./`-relative imports near `execute.ts:28-37`):

```ts
import { resolveCodexChatModel } from "./resolve-chat-model.js";
import { readSharedCodexModel } from "./codex-home.js"; // if not already imported
```

Then, at the bridged call site (`execute.ts:739`), resolve the model and pass it. Replace the existing `deps.runAppServerTurn({ ... })` call (lines 739-753) with a version that adds `model` + `managedCodexHome`:

```ts
    // BUG-6 fix 1: resolve a codex-compatible chat model and deliver it via the
    // managed config.toml (writeCodexModelConfigToml, inside runAppServerTurn).
    // Preserve api-key mode: a valid api-key model (gpt-5.3-codex) must not be
    // forced/rewritten, so only resolve when the run is subscription auth.
    const supervisedModel =
      billingType === "subscription"
        ? resolveCodexChatModel(model, await readSharedCodexModel(process.env))
        : undefined;

    const driverResult = await deps.runAppServerTurn({
      runId,
      command,
      cwd,
      env,
      prompt,
      timeoutSec,
      graceSec,
      session: sessionId ? { sessionId, cwd: runtimeSessionCwd || cwd } : undefined,
      broker: ctx.runtimeDecisionBroker,
      onSpawn,
      onWarn: (message) => {
        void onLog("stderr", `${message}\n`);
      },
      model: supervisedModel,
      managedCodexHome,
    });
```

> `billingType` is already computed at `execute.ts:364`; `model` is the local `config.model` (line 216); `managedCodexHome` is the local from `execute.ts:318`. All three are in scope at the bridged call site.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run packages/adapters/codex-local/src/server/__tests__/execute-appserver-model-routing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/codex-local/src/server/execute.ts \
        packages/adapters/codex-local/src/server/resolve-chat-model.ts \
        packages/adapters/codex-local/src/server/__tests__/resolve-chat-model.test.ts \
        packages/adapters/codex-local/src/server/__tests__/execute-appserver-model-routing.test.ts
git diff --cached --stat
git commit -m "feat(codex): resolve + thread supervised chat model on the bridged path (BUG-6 fix 1; package-local resolver mirror — adapter cannot import server codex-model.ts)"
```

---

### Task A4: verify supervised end-to-end wiring (no code — regression gate)

**Files:** none (verification only).

- [ ] **Step 1: Run the whole codex-local adapter suite**

Run: `pnpm test:run packages/adapters/codex-local`
Expected: PASS — all existing app-server tests still green (spike/driver/parse-events/failure-modes/spawn-teardown/jsonrpc-client) plus the three new model tests. This confirms A1–A3 did not regress the bridged path.

- [ ] **Step 2: Typecheck the adapter package**

Run: `pnpm --filter @armyofagents/codex-local typecheck`
Expected: PASS.

- [ ] **Step 3: Build the adapter package (import-resolution smoke for the local mirror)**

Run: `pnpm --filter @armyofagents/codex-local build`
Expected: PASS — proves `resolve-chat-model.ts`'s `import { DEFAULT_CODEX_LOCAL_MODEL } from "../index.js"` and the `execute.ts` → `./resolve-chat-model.js` import resolve at build time (the A3 test stubs `runAppServerTurn`, so only a real build exercises the new import edges). If the build fails on the `../index.js` import cycle, fall back to the inline `const DEFAULT_CODEX_LOCAL_MODEL = "gpt-5.5"` noted in A3/3a.

*(No commit — verification gate.)*

---

### Task A5: heal an EMPTY model on chatgpt-auth codex_local (resolve-crew-adapter Case 3)

**File-disjoint from A1–A4** (server package). May be done in parallel by a second worker; commit on its own.

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts:201-213`
- Test: the existing resolve-crew-adapter test suite.

- [ ] **Step 1: Locate the existing test file**

Run: `grep -rln "needsAdapterBackfill\|resolveCrewAdapterFor" server/src/__tests__ | head`
Record the file (e.g. `server/src/__tests__/resolve-crew-adapter.test.ts` or `crew-role-map.test.ts`). Add the new cases there. If no dedicated suite exists, create `server/src/__tests__/resolve-crew-adapter-empty-model.test.ts` importing `needsAdapterBackfill` directly (it is a pure function — no db mock needed).

- [ ] **Step 2: Write the failing test**

Add to the located suite (or the new file):

```ts
import { describe, expect, it } from "vitest";
import { needsAdapterBackfill } from "../services/internal-agent/aoa-agents/resolve-crew-adapter.js";

describe("needsAdapterBackfill — codex_local empty model (BUG-6 fix)", () => {
  it("heals an EMPTY model on chatgpt-auth codex_local (subscription)", () => {
    // No api-key auth, no own key, empty model → must backfill to the default.
    expect(needsAdapterBackfill("codex_local", { model: "" })).toBe(true);
    expect(needsAdapterBackfill("codex_local", {})).toBe(true);
  });

  it("does NOT heal an empty model when the run is api-key auth", () => {
    expect(
      needsAdapterBackfill("codex_local", { model: "" }, { isApiKeyAuth: true }),
    ).toBe(false);
  });

  it("does NOT heal an empty model when the agent carries its own OPENAI_API_KEY", () => {
    expect(
      needsAdapterBackfill("codex_local", {
        model: "",
        env: { OPENAI_API_KEY: "sk-live" },
      }),
    ).toBe(false);
  });

  it("still heals a non-empty incompatible model (gpt-5.3-codex) — unchanged", () => {
    expect(needsAdapterBackfill("codex_local", { model: "gpt-5.3-codex" })).toBe(true);
  });

  it("leaves a compatible model untouched (gpt-5.5)", () => {
    expect(needsAdapterBackfill("codex_local", { model: "gpt-5.5" })).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/<located-or-new-file>.test.ts`
Expected: FAIL — the first case returns `false` (current code at line 212 requires `model.length > 0`, so an empty model is never healed).

- [ ] **Step 4: Write minimal implementation**

In `server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts`, replace the Case 3 return (line 210-212) so an EMPTY model on subscription auth also heals. Current:

```ts
    if (opts?.isApiKeyAuth || hasOwnOpenAiKey(adapterConfig?.env)) return false;
    const model = typeof adapterConfig?.model === "string" ? adapterConfig.model : "";
    // A persisted codex model that a ChatGPT login would reject needs rewriting.
    return model.length > 0 && !isCodexCompatibleModel(model);
```

New:

```ts
    if (opts?.isApiKeyAuth || hasOwnOpenAiKey(adapterConfig?.env)) return false;
    const model = typeof adapterConfig?.model === "string" ? adapterConfig.model : "";
    // A persisted codex model that a ChatGPT login would reject needs rewriting.
    // An EMPTY model also needs healing on a ChatGPT/subscription run: with no
    // model, codex 0.130 falls back to gpt-5.3-codex and 400s → empty turn
    // (BUG-6). isCodexCompatibleModel("") is false, so dropping the length gate
    // heals both the empty and the non-empty-incompatible case; a compatible
    // model (gpt-5.5, gpt-4o) still returns false. api-key/own-key runs already
    // returned above, so gpt-5.3-codex stays valid there.
    return !isCodexCompatibleModel(model);
```

Also update the Case-3 JSDoc block (lines ~155-159) to add: "An empty model on a ChatGPT/subscription run is treated identically (codex falls back to the incompatible gpt-5.3-codex without one)."

> **Scope note (deliberate — reviewed against a narrowing suggestion):** the guard stays `!isCodexCompatibleModel(model)`, NOT a narrower `model === "" || model === "gpt-5.3-codex"`. Narrowing to the two known-bad strings would REGRESS the existing behavior — today's code (`model.length > 0 && !isCodexCompatibleModel(model)`) already heals *every* non-empty incompatible model, and narrowing would silently stop healing other incompatible values on a ChatGPT login. This change adds ONLY empty-model healing (drops the length gate); it does not widen or narrow the incompatible-model set. The broader "does `isCodexCompatibleModel` over-classify a founder-set exotic-but-valid model as incompatible?" question is **pre-existing** (unchanged by this plan) and out of scope for BUG-6. `isCodexCompatibleModel` is preserved verbatim from the canonical `codex-model.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/<located-or-new-file>.test.ts`
Expected: PASS. Then run the broader existing suite to catch a regression: `pnpm test:run server/src/__tests__/ -t "AdapterBackfill"` (or re-run the located file's whole describe).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts \
        server/src/__tests__/<located-or-new-file>.test.ts
git diff --cached --stat
git commit -m "fix(crew): heal an empty codex_local model on chatgpt-auth (BUG-6)"
```

---

### Task A6: M1 hardening — a zero-work completed turn with an error is an honest failure

**File-disjoint** (different file from A1–A5). May parallelize; commit on its own.

**Files:**
- Modify: `packages/adapters/codex-local/src/server/app-server/parse-events.ts:175-186`
- Modify test: `packages/adapters/codex-local/src/server/__tests__/appserver-parse-events.test.ts:208-224`

**Where errorMessage → exitCode:1 is mapped (cited per spec):** `packages/adapters/codex-local/src/server/execute.ts:685` — `bridgedResultToIntermediate` sets `exitCode: result.timedOut ? null : result.errorMessage ? 1 : 0`. So a preserved `errorMessage` maps to `exitCode:1` → heartbeat's outcome classifier reads it as a failure (honest). A cleared `errorMessage` + zero work → `exitCode:0` → false success (the bug).

- [ ] **Step 1: Update the existing transient-error test + add two cases**

In `packages/adapters/codex-local/src/server/__tests__/appserver-parse-events.test.ts`, the existing test at lines 208-223 ("clears a transient error when the turn later completes") feeds an `error` then `turn/completed` with `{ turn: {} }` and **no work** — after the fix that must NOT clear (zero work). Update it to include a real completed agentMessage so it still asserts the recovered-success intent, and add a new zero-work test.

Replace the existing test (lines 208-223) with:

```ts
  it("clears a transient error when the turn recovered AND produced work (M1)", () => {
    // A turn may emit a transient `error` (willRetry) frame, recover, produce a
    // real agent message, and settle on `turn/completed`. That is a SUCCESSFUL
    // turn — the accumulated errorMessage/errorCode must be cleared so
    // bridgedResultToIntermediate does NOT map it to exitCode:1. (M1)
    const acc = createAppServerResultAccumulator();
    acc.onNotification("error", {
      message: "stream disconnected",
      willRetry: true,
      code: "stream_error",
    });
    acc.onNotification("item/completed", {
      item: { type: "agentMessage", id: "m1", text: "Done." },
    });
    acc.onNotification("turn/completed", { turn: {} });
    const out = acc.result();
    expect(out.errorMessage).toBeNull();
    expect(out.errorCode).toBeNull();
    expect(out.summary).toBe("Done.");
  });

  it("PRESERVES a fatal error on a ZERO-WORK completed turn (masked-400 guard, M1 hardened)", () => {
    // The BUG-6 primary defect: a ChatGPT-auth 400 ends the turn with zero items
    // but codex still emits turn/completed. A completed turn with NO work AND an
    // error present is a masked fatal — the error must be PRESERVED so it maps to
    // exitCode:1 (honest failure) instead of a false "succeeded".
    const acc = createAppServerResultAccumulator();
    acc.onNotification("error", {
      message: "not supported when using Codex with a ChatGPT account",
      code: "http_400",
    });
    acc.onNotification("turn/completed", { turn: {} });
    const out = acc.result();
    expect(out.errorMessage).toBe(
      "not supported when using Codex with a ChatGPT account",
    );
    expect(out.errorCode).toBe("http_400");
    expect(out.summary).toBe("");
  });

  it("clears the error when work came only from an outputFile (fileChange) — producedWork counts files", () => {
    const acc = createAppServerResultAccumulator();
    acc.onNotification("error", { message: "transient", code: "x" });
    acc.onNotification("item/completed", {
      item: { type: "fileChange", changes: [{ path: "/tmp/out.txt" }] },
    });
    acc.onNotification("turn/completed", { turn: {} });
    const out = acc.result();
    expect(out.errorMessage).toBeNull();
    expect(out.outputFiles).toEqual(["/tmp/out.txt"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run packages/adapters/codex-local/src/server/__tests__/appserver-parse-events.test.ts`
Expected: FAIL — the new zero-work test expects a preserved error, but the current unconditional clear (line 183-184) nulls it.

- [ ] **Step 3: Write minimal implementation**

In `packages/adapters/codex-local/src/server/app-server/parse-events.ts`, replace the `turn/completed` case (lines 175-186) with:

```ts
        case "turn/completed": {
          // A completed turn that produced real work may carry a transient
          // (recovered) error frame — clear it. But a turn that completed with
          // ZERO work AND an error present is a masked fatal (e.g. an auth/model
          // 400 that ends the turn with no items): PRESERVE the error so
          // bridgedResultToIntermediate maps it to exitCode:1 instead of a false
          // "succeeded". (M1, hardened for BUG-6.)
          const producedWork =
            messageOrder.length > 0 || chunks.length > 0 || outputFiles.length > 0;
          if (producedWork) {
            errorMessage = null;
            errorCode = null;
          }
          return;
        }
```

> `messageOrder` (line 47), `chunks` (line 59), and `outputFiles` (line 69) are all in the accumulator closure — no new state needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run packages/adapters/codex-local/src/server/__tests__/appserver-parse-events.test.ts`
Expected: PASS (existing fixture/parity/idempotency tests + the three updated/added error tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/codex-local/src/server/app-server/parse-events.ts \
        packages/adapters/codex-local/src/server/__tests__/appserver-parse-events.test.ts
git diff --cached --stat
git commit -m "fix(codex): preserve a fatal error on a zero-work completed turn (BUG-6 fix 2, M1)"
```

---
---

# PART B — `ask_founder` MCP tool (agent asks the founder a question)

The runtime-decision machinery already exists and is DB-backed (`agentRuntimeDecisionService`). Only the **caller** is missing. No new table, no schema change.

**Locked product decisions (do NOT relitigate):**
1. Answer UI = free-text **AND** options[] choice buttons (panel renders buttons when `detail.options` present, else the existing textarea).
2. Blocking = synchronous — the tool awaits `waitForAnswer` and returns the answer.
3. Surface = **org/heartbeat task-execution agents ONLY** — guard on `ctx.actor.source === "agent"` AND an active `ctx.actor.runId`. Crew/internal-agent are out of scope (their channel is the in-thread reply). No polymorphic FK change; the existing `run_id → heartbeat_runs` scope is correct.
4. Timeout = park-on-timeout (`timeoutPolicy:"park_run"`) + a bounded ~5-min block; on timeout/cancel return a NON-error graceful `{answered:false, status:"parked"}` (NOT isError). The hub row keeps its own 24h TTL, reconciled by the existing sweep.

**Confirmed contracts from the code read:**
- `agentRuntimeDecisionService(db)` → `{ createPrompt, waitForAnswer, ... }` (`agent-runtime-decisions.ts:667,1171`).
- `createPrompt(input)` returns `{ decision, hubItem }` (line 798). Required input: `companyId, agentId, runId, adapterType, kind, nonce, title, timeoutPolicy`. `options?: Array<Record<string, unknown>> | null` (line 108). It 409s (`throw conflict("run is terminal")`) on a terminal/missing run — the zombie guard (lines 749-752).
- `waitForAnswer({ companyId, decisionId, timeoutMs })` returns the answered row (with `.answerPayload`), throws `RuntimeDecisionCancelledError` on cancelled (line 983), throws `conflict(...)` on timeout ("Timed out waiting for runtime decision answer", line 989) or a terminal status (line 986). It polls the DECISION row only (default 1s interval, `agent-runtime-decisions.ts:975-993`) — it does NOT itself watch run liveness.
- **Run-terminal release chain (verified):** when a heartbeat run goes terminal, `heartbeat.ts` calls `cancelRuntimeDecisionPromptsForRun(run,…)` → `agentRuntimeDecisionService(db).cancelActiveForRun({companyId, runId, reason})` at ALL four terminal sites — run-failed (`:2297`), terminal (`:4410`), watchdog (`:4608`), explicit cancel (`:5618`). That cancels the open `work_question`, so the next `waitForAnswer` poll observes `cancelled` and throws → the tool returns `parked` within ~1 poll (~1s). This is why the blocking wait is safe: a dead run never wedges it for the full 5-min bound.
- `assertAnswerMatches` for `work_question` requires `input.answer` present and `input.decision` absent (lines 884-886). The answer schema is `answer: z.record(z.unknown())` (`validators/hub.ts:135`) — `{ text }` or `{ value }` both validate.
- Actor-type gate is enforced in `server/src/mcp/server.ts:565-575` via `toolAllowedActors`. Unlisted tools are open to all authenticated actors; anonymous callers are already 401'd upstream (`server.ts:237`, Decision #14). We add `ask_founder` to `toolAllowedActors` restricted to `["agent"]`.
- `adapterType` comes from `ctx.services.agentsSvc.getById(agentId).adapterType` (`agents.ts:236-242,136`).
- The MCP server invokes handlers as `handler(ctx, args)` and maps `{ok:false,status,code,message}` to a JSON-RPC error (`server.ts:586-593`).

## Files (Part B)

- Create: `server/src/mcp/tools/ask-founder-tool.ts`
- Create test: `server/src/__tests__/ask-founder-tool.test.ts`
- Modify: `server/src/mcp/tools/index.ts:1-24` (import + `toolHandlers`), `:48-57` (`toolAllowedActors`), `:59-538` (`TOOL_DEFINITIONS`)
- Modify: `ui/src/components/hub/RuntimeDecisionPanel.tsx:62-70,98-111`
- Modify test: `ui/src/components/hub/__tests__/RuntimeDecisionPanel.test.tsx`
- Docs (Task B4): `docs/api/mcp.md`, `CLAUDE.md`, `docs/architecture/decisions.md`

---

### Task B1: `ask-founder-tool.ts` — the guarded, blocking work_question caller

**Files:**
- Create: `server/src/mcp/tools/ask-founder-tool.ts`
- Test: `server/src/__tests__/ask-founder-tool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/ask-founder-tool.test.ts`. Mock `agent-runtime-decisions.js` (the service factory + the cancelled error class) and `node:crypto`'s `randomUUID`. Build a minimal `ctx` matching `ToolContext`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const { createPrompt, waitForAnswer } = vi.hoisted(() => ({
  createPrompt: vi.fn(),
  waitForAnswer: vi.fn(),
}));

// Real cancelled-error class (the tool catches it by instanceof).
class FakeCancelledError extends Error {
  readonly decision: unknown;
  constructor() {
    super("cancelled");
    this.name = "RuntimeDecisionCancelledError";
    this.decision = {};
  }
}

vi.mock("../services/agent-runtime-decisions.js", () => ({
  agentRuntimeDecisionService: () => ({ createPrompt, waitForAnswer }),
  RuntimeDecisionCancelledError: FakeCancelledError,
}));

import { handleAskFounder } from "../mcp/tools/ask-founder-tool.js";

function makeCtx(actor: Record<string, unknown>, getById = vi.fn()) {
  return {
    db: {} as any,
    companyId: "co-1",
    actor: { userId: "agent-1", companyId: "co-1", keyId: null, ...actor },
    scope: { kind: "founder", userId: "agent-1" },
    services: { agentsSvc: { getById } },
    actorInfo: {},
    resolveRole: vi.fn(),
    resolveScopedAgentIds: vi.fn(),
  } as any;
}

beforeEach(() => {
  createPrompt.mockReset();
  waitForAnswer.mockReset();
});

describe("ask_founder tool", () => {
  it("403s when the caller is not an agent actor", async () => {
    const res = await handleAskFounder(
      makeCtx({ source: "board", agentId: null, runId: null }),
      { question: "Ship it?" },
    );
    expect(res.ok).toBe(false);
    expect((res as any).status).toBe(403);
  });

  it("403s when the agent has no active run", async () => {
    const res = await handleAskFounder(
      makeCtx({ source: "agent", agentId: "agent-1", runId: null }),
      { question: "Ship it?" },
    );
    expect(res.ok).toBe(false);
    expect((res as any).status).toBe(403);
  });

  it("creates a work_question prompt (park_run + options) and returns the answer", async () => {
    const getById = vi.fn().mockResolvedValue({ adapterType: "codex_local" });
    createPrompt.mockResolvedValue({ decision: { id: "d1" } });
    waitForAnswer.mockResolvedValue({ answerPayload: { value: "yes" } });

    const res = await handleAskFounder(
      makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }, getById),
      {
        question: "Ship the release?",
        options: [
          { label: "Yes", value: "yes" },
          { label: "No", value: "no" },
        ],
      },
    );

    expect(createPrompt).toHaveBeenCalledTimes(1);
    const arg = createPrompt.mock.calls[0][0];
    expect(arg.kind).toBe("work_question");
    expect(arg.timeoutPolicy).toBe("park_run");
    expect(arg.agentId).toBe("agent-1");
    expect(arg.runId).toBe("run-1");
    expect(arg.adapterType).toBe("codex_local");
    expect(arg.options).toEqual([
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" },
    ]);
    expect(res.ok).toBe(true);
    expect((res as any).data).toEqual({ answered: true, answer: { value: "yes" } });
  });

  it("returns a graceful parked result (NOT isError) when the wait is cancelled", async () => {
    const getById = vi.fn().mockResolvedValue({ adapterType: "codex_local" });
    createPrompt.mockResolvedValue({ decision: { id: "d1" } });
    waitForAnswer.mockRejectedValue(new FakeCancelledError());

    const res = await handleAskFounder(
      makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }, getById),
      { question: "Ship it?" },
    );

    expect(res.ok).toBe(true);
    expect((res as any).data).toEqual({
      answered: false,
      status: "parked",
      note: "parked for founder",
    });
  });

  it("returns a graceful parked result when the block times out", async () => {
    const getById = vi.fn().mockResolvedValue({ adapterType: "codex_local" });
    createPrompt.mockResolvedValue({ decision: { id: "d1" } });
    // waitForAnswer throws a plain conflict-style Error on timeout.
    waitForAnswer.mockRejectedValue(new Error("Timed out waiting for runtime decision answer"));

    const res = await handleAskFounder(
      makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }, getById),
      { question: "Ship it?" },
    );

    expect(res.ok).toBe(true);
    expect((res as any).data.status).toBe("parked");
  });

  it("propagates a terminal-run 409 from createPrompt (zombie guard)", async () => {
    const getById = vi.fn().mockResolvedValue({ adapterType: "codex_local" });
    const conflictErr = Object.assign(new Error("run is terminal"), { status: 409 });
    createPrompt.mockRejectedValue(conflictErr);

    await expect(
      handleAskFounder(
        makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }, getById),
        { question: "Ship it?" },
      ),
    ).rejects.toThrow("run is terminal");
  });

  it("rejects options with duplicate values (uniqueness guard)", async () => {
    const getById = vi.fn().mockResolvedValue({ adapterType: "codex_local" });
    // Duplicate option values would collide as React keys in the panel and make
    // the answer discriminator ambiguous — reject at call time.
    await expect(
      handleAskFounder(
        makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }, getById),
        {
          question: "Pick one?",
          options: [
            { label: "A", value: "x" },
            { label: "B", value: "x" },
          ],
        },
      ),
    ).rejects.toThrow(/unique/i);
    // Guard fired before any prompt was minted.
    expect(createPrompt).not.toHaveBeenCalled();
  });
});
```

> **Design note (block-timeout constant):** define `WORK_QUESTION_BLOCK_TIMEOUT_MS = 5 * 60 * 1000` in the tool file. There is an existing permission-side SLA constant `RUNTIME_HOOK_BLOCK_TIMEOUT_SEC` (`@armyofagents/adapter-utils`, used in `execute-app-server.ts:192`) — note the parallel in a comment but keep `WORK_QUESTION_BLOCK_TIMEOUT_MS` its own constant (the 24h hub TTL from `WORK_QUESTION_DEFAULT_TTL_MS` is separate and unaffected).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/ask-founder-tool.test.ts`
Expected: FAIL — `handleAskFounder` not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/mcp/tools/ask-founder-tool.ts`:

```ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agentRuntimeDecisionService,
  RuntimeDecisionCancelledError,
} from "../../services/agent-runtime-decisions.js";
import { type ToolContext, type ToolHandler, type ToolResult, err, ok } from "./types.js";

/**
 * Bounded synchronous block for a founder answer. The hub row keeps its own 24h
 * TTL (WORK_QUESTION_DEFAULT_TTL_MS in agent-runtime-decisions.ts) reconciled by
 * the expiry sweep; THIS constant bounds only how long the tool call blocks the
 * agent's run before returning a graceful "parked". Parallels the permission-side
 * RUNTIME_HOOK_BLOCK_TIMEOUT_SEC (adapter-utils) but is its own value.
 */
const WORK_QUESTION_BLOCK_TIMEOUT_MS = 5 * 60 * 1000;

/** Cap the decision title so a long question does not blow the hub-item chrome. */
const TITLE_CAP = 120;

const askFounderSchema = z
  .object({
    question: z.string().trim().min(1),
    options: z
      .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
      // Option values are the answer discriminator AND the panel's React keys —
      // duplicates would make the answer ambiguous and collide keys. Reject at
      // call time. (refine runs only when options is present — .optional() wraps it.)
      .refine((opts) => new Set(opts.map((o) => o.value)).size === opts.length, {
        message: "option values must be unique",
      })
      .optional(),
    context: z.string().optional(),
  })
  .strict();

function capped(text: string): string {
  return text.length <= TITLE_CAP ? text : `${text.slice(0, TITLE_CAP - 1)}…`;
}

/**
 * ask_founder — an org/heartbeat task-execution agent asks the founder a
 * question and blocks (bounded) for the answer. Surfaces via the existing
 * runtime-decision machinery (kind:"work_question"), so the founder answers in
 * the Inbox hub's RuntimeDecisionPanel.
 *
 * Guard (locked decision #3): agent actor WITH an active heartbeat run only.
 * Crew/internal-agent are out of scope (their channel is the in-thread reply).
 * The run_id → heartbeat_runs scope is the correct existing shape (no FK change).
 *
 * Block vs run lifetime (verified): the ~5-min WORK_QUESTION_BLOCK_TIMEOUT_MS is a
 * SOFT bound on how long this tool call blocks the run before returning "parked".
 * It does NOT outlive the run: when the heartbeat run goes terminal (failed /
 * cancelled / watchdog-killed / explicit cancel), heartbeat.ts calls
 * cancelRuntimeDecisionPromptsForRun → agentRuntimeDecisionService.cancelActiveForRun
 * (heartbeat.ts:2297,4410,4608,5618), which cancels this open work_question. The
 * NEXT waitForAnswer poll (≤ pollInterval, ~1s) then sees status "cancelled",
 * throws RuntimeDecisionCancelledError, and the catch below returns the graceful
 * {answered:false, status:"parked"} — so a dead run releases the block within ~1s
 * rather than hanging for the full 5 min. If the run's own wall-clock turn timeout
 * is shorter than 5 min, that same teardown path fires and the tool returns parked.
 * On a NON-error timeout of the block itself, the hub row lives on (24h TTL,
 * WORK_QUESTION_DEFAULT_TTL_MS) for the founder to answer later; the run is parked
 * by the park_run policy. Either way the model gets a terminal, non-retryable
 * result — it must STOP, not retry-loop.
 */
export async function handleAskFounder(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (ctx.actor.source !== "agent" || !ctx.actor.agentId || !ctx.actor.runId) {
    return err(403, -32003, "ask_founder requires an active run");
  }
  const parsed = askFounderSchema.parse(args);

  const agent = await ctx.services.agentsSvc.getById(ctx.actor.agentId);
  if (!agent) {
    return err(404, -32004, "Agent not found");
  }

  const svc = agentRuntimeDecisionService(ctx.db);
  // createPrompt 409s on a terminal/missing run (R1 zombie guard,
  // agent-runtime-decisions.ts:749-752), so a zombie CLI cannot mint questions —
  // let that throw propagate to the JSON-RPC error mapper.
  const { decision } = await svc.createPrompt({
    companyId: ctx.companyId,
    agentId: ctx.actor.agentId,
    runId: ctx.actor.runId,
    adapterType: agent.adapterType,
    kind: "work_question",
    nonce: randomUUID(),
    title: capped(parsed.question),
    promptText: parsed.question,
    summary: parsed.context ?? null,
    options: parsed.options ?? null,
    timeoutPolicy: "park_run",
  });

  try {
    const answered = await svc.waitForAnswer({
      companyId: ctx.companyId,
      decisionId: decision.id,
      timeoutMs: WORK_QUESTION_BLOCK_TIMEOUT_MS,
    });
    return ok({ answered: true, answer: answered.answerPayload });
  } catch (e) {
    // park_run timeout policy: on cancel (RuntimeDecisionCancelledError) OR the
    // bounded block timing out (conflict "Timed out..."), return a NON-error
    // graceful result so the model STOPS gracefully instead of retry-looping.
    // The hub row lives on (24h TTL) for the founder to answer later; the run is
    // parked by the timeout policy. Any OTHER error is a real failure — rethrow.
    if (e instanceof RuntimeDecisionCancelledError) {
      return ok({ answered: false, status: "parked", note: "parked for founder" });
    }
    if (e instanceof Error && /timed out/i.test(e.message)) {
      return ok({ answered: false, status: "parked", note: "parked for founder" });
    }
    throw e;
  }
}

export const askFounderToolHandlers: Record<string, ToolHandler> = {
  ask_founder: handleAskFounder,
};
```

> **Type note:** `agent.adapterType` is `string` (agents.ts:136). `createPrompt`'s `adapterType` param is `string` — match. `options` param is `Array<Record<string, unknown>> | null`; the zod-parsed `{label,value}` objects satisfy `Record<string, unknown>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/ask-founder-tool.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/tools/ask-founder-tool.ts \
        server/src/__tests__/ask-founder-tool.test.ts
git diff --cached --stat
git commit -m "feat(mcp): ask_founder tool — blocking work_question caller (agent+run gated)"
```

---

### Task B2: register `ask_founder` in the tool registry + actor gate + definition

**File-coupled with B1** (imports it). Sequential: after B1.

**Files:**
- Modify: `server/src/mcp/tools/index.ts:1-24,48-57,536-538`

- [ ] **Step 1: Write the failing test**

Add a registry test. Create `server/src/__tests__/ask-founder-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toolHandlers, toolAllowedActors, TOOL_DEFINITIONS } from "../mcp/tools/index.js";

describe("ask_founder registration", () => {
  it("is registered in toolHandlers", () => {
    expect(typeof toolHandlers["ask_founder"]).toBe("function");
  });

  it("is gated to agent actors only", () => {
    expect(toolAllowedActors["ask_founder"]).toEqual(["agent"]);
  });

  it("has a TOOL_DEFINITIONS entry with a required question and optional options/context", () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === "ask_founder");
    expect(def).toBeTruthy();
    expect(def!.inputSchema.required).toContain("question");
    expect(def!.inputSchema.properties).toHaveProperty("options");
    expect(def!.inputSchema.properties).toHaveProperty("context");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/ask-founder-registry.test.ts`
Expected: FAIL — `ask_founder` not in the maps/definitions.

- [ ] **Step 3: Write minimal implementation**

In `server/src/mcp/tools/index.ts`:

Add the import (after line 6, with the other tool-handler imports):

```ts
import { askFounderToolHandlers } from "./ask-founder-tool.js";
```

Add to the `toolHandlers` spread (inside the object, after `...skillToolHandlers,` line 23):

```ts
  ...askFounderToolHandlers,
```

Add the actor gate to `toolAllowedActors` (after the `"use_skill"` entry, line 56, before the closing `}`):

```ts
  // ask_founder is org/heartbeat task-execution agents ONLY. The handler
  // additionally requires an active runId; crew/internal-agent (whose question
  // channel is the in-thread reply) are excluded by this actor gate. board/mcp/
  // commander cannot call it.
  "ask_founder": ["agent"],
```

Add the `TOOL_DEFINITIONS` entry (append after the `use_skill` entry, before the closing `]` at line 538):

```ts
  {
    name: "ask_founder",
    description:
      "Ask the founder a question and block (up to ~5 min) for the answer. For " +
      "org/heartbeat task-execution agents during an active run only. Surfaces in " +
      "the Inbox as a question the founder answers (free-text, or one of your " +
      "options). On timeout the run is parked and you get {answered:false, " +
      "status:\"parked\"} — stop gracefully; do not retry.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
            },
            required: ["label", "value"],
          },
        },
        context: { type: "string" },
      },
      required: ["question"],
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/ask-founder-registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/tools/index.ts \
        server/src/__tests__/ask-founder-registry.test.ts
git diff --cached --stat
git commit -m "feat(mcp): register ask_founder (agent-only gate + tool definition)"
```

---

### Task B3: RuntimeDecisionPanel — render option buttons for a work_question when options are present

**File-disjoint** (UI). May parallelize with B1/B2.

**Files:**
- Modify: `ui/src/components/hub/RuntimeDecisionPanel.tsx:62-70,98-111`
- Modify test: `ui/src/components/hub/__tests__/RuntimeDecisionPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

In `ui/src/components/hub/__tests__/RuntimeDecisionPanel.test.tsx`, add after the existing work_question test (line 127). The panel posts `{answer:{value}}` for an option and `{answer:{text}}` for free-text:

```ts
  it("renders option buttons and posts {answer:{value}} for a work_question with options", async () => {
    const { fireEvent } = await import("@testing-library/react");
    detailSpy.mockResolvedValueOnce(
      permissionDetail({
        kind: "work_question",
        options: [
          { label: "Approve", value: "approve" },
          { label: "Hold", value: "hold" },
        ] as any,
      }),
    );
    answerSpy.mockResolvedValueOnce(permissionDetail({ kind: "work_question" }));
    renderPanel(runtimeDecisionItem());

    const approve = await screen.findByRole("button", { name: /approve/i });
    expect(screen.getByRole("button", { name: /hold/i })).toBeInTheDocument();
    // No free-text box when options are present.
    expect(screen.queryByLabelText(/work question answer/i)).not.toBeInTheDocument();

    fireEvent.click(approve);
    await waitFor(() => expect(answerSpy).toHaveBeenCalledTimes(1));
    const payload = answerSpy.mock.calls[0][2];
    expect(payload).toMatchObject({ kind: "work_question", answer: { value: "approve" } });
  });

  it("still renders the free-text box when a work_question has no options", async () => {
    detailSpy.mockResolvedValueOnce(permissionDetail({ kind: "work_question", options: null }));
    renderPanel(runtimeDecisionItem());
    expect(await screen.findByLabelText(/work question answer/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui test:run src/components/hub/__tests__/RuntimeDecisionPanel.test.tsx` (or `cd ui && npx vitest run src/components/hub/__tests__/RuntimeDecisionPanel.test.tsx`)
Expected: FAIL — no option buttons; the free-text box renders even with options.

- [ ] **Step 3: Write minimal implementation**

In `ui/src/components/hub/RuntimeDecisionPanel.tsx`, add an option-submit handler next to `submitQuestion` (after line 70):

```ts
  const submitQuestionOption = (value: string) => {
    answerMutation.mutate({
      kind: "work_question",
      answer: { value },
      expectedSourceRevision: detail.sourceRevision,
      nonce: detail.nonce,
    });
  };
```

Replace the work_question branch (the `else` block, lines 98-111) with an options-aware version:

```tsx
      ) : detail.options && detail.options.length > 0 ? (
        <div className="mt-4 grid gap-2">
          {detail.options.map((opt) => (
            <Button
              key={opt.value}
              type="button"
              size="sm"
              disabled={disabled}
              onClick={() => submitQuestionOption(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="mt-4 grid gap-2">
          <textarea
            aria-label="Work question answer"
            value={answerText}
            disabled={disabled}
            onChange={(event) => setAnswerText(event.target.value)}
            className="min-h-24 resize-y rounded border border-border bg-bg p-2 text-sm"
          />
          <Button type="button" size="sm" disabled={disabled || !answerText.trim()} onClick={submitQuestion}>
            Send answer
          </Button>
        </div>
      )}
```

> `detail.options` is typed on `RuntimeDecisionDetail` as `{label,value}[] | null` (validators/hub.ts runtimeDecisionDetailSchema ~:164). **Narrative correction (verified):** the permission branch renders **hardcoded** allow_once/allow_always/deny buttons (RuntimeDecisionPanel.tsx:86-97) — it does NOT render from `detail.options`. Option-button rendering from `detail.options` does not exist anywhere yet; B3 ADDS it for the work_question branch (the button styling can mirror the permission branch's `<Button size="sm">` usage, but the data source — `detail.options` — is new).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/components/hub/__tests__/RuntimeDecisionPanel.test.tsx`
Expected: PASS (existing permission/work_question/unavailable/error tests + the two new option tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/hub/RuntimeDecisionPanel.tsx \
        ui/src/components/hub/__tests__/RuntimeDecisionPanel.test.tsx
git diff --cached --stat
git commit -m "feat(hub): render option buttons for a work_question decision (ask_founder UI)"
```

---

### Task B4: Full suite + docs + decisions note

**Last** — after A1–A6 and B1–B3 land.

**Files:**
- Modify: `docs/api/mcp.md:3,49-60`
- Modify: `CLAUDE.md:201`
- Modify: `docs/architecture/decisions.md` (append a note)

- [ ] **Step 1: Run the full server test suite**

Run: `pnpm test:run server`
Expected: PASS — no regression from the new `ask_founder` handler/registry or the resolve-crew-adapter change.

- [ ] **Step 2: Run the full adapter suite + adapter-utils**

Run: `pnpm test:run packages/adapters/codex-local packages/adapter-utils`
Expected: PASS — Part A changes green.

- [ ] **Step 3: Run the UI hub suite**

Run: `cd ui && npx vitest run src/components/hub`
Expected: PASS.

- [ ] **Step 4: Update `docs/api/mcp.md`**

- Line 3 frontmatter: change `34 tools and 4 resources` → `35 tools and 4 resources`.
- Line 6 body: same `34` → `35` if present.
- Line 49 heading `## Tools — Write (8)` → `## Tools — Write (9)`. Append a row to the Write table (after `attach-artifact-version`, line 60):

```md
| `ask_founder` | Ask the founder a question and block (~5 min) for the answer. Org/heartbeat task-execution agents during an active run ONLY (403 otherwise). Surfaces in the Inbox hub. On timeout the run is parked → returns `{answered:false, status:"parked"}`. Required: `question`. Optional: `options` (`[{label,value}]`), `context` |
```

Also add the MISSING `memory.write` row (the registry has it; the table omits it) so the table lists all 9 Write tools and matches the "Write (9)" count. Grep the registry for the exact `memory.write` name/description to write an accurate row:

```md
| `memory.write` | Write a memory item (agent-suggested, founder-gated per the memory approval model). |
```

> **Note for the doc author:** the pre-existing table listed 7 rows under "Write (8)" (missing `memory.write`). After this task it lists **9** rows under "Write (9)": the original 7 + the true-up `memory.write` row + the new `ask_founder` row. This keeps the count and the table consistent (no silent drift). Verify the exact `memory.write` description against `server/src/mcp/tools/index.ts` `TOOL_DEFINITIONS` rather than inventing copy.

- [ ] **Step 5: Update `CLAUDE.md`**

Line 201, change:

```md
**Outbound (AoA as MCP server) — 34 tools total, RBAC-scoped:** Read (11), Write (8), Document (5), Approval (10).
```

to:

```md
**Outbound (AoA as MCP server) — 35 tools total, RBAC-scoped:** Read (11), Write (9), Document (5), Approval (10).
```

- [ ] **Step 6: Add a note to `docs/architecture/decisions.md`**

Append under the most recent decisions section a short note (do NOT relitigate a locked decision — this documents the caller landing):

```md
- **work_question caller landed (Part B of the BUG-6 + work_question plan, 2026-07-04).**
  The `ask_founder` MCP tool is the deferred `work_question` caller referenced by
  Decision #107. It is org/heartbeat task-execution-agent-only (guarded on
  `actor.source==="agent"` + an active `runId`); crew/internal-agent question
  channel remains the in-thread reply. `timeoutPolicy:"park_run"` with a bounded
  ~5-min synchronous block; on timeout/cancel the tool returns a non-error
  `{answered:false, status:"parked"}` and the hub row keeps its own 24h TTL. No
  schema change — reuses the existing `run_id → heartbeat_runs` runtime-decision
  scope. See `server/src/mcp/tools/ask-founder-tool.ts`.
- **BUG-6 codex supervised fix (Part A, 2026-07-04).** The supervised
  `codex app-server` path now resolves a codex-compatible chat model
  (`resolveCodexChatModel` default `gpt-5.5`) and delivers it via the managed
  `config.toml` (`writeCodexModelConfigToml`) so a ChatGPT-auth account never
  falls back to the incompatible `gpt-5.3-codex`; api-key mode is untouched. The
  accumulator now PRESERVES a fatal error on a zero-work completed turn so a
  masked 400 surfaces as an honest failed run instead of a false success.
```

- [ ] **Step 7: Commit**

```bash
git add docs/api/mcp.md CLAUDE.md docs/architecture/decisions.md
git diff --cached --stat
git commit -m "docs: ask_founder MCP tool (35 tools / Write 9) + BUG-6 supervised-fix notes"
```

> **Environment note (NOT a code task):** this account is separately out of Codex credits until Jul 7. After Part A fix 2, a usage-limit run surfaces HONESTLY as a failed run instead of a fake success — that is the CORRECT post-fix behavior. Do NOT attempt to "fix" the credit state.

---
---

## Self-Review

**1. Spec coverage.**

Part A:
- FIX 1 model resolution + delivery — A1 (config writer), A2 (deliver before spawn), A3 (resolve + thread in execute.ts). Delivery mechanism (ii) chosen + justified against `codex-appserver-protocol.md:38` (no `turn/start` model param) ✅.
- Model resolver — A3 creates a faithful package-local mirror of `resolveCodexChatModel` (cross-package import is impossible; verified) with a keep-in-sync header + its own unit test ✅.
- Preserve api-key mode — A3 only resolves when `billingType === "subscription"`; test asserts `model` undefined with `OPENAI_API_KEY` ✅.
- Preserve `unsetEnvKeys:["OPENAI_API_KEY"]` — untouched; A2/A3 do not modify the spawn env or the existing `unsetEnvKeys` in `execute-app-server.ts:164` ✅.
- Package-coupling — A3 creates a package-local `resolve-chat-model.ts` mirror (verified: adapter cannot import server's `codex-model.ts`); A4 build step smokes the import edges ✅.
- Concurrency — A1's `withCodexHomeConfigLock` serializes the shared per-company `config.toml` across the model + MCP writers; concurrency test proves both sections survive ✅.
- resolve-crew-adapter Case 3 heals EMPTY model — A5, with api-key/own-key preservation; keeps the broad `!isCodexCompatibleModel` heal (narrowing rejected — would regress existing incompatible-model healing) ✅.
- FIX 2 M1 masking — A6; `producedWork` gate; cited `bridgedResultToIntermediate` at `execute.ts:685` for errorMessage→exitCode:1; updated the existing transient-error test (which had zero work) + added zero-work-preserve + fileChange-clears cases ✅.

Part B:
- New `ask-founder-tool.ts` `ToolHandler`, actor+run guard, createPrompt(work_question, park_run, options) + waitForAnswer, graceful parked catch — B1 ✅.
- Register in `index.ts` (`toolHandlers` + `toolAllowedActors: ["agent"]` + `TOOL_DEFINITIONS`) — B2 ✅.
- Panel option buttons + free-text fallback, post `{answer:{value}}` / `{answer:{text}}` — B3 ✅.
- Answer payload shape confirmed against `assertAnswerMatches` (answer present, no decision) + `runtimeDecisionAnswerSchema` (`answer: z.record`) ✅.
- Option-value uniqueness guarded in `askFounderSchema` `.refine` (B1) + tested; makes B3's `opt.value` React key safe ✅.
- Run-terminal release chain documented + relied on: `cancelActiveForRun` at all 4 heartbeat terminal sites cancels the open work_question so `waitForAnswer` releases in ~1s — the block never wedges a dead run ✅.
- Tests (a)-(d) + uniqueness all present in B1; panel test (options + free-text fallback) in B3 ✅.
- zombie 409 cited (createPrompt R1 guard, lines 749-752) and tested (B1 last case) ✅.
- RBAC / anonymous exclusion cited (`server.ts:565-575` gate + `:237` 401) ✅.
- Docs count 34→35 / Write 8→9 + decisions note — B4 ✅.

**2. Placeholder scan.** No "TBD"/"add error handling"/"similar to". Every code step shows real code. A3's resolver mirror is concrete code (not a conditional); the only build-time choice (import `DEFAULT_CODEX_LOCAL_MODEL` vs inline const) is decided by the A4 build smoke, not deferred as a placeholder. ✅

**3. Type consistency.** `handleAskFounder` / `askFounderToolHandlers` names consistent across B1↔B2↔test. `writeCodexModelConfigToml(managedHomeDir, model)` signature consistent across A1↔A2. `RunAppServerTurnInput.model?/managedCodexHome?` consistent across A2↔A3. `createPrompt` arg shape matches the read `CreatePromptInput` (companyId/agentId/runId/adapterType/kind/nonce/title/options/timeoutPolicy). `answerPayload` read from `waitForAnswer`'s row (agent-runtime-decisions.ts:916,981). ✅

## Risks / Open Questions (found while reading the code)

1. **Cross-package import for `resolveCodexChatModel` (A3) — RESOLVED.** Verified: the codex-local adapter package has NO dependency on the server package and there is NO shared re-export of `resolveCodexChatModel`/`isCodexCompatibleModel` anywhere reachable — a `server/src/...` import would fail module resolution. A3 therefore **unconditionally** creates the package-local mirror `resolve-chat-model.ts` (faithful copy of `codex-model.ts:44-98`, keep-in-sync header, default single-sourced from the adapter's `DEFAULT_CODEX_LOCAL_MODEL`). The A4 build step is the import-resolution smoke. No open question remains; the only implementer choice is inline-const vs `../index.js` import for the default (build step decides).

2. **`readSharedCodexModel(process.env)` reads the ambient CODEX_HOME.** In A3 the shared-model fallback reads `~/.codex/config.toml` (or `$CODEX_HOME`). That is the intended behavior (mirrors Commander), but note the managed home has already been assigned to `env.CODEX_HOME` on the run env — passing `process.env` (not the run `env`) keeps it reading the SHARED home, which is correct. The plan passes `process.env` explicitly.

3. **`execute` test harness reachability (A3).** `execute` runs real filesystem/`ensureCommandResolvable` work before the bridged branch. The A3 test stubs `deps.runAppServerTurn` but the pre-branch code still runs; the plan flags a `command:"node"` / `cwd:process.cwd()` fallback if CI's command-resolvable check throws. If the pre-branch surface is too heavy to unit-test cleanly, the implementer may instead assert the resolution logic by extracting a tiny pure helper (`resolveSupervisedModel(billingType, configModel, sharedModel)`) and unit-testing THAT directly — a reasonable DRY alternative if the full-`execute` test proves flaky. Left as implementer discretion.

4. **`docs/api/mcp.md` Write table was already stale** (listed 7 rows under "Write (8)", omitted `memory.write`). B4 now trues it up: adds the missing `memory.write` row AND the new `ask_founder` row → 9 rows under "Write (9)", count and table consistent (no silent drift).

5. **Panel option `value` uniqueness — GUARDED.** B3 uses `opt.value` as the React `key`. Duplicate values would collide keys and make the answer ambiguous. Now prevented at the source: `askFounderSchema` (B1) `.refine`s option values to be unique, so a duplicate is rejected at call time (403/ZodError) before any prompt is minted — tested in B1. B3's key usage is therefore safe by construction.

6. **Shared per-company `config.toml` write-race — MITIGATED (serialized), with a noted residual.** The managed codex home is per-COMPANY (`prepareManagedCodexHome(..., agent.companyId, ...)`, `execute.ts:318`), so concurrent runs in one company share `<home>/config.toml`. A1 adds a per-home in-process serializer (`withCodexHomeConfigLock`) wrapping BOTH the model writer and the existing MCP writer, eliminating torn/lost writes (also hardens a pre-existing latent race in the MCP writer). **Residual (out of scope, follow-up):** two concurrent runs of DIFFERENT agents in one company that resolve to DIFFERENT models still share one file — run B's model line can overwrite run A's between A's write and A's codex spawn/read. This is bounded (a ~ms window per run) and does not occur at the default concurrency clamp of 1 (Divergence §D5); fully solved only by a per-run CODEX_HOME, tracked as a follow-up gated on teams opting per-agent concurrency up. The serializer prevents *corruption*; the per-run-home follow-up prevents *cross-agent model bleed* at high concurrency.

7. **A6 existing-test breakage is intentional and load-bearing.** The current test at `appserver-parse-events.test.ts:208-223` feeds `turn/completed` with ZERO work and asserts the error is cleared — that is exactly the masking behavior BUG-6 fixes. A6 REWRITES that test to add real work (preserving the recovered-success intent) rather than deleting it. A worker running A6 must edit that block, not just append — the plan makes the replacement explicit.
