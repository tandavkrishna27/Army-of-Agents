import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  aoaSecretPlaceholderFor,
  aoaSecretPlaceholderVars,
  isHttpServerSpec,
  isStdioServerSpec,
  reservedMcpServerNameCollisions,
  stdioSpecCarriesSecretPlaceholder,
  stripReservedMcpServerNames,
  type McpHttpServerSpec,
  type McpServerSpec,
  type McpWriterResult,
  type McpWriterSkip,
} from "@armyofagents/adapter-utils";

/**
 * Serialize ALL config.toml mutations for a given managed home. The home is
 * per-AGENT (`prepareManagedCodexHome(..., companyId, agentId, ...)`), so two
 * agents no longer share a file — but one agent can still have concurrent runs
 * (and the model writer + MCP writer both touch the same file within a single
 * run). Both writers here do read-strip-rewrite; without serialization a concurrent
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
  configTomlWriteChains.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

/**
 * Provider-neutral MCP bridge spec (same shape as the server's
 * buildMcpBridgeSpec / adapter-utils McpBridgeSpec). Local copy of the shape —
 * this package must not import from the server.
 */
export interface CodexMcpBridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Escape a string for a TOML basic (double-quoted) string. TOML requires
 * backslash and the surrounding quote to be escaped, and disallows raw
 * control characters — escape the common ones (and any remaining control
 * char as a \uXXXX sequence) so the emitted file always parses.
 */
function escapeTomlBasicString(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\b":
        out += "\\b";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\r":
        out += "\\r";
        break;
      default:
        if (code < 0x20 || code === 0x7f) {
          out += "\\u" + code.toString(16).padStart(4, "0").toUpperCase();
        } else {
          out += ch;
        }
        break;
    }
  }
  return out;
}

function tomlString(value: string): string {
  return `"${escapeTomlBasicString(value)}"`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((v) => tomlString(v)).join(", ")}]`;
}

/**
 * Render the codex `[mcp_servers.<name>]` (+ nested `.env`) block. This mirrors
 * the exact structure codex itself writes via `codex mcp add` and reads back
 * via `codex mcp list`:
 *
 *   [mcp_servers.aoa]
 *   command = "node"
 *   args = ["/path/to/mcp-bridge.js"]
 *
 *   [mcp_servers.aoa.env]
 *   KEY = "value"
 *
 * stdio is codex's default transport — no explicit `transport` key is needed.
 */
function renderMcpBlock(spec: CodexMcpBridgeSpec, serverName: string): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${serverName}]`);
  lines.push(`command = ${tomlString(spec.command)}`);
  lines.push(`args = ${tomlStringArray(spec.args)}`);
  lines.push("");
  lines.push(`[mcp_servers.${serverName}.env]`);
  for (const [key, value] of Object.entries(spec.env)) {
    lines.push(`${key} = ${tomlString(value)}`);
  }
  return lines.join("\n");
}

/**
 * A connector name becomes a TOML table-header path segment
 * (`[mcp_servers.<name>]`). Names are untrusted runtime strings from DB rows, so
 * restrict them to TOML BARE keys (`A-Za-z0-9_-`). A name containing `]`, a
 * quote, or a newline would otherwise close the header early and let a
 * connector row inject arbitrary tables into codex's config. Anything outside
 * the bare-key set is skipped, not quoted: codex's own `codex mcp add` refuses
 * such names too, so quoting would only produce a server codex cannot address.
 */
const SAFE_MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Render ONE external connector as a codex `[mcp_servers.<name>]` block, or
 * `null` when the entry cannot be represented (unknown transport, unsafe name).
 * Skipping is deliberate: an adapter that cannot support a transport must drop
 * that entry and keep running rather than fail the whole run.
 *
 * stdio mirrors the bridge shape. HTTP uses codex's env-var-NAME indirection,
 * in three complementary forms — all verified against the real codex binary:
 *
 *   [mcp_servers.notion]
 *   url = "https://mcp.notion.com/mcp"
 *   bearer_token_env_var = "AOA_MCP_NOTION_TOKEN"
 *   env_http_headers = { "X-Api-Key" = "AOA_MCP_ACME_TOKEN" }
 *   http_headers = { "X-Tenant" = "acme" }
 *
 * `bearer_token_env_var` sends `Authorization: Bearer <value-of-that-var>`.
 * `env_http_headers` maps a header NAME to an env var NAME and sends the var's
 * RAW value as that header. `http_headers` carries literal, non-secret values.
 * All three are name-indirection or plain literals, so D5 holds: only env var
 * NAMES ever reach disk, and the real token travels in the spawn env
 * (connectorEnv → config.env → execute()'s child env).
 *
 * WHY ALL THREE (the C1 fix): the first version emitted `bearer_token_env_var`
 * unconditionally and DISCARDED `spec.headers` entirely. A connector that
 * authenticates with `X-Api-Key: ${TOKEN}` therefore got an `Authorization:
 * Bearer` header its server never reads, lost its real header, and was NOT
 * skipped — the precise "authenticates as no-one" outcome the skip channel
 * exists to prevent. Non-auth headers such as `X-Tenant` were dropped silently
 * too. Now every header is classified and nothing is discarded in silence.
 *
 * The `Bearer ` prefix is why `bearer_token_env_var` is kept rather than
 * expressing everything through `env_http_headers`: `env_http_headers` sends
 * the variable's raw value, so routing `Authorization: Bearer ${VAR}` through it
 * would send the bare token WITHOUT the `Bearer ` scheme and break the
 * overwhelmingly common case.
 *
 * These are all FLAT keys (inline tables), never `[mcp_servers.<n>.http_headers]`
 * sub-tables — B4. The legacy per-name stripper only knows `[mcp_servers.<n>]`
 * and `[mcp_servers.<n>.env]`, so a third sub-table could be orphaned; a flat
 * key is always carried with its parent header.
 */
type RenderedExternalBlock =
  | { block: string }
  | { block: null; reason: McpWriterSkip["reason"] };

/**
 * Render a TOML inline table: `{ "k" = "v", "k2" = "v2" }`. Keys are quoted
 * basic strings so any header name that passed validation is representable.
 */
function tomlInlineTable(entries: Array<[string, string]>): string {
  return `{ ${entries.map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(", ")} }`;
}

/**
 * Classify ONE http header into the codex form that can carry it.
 *
 * `null` means codex has no representation for it, which is a connector-level
 * skip rather than a dropped header: a partially-delivered auth story is how a
 * connector ends up silently unauthenticated.
 */
type HeaderPlan =
  | { form: "bearer"; varName: string }
  | { form: "env"; varName: string }
  | { form: "literal"; value: string }
  | null;

function planHttpHeader(headerName: string, value: string): HeaderPlan {
  const vars = aoaSecretPlaceholderVars(value);
  if (vars.length === 0) return { form: "literal", value };
  if (vars.length > 1) return null; // two secrets in one header: not expressible
  const varName = vars[0];
  if (!SAFE_MCP_SERVER_NAME.test(varName)) return null;

  const placeholder = aoaSecretPlaceholderFor(varName);
  // Whole value IS the placeholder → env_http_headers sends the raw value.
  if (value === placeholder) return { form: "env", varName };
  // `Authorization: Bearer ${VAR}` → codex's dedicated bearer form, which adds
  // the `Bearer ` prefix that env_http_headers would omit.
  if (headerName.toLowerCase() === "authorization" && value === `Bearer ${placeholder}`) {
    return { form: "bearer", varName };
  }
  // Placeholder embedded in other text (e.g. `Token ${VAR}` or `${VAR}-suffix`).
  // env_http_headers cannot add the surrounding text and http_headers would
  // write the literal placeholder, which authenticates as no-one.
  return null;
}

function renderExternalMcpBlock(name: string, spec: McpServerSpec): RenderedExternalBlock {
  if (!SAFE_MCP_SERVER_NAME.test(name)) return { block: null, reason: "unsafe_name" };

  if (isStdioServerSpec(spec)) {
    // ── B2N9: codex CANNOT deliver a stdio connector's secret ───────────────
    // Probed against the real CLI with a recorder MCP server that dumps the
    // env/argv it was actually spawned with:
    //   * codex does NOT expand `${VAR}` in stdio `args` or `env` — the child
    //     receives the literal eight characters, and
    //   * codex SCRUBS its own environment before spawning an MCP child, so the
    //     "the child inherits the token anyway" fallback that makes opencode
    //     forgiving does not exist here, and
    //   * `--bearer-token-env-var` is HTTP-ONLY; stdio's `--env` takes a
    //     literal `KEY=VALUE`. There is no stdio name-indirection.
    // So there is NO route by which this credential reaches the server. Writing
    // the block anyway produces a connector that silently authenticates as
    // no-one — the exact failure the classified-skip channel exists to prevent,
    // and strictly worse than a reported absence.
    //
    // The two tempting "fixes" are both REGRESSIONS, not fixes:
    //   * expanding the placeholder at write time writes a LIVE credential into
    //     config.toml on disk, reversing D5 (placeholder on disk, value in the
    //     spawn env);
    //   * `shell_environment_policy.inherit = "all"` is GLOBAL — it would leak
    //     every env var, including OTHER connectors' tokens, into every shell
    //     command the agent runs.
    // Stdio connectors WITHOUT a secret are unaffected and deliver normally;
    // HTTP connectors are unaffected (`bearer_token_env_var` works).
    if (stdioSpecCarriesSecretPlaceholder(spec)) {
      return { block: null, reason: "secret_unreachable" };
    }

    const envEntries = Object.entries(spec.env ?? {});
    // M1: a key that is not a TOML bare key used to be silently dropped, which
    // shipped a connector missing part of its environment while reporting
    // success. Partial delivery is indistinguishable from a broken server at
    // runtime, so refuse the whole connector and say why.
    if (envEntries.some(([key]) => !SAFE_MCP_SERVER_NAME.test(key))) {
      return { block: null, reason: "unsafe_name" };
    }

    const lines: string[] = [];
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${tomlString(spec.command)}`);
    lines.push(`args = ${tomlStringArray(spec.args ?? [])}`);
    if (envEntries.length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of envEntries) {
        lines.push(`${key} = ${tomlString(value)}`);
      }
    }
    return { block: lines.join("\n") };
  }

  if (isHttpServerSpec(spec)) {
    const headers = Object.entries(spec.headers ?? {});
    // Header NAMES get the same bare-key validation as server names: they end
    // up as inline-table keys, and an unvalidated name is an injection surface.
    if (headers.some(([headerName]) => !SAFE_MCP_SERVER_NAME.test(headerName))) {
      return { block: null, reason: "unsafe_name" };
    }

    const envHeaders: Array<[string, string]> = [];
    const literalHeaders: Array<[string, string]> = [];
    let bearerVar: string | null = null;
    /** Did some header already carry this connector's credential? */
    let secretDelivered = false;

    for (const [headerName, value] of headers) {
      const plan = planHttpHeader(headerName, typeof value === "string" ? value : "");
      if (plan === null) return { block: null, reason: "secret_unreachable" };
      if (plan.form === "literal") {
        literalHeaders.push([headerName, plan.value]);
      } else if (plan.form === "env") {
        envHeaders.push([headerName, plan.varName]);
        secretDelivered = true;
      } else {
        bearerVar = plan.varName;
        secretDelivered = true;
      }
    }

    // I3: a connector can have a secret and an EMPTY headerTemplate (the API
    // defaults it to `{}` and never requires a `${TOKEN}` reference). Fall back
    // to the bearer form so it authenticates, instead of emitting a URL with no
    // credential at all.
    const authVar = spec.authTokenEnvVar;
    if (
      !secretDelivered
      && typeof authVar === "string"
      && SAFE_MCP_SERVER_NAME.test(authVar)
    ) {
      bearerVar = authVar;
    }

    const lines: string[] = [];
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`url = ${tomlString(spec.url)}`);
    if (bearerVar) lines.push(`bearer_token_env_var = ${tomlString(bearerVar)}`);
    if (envHeaders.length > 0) {
      lines.push(`env_http_headers = ${tomlInlineTable(envHeaders)}`);
    }
    if (literalHeaders.length > 0) {
      lines.push(`http_headers = ${tomlInlineTable(literalHeaders)}`);
    }
    return { block: lines.join("\n") };
  }

  // Unknown/unsupported transport — skip, never fail the run.
  return { block: null, reason: "unsupported_transport" };
}

/**
 * Strip any prior `[mcp_servers.<serverName>]` and
 * `[mcp_servers.<serverName>.env]` blocks from existing TOML text, leaving all
 * other content untouched. A "block" runs from its table header up to (but not
 * including) the next top-level `[` table header or end-of-file. This keeps the
 * regenerate idempotent and never touches unrelated tables (e.g. `[profiles.*]`,
 * `[other]`) or sibling files such as `auth.json`.
 */
function stripAoaMcpBlocks(existing: string, serverName: string): string {
  const targetHeaders = new Set([
    `[mcp_servers.${serverName}]`,
    `[mcp_servers.${serverName}.env]`,
  ]);
  const lines = existing.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const isTableHeader = /^\[[^\]]+\]$/.test(trimmed);
    if (isTableHeader) {
      skipping = targetHeaders.has(trimmed);
      if (skipping) continue;
    }
    if (skipping) continue;
    kept.push(line);
  }
  // Collapse trailing blank lines so re-appended blocks are separated by
  // exactly one blank line each run (idempotent output).
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") {
    kept.pop();
  }
  return kept.join("\n");
}

/**
 * Ownership fence (Plan 2b B5). AoA's `[mcp_servers.*]` tables live between
 * these two sentinel comment lines, so a later run can remove ALL previously
 * AoA-owned server blocks without knowing the names it wrote. Without the fence
 * there is no way to enumerate prior writes: once a connector block is written,
 * disabling or deleting the connector would leave its `[mcp_servers.<name>]`
 * table in the file forever and the agent would keep the tool. Content OUTSIDE
 * the fence is user-authored and is never touched.
 *
 * EXCEPTION: the top-level `model = "..."` line written by
 * {@link writeCodexModelConfigToml} is deliberately kept OUTSIDE (above) the
 * fence — TOML requires top-level keys to precede the first table header, and
 * the fence opens immediately before a table. That line is AoA-owned too, but it
 * is managed by its own strip (`stripTopLevelModelLine`), not by the fence.
 *
 * The PREFIXES are the persisted on-disk contract — changing them orphans the
 * fenced content in every already-written config.toml. The human-facing tail of
 * each line is cosmetic: detection matches the prefix plus a terminator, so the
 * wording can be reworded later without stranding existing files.
 */
const AOA_MANAGED_FENCE_START_PREFIX = "# >>> aoa-managed";
const AOA_MANAGED_FENCE_END_PREFIX = "# <<< aoa-managed";
export const AOA_MANAGED_FENCE_START = `${AOA_MANAGED_FENCE_START_PREFIX} (do not edit below; regenerated each run)`;
// Self-describing on purpose: a bare `# <<< aoa-managed` reads like a stray
// comment, and a user tidying the file who deletes it would orphan the start
// fence. (An orphan start is now inert — see findFencedRegions — but the file
// would still silently stop being cleaned.)
export const AOA_MANAGED_FENCE_END = `${AOA_MANAGED_FENCE_END_PREFIX} (end of AoA-managed block; do not remove this line)`;

/**
 * A fence line is the prefix followed by a TERMINATOR — end-of-line, a space, or
 * `(`. Without this, `startsWith(prefix)` also swallows a user comment such as
 * `# >>> aoa-managed-notes for myself`, which would make the rest of their file
 * look AoA-owned.
 */
function isFenceLine(trimmed: string, prefix: string): boolean {
  if (!trimmed.startsWith(prefix)) return false;
  const rest = trimmed.slice(prefix.length);
  return rest.length === 0 || rest.startsWith(" ") || rest.startsWith("(");
}

/**
 * Locate MATCHED fence regions as inclusive `[startIdx, endIdx]` line ranges.
 *
 * An UNMATCHED start fence is NOT a fence: it is left in place along with
 * everything after it. A user comment that happens to look like a start fence
 * (or a start fence whose closing line someone deleted while tidying the file)
 * must never cause the remainder of their config to be deleted — data loss is a
 * far worse failure than leaving a stale AoA block behind, and the legacy
 * per-name strip still cleans the unfenced `[mcp_servers.aoa]` block anyway.
 *
 * Pairing is NEAREST-start-wins: a second start before any end supersedes the
 * first, so at worst we strip the smallest plausible region. The writer only
 * ever emits one matched pair; this only matters for hand-edited files. The
 * cost is deliberate: an orphan start pasted INSIDE AoA's own region strands
 * everything above it in that region permanently (it is never stripped again).
 * The alternative — pairing the FIRST start with the next end — reintroduces
 * the I1 data-loss bug, where an orphan start above user content makes the
 * strip swallow that content. Stranding an AoA block beats deleting a user's.
 *
 * Detection is LINE-BASED and not TOML-string-aware: a fence-looking line that
 * happens to sit inside a multi-line TOML string literal would be treated as a
 * real fence. Contrived (codex's config.toml has no multi-line string keys) —
 * documented, not fixed.
 */
function findFencedRegions(lines: string[]): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let openIdx: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (isFenceLine(trimmed, AOA_MANAGED_FENCE_START_PREFIX)) {
      openIdx = i;
      continue;
    }
    if (openIdx !== null && isFenceLine(trimmed, AOA_MANAGED_FENCE_END_PREFIX)) {
      regions.push([openIdx, i]);
      openIdx = null;
    }
  }
  // openIdx !== null here == unmatched start: intentionally dropped, not stripped.
  return regions;
}

/**
 * Remove every MATCHED fenced AoA-managed region (fence lines inclusive) from
 * existing TOML text, preserving all other content verbatim. Multiple regions
 * are handled (defensive — the writer emits one).
 *
 * SINGLE-WRITER INVARIANT: because this strips ALL fenced regions, there must
 * be exactly ONE function that emits a fence — {@link writeCodexMcpConfigToml}.
 * A second fenced writer would delete the first's region on every run, so the
 * bridge and the external connectors would alternately erase each other. New
 * AoA-owned config belongs in that writer's block list, not in a new fence.
 */
function stripAoaManagedFencedRegions(existing: string): string {
  const lines = existing.split(/\r?\n/);
  const regions = findFencedRegions(lines);
  if (regions.length === 0) return trimTrailingBlankLines(lines).join("\n");

  const dropped = new Set<number>();
  for (const [start, end] of regions) {
    for (let i = start; i <= end; i++) dropped.add(i);
  }
  const kept = lines.filter((_line, idx) => !dropped.has(idx));
  return trimTrailingBlankLines(kept).join("\n");
}

/**
 * Collapse trailing blank lines so re-appended blocks are separated by exactly
 * one blank line each run (idempotent output). Mutates + returns the array.
 */
function trimTrailingBlankLines(lines: string[]): string[] {
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

/**
 * The strippers work in LF internally (they split on `/\r?\n/`). Detect the
 * file's existing convention so a CRLF config.toml — the norm when a Windows
 * user has edited it — is written back as CRLF rather than silently rewritten
 * to LF. A file with no newline at all (or a brand-new file) uses LF.
 */
function detectEol(existing: string): "\r\n" | "\n" {
  return existing.includes("\r\n") ? "\r\n" : "\n";
}

function applyEol(body: string, eol: "\r\n" | "\n"): string {
  return eol === "\n" ? body : body.replace(/\r?\n/g, eol);
}

/**
 * Write `contents` to `target` atomically: write a unique sibling temp file,
 * then `rename` it over the destination. A rename is atomic on both POSIX and
 * NTFS, so a crashed/killed run can never leave a half-written config.toml —
 * a reader sees either the old file or the new one, never a truncated fence.
 * The temp file is always removed on failure.
 *
 * Windows retry: an antivirus/indexer/editor holding a transient handle on the
 * destination makes `rename` fail with EPERM/EACCES/EBUSY. Those are momentary,
 * so retry a few times with a short backoff before surfacing the error.
 *
 * MODE: the temp file is opened 0600 and `rename` REPLACES the destination
 * inode, so config.toml's mode is re-derived from the temp file on every write
 * (a default 0644 open would silently widen it back each run). This file now
 * carries connector configuration and bearer-token env-var NAMES, and its
 * sibling `auth.json` in the same managed home is explicitly 0600. win32
 * ignores the mode argument, matching the `platform !== "win32"` guard used for
 * auth.json.
 */
const TEMP_FILE_SWEEP_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Best-effort removal of orphaned sibling temp files from a crashed/killed
 * earlier write. Post-connectors each orphan is a config file sitting in a
 * credential-bearing directory, so leaving them around is worse than it was.
 * Only files older than {@link TEMP_FILE_SWEEP_MAX_AGE_MS} are touched, so a
 * concurrent in-flight write from another process is never disturbed. Every
 * failure is swallowed — sweeping must not be able to fail a run.
 */
async function sweepStaleTempFiles(target: string): Promise<void> {
  try {
    const dir = path.dirname(target);
    const prefix = `${path.basename(target)}.tmp-`;
    const cutoff = Date.now() - TEMP_FILE_SWEEP_MAX_AGE_MS;
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;
      const candidate = path.join(dir, name);
      const stat = await fs.stat(candidate).catch(() => null);
      if (!stat?.isFile() || stat.mtimeMs > cutoff) continue;
      await fs.rm(candidate, { force: true }).catch(() => {});
    }
  } catch {
    // best-effort only
  }
}

async function writeFileAtomically(target: string, contents: string): Promise<void> {
  await sweepStaleTempFiles(target);
  const tempPath = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }

  const retryableCodes = new Set(["EPERM", "EACCES", "EBUSY"]);
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tempPath, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "";
      if (attempt >= maxAttempts || !retryableCodes.has(code)) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

/** Wrap AoA-owned body text in the ownership fence. */
function fenceAoaManaged(body: string): string {
  return `${AOA_MANAGED_FENCE_START}\n${body}\n${AOA_MANAGED_FENCE_END}`;
}

/**
 * Write/merge `<managedHomeDir>/config.toml` so that codex (run with
 * `CODEX_HOME` pointed at `managedHomeDir`) discovers and spawns the AoA
 * internal-agent MCP bridge.
 *
 * The managed CODEX_HOME is adapter-owned and holds only `auth.json` + this
 * file. To stay safe and idempotent we read any existing `config.toml`, strip
 * every AoA-managed fenced region (plus a legacy unfenced
 * `[mcp_servers.<serverName>]` (+ `.env`) block), preserve everything else
 * verbatim, then append a freshly-rendered, fenced block. `auth.json` is never
 * touched.
 *
 * This is ALSO the writer for EXTERNAL connectors (`options.externalServers`) —
 * deliberately, not as a convenience. See the single-writer invariant note
 * inside. `spec` may be null: a run with connectors but no bridge still writes
 * (and therefore still cleans) the file.
 *
 * `spec` is normally the stdio `CodexMcpBridgeSpec` (command/args/env, with
 * DATABASE_URL inherited into `.env`). U2d-bridge: a brokered (E2B-sandboxed)
 * run passes an HTTP-shaped `McpHttpServerSpec` instead — pointed at the
 * control-plane broker with `authTokenEnvVar` set, so the reserved `aoa`
 * table renders through the exact same `renderExternalMcpBlock` HTTP path
 * used for external connectors below (`url` + `bearer_token_env_var`, NO
 * `command`/`args`/`.env` block, and therefore no DATABASE_URL on disk).
 */
export interface WriteCodexMcpConfigOptions {
  /**
   * EXTERNAL MCP connectors keyed by server name (Plan 2b Task 5). Rendered
   * into the SAME fenced region as the bridge. Reserved names (`aoa`,
   * `playwright`) are filtered here; entries whose transport codex cannot
   * express, or whose name is not a safe TOML bare key, are skipped.
   *
   * Pass an EMPTY object (rather than omitting the field) to mean "this run has
   * no connectors" — the writer then removes every previously-written connector
   * block. Omitting it has the same effect, since the fence strip is
   * unconditional; the distinction only matters at the execute() call site.
   */
  externalServers?: Record<string, McpServerSpec>;
  /** Table name for AoA's own loopback bridge. */
  serverName?: string;
}

export async function writeCodexMcpConfigToml(
  managedHomeDir: string,
  spec: CodexMcpBridgeSpec | McpHttpServerSpec | null | undefined,
  options: WriteCodexMcpConfigOptions = {},
): Promise<McpWriterResult> {
  const serverName = options.serverName ?? "aoa";
  const externalServers = options.externalServers ?? {};
  return withCodexHomeConfigLock(managedHomeDir, async () => {
    await fs.mkdir(managedHomeDir, { recursive: true });
    const target = path.join(managedHomeDir, "config.toml");

    let existing = "";
    try {
      existing = await fs.readFile(target, "utf8");
    } catch {
      existing = "";
    }

    // Two-pass strip:
    //  1. the ownership fence removes EVERYTHING a previous run wrote (incl.
    //     blocks whose names this run knows nothing about), and
    //  2. the legacy per-name pass removes an UNFENCED `[mcp_servers.<name>]`
    //     left by a pre-fence writer, so an existing file upgrades on the first
    //     write instead of ending up with two `aoa` blocks.
    const preserved = stripAoaMcpBlocks(stripAoaManagedFencedRegions(existing), serverName);

    // SINGLE-WRITER INVARIANT (C1): the bridge block and every external
    // connector block are rendered into ONE fenced region by THIS function. Do
    // not add a second function that emits its own fence — the strip above
    // removes ALL fenced regions, so whichever fenced writer ran second would
    // delete the other's region and the two would erase each other run to run.
    const blocks: string[] = [];
    const managedServerNames: string[] = [];
    const skipped: McpWriterSkip[] = [];
    if (spec) {
      // U2d-bridge: a brokered (E2B-sandboxed) run's reserved `aoa` server is
      // HTTP-shaped (points at the control-plane broker, no DATABASE_URL) —
      // the SAME McpServerSpec shape external connectors use below. Render it
      // through the identical renderExternalMcpBlock HTTP path (bearer_token_env_var
      // indirection) rather than hand-rolling a second TOML HTTP emitter.
      // Non-brokered runs pass the plain stdio CodexMcpBridgeSpec and keep
      // hitting the original renderMcpBlock path, byte-identical to before.
      if (isHttpServerSpec(spec)) {
        const rendered = renderExternalMcpBlock(serverName, spec);
        if (rendered.block !== null) {
          blocks.push(rendered.block);
          managedServerNames.push(serverName);
        } else {
          skipped.push({ serverName, reason: rendered.reason });
        }
      } else {
        blocks.push(renderMcpBlock(spec, serverName));
        managedServerNames.push(serverName);
      }
    }
    // M2 (B2N10): `serverName` is CONFIGURABLE, so the hardcoded reserved list
    // alone left a hole — a connector sharing the bridge's actual table name
    // would emit a second `[mcp_servers.<same>]`, and codex (last-wins) would
    // let the connector REPLACE AoA's own loopback bridge. Pass the real name.
    for (const name of reservedMcpServerNameCollisions(externalServers, [serverName])) {
      skipped.push({ serverName: name, reason: "reserved_name" });
    }
    for (const [name, connector] of Object.entries(
      stripReservedMcpServerNames(externalServers, [serverName]),
    )) {
      const rendered = renderExternalMcpBlock(name, connector);
      if (rendered.block === null) {
        skipped.push({ serverName: name, reason: rendered.reason });
        continue;
      }
      blocks.push(rendered.block);
      managedServerNames.push(name);
    }

    // Nothing AoA-owned to write → emit no fence at all (an empty fence pair is
    // just noise). The strip above already removed prior AoA content, so this is
    // still a full cleanup pass.
    const fenced = blocks.length > 0 ? fenceAoaManaged(blocks.join("\n\n")) : "";

    let body: string;
    if (preserved.trim().length > 0) {
      body = fenced ? `${preserved}\n\n${fenced}\n` : `${preserved}\n`;
    } else {
      body = fenced ? `${fenced}\n` : "";
    }

    await writeFileAtomically(target, applyEol(body, detectEol(existing)));
    // codex needs no ownership manifest: its comment FENCE already records
    // exactly which region AoA owns, in the config file itself.
    return { managedServerNames, skipped };
  });
}

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

    await writeFileAtomically(target, applyEol(body, detectEol(existing)));
  });
}

/**
 * Remove a stale top-level `model = ...` line from managed CODEX_HOME while
 * preserving all other config, notably the AoA MCP bridge block. Used by
 * API-key auth mode where the adapter intentionally does not force a
 * subscription-safe chat model.
 */
export async function clearCodexModelConfigToml(
  managedHomeDir: string,
): Promise<void> {
  return withCodexHomeConfigLock(managedHomeDir, async () => {
    const target = path.join(managedHomeDir, "config.toml");
    const existing = await fs.readFile(target, "utf8").catch(() => "");
    if (!existing) return;

    const preserved = stripTopLevelModelLine(existing);
    await writeFileAtomically(
      target,
      applyEol(preserved.trim().length > 0 ? `${preserved}\n` : "", detectEol(existing)),
    );
  });
}
