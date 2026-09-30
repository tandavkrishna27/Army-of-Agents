import fs from "node:fs/promises";
import path from "node:path";
import {
  isHttpServerSpec,
  isStdioServerSpec,
  mergeExternalMcpServers,
  readAoaManagedServerNames,
  removeLegacyCwdManifest,
  reservedMcpServerNameCollisions,
  tryResolveMcpManagedManifestPath,
  sweepAoaManagedEntries,
  tryWriteAoaManagedServerNames,
  withSynthesizedBearerHeader,
  type McpHttpServerSpec,
  type McpServerSpec,
  type McpWriterResult,
  type McpWriterSkip,
} from "@armyofagents/adapter-utils";

/**
 * T2.2 — gemini MCP bridge spec writer.
 *
 * Mirrors opencode-config-json.ts but for gemini's `.gemini/settings.json`
 * discovery mechanism. Pre-T2.2 gemini crew agents spawned without MCP
 * tools (the runner passed ctx.mcpBridge but the adapter ignored it).
 * Same failure mode codex had pre-MX2 and opencode had pre-T2.1; this
 * commit closes the parallel gap.
 *
 * SHAPE (claude_desktop_config.json-compatible — gemini's accepted format):
 *
 *   {
 *     "mcpServers": {
 *       "aoa": {
 *         "command": "node",
 *         "args": ["/path/to/mcp-bridge.js"],
 *         "env": { ... }
 *       }
 *     }
 *   }
 *
 * Note: this differs from opencode's shape. opencode wants `command` as a
 * single array (cmd + args together) under `mcp.<name>`; gemini wants the
 * claude-shape with `command: string` + `args: string[]` separately under
 * `mcpServers.<name>`. Bridge spec → schema mapping happens here.
 *
 * DISCOVERY: gemini reads `.gemini/settings.json` from the cwd (workspace
 * scope) and `~/.gemini/settings.json` (user scope). We write to the
 * workspace scope so we never touch the user's global config — keeps the
 * pollution radius bounded to the adapter-controlled workspace.
 *
 * IDEMPOTENT + ERROR-TOLERANT (same policies as opencode T2.1):
 *  - re-running with same spec is byte-identical
 *  - preserves unrelated keys (theme, contextFileName, other mcp servers)
 *  - strips the prior mcpServers.{serverName} before splicing the new one
 *    so spec changes propagate cleanly (no stale env)
 *  - parse-fail on existing file → overwrite with a fresh config containing
 *    just the aoa block. Pinned by tests so a future "preserve" choice is
 *    explicit.
 */

/** Provider-neutral MCP bridge spec — same shape codex/opencode adapters use.
 *  Local copy of the shape; this package must not import from the server. */
export interface GeminiMcpBridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** An `mcpServers.<name>` entry in gemini's settings.json. */
type GeminiMcpEntry =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { httpUrl: string; headers?: Record<string, string> };

/**
 * Render ONE external connector as a gemini `mcpServers.<name>` entry.
 *
 * SECRET PLACEHOLDERS ARE EMITTED VERBATIM. gemini's native interpolation
 * syntax IS `${VAR}` — the exact form the specs already carry — so unlike the
 * opencode writer (which must rewrite to `{env:VAR}`) and the codex writer
 * (which cannot expand at all and uses env-var-NAME indirection), there is
 * nothing to translate here. Verified live against gemini-cli: a header of
 * `Bearer ${AOA_PROBE_TOKEN}` arrived at the listener fully expanded, in
 * `headers`, `args` and `env` alike (Plan 2b B2N9). Do not "helpfully" rewrite
 * these — any rewrite would break the one CLI whose syntax already matches.
 */
function toGeminiEntry(spec: McpServerSpec): GeminiMcpEntry {
  if (isHttpServerSpec(spec)) {
    // I3: a connector can have a secret and an EMPTY headerTemplate — the API
    // defaults it to `{}` and never requires a `${TOKEN}` reference, so this is
    // creatable straight from the UI. codex is fine (it consumes
    // `authTokenEnvVar` directly), but here an empty map would emit a remote
    // server with NO auth and no skip: it authenticates as no-one, silently.
    // gemini's native interpolation syntax IS `${VAR}` — the same form the specs
    // already carry — so the shared helper renders the token ref verbatim; there
    // is nothing else to translate (verified live, Plan 2b B2N9).
    const headers = withSynthesizedBearerHeader(
      spec.headers,
      spec.authTokenEnvVar,
      (varName) => `\${${varName}}`,
    );
    return { httpUrl: spec.url, headers };
  }
  const stdio = spec as Extract<McpServerSpec, { kind: "stdio" }>;
  return {
    command: stdio.command,
    args: [...(stdio.args ?? [])],
    env: { ...(stdio.env ?? {}) },
  };
}

export interface WriteGeminiMcpSettingsOptions {
  /**
   * EXTERNAL MCP connectors keyed by server name. Rendered alongside the bridge
   * into `mcpServers`. Pass an EMPTY object to mean "this run has no
   * connectors" — the sweep then removes every connector a previous run wrote.
   */
  externalServers?: Record<string, McpServerSpec>;
  /** Key for AoA's own loopback bridge. */
  serverName?: string;
  /**
   * Identity the ownership manifest is scoped to. The manifest lives under the
   * AoA instance root (never in the workspace — see `mcp-managed-manifest.ts`),
   * keyed by company + agent + cwd so concurrent runs never collide.
   */
  companyId?: string | null;
  agentId?: string | null;
}

/**
 * Write/merge `<cwd>/.gemini/settings.json` so gemini discovers the AoA
 * internal-agent MCP bridge plus every external connector. Idempotent.
 * Preserves unrelated keys and the user's own `mcpServers.*` entries.
 *
 * STALENESS (B5): AoA-owned entry names are recorded in an ownership manifest
 * under the AoA instance root and swept on the next run — see
 * `mcp-managed-manifest.ts` for the rationale, the rejected alternatives, why
 * the manifest must not live in the workspace, and why it is written BEFORE
 * this config. Notably, a separate manifest was chosen over an in-file key
 * precisely so this writer does NOT have to bet on gemini tolerating an unknown
 * key in settings.json — a property that could not be verified here (gemini
 * exits at an auth wall before config load is observable), and whose failure
 * mode on the sibling CLI is total MCP loss.
 *
 * `spec` may be null: a run with connectors but no bridge still writes — and
 * therefore still cleans — the file.
 *
 * U4b (S7): `spec` may also be an {@link McpHttpServerSpec} — a brokered
 * (E2B-sandboxed) run's `aoa` server, pointed at the control-plane broker
 * instead of a locally-spawned stdio process. gemini's `mcpServers.<name>`
 * entry already supports an `httpUrl` (HTTP) form for external connectors
 * (see `toGeminiEntry`) — the brokered aoa server is rendered through that
 * SAME path, so it carries no `command`/`env` and therefore no
 * `DATABASE_URL`. Non-brokered (stdio) specs are unchanged.
 */
export async function writeGeminiMcpSettingsJson(
  cwd: string,
  spec: GeminiMcpBridgeSpec | McpHttpServerSpec | null | undefined,
  options: WriteGeminiMcpSettingsOptions = {},
): Promise<McpWriterResult> {
  const serverName = options.serverName ?? "aoa";
  const externalServers = options.externalServers ?? {};
  const geminiDir = path.join(cwd, ".gemini");
  await fs.mkdir(geminiDir, { recursive: true });
  // Best-effort: a resolution failure means "no ownership tracking this run",
  // never an aborted MCP config write (M-3).
  const manifestPath = tryResolveMcpManagedManifestPath({
    adapter: "gemini",
    cwd,
    companyId: options.companyId,
    agentId: options.agentId,
  });
  // An earlier build wrote the manifest into the workspace. Remove it (never
  // read it — it is untrusted there); see removeLegacyCwdManifest.
  await removeLegacyCwdManifest(geminiDir);
  const target = path.join(geminiDir, "settings.json");

  let existing: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unparseable — treat as empty config (overwrite policy).
    existing = {};
  }

  const existingServers =
    typeof existing.mcpServers === "object"
    && existing.mcpServers !== null
    && !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as Record<string, unknown>)
      : {};

  // B5 sweep: drop every entry a PREVIOUS AoA run owned, so a deleted/disabled
  // connector stops being offered to the agent. `serverName` is included even
  // when it predates the manifest, preserving the bridge's full-replace
  // semantics (no stale env carryover).
  const previouslyManaged = await readAoaManagedServerNames(manifestPath);
  const preserved = sweepAoaManagedEntries(existingServers, [
    ...previouslyManaged,
    serverName,
  ]);

  // Classify what we cannot deliver BEFORE merging — nothing is dropped
  // silently. Reserved names are filtered inside mergeExternalMcpServers too;
  // collecting them here is purely so they can be REPORTED.
  const skipped: McpWriterSkip[] = [];
  for (const name of reservedMcpServerNameCollisions(externalServers, [serverName])) {
    skipped.push({ serverName: name, reason: "reserved_name" });
  }
  const deliverable: Record<string, McpServerSpec> = Object.create(null);
  for (const [name, connector] of Object.entries(externalServers)) {
    if (isHttpServerSpec(connector) || isStdioServerSpec(connector)) {
      deliverable[name] = connector;
      continue;
    }
    skipped.push({ serverName: name, reason: "unsupported_transport" });
  }
  // NOTE: no `secret_unreachable` case. gemini expands `${VAR}` in headers,
  // args and env alike (B2N9, verified live), so every connector shape has a
  // working route for its credential. That skip is codex-only.

  const bridge: Record<string, GeminiMcpEntry> = Object.create(null);
  if (spec) {
    // U4b (S7): a brokered spec is HTTP-shaped — render it through the SAME
    // httpUrl path external HTTP connectors use (toGeminiEntry), so it
    // carries no `command`/`env` block and therefore no DATABASE_URL.
    // Non-brokered (stdio) specs keep the original claude-shaped entry.
    bridge[serverName] = isHttpServerSpec(spec)
      ? toGeminiEntry(spec)
      : {
          // Claude-shape: command as string, args as string[]. (opencode's
          // "command as combined array" shape is the OTHER convention.)
          command: spec.command,
          args: [...spec.args],
          env: { ...spec.env },
        };
  }

  // mergeExternalMcpServers is the ONLY safe merge: reserved-name filtering and
  // a null-prototype destination in one call. A connector named `__proto__`
  // assigned onto a normal object literal would replace the prototype instead
  // of creating a key, and the server would silently vanish.
  const aoaOwned = mergeExternalMcpServers<GeminiMcpEntry>(
    bridge,
    deliverable,
    toGeminiEntry,
    [serverName],
  );

  const nextServers: Record<string, unknown> = Object.create(null);
  for (const [name, value] of Object.entries(preserved)) nextServers[name] = value;
  for (const [name, value] of Object.entries(aoaOwned)) nextServers[name] = value;

  const managedServerNames = Object.keys(aoaOwned);

  const next = {
    ...existing,
    mcpServers: nextServers,
  };

  // 2-space indent + trailing newline (same as opencode T2.1).
  //
  // T2.2.1 (codex finding P1): atomic write. See opencode-config-json.ts
  // for the full rationale — same bug class, same fix. We write into the
  // `.gemini/` dir (already created above) so the temp file is on the same
  // filesystem as the target, which is what fs.rename() needs to be atomic.
  // Windows requires the EPERM/EBUSY retry loop because concurrent renames
  // against the same target briefly fail with the destination locked —
  // POSIX never sees this.
  const body = JSON.stringify(next, null, 2) + "\n";

  // I1 — MANIFEST FIRST, WITH THE UNION. The two files cannot be written
  // atomically together, so the crash window must fail safe. Claiming ownership
  // BEFORE the config means a name can never be written to disk without already
  // being claimed. Config-first was wrong: a crash after the config left the new
  // names unowned FOREVER (the next run rewrites the manifest from its own set
  // and never learns about them). The union can only over-claim names AoA is
  // about to write or already owned, so it can never eat a user entry.
  await tryWriteAoaManagedServerNames(manifestPath, [
    ...previouslyManaged,
    ...managedServerNames,
  ]);

  const tempName = `settings.json.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const tempPath = path.join(geminiDir, tempName);
  await fs.writeFile(tempPath, body, "utf8");
  try {
    await renameWithRetry(tempPath, target);
  } catch (err) {
    // Best-effort cleanup so a failing rename doesn't leak a temp file.
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }

  // Narrow the claim to exactly what this run wrote, now that the config is
  // durable. A crash before this point just leaves the (safe) union.
  await tryWriteAoaManagedServerNames(manifestPath, managedServerNames);

  return { managedServerNames, skipped };
}

/**
 * fs.rename() with retry on Windows EPERM/EBUSY. Identical contract to the
 * opencode adapter's renameWithRetry — POSIX rename is atomic and never
 * throws these codes for same-fs moves, so on Linux/Mac the loop exits on
 * attempt 1. Inlined rather than imported from a shared package because
 * (a) only 2 call sites and (b) this package must not depend on the
 * opencode-local package. If a 3rd call site emerges, factor out to
 * @armyofagents/adapter-utils.
 */
async function renameWithRetry(src: string, dst: string, maxAttempts = 10): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fs.rename(src, dst);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        throw err;
      }
      // Jittered backoff so retrying writers don't wake in lockstep.
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
    }
  }
  throw lastErr;
}
