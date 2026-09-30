# Handoff — MCP OAuth Connector Broker (PR #317)

> **Superseded 2026-08-03.** This document describes the original `1983ff1c6`
> baseline and is retained as historical evidence only. Its “ready to merge” and
> deferred multi-tenant statements are no longer current. Use
> `2026-08-02-pr317-oauth-broker-remediation-plan.md` and the final PR SHA/CI for
> implementation and release decisions.

**Date:** 2026-07-31 · **Status:** ✅ built, live-verified, CI-green, **MERGEABLE / not yet merged**

This is a self-contained handoff for another agent (or a fresh session). Everything you
need to pick up the work — where it lives, what shipped, what was reviewed, and what's
left — is below. **Read this whole file before touching anything.**

---

## 0. TL;DR

An **MCP OAuth connector broker** was built so AoA can use OAuth-only MCP connectors
(browser sign-in, no static token). v1 target = **Notion-hosted**. It's on a pushed
branch as **PR #317**, fully green on Linux CI, `mergeStateStatus: CLEAN`, and ready to
merge on the founder's go-ahead. Two pre-PR reviewers both said SHIP; the Codex bot did
**not** run (usage limit). One security follow-up (I1) is intentionally deferred to 1.1
and guard-commented in code. The single "real users can use it" gate is **producer-side**
(publish `connectors.json`) and is out of this PR's scope.

---

## 1. Coordinates (where everything is)

| Thing | Value |
|---|---|
| **Worktree** | `C:\Users\TK\.aoa\wt\mcp-connectors` (Windows) |
| **Branch** | `feat/connector-security-hardening` |
| **HEAD SHA** | `1983ff1c6db395c203f735464f573499320bcac8` |
| **PR** | https://github.com/MeteoriteLabs/AoA/pull/317 (base `main`) |
| **Repo (remote)** | `MeteoriteLabs/AoA` |
| **Size** | 51 commits ahead / 0 behind `main`; 29 files; +38.8k/−325 (the +33.8k is the auto-gen Drizzle snapshot, not code) |

**Docs already in the worktree (`docs/aoa/plans/`):**
- `2026-07-31-oauth-connector-broker-design.md` — the spec (brainstormed).
- `2026-07-31-oauth-connector-broker-implementation-plan.md` — 18-task TDD plan.
- `2026-07-25-plan3b-connector-catalog-publishing.md` — the **producer-side** `connectors.json` publish plan (follow-up #1 below).
- `mcp-connectors-followups.md` — running follow-up list for the whole connectors initiative.

**Persistent memory (this machine):**
`C:\Users\TK\.claude\projects\C--Users-TK-OneDrive-Desktop-Claude-Data-Paperclip-AoA-AoA-2-5\memory\`
- `oauth-connector-broker-plan.md` — the authoritative running state of THIS work.
- `mcp-connectors-initiative.md` — the broader connectors initiative (Decisions #110, FU list).
- `claude-mcp-header-delivery-verified.md` — proof claude 2.1.126 delivers the MCP bearer on tool calls (the runtime-delivery premise).

---

## 2. What was built (architecture)

**Discovery-first OAuth 2.1 + PKCE(S256):** RFC 9728 (protected-resource-metadata) →
RFC 8414 (AS metadata) → RFC 7591 dynamic client registration. Zero per-provider config
for spec-compliant servers. Verified live against `mcp.notion.com`.

**Install-then-authorize flow:**
1. Install the OAuth connector → status `needs_credentials`.
2. `POST …/mcp-connectors/:id/oauth/start` (founder-only) → discovery + DCR + PKCE, signs
   an HMAC `state`, inserts an `mcp_connector_oauth_flows` row, returns `authorizeUrl`.
3. Founder completes provider consent in the browser.
4. `GET …/mcp-connectors/oauth/callback` (company-agnostic, authenticated by signed
   `state` + flow row) → atomically claims the flow `pending→claimed`, exchanges the code,
   stores the token bundle, binds it to the connector via `updateIfStatus` → status `active`.

**Token storage:** the access/refresh bundle is the encrypted `value` of a
`company_secrets` row `mcp:<serverName>` — a JSON blob discriminated by `v:"aoa-oauth-1"`,
**not** new connector-table columns (preserves the two-writer invariant). Tokens never
touch logs or the connector row.

**Runtime delivery (one seam):** `loadEnabledConnectorRows` refreshes the bundle if the
access token is expired; the refreshed token becomes `row.secretValue`, and the existing
`buildConnectorSpecs` → `withSynthesizedBearerHeader` path delivers the bearer unchanged.
Refresh failure → connector flipped to `needs_credentials` + re-authorize prompt.

**Access model:** Commander gets all `active` connectors; crew/org agents get only ones
assigned via `company_mcp_connector_agents` (PUT `…/agents`).

### Key files (all under the worktree)

| File | Role |
|---|---|
| `packages/db/src/schema/mcp_connector_oauth_flows.ts` | New table (flow state). `started_by_user_id` is `text`, **no FK** (a `local-board` sentinel must not violate a users FK). |
| `packages/db/src/migrations/0188_narrow_blonde_phantom.sql` | Creates the table. **Must keep `IF NOT EXISTS`** (see §5). |
| `packages/shared/src/mcp-connector-catalog.ts` | Adds optional `oauth` block (`scopes` + reserved urls) + a `requiresOAuth && transport==="stdio"` ban. |
| `server/src/services/mcp-connector-oauth.ts` | Broker core: PKCE, state HMAC sign/verify (timing-safe, sig-before-expiry), discovery, DCR, authorize URL, exchange, refresh. https-only (`assertHttps`), 15s fetch timeouts. |
| `server/src/services/mcp-connector-oauth-bundle.ts` | Token-bundle codec (`encode/decode/isOAuthBundle/isBundleExpired`). |
| `server/src/services/mcp-connector-token-refresh.ts` | `resolveConnectorToken` + `doRefresh` + in-process single-flight + `OAuthRefreshError`. |
| `server/src/routes/mcp-connectors.ts` | `/oauth/start` (~L1186) + `/oauth/callback` (~L1296). Founder-gate, catalog+requiresOAuth guard, signing-secret fail-fast, atomic single-use claim + revert. |
| `server/src/services/mcp-connectors-loader.ts` | JIT refresh wired into the enabled-rows load; unions cleanly with main's emergency-policy (emergency filter runs BEFORE any refresh). |
| `ui/src/components/settings/NewConnectorDialog.tsx` | Add-connector modal (the `Bearer ${TOKEN}` header hint lives HERE now). |
| `ui/src/components/settings/sections/MCPConnectorsSection.tsx` | Enable / Re-authorize / Remove-confirm + per-connector access line. |
| `ui/src/pages/MarketplaceConnectors.tsx` | `?authorized=<name>` post-OAuth success notice. |
| `ui/src/components/marketplace/connectors/ConnectorShelf.tsx` | Authorize button on OAuth shelf cards. |

### Defining commits (newest first, excerpt)
```
1983ff1c6 fix(db): add IF NOT EXISTS to migration 0188 CREATE statements
5cb828432 fix(connectors): least-privilege OAuth scopes + document multi-tenant callback gap
74ad0ba4b feat(connectors): show per-connector access (Commander + N agents) in settings
a11fa142b feat(connectors): post-OAuth success notice on the marketplace connectors page
4e8bfadfb fix(connectors): clear error (not 500) when oauth/start lacks a signing secret
5398d76f5 feat(connectors): connector-management UX — Enable, Remove-confirm, Add-connector modal
b62d14333 fix(connectors): final-review follow-ups (re-authorize gate, callback bind-check, PRM https)
1ebfcf393 test(connectors): OAuth broker integration (real DB + mock AS)
d25c2a46b feat(connectors): JIT OAuth token refresh in the connector loader
e2d40fc76 feat(connectors): GET oauth/callback (exchange, store secret, bind connector)
92f5e5c39 feat(connectors): POST oauth/start route (discovery + DCR + PKCE + state)
1a4d4e324 Merge remote-tracking branch 'origin/main'   ← the main-sync merge
```

---

## 3. Merge context (what happened to sync with main)

The branch diverged at #301; `main` advanced to #313. `origin/main` was merged in
(commit `1a4d4e324`). **5 conflicts, all resolved:**
- `server/src/services/mcp-connectors-loader.ts` — **union** of this branch's OAuth
  JIT-refresh imports + main's emergency-policy imports/logic.
- `server/src/routes/mcp-connectors.ts` — kept this branch's OAuth imports.
- `server/src/services/__tests__/mcp-connectors-loader.test.ts` — union of the
  `updateIfStatus` spy + `vi.mock` + main's `isConnectorToolAutoAllowed` import + `afterEach`.
- `packages/db/src/migrations/meta/0185_snapshot.json` + `_journal.json` — took main's;
  **my colliding migration `0185` was renumbered to `0188`** by deleting it and re-running
  `pnpm db:generate` (main's latest is `0187_daily_liz_osborn`).
- One stale test repointed: the `Bearer ${TOKEN}` hint moved from `MCPConnectorsSection.tsx`
  → `NewConnectorDialog.tsx` during the UI refactor, so
  `mcp-connector-install-adversarial.test.ts` was updated to read the new file (invariant
  preserved, not made-to-pass).

**Post-merge gotcha:** main's Home-widget-board work added `react-grid-layout@2.2.3` to
`ui/package.json`. Run **`pnpm install`** after checking out this branch or `ui` typecheck
fails with `Cannot find module 'react-grid-layout'`.

---

## 4. Review status

- **Codex review bot did NOT run** — its only PR comment is *"You have reached your Codex
  usage limits for code reviews."* Consider re-triggering once the limit resets (this repo
  usually leans on Codex rounds). **No human reviews, no inline comments** on the PR.
- **Two pre-PR reviewer subagents — both returned SHIP:**
  - *Merge integrity + loader seam*: fully clean. Confirmed the emergency filter runs
    before any token refresh (a blocked connector never makes a network call), test
    integrity intact (18/18), migration renumber sequential + scoped.
  - *OAuth security surface*: no Critical. Two `Important`, both **multi-tenant-only** and
    unreachable in the v1 target (local_trusted / single-org):
    - **I2 — FIXED in `5cb828432`**: `/oauth/start` requested the AS's entire advertised
      scope set; now requests the connector's declared `oauth.scopes` (least-privilege),
      falling back to `scopesSupported` only when none declared (Notion path unchanged, as
      no published catalog entry declares scopes yet).
    - **I1 — TRACKED (guard-commented at the callback, `mcp-connectors.ts` ~L1296)**: the
      callback authenticates the *flow* but not the *session* completing it, so on a shared
      `cloud_auth` instance a hostile co-tenant could phish a victim into completing the
      attacker's flow (cross-account token injection). **Must be closed before enabling
      untrusted multi-tenant OAuth** — resolve the session actor on the callback and require
      it to match `flow.startedByUserId`, and derive company from the session.
  - Minor/tracked (not blocking): unbounded response-body reads on discovery/token/register;
    SSRF to private hosts via discovered endpoints (BYO rows already can't reach discovery —
    catalog-source gate); orphaned secret on a bind race; in-process-only refresh
    single-flight; orphaned DCR client on re-register.

The prior-history reviews (per memory): subagent-driven build (per-task spec + quality
review), a 4-lens adversarial pass (13 findings, all fixed), and a **live Notion E2E**.

---

## 5. CI journey (and one lesson)

1. First run: refused in 15s by a **transient** GitHub Actions **billing** state (a
   different PR ran full CI 3 min later → it self-cleared). Re-run went `queued`.
2. Second run: real suite ran; **1 failure** — `packages/db migration-idempotency.test.ts`.
   Root cause: the `0185→0188` `db:generate` regeneration emitted `CREATE TABLE/INDEX`
   **without `IF NOT EXISTS`**. The repo requires it on every non-grandfathered migration
   (the runner replays statements in one transaction; an unguarded `CREATE` on an existing
   object permanently wedges a DB). Convention: hand-edit the generated SQL to add
   `IF NOT EXISTS`; `ALTER TABLE … ADD CONSTRAINT` stays plain (see `0184_connectors.sql`).
3. Fix `1983ff1c6`: added the guards (table + 3 indexes). `db:generate` reports "No schema
   changes" (zero snapshot drift). Migration test 4/4.
4. Third run: **fully green** — all 8 checks SUCCESS (`verify`, `e2e`, `e2e-pgvector`,
   `migrations`, `policy`, `brand-check`, `changes`, `ci-required`).

> **Lesson (do this):** this branch class validates on **Linux CI**. Windows local skips
> the `skipIf(win32)` integration/e2e suites. Before declaring green, run the **full**
> `pnpm test:run` (all packages) — not just connector-scoped filters — or push to Linux CI.
> The migration test is a pure unit test that a full local run would have caught.

---

## 6. How to build / verify (Windows)

```bash
cd "C:/Users/TK/.aoa/wt/mcp-connectors"
pnpm install                 # REQUIRED post-merge (react-grid-layout)
pnpm -r typecheck            # repo-wide; currently clean
pnpm db:generate             # should say "No schema changes, nothing to migrate"
npx vitest run mcp-connector # connector unit/route/service suites (724 pass, integration skipIf-win32)
pnpm test:run                # FULL suite — run this before claiming green
```
- Integration/e2e (`*.integration.test.ts`) `skipIf(win32)` with
  `initdbFlags: ["--encoding=UTF8","--locale=C"]` — they run on Linux CI (the real gate).
- To force them locally on Windows: `AOA_E2E_FORCE_WINDOWS=1` (per repo convention).

---

## 7. How to run a live instance + test OAuth end-to-end

The broker was live-verified against **real Notion** on a booted `local_trusted` instance.

**Critical env:** `/oauth/start` signs `state` via `resolveConsentSecret()` (env-only:
`BETTER_AUTH_SECRET || AOA_AGENT_JWT_SECRET`). **Without one set, `/oauth/start` returns a
clear 400** (used to be an opaque 500 — fixed in `4e8bfadfb`). A founder who ran
`aoa onboard` already has the JWT secret. So export one before booting for OAuth testing.

**Live-test recipe (as performed):** boot the worktree instance in `local_trusted`, create
a fresh company, install the Notion-hosted OAuth catalog entry → `needs_credentials`, click
Authorize → `/oauth/start` runs discovery + DCR against `mcp.notion.com` → **the founder
completes the Notion consent in the browser themselves** → callback exchanges the code →
`mcp:notion-hosted` secret stored → status `active`.

> ⚠ **Credential-safety rule (still in force):** the agent must **never** enter the
> founder's Notion credentials / complete the provider sign-in. The human does the browser
> consent step. The agent only drives AoA's own UI/API.

**Test-instance / DB pointers (from session memory — verify before reuse, may be torn down):**
- Live OAuth test used `AOA_HOME=C:/Users/TK/.aoa/oaqa` (isolated test DB), a fresh company
  "OAuth Test Co". Instance ports churned during the session (`:3146` → `:3145`); a separate
  memory-enterprise instance was on `:3130`. **Don't assume any are still running** — re-boot
  fresh. See memory `memstep-instance-ops` / `qa-isolated-main-instance` for the isolated-boot
  recipe (detached worktree, worktree-local `.aoa/config.json` pinning PG dataDir+port, `PORT`).
- Windows deep-OneDrive worktrees can fail embedded-PG initdb at MAX_PATH — this worktree is
  already at a short path (`C:\Users\TK\.aoa\wt\...`) to avoid that.

---

## 8. Follow-ups (prioritized) — "the rest"

**Nothing blocks merging #317 for a self-hosted (local_trusted) Notion v1.** Remaining work:

### A. The actual "real users can use it" gate — PRODUCER SIDE, outside this PR
1. **Publish `connectors.json`** in the marketplace CDN repo
   (`meteoritelabs.github.io/aoa-marketplace-cdn`). The broker is the *runtime*; until the
   Notion-hosted OAuth entry is published in the catalog, the shelf is empty for real users
   — the live test used a **locally-injected** entry. Plan already written:
   `docs/aoa/plans/2026-07-25-plan3b-connector-catalog-publishing.md`. **Highest leverage.**

### B. Security / hardening (tracked; none block v1 self-hosted)
2. **I1 — multi-tenant callback session-binding** (the one real security item). Gates
   enabling OAuth on `cloud_auth` multi-tenant. Bind the callback to `flow.startedByUserId`
   + derive company from session. Guard comment is already at the callback.
3. Multi-process refresh lock (single-flight is in-process only → DB advisory lock).
4. Transient-vs-permanent refresh classification (any refresh error currently →
   `needs_credentials`, even a network blip).
5. `mcp_connector_oauth_flows` TTL sweeper (completed/failed rows accumulate).
6. Private-host / SSRF guard on discovery (deny-private-IP; BYO already can't reach discovery).
7. Declared-override path for non-DCR providers (Google / M365 don't do open registration).
8. Response-body size caps on the 3 outbound OAuth fetches.

### C. Process
9. **Re-trigger the Codex review** on #317 once the usage limit resets (it never ran).
10. Merge #317 (founder decision) → then start A/B.

---

## 9. Gotchas / decisions to not relitigate

- **Notion hosted MCP is OAuth-only** (no static token) — that's the whole reason for the
  broker. Notion *local* (`npx @notionhq/notion-mcp-server`) works with a static `ntn_`
  token today (different path).
- **CLAUDE.md Rule #11 (keyless-except-embeddings):** don't add hosted-API calls outside the
  embeddings chokepoint. The broker talks only to the connector's *own* OAuth AS, not a
  hosted LLM — compliant.
- **Two independent autonomy dials** (D18 split): `crewAutonomyLevel` (agent work) vs
  `autonomyLevel` (Commander). Not relevant to the broker but easy to trip on nearby.
- Migration numbering is **sequential + hand-`IF NOT EXISTS`-edited**. Never re-run
  `db:generate` on `0188` without re-adding the guards.
- The handoff doc itself is **uncommitted** in the worktree — commit it if you want it to
  travel with the branch.
