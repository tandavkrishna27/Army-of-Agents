/**
 * Extraction ENGINE ROUTER.
 *
 * Decides whether a discussion entry can be extracted. Extraction is CLI-ONLY
 * (keyless): a local CLI (`claude` / `codex`) on PATH and logged in. There is
 * NO hosted-API extraction path — hosted provider keys are consumed only by
 * embeddings (Decision #104, amended 2026-06-27). If no supported CLI is
 * available the router throws; it NEVER consults a provider key.
 *
 * AUTO resolution:
 *   1. If a supported CLI is available (binary on PATH, probed via
 *      `detectCliTool`) → "cli".
 *   2. Else throw (no extraction engine — install + log in a CLI).
 *
 * The `opts.cliAvailable` injection point lets unit tests drive the decision
 * without real binaries.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { internalAgentConfig } from "@armyofagents/db";
import { detectCliTool } from "./internal-agent/cli-mode.js";

/** Engines the router can select. Extraction is CLI-only. */
export type ExtractionEngine = "cli";

/** Default CLI tool when a company has no configured Commander CLI tool. */
export const DEFAULT_EXTRACTION_CLI_TOOL = "claude_cli";

/**
 * CLI tools that the one-shot extractor (`extraction-cli.ts`) can actually
 * drive — i.e. have a real extractor implementation. `detectCliTool` also
 * recognizes `opencode` (and future tools) for Commander CHAT, but
 * `extractViaCli` has no extractor for them. Without this allow-list an
 * opencode-configured company would resolve to "cli", then every extraction
 * would throw "Unsupported CLI tool". Treating it as unavailable instead makes
 * the router throw a clear "install a supported CLI" error. Keep this in sync
 * with `extraction-cli.ts`'s CLI_BINARY_MAP.
 */
export const EXTRACTION_SUPPORTED_CLI_TOOLS = new Set([
  "claude_cli",
  "claude",
  "codex",
]);

export interface ProbeExtractionCliResult {
  available: boolean;
  /** The CLI tool key that was probed (e.g. "claude_cli", "codex"). */
  tool: string;
  error?: string;
}

/**
 * Resolve the CLI tool a company would use for extraction. Reuses the
 * Commander CLI tool hint (`internal_agent_config.cliTool`) when present,
 * falling back to the keyless default (`claude_cli`).
 */
export async function resolveCompanyCliTool(
  db: Db,
  companyId: string,
): Promise<string> {
  const [config] = await db
    .select({ cliTool: internalAgentConfig.cliTool })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId));

  return config?.cliTool ?? DEFAULT_EXTRACTION_CLI_TOOL;
}

/**
 * Probe whether the configured extraction CLI binary is on PATH.
 *
 * Reuses `detectCliTool` (the same PATH-detection the Commander chat path uses)
 * so the two transports agree on what "available" means.
 *
 * @param cliTool  CLI tool key (e.g. "claude_cli", "codex"). Defaults to
 *                 `DEFAULT_EXTRACTION_CLI_TOOL` when omitted.
 */
export async function probeExtractionCli(
  cliTool: string = DEFAULT_EXTRACTION_CLI_TOOL,
): Promise<ProbeExtractionCliResult> {
  const detection = await detectCliTool(cliTool);
  return {
    available: detection.available,
    tool: cliTool,
    error: detection.error,
  };
}

export interface ResolveExtractionEngineOptions {
  /**
   * Inject CLI availability (skips the real PATH probe). When set, the router
   * uses this value verbatim instead of calling `probeExtractionCli`.
   */
  cliAvailable?: boolean;
}

/**
 * AUTO-resolve the extraction engine for a company. Extraction is CLI-only.
 *
 *   1. Determine the company's configured CLI tool (Commander hint, else default).
 *   2. If a supported CLI is available → "cli".
 *   3. Else throw — no extraction engine. The message guides the user to install
 *      a CLI (e.g. the Claude Code CLI) and run its login flow. A hosted
 *      provider key is NEVER consulted (keys are embeddings-only).
 *
 * Test injection: `opts.cliAvailable` short-circuits the real probe so unit
 * tests can drive the decision without binaries.
 */
export async function resolveExtractionEngine(
  db: Db,
  companyId: string,
  opts: ResolveExtractionEngineOptions = {},
): Promise<ExtractionEngine> {
  // CLI availability — injected for tests, else a real PATH probe.
  let cliAvailable: boolean;
  if (opts.cliAvailable !== undefined) {
    cliAvailable = opts.cliAvailable;
  } else {
    const cliTool = await resolveCompanyCliTool(db, companyId);
    // Only probe CLIs that extraction can actually drive. An unsupported
    // extraction CLI (e.g. opencode, which detectCliTool recognizes for chat)
    // must NOT report available — otherwise we'd commit to "cli" then fail
    // every extraction with "Unsupported CLI tool". Treat it as unavailable
    // so resolution throws the clear "install a supported CLI" guidance.
    if (!EXTRACTION_SUPPORTED_CLI_TOOLS.has(cliTool)) {
      cliAvailable = false;
    } else {
      const probe = await probeExtractionCli(cliTool);
      cliAvailable = probe.available;
    }
  }

  if (cliAvailable) {
    return "cli";
  }

  // No CLI — there is no extraction engine. Hosted keys are NOT a fallback.
  throw new Error(
    "No extraction engine available. Install a CLI (e.g. the Claude Code CLI) " +
      "and run its login flow (`claude auth login`).",
  );
}
