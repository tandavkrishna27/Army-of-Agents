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
 * T2.1 — opencode MCP bridge spec writer.
 *
 * Mirrors codex-config-toml.ts but for opencode's `opencode.json` discovery
 * mechanism. Pre-T2.1, opencode crew agents spawned without MCP tools — the
 * runner passed `ctx.mcpBridge` to the adapter but the adapter ignored it,
 * so the LLM ran with no way to call `post_entry` / `submit_extracted_items`
 * / etc. Same failure mode codex had pre-MX2 (resolved by the codex.toml
 * writer); T2.1 closes the parallel gap for opencode.
 *
 * SHAPE (per opencode docs research — v1-completion plan section 2.1):
 *
 *   {
 *     "mcp": {
 *       "aoa": {
 *         "type": "local",
 *         "command": ["node", "/path/to/mcp-bridge.js"],
 *         "environment": { ... }
 *       }
 *     }
 *   }
 *
 * Note: `command` is a SINGLE array containing the command + all args
 * (opencode's shape), unlike codex's separate `command = "..."` +
 * `args = [...]` fields. The bridge spec we receive has them split, so we
 * concatenate here.
 *
 * DISCOVERY: opencode reads opencode.json from the current working
 * directory. The adapter writes to `<cwd>/opencode.json` — same dir
 * opencode spawns in. Pollution risk is low (file is opencode-specific
 * config; users typically gitignore it).
 *
 * IDEMPOTENCE: re-running with the same spec produces byte-identical
 * output. The previous `mcp.aoa` (or matching serverName) block is
 * STRIPPED before splicing the new one — prevents stale env carryover when
 * the spec changes mid-deployment.
 *
 * ERROR TOLERANCE: if opencode.json exists but is unparseable JSON (a user
 * left a trailing comma during hand-editing, etc.), we OVERWRITE it with
 * a fresh config containing just the aoa block. Choice rationale: better
 * to lose hand-edits than to silently orphan our MCP wiring; tests pin
 * this policy so a future "preserve corrupt files" change is explicit.
 */

/** Provider-neutral MCP bridge spec — same shape the codex adapter uses.
 *  Local copy of the shape; this package must not import from the server. */
export interface OpenCodeMcpBridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** An `mcp.<name>` entry in opencode.json. */
type OpenCodeMcpEntry =
  | {
      type: "local";
      /** opencode wants command + args together as ONE array. */
      command: string[];
      environment?: Record<string, string>;
      enabled: true;
    }
  | {
      type: "remote";
      url: string;
      headers?: Record<string, string>;
      enabled: true;
    };

/**
 * Rewrite AoA's `${AOA_MCP_*}` secret placeholders into opencode's OWN
 * interpolation syntax, `{env:AOA_MCP_*}`.
 *
 * ── WHY THIS EXISTS (Plan 2b B2N9) ──────────────────────────────────────────
 * Specs arrive carrying `${VAR}` because that is claude's syntax and the server
 * substitutes one canonical form for every adapter (D5: the placeholder is on
 * disk, the real value rides in the spawned process env). opencode does NOT
 * expand `${VAR}` — it expands `{env:VAR}`. Emitting the incoming form verbatim
 * hands the connector the LITERAL eight characters `${AOA_M…}` as its bearer
 * token: the server does not fail loudly, it authenticates as no-one.
 *
 * ── THE TRAP ────────────────────────────────────────────────────────────────
 * This rewrite must be applied to stdio `args` and stdio `environment` VALUES
 * as well as to HTTP headers. It is tempting to treat this as an
 * "HTTP auth header" concern and rewrite only headers — that reproduces exactly
 * the bug above on every stdio connector. Verified against opencode v1.18.4:
 * `{env:VAR}` expands in all three positions.
 *
 * Only the `${AOA_MCP_*}` form is touched. A user's unrelated literal text —
 * including any other `${...}` they legitimately want passed through — is left
 * exactly as written.
 */
function toOpenCodeEnvSyntax(value: string): string {
  return value.replace(/\$\{(AOA_MCP_[A-Za-z0-9_]*)\}/g, "{env:$1}");
}

function rewriteValues(map: Record<string, string>): Record<string, string> {
  // Null prototype: a header or env key literally named `__proto__` assigned
  // onto a normal `{}` hits Object.prototype's setter — no own key is created
  // and the entry silently vanishes from the emitted config.
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(map ?? {})) {
    out[key] = typeof value === "string" ? toOpenCodeEnvSyntax(value) : value;
  }
  return out;
}

/** Render ONE external connector as an opencode `mcp.<name>` entry. */
function toOpenCodeEntry(spec: McpServerSpec): OpenCodeMcpEntry {
  if (isHttpServerSpec(spec)) {
    // I3: a connector can have a secret and an EMPTY headerTemplate — the API
    // defaults it to `{}` and never requires a `${TOKEN}` reference, so this is
    // creatable straight from the UI. codex is fine (it consumes
    // `authTokenEnvVar` directly), but here an empty map would emit a remote
    // server with NO auth and no skip: it authenticates as no-one, silently.
    // The shared helper synthesises the conventional bearer header in opencode's
    // `{env:VAR}` syntax — headers are pre-rewritten so the "already referenced"
    // check compares against that same form.
    const headers = withSynthesizedBearerHeader(
      rewriteValues(spec.headers ?? {}),
      spec.authTokenEnvVar,
      (varName) => `{env:${varName}}`,
    );
    return {
      type: "remote",
      url: spec.url,
      headers,
      enabled: true,
    };
  }
  // Narrowed by the caller's pre-filter — only stdio reaches here.
  const stdio = spec as Extract<McpServerSpec, { kind: "stdio" }>;
  return {
    type: "local",
    command: [stdio.command, ...(stdio.args ?? []).map(toOpenCodeEnvSyntax)],
    environment: rewriteValues(stdio.env ?? {}),
    enabled: true,
  };
}

export interface WriteOpenCodeMcpConfigOptions {
  /**
   * EXTERNAL MCP connectors keyed by server name. Rendered alongside the
   * bridge into `mcp`.
   *
   * Pass an EMPTY object (rather than omitting it) to mean "this run has no
   * connectors": the sweep then removes every connector a previous run wrote.
   * Omitting has the same effect here since the sweep is unconditional — the
   * distinction matters at the execute() call site's presence gate.
   */
  externalServers?: Record<string, McpServerSpec>;
  /** Key for AoA's own loopback bridge. */
  serverName?: string;
  /**
   * Identity the ownership manifest is scoped to. The manifest lives under the
   * AoA instance root (never in `cwd` — see `mcp-managed-manifest.ts`), keyed by
   * company + agent + cwd so concurrent runs never collide.
   */
  companyId?: string | null;
  agentId?: string | null;
}

/**
 * Write/merge `<cwd>/opencode.json` so that opencode discovers and spawns
 * the AoA internal-agent MCP bridge plus every external connector.
 * Idempotent. Preserves unrelated keys and the user's own `mcp.*` entries.
 *
 * STALENESS (B5): AoA-owned entry names are recorded in an ownership manifest
 * under the AoA instance root and swept on the next run — see
 * `mcp-managed-manifest.ts` for the full rationale, the rejected alternatives
 * (an in-file manifest key is empirically FATAL here: opencode refuses unknown
 * top-level keys and then loads NO MCP servers at all), why the manifest must
 * not live in the agent's repo, and why it is written BEFORE this config.
 *
 * `spec` may be null: a run with connectors but no bridge still writes — and
 * therefore still cleans — the file.
 *
 * U4b (S7): `spec` may also be an {@link McpHttpServerSpec} — a brokered
 * (E2B-sandboxed) run's `aoa` server, pointed at the control-plane broker
 * instead of a locally-spawned stdio process. opencode's `mcp.<name>` entry
 * already supports a `type:"remote"` (HTTP) form for external connectors
 * (see `toOpenCodeEntry`) — the brokered aoa server is rendered through that
 * SAME path, so it carries no `command`/`environment` and therefore no
 * `DATABASE_URL`. Non-brokered (stdio) specs are unchanged.
 */
export async function writeOpenCodeMcpConfigJson(
  cwd: string,
  spec: OpenCodeMcpBridgeSpec | McpHttpServerSpec | null | undefined,
  options: WriteOpenCodeMcpConfigOptions = {},
): Promise<McpWriterResult> {
  const serverName = options.serverName ?? "aoa";
  const externalServers = options.externalServers ?? {};
  await fs.mkdir(cwd, { recursive: true });
  const target = path.join(cwd, "opencode.json");
  // Best-effort: a resolution failure means "no ownership tracking this run",
  // never an aborted MCP config write (M-3).
  const manifestPath = tryResolveMcpManagedManifestPath({
    adapter: "opencode",
    cwd,
    companyId: options.companyId,
    agentId: options.agentId,
  });
  // An earlier build wrote the manifest into the repo. Remove it (never read
  // it — it is untrusted there); see removeLegacyCwdManifest.
  await removeLegacyCwdManifest(cwd);

  let existing: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Either file doesn't exist or content isn't parseable JSON. Treat as
    // empty config — tests pin this "overwrite-on-parse-fail" policy.
    existing = {};
  }

  const existingMcp =
    typeof existing.mcp === "object" && existing.mcp !== null && !Array.isArray(existing.mcp)
      ? (existing.mcp as Record<string, unknown>)
      : {};

  // B5 sweep: drop every entry a PREVIOUS AoA run owned, so a deleted/disabled
  // connector stops being offered to the agent. `serverName` is included even
  // when it predates the manifest, so the bridge's full-replace semantics
  // (no shallow-merge of environment) are preserved.
  const previouslyManaged = await readAoaManagedServerNames(manifestPath);
  const preserved = sweepAoaManagedEntries(existingMcp, [...previouslyManaged, serverName]);

  // Classify what we cannot deliver BEFORE merging, so nothing is dropped
  // silently. Reserved names are also filtered inside mergeExternalMcpServers;
  // computing the collisions here is purely so they can be REPORTED.
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
    // Unknown transport — skip and keep running, never fail the run.
    skipped.push({ serverName: name, reason: "unsupported_transport" });
  }
  // NOTE: no `secret_unreachable` case here. opencode expands `{env:VAR}` in
  // headers, args AND environment values (B2N9, verified), so every connector
  // shape has a working route for its credential. That skip is codex-only.

  const bridge: Record<string, OpenCodeMcpEntry> = Object.create(null);
  if (spec) {
    // U4b (S7): a brokered spec is HTTP-shaped — render it through the SAME
    // remote-entry path external HTTP connectors use (toOpenCodeEntry), so
    // it carries no `command`/`environment` block and therefore no
    // DATABASE_URL. Non-brokered (stdio) specs keep the original local shape.
    bridge[serverName] = isHttpServerSpec(spec)
      ? toOpenCodeEntry(spec)
      : {
          type: "local",
          // opencode wants command + args together as a single array.
          command: [spec.command, ...spec.args],
          environment: { ...spec.env },
          enabled: true,
        };
  }

  // mergeExternalMcpServers is the ONLY safe merge: it couples reserved-name
  // filtering with a null-prototype destination. A connector literally named
  // `__proto__` assigned onto a normal object would replace the prototype
  // instead of creating a key.
  const aoaOwned = mergeExternalMcpServers<OpenCodeMcpEntry>(
    bridge,
    deliverable,
    toOpenCodeEntry,
    [serverName],
  );

  // Null-prototype destination for the same reason (survivors can include a
  // `__proto__` own key straight out of JSON.parse).
  const nextMcp: Record<string, unknown> = Object.create(null);
  for (const [name, value] of Object.entries(preserved)) nextMcp[name] = value;
  for (const [name, value] of Object.entries(aoaOwned)) nextMcp[name] = value;

  const managedServerNames = Object.keys(aoaOwned);

  const next = {
    ...existing,
    mcp: nextMcp,
  };

  // 2-space indent matches the codex pattern's readability + makes diffs
  // useful when an operator inspects the file by hand. Trailing newline so
  // POSIX text-file tools don't complain.
  //
  // T2.1.1 (codex finding P1): atomic write. Pre-fix this was a bare
  // fs.writeFile(target, ...) which (under concurrent agent starts in the
  // same cwd) could either tear the file (byte interleaving) or clobber
  // unrelated mcp.* entries. POSIX rename(2) and Windows MoveFileExW (which
  // Node's fs.rename uses on NTFS, Vista+) are atomic for same-fs moves —
  // every reader sees either the old file or the new file, never a partial
  // mix. We write to a randomized tempname IN THE SAME DIRECTORY (so the
  // rename stays on the same filesystem) and rename over the target.
  //
  // Windows quirk: concurrent renames against the SAME target can throw
  // EPERM/EBUSY/EACCES briefly because the destination has an open handle
  // from the rename-in-progress. POSIX never sees this. Retry with a tiny
  // jittered backoff so 10 concurrent writers all eventually win their
  // own slot. The retry budget (10 attempts, ~5-15ms each = ~150ms worst
  // case) is well below any sane LLM-call latency, so this doesn't change
  // observable latency on the happy path.
  const body = JSON.stringify(next, null, 2) + "\n";

  // I1 — MANIFEST FIRST, WITH THE UNION. The two files cannot be written
  // atomically together, so the crash window must fail safe. Claiming ownership
  // BEFORE the config means a name can never be written to disk without already
  // being claimed. Config-first was wrong: a crash after the config left the new
  // names unowned FOREVER (the next run rewrites the manifest from its own set
  // and never learns about them), which is exactly the revoked-connector-still-
  // live failure. The union can only over-claim names AoA is about to write or
  // already owned, both AoA-owned by the ownership rule, so it can never eat a
  // user entry. See mcp-managed-manifest.ts.
  await tryWriteAoaManagedServerNames(manifestPath, [
    ...previouslyManaged,
    ...managedServerNames,
  ]);

  const tempName = `opencode.json.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const tempPath = path.join(cwd, tempName);
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
 * fs.rename() with a small retry budget for the Windows EPERM/EBUSY case
 * where the destination is briefly locked by a concurrent rename in
 * flight. POSIX rename(2) is atomic and never throws these codes for the
 * same-fs case, so on Linux/Mac this loop always exits on attempt 1.
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
      // Only retry the Windows-quirk codes. Any other error (ENOENT,
      // EISDIR, EROFS, ...) is a real problem — surface it immediately.
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        throw err;
      }
      // Jittered backoff so 10 retrying writers don't all wake in lockstep
      // and starve each other in synchronized cycles.
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
    }
  }
  throw lastErr;
}
