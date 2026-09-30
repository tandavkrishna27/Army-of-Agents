/**
 * cli-mode-codex-integration.test.ts  (Plan Task A — KEYSTONE)
 *
 * Real fake-codex spawn integration test. Does NOT mock child_process.
 * Instead uses the deterministic fake-codex fixture (tests/e2e/fixtures/fake-codex/)
 * placed on PATH so Commander's cli-mode finds and spawns it the exact same way
 * it would spawn the real codex CLI.
 *
 * Plan-review resolution #8: The route-SSE test (internal-agent-chat-route-sse.test.ts)
 * mocks cliService.chat and does NOT prove the codex parser/spawn seam. THIS test does.
 *
 * What it proves:
 *  1. SPAWN: Commander's detectCliTool resolves the fake-codex shim from PATH and
 *     spawns it. The invocation record (written by the shim) proves real spawn happened.
 *  2. ARGV: The spawned argv matches the codex contract — exec --json
 *     [--dangerously-bypass-approvals-and-sandbox] --model <codex-model> -c
 *     model_reasoning_effort=high -c model_reasoning_summary=detailed [-]
 *  3. MODEL: A claude default model string (e.g. "claude-sonnet-4-6") is resolved to
 *     a codex-compatible model (DEFAULT_CODEX_CHAT_MODEL = "gpt-5.5") before spawn.
 *  4. CODEX_HOME: The spawn env carries a managed CODEX_HOME; config.toml was written
 *     there by cli-mode before spawn (configTomlExists === true in the invocation record).
 *  5. CHUNKS: The yielded chunks from cliModeService.chat are: reasoning → text → done,
 *     with tokenUsage from turn.completed AND model/provider="openai" (F1 provenance).
 *  6. RESUME: A second turn's invocation argv contains `resume <sessionId>` proving
 *     real resume continuity, not shim defaulting.
 *  7. FAIL: When the control file has fail:"model-400", chat yields {type:"error"}
 *     whose message contains the parsed turn.failed errorMessage.
 *  8. CLI-UNAVAILABLE: When PATH does not contain the codex binary, chat yields
 *     {type:"error"} with the install/availability message (plan-review #4).
 *
 * Setup:
 *  - beforeAll: prepend fake-codex fixture dir to process.env.PATH; import cliModeService.
 *  - Disk helpers (writeCodexMcpConfigToml, ensureCodexAuthInHome, readSharedCodexModel)
 *    are mocked so cli-mode never touches the real ~/.codex — only the spawn itself is real.
 *  - Each test uses a unique companyId:userId pair to isolate the session store.
 *  - Note: vi.resetModules() is NOT used inside test functions — it causes async ticks
 *    that let the fake-codex process exit before the 'exit' listener is registered
 *    (Node.js ChildProcess: missed-exit is an actual race on fast processes).
 *
 * Platform: Windows (shell:true → codex.cmd resolves); also correct on Linux/macOS.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const WORKTREE_ROOT = path.resolve(
  __dirname,
  "..", "..", "..",   // server/src/__tests__ → worktree root (3 levels up)
);

const FAKE_CODEX_BIN_DIR = path.join(
  WORKTREE_ROOT,
  "tests", "e2e", "fixtures", "fake-codex",
);

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks — registered before any imports (hoisted by vitest)
// ─────────────────────────────────────────────────────────────────────────────

// fs.statSync is used by getBridgeEntrypoint() to detect production vs dev mode.
// Return a truthy object so it sees the .js "exists" → uses `node` not `tsx`.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(() => ({ isFile: () => true })) };
});

// fs/promises.writeFile — stubbed so cli-mode never writes the MCP config JSON
// to a real temp path (the codex path uses writeCodexMcpConfigToml from the
// adapter mock below; this covers the claude path as a safety net).
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
}));

// Adapter helpers: stub disk/auth I/O; keep REAL parseCodexJsonl + isCodexUnknownSessionError.
// writeCodexMcpConfigToml is stubbed to create the actual dir + config.toml on disk
// (using real synchronous fs) so the fake-codex shim records configTomlExists===true.
vi.mock("@armyofagents/adapter-codex-local/server", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@armyofagents/adapter-codex-local/server")
  >();
  return {
    ...actual,
    writeCodexMcpConfigToml: vi.fn(async (dir: string) => {
      // Create dir + write a minimal config.toml on disk using synchronous real fs
      // (bypasses the mocked fs/promises). This ensures the fake-codex shim's
      // statSync(join(codexHome,"config.toml")).isFile() returns true.
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "config.toml"), "[mcp_servers]\n", "utf8");
      } catch { /* best-effort */ }
    }),
    ensureCodexAuthInHome: vi.fn(async () => true),
    readSharedCodexModel: vi.fn(async () => null), // null → falls through to DEFAULT_CODEX_CHAT_MODEL
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// PATH setup — module level, not beforeAll
//
// vitest workers inherit process.env from the forked runner, but `execSync` and
// `spawn` see the env at call-time. Setting PATH here (module body) ensures it
// is in place before any test function runs, which is what execSync sees when
// detectCliTool("codex") calls `where codex` inside spawnAndCollect.
//
// beforeAll is too late in practice: vitest may evaluate the module body
// synchronously before beforeAll fires in the same tick, so PATH needs to be
// patched at module-load time to guarantee it's visible to child processes.
// ─────────────────────────────────────────────────────────────────────────────

const _originalPath = process.env.PATH ?? "";
process.env.PATH = `${FAKE_CODEX_BIN_DIR}${path.delimiter}${_originalPath}`;

let cliModeServiceFn: typeof import("../services/internal-agent/cli-mode.js").cliModeService;

beforeAll(async () => {
  // Import cli-mode ONCE — no resetModules between tests. Using unique
  // companyId:userId per test isolates the session store instead.
  const mod = await import("../services/internal-agent/cli-mode.js");
  cliModeServiceFn = mod.cliModeService;
});

afterAll(() => {
  process.env.PATH = _originalPath;
  delete process.env.AOA_E2E_FAKE_CODEX_CONTROL;
  delete process.env.AOA_E2E_FAKE_CODEX_INVOCATIONS;
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-test control + invocation files
// ─────────────────────────────────────────────────────────────────────────────

function freshTempFiles() {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ctrl = path.join(os.tmpdir(), `aoa-vitest-codex-ctrl-${id}.json`);
  const inv = path.join(os.tmpdir(), `aoa-vitest-codex-inv-${id}.jsonl`);
  return { ctrl, inv };
}

function writeControl(
  ctrl: string,
  c: {
    sessionId?: string;
    reasoning?: string;
    text: string;
    usage?: { input?: number; cached?: number; output?: number };
    fail?: "model-400" | "generic";
  },
) {
  fs.writeFileSync(ctrl, JSON.stringify(c), "utf8");
}

function readInvocations(inv: string): Array<{
  argv: string[];
  stdin: string;
  codexHome: string | null;
  configTomlExists: boolean;
}> {
  try {
    return fs
      .readFileSync(inv, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Helper: drain cliModeService.chat chunks.
// Uses a unique companyId per call to isolate session-store state.
async function drainCodexChat(
  companyId: string,
  content: string,
  configOverride: Record<string, unknown> = {},
): Promise<{ chunks: any[]; service: any }> {
  const service = cliModeServiceFn({} as any);
  const chunks: any[] = [];
  for await (const chunk of service.chat(
    {
      companyId,
      userId: "usr-integ",
      userRole: "founder" as const,
      content,
      enabledCapabilities: [],
      conversationId: "conversation-integ",
    } as any,
    {
      cliTool: "codex",
      executionMode: "cli",
      model: "claude-sonnet-4-6", // claude default → should resolve to gpt-5.5
      ...configOverride,
    } as any,
  )) {
    chunks.push(chunk);
  }
  return { chunks, service };
}

// The managed CODEX_HOME path that cli-mode computes for a given companyId:userId.
// Mirrors codexHomeDirFor() in cli-mode.ts.
function codexHomeDirFor(companyId: string, userId = "usr-integ"): string {
  return path.join(
    os.tmpdir(),
    `aoa-codex-chat-${`${companyId}:${userId}`.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe("cli-mode-codex-integration — real fake-codex spawn (no child_process mock)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Success turn: chunks + invocation record ──────────────────────────

  it("success turn: yields reasoning → text → done with F1 provenance; invocation has correct argv + codexHome", async () => {
    const { ctrl, inv } = freshTempFiles();
    writeControl(ctrl, {
      sessionId: "integ-sess-001",
      reasoning: "Planning the launch sequence carefully",
      text: "Here is the 3-step plan: Step 1, Step 2, Step 3.",
      usage: { input: 120, output: 60, cached: 5 },
    });

    process.env.AOA_E2E_FAKE_CODEX_CONTROL = ctrl;
    process.env.AOA_E2E_FAKE_CODEX_INVOCATIONS = inv;

    const { chunks, service } = await drainCodexChat("cmp-success", "plan the launch");

    // ── Chunk assertions ────────────────────────────────────────────────────

    // reasoning chunk
    const reasoningChunks = chunks.filter((c) => c.type === "reasoning");
    expect(reasoningChunks).toHaveLength(1);
    expect(reasoningChunks[0].delta).toBe("Planning the launch sequence carefully");

    // text chunk (the parsed summary)
    const textChunks = chunks.filter((c) => c.type === "text");
    expect(textChunks).toHaveLength(1);
    expect(textChunks[0].delta).toContain("3-step plan");
    // Must NOT be raw JSONL leaking through
    expect(textChunks[0].delta).not.toContain("thread.started");
    expect(textChunks[0].delta).not.toContain('"type"');

    // exactly one done chunk
    const doneChunks = chunks.filter((c) => c.type === "done");
    expect(doneChunks).toHaveLength(1);

    const done = doneChunks[0].summary;
    // tokenUsage from turn.completed
    expect(done.tokenUsage.inputTokens).toBe(120);
    expect(done.tokenUsage.outputTokens).toBe(60);
    expect(done.tokenUsage.cachedInputTokens).toBe(5);

    // F1 provenance: model is a codex-compatible value (NOT a claude string)
    expect(done.model).toBeTruthy();
    expect(done.model).not.toContain("claude");
    expect(done.provider).toBe("openai");

    // no error
    expect(chunks.some((c) => c.type === "error")).toBe(false);

    // ── Invocation record assertions ────────────────────────────────────────

    const invocations = readInvocations(inv);
    expect(invocations).toHaveLength(1);
    const recorded = invocations[0];

    // argv[0..1] = exec --json
    expect(recorded.argv[0]).toBe("exec");
    expect(recorded.argv[1]).toBe("--json");

    // --model is present and is a codex-compatible model (NOT a claude string)
    const modelIdx = recorded.argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    const actualModel = recorded.argv[modelIdx + 1];
    expect(actualModel).toBeTruthy();
    expect(actualModel).not.toContain("claude"); // claude default must be translated

    // reasoning effort flag
    expect(recorded.argv).toContain("model_reasoning_effort=high");
    const effortIdx = recorded.argv.indexOf("model_reasoning_effort=high");
    expect(recorded.argv[effortIdx - 1]).toBe("-c");

    // reasoning summary flag
    expect(recorded.argv).toContain("model_reasoning_summary=detailed");
    const summaryIdx = recorded.argv.indexOf("model_reasoning_summary=detailed");
    expect(recorded.argv[summaryIdx - 1]).toBe("-c");

    // Trailing - (stdin sentinel)
    expect(recorded.argv[recorded.argv.length - 1]).toBe("-");

    // CODEX_HOME set by Commander (the managed per-session dir)
    const expectedHome = codexHomeDirFor("cmp-success");
    expect(recorded.codexHome).toBe(expectedHome);

    // config.toml was written before spawn
    expect(recorded.configTomlExists).toBe(true);

    // session ID stored on the session
    const stored = service.getSessionStore().get("cmp-success:usr-integ:conversation-integ");
    expect(stored).toBeDefined();
    expect(stored.codexSessionId).toBe("integ-sess-001");
  }, 30_000);

  // ── 2. Model: claude default → DEFAULT_CODEX_CHAT_MODEL ──────────────────

  it("claude default config.model is translated to codex-compatible model (not a claude string)", async () => {
    const { ctrl, inv } = freshTempFiles();
    writeControl(ctrl, {
      sessionId: "integ-model-sess",
      text: "The answer.",
      usage: { input: 10, output: 5 },
    });

    process.env.AOA_E2E_FAKE_CODEX_CONTROL = ctrl;
    process.env.AOA_E2E_FAKE_CODEX_INVOCATIONS = inv;

    await drainCodexChat("cmp-model", "hi", { model: "claude-opus-4-6" });

    const invocations = readInvocations(inv);
    expect(invocations).toHaveLength(1);

    const modelIdx = invocations[0].argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    const usedModel = invocations[0].argv[modelIdx + 1];
    expect(usedModel).not.toContain("claude");
    expect(usedModel).not.toContain("opus");
    expect(usedModel.length).toBeGreaterThan(0);
  }, 20_000);

  // ── 3. RESUME: second turn has `resume <sessionId>` in argv ──────────────

  it("resume case: second turn argv contains `resume <sessionId>` from first turn", async () => {
    const { ctrl, inv } = freshTempFiles();

    // Turn 1
    writeControl(ctrl, {
      sessionId: "integ-resume-sess-abc",
      text: "First answer.",
      usage: { input: 20, output: 10 },
    });

    process.env.AOA_E2E_FAKE_CODEX_CONTROL = ctrl;
    process.env.AOA_E2E_FAKE_CODEX_INVOCATIONS = inv;

    // Use a dedicated service so session state is isolated
    const service = cliModeServiceFn({} as any);
    const chatParams: any = {
      companyId: "cmp-resume",
      userId: "usr-integ",
      userRole: "founder",
      enabledCapabilities: [],
      conversationId: "conversation-resume",
    };
    const chatConfig: any = { cliTool: "codex", executionMode: "cli", model: "claude-sonnet-4-6" };

    // Turn 1
    const t1: any[] = [];
    for await (const c of service.chat({ ...chatParams, content: "first question" }, chatConfig)) {
      t1.push(c);
    }
    expect(t1.some((c) => c.type === "done")).toBe(true);
    expect(service.getSessionStore().get("cmp-resume:usr-integ:conversation-resume")?.codexSessionId).toBe("integ-resume-sess-abc");

    // Turn 2: update control file
    writeControl(ctrl, {
      sessionId: "integ-resume-sess-abc",
      text: "Second answer.",
      usage: { input: 15, output: 8 },
    });

    const t2: any[] = [];
    for await (const c of service.chat({ ...chatParams, content: "second question" }, chatConfig)) {
      t2.push(c);
    }
    expect(t2.some((c) => c.type === "done")).toBe(true);

    // Turn 2 invocation must contain `resume <sessionId>`
    const invocations = readInvocations(inv);
    expect(invocations).toHaveLength(2);

    const turn2Argv = invocations[1].argv;
    const resumeIdx = turn2Argv.indexOf("resume");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(turn2Argv[resumeIdx + 1]).toBe("integ-resume-sess-abc");

    // Trailing - still present after resume <id>
    expect(turn2Argv[turn2Argv.length - 1]).toBe("-");
  }, 40_000);

  // ── 4. FAIL: turn.failed errorMessage surfaces correctly ──────────────────

  it("fail case: turn.failed errorMessage surfaces in {type:error} chunk, not generic exit-code text", async () => {
    const { ctrl, inv } = freshTempFiles();
    writeControl(ctrl, { text: "", fail: "model-400" });

    process.env.AOA_E2E_FAKE_CODEX_CONTROL = ctrl;
    process.env.AOA_E2E_FAKE_CODEX_INVOCATIONS = inv;

    const { chunks } = await drainCodexChat("cmp-fail", "trigger failure");

    const errChunk = chunks.find((c) => c.type === "error");
    expect(errChunk).toBeDefined();
    // The parsed turn.failed message must win over generic "exited with code N"
    expect(errChunk!.message).toContain("gpt-5.3-codex");
    expect(errChunk!.message).not.toContain("exited with code");
    // Spawn happened (invocation recorded)
    const invs = readInvocations(inv);
    expect(invs).toHaveLength(1);
  }, 20_000);

  // ── 5. CLI-unavailable (plan-review #4) ──────────────────────────────────

  it("CLI-unavailable: when codex is not on PATH, chat yields {type:error} with install message", async () => {
    // Save and override PATH — remove fake-codex dir and npm bins so where/which fails.
    const savedPath = process.env.PATH;
    process.env.PATH = savedPath!
      .split(path.delimiter)
      .filter((p) =>
        p !== FAKE_CODEX_BIN_DIR &&
        !p.toLowerCase().includes("npm") &&
        !p.toLowerCase().includes("codex"),
      )
      .join(path.delimiter);

    try {
      const service = cliModeServiceFn({} as any);
      const chunks: any[] = [];
      for await (const chunk of service.chat(
        {
          companyId: "cmp-unavail",
          userId: "usr-unavail",
          userRole: "founder",
          content: "hi",
          enabledCapabilities: [],
          // conversationId is required (W7.5d checks it before the host CLI probe).
          conversationId: "conversation-unavail",
        } as any,
        { cliTool: "codex", executionMode: "cli" } as any,
      )) {
        chunks.push(chunk);
      }

      const errChunk = chunks.find((c) => c.type === "error");
      expect(errChunk).toBeDefined();
      const msg = errChunk!.message as string;
      expect(msg.toLowerCase()).toMatch(/install|not found|path/i);
    } finally {
      process.env.PATH = savedPath;
    }
  }, 10_000);

  // ── 6. Full argv contract for first turn ─────────────────────────────────

  it("first-turn argv matches the codex exec contract: exec --json --model -c effort -c summary -", async () => {
    const { ctrl, inv } = freshTempFiles();
    writeControl(ctrl, {
      sessionId: "integ-argv-sess",
      text: "Result.",
      usage: { input: 5, output: 3 },
    });

    process.env.AOA_E2E_FAKE_CODEX_CONTROL = ctrl;
    process.env.AOA_E2E_FAKE_CODEX_INVOCATIONS = inv;

    await drainCodexChat("cmp-argv", "argv test", { model: "claude-sonnet-4-6" });

    const invocations = readInvocations(inv);
    expect(invocations).toHaveLength(1);
    const argv = invocations[0].argv;

    expect(argv[0]).toBe("exec");
    expect(argv[1]).toBe("--json");
    expect(argv).toContain("--model");
    expect(argv).toContain("model_reasoning_effort=high");
    expect(argv).toContain("model_reasoning_summary=detailed");
    // Trailing - is the LAST element
    expect(argv[argv.length - 1]).toBe("-");
    // No resume in a first turn
    expect(argv).not.toContain("resume");
    // Model must not be a claude string
    const modelIdx = argv.indexOf("--model");
    expect(argv[modelIdx + 1]).not.toContain("claude");
    // summary flag is BEFORE the trailing -
    const summaryIdx = argv.indexOf("model_reasoning_summary=detailed");
    const trailingIdx = argv.lastIndexOf("-");
    expect(summaryIdx).toBeLessThan(trailingIdx);
  }, 20_000);
});
