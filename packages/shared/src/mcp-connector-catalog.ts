import { z } from "zod";

/**
 * Schema for `connectors.json` — a SECOND CDN artifact, deliberately separate
 * from catalog.json.
 *
 * WHY SEPARATE: MarketplaceCatalogFileSchema.parse() rejects the WHOLE array on
 * one unknown `type` enum value, and the sync failure path preserves the previous
 * cache — so publishing a new item type silently freezes the catalog forever on
 * every older instance (server/src/services/aoa-marketplace.ts:107,116). Connectors
 * therefore never touch catalog.json. (Decision #96's `.strip()` covers unknown
 * FIELDS, not unknown ENUM VALUES.)
 *
 * SECRETS (D5): entries carry header/env template KEYS only — never a value, never
 * a placeholder. The founder binds a real secret after install.
 */

const SERVER_NAME_RE = /^[a-z0-9-]+$/;

/**
 * AoA-owned MCP server names that a connector must NEVER claim. `aoa` is the
 * loopback bridge; `playwright` is the browser-use server. Both are re-supplied
 * structurally by AoA and stripped from any incoming connector at adapter merge
 * (`stripReservedMcpServerNames`), so a connector using one installs into a
 * permanently-dead row.
 *
 * CANONICAL DEFINITION LIVES HERE (in `shared`). `@armyofagents/adapter-utils`
 * re-exports it — `adapter-utils` depends on `shared`, never the reverse, so this
 * placement is the only one that lets both the catalog parser (shared) and the
 * adapter merge (adapter-utils) share one source of truth without a workspace
 * dependency cycle.
 */
export const RESERVED_MCP_SERVER_NAMES = ["aoa", "playwright"] as const;

// RFC 7230 §3.2.6 token charset for HTTP header field-names. Deliberately
// excludes `:` and whitespace — those are exactly what would let a "key" smuggle
// a `Name: value` pair (or a whole secret) past this schema and into the
// downstream TOML/JSON header-map writers (Plan 2b's codex `env_http_headers`).
// This keeps the docstring above ("Values never appear here") actually
// enforced, not just documented.
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

// POSIX environment-variable name charset. Deliberately excludes `=` and
// whitespace — those are exactly what would let a "key" smuggle a `NAME=value`
// pair (or a whole secret) past this schema and into downstream env-map
// writers. Same rationale as HEADER_NAME_RE above.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Fail-closed: an entry with no trust block is community, never verified. */
export const McpConnectorTrustSchema = z
  .object({
    tier: z.enum(["verified", "community", "unverified"]).default("community"),
  })
  .default({ tier: "community" });

export const McpConnectorCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    serverName: z.string().regex(SERVER_NAME_RE),
    transport: z.enum(["http", "stdio"]),
    url: z.string().url().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    /**
     * Header NAMES this connector authenticates with. Values never appear here.
     * Constrained to the RFC 7230 token charset (no `:`, no whitespace) so this
     * field cannot smuggle a `Name: value` pair — or a bare credential — through
     * the catalog and into a downstream header-map writer.
     */
    headerTemplateKeys: z.array(z.string().regex(HEADER_NAME_RE)).default([]),
    /**
     * Env var NAMES a stdio server expects. Values never appear here.
     * Constrained to the POSIX env-name charset (no `=`, no whitespace) so this
     * field cannot smuggle a `NAME=value` pair — or a bare credential — through
     * the catalog and into a downstream env-map writer.
     */
    envTemplateKeys: z.array(z.string().regex(ENV_NAME_RE)).default([]),
    requiresSecret: z.boolean().default(false),
    /**
     * OAuth-ONLY remote server (e.g. Notion's hosted `mcp.notion.com`): it rejects
     * a bearer token and demands an interactive browser OAuth flow, so it CANNOT
     * work headlessly under our token model. Such an entry is a VALID catalog entry
     * — it is meant to be SHOWN side by side with a working connector, clearly
     * labelled "needs OAuth" — but is NOT installable until the OAuth broker lands
     * (Plan 4). Downstream (`server/src/routes/mcp-connectors.ts`) projects it as
     * `installable: false` + an `unavailableReason`, mints no consent token, and
     * the install route refuses it. Defaults `false`, so every existing entry is
     * unaffected. (Notion live finding; founder decision — see
     * `docs/aoa/plans/mcp-connectors-followups.md`.)
     */
    requiresOAuth: z.boolean().default(false),
    /**
     * OAuth metadata for requiresOAuth entries. NON-SECRET only (D5: the catalog never
     * carries a credential). Discovery-first providers (Notion) need nothing here; the
     * declared-endpoint fields are reserved for later non-DCR providers (Google/M365).
     * Nested .strip() keeps additive forward-compat; `oauth` is NOT a VALUE_BEARING_ALIAS key.
     */
    oauth: z
      .object({
        scopes: z.array(z.string()).default([]),
        authorizationUrl: z.string().url().optional(),
        tokenUrl: z.string().url().optional(),
        registrationUrl: z.string().url().optional(),
      })
      .strip()
      .optional(),
    secretLabel: z.string().max(200).optional(),
    docsUrl: z.string().url().optional(),
    trust: McpConnectorTrustSchema,
  })
  // FU-22 — `.strip()`, NOT `.strict()`. A purely additive optional field on a
  // newer `connectors.json` (say `iconUrl`) must NOT fail the entry: `.strict()`
  // would drop every entry the moment we publish one, blanking the shelf on every
  // older instance in a self-hosted fleet (the connector-side twin of FU-14).
  // `.strip()` drops the unknown key and validates the known shape — Decision #96's
  // forward-compat mode.
  //
  // The secret-smuggling property SURVIVES this: `.strip()` removes ANY unknown
  // key, so an entry carrying a value-bearing `headerTemplate`/`envTemplate` object
  // (as opposed to the `*Keys` arrays this schema knows) is stripped harmlessly and
  // its values never reach `entryToCreateInput` or a downstream writer. Trust also
  // cannot be self-promoted: a top-level `verified`/`tier`/`trustTier` is stripped,
  // and the real `trust` field stays enum-validated and fail-closed to `community`.
  .strip()
  .superRefine((val, ctx) => {
    // Symmetric with server/src/routes/mcp-connectors.ts's BYO connector schema:
    // each transport requires its own field and forbids the other transport's
    // field, so the two error surfaces read consistently.
    if (val.transport === "http") {
      if (!val.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: "http transport requires url",
        });
      }
      if (val.command !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["command"],
          message: "http transport forbids command",
        });
      }
    } else if (val.transport === "stdio") {
      if (!val.command) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["command"],
          message: "stdio transport requires command",
        });
      }
      if (val.url !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: "stdio transport forbids url",
        });
      }
    }
    // OAuth is a browser sign-in flow against a hosted HTTP server; a stdio
    // connector spawns a local process and has no way to run it. Forbidding the
    // combo here (rather than downstream) eliminates a dead branch where the
    // shelf would show an OAuth stdio entry as installable but createConnector's
    // command-safety gate would 400 it.
    if (val.requiresOAuth && val.transport === "stdio") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresOAuth"],
        message:
          "OAuth connectors must use http transport (OAuth is a browser sign-in flow for a hosted server, not stdio)",
      });
    }
  });

export type McpConnectorCatalogEntry = z.infer<
  typeof McpConnectorCatalogEntrySchema
>;

/**
 * KNOWN-DANGEROUS value-bearing alias keys (Codex Finding 5).
 *
 * The schema is `.strip()` for FU-22 forward-compat, so an unknown key is removed
 * and the entry still validates. That is correct for a GENUINELY-additive field
 * (e.g. a future `iconUrl`): drop the key, keep the entry. But it is WRONG for the
 * value-bearing TWINS of our KEYS-only fields — `headerTemplate` / `envTemplate`
 * (and the obvious `headers` / `env` value maps). Silently stripping those means:
 *   (a) it contradicts the intended "reject an entry that puts a VALUE in a
 *       template field" — the secret value vanishes (good) but the entry survives
 *       carrying no auth it thought it declared (bad, silent), and
 *   (b) an entry that meant to set a header/env value silently loses it.
 *
 * So for THIS closed denylist we drop the whole ENTRY (not just the key). Any key
 * NOT on this list still `.strip()`s harmlessly — FU-22 preserved exactly, so an
 * additive field never re-triggers the fleet-freeze bug.
 *
 * Matched exactly and case-sensitively on the raw item, BEFORE `safeParse` — a
 * `.strip()`ed schema removes these keys before a `.superRefine` could ever see
 * them, so this must be a pre-check here in `parseMcpConnectorCatalog`.
 */
const VALUE_BEARING_ALIAS_KEYS = [
  "headerTemplate",
  "envTemplate",
  "headers",
  "env",
] as const;

/** The label recorded in `dropped` for an item — its `id`, or `<unidentified>`. */
function droppedIdOf(item: unknown): string {
  const id =
    typeof item === "object" && item !== null
      ? (item as { id?: unknown }).id
      : undefined;
  return typeof id === "string" ? id : "<unidentified>";
}

/** True when the raw item carries a known-dangerous value-bearing alias key. */
function hasValueBearingAlias(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  return VALUE_BEARING_ALIAS_KEYS.some((k) =>
    Object.prototype.hasOwnProperty.call(item, k)
  );
}

/**
 * Parse PER ENTRY, dropping bad ones. This is the forward-compat property
 * catalog.json lacks: a future field or entry shape we do not understand costs
 * us that entry, never the whole file.
 *
 * This function never throws, for any input — that guarantee is the entire
 * point of this module, so callers (e.g. P3a-10's fetch+cache layer) can call
 * it directly on an untrusted CDN response body.
 *
 * Return shape: `{ entries, dropped, malformed }`.
 *
 * - `malformed` is `true` when the ENVELOPE itself could not be understood:
 *   `input` is not a non-null object, `entries` is absent, or `entries` is
 *   present but not an array. In this case `entries` and `dropped` are always
 *   `[]` — there was nothing to iterate.
 * - `malformed` is `false` whenever we successfully read an array out of
 *   `entries`, INCLUDING when that array is legitimately empty (`{ entries: [] }`
 *   yields `{ entries: [], dropped: [], malformed: false }`). A legitimately
 *   empty catalog and an unintelligible response are otherwise indistinguishable
 *   from `entries.length === 0` alone, which is exactly the ambiguity a cache
 *   layer must not paper over: `malformed: true` should keep serving the last
 *   known-good cache, while `malformed: false` (even with zero entries) is a
 *   real answer from the CDN and can replace it.
 * - Per-entry validation failures (an item that isn't a well-formed
 *   `McpConnectorCatalogEntry`) never set `malformed` — they are recorded in
 *   `dropped` by `id` (or `"<unidentified>"` when the item isn't an object or
 *   its `id` isn't a string), and parsing continues with the remaining items.
 * - Two further per-entry guards drop-and-record without setting `malformed`:
 *   (Finding 5) an item carrying a KNOWN-DANGEROUS value-bearing alias key
 *   (`headerTemplate`/`envTemplate`/…, see `VALUE_BEARING_ALIAS_KEYS`) is dropped
 *   rather than silently stripped-and-kept; and (Finding 7) a DUPLICATE `id` is
 *   dropped. Dedup is FIRST-WINS: the first entry for an id is kept and every later
 *   collision is recorded in `dropped`. First-wins is chosen because the install
 *   route selects with `entries.find(e => e.id === entryId)` (also first-wins), so
 *   parse and install agree on exactly one entry per id; it defeats the
 *   append-a-duplicate attack (a trailing malicious clone loses to the original),
 *   and — unlike drop-ALL — it preserves availability of the presumably-intended
 *   primary entry when a publish mistake duplicates an id. The same first-wins
 *   rule applies to `serverName`: runtime connector configuration is keyed by
 *   that name, so two different catalog ids must never compete for it.
 */
export function parseMcpConnectorCatalog(input: unknown): {
  entries: McpConnectorCatalogEntry[];
  dropped: string[];
  malformed: boolean;
} {
  const entries: McpConnectorCatalogEntry[] = [];
  const dropped: string[] = [];

  if (typeof input !== "object" || input === null) {
    return { entries, dropped, malformed: true };
  }
  const raw = (input as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) {
    return { entries, dropped, malformed: true };
  }

  const seenIds = new Set<string>();
  const seenServerNames = new Set<string>();
  for (const item of raw) {
    // Finding 5: a known-dangerous value-bearing alias drops the whole entry,
    // BEFORE parsing (a `.strip()`ed schema would silently discard the key and
    // keep the entry). Genuinely-additive unknown fields are NOT on the denylist
    // and still `.strip()` harmlessly inside `safeParse` — FU-22 preserved.
    if (hasValueBearingAlias(item)) {
      dropped.push(droppedIdOf(item));
      continue;
    }
    const parsed = McpConnectorCatalogEntrySchema.safeParse(item);
    if (!parsed.success) {
      dropped.push(droppedIdOf(item));
      continue;
    }
    // P2 (Codex): shelf hygiene — drop a reserved-name entry so it never
    // surfaces on the shelf. NOT the security boundary (createConnector + the
    // delivery-time reserved guard remain that): the adapter merge would strip
    // it anyway, but showing it as installable is a dead-install trap.
    if (
      (RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(
        parsed.data.serverName
      )
    ) {
      dropped.push(parsed.data.id);
      continue;
    }
    // Finding 7: enforce id uniqueness in the returned entries. First-wins, so
    // this agrees with the install route's `entries.find(...)` selection.
    if (seenIds.has(parsed.data.id)) {
      dropped.push(parsed.data.id);
      continue;
    }
    // Runtime delivery keys MCP servers by name. Keeping two catalog identities
    // for one name would make install/retry behavior depend on client-side
    // inference, so reject the later publisher entry at the trust boundary.
    if (seenServerNames.has(parsed.data.serverName)) {
      dropped.push(parsed.data.id);
      continue;
    }
    seenIds.add(parsed.data.id);
    seenServerNames.add(parsed.data.serverName);
    entries.push(parsed.data);
  }
  return { entries, dropped, malformed: false };
}
