import { buildScrubbedCliEnv } from "./cli-spawn-safety.js";

/**
 * PURE merge half, unit-testable with synthetic input.
 *
 * The scrubbed base WINS over connector vars — a connector must never be able
 * to redirect PATH (or any other base entry) and hijack executable resolution
 * for a spawned stdio server. Result is null-prototype: connector-token keys
 * come from envVarNameFor (sanitized) but the base is process.env, so defense
 * in depth against a hostile inherited key.
 */
export function mergeConnectorEnv(
  scrubbedBase: NodeJS.ProcessEnv,
  connectorEnv: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(connectorEnv)) out[k] = v;
  for (const [k, v] of Object.entries(scrubbedBase)) {
    if (v !== undefined) out[k] = v; // base wins
  }
  return out;
}

/**
 * Environment for a CLI that will talk to EXTERNAL MCP servers. Starts from the
 * scrubbed base (denylist + secret-ish heuristics; DATABASE_URL and provider
 * keys removed) and adds ONLY the connector token vars. AoA's own secrets must
 * never reach a third-party server.
 *
 * `buildScrubbedCliEnv` denies-by-exception (AOA_* prefix, an exact infra-cred
 * set, vendor auth keys, and a generic secret/token/password/etc regex) rather
 * than allow-listing, so an empty `keep` still passes through PATH/HOME/APPDATA/
 * TMP/SystemRoot/etc. — verified empirically below and in the test file.
 */
export function buildConnectorProcessEnv(
  connectorEnv: Record<string, string>,
): Record<string, string> {
  return mergeConnectorEnv(buildScrubbedCliEnv([]), connectorEnv);
}

/** The minimal per-row shape {@link buildConnectorEgressHosts} needs — a
 *  structural subset of {@link ResolvedConnectorRow} / the raw
 *  `company_mcp_connectors` DB row, so callers on either side (secrets
 *  resolved or not) can pass rows straight through with no remapping. */
export interface ConnectorEgressHostRow {
  transport: string;
  url?: string | null;
  command?: string | null;
}

/** npm/npx registry host — every stdio connector's launcher (`npx` or `uvx`)
 *  needs SOME package registry; npm covers the `npx` case unconditionally. */
const NPM_REGISTRY_HOST = "registry.npmjs.org";

/** PyPI hosts a `uvx`-launched stdio connector needs to resolve + download its
 *  package (the index host + the actual file-hosting CDN host). */
const PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"] as const;

/**
 * U11 — best-effort VM egress allowlist for a set of connector rows: a
 * de-duplicated, BARE host list (never a scheme, path, or wildcard). NOT a
 * security boundary — `isTransportAllowed`/`isStdioCommandSafe` still
 * independently gate whether a connector is actually delivered; this only
 * widens what the sandbox's (advisory, managed-E2B-best-effort — see U6.2)
 * network policy permits the process to reach, so an admitted stdio
 * connector's `npx`/`uvx` launcher and an http connector's own endpoint are
 * actually reachable from inside the VM.
 *
 * Pure: takes plain rows (no DB, no secret resolution needed — only
 * `transport`/`url`/`command` are read), so both an already-secret-resolved
 * `LoadedConnectorRow[]` and a raw un-resolved DB row array satisfy the input
 * type unmodified.
 *
 * - `http` row: `new URL(row.url).host` — a malformed URL is SKIPPED (never
 *   guessed at, mirrors `buildConnectorSpecs`' skip-not-guess philosophy) and
 *   never throws.
 * - `stdio` row: unconditionally adds the npm registry (both `npx` and `uvx`
 *   resolve packages through npm-shaped registries in this codebase's
 *   pinning grammar — `npx` always; `uvx` ALSO needs PyPI), and additionally
 *   adds the PyPI hosts when the launcher is specifically `uvx`.
 */
export function buildConnectorEgressHosts(rows: readonly ConnectorEgressHostRow[]): string[] {
  const hosts = new Set<string>();
  let needsNpm = false;
  let needsPypi = false;

  for (const row of rows) {
    if (row.transport === "http") {
      if (!row.url) continue;
      try {
        const host = new URL(row.url).host;
        if (host) hosts.add(host);
      } catch {
        // Malformed URL — skip rather than guess (never throws).
      }
    } else if (row.transport === "stdio") {
      needsNpm = true;
      if (row.command === "uvx") needsPypi = true;
    }
  }

  if (needsNpm) hosts.add(NPM_REGISTRY_HOST);
  if (needsPypi) for (const host of PYPI_HOSTS) hosts.add(host);

  return Array.from(hosts);
}
