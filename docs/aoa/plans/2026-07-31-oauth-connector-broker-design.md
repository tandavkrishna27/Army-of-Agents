# OAuth Connector Broker — Design & Scope (v1: Notion-hosted)

- **Status:** Design / scope (approved direction; pre-implementation)
- **Date:** 2026-07-31
- **Target branch:** `feat/connector-security-hardening` (latest MCP-connector code; base feature #301 is on main)
- **Related:** Decision #110 (BYO connectors), D5 (secret placeholder model), D7 (transport gate), `docs/aoa/plans/2026-07-24-mcp-connectors-plan3-marketplace-design.md`, `docs/aoa/plans/mcp-connectors-followups.md`
- **Next step:** a detailed implementation + test plan via the writing-plans skill (this doc is the scope, not the task breakdown)

---

## 1. Summary

Build a **generic OAuth broker** so AoA can use OAuth-only MCP connectors — MCP servers that require a browser sign-in (OAuth 2.1 authorization-code flow) and give no static-token alternative. v1 targets **Notion-hosted** (`https://mcp.notion.com/mcp`), which ships as the **first user-facing OAuth connector**: it appears on the shelf, the founder clicks **Authorize**, completes Notion consent in the browser, the connector goes `active`, and company agents call Notion tools headlessly thereafter (with silent token refresh).

The broker is **discovery-first**: it derives every OAuth endpoint from the connector's URL via the MCP authorization spec (RFC 9728 → RFC 8414 → RFC 7591 dynamic client registration + PKCE), so **no per-provider configuration and no hand-registered app** are needed for spec-compliant providers. Notion is fully compliant (verified — §3.2), making it an ideal proving ground. The catalog schema is shaped so **declared-endpoint overrides** can be added later for non-compliant providers (Google/M365) without a redesign.

---

## 2. Background & problem

MCP connectors split by auth model:

- **No-auth / static-token (stdio or HTTP):** work today. e.g. filesystem, postgres, brave-search, notion-local (`ntn_` token), and the HTTP static-bearer connectors github-hosted + linear.
- **OAuth-only (HTTP):** blocked today. e.g. notion-hosted, sentry-hosted, and the high-value Google Workspace / Microsoft 365 tier (which has **no** static-token path for user data).

Today OAuth connectors are hard-stopped in two places (§3.3): the shelf marks them `installable:false` and the install route throws `OAUTH_UNAVAILABLE_REASON`. This broker replaces those two stops with a real OAuth flow.

**Why now / why generic:** the broker's unique unlock is the Google/M365 tier (no token workaround). We prove the generic machinery against Notion-hosted first (spec-compliant, supports DCR → zero manual setup), then extend to Google/M365 later via declared-endpoint config.

---

## 3. Investigation findings

### 3.1 Runtime already delivers OAuth bearer tokens (header-drop bug does NOT apply)

The top de-risk was Claude Code bug [anthropics/claude-code#50464](https://github.com/anthropics/claude-code/issues/50464) — the `(sdk-cli)` `--print` path (AoA's `claude_local` path) allegedly drops the `Authorization` header on tool calls. **Probed on the installed claude 2.1.126 and it does NOT reproduce:** a mock streamable-HTTP MCP server observed that on the decisive `tools/call` request, **both** a `Authorization: Bearer` header **and** a custom header were **present and correct** — not just on the initial connection. (Probe harness: scratchpad `mcp-header-probe/`; details in memory `claude-mcp-header-delivery-verified`.)

Consequence: an OAuth connector is `http`, and all four CLIs already carry an `http` bearer (claude/gemini/opencode inline, codex via `bearer_token_env_var`). **No per-CLI or `buildConnectorSpecs` change is needed** — the broker only has to ensure a *fresh* access token lands in `row.secretValue`.

### 3.2 Notion-hosted is fully MCP-OAuth-spec-compliant (verified 2026-07-31)

Direct probes of `https://mcp.notion.com`:

- **RFC 9728:** unauthenticated `POST /mcp` → `401` + `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp"`. That metadata: `resource=https://mcp.notion.com/mcp`, `authorization_servers=["https://mcp.notion.com"]`, `scopes_supported=["default"]`, `bearer_methods_supported=["header"]`.
- **RFC 8414** (`/.well-known/oauth-authorization-server`): `authorization_endpoint=/authorize`, `token_endpoint=/token`, **`registration_endpoint=/register`**, `code_challenge_methods_supported=["plain","S256"]`, `grant_types_supported=["authorization_code","refresh_token", ...]`, `response_types_supported=["code"]`, `token_endpoint_auth_methods_supported=["client_secret_basic","client_secret_post","none"]`, `scopes_supported=["default"]`.
- **Conclusion:** DCR (`/register`) + PKCE `S256` + public client (`none`) + auth-code/refresh grants + single `default` scope + bearer-in-header. The generic discovery-first flow works against Notion with **zero manual configuration**.
- **Left as a build-time verify (not assumed):** that `/register` accepts *open* (unauthenticated) DCR and a `http://localhost:<port>` loopback `redirect_uri` (RFC 8252). Not tested here because POSTing to `/register` creates a real client record on Notion.

### 3.3 Existing connector code — integration map (branch `feat/connector-security-hardening`)

- **Connector row:** `company_mcp_connectors` (`packages/db/src/schema/company_mcp_connectors.ts`). D5 model: `headerTemplate`/`envTemplate` hold **`${VAR}` placeholders only**; the real value lives in `company_secrets`, referenced by `secretRef`. Columns include `transport`, `url`, `requiresSecret`, `source`, `trustTier`, `status`. **The table has exactly two writers** (`create`, `update`/`updateIfStatus*` in `services/mcp-connectors-crud.ts`) — an invariant the broker must preserve (see §5.3).
- **Status machine:** `resolveConnectorStatus({deploymentMode, approved, requiresSecret, hasSecret})` (`services/mcp-connector-status.ts:51-68`) → `pending_approval` (governance unmet) | `needs_credentials` (`requiresSecret && !hasSecret`) | `active`. Never returns `active` while a required secret is missing.
- **OAuth hard-stop (what we replace):** catalog flag `requiresOAuth` (`packages/shared/src/mcp-connector-catalog.ts:93`); shelf projection `installable=false` (`routes/mcp-connectors.ts:571-574`); install route `throw badRequest(OAUTH_UNAVAILABLE_REASON)` (`routes/mcp-connectors.ts:698-700`). These three sites are the entire hard-stop.
- **Runtime injection chokepoints:**
  - **Value resolution:** `loadEnabledConnectorRows` (`services/mcp-connectors-loader.ts:~138-160`) resolves `secretRef` → `secretValue` via `secretService.resolveByName`. **This is where refresh-if-expired belongs.**
  - **Value injection:** `buildConnectorSpecs` (`services/mcp-connectors.ts:314-370`) puts `secretValue` into the spawn env and sets `authTokenEnvVar`; the bearer header is then auto-synthesized by `withSynthesizedBearerHeader` (`packages/adapter-utils/src/mcp-server-spec.ts:208-226`). Pure; one production caller (`resolveAgentConnectors`). **Unchanged by this work.**
- **No reusable OAuth infra exists** (no PKCE helper, no auth-code exchanger, no token-refresh). Reusable building blocks: the consent HMAC module (`services/mcp-connector-consent.ts`, `mintConsentToken`/`verifyConsentToken`) for signing the OAuth `state`; the `commander_login_challenges`/`cli_auth_challenges` "persist an in-flight browser challenge with expiry/status" table pattern; `secretService.create`/`rotate`/`resolveByName` (`services/secrets.ts:616/691/464`) for encrypted token storage.

---

## 4. Goals, non-goals, definition of done

**v1 goals**
- Generic discovery-first broker: RFC 9728 discovery → RFC 8414 AS metadata → RFC 7591 DCR → PKCE(S256) authorization-code flow → token store → JIT refresh.
- Ship **notion-hosted** as a real, installable, user-facing OAuth connector.
- Silent access-token refresh at run time; graceful re-authorize when the refresh token dies.
- Company-scoped, founder-authorized token; connector install still subject to the existing board-approval governance in `authenticated` mode.

**Definition of done:** in a live AoA instance, a founder installs notion-hosted from the shelf → clicks Authorize → completes Notion consent → connector is `active` → a crew agent calls a Notion tool headlessly and succeeds → after the access token expires, the next run refreshes silently and still succeeds.

**Non-goals (deferred)**
- Google Workspace / Microsoft 365 (need declared-endpoint config + a hand-registered app; the schema is forward-compatible for it).
- Sentry-hosted.
- Per-user (vs company) tokens.
- A full "connected accounts" management UI (v1 UI is minimal — Authorize button + re-auth prompt).
- Scheduled refresh-ahead (v1 refreshes just-in-time on run).

---

## 5. Design

### 5.1 Approach: discovery-first, forward-compatible with declared-override

The broker prefers discovery (works for Notion and any spec-compliant provider, no config). The catalog `oauth` block carries only hints (`scopes`) for v1, but is shaped to later accept `authorizationUrl`/`tokenUrl`/`clientId` overrides for non-compliant providers (Google). Discovery is attempted first; declared values override discovered ones when present.

### 5.2 The OAuth flow (authorization-code + PKCE, founder-authorized)

```
Founder clicks "Authorize" on a requiresOAuth shelf entry
  POST …/mcp-connectors/oauth/start { entryId }
    → discover: GET connector url (or its /.well-known/oauth-protected-resource) → authorization_servers
              → GET AS /.well-known/oauth-authorization-server → { authorize, token, register, pkce, scopes }
    → DCR: POST /register (public client, redirect_uri = <base>/…/oauth/callback) → client_id
    → PKCE: generate verifier + S256 challenge
    → state: HMAC-signed (mcp-connector-consent), binds { entryId, verifier, client_id, redirect_uri }, short TTL, single-use
    → persist in-flight row (mcp_connector_oauth_flows)
    → return authorize URL (authorization_endpoint?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256&scope&resource=<connector url>)
  Browser → Notion consent → redirect to callback
  GET …/mcp-connectors/oauth/callback?code&state
    → verify state (HMAC + TTL + single-use); load flow row
    → POST /token (authorization_code, code, verifier, client_id, redirect_uri, resource) → { access_token, refresh_token, expires_in }
    → store token bundle as a company_secrets row (secretService.create, or rotate on re-authorize)
    → first install: createConnector(entryId, secretRef=<bundle>)
      re-authorize (existing connector was needs_credentials after a dead refresh token): bind secretRef via updateIfStatus
      [status via resolveConnectorStatus → active / pending_approval (unapproved in authenticated mode) / needs_credentials]
    → redirect browser back to the connector page
```

- **Governance:** the `/oauth/start` route is founder-only (mirrors the founder-only `/credentials` route). In `authenticated` mode the connector install itself is still board-gated by the existing approval flow (`pending_approval` until approved) — OAuth authorization is the credential step, not a bypass of governance.
- **Audience binding (RFC 8707):** `resource=<connector url>` is sent on authorize + token so the access token is audience-bound to Notion's MCP endpoint. Verified headless re-injection works (§3.1).

### 5.3 Data model

- **Token bundle → `company_secrets`** (reuse `secretService.create`/`rotate`, `local_encrypted`). Encrypted `material` holds `{ access_token, refresh_token }`; `providerMetadata` holds `{ token_endpoint, client_id, expires_at, scopes, resource }`. The connector's `secretRef` points at this secret. **No new columns on `company_mcp_connectors`** → the two-writer invariant is preserved; the OAuth-specific metadata lives entirely in the secret.
- **New table `mcp_connector_oauth_flows`** (Drizzle; modeled on `commander_login_challenges`): `id, companyId, entryId, clientId, pkceVerifier, redirectUri, stateHash, status(pending|completed|failed|timeout), startedByUserId, expiresAt, createdAt`. Holds only in-flight state; the browser-facing `state` param is HMAC-signed (not a raw row id).
- **OAuth connector row shape:** `transport=http`, `url=https://mcp.notion.com/mcp`, `headerTemplate={}` (empty — the bearer is synthesized from `authTokenEnvVar` by `withSynthesizedBearerHeader`), `requiresSecret=true`, `secretRef=<bundle>`, `source=catalog`.

### 5.4 Runtime refresh (the one runtime change)

In `loadEnabledConnectorRows`, for OAuth connectors: resolve the token **bundle**; if `expires_at` is within a margin (e.g. 120s), **refresh** via `refresh_token` at `token_endpoint`, `rotate` the secret with the new tokens, then set `row.secretValue = fresh access_token`. Downstream (`buildConnectorSpecs`, all four CLIs) is unchanged.

- **Single-flight:** guard concurrent refreshes (optimistic version check on the secret / short advisory lock) so two simultaneous runs don't both spend the (rotating) refresh token.
- **Refresh failure** (refresh token revoked or past the provider ceiling, e.g. Notion ~ long-lived but finite): do not fail the run hard — flip the connector to `needs_credentials`, emit a `notifications` re-authorize prompt, and let the run proceed without that connector.

### 5.5 Catalog schema extension

Extend `McpConnectorCatalogEntrySchema` with an optional `oauth` object: v1 uses `{ scopes?: string[] }` (Notion needs none beyond discovery's `default`). Reserve `authorizationUrl?`, `tokenUrl?`, `clientId?` for the later declared-override path. Respect the schema's `.strip()` and the `VALUE_BEARING_ALIAS_KEYS` denylist (the `oauth` key must not collide with header/env alias names).

### 5.6 What changes (surface)

| Change | File |
|---|---|
| Shelf: `requiresOAuth` → "Authorize" affordance instead of `installable:false` | `routes/mcp-connectors.ts:571-574` |
| Install: `requiresOAuth` → launch OAuth flow instead of `throw` | `routes/mcp-connectors.ts:698-700` |
| Catalog schema: add optional `oauth` block | `packages/shared/src/mcp-connector-catalog.ts` |
| **New** broker service: discovery, DCR, PKCE, code-exchange, refresh | `services/mcp-connector-oauth.ts` |
| **New** routes: `POST …/oauth/start`, `GET …/oauth/callback` | `routes/mcp-connectors.ts` |
| **New** flow table + migration | `packages/db/src/schema/mcp_connector_oauth_flows.ts` |
| Refresh-if-expired hook | `services/mcp-connectors-loader.ts:~140` |
| Redirect-URI resolver (base URL by deployment mode) | new small helper |

Reuse (no change): consent HMAC (`state`), `secretService` (token store/rotate), `resolveConnectorStatus` + `updateIfStatus` (status), per-CLI writers + `buildConnectorSpecs` (delivery).

### 5.7 Deployment nuance

`redirect_uri` is computed from the deployment base URL: `http://localhost:<port>/…/oauth/callback` (`local_trusted`) or `https://<domain>/…` (`authenticated`/`cloud_auth`). Registered per-flow via DCR. `local_trusted`/localhost is the primary v1 test path; hosted is a follow-on.

---

## 6. Security considerations

- **CSRF / flow fixation:** `state` is HMAC-signed (existing consent module), single-use, short TTL, and bound to `{entryId, verifier, client_id, redirect_uri}`; callback rejects unknown/expired/replayed state.
- **PKCE:** S256 mandatory; verifier never leaves the server; public client (no secret).
- **Open-redirect:** `redirect_uri` is server-computed from the deployment base URL only — never taken from the request; the callback redirects only to the internal connector page.
- **Token at rest:** access + refresh tokens stored only in `company_secrets` (`local_encrypted`); never in the connector row, logs, activity entries (log secret *names* only, per the existing `credentials_bound` pattern), or CLI config files (delivered via spawn env).
- **Audience binding (RFC 8707):** `resource` param binds the token to the connector's MCP endpoint.
- **DCR trust:** register a public client with the minimal redirect set; treat the discovered AS as authoritative only when it is the `authorization_servers` value from the connector's own RFC 9728 metadata (no cross-origin AS smuggling).
- **Governance:** founder-only authorize; install remains board-gated in multi-human deployments.
- **Refresh-token handling:** rotate on refresh; single-flight to avoid races; on revocation, fail closed to `needs_credentials`.

A dedicated security pass (`/cso`, OWASP + STRIDE) is scheduled for the implementation-plan phase.

---

## 7. Testing strategy (high level — detailed TDD plan comes with writing-plans)

- **Unit:** PKCE challenge/verifier; `state` HMAC sign/verify + TTL + single-use; RFC 9728 → 8414 discovery parsing (incl. path-suffixed PRM); DCR request/response; token-exchange + refresh; refresh-failure → `needs_credentials`; redirect-URI resolver per deployment mode.
- **Integration:** full flow against a **mock authorization server** (a local OAuth AS mock, in the spirit of the header-probe mock) — happy path, tampered/expired/replayed state, DCR failure, token-exchange error, refresh-rotation + concurrent single-flight.
- **Live (the proof):** end-to-end against real Notion-hosted on a local instance — install → Authorize → active → crew agent calls a Notion tool → force access-token expiry → confirm silent refresh. Also confirm the two build-time verifies (open DCR, localhost loopback redirect).

---

## 8. Build-time verifications & open questions

1. **Open DCR + loopback redirect** on Notion `/register` (§3.2) — verify early; if `/register` needs an initial access token or rejects `http://localhost`, fall back to a declared client_id in the catalog `oauth` block (already reserved).
2. **Single-flight mechanism** — optimistic secret-version guard vs. a short advisory lock; decide in the impl plan.
3. **Refresh-ahead vs JIT-only** — v1 is JIT; revisit if cold-start refresh latency is noticeable.
4. **notion-local vs notion-hosted naming** — differentiate clearly on the shelf ("Notion (hosted, sign-in)" vs "Notion (local token)") to avoid confusion.

---

## 9. Rollout & follow-ons

1. v1: broker + notion-hosted (this doc).
2. Declared-override path → Google Workspace / Microsoft 365 (hand-registered app, no DCR).
3. Sentry-hosted (once its OAuth/static story is confirmed).
4. Connected-accounts management UI; per-user tokens; scheduled refresh-ahead.

---

## 10. Delivery phases (high level; granular tasks + tests in the implementation plan)

1. **Schema & storage** — catalog `oauth` block; `mcp_connector_oauth_flows` table + migration; token-bundle secret shape.
2. **Broker service** — discovery, DCR, PKCE, authorize-URL, code-exchange, refresh (pure, unit-tested against the mock AS).
3. **Routes & hard-stop replacement** — `/oauth/start` + `/oauth/callback`; shelf + install `requiresOAuth` handling.
4. **Runtime refresh hook** — `loadEnabledConnectorRows` refresh-if-expired + single-flight + fail-to-`needs_credentials`.
5. **UI** — Authorize affordance on the shelf/detail; re-authorize prompt on refresh failure.
6. **Live E2E** — Notion-hosted proof on a local instance; security pass (`/cso`).
