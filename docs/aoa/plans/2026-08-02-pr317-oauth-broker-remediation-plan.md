<!-- gstack-autoplan restore point: git blob 8498be34db539df793e08bda0e40fa4330dd9d77 -->

# PR #317 OAuth Connector Broker Remediation Plan

**Status:** Local implementation complete — release gates remain; merge blocked
**Date:** 2026-08-03
**Worktree:** `C:\Users\TK\.aoa\wt\mcp-connectors`
**Branch:** `feat/connector-security-hardening`
**Baseline PR HEAD:** `1983ff1c6db395c203f735464f573499320bcac8` (green checks cover only this pre-remediation SHA)
**PR:** [MeteoriteLabs/AoA#317](https://github.com/MeteoriteLabs/AoA/pull/317), base `main`

## Outcome

Land the OAuth connector broker without allowing one tenant to bind another user's provider account, accepting a founder-forged refresh target, overwriting an unrelated secret, or activating an unverified provider integration. Preserve the already-correct PKCE, signed state, company scoping, atomic flow claim, encrypted secret storage, transport policy, and emergency-policy behavior.

The merge gate is not “CI is green.” It is:

1. All merge-blocking findings below are fixed and covered by regression tests.
2. Only the explicitly supported `notion-hosted` catalog entry can enter the OAuth path.
3. A real Notion authorization proves an MCP tool call and a forced-expiry refresh, not only a browser redirect.
4. A fresh independent code review reports no unresolved P0/P1/P2 findings.

## Verified Current State

Verified on 2026-08-03. The GitHub rows below describe the committed baseline only;
they are not evidence for the current uncommitted remediation candidate:

| Area | State | Evidence |
|---|---|---|
| Baseline PR | Open, mergeable, merge state `CLEAN` | PR #317 at HEAD `1983ff1c6` |
| Baseline CI | 8/8 checks green | `changes`, `policy`, `verify`, `e2e`, `migrations`, `e2e-pgvector`, `brand-check`, `ci-required`; none cover the remediation diff |
| Reviews | No human reviews and no inline comments | GitHub review list is empty |
| Codex review | Did not run | Only bot comment says the code-review usage limit was reached |
| Local verification | Typecheck and focused connector suites passed on Windows at reviewed HEAD | Useful review evidence only; the final SHA must run the reproducible commands in this plan |
| Live catalog | Published but not remediation-complete | Marketplace PR #15 merged; 14 entries exist, but Notion copy/scopes and Sentry availability still require a new marketplace PR |
| Local remediation | Uncommitted and unreviewed as a final SHA | 36 tracked files, +3,154/-866, plus new untracked files at the start of this review |
| OAuth entries | `notion-hosted` and `sentry` both declare `requiresOAuth: true` | `aoa-marketplace/content/connectors/*/connector.json` |
| Plan bookkeeping | Stale | The implementation plan keeps all 18 tasks unchecked; the follow-up register contains completed work as open |

The untracked handoff file is user-owned and must be preserved:

`docs/aoa/plans/2026-07-31-oauth-connector-broker-HANDOFF.md`

## Root Causes

| ID | Priority | Root cause | User/security impact |
|---|---:|---|---|
| R1 | P1 | The callback authenticates signed flow state but does not bind completion to the board session that started the flow. | A hostile tenant founder can trick another signed-in user into authorizing the attacker's connector. |
| R2 | P1 | A public JSON discriminator (`v: "aoa-oauth-1"`) is treated as server provenance. | A founder-controlled secret can be parsed as a broker bundle and make refresh POST to an attacker-selected URL. |
| R3 | P1 | Callback secret identity is `mcp:${serverName}` and any existing secret is rotated unconditionally. | OAuth completion can destroy an unrelated static or externally managed credential. |
| R4 | P1 | Installed OAuth identity is reconstructed from mutable `serverName`; the catalog parser only guarantees unique entry IDs. | Catalog drift or duplicate names can authorize the wrong entry or change auth behavior after install. |
| R5 | P1 | Every catalog entry declaring `requiresOAuth` becomes live when this PR merges. | Sentry is activated without the provider-specific proof required by the original design; descriptions become false. |
| R6 | P2 | Secret write, connector bind, flow completion, and activity log are separate commits. | Partial success leaves an orphan/overwritten secret or an active connector paired with a failed flow/audit. |
| R7 | P2 | Callback does not reject a connector that is already `disabled` when loaded; its compare-and-set then legitimately matches `disabled`. | An already-disabled connector can be resurrected. The existing CAS does protect a disable that lands after the read. |
| R8 | P2 | All refresh failures are treated as permanent credential loss. | Timeouts, 429s, and provider 5xx responses unnecessarily demote a working connector to `needs_credentials`. |
| R9 | P2 | Refresh single-flight is process-local. | Horizontally scaled servers can spend the same rotating refresh token twice. |
| R10 | P3 | OAuth flow rows have expiry but no expiry/status cleanup index or sweeper. | The table grows without a retention bound. |
| R11 | P3 | Marketplace success/error state assumes happy-path activation. | Failed OAuth start can leave stale UI, and an approval-pending connector is reported as active. |
| R12 | P2 | Migration `0188` has unguarded FK additions. The migration runner skips only when every statement already exists; a partial state replays the whole file and collides on the first existing FK. | A partially applied migration can remain wedged. |

## Scope and Release Boundaries

### Merge blockers for PR #317

- Session-bind OAuth callback completion in every non-`local_trusted` deployment.
- Persist immutable catalog/OAuth identity on the connector row.
- Restrict the broker to the server-owned provider allowlist, initially `notion-hosted` only.
- Sign broker token bundles and fail closed for OAuth-managed connectors.
- Use a collision-proof, connector-owned OAuth secret name.
- Make callback persistence atomic and reject disabled connectors before any secret mutation.
- Reconcile the published Notion/Sentry catalog copy and behavior.
- Correct the marketplace completion/error UI.
- Run the real Notion tool-call and forced-refresh acceptance test.
- Reconcile the custom discovery-first broker with locked Decision #116, which still names Better Auth `genericOAuth` as the substrate.

### Also required in PR #317 before merge

- Cross-process refresh coordination.
- Transient/permanent refresh error classification with bounded retry behavior.
- Central outbound OAuth URL policy, connection-time DNS/IP enforcement, method-specific redirect rules, timeouts, and response-size caps.
- Expired-flow cleanup.

There is no “merge local-only and remember to fix hosted later” branch in this plan. The
founder explicitly selected the authenticated-ready path on 2026-08-03. These controls
are acceptance gates on the final #317 SHA.

### Cross-repository release boundary

AoA and the marketplace remain separate PRs. The safe order is consumer-first:

1. Test the AoA candidate against a locally generated, exact marketplace artifact.
2. Merge the fail-closed AoA consumer only after final-SHA CI and live Notion proof.
3. Create a fresh marketplace branch/worktree from current `origin/main`; do not reuse
   the stale, already-merged `feat/connectors-catalog` branch.
4. Merge/publish the marketplace producer change and verify the CDN hash/content.
5. Run the post-publish smoke against that exact artifact.

At every intermediate point old AoA builds keep OAuth entries unavailable and the new
consumer accepts only the pinned `notion-hosted` policy.

### Out of scope

- Enabling Sentry OAuth.
- Supporting non-DCR providers or manual client ID/secret overrides.
- Generalizing the broker to arbitrary user-supplied OAuth servers.
- Replacing Better Auth, the secret provider system, connector approval governance, or the catalog distribution mechanism.
- Rewriting already-correct PKCE/state/emergency-policy code.

## Architecture Decisions

### A1. Persist server-owned connector identity

Add the authoritative catalog identity and policy version in the next migration number available after fetching/rebasing `main`:

```sql
ALTER TABLE "company_mcp_connectors"
  ADD COLUMN IF NOT EXISTS "catalog_entry_id" text;

ALTER TABLE "company_mcp_connectors"
  ADD COLUMN IF NOT EXISTS "oauth_policy_version" integer;

CREATE UNIQUE INDEX IF NOT EXISTS "company_mcp_connectors_company_catalog_entry_uq"
  ON "company_mcp_connectors" ("company_id", "catalog_entry_id")
  WHERE "catalog_entry_id" IS NOT NULL;

ALTER TABLE "mcp_connector_oauth_flows"
  ADD COLUMN IF NOT EXISTS "catalog_entry_id" text,
  ADD COLUMN IF NOT EXISTS "oauth_policy_version" integer;

CREATE INDEX IF NOT EXISTS "mcp_connector_oauth_flows_status_expires_idx"
  ON "mcp_connector_oauth_flows" ("status", "expires_at");

CREATE TABLE IF NOT EXISTS "mcp_connector_oauth_refresh_leases" (
  "secret_id" uuid PRIMARY KEY REFERENCES "company_secrets"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "owner_token" uuid NOT NULL,
  "fencing_token" bigint NOT NULL,
  "expected_secret_version" integer NOT NULL,
  "phase" text NOT NULL DEFAULT 'acquired',
  "request_started_at" timestamptz,
  "leased_until" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
```

This SQL documents the generated target shape; implementation still starts in Drizzle schema and uses `pnpm db:generate`.

Contract:

```ts
interface McpConnectorIdentity {
  catalogEntryId: string | null;
  oauthPolicyVersion: number | null;
}
```

- BYO create always writes both fields as `null`.
- Catalog install writes the exact selected `entry.id` to `catalogEntryId`.
- Catalog install writes `oauthPolicyVersion` only for a provider whose complete server policy validates; static catalog connectors keep it `null`.
- Neither field is accepted from create/PATCH/credential request bodies.
- Both fields are insert-only in service types; generic update primitives cannot mutate them.
- `/oauth/start` authorizes from the stored identity plus server policy, never from `serverName` or remote catalog OAuth metadata.
- A missing, removed, changed-to-non-OAuth, or unsupported entry fails with HTTP 409 and does not perform discovery.
- The shared catalog parser rejects duplicate `serverName` values as defense in depth, while unique `id` remains the primary identity rule.
- Duplicate/concurrent install of one catalog entry returns the existing row or a clean HTTP 409 after mapping PostgreSQL 23505; UI retries cannot create a second row.
- `mcp_connector_oauth_flows` stores `catalogEntryId` and `oauthPolicyVersion`; callback compares both against the locked connector and current policy.
- Existing rows have null policy identity. Because the feature is not merged, no production OAuth row is entitled to automatic trust. Any local test row must be reinstalled.

### A2. Provider allowlist is server policy

Create `server/src/services/mcp-connector-oauth-policy.ts` with a server-owned policy map. The remote catalog controls display/distribution, not OAuth authority:

```ts
interface McpOAuthProviderPolicy {
  version: 1;
  entryId: "notion-hosted";
  resourceUrl: "https://mcp.notion.com/mcp";
  issuer: "https://mcp.notion.com";
  authorizationEndpoint: "https://mcp.notion.com/authorize";
  tokenEndpoint: "https://mcp.notion.com/token";
  registrationEndpoint: "https://mcp.notion.com/register";
  scopes: readonly ["default"];
  allowDynamicClientRegistration: true;
}

export const MCP_OAUTH_PROVIDER_POLICIES: ReadonlyMap<string, McpOAuthProviderPolicy>;
export function requireOAuthProviderPolicy(entryId: string, version?: number): McpOAuthProviderPolicy;
```

Use the same helper in:

- catalog shelf projection: unsupported OAuth entries are `installable: false`, `oauthRequired: false`, with a server-provided reason;
- catalog install: require the remote entry ID and resource URL to equal policy; use policy scopes/endpoints, never mutable remote OAuth authority;
- `/oauth/start`: reject unsupported stored identities before network and require discovered issuer/endpoints to equal policy;
- callback transaction: re-check stored identity, flow policy version, and current policy before committing;
- loader/refresh: withhold any OAuth row whose current policy is absent/mismatched before secret resolution or outbound network.

The existing emergency policy remains an independent hard stop. Call `isMcpConnectorBlocked(connector.serverName)` before `/oauth/start` network access, again after state/session validation before callback token exchange, again inside the locked callback transaction, and before delivery/refresh. A denylist change during an in-flight browser flow must prevent exchange/commit with zero new secret versions.

Sentry stays visible but unavailable until a separate provider-specific plan supplies exact scopes, live authorization, tool-call proof, forced refresh proof, and security review.

Server responses expose derived state, not another writable authority bit:

```ts
type OAuthEligibility = "not_oauth" | "supported" | "policy_blocked";

interface McpConnectorOAuthProjection {
  catalogEntryId: string | null;
  oauthPolicyVersion: number | null;
  oauthEligibility: OAuthEligibility;
  oauthUnavailableReason?: string;
}
```

Settings and Marketplace consume this projection. They do not infer OAuth from `serverName` or a fresh catalog lookup.

### A3. Broker bundles require an HMAC

Replace the public-discriminator envelope with version 2:

```ts
interface OAuthTokenBundlePayload {
  companyId: string;
  connectorId: string;
  catalogEntryId: string;
  oauthPolicyVersion: number;
  secretName: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
}

type SignedOAuthTokenBundle = `aoa-oauth-2.${string}.${string}`;
```

- Serialize the strict payload once as UTF-8 JSON, then store `aoa-oauth-2.<base64url(payloadBytes)>.<base64url(mac)>`. Verify the MAC over the received payload bytes before parsing; do not parse and reserialize for verification.
- Derive a dedicated bundle key from the configured root with HKDF-SHA256 label `aoa:mcp-oauth-bundle:v2`; never use the Better Auth/JWT root directly as the MAC key.
- `decodeOAuthBundle(raw, key, expectedContext)` uses `timingSafeEqual` and rejects any company, connector, catalog, policy, or secret-name mismatch.
- Enforce encoded/decoded size caps, strict field types/lengths, finite safe timestamps, HTTPS URLs, and string-only scopes.
- OAuth-managed connectors treat `null` as invalid credentials and fail closed. They never pass the raw value through as a static bearer token.
- Only connectors with a current matching OAuth policy attempt bundle parsing; static connectors never do.
- Reauthorization reuses `clientId` only when the verified bundle's `redirectUri` equals the current computed redirect URI. Otherwise it performs DCR again.
- Signing-key rotation invalidates stored bundles and moves affected connectors to reauthorization; document this operational consequence.

### A4. OAuth secrets are connector-owned

Use `mcp:oauth:${connector.id}` as the broker secret name.

- On first authorization, create only that name with `provider: "local_encrypted"` and `managedMode: "aoa_managed"`.
- Store `providerMetadata: { purpose: "mcp_oauth", ownerConnectorId, catalogEntryId, oauthPolicyVersion }`.
- On reauthorization, rotate only when `connector.secretRef` equals the expected name, metadata matches, and the current value verifies for the exact expected context.
- If the expected name exists but is not the exact bound, valid broker-owned secret, return HTTP 409. Do not rotate or bind anything.
- Generic credential binding and generic secret rotate/rename/delete routes reject `purpose: "mcp_oauth"`; only broker transaction primitives may mutate it. A collision is resolved by deleting/renaming the unrelated colliding secret through the normal secret UI, then retrying; the broker never quarantines it silently.
- Static credentials remain on their current names and are never touched by callback code.

### A5. Callback authorization and atomic commit

Callback order:

1. Parse and verify state.
2. Load the flow and verify connector/company/state/expiry.
3. In non-`local_trusted` mode, require `req.actor.type === "board"`, `req.actor.source === "session"`, and a non-empty `req.actor.userId`; require exact equality with `flow.startedByUserId`, then call `assertCompanyAccess(req, flow.companyId)`. Missing session is 401; wrong user/company is 403.
4. Atomically claim `pending -> claimed`.
5. Load the connector and reject `disabled` before exchanging or writing secrets.
6. Exchange the authorization code outside the database transaction.
7. In one database transaction: re-read and lock/compare connector identity/status/policy; use transaction-scoped local-encrypted secret primitives; bind the secret; mark flow completed; insert the activity row without publishing.
8. After commit, publish the best-effort activity live poke, then redirect. Publishing inside the transaction is forbidden. The durable activity row and UI refetch are authoritative; because the current live-event bus is in-memory, a publish failure is logged and dropped, not falsely promised a durable retry, and does not rewrite the committed OAuth result to failed.

`/oauth/start` has the matching starter contract: outside `local_trusted`, only a real board session may start OAuth, and it stores the exact text `req.actor.userId` without UUID-shape inference. API-key/no-session actors are rejected before discovery. `null` is reserved for the synthetic local operator.

The secret transaction API must be explicit. Add local-encrypted prepare/commit primitives in `server/src/services/secrets.ts` (or a narrowly scoped broker-secret service): prepare encrypted version material before the outer DB transaction, then insert/update `company_secrets` and `company_secret_versions` using the caller's transaction. It must not call the existing nested `create`/`rotate` transactions. Add an activity-log primitive that inserts with the caller's transaction and returns the event payload for post-commit publication.

Allowed connector status transitions inside the transaction:

| Current status | Result after valid token | Allowed |
|---|---|---:|
| `needs_credentials` | `active` in `local_trusted`; governed result in authenticated mode | Yes |
| `pending_approval` | remains `pending_approval` | Yes |
| `active` | remains `active` during reauthorization | Yes |
| `disabled` | no mutation, flow fails | No |

Any transaction failure rolls back secret, connector, flow-completion, and audit writes together. The outer catch may mark a still-claimed flow `failed` in a separate best-effort update, but it must not report authorization success or publish a live success event.

After verified state, callback redirects use immutable IDs: `/marketplace/connectors?oauthResult=completed&connectorId=<uuid>` or `oauthResult=failed&connectorId=<uuid>&reason=<stable-code>`. Invalid/unverifiable state remains a plain 400. The UI refetches the current company's list and renders the persisted connector status; if the ID is not in the selected company, it shows a neutral “authorization completed for another company” prompt without leaking names/status.

```ts
type OAuthCallbackFailureReason =
  | "access_denied"
  | "provider_error"
  | "token_exchange_failed"
  | "secret_collision"
  | "connector_changed"
  | "policy_blocked";
```

Accept either `code + state` or `error + state`. For provider `error` callbacks,
validate state/session/company first, atomically claim and terminalize the flow as
failed, perform no token exchange, and never echo provider `error_description`.
Map explicit provider denial to `access_denied`, other provider callbacks to
`provider_error`, token/DCR failures to `token_exchange_failed`, owned-secret
mismatch to `secret_collision`, disabled/status/identity races to
`connector_changed`, and provider/emergency policy failure to `policy_blocked`.

### A6. Refresh behavior

Define explicit outcomes:

```ts
type OAuthRefreshFailureKind =
  | "permanent"   // invalid_grant, invalid_client, missing refresh token, invalid signed bundle
  | "transient"   // timeout, network failure, 429, 5xx
  | "policy";     // blocked URL/redirect/response cap
```

- Permanent failures demote to `needs_credentials` and log one credential-expired activity.
- Transient failures skip the connector for the current run, retain its status, and log/metric a retryable failure without exposing tokens.
- Policy failures withhold delivery/refresh while retaining status and expose an explicit `oauth_policy_blocked` health/activity reason. Reauthorization is not offered because credentials cannot repair policy.
- Successful refresh writes token-safe `mcp_connector.oauth_refreshed` activity with connector ID, old secret version, and new secret version only; never endpoints or token material.
- Before resolving a secret or making a request, loader/refresh validates stored
  identity, expected broker secret name, current provider policy, emergency policy,
  and every signed bundle authority field (issuer, token endpoint, resource, scopes,
  redirect URI) against that policy. The request uses current policy endpoints, not
  stale bundle endpoints.
- Keep in-process single-flight.
- Add `mcp_connector_oauth_refresh_leases`, keyed by immutable `secret_id`, with `owner_token`, monotonic `fencing_token`, `expected_secret_version`, and `leased_until`.
- Acquire by insert-or-conditional-update only when absent/expired, using a 20-second lease (longer than the 10-second outbound timeout). The owner records the current secret version and `phase: acquired`.
- Heartbeat every 5 seconds while working, extending the lease only when owner/fence/version still match. Abort before provider I/O or commit if renewal/ownership fails.
- Immediately before the provider call, recheck owner/fence/lease/version and persist `phase: request_started` plus `request_started_at`.
- Contenders poll with 100-250 ms jitter, reload the latest signed bundle, and reuse a newly rotated access token; after 12 seconds they retry lease acquisition. They never call the provider while another live lease exists.
- Expired takeover is automatic only from `phase: acquired`. If an expired lease is `request_started` with no committed secret-version advance, the external result is indeterminate: do not spend the old rotating refresh token again; fail closed to reauthorization and log a non-secret recovery reason.
- Only the live lease owner may rotate from `expected_secret_version`; commit rechecks owner/fence/lease/version. Release is best-effort after commit.
- Test with two independent DB connections/process-equivalent workers; two promises sharing the in-process map do not satisfy the acceptance criterion.

### A7. Outbound OAuth policy

All discovery, authorization-server metadata, DCR, token exchange, and refresh requests use one helper with:

- HTTPS only; no URL credentials;
- a `node:https` request/lookup boundary that resolves and rejects every A/AAAA result in loopback, link-local, private, multicast, reserved, and IPv4-mapped-IPv6 ranges, and pins the socket to the validated address so there is no resolve-then-fetch DNS-rebinding window;
- metadata GET redirects only, maximum 3, validating and connection-pinning each target against the provider policy;
- zero redirects for DCR, authorization-code exchange, and refresh; never forward a credential-bearing body or Authorization header across origins;
- authorization endpoint validation against the provider policy before returning it to the browser;
- 10-second request timeout;
- 1 MiB streamed response-body cap that aborts before buffering beyond the limit;
- provider-neutral errors that never include tokens or authorization codes.

Bundle signing removes tenant control of refresh endpoints. The egress helper closes provider-metadata redirect and future-provider risks before merge.

## Execution Plan

### Phase 0: Freeze the release surface

- [ ] Do not merge PR #317 while merge blockers remain.
- [x] Add the `notion-hosted`-only policy and make Sentry unavailable in both shelf projection and server install/start gates.
- [x] Add regression tests proving an unsupported or emergency-denied OAuth entry cannot be installed, started, completed, delivered, or refreshed, including denylist activation during an in-flight flow, with zero outbound network.

### Phase 1: Identity, callback binding, and secret provenance

- [x] Fetch/rebase `main`, add `catalogEntryId`/`oauthPolicyVersion`, flow identity fields, the partial unique index, and the refresh-lease table in Drizzle schema.
- [x] Generate the next available migration with `pnpm db:generate`; do not hand-author it. Apply only repository-required post-generation idempotency guards enforced by `migration-idempotency.test.ts`, and include generated journal/snapshot changes.
- [x] Thread the fields through DB exports, CRUD/service return types, UI API types, catalog install, and tests.
- [x] Remove the live remote-catalog dependency from `/oauth/start`; authorize from
  persisted `catalogEntryId`/`oauthPolicyVersion` plus server policy after install.
- [x] Reject duplicate catalog `serverName` values.
- [x] Store the exact non-empty `req.actor.userId` text outside `local_trusted`;
  remove UUID-shape inference. Return 401 for a missing browser session and 403 for
  a different user/company, before claim/network/write.
- [x] Introduce signed v2 bundles and connector-owned secret names.
- [x] Prohibit generic credential/secret mutation routes from changing broker-owned secrets; reauthorization must use the broker.
- [x] Reuse a prior DCR client only when the verified bundle `redirectUri` exactly
  equals the newly computed callback URI; otherwise register a new client.

### Phase 2: Atomicity and state transitions

- [x] Re-read/lock the connector inside the commit transaction and recheck status,
  immutable identity, provider policy, and emergency denylist before secret mutation.
- [x] Make post-commit activity publication truly best-effort for callback and
  refresh: listener exceptions are logged/dropped and cannot turn durable success
  into a failed redirect/result or strand a refresh lease.
- [x] Commit secret mutation, connector binding, flow completion, and activity row in one transaction.
- [ ] Add real-PostgreSQL failure/race tests for already-disabled,
  disable-after-read, policy/denylist change during exchange, approval, duplicate
  callback, secret collision, and failure at secret commit, bind, flow completion,
  activity insert, and post-commit publish. The route fake is ordering evidence only.
- [x] Wrap both `0188` FK additions in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` guards, matching the repository's guarded-constraint convention.
- [ ] Run repository migration-idempotency tests plus integration tests that replay `0188` and the new generated migration twice and from partial states. The static idempotency suite passes on Windows; the real-PostgreSQL replay remains Linux-CI evidence.

### Phase 3: Refresh and egress hardening

- [x] Add the central outbound OAuth request policy.
- [x] Add permanent/transient/policy refresh classification.
- [x] Add response caps and timeouts to discovery/DCR/token paths.
- [ ] Validate refresh fencing with two independent real-PostgreSQL connections on
  Linux CI, including publish-listener failure and policy drift after lease acquire.
- [ ] Prevent the sweeper from expiring an actively claimed flow during the bounded
  provider exchange: expire `pending` at TTL, but give `claimed` a grace/claim lease
  longer than the maximum exchange+commit window. Add a `(status, updated_at)` index
  for terminal retention deletion and verify migration replay/query plan.
- [ ] Replace sequential per-connector delivery/refresh waiting with bounded
  concurrency after the policy prefilter so multiple expired connectors cannot delay
  a run by N× the lease wait. Add deterministic concurrency/timing tests.

### Phase 4: Marketplace and documentation reconciliation

In a fresh marketplace worktree/branch created from current `origin/main` (the
existing `C:\Users\TK\.aoa\wt\aoa-marketplace` branch is already merged/stale):

- [ ] Use version-safe Notion copy: “Requires an AoA release with OAuth connector support; older releases show this connector as unavailable.” Do not claim every installed AoA release supports sign-in.
- [ ] Add producer schema parity for `oauth.scopes` in `catalog/src/types/connector.ts`; its current `.strip()` silently drops the field. Add aggregate/contract tests proving `oauth.scopes: ["default"]` survives into `dist/connectors.json`.
- [ ] Publish exact Notion scopes `['default']`; the AoA server policy remains authoritative.
- [ ] Keep Sentry visible but explicitly unavailable until the separate Sentry acceptance plan is complete.
- [ ] Fail marketplace aggregation on duplicate `serverName` values; keep the AoA consumer check as defense in depth.
- [ ] Run `pnpm install --frozen-lockfile`, `pnpm validate-connectors`, `pnpm aggregate-connectors`, `pnpm test`, and `pnpm typecheck`; validate local generated `dist/connectors.json` but do not commit it (`dist/` is ignored/untracked).
- [ ] Before #317 merges, validate AoA against the exact locally generated
  marketplace artifact. After the fail-closed AoA consumer merges, open/review/merge
  the marketplace PR, verify published CDN content/hash, and run the post-publish smoke.

In this repository:

- [ ] Update the original 18-task implementation plan with actual completion/evidence, not blanket checks.
- [ ] Reconcile `mcp-connectors-followups.md`, closing completed entries and linking remaining work here.
- [ ] Mark the old handoff superseded and reconcile it, the original implementation
  plan, follow-up register, and PR description to the final SHA/current v2 behavior.
- [x] Document signing-key rotation and the reauthorization consequence.
- [x] Append a dated correction to locked Decision #116 recording the discovery-first custom broker as the implementation. Supersede only the `genericOAuth` implementation note; preserve the company-scoping, explicit-lifetime, broker-owned-token, and historical decision text.

### Phase 5: UI correctness

- [x] If install succeeds but `/oauth/start` fails, refetch connectors before showing the error so the installed `needs_credentials` row is visible and retryable.
- [x] Make authorization completion copy status-aware: `active`, `pending_approval`, and `needs_credentials` must have distinct messages.
- [x] Prevent retry from creating a duplicate connector; reuse the installed connector and restart OAuth.
- [x] Replace Settings' live-catalog/`serverName` inference with server-returned immutable connector identity and derived OAuth eligibility.
- [x] Consume `oauthResult`, immutable `connectorId`, and stable error codes from the callback; refetch before rendering and handle a company switch without misidentifying the connector.
- [x] Add component tests for partial install, pending approval, callback error, retry, and wrong-company/company-switch results.
- [x] Handle connector-list fetch failure without an indefinite “Checking…” state;
  provide a retryable neutral verification error and render known failure reasons
  without waiting forever on the list.
- [x] Make callback failure company-safe, including a real two-company switch test;
  never link a failed callback to the wrong selected company's Settings.
- [x] Treat callback query parameters as flash state: after terminal rendering remove
  only `oauthResult`, `connectorId`, and `reason` with replace navigation.
- [x] Add correct recovery for `secret_collision` (Settings → Secrets, then retry),
  warning/action-required semantics for `needs_credentials`, and all stable reason codes.
- [x] Show policy-blocked/unavailable health to all board roles while keeping mutation
  actions founder-only; do not describe a blocked active row as usable.
- [x] Distinguish Settings loading/error from genuine empty connector/agent lists.
- [x] Add `role=status`/polite live regions for progress/success and `role=alert` for
  async failures; give busy/disclosure controls meaningful accessible names/state.
- [x] Scope in-flight install/OAuth work to the initiating company and prevent a
  second competing OAuth redirect; ignore late responses after company switch.

### Phase 5.5: Operator safety, documentation, and rollback

- [x] Correct every rollback/runbook value to
  `AOA_MCP_CONNECTOR_DENYLIST=notion,sentry`; verify that exact value makes
  both entries visible-but-unavailable and blocks install/start/callback/delivery/
  refresh before outbound network or secret mutation.
- [x] Add a shared token-safe operator DB resolver used by rollback and forced
  expiry: explicit external URL/config first, otherwise the active embedded AoA
  instance and actual runtime port. `--help` must work without a database.
- [x] Redesign rollback as dry-run by default. Support `--company-id`; require
  `--all-companies --apply --confirm <instance-id>` for global mutation plus an
  active-denylist/maintenance acknowledgement. Require backup, drained/restarted
  processes, bounded candidate preview, full owner/binding/catalog/policy/provider
  metadata checks, atomic redacted audit, idempotent apply, and `--verify` exit 0/2.
- [ ] Add real-PostgreSQL spawned-CLI tests for both operator scripts: external and
  embedded resolution, help/no-DB, dry-run no writes, apply, idempotence, wrong DB,
  wrong key, metadata transplant/collision preservation, audit rollback, exit codes,
  and stdout/stderr token-pattern redaction.
- [x] Add `docs/guides/board-operator/oauth-connectors.md`, register/link it, and
  document the golden path plus exact authenticated prerequisites: stable signing
  root across replicas, public HTTPS callback origin, board auth, trusted proxy/
  origin configuration, secret-provider/master-key requirements, and restart rules.
- [x] Give every operator error problem/cause/fix guidance for signing-secret,
  public-base-URL, provider cancellation, policy/denylist, secret collision,
  transient refresh, permanent reauthorization, wrong DB/key, and unsafe rollback.
- [x] Provide paired PowerShell and POSIX commands for signing, DB resolution,
  force-expiry, rollback, and verification. Linux CI is authoritative for the
  real-PostgreSQL suites skipped on Windows.
- [x] Add a checked redacted live-evidence template containing only final SHA,
  catalog URL/hash, connector/run/page/tool IDs, timestamps, version counters,
  activity action/count, and cleanup confirmations. Forbid cookies, codes, state,
  tokens, authorize URLs/query strings, secret material, and provider bodies; run
  `pnpm check:tokens` plus a narrow OAuth scan before attaching/committing evidence.

### Phase 6: Acceptance, review, and merge

- [ ] Run a live Notion sign-in with the founder completing provider authentication.
- [ ] Have the founder create a disposable Notion page named `AoA OAuth E2E <timestamp>`; through an agent/crew run, list the provider tools and call its read-only search tool for that exact title. Capture only tool name, run ID, page title/ID, status, and timestamps.
- [ ] Harden `force-mcp-oauth-expiry`: shared external/embedded DB resolver,
  `--help`, dry-run default, required company ID, expected version, explicit
  `--apply --confirm-test-connector`, policy/status recheck, atomic redacted
  `mcp_connector.oauth_forced_expiry` activity, stable JSON output, and CLI/PG tests.
- [ ] Repeat the exact search in a new run. Prove the secret `latestVersion` increased by exactly one from the post-force snapshot, one provider refresh occurred, and the post-refresh tool call succeeded.
- [ ] Store redacted evidence only; then delete the disposable page, disable/remove the test connector, and disconnect the AoA integration from the Notion test workspace under Notion Settings → Connections. Record DCR client deletion as `N/A: provider exposes no deletion endpoint` when that remains true.
- [ ] Run the full repository verification commands below.
- [ ] Re-run Codex review after its usage limit resets.
- [ ] Obtain independent security/code review of the committed final SHA; planning
  reviews of the changing uncommitted diff do not satisfy this gate.
- [ ] Resolve every P0/P1/P2 finding before merge.
- [ ] Merge only after GitHub returns `MERGEABLE`, `CLEAN`, and all required checks are green on the final SHA.

## Acceptance Criteria

1. Outside `local_trusted`, `/oauth/start` rejects API-key/no-session actors, stores exact non-UUID Better Auth user IDs, and callback returns 401 for no session or 403 for a different user/company with zero secret, connector, flow-completion, activity, or live-event writes.
2. In `local_trusted`, the synthetic local board can complete the same flow with a null persisted starter user.
3. A founder-created secret containing a syntactically valid v1/v2-looking JSON object cannot trigger an outbound refresh request.
4. Invalid-MAC, cross-company, cross-connector, wrong-secret-name, and wrong-policy-version bundle transplants are withheld and never fall through as static bearer tokens.
5. OAuth completion never rotates `mcp:${serverName}` or any secret lacking exact broker purpose/owner metadata and signed context; generic credential/secret routes cannot mutate, bind, resolve, or deliver broker-owned secrets, including stale direct-database bindings.
6. Changing `serverName`, retrying concurrently, or publishing a duplicate catalog `serverName` cannot change identity or create two rows for one `(companyId, catalogEntryId)`.
7. Sentry cannot be installed/authorized; removing/changing provider policy or emergency-denying a serverName (including mid-flow) blocks start/callback/delivery/refresh before secret mutation/resolution or network.
8. A connector already disabled when callback loads, or disabled after the initial read, stays disabled and causes no committed secret mutation.
9. A forced failure in secret commit, connector bind, flow completion, or activity persistence leaves no partial callback commit and publishes no live success event.
10. Two simultaneous callbacks produce at most one successful token exchange/commit path; the loser reports the flow as already used.
11. A 429, timeout, or 5xx refresh error does not change status to `needs_credentials`; `invalid_grant` does; a policy block withholds delivery with `oauth_policy_blocked` rather than asking for credentials.
12. Two overlapping healthy process-equivalent workers make exactly one provider request/rotation; the contender waits, reloads, and reuses the new token. Expiry before `request_started` permits fenced takeover; crash/expiry after `request_started` and before commit makes the result indeterminate and fails closed to reauthorization without a second provider request.
13. Connection-time policy rejects HTTP, DNS rebinding/private/loopback/link-local/mapped addresses, unsafe metadata redirects, every DCR/token/refresh redirect, responses over 1 MiB, and requests exceeding 10 seconds.
14. Migration `0188` and the new generated migration each apply twice and recover from a tested partial state, including one pre-existing `0188` FK.
15. Callback UI refetches by immutable connector ID and correctly distinguishes active, pending approval, needs credentials, failure, and a connector belonging to another selected company.
16. Live Notion evidence includes a successful tool result before and after forced expiry, exactly one `mcp_connector.oauth_refreshed` activity after the post-force version snapshot, and no token values in logs/artifacts.
17. A remote catalog entry retaining ID `notion-hosted` but changing resource URL, issuer/endpoints, or scopes is rejected by the server policy.
18. `/oauth/start` remains available from persisted identity/server policy when the
    remote catalog is unavailable after install; remote catalog authority is used at
    install/shelf only.
19. Same-URI reauthorization reuses DCR; a changed callback URI performs new DCR.
20. A post-commit live-event listener exception leaves callback/refresh durable state
    successful, logs the poke failure, releases the lease, and never redirects/demotes.
21. The flow sweeper cannot expire a live claimed exchange; terminal retention uses a
    matching `(status, updated_at)` index.
22. Rollback is dry-run by default, operates on the default embedded deployment,
    archives only exact bound broker-owned secrets, is idempotent/audited/redacted,
    and verifies safety before an old binary starts.
23. UI failures are terminal and recoverable, company-safe, screen-reader announced,
    and do not confuse loading/API failure with empty or usable state.

## Testing Plan

| Layer | Required behavior gates |
|---|---|
| Pure unit | bundle MAC/context/limits and policy-field drift; URL/IP/redirect/body/timeout policy; refresh classification; exact callback reason mapping; same/changed redirect URI DCR; pending/claimed sweeper boundaries |
| Route/service unit | exact non-UUID starter; 401 vs 403 with zero side effects; unsupported/denylisted install/start; catalog outage after install; broker-secret generic create/bind/env/resolve/delivery isolation; loader policy-before-secret; publish-listener throw; no network on every policy failure |
| UI component | initial/refetch failure+retry; all callback reasons/statuses; two-company switch; late request after switch; competing OAuth clicks; policy-block visibility; Settings loading/error/empty; flash query cleanup; ARIA status/alert semantics |
| Real-PostgreSQL integration | atomic callback failure injection at secret/bind/flow/activity; disable/policy/denylist races with barriers; duplicate callbacks; secret collision; publish throw after commit; two-connection refresh fencing/policy drift/lease release; claimed-flow sweeper race |
| CLI integration | rollback/forced-expiry external+embedded DB resolution, help/dry-run/apply/verify, exact ownership, audit rollback, idempotence, exit codes, output redaction |
| Migration/performance | replay `0188`/`0189` twice and partial state; refresh lease constraints; `(status,updated_at)` index query plan; bounded loader concurrency without N×lease delay |
| Automated browser/E2E | authenticated non-UUID board session install→start→callback; company switch and list failure; base-URL/DCR change; denylist mid-flow; rollback apply→verify safety |
| Founder-assisted live E2E | exact marketplace artifact; Notion consent; read-only tool search; forced expiry; second search; exactly one secret-version refresh/activity; redacted evidence and provider/connector/page cleanup |

Required commands from repository root:

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm test:run
pnpm build
```

Targeted commands must also cover:

```sh
pnpm exec vitest run packages/db/src/__tests__/migration-idempotency.test.ts packages/db/src/__tests__/mcp-connector-oauth-migrations.integration.test.ts
pnpm exec vitest run packages/shared/src/__tests__/mcp-connector-catalog.test.ts server/src/services/__tests__/mcp-connector-oauth-policy.test.ts server/src/services/__tests__/mcp-connector-oauth.test.ts server/src/services/__tests__/mcp-connector-oauth-bundle.test.ts server/src/services/__tests__/mcp-connector-token-refresh.test.ts server/src/services/__tests__/mcp-connector-token-refresh.integration.test.ts server/src/services/__tests__/mcp-connectors-loader.test.ts server/src/services/__tests__/mcp-connector-emergency-policy.test.ts server/src/services/__tests__/mcp-connector-oauth-flow-sweeper.test.ts server/src/__tests__/mcp-connector-install-route.test.ts server/src/__tests__/mcp-connectors-routes.test.ts server/src/__tests__/mcp-connector-create.test.ts server/src/__tests__/mcp-connector-credentials-route.test.ts server/src/__tests__/mcp-connector-oauth-route.test.ts server/src/__tests__/mcp-connector-oauth.integration.test.ts server/src/__tests__/mcp-oauth-operator-cli.test.ts server/src/__tests__/mcp-oauth-operator-cli.integration.test.ts server/src/__tests__/secrets-service.test.ts
pnpm --filter @armyofagents/ui test:run -- MarketplaceConnectors MCPConnectorsSection
```

Targeted tests do not replace the full `pnpm test:run` gate.

### Test execution rules

- Add failing regression tests before each fix where practical.
- Unit mocks prove guards, mapping, and side-effect ordering only. They do not prove
  SQL rollback, locks, fencing, or isolation.
- Every transaction/race claim must pass against real PostgreSQL with independent
  connections and deterministic barriers, not sleeps.
- Windows-skipped integration tests are not passing evidence. They must run in the
  required Linux CI lanes on the committed final SHA.
- Live provider testing never prints or stores credentials and requires founder
  interaction only for Notion sign-in/consent.
- After targeted suites: run fresh install, repository typecheck, complete test suite,
  build, token scan, `git diff --check`, and GitHub required checks.

## Files Reference

| File | Planned change |
|---|---|
| `packages/db/src/schema/company_mcp_connectors.ts` | Add catalog/policy identity and partial company/catalog unique index |
| `packages/db/src/schema/mcp_connector_oauth_flows.ts` | Add catalog/policy identity and status/expiry cleanup index |
| `packages/db/src/schema/mcp_connector_oauth_refresh_leases.ts` | Add lease owner/fence/version/expiry table |
| `packages/db/src/migrations/0188_narrow_blonde_phantom.sql` | Guard both PR-introduced FK additions for partial replay |
| generated next `packages/db/src/migrations/*.sql` + `meta/_journal.json` + snapshot | Generated schema changes; next number determined after rebase |
| `packages/shared/src/mcp-connector-catalog.ts` | Reject duplicate server names |
| `server/src/routes/mcp-connectors.ts` | Enforce provider policy, immutable identity, session-bound callback, atomic commit, collision-safe secrets |
| `server/src/services/secrets.ts` | Add transaction-scoped broker-secret primitives and broker-owned mutation guards |
| `server/src/services/activity-log.ts` | Split transaction-only insert from post-commit live publication |
| `server/src/services/mcp-connector-create.ts` | Carry server-owned identity through catalog creation only |
| `server/src/services/mcp-connectors-crud.ts` | Return/persist identity fields; keep them out of user patch input |
| `server/src/services/mcp-connector-oauth-policy.ts` | New supported-provider and outbound policy boundary |
| `server/src/services/mcp-connector-oauth-bundle.ts` | Signed v2 envelope and redirect URI |
| `server/src/services/mcp-connector-oauth.ts` | Central safe outbound requests and typed token errors |
| `package.json` + `pnpm-lock.yaml` | Keep actual script/runtime dependency changes synchronized; outbound policy currently uses `node:https`, not an Undici package addition |
| `server/src/services/mcp-connector-token-refresh.ts` | Policy-bound parsing, failure classification, lease/fencing coordination |
| `server/src/services/mcp-connector-oauth-flow-sweeper.ts` | Boot/hourly batched flow cleanup |
| `server/src/index.ts` | Schedule the idempotent flow sweeper |
| `server/src/services/mcp-connectors-loader.ts` | Fail-closed OAuth delivery and status behavior |
| `server/src/routes/secrets.ts` | Reject generic mutation of broker-owned secrets |
| `ui/src/api/mcpConnectors.ts` | Synchronize connector identity/status response types |
| `ui/src/pages/MarketplaceConnectors.tsx` | Status-aware callback success and refetch on partial failure |
| `ui/src/components/marketplace/connectors/ConnectorShelf.tsx` | Unsupported-provider and retry behavior |
| `ui/src/components/settings/sections/MCPConnectorsSection.tsx` | Remove live-catalog/server-name OAuth inference |
| `server/src/__tests__/mcp-connector-oauth-route.test.ts` | Callback/session/provider/race/collision regressions |
| `server/src/__tests__/mcp-connector-oauth.integration.test.ts` | Transactional callback integration |
| `server/src/services/__tests__/mcp-connector-oauth-bundle.test.ts` | MAC and malformed envelope tests |
| `server/src/services/__tests__/mcp-connector-token-refresh.test.ts` | Classification and concurrency tests |
| `ui/src/__tests__/MarketplaceConnectors.test.tsx` | UI state and retry tests |
| `ui/src/components/settings/__tests__/MCPConnectorsSection.test.tsx` | Persisted identity and reauthorize tests |
| `scripts/force-mcp-oauth-expiry.ts` | Token-safe live refresh harness |
| `scripts/rollback-mcp-oauth-v2.ts` | Idempotent, audited pre-old-binary rollback and verify command |
| `scripts/lib/*` + operator script tests | Shared active-instance DB resolution, safe CLI parsing, spawned real-PostgreSQL coverage |
| `docs/guides/board-operator/oauth-connectors.md` | Golden path, authenticated prerequisites, troubleshooting, live proof, rollback |
| OAuth E2E evidence template | Redacted final-SHA/catalog/tool/refresh/cleanup evidence only |
| `C:\Users\TK\.aoa\wt\aoa-marketplace\catalog\src\types\connector.ts` | Preserve `oauth.scopes` in producer schema |
| `C:\Users\TK\.aoa\wt\aoa-marketplace\catalog\src\__tests__\aggregate-connectors.test.ts` | Scope preservation and duplicate server-name failures |
| `C:\Users\TK\.aoa\wt\aoa-marketplace\content\connectors\notion-hosted\connector.json` | Current copy and explicit `default` scope |
| `C:\Users\TK\.aoa\wt\aoa-marketplace\content\connectors\sentry\connector.json` | Visible-but-unavailable copy |
| ignored `C:\Users\TK\.aoa\wt\aoa-marketplace\dist\connectors.json` | Local validation output only; verify published CDN artifact/hash after merge |
| `docs/aoa/plans/2026-07-31-oauth-connector-broker-implementation-plan.md` | Evidence-based completion audit |
| `docs/aoa/plans/mcp-connectors-followups.md` | Reconcile stale follow-ups |
| `docs/architecture/decisions.md` | Append the dated Decision #116 implementation correction |

## Dependency Graph and Sequencing

```text
Provider freeze/allowlist
        |
        v
Persist immutable identity ---> Signed bundles + owned secret names
        |                              |
        +--------------+---------------+
                       v
          Session-bound atomic callback
                       |
             +---------+----------+
             v                    v
       Refresh/egress         UI/catalog copy
       hardening              reconciliation
             +---------+----------+
                       v
          Live tool + refresh proof
                       |
                       v
              Independent review
                       |
                       v
                     Merge
```

Identity and provider policy come first because every later operation must know which installed connector is entitled to broker behavior. Bundle/secret ownership must precede the atomic callback so the transaction commits safe objects. Live testing comes after marketplace reconciliation so it exercises what users will actually receive.

## Rollback Plan

- Before merge: revert the remediation commits and keep PR #317 open; the catalog policy must continue showing unsupported OAuth entries as unavailable.
- Runtime provider rollback: set
  `AOA_MCP_CONNECTOR_DENYLIST=notion,sentry`, restart/drain every server, and
  verify shelf/install/start/callback/delivery/refresh are blocked before changing
  binaries. The values are `serverName` identities, not catalog IDs or display names.
- Binary rollback after v2 bundles exist: take a database backup, keep the exact
  denylist active, run the hardened rollback in dry-run mode, review its redacted
  candidates, then use explicit `--apply` confirmation. Archive only an exact currently
  bound local-encrypted/AoA-managed broker secret whose company, connector, catalog,
  policy, purpose, name, and binding all match. Re-run `--verify` (exit 0 required),
  revoke provider grants, and only then deploy old code. Otherwise the v1 decoder can
  pass the signed dot-delimited v2 envelope through as a static bearer value.
- Schema rollback: columns/tables are additive. Do not drop them during an incident; old application code is safe only after the denylist/data procedure above.
- Token incident: disable the affected connector and revoke/reauthorize the provider grant. Rotate the root signing secret only on confirmed root compromise; doing so invalidates sessions/JWT-derived state and every bundle key, so document and coordinate the global blast radius.
- Marketplace rollback: revert the marketplace manifest PR and rebuild the aggregate; do not hand-edit generated `dist/connectors.json`.

## What Is Already Correct (Do Not Rework)

- Server-computed redirect URI and fail-closed public-base-URL behavior.
- PKCE S256 generation and authorization-code exchange inputs.
- HMAC-signed, expiring OAuth state and timing-safe verification.
- Atomic `pending -> claimed` flow transition preventing callback replay.
- Flow and connector company binding.
- HTTPS assertions already present for discovered endpoints.
- Encrypted secret storage and token-safe logging.
- Emergency policy evaluation before connector delivery/refresh.
- In-process refresh single-flight for a single server process.
- Existing transport and command-safety gates.

## Definition of Done

The plan is complete when every merge-blocker checkbox and acceptance criterion passes on the final PR SHA, the marketplace artifact matches the provider policy, live Notion tool/refresh evidence exists without credentials, full verification succeeds, and an independent final review has no unresolved P0/P1/P2 findings.

### Implementation status (2026-08-03)

The remediation is locally implementation-complete but release-incomplete and remains uncommitted in
`C:\Users\TK\.aoa\wt\mcp-connectors` on
`feat/connector-security-hardening`. All-workspace typecheck and production build
pass. The comprehensive focused matrix reports 457 passing tests with 12
real-PostgreSQL cases skipped on Windows. Chromium connector-install E2E reports
2 passing journeys. Independent security review found and then verified the fix for
generic rebinding/resolution of broker-owned OAuth secrets; final security verdict is
SHIP. These results do not prove the Linux-only rollback/race/fencing paths.

The latest full-suite run produced ten unrelated worker/import/subprocess timeouts
under saturated Windows load. Every failed file passed serially (9 files, 33 tests).
Treat this as strong contention evidence, not a passing full-suite result or an OAuth
exemption. The final committed SHA must still pass required Linux CI and the complete
repository gate.

## Decision Audit (2026-08-03)

| Decision | Choice | Why |
|---|---|---|
| Release scope | Authenticated-ready Notion OAuth | Founder explicitly chose the full trust boundary; no silent local-only fallback |
| Repository boundary | One safety-complete AoA PR plus a separate marketplace PR | Splitting AoA security creates an unsafe intermediate unless OAuth is hard-disabled |
| Release order | AoA consumer first, marketplace producer second | Fail-closed consumer exists before the catalog activates corrected behavior |
| Callback reasons | Keep the implemented six-code server/UI contract | It is internally synchronized; only the plan was stale |
| Callback URL state | Flash state cleared with replace after terminal rendering | Prevents stale banners while preserving unrelated query parameters |
| UI direction | State/error/accessibility correction only | Existing Marketplace-install / Settings-manage information architecture is sound |
| Transaction proof | Real PostgreSQL, independent connections, deterministic barriers | Unit transaction stubs cannot prove rollback, locks, isolation, or fencing |
| Commit timing | Create a CI-candidate commit only after local fixes/review; merge only after Linux CI, committed-SHA review, marketplace validation, and live proof | The current GitHub checks cover the old SHA and Linux-only evidence requires a pushed candidate |

## Developer and Operator Journey

Primary persona: a technical founder/self-hosted operator authorizing Notion for an
agent. Secondary persona: a deployment operator diagnosing or rolling back OAuth.

```text
Marketplace -> select company -> install Notion -> Authorize -> founder consent
     |                                                   |
     | fetch/install/start error                         v
     +-> explicit cause + retry/recovery        persisted connector status
                                                         |
                                                         v
Settings -> assign agents -> read-only tool smoke -> forced-expiry test -> cleanup
                                                         |
                                      incident: denylist -> dry-run -> backup/apply
                                      -> verify -> revoke -> old binary
```

The target time from opening Marketplace to an authorized connector is 2–5 minutes.
No step may require an operator to reverse-engineer the embedded database port,
discover an undocumented environment variable, or infer whether a mutation worked.

## Failure Modes Registry

| Codepath | Failure mode | Required rescue | Test layer | User/operator sees |
|---|---|---|---|---|
| OAuth start | no session/non-UUID user/catalog outage | 403 before network; exact text identity; stored-policy start | unit + PG E2E | actionable auth/config error |
| Callback | wrong session, disable/policy race, partial DB failure | 401/403 before claim; locked recheck; full rollback | unit + real PG | stable reason, no false success |
| Post-commit event | listener throws | log/drop poke, preserve durable success and release lease | unit + real PG | persisted success after refetch |
| Refresh | transient/permanent/policy/indeterminate/race | classify, fence, current-policy validation, no duplicate request | unit + two-connection PG | retryable vs reauthorize vs policy health |
| Sweeper | active claimed exchange crosses TTL | claim grace/lease; terminal indexed cleanup | unit + PG race | no orphan provider grant from local expiry |
| UI callback | list 401/403/500 or company switch | terminal retryable/company-neutral state | component + browser | never infinite checking/wrong-company link |
| Rollback CLI | wrong DB/key/identity/denylist or partial write | dry-run, exact ownership, backup/preflight, atomic audit, verify 0/2 | spawned CLI + PG | counts/IDs/next action only |
| Marketplace | scopes stripped/duplicate name/stale copy | producer schema+aggregate failure+hash verification | producer unit/contract | unavailable until compatible artifact |

## Parallel Execution Lanes

Land shared contracts first: stable callback reasons, provider-policy context, operator
DB resolver shape, and migration/index shape. Then run four coordinated lanes:

| Lane | Work | Depends on |
|---|---|---|
| A | Session/start/callback transaction and real-PG races | shared policy/reason contract |
| B | Bundle/loader/refresh/publish/lease/sweeper performance | shared policy context + migration shape |
| C | Marketplace/Settings UI states, company isolation, a11y and component/browser tests | stable API reason/status contract |
| D | Migrations, rollback/force-expiry CLI, operator docs/evidence, marketplace producer branch | DB resolver + ownership contract |

Lanes A and B both touch policy/refresh boundaries; merge the shared contract first and
coordinate those files. C can proceed independently after the API contract. Marketplace
producer work stays in its own repository/worktree. After lanes merge: targeted tests,
real-PG Linux gates, full repository verification, live Notion E2E, fresh final-SHA
review, then commit/push/CI/merge.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` via `/autoplan` | Scope & strategy | 2 voices | DECIDED | Authenticated-ready scope selected; consumer-first cross-repo release |
| Codex Review | PR bot + local outside voice | Independent 2nd opinion | 2 completed, 1 timeout | ISSUES FOUND | PR bot quota-blocked; local Codex confirmed premise/design gaps; Eng run timed out and used fallback agent |
| Eng Review | `/plan-eng-review` via `/autoplan` | Architecture & tests (required) | 2 voices | ISSUES OPEN | 2 P1 plus transaction, refresh, rollback, performance, and test gaps folded into plan |
| Design Review | `/plan-design-review` via `/autoplan` | UI/UX gaps | 2 voices | ISSUES OPEN | Infinite callback loading, company attribution, state semantics, policy health, and a11y gaps |
| DX Review | `/plan-devex-review` via `/autoplan` | Operator/developer experience | 2 voices | ISSUES OPEN | Rollback identity/embedded DB, CLI safety, operator docs, evidence, and cross-platform gaps |

**CROSS-MODEL:** Reviewers agreed that the current GitHub green checks are stale,
non-UUID authenticated callback binding and in-transaction policy rechecks block ship,
real PostgreSQL is required for rollback/race claims, UI errors must be terminal and
company-safe, and rollback/operator procedures are not yet reproducible or safe.

**VERDICT:** PLAN REVIEW COMPLETE, IMPLEMENTATION NOT CLEARED — execute all unchecked
P1/P2 tasks, verify the committed final SHA, then run fresh pre-landing review.

NO UNRESOLVED DECISIONS
