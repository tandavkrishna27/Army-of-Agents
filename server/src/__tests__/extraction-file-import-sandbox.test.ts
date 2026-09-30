import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { setDeploymentMode } from "../config/deployment-mode.js";

/**
 * U13.5 — file-import (`extractFromRawText`, extraction.ts) must stage the
 * uploaded file's content into the sandbox VM as a named file (not
 * concatenate it into `stdinContent` the way discussion/debrief/memory-
 * candidate extraction still do) and point the CLI invocation at it.
 *
 * Strategy mirrors extraction-cli-sandbox-env.test.ts (U13.2): drive the REAL
 * `extraction.ts` + `extraction-cli.ts` modules through `extractFromRawText`,
 * with only `one-shot-provider-credential.js` (credential resolution) and
 * `one-shot-sandbox-cli.js` (the U13.1 sandbox seam) mocked — this file
 * asserts ROUTING (stagedFile shape + args shape), not the sandbox provider's
 * own file-write mechanics (covered by sandbox-provider-runtime.test.ts) or
 * the stagedFile->execute() wiring (covered by one-shot-sandbox-cli.test.ts).
 */

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  gt: vi.fn((a: unknown, b: unknown) => ({ gt: [a, b] })),
  gte: vi.fn((a: unknown, b: unknown) => ({ gte: [a, b] })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  asc: vi.fn((a: unknown) => ({ asc: a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  sql: Object.assign(
    vi.fn((strings: any, ...values: any[]) => ({ sql: strings, values })),
    { raw: vi.fn((input: any) => input) },
  ),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (typeof prop === "string") return Symbol(`${name}.${prop}`);
        return undefined;
      },
    });
  return {
    discussions: makeTable("discussions"),
    discussionEntries: makeTable("discussion_entries"),
    discussionExtractedItems: makeTable("discussion_extracted_items"),
    internalAgentConfig: makeTable("internal_agent_config"),
    threadScopeVersions: makeTable("thread_scope_versions"),
    projects: makeTable("projects"),
    debriefs: makeTable("debriefs"),
    briefs: makeTable("briefs"),
    briefItems: makeTable("brief_items"),
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

// resolveCompanyCliTool is parametrized per-test via mockResolveCompanyCliTool
// so the same file can prove both claude's and codex's invocation shapes.
const mockResolveCompanyCliTool = vi.fn(async () => "claude");
vi.mock("../services/extraction-engine.js", () => ({
  resolveExtractionEngine: vi.fn(async () => "cli"),
  resolveCompanyCliTool: (...a: unknown[]) => mockResolveCompanyCliTool(...(a as [never, never])),
}));

// U13.0 — company provider credential resolution. Mocked so these tests never
// touch a real DB / provider-resolution chain.
const mockResolveCompanyProviderCredential = vi.fn();
vi.mock("../services/one-shot-provider-credential.js", () => ({
  resolveCompanyProviderCredential: (...a: unknown[]) => mockResolveCompanyProviderCredential(...a),
}));

// U13.1 — the shared sandbox seam. Mocked so these tests assert ROUTING
// (extraction-cli.ts calls this, with what stagedFile/args) without
// exercising the real acquire/execute/release machinery.
const mockRunOneShotCliInSandbox = vi.fn();
vi.mock("../services/one-shot-sandbox-cli.js", () => {
  class FakeOneShotSandboxError extends Error {
    readonly kind: string;
    readonly exitCode: number | null;
    readonly stderr: string;
    constructor(message: string, kind: string, exitCode: number | null = null, stderr = "") {
      super(message);
      this.name = "OneShotSandboxError";
      this.kind = kind;
      this.exitCode = exitCode;
      this.stderr = stderr;
    }
  }
  return {
    runOneShotCliInSandbox: (...a: unknown[]) => mockRunOneShotCliInSandbox(...a),
    OneShotSandboxError: FakeOneShotSandboxError,
  };
});

// ── node:child_process spawn mock (desktop path only) ───────────────────────
interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown> | undefined;
}
let nextSpawnStdout = "[]";
const spawnCalls: SpawnCall[] = [];
const spawnStdinWrites: string[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], options?: Record<string, unknown>) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: EventEmitter & { writable: boolean; write: (s: string) => void; end: () => void };
        kill: (sig?: string) => void;
        exitCode: number | null;
        signalCode: string | null;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn();
      const stdin = new EventEmitter() as EventEmitter & {
        writable: boolean;
        write: (s: string) => void;
        end: () => void;
      };
      stdin.writable = true;
      stdin.write = (s: string) => {
        spawnStdinWrites.push(s);
      };
      stdin.end = () => {};
      child.stdin = stdin;
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(nextSpawnStdout));
        child.exitCode = 0;
        child.emit("close", 0);
      });
      return child;
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(async () => {}), rm: vi.fn(async () => {}) };
});

import { extractionService } from "../services/extraction.js";

const FAKE_CREDENTIAL = {
  envName: "ANTHROPIC_API_KEY",
  value: "sk-co-secret",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

const COMPANY_ID = "co-file-import-1";
const RAW_TEXT = "This is the uploaded file's raw text content, long enough to extract from.";

/** extractFromRawText issues exactly two real db.select calls in order:
 *  1) buildDepartmentsList (projects table) 2) internalAgentConfig row. */
function makeDb(rows: unknown[][] = [[], [{ model: null }]]) {
  const queue = [...rows];
  return {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: unknown[]) => unknown) => Promise.resolve(fn(queue.shift() ?? []))),
    })),
  } as unknown as Parameters<typeof extractionService>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  nextSpawnStdout = "[]";
  spawnCalls.length = 0;
  spawnStdinWrites.length = 0;
  mockResolveCompanyCliTool.mockResolvedValue("claude");
  mockResolveCompanyProviderCredential.mockResolvedValue(FAKE_CREDENTIAL);
  mockRunOneShotCliInSandbox.mockResolvedValue({
    stdout: JSON.stringify([{ type: "task", title: "Extracted from file" }]),
    stderr: "",
    exitCode: 0,
    durationMs: 5,
  });
});

afterEach(() => {
  setDeploymentMode("local_trusted");
});

describe("extractFromRawText — file-import sandbox staging (U13.5)", () => {
  it("cloud (claude): calls runOneShotCliInSandbox with a stagedFile (remote path under /tmp, content = the file text) and stdinContent undefined", async () => {
    setDeploymentMode("cloud_auth");

    const items = await extractionService(makeDb()).extractFromRawText(COMPANY_ID, RAW_TEXT);

    expect(mockRunOneShotCliInSandbox).toHaveBeenCalledTimes(1);
    const [sandboxInput] = mockRunOneShotCliInSandbox.mock.calls[0];

    expect(sandboxInput.stagedFile).toBeDefined();
    expect(sandboxInput.stagedFile.remotePath).toMatch(/^\/tmp\//);
    expect(sandboxInput.stagedFile.content).toBe(RAW_TEXT);
    expect(sandboxInput.stdinContent).toBeUndefined();

    // Desktop KEEP-list spawn never touched.
    expect(spawnCalls).toHaveLength(0);

    expect(items[0].title).toBe("Extracted from file");
  });

  it("cloud (claude): args reference the staged content via the real --system-prompt flag (verified via `claude --help`) — NOT via a fabricated file-path flag; the system prompt is NOT the uploaded file content", async () => {
    setDeploymentMode("cloud_auth");

    await extractionService(makeDb()).extractFromRawText(COMPANY_ID, RAW_TEXT);

    const [sandboxInput] = mockRunOneShotCliInSandbox.mock.calls[0];
    const args: string[] = sandboxInput.args;

    expect(args).toContain("--print");
    expect(args).toContain("--strict-mcp-config");
    const sysIdx = args.indexOf("--system-prompt");
    expect(sysIdx).toBeGreaterThan(-1);
    const systemPromptArg = args[sysIdx + 1];
    expect(typeof systemPromptArg).toBe("string");
    expect(systemPromptArg.length).toBeGreaterThan(0);
    // The system prompt and the uploaded content are DISTINCT channels now —
    // the uploaded text must not appear inside the system-prompt arg.
    expect(systemPromptArg).not.toContain(RAW_TEXT);
    // No stale "--output-format text" dropped.
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("text");
  });

  it("cloud (codex): PROMPT arg carries the system prompt (not '-'), matching codex's own documented shape where piped stdin is appended as a <stdin> block", async () => {
    setDeploymentMode("cloud_auth");
    mockResolveCompanyCliTool.mockResolvedValue("codex");
    mockResolveCompanyProviderCredential.mockResolvedValue({
      envName: "OPENAI_API_KEY",
      value: "sk-co-secret",
      provider: "openai",
      model: "gpt-5-codex",
    });

    await extractionService(makeDb()).extractFromRawText(COMPANY_ID, RAW_TEXT);

    const [sandboxInput] = mockRunOneShotCliInSandbox.mock.calls[0];
    const args: string[] = sandboxInput.args;
    expect(args[0]).toBe("exec");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5-codex");

    const promptArg = args[args.length - 1];
    expect(promptArg).not.toBe("-"); // no longer the stdin-only sentinel
    expect(promptArg.length).toBeGreaterThan(0);
    expect(promptArg).not.toContain(RAW_TEXT);

    expect(sandboxInput.stagedFile.content).toBe(RAW_TEXT);
    expect(sandboxInput.stdinContent).toBeUndefined();
  });

  it("desktop (tenantIsolationEnforced=false): unaffected — spawns locally with the content over stdin, sandbox helper never called", async () => {
    setDeploymentMode("local_trusted");
    nextSpawnStdout = JSON.stringify([{ type: "task", title: "Extracted locally" }]);

    const items = await extractionService(makeDb()).extractFromRawText(COMPANY_ID, RAW_TEXT);

    expect(mockRunOneShotCliInSandbox).not.toHaveBeenCalled();
    expect(mockResolveCompanyProviderCredential).not.toHaveBeenCalled();

    const call = spawnCalls.find((c) => c.command === "claude");
    expect(call).toBeDefined();
    // Desktop still delivers content over stdin (unchanged W1 behavior) — no
    // stagedFile concept exists on this branch.
    expect(spawnStdinWrites.join("")).toContain(RAW_TEXT);

    expect(items[0].title).toBe("Extracted locally");
  });
});
