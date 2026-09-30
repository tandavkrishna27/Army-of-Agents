# Sprint 5 — Security Audit Cleanup Design

> **Status:** awaiting user approval before implementation plan is written.
> **Recon:** all findings verified against `origin/main` at `aff48f4` (Sprint 4 final merge). Three previous-audit items dropped after verification (see "Dropped from scope" below).

## Goal

Close 6 verified findings from the Sprint 4 audit — three cross-tenant / cross-instance hardening items and three architectural / cloud-readiness items — without introducing new abstractions or expanding feature surface.

## Architecture

Three focused PRs along change-boundary lines (not severity lines), so each PR has a coherent diff a reviewer can understand in 5 minutes:

- **PR S5-A "Transcribe path removal"** — single architectural change touching server route + UI handler. Replaces the OpenAI Whisper API path with a 501 stub pending the Commander sub-agent migration (Decision #91).
- **PR S5-B "Cloud-readiness: body caps + trust-proxy knob"** — two infrastructure-config changes (`express.json` size cap + `app.set("trust proxy", config.trustProxy)`) that together unblock deploying behind a reverse proxy.
- **PR S5-C "Cross-tenant + audit hardening"** — three small server-only fixes (feedback DELETE companyId, better-auth origins HTTPS-only in `authenticated`, agent-keys DELETE+POST audit log).

No file overlap between PRs, so they merge in any order.

## Tech stack

Existing Express 5.x backend, Drizzle ORM, Zod validators, Vitest with `createSequenceDb` mock pattern, better-auth, helmet (per PR #157), express-rate-limit (per PR #156), `assertCompanyAccess` / `assertBoard` / `getActorInfo` helpers (`server/src/routes/authz.ts`). No new dependencies.

---

## Verified findings + per-fix design

### Finding 1 — Transcribe API-key fallback (REMOVE)

**Verified at** `server/src/routes/transcription.ts:78-87`. Lines 79-84 try the company secret `llm:openai`; lines 85-87 silently fall back to `process.env.OPENAI_API_KEY`. No log on the env-var branch.

**Threat.** In `authenticated`/`cloud_auth` deployments, the host operator's OpenAI key gets billed for any tenant company that hasn't configured its own — silent billing-leakage.

**Why remove instead of mode-gate.** Decision #91 moves AoA to CLI-only execution; transcription will land as a Commander sub-agent task. The provider-SDK util doc in `CLAUDE.md` already declares "Extraction will migrate to a sub-agent CLI task when the team-under-Commander architecture lands." Removing the OpenAI path now is alignment, not regression.

**Scope.**
- Server: `server/src/routes/transcription.ts` route returns `501 { error: "transcription_not_available", message: "Voice transcription will be added via the Internal Agent. See Decision #91." }`.
- Server: `server/src/services/transcription.ts` is deleted (only callsite is the route).
- Server: `server/src/middleware/rate-limit.ts:193-198` `transcribeLimiter` stays (still applies — limiter on a 501 is fine, prevents flooding).
- UI: `ui/src/api/transcription.ts:1-9` `transcribe()` keeps signature; `ui/src/components/DiscussionCaptureModal.tsx:201` catches `501` → surfaces a disabled "voice input not yet wired" state instead of a hard error.
- UI: `ui/src/__tests__/DiscussionCaptureModal.test.tsx:59-61` and `ui/src/__tests__/DiscussionDetail.test.tsx:125-127` mock updates (one-line each, change to mock a 501 path).
- Server: `server/src/__tests__/transcription.test.ts` deleted (tested the removed service).
- Tests added: route-level test asserting `POST /api/companies/:cid/transcribe` returns 501 with the documented JSON body.

**Why this is safe.** Recon confirmed UI consumers all mock `transcriptionApi.transcribe` in tests; no real test depends on a 200. Production UI will degrade to "voice not available" with the existing modal layout intact.

---

### Finding 2 — Feedback-votes DELETE missing companyId

**Verified at** `server/src/routes/feedback.ts:166-175` + service `server/src/services/feedback-votes.ts:135-148`. Route loads voteId, calls `dismissVote(voteId, authorUserId)`. Service checks `existing.authorUserId === authorUserId` only — no companyId WHERE.

**Threat.** Defense-in-depth gap. Bearer/cookie auth makes practical exploit narrow today (authorUserId is unique per better-auth user; a UUID-knowledge attack on votes in another company is the only vector). But it's the kind of gap that becomes load-bearing on the next refactor (e.g. if the literal "local-board" actor gets reused across local instances). Sibling endpoints in the same file (POST/GET on `/issues/:id/feedback-votes` lines 49-119) already do `assertCompanyAccess(req, issue.companyId)`. DELETE is the lone exception.

**Scope.**
- `server/src/routes/feedback.ts:166` — load vote first, then `assertCompanyAccess(req, vote.companyId)`, then call dismiss. Mirrors the secrets-routes pattern at `server/src/routes/secrets.ts:135-149`.
- Optional defense-in-depth: extend `feedback-votes.ts:dismissVote` to accept `companyId` and add it to WHERE. Either approach works; route-level check is cheaper and matches existing pattern.
- Tests added in `server/src/__tests__/routes-feedback.test.ts` (extending the existing 4-test DELETE block at lines 309-345): cross-tenant DELETE returns 403; same-tenant DELETE still works.

---

### Finding 3 — Import body-size + Zod-array caps

**Verified.** `server/src/app.ts:164-170` mounts `express.json({ verify: ... })` with **no `limit` option**. Default is 100KB. Routes `POST /api/companies/import/preview` (`companies.ts:84`) and `POST /api/companies/import` (`:95`) accept legitimate company bundles that include `files: Record<string, string>` (per `packages/shared/src/validators/company-portability.ts:326`) — full file bodies inline, easily larger than 100KB. So either imports are silently 413-ing in real use or the global limit was raised somewhere off the audit's radar; recon did not find a per-route override.

**Depth.** Top-level schema is shape-bounded (no recursive types). But arrays have NO `.max()` length caps anywhere — `agents: [...10M items]` would parse and Zod-walk before any business logic.

**Threat.** Authenticated board user can OOM the server via 99KB of deeply-repeated array entries (CPU-bound Zod validation), or by bumping past 100KB if the import-route limit was raised. Cross-tenant DoS in shared `authenticated`/`cloud_auth`.

**Scope.**
- `server/src/app.ts:164` — keep the global `express.json` (with `verify` for plugin webhook HMAC). No change to the global limit (preserve compat with all current routes).
- Import-route-specific override: add `app.use("/api/companies/import", express.json({ limit: "20mb", verify: <same as global> }), ...)` mounted before the import routes. 20 MB is a defensible cap for a real export bundle (recon did not find a documented max-customer size; if a real customer breaks this, raise the cap with a changelog entry).
- `packages/shared/src/validators/company-portability.ts` — add `.max(N)` to each top-level array field on `portabilityManifestSchema`. Conservative caps: `agents: 1_000`, `projects: 1_000`, `issues: 50_000`, `goals: 1_000`, `costEvents: 100_000` (per the existing 10K warn threshold). Skills/routines/envInputs match Paperclip-bundle realistic sizes.
- Tests in `server/src/__tests__/company-portability-preview-export.test.ts`: payload over 20MB returns 413; payload with `agents: [...1001]` returns Zod error; payload at the cap succeeds.

**Open question.** The 20 MB cap — is there a real customer bundle bigger than that today? If yes, raise the cap; if not, ship at 20 MB and treat any future raise as a changelog entry.

---

### Finding 4 — Trust-proxy operator config knob

**Verified.** Zero `app.set("trust proxy", ...)` calls in `server/src/`. `server/src/config.ts` has no `trustProxy` field. The comment at `server/src/middleware/rate-limit.ts:13-19` correctly flags the gap.

**Threat.** Critical for cloud. Without an opt-in, deploying AoA behind any reverse proxy (Cloudflare, ALB, nginx) makes `req.ip` always the proxy's IP. Every rate limiter shipped in PR #156 (`signinLimiter` 10/min/IP, `cliAuthChallengeLimiter` 5/min/IP, etc.) collapses to one shared bucket — defenses are gone.

**Why an opt-in (not always-on).** `app.set("trust proxy", true)` without a real proxy in front lets an attacker spoof `X-Forwarded-For` from anywhere → bypass IP-keyed limits. We deliberately stayed conservative in #156. The fix is to put the operator in control with a documented env-var.

**Scope.**
- `server/src/config.ts:33-64` (Config interface) — add `trustProxy: boolean | number | string[];` field.
- `server/src/config.ts:66-241` (loadConfig) — parse `process.env.AOA_TRUST_PROXY` per Express's docs: `"true"` → boolean true, `"false"` → boolean false, integer → proxy hop count, comma-separated CIDRs → array. Default `false`.
- `server/src/app.ts:138` (after `const app = express()`) — `app.set("trust proxy", opts.trustProxy)`.
- `server/src/index.ts` (or wherever `createApp` is called) — pass `trustProxy: config.trustProxy` into opts.
- `docs/deploy/environment-variables.md` — document `AOA_TRUST_PROXY` with the standard Express semantics + a paragraph on when to set it (any reverse-proxy deployment). The brand-check CI gate enforces docs match code.
- `server/src/middleware/rate-limit.ts:13-19` — replace the comment with a one-liner pointing operators at `AOA_TRUST_PROXY`.
- Tests in `server/src/__tests__/rate-limit.test.ts` (extending existing pattern): with `trustProxy=true` and `X-Forwarded-For: 1.2.3.4`, `req.ip === "1.2.3.4"` and the limiter buckets by that IP. With `trustProxy=false` (default), `req.ip` ignores XFF.

**Note.** The MCP audit log at `server/src/mcp/server.ts:422` and access-events log at `server/src/routes/access.ts:1324` also read `req.ip` — they automatically benefit from the same knob; no separate change.

---

### Finding 6 — Better-auth `http://` origins in authenticated mode

**Verified at** `server/src/auth/better-auth.ts:91-112`, specifically lines 106-107: both `https://${trimmed}` and `http://${trimmed}` are unconditionally added for every `config.allowedHostnames` entry when `deploymentMode === "authenticated"`.

**Threat.** `trustedOrigins` governs origin validation for sensitive flows (sign-in, password reset, session bootstrap). The implicit `http://` entry means a downgrade attack landing the user on `http://example.com/...` (no TLS) is accepted as a trusted origin — credentialed flow proceeds with cookies in the clear.

**Scope.**
- `server/src/auth/better-auth.ts:106-107` — drop the `http://` add. Operators who need `http://` for testing can set `BETTER_AUTH_URL=http://...` via the explicit-base-url path (lines 95-100), which survives.
- Tests in `server/src/__tests__/better-auth-config.test.ts` (file already exists per PR #152): with `deploymentMode: "authenticated"` and `allowedHostnames: ["example.com"]`, `trustedOrigins` includes only `https://example.com` (and the explicit `BETTER_AUTH_URL` if set). With `deploymentMode: "local_trusted"`, both schemes can stay (loopback dev).

**Why local_trusted keeps both.** Loopback dev is the trust boundary; localhost over HTTP is normal there.

---

### Finding 7 — Agent-keys audit-log gap

**Verified, worse than originally claimed.** `server/src/routes/agents.ts:1266-1317`:
- GET `/agents/:id/keys` (line 1266): no log — read-only, expected.
- POST `/agents/:id/keys` (lines 1278-1299): logs `agent.key_created`, but uses old actor-shape (`actorType: "user", actorId: req.actor.userId ?? "board"`) instead of the canonical `...getActorInfo(req)` spread used by sibling routes.
- DELETE `/agents/:id/keys/:keyId` (lines 1301-1317): **no `logActivity` call at all**. Revocation is silent in the audit log.

Compare canonical pattern at `server/src/mcp/server.ts:332-377`: POST emits `mcp.api_key_created` + DELETE emits `mcp.api_key_revoked`, both with full `getActorInfo(req)` spread.

**Threat.** Audit-log gap on a sensitive operation. "When did this agent stop having access?" has no answer in the activity log today. For incident forensics that's load-bearing.

**Scope.**
- `server/src/routes/agents.ts:1278` (POST) — switch to `...getActorInfo(req)` spread for shape parity with MCP keys. Action stays `agent.key_created`.
- `server/src/routes/agents.ts:1315` (DELETE, after `await svc.revokeKey(...)`) — add `logActivity` emitting `agent.key_revoked` with `getActorInfo` spread + `details: { keyId, agentId, reason }`. Mirror MCP DELETE shape.
- Tests in `server/src/__tests__/agents-keys-routes.test.ts` (file exists, already mocks `logActivity` at line 82): assert POST emits `agent.key_created` with the canonical shape; assert DELETE emits `agent.key_revoked`.

---

## Dropped from scope (recon evidence)

### Finding 5 — Plugin static CORS wildcard

`server/src/routes/plugin-ui-static.ts:475` sets `Access-Control-Allow-Origin: *` on plugin static files. **Intentional design** per PLUGIN_SPEC §19.0.3. Confirmed: zero `Access-Control-Allow-Credentials` matches anywhere in `server/src/`, so the wildcard cannot send cookies cross-origin per Fetch spec. Files are public ESM bundles. **Skip.**

### Finding 8 — Secrets list `value` redaction regression test

Recon found `companySecrets` schema (`packages/db/src/schema/company_secrets.ts:5-25`) has **no `value` column**. Encrypted values live in `company_secret_versions`. The list endpoint can't leak `value` because it doesn't query that table. Test gap exists but the bug-class concern is inert until someone adds a `value` column. **Skip** — file as a tracked issue if you want a future regression guard.

### Finding 9 — `lastUsedAt` per-request write

**False positive on the original audit's claim.** `authSessions` schema (`packages/db/src/schema/auth.ts:17-26`) has **no `lastUsedAt` column** — the writes are on `boardApiKeys` / `mcpApiKeys` / `agentApiKeys`, only on Bearer-token paths (lines 108, 138, 191 of `server/src/middleware/auth.ts`). Cookie-based session auth doesn't trigger them. The "every authenticated request" framing was wrong. **Skip.**

---

## PR clusters

### PR S5-A — Transcribe path removal

**Closes Finding 1.**

**Files:**
- Modify: `server/src/routes/transcription.ts` → 501 stub
- Delete: `server/src/services/transcription.ts`
- Delete: `server/src/__tests__/transcription.test.ts`
- Modify: `ui/src/components/DiscussionCaptureModal.tsx:201` — handle 501 gracefully
- Modify: `ui/src/__tests__/DiscussionCaptureModal.test.tsx:59-61` — adjust mock
- Modify: `ui/src/__tests__/DiscussionDetail.test.tsx:125-127` — adjust mock
- Create: `server/src/__tests__/routes-transcription.test.ts` — assert 501 contract
- Create: `.changeset/security-transcription-deprecate-openai-path.md`

**Risk:** UI degradation. Mitigation: the 501 path renders as a disabled "voice not yet available" state with the rest of the modal intact. Existing tests already mock the API call, so test updates are one-line.

---

### PR S5-B — Cloud-readiness: body caps + trust-proxy knob

**Closes Findings 3 + 4.**

**Files:**
- Modify: `server/src/config.ts` — add `trustProxy` to Config + parse `AOA_TRUST_PROXY` in `loadConfig`
- Modify: `server/src/app.ts:138` — `app.set("trust proxy", opts.trustProxy)`
- Modify: `server/src/app.ts` (mount before companies routes) — per-route `express.json({ limit: "20mb" })` for `/api/companies/import` paths
- Modify: `server/src/index.ts` — pass `trustProxy: config.trustProxy` to `createApp` opts
- Modify: `packages/shared/src/validators/company-portability.ts:306-317` — `.max()` caps on each top-level array
- Modify: `server/src/middleware/rate-limit.ts:13-19` — replace WHY-NOT comment with pointer to env var
- Modify: `docs/deploy/environment-variables.md` — document `AOA_TRUST_PROXY`
- Modify: `server/src/__tests__/rate-limit.test.ts` — XFF + trust-proxy on/off tests
- Modify: `server/src/__tests__/company-portability-preview-export.test.ts` — 413 + array-cap tests
- Create: `.changeset/security-cloud-readiness-body-caps-trust-proxy.md`

**Risk:** wrong cap on `agents`/`issues`/etc. arrays could 400 a legitimate large customer's import. Mitigation: caps chosen above the existing 10K warn threshold for cost events; if a real bundle hits the cap, raise it with a changelog note (no security regression — caps are advisory DoS limits, not security boundaries).

---

### PR S5-C — Cross-tenant + audit hardening

**Closes Findings 2 + 6 + 7.**

**Files:**
- Modify: `server/src/routes/feedback.ts:166-175` — load vote, `assertCompanyAccess(req, vote.companyId)`, then dismiss
- Modify: `server/src/auth/better-auth.ts:106-107` — drop `http://` from `authenticated`-mode trustedOrigins
- Modify: `server/src/routes/agents.ts:1278-1299` — POST switches to `...getActorInfo(req)` spread
- Modify: `server/src/routes/agents.ts:1301-1317` — DELETE adds `logActivity("agent.key_revoked", ...)`
- Modify: `server/src/__tests__/routes-feedback.test.ts:309-345` — cross-tenant DELETE 403 test
- Modify: `server/src/__tests__/better-auth-config.test.ts` — `authenticated` mode trustedOrigins HTTPS-only
- Modify: `server/src/__tests__/agents-keys-routes.test.ts` — POST shape + DELETE log assertions
- Create: `.changeset/security-cross-tenant-audit-hardening.md`

**Risk:** the `http://` origin removal could break a test deployment that was using `http://hostname` for staging. Mitigation: the explicit `BETTER_AUTH_URL=http://...` opt-in still works for tests; document in changeset.

---

## Decision matrix

| Decision | Choice | Reason |
|---|---|---|
| Transcribe: 501 vs delete route entirely | 501 stub | UI keeps existing voice-input flow; degrade gracefully instead of breaking the modal mount |
| Body cap value | 20 MB | Above 10K cost-event warn threshold + array caps, below most LB defaults (50–100 MB) |
| Trust-proxy semantics | Express's standard (boolean/number/CIDR) | Matches Express docs operators already know |
| Better-auth http: kept in local_trusted | yes | Loopback dev is the trust boundary; localhost over HTTP is normal |
| Better-auth http: removed in authenticated | yes | TLS-terminating LB makes http: dead weight + downgrade-attack surface |
| Feedback DELETE: route-level vs service-level companyId | Route-level `assertCompanyAccess` | Matches existing pattern in same file (POST/GET); no new service signature |
| Agent-keys DELETE log: new action name | `agent.key_revoked` | Mirrors MCP `mcp.api_key_revoked` pattern |
| PR boundaries | 3 PRs along change-domain lines | Reviewable in 5 min each; no file overlap |

---

## Self-review

**Placeholder scan.** No "TBD", no "TODO", no vague phrases. Every fix names the file:line.

**Internal consistency.** All three PRs use existing helpers (`assertCompanyAccess`, `getActorInfo`, `loadConfig`); no PR introduces a pattern that conflicts with another. PR S5-B's `trustProxy` config plumbing matches the established Config interface shape; nothing is reinventing config loading.

**Scope check.** Six fixes across three small focused PRs. Each PR is a 1–2 hour subagent dispatch. Total work fits one sprint.

**Ambiguity check.** Two genuine open questions surfaced during recon:
1. PR S5-B 20 MB cap — is a real customer bundle bigger? Recon couldn't find data; ship at 20 MB and adjust if a bug report arrives.
2. PR S5-A — should the rate limiter `transcribeLimiter` be removed since the route is 501? **No** — limiter on a 501 still prevents flooding the route. Keep it.

**False-positive guard.** Three audit items dropped after recon:
- F5 (CORS wildcard) — by-design, no creds, low risk
- F8 (secrets list test) — schema lacks `value` column, no current leak
- F9 (lastUsedAt) — false positive on the audit's claim about session-table column

This is the kind of triage the Sprint 4 audit was missing. Doing it pre-spec catches three items that would have been wasted subagent dispatches.

---

## Out of scope (separately tracked)

- **C15 plugin sandbox** — user's separate plugins session
- **~30 plugin admin gap audit** — handed off in earlier prompt
- **Vectorization tier rollout** — product feature
- **Style-src hashes for dynamic Vite styles** (S4-G follow-up) — Vite emits dynamic `<style>` from lazy chunks at runtime, can't be enumerated at build time
- **COEP enabling** — needs external-asset audit
- **Redis-backed rate limit store** — needed only for multi-instance deploys
- **Plugin-loader cleanup-on-mismatch lockfile rollback** — not exploitable
- **Response-body redaction** — current routes don't echo back secrets
- **5 untagged Errors in outbound-url-guard** — taxonomy nice-to-have

---

## Next step

User reviews this spec. If approved, I write the implementation plan with TDD step quintets (writing-plans skill format) to `docs/superpowers/plans/2026-05-06-sprint-5-security-cleanup.md`, then dispatch subagent-driven implementation per the established pattern.
