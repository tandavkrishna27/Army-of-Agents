# Upstream Paperclip → AoA Resync (Tier 1 + Tier 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull 23 verified-as-portable improvements from Paperclip releases `v2026.414.0`, `v2026.415.0`, `v2026.416.0`, and post-416 master (commit `c036bbfa`) into AoA-2.5 — closing the security/CVE gaps, landing the small UX wins, and adding the bounded backend additions that don't require an architecture change.

**Architecture:** Sequential branch `port/upstream-resync-2026-04-26` off `Porting1.1`, organized as 7 phases × 25 tasks (T1–T6, T6.5, T7–T24 + docs). Phase 1 is a critical batch (~30 min, ships as **one bundled commit**). Phases 2–7 are independent task units that ship as their own commits. Tasks are ordered by independence + risk, lightest first. Three migrations land in Phase 6 (numbered `0061`–`0063` to fit AoA's existing namespace). Three Paperclip items are explicitly **skipped** with documented rationale (C4 already-complete, D1 superseded by AoA's in-server MCP, D5 not applicable to AoA's adapter set).

**Plan-review pass landed 2026-04-26** — verified each task claim against AoA source-of-truth. Findings folded inline below: (a) several "additions" turned out to already exist in AoA and are now noted as confirmation steps, saving ~3 hr; (b) several import/file-path mismatches caught and corrected; (c) Phase 4 execution order changed (T15 now runs before T13 because T13's Bedrock support depends on T15's `metered_api` billing-type variant); (d) UI tasks got render tests; (e) migration tasks got round-trip rollback verification.

**Phase 1 execution (2026-04-26) found additional AoA-specific shapes that subsequent implementers should know:**
- `createApp` in `server/src/app.ts` requires a real `Db` instance + many mandatory `opts` fields. Tests that need to exercise route registration should mount routes directly on a fresh `express()` rather than bootstrapping the full app.
- `createLocalAgentJwt` and `verifyLocalAgentJwt` in `server/src/agent-auth-jwt.ts` are **positional + sync** — `(agentId: string, companyId: string, adapterType: string, runId: string) => string | null` and verify returns the decoded shape (sync, not Promise). Decoded claims use `sub` (the agent id), not `agentId` directly.
- The brand/token-check script is `scripts/check-forbidden-tokens.mjs` (NOT `scripts/brand-check.mjs`).

**Tech Stack:** TypeScript (server, UI, CLI), Vitest + `@testing-library/react`, Drizzle ORM (Postgres), pnpm workspaces, Express 5, Better-Auth, Radix UI, shadcn/ui, lucide-react.

---

## Cross-cutting context

**Source branch in fresh Paperclip:** `master` @ `c036bbfa` (working copy at `C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\paperclip-master\paperclip-master`). Fork point: `a0723777` = `v2026.403.0`.

**Rebrand rules (apply to every task):**
- `Issue` → `Task` in user-visible UI strings only. DB table stays `issues`. API routes stay `/issues`. Type names like `IssueAttachment` stay (internal).
- `Paperclip` → `AoA` in user-visible strings (banners, dialog copy, settings).
- `paperclip-*` plugin keys → `aoa-*` (with `mapLegacyPaperclipKey` fallback).
- `pcp_*` token prefixes → `aoa_*`.
- `PAPERCLIP_*` env vars stay as-is when they're cross-system protocol contracts (e.g., `PAPERCLIP_API_KEY`, `X-Paperclip-Run-Id` headers — these are wire-protocol fields with the Hermes adapter and external skill harness; renaming would break compat). For pure AoA-internal env vars (e.g., `AOA_AGENT_JWT_SECRET`), use the AoA name.

**Migration namespace:** AoA migrations currently end at `0060_aoa_sentinels.sql`. New migrations in this plan use `0061`, `0062`, `0063`. Paperclip's `0049–0070` collision is irrelevant — we author AoA-numbered migrations from scratch using Paperclip's SQL as a reference.

**Verified already-complete in AoA — no port needed (confirmed by review pass 2026-04-26):**
- **C4 — Adapter capability flags** (`supportsInstructionsBundle`, `instructionsPathKey`, `requiresMaterializedRuntimeSkills`). Already in `packages/adapter-utils/src/types.ts:220-262` and declared on every adapter in `server/src/adapters/registry.ts:70-166`.
- **D3 partial — `BUILTIN_ROUTINE_VARIABLE_NAMES`, `getBuiltinRoutineVariableValues()`** in `packages/shared/src/routine-variables.ts:6-16`. Only the schema migration + UI dialog parts of D3 remain (Task 11 below).
- **T10 partial — `extractRoutineVariableNames` and `syncRoutineVariablesWithTemplate`** already exist in `packages/shared/src/routine-variables.ts:27-58`. Task 10 reduced to UI-only work (was 90 min → now ~30 min).
- **T22 partial — `checkedOutByHarness: boolean`** already on `PaperclipWakePayload` at `packages/adapter-utils/src/server-utils.ts:443`. `normalizePaperclipWakePayload` exists (alias for `normalizeAoaWakePayload`) at line 566. Task 22 reduced to heartbeat-wiring + prompt-rendering only.
- **T23 partial — `BackupRetentionPolicy` interface + retention presets** (`DAILY/WEEKLY/MONTHLY_RETENTION_PRESETS`) already in `packages/shared/src/types/instance.ts:8-12` plus zod validator in `packages/shared/src/validators/instance.ts:19-23`. Task 23 reduced to backup-lib refactor + UI wire-up + un-hide.

**Explicitly skipped — out of scope:**
- **D1 — Standalone `@paperclipai/mcp-server` package.** AoA's in-server MCP at `server/src/mcp/server.ts` (31 tools, scoped, rate-limited) supersedes this. The standalone package is a stdio MCP→REST bridge for external clients connecting to a remote Paperclip; AoA's deployment model is local-first, so this package adds no v1.0 value. **Decision lock candidate** for `docs/aoa/reference/decisions.md`.
- **D5 — Skill bin/ PATH support** (Paperclip commit `854fa817`). Targets `pi-local` adapter, which AoA does not have (Sprint 2A removed API adapters; AoA's adapter set is `claude_local | opencode_local | openclaw | http | process | cursor | codex_local | hermes_local | gemini_local`). If skill helpers ever need PATH-prepending in AoA's adapters, revisit then.

---

## Test Strategy — how we know nothing broke

Every task ends with the same gates green for the file(s) it touched:

| Gate | Command |
|---|---|
| **Targeted test** | `pnpm --filter @armyofagents/server exec vitest run <file>` (or `@armyofagents/ui` / `@armyofagents/shared` equivalent) |
| **Typecheck** | `pnpm typecheck` |
| **Brand-check CI guards** | `pnpm exec node scripts/check-forbidden-tokens.mjs` |

After **all** tasks land, run the full suite once before opening the PR:

```sh
pnpm test:run            # unit + contract
pnpm test:e2e            # Playwright e2e
pnpm test:release-smoke  # auth + onboarding against built server
pnpm build               # all packages clean
```

**Rollback safety:** Each task is its own commit. Migrations are additive (no `DROP COLUMN`, no data backfill that can't be re-run). Reverting any single migration via `pnpm db:migrate:down` is safe up to the migration boundary.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `server/src/app.ts` | **Modify** | T1 — Express 5 wildcard syntax fix on better-auth route |
| `server/package.json` | **Modify** | T2 — Multer pin |
| `package.json` (root) | **Modify** | T3 — Rollup pnpm override |
| `server/src/agent-auth-jwt.ts` | **Modify** | T4 — `BETTER_AUTH_SECRET` fallback for JWT secret |
| `server/src/__tests__/agent-auth-jwt.test.ts` | **Modify** | T4 — fallback test case |
| `ui/index.html` | **Modify** | T5 — viewport meta tag a11y fix |
| `ui/src/pages/InstanceSettingsPage.tsx` | **Modify** | T6 — sign-out section in General tab |
| `ui/src/lib/keyboard-shortcuts-config.ts` | **Create** | T6.5 — single source of truth for shortcut definitions |
| `ui/src/components/KeyboardShortcutsCheatsheet.tsx` | **Create** | T7 — `?`-key cheatsheet dialog (consumes T6.5 config) |
| `ui/src/hooks/useKeyboardShortcuts.ts` | **Modify** | T6.5 — refactor to consume shared config; T7 — `?` listener |
| `ui/src/__tests__/KeyboardShortcutsCheatsheet.test.tsx` | **Create** | T7 — render test (`?` opens, sections render, Esc closes) |
| `ui/src/__tests__/InstanceSettingsPage-signout.test.tsx` | **Create** | T6 — render test (button clicks, signOut mutation fires) |
| `ui/src/__tests__/ImageGalleryModal.test.tsx` | **Create** | T8 — render test (arrow nav, escape, click-curtain) |
| `ui/src/__tests__/Inbox-nesting.test.tsx` | **Create** | T24 — render test (toggle, collapse/expand, j/k traversal) |
| `ui/src/components/ImageGalleryModal.tsx` | **Create** | T8 — image gallery modal |
| `ui/src/components/issue-detail/AttachmentsSection.tsx` (or equivalent) | **Modify** | T8 — wire gallery into task detail attachments |
| `packages/shared/src/types/routine.ts` | **Modify** | T9 — add `timezone` to `RoutineListItem.triggers` Pick |
| `server/src/services/routines.ts` | **Modify** | T9 — include `timezone` in trigger list response; T11 — runtime variable overrides |
| `packages/shared/src/routine-variables.ts` | **Modify** | T10 — add `extractRoutineVariableNames`, `syncRoutineVariablesWithTemplate` |
| `packages/shared/src/__tests__/routine-variables.test.ts` | **Create** | T10 — interpolation + extraction tests |
| `ui/src/pages/Routines.tsx` | **Modify** | T10 — render variable chips in routine titles; T11 — runtime override dialog launcher |
| `ui/src/pages/RoutineDetail.tsx` | **Modify** | T10 — variable preview |
| `ui/src/components/routines/RoutineRunVariablesDialog.tsx` | **Create** | T11 — runtime override dialog |
| `packages/db/src/migrations/0063_routine_draft_defaults.sql` | **Create** | T11 — drop NOT NULL on `routines.project_id` and `routines.assignee_agent_id` |
| `packages/db/src/schema/routines.ts` | **Modify** | T11 — relax `.notNull()` on those two columns |
| `packages/adapters/codex-local/src/index.ts` | **Modify** | T12 — `isCodexLocalFastModeSupported` + supported-models const |
| `packages/adapters/codex-local/src/server/codex-args.ts` | **Modify** | T12 — fast-mode flag injection |
| `ui/src/adapters/codex-local/config-fields.tsx` | **Modify** | T12 — `fastMode` boolean field |
| `packages/adapters/claude-local/src/server/execute.ts` | **Modify** | T13 — `isBedrockAuth` helper, billing-type + model-flag + biller routing |
| `packages/adapters/claude-local/src/server/test.ts` | **Modify** | T13 — Bedrock detection in environment test |
| `packages/adapters/claude-local/src/server/quota.ts` | **Modify** | T13 — Bedrock skips Anthropic quota |
| `ui/src/components/finance/ProviderQuotaCard.tsx` | **Modify** | T13 — add `aws_bedrock: "AWS Bedrock"` to inline `PROVIDER_LABELS` map (lines 12-17). NOT `ui/src/lib/utils.ts` — review pass confirmed no `providerDisplayName` util exists in AoA |
| `server/src/adapters/registry.ts` | **Modify** | T14 — Hermes JWT injection wrapper + command override normalization |
| `server/src/__tests__/adapter-registry.test.ts` | **Modify** | T14 — JWT injection + override tests |
| `ui/src/adapters/hermes-local/index.ts` | **Modify** | T14 — `hermesCommand` config field rename |
| `packages/adapter-utils/src/types.ts` | **Modify** | T15 — expand `AdapterBillingType` |
| `packages/shared/src/project-mentions.ts` | **Modify** | T16 — skill mention scheme + parsers |
| `packages/shared/src/__tests__/project-mentions.test.ts` | **Modify** | T16 — skill mention tests |
| `ui/src/context/EditorAutocompleteContext.tsx` | **Create** | T16 — slash-command autocomplete context |
| `ui/src/components/MarkdownEditor.tsx` | **Modify** | T16 — autocomplete provider integration |
| `ui/src/lib/mention-chips.ts` | **Modify** | T16 — render skill mention chips |
| `server/src/services/heartbeat.ts` | **Modify** | T17 — auto-enable mentioned skills; T20 — process group population; T22 — auto-checkout integration |
| `packages/db/src/migrations/0061_project_environment_variables.sql` | **Create** | T18 — `projects.env` JSONB column |
| `packages/db/src/schema/projects.ts` | **Modify** | T18 — add `env` field |
| `server/src/routes/projects.ts` | **Modify** | T18 — env var GET/PATCH endpoints |
| `ui/src/components/projects/ProjectEnvironmentSection.tsx` | **Create** | T18 — env editor UI |
| `packages/db/src/migrations/0062_heartbeat_liveness_and_watchdog.sql` | **Create** | T19 — heartbeat process tracking columns + watchdog decisions table |
| `packages/db/src/schema/heartbeat_runs.ts` | **Modify** | T19 — add 13 new columns |
| `packages/db/src/schema/heartbeat_run_watchdog_decisions.ts` | **Create** | T19 — new schema file |
| `packages/db/src/schema/index.ts` | **Modify** | T19 — re-export new schema |
| `server/src/services/heartbeat-watchdog.ts` | **Create** | T21 — stale-run sweeper |
| `server/src/index.ts` | **Modify** | T21 — register watchdog sweeper alongside TTL sweeper |
| `packages/adapter-utils/src/server-utils.ts` | **Modify** | T22 — add `checkedOutByHarness` to `PaperclipWakePayload` + prompt advisory |
| `packages/db/src/backup-lib.ts` | **Modify** | T23 — gzip pipeline + tiered pruning |
| `packages/shared/src/types/instance.ts` | **Modify** | T23 — `BackupRetentionPolicy` interface + presets |
| `packages/shared/src/validators/instance.ts` | **Modify** | T23 — schema for `backupRetention` |
| `server/src/services/instance-settings.ts` | **Modify** | T23 — new retention defaults |
| `ui/src/components/instance-settings/BackupsTab.tsx` | **Modify** | T23 — three-tier preset picker, un-hide tab |
| `ui/src/pages/InstanceSettingsPage.tsx` | **Modify** | T23 — re-add Backups tab to TABS array |
| `ui/src/components/IssuesList.tsx` | **Modify** | T24 — parent-child nesting render |
| `ui/src/lib/inbox.ts` | **Create** | T24 — nesting toggle helpers + collapse-state localStorage (review pass confirmed file does NOT exist yet) |
| `ui/src/pages/Inbox.tsx` | **Modify** | T24 — toggle button + j/k traversal across nested |
| `docs/aoa/reference/decisions.md` | **Modify** | Final task — Decision #92 (skip MCP package), #93 (skip pi-local PATH) |

---

## Phase 1 — Critical security & one-liners (~30 min, ship as one commit)

### Task 1: Express 5 wildcard syntax fix on better-auth route

**Why:** AoA is on Express 5 (per CLAUDE.md). Express 5 + path-to-regexp v8 dropped the `*paramName` syntax — the route silently 404s. This means **every `/api/auth/*` request returns 404**, breaking sign-in, session lookup, and password flows. AoA's `server/src/app.ts:152` still uses the broken syntax (currently masked by other middleware or not exercised in the test path that catches it). Paperclip fixed in commit `a8638619`.

**Files:**
- Modify: `server/src/app.ts` (line ~152)
- Create: `server/src/__tests__/express5-auth-wildcard.test.ts`

- [ ] **Step 1: Verify the bug exists in AoA**

Read `server/src/app.ts` and find the `app.all("/api/auth/*authPath", opts.betterAuthHandler)` line (around line 152). Confirm it uses the v4 syntax. If it already says `{*authPath}`, mark this task done.

- [ ] **Step 2: Write failing test**

Create `server/src/__tests__/express5-auth-wildcard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createApp } from "../app.js";

describe("Express 5 better-auth wildcard route", () => {
  it("matches /api/auth/sign-in/email (deep sub-path)", async () => {
    const handlerCalls: string[] = [];
    const app = await createApp({
      betterAuthHandler: (req, _res, next) => {
        handlerCalls.push(req.path);
        next();
      },
    } as any);
    await request(app).post("/api/auth/sign-in/email").send({ email: "x@y.z", password: "x" });
    expect(handlerCalls.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test — expect FAIL**

```sh
pnpm --filter @armyofagents/server exec vitest run src/__tests__/express5-auth-wildcard.test.ts
```

Expected: FAIL — handler not invoked because route doesn't match.

- [ ] **Step 4: Apply fix**

In `server/src/app.ts:152`, change `"/api/auth/*authPath"` → `"/api/auth/{*authPath}"`.

- [ ] **Step 5: Run test — expect PASS**

```sh
pnpm --filter @armyofagents/server exec vitest run src/__tests__/express5-auth-wildcard.test.ts
```

- [ ] **Step 6: Commit (will batch with Tasks 2-5)**

Hold commit until Phase 1 batch is ready. Stage but don't commit yet.

**Verification:** `curl http://localhost:5174/api/auth/sign-in/email` reaches `betterAuthHandler` (200 from handler), not 404.

**Effort:** 5 min  
**Dependencies:** none

---

### Task 2: Multer CVE bump (`^2.0.2` → `^2.1.1`)

**Why:** Multer `<2.1.0` has three HIGH-severity CVEs — GHSA-xf7r-hgr6-v32p (incomplete cleanup), GHSA-v52c-386h-88mc (crafted multipart), GHSA-2m88-8c7h-36gr (resource exhaustion). All three fixed in `2.1.1`. AoA's `server/package.json:57` is `"multer": "^2.0.2"`. No API surface changes between 2.0 and 2.1 — pure security patch.

**Files:**
- Modify: `server/package.json:57`
- Modify: `pnpm-lock.yaml` (auto)

- [ ] **Step 1: Bump version**

Edit `server/package.json` line 57: `"multer": "^2.0.2"` → `"multer": "^2.1.1"`.

- [ ] **Step 2: Lock**

```sh
pnpm install
```

- [ ] **Step 3: Verify**

```sh
pnpm list multer
```

Expected output includes `multer 2.1.1` (or higher patch). No code changes needed.

- [ ] **Step 4: Run upload-touching tests**

```sh
pnpm --filter @armyofagents/server exec vitest run --grep "upload|multer|attachment"
```

Expected: pass (or the same baseline as before — multer 2.1 is API-compatible with 2.0).

**Verification:** No test regression. `npm audit` no longer flags multer-related HIGH CVEs.

**Effort:** 2 min  
**Dependencies:** none

---

### Task 3: Rollup CVE pin (`>=4.59.0`)

**Why:** Rollup `<4.59.0` has a path-traversal CVE (GHSA-gcx4-mw62-g8wm). Paperclip pins via root-level `pnpm.overrides`. AoA's root `package.json:54-58` has `pnpm.patchedDependencies` but no `overrides` block.

**Files:**
- Modify: `package.json` (root, lines 54-58)

- [ ] **Step 1: Add override**

Edit root `package.json`, change the `pnpm` block to include an `overrides` field:

```json
"pnpm": {
  "patchedDependencies": {
    "embedded-postgres@18.1.0-beta.16": "patches/embedded-postgres@18.1.0-beta.16.patch"
  },
  "overrides": {
    "rollup": ">=4.59.0"
  }
}
```

- [ ] **Step 2: Lock**

```sh
pnpm install
```

- [ ] **Step 3: Verify**

```sh
pnpm list rollup -r
```

Expected: every rollup entry shows `4.59.0` or higher.

**Verification:** `pnpm-lock.yaml` shows rollup ≥ 4.59.0 transitively.

**Effort:** 3 min  
**Dependencies:** none

---

### Task 4: JWT secret `BETTER_AUTH_SECRET` fallback

**Why:** When `AOA_AGENT_JWT_SECRET` is unset but `BETTER_AUTH_SECRET` is set (a normal authenticated-mode deployment), local-adapter JWTs currently fail to mint. Paperclip PR #2866 adds the fallback. Resilience win for self-hosted.

**Files:**
- Modify: `server/src/agent-auth-jwt.ts:29` (or wherever the env read lives)
- Modify: `server/src/__tests__/agent-auth-jwt.test.ts`

- [ ] **Step 1: Read current state**

Open `server/src/agent-auth-jwt.ts` and find the line `const secret = process.env.AOA_AGENT_JWT_SECRET;` (~line 29).

- [ ] **Step 2: Write failing test**

Append to `server/src/__tests__/agent-auth-jwt.test.ts`:

```ts
describe("AOA_AGENT_JWT_SECRET fallback", () => {
  it("falls back to BETTER_AUTH_SECRET when AOA_AGENT_JWT_SECRET is unset", async () => {
    const prevAoa = process.env.AOA_AGENT_JWT_SECRET;
    const prevBetter = process.env.BETTER_AUTH_SECRET;
    delete process.env.AOA_AGENT_JWT_SECRET;
    process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-32chars";
    try {
      const token = await createLocalAgentJwt({ agentId: "a1", companyId: "c1", runId: "r1" });
      expect(token).toBeTruthy();
      const decoded = await verifyLocalAgentJwt(token);
      expect(decoded.agentId).toBe("a1");
    } finally {
      if (prevAoa !== undefined) process.env.AOA_AGENT_JWT_SECRET = prevAoa;
      if (prevBetter !== undefined) process.env.BETTER_AUTH_SECRET = prevBetter;
      else delete process.env.BETTER_AUTH_SECRET;
    }
  });

  it("trims whitespace from both env vars", async () => {
    const prevAoa = process.env.AOA_AGENT_JWT_SECRET;
    process.env.AOA_AGENT_JWT_SECRET = "  whitespace-secret-32chars-x  ";
    try {
      const token = await createLocalAgentJwt({ agentId: "a1", companyId: "c1", runId: "r1" });
      expect(token).toBeTruthy();
    } finally {
      if (prevAoa !== undefined) process.env.AOA_AGENT_JWT_SECRET = prevAoa;
      else delete process.env.AOA_AGENT_JWT_SECRET;
    }
  });
});
```

- [ ] **Step 3: Run test — expect FAIL on first case**

```sh
pnpm --filter @armyofagents/server exec vitest run src/__tests__/agent-auth-jwt.test.ts
```

- [ ] **Step 4: Apply fix**

In `server/src/agent-auth-jwt.ts:29`, change:

```ts
const secret = process.env.AOA_AGENT_JWT_SECRET;
```

to:

```ts
const secret = process.env.AOA_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
```

- [ ] **Step 5: Run test — expect PASS**

```sh
pnpm --filter @armyofagents/server exec vitest run src/__tests__/agent-auth-jwt.test.ts
```

**Verification:** Run server with only `BETTER_AUTH_SECRET` set; spawn a `claude_local` heartbeat; logs show JWT minted (no "secret missing or invalid" warning).

**Effort:** 10 min  
**Dependencies:** none

---

### Task 5: A11y viewport meta tag

**Why:** AoA's `ui/index.html:5` has `maximum-scale=1.0, user-scalable=no` — WCAG 2.1 SC 1.4.4 (Resize Text) violation. Modern Safari's auto-zoom on focused inputs is driven by font-size <16px, not viewport restriction, so the restriction is unnecessary. Paperclip removed in `6059c665`.

**Files:**
- Modify: `ui/index.html:5`

- [ ] **Step 1: Apply fix**

In `ui/index.html:5`, change:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
```

to:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

- [ ] **Step 2: Verify build**

```sh
pnpm --filter @armyofagents/ui build
```

Expected: clean build.

- [ ] **Step 3: Manual verification**

Open built UI on iOS or Chrome devtools mobile emulation, attempt pinch-zoom — should now scale beyond 100%.

- [ ] **Step 4: Commit Phase 1 batch**

```sh
git add server/src/app.ts server/package.json package.json server/src/agent-auth-jwt.ts \
        server/src/__tests__/agent-auth-jwt.test.ts \
        server/src/__tests__/express5-auth-wildcard.test.ts \
        ui/index.html pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
fix(security,a11y): Tier-1 upstream resync — Express 5 wildcard, JWT fallback, CVE bumps, viewport

- Express 5 better-auth wildcard syntax (a8638619 upstream)
- Multer ^2.0.2 → ^2.1.1 (3 HIGH CVEs)
- Rollup pnpm override >=4.59.0 (path-traversal CVE)
- JWT secret BETTER_AUTH_SECRET fallback (#2866 upstream)
- Viewport meta drops maximum-scale + user-scalable=no (#3726 upstream)

Refs: docs/superpowers/plans/2026-04-26-upstream-paperclip-resync.md (Tasks 1-5)
EOF
)"
```

**Verification:** Manual UA test. No automated test (CSS/HTML config only).

**Effort:** 2 min  
**Dependencies:** none

---

## Phase 2 — UI quickwins (~2 hr)

### Task 6: Sign-out button in Instance General Settings

**Why:** No way for an admin to sign out from the Instance Settings page. Paperclip added in `3d685335`. Drop-in copy with Paperclip→AoA string swap.

**Files:**
- Modify: `ui/src/pages/InstanceSettingsPage.tsx`

- [ ] **Step 1: Locate insertion point**

Read `ui/src/pages/InstanceSettingsPage.tsx`. Find the General tab's `<TabsContent value="general">` block. Identify the closing tag of the last existing section.

- [ ] **Step 2: Add imports**

At the top of the file, add (or augment existing imports):

```tsx
import { LogOut } from "lucide-react";
import { authApi } from "@/api/auth";
import { useMutation } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
```

- [ ] **Step 3: Add mutation inside the component**

After existing hooks, add:

```tsx
const [actionError, setActionError] = useState<string | null>(null); // if not already present
const signOutMutation = useMutation({
  mutationFn: () => authApi.signOut(),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
  },
  onError: (error) => {
    setActionError(error instanceof Error ? error.message : "Failed to sign out.");
  },
});
```

- [ ] **Step 4: Render the section**

Inside `<TabsContent value="general">`, before its closing tag, add:

```tsx
<section className="rounded-xl border border-border bg-card p-5">
  <div className="flex items-start justify-between gap-4">
    <div className="space-y-1.5">
      <h2 className="text-sm font-semibold">Sign out</h2>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Sign out of this AoA instance. You will be redirected to the login page.
      </p>
    </div>
    <Button
      variant="outline"
      size="sm"
      disabled={signOutMutation.isPending}
      onClick={() => signOutMutation.mutate()}
    >
      <LogOut className="size-4" />
      {signOutMutation.isPending ? "Signing out..." : "Sign out"}
    </Button>
  </div>
</section>
```

- [ ] **Step 5: Verify build + manual test**

```sh
pnpm --filter @armyofagents/ui build
pnpm typecheck
```

Then: open `/instance/settings`, General tab → see Sign out section → click → redirects to login.

- [ ] **Step 6: Commit**

```sh
git add ui/src/pages/InstanceSettingsPage.tsx
git commit -m "feat(settings): sign-out button in Instance General Settings"
```

**Verification:** Manual UI test passes; typecheck clean. Render test verifies button clicks trigger the mutation.

- [ ] **Step 7: Add render test**

Create `ui/src/__tests__/InstanceSettingsPage-signout.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InstanceSettingsPage } from "../pages/InstanceSettingsPage";
import * as authApi from "../api/auth";

it("Sign out button calls authApi.signOut on click", async () => {
  const signOutSpy = vi.spyOn(authApi.authApi, "signOut").mockResolvedValue(undefined);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InstanceSettingsPage />
    </QueryClientProvider>
  );
  // Switch to General tab if not default
  const button = await screen.findByRole("button", { name: /sign out/i });
  fireEvent.click(button);
  await waitFor(() => expect(signOutSpy).toHaveBeenCalled());
});
```

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/InstanceSettingsPage-signout.test.tsx` — expect PASS.

**Effort:** 15 min (+ 15 min for render test) = 30 min  
**Verified by review:** `authApi.signOut()` confirmed at `ui/src/api/auth.ts:71`. `queryKeys.auth.session` confirmed at `ui/src/lib/queryKeys.ts:84`. `LogOut` icon already imported in InstanceSettingsPage. `Button` import needs to be added.

**Dependencies:** none

---

### Task 6.5: Extract keyboard shortcut config to single source of truth

**Why:** Review pass found AoA's `useKeyboardShortcuts.ts` is just 42 lines hardcoding 3 shortcuts (Cmd+1..9, C, [). T7's cheatsheet needs to display the full shortcut catalog — but if T7 hardcodes its own list, the two will drift. Single source of truth required before T7.

**Files:**
- Create: `ui/src/lib/keyboard-shortcuts-config.ts`
- Modify: `ui/src/hooks/useKeyboardShortcuts.ts` (refactor to read from the new config)

- [ ] **Step 1: Create the config**

Create `ui/src/lib/keyboard-shortcuts-config.ts`:

```ts
export interface KeyboardShortcut {
  /** Key sequence to trigger. Examples: "?", "g i", "Cmd+1". */
  keys: string[];
  /** User-visible label in cheatsheet. */
  description: string;
  /** Group in cheatsheet — use "Inbox" / "Task detail" / "Global". */
  section: "Inbox" | "Task detail" | "Global";
  /** Identifier for the handler. Maps to runtime callbacks in the hook. */
  id: string;
}

export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  // Inbox
  { id: "inbox.next", keys: ["j"], description: "Next item", section: "Inbox" },
  { id: "inbox.prev", keys: ["k"], description: "Previous item", section: "Inbox" },
  { id: "inbox.archive", keys: ["a"], description: "Archive", section: "Inbox" },
  { id: "inbox.archive_undo", keys: ["y"], description: "Archive (z to undo)", section: "Inbox" },
  { id: "inbox.undo", keys: ["z"], description: "Undo last archive", section: "Inbox" },
  { id: "inbox.read", keys: ["r"], description: "Mark as read", section: "Inbox" },
  { id: "inbox.unread", keys: ["U"], description: "Mark as unread", section: "Inbox" },
  { id: "inbox.open", keys: ["Enter"], description: "Open task", section: "Inbox" },
  // Task detail
  { id: "task.go_inbox", keys: ["g", "i"], description: "Go to Inbox", section: "Task detail" },
  { id: "task.focus_composer", keys: ["g", "c"], description: "Focus comment composer", section: "Task detail" },
  // Global
  { id: "global.search", keys: ["/"], description: "Search", section: "Global" },
  { id: "global.new_task", keys: ["c"], description: "New task", section: "Global" },
  { id: "global.toggle_sidebar", keys: ["["], description: "Toggle sidebar", section: "Global" },
  { id: "global.toggle_panel", keys: ["]"], description: "Toggle right panel", section: "Global" },
  { id: "global.cheatsheet", keys: ["?"], description: "Show keyboard shortcuts", section: "Global" },
];

export function isKeyboardShortcutTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}
```

- [ ] **Step 2: Refactor useKeyboardShortcuts.ts to consume config**

Update `ui/src/hooks/useKeyboardShortcuts.ts` to:
- Import `KEYBOARD_SHORTCUTS` and `isKeyboardShortcutTextInputTarget`
- Accept a `handlers: Partial<Record<ShortcutId, () => void>>` parameter where ShortcutId is derived from `KEYBOARD_SHORTCUTS[i].id`
- Internally match keydown events against the config and dispatch to handlers
- Preserve existing behavior for the 3 already-handled shortcuts (Cmd+1..9, C, [) by mapping them to the new IDs

The exact refactor pattern depends on the existing hook signature; preserve all current callers.

- [ ] **Step 3: Verify existing shortcut behavior unchanged**

```sh
pnpm --filter @armyofagents/ui build
pnpm typecheck
```

Manually exercise the 3 existing shortcuts (Cmd+1..9 nav, C new task, [ toggle sidebar) — confirm still working.

- [ ] **Step 4: Commit**

```sh
git add ui/src/lib/keyboard-shortcuts-config.ts ui/src/hooks/useKeyboardShortcuts.ts
git commit -m "refactor(ui): extract keyboard shortcuts to single-source-of-truth config (prep for T7 cheatsheet)"
```

**Verification:** Existing shortcuts still work; typecheck clean; new config exports `KEYBOARD_SHORTCUTS` and helper.

**Effort:** 20 min  
**Dependencies:** none. T7 depends on this.

---

### Task 7: Keyboard shortcut cheatsheet (`?` key)

**Why:** Power users need a visible reference for keyboard shortcuts. Paperclip PR #2772 added a Radix Dialog showing all shortcuts grouped by section, triggered by `?` outside text-input fields.

**Files:**
- Create: `ui/src/components/KeyboardShortcutsCheatsheet.tsx`
- Modify: `ui/src/hooks/useKeyboardShortcuts.ts` (add `?` listener — config already extracted in T6.5)
- Modify: `ui/src/components/Layout.tsx` (or wherever the global shortcut listener lives)
- Create: `ui/src/__tests__/KeyboardShortcutsCheatsheet.test.tsx`

- [ ] **Step 1: Create the component**

Create `ui/src/components/KeyboardShortcutsCheatsheet.tsx` (consumes `KEYBOARD_SHORTCUTS` config from T6.5):

```tsx
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { KEYBOARD_SHORTCUTS, type KeyboardShortcut } from "@/lib/keyboard-shortcuts-config";

const SECTION_ORDER: KeyboardShortcut["section"][] = ["Inbox", "Task detail", "Global"];

function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-lg">
          <div className="flex items-center justify-between pb-4">
            <Dialog.Title className="text-lg font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-muted-foreground hover:bg-accent">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Reference of keyboard shortcuts available in AoA.
          </Dialog.Description>
          <div className="space-y-6">
            {SECTION_ORDER.map((sectionTitle) => {
              const items = KEYBOARD_SHORTCUTS.filter((s) => s.section === sectionTitle);
              if (items.length === 0) return null;
              return (
                <div key={sectionTitle}>
                  <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{sectionTitle}</h3>
                  <ul className="space-y-1.5">
                    {items.map((s) => (
                      <li key={s.id} className="flex items-center justify-between text-sm">
                        <span>{s.description}</span>
                        <span className="flex gap-1">
                          {s.keys.map((k, i) => (
                            <KeyCap key={i}>{k}</KeyCap>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 2: Wire `?` listener**

In `ui/src/hooks/useKeyboardShortcuts.ts`, find the existing global keydown handler. Add (alongside existing shortcuts):

```ts
// Inside the existing useEffect / handleKeydown:
if (event.key === "?" && !isKeyboardShortcutTextInputTarget(event.target)) {
  event.preventDefault();
  setCheatsheetOpen(true);
}
```

If `setCheatsheetOpen` doesn't yet exist, lift it from the consumer. Simplest approach: add a `cheatsheetOpen` state to a top-level context (e.g., `ShortcutsContext`) so any component can subscribe.

- [ ] **Step 3: Render in Layout**

In `ui/src/components/Layout.tsx`, import and render:

```tsx
import { KeyboardShortcutsCheatsheet } from "./KeyboardShortcutsCheatsheet";
// ...
const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
// ...
<KeyboardShortcutsCheatsheet open={cheatsheetOpen} onOpenChange={setCheatsheetOpen} />
```

Pass `setCheatsheetOpen` to the keyboard hook.

- [ ] **Step 4: Manual test**

Run dev server. Press `?` outside an input → modal opens. Press Esc → closes. Click in textarea, press `?` → typed literally, no modal.

- [ ] **Step 5: Render test**

Create `ui/src/__tests__/KeyboardShortcutsCheatsheet.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KeyboardShortcutsCheatsheet } from "../components/KeyboardShortcutsCheatsheet";

it("renders sections in order with all shortcuts", () => {
  render(<KeyboardShortcutsCheatsheet open onOpenChange={() => {}} />);
  expect(screen.getByText("Inbox")).toBeInTheDocument();
  expect(screen.getByText("Task detail")).toBeInTheDocument();
  expect(screen.getByText("Global")).toBeInTheDocument();
  // Sanity: a known shortcut renders
  expect(screen.getByText("New task")).toBeInTheDocument();
});

it("does not render when open=false", () => {
  render(<KeyboardShortcutsCheatsheet open={false} onOpenChange={() => {}} />);
  expect(screen.queryByText("Inbox")).not.toBeInTheDocument();
});
```

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/KeyboardShortcutsCheatsheet.test.tsx` — expect PASS.

- [ ] **Step 6: Commit**

```sh
git add ui/src/components/KeyboardShortcutsCheatsheet.tsx ui/src/hooks/useKeyboardShortcuts.ts ui/src/components/Layout.tsx ui/src/__tests__/KeyboardShortcutsCheatsheet.test.tsx
git commit -m "feat(ui): keyboard shortcut cheatsheet on ? keypress (#2772 upstream)"
```

**Verification:** Manual UI test; render test passes; cheatsheet shows correct shortcuts; typecheck clean.

**Effort:** 45 min (+ 15 min for render test) = 60 min  
**Dependencies:** **T6.5** (consumes `KEYBOARD_SHORTCUTS` config). Radix Dialog primitive.

---

### Task 8: Image gallery modal in chat

**Why:** Click an image in a task comment → fullscreen gallery with arrow nav, instead of just inline. Paperclip added `ImageGalleryModal.tsx` in commit `d0920da4`.

**Review-pass corrections:**
- AoA's `IssueAttachment` uses `contentPath`, **not** `url` (`packages/shared/src/types/issue.ts:113-129`). Fields: `id`, `contentType`, `originalFilename`, `contentPath`.
- AoA renders attachments in **`ui/src/components/TaskSlideOver.tsx:195`**, not a separate `AttachmentsSection.tsx`. Look for the `isImageAttachment` check (`attachment.contentType.startsWith("image/")`) — that's the wire-in point.

**Files:**
- Create: `ui/src/components/ImageGalleryModal.tsx`
- Modify: `ui/src/components/TaskSlideOver.tsx` (~line 195, where image attachments render)
- Create: `ui/src/__tests__/ImageGalleryModal.test.tsx`

- [ ] **Step 1: Create the modal component**

Create `ui/src/components/ImageGalleryModal.tsx`:

```tsx
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { IssueAttachment } from "@armyofagents/shared";

interface Props {
  images: IssueAttachment[];
  initialIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImageGalleryModal({ images, initialIndex, open, onOpenChange }: Props) {
  const [index, setIndex] = useState(initialIndex);

  useEffect(() => {
    if (open) setIndex(initialIndex);
  }, [open, initialIndex]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setIndex((i) => (i + 1) % images.length);
      else if (e.key === "ArrowLeft") setIndex((i) => (i - 1 + images.length) % images.length);
      else if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, images.length, onOpenChange]);

  if (images.length === 0) return null;
  const current = images[index];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/90" onClick={() => onOpenChange(false)} />
        <Dialog.Content className="fixed inset-0 z-50 flex flex-col" onClick={(e) => e.stopPropagation()}>
          <Dialog.Title className="sr-only">{current.originalFilename}</Dialog.Title>
          <Dialog.Description className="sr-only">Image {index + 1} of {images.length}</Dialog.Description>
          <div className="flex items-center justify-between bg-black/60 px-4 py-2 text-white">
            <span className="text-sm">
              {current.originalFilename} <span className="text-white/60">({index + 1} / {images.length})</span>
            </span>
            <div className="flex items-center gap-2">
              <a
                href={current.contentPath}
                download={current.originalFilename}
                className="rounded p-1 hover:bg-white/10"
                onClick={(e) => e.stopPropagation()}
              >
                <Download className="size-4" />
              </a>
              <button onClick={() => onOpenChange(false)} className="rounded p-1 hover:bg-white/10">
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="relative flex flex-1 items-center justify-center" onClick={() => onOpenChange(false)}>
            <button
              className="absolute left-4 rounded bg-black/60 p-2 text-white hover:bg-black/80"
              onClick={(e) => { e.stopPropagation(); setIndex((i) => (i - 1 + images.length) % images.length); }}
            >
              <ChevronLeft className="size-6" />
            </button>
            <img
              src={current.contentPath}
              alt={current.originalFilename}
              className="max-h-full max-w-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              className="absolute right-4 rounded bg-black/60 p-2 text-white hover:bg-black/80"
              onClick={(e) => { e.stopPropagation(); setIndex((i) => (i + 1) % images.length); }}
            >
              <ChevronRight className="size-6" />
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 2: Open AoA's task-attachment renderer**

Open `ui/src/components/TaskSlideOver.tsx` and find the section around line 195 that uses `isImageAttachment` (`attachment.contentType.startsWith("image/")`). That's where image attachments currently render. Note the surrounding component structure.

- [ ] **Step 3: Wire gallery into TaskSlideOver**

In `TaskSlideOver.tsx`, near the existing attachment-rendering section, add state:

```tsx
const [galleryOpen, setGalleryOpen] = useState(false);
const [galleryInitialIndex, setGalleryInitialIndex] = useState(0);
const imageAttachments = useMemo(
  () => attachments.filter((a) => a.contentType?.startsWith("image/")),
  [attachments]
);
```

Where each image renders, wrap in a clickable button that calls:

```tsx
onClick={() => {
  setGalleryInitialIndex(imageAttachments.findIndex((img) => img.id === attachment.id));
  setGalleryOpen(true);
}}
```

At the bottom of the component (before the closing tag), render:

```tsx
<ImageGalleryModal
  images={imageAttachments}
  initialIndex={galleryInitialIndex}
  open={galleryOpen}
  onOpenChange={setGalleryOpen}
/>
```

- [ ] **Step 4: Manual test**

Upload 3 images to a task. Click any → modal opens at correct index. Arrow keys navigate. Escape/curtain closes. Download works.

- [ ] **Step 5: Render test**

Create `ui/src/__tests__/ImageGalleryModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ImageGalleryModal } from "../components/ImageGalleryModal";

const mockImages = [
  { id: "1", contentType: "image/png", originalFilename: "first.png", contentPath: "/blobs/1" },
  { id: "2", contentType: "image/jpeg", originalFilename: "second.jpg", contentPath: "/blobs/2" },
  { id: "3", contentType: "image/gif", originalFilename: "third.gif", contentPath: "/blobs/3" },
] as any;

it("renders initial image and advances on ArrowRight", () => {
  render(<ImageGalleryModal images={mockImages} initialIndex={0} open onOpenChange={() => {}} />);
  expect(screen.getByText(/first\.png/)).toBeInTheDocument();
  expect(screen.getByText(/\(1 \/ 3\)/)).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(screen.getByText(/second\.jpg/)).toBeInTheDocument();
});

it("calls onOpenChange(false) on Escape", () => {
  const onOpenChange = vi.fn();
  render(<ImageGalleryModal images={mockImages} initialIndex={0} open onOpenChange={onOpenChange} />);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("wraps around at last image", () => {
  render(<ImageGalleryModal images={mockImages} initialIndex={2} open onOpenChange={() => {}} />);
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(screen.getByText(/first\.png/)).toBeInTheDocument();
});
```

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/ImageGalleryModal.test.tsx` — expect PASS.

- [ ] **Step 6: Commit**

```sh
git add ui/src/components/ImageGalleryModal.tsx ui/src/components/TaskSlideOver.tsx ui/src/__tests__/ImageGalleryModal.test.tsx
git commit -m "feat(ui): image gallery modal for task attachments (d0920da4 upstream)"
```

**Verification:** Manual UI test + render test; typecheck clean.

**Effort:** 60 min (+ 15 min for render test) = 75 min  
**Dependencies:** Radix Dialog, lucide-react icons

---

## Phase 3 — Routine improvements (~3.75 hr)

### Task 9: Routine cron+timezone in list trigger response

**Why:** AoA's `RoutineListItem.triggers` Pick currently includes `id|kind|label|enabled|cronExpression|nextRunAt` but **not** `timezone`. UI cannot display the configured timezone for cron triggers in routine list view. Paperclip fixed in `d0a8d4e0`.

**Files:**
- Modify: `packages/shared/src/types/routine.ts:101`
- Modify: `server/src/services/routines.ts` (list endpoint)
- Modify: `server/src/__tests__/routines-routes-contract.test.ts`

- [ ] **Step 1: Verify current state**

Read `packages/shared/src/types/routine.ts:101` and confirm `triggers: Pick<RoutineTrigger, ...>[]` is missing `"timezone"`.

- [ ] **Step 2: Write failing test**

In `server/src/__tests__/routines-routes-contract.test.ts`, add:

```ts
it("includes timezone in trigger response", async () => {
  const routine = await createTestRoutine({ trigger: { kind: "cron", cronExpression: "0 9 * * 1", timezone: "America/New_York" } });
  const list = await routinesService.list({ companyId: routine.companyId });
  const found = list.find((r) => r.id === routine.id);
  expect(found?.triggers[0]).toMatchObject({
    cronExpression: "0 9 * * 1",
    timezone: "America/New_York",
  });
});
```

- [ ] **Step 3: Run test — expect FAIL**

```sh
pnpm --filter @armyofagents/server exec vitest run src/__tests__/routines-routes-contract.test.ts
```

- [ ] **Step 4: Update Pick type**

In `packages/shared/src/types/routine.ts:101`, change:

```ts
triggers: Pick<RoutineTrigger, "id" | "kind" | "label" | "enabled" | "cronExpression" | "nextRunAt">[];
```

to:

```ts
triggers: Pick<RoutineTrigger, "id" | "kind" | "label" | "enabled" | "cronExpression" | "timezone" | "nextRunAt">[];
```

- [ ] **Step 5: Update service mapping**

In `server/src/services/routines.ts`, find the `list()` function. Inside the trigger mapping, add `timezone: trigger.timezone` to the returned object.

- [ ] **Step 6: Run test — expect PASS**

```sh
pnpm --filter @armyofagents/server exec vitest run src/__tests__/routines-routes-contract.test.ts
pnpm typecheck
```

- [ ] **Step 7: Commit**

```sh
git add packages/shared/src/types/routine.ts server/src/services/routines.ts server/src/__tests__/routines-routes-contract.test.ts
git commit -m "fix(routines): include timezone in list trigger response (d0a8d4e0 upstream)"
```

**Verification:** GET `/api/companies/:cid/routines` returns triggers with `timezone` populated.

**Effort:** 15 min  
**Dependencies:** none

---

### Task 10: Routine variables in titles

**Why:** Routine titles like `"Deploy {{environment}} on {{date}}"` should interpolate variables. **Review pass found that `extractRoutineVariableNames` (lines 27-38) and `syncRoutineVariablesWithTemplate` (lines 51-58) already exist in AoA's `packages/shared/src/routine-variables.ts`** alongside the builtin handling. Task 10 is therefore **UI-only** — render variable chips in routine titles. Paperclip's matching commit is `1de5fb93`.

**Files:**
- Verify (no edit expected): `packages/shared/src/routine-variables.ts`
- Verify (extend if missing): `packages/shared/src/__tests__/routine-variables.test.ts`
- Modify: `packages/shared/src/index.ts` (confirm exports surfaced from barrel)
- Modify: `ui/src/pages/Routines.tsx`
- Modify: `ui/src/pages/RoutineDetail.tsx`

- [ ] **Step 1: Verify shared layer is complete**

Read `packages/shared/src/routine-variables.ts`. Confirm presence of:
- `extractRoutineVariableNames(template: string): string[]`
- `syncRoutineVariablesWithTemplate(current, template)`
- `BUILTIN_ROUTINE_VARIABLE_NAMES`, `isBuiltinRoutineVariable`, `getBuiltinRoutineVariableValues`

Confirm `packages/shared/src/index.ts` re-exports `routine-variables`.

If a `RoutineVariableSpec` interface is missing (review pass noted it may not exist), add it:

```ts
export interface RoutineVariableSpec {
  name: string;
  defaultValue: string;
  label?: string;
  required?: boolean;
}
```

- [ ] **Step 2: Verify or add tests**

Search for an existing test file. If absent, create `packages/shared/src/__tests__/routine-variables.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  extractRoutineVariableNames,
  syncRoutineVariablesWithTemplate,
  isBuiltinRoutineVariable,
} from "../routine-variables";

describe("extractRoutineVariableNames", () => {
  it("extracts simple {{var}} patterns", () => {
    expect(extractRoutineVariableNames("Deploy {{environment}}")).toEqual(["environment"]);
  });

  it("dedupes repeats", () => {
    expect(extractRoutineVariableNames("{{x}} and {{x}} and {{y}}")).toEqual(["x", "y"]);
  });

  it("ignores builtin date", () => {
    // built-ins are NOT excluded by extract — they're filtered downstream by sync
    expect(extractRoutineVariableNames("Run on {{date}}")).toEqual(["date"]);
  });

  it("handles spaces inside braces", () => {
    expect(extractRoutineVariableNames("Hello {{ name }}")).toEqual(["name"]);
  });
});

describe("syncRoutineVariablesWithTemplate", () => {
  it("adds new variables found in template", () => {
    const result = syncRoutineVariablesWithTemplate(
      [{ name: "old", defaultValue: "" }],
      "{{old}} and {{new}}"
    );
    expect(result.map((v) => v.name).sort()).toEqual(["new", "old"]);
  });

  it("filters out builtin variables", () => {
    const result = syncRoutineVariablesWithTemplate([], "Run on {{date}}");
    expect(result.find((v) => v.name === "date")).toBeUndefined();
  });

  it("removes variables no longer in template", () => {
    const result = syncRoutineVariablesWithTemplate(
      [{ name: "stale", defaultValue: "" }, { name: "kept", defaultValue: "" }],
      "{{kept}}"
    );
    expect(result.map((v) => v.name)).toEqual(["kept"]);
  });
});
```

- [ ] **Step 3: Run tests — expect PASS**

```sh
pnpm --filter @armyofagents/shared exec vitest run src/__tests__/routine-variables.test.ts
```

If they pass, the shared layer is good — proceed to UI work. If anything fails (e.g. `RoutineVariableSpec` missing), fix in `routine-variables.ts` to make tests pass before moving on.

- [ ] **Step 4: UI rendering — variable chips in title**

In `ui/src/pages/Routines.tsx` (and `RoutineDetail.tsx`), where routine titles render, replace plain title rendering with chip-augmented rendering:

```tsx
function RoutineTitle({ template }: { template: string }) {
  const vars = extractRoutineVariableNames(template);
  if (vars.length === 0) return <>{template}</>;
  // Split template on {{var}} boundaries
  const parts = template.split(/(\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\})/g);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {parts.map((part, i) => {
        const m = part.match(/^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/);
        if (m) return (
          <span key={i} className="inline-flex items-center rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
            {m[1]}
          </span>
        );
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}
```

- [ ] **Step 5: Manual test**

Create routine titled `"Deploy {{environment}} on {{date}}"`. Verify chips render in Routines list and detail.

- [ ] **Step 6: Commit**

```sh
git add packages/shared/src/routine-variables.ts packages/shared/src/__tests__/routine-variables.test.ts ui/src/pages/Routines.tsx ui/src/pages/RoutineDetail.tsx
git commit -m "feat(routines): render variable chips in titles (1de5fb93 upstream)"
```

**Verification:** Test suite green; chips render in UI.

**Effort:** ~30 min (shared layer already done; UI-only work)  
**Dependencies:** none

---

### Task 11: Routine draft defaults + run-time overrides

**Why:** Allow saving incomplete routines (no project / no assignee yet) and overriding variable values at dispatch. Paperclip PR #3220 / commit `5d021583`. AoA's shared layer is partially done; missing: schema migration to drop NOT NULL on `project_id` + `assignee_agent_id`, and the runtime override dialog.

**Files:**
- Create: `packages/db/src/migrations/0063_routine_draft_defaults.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `packages/db/src/schema/routines.ts`
- Modify: `server/src/services/routines.ts` (run endpoint accepts `variables` overrides)
- Create: `ui/src/components/routines/RoutineRunVariablesDialog.tsx`
- Modify: `ui/src/pages/Routines.tsx` (or RoutineDetail) — wire the dialog before run dispatch

- [ ] **Step 1: Create migration**

Create `packages/db/src/migrations/0063_routine_draft_defaults.sql`:

```sql
ALTER TABLE "routines" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "routines" ALTER COLUMN "assignee_agent_id" DROP NOT NULL;
```

- [ ] **Step 2: Update journal**

Add corresponding entry in `packages/db/src/migrations/meta/_journal.json` (mirror format of the previous entry).

- [ ] **Step 3: Update schema**

In `packages/db/src/schema/routines.ts`, change `projectId` and `assigneeAgentId` from `.notNull()` to plain (nullable). Update the TypeScript type accordingly.

- [ ] **Step 4: Run db:generate to verify Drizzle accepts**

```sh
pnpm --filter @armyofagents/db db:generate
```

- [ ] **Step 5: Update service to accept runtime variable overrides**

In `server/src/services/routines.ts`, find the `runRoutine()` (or `dispatchRoutine`) function. Add a `variableOverrides?: Record<string, string>` parameter. Merge with stored defaults before interpolation. Validate that overridden vars exist in the routine's variable list (reject unknown names).

- [ ] **Step 6: Create RoutineRunVariablesDialog**

Create `ui/src/components/routines/RoutineRunVariablesDialog.tsx`:

```tsx
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RoutineVariableSpec } from "@armyofagents/shared";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variables: RoutineVariableSpec[];
  onConfirm: (overrides: Record<string, string>) => void;
}

export function RoutineRunVariablesDialog({ open, onOpenChange, variables, onConfirm }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(variables.map((v) => [v.name, v.defaultValue]))
  );

  const handleSubmit = () => {
    onConfirm(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run routine</DialogTitle>
          <DialogDescription>
            Set values for this run. Defaults are pre-filled; override any field.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {variables.length === 0 ? (
            <p className="text-sm text-muted-foreground">This routine has no variables.</p>
          ) : (
            variables.map((v) => (
              <div key={v.name} className="space-y-1.5">
                <Label htmlFor={`var-${v.name}`}>
                  {v.label ?? v.name}
                  {v.required ? <span className="text-destructive"> *</span> : null}
                </Label>
                <Input
                  id={`var-${v.name}`}
                  value={values[v.name] ?? ""}
                  onChange={(e) => setValues((s) => ({ ...s, [v.name]: e.target.value }))}
                />
              </div>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit}>Run</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 7: Wire into Routines page**

In the routine "Run" button handler, open the dialog instead of dispatching directly. On `onConfirm`, call the existing dispatch mutation with `variableOverrides` payload.

- [ ] **Step 8: Migrate test DB and verify down/up round-trip**

```sh
pnpm --filter @armyofagents/db db:migrate                # apply 0063
pnpm --filter @armyofagents/db db:migrate:down --to=0062 # roll back
pnpm --filter @armyofagents/db db:migrate                # re-apply
pnpm typecheck
```

If down-migration is not supported by AoA's drizzle config, skip the rollback step but flag it for the engineer to verify the SQL `ALTER COLUMN ... DROP NOT NULL` is reversible by pgsql alone (`ALTER COLUMN ... SET NOT NULL` works only if no NULL rows exist).

- [ ] **Step 9: Manual test**

Create a draft routine (skip project assignment). Save → success. Add a variable `environment`. Run → dialog opens → set `environment=prod` → submit → routine dispatches with `prod`.

- [ ] **Step 10: Commit**

```sh
git add packages/db/src/migrations/0063_routine_draft_defaults.sql packages/db/src/migrations/meta/_journal.json packages/db/src/schema/routines.ts server/src/services/routines.ts ui/src/components/routines/RoutineRunVariablesDialog.tsx ui/src/pages/Routines.tsx
git commit -m "feat(routines): draft defaults + run-time variable overrides (#3220 upstream)"
```

**Verification:** Migration applies cleanly. Draft routines save with null project. Run dialog overrides defaults at dispatch.

**Effort:** 120 min  
**Dependencies:** Task 10 (variable extraction)

---

## Phase 4 — Adapter improvements (~4 hr)

> **Execution order in this phase: T12 → T15 → T13 → T14.** T13 (Bedrock) needs the `metered_api` variant from T15. Doc order below matches execution order; task numbering is preserved for stable references.

### Task 12: Codex fast mode

**Why:** Codex local adapter on GPT-5.4 supports a `service_tier=fast` execution path that returns lower-latency results. Paperclip PR #3383 / commit `2d8f97fe`. Drop-in feature flag — no breaking changes.

**Files:**
- Modify: `packages/adapters/codex-local/src/index.ts`
- Modify: `packages/adapters/codex-local/src/server/codex-args.ts`
- Modify: `ui/src/adapters/codex-local/config-fields.tsx`

- [ ] **Step 1: Add supported-models export**

In `packages/adapters/codex-local/src/index.ts`, add:

```ts
export const CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS = ["gpt-5.4"] as const;

export function isCodexLocalFastModeSupported(model: string | null | undefined): boolean {
  if (!model) return false;
  return (CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS as readonly string[]).includes(model);
}
```

- [ ] **Step 2: Document in agent-config doc**

In the same file, find `agentConfigurationDoc` (the human-readable config schema string). Append:

```
- fastMode (boolean, optional): enable Codex Fast mode; currently supported on GPT-5.4 only and consumes credits faster.
```

- [ ] **Step 3: Apply flag in codex args**

In `packages/adapters/codex-local/src/server/codex-args.ts`, find `buildCodexExecArgs()`. Add to the returned shape:

```ts
const fastModeRequested = asBoolean(record.fastMode, false);
const fastModeApplied = fastModeRequested && isCodexLocalFastModeSupported(model);
const fastModeIgnoredReason = fastModeRequested && !fastModeApplied
  ? `currently only supported on ${CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.join(", ")}`
  : null;

if (fastModeApplied) {
  args.push("-c", 'service_tier="fast"');
  args.push("-c", "features.fast_mode=true");
}

return { args, fastModeRequested, fastModeApplied, fastModeIgnoredReason };
```

(Adjust the existing return shape to include the new fields. Update the call sites in `execute.ts` to read the new fields and emit a log warning when `fastModeIgnoredReason` is set.)

- [ ] **Step 4: Add UI config field**

In `ui/src/adapters/codex-local/config-fields.tsx`, add a `fastMode` boolean checkbox. Label: "Fast mode (GPT-5.4 only)". Help text: "Use Codex Fast tier for lower latency. Consumes credits faster."

- [ ] **Step 5: Add a test**

Create or extend `packages/adapters/codex-local/__tests__/codex-args.test.ts`:

```ts
it("appends service_tier=fast when fastMode + gpt-5.4", () => {
  const result = buildCodexExecArgs({ model: "gpt-5.4", fastMode: true });
  expect(result.args).toContain('service_tier="fast"');
  expect(result.fastModeApplied).toBe(true);
});

it("ignores fastMode on unsupported model", () => {
  const result = buildCodexExecArgs({ model: "gpt-4o", fastMode: true });
  expect(result.args).not.toContain('service_tier="fast"');
  expect(result.fastModeApplied).toBe(false);
  expect(result.fastModeIgnoredReason).toMatch(/gpt-5.4/);
});
```

- [ ] **Step 6: Test + typecheck**

```sh
pnpm --filter @armyofagents/codex-local-adapter exec vitest run
pnpm typecheck
```

- [ ] **Step 7: Commit**

```sh
git add packages/adapters/codex-local ui/src/adapters/codex-local/config-fields.tsx
git commit -m "feat(codex-local): fast mode support on gpt-5.4 (#3383 upstream)"
```

**Verification:** Create codex_local agent on gpt-5.4 with fastMode=true → run → CLI args include `service_tier="fast"`. Switch to gpt-4o → fast mode silently ignored, log warning emitted.

**Effort:** 45 min  
**Dependencies:** none

---

### Task 13: AWS Bedrock auth on claude-local

> **MUST RUN AFTER T15** — relies on T15's `metered_api` billing-type variant.

**Why:** Customers running Claude on AWS Bedrock can't use AoA's claude-local adapter today — it always assumes Anthropic API or subscription. Paperclip PR #2793 / commit `b6e40fec` adds env-based detection: when `CLAUDE_CODE_USE_BEDROCK=1` (or `ANTHROPIC_BEDROCK_BASE_URL` is set), skip Anthropic auth, skip `--model` flag (Bedrock model IDs differ), set `biller=aws_bedrock`, billing-type `metered_api`, skip Anthropic quota probe.

**Review-pass corrections (verified by reading `packages/adapters/claude-local/src/server/execute.ts` 2026-04-26):**
- AoA's claude-local **does** have `resolveClaudeBillingType()` (line 127) and `hasNonEmptyEnvValue()` helpers — names match Paperclip. ✓
- AoA imports differ: uses `buildAoaEnv` (not `buildPaperclipEnv`) at line 14, `redactEnvForLogs` (not `buildInvocationEnvForLogs`) at line 15. **Use AoA's import names.**
- AoA's claude-local has **no separate `quota.ts` file** — quota logic must be located via grep (probably inline in `execute.ts` or imported from elsewhere). The Bedrock-skip-quota change goes wherever the quota check actually lives.
- AoA's claude-local-internal env vars are `AOA_API_KEY`, `AOA_RUN_ID`, `AOA_TASK_ID`, etc. (per `execute.ts:155-200`). **Do not rename `PAPERCLIP_API_KEY` for claude-local** — it's already not used here. Only Hermes uses `PAPERCLIP_API_KEY` (T14, wire-protocol contract).
- AoA's UI provider-label map is **inline** in `ui/src/components/finance/ProviderQuotaCard.tsx:12-17` (`PROVIDER_LABELS` const), **not** `ui/src/lib/utils.ts`. There is no `providerDisplayName()` util.

**Files:**
- Modify: `packages/adapters/claude-local/src/server/execute.ts`
- Modify: `packages/adapters/claude-local/src/server/test.ts`
- Modify: wherever the existing claude-local quota check lives (locate via `grep -rn "ANTHROPIC_API_KEY" packages/adapters/claude-local/src/`)
- Modify: `ui/src/components/finance/ProviderQuotaCard.tsx` (add `aws_bedrock: "AWS Bedrock"` to `PROVIDER_LABELS`)
- Create: `packages/adapters/claude-local/__tests__/bedrock.test.ts`

- [ ] **Step 1: Add `isBedrockAuth` helper**

In `packages/adapters/claude-local/src/server/execute.ts`, add near other helpers:

```ts
function isBedrockAuth(env: Record<string, string | undefined>): boolean {
  if (env.CLAUDE_CODE_USE_BEDROCK === "1" || env.CLAUDE_CODE_USE_BEDROCK === "true") return true;
  if ((env.ANTHROPIC_BEDROCK_BASE_URL ?? "").trim() !== "") return true;
  return false;
}
```

- [ ] **Step 2: Update billing-type resolver**

Find `resolveClaudeBillingType()` at `execute.ts:127`. Current implementation:

```ts
function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}
```

Update return type and body (depends on T15's `metered_api` variant):

```ts
function resolveClaudeBillingType(env: Record<string, string>): AdapterBillingType {
  if (isBedrockAuth(env)) return "metered_api";
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}
```

- [ ] **Step 3: Skip --model when Bedrock**

In `buildClaudeArgs()`, where `--model` is appended, wrap in:

```ts
if (model && !isBedrockAuth(effectiveEnv)) {
  args.push("--model", model);
}
```

- [ ] **Step 4: Set biller in result**

Where `toAdapterResult()` constructs the return value with `biller`:

```ts
biller: isBedrockAuth(effectiveEnv) ? "aws_bedrock" : "anthropic",
```

- [ ] **Step 5: Update environment test message**

In `packages/adapters/claude-local/src/server/test.ts`, before the API-key / subscription branches, check `isBedrockAuth(env)` and return a result with message: `"AWS Bedrock auth detected. Claude will use Bedrock for inference."`.

- [ ] **Step 6: Skip Anthropic quota probe**

Locate the existing quota check in claude-local. Run:

```sh
grep -rn "ANTHROPIC_API_KEY\|quota" packages/adapters/claude-local/src/
```

Likely candidates: a function exported from `execute.ts` or `index.ts`. At the top of that function, add:

```ts
if (isBedrockAuth(env)) return { ok: true, windows: [] };
```

If no quota-checking function exists for claude-local in AoA today, skip this step (Bedrock will already work) and add a TODO comment noting that quota probe is not currently wired for claude-local.

- [ ] **Step 7: Add display name in `PROVIDER_LABELS` map**

In `ui/src/components/finance/ProviderQuotaCard.tsx:12-17`, find the `PROVIDER_LABELS` map. Add:

```ts
const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  // ...existing entries...
  aws_bedrock: "AWS Bedrock",  // ← new
} as const;
```

Update the const type assertion if it's strictly typed.

- [ ] **Step 8: Tests**

Create `packages/adapters/claude-local/__tests__/bedrock.test.ts`:

```ts
describe("Bedrock auth detection", () => {
  it("detects CLAUDE_CODE_USE_BEDROCK=1", () => {
    expect(isBedrockAuth({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
  });
  it("detects ANTHROPIC_BEDROCK_BASE_URL", () => {
    expect(isBedrockAuth({ ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.us-east-1.amazonaws.com" })).toBe(true);
  });
  it("returns false for empty env", () => {
    expect(isBedrockAuth({})).toBe(false);
  });
});
```

- [ ] **Step 9: Test + typecheck + commit**

```sh
pnpm --filter @armyofagents/claude-local-adapter exec vitest run
pnpm typecheck
git add packages/adapters/claude-local ui/src/components/finance/ProviderQuotaCard.tsx
git commit -m "feat(claude-local): AWS Bedrock auth support (#2793 upstream)"
```

**Verification:** With `CLAUDE_CODE_USE_BEDROCK=1` in agent env → environment test passes with Bedrock message; heartbeat emits CLI without `--model`; result has `biller="aws_bedrock"`.

**Effort:** 60 min  
**Dependencies:** **T15** (needs `metered_api` variant on `AdapterBillingType`).

---

### Task 14: Hermes JWT injection + session mgmt + command override

**Why:** AoA's `hermes_local` adapter needs (a) the agent's JWT injected into Hermes's env so its API calls back to AoA carry agent identity (not board), (b) session codec for history, (c) `hermesCommand` config field instead of generic `command`. Paperclip's three commits: `8d0c3d2f`, `acfd7c26`, `1bf24243`.

**Files:**
- Modify: `server/src/adapters/registry.ts:158-166` (hermes adapter wrapper)
- Modify: `server/src/__tests__/adapter-registry.test.ts`
- Modify: `ui/src/adapters/hermes-local/index.ts`

- [ ] **Step 1: Read current state**

Open `server/src/adapters/registry.ts` around line 158. Confirm hermes is registered as a thin pass-through:

```ts
const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: hermesExecute,
  ...
};
```

- [ ] **Step 2: Wrap execute with JWT + run-id injection**

Replace the `execute: hermesExecute` line with:

```ts
execute: async (ctx) => {
  const adapterConfig = parseObject(ctx.config) as Record<string, unknown>;
  const env = (adapterConfig.env as Record<string, string> | undefined) ?? {};

  // Inject agent JWT if not explicitly configured (wire-protocol contract: PAPERCLIP_API_KEY)
  if (ctx.authToken && !asString(env.PAPERCLIP_API_KEY, "").trim()) {
    adapterConfig.env = { ...env, PAPERCLIP_API_KEY: ctx.authToken, PAPERCLIP_RUN_ID: ctx.runId };
  } else {
    adapterConfig.env = { ...env, PAPERCLIP_RUN_ID: ctx.runId };
  }

  // Honor hermesCommand override; fall back to legacy "command" field for back-compat
  const hermesCommand = asString(
    adapterConfig.hermesCommand ?? adapterConfig.command,
    "hermes"
  );
  adapterConfig.hermesCommand = hermesCommand;

  return hermesExecute({ ...ctx, config: adapterConfig });
},
```

- [ ] **Step 3: Verify session codec is registered**

Confirm `sessionCodec: hermesSessionCodec` is already in the adapter declaration. If not, add it. (Check that `hermesSessionCodec` is exported from `hermes-paperclip-adapter/server`.)

- [ ] **Step 4: UI config field rename**

In `ui/src/adapters/hermes-local/index.ts`, find the config form schema. Replace any `command` field with `hermesCommand`. Keep label "Hermes command" with help text "Path or name of the Hermes binary. Defaults to `hermes`."

- [ ] **Step 5: Tests**

In `server/src/__tests__/adapter-registry.test.ts`, add:

```ts
describe("hermes_local execute wrapper", () => {
  it("injects PAPERCLIP_API_KEY from ctx.authToken when env doesn't set it", async () => {
    const captured: any = {};
    vi.mocked(hermesExecute).mockImplementation(async (ctx) => {
      captured.config = ctx.config;
      return { exitCode: 0, transcript: "" };
    });
    await hermesLocalAdapter.execute({ ctx: { authToken: "tok-xyz", runId: "r-1", config: {} } } as any);
    expect((captured.config as any).env.PAPERCLIP_API_KEY).toBe("tok-xyz");
    expect((captured.config as any).env.PAPERCLIP_RUN_ID).toBe("r-1");
  });

  it("preserves explicit PAPERCLIP_API_KEY", async () => {
    const captured: any = {};
    vi.mocked(hermesExecute).mockImplementation(async (ctx) => { captured.config = ctx.config; return { exitCode: 0, transcript: "" }; });
    await hermesLocalAdapter.execute({ authToken: "tok-xyz", runId: "r-1", config: { env: { PAPERCLIP_API_KEY: "explicit" } } } as any);
    expect((captured.config as any).env.PAPERCLIP_API_KEY).toBe("explicit");
  });

  it("normalizes hermesCommand from legacy command field", async () => {
    const captured: any = {};
    vi.mocked(hermesExecute).mockImplementation(async (ctx) => { captured.config = ctx.config; return { exitCode: 0, transcript: "" }; });
    await hermesLocalAdapter.execute({ authToken: null, runId: "r-1", config: { command: "/custom/hermes" } } as any);
    expect((captured.config as any).hermesCommand).toBe("/custom/hermes");
  });
});
```

- [ ] **Step 6: Test + typecheck + commit**

```sh
pnpm --filter @armyofagents/server exec vitest run src/__tests__/adapter-registry.test.ts
pnpm typecheck
git add server/src/adapters/registry.ts server/src/__tests__/adapter-registry.test.ts ui/src/adapters/hermes-local/index.ts
git commit -m "feat(hermes): JWT injection + run-id env + hermesCommand override (8d0c3d2f, 1bf24243 upstream)"
```

**Verification:** Spawn hermes_local heartbeat with `authToken` set → confirm Hermes child env has `PAPERCLIP_API_KEY`. API mutations from Hermes attribute to the agent (not board user).

**Effort:** 90 min  
**Dependencies:** `hermes-paperclip-adapter` external package exports `hermesSessionCodec` (verify)  
**Note:** `PAPERCLIP_API_KEY` and `PAPERCLIP_RUN_ID` are wire-protocol contracts with the external Hermes adapter — keep the names `PAPERCLIP_*`. AoA-internal env vars (e.g. `AOA_AGENT_JWT_SECRET`) use the AoA prefix.

---

### Task 15: Enhanced `AdapterBillingType` + caller audit

> **Run BEFORE T13** — T13's Bedrock support depends on the new `metered_api` variant landing here.

**Why:** Paperclip expanded `AdapterBillingType` from `"api" | "subscription" | "unknown"` to 8 variants. AoA's `packages/adapter-utils/src/types.ts:33` is still the 3-variant version. Adopting the full 8-variant set keeps AoA's adapter-utils types in lockstep with upstream so future re-ports remain trivial diffs. Review pass found 28 callers of `billingType` across `server/src` and `ui/src`; audit is mostly mechanical (display strings, default cost-calc arms).

**Files:**
- Modify: `packages/adapter-utils/src/types.ts:33`
- Modify: any file that switches on `billingType` (audit step finds these)

- [ ] **Step 1: Expand the type**

Edit `packages/adapter-utils/src/types.ts:33`:

```ts
export type AdapterBillingType =
  | "api"
  | "subscription"
  | "metered_api"
  | "subscription_included"
  | "subscription_overage"
  | "credits"
  | "fixed"
  | "unknown";
```

- [ ] **Step 2: Audit callers**

```sh
grep -rn "billingType" --include="*.ts" --include="*.tsx" server/src ui/src packages/
```

Review pass measured **28 references** across the AoA codebase. Inspect each hit. Categorize:
- **Type-only references** (assignments, prop pass-through) → no change needed; type expansion is structurally compatible.
- **Switches with cases for `"api"` / `"subscription"` / `"unknown"`** → add explicit cases for the 5 new variants OR add a `default` arm that maps to a sensible fallback. **Avoid silent default-to-unknown** for variants we know are coming (especially `metered_api`).
- **Cost calculations** that multiply by adapter-specific rates → ensure new variants have a defined rate (or fall back to existing API-style billing).

- [ ] **Step 3: Apply human-label and cost-fallback rules**

Apply consistently across all callers:

**Display strings (human labels):**
| Variant | Label |
|---|---|
| `api` | "API" |
| `subscription` | "Subscription" |
| `metered_api` | "Metered API" |
| `subscription_included` | "Subscription (included)" |
| `subscription_overage` | "Subscription (overage)" |
| `credits` | "Credits" |
| `fixed` | "Fixed fee" |
| `unknown` | "Unknown" |

**Cost-calc fallback rules:**
- `metered_api` → treat like `api` (per-call rate)
- `subscription_included` → treat like `subscription` (no incremental cost; covered by base subscription)
- `subscription_overage` → treat like `api` (per-call rate kicks in past cap)
- `credits` → defer to `costEvents` records (do not infer; the adapter must emit the cents)
- `fixed` → defer to `costEvents` (literal price recorded by adapter)

If a caller's existing logic doesn't cleanly fit, prefer the **defer-to-costEvents** path over inferring.

- [ ] **Step 4: Test + typecheck**

```sh
pnpm typecheck
pnpm --filter @armyofagents/server exec vitest run --grep "billing|cost"
```

- [ ] **Step 5: Commit**

```sh
git add packages/adapter-utils/src/types.ts <each file modified>
git commit -m "refactor(types): expand AdapterBillingType + handle new variants in callers"
```

**Verification:** Typecheck clean (no exhaustive-switch errors). Cost UI displays the new variants. Adapters returning new variants don't crash. Pass `pnpm test:run --grep "billing|cost"` to ensure no regression.

**Effort:** ~60 min (mostly the audit pass)  
**Dependencies:** none. **T13 (Bedrock) blocks on this** — must land first.

---

## Phase 5 — Skills (~3 hr)

### Task 16: Skill slash-command autocomplete

**Why:** Typing `/skillname` in the markdown editor should show a filtered list of company skills, click → inserts a `[name](skill://skillId?s=slug)` mention. Paperclip commit `94d4a01b`.

**Files:**
- Modify: `packages/shared/src/project-mentions.ts` (add skill scheme + parsers)
- Modify: `packages/shared/src/__tests__/project-mentions.test.ts`
- Create: `ui/src/context/EditorAutocompleteContext.tsx`
- Modify: `ui/src/components/MarkdownEditor.tsx`
- Modify: `ui/src/lib/mention-chips.ts` (skill chip rendering)

- [ ] **Step 1: Add skill scheme to shared**

In `packages/shared/src/project-mentions.ts`, append:

```ts
export const SKILL_MENTION_SCHEME = "skill://";
const SKILL_MENTION_LINK_RE = /skill:\/\/([0-9a-f-]+)(?:\?s=([a-z0-9-]+))?/gi;
const SKILL_SLUG_RE = /^[a-z0-9-]+$/i;

export function buildSkillMentionHref(skillId: string, slug?: string): string {
  const base = `${SKILL_MENTION_SCHEME}${skillId}`;
  return slug ? `${base}?s=${slug}` : base;
}

export function parseSkillMentionHref(href: string): { skillId: string; slug: string | null } | null {
  const m = href.match(/^skill:\/\/([0-9a-f-]+)(?:\?s=([a-z0-9-]+))?$/i);
  if (!m) return null;
  return { skillId: m[1], slug: m[2] ?? null };
}

export function extractSkillMentionIds(markdown: string): string[] {
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  SKILL_MENTION_LINK_RE.lastIndex = 0;
  while ((m = SKILL_MENTION_LINK_RE.exec(markdown)) !== null) ids.add(m[1]);
  return [...ids];
}

export function normalizeSkillSlug(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}
```

- [ ] **Step 2: Test the parsers**

In `packages/shared/src/__tests__/project-mentions.test.ts`, add:

```ts
describe("skill mentions", () => {
  it("builds and parses href round-trip", () => {
    const href = buildSkillMentionHref("abc-123", "my-skill");
    expect(parseSkillMentionHref(href)).toEqual({ skillId: "abc-123", slug: "my-skill" });
  });

  it("extracts skill IDs from markdown", () => {
    const md = "see [my skill](skill://abc-123?s=my-skill) and [other](skill://def-456)";
    expect(extractSkillMentionIds(md).sort()).toEqual(["abc-123", "def-456"]);
  });

  it("normalizes slugs", () => {
    expect(normalizeSkillSlug("My Cool Skill!")).toBe("my-cool-skill");
  });
});
```

- [ ] **Step 3: Run shared tests — expect PASS**

```sh
pnpm --filter @armyofagents/shared exec vitest run
```

- [ ] **Step 4: Create autocomplete context**

Create `ui/src/context/EditorAutocompleteContext.tsx`:

```tsx
import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { companySkillsApi } from "@/api/companySkills";
import { queryKeys } from "@/lib/query-keys";
import { buildSkillMentionHref, normalizeSkillSlug } from "@armyofagents/shared";

export interface SkillCommandOption {
  id: string;
  kind: "skill";
  skillId: string;
  key: string;
  name: string;
  slug: string;
  description: string | null;
  href: string;
  aliases: string[];
}

interface ContextValue {
  slashCommands: SkillCommandOption[];
}

const Ctx = createContext<ContextValue>({ slashCommands: [] });

export function EditorAutocompleteProvider({
  companyId,
  children,
}: {
  companyId: string | null;
  children: React.ReactNode;
}) {
  const { data: skills = [] } = useQuery({
    queryKey: queryKeys.companySkills.list(companyId ?? ""),
    queryFn: () => (companyId ? companySkillsApi.list(companyId) : Promise.resolve([])),
    enabled: Boolean(companyId),
  });

  const slashCommands = useMemo<SkillCommandOption[]>(
    () =>
      skills.map((s) => {
        const slug = normalizeSkillSlug(s.name);
        return {
          id: `skill:${s.id}`,
          kind: "skill" as const,
          skillId: s.id,
          key: s.key,
          name: s.name,
          slug,
          description: s.description ?? null,
          href: buildSkillMentionHref(s.id, slug),
          aliases: [slug, s.name, s.key].filter(Boolean),
        };
      }),
    [skills]
  );

  return <Ctx.Provider value={{ slashCommands }}>{children}</Ctx.Provider>;
}

export function useEditorAutocomplete() {
  return useContext(Ctx);
}
```

- [ ] **Step 5: Integrate in MarkdownEditor**

In `ui/src/components/MarkdownEditor.tsx`, wrap the editor root with `<EditorAutocompleteProvider companyId={companyId}>`. Hook the slash trigger: when the user types `/`, query `slashCommands` filtered by the text after `/` (substring match against `aliases`). Render a Radix Popover dropdown anchored to the cursor. On selection, replace the `/text` token with `[name](href)`.

The exact integration depends on whether AoA uses MDXEditor, ProseMirror, or a textarea — choose the lightest path:
- **Textarea-based editor:** track caret position, listen to `keydown`, on `/` open popover with input filter, on selection insert markdown text at caret.
- **MDXEditor:** use the existing autocomplete plugin API (mirror Paperclip's integration).

- [ ] **Step 6: Render skill chips in mention-chips.ts**

In `ui/src/lib/mention-chips.ts`, add a parser branch that detects `skill://` href and renders a chip with the skill icon + name. Use `parseSkillMentionHref` for parsing.

- [ ] **Step 7: Manual test**

In a comment composer, type `/de` → see "Deploy" skill. Click → markdown `[Deploy](skill://...)` inserted. Hover the chip → tooltip shows skill description.

- [ ] **Step 8: Commit**

```sh
git add packages/shared/src/project-mentions.ts packages/shared/src/__tests__/project-mentions.test.ts ui/src/context/EditorAutocompleteContext.tsx ui/src/components/MarkdownEditor.tsx ui/src/lib/mention-chips.ts
git commit -m "feat(ui): skill slash-command autocomplete in markdown editor (94d4a01b upstream)"
```

**Verification:** Manual UI test; `extractSkillMentionIds` finds skills in saved comments.

**Effort:** 90 min  
**Dependencies:** `companySkillsApi.list()` exists (verify in `ui/src/api/companySkills.ts`)

---

### Task 17: Skill auto-enable for heartbeat runs

**Why:** When a task description or comment mentions a skill via `[name](skill://id)`, the heartbeat run should auto-enable that skill (without requiring the founder to set it in the agent's skill list). Paperclip commit ~`367065a3`.

**Review-pass corrections (verified 2026-04-26):**
- `readPaperclipSkillSyncPreference` and `writePaperclipSkillSyncPreference` do **not** exist in AoA. Located in Paperclip at `packages/adapter-utils/src/server-utils.ts:1227-1306`.
- Port them with **AoA-renamed function names** (`readAoaSkillSyncPreference` / `writeAoaSkillSyncPreference`), but the **runtime-config FIELD name** must support both `aoaSkillSync` (forward write) AND `paperclipSkillSync` (back-compat read) — because external adapters like Hermes (`hermes-paperclip-adapter` package, not under our control) may still emit/consume the old field name. Document with comment "// paperclipSkillSync compat read — remove in next major" matching AoA's existing pattern (per CLAUDE.md "Ambient Paperclip-era gaps still open" section).

**Files:**
- Modify: `packages/adapter-utils/src/server-utils.ts` (port + rename helpers; dual-name field)
- Modify: `packages/adapter-utils/src/__tests__/server-utils.test.ts` (add tests for read/write + back-compat)
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/__tests__/heartbeat-*.test.ts`

- [ ] **Step 1: Port helpers with AoA naming + dual-field compat**

In `packages/adapter-utils/src/server-utils.ts`, append:

```ts
/**
 * Read the skill-sync preference from a runtime config.
 * Reads the new `aoaSkillSync` field first; falls back to the
 * pre-rebrand `paperclipSkillSync` field for compat with external
 * adapters that haven't been updated. Remove the fallback in the
 * next major.
 */
export function readAoaSkillSyncPreference(
  config: Record<string, unknown>,
): { mode: "all" | "explicit" | "none"; keys: string[] } | null {
  const raw = config.aoaSkillSync ?? config.paperclipSkillSync; // paperclipSkillSync compat read — remove in next major
  if (!raw || typeof raw !== "object") return null;
  // ...port the body verbatim from Paperclip's readPaperclipSkillSyncPreference (lines 1227-1287)
  // adjusting the field-read prelude shown above
  return /* ...parsed shape... */ null;
}

/**
 * Write the skill-sync preference to a runtime config.
 * Writes BOTH `aoaSkillSync` (forward) AND `paperclipSkillSync` (compat)
 * so external adapters reading the old name continue to work. Remove the
 * compat write in the next major.
 */
export function writeAoaSkillSyncPreference<T extends Record<string, unknown>>(
  config: T,
  keys: string[],
): T {
  const next = { ...config };
  // ...port body verbatim from Paperclip's writePaperclipSkillSyncPreference (lines 1289-1306)
  next.aoaSkillSync = /* serialized shape */ undefined;
  next.paperclipSkillSync = next.aoaSkillSync; // compat write — remove in next major
  return next as T;
}
```

Read Paperclip's full implementation at `paperclip-master/paperclip-master/packages/adapter-utils/src/server-utils.ts:1227-1306` and adapt verbatim with the field-name changes above.

- [ ] **Step 2: Add unit tests for the helpers**

Append to `packages/adapter-utils/src/__tests__/server-utils.test.ts`:

```ts
describe("aoaSkillSync helpers", () => {
  it("reads new aoaSkillSync field", () => {
    const result = readAoaSkillSyncPreference({
      aoaSkillSync: { mode: "explicit", keys: ["foo"] },
    });
    expect(result).toEqual({ mode: "explicit", keys: ["foo"] });
  });

  it("falls back to legacy paperclipSkillSync", () => {
    const result = readAoaSkillSyncPreference({
      paperclipSkillSync: { mode: "explicit", keys: ["bar"] },
    });
    expect(result).toEqual({ mode: "explicit", keys: ["bar"] });
  });

  it("prefers aoaSkillSync over paperclipSkillSync when both present", () => {
    const result = readAoaSkillSyncPreference({
      aoaSkillSync: { mode: "explicit", keys: ["new"] },
      paperclipSkillSync: { mode: "explicit", keys: ["old"] },
    });
    expect(result).toEqual({ mode: "explicit", keys: ["new"] });
  });

  it("writes both fields for compat", () => {
    const out = writeAoaSkillSyncPreference({}, ["x", "y"]);
    expect(out.aoaSkillSync).toBeDefined();
    expect(out.paperclipSkillSync).toEqual(out.aoaSkillSync);
  });
});
```

- [ ] **Step 3: Add resolver helpers in heartbeat**

In `server/src/services/heartbeat.ts`, near other helpers, add:

```ts
import { extractSkillMentionIds } from "@armyofagents/shared";
import { readAoaSkillSyncPreference, writeAoaSkillSyncPreference } from "@armyofagents/adapter-utils/server-utils";

function extractMentionedSkillIdsFromSources(sources: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    for (const id of extractSkillMentionIds(src)) seen.add(id);
  }
  return [...seen];
}

async function resolveRunScopedMentionedSkillKeys(
  db: Db,
  companyId: string,
  issueId: string | null
): Promise<string[]> {
  if (!issueId) return [];
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
  if (!issue) return [];
  const comments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, issueId));
  const sources = [issue.title, issue.description, ...comments.map((c) => c.body)];
  const mentionedIds = extractMentionedSkillIdsFromSources(sources);
  if (mentionedIds.length === 0) return [];
  const rows = await db.select({ key: companySkills.key }).from(companySkills).where(and(eq(companySkills.companyId, companyId), inArray(companySkills.id, mentionedIds)));
  return rows.map((r) => r.key);
}

function applyRunScopedMentionedSkillKeys<T extends Record<string, any>>(config: T, skillKeys: string[]): T {
  if (skillKeys.length === 0) return config;
  const existing = readAoaSkillSyncPreference(config)?.keys ?? [];
  const merged = Array.from(new Set([...existing, ...skillKeys]));
  return writeAoaSkillSyncPreference(config, merged);
}
```

- [ ] **Step 4: Wire into wakeup**

In the heartbeat wakeup execution path (where `runtimeConfig` is finalized before calling `adapter.execute()`), call:

```ts
const mentionedSkillKeys = await resolveRunScopedMentionedSkillKeys(db, companyId, issueId);
runtimeConfig = applyRunScopedMentionedSkillKeys(runtimeConfig, mentionedSkillKeys);
if (mentionedSkillKeys.length > 0) {
  log.info("[heartbeat] Enabled run-scoped skills from issue mentions", { skills: mentionedSkillKeys });
}
```

- [ ] **Step 5: Test**

In `server/src/__tests__/heartbeat-*.test.ts`, add:

```ts
it("auto-enables skills mentioned in issue description", async () => {
  const skill = await createTestSkill({ key: "deploy-prod" });
  const issue = await createTestIssue({ description: `Use [deploy-prod](skill://${skill.id})` });
  const config = await prepareRuntimeConfig({ companyId: skill.companyId, issueId: issue.id, baseConfig: {} });
  const pref = readAoaSkillSyncPreference(config);
  expect(pref?.keys).toContain("deploy-prod");
});
```

- [ ] **Step 6: Test + typecheck + commit**

```sh
pnpm --filter @armyofagents/adapter-utils exec vitest run
pnpm --filter @armyofagents/server exec vitest run --grep heartbeat
pnpm typecheck
git add packages/adapter-utils/src/server-utils.ts packages/adapter-utils/src/__tests__/server-utils.test.ts server/src/services/heartbeat.ts server/src/__tests__/heartbeat-*.test.ts
git commit -m "feat(heartbeat): auto-enable skills mentioned in task body/comments (367065a3 upstream)"
```

**Verification:** Mention `[deploy-prod](skill://...)` in a task → wake heartbeat → log line shows skill auto-enabled. Compat-read test confirms legacy `paperclipSkillSync` field still readable.

**Effort:** 90 min (port helpers + dual-write tests + heartbeat wiring + tests)  
**Dependencies:** Task 16 (uses `extractSkillMentionIds` from shared)

---

## Phase 6 — Backend / migrations (~5.25 hr)

### Task 18: Project environment variables

**Why:** Projects don't currently carry an env-var map; agents in a project run with only the agent's own env. Paperclip commit `8f23270f` adds a `projects.env` JSONB column. Trivial migration; routes need GET/PATCH; UI needs an editor section.

**Files:**
- Create: `packages/db/src/migrations/0061_project_environment_variables.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `packages/db/src/schema/projects.ts`
- Modify: `server/src/routes/projects.ts`
- Create: `ui/src/components/projects/ProjectEnvironmentSection.tsx`
- Modify: `ui/src/pages/ProjectDetail.tsx` (or wherever project settings render)

- [ ] **Step 1: Create migration**

Create `packages/db/src/migrations/0061_project_environment_variables.sql`:

```sql
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "env" jsonb;
```

Update `packages/db/src/migrations/meta/_journal.json` accordingly.

- [ ] **Step 2: Update schema**

In `packages/db/src/schema/projects.ts`, add:

```ts
import type { AgentEnvConfig } from "@armyofagents/shared";
// ...inside pgTable("projects", { ... }):
env: jsonb("env").$type<AgentEnvConfig>(),
```

- [ ] **Step 3: Run db:generate (sanity)**

```sh
pnpm --filter @armyofagents/db db:generate
```

(Should produce no new auto-migration; manual migration takes precedence.)

- [ ] **Step 4: Add routes on existing `projectsRouter`**

Review pass confirmed: AoA's `server/src/routes/projects.ts:13` mounts `projectsRouter` (not nested under company). Existing routes use `projectsRouter.get("/:projectId", ...)`. **Mount the new env routes consistently:**

In `server/src/routes/projects.ts`, after the existing GET/PATCH `/:projectId` block:

```ts
projectsRouter.get("/:projectId/environment", async (req, res) => {
  const { projectId } = req.params;
  const project = await projectService.getById(projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  await assertCompanyAccess(req, project.companyId);
  res.json({ env: project.env ?? null });
});

projectsRouter.patch("/:projectId/environment", async (req, res) => {
  const { projectId } = req.params;
  const project = await projectService.getById(projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  await assertCompanyAccess(req, project.companyId);
  const parsed = agentEnvConfigSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "validation", issues: parsed.error.issues });
  const updated = await projectService.updateEnvironment(projectId, parsed.data);
  res.json({ env: updated.env });
});
```

Use existing `agentEnvConfigSchema` validator from `@armyofagents/shared`. (Verified by review pass: `AgentEnvConfig` type exists in `packages/shared/src/types/secrets.ts:23`; corresponding zod validator should exist in `packages/shared/src/validators/`. If only the type exists and not a zod schema, port the schema from `secrets.ts` validator pattern.)

- [ ] **Step 5: Add service method**

In `server/src/services/projects.ts`, add:

```ts
async updateEnvironment(projectId: string, env: Partial<AgentEnvConfig>): Promise<Project> {
  const [updated] = await db.update(projects).set({ env: env as AgentEnvConfig }).where(eq(projects.id, projectId)).returning();
  return updated;
}
```

- [ ] **Step 6: Wire env vars into heartbeat**

In `server/src/services/heartbeat.ts`, where the run env is built (look for existing env merging from agent env bindings), add a step that merges `project.env` before agent-level env (so agent vars take precedence). Order: `system → instance → company → project → agent`.

- [ ] **Step 7: UI editor section**

Create `ui/src/components/projects/ProjectEnvironmentSection.tsx` mirroring an existing env-binding editor (look for similar in agent settings). Plain key-value pairs, "Add variable" button, "Save" with optimistic update via mutation.

- [ ] **Step 8: Test**

Add `server/src/__tests__/project-routes-env.test.ts`:

```ts
it("GET /api/companies/:cid/projects/:pid/environment returns env", async () => {
  const project = await createTestProject({ env: { DATABASE_URL: "postgres://x" } });
  const res = await request(app).get(`/api/companies/${project.companyId}/projects/${project.id}/environment`).set(authHeaders);
  expect(res.status).toBe(200);
  expect(res.body.env).toEqual({ DATABASE_URL: "postgres://x" });
});

it("PATCH replaces env keys", async () => {
  const project = await createTestProject({ env: { OLD: "x" } });
  const res = await request(app).patch(`/api/companies/${project.companyId}/projects/${project.id}/environment`).set(authHeaders).send({ NEW: "y" });
  expect(res.status).toBe(200);
  expect(res.body.env).toEqual({ NEW: "y" });
});
```

- [ ] **Step 9: Migrate test DB + verify down/up round-trip + run tests + typecheck + commit**

```sh
pnpm --filter @armyofagents/db db:migrate                # apply 0061
pnpm --filter @armyofagents/db db:migrate:down --to=0060 # roll back
pnpm --filter @armyofagents/db db:migrate                # re-apply
pnpm --filter @armyofagents/server exec vitest run src/__tests__/project-routes-env.test.ts
pnpm typecheck
git add packages/db/src/migrations packages/db/src/schema/projects.ts server/src/routes/projects.ts server/src/services/projects.ts server/src/services/heartbeat.ts server/src/__tests__/project-routes-env.test.ts ui/src/components/projects/ProjectEnvironmentSection.tsx ui/src/pages/ProjectDetail.tsx
git commit -m "feat(projects): per-project environment variables (8f23270f upstream)"
```

Round-trip proves the migration is reversible. If down isn't supported by AoA's drizzle config, skip and note manually that `ALTER TABLE projects DROP COLUMN env;` would reverse the change cleanly.

**Verification:** Migration applies. PATCH project env → GET returns it → heartbeat run inherits the var.

**Effort:** 45 min  
**Dependencies:** none

---

### Task 19: Heartbeat liveness columns + watchdog decisions schema (migration 0062)

**Why:** Both T20 (process group tracking) and T21 (stale-run watchdog) need new columns on `heartbeat_runs` and a new `heartbeat_run_watchdog_decisions` table. Bundle all schema changes into one migration so the service layer can be authored on top of a stable schema.

**Files:**
- Create: `packages/db/src/migrations/0062_heartbeat_liveness_and_watchdog.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `packages/db/src/schema/heartbeat_runs.ts`
- Create: `packages/db/src/schema/heartbeat_run_watchdog_decisions.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create the migration**

Create `packages/db/src/migrations/0062_heartbeat_liveness_and_watchdog.sql`:

```sql
-- Process tracking + liveness columns
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_group_id" integer;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_pid" integer;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_started_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_seq" integer DEFAULT 0 NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_stream" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_bytes" bigint;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "liveness_state" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "liveness_reason" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "continuation_attempt" integer DEFAULT 0 NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_useful_action_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "next_action" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_snapshot" jsonb;

CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_last_output_idx"
  ON "heartbeat_runs" ("company_id", "status", "last_output_at");
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_process_started_idx"
  ON "heartbeat_runs" ("company_id", "status", "process_started_at");
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_liveness_idx"
  ON "heartbeat_runs" ("company_id", "liveness_state", "created_at");

-- Watchdog decisions table
CREATE TABLE IF NOT EXISTS "heartbeat_run_watchdog_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "evaluation_issue_id" uuid,
  "decision" text NOT NULL,
  "snoozed_until" timestamp with time zone,
  "reason" text,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_by_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "heartbeat_run_watchdog_decisions"
  ADD CONSTRAINT "hb_watchdog_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "heartbeat_run_watchdog_decisions"
  ADD CONSTRAINT "hb_watchdog_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "heartbeat_runs"("id") ON DELETE CASCADE;
ALTER TABLE "heartbeat_run_watchdog_decisions"
  ADD CONSTRAINT "hb_watchdog_evaluation_issue_fk" FOREIGN KEY ("evaluation_issue_id") REFERENCES "issues"("id") ON DELETE SET NULL;
ALTER TABLE "heartbeat_run_watchdog_decisions"
  ADD CONSTRAINT "hb_watchdog_created_by_agent_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
ALTER TABLE "heartbeat_run_watchdog_decisions"
  ADD CONSTRAINT "hb_watchdog_created_by_run_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "hb_watchdog_company_run_created_idx"
  ON "heartbeat_run_watchdog_decisions" ("company_id", "run_id", "created_at");
CREATE INDEX IF NOT EXISTS "hb_watchdog_company_run_snooze_idx"
  ON "heartbeat_run_watchdog_decisions" ("company_id", "run_id", "snoozed_until");
```

Update `packages/db/src/migrations/meta/_journal.json`.

- [ ] **Step 2: Update heartbeat_runs schema**

In `packages/db/src/schema/heartbeat_runs.ts`, add (alongside existing columns):

```ts
processGroupId: integer("process_group_id"),
processPid: integer("process_pid"),
processStartedAt: timestamp("process_started_at", { withTimezone: true }),
lastOutputAt: timestamp("last_output_at", { withTimezone: true }),
lastOutputSeq: integer("last_output_seq").notNull().default(0),
lastOutputStream: text("last_output_stream"),
lastOutputBytes: bigint("last_output_bytes", { mode: "bigint" }),
livenessState: text("liveness_state"),
livenessReason: text("liveness_reason"),
continuationAttempt: integer("continuation_attempt").notNull().default(0),
lastUsefulActionAt: timestamp("last_useful_action_at", { withTimezone: true }),
nextAction: text("next_action"),
contextSnapshot: jsonb("context_snapshot"),
```

Add the three new indexes inside the `(table) => ({ ... })` config block.

- [ ] **Step 3: Create watchdog decisions schema file**

Create `packages/db/src/schema/heartbeat_run_watchdog_decisions.ts`:

```ts
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies";
import { heartbeatRuns } from "./heartbeat_runs";
import { issues } from "./issues";
import { agents } from "./agents";

export const heartbeatRunWatchdogDecisions = pgTable(
  "heartbeat_run_watchdog_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    evaluationIssueId: uuid("evaluation_issue_id").references(() => issues.id, { onDelete: "set null" }),
    decision: text("decision").notNull(),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    reason: text("reason"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunCreatedIdx: index("hb_watchdog_company_run_created_idx").on(table.companyId, table.runId, table.createdAt),
    companyRunSnoozeIdx: index("hb_watchdog_company_run_snooze_idx").on(table.companyId, table.runId, table.snoozedUntil),
  })
);
```

- [ ] **Step 4: Re-export**

In `packages/db/src/schema/index.ts`, add `export * from "./heartbeat_run_watchdog_decisions";`.

- [ ] **Step 5: Migrate + verify down/up round-trip + typecheck**

```sh
pnpm --filter @armyofagents/db db:migrate                # apply 0062
pnpm --filter @armyofagents/db db:migrate:down --to=0061 # roll back
pnpm --filter @armyofagents/db db:migrate                # re-apply
pnpm typecheck
```

If down-migration not supported, note manually that the reversal SQL would be:
```sql
DROP TABLE heartbeat_run_watchdog_decisions;
ALTER TABLE heartbeat_runs DROP COLUMN process_group_id, DROP COLUMN process_pid, DROP COLUMN process_started_at, DROP COLUMN last_output_at, DROP COLUMN last_output_seq, DROP COLUMN last_output_stream, DROP COLUMN last_output_bytes, DROP COLUMN liveness_state, DROP COLUMN liveness_reason, DROP COLUMN continuation_attempt, DROP COLUMN last_useful_action_at, DROP COLUMN next_action, DROP COLUMN context_snapshot;
```

- [ ] **Step 6: Commit**

```sh
git add packages/db/src/migrations packages/db/src/schema
git commit -m "feat(db): heartbeat liveness columns + watchdog decisions table (migration 0062)"
```

**Verification:** Migration applies cleanly on fresh + existing DBs. Schema typecheck clean.

**Effort:** 1.5 hr  
**Dependencies:** none

---

### Task 20: Heartbeat process group + child PID population

**Why:** With the columns from T19 in place, populate them during process spawn so process-group cleanup (`pkill -g`) becomes possible. Paperclip relevant commits: `26d4cabb` (persist child pid before stdin handoff), `bcbbb41a` (heartbeat runtime cleanup hardening).

**Files:**
- Modify: `server/src/services/heartbeat.ts` (or `heartbeat-process-spawn.ts` if extracted)
- Modify: `server/src/__tests__/heartbeat-*.test.ts`

- [ ] **Step 1: Capture process group at spawn (cross-platform)**

In the heartbeat process spawn site, after `child = spawn(...)`, immediately update the run row:

```ts
const pid = child.pid ?? null;
const pgid = pid !== null ? safeProcessGetGid(pid) : null;
const startedAt = new Date();
await db.update(heartbeatRuns)
  .set({ processPid: pid, processGroupId: pgid, processStartedAt: startedAt })
  .where(eq(heartbeatRuns.id, runId));

function safeProcessGetGid(pid: number): number | null {
  if (process.platform === "win32") return null;
  try {
    // process.getpgid is POSIX-only and not in Node's TypeScript defs by default
    return (process as unknown as { getpgid(pid: number): number }).getpgid(pid);
  } catch {
    return null;
  }
}
```

(Persist BEFORE first stdin write so SIGKILL-on-startup-failure can target the group.)

- [ ] **Step 2: Group-kill on cancel (with Windows fallback)**

The kill strategy must fork by platform:

- **POSIX (`linux`/`darwin`):** `process.kill(-pgid, "SIGTERM")` followed by `SIGKILL` after a 5s grace, falls back to `process.kill(pid, ...)` if pgid is null.
- **Windows:** `process.kill(-pgid)` does not work. Use `taskkill /PID <pid> /T /F` via `child_process.spawnSync` to terminate the process tree, falling back to `process.kill(pid)` if `taskkill` fails.

Sketch:

```ts
function killRun(pid: number, pgid: number | null): void {
  if (process.platform === "win32") {
    if (pid > 0) {
      try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]); }
      catch { try { process.kill(pid); } catch {} }
    }
    return;
  }
  // POSIX
  try {
    if (pgid !== null) process.kill(-pgid, "SIGTERM");
    else process.kill(pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      if (pgid !== null) process.kill(-pgid, "SIGKILL");
      else process.kill(pid, "SIGKILL");
    } catch {}
  }, 5000);
}
```

- [ ] **Step 3: Update last_output_at on stdout/stderr**

Wire the streaming output handler to also update `lastOutputAt` and `lastOutputSeq`/`lastOutputStream`/`lastOutputBytes` (debounce to once-per-second to avoid hammering the DB):

```ts
let lastUpdate = 0;
let outputSeq = 0;
function onChunk(stream: "stdout" | "stderr", chunk: Buffer) {
  outputSeq += 1;
  const now = Date.now();
  if (now - lastUpdate > 1000) {
    lastUpdate = now;
    void db.update(heartbeatRuns)
      .set({ lastOutputAt: new Date(now), lastOutputSeq: outputSeq, lastOutputStream: stream, lastOutputBytes: BigInt(chunk.length) })
      .where(eq(heartbeatRuns.id, runId));
  }
}
```

- [ ] **Step 4: Tests**

In an existing heartbeat test file, add a test that spawns a fake adapter and asserts `processPid` is non-null and `processStartedAt` is set after spawn.

- [ ] **Step 5: Test + typecheck + commit**

```sh
pnpm --filter @armyofagents/server exec vitest run --grep heartbeat
pnpm typecheck
git add server/src/services/heartbeat.ts server/src/__tests__
git commit -m "feat(heartbeat): persist process group + PID + last-output-at during run"
```

**Verification:** Spawn heartbeat, query DB → see `process_pid`, `process_group_id`, `last_output_at` populated. Cancel run → process group terminated.

**Effort:** 1 hr  
**Dependencies:** Task 19 (schema)

---

### Task 21: Stale-run watchdog service

**Why:** Detect agents that hang (no output for >30 min while run still marked `running`) and record decisions in `heartbeat_run_watchdog_decisions`. Optionally auto-create an "evaluation" issue for founder triage. Paperclip migration `0070_active_run_output_watchdog.sql`.

**Files:**
- Create: `server/src/services/heartbeat-watchdog.ts`
- Modify: `server/src/index.ts` (register sweeper alongside existing TTL/cleanup sweepers)
- Create: `server/src/__tests__/heartbeat-watchdog.test.ts`

- [ ] **Step 1: Create the watchdog service**

Create `server/src/services/heartbeat-watchdog.ts`:

```ts
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { heartbeatRuns, heartbeatRunWatchdogDecisions } from "@armyofagents/db";
import { log } from "../log";

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min
const SNOOZE_DURATION_MS = 60 * 60 * 1000; // 1 hr per decision

export async function sweepStaleHeartbeatRuns(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stale = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      lastOutputAt: heartbeatRuns.lastOutputAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.status, "running"),
        isNotNull(heartbeatRuns.lastOutputAt),
        lt(heartbeatRuns.lastOutputAt, cutoff)
      )
    );

  for (const run of stale) {
    // Skip if a decision was made within the snooze window
    const recent = await db
      .select({ id: heartbeatRunWatchdogDecisions.id, snoozedUntil: heartbeatRunWatchdogDecisions.snoozedUntil })
      .from(heartbeatRunWatchdogDecisions)
      .where(eq(heartbeatRunWatchdogDecisions.runId, run.id))
      .orderBy(sql`${heartbeatRunWatchdogDecisions.createdAt} DESC`)
      .limit(1);

    if (recent[0] && recent[0].snoozedUntil && recent[0].snoozedUntil > new Date()) {
      continue;
    }

    await db.insert(heartbeatRunWatchdogDecisions).values({
      companyId: run.companyId,
      runId: run.id,
      decision: "stale_no_output",
      reason: `No output since ${run.lastOutputAt?.toISOString()}`,
      snoozedUntil: new Date(Date.now() + SNOOZE_DURATION_MS),
    });

    log.warn("[watchdog] Stale run detected", { runId: run.id, lastOutputAt: run.lastOutputAt });
  }
}
```

- [ ] **Step 2: Register sweeper**

In `server/src/index.ts`, alongside the existing TTL sweeper registration, add:

```ts
import { sweepStaleHeartbeatRuns } from "./services/heartbeat-watchdog";

// ... after server is up:
setInterval(() => {
  sweepStaleHeartbeatRuns(db).catch((err) => log.error("[watchdog] sweep failed", err));
}, 60_000);
```

(Use the same scheduling pattern as the existing TTL sweeper for consistency.)

- [ ] **Step 3: Test**

Create `server/src/__tests__/heartbeat-watchdog.test.ts`:

```ts
it("creates a decision when a running run has no output for >30 min", async () => {
  const oldDate = new Date(Date.now() - 45 * 60 * 1000);
  const run = await createTestHeartbeatRun({ status: "running", lastOutputAt: oldDate });
  await sweepStaleHeartbeatRuns(db);
  const decisions = await db.select().from(heartbeatRunWatchdogDecisions).where(eq(heartbeatRunWatchdogDecisions.runId, run.id));
  expect(decisions).toHaveLength(1);
  expect(decisions[0].decision).toBe("stale_no_output");
});

it("respects snooze window", async () => {
  const run = await createTestHeartbeatRun({ status: "running", lastOutputAt: new Date(Date.now() - 45 * 60 * 1000) });
  await sweepStaleHeartbeatRuns(db);
  await sweepStaleHeartbeatRuns(db); // second call — snoozed
  const decisions = await db.select().from(heartbeatRunWatchdogDecisions).where(eq(heartbeatRunWatchdogDecisions.runId, run.id));
  expect(decisions).toHaveLength(1);
});
```

- [ ] **Step 4: Test + commit**

```sh
pnpm --filter @armyofagents/server exec vitest run src/__tests__/heartbeat-watchdog.test.ts
pnpm typecheck
git add server/src/services/heartbeat-watchdog.ts server/src/index.ts server/src/__tests__/heartbeat-watchdog.test.ts
git commit -m "feat(heartbeat): stale-run watchdog with snooze (#3679-style upstream)"
```

**Verification:** Stale run → decision recorded → second sweep no-op (snoozed) → after snooze expires, new decision recorded.

**Effort:** 2 hr  
**Dependencies:** Tasks 19 + 20

---

### Task 22: Auto-checkout for scoped wakes

**Why:** When the heartbeat wakes an agent because of a comment on issue X, the agent's first action is usually `POST /issues/X/checkout`. We can pre-checkout server-side and tell the agent in the prompt — saving an HTTP round-trip and avoiding race-with-other-agents on the comment wake. Paperclip PR #3538 / commits `c1bb9385` + `8e82ac7e`.

**Review-pass corrections (verified 2026-04-26):**
- `checkedOutByHarness: boolean` is **already on** the `AoaWakePayload` type at `packages/adapter-utils/src/server-utils.ts:443`. (AoA's canonical name is `AoaWakePayload` — `PaperclipWakePayload` is a legacy alias kept for back-compat at line 566+.)
- `normalizeAoaWakePayload` (line 532) already normalizes the field via `asBoolean(payload.checkedOutByHarness, false)`. **No type/normalizer change needed.**
- This task is therefore **just heartbeat-wiring + prompt-advisory (extending `renderAoaWakePrompt`) + checkout-conflict-handling**.
- AoA's `issues.ts:1085` throws `conflict("Issue checkout conflict", {...})` — the `isCheckoutConflictError` predicate must be ported from Paperclip (`server/src/services/heartbeat.ts:1442`) since AoA doesn't have it.

**Naming convention for this task:** Use AoA's **canonical** names (`AoaWakePayload`, `renderAoaWakePrompt`, `normalizeAoaWakePayload`) in any new code. The `Paperclip*` aliases at lines 566 / 573 / 691 stay (back-compat) but new references should use the canonical AoA names per AoA's rebrand convention.

**Files:**
- Modify: `packages/adapter-utils/src/server-utils.ts` (only `renderAoaWakePrompt` — type + normalizer already done; legacy aliases at lines 566/573/691 stay)
- Modify: `server/src/services/heartbeat.ts` (call checkout before adapter execute; add `isCheckoutConflictError` predicate)
- Modify: `packages/adapter-utils/src/__tests__/server-utils.test.ts`

- [ ] **Step 1: Confirm field already on `AoaWakePayload`**

Open `packages/adapter-utils/src/server-utils.ts:443` and confirm `checkedOutByHarness: boolean` is present on the `AoaWakePayload` type. Also confirm `normalizeAoaWakePayload` at line 532 normalizes it via `asBoolean(payload.checkedOutByHarness, false)`. **No code change here** — proceed to step 2.

- [ ] **Step 2: Add prompt advisory**

In `renderAoaWakePrompt()` (line 575), where wake hints are rendered, add a conditional line:

```ts
if (payload.checkedOutByHarness) {
  lines.push("- checkout: already claimed by the harness for this run");
  lines.push("");
  lines.push("> The harness already checked out this issue for the current run. Do not call `/api/issues/{id}/checkout` again unless you intentionally switch to a different task.");
}
```

- [ ] **Step 3: Port `isCheckoutConflictError` predicate**

In `server/src/services/heartbeat.ts`, add the predicate (port verbatim from Paperclip's `heartbeat.ts:1442`):

```ts
function isCheckoutConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string };
  return e.code === "issue_checkout_conflict" || (e.message?.includes("checkout conflict") ?? false);
}
```

The predicate accommodates both error-code-based detection (preferred — if AoA's `conflict()` thrower at `issues.ts:1085` sets a code) and message-based detection as a fallback.

- [ ] **Step 4: Heartbeat integration**

In `server/src/services/heartbeat.ts`, where the wake payload is built for comment-driven wakes:

```ts
let checkedOutByHarness = false;
if (issueId && wake.kind === "comment") {
  try {
    await issueService.checkout({ issueId, agentId: agent.id, source: "harness_wake" });
    checkedOutByHarness = true;
  } catch (err) {
    if (isCheckoutConflictError(err)) {
      log.info("[heartbeat] Harness checkout skipped — already claimed", { issueId });
    } else {
      log.warn("[heartbeat] Harness checkout failed", err);
    }
  }
}
const wakePayload = { ..., checkedOutByHarness };
```

Confirm `issueService.checkout()`'s signature in `server/src/services/issues.ts`. Per review pass, current signature is `checkout: async (id, agentId, expectedStatuses, checkoutRunId)`. **Adapt the call** — likely `await issueService.checkout(issueId, agent.id, [/* default statuses */], runId)` — and use the existing optional `source: "automation"` parameter if present (review pass noted line 856 hardcodes this pattern). If `source` isn't a parameter, add it as an optional 5th arg with default `"automation"`.

- [ ] **Step 5: Tests**

In `packages/adapter-utils/src/__tests__/server-utils.test.ts`:

```ts
it("renders 'already claimed by the harness' note when checkedOutByHarness=true", () => {
  const prompt = renderAoaWakePrompt({ ...basePayload, checkedOutByHarness: true });
  expect(prompt).toContain("already claimed by the harness");
});

it("omits the harness-claim note when checkedOutByHarness=false", () => {
  const prompt = renderAoaWakePrompt({ ...basePayload, checkedOutByHarness: false });
  expect(prompt).not.toContain("already claimed by the harness");
});
```

In `server/src/__tests__/heartbeat-*.test.ts`, add an integration test that mocks `issueService.checkout` and confirms `checkedOutByHarness=true` flows through to the wake payload.

Also test the `isCheckoutConflictError` predicate against the actual error shape AoA's `conflict()` thrower produces.

- [ ] **Step 6: Test + typecheck + commit**

```sh
pnpm typecheck
pnpm --filter @armyofagents/server exec vitest run --grep heartbeat
git add packages/adapter-utils/src server/src/services/heartbeat.ts
git commit -m "feat(heartbeat): auto-checkout scoped issue wakes (PR #3538 upstream)"
```

**Verification:** Comment-wake on a task → agent prompt contains "already claimed by the harness" → agent skips redundant checkout call.

**Effort:** ~30 min (type + normalizer already done; just prompt-rendering, predicate, and heartbeat wiring)  
**Dependencies:** Existing `issueService.checkout()` in `server/src/services/issues.ts:961`

---

## Phase 7 — Backups + Inbox UI (~4.5 hr)

### Task 23: Backup tiered retention + gzip + un-hide tab

**Why:** AoA's BackupsTab is hidden (Sprint 3 Finding X) pending real backup implementation. Paperclip PR #3015 (commits `cc44d309`, `fcbae62b`, `b1e45736`) ships gzipped backups + ISO-week + monthly retention tiers. This unblocks v1.0 launch backup story.

**Review-pass corrections (verified 2026-04-26):**
- `BackupRetentionPolicy` interface + `DAILY_RETENTION_PRESETS` / `WEEKLY_RETENTION_PRESETS` / `MONTHLY_RETENTION_PRESETS` are **already in** `packages/shared/src/types/instance.ts:8-12`. The corresponding zod validator `backupRetentionPolicySchema` is **already in** `packages/shared/src/validators/instance.ts:19-23`. **No shared-layer additions needed.**
- `ui/src/pages/InstanceSettingsPage.tsx:11-12` has comment: "BackupsTab is intentionally unmounted for v1.0 — backup/restore ships in 1.1." Plan must un-hide via the `TABS` array (~line 176).
- `BackupsTab.tsx` component exists in tree but is unmounted. Re-mount + wire to the new presets.
- AoA's existing `packages/db/src/backup-lib.ts` does NOT have gzip or tiered pruning. Refactor required there.
- **Restore-side compatibility:** Plan must detect file extension and decompress with `createGunzip()` only if `.endsWith(".gz")`, so old `.sql` backups remain restorable. (Matches what Paperclip does.)

**Files:**
- Modify: `packages/db/src/backup-lib.ts` (gzip pipeline, tiered pruning, extension-detection on restore)
- Modify: `server/src/services/instance-settings.ts` (use existing `DEFAULT_BACKUP_RETENTION` / validator)
- Modify: `ui/src/components/instance-settings/BackupsTab.tsx` (preset pickers wired to existing types)
- Modify: `ui/src/pages/InstanceSettingsPage.tsx` (re-add Backups to `TABS` array; remove unmount comment)
- Create: `packages/db/src/__tests__/backup-pruning.test.ts`

- [ ] **Step 1: Verify shared layer is already complete**

Read `packages/shared/src/types/instance.ts:8-12` and `packages/shared/src/validators/instance.ts:19-23`. Confirm `BackupRetentionPolicy`, the three preset constants, and `backupRetentionPolicySchema` already exist. **If anything is missing**, port from Paperclip's `packages/shared/src/types/instance.ts`. If complete, no edits to shared layer.

- [ ] **Step 2: Confirm `DEFAULT_BACKUP_RETENTION` constant**

Search for `DEFAULT_BACKUP_RETENTION` in `packages/shared/src/`. If missing, add to `types/instance.ts`:

```ts
export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  dailyDays: 7,
  weeklyWeeks: 2,
  monthlyMonths: 3,
};
```

- [ ] **Step 3: Rewrite backup-lib**

In `packages/db/src/backup-lib.ts`:

(a) Update `RunDatabaseBackupOptions` to take `retention: BackupRetentionPolicy` instead of `retentionDays: number`.

(b) Add gzip pipeline. Where pg_dump is invoked:

```ts
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";
// ...
await pipeline(child.stdout!, createGzip(), createWriteStream(opts.backupFile));
```

The output file path should now use `.sql.gz` extension.

(c) Rewrite `pruneOldBackups()`:

```ts
function isoWeek(d: Date): string {
  // ISO week year-week (e.g., "2026-W18")
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((+date - +yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}
function calendarMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function pruneOldBackups(
  backups: Array<{ path: string; createdAt: Date }>,
  policy: BackupRetentionPolicy,
  now: Date = new Date()
): { keep: string[]; remove: string[] } {
  const sorted = [...backups].sort((a, b) => +b.createdAt - +a.createdAt);
  const keep = new Set<string>();

  // Daily tier: keep newest backup per day for last N days
  const dayCutoff = new Date(now);
  dayCutoff.setUTCDate(dayCutoff.getUTCDate() - policy.dailyDays);
  const seenDays = new Set<string>();
  for (const b of sorted) {
    if (b.createdAt < dayCutoff) break;
    const dayKey = b.createdAt.toISOString().slice(0, 10);
    if (!seenDays.has(dayKey)) {
      seenDays.add(dayKey);
      keep.add(b.path);
    }
  }

  // Weekly tier: keep newest backup per ISO-week for next N weeks
  const weekCutoff = new Date(dayCutoff);
  weekCutoff.setUTCDate(weekCutoff.getUTCDate() - policy.weeklyWeeks * 7);
  const seenWeeks = new Set<string>();
  for (const b of sorted) {
    if (b.createdAt >= dayCutoff || b.createdAt < weekCutoff) continue;
    const weekKey = isoWeek(b.createdAt);
    if (!seenWeeks.has(weekKey)) {
      seenWeeks.add(weekKey);
      keep.add(b.path);
    }
  }

  // Monthly tier: keep newest backup per calendar-month for next N months
  const monthCutoff = new Date(weekCutoff);
  monthCutoff.setUTCMonth(monthCutoff.getUTCMonth() - policy.monthlyMonths);
  const seenMonths = new Set<string>();
  for (const b of sorted) {
    if (b.createdAt >= weekCutoff || b.createdAt < monthCutoff) continue;
    const monthKey = calendarMonth(b.createdAt);
    if (!seenMonths.has(monthKey)) {
      seenMonths.add(monthKey);
      keep.add(b.path);
    }
  }

  const remove = sorted.filter((b) => !keep.has(b.path)).map((b) => b.path);
  return { keep: [...keep], remove };
}
```

(d) Add restore support that detects file extension and decompresses only when needed (so existing `.sql` backups remain restorable):

```ts
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

// ...in restore:
const isGzipped = opts.backupFile.endsWith(".gz");
const inputStream = isGzipped
  ? createReadStream(opts.backupFile).pipe(createGunzip())
  : createReadStream(opts.backupFile);
await pipeline(inputStream, child.stdin!);
```

This is forward-compatible: future formats (e.g. `.sql.zst`) can be added with another extension branch. **No migration of old backups is performed — existing `.sql` files remain restorable forever.**

(e) On compression failure, ensure orphan `.sql` (uncompressed intermediate, if any) is cleaned up.

- [ ] **Step 4: Update instance-settings service**

In `server/src/services/instance-settings.ts`, replace any `retentionDays` defaulting with `DEFAULT_BACKUP_RETENTION`. Validate via `backupRetentionPolicySchema`.

- [ ] **Step 5: Update BackupsTab UI**

In `ui/src/components/instance-settings/BackupsTab.tsx`, replace the single retention slider with three preset selectors:

```tsx
<div className="grid grid-cols-3 gap-4">
  <Selector label="Daily" presets={DAILY_RETENTION_PRESETS} value={value.dailyDays} onChange={(v) => onChange({ ...value, dailyDays: v })} suffix="days" />
  <Selector label="Weekly" presets={WEEKLY_RETENTION_PRESETS} value={value.weeklyWeeks} onChange={(v) => onChange({ ...value, weeklyWeeks: v })} suffix="weeks" />
  <Selector label="Monthly" presets={MONTHLY_RETENTION_PRESETS} value={value.monthlyMonths} onChange={(v) => onChange({ ...value, monthlyMonths: v })} suffix="months" />
</div>
```

(Use a small inline `Selector` component or radix RadioGroup; keep visually consistent with other instance-settings sections.)

- [ ] **Step 6: Re-enable the Backups tab**

In `ui/src/pages/InstanceSettingsPage.tsx`, find the `TABS` array (~line 176). Add the Backups entry back:

```ts
{ value: "backups", label: "Backups" },
```

Re-render the corresponding `<TabsContent value="backups"><BackupsTab /></TabsContent>` block. **Remove the comment at lines 11-12** (`// BackupsTab is intentionally unmounted for v1.0...`) since v1.1 ship is now landing.

- [ ] **Step 7: Tests**

Add `packages/db/src/__tests__/backup-pruning.test.ts`:

```ts
it("keeps newest backup per day for daily tier", () => {
  const now = new Date("2026-04-26T00:00:00Z");
  const backups = [
    { path: "a.gz", createdAt: new Date("2026-04-25T10:00:00Z") },
    { path: "b.gz", createdAt: new Date("2026-04-25T05:00:00Z") },
  ];
  const { keep, remove } = pruneOldBackups(backups, { dailyDays: 7, weeklyWeeks: 1, monthlyMonths: 1 }, now);
  expect(keep).toContain("a.gz");
  expect(remove).toContain("b.gz");
});
```

Add tests for weekly + monthly tiers + edge cases.

- [ ] **Step 8: Test + typecheck + commit**

```sh
pnpm --filter @armyofagents/db exec vitest run src/__tests__/backup-pruning.test.ts
pnpm typecheck
git add packages/db/src/backup-lib.ts packages/db/src/__tests__/backup-pruning.test.ts packages/shared/src/types/instance.ts packages/shared/src/validators/instance.ts server/src/services/instance-settings.ts ui/src/components/instance-settings/BackupsTab.tsx ui/src/pages/InstanceSettingsPage.tsx
git commit -m "feat(backups): tiered retention + gzip + re-enable BackupsTab (Finding X close)"
```

**Verification:** Generate 30 daily backups → run prune with `{daily:7,weekly:2,monthly:1}` → exactly 7 daily + 2 weekly + 1 monthly retained. New backup files end in `.sql.gz`. Restore from `.sql.gz` works. Restore from existing `.sql` (uncompressed legacy) **still works** via extension detection.

**Effort:** ~2 hr (shared types already done; just backup-lib refactor + UI wiring + un-hide tab)  
**Dependencies:** none

---

### Task 24: Inbox parent-child nesting UI

**Why:** AoA already has `parentId` on issues (per CLAUDE.md task hierarchy). Missing: the toggle to view inbox flat vs nested, the collapse/expand chevrons, and j/k traversal that respects nesting. Paperclip PR #2218 (commits `8cdb65fe`, `d3e66c78`, `58ae23aa`).

**Review-pass corrections (verified 2026-04-26):**
- `ui/src/lib/inbox.ts` does **NOT exist** in AoA. **Create**, do not Modify.
- `ui/src/components/IssuesList.tsx` already has `parentId` awareness (computes `subIssueStats` by grouping). Has `Collapsible` Radix imports already. Add nesting render mode + chevron UI.
- The `useKeyboardShortcuts` hook (post-T6.5 refactor) needs to accept the visible-ordered list. Pass `visibleOrderedIds` from Inbox to the hook handler.

**Files:**
- Modify: `ui/src/components/IssuesList.tsx`
- Create: `ui/src/lib/inbox.ts`
- Modify: `ui/src/pages/Inbox.tsx`
- Create: `ui/src/__tests__/Inbox-nesting.test.tsx`

- [ ] **Step 1: Add nesting helpers**

In `ui/src/lib/inbox.ts`, add:

```ts
const NESTING_KEY = "aoa:inbox:nestingEnabled";
const COLLAPSE_PREFIX = "aoa:inbox:collapsed:";

export function getInboxNestingEnabled(): boolean {
  return localStorage.getItem(NESTING_KEY) === "1";
}

export function setInboxNestingEnabled(v: boolean): void {
  localStorage.setItem(NESTING_KEY, v ? "1" : "0");
  window.dispatchEvent(new Event("inbox-nesting-change"));
}

export function getCollapsedSet(): Set<string> {
  const raw = localStorage.getItem(`${COLLAPSE_PREFIX}set`);
  if (!raw) return new Set();
  try { return new Set(JSON.parse(raw) as string[]); } catch { return new Set(); }
}

export function toggleCollapsed(parentId: string): Set<string> {
  const set = getCollapsedSet();
  if (set.has(parentId)) set.delete(parentId);
  else set.add(parentId);
  localStorage.setItem(`${COLLAPSE_PREFIX}set`, JSON.stringify([...set]));
  return set;
}
```

- [ ] **Step 2: Refactor IssuesList for nesting**

In `ui/src/components/IssuesList.tsx`, accept a `nestingEnabled?: boolean` prop. When true, group issues by parentId:

```tsx
const grouped = useMemo(() => {
  if (!nestingEnabled) return null;
  const byParent = new Map<string | null, Issue[]>();
  for (const i of issues) {
    const key = i.parentId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(i);
  }
  // Top level: items with parentId === null OR whose parent is not in the list
  const issueIds = new Set(issues.map((i) => i.id));
  const topLevel = issues.filter((i) => !i.parentId || !issueIds.has(i.parentId));
  return { byParent, topLevel };
}, [issues, nestingEnabled]);

const [collapsed, setCollapsed] = useState<Set<string>>(() => getCollapsedSet());
```

Render top-level rows; for each parent, render a chevron if it has children; on click, toggle collapse via `toggleCollapsed(parent.id)`. Children render indented (e.g., `pl-7 sm:pl-7`).

- [ ] **Step 3: Toggle button in Inbox**

In `ui/src/pages/Inbox.tsx`, add to the toolbar:

```tsx
import { ListTree } from "lucide-react";
import { getInboxNestingEnabled, setInboxNestingEnabled } from "@/lib/inbox";

const [nesting, setNesting] = useState(getInboxNestingEnabled);
useEffect(() => {
  const handler = () => setNesting(getInboxNestingEnabled());
  window.addEventListener("inbox-nesting-change", handler);
  return () => window.removeEventListener("inbox-nesting-change", handler);
}, []);

// In toolbar:
<Button
  variant="ghost"
  size="sm"
  onClick={() => setInboxNestingEnabled(!nesting)}
  aria-pressed={nesting}
  aria-label="Toggle parent-child nesting"
>
  <ListTree className={`size-4 ${nesting ? "text-primary" : "text-muted-foreground"}`} />
</Button>
```

Pass `nestingEnabled={nesting}` to `<IssuesList>`.

- [ ] **Step 4: j/k traversal across nested children**

In the inbox keyboard handler, the navigation list must reflect the rendered (visible, post-collapse) flat order. Compute a `visibleOrderedIds` array each render:

```tsx
const visibleOrderedIds = useMemo(() => {
  if (!nestingEnabled) return issues.map((i) => i.id);
  const out: string[] = [];
  for (const parent of grouped!.topLevel) {
    out.push(parent.id);
    if (!collapsed.has(parent.id)) {
      const kids = grouped!.byParent.get(parent.id) ?? [];
      for (const k of kids) out.push(k.id);
    }
  }
  return out;
}, [nestingEnabled, grouped, collapsed]);
```

Pass `visibleOrderedIds` to the keyboard hook so j/k advances in nesting-aware order.

- [ ] **Step 5: Manual test**

Create 3 parent tasks, each with 2 sub-tasks. Inbox → flat (default). Toggle nesting → see chevrons + indented kids. Click chevron → kids hide. Press `j` → cursor advances over visible items only.

- [ ] **Step 6: Render test**

Create `ui/src/__tests__/Inbox-nesting.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { setInboxNestingEnabled, getInboxNestingEnabled, toggleCollapsed, getCollapsedSet } from "../lib/inbox";

describe("inbox nesting helpers", () => {
  beforeEach(() => localStorage.clear());

  it("persists nesting toggle to localStorage", () => {
    expect(getInboxNestingEnabled()).toBe(false);
    setInboxNestingEnabled(true);
    expect(getInboxNestingEnabled()).toBe(true);
    expect(localStorage.getItem("aoa:inbox:nestingEnabled")).toBe("1");
  });

  it("toggles collapsed parent in set", () => {
    expect(getCollapsedSet().has("parent-1")).toBe(false);
    toggleCollapsed("parent-1");
    expect(getCollapsedSet().has("parent-1")).toBe(true);
    toggleCollapsed("parent-1");
    expect(getCollapsedSet().has("parent-1")).toBe(false);
  });
});
```

(Add a higher-level render test for the toggle button + chevron interaction if the existing IssuesList test infrastructure makes it straightforward; otherwise rely on manual + helpers tests.)

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/Inbox-nesting.test.tsx` — expect PASS.

- [ ] **Step 7: Commit**

```sh
git add ui/src/components/IssuesList.tsx ui/src/lib/inbox.ts ui/src/pages/Inbox.tsx ui/src/__tests__/Inbox-nesting.test.tsx
git commit -m "feat(inbox): parent-child nesting toggle + j/k traversal (PR #2218 upstream)"
```

**Verification:** Manual UI test + helpers test. Toggle persists across reloads via localStorage. Collapsed parents stay collapsed.

**Effort:** 120 min (+ 15 min for render test) = 135 min  
**Dependencies:** **T6.5** (refactored `useKeyboardShortcuts` hook accepts visible-ordered list)

---

## Final task: Decision-lock skipped items

**Why:** Document why D1 (standalone MCP server) and D5 (skill bin/ PATH) were intentionally skipped, so future contributors don't re-port them blindly.

**Files:**
- Modify: `docs/aoa/reference/decisions.md`

- [ ] **Step 1: Append two decisions**

In `docs/aoa/reference/decisions.md`, append (use the next sequential decision numbers):

```markdown
## Decision #92: Skip standalone `@paperclipai/mcp-server` package port

**Date:** 2026-04-26
**Context:** Paperclip released `packages/mcp-server` — a stdio-based MCP server that wraps the Paperclip REST API for external MCP clients (e.g., Claude Desktop) to call Paperclip from outside.

**Decision:** Do NOT port. AoA's in-server MCP at `server/src/mcp/server.ts` (31 tools, RBAC-scoped, rate-limited) covers the v1.0 use case directly without a separate package. The standalone wrapper is only useful when the MCP client cannot reach AoA's HTTP endpoint — a use case AoA's local-first deployment model does not currently have.

**Revisit when:** AoA grows a multi-tenant cloud deployment where external Claude Desktop clients need to talk to a hosted instance.

## Decision #93: Skip `pi-local` skill bin/ PATH support port

**Date:** 2026-04-26
**Context:** Paperclip commit `854fa817` adds skill `bin/` directories to the child process PATH for the `pi-local` adapter so AGENTS.md-invoked skill helpers (`paperclip-get-issue`, etc.) resolve without absolute paths.

**Decision:** Do NOT port. AoA's adapter set (`claude_local | opencode_local | openclaw | http | process | cursor | codex_local | hermes_local | gemini_local`) does not include `pi-local`. Skill helpers are not part of AoA's heartbeat protocol today.

**Revisit when:** AoA introduces a similar skill-helper protocol or adopts the `pi-local` adapter family.
```

- [ ] **Step 2: Commit**

```sh
git add docs/aoa/reference/decisions.md
git commit -m "docs: lock decisions #92, #93 — skip MCP server pkg and pi-local PATH ports"
```

---

## Plan summary

**Tasks:** 25 tasks across 7 phases + 1 docs task = 26 commits (Phase 1 ships as a single bundled commit).

**Effort total (rough):** ~22.5 hours of focused work — 3 days of full-time effort, or 1.5 sprints at half-time.

**By phase:**
| Phase | Tasks | Effort | Notes |
|---|---|---|---|
| 1 — Critical security/CVE/quickwins | T1–T5 | ~30 min | Ships as **one bundled commit** |
| 2 — UI quickwins | T6, T6.5, T7, T8 | ~2.5 hr | T6.5 added (shortcut config); UI render tests added |
| 3 — Routine improvements | T9, T10, T11 | ~3.5 hr | T10 down to UI-only (saved 60 min) |
| 4 — Adapter improvements | T12, T15, T13, T14 | ~4.25 hr | Execution order: T12 → T15 → T13 → T14 |
| 5 — Skills | T16, T17 | ~3 hr | T17 ports helpers w/ rename + dual-write |
| 6 — Backend / migrations | T18–T22 | ~5.5 hr | Migrations 0061-0062 with down/up round-trip |
| 7 — Backups + Inbox UI | T23, T24 | ~3.5 hr | T23 saved 30 min (types already exist); T24 render test added |
| Docs | Decisions #92, #93 | ~10 min | |

**Migrations created:** 0061 (project env, in Phase 6 / T18), 0062 (heartbeat liveness + watchdog, in Phase 6 / T19), 0063 (routine draft defaults, **in Phase 3 / T11** — note: NOT in Phase 6 despite the higher number; chronological since T11 is reached first in execution order).

**Skipped (with rationale):**
- **D1** standalone MCP package — superseded by in-server MCP at `server/src/mcp/server.ts`
- **D5** skill bin/ PATH — not applicable to AoA adapter set
- **C4** capability flags — verified already in AoA `packages/adapter-utils/src/types.ts:220-262`

**Already-in-AoA (no port needed, found by review pass):**
- T10 partial: `extractRoutineVariableNames` + `syncRoutineVariablesWithTemplate` in `packages/shared/src/routine-variables.ts:27-58`
- T22 partial: `checkedOutByHarness` field on `PaperclipWakePayload` at `packages/adapter-utils/src/server-utils.ts:443`
- T23 partial: `BackupRetentionPolicy` + presets in `packages/shared/src/types/instance.ts:8-12` and validator in `validators/instance.ts:19-23`

**Cross-task dependencies:**
- **T7 depends on T6.5** (shortcut config)
- **T11 depends on T10** (variable extraction — though now mostly already-done in shared)
- **T13 depends on T15** (`metered_api` billing-type variant — execution order: T15 before T13)
- **T17 depends on T16** (skill mention parser)
- **T20 depends on T19** (schema)
- **T21 depends on T19 + T20**
- **T24 depends on T6.5** (refactored `useKeyboardShortcuts` hook accepts visible-ordered list)

**Procedural decisions locked:**
- Phase 1 ships as **one bundled commit** (5 trivial fixes, ~30 min total).
- **Brand-check CI** is sole gate for Issue→Task copy enforcement (no per-task manual review).
- **Migration round-trip** (down/up) verified for T11, T18, T19; skipped for non-migration tasks.

**Render tests added** for T6 (sign-out), T7 (cheatsheet), T8 (image gallery), T24 (inbox nesting).

**Next step after Tier 1+2:** Plan a separate sprint for Tier 3 candidates — blocker dependencies, execution policies (multi-stage signoff), issue chat thread, trigram search, sub-issues inline. Each needs its own planning pass; do not lump into this PR.
