/**
 * One-shot `codex exec` text helper (keyless extraction transport).
 *
 * This is the codex sibling of the claude one-shot used by
 * `server/src/services/extraction-cli.ts`. It is deliberately HEADLESS:
 *   - NO MCP bridge (no CODEX_HOME/config.toml [mcp_servers] write),
 *   - NO agent loop, NO session/resume continuity,
 *   - NO stream generator — it buffers one turn and returns the final
 *     assistant TEXT.
 *
 * It REUSES the same hardened codex machinery the Commander chat path uses
 * (`runCodexTurn` in cli-mode.ts) so the keyless extractor inherits the exact
 * model-resolution + auth + JSONL-parse semantics rather than hand-rolling a
 * bare `codex exec`:
 *   - `readSharedCodexModel` + `resolveCodexChatModel` — pin a
 *     subscription-supported model (the per-session CODEX_HOME has no `model`
 *     line, so codex would otherwise 400 on a ChatGPT account).
 *   - `ensureCodexAuthInHome` — copy the shared ~/.codex/auth.json into the
 *     managed home so `codex exec` is authenticated (no 401).
 *   - `parseCodexJsonl` — extract the final assistant text (the `summary`),
 *     NOT raw JSONL (the historical "rendered nothing" bug).
 *
 * Prompt delivery is stdin + close (one-shot), matching the chat path and the
 * W1 spike: on Windows argv positionals are silently dropped, stdin works.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCodexChatModel,
  COMMANDER_CODEX_REASONING_EFFORT,
} from "./codex-model.js";
import {
  appendCapped,
  buildScrubbedCliEnv,
  MAX_CLI_STDERR_BYTES,
  MAX_CLI_STDOUT_BYTES,
  newCappedBuffer,
} from "../cli-spawn-safety.js";

export interface RunCodexExecJsonOptions {
  timeoutMs?: number;
  /** internal_agent_config.model — validated downstream; pins the codex model. */
  codexModel?: string | null;
}

export interface RunCodexExecJsonResult {
  /** Final assistant text (parsed `summary` from the JSONL stream). */
  text: string;
  /** Raw stdout (JSONL) — for diagnostics / error classification. */
  stdout: string;
  /** Raw stderr — for diagnostics / error classification. */
  stderr: string;
  /** Process exit code (null if killed before exit). */
  exitCode: number | null;
  /** Set true when the run was killed by the timeout. */
  timedOut: boolean;
  /** Set true when the run was killed because stdout exceeded the size cap. */
  outputCapped: boolean;
  /** Spawn error (e.g. ENOENT) when the binary could not launch. */
  spawnError: NodeJS.ErrnoException | null;
  /** Resolved model used for the invocation (provenance). */
  resolvedModel: string;
}

/**
 * Run a single `codex exec --json -` turn with the prompt on stdin and return
 * the final assistant TEXT. No MCP, no resume, no streaming.
 *
 * Mirrors runCodexTurn's spawn shape (argv, CODEX_HOME, stdin+close, JSONL
 * parse) minus the bridge + session machinery. Reuses the exported codex
 * helpers verbatim so model/auth/parse semantics stay single-sourced.
 */
export async function runCodexExecJson(
  prompt: string,
  options: RunCodexExecJsonOptions = {},
): Promise<RunCodexExecJsonResult> {
  const { timeoutMs = 60_000, codexModel = null } = options;
  const isWin = platform() === "win32";

  const {
    ensureCodexAuthInHome,
    readSharedCodexModel,
    parseCodexJsonl,
  } = await import("@armyofagents/adapter-codex-local/server");

  // Per-run, UNGUESSABLE credential + cwd dirs (P2, Codex re-review): a stable
  // predictable name in the shared OS temp dir is unsafe — mkdir(mode:0o700)
  // does NOT re-permission an ALREADY-existing dir, so a local user could
  // pre-create `/tmp/aoa-codex-extract` world-readable and then read the
  // copied auth.json. mkdtemp creates a fresh random-suffixed dir (mode 0o700)
  // each run that no other user can predict; both are removed in `finally`.
  //   - codexHomeDir holds auth.json (no MCP config.toml — the extractor needs
  //     no tools).
  //   - codexCwd is an EMPTY working dir, SIBLING of the home (not a parent), so
  //     the read-only sandbox's readable workspace can't reach the credential
  //     dir (a prompt-injected entry can't have codex read + emit the token).
  const codexHomeDir = await mkdtemp(join(tmpdir(), "aoa-codex-extract-"));
  const codexCwd = await mkdtemp(join(tmpdir(), "aoa-codex-extract-run-"));
  try {
  // Provision auth.json from the shared ~/.codex so `codex exec` is
  // authenticated (no-op if the user has no login).
  await ensureCodexAuthInHome(codexHomeDir);

  // Model: same layered, validated resolution as the chat path so a claude
  // default / GPT-Codex / shell-unsafe value can never reach codex.
  const sharedCodexModel = await readSharedCodexModel();
  const resolvedModel = resolveCodexChatModel(codexModel, sharedCodexModel);

  // SECURITY (P1, Codex): extraction feeds ARBITRARY discussion text into codex
  // as the prompt, so it must NOT run with the approvals/sandbox bypass — a
  // prompt-injection entry could otherwise make codex execute host commands as
  // the server user. Extraction only needs the model to read the prompt and emit
  // JSON; it needs no shell/tool access. Run with the most restrictive sandbox
  // (read-only) and never auto-approve escalations (non-interactive, so it can't
  // hang waiting for one either).
  const args = [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--model",
    resolvedModel,
    "-c",
    `model_reasoning_effort=${COMMANDER_CODEX_REASONING_EFFORT}`,
    "-",
  ];

  // cwd = a dedicated EMPTY dir (not tmpdir, not CODEX_HOME): keeps the
  // subprocess from reading project CLAUDE.md / AGENTS.md AND keeps the codex
  // credential dir outside the read-only sandbox's readable workspace (P1, Codex).
  // env: FULLY scrubbed of the server's own secrets — including the embeddings
  // OPENAI_API_KEY (P1, Codex re-review). Keyless codex extraction authenticates
  // via the copied auth.json (CODEX_HOME), NOT the server's OpenAI key, so
  // re-adding that hosted key would hand it to an untrusted-prompt subprocess
  // that could print its env and exfiltrate it. GITHUB_PAT / DATABASE_URL /
  // AOA_* / ANTHROPIC_API_KEY are likewise withheld.
  const proc = spawn("codex", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...buildScrubbedCliEnv(),
      CODEX_HOME: codexHomeDir,
    },
    shell: isWin,
    cwd: codexCwd,
  });

  const stdoutBuf = newCappedBuffer();
  const stderrBuf = newCappedBuffer();
  let timedOut = false;
  let spawnError: NodeJS.ErrnoException | null = null;

  proc.stdout?.on("data", (d: Buffer) => {
    // Bound buffered JSONL: codex --json is verbose, and a looping/hostile turn
    // could stream until the server OOMs. On overflow, kill and stop reading.
    if (appendCapped(stdoutBuf, d, MAX_CLI_STDOUT_BYTES)) proc.kill();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    appendCapped(stderrBuf, d, MAX_CLI_STDERR_BYTES);
  });

  // Swallow stdin stream errors (P1, Codex): if codex exits before reading stdin
  // (auth/model/config error) and the prompt exceeds the OS pipe buffer, the
  // write raises EPIPE. Without an `error` listener that is an unhandled stream
  // error that crashes the process; the early exit is captured by the
  // close/error handler below and classified as a CLI failure instead.
  proc.stdin?.on("error", () => {});

  // codex reads the prompt from stdin (the `-` PROMPT arg) until EOF, so the
  // stream MUST be closed for the one-shot turn to proceed (raw content — codex
  // never sees a shell).
  if (proc.stdin?.writable) {
    proc.stdin.write(prompt + "\n");
    proc.stdin.end?.();
  }

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
    // Short grace, then SIGKILL if still alive.
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
    }, 2_000).unref?.();
  }, timeoutMs);
  timer.unref?.();

  // Wait for "close" (NOT "exit"): Node can emit `exit` before stdout/stderr are
  // fully flushed/closed, so parsing on `exit` can see truncated/empty JSONL and
  // make codex extraction intermittently return an empty/unparseable response.
  // `close` fires only after all stdio streams have ended, so `stdout` is whole
  // by the time we parse. (The claude one-shot path waits for `close` too.)
  const exitCode = await new Promise<number | null>((resolveExit) => {
    proc.on("close", (code) => resolveExit(code));
    proc.on("error", (err: NodeJS.ErrnoException) => {
      spawnError = err;
      resolveExit(null);
    });
  });

  clearTimeout(timer);

  const stdout = stdoutBuf.text;
  const stderr = stderrBuf.text;
  const parsed = parseCodexJsonl(stdout);

  return {
    text: parsed.summary ?? "",
    stdout,
    stderr,
    exitCode,
    timedOut,
    outputCapped: stdoutBuf.capped,
    spawnError,
    resolvedModel,
  };
  } finally {
    // Always remove the per-run credential + cwd dirs (they hold the copied
    // auth.json) — on success, parse failure, timeout, or spawn error.
    await rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
    await rm(codexCwd, { recursive: true, force: true }).catch(() => {});
  }
}
