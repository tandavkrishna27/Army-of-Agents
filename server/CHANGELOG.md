# @armyofagents/server

## 1.0.1

### Patch Changes

- 40688fc: Add the July 2026 Docker deployment and runtime research consolidation: a pgvector-backed Compose deployment stack with first-run config/secret bootstrap, Google-OAuth `authenticated` mode (first sign-in becomes instance admin) with an opt-in CEO invite helper to pre-designate that admin when the URL is exposed before you sign in, and a disposable Docker research harness with deterministic e2e and opt-in real-provider lanes for Claude, Codex, and Gemini.
- 40688fc: Extend `GET /api/companies/stats` response with `pendingApprovalCount` and `unreadNotificationCount` per company. Aggregates from the `approvals` (status='pending') and `notifications` (readAt IS NULL) tables. Multi-tenant isolation preserved via the existing route-level filter against the actor's accessible companies. No schema changes; backward-compatible additive type expansion of the `CompanyStats` shape consumed by the lobby UI.
- 40688fc: fix(security): close cross-tenant IDOR on /agents/:id/keys (GET, POST, DELETE). Agent loaded + assertCompanyAccess; DELETE additionally validates the key belongs to the named agent. Adds getKeyById service method. Closes C5.
- 40688fc: fix(security): close cross-tenant IDOR on /agents/:id/{pause,resume,terminate} (parallel-C5 follow-up flagged by the PR #132 code review). Each handler now follows the canonical load → 404-if-missing → assertCompanyAccess → act pattern, mirroring the fix that PR #132 applied to /agents/:id/keys. Without this guard, a board user with membership in company A could pause/resume/terminate any agent in company B by knowing the agent UUID.
- 40688fc: fix(security): defense-in-depth on approval mutations. `approvalService.approve/reject/requestRevision` now require a `companyId` argument and include `eq(approvals.companyId, companyId)` in the UPDATE's WHERE clause. If a future route forgets the route-layer `load+assertCompanyAccess` guard (which PR #131 added), the service silently refuses the cross-tenant write. Existing route handlers were updated to pass `existing.companyId` (which they already load). Closes the PR #131 follow-up flagged by the C3/C4 review as "defense-in-depth, deferred".
- 40688fc: fix(security): close cross-tenant IDOR on /approvals/:id/approve|reject|request-revision (C3) and remove the spoofable `decidedByUserId` body field (C4). Decider is now derived from `req.actor.userId` server-side; CLI no longer accepts `--decided-by-user-id`.
- 40688fc: Force `Content-Disposition: attachment` for asset GETs unless the content type is on a safe-inline allowlist (images excluding SVG, PDF, plain text, markdown, JSON). Adds explicit `X-Content-Type-Options: nosniff` on every asset response. Closes the same-origin XSS window where a user-uploaded HTML or SVG file would otherwise execute under the AoA app origin. Upload policy is unchanged — all types are still accepted.
- 40688fc: Auth + logging hardening:
  - Better-auth fails closed at startup if `BETTER_AUTH_SECRET` is unset in `authenticated` or `cloud_auth` deployments. The dev fallback is preserved only for `local_trusted` mode and emits a startup WARN.
  - Error-handler and request logger now redact sensitive body/query/params fields (`password`, `pat`, `secret`, `token`, `apiKey`, etc.) before serialising to logs. Recursion depth and array length are bounded to prevent log-pump DoS.
- 40688fc: ci(routes): regression guard against unpaired `assertBoard(req);` calls. After Sprint 1 + 2 fixed five cross-tenant IDORs (C3, C5, C6, parallel-C5, batch-2) caused by routes that called `assertBoard(req)` without a follow-up `assertCompanyAccess(req, ...)` or `assertCanManageInstanceSettings(req)` to enforce actual scope, this guard pins the lesson — any future route that calls `assertBoard(req);` without one of: `assertCompanyAccess`, `assertCanManageInstanceSettings`, `assertRole`, or an explicit `// rbac: instance-admin-not-required` (or `paired-via-helper`) opt-out comment within its handler body fails CI with a remediation hint. The guard uses handler-scope detection (looks within the enclosing `router.X(...)` block, not a fixed line window) so it correctly handles the codebase's idiomatic load-then-404-guard pattern. The `plugins.ts` and `marketplace.ts` files are temporarily allowlisted pending a separate plugins-workstream that will gate their instance-admin operations with `assertCanManageInstanceSettings`. Remove from the allowlist as each file gets its proper gates. The migration-idempotency portion originally planned for PR 6b is already covered by C14's regression test (PR #138).
- 40688fc: Cloud-readiness hardening:
  - New `AOA_TRUST_PROXY` env var lets operators opt into Express's `trust proxy` setting (boolean / hop count / CIDR list). Required for cloud deploys behind Cloudflare/ALB/nginx — without it, IP-keyed rate limits from PR #156 collapse to one shared bucket.
  - `/api/companies/import` and `/api/companies/import/preview` capped at 20MB body size (was unbounded by the global default's 100KB, which already silently 413'd legitimate bundles).
  - Zod array length caps on the portability schema prevent CPU-bound validation on inflated payloads (10M issues → ~500MB Zod walk).
- 40688fc: fix(security): close Commander RBAC bypass + capability bypass (C13). `executeTool` now gates on `tool.requiredRole` (against an actual `founder > team_lead > team_member` hierarchy) AND on `internal_agent_config.enabledCapabilities` for capability-gated categories (`discussion`, `action`, `memory`). The chat route now looks up the caller's effective role via `permissionService` instead of hardcoding `"founder"`. `mcp-bridge.ts` fails closed if `AOA_SESSION_USER_ROLE` is missing instead of defaulting to founder.
- 40688fc: Cross-tenant + audit hardening:
  - DELETE /feedback-votes/:voteId now loads the vote and `assertCompanyAccess` before dismissal (DiD against UUID-knowledge attacks across companies).
  - Better-auth trustedOrigins drops `http://<host>` in `authenticated`/`cloud_auth` deployments (downgrade-attack surface). `local_trusted` keeps both schemes for loopback dev.
  - POST /agents/:id/keys activity log now uses the canonical `getActorInfo` spread for shape parity.
  - DELETE /agents/:id/keys/:keyId now emits `agent.key_revoked` (was silent in the activity log — incident-forensics gap closed).
- 40688fc: fix(security): close two more cross-tenant IDORs in the same C3/C5/C6 class — `PATCH /companies/:companyId/budgets` (any board user could modify any company's monthly budget) and `POST /heartbeat-runs/:runId/cancel` (any board user could cancel any company's heartbeat runs). Both surfaced by the regression-guard audit prep for the upcoming `assertBoard` pairing CI guard. Each route now follows the canonical load/lookup → assertCompanyAccess → act pattern established by PR #132 / PR #145.
- 40688fc: Defense-in-depth nits on the DNS-rebind guard:
  - `validateAndResolveFetchUrl` now strips embedded credentials from the URL — basic-auth in URLs (`https://user:pass@host/`) is no longer forwarded to the pinned request, preventing credential leakage if a future caller accepts a URL from an authenticated user.
  - Body-cap exceeded now throws a tagged `PinnedRequestBodyCapError` (with `capBytes`) so callers can distinguish from transport errors.
- 40688fc: Graduate helmet from light defaults to a strict Content-Security-Policy in `authenticated` and other production deployment modes. Adds `script-src 'self' 'sha256-<bootloader>'` (the Vite bootloader inline script hash is computed at server startup by reading the served `index.html`), locked `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`, and a `connect-src 'self'` lock-down (the UI never calls LLM APIs directly — all LLM traffic is server-mediated). Local-trusted dev mode skips CSP because Vite HMR requires inline + WebSocket + eval. Cross-Origin-Opener-Policy moves to `same-origin-allow-popups` and Cross-Origin-Resource-Policy to `same-site`; COEP intentionally remains off to allow external avatar/image loading without forcing every host to emit a CORP header. Closes Sprint 4 finding S4-G.
- 40688fc: fix(security): close the DNS-rebind window on the http adapter (deferred follow-up from PR #137 / C9). PR #137's `validateAndResolveFetchUrl` validated the URL → resolved DNS → rejected private IPs, but then `fetch(url, ...)` re-resolved DNS, so an attacker controlling authoritative DNS could answer with a public IP during validation and a private IP during the actual request. Now the adapter switches from `fetch()` to `executePinnedRequest()` (lifted from `plugin-host-services.ts` into the shared `outbound-url-guard.ts`) which uses `https.request`/`http.request` with the resolved IP pinned while preserving Host header + TLS SNI. Same pattern the plugin host already uses for outbound HTTP. Both `adapters/http/execute.ts` and `adapters/http/test.ts` updated.
- 40688fc: fix(security): close SSRF on the http adapter's execute and test-environment paths (C9). Lifts `isPrivateIP` and `validateAndResolveFetchUrl` from `plugin-host-services.ts` into a shared `outbound-url-guard.ts` so adapters and plugins use one source of truth. URLs are parsed, protocol-gated (http/https only), DNS-resolved with timeout, and rejected if any resolved address is in a private/reserved range (RFC 1918, loopback, link-local including 169.254.169.254 cloud metadata, IPv6 ULA/loopback, IPv4-mapped IPv6). Static-misconfig SSRF closed; full DNS-rebind defense (resolved-IP pinning) deferred to a follow-up that switches the adapter from `fetch()` to `https.request`/`undici` dispatcher.
- 40688fc: fix(security): require instance-admin (or local_implicit) for filesystem routes (C2) and adapter operations (C6). Lifts `assertCanManageInstanceSettings` to `routes/authz.ts` so `instance-settings.ts` and `feedback.ts` use the same shared helper. `/filesystem/reveal` additionally bounds spawn targets to the home directory.
- 40688fc: Marketplace plugin install now verifies the package's integrity hash against the catalog when the catalog declares `npm.integrity` (e.g. `sha512-...`). Mismatches fail-closed with `IntegrityMismatchError` showing both expected and actual hashes. Catalog items without `integrity` install as before but emit a one-line WARN that integrity is unverified — backward-compat preserved.

  Threat model: defends against compromised npm registry mirrors / MITM CDN attacks where the tarball npm pulls doesn't match what the AoA marketplace published.

- 40688fc: Gate the URL/GitHub import paths in company-portability and company-skills services through the shared `validateAndResolveFetchUrl` + `executePinnedRequest` SSRF guard. Closes the link-local / RFC-1918 / file:// vectors that were reachable via `POST /companies/import/preview`, `POST /companies/import`, and skill-install URL/GitHub flows.
- 40688fc: Add per-route rate limits to defend against credential stuffing, billing-drain, and table-flood attacks. Limits: sign-in 10/min/IP, sign-up + forgot-password 5/hour/IP, CLI-auth challenges 5/min/IP (replaces the long-standing TODO at `cli-auth.ts:29`), transcribe 30/min/actor, internal-agent chat 60/min/actor. Uses `express-rate-limit` with the `draft-7` standardized headers; in-memory store (Redis-backed store is a follow-up for multi-instance deployments).
- 40688fc: fix(security): require founder role to set workspace shell commands (provision/teardown/cleanup) on projects, and reject agent/MCP actors entirely. Validator tightened to a strict Zod schema. Closes C1 (RCE via executionWorkspacePolicy.provisionCommand).
- 40688fc: ci: SHA-pin all GitHub Actions, add Dependabot for weekly updates, add `permissions: contents: read` to pr.yml and release-smoke.yml. Closes the moving-tag supply-chain attack vector (C16). Marketplace `pluginUpdatePolicy` now defaults to `notify_all` to close the auto-update mass-exploit vector pending full integrity verification (C11 step 1).
- 40688fc: Deprecate the server-side OpenAI Whisper transcription path. POST /companies/:cid/transcribe now returns 501 with a documented body pending the Commander sub-agent migration (Decision #91). Removes the silent `process.env.OPENAI_API_KEY` fallback that could bill the host operator for tenant audio. UI degrades to a "voice input not yet available" state with Paste/Write controls intact.
- 40688fc: fix(security): sanitize mammoth DOCX HTML output via DOMPurify to strip `javascript:` hyperlinks and dangerous tags (C8). Mount helmet with light defaults (X-Content-Type-Options: nosniff, X-Frame-Options: SAMEORIGIN, Referrer-Policy: no-referrer, X-Powered-By removed). Strict CSP deferred to Sprint 2 with C7.
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
  - @armyofagents/db@1.0.1
  - @armyofagents/shared@1.0.1
  - @armyofagents/adapter-utils@1.0.1
  - @armyofagents/plugin-sdk@1.0.1
  - @armyofagents/adapter-acpx-local@1.0.1
  - @armyofagents/adapter-claude-local@1.0.1
  - @armyofagents/adapter-codex-local@1.0.1
  - @armyofagents/adapter-cursor-cloud@1.0.1
  - @armyofagents/adapter-cursor-local@1.0.1
  - @armyofagents/adapter-gemini-local@1.0.1
  - @armyofagents/adapter-grok-local@1.0.1
  - @armyofagents/adapter-hermes-local@1.0.1
  - @armyofagents/adapter-openclaw@1.0.1
  - @armyofagents/adapter-openclaw-gateway@1.0.1
  - @armyofagents/adapter-opencode-local@1.0.1
  - @armyofagents/adapter-pi-local@1.0.1

## 0.2.7

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.7
  - @armyofagents/adapter-utils@0.2.7
  - @armyofagents/db@0.2.7
  - @armyofagents/adapter-claude-local@0.2.7
  - @armyofagents/adapter-codex-local@0.2.7
  - @armyofagents/adapter-openclaw@0.2.7

## 0.2.6

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.6
  - @armyofagents/adapter-utils@0.2.6
  - @armyofagents/db@0.2.6
  - @armyofagents/adapter-claude-local@0.2.6
  - @armyofagents/adapter-codex-local@0.2.6
  - @armyofagents/adapter-openclaw@0.2.6

## 0.2.5

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.5
  - @armyofagents/adapter-utils@0.2.5
  - @armyofagents/db@0.2.5
  - @armyofagents/adapter-claude-local@0.2.5
  - @armyofagents/adapter-codex-local@0.2.5
  - @armyofagents/adapter-openclaw@0.2.5

## 0.2.4

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.4
  - @armyofagents/adapter-utils@0.2.4
  - @armyofagents/db@0.2.4
  - @armyofagents/adapter-claude-local@0.2.4
  - @armyofagents/adapter-codex-local@0.2.4
  - @armyofagents/adapter-openclaw@0.2.4

## 0.2.3

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.3
  - @armyofagents/adapter-utils@0.2.3
  - @armyofagents/db@0.2.3
  - @armyofagents/adapter-claude-local@0.2.3
  - @armyofagents/adapter-codex-local@0.2.3
  - @armyofagents/adapter-openclaw@0.2.3

## 0.2.2

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.2
  - @armyofagents/adapter-utils@0.2.2
  - @armyofagents/db@0.2.2
  - @armyofagents/adapter-claude-local@0.2.2
  - @armyofagents/adapter-codex-local@0.2.2
  - @armyofagents/adapter-openclaw@0.2.2

## 0.2.1

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.1
  - @armyofagents/adapter-utils@0.2.1
  - @armyofagents/db@0.2.1
  - @armyofagents/adapter-claude-local@0.2.1
  - @armyofagents/adapter-codex-local@0.2.1
  - @armyofagents/adapter-openclaw@0.2.1
