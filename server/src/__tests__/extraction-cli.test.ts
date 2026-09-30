import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { setDeploymentMode } from "../config/deployment-mode.js";

// ── child_process.spawn mock ────────────────────────────────────────────────
//
// Each test configures `nextSpawn` to script the fake process' behavior. The
// mock returns an EventEmitter with stdin/stdout/stderr so extraction-cli's
// stdin-write + stdout-collect + close/error wiring can be exercised without
// touching the real `claude` / `codex` binaries.

interface SpawnScript {
  /** stdout chunks emitted before close. */
  stdout?: string[];
  /** stderr chunks emitted before close. */
  stderr?: string[];
  /** close exit code (mutually exclusive with `error`). */
  exitCode?: number;
  /** spawn error (e.g. { code: "ENOENT" }) — emits "error" instead of close. */
  error?: NodeJS.ErrnoException;
  /** stdin stream error (e.g. EPIPE) — emitted on child.stdin before close. */
  stdinError?: NodeJS.ErrnoException;
}

interface SpawnCall {
  command: string;
  args: string[];
  stdinWrites: string[];
  stdinEnded: boolean;
  /** spawn() options (env, cwd, …) — captured for env-scrub assertions. */
  options: Record<string, unknown> | undefined;
  /** number of times the fake child's kill() was invoked. */
  killCount: number;
}

let nextSpawn: SpawnScript = { stdout: [], exitCode: 0 };
const spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(
      (command: string, args: string[], options?: Record<string, unknown>) => {
      const call: SpawnCall = {
        command,
        args,
        stdinWrites: [],
        stdinEnded: false,
        options,
        killCount: 0,
      };
      spawnCalls.push(call);

      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: EventEmitter & {
          writable: boolean;
          write: (s: string) => void;
          end: () => void;
        };
        kill: (sig?: string) => void;
        exitCode: number | null;
        signalCode: string | null;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => {
        call.killCount += 1;
      });
      // stdin is an EventEmitter so production code can attach an `error`
      // listener (EPIPE handling); .write/.end are stubbed to record activity.
      const stdin = new EventEmitter() as EventEmitter & {
        writable: boolean;
        write: (s: string) => void;
        end: () => void;
      };
      stdin.writable = true;
      stdin.write = (s: string) => {
        call.stdinWrites.push(s);
      };
      stdin.end = () => {
        call.stdinEnded = true;
      };
      child.stdin = stdin;

      // Drive the scripted behavior on the next microtask so the caller has
      // attached its listeners + written stdin first.
      queueMicrotask(() => {
        const script = nextSpawn;
        if (script.error) {
          child.emit("error", script.error);
          return;
        }
        // Simulate the CLI exiting before reading stdin: the stdin write raises
        // EPIPE. Production must have an `error` listener or this would be an
        // unhandled stream error that crashes the process.
        if (script.stdinError) {
          child.stdin.emit("error", script.stdinError);
        }
        for (const chunk of script.stdout ?? []) {
          child.stdout.emit("data", Buffer.from(chunk));
        }
        for (const chunk of script.stderr ?? []) {
          child.stderr.emit("data", Buffer.from(chunk));
        }
        child.exitCode = script.exitCode ?? 0;
        child.emit("close", script.exitCode ?? 0);
        // codex-exec listens on "exit"; claude listens on "close". Emit both so
        // either transport resolves regardless of which event it awaits.
        child.emit("exit", script.exitCode ?? 0);
      });

      return child;
    }),
  };
});

// fs/promises.writeFile is used by the claude path to drop the system prompt to
// a temp file — stub it so the test never touches disk.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
  };
});

beforeEach(() => {
  spawnCalls.length = 0;
  nextSpawn = { stdout: [], exitCode: 0 };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── classifyCliError ─────────────────────────────────────────────────────────

describe("classifyCliError", () => {
  it("ENOENT spawn error → not_installed", async () => {
    const { classifyCliError } = await import("../services/extraction-cli.ts");
    expect(classifyCliError({ code: "ENOENT" }, "", null)).toBe("not_installed");
  });

  it("timedOut → timeout", async () => {
    const { classifyCliError } = await import("../services/extraction-cli.ts");
    expect(classifyCliError({ timedOut: true }, "", null)).toBe("timeout");
  });

  it("auth stderr → not_authed", async () => {
    const { classifyCliError } = await import("../services/extraction-cli.ts");
    expect(classifyCliError(null, "Error: not logged in", 1)).toBe("not_authed");
    expect(classifyCliError(null, "401 unauthorized", 1)).toBe("not_authed");
    expect(classifyCliError(null, "Missing bearer or basic authentication", 1)).toBe(
      "not_authed",
    );
  });

  it("nonzero exit (no auth signal) → nonzero_exit", async () => {
    const { classifyCliError } = await import("../services/extraction-cli.ts");
    expect(classifyCliError(null, "some crash", 2)).toBe("nonzero_exit");
  });

  it("exit 0 with no spawn error → unparseable fall-through", async () => {
    const { classifyCliError } = await import("../services/extraction-cli.ts");
    expect(classifyCliError(null, "", 0)).toBe("unparseable");
  });

  it("ENOENT takes precedence over a nonzero exit", async () => {
    const { classifyCliError } = await import("../services/extraction-cli.ts");
    expect(classifyCliError({ code: "ENOENT" }, "", 1)).toBe("not_installed");
  });
});

// ── extractViaCli (claude) ───────────────────────────────────────────────────

describe("extractViaCli — claude happy path", () => {
  it("parses a JSON array of items from claude stdout", async () => {
    const items = [
      {
        type: "task",
        title: "Ship the extractor",
        description: "Implement the one-shot CLI extractor.",
        priority: "high",
      },
    ];
    nextSpawn = { stdout: [JSON.stringify(items)], exitCode: 0 };

    const { extractViaCli } = await import("../services/extraction-cli.ts");
    const result = await extractViaCli("claude", "SYSTEM", "do the thing");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "task",
      title: "Ship the extractor",
      priority: "high",
    });

    // Sanity: spawned `claude`, content delivered over stdin + closed (one-shot).
    const call = spawnCalls.find((c) => c.command === "claude");
    expect(call).toBeDefined();
    expect(call!.args).toContain("--print");
    expect(call!.args).toContain("--system-prompt-file");
    // SECURITY (P1): built-in tools MUST be disabled — `--tools` followed by the
    // empty value ("" on POSIX). Otherwise a prompt-injected entry could run
    // Read/Bash against the server user's home/temp/env.
    const toolsIdx = call!.args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    // Disable-all sentinel: "" on POSIX, '""' (empty-quoted token) on Windows.
    expect(["", '""']).toContain(call!.args[toolsIdx + 1]);
    // SECURITY (audit): --tools "" disables only BUILT-IN tools; --strict-mcp-config
    // (with no --mcp-config) ignores all filesystem MCP config so no MCP servers
    // load for the untrusted-prompt extractor.
    expect(call!.args).toContain("--strict-mcp-config");
    expect(call!.stdinWrites.join("")).toContain("do the thing");
    expect(call!.stdinEnded).toBe(true);
  });

  it("scrubs the server's secrets from the claude child env (keeps claude's own auth)", async () => {
    const prev = { ...process.env };
    process.env.OPENAI_API_KEY = "sk-embeddings";
    process.env.GITHUB_PAT = "ghp_secret";
    process.env.AOA_AGENT_JWT_SECRET = "jwt";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-tok";
    try {
      nextSpawn = { stdout: ["[]"], exitCode: 0 };
      const { extractViaCli } = await import("../services/extraction-cli.ts");
      await extractViaCli("claude", "SYSTEM", "content");

      const call = spawnCalls.find((c) => c.command === "claude");
      const env = call!.options?.env as NodeJS.ProcessEnv;
      expect(env).toBeDefined();
      // The embeddings OpenAI key / GitHub PAT / AOA internals must NOT leak.
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GITHUB_PAT).toBeUndefined();
      expect(env.AOA_AGENT_JWT_SECRET).toBeUndefined();
      // claude's OWN auth env survives the scrub (else keyless auth breaks).
      expect(env.ANTHROPIC_API_KEY).toBe("sk-anthropic");
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
    } finally {
      for (const k of [
        "OPENAI_API_KEY",
        "GITHUB_PAT",
        "AOA_AGENT_JWT_SECRET",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ]) {
        if (!(k in prev)) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });

  it("kills the child and fails when claude output exceeds the byte cap", async () => {
    // One ~9 MiB chunk trips MAX_CLI_STDOUT_BYTES (8 MiB); the child is killed and
    // the (capped/garbage) output fails to parse rather than OOMing the server.
    const huge = "x".repeat(9 * 1024 * 1024);
    nextSpawn = { stdout: [huge], exitCode: 0 };
    const { extractViaCli } = await import("../services/extraction-cli.ts");
    // Killing on overflow makes close report a null exit; the run must still FAIL
    // (not be coalesced to success) (P2 re-review).
    await expect(extractViaCli("claude", "SYSTEM", "content")).rejects.toMatchObject({
      kind: "nonzero_exit",
    });

    const call = spawnCalls.find((c) => c.command === "claude");
    expect(call!.killCount).toBeGreaterThanOrEqual(1);
  });

  it("accepts both 'claude' and 'claude_cli' tool aliases", async () => {
    nextSpawn = { stdout: ["[]"], exitCode: 0 };
    const { extractViaCli } = await import("../services/extraction-cli.ts");
    const result = await extractViaCli("claude_cli", "SYSTEM", "content");
    expect(result).toEqual([]);
  });
});

describe("extractViaCli — claude error paths", () => {
  it("unparseable stdout → CliExtractionError kind 'unparseable'", async () => {
    nextSpawn = { stdout: ["not json"], exitCode: 0 };
    const { extractViaCli, CliExtractionError } = await import(
      "../services/extraction-cli.ts"
    );
    await expect(extractViaCli("claude", "SYSTEM", "content")).rejects.toMatchObject({
      kind: "unparseable",
    });
    await expect(extractViaCli("claude", "SYSTEM", "content")).rejects.toBeInstanceOf(
      CliExtractionError,
    );
  });

  it("ENOENT spawn → CliExtractionError kind 'not_installed'", async () => {
    nextSpawn = { error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) };
    const { extractViaCli } = await import("../services/extraction-cli.ts");
    await expect(extractViaCli("claude", "SYSTEM", "content")).rejects.toMatchObject({
      kind: "not_installed",
    });
  });

  it("nonzero exit → CliExtractionError kind 'nonzero_exit'", async () => {
    nextSpawn = { stdout: [""], stderr: ["boom"], exitCode: 2 };
    const { extractViaCli } = await import("../services/extraction-cli.ts");
    await expect(extractViaCli("claude", "SYSTEM", "content")).rejects.toMatchObject({
      kind: "nonzero_exit",
    });
  });

  it("auth stderr on nonzero exit → CliExtractionError kind 'not_authed'", async () => {
    nextSpawn = { stdout: [""], stderr: ["Error: not logged in"], exitCode: 1 };
    const { extractViaCli } = await import("../services/extraction-cli.ts");
    await expect(extractViaCli("claude", "SYSTEM", "content")).rejects.toMatchObject({
      kind: "not_authed",
    });
  });

  it("stdin EPIPE on early exit → classified failure, not an unhandled crash (P1)", async () => {
    // claude exits before reading stdin (auth fail) → stdin write raises EPIPE.
    // Without the stdin `error` handler this would be an unhandled stream error;
    // with it, the run resolves to a classified CLI failure via the close path.
    nextSpawn = {
      stdinError: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
      stdout: [""],
      stderr: ["Error: not logged in"],
      exitCode: 1,
    };
    const { extractViaCli } = await import("../services/extraction-cli.ts");
    await expect(extractViaCli("claude", "SYSTEM", "content")).rejects.toMatchObject({
      kind: "not_authed",
    });
  });
});

// ── extractViaCli (codex) ────────────────────────────────────────────────────
//
// The codex path delegates to runCodexExecJson, which uses the REAL
// parseCodexJsonl (pure function) but provisions auth + reads the shared model
// via codex helpers. Stub the disk/auth helpers so no real ~/.codex is touched;
// keep parseCodexJsonl real so the JSONL→summary→parse chain is exercised.

vi.mock("@armyofagents/adapter-codex-local/server", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@armyofagents/adapter-codex-local/server")
  >();
  return {
    ...actual,
    ensureCodexAuthInHome: vi.fn(async () => true),
    readSharedCodexModel: vi.fn(async () => null),
  };
});

/** Build a minimal codex JSONL stream whose agent_message text = `text`. */
function codexJsonl(text: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "t-123" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  ].join("\n");
}

describe("extractViaCli — codex", () => {
  it("parses items from the codex assistant summary", async () => {
    const prev = { ...process.env };
    process.env.OPENAI_API_KEY = "sk-embeddings";
    process.env.AOA_AGENT_JWT_SECRET = "jwt";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    try {
      const items = [
        { type: "decision", title: "Use stdin delivery", description: "Windows-safe." },
      ];
      nextSpawn = { stdout: [codexJsonl(JSON.stringify(items))], exitCode: 0 };

      const { extractViaCli } = await import("../services/extraction-cli.ts");
      const result = await extractViaCli("codex", "SYSTEM", "content");

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ type: "decision", title: "Use stdin delivery" });

      // codex spawned with `exec --json ... -` and prompt over stdin (closed).
      const call = spawnCalls.find((c) => c.command === "codex");
      expect(call).toBeDefined();
      expect(call!.args).toContain("exec");
      expect(call!.args).toContain("--json");
      expect(call!.args[call!.args.length - 1]).toBe("-");
      expect(call!.stdinEnded).toBe(true);
      // SECURITY (Codex re-review P1): scrubbed env — CODEX_HOME set (codex
      // authenticates via the copied auth.json), but the server's OWN secrets are
      // withheld, INCLUDING the embeddings OPENAI_API_KEY (must not reach an
      // untrusted-prompt subprocess), plus ANTHROPIC + AOA internals.
      const env = call!.options?.env as NodeJS.ProcessEnv;
      expect(env).toBeDefined();
      expect(typeof env.CODEX_HOME).toBe("string");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.AOA_AGENT_JWT_SECRET).toBeUndefined();
    } finally {
      for (const k of ["OPENAI_API_KEY", "AOA_AGENT_JWT_SECRET", "ANTHROPIC_API_KEY"]) {
        if (!(k in prev)) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });

  it("unparseable codex summary → CliExtractionError kind 'unparseable'", async () => {
    nextSpawn = { stdout: [codexJsonl("not json")], exitCode: 0 };
    const { extractViaCli } = await import("../services/extraction-cli.ts");
    await expect(extractViaCli("codex", "SYSTEM", "content")).rejects.toMatchObject({
      kind: "unparseable",
    });
  });

  it("codex nonzero exit → CliExtractionError kind 'nonzero_exit'", async () => {
    nextSpawn = { stdout: [""], stderr: ["crashed"], exitCode: 3 };
    const { extractViaCli } = await import("../services/extraction-cli.ts");
    await expect(extractViaCli("codex", "SYSTEM", "content")).rejects.toMatchObject({
      kind: "nonzero_exit",
    });
  });

  it("codex stdin EPIPE on early exit → classified failure, not a crash (P1)", async () => {
    // codex exits before reading stdin (auth/config error) → stdin write raises
    // EPIPE. The stdin `error` handler must swallow it so the run is classified
    // via the close path instead of crashing the process.
    nextSpawn = {
      stdinError: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
      stdout: [""],
      stderr: ["stream error: unauthorized"],
      exitCode: 1,
    };
    const { extractViaCli } = await import("../services/extraction-cli.ts");
    await expect(extractViaCli("codex", "SYSTEM", "content")).rejects.toMatchObject({
      kind: "not_authed",
    });
  });

  it("capped codex output fails even with a valid JSON prefix (P2 re-review)", async () => {
    // Valid JSONL answer followed by spam that trips MAX_CLI_STDOUT_BYTES (8 MiB).
    // The child is killed (close → null exit), so the run must FAIL rather than
    // parse the buffered prefix and mark the entry completed.
    const validPrefix = codexJsonl(JSON.stringify([{ type: "task", title: "T" }]));
    const spam = "x".repeat(9 * 1024 * 1024);
    nextSpawn = { stdout: [validPrefix, spam], exitCode: 0 };

    const { extractViaCli } = await import("../services/extraction-cli.ts");
    await expect(extractViaCli("codex", "SYSTEM", "content")).rejects.toMatchObject({
      kind: "nonzero_exit",
    });

    const call = spawnCalls.find((c) => c.command === "codex");
    expect(call!.killCount).toBeGreaterThanOrEqual(1);
  });
});

// ── extractViaCli — cloud_auth routes through the sandbox (U13.2) ───────────
//
// On multi-tenant AoA Cloud (cloud_auth), extraction now routes through an
// EPHEMERAL sandbox authenticated with the COMPANY's own resolved provider
// key (U13.0-2) instead of the ambient host CLI login (the operator-cred
// sink these tests used to prove was refused outright pre-U13). A direct
// `extractViaCli` call with no `credential`/`companyId`/`db` — as every real
// production caller now supplies (extraction.ts threads them) — cannot route
// through the sandbox and fails closed BEFORE any subprocess spawn. The
// "kind" mapping is TEMPORARY (extraction-cli.ts's extractViaCliSandbox
// comment): U13.3 adds a dedicated `sandbox_unavailable` CliErrorKind; for
// now this bucket is `nonzero_exit`, deliberately not `not_authed` (which
// would trip DiscussionDetail's stale pre-U13 "unavailable on AoA Cloud"
// override copy). Full sandbox-routing coverage (spy on
// runOneShotCliInSandbox, env exclusions, batch-handle reuse) lives in
// extraction-cli-sandbox-env.test.ts.

describe("extractViaCli — cloud_auth routes through the sandbox (U13.2)", () => {
  afterEach(() => setDeploymentMode("local_trusted"));

  it("without a resolved credential/companyId/db, fails closed before spawning a CLI", async () => {
    setDeploymentMode("cloud_auth");
    const { extractViaCli } = await import("../services/extraction-cli.ts");
    await expect(extractViaCli("claude", "sys", "content")).rejects.toMatchObject({
      name: "CliExtractionError",
      kind: "nonzero_exit",
    });
    // No LOCAL subprocess may be spawned on the sandbox-routing path — the
    // sandbox execution goes through the provider-runtime seam, never
    // node:child_process.
    expect(spawnCalls).toHaveLength(0);
  });

  it("refuses codex extraction on cloud_auth the same way (no credential/companyId/db)", async () => {
    setDeploymentMode("cloud_auth");
    const { extractViaCli } = await import("../services/extraction-cli.ts");
    await expect(extractViaCli("codex", "sys", "content")).rejects.toMatchObject({
      name: "CliExtractionError",
      kind: "nonzero_exit",
    });
    expect(spawnCalls).toHaveLength(0);
  });

  it("does NOT refuse off-cloud — the guard is a no-op on self-hosted (HERMETIC, no spawn)", async () => {
    setDeploymentMode("local_trusted");
    const { extractViaCli } = await import("../services/extraction-cli.ts");
    // Unsupported tool → the synchronous "Unsupported CLI tool" throw
    // (extraction-cli.ts ~:165), NOT the cloud refusal, and NO subprocess spawn.
    let caught: unknown;
    try {
      await extractViaCli("bogus-tool", "sys", "content");
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.name).toBe("CliExtractionError");
    expect(String((caught as Error)?.message)).not.toContain("AoA Cloud");
    expect(spawnCalls).toHaveLength(0);
  });
});
