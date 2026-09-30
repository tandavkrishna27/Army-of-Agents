# OAuth Connector Broker — Implementation Plan (v1: Notion-hosted)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let AoA install and use OAuth-only MCP connectors (v1: Notion-hosted) — a founder clicks Authorize, completes browser consent, the connector goes `active`, and agents call it headlessly with silent token refresh.

**Architecture:** Discovery-first OAuth 2.1 + PKCE broker. The connector is installed first (`needs_credentials`), then an OAuth flow (RFC 9728 discovery → RFC 8414 AS metadata → RFC 7591 dynamic client registration → PKCE authorize → code exchange) obtains a token bundle stored in `company_secrets`; a callback binds it via the existing `updateIfStatus` credentials path. At run time, `loadEnabledConnectorRows` refreshes the access token if expired. No per-CLI or `buildConnectorSpecs` changes (the bearer is already delivered — verified by probe).

**Tech Stack:** TypeScript, Express, Drizzle ORM (Postgres), Zod, Vitest 3.2.6 (+ supertest, embedded-postgres for integration), React + TanStack Query (UI). Node's `crypto` for PKCE/HMAC. Outbound `fetch` for OAuth endpoints.

**Base branch/worktree:** `feat/connector-security-hardening` at `C:\Users\TK\.aoa\wt\mcp-connectors`. Spec: `docs/aoa/plans/2026-07-31-oauth-connector-broker-design.md`.

**Review corrections (2026-07-31):** a 4-lens adversarial review against the real code found 13 issues, all folded in: positional `assertTransportAllowed` (was an object literal — wouldn't compile), `logActivity` `actorId` must be a non-null string sentinel, `startedByUserId` FK dropped (board sentinel would 500 the insert in local_trusted), the OAuth `requiresSecret:true` override made an explicit code edit (was prose → "active-with-no-bearer" hole), catalog test fixtures given the required `serverName`, route tests given a capable fake `db` + full mocks, loader test given a CRUD mock + network-free refresh-reject seam, callback flow-claim made **atomic** with try/catch revert (was a replay TOCTOU), `/oauth/start` gated to OAuth-only connectors, DCR client reused on re-auth, and `redirect_uri` fail-closed in multi-human modes.

---

## Locked contract (all tasks use these names verbatim)

**Secret token bundle** — stored as the encrypted `value` string of a `company_secrets` row named `mcp:<serverName>`:

```ts
export const OAUTH_BUNDLE_VERSION = "aoa-oauth-1";
export interface OAuthTokenBundle {
  v: typeof OAUTH_BUNDLE_VERSION;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;          // epoch ms
  tokenEndpoint: string;
  clientId: string;
  scopes: string[];
  resource: string;           // RFC 8707 audience (the connector MCP url)
}
```

**Broker service** (`server/src/services/mcp-connector-oauth.ts`):
```ts
generatePkce(): { verifier: string; challenge: string };                          // S256
signOAuthState(p: OAuthStatePayload): string;                                     // mirrors github-app
verifyOAuthState(token: string, nowMs: number): OAuthStatePayload | null;
discoverOAuthServer(connectorUrl: string, fetchImpl?: typeof fetch): Promise<DiscoveredOAuth>;
registerOAuthClient(registrationEndpoint: string, redirectUri: string, fetchImpl?): Promise<{ clientId: string }>;
buildAuthorizeUrl(p: AuthorizeUrlParams): string;
exchangeAuthorizationCode(p: ExchangeParams, fetchImpl?): Promise<TokenResponse>;
refreshOAuthToken(p: RefreshParams, fetchImpl?): Promise<TokenResponse>;
```
```ts
interface OAuthStatePayload { connectorId: string; companyId: string; nonce: string; exp: number }
interface DiscoveredOAuth { authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string | null; scopesSupported: string[]; codeChallengeMethods: string[] }
interface TokenResponse { accessToken: string; refreshToken: string | null; expiresIn: number }
```

**Bundle codec** (`server/src/services/mcp-connector-oauth-bundle.ts`):
```ts
encodeOAuthBundle(b: OAuthTokenBundle): string;
decodeOAuthBundle(s: string): OAuthTokenBundle | null;   // null if not our bundle
isOAuthBundle(s: string): boolean;
isBundleExpired(b: OAuthTokenBundle, nowMs: number, marginMs?: number): boolean;  // default margin 120_000
```

**New table** `mcp_connector_oauth_flows`. **Routes** `POST /companies/:companyId/mcp-connectors/:id/oauth/start` and `GET /mcp-connectors/oauth/callback`. **Secret name** `mcp:<serverName>`. **State signing secret** = `resolveConsentSecret()` (reused).

---

## Phase 1 — Schema & storage

### Task 1: Catalog schema — optional `oauth` block

**Files:**
- Modify: `packages/shared/src/mcp-connector-catalog.ts:56-147` (add field inside the object, before `.strip()` at :111)
- Test: `packages/shared/src/__tests__/mcp-connector-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the catalog test file:
```ts
import { McpConnectorCatalogEntrySchema } from "../mcp-connector-catalog.js";

describe("oauth block", () => {
  it("accepts an entry with an oauth object of non-secret metadata", () => {
    const parsed = McpConnectorCatalogEntrySchema.parse({
      id: "notion-hosted", serverName: "notion", displayName: "Notion (hosted)", transport: "http",
      url: "https://mcp.notion.com/mcp", requiresOAuth: true,
      oauth: { scopes: ["default"] },
    });
    expect(parsed.oauth?.scopes).toEqual(["default"]);
    expect(parsed.requiresOAuth).toBe(true);
  });

  it("defaults oauth scopes to [] and leaves oauth undefined when absent", () => {
    const parsed = McpConnectorCatalogEntrySchema.parse({
      id: "linear", serverName: "linear", displayName: "Linear", transport: "http", url: "https://x/mcp",
    });
    expect(parsed.oauth).toBeUndefined();
  });

  it("strips unknown keys inside oauth (forward-compat)", () => {
    const parsed = McpConnectorCatalogEntrySchema.parse({
      id: "x", serverName: "x", displayName: "X", transport: "http", url: "https://x/mcp",
      oauth: { scopes: [], somethingNew: 1 },
    });
    expect((parsed.oauth as Record<string, unknown>).somethingNew).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/mcp-connector-catalog.test.ts -t "oauth block"`
Expected: FAIL — `oauth` is stripped (entry-level `.strip()`) so `parsed.oauth` is `undefined` in test 1.

- [ ] **Step 3: Add the field**

In `mcp-connector-catalog.ts`, inside the `z.object({...})` (before the `requiresOAuth` line ~93 is fine), add:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/mcp-connector-catalog.test.ts -t "oauth block"`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**
```bash
git add packages/shared/src/mcp-connector-catalog.ts packages/shared/src/__tests__/mcp-connector-catalog.test.ts
git commit -m "feat(connectors): add optional oauth block to catalog schema"
```

---

### Task 2: `mcp_connector_oauth_flows` table + migration

**Files:**
- Create: `packages/db/src/schema/mcp_connector_oauth_flows.ts`
- Modify: `packages/db/src/schema/index.ts:142` (add barrel export)
- Create (generated): `packages/db/src/migrations/0185_mcp_connector_oauth_flows.sql`

- [ ] **Step 1: Create the schema file**
```ts
import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companyMcpConnectors } from "./company_mcp_connectors.js";

/**
 * In-flight OAuth authorization flows for MCP connectors. Holds ONLY transient state
 * for the browser round-trip (PKCE verifier, discovered endpoints, DCR client id). The
 * `state` column is the anti-CSRF value echoed by the provider on callback; it is ALSO
 * HMAC-signed (see mcp-connector-oauth.ts) so the callback verifies signature THEN looks
 * up the row. No tokens are ever stored here — those go to company_secrets on success.
 */
export const mcpConnectorOauthFlows = pgTable(
  "mcp_connector_oauth_flows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id").notNull().references(() => companyMcpConnectors.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    pkceVerifier: text("pkce_verifier").notNull(),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    authorizationEndpoint: text("authorization_endpoint").notNull(),
    tokenEndpoint: text("token_endpoint").notNull(),
    resource: text("resource").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("pending"), // pending | claimed | completed | failed | expired
    // No FK: the starting actor id may be a board sentinel (e.g. "local-board") with no user row —
    // an FK here would 500 the oauth/start INSERT in local_trusted. The route stores the id only when
    // it's a real UUID (else null), mirroring company_mcp_connectors.createdByUserId (which has no FK).
    startedByUserId: text("started_by_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stateIdx: index("mcp_connector_oauth_flows_state_idx").on(table.state),
    connectorIdx: index("mcp_connector_oauth_flows_connector_idx").on(table.connectorId),
    companyIdx: index("mcp_connector_oauth_flows_company_idx").on(table.companyId),
  }),
);
```

- [ ] **Step 2: Register in the barrel**

In `packages/db/src/schema/index.ts`, after line 142 (`export { companyMcpConnectorAgents } ...`) add:
```ts
export { mcpConnectorOauthFlows } from "./mcp_connector_oauth_flows.js";
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate --name mcp_connector_oauth_flows`
Expected: compiles `packages/db` then emits `packages/db/src/migrations/0185_mcp_connector_oauth_flows.sql` (CREATE TABLE + 3 indexes, FKs `ON DELETE cascade`/`set null`) and appends idx 185 to `meta/_journal.json`. Do NOT hand-edit the SQL.

- [ ] **Step 4: Verify it typechecks and the migration is present**

Run: `pnpm --filter @armyofagents/db typecheck`
Expected: PASS. Confirm `0185_mcp_connector_oauth_flows.sql` exists and contains `CREATE TABLE "mcp_connector_oauth_flows"`.

- [ ] **Step 5: Commit**
```bash
git add packages/db/src/schema/mcp_connector_oauth_flows.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(connectors): add mcp_connector_oauth_flows table + migration 0185"
```

---

### Task 3: OAuth token-bundle codec (pure)

**Files:**
- Create: `server/src/services/mcp-connector-oauth-bundle.ts`
- Test: `server/src/services/__tests__/mcp-connector-oauth-bundle.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from "vitest";
import {
  OAUTH_BUNDLE_VERSION, encodeOAuthBundle, decodeOAuthBundle, isOAuthBundle, isBundleExpired,
  type OAuthTokenBundle,
} from "../mcp-connector-oauth-bundle.js";

const bundle: OAuthTokenBundle = {
  v: OAUTH_BUNDLE_VERSION, accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000,
  tokenEndpoint: "https://as/token", clientId: "cid", scopes: ["default"], resource: "https://mcp/x",
};

describe("oauth bundle codec", () => {
  it("round-trips", () => {
    expect(decodeOAuthBundle(encodeOAuthBundle(bundle))).toEqual(bundle);
  });
  it("decode returns null for a plain token string", () => {
    expect(decodeOAuthBundle("ntn_plain_token")).toBeNull();
    expect(isOAuthBundle("ntn_plain_token")).toBe(false);
  });
  it("decode returns null for JSON without our version tag", () => {
    expect(decodeOAuthBundle(JSON.stringify({ accessToken: "x" }))).toBeNull();
  });
  it("isBundleExpired respects the margin (expiresAt=1_000_000; expired iff now >= expiresAt - margin)", () => {
    expect(isBundleExpired(bundle, 800_000)).toBe(false);          // 200s before expiry, 120s margin -> fresh
    expect(isBundleExpired(bundle, 900_000)).toBe(true);           // 100s before expiry, within 120s margin -> refresh
    expect(isBundleExpired(bundle, 900_000, 60_000)).toBe(false);  // 100s before, 60s margin -> fresh
    expect(isBundleExpired(bundle, 999_000)).toBe(true);           // 1s before expiry -> refresh
    expect(isBundleExpired(bundle, 1_200_000)).toBe(true);         // past expiry -> expired
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth-bundle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**
```ts
export const OAUTH_BUNDLE_VERSION = "aoa-oauth-1" as const;

export interface OAuthTokenBundle {
  v: typeof OAUTH_BUNDLE_VERSION;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  tokenEndpoint: string;
  clientId: string;
  scopes: string[];
  resource: string;
}

export function encodeOAuthBundle(b: OAuthTokenBundle): string {
  return JSON.stringify(b);
}

export function decodeOAuthBundle(s: string): OAuthTokenBundle | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== OAUTH_BUNDLE_VERSION) return null;
  if (typeof o.accessToken !== "string") return null;
  if (typeof o.expiresAt !== "number") return null;
  if (typeof o.tokenEndpoint !== "string" || typeof o.clientId !== "string") return null;
  return {
    v: OAUTH_BUNDLE_VERSION,
    accessToken: o.accessToken,
    refreshToken: typeof o.refreshToken === "string" ? o.refreshToken : null,
    expiresAt: o.expiresAt,
    tokenEndpoint: o.tokenEndpoint,
    clientId: o.clientId,
    scopes: Array.isArray(o.scopes) ? (o.scopes as string[]) : [],
    resource: typeof o.resource === "string" ? o.resource : "",
  };
}

export function isOAuthBundle(s: string): boolean {
  return decodeOAuthBundle(s) !== null;
}

export function isBundleExpired(b: OAuthTokenBundle, nowMs: number, marginMs = 120_000): boolean {
  return nowMs >= b.expiresAt - marginMs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth-bundle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/src/services/mcp-connector-oauth-bundle.ts server/src/services/__tests__/mcp-connector-oauth-bundle.test.ts
git commit -m "feat(connectors): add OAuth token-bundle codec"
```

---

## Phase 2 — Broker service (pure + fetch)

All of Phase 2 lives in `server/src/services/mcp-connector-oauth.ts` and its test `server/src/services/__tests__/mcp-connector-oauth.test.ts`. Each task appends. Every fetch function takes an optional `fetchImpl: typeof fetch = fetch` last param so tests inject a stub (no global patching needed).

### Task 4: PKCE generator

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { generatePkce } from "../mcp-connector-oauth.js";

describe("generatePkce", () => {
  it("produces a URL-safe verifier and a matching S256 challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/); // base64url, no padding
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });
  it("is random per call", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts -t generatePkce`
Expected: FAIL — module/function missing.

- [ ] **Step 3: Implement (create the file; import ONLY what this fn uses)**

Import-as-you-go: create the file importing only `createHash`/`randomBytes`. Later tasks ADD their own imports (Task 5 adds `createHmac`, `timingSafeEqual` to the `node:crypto` import and `import { resolveConsentSecret } from "./mcp-connector-consent.js";`; Task 6/9 add nothing new). This keeps each commit free of dead imports.
```ts
import { createHash, randomBytes } from "node:crypto";

export function generatePkce(): { verifier: string; challenge: string } {
  // 32 random bytes -> 43-char base64url verifier (RFC 7636 §4.1)
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts -t generatePkce`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/src/services/mcp-connector-oauth.ts server/src/services/__tests__/mcp-connector-oauth.test.ts
git commit -m "feat(connectors): PKCE generator for OAuth broker"
```

### Task 5: Signed OAuth `state`

- [ ] **Step 1: Write the failing test**
```ts
import { signOAuthState, verifyOAuthState, type OAuthStatePayload } from "../mcp-connector-oauth.js";

describe("oauth state", () => {
  const base: OAuthStatePayload = { connectorId: "c1", companyId: "co1", nonce: "n", exp: 0 };
  it("round-trips a valid unexpired state", () => {
    const token = signOAuthState({ ...base, exp: 10_000 });
    expect(verifyOAuthState(token, 5_000)).toEqual({ ...base, exp: 10_000 });
  });
  it("rejects an expired state", () => {
    const token = signOAuthState({ ...base, exp: 1_000 });
    expect(verifyOAuthState(token, 2_000)).toBeNull();
  });
  it("rejects a tampered payload (signature mismatch)", () => {
    const token = signOAuthState({ ...base, exp: 10_000 });
    const [payload] = token.split(".");
    expect(verifyOAuthState(`${payload}.deadbeef`, 5_000)).toBeNull();
  });
  it("rejects garbage", () => {
    expect(verifyOAuthState("not-a-token", 0)).toBeNull();
    expect(verifyOAuthState("", 0)).toBeNull();
  });
});
```
(Set `process.env.BETTER_AUTH_SECRET = "test-secret"` in a `beforeAll` in this file if not already set — `resolveConsentSecret` throws without it.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts -t "oauth state"`
Expected: FAIL.

- [ ] **Step 3: Implement (append to the service; mirrors github-app.ts:53-102)**

First extend the imports at the top of `mcp-connector-oauth.ts`: change the crypto import to `import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";` and add `import { resolveConsentSecret } from "./mcp-connector-consent.js";`. Then append:
```ts
export interface OAuthStatePayload {
  connectorId: string;
  companyId: string;
  nonce: string;
  exp: number; // epoch ms
}

export function signOAuthState(p: OAuthStatePayload): string {
  const secret = resolveConsentSecret();
  const encoded = Buffer.from(JSON.stringify(p)).toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyOAuthState(token: string, nowMs: number): OAuthStatePayload | null {
  const secret = resolveConsentSecret();
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || nowMs >= payload.exp) return null;
  if (typeof payload.connectorId !== "string" || typeof payload.companyId !== "string") return null;
  return payload;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts -t "oauth state"`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/src/services/mcp-connector-oauth.ts server/src/services/__tests__/mcp-connector-oauth.test.ts
git commit -m "feat(connectors): signed OAuth state (HMAC, TTL, timing-safe)"
```

### Task 6: Discovery (RFC 9728 → RFC 8414)

- [ ] **Step 1: Write the failing test** (URL-routing fetch stub — see patterns pack §6)
```ts
import { discoverOAuthServer } from "../mcp-connector-oauth.js";

function stubFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url in routes) return new Response(JSON.stringify(routes[url]), { status: 200 });
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
}

describe("discoverOAuthServer", () => {
  const CONN = "https://mcp.notion.com/mcp";
  const f = stubFetch({
    "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp": {
      resource: CONN, authorization_servers: ["https://mcp.notion.com"], scopes_supported: ["default"],
    },
    "https://mcp.notion.com/.well-known/oauth-authorization-server": {
      issuer: "https://mcp.notion.com", authorization_endpoint: "https://mcp.notion.com/authorize",
      token_endpoint: "https://mcp.notion.com/token", registration_endpoint: "https://mcp.notion.com/register",
      code_challenge_methods_supported: ["S256"], scopes_supported: ["default"],
    },
  });

  it("resolves endpoints via PRM then AS metadata", async () => {
    const d = await discoverOAuthServer(CONN, f);
    expect(d.authorizationEndpoint).toBe("https://mcp.notion.com/authorize");
    expect(d.tokenEndpoint).toBe("https://mcp.notion.com/token");
    expect(d.registrationEndpoint).toBe("https://mcp.notion.com/register");
    expect(d.codeChallengeMethods).toContain("S256");
  });

  it("throws a clear error when the AS omits S256", async () => {
    const noPkce = stubFetch({
      "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp": { authorization_servers: ["https://as"] },
      "https://as/.well-known/oauth-authorization-server": {
        authorization_endpoint: "https://as/a", token_endpoint: "https://as/t", code_challenge_methods_supported: ["plain"],
      },
    });
    await expect(discoverOAuthServer(CONN, noPkce)).rejects.toThrow(/S256/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts -t discoverOAuthServer`
Expected: FAIL.

- [ ] **Step 3: Implement (append)**
```ts
export interface DiscoveredOAuth {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopesSupported: string[];
  codeChallengeMethods: string[];
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`OAuth discovery failed: ${url} -> HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function discoverOAuthServer(
  connectorUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredOAuth> {
  const u = new URL(connectorUrl);
  // RFC 9728: protected-resource-metadata is served with the resource path suffixed.
  const prmUrl = `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
  const prm = await fetchJson(prmUrl, fetchImpl);
  const servers = Array.isArray(prm.authorization_servers) ? (prm.authorization_servers as string[]) : [];
  const asBase = servers[0];
  if (!asBase) throw new Error(`OAuth discovery: no authorization_servers at ${prmUrl}`);
  // RFC 8414: AS metadata at the issuer origin.
  const asUrl = `${new URL(asBase).origin}/.well-known/oauth-authorization-server`;
  const md = await fetchJson(asUrl, fetchImpl);
  const authorizationEndpoint = md.authorization_endpoint as string;
  const tokenEndpoint = md.token_endpoint as string;
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error(`OAuth discovery: AS metadata missing endpoints at ${asUrl}`);
  }
  const codeChallengeMethods = Array.isArray(md.code_challenge_methods_supported)
    ? (md.code_challenge_methods_supported as string[])
    : [];
  if (!codeChallengeMethods.includes("S256")) {
    throw new Error(`OAuth discovery: authorization server does not support PKCE S256 (${asUrl})`);
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: (md.registration_endpoint as string) ?? null,
    scopesSupported: Array.isArray(md.scopes_supported) ? (md.scopes_supported as string[]) : [],
    codeChallengeMethods,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts -t discoverOAuthServer`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/src/services/mcp-connector-oauth.ts server/src/services/__tests__/mcp-connector-oauth.test.ts
git commit -m "feat(connectors): OAuth discovery (RFC 9728 -> RFC 8414)"
```

### Task 7: Dynamic client registration (RFC 7591)

- [ ] **Step 1: Write the failing test**
```ts
import { registerOAuthClient } from "../mcp-connector-oauth.js";

describe("registerOAuthClient", () => {
  it("POSTs a public-client registration and returns the client_id", async () => {
    let captured: { url: string; body: unknown } | null = null;
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: input.toString(), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ client_id: "dcr-123" }), { status: 201 });
    }) as typeof fetch;
    const out = await registerOAuthClient("https://as/register", "https://app/cb", f);
    expect(out.clientId).toBe("dcr-123");
    expect(captured!.body).toMatchObject({
      redirect_uris: ["https://app/cb"], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    });
  });
  it("throws on non-2xx", async () => {
    const f = (async () => new Response("no", { status: 400 })) as typeof fetch;
    await expect(registerOAuthClient("https://as/register", "https://app/cb", f)).rejects.toThrow(/registration/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts -t registerOAuthClient`
Expected: FAIL.

- [ ] **Step 3: Implement (append)**
```ts
export async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ clientId: string }> {
  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Army of Agents",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none", // public client (PKCE)
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!res.ok) throw new Error(`OAuth client registration failed: HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const clientId = body.client_id;
  if (typeof clientId !== "string") throw new Error("OAuth client registration: no client_id in response");
  return { clientId };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts -t registerOAuthClient`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/src/services/mcp-connector-oauth.ts server/src/services/__tests__/mcp-connector-oauth.test.ts
git commit -m "feat(connectors): dynamic client registration (RFC 7591)"
```

### Task 8: `buildAuthorizeUrl`

- [ ] **Step 1: Write the failing test**
```ts
import { buildAuthorizeUrl } from "../mcp-connector-oauth.js";

describe("buildAuthorizeUrl", () => {
  it("assembles a spec-correct authorize URL", () => {
    const url = new URL(buildAuthorizeUrl({
      authorizationEndpoint: "https://as/authorize", clientId: "cid", redirectUri: "https://app/cb",
      scopes: ["default"], resource: "https://mcp/x", state: "STATE", codeChallenge: "CHAL",
    }));
    expect(url.origin + url.pathname).toBe("https://as/authorize");
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("cid");
    expect(q.get("redirect_uri")).toBe("https://app/cb");
    expect(q.get("scope")).toBe("default");
    expect(q.get("resource")).toBe("https://mcp/x");
    expect(q.get("state")).toBe("STATE");
    expect(q.get("code_challenge")).toBe("CHAL");
    expect(q.get("code_challenge_method")).toBe("S256");
  });
  it("omits scope when empty", () => {
    const url = new URL(buildAuthorizeUrl({
      authorizationEndpoint: "https://as/a", clientId: "c", redirectUri: "https://app/cb",
      scopes: [], resource: "https://mcp/x", state: "s", codeChallenge: "c",
    }));
    expect(url.searchParams.has("scope")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts -t buildAuthorizeUrl`
Expected: FAIL.

- [ ] **Step 3: Implement (append)**
```ts
export interface AuthorizeUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  state: string;
  codeChallenge: string;
}

export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const url = new URL(p.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  if (p.scopes.length > 0) url.searchParams.set("scope", p.scopes.join(" "));
  url.searchParams.set("resource", p.resource);
  url.searchParams.set("state", p.state);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts -t buildAuthorizeUrl`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/src/services/mcp-connector-oauth.ts server/src/services/__tests__/mcp-connector-oauth.test.ts
git commit -m "feat(connectors): buildAuthorizeUrl"
```

### Task 9: Code exchange + token refresh

- [ ] **Step 1: Write the failing test**
```ts
import { exchangeAuthorizationCode, refreshOAuthToken } from "../mcp-connector-oauth.js";

function tokenStub(assert: (form: URLSearchParams) => void, resp: unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify(resp), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("token endpoint", () => {
  it("exchangeAuthorizationCode posts the PKCE verifier + resource and maps the response", async () => {
    const f = tokenStub((form) => {
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("CODE");
      expect(form.get("code_verifier")).toBe("VER");
      expect(form.get("client_id")).toBe("cid");
      expect(form.get("redirect_uri")).toBe("https://app/cb");
      expect(form.get("resource")).toBe("https://mcp/x");
    }, { access_token: "at", refresh_token: "rt", expires_in: 3600 });
    const out = await exchangeAuthorizationCode({
      tokenEndpoint: "https://as/token", code: "CODE", codeVerifier: "VER", clientId: "cid",
      redirectUri: "https://app/cb", resource: "https://mcp/x",
    }, f);
    expect(out).toEqual({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 });
  });

  it("refreshOAuthToken posts grant_type=refresh_token and keeps the old refresh token if none returned", async () => {
    const f = tokenStub((form) => {
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("OLD");
    }, { access_token: "at2", expires_in: 3600 });
    const out = await refreshOAuthToken({
      tokenEndpoint: "https://as/token", refreshToken: "OLD", clientId: "cid", resource: "https://mcp/x",
    }, f);
    expect(out).toEqual({ accessToken: "at2", refreshToken: null, expiresIn: 3600 });
  });

  it("throws on token error", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    await expect(refreshOAuthToken({ tokenEndpoint: "https://as/token", refreshToken: "x", clientId: "c", resource: "r" }, f))
      .rejects.toThrow(/invalid_grant|token/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts -t "token endpoint"`
Expected: FAIL.

- [ ] **Step 3: Implement (append)**
```ts
export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}
export interface ExchangeParams {
  tokenEndpoint: string; code: string; codeVerifier: string;
  clientId: string; redirectUri: string; resource: string;
}
export interface RefreshParams {
  tokenEndpoint: string; refreshToken: string; clientId: string; resource: string;
}

async function postToken(tokenEndpoint: string, form: URLSearchParams, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const res = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`OAuth token request failed: HTTP ${res.status} ${String(body.error ?? "")}`.trim());
  const accessToken = body.access_token;
  const expiresIn = body.expires_in;
  if (typeof accessToken !== "string" || typeof expiresIn !== "number") {
    throw new Error("OAuth token response missing access_token/expires_in");
  }
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresIn,
  };
}

export function exchangeAuthorizationCode(p: ExchangeParams, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code", code: p.code, code_verifier: p.codeVerifier,
    client_id: p.clientId, redirect_uri: p.redirectUri, resource: p.resource,
  });
  return postToken(p.tokenEndpoint, form, fetchImpl);
}

export function refreshOAuthToken(p: RefreshParams, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "refresh_token", refresh_token: p.refreshToken, client_id: p.clientId, resource: p.resource,
  });
  return postToken(p.tokenEndpoint, form, fetchImpl);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts -t "token endpoint"`
Expected: PASS. Then run the whole broker test file: `pnpm vitest run server/src/services/__tests__/mcp-connector-oauth.test.ts` — all green.

- [ ] **Step 5: Commit**
```bash
git add server/src/services/mcp-connector-oauth.ts server/src/services/__tests__/mcp-connector-oauth.test.ts
git commit -m "feat(connectors): OAuth code exchange + token refresh"
```

---

## Phase 3 — Routes & hard-stop replacement

### Task 10: Let OAuth entries install; expose an authorize signal on the shelf

**Files:**
- Modify: `server/src/routes/mcp-connectors.ts:571-574` (shelf projection) and `:698-700` (install POST guard)
- Test: `server/src/__tests__/mcp-connector-install-route.test.ts` (extend) and the catalog-shelf test

The two `requiresOAuth` hard-stops become: shelf marks the entry installable with an `oauthRequired` flag (no dead-end reason); the install POST allows an OAuth entry to be created `requiresSecret: true` with no secretRef (→ `needs_credentials`), still running the D7 transport gate.

- [ ] **Step 1: Write the failing tests**

In the install-route test, add:
```ts
it("installs an OAuth entry to needs_credentials (not a 400)", async () => {
  // CATALOG must include a requiresOAuth http entry; add one to the test catalog.
  mockConnectorSvc.getByName.mockResolvedValue(null);
  mockConnectorSvc.create.mockImplementation(async (_c: string, input: Record<string, unknown>) => ({ id: "new", ...input }));
  const res = await install(makeApp(founderActor), { entryId: "notion-hosted" });
  expect(res.status).toBe(201);
  expect(mockConnectorSvc.create).toHaveBeenCalledWith(
    "company-A",
    expect.objectContaining({ requiresSecret: true, secretRef: null, status: "needs_credentials", transport: "http" }),
  );
});
```
In the catalog-shelf test (same file family), assert the projected entry:
```ts
it("projects a requiresOAuth entry as installable with oauthRequired", async () => {
  const res = await request(makeApp(founderActor)).get(`/api/companies/company-A/mcp-connectors/catalog`);
  const entry = res.body.entries.find((e: any) => e.id === "notion-hosted");
  expect(entry.installable).toBe(true);
  expect(entry.oauthRequired).toBe(true);
  expect(entry.unavailableReason).toBeUndefined();
});
```
(Ensure the injected test catalog `CATALOG` includes `{ id: "notion-hosted", serverName: "notion", displayName: "Notion (hosted)", transport: "http", url: "https://mcp.notion.com/mcp", requiresOAuth: true, oauth: { scopes: ["default"] }, trust: {...verified...} }` — **`serverName` is required by the schema**; omitting it drops the entry.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/__tests__/mcp-connector-install-route.test.ts -t "OAuth entry"`
Expected: FAIL — currently 400 (`OAUTH_UNAVAILABLE_REASON`) and `installable:false`.

- [ ] **Step 3: Implement — shelf projection (`:571-574`)**

Replace:
```ts
if (entry.requiresOAuth) {
  installable = false;
  unavailableReason = OAUTH_UNAVAILABLE_REASON;
} else {
  // ...D7 + command-safety...
}
```
with (run the same D7 gate for OAuth entries; just add the flag and do NOT set unavailableReason):
```ts
if (entry.requiresOAuth) {
  // Broker handles OAuth entries: installable, with an authorize step post-install.
  oauthRequired = true;
  // D7 gate is POSITIONAL: (transport, deploymentMode, source, trustTier) — matches the real
  // callers at mcp-connectors.ts:576 / :705. `deploymentMode` is already in scope in this
  // projection loop; `entry.trust?.tier` is the correct accessor (trust schema = { tier }).
  // Wrap it like the non-OAuth branch so a D7 refusal degrades THIS card instead of throwing
  // out of entries.map and 500-ing the whole shelf (http/catalog is never refused today).
  try {
    assertTransportAllowed(entry.transport, deploymentMode, "catalog", entry.trust?.tier);
  } catch (err) {
    oauthRequired = false;
    installable = false;
    unavailableReason = err instanceof Error ? err.message : "Not allowed";
  }
} else {
  // ...existing D7 + command-safety...
}
```
Declare `let oauthRequired = false;` next to `let installable = true;` (~:563), and add it to the projected `base` (~:625-630):
```ts
const base = {
  ...entry, installable, consentRequired, oauthRequired,
  ...(unavailableReason ? { unavailableReason } : {}),
};
```
(The `try/catch` shown above mirrors the non-OAuth branch, so a D7 refusal marks that one card `installable=false` rather than throwing out of `entries.map`.)

- [ ] **Step 4a: Implement — install POST (`:698-700`)**

Replace:
```ts
if (entry.requiresOAuth) {
  throw badRequest(OAUTH_UNAVAILABLE_REASON);
}
```
with nothing at that site (delete the block). Then fix the create-input mapping so an OAuth entry is created credential-unbound **and requiring a secret**. The real `entryToCreateInput` is in **`server/src/routes/mcp-connectors.ts:411`** (NOT the shared package — that name appears there only inside a comment). It currently sets `requiresSecret: entry.requiresSecret` (`:453`) and `secretRef: null` (`:452`). Change line 453:
```ts
// server/src/routes/mcp-connectors.ts ~:453
requiresSecret: entry.requiresOAuth || entry.requiresSecret,   // OAuth entries ALWAYS need a credential
secretRef: null,
```
**This is load-bearing.** `requiresSecret` and `requiresOAuth` are INDEPENDENT catalog booleans that both default `false` (`catalog.ts:80,93`). Without the override, a `requiresOAuth` entry with no `requiresSecret` installs `requiresSecret:false` → `resolveConnectorStatus` returns **`active`** with no secret → `buildConnectorSpecs` (`mcp-connectors.ts:327`) only sets `authTokenEnvVar` when `secretValue` is truthy, so `withSynthesizedBearerHeader` emits **no** `Authorization` header → the connector goes live and authenticates as no-one (silent 401 against Notion). Do NOT rely on the producer publishing `requiresSecret:true`. The D7 gate (`assertTransportAllowed`, install `:705`) still runs. With the override, status resolves to `needs_credentials` (local_trusted) or `pending_approval` (authenticated).

- [ ] **Step 4b: Run to verify it passes**

Run: `pnpm vitest run server/src/__tests__/mcp-connector-install-route.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**
```bash
git add server/src/routes/mcp-connectors.ts packages/shared/src/mcp-connector-catalog.ts server/src/__tests__/mcp-connector-install-route.test.ts
git commit -m "feat(connectors): install OAuth entries to needs_credentials; expose oauthRequired on shelf"
```

### Task 11: `POST …/:id/oauth/start`

**Files:**
- Modify: `server/src/routes/mcp-connectors.ts` (add schema near :328-359; add route + a `redirectUriFor` helper)
- Test: `server/src/__tests__/mcp-connector-oauth-route.test.ts` (new)

- [ ] **Step 0 (this file's harness): capable fake `db` + mocks**

The new routes call `db.insert/select/update` directly, so the `{ transaction }`-only fake used by the install/credentials tests is NOT enough (a module-level `vi.mock("@armyofagents/db", …)` does NOT intercept methods on the `db` PASSED INTO `mcpConnectorRoutes(db)`). Build a capable fake db, mock the broker service (no network), and inject a catalog containing the OAuth entry (the route's Fix-11 gate calls `catalog.load()`).
```ts
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

let deploymentMode = "authenticated";
vi.mock("../config.js", () => ({ loadConfig: () => ({ deploymentMode, port: 3100, authPublicBaseUrl: "https://app.test" }) }));

const mockConnectorSvc = vi.hoisted(() => ({ getById: vi.fn(), getByName: vi.fn(), create: vi.fn(), updateIfStatus: vi.fn() }));
const mockSecretSvc = vi.hoisted(() => ({ getByName: vi.fn(), create: vi.fn(), rotate: vi.fn(), resolveByName: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/index.js", () => ({
  mcpConnectorService: () => mockConnectorSvc, secretService: () => mockSecretSvc,
  logActivity: mockLogActivity, approvalService: () => ({ create: vi.fn() }),
}));
const mockGetEffectiveRole = vi.hoisted(() => vi.fn());
vi.mock("../services/permissions.js", () => ({ permissionService: () => ({ getEffectiveRole: mockGetEffectiveRole, isFounder: vi.fn() }) }));
const mockOauth = vi.hoisted(() => ({
  discoverOAuthServer: vi.fn(), registerOAuthClient: vi.fn(), generatePkce: vi.fn(),
  signOAuthState: vi.fn(), buildAuthorizeUrl: vi.fn(), exchangeAuthorizationCode: vi.fn(), verifyOAuthState: vi.fn(),
}));
vi.mock("../services/mcp-connector-oauth.js", () => mockOauth);

import { mcpConnectorRoutes } from "../routes/mcp-connectors.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY = "company-A";
const FOUNDER_UUID = "44444444-4444-4444-8444-444444444444";
const founderActor = { type: "board" as const, source: "session" as const, userId: FOUNDER_UUID, companyIds: [COMPANY], isInstanceAdmin: false };
const CATALOG = [{ id: "notion-hosted", serverName: "notion", displayName: "Notion (hosted)", transport: "http",
  url: "https://mcp.notion.com/mcp", requiresOAuth: true, oauth: { scopes: ["default"] }, trust: { tier: "verified" } }];

// Capture DB writes/reads; the routes call these on the injected db.
const mockFlowInsert = vi.fn();
const mockFlowSelect = vi.fn().mockResolvedValue([]);          // select().from().where().limit()
const mockFlowClaim = vi.fn().mockResolvedValue([{ id: "flow1" }]); // update().set().where().returning()
function fakeDb() {
  // `where()` is awaited for fire-and-forget status flips AND chained to `.returning()` for the
  // atomic claim, so make it BOTH a thenable and expose `.returning()`.
  const whereResult: any = { returning: () => mockFlowClaim(), then: (r: any) => Promise.resolve().then(r), catch: () => Promise.resolve() };
  return {
    transaction: (fn: any) => fn({}),
    insert: () => ({ values: (v: any) => { mockFlowInsert(v); return Promise.resolve(); } }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => mockFlowSelect() }) }) }),
    update: () => ({ set: () => ({ where: () => whereResult }) }),
  } as never;
}
function makeApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", mcpConnectorRoutes(fakeDb(), { catalog: { load: async () => ({ entries: CATALOG, stale: false }) } }));
  app.use(errorHandler);
  return app;
}
beforeEach(() => { vi.clearAllMocks(); mockGetEffectiveRole.mockResolvedValue("founder"); mockFlowSelect.mockResolvedValue([]); mockFlowClaim.mockResolvedValue([{ id: "flow1" }]); });
```

- [ ] **Step 1: Write the failing tests (oauth/start)**
```ts
it("founder start returns an authorizeUrl and inserts a flow row", async () => {
  mockConnectorSvc.getById.mockResolvedValue({ id: "conn1", companyId: COMPANY, serverName: "notion",
    transport: "http", url: "https://mcp.notion.com/mcp", requiresSecret: true, secretRef: null, status: "needs_credentials" });
  mockOauth.discoverOAuthServer.mockResolvedValue({ authorizationEndpoint: "https://as/authorize",
    tokenEndpoint: "https://as/token", registrationEndpoint: "https://as/register", scopesSupported: ["default"], codeChallengeMethods: ["S256"] });
  mockOauth.registerOAuthClient.mockResolvedValue({ clientId: "cid" });
  mockOauth.generatePkce.mockReturnValue({ verifier: "ver", challenge: "chal" });
  mockOauth.signOAuthState.mockReturnValue("STATE");
  mockOauth.buildAuthorizeUrl.mockReturnValue("https://as/authorize?x=1");

  const res = await request(makeApp(founderActor)).post(`/api/companies/${COMPANY}/mcp-connectors/conn1/oauth/start`).send({});
  expect(res.status).toBe(200);
  expect(res.body.authorizeUrl).toBe("https://as/authorize?x=1");
  expect(mockFlowInsert).toHaveBeenCalledWith(expect.objectContaining({ connectorId: "conn1", state: "STATE", clientId: "cid", startedByUserId: FOUNDER_UUID }));
});

it("rejects oauth/start on a non-OAuth connector (Fix 11)", async () => {
  mockConnectorSvc.getById.mockResolvedValue({ id: "conn2", companyId: COMPANY, serverName: "linear",
    transport: "http", url: "https://x/mcp", requiresSecret: true, secretRef: "mcp:linear", status: "active" });
  const res = await request(makeApp(founderActor)).post(`/api/companies/${COMPANY}/mcp-connectors/conn2/oauth/start`).send({});
  expect(res.status).toBe(400);
  expect(mockFlowInsert).not.toHaveBeenCalled();
});

it.each(["team_lead", "team_member"])("%s is forbidden", async (role) => {
  mockGetEffectiveRole.mockResolvedValue(role);
  mockConnectorSvc.getById.mockResolvedValue({ id: "conn1", companyId: COMPANY, serverName: "notion", transport: "http", url: "https://mcp.notion.com/mcp" });
  const res = await request(makeApp(founderActor)).post(`/api/companies/${COMPANY}/mcp-connectors/conn1/oauth/start`).send({});
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/__tests__/mcp-connector-oauth-route.test.ts -t "oauth/start"`
Expected: FAIL — route not defined (404).

- [ ] **Step 3: Implement — add the redirect-uri helper + route**

Near the top of the route file, add the schema:
```ts
export const oauthStartSchema = z.object({}).strict();
```
Add a helper (mirrors `resolveInviteBaseUrl`, access-helpers.ts:452):
```ts
import { resolveInviteBaseUrl } from "./access-helpers.js";
function oauthRedirectUri(req: Request): string {
  const cfg = loadConfig();
  // Fix 13: in multi-human deployments the redirect_uri MUST be the operator-configured origin,
  // never a spoofable Host header. Fail closed rather than derive it from the request.
  if (cfg.deploymentMode !== "local_trusted" && !cfg.authPublicBaseUrl) {
    throw badRequest("Set AOA_AUTH_PUBLIC_BASE_URL before using OAuth connectors in this deployment mode");
  }
  const origin = resolveInviteBaseUrl(req) || `http://127.0.0.1:${cfg.port}`; // local_trusted loopback fallback
  return `${origin.replace(/\/$/, "")}/api/mcp-connectors/oauth/callback`;
}
```
Add the route (founder-only; connector must be an OAuth connector):
```ts
const OAUTH_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

router.post(
  "/companies/:companyId/mcp-connectors/:id/oauth/start",
  validate(oauthStartSchema),
  async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    await assertRole(db, req, companyId, "founder");

    const connector = await mcpConnectorService(db).getById(id);
    if (!connector || connector.companyId !== companyId) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }
    if (connector.transport !== "http" || !connector.url) {
      throw badRequest("OAuth is only available for HTTP connectors");
    }
    // Fix 11: only OAuth connectors may run this flow — otherwise the callback would rotate
    // (overwrite) a static-bearer connector's secret. Resolve the catalog entry by serverName.
    // NB: the in-scope service is `connectorCatalog` (mcp-connectors.ts:477) and its `load`
    // takes the current time (`load(nowMs: number)`) — matches the install POST at :685.
    const { entries: catalogEntries } = await connectorCatalog.load(Date.now());
    const entry = catalogEntries.find((e) => e.serverName === connector.serverName);
    if (!entry?.requiresOAuth) {
      throw badRequest("This connector does not use OAuth sign-in");
    }

    const actor = getActorInfo(req);
    const startedByUserId = OAUTH_UUID_RE.test(actor.actorId) ? actor.actorId : null; // Fix 3: no board sentinel into the id column

    const discovered = await discoverOAuthServer(connector.url);
    if (!discovered.registrationEndpoint) {
      throw badRequest("This connector's authorization server does not support dynamic client registration");
    }
    const redirectUri = oauthRedirectUri(req);

    // Fix 12: on re-authorize the connector already has a stored bundle carrying a DCR clientId —
    // reuse it instead of orphaning a fresh client on the provider. First-auth registers a client.
    const priorBundle = connector.secretRef
      ? decodeOAuthBundle(
          await secretService(db)
            .resolveByName(companyId, connector.secretRef, {
              consumerType: "system", consumerId: "oauth-broker", actorType: "system",
              configPath: `mcp.connector.${connector.serverName}`,
            })
            .catch(() => ""),
        )
      : null;
    const clientId =
      priorBundle?.clientId ??
      (await registerOAuthClient(discovered.registrationEndpoint, redirectUri)).clientId;

    const { verifier, challenge } = generatePkce();
    const nowMs = Date.now();
    const nonce = randomUUID();
    const state = signOAuthState({ connectorId: id, companyId, nonce, exp: nowMs + 10 * 60_000 });
    const resource = connector.url;
    const scopes = discovered.scopesSupported;

    await db.insert(mcpConnectorOauthFlows).values({
      companyId, connectorId: id, state, pkceVerifier: verifier, clientId, redirectUri,
      authorizationEndpoint: discovered.authorizationEndpoint, tokenEndpoint: discovered.tokenEndpoint,
      resource, scopes, status: "pending", startedByUserId,
      expiresAt: new Date(nowMs + 10 * 60_000),
    });

    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: discovered.authorizationEndpoint, clientId, redirectUri,
      scopes, resource, state, codeChallenge: challenge,
    });

    await logActivity(db, {
      companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, // Fix 2: explicit fields, no runId spread / no null
      action: "mcp_connector.oauth_started", entityType: "mcp_connector", entityId: id,
      details: { serverName: connector.serverName },
    });
    res.json({ authorizeUrl });
  },
);
```
Add imports: `import { randomUUID } from "node:crypto";`, the broker fns from `../services/mcp-connector-oauth.js`, `decodeOAuthBundle` from `../services/mcp-connector-oauth-bundle.js`, `mcpConnectorOauthFlows` from `@armyofagents/db`, `loadConfig` from `../config.js`. `secretService`, `getActorInfo`, and `connectorCatalog` (the route-factory catalog service, `mcp-connectors.ts:477`; its `load(nowMs)` takes the current time) are already in scope.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/src/__tests__/mcp-connector-oauth-route.test.ts -t "oauth/start"`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/src/routes/mcp-connectors.ts server/src/__tests__/mcp-connector-oauth-route.test.ts
git commit -m "feat(connectors): POST oauth/start route (discovery + DCR + PKCE + state)"
```

### Task 12: `GET /mcp-connectors/oauth/callback`

**Files:**
- Modify: `server/src/routes/mcp-connectors.ts` (add company-agnostic callback route)
- Test: `server/src/__tests__/mcp-connector-oauth-route.test.ts` (extend)

The callback is a browser redirect target — it authenticates via the signed `state` + flow-row lookup, NOT actor helpers. It exchanges the code, stores the token bundle as `company_secrets` `mcp:<serverName>`, binds `secretRef` via `updateIfStatus`, marks the flow completed, and redirects the browser to the connectors page.

- [ ] **Step 1: Write the failing tests** (same file / the Step-0 harness from Task 11)
```ts
it("callback exchanges the code, stores the secret, binds the connector, redirects", async () => {
  mockOauth.verifyOAuthState.mockReturnValue({ connectorId: "conn1", companyId: "company-A", nonce: "n", exp: Date.now() + 60_000 });
  mockFlowSelect.mockResolvedValue([{ id: "flow1", connectorId: "conn1", companyId: "company-A", status: "pending",
    pkceVerifier: "ver", clientId: "cid", redirectUri: "https://app/cb", tokenEndpoint: "https://as/token",
    resource: "https://mcp.notion.com/mcp", scopes: ["default"], expiresAt: new Date(Date.now() + 60_000) }]);
  mockConnectorSvc.getById.mockResolvedValue({ id: "conn1", companyId: "company-A", serverName: "notion", status: "needs_credentials" });
  mockOauth.exchangeAuthorizationCode.mockResolvedValue({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 });
  mockSecretSvc.getByName.mockResolvedValue(null);
  mockSecretSvc.create.mockResolvedValue({ id: "sec1", name: "mcp:notion" });
  mockConnectorSvc.updateIfStatus.mockResolvedValue({ id: "conn1", status: "active" });

  const res = await request(makeApp(null)) // no actor — browser redirect
    .get(`/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`);
  expect(res.status).toBe(302);
  expect(mockSecretSvc.create).toHaveBeenCalledWith("company-A",
    expect.objectContaining({ name: "mcp:notion", provider: "local_encrypted", managedMode: "aoa_managed" }), expect.anything());
  expect(mockConnectorSvc.updateIfStatus).toHaveBeenCalledWith("conn1", "needs_credentials",
    expect.objectContaining({ secretRef: "mcp:notion", status: "active" }));
});

it("callback rejects an invalid state", async () => {
  mockOauth.verifyOAuthState.mockReturnValue(null);
  const res = await request(makeApp(null)).get(`/api/mcp-connectors/oauth/callback?code=c&state=bad`);
  expect(res.status).toBe(400);
});

it("callback is single-use: a lost atomic claim -> 400, no exchange (Fix 6)", async () => {
  mockOauth.verifyOAuthState.mockReturnValue({ connectorId: "conn1", companyId: "company-A", nonce: "n", exp: Date.now() + 60_000 });
  mockFlowSelect.mockResolvedValue([{ id: "flow1", connectorId: "conn1", companyId: "company-A", status: "pending", expiresAt: new Date(Date.now() + 60_000) }]);
  mockFlowClaim.mockResolvedValue([]); // another concurrent callback already claimed it
  const res = await request(makeApp(null)).get(`/api/mcp-connectors/oauth/callback?code=CODE&state=STATE`);
  expect(res.status).toBe(400);
  expect(mockOauth.exchangeAuthorizationCode).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/__tests__/mcp-connector-oauth-route.test.ts -t callback`
Expected: FAIL — route missing (404).

- [ ] **Step 3: Implement**
```ts
const oauthCallbackQuerySchema = z.object({ code: z.string().min(1), state: z.string().min(1) }).strict();

router.get("/mcp-connectors/oauth/callback", async (req, res) => {
  const parsed = oauthCallbackQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).send("Invalid OAuth callback"); return; }
  const { code, state } = parsed.data;

  const payload = verifyOAuthState(state, Date.now());
  if (!payload) { res.status(400).send("Invalid or expired OAuth state"); return; }

  const flows = await db.select().from(mcpConnectorOauthFlows).where(eq(mcpConnectorOauthFlows.state, state)).limit(1);
  const flow = flows[0];
  if (!flow || flow.connectorId !== payload.connectorId) { res.status(400).send("OAuth flow not found"); return; }
  if (new Date() > new Date(flow.expiresAt)) { res.status(400).send("OAuth flow expired"); return; }

  // Fix 6: atomically CLAIM the flow BEFORE touching the code. Only one concurrent callback can
  // move pending -> claimed, so the state/code is single-use (no replay within the 10-min TTL).
  const claimed = await db
    .update(mcpConnectorOauthFlows)
    .set({ status: "claimed", updatedAt: new Date() })
    .where(and(eq(mcpConnectorOauthFlows.id, flow.id), eq(mcpConnectorOauthFlows.status, "pending")))
    .returning();
  if (claimed.length === 0) { res.status(400).send("OAuth flow already used"); return; }

  const connector = await mcpConnectorService(db).getById(flow.connectorId);
  if (!connector || connector.companyId !== flow.companyId) { res.status(400).send("Connector not found"); return; }

  try {
    const token = await exchangeAuthorizationCode({
      tokenEndpoint: flow.tokenEndpoint, code, codeVerifier: flow.pkceVerifier,
      clientId: flow.clientId, redirectUri: flow.redirectUri, resource: flow.resource,
    });
    const bundle: OAuthTokenBundle = {
      v: OAUTH_BUNDLE_VERSION, accessToken: token.accessToken, refreshToken: token.refreshToken,
      expiresAt: Date.now() + token.expiresIn * 1000, tokenEndpoint: flow.tokenEndpoint,
      clientId: flow.clientId, scopes: flow.scopes, resource: flow.resource,
    };
    const secretName = `mcp:${connector.serverName}`;
    const secrets = secretService(db);
    const existing = await secrets.getByName(flow.companyId, secretName);
    if (existing) {
      await secrets.rotate(existing.id, { value: encodeOAuthBundle(bundle) });
    } else {
      await secrets.create(flow.companyId, {
        name: secretName, provider: "local_encrypted", managedMode: "aoa_managed",
        value: encodeOAuthBundle(bundle),
      }, { userId: flow.startedByUserId ?? null });
    }
    await mcpConnectorService(db).updateIfStatus(connector.id, connector.status, {
      secretRef: secretName,
      status: resolveConnectorStatus({
        deploymentMode: loadConfig().deploymentMode,
        approved: connector.status !== "pending_approval" && connector.status !== "disabled",
        requiresSecret: true, hasSecret: true,
      }),
    });
    await db.update(mcpConnectorOauthFlows)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(mcpConnectorOauthFlows.id, flow.id));
    await logActivity(db, {
      companyId: flow.companyId, actorType: "system", actorId: "oauth-broker", agentId: null, // Fix 2: required non-null string
      action: "mcp_connector.oauth_authorized", entityType: "mcp_connector", entityId: connector.id,
      details: { serverName: connector.serverName, secretRef: secretName },
    });
  } catch (err) {
    // Fix 6: a failed exchange/store must not leave the flow replayable — revert to failed.
    await db.update(mcpConnectorOauthFlows)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(mcpConnectorOauthFlows.id, flow.id))
      .catch(() => {});
    logger.warn({ err, connectorId: connector.id }, "OAuth callback failed");
    res.status(400).send("OAuth authorization failed");
    return;
  }

  const base = resolveInviteBaseUrl(req) || "";
  res.redirect(302, `${base}/marketplace/connectors?authorized=${encodeURIComponent(connector.serverName)}`);
});
```
Add imports as needed: `secretService`, `resolveConnectorStatus`, `encodeOAuthBundle`/`OAUTH_BUNDLE_VERSION`/`OAuthTokenBundle`, `and` + `eq` from `drizzle-orm`, `exchangeAuthorizationCode`, `verifyOAuthState`, and `logger` from `../middleware/logger.js`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/src/__tests__/mcp-connector-oauth-route.test.ts`
Expected: PASS (start + callback).

- [ ] **Step 5: Commit**
```bash
git add server/src/routes/mcp-connectors.ts server/src/__tests__/mcp-connector-oauth-route.test.ts
git commit -m "feat(connectors): GET oauth/callback (exchange, store secret, bind connector)"
```

---

## Phase 4 — Runtime refresh hook

### Task 13: Refresh-if-expired in `loadEnabledConnectorRows`

**Files:**
- Create: `server/src/services/mcp-connector-token-refresh.ts` (the refresh unit — keeps the loader thin + independently testable)
- Modify: `server/src/services/mcp-connectors-loader.ts:133-160` (call the refresh unit)
- Test: `server/src/services/__tests__/mcp-connector-token-refresh.test.ts` (new) + extend the loader test

The refresh unit takes an already-resolved secret string and returns the effective token to inject: for a plain token it's a pass-through; for an OAuth bundle it refreshes when near expiry (rotating the secret), and returns the live access token. On refresh failure it throws a typed error so the loader drops that connector and flips it to `needs_credentials`.

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveConnectorToken, OAuthRefreshError } from "../mcp-connector-token-refresh.js";
import { encodeOAuthBundle, OAUTH_BUNDLE_VERSION, type OAuthTokenBundle } from "../mcp-connector-oauth-bundle.js";

const freshBundle = (over: Partial<OAuthTokenBundle> = {}): OAuthTokenBundle => ({
  v: OAUTH_BUNDLE_VERSION, accessToken: "at", refreshToken: "rt", expiresAt: 10_000_000,
  tokenEndpoint: "https://as/token", clientId: "cid", scopes: ["default"], resource: "https://mcp/x", ...over,
});

describe("resolveConnectorToken", () => {
  const rotate = vi.fn();
  const getByName = vi.fn();
  const refreshOAuthToken = vi.fn();
  const deps = { secrets: { getByName, rotate }, refreshOAuthToken, now: () => 5_000_000 };
  beforeEach(() => { rotate.mockReset(); getByName.mockReset(); refreshOAuthToken.mockReset(); });

  it("passes a plain token through untouched", async () => {
    const out = await resolveConnectorToken(deps as any, "co", "mcp:notion", "ntn_plain");
    expect(out).toBe("ntn_plain");
    expect(refreshOAuthToken).not.toHaveBeenCalled();
  });

  it("returns the access token when the bundle is still fresh", async () => {
    const out = await resolveConnectorToken(deps as any, "co", "mcp:notion", encodeOAuthBundle(freshBundle()));
    expect(out).toBe("at");
    expect(refreshOAuthToken).not.toHaveBeenCalled();
  });

  it("refreshes + rotates when expired, returning the new access token", async () => {
    getByName.mockResolvedValue({ id: "sec1" });
    refreshOAuthToken.mockResolvedValue({ accessToken: "at2", refreshToken: "rt2", expiresIn: 3600 });
    const expired = encodeOAuthBundle(freshBundle({ expiresAt: 5_000_000 })); // now === expiresAt
    const out = await resolveConnectorToken(deps as any, "co", "mcp:notion", expired);
    expect(out).toBe("at2");
    expect(rotate).toHaveBeenCalledWith("sec1", expect.objectContaining({ value: expect.stringContaining("at2") }));
  });

  it("throws OAuthRefreshError when the refresh token is dead", async () => {
    getByName.mockResolvedValue({ id: "sec1" });
    refreshOAuthToken.mockRejectedValue(new Error("HTTP 400 invalid_grant"));
    const expired = encodeOAuthBundle(freshBundle({ expiresAt: 1_000 }));
    await expect(resolveConnectorToken(deps as any, "co", "mcp:notion", expired)).rejects.toBeInstanceOf(OAuthRefreshError);
  });

  it("throws OAuthRefreshError when an expired bundle has no refresh token", async () => {
    const expired = encodeOAuthBundle(freshBundle({ expiresAt: 1_000, refreshToken: null }));
    await expect(resolveConnectorToken(deps as any, "co", "mcp:notion", expired)).rejects.toBeInstanceOf(OAuthRefreshError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-token-refresh.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the refresh unit**
```ts
import { decodeOAuthBundle, encodeOAuthBundle, isBundleExpired, type OAuthTokenBundle } from "./mcp-connector-oauth-bundle.js";
import { refreshOAuthToken as realRefresh } from "./mcp-connector-oauth.js";

export class OAuthRefreshError extends Error {
  constructor(message: string, readonly cause?: unknown) { super(message); this.name = "OAuthRefreshError"; }
}

export interface RefreshDeps {
  secrets: {
    getByName(companyId: string, name: string): Promise<{ id: string } | null>;
    rotate(secretId: string, input: { value: string }): Promise<unknown>;
  };
  refreshOAuthToken?: typeof realRefresh;
  now?: () => number;
}

// In-process single-flight: concurrent runs in this process share one refresh per secret.
const inFlight = new Map<string, Promise<string>>();

export async function resolveConnectorToken(
  deps: RefreshDeps, companyId: string, secretName: string, resolvedValue: string,
): Promise<string> {
  const bundle = decodeOAuthBundle(resolvedValue);
  if (!bundle) return resolvedValue; // plain static token — unchanged

  const now = (deps.now ?? Date.now)();
  if (!isBundleExpired(bundle, now)) return bundle.accessToken;

  const key = `${companyId}:${secretName}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = doRefresh(deps, companyId, secretName, bundle).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function doRefresh(
  deps: RefreshDeps, companyId: string, secretName: string, bundle: OAuthTokenBundle,
): Promise<string> {
  if (!bundle.refreshToken) throw new OAuthRefreshError("OAuth token expired and no refresh token is available");
  const refresh = deps.refreshOAuthToken ?? realRefresh;
  let token;
  try {
    token = await refresh({
      tokenEndpoint: bundle.tokenEndpoint, refreshToken: bundle.refreshToken,
      clientId: bundle.clientId, resource: bundle.resource,
    });
  } catch (err) {
    throw new OAuthRefreshError("OAuth token refresh failed", err);
  }
  const row = await deps.secrets.getByName(companyId, secretName);
  if (!row) throw new OAuthRefreshError("OAuth secret vanished during refresh");
  const next: OAuthTokenBundle = {
    ...bundle, accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? bundle.refreshToken,
    expiresAt: (deps.now ?? Date.now)() + token.expiresIn * 1000,
  };
  await deps.secrets.rotate(row.id, { value: encodeOAuthBundle(next) });
  return next.accessToken;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connector-token-refresh.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the loader + test failure isolation**

In `mcp-connectors-loader.ts`, inside the `if (connector.secretRef)` block (after `resolveByName` succeeds, ~:140-155), transform the value and handle refresh failure by flipping status + dropping the connector:
```ts
      try {
        const raw = await secrets.resolveByName(companyId, connector.secretRef, consumerContextFor(connector.serverName));
        secretValue = await resolveConnectorToken(
          { secrets: { getByName: (c, n) => secrets.getByName(c, n), rotate: (id, i) => secrets.rotate(id, i) } },
          companyId, connector.secretRef, raw,
        );
      } catch (err) {
        if (err instanceof OAuthRefreshError) {
          await mcpConnectorService(db)
            .updateIfStatus(connector.id, "active", { status: "needs_credentials" })
            .catch(() => {});
          logActivity(db, { companyId, actorType: "system", actorId: "oauth-broker", agentId: null, // Fix 2: required non-null string
            action: "mcp_connector.oauth_refresh_failed", entityType: "mcp_connector", entityId: connector.id,
            details: { serverName: connector.serverName } }).catch(() => {});
        }
        logger.warn({ err, companyId, connectorId: connector.id, serverName: connector.serverName },
          "MCP connector skipped: secret could not be resolved/refreshed");
        continue; // failure isolation: drop THIS connector only
      }
```
Also add these imports to the loader: `import { mcpConnectorService } from "./mcp-connectors-crud.js";` and `import { resolveConnectorToken, OAuthRefreshError } from "./mcp-connector-token-refresh.js";` — the loader does NOT currently import `mcpConnectorService` (it lives in `mcp-connectors-crud.ts:84`, not the `./mcp-connectors.js` the loader already imports from).

**Loader test wiring** (`mcp-connectors-loader.test.ts`) — two seams to make explicit, because the existing test mocks only `@armyofagents/db`, `drizzle-orm`, `../secrets.js` (as `{ resolveByName }`), `../../middleware/logger.js`, `../activity-log.js`:
1. Mock the CRUD module so `updateIfStatus` is an observable spy (otherwise the real `db.update` runs against the sequence-mock db, throws, and is swallowed by the `.catch(() => {})`, making the assertion unobservable):
```ts
const updateIfStatus = vi.fn();
vi.mock("../mcp-connectors-crud.js", () => ({ mcpConnectorService: () => ({ updateIfStatus }) }));
```
2. Drive the failure WITHOUT a live network call — return an **expired bundle whose `refreshToken` is `null`**, so `resolveConnectorToken`→`doRefresh` throws `OAuthRefreshError` immediately (no fetch, no `getByName`):
```ts
resolveByName.mockResolvedValue(encodeOAuthBundle({ v: OAUTH_BUNDLE_VERSION, accessToken: "old", refreshToken: null,
  expiresAt: 1, tokenEndpoint: "https://as/token", clientId: "cid", scopes: [], resource: "https://mcp/x" }));
```
Then assert the connector is dropped from the result AND `expect(updateIfStatus).toHaveBeenCalledWith(<id>, "active", { status: "needs_credentials" })`. (Alternative seam: `vi.mock("../mcp-connector-oauth.js", () => ({ refreshOAuthToken: vi.fn().mockRejectedValue(new Error("invalid_grant")) }))` AND extend the `../secrets.js` mock to `{ resolveByName, getByName, rotate }`.)

- [ ] **Step 6: Run the loader tests**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connectors-loader.test.ts`
Expected: PASS (existing + new refresh-failure isolation test).

- [ ] **Step 7: Commit**
```bash
git add server/src/services/mcp-connector-token-refresh.ts server/src/services/mcp-connectors-loader.ts server/src/services/__tests__/mcp-connector-token-refresh.test.ts server/src/services/__tests__/mcp-connectors-loader.test.ts
git commit -m "feat(connectors): JIT OAuth token refresh in the connector loader"
```

> **Follow-up (noted, not v1):** `inFlight` is in-process single-flight only. Multi-process deployments need a DB advisory lock keyed on the secret to avoid two nodes spending the same rotating refresh token. Tracked for the hosted rollout.

---

## Phase 5 — UI

### Task 14: API client + shelf-entry type

**Files:**
- Modify: `ui/src/api/mcpConnectors.ts` (add `oauthStart`; extend `McpConnectorShelfEntry` at :128-140)
- Test: `ui/src/api/__tests__/mcpConnectors.test.ts` (if present; else assert via the component tests in Task 15)

- [ ] **Step 1:** Add to `McpConnectorShelfEntry` (:128-140): `oauthRequired?: boolean;`
- [ ] **Step 2:** Add to `mcpConnectorsApi` (:147-175):
```ts
  oauthStart: (companyId: string, id: string) =>
    api.post<{ authorizeUrl: string }>(`/companies/${companyId}/mcp-connectors/${id}/oauth/start`, {}),
```
- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @armyofagents/ui typecheck` (or the repo's UI typecheck).
Expected: PASS.
- [ ] **Step 4: Commit**
```bash
git add ui/src/api/mcpConnectors.ts
git commit -m "feat(connectors): UI api client oauthStart + oauthRequired shelf field"
```

### Task 15: "Authorize" affordance on the shelf card

**Files:**
- Modify: `ui/src/components/marketplace/connectors/ConnectorShelf.tsx` (`ShelfCard` button block :133-147; add `authorizeMutation` + `onAuthorize` prop wiring in the container :231-322)
- Test: `ui/src/components/marketplace/connectors/__tests__/ConnectorShelf.test.tsx` (or the existing shelf test)

Behavior: for an entry with `oauthRequired` that is not yet installed, render an **"Authorize"** button. Clicking it installs the connector (if needed) then calls `oauthStart` and navigates the browser to `authorizeUrl`.

- [ ] **Step 1: Write the failing test**
```tsx
it("renders Authorize for an oauthRequired entry and navigates to the authorize URL", async () => {
  // mock mcpConnectorsApi.install -> { id: "conn1" }, .oauthStart -> { authorizeUrl: "https://as/authorize" }
  // render <ConnectorShelf/> with a catalog entry { id:"notion-hosted", oauthRequired:true, installable:true, requiresOAuth:true }
  const assign = vi.fn();
  Object.defineProperty(window, "location", { value: { assign, href: "" }, writable: true });
  // ... render, click the button labeled /authorize/i ...
  await waitFor(() => expect(assign).toHaveBeenCalledWith("https://as/authorize"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run ui/src/components/marketplace/connectors/__tests__/ConnectorShelf.test.tsx -t Authorize`
Expected: FAIL — no Authorize button.

- [ ] **Step 3: Implement**

In `ShelfCard` (:133-147), replace the `unavailable ? null` branch so an OAuth entry gets a button:
```tsx
{installed ? (
  <Badge variant="active">Installed</Badge>
) : entry.oauthRequired ? (
  <Button size="sm" onClick={onAuthorize} disabled={busy} aria-label={`Authorize ${entry.displayName}`}>
    {busy ? "…" : "Authorize"}
  </Button>
) : unavailable ? null : (
  <Button size="sm" onClick={onInstall} disabled={busy} aria-label={`Install ${entry.displayName}`}>
    {busy ? "…" : "Install"}
  </Button>
)}
```
Add `onAuthorize?: () => void` to `ShelfCard`'s props and pass it from the container (parallel to `onInstall` at :322). In the container add an `authorizeMutation`:
```tsx
const authorizeMutation = useMutation({
  mutationFn: async (entry: McpConnectorShelfEntry) => {
    // install first if not already installed, then start OAuth
    const installed = installedByEntryId(entry.id); // reuse the existing installed lookup
    const connectorId = installed?.id ?? (await mcpConnectorsApi.install(companyId, { entryId: entry.id })).id;
    const { authorizeUrl } = await mcpConnectorsApi.oauthStart(companyId, connectorId);
    window.location.assign(authorizeUrl);
  },
  onError: (e) => setError(errMsg(e)),
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run ui/src/components/marketplace/connectors/__tests__/ConnectorShelf.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add ui/src/components/marketplace/connectors/ConnectorShelf.tsx ui/src/components/marketplace/connectors/__tests__/ConnectorShelf.test.tsx
git commit -m "feat(connectors): Authorize button on OAuth shelf cards"
```

### Task 16: Re-authorize prompt in the management row

**Files:**
- Modify: `ui/src/components/settings/sections/MCPConnectorsSection.tsx` (`ConnectorRow` :519-762 — add a Re-authorize control next to `DeliverabilityWarning` :674 when `status === "needs_credentials"` and the connector is OAuth)
- Test: `ui/src/components/settings/__tests__/MCPConnectorsSection.test.tsx`

- [ ] **Step 1: Write the failing test** — render a connector with `status: "needs_credentials"` + an OAuth marker; assert a "Re-authorize" button appears and calls `oauthStart` then navigates.
- [ ] **Step 2: Run to verify it fails.** Run: `pnpm vitest run ui/src/components/settings/__tests__/MCPConnectorsSection.test.tsx -t "Re-authorize"` → FAIL.
- [ ] **Step 3: Implement** — in `ConnectorRow`, when `connector.status === "needs_credentials"` and the connector was installed from an OAuth catalog entry (detect via `connector.secretRef?.startsWith("mcp:")` + the catalog `oauthRequired`, or add a small `isOAuth` derivation), render a "Re-authorize" button that calls `mcpConnectorsApi.oauthStart(companyId, connector.id)` and `window.location.assign(authorizeUrl)`. Place it beside `DeliverabilityWarning` (:674).

  > To know whether an installed connector is OAuth without a new DB column, the simplest UI signal is: the connectors list already carries `requiresSecret` + `secretRef`; add `oauthRequired` to the catalog cross-reference the section already loads, OR expose an `authKind` on the connector list DTO. If neither is convenient, gate the button on `requiresSecret && !secretRef` (same as the "Add credential" affordance) and always offer both "Add credential" and "Re-authorize" — acceptable for v1. Pick one and make it explicit in the component.
- [ ] **Step 4: Run to verify it passes.** Run the section test → PASS.
- [ ] **Step 5: Commit**
```bash
git add ui/src/components/settings/sections/MCPConnectorsSection.tsx ui/src/components/settings/__tests__/MCPConnectorsSection.test.tsx
git commit -m "feat(connectors): re-authorize prompt for needs_credentials OAuth connectors"
```

---

## Phase 6 — Integration, live proof, security

### Task 17: OAuth broker integration test (real DB + mock AS)

**Files:**
- Create: `server/src/__tests__/mcp-connector-oauth.integration.test.ts`

Boot embedded Postgres (via `allocateEmbeddedPgPort()` + `initdbFlags: ["--encoding=UTF8","--locale=C"]`), apply migrations (incl. 0185), mount the REAL `mcpConnectorRoutes(db, { catalog })`, and install a URL-routing `globalThis.fetch` mock for the authorization server (`/.well-known/*`, `/register`, `/token`). `describe.skipIf(process.platform === "win32")`.

- [ ] **Step 1: Write the integration test** — drive the real routes end-to-end:
  1. Seed a company + founder (board actor) + the OAuth catalog entry (**must include `serverName: "notion"`** — the callback derives the secret name `mcp:notion` from it; a serverName-less entry is dropped by `parseMcpConnectorCatalog`).
  2. `POST …/install { entryId: "notion-hosted" }` → assert the connector row is `needs_credentials`, `requiresSecret=true`, `secretRef` null.
  3. `POST …/:id/oauth/start` → assert `authorizeUrl` returned + a `mcp_connector_oauth_flows` row exists (`status:"pending"`), and extract the `state` from the DB row.
  4. `GET /api/mcp-connectors/oauth/callback?code=CODE&state=<state>` → assert 302; assert a `company_secrets` row `mcp:notion` exists; assert the connector row is now `active` with `secretRef="mcp:notion"`; assert the flow row is `completed`.
  5. Decrypt-read path: call `loadEnabledConnectorRows(db, { companyId, agentId })` (after opting the connector into an agent) and assert the returned row's `secretValue` equals the mock `access_token` (proves the bundle → access-token extraction).
  6. Refresh path: rewind the stored bundle's `expiresAt` into the past (rotate the secret), set the mock `/token` to return `access_token: "at2"`, call the loader again, assert `secretValue === "at2"` and the secret rotated.
- [ ] **Step 2: Run (Linux, or Windows with the skip removed locally)**

Run: `pnpm vitest run server/src/__tests__/mcp-connector-oauth.integration.test.ts`
Expected: PASS on Linux; collected-and-skipped on Windows CI.
- [ ] **Step 3: Commit**
```bash
git add server/src/__tests__/mcp-connector-oauth.integration.test.ts
git commit -m "test(connectors): OAuth broker integration (real DB + mock AS)"
```

### Task 18: Full-suite gate, live Notion proof, security pass

- [ ] **Step 1: Full local gate.** Run: `pnpm -r typecheck && pnpm test:run && pnpm build`. Expected: all green. Fix any drift.
- [ ] **Step 2: Verify the two build-time assumptions against real Notion** (spec §8). On a running local instance, drive the flow once against `https://mcp.notion.com/mcp`:
  - Confirm `/register` accepts open DCR with a `http://localhost:<port>` redirect. If it 4xx's, add `client_id`/endpoints to the catalog `oauth` block (declared-override path — already reserved) and branch `oauth/start` to skip DCR when declared.
- [ ] **Step 3: Live E2E (the DoD).** On a local instance: install "Notion (hosted)", click Authorize, complete Notion consent, confirm the connector goes `active`; run a crew task that calls a Notion tool and confirm it succeeds; then force `expiresAt` into the past (or wait) and confirm the next run refreshes silently and still succeeds. Capture evidence (screenshots / run logs).
- [ ] **Step 4: Security pass.** Invoke the `/cso` skill (OWASP + STRIDE) focused on: `state` CSRF/replay, open-redirect on the callback `redirect`, token-at-rest (never logged), refresh-token rotation + single-flight, `redirect_uri` server-computed only, DCR client scoping, audience (`resource`) binding. Address findings before merge.
- [ ] **Step 5: Distinguish notion-local vs notion-hosted on the shelf** (spec §8 open item) — display names "Notion (hosted, sign-in)" vs "Notion (local token)". Commit the catalog display-name change (producer repo) or the UI label.

---

## Self-review (completed by the plan author)

- **Spec coverage:** discovery-first ✔ (Task 6/7), PKCE ✔ (4/8/9), state ✔ (5), token store in company_secrets ✔ (12), JIT refresh + fail→needs_credentials ✔ (13), install-then-authorize governance ✔ (10-12), no per-CLI/buildConnectorSpecs change ✔ (none touched), catalog oauth block ✔ (1), new flow table ✔ (2), UI Authorize + re-auth ✔ (15-16), integration + live + security ✔ (17-18). Deployment redirect_uri ✔ (Task 11 `oauthRedirectUri`).
- **Type consistency:** `OAuthTokenBundle`, `TokenResponse`, `DiscoveredOAuth`, `OAuthStatePayload`, service fn names, `mcpConnectorOauthFlows` columns, and the `mcp:<serverName>` secret name are used identically across Tasks 3–17.
- **Placeholder scan:** every code step carries real code; the two intentional judgment calls (UI OAuth-detection signal in Task 16; single-flight scope in Task 13) are called out explicitly with a concrete v1 choice, not left as "TBD".
- **Known deferrals (explicit, not gaps):** cross-process single-flight (Task 13 note); declared-override for non-DCR providers (reserved schema fields, Task 1); notification hub item on refresh failure (Task 13 uses activity log; a hub notification can be layered on the existing notifications service).
- **Adversarial review pass (2026-07-31):** 4 independent reviewers verified every API call, test, edge case, and security property against the real code; 13 findings (6 high, 4 medium, 3 low) folded in — see the "Review corrections" note in the header. The 6 high defects (3 compile errors, 1 unrunnable test suite, 1 active-with-no-bearer hole, 1 replay TOCTOU) are all resolved in the tasks above.
