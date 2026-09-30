# Paperclip → AoA Rename: Phased Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate stale "paperclip" references everywhere they're safe to remove, while preserving the wire-compat surfaces explicitly documented in `.changeset/v1-0-0-rc-4-polish-batch.md:13` and the existing `env-compat.ts` migration layer.

**Architecture:** Seven independent phases, each mergeable on its own. Phases are ordered low-risk-first so we ship value early and learn before touching persisted data. **Phase 6 (Hermes wire fields) is deferred** — it requires upstream coordination.

**Tech Stack:** TypeScript (server, CLI, UI), Drizzle ORM (Postgres), Vitest, Playwright, GitHub Actions.

---

## Test Strategy — how we know nothing breaks

**Layered safety net, top to bottom.** Every phase runs the gates marked ✅ below before its commit, plus the phase-specific NEW tests listed in the table.

### Existing gates (run after every phase)

| Gate | Command | What it catches |
|---|---|---|
| **Typecheck** | `pnpm typecheck` | Broken imports, type drift, missing exports |
| **Unit tests** | `pnpm test:run` | Regressions in `server/src/__tests__/`, `ui/src/__tests__/`, `packages/**/__tests__/` (~250 existing test files) |
| **E2E happy paths** | `pnpm test:e2e` | Full browser flows in `tests/e2e/` — onboarding, sign-in, board, task creation |
| **Release smoke** | `pnpm test:release-smoke` | Auth + onboarding against a built server |
| **Evals validate** | `pnpm evals:validate` | Eval prompt files parse correctly |
| **Docker smoke** | `pnpm docker:smoke` | Container build → onboard → sign-in → session verify (only run before Phase 4 ships) |
| **Brand-check CI** | (runs on every PR) | Already-allow-listed paperclip patterns + new ones from Phase 7 |

### Phase-specific NEW tests we add

| Phase | New test file | What it asserts |
|---|---|---|
| 1 | (none — existing tests cover) | renamed test file still passes; log-prefix change has no test that asserts on the old prefix (verified via grep in Step 2 of Task 1.2) |
| 2 | `ui/src/__tests__/markdown-editor-classes.test.tsx` | Render `MarkdownEditor` and `MarkdownBody`; assert the rendered DOM has `aoa-mdxeditor`, `aoa-mdxeditor-content`, `aoa-project-mention-chip` classes; assert NO `paperclip-` classes remain |
| 3 | `ui/src/__tests__/storage-migration.test.ts` | (Task 3.1) helper unit tests — 5 cases |
| 3 | `ui/src/__tests__/storage-migrations-registry.test.ts` | (NEW — Task 3.2) seed all 13 paperclip keys + 3 prefix groups, call `runStorageMigrations()`, assert every old key is gone and every new key holds the same value; assert idempotency (run twice → same state); assert no-clobber (pre-set `aoa:foo` → not overwritten) |
| 5 | `server/src/__tests__/aoa-sentinel-compat.test.ts` | Insert row with legacy `_paperclipWakeContext` JSON key + legacy `/__paperclip_repo_only__` cwd; call the heartbeat read paths; assert behavior identical to a row with new sentinels; assert subsequent writes emit only AoA names |
| 5 | `packages/db/src/__tests__/0060_aoa_sentinels-migration.test.ts` | Spin up an embedded-pg, seed legacy rows via raw SQL, run the migration, assert rows updated; run a second time, assert idempotency (zero rows changed) |
| 7 | (none — the CI rule itself is the test) | Open a draft PR with a deliberate `paperclip:foo` localStorage write, assert brand-check fails it |

### Manual verification (per phase, recorded in PR description)

| Phase | Manual smoke |
|---|---|
| 1 | `pnpm dev:once`, open `/TES/projects/dev/issues`, create a task, watch server stderr — confirm `[aoa]` prefix appears, no `[paperclip]` |
| 2 | Open New Task dialog, type a description with **bold**, **italic**, `code`, and `@`-mention — confirm all styles render (means CSS rules are matching the renamed classes) |
| 3 | Pre-seed `localStorage.setItem("paperclip.theme", "dark")` and `paperclip:sidebar-collapsed` and `paperclip:issue-draft`; hard-reload; confirm theme is dark, sidebar collapsed, draft restored. `localStorage.getItem("paperclip.theme") === null` and `aoa.theme === "dark"`. |
| 4 | Run `pnpm docker:smoke` end-to-end |
| 5 | Pre-seed a row with legacy sentinels via psql; hit a heartbeat trigger; verify task executes with the same workspace behavior as a non-legacy row |

### Pre-merge checklist (every phase)

- [ ] All existing gates green (typecheck, unit, e2e, release-smoke)
- [ ] Phase-specific new tests added and green
- [ ] Manual smoke recorded with screenshots / log excerpts in PR description
- [ ] Brand-check CI green
- [ ] No new `paperclip` strings outside the explicit wire-compat allow-list (sweep with the same grep that brand-check uses)

### Rollback safety

| Phase | Rollback path |
|---|---|
| 1 | `git revert` — fully reversible |
| 2 | `git revert` — fully reversible (CSS classes are not persisted) |
| 3 | `git revert` of the per-key constants reverts to legacy keys; the migration helper itself is harmless. **Note:** users who have already booted with the new build will have already migrated their keys — reverting just makes the app read the AoA names again, which won't exist for those users. **Mitigation:** the registry could optionally also write the legacy key when running on a downgraded build. Skipping for v1 — accept that downgrades wipe local UI state. Documented. |
| 4 | `git revert` Dockerfile + docs. Runtime env-compat means no impact on running deployments. |
| 5 | Dual-read shipped first (Task 5.1) — reverting Task 5.2 (the SQL migration) leaves rows in legacy state; code still reads them. Reverting Task 5.1 too means new rows still have new names, but legacy rows would be unreachable via code (workspace cwd would no longer match the sentinel) — **so revert order matters: revert 5.2 first, then 5.1**. Documented. |
| 7 | `git revert` — only relaxes CI |

---

## What we're keeping (wire-compat — DO NOT TOUCH)

The brand-check CI job at `.github/workflows/pr.yml:99-170` already enforces these allow-lists. Per `.changeset/v1-0-0-rc-4-polish-batch.md:13`:

- `PAPERCLIP_*` env vars — kept via `server/src/env-compat.ts` + `cli/src/config/env-compat.ts` (mirrors to `AOA_*` at startup; both are imported at line 1 of every entrypoint)
- `paperclipai` CLI bin alias in `cli/package.json:8` and root `package.json:27`
- `paperclipPlugin` package.json key + `__paperclipPluginBridge__` / `__paperclipPluginToolDispatcher` / `__paperclip_*` sandbox globals (plugin wire protocol)
- `paperclip-feedback-envelope-v2` / `paperclip-feedback-bundle-v2` schemaVersion values (telemetry compat, see `docs/telemetry.md`)
- `hermes-paperclip-adapter` (external npm package — upstream)
- `@paperclipai/*` published package scope (upstream)
- `PaperclipPluginManifest` / `paperclipConfigSchema` type aliases
- `docs/aoa/specs/paperclip_spec.md` (upstream spec snapshot)
- `docs/audit/v1.0.0/raw/*.md` (audit history)
- `.changeset/*.md` (release history)

---

## File Structure

| File | Phase | Action |
|------|-------|--------|
| `evals/promptfoo/prompts/task-agent-system.txt` | 1 | Replace `PAPERCLIP_*` with `AOA_*` (8 lines) |
| `evals/promptfoo/prompts/internal-agent-system.txt` | 1 | Replace `PAPERCLIP_*` with `AOA_*` (2 lines) |
| `scripts/dev-runner.mjs` | 1 | `[paperclip]` log prefix → `[aoa]` (2 lines) |
| `server/src/app.ts` | 1 | `[paperclip]` log prefix → `[aoa]` (1 line) |
| `server/src/services/heartbeat.ts` | 1 | `[paperclip]` log prefixes → `[aoa]` (3+ lines, lines 80/82 stay until Phase 5) |
| `packages/adapters/{claude,codex,cursor,gemini,opencode}-local/src/server/execute.ts` | 1 | `[paperclip]` log prefix → `[aoa]` (~40 occurrences across 5 files) |
| `ui/src/adapters/openclaw/config-fields.tsx` | 1 | Placeholder `https://paperclip.example` → `https://aoa.example`; default value `paperclip` → `aoa` (2 lines) |
| `.claude/skills/paperclip/` | 1 | `git mv` → `.claude/skills/aoa/` |
| `skills/paperclip/` | 1 | `git mv` → `skills/aoa/` (check skill loader for hardcoded path) |
| `skills/paperclip-create-agent/` | 1 | `git mv` → `skills/aoa-create-agent/` |
| `server/src/__tests__/paperclip-env.test.ts` | 1 | `git mv` → `aoa-env.test.ts`; describe block renamed |
| `docs/start/what-is-paperclip.md` | 1 | `git mv` → `what-is-aoa.md`; update body content; fix any cross-doc links |
| `ui/src/index.css` | 2 | Rename `.paperclip-mdxeditor*` and `.paperclip-project-mention-chip` to `.aoa-*` (~30 selectors) |
| `ui/src/components/MarkdownEditor.tsx` | 2 | Rename JSX className strings + classList ops (lines 300, 311, 482, 564, 566) |
| `ui/src/components/MarkdownBody.tsx` | 2 | Rename JSX className (line 56) |
| `ui/src/lib/storage-migration.ts` | 3 | **NEW** — generic localStorage rename helper with one-time migration flag |
| `ui/src/__tests__/storage-migration.test.ts` | 3 | **NEW** — unit tests for the helper |
| `ui/src/main.tsx` | 3 | Call `runStorageMigrations()` once at app boot, before any context provider mounts |
| `ui/src/lib/storage-migrations.ts` | 3 | **NEW** — registry of all `paperclip:* → aoa:*` migrations (single source of truth) |
| 14 callsites listed in Phase 3 | 3 | Update each `STORAGE_KEY` constant + add migration entry |
| `Dockerfile.onboard-smoke` | 4 | Replace `PAPERCLIPAI_VERSION` ARG → `AOA_CLI_VERSION`; `PAPERCLIP_HOME` → `AOA_HOME`; `PAPERCLIP_OPEN_ON_LISTEN` → `AOA_OPEN_ON_LISTEN`; `paperclipai@` npx → `@armyofagents/cli@` |
| `tests/README.md` | 4 | Document `AOA_E2E_PORT` / `AOA_E2E_SKIP_LLM` (env-compat aliases keep `PAPERCLIP_E2E_*` working — note that) |
| `docs/deploy/docker.md`, `docs/deploy/environment-variables.md`, `docs/guides/openclaw-docker-setup.md` | 4 | Sweep `PAPERCLIP_*` examples to `AOA_*`, mention the compat sunset |
| `cli/CHANGELOG.md`, `README.md` | 4 | Sweep references |
| `packages/db/src/schema/agent_runtime_state.ts` (or where) | 5 | (no schema change) — migration writes new key, dual-read in code |
| `server/src/services/heartbeat.ts:80,82` | 5 | Add new constants `AOA_DEFERRED_WAKE_CONTEXT_KEY = "_aoaWakeContext"`, `REPO_ONLY_CWD_SENTINEL_NEW = "/__aoa_repo_only__"`; dual-read; write only new key |
| `server/src/services/projects.ts:16` | 5 | Update sentinel constant |
| `packages/db/src/migrations/00XX_aoa_sentinels.sql` | 5 | **NEW** Drizzle migration: backfill `agent_runtime_state.context` and `project_workspaces.cwd` |
| `.github/workflows/pr.yml:99-170` | 7 | Tighten brand-check to flag any new `paperclip:*` localStorage key, any `[paperclip]` log prefix, etc. (additional patterns) |

---

# Phase 1: Quick wins — zero cascade

Each item is independently committable. Total surface ≈ 60 line edits across 12 files + 4 dir renames.

## Task 1.1: Eval prompts — `PAPERCLIP_*` → `AOA_*`

**Files:**
- Modify: `evals/promptfoo/prompts/task-agent-system.txt`
- Modify: `evals/promptfoo/prompts/internal-agent-system.txt`

- [ ] **Step 1: Apply replacements**

In `evals/promptfoo/prompts/task-agent-system.txt`, lines 4-10 and line 18, replace each token:
```
PAPERCLIP_AGENT_ID    → AOA_AGENT_ID
PAPERCLIP_COMPANY_ID  → AOA_COMPANY_ID
PAPERCLIP_API_URL     → AOA_API_URL
PAPERCLIP_RUN_ID      → AOA_RUN_ID
PAPERCLIP_TASK_ID     → AOA_TASK_ID
PAPERCLIP_WAKE_REASON → AOA_WAKE_REASON
PAPERCLIP_APPROVAL_ID → AOA_APPROVAL_ID
```

In `evals/promptfoo/prompts/internal-agent-system.txt`, lines 4-5:
```
PAPERCLIP_COMPANY_ID  → AOA_COMPANY_ID
PAPERCLIP_API_URL     → AOA_API_URL
```

- [ ] **Step 2: Verify**

```
grep -rn "PAPERCLIP_" evals/promptfoo/prompts/
```
Expected: no output (zero hits).

```
pnpm evals:validate
```
Expected: PASS.

- [ ] **Step 3: Commit**

```
git add evals/promptfoo/prompts/task-agent-system.txt evals/promptfoo/prompts/internal-agent-system.txt
git commit -m "evals: rename PAPERCLIP_* env vars to AOA_* in agent prompts

Stops teaching agents the legacy env-var names. Runtime env-compat
layer (server/src/env-compat.ts) still mirrors PAPERCLIP_* → AOA_* for
deployments that haven't migrated, so both names resolve at the OS
level — but the authoritative name in prompts is now AOA_*."
```

**Cascade analysis:**
- Already-trained or in-flight agents: unaffected (prompts read at agent-spawn time).
- The `server/src/__tests__/default-agent-instructions.test.ts:31` test already asserts the *bundled* HEARTBEAT.md uses `AOA_*`. We're aligning the eval prompts with that contract.
- No code reads these prompt files outside the eval harness.

---

## Task 1.2: Log prefix `[paperclip]` → `[aoa]`

**Files:**
- Modify: `scripts/dev-runner.mjs:40,42`
- Modify: `server/src/app.ts:321`
- Modify: `server/src/services/heartbeat.ts:2212,2265,2391` (and any other `[paperclip]` lines — grep before edit)
- Modify: `packages/adapters/claude-local/src/server/execute.ts` (lines 353, 536; grep first)
- Modify: `packages/adapters/codex-local/src/server/execute.ts` (lines 96, 101, 235, 250, 256, 405; grep first)
- Modify: `packages/adapters/cursor-local/src/server/execute.ts` (lines 117, 130, 147, 152, 321, 337, 343, 527; grep first)
- Modify: `packages/adapters/gemini-local/src/server/execute.ts` (lines 175, 193, 377; grep first)
- Modify: `packages/adapters/opencode-local/src/server/execute.ts` (lines 74, 79, 193, 212, 218, 363; grep first)

- [ ] **Step 1: Sweep**

```
grep -rn "\[paperclip\]" --include="*.ts" --include="*.mjs" --include="*.js" \
  --exclude-dir=node_modules --exclude-dir=dist .
```
Capture every line into a checklist; replace `[paperclip]` with `[aoa]` in each. **Do NOT touch `.changeset/`, `docs/audit/`, `docs/telemetry.md`, or audit raw files.**

- [ ] **Step 2: Search for tests that grep this prefix**

```
grep -rn "\[paperclip\]" --include="*.test.ts" --include="*.test.tsx" \
  --exclude-dir=node_modules .
```
Expected: no matches (or matches only in the audit docs). If a test asserts on this prefix, update the test in the same commit.

- [ ] **Step 3: Verify build**

```
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```
git add -A -- 'packages/adapters/*/src/server/execute.ts' \
              server/src/app.ts \
              server/src/services/heartbeat.ts \
              scripts/dev-runner.mjs
git commit -m "chore: rename [paperclip] log prefix to [aoa] across adapters and scripts

Pure log output rename. Affects stderr/stdout lines emitted by all
local adapters (claude/codex/cursor/gemini/opencode), the heartbeat
service, the API server's UI-fallback warning, and the dev-runner
mode banner. No functional change."
```

**Cascade analysis:**
- External log aggregation rules looking for `[paperclip]` would break — list as a documented breaking change in the next changelog entry.
- Adapter stdout is captured into `agent_runs.transcript` rows. Old transcripts retain `[paperclip]`; new transcripts use `[aoa]`. Both readable.
- Heartbeat lines 80, 82 (`DEFERRED_WAKE_CONTEXT_KEY`, `REPO_ONLY_CWD_SENTINEL`) are NOT touched in this task — they're DB sentinels, deferred to Phase 5.

---

## Task 1.3: Placeholder strings

**Files:**
- Modify: `ui/src/adapters/openclaw/config-fields.tsx:121,151,155`

- [ ] **Step 1: Replace the three lines**

Replace:
```
placeholder="https://paperclip.example"   →   placeholder="https://aoa.example"
String(config.sessionKey ?? "paperclip")  →   String(config.sessionKey ?? "aoa")
placeholder="paperclip"                    →   placeholder="aoa"
```

The `sessionKey` change is **NOT a wire-compat field** — it's a default value for new OpenClaw configs. Existing configs in the DB keep their stored `sessionKey` (whatever the user set). Only freshly-created configs default to `"aoa"` instead of `"paperclip"`.

- [ ] **Step 2: Verify**

```
grep -n "paperclip" ui/src/adapters/openclaw/config-fields.tsx
```
Expected: no output.

- [ ] **Step 3: Commit**

```
git add ui/src/adapters/openclaw/config-fields.tsx
git commit -m "ui: replace 'paperclip' placeholder/default in OpenClaw config form

Default sessionKey for new configs is now 'aoa' rather than 'paperclip'.
Existing configs are unaffected — the DB-stored value is read back as-is."
```

**Cascade analysis:**
- Stored OpenClaw configs: untouched. The default only applies when `config.sessionKey` is undefined (new configs).
- The Hermes server expecting a specific `sessionKey` value: **the user picks the sessionKey explicitly** when registering with Hermes — the default just primes the form. No protocol break.

---

## Task 1.4: Rename `paperclip-env.test.ts`

**Files:**
- Rename: `server/src/__tests__/paperclip-env.test.ts` → `server/src/__tests__/aoa-env.test.ts`
- Modify: the test's `describe` string

- [ ] **Step 1: Move the file**

```
git mv server/src/__tests__/paperclip-env.test.ts server/src/__tests__/aoa-env.test.ts
```

- [ ] **Step 2: Update the describe block**

Open the file, find any `describe("paperclip", ...)` or similar, rename to `describe("aoa env compat", ...)`. The test still asserts `PAPERCLIP_*` mirroring works — that assertion stays unchanged (it's testing the compat layer behavior, not the brand).

- [ ] **Step 3: Verify**

```
pnpm --filter @armyofagents/server exec vitest run src/__tests__/aoa-env.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```
git add server/src/__tests__/aoa-env.test.ts server/src/__tests__/paperclip-env.test.ts
git commit -m "test: rename paperclip-env.test.ts to aoa-env.test.ts

Test still verifies the PAPERCLIP_* → AOA_* env-compat mirror;
renamed for consistency with the rest of the AoA brand. The actual
PAPERCLIP_* env-var coverage in the assertions is preserved."
```

**Cascade analysis:**
- No code imports this file. Pure rename.

---

## Task 1.5: Rename Claude Code skill dirs

**Files:**
- Rename: `.claude/skills/paperclip/` → `.claude/skills/aoa/`
- Rename: `skills/paperclip/` → `skills/aoa/`
- Rename: `skills/paperclip-create-agent/` → `skills/aoa-create-agent/`

- [ ] **Step 1: Audit incoming references**

```
grep -rn "skills/paperclip\|skills\.paperclip\|paperclip-create-agent" \
  --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=docs/audit --exclude-dir=.changeset .
```
Build a list of every callsite. Common spots: skill-loader code in `server/src/`, plugin examples, docs.

- [ ] **Step 2: Move each dir**

```
git mv .claude/skills/paperclip .claude/skills/aoa
git mv skills/paperclip skills/aoa
git mv skills/paperclip-create-agent skills/aoa-create-agent
```

- [ ] **Step 3: Update references**

For each callsite found in Step 1, replace `paperclip` with `aoa` in the path. Make sure to update both literal string paths and any glob patterns.

- [ ] **Step 4: Verify**

```
grep -rn "skills/paperclip" --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=docs/audit --exclude-dir=.changeset .
pnpm typecheck
pnpm test:run
```
First grep should return no hits. Tests should pass.

- [ ] **Step 5: Commit**

```
git add -A -- skills/ .claude/skills/ <any-files-with-import-updates>
git commit -m "chore: rename skill dirs from paperclip to aoa

Renames .claude/skills/paperclip → .claude/skills/aoa,
skills/paperclip → skills/aoa, skills/paperclip-create-agent →
skills/aoa-create-agent. Updates all path references in the loader
and docs. Pure rename — skill contents unchanged."
```

**Cascade analysis:**
- If anyone has `.claude/skills/paperclip` referenced in their own dotfiles/local Claude Code config, it'll silently miss. Low impact — these dotfiles are user-local.
- Skill-loader at runtime reads `skills/` glob. Path moves; loader picks them up at the new path.

---

## Task 1.6: Rename `what-is-paperclip.md`

**Files:**
- Rename: `docs/start/what-is-paperclip.md` → `docs/start/what-is-aoa.md`
- Modify: any cross-doc links pointing to the old path

- [ ] **Step 1: Audit references**

```
grep -rn "what-is-paperclip" --exclude-dir=node_modules --exclude-dir=.git .
```

- [ ] **Step 2: Move + update content + fix links**

```
git mv docs/start/what-is-paperclip.md docs/start/what-is-aoa.md
```

In the new file body: update the `# Title`, intro paragraph, and any in-body "Paperclip" → "AoA" except where the doc explicitly explains the project's history with the upstream Paperclip name (decide per paragraph; preserve attribution).

For each cross-link found in Step 1, update the path.

- [ ] **Step 3: Commit**

```
git add docs/
git commit -m "docs: rename what-is-paperclip → what-is-aoa and refresh body

Renames the intro doc and updates body copy where it referred to the
project as 'Paperclip'. Preserves explicit attribution paragraphs
that describe the upstream Paperclip project as historical context."
```

**Cascade analysis:**
- Mintlify nav config: if `docs/mint.json` (or similar) lists this doc by path, update it.
- External links to the old URL break. Acceptable for a v1 doc-tree rename.

---

# Phase 2: CSS class rename

**Files:**
- Modify: `ui/src/index.css` (~30 selectors)
- Modify: `ui/src/components/MarkdownEditor.tsx` (lines 300, 311, 482, 564, 566)
- Modify: `ui/src/components/MarkdownBody.tsx` (line 56)
- Create: `ui/src/__tests__/markdown-editor-classes.test.tsx` (NEW — pins the rename)

## Task 2.0: Pin the rename with a failing test (TDD)

**File:**
- Create: `ui/src/__tests__/markdown-editor-classes.test.tsx`

- [ ] **Step 1: Write the test that asserts the renamed classes**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownBody } from "../components/MarkdownBody";

describe("MarkdownBody renders aoa-* classes (Paperclip rename)", () => {
  it("uses aoa-project-mention-chip on project mention links", () => {
    const { container } = render(
      <MarkdownBody markdown={"see [Dev](/projects/dev)"} />
    );
    // Once the rename lands, the link should carry the aoa-* class.
    expect(container.querySelector(".aoa-project-mention-chip")).not.toBeNull();
    // And no paperclip-* class should remain anywhere in the rendered DOM.
    expect(container.querySelector("[class*='paperclip-']")).toBeNull();
  });
});
```

(If `MarkdownBody` requires extra context providers, mock them minimally; copy the pattern from `ui/src/__tests__/NewProjectDialog-functionType.test.tsx`.)

- [ ] **Step 2: Run, expect FAIL**

```
pnpm --filter @armyofagents/ui exec vitest run src/__tests__/markdown-editor-classes.test.tsx
```
Expected: FAIL — current code emits `paperclip-project-mention-chip`.

- [ ] **Step 3: Commit just the failing test**

```
git add ui/src/__tests__/markdown-editor-classes.test.tsx
git commit -m "test(wip): pin paperclip→aoa CSS class rename with failing test"
```

(Optional but recommended — by committing the failing test first, the next commit's diff cleanly shows "test goes from red to green".)

## Task 2.1: Rename `.paperclip-*` CSS classes to `.aoa-*`

The renames:
- `paperclip-mdxeditor` → `aoa-mdxeditor`
- `paperclip-mdxeditor-scope` → `aoa-mdxeditor-scope`
- `paperclip-mdxeditor--borderless` → `aoa-mdxeditor--borderless`
- `paperclip-mdxeditor-content` → `aoa-mdxeditor-content`
- `paperclip-project-mention-chip` → `aoa-project-mention-chip`

- [ ] **Step 1: Apply atomic replacement**

```
grep -rn "paperclip-mdxeditor\|paperclip-project-mention-chip" \
  ui/src --include="*.css" --include="*.tsx" --include="*.ts"
```
For each hit, replace `paperclip-` with `aoa-`.

The 5 classes appear in:
- `ui/src/index.css` (selector definitions)
- `ui/src/components/MarkdownEditor.tsx` (5 JSX className strings + 2 `classList.add/remove`)
- `ui/src/components/MarkdownBody.tsx` (1 JSX className)

- [ ] **Step 2: Verify**

```
grep -rn "paperclip-mdxeditor\|paperclip-project-mention-chip" ui/
```
Expected: no output.

```
pnpm --filter @armyofagents/ui exec tsc --noEmit
pnpm --filter @armyofagents/ui dev   # spot-check the markdown editor renders styled
```

- [ ] **Step 3: Visual smoke**

Open `/TES/projects/dev/issues`, click **+ New Task**. Verify:
- The description editor renders with proper toolbar styling (means `.aoa-mdxeditor` rules are matching).
- Type a `@`-mention; the chip renders with the styled background (means `.aoa-project-mention-chip` matches).
- Borderless variant renders without border (some embed contexts).

- [ ] **Step 4: Commit**

```
git add ui/src/index.css ui/src/components/MarkdownEditor.tsx ui/src/components/MarkdownBody.tsx
git commit -m "ui: rename paperclip-mdxeditor* CSS classes to aoa-*

Pure CSS-class rename across index.css, MarkdownEditor.tsx, and
MarkdownBody.tsx. No DOM structure or styling changes — just the
class names. All five classes (.paperclip-mdxeditor,
-mdxeditor-scope, -mdxeditor--borderless, -mdxeditor-content,
-project-mention-chip) renamed to aoa-* in lockstep."
```

**Cascade analysis:**
- These are *internal* class names. No external CSS or third-party styling depends on them.
- Plugin SDK might inject content into the editor — verify plugin examples don't apply `paperclip-mdxeditor` themselves. Quick `grep packages/plugins/examples` for these classes.
- No persisted state involved.

---

# Phase 3: localStorage migration helper + 14 key renames

This is the biggest user-visible exposure. We follow the migration pattern already in `ui/src/hooks/useInboxBadge.ts:7` (`MIGRATION_FLAG_KEY`).

## Task 3.1: Create generic `migrateStorageKey` helper

**Files:**
- Create: `ui/src/lib/storage-migration.ts`
- Create: `ui/src/__tests__/storage-migration.test.ts`

- [ ] **Step 1: Write the failing test**

`ui/src/__tests__/storage-migration.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { migrateStorageKey } from "../lib/storage-migration";

describe("migrateStorageKey", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("copies value from old key to new key on first run", () => {
    localStorage.setItem("paperclip:foo", "hello");
    migrateStorageKey("paperclip:foo", "aoa:foo");
    expect(localStorage.getItem("aoa:foo")).toBe("hello");
    expect(localStorage.getItem("paperclip:foo")).toBeNull();
  });

  it("sets a migrated flag and is idempotent", () => {
    localStorage.setItem("paperclip:foo", "hello");
    migrateStorageKey("paperclip:foo", "aoa:foo");
    // Simulate a second app boot: write a new value to the new key, then re-run.
    localStorage.setItem("aoa:foo", "world");
    migrateStorageKey("paperclip:foo", "aoa:foo");
    expect(localStorage.getItem("aoa:foo")).toBe("world"); // not overwritten
  });

  it("does nothing if old key is absent", () => {
    migrateStorageKey("paperclip:foo", "aoa:foo");
    expect(localStorage.getItem("aoa:foo")).toBeNull();
  });

  it("does not overwrite an existing new-key value", () => {
    localStorage.setItem("paperclip:foo", "old");
    localStorage.setItem("aoa:foo", "new");
    migrateStorageKey("paperclip:foo", "aoa:foo");
    expect(localStorage.getItem("aoa:foo")).toBe("new");
    expect(localStorage.getItem("paperclip:foo")).toBeNull(); // still cleaned up
  });

  it("supports prefix migration (renames every key matching old prefix)", () => {
    localStorage.setItem("paperclip.projectOrder:co1:u1", JSON.stringify(["a", "b"]));
    localStorage.setItem("paperclip.projectOrder:co2:u1", JSON.stringify(["c"]));
    localStorage.setItem("unrelated", "x");
    migrateStorageKeyPrefix("paperclip.projectOrder:", "aoa.projectOrder:");
    expect(localStorage.getItem("aoa.projectOrder:co1:u1")).toBe(JSON.stringify(["a", "b"]));
    expect(localStorage.getItem("aoa.projectOrder:co2:u1")).toBe(JSON.stringify(["c"]));
    expect(localStorage.getItem("paperclip.projectOrder:co1:u1")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("x");
  });
});
```

(Note: the prefix variant requires a second exported function `migrateStorageKeyPrefix`.)

- [ ] **Step 2: Verify it fails**

```
pnpm --filter @armyofagents/ui exec vitest run src/__tests__/storage-migration.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`ui/src/lib/storage-migration.ts`:

```ts
/**
 * One-time migration helpers for renaming localStorage keys.
 *
 * Pattern: read the old key, copy its value to the new key (only if the
 * new key isn't already set — never clobber fresh user data), then
 * delete the old key. Idempotent: running again is a no-op once the
 * old key is gone.
 *
 * Used by the Paperclip → AoA rebrand to migrate user-visible state
 * (theme, sidebar collapse, drafts, recent picks, etc.) without
 * losing it across the rename.
 */

export function migrateStorageKey(oldKey: string, newKey: string): void {
  if (typeof window === "undefined") return; // SSR safety
  const oldVal = localStorage.getItem(oldKey);
  if (oldVal === null) return;
  if (localStorage.getItem(newKey) === null) {
    localStorage.setItem(newKey, oldVal);
  }
  localStorage.removeItem(oldKey);
}

/**
 * Rename every localStorage key starting with `oldPrefix` to use
 * `newPrefix` instead. Same no-clobber semantics as `migrateStorageKey`.
 */
export function migrateStorageKeyPrefix(oldPrefix: string, newPrefix: string): void {
  if (typeof window === "undefined") return;
  const toMigrate: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(oldPrefix)) toMigrate.push(key);
  }
  for (const oldKey of toMigrate) {
    const newKey = newPrefix + oldKey.slice(oldPrefix.length);
    migrateStorageKey(oldKey, newKey);
  }
}
```

- [ ] **Step 4: Verify it passes**

```
pnpm --filter @armyofagents/ui exec vitest run src/__tests__/storage-migration.test.ts
```
Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```
git add ui/src/lib/storage-migration.ts ui/src/__tests__/storage-migration.test.ts
git commit -m "ui: add migrateStorageKey + migrateStorageKeyPrefix helpers

Pure helpers for the Paperclip → AoA localStorage key rename.
Idempotent, no-clobber, SSR-safe. Tested with 5 cases covering
single-key, prefix, idempotency, no-old-value, and existing-new-value."
```

---

## Task 3.2: Migration registry + boot-time invocation

**Files:**
- Create: `ui/src/lib/storage-migrations.ts`
- Modify: `ui/src/main.tsx`

The registry is the single source of truth for every key that needs renaming. When we add a new migration in the future, only this file changes.

- [ ] **Step 1: Create the registry**

`ui/src/lib/storage-migrations.ts`:

```ts
import { migrateStorageKey, migrateStorageKeyPrefix } from "./storage-migration";

/**
 * Run every Paperclip → AoA localStorage migration registered below.
 * Idempotent: safe to call on every boot. Each individual migration
 * is a no-op once the old key is gone.
 *
 * Call this once, early in app boot — before any context provider
 * reads from localStorage.
 */
export function runStorageMigrations(): void {
  // Single keys (paperclip:* and paperclip.* — both punctuations were used).
  const single: Array<[string, string]> = [
    ["paperclip:inbox:dismissed", "aoa:inbox:dismissed"],
    ["paperclip:inbox:dismissed:migrated", "aoa:inbox:dismissed:migrated"],
    ["paperclip.theme", "aoa.theme"],
    ["paperclip:sidebar-collapsed", "aoa:sidebar-collapsed"],
    ["paperclip.selectedCompanyId", "aoa.selectedCompanyId"],
    ["paperclip.companyPaths", "aoa.companyPaths"],
    ["paperclip:agent-panel-open", "aoa:agent-panel-open"],
    ["paperclip:recent-assignees", "aoa:recent-assignees"],
    ["paperclip:issues-view", "aoa:issues-view"],
    ["paperclip:issue-draft", "aoa:issue-draft"],
  ];
  for (const [oldKey, newKey] of single) migrateStorageKey(oldKey, newKey);

  // Prefix-based: keys that include a dynamic id suffix.
  migrateStorageKeyPrefix("paperclip.projectOrder:", "aoa.projectOrder:");
  migrateStorageKeyPrefix("paperclip:project-view:", "aoa:project-view:");
  migrateStorageKeyPrefix("paperclip:issue-comment-draft:", "aoa:issue-comment-draft:");

  // Already-deprecated keys (cleanup-on-boot pattern in Layout.tsx) — don't
  // migrate, just delete. Layout.tsx will be updated to delete the AoA
  // names instead, but for users who never had them, this is a no-op.
  for (const dead of ["paperclip.companyOrder", "paperclip:panel-visible"]) {
    if (typeof window !== "undefined") localStorage.removeItem(dead);
  }
}
```

- [ ] **Step 2: Wire into boot**

In `ui/src/main.tsx`, find the top of the file (before any `createRoot()` call) and add:

```ts
import { runStorageMigrations } from "./lib/storage-migrations";
runStorageMigrations();
```

It must run **before** any context provider mounts (because the providers' constructors read from localStorage).

- [ ] **Step 3: Verify**

```
pnpm --filter @armyofagents/ui exec tsc --noEmit
```

Manual: in the dev preview, set `localStorage.setItem("paperclip.theme", "dark")`, hard-reload, then check `localStorage.getItem("aoa.theme") === "dark"` and `localStorage.getItem("paperclip.theme") === null`.

- [ ] **Step 4: Commit**

```
git add ui/src/lib/storage-migrations.ts ui/src/main.tsx
git commit -m "ui: add storage-migrations registry, run on app boot

Single source of truth for Paperclip → AoA localStorage key renames.
Runs before any context provider mounts so all subsequent reads see
the new names. 13 single keys + 3 prefix migrations, plus cleanup of
two already-deprecated keys."
```

---

## Task 3.2.5: Integration test for the registry

**File:**
- Create: `ui/src/__tests__/storage-migrations-registry.test.ts`

This test is what gives confidence Phase 3 doesn't lose user data. It seeds every legacy key, runs `runStorageMigrations()`, and asserts every value survived.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { runStorageMigrations } from "../lib/storage-migrations";

const SINGLE_KEY_PAIRS: Array<[string, string, string]> = [
  // [oldKey, newKey, sampleValue]
  ["paperclip:inbox:dismissed", "aoa:inbox:dismissed", JSON.stringify(["a", "b"])],
  ["paperclip:inbox:dismissed:migrated", "aoa:inbox:dismissed:migrated", "1"],
  ["paperclip.theme", "aoa.theme", "dark"],
  ["paperclip:sidebar-collapsed", "aoa:sidebar-collapsed", "true"],
  ["paperclip.selectedCompanyId", "aoa.selectedCompanyId", "co-1"],
  ["paperclip.companyPaths", "aoa.companyPaths", JSON.stringify({ co1: "/x" })],
  ["paperclip:agent-panel-open", "aoa:agent-panel-open", "true"],
  ["paperclip:recent-assignees", "aoa:recent-assignees", JSON.stringify(["a-1"])],
  ["paperclip:issues-view", "aoa:issues-view", "board"],
  ["paperclip:issue-draft", "aoa:issue-draft", JSON.stringify({ title: "x" })],
];

const PREFIX_GROUPS: Array<[string, string, Array<[string, string]>]> = [
  ["paperclip.projectOrder:", "aoa.projectOrder:", [
    ["co1:u1", JSON.stringify(["p1", "p2"])],
    ["co2:u1", JSON.stringify(["p3"])],
  ]],
  ["paperclip:project-view:", "aoa:project-view:", [
    ["proj-1", "board"],
    ["proj-2", "list"],
  ]],
  ["paperclip:issue-comment-draft:", "aoa:issue-comment-draft:", [
    ["TES-1", "draft body 1"],
    ["TES-2", "draft body 2"],
  ]],
];

describe("runStorageMigrations — full registry sweep", () => {
  beforeEach(() => localStorage.clear());

  it("migrates every single key without losing values", () => {
    for (const [oldKey, , value] of SINGLE_KEY_PAIRS) {
      localStorage.setItem(oldKey, value);
    }
    runStorageMigrations();
    for (const [oldKey, newKey, value] of SINGLE_KEY_PAIRS) {
      expect(localStorage.getItem(newKey)).toBe(value);
      expect(localStorage.getItem(oldKey)).toBeNull();
    }
  });

  it("migrates every prefix group without losing values", () => {
    for (const [oldPrefix, , entries] of PREFIX_GROUPS) {
      for (const [suffix, value] of entries) {
        localStorage.setItem(oldPrefix + suffix, value);
      }
    }
    runStorageMigrations();
    for (const [oldPrefix, newPrefix, entries] of PREFIX_GROUPS) {
      for (const [suffix, value] of entries) {
        expect(localStorage.getItem(newPrefix + suffix)).toBe(value);
        expect(localStorage.getItem(oldPrefix + suffix)).toBeNull();
      }
    }
  });

  it("is idempotent — running twice produces the same end state", () => {
    for (const [oldKey, , value] of SINGLE_KEY_PAIRS) {
      localStorage.setItem(oldKey, value);
    }
    runStorageMigrations();
    runStorageMigrations(); // second run
    for (const [oldKey, newKey, value] of SINGLE_KEY_PAIRS) {
      expect(localStorage.getItem(newKey)).toBe(value);
      expect(localStorage.getItem(oldKey)).toBeNull();
    }
  });

  it("does not overwrite a fresher value already stored under the AoA key", () => {
    localStorage.setItem("paperclip.theme", "dark");
    localStorage.setItem("aoa.theme", "light"); // user has already used the new build
    runStorageMigrations();
    expect(localStorage.getItem("aoa.theme")).toBe("light");
    expect(localStorage.getItem("paperclip.theme")).toBeNull(); // still cleaned up
  });

  it("removes already-deprecated keys without migrating them", () => {
    localStorage.setItem("paperclip.companyOrder", "should-be-deleted");
    localStorage.setItem("paperclip:panel-visible", "true");
    runStorageMigrations();
    expect(localStorage.getItem("paperclip.companyOrder")).toBeNull();
    expect(localStorage.getItem("paperclip:panel-visible")).toBeNull();
    // No corresponding aoa.* keys created either.
    expect(localStorage.getItem("aoa.companyOrder")).toBeNull();
    expect(localStorage.getItem("aoa:panel-visible")).toBeNull();
  });
});
```

- [ ] **Step 2: Run**

```
pnpm --filter @armyofagents/ui exec vitest run src/__tests__/storage-migrations-registry.test.ts
```
Expected: 5/5 PASS.

- [ ] **Step 3: Commit (with the registry from Task 3.2)**

If Task 3.2 hasn't been committed yet, fold this test into that commit. Otherwise:

```
git add ui/src/__tests__/storage-migrations-registry.test.ts
git commit -m "test: full-registry integration test for storage migration

Asserts every paperclip:/. key (10 single + 3 prefix groups + 2
already-deprecated) is migrated correctly with values preserved,
idempotent, no-clobber, and deprecated keys cleaned up. This is the
safety net that proves Phase 3 doesn't lose user state."
```

## Task 3.3: Rename keys in their source files

**Files:** 14 callsites listed below. Update each file's `STORAGE_KEY` (or equivalent) constant **only** — the registry handles migrating users.

| Constant | File:Line | Old | New |
|---|---|---|---|
| `THEME_STORAGE_KEY` | `ui/src/context/ThemeContext.tsx:19` | `paperclip.theme` | `aoa.theme` |
| `COLLAPSED_KEY` | `ui/src/context/SidebarContext.tsx:3` | `paperclip:sidebar-collapsed` | `aoa:sidebar-collapsed` |
| `STORAGE_KEY` | `ui/src/context/CompanyContext.tsx:35` | `paperclip.selectedCompanyId` | `aoa.selectedCompanyId` |
| `STORAGE_KEY` | `ui/src/hooks/useCompanyPageMemory.ts:6` | `paperclip.companyPaths` | `aoa.companyPaths` |
| `PANEL_KEY` | `ui/src/context/AgentPanelContext.tsx:4` | `paperclip:agent-panel-open` | `aoa:agent-panel-open` |
| `DISMISSED_LOCAL_STORAGE_KEY` + `MIGRATION_FLAG_KEY` | `ui/src/hooks/useInboxBadge.ts:6,7` | `paperclip:inbox:dismissed` / `:migrated` | `aoa:inbox:dismissed` / `:migrated` |
| `STORAGE_KEY` | `ui/src/lib/recent-assignees.ts:1` | `paperclip:recent-assignees` | `aoa:recent-assignees` |
| `PROJECT_ORDER_UPDATED_EVENT` | `ui/src/lib/project-order.ts:3` | `paperclip:project-order-updated` | `aoa:project-order-updated` |
| `PROJECT_ORDER_STORAGE_PREFIX` | `ui/src/lib/project-order.ts:4` | `paperclip.projectOrder` | `aoa.projectOrder` |
| `viewStateKey` literal | `ui/src/pages/Issues.tsx:153` | `paperclip:issues-view` | `aoa:issues-view` |
| `viewStateKey` literal | `ui/src/pages/ProjectDetail.tsx:201` | `paperclip:project-view:${...}` | `aoa:project-view:${...}` |
| `draftKey` literal | `ui/src/pages/IssueDetail.tsx:962` | `paperclip:issue-comment-draft:${...}` | `aoa:issue-comment-draft:${...}` |
| `draftKey` literal | `ui/src/components/TaskSlideOver.tsx:1373` | `paperclip:issue-comment-draft:${...}` | `aoa:issue-comment-draft:${...}` |
| `DRAFT_KEY` | `ui/src/components/NewIssueDialog.tsx:50` | `paperclip:issue-draft` | `aoa:issue-draft` |
| Two `removeItem` calls | `ui/src/components/Layout.tsx:47,48` | `paperclip.companyOrder` / `paperclip:panel-visible` | (drop these calls — registry handles them) |

- [ ] **Step 1: Update the test that hardcodes the migration flag key**

`ui/src/__tests__/useInboxBadge.test.tsx:24` has:
```ts
const MIGRATION_FLAG_KEY = "paperclip:inbox:dismissed:migrated";
```
Change to:
```ts
const MIGRATION_FLAG_KEY = "aoa:inbox:dismissed:migrated";
```

- [ ] **Step 2: Update each callsite's constant**

For each row in the table, edit only the `STORAGE_KEY = "..."` line (or equivalent literal).

- [ ] **Step 3: Sweep**

```
grep -rn "paperclip[:.]" ui/src --include="*.ts" --include="*.tsx" \
  | grep -v "lib/storage-migrations\|__tests__/storage-migration"
```
Expected: only the placeholder/default in `openclaw/config-fields.tsx` (already handled in Phase 1.3) — and that should already be gone if 1.3 is merged. Otherwise: zero hits in `ui/src`.

- [ ] **Step 4: Verify**

```
pnpm --filter @armyofagents/ui exec tsc --noEmit
pnpm --filter @armyofagents/ui exec vitest run
```
Expected: full UI test suite passes (especially `useInboxBadge.test.tsx`).

- [ ] **Step 5: Manual smoke**

In the running preview:
1. Set old keys: `localStorage.setItem("paperclip.theme", "dark")` / `localStorage.setItem("paperclip:sidebar-collapsed", "true")`.
2. Hard-reload.
3. Verify: theme is dark, sidebar is collapsed, AND `localStorage.getItem("paperclip.theme") === null` && `localStorage.getItem("aoa.theme") === "dark"`.

- [ ] **Step 6: Commit**

```
git add ui/src/context/*.tsx ui/src/hooks/*.ts ui/src/hooks/*.tsx \
        ui/src/pages/Issues.tsx ui/src/pages/ProjectDetail.tsx \
        ui/src/pages/IssueDetail.tsx ui/src/components/NewIssueDialog.tsx \
        ui/src/components/TaskSlideOver.tsx ui/src/components/Layout.tsx \
        ui/src/lib/recent-assignees.ts ui/src/lib/project-order.ts \
        ui/src/__tests__/useInboxBadge.test.tsx
git commit -m "ui: rename localStorage keys from paperclip:/. to aoa:/.

13 single keys + 3 prefixed key families. Existing user state is
migrated by storage-migrations.ts on next app boot, so theme,
sidebar-collapse, drafts, recent picks, project order, and inbox
dismissals are all preserved. Layout.tsx no longer hand-cleans the
two already-deprecated keys (storage-migrations handles those too)."
```

**Cascade analysis:**
- Anyone running tests that hardcode an `paperclip:*` localStorage key would fail. The only one is `useInboxBadge.test.tsx`, updated above. Verified by grep.
- Browser back/forward cache might serve stale JS that writes old keys until the cache evicts. Worst case: a user has a tab open from before the deploy that writes `paperclip:foo`. Solution: the migration runs on every boot, so the next reload picks it up.
- No server-side code reads these keys.

---

# Phase 4: Dockerfile + deploy docs

## Task 4.1: `Dockerfile.onboard-smoke`

**Files:**
- Modify: `Dockerfile.onboard-smoke:4,8,9,17,40`

- [ ] **Step 1: Replace ARGs and ENVs**

| Old | New |
|---|---|
| `ARG PAPERCLIPAI_VERSION=latest` | `ARG AOA_CLI_VERSION=latest` |
| `PAPERCLIP_HOME=/paperclip` | `AOA_HOME=/aoa` (and rename the host dir if mounted) |
| `PAPERCLIP_OPEN_ON_LISTEN=false` | `AOA_OPEN_ON_LISTEN=false` |
| `paperclipai@${PAPERCLIPAI_VERSION}` | `@armyofagents/cli@${AOA_CLI_VERSION}` |
| `mkdir -p "$PAPERCLIP_HOME"` (CMD line) | `mkdir -p "$AOA_HOME"` |
| `--data-dir "$PAPERCLIP_HOME"` | `--data-dir "$AOA_HOME"` |

The `paperclip` user/group (if created in the Dockerfile via `useradd`/`groupadd`) → consider `aoa` or `node`. Verify by reading the full file before editing.

- [ ] **Step 2: Verify the smoke harness still works**

```
pnpm docker:smoke
```
This invokes `scripts/docker-onboard-smoke.sh`. The script at line 96 already calls `@armyofagents/cli@${AOA_CLI_VERSION}` (per `docs/audit/v1.0.0/raw/S6.md:31`), so the script side is already AoA-aligned. The Dockerfile catching up should make the smoke pass on the first try.

Expected: PASS (auto-bootstrap → sign-in → bootstrap-ceo → session verify all green).

- [ ] **Step 3: Commit**

```
git add Dockerfile.onboard-smoke
git commit -m "docker: rename PAPERCLIP_* ARGs/ENVs to AOA_* in onboard-smoke

Aligns Dockerfile.onboard-smoke with the AoA brand and matches the
already-AoA-aligned scripts/docker-onboard-smoke.sh runtime invocation
(@armyofagents/cli@\${AOA_CLI_VERSION}). PAPERCLIPAI_VERSION ARG is
gone — callers must pass --build-arg AOA_CLI_VERSION instead.
PAPERCLIP_HOME → AOA_HOME inside the container; runtime env-compat
keeps PAPERCLIP_HOME working at the OS level for users who haven't
migrated their shell config."
```

**Cascade analysis:**
- Any external CI/CD passing `--build-arg PAPERCLIPAI_VERSION=...`: breaks. Document in changelog. (Mitigation if needed: keep both ARGs, default `PAPERCLIPAI_VERSION` to empty, prefer `AOA_CLI_VERSION` then fall back. Skip unless someone reports.)
- Volumes mounted at `/paperclip`: would need to be remounted at `/aoa`. List as breaking change.

---

## Task 4.2: Sweep deploy + test docs

**Files:**
- Modify: `tests/README.md` (lines 51-77 — `PAPERCLIP_E2E_*`)
- Modify: `docs/deploy/docker.md` (if it has `PAPERCLIP_*` references)
- Modify: `docs/deploy/environment-variables.md`
- Modify: `docs/guides/openclaw-docker-setup.md`
- Modify: `cli/CHANGELOG.md`
- Modify: `README.md`

- [ ] **Step 1: Sweep**

```
grep -rn "PAPERCLIP_\|paperclipai\|Paperclip" \
  --include="*.md" \
  --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=docs/audit --exclude-dir=.changeset \
  --exclude-dir=docs/aoa/specs --exclude-dir=docs/aoa/reference \
  .
```
Capture the list. **Skip** anything in audit raw, changeset history, upstream spec docs (those preserve attribution).

- [ ] **Step 2: Update each hit**

For each, replace `PAPERCLIP_FOO` with `AOA_FOO` (in env var docs), and replace user-facing brand strings ("Paperclip dashboard", "Start Paperclip") with "AoA". Add a one-line note where appropriate: *"`PAPERCLIP_*` aliases still work via the env-compat layer; switch to `AOA_*` at your convenience."*

- [ ] **Step 3: Commit**

```
git add docs/ tests/README.md cli/CHANGELOG.md README.md
git commit -m "docs: sweep PAPERCLIP_* env-var references to AOA_* across deploy & test docs

Reader-facing docs now use AOA_* as the canonical names; PAPERCLIP_*
aliases remain functional at runtime via env-compat (server/cli
import env-compat.ts at startup). Audit-raw, changeset history, and
upstream spec docs preserved for attribution."
```

**Cascade analysis:**
- Doc-only. Zero runtime impact thanks to env-compat.

---

# Phase 5: DB sentinel migration

## Task 5.1: Dual-read in heartbeat + projects services

**Files:**
- Modify: `server/src/services/heartbeat.ts:80,82`
- Modify: `server/src/services/projects.ts:16`

The two constants:

```ts
// heartbeat.ts:80 — JSON key inside agent_runtime_state.context
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
// heartbeat.ts:82 / projects.ts:16 — sentinel value in project_workspaces.cwd
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
```

These are stored in DB rows. We can't just rename them — existing rows would orphan.

**Strategy:** dual-read, single-write.
- Define new constants with `aoa` names alongside the existing ones.
- All **reads** check both old and new names.
- All **writes** use the new name only.
- A separate Drizzle migration (Task 5.2) backfills existing rows lazily.

- [ ] **Step 1: Add new constants alongside old**

In `heartbeat.ts`:
```ts
// New canonical names
const AOA_DEFERRED_WAKE_CONTEXT_KEY = "_aoaWakeContext";
const AOA_REPO_ONLY_CWD_SENTINEL = "/__aoa_repo_only__";
// Legacy names — read for compat, never written.
const LEGACY_DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const LEGACY_REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
```

In `projects.ts:16`:
```ts
const AOA_REPO_ONLY_CWD_SENTINEL = "/__aoa_repo_only__";
const LEGACY_REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
```

- [ ] **Step 2: Update reads to check both**

For `_paperclipWakeContext`:
```ts
const ctx = state.context as Record<string, unknown> | null;
const deferred = ctx?.[AOA_DEFERRED_WAKE_CONTEXT_KEY] ?? ctx?.[LEGACY_DEFERRED_WAKE_CONTEXT_KEY];
```

For `/__paperclip_repo_only__`:
```ts
function isRepoOnlySentinel(cwd: string | null): boolean {
  return cwd === AOA_REPO_ONLY_CWD_SENTINEL || cwd === LEGACY_REPO_ONLY_CWD_SENTINEL;
}
// at every callsite: replace `cwd === REPO_ONLY_CWD_SENTINEL` with `isRepoOnlySentinel(cwd)`
```

- [ ] **Step 3: Update writes to use new name only**

```ts
// In heartbeat.ts where the deferred wake context is set:
ctx[AOA_DEFERRED_WAKE_CONTEXT_KEY] = newWakePayload;
// Make sure the legacy key is removed from the same object on write:
delete ctx[LEGACY_DEFERRED_WAKE_CONTEXT_KEY];
```

```ts
// Where REPO_ONLY_CWD_SENTINEL is set on a workspace cwd:
workspaceCwd = AOA_REPO_ONLY_CWD_SENTINEL;
```

- [ ] **Step 4: Add tests**

Create `server/src/__tests__/aoa-sentinel-compat.test.ts`. Use the project's mock-DB pattern (`createSequenceDb`) seen in other server tests under `server/src/__tests__/`. Tests:

```ts
import { describe, it, expect, vi } from "vitest";

// (Mock @armyofagents/db + drizzle-orm following the pattern in
// existing tests — e.g. how heartbeat.test.ts mocks them.)

describe("paperclip→aoa sentinel dual-read", () => {
  it("reads _paperclipWakeContext as if it were _aoaWakeContext", async () => {
    // Seed a fake agent_runtime_state row whose context column is
    //   { "_paperclipWakeContext": { reason: "x", payload: { p: 1 } } }
    // Call the heartbeat read path. Expect the same deferred wake to be
    // resumed as if it had been written under _aoaWakeContext.
  });

  it("write replaces both keys with only _aoaWakeContext", async () => {
    // Seed context: { "_paperclipWakeContext": "stale", "other": 1 }
    // Call the write path that sets a deferred wake.
    // Expect resulting context: { "_aoaWakeContext": <new>, "other": 1 }
    // (legacy key removed, no _paperclipWakeContext residue)
  });

  it("treats /__paperclip_repo_only__ cwd as repo-only", async () => {
    // Seed project_workspaces row with cwd = "/__paperclip_repo_only__".
    // Call the path that branches on isRepoOnlySentinel().
    // Expect repo-only branch taken, same as if cwd were "/__aoa_repo_only__".
  });

  it("treats /__aoa_repo_only__ cwd as repo-only", async () => {
    // Same as above but with the new sentinel — confirms the new path works.
  });

  it("workspace creation writes /__aoa_repo_only__, never /__paperclip_repo_only__", async () => {
    // Trigger a workspace-create code path that uses the sentinel.
    // Inspect the persisted row — assert cwd === "/__aoa_repo_only__".
  });
});
```

Stub the DB calls; this is a unit test of the dual-read/single-write logic, not a real-DB integration test. The Drizzle migration (Task 5.2) covers the real-DB side.

- [ ] **Step 5: Verify**

```
pnpm --filter @armyofagents/server exec tsc --noEmit
pnpm --filter @armyofagents/server test:run
```

- [ ] **Step 6: Commit**

```
git add server/src/services/heartbeat.ts server/src/services/projects.ts \
        server/src/__tests__/aoa-sentinel-compat.test.ts
git commit -m "server: dual-read paperclip→aoa DB sentinels; write only AoA names

Renames the in-DB sentinel constants used by the heartbeat service
(_paperclipWakeContext key in agent_runtime_state.context) and the
workspace-cwd sentinel (/__paperclip_repo_only__ in
project_workspaces.cwd). Reads accept both old and new names; writes
emit only the new AoA names, and writes that touch a row also strip
the legacy key from the same blob so we converge over time."
```

---

## Task 5.2: One-shot Drizzle migration to backfill existing rows

**Files:**
- Create: `packages/db/src/migrations/00XX_aoa_sentinels.sql` (let `pnpm db:generate` pick the next number)
- Verify against: `packages/db/src/schema/agent_runtime_state.ts`, `packages/db/src/schema/project_workspaces.ts` (no schema change, just a data migration)

- [ ] **Step 1: Generate the migration scaffold**

We're not changing the schema, so `pnpm db:generate` won't auto-create one. Manually create the file. Filename example: `0060_aoa_sentinels.sql` (use the next number after the latest existing migration).

- [ ] **Step 2: Write the SQL**

```sql
-- Migrate Paperclip → AoA in-row sentinels.
-- Idempotent: every UPDATE has a WHERE that drops it to a no-op on rerun.

-- 1. project_workspaces.cwd: replace literal sentinel string.
UPDATE project_workspaces
SET cwd = '/__aoa_repo_only__'
WHERE cwd = '/__paperclip_repo_only__';

-- 2. agent_runtime_state.context (jsonb): rename top-level key
--    _paperclipWakeContext → _aoaWakeContext.
UPDATE agent_runtime_state
SET context = (
  context - '_paperclipWakeContext'
) || jsonb_build_object('_aoaWakeContext', context -> '_paperclipWakeContext')
WHERE context ? '_paperclipWakeContext';
```

- [ ] **Step 3: Test the migration locally**

```
# On a fresh embedded-pg dev DB, seed a row with the legacy values via the
# existing test fixtures or psql:
psql ... -c "
  INSERT INTO project_workspaces (..., cwd, ...) VALUES (..., '/__paperclip_repo_only__', ...);
  UPDATE agent_runtime_state SET context = jsonb_set(context, '{_paperclipWakeContext}', '\"hello\"', true) WHERE id = '...';
"

pnpm db:migrate
psql ... -c "SELECT cwd FROM project_workspaces WHERE cwd LIKE '%aoa%';"
psql ... -c "SELECT context ? '_aoaWakeContext' AS migrated, context ? '_paperclipWakeContext' AS legacy FROM agent_runtime_state;"
```

Expected: `migrated = true`, `legacy = false` after the migration runs.

- [ ] **Step 4: Run idempotency check**

```
pnpm db:migrate   # second time
```
Expected: PASS, zero rows updated. (Drizzle normally tracks applied migrations, so the file won't run twice; but if you manually re-run the SQL, the WHERE clauses make it a no-op.)

- [ ] **Step 4b: Add a real-DB migration test**

Create `packages/db/src/__tests__/0060_aoa_sentinels-migration.test.ts`. Pattern: spin up `embedded-postgres`, seed with legacy values, run the migration via the same code path Drizzle uses, assert the rows.

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

describe("0060_aoa_sentinels migration", () => {
  let pg: EmbeddedPostgres;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-mig-test-"));
    pg = new EmbeddedPostgres({ databaseDir: dataDir, port: 0 /* random */ });
    await pg.initialise();
    await pg.start();
    // Run migrations up to 0059 only? Easier: run all migrations, then
    // manually re-introduce the legacy values, then re-run 0060
    // (idempotent) and assert. Or seed schema manually for the
    // 2 columns we care about.
  }, 60_000);

  afterAll(async () => {
    await pg.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("converts legacy /__paperclip_repo_only__ cwd to /__aoa_repo_only__", async () => {
    // Insert a project_workspaces row with the legacy sentinel via raw SQL.
    // Run the migration SQL.
    // SELECT cwd; expect "/__aoa_repo_only__".
  });

  it("renames _paperclipWakeContext jsonb key to _aoaWakeContext", async () => {
    // Insert agent_runtime_state row with context={"_paperclipWakeContext": {...}, "x": 1}.
    // Run the migration SQL.
    // SELECT context; expect _aoaWakeContext present with same value, _paperclipWakeContext absent, x preserved.
  });

  it("is idempotent — second run changes zero rows", async () => {
    // After the first run above, run the SQL a second time.
    // Use UPDATE ... RETURNING to count affected rows.
    // Expect 0.
  });
});
```

Run: `pnpm --filter @armyofagents/db exec vitest run src/__tests__/0060_aoa_sentinels-migration.test.ts`. Expected: 3/3 PASS.

If `embedded-postgres` setup is slow/flaky inside vitest, fall back to: run `pnpm db:migrate` against a fresh dev DB after seeding via psql, manually verify with the queries from Step 3. Document the manual check in the PR description.

- [ ] **Step 5: Commit**

```
git add packages/db/src/migrations/00XX_aoa_sentinels.sql
git commit -m "db: backfill paperclip→aoa sentinels in project_workspaces.cwd and agent_runtime_state.context

One-shot data migration. Renames /__paperclip_repo_only__ →
/__aoa_repo_only__ in project_workspaces.cwd, and the
_paperclipWakeContext jsonb key → _aoaWakeContext in
agent_runtime_state.context. Both UPDATEs are idempotent (WHERE
clauses gate them to legacy rows only).

The dual-read code in heartbeat.ts/projects.ts is still in place so
rollback is safe — if this migration is reverted, code continues to
read both names."
```

**Cascade analysis:**
- After this lands, every NEW write uses AoA names; every legacy row gets backfilled by this migration.
- The dual-read code becomes effectively dead after a few weeks. Schedule its removal in a follow-up release (one-line: drop the LEGACY constants and the OR clause).
- Rollback safety: if we revert the migration, the dual-read code still works because the old keys are just absent from new writes — old rows would still be readable.

---

# Phase 6: Hermes wire fields — DEFERRED

**Files (do not touch yet):**
- `packages/adapters/openclaw/src/server/execute-webhook.ts:79,80` — `paperclip_session_key`, `paperclip_stream_transport`
- `packages/adapters/openclaw/src/server/execute-sse.ts:279` — `paperclip_session_key`
- `scripts/smoke/openclaw-sse-standalone.sh:90` — `paperclip_session_key` in test payload
- `packages/adapters/openclaw/README.md:75` — documents the field

These are field names in the JSON payload sent to Hermes/OpenClaw runtime. Renaming **breaks every existing OpenClaw deployment** that hasn't been re-deployed with matching server-side changes.

**Decision required (record in a follow-up changeset):**
- **Option A — Keep wire-compat**: leave the field names. Add internal type aliases so the TS code reads `aoa_session_key` while the JSON wire still says `paperclip_session_key`. Low effort, no breaking change.
- **Option B — Bump protocol version**: introduce a new field name AND a `protocolVersion` field. Server-side accepts both. Coordinate with upstream Hermes.
- **Option C — Bulk rename + minor-version bump**: announce, document, ship in next minor.

Defer until the user picks an option. **Do not include in the current PR series.**

---

# Phase 7: Brand-check CI tightening (optional polish)

**Files:**
- Modify: `.github/workflows/pr.yml:99-170`

After Phases 1–5 land, add these checks to the brand-check job so future regressions are caught at PR time:

- [ ] **Step 1: Add localStorage-key check**

```yaml
# 5. No paperclip:/. localStorage keys outside the migration registry.
ls_hits=$(grep -rnE 'localStorage\.(set|get|remove)Item\([^)]*paperclip' \
  --include='*.ts' --include='*.tsx' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
  ui/src 2>/dev/null \
  | grep -v 'lib/storage-migrations\|__tests__/storage-migration' || true)
if [ -n "$ls_hits" ]; then
  echo "::error::Found paperclip:/. localStorage references in ui/src (use aoa: prefix; legacy reads only allowed in storage-migrations.ts):"
  printf '%s\n' "$ls_hits"
  failed=1
fi
```

- [ ] **Step 2: Add `[paperclip]` log-prefix check**

```yaml
# 6. No [paperclip] log prefixes outside docs.
log_hits=$(grep -rnE '\[paperclip\]' \
  --include='*.ts' --include='*.tsx' --include='*.mjs' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
  server/src ui/src cli/src packages/adapters scripts 2>/dev/null || true)
if [ -n "$log_hits" ]; then
  echo "::error::Found [paperclip] log prefix (rename to [aoa]):"
  printf '%s\n' "$log_hits"
  failed=1
fi
```

- [ ] **Step 3: Add `paperclip-mdxeditor` CSS-class check**

```yaml
# 7. No paperclip-mdxeditor CSS classes (renamed to aoa-mdxeditor).
css_hits=$(grep -rnE 'paperclip-(mdxeditor|project-mention-chip)' \
  --include='*.css' --include='*.tsx' --include='*.ts' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
  ui/src 2>/dev/null || true)
if [ -n "$css_hits" ]; then
  echo "::error::Found paperclip-* CSS classes (rename to aoa-*):"
  printf '%s\n' "$css_hits"
  failed=1
fi
```

- [ ] **Step 4: Verify on PR**

Open a draft PR and watch the brand-check job run. Expected: PASS on a clean branch; FAIL if any developer accidentally re-introduces a banned pattern.

- [ ] **Step 5: Commit**

```
git add .github/workflows/pr.yml
git commit -m "ci: tighten brand-check to flag new localStorage/log/CSS regressions

Three new patterns now blocked at PR time: paperclip:/. localStorage
keys outside the migration registry, [paperclip] log prefixes, and
paperclip-mdxeditor* CSS classes. Existing wire-compat allow-list
(PAPERCLIP_* env vars, paperclipai bin alias, plugin globals,
schemaVersions) preserved."
```

---

# Self-Review

**1. Spec coverage:**
- Eval prompts → Phase 1.1
- Log prefix → Phase 1.2
- Placeholder strings → Phase 1.3
- File/dir renames → Phase 1.4 / 1.5 / 1.6
- CSS classes → Phase 2
- localStorage keys (all 14) → Phase 3
- Dockerfile + deploy docs → Phase 4
- DB sentinels → Phase 5
- Hermes wire fields → Phase 6 (deferred, decision required)
- CI tightening → Phase 7

**2. Placeholder scan:** no "TBD", "implement later", "handle edge cases" — every step has the actual code, command, or file:line reference. The Phase 5 migration filename uses `00XX_` because the next migration number depends on the state of the migrations dir at execution time; this is documented in Step 1.

**3. Type / name consistency:**
- `migrateStorageKey(oldKey, newKey)` defined in Task 3.1 and called identically in Task 3.2.
- `migrateStorageKeyPrefix(oldPrefix, newPrefix)` defined in Task 3.1 and called identically in Task 3.2.
- `runStorageMigrations()` defined in Task 3.2 and called from `main.tsx` in the same task.
- DB constants `AOA_*` / `LEGACY_*` defined in heartbeat.ts and consumed in projects.ts via the same naming convention.

**4. Risk notes:**

- **Phase 3** is the highest user-visible risk. Mitigation: the migration runs on every boot (idempotent), and the no-clobber semantics never overwrite fresher state.
- **Phase 5** has database state in flight. Mitigation: dual-read (Task 5.1) ships before the data migration (Task 5.2). If Task 5.2 fails for any row, dual-read covers it; we can re-run.
- **Phase 4 (Dockerfile)** breaks `--build-arg PAPERCLIPAI_VERSION=...` in external CI. Mitigation: documented breaking change. If anyone reports, add a one-line ARG fallback.
- **Phase 6 (Hermes)** is deliberately not attempted — the wire-format break is a coordination problem, not a code problem.

**5. Estimated effort (sequential, single dev — now including new tests):**
- Phase 1: 1.5 hours (60-line sweep across 12 files + 4 dir renames; relies on existing test suite as the safety net)
- Phase 2: 1 hour (CSS rename + new `markdown-editor-classes.test.tsx` to pin it)
- Phase 3: 4 hours (helper + 5 helper tests + registry + **new full-sweep registry test (5 cases)** + 14 callsites + boot wire-up + manual smoke)
- Phase 4: 1 hour (Dockerfile + 5-6 doc files; existing `pnpm docker:smoke` is the test)
- Phase 5: 4 hours (dual-read + **new compat unit test (5 cases)** + SQL migration + **new real-DB migration test (3 cases)** + verify)
- Phase 7: 30 minutes
- **Total: ~12 hours focused.**

Phases 1, 2, 4, 7 can run in parallel; Phase 3 depends on nothing; Phase 5 stands alone. Realistic calendar: one or two days end-to-end.

**6. Net new test coverage:**
- 1 new unit-test file in Phase 2 (CSS class assertions in `MarkdownBody`)
- 2 new test files in Phase 3 (helper + full-registry sweep, ~10 cases total)
- 2 new test files in Phase 5 (dual-read unit + real-DB migration, ~8 cases total)
- = **5 new test files / ~23 new test cases** — small, focused, all pinning the high-risk parts of the rename.

Plus every phase runs the **existing ~250-test vitest suite** + **playwright e2e** + **brand-check CI** before commit. If any regressed flow exists, those gates catch it.
