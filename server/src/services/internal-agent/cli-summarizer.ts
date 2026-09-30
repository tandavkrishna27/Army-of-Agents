import { spawn } from "node:child_process";
import { platform, tmpdir } from "node:os";
import type { Db } from "@armyofagents/db";

import { tenantIsolationEnforced } from "../../config/deployment-mode.js";
import { resolveCompanyProviderCredential } from "../one-shot-provider-credential.js";
import { runOneShotCliInSandbox } from "../one-shot-sandbox-cli.js";

interface SummarizeArgs {
  cliTool: string;
  cheapModel?: string | null;
  transcript: string;
  /**
   * U13.6 — required on `cloud_auth` (`tenantIsolationEnforced()`), threaded
   * to `resolveCompanyProviderCredential` / `runOneShotCliInSandbox` so
   * compaction routes through an ephemeral sandbox authenticated with the
   * COMPANY's own provider key instead of the shared host's operator login.
   * Unused on desktop, where the ambient host CLI login is the intended auth
   * (mirrors `ExtractViaCliOptions.db`/`companyId`, extraction-cli.ts).
   */
  db?: Db;
  companyId?: string;
}

const PROMPT_PREFIX =
  "Summarize this conversation history concisely, preserving key decisions, action items, and context. Output ONLY the summary:\n\n";

/** U13.4-costed spawn budget for the sandbox branch — the desktop spawn below
 *  has no timeout of its own (pre-existing; out of scope here), but a
 *  sandboxed VM call always needs a bound. Matches extraction's default
 *  one-shot timeout (extraction-cli.ts). */
const SANDBOX_SUMMARIZE_TIMEOUT_MS = 60_000;

/**
 * Summarize a transcript via the SAME CLI the chat uses, with NO MCP bridge
 * / tool surface (a summary must never trigger tool calls). One-shot, plain
 * prompt, cheap model. Throws on non-zero exit / empty output (caller treats
 * any failure as "skip compaction this turn").
 */
export async function summarizeViaCli(args: SummarizeArgs): Promise<string> {
  const prompt = PROMPT_PREFIX + args.transcript;

  // U13.6: on AoA Cloud (cloud_auth), route through the SAME ephemeral-sandbox
  // seam every other one-shot CLI family uses (extraction — U13.2/U13.3;
  // readiness probes — U13.7), authenticated with the COMPANY's own resolved
  // provider key (U13.0) — never the shared host's operator login. This
  // replaces the old hard `tenantIsolationEnforced()` throw: compaction now
  // actually runs on cloud instead of being permanently unavailable. The
  // single caller (agent-loop.ts) still treats any throw from this function
  // as "skip compaction this turn" (best-effort), and — new in U13.6 — raises
  // a founder notification when that throw happens on cloud (agent-loop.ts).
  if (tenantIsolationEnforced()) {
    return summarizeViaCliSandbox(args, prompt);
  }

  const isWin = platform() === "win32";
  let bin: string;
  let argv: string[];
  let useStdin = false;

  if (args.cliTool === "codex") {
    bin = "codex";
    argv = ["exec", "--json", "-"];
    useStdin = true;
  } else {
    bin = "claude";
    argv = [
      "-p",
      isWin
        ? `"${prompt.replace(/"/g, '""').replace(/%/g, "%%").replace(/\^/g, "^^")}"`
        : prompt,
      "--output-format",
      "text",
    ];
  }

  if (args.cheapModel) argv = [...argv, "--model", args.cheapModel];

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWin,
      cwd: tmpdir(),
    });

    let out = "";

    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });

    child.on("close", (code: number | null) => {
      if (code === 0 && out.trim().length > 0) {
        resolve(out.trim());
      } else {
        reject(new Error(`summarizer exit ${code}`));
      }
    });

    child.on("error", reject);

    if (useStdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

/**
 * U13.6 — route Commander compaction through the ephemeral sandbox on AoA
 * Cloud. Command/args mirror the extraction sandbox invocation's INTENT
 * (extraction-cli.ts's `extractViaCliSandbox`, U13.2/U13.3): claude one-shot
 * text-generation-only with tools disabled (`--tools ""`, `--strict-mcp-config`
 * — this function's whole contract is "no tool surface, ever"), codex
 * `exec --json` in a read-only sandbox. The full prompt (instruction +
 * transcript, already concatenated by the caller — there is no separate
 * system/content channel here, unlike extraction) rides over stdin, exactly
 * like extraction's default (non-staged-file) sandbox branch.
 *
 * Unlike the desktop spawn below (which can rely on the local CLI login's own
 * default model), an ephemeral sandbox has no persistent login to fall back
 * on, so `--model` is always explicit here — `cheapModel` when the caller
 * supplied one (Commander's per-company "cheap compaction model" config),
 * else the company's resolved default model (`credential.model`, U13.0).
 */
async function summarizeViaCliSandbox(args: SummarizeArgs, prompt: string): Promise<string> {
  // Structural guard (mirrors extractViaCliSandbox's equivalent,
  // extraction-cli.ts): the only real caller (agent-loop.ts) threads
  // db+companyId together on cloud. A direct call missing either cannot
  // resolve a company provider key or acquire a sandbox — fail closed with
  // an actionable message rather than reaching runOneShotCliInSandbox with a
  // missing companyId/db.
  if (!args.db || !args.companyId) {
    throw new Error(
      "Commander compaction on AoA Cloud requires company context (db + companyId) to resolve a provider key.",
    );
  }

  // S3: resolved here (not just inside runOneShotCliInSandbox) because
  // codex's `exec` needs an explicit --model argv value up front. This is
  // the same double-resolve shape extraction.ts already uses:
  // resolveCliExtractionContext resolves once (for --model/config threading),
  // then runOneShotCliInSandbox resolves again internally (S2, env-building).
  const credential = await resolveCompanyProviderCredential(args.db, args.companyId, {
    cliTool: args.cliTool,
  });
  const model = args.cheapModel ?? credential.model;
  const command = args.cliTool === "codex" ? "codex" : "claude";
  const cliArgs =
    command === "codex"
      ? ["exec", "--json", "--sandbox", "read-only", "--ask-for-approval", "never", "--model", model, "-"]
      : ["--print", "--tools", "", "--strict-mcp-config", "--output-format", "text", "--model", model];

  const result = await runOneShotCliInSandbox({
    db: args.db,
    companyId: args.companyId,
    cliTool: args.cliTool,
    command,
    args: cliArgs,
    stdinContent: prompt,
    timeoutMs: SANDBOX_SUMMARIZE_TIMEOUT_MS,
    // U13.4: labels the cost_events row so budget/cost reporting can tell
    // compaction spend apart from extraction/readiness spend.
    source: "compaction",
  });

  const summary = result.stdout.trim();
  if (!summary) {
    throw new Error("Commander compaction (sandbox) produced empty output.");
  }
  return summary;
}
