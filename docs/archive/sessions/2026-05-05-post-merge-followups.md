# Post-Merge Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the 16 follow-up items identified during the PR #118 code review + Quality Baseline closeout. The codex bot's P2 comment is already resolved (PR #119 merged its fix into Porting1.1). Item 10's recommended host-binding guard already exists in code (`server/src/index.ts:413-417`). The remaining 12 items split across 4 sequential phases.

**Architecture:** Four phases ordered by risk + effort. Phase 1 = operational hygiene (3 user-only GitHub Settings actions + 1 small CI release-workflow fix). Phase 2 = 4 quick-win code PRs. Phase 3 = 3 cross-platform CI PRs (Issues #112/#113/#114, the largest of which is ~1 day). Phase 4 = manual UI verification of Issue #96. Each task is its own PR following the established pattern. Items 17 (Docker tag-only), 18 (self-hosted runner), 19 (V2.5/V3 product roadmap) are explicitly out-of-scope (see "Deferred / Out of Scope" at the end).

**Tech Stack:** Same as Porting1.1 (Express 5.x, Drizzle ORM, Vitest, GitHub Actions, pnpm 9.15.4). No new dependencies introduced by any task in this plan.

---

## Status of related items (resolved before plan execution)

| Item | Status | Reference |
|---|---|---|
| **Codex bot's P2 comment** ("Make `dev:watch` script cross-platform") | ✅ RESOLVED | PR #119 (commit `ec00d36`) removed the bash-style env prefix from root `package.json:8`. Verified: `grep -n "dev:watch" package.json` shows clean script. |
| **Item 10** (refuse `local_trusted` mode without loopback host binding) | ✅ ALREADY EXISTS | `server/src/index.ts:413-417` already throws `Error("local_trusted mode requires loopback host binding ...")`. No new code needed. |

The plan below covers the remaining 12 actionable items.

## Locked decisions

1. **Each code task = its own PR.** Same rule as Quality Baseline plan. Easier review, easier revert, clean blame.
2. **All PRs target `Porting1.1`** with explicit `--base Porting1.1` AND a post-creation `gh pr view <PR> --json baseRefName --jq .baseRefName` verification step (Incident 1 lesson — never trust without verifying).
3. **Phase ordering is risk-ascending**: cheap operational items first (Phase 1), then quick-wins (Phase 2), then cross-platform (Phase 3), then manual verification (Phase 4). Bulletproof first to build momentum.
4. **No new dependencies.** Every task uses what's already in the codebase.
5. **Items 17, 18, 19 are deferred.** See "Deferred / Out of Scope" at the end.
6. **Items 4, 5, 6 are USER-ONLY** (GitHub Settings clicks). The plan documents them but they cannot be executed by a subagent. The user does them manually.

## Controller-Only Decisions (subagent never decides these)

When a subagent reports back, the **controller** decides:
- Whether to halt at any halt criterion
- Whether sub-fixes within a single Issue (#112's 2 sub-fixes, #113's 3 sub-fixes) ship as one PR or separate PRs (default: one PR per Issue, but split if any sub-fix is non-trivial)
- Whether Issue #114's fix uses Option 1 (run-as-non-admin), Option 2 (postgres service container), or Option 3 (skip on Windows) — see Task 3.3
- Whether Item 11 (audit) findings warrant follow-up tasks beyond the audit document itself

The subagent decides:
- How to implement what each task description says (within the locked code blocks)
- Whether commit messages match the spec
- Whether tests pass before committing
- When to ask the controller a clarifying question

---

## Phase 1: Operational Hygiene + Release Workflow Fix

**Goal:** Close out the GitHub-Settings-side hygiene items (4, 5, 6 — user-only) and fix the chronic release workflow failure (item 7).

### Task 1.1: USER ACTION — Add `migrations` job to branch protection required checks

**This task is USER-ONLY. The subagent cannot execute it; the controller documents it for the user.**

**Why:** PR #107 added a `migrations` job (postgres:16 service container + Python chain check). It runs on every PR but isn't enforced as a required gate, so a future PR could land with broken migrations.

**Steps (for the user, not subagent):**

1. Open https://github.com/MeteoriteLabs/AoA/settings/branches
2. Click "Edit" on the `Porting1.1` branch protection rule (and `main` if/when applicable)
3. Under "Require status checks to pass before merging":
   - Confirm checked: `policy`, `brand-check`, `verify`, `e2e`
   - **Add:** `migrations`
4. Save changes.

**Note:** Branch protection state cannot be read or written via the free-plan API (returns 403). This is a manual UI action.

### Task 1.2: USER ACTION — Confirm required checks on `main`

**This task is USER-ONLY.** Same as Task 1.1, applied to the `main` branch rule. After PR #118 merges, all the `Porting1.1` infrastructure becomes part of `main`'s gating.

**Steps:** Same as Task 1.1 but on the `main` branch rule. Required: `policy`, `brand-check`, `verify`, `e2e`, `migrations`.

### Task 1.3: USER ACTION — Add Actions spending alert

**This task is USER-ONLY.**

**Why:** Today's CI billing exhaustion happened because no alert fired before hitting zero. A 50% threshold alert gives advance warning.

**Steps:**

1. Open https://github.com/settings/billing/spending_limits
2. Set Actions spending limit (e.g., $5/month if you upgrade to Pro and want a hard cap)
3. Set notification email at 50% / 75% / 90% thresholds.

### Task 1.4: Fix chronic release workflow failure (Item 7)

**Context:** `.github/workflows/release.yml` fires on every push to `master`/`main`/`Porting1.1`. It uses Changesets. On every push it fails with:

```
🦋 error Error: Found changeset phase-i2-cleanup for package aoa which is not in the workspace
```

The file `.changeset/phase-i2-cleanup.md` declares a change for package `"aoa"`, but `pnpm-workspace.yaml` doesn't include the root (root's `package.json` has `name: "aoa"`, but root isn't a workspace package). Predates today's session.

**Halt criteria (subagent stops + reports):**

- 🛑 The changeset file's content references something larger (e.g., a bundled release plan) that the controller might want to preserve in another form — STOP, report content. Controller decides delete vs repoint.
- 🛑 OTHER changesets in `.changeset/` reference `aoa` and would also need fixing — STOP, list them. Controller decides batch-fix scope.
- 🛑 Removing the file causes `pnpm changeset version` to fail in another way (e.g., orphaned references) — STOP, report.

**Files:**
- Delete: `.changeset/phase-i2-cleanup.md`

- [ ] **Step 1: Read the changeset file**

```bash
cat .changeset/phase-i2-cleanup.md
```

Expected: yaml frontmatter with `"aoa": minor` + a description of "Phase I.2 cleanup" work.

- [ ] **Step 2: Audit other changesets for `aoa` references**

```bash
grep -lE '^"aoa":' .changeset/*.md 2>&1 | head -10
```

Expected: only `.changeset/phase-i2-cleanup.md`. If others appear, STOP and report.

- [ ] **Step 3: Verify root `package.json` name is indeed `aoa`**

```bash
grep -E "^  \"name\":" package.json
```

Expected: `"name": "aoa",`. Confirms the root has the name being referenced; root isn't in `pnpm-workspace.yaml`.

- [ ] **Step 4: Branch + delete the changeset**

```bash
git checkout Porting1.1
git pull origin Porting1.1
git checkout -b ci/release-workflow-fix-changeset
git rm .changeset/phase-i2-cleanup.md
```

- [ ] **Step 5: Commit + push + open PR (verify `--base Porting1.1`)**

```bash
git commit -m "$(cat <<'EOF'
ci(release): drop orphan .changeset/phase-i2-cleanup.md

The changeset declares a change for package "aoa" — the name of the
root package.json — but root is not in pnpm-workspace.yaml's package
list. The Changesets action errors out on every push to Porting1.1 /
main with:

  🦋 error: Found changeset phase-i2-cleanup for package aoa which
  is not in the workspace

Predates today's session. The changeset's content (Phase I.2 cleanup
narrative) is already represented in actual landed work; the file
itself is residual.

Removing it stops the chronic release workflow failure on every
push event.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin ci/release-workflow-fix-changeset
gh pr create --base Porting1.1 --head ci/release-workflow-fix-changeset \
  --title "ci(release): drop orphan .changeset/phase-i2-cleanup.md" \
  --body "## Summary
- Deletes \`.changeset/phase-i2-cleanup.md\` which declares a change for package \`aoa\` (root) — not in pnpm workspaces.
- The Changesets release workflow has been failing on every push to Porting1.1 + main since this changeset was added.

## Test plan
- [ ] CI: required gates green on this PR
- [ ] Verify the next push to Porting1.1 (this PR's merge) does NOT fail the \`release\` workflow"
```

- [ ] **Step 6: VERIFY base + watch CI + merge**

```bash
PR_NUM=$(gh pr list --head ci/release-workflow-fix-changeset --state open --json number --jq '.[0].number')
gh pr view $PR_NUM --json baseRefName --jq '.baseRefName'  # MUST equal "Porting1.1"
until [ "$(gh pr checks $PR_NUM --json bucket --jq '[.[] | select(.bucket=="pending")] | length' 2>/dev/null)" = "0" ]; do sleep 60; done
gh pr checks $PR_NUM --watch=false
gh pr merge $PR_NUM --squash --delete-branch
git checkout Porting1.1 && git pull origin Porting1.1
```

- [ ] **Step 7: Confirm release workflow now passes on the post-merge push**

```bash
sleep 30
RELEASE_RUN_ID=$(gh run list --branch Porting1.1 --workflow="Release" --limit 1 --json databaseId --jq '.[0].databaseId')
until gh run view $RELEASE_RUN_ID --json status --jq '.status' 2>&1 | grep -qE "completed"; do sleep 30; done
gh run view $RELEASE_RUN_ID --json conclusion --jq '.conclusion'
```

Expected: `"success"`. If `"failure"`, capture the new error (could be a different changeset issue) and re-investigate.

---

## Phase 2: Quick Wins (small code PRs)

**Goal:** Land 4 small follow-up PRs (each <30 lines, each a single concern).

### Task 2.1: Migration 0080 — add `IF NOT EXISTS` to indexes (Item 8)

**Context:** `packages/db/src/migrations/0080_marketplace_pending_updates.sql` has 2 `CREATE INDEX` statements at lines 13-14 without `IF NOT EXISTS`. Other migrations use the defensive form. If the migration ever re-runs (e.g., a half-failed apply scenario), index creation will fail with "relation already exists".

**Halt criteria:**

- 🛑 The migration file structure has changed since planning (e.g., indexes restructured) — adjust per actual file, report.
- 🛑 Tests fail post-fix — STOP. Indexes shouldn't have functional impact; failure indicates something else.

**Files:**
- Modify: `packages/db/src/migrations/0080_marketplace_pending_updates.sql`

- [ ] **Step 1: Read current state of the migration**

```bash
sed -n '13,14p' packages/db/src/migrations/0080_marketplace_pending_updates.sql
```

Expected output:
```sql
CREATE INDEX "mpu_company_status_idx" ON "marketplace_pending_updates"("company_id","status");
CREATE UNIQUE INDEX "mpu_company_item_uq" ON "marketplace_pending_updates"("company_id","catalog_item_id");
```

- [ ] **Step 2: Branch + edit**

```bash
git checkout Porting1.1
git pull origin Porting1.1
git checkout -b fix/migration-0080-idempotent-indexes
```

Use the Edit tool. Find:
```sql
CREATE INDEX "mpu_company_status_idx" ON "marketplace_pending_updates"("company_id","status");
CREATE UNIQUE INDEX "mpu_company_item_uq" ON "marketplace_pending_updates"("company_id","catalog_item_id");
```

Replace with:
```sql
CREATE INDEX IF NOT EXISTS "mpu_company_status_idx" ON "marketplace_pending_updates"("company_id","status");
CREATE UNIQUE INDEX IF NOT EXISTS "mpu_company_item_uq" ON "marketplace_pending_updates"("company_id","catalog_item_id");
```

- [ ] **Step 3: Verify the migrations-from-scratch CI job is unaffected**

The migrations job in `pr.yml` runs `pnpm db:migrate` which calls `applyPendingMigrations()`. `IF NOT EXISTS` is benign on a fresh database (nothing exists, so the index gets created). On a re-run scenario, it now no-ops cleanly instead of erroring.

```bash
python -c "
import re
content = open('packages/db/src/migrations/0080_marketplace_pending_updates.sql').read()
assert 'CREATE INDEX IF NOT EXISTS' in content
assert 'CREATE UNIQUE INDEX IF NOT EXISTS' in content
print('OK: both indexes are now idempotent')
"
```

Expected: `OK: both indexes are now idempotent`.

- [ ] **Step 4: Commit + push + open PR (verify base = Porting1.1)**

```bash
git add packages/db/src/migrations/0080_marketplace_pending_updates.sql
git commit -m "$(cat <<'EOF'
fix(db): make migration 0080 indexes idempotent

migration 0080 (marketplace_pending_updates) creates two indexes via
plain CREATE INDEX / CREATE UNIQUE INDEX. Other migrations use
IF NOT EXISTS for both tables and indexes; this one does not.

If the migration ever re-applies (half-failed apply, reconciliation
path, etc.), the duplicate-index error halts the batch.

Add IF NOT EXISTS to both indexes. No-op on a fresh DB; defensive
on re-runs. Matches the pattern used by other migrations.

Reviewer flagged this during the PR #118 retrospective.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin fix/migration-0080-idempotent-indexes
gh pr create --base Porting1.1 --head fix/migration-0080-idempotent-indexes \
  --title "fix(db): make migration 0080 indexes idempotent" \
  --body "## Summary
- Adds \`IF NOT EXISTS\` to the two \`CREATE INDEX\` statements in migration 0080.
- Defensive on re-runs; no-op on fresh DB.

## Test plan
- [ ] CI: \`migrations\` job passes (chain check + apply still green)
- [ ] CI: required gates green"
```

- [ ] **Step 5: Verify base = Porting1.1, watch CI, merge** (same pattern as Task 1.4 Step 6)

### Task 2.2: Add startup banner for memory retrieval mode (Item 9)

**Context:** Reviewer noted that pgvector-absent fallback to text-only retrieval is silent — operators don't see a warning at boot. The dev log shows it as a `WARN` line when pgvector is missing, but it's not surfaced in the boot banner that lists `Mode: embedded-postgres | vite-dev-middleware` etc.

**Halt criteria:**

- 🛑 The boot banner code is significantly different from what's described here — investigate, report. May need a different patch site.
- 🛑 The pgvector-detection logic doesn't expose a clean boolean — too tangled to surface cleanly. STOP and report.

**Files:**
- Modify: `server/src/index.ts` (the boot banner / startup log section)

- [ ] **Step 1: Investigate where the banner is constructed**

```bash
grep -nE "Mode\s*\|\s*Auth\s*\|\s*ready" server/src/index.ts | head -5
grep -nE "Memory retrieval|getDbCapabilities|hasPgvector" server/src/index.ts | head -10
grep -nE "pgvector extension not available|Memory works.*ilike" server/src/services/*.ts | head -5
```

Expected: a `console.log`-style block listing dev banner items (Mode, Deploy, Auth, Server, API, UI, Database, Migrations, etc.). Identify the exact location.

The pgvector-absent warning fires from `db-capabilities` service. The retrieval mode follows from whether `vector` extension is available.

- [ ] **Step 2: Branch**

```bash
git checkout Porting1.1
git pull origin Porting1.1
git checkout -b feat/startup-banner-memory-retrieval-mode
```

- [ ] **Step 3: Add a Memory retrieval line to the banner**

Use the Edit tool. Find a representative banner-construction line (e.g., `[\\u2002]Migrations[\\u2002]applied`) and add a sibling line ABOVE or BELOW that prints the retrieval mode. The exact insertion point depends on the banner structure observed in Step 1.

The new line should read approximately:
```typescript
const memoryRetrievalMode = capabilities.hasPgvector ? "pgvector (semantic)" : "text-only fallback";
// then in the banner:
//   [Memory retrieval] memoryRetrievalMode
```

(Adjust to match the actual banner code structure. The capability is exposed via the `getDbCapabilities()` call at line 411.)

- [ ] **Step 4: Smoke-test by running pnpm dev**

```bash
rm -f /tmp/aoa-banner-test.log
pnpm dev 2>&1 | tee /tmp/aoa-banner-test.log &
DEV_PID=$!
for i in $(seq 1 60); do
  if grep -q "Server listening on" /tmp/aoa-banner-test.log 2>/dev/null; then break; fi
  sleep 1
done
grep -E "Memory retrieval|pgvector|text-only" /tmp/aoa-banner-test.log | head -3
ps -ef | grep -E "dev-runner|tsx watch" | grep -v grep | awk '{print $2}' | xargs -r kill 2>&1 || true
```

Expected: a line with "Memory retrieval" + either "pgvector (semantic)" or "text-only fallback".

- [ ] **Step 5: Commit + push + open PR + verify base + watch CI + merge** (same pattern)

PR title: `feat(server): show memory retrieval mode in startup banner`
PR body: link to reviewer's recommendation, note no functional change.

### Task 2.3: Audit `plugin-secrets-handler.ts` encryption-at-rest (Item 11)

**Context:** Reviewer recommended a targeted audit of `server/src/services/plugin-secrets-handler.ts` for at-rest encryption of `github_pat` (Phase I worktree feature uses this). Specifically check: when secrets are written to `company_secrets` table, are they encrypted before insert? Is the encryption key sourced safely?

**This task is INVESTIGATION ONLY.** Output is a written audit doc. May produce follow-up coding tasks if findings warrant.

**Halt criteria:**

- 🛑 The audit finds a real critical security issue (e.g., plaintext storage, hardcoded key) — STOP. Controller decides whether to fix immediately or treat as a separate critical-priority plan.
- 🛑 The handler delegates to `SecretProviderModule` which has multiple implementations (e.g., `local_encrypted`, `aws_secrets_manager`) — audit ALL active implementations, not just one.

**Files:**
- Read: `server/src/services/plugin-secrets-handler.ts`
- Read: any `SecretProviderModule` implementations
- Read: `packages/db/src/schema/company_secrets.ts` (or equivalent)
- Create: `docs/superpowers/audits/2026-05-05-plugin-secrets-encryption.md` (audit document)

- [ ] **Step 1: Map the secrets handler architecture**

```bash
grep -nE "SecretProviderModule|local_encrypted|encrypt|decrypt" server/src/services/plugin-secrets-handler.ts | head -20
grep -rn "SecretProviderModule" server/src --include="*.ts" | head -10
ls server/src/services/secrets/ 2>&1 | head -10
```

Expected: provider modules at `server/src/services/secrets/` (or similar). One of them is `local_encrypted`.

- [ ] **Step 2: Audit each provider implementation**

For each provider module:
1. What encryption algorithm? (AES-256-GCM? ChaCha20? Plaintext?)
2. Where does the key come from? (Env var? File? Generated on first boot?)
3. Is the key persisted? Where? With what permissions?
4. Are encrypted blobs marked with a version/algo identifier so future migrations can rotate keys?
5. What happens on key loss? (Plain failure to decrypt vs. cascading data corruption?)

- [ ] **Step 3: Check the writing path**

When `github_pat` is set via the workspace UI, trace:
1. UI sends POST to which route?
2. Route handler calls which service?
3. Service calls the secret provider's `encrypt()` (or equivalent)?
4. Encrypted blob is written to `company_secrets` table — confirm column type (text? bytea?) and ensure no plaintext leak.

- [ ] **Step 4: Check the reading path**

When the workspace's "Create PR" button fires:
1. Handler retrieves the encrypted secret from `company_secrets`
2. Calls provider's `decrypt()` to get the plaintext PAT
3. Plaintext is used in the GitHub API call (in-memory, scoped to the request)
4. Verify the plaintext is NOT logged or persisted elsewhere.

- [ ] **Step 5: Write the audit document**

Create `docs/superpowers/audits/2026-05-05-plugin-secrets-encryption.md` with:
```markdown
# Plugin Secrets Encryption Audit (2026-05-05)

## Architecture
[diagram or description of provider abstraction]

## Implementations audited
- local_encrypted: [findings]
- [other providers]: [findings]

## Writing path
[trace from UI → DB]

## Reading path
[trace from DB → use site]

## Findings

### High severity
[any]

### Medium severity
[any]

### Low severity / Recommendations
[any]

## Recommended follow-ups (if any)
- [list]
```

- [ ] **Step 6: Commit the audit doc + report**

```bash
git checkout -b docs/audit-plugin-secrets-encryption
git add docs/superpowers/audits/2026-05-05-plugin-secrets-encryption.md
git commit -m "docs(audit): plugin secrets encryption-at-rest review"
git push -u origin docs/audit-plugin-secrets-encryption
gh pr create --base Porting1.1 --head docs/audit-plugin-secrets-encryption \
  --title "docs(audit): plugin secrets encryption-at-rest review" \
  --body "Audit-only PR. Findings + recommendations in the new doc."
```

If High-severity findings: report DONE_WITH_CONCERNS, controller decides next steps.

### Task 2.4: Add 404 fallback for unmatched `/api` routes (Item 15)

**Context:** Issue #116. `GET /api/auth/me` (or any unmatched `/api/*`) currently returns HTTP 500 instead of 404. The 500 originates from a downstream middleware (Vite dev middleware or static handler) that throws on unknown routes after the API router doesn't match. Reviewer noted: clean fallback is a 3-line `app.use("/api", (req, res) => res.status(404).json({error: "Not found"}))` insertion.

**Halt criteria:**

- 🛑 Investigation shows the 500 originates from somewhere OTHER than unmatched-route fallthrough (e.g., a real bug in `authProfileRoutes`) — STOP, report. The fix is different.
- 🛑 Adding the 404 fallback breaks legitimate non-`/api` routes (UI HTML routes that go through Vite middleware) — STOP. Patch site is wrong.

**Files:**
- Modify: `server/src/app.ts` (insert 404 fallback for `/api` before the static handler)

- [ ] **Step 1: Identify the exact insertion point**

Read `server/src/app.ts` from line 380 to line 460 (the section after the main `/api` router mount and before `errorHandler`).

Expected structure:
- ~line 386: `app.use("/api", api);`  (main API router)
- ~line 419: `app.use(express.static(uiDist));`
- ~line 440: `app.use(vite.middlewares);`
- ~line 453: `app.use(errorHandler);`

The 404 fallback for `/api` goes AFTER line 386 (after main API router) and BEFORE the static handlers. This way unmatched `/api/*` requests get a clean JSON 404 instead of falling through to the SPA's index.html.

- [ ] **Step 2: Reproduce the current behavior locally**

```bash
pnpm dev &
sleep 30  # wait for boot
curl -sS -i http://127.0.0.1:3100/api/auth/me 2>&1 | head -5
ps -ef | grep -E "dev-runner|tsx watch" | grep -v grep | awk '{print $2}' | xargs -r kill 2>&1 || true
```

Expected: HTTP 500. Confirms the bug. (After the fix, this should return HTTP 404.)

- [ ] **Step 3: Branch + insert the fallback**

```bash
git checkout Porting1.1
git pull origin Porting1.1
git checkout -b fix/api-404-fallback
```

Use the Edit tool. Find:
```typescript
  app.use("/api", api);
```

(at line ~386)

Replace with:
```typescript
  app.use("/api", api);

  // Catch-all 404 for unmatched /api/* routes. Without this, requests like
  // GET /api/foo fall through to the static UI handler / Vite middleware,
  // which either serves index.html (200) or throws (→ 500 via errorHandler).
  // Issue #116. Reviewer of PR #118 flagged this.
  app.use("/api", (req, res) => {
    res.status(404).json({ error: "Not found", path: req.originalUrl });
  });
```

- [ ] **Step 4: Smoke-test the fix**

```bash
pnpm dev &
sleep 30
curl -sS -i http://127.0.0.1:3100/api/auth/me 2>&1 | head -5
curl -sS -o /dev/null -w "GET / -> HTTP %{http_code}\n" http://127.0.0.1:3100/
ps -ef | grep -E "dev-runner|tsx watch" | grep -v grep | awk '{print $2}' | xargs -r kill 2>&1 || true
```

Expected:
- `/api/auth/me` returns HTTP 404 with JSON body `{"error":"Not found","path":"/api/auth/me"}`
- `GET /` still returns HTTP 200 (UI not affected)

- [ ] **Step 5: Commit + push + open PR + verify base + watch CI + merge**

PR title: `fix(server): return 404 for unmatched /api routes (closes #116)`

The PR body should reference Issue #116, explain the before/after behavior, and link to the curl reproduction.

After merge: `gh issue close 116 --comment "Fixed in PR #<num>."`

---

## Phase 3: Cross-Platform CI Fixes (Issues #112 / #113 / #114)

**Goal:** Address the 3 documented cross-platform CI failures so the advisory matrix can eventually be flipped to required.

**Phase-level halt criteria:**

- 🛑 Any fix surfaces a deeper algorithmic bug (not just platform-specific quirk) — STOP, controller decides whether to expand scope or defer.
- 🛑 The fix would require modifying production code paths (not just tests / CI infra) — STOP, controller reviews the production change.

### Task 3.1: Fix Issue #112 — macOS verify failures

**Context:** Two distinct test failures on macOS:

1. `workspace-runtime-resilience.test.ts > reuses a worktree...` — `expected '/private/var/folders/...' to be '/var/folders/...'`. macOS-specific symlink resolution: `/var/...` is a symlink to `/private/var/...`. The test compares paths from different sides of the symlink.

2. vitest mock error: `No "userRoles" export is defined on the "@armyofagents/db" mock`. Linux passes; macOS fails. Probably platform-specific module-resolution timing in vitest's hoisted mocks.

**Halt criteria:**

- 🛑 The path normalization fix breaks Linux tests (which pass today) — STOP. Use platform-conditional logic if necessary.
- 🛑 The `userRoles` mock fix requires changes outside the failing test file — STOP, scope review needed.

**Files:**
- Modify: `server/src/__tests__/workspace-runtime-resilience.test.ts` (path normalization)
- Modify: whichever test file mocks `@armyofagents/db` and is missing `userRoles` (find via grep)

- [ ] **Step 1: Find the failing test's exact assertion**

```bash
grep -nE "to be '/var/folders|registered for the branch at a non-default" server/src/__tests__/workspace-runtime-resilience.test.ts | head -5
```

Identify the specific `expect(...).toBe(...)` line.

- [ ] **Step 2: Find the vitest mock missing `userRoles`**

```bash
grep -rnE 'vi\.mock\(["\']@armyofagents/db["\']' server/src/__tests__ ui/src/__tests__ | head -10
```

Identify mocks that don't include `userRoles`. Compare with `packages/db/src/schema/index.ts` or whatever the canonical export is.

- [ ] **Step 3: Branch**

```bash
git checkout Porting1.1
git pull origin Porting1.1
git checkout -b fix/issue-112-macos-verify
```

- [ ] **Step 4: Fix path normalization**

Use the Edit tool on `server/src/__tests__/workspace-runtime-resilience.test.ts`. Locate the `expect(actualPath).toBe(expectedPath)` line. Replace with:

```typescript
import { realpathSync } from "node:fs";
// ... (in the test)
expect(realpathSync(actualPath)).toBe(realpathSync(expectedPath));
```

This resolves both sides through the symlink. POSIX-safe (Linux + macOS); Windows uses different path semantics — verify the test even runs on Windows (check `it.skipIf` etc.). Use `existsSync` guard if either path may not exist at assertion time.

- [ ] **Step 5: Fix the userRoles mock**

For each affected mock file, add the missing export. Pattern:
```typescript
vi.mock("@armyofagents/db", () => ({
  // ... existing mocks
  userRoles: { /* table stub or empty Proxy */ },
}));
```

The exact stub shape depends on what the consuming code uses (table query? schema reference?). Match the pattern used by other tables in the same mock.

- [ ] **Step 6: Run tests on this platform first**

```bash
pnpm test:run server/src/__tests__/workspace-runtime-resilience.test.ts 2>&1 | tail -10
```

Expected: pass. (Cross-platform validation happens via CI in Step 9.)

- [ ] **Step 7: Commit + push + open PR + verify base = Porting1.1**

```bash
git add server/src/__tests__
git commit -m "fix(tests): macOS verify-cross-platform path normalization + userRoles mock (closes #112)"
git push -u origin fix/issue-112-macos-verify
gh pr create --base Porting1.1 --head fix/issue-112-macos-verify \
  --title "fix(tests): macOS verify-cross-platform path normalization + userRoles mock" \
  --body "Closes #112. Wraps both sides of path assertions in fs.realpathSync(); adds userRoles to the @armyofagents/db mock."
```

- [ ] **Step 8: Watch CI**

```bash
PR_NUM=$(gh pr list --head fix/issue-112-macos-verify --state open --json number --jq '.[0].number')
gh pr view $PR_NUM --json baseRefName --jq '.baseRefName'  # MUST equal "Porting1.1"
until [ "$(gh pr checks $PR_NUM --json bucket --jq '[.[] | select(.bucket=="pending")] | length' 2>/dev/null)" = "0" ]; do sleep 60; done
gh pr checks $PR_NUM --watch=false | grep -E "verify-cross-platform"
```

Expected: `verify-cross-platform (macos-latest)` now passes.

- [ ] **Step 9: Merge + close Issue #112**

```bash
gh pr merge $PR_NUM --squash --delete-branch
gh issue close 112 --comment "Fixed in PR #$PR_NUM."
```

### Task 3.2: Fix Issue #113 — Windows verify failures (3 sub-fixes)

**Context:** Three distinct failures on Windows verify:

1. `companies-delete-integration.test.ts` — embedded-postgres setup fails (UTF-8 → WIN1252 encoding issue). Documented in CLAUDE.md.
2. `workspace-runtime.test.ts > runs a configured provision command...` — `Error: spawn /bin/sh ENOENT` (Windows lacks `/bin/sh`).
3. `workspace-runtime-resilience.test.ts > reuses a worktree...` — Windows path normalization (`RUNNER~1` vs `runneradmin`). Same root cause as Task 3.1.

**Halt criteria:**

- 🛑 Sub-fix 1 (encoding) requires deeper changes to the embedded-postgres patch — STOP. Out of scope for this PR; instead, skip the test on Windows with explicit `it.skipIf(process.platform === "win32", "embedded-postgres encoding issue: see Issue #113")`.
- 🛑 Sub-fix 2 (`/bin/sh`) requires changes to production code (not just test) — STOP, scope review.
- 🛑 Task 3.1's path-normalization fix didn't cover this case (different test file) — apply the same `fs.realpathSync` pattern here.

**Files:**
- Modify: `server/src/__tests__/companies-delete-integration.test.ts` (add Windows skip OR encoding fix)
- Modify: `server/src/__tests__/workspace-runtime.test.ts` (use platform-aware shell)
- Modify: `server/src/__tests__/workspace-runtime-resilience.test.ts` (path normalization — same pattern as Task 3.1)

- [ ] **Step 1: Read each failing test to understand context**

```bash
grep -nE "embedded-postgres|encoding|WIN1252" server/src/__tests__/companies-delete-integration.test.ts | head -5
grep -nE "/bin/sh|provision command|spawn" server/src/__tests__/workspace-runtime.test.ts | head -10
grep -nE "RUNNER~1|reuses a worktree" server/src/__tests__/workspace-runtime-resilience.test.ts | head -5
```

- [ ] **Step 2: Branch**

```bash
git checkout Porting1.1
git pull origin Porting1.1
git checkout -b fix/issue-113-windows-verify
```

- [ ] **Step 3: Sub-fix 1 — Skip companies-delete-integration on Windows**

The encoding issue (`character with byte sequence 0xe2 0x86 0x92 in encoding "UTF8" has no equivalent in encoding "WIN1252"`) is documented in CLAUDE.md as a known limitation. The patched `embedded-postgres@18.1.0-beta.16` doesn't fully cover all paths. Skip on Windows with explicit reasoning.

Use the Edit tool. Find the `describe(...)` or `it(...)` block. Wrap with:
```typescript
describe.skipIf(process.platform === "win32")(
  "companies.remove() — real DB integration (0066 cascade sweep)",
  () => {
    // ... existing tests
  },
);
```

(Or use `it.skipIf` per individual test if more granular skip needed.)

- [ ] **Step 4: Sub-fix 2 — Make workspace-runtime test use platform-aware shell**

In `workspace-runtime.test.ts`, find the test that uses `/bin/sh`:

```bash
grep -nE "spawn.*\/bin\/sh|exec.*\/bin\/sh|shell:.*\/bin\/sh" server/src/__tests__/workspace-runtime.test.ts | head -5
```

Replace `/bin/sh` references with a platform-conditional helper:
```typescript
const shellCmd = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
const shellFlag = process.platform === "win32" ? "/c" : "-c";
```

(Adjust per the actual usage. If the test is asserting on shell-specific output, may need separate POSIX/Windows expected values OR `it.skipIf` for Windows.)

- [ ] **Step 5: Sub-fix 3 — Path normalization (same pattern as Task 3.1)**

In `workspace-runtime-resilience.test.ts`, locate the assertion that fails on Windows. Apply the same `fs.realpathSync` wrap pattern. (Task 3.1 may already have fixed this if both tests share the assertion — verify post-merge.)

- [ ] **Step 6: Run affected tests locally**

```bash
pnpm test:run server/src/__tests__/companies-delete-integration.test.ts \
              server/src/__tests__/workspace-runtime.test.ts \
              server/src/__tests__/workspace-runtime-resilience.test.ts 2>&1 | tail -15
```

Expected: pass on Linux. (Cross-platform validation via CI in Step 8.)

- [ ] **Step 7: Commit + push + open PR + verify base**

PR title: `fix(tests): Windows verify-cross-platform 3 fixes (closes #113)`. Body itemizes the three sub-fixes.

- [ ] **Step 8: Watch CI**

Expected: `verify-cross-platform (windows-latest)` passes (or at least doesn't fail with these three known errors).

- [ ] **Step 9: Merge + close Issue #113**

### Task 3.3: Fix Issue #114 — Windows e2e (PostgreSQL refuses runneradmin)

**Context:** Windows runner runs as `runneradmin`. PostgreSQL refuses to start as administrative user (security policy). e2e fails at WebServer boot.

**Three options ranked by effort:**

1. **Skip on Windows** — quickest. Document in CLAUDE.md.
2. **Switch to postgres service container** — like the `migrations` job already does. ~1 day work.
3. **Run server as non-admin user via PowerShell** — most "correct" but heaviest implementation.

**This task requires CONTROLLER DECISION on which option to take.** The subagent does NOT decide.

**Halt criteria:**

- 🛑 Subagent should NOT begin implementation until controller picks an option. Subagent dispatch reads "Choose option [N]" in the prompt body.
- 🛑 Option 2 (service container): if it requires moving e2e setup beyond a 1-PR-shape change (e.g., needs a separate workflow file restructure) — STOP and scope review.

**Files (depends on option):**
- Option 1: `tests/e2e/playwright.config.ts` (Windows skip) + `CLAUDE.md` (note)
- Option 2: `.github/workflows/pr.yml` (e2e-cross-platform job — add postgres service container, similar to `migrations` job)
- Option 3: `.github/workflows/pr.yml` + a setup script that creates a non-admin user

- [ ] **Step 1: CONTROLLER PICKS OPTION (1, 2, or 3)** — DO NOT proceed without an explicit choice.

- [ ] **Step 2: Implement chosen option**

(Detailed steps for each option below.)

#### Option 1 — Skip on Windows (~30 min)

Edit `tests/e2e/playwright.config.ts`. Find the `webServer` block. Add a `process.platform === "win32"` skip OR wrap individual tests.

Alternative: add a top-level `if (process.platform === "win32" && process.env.CI) test.skip()` in test files.

Document in CLAUDE.md: "e2e tests skip on Windows runner per Issue #114 (PostgreSQL refuses to start as `runneradmin`). To verify e2e on Windows, use a non-admin local user."

#### Option 2 — Postgres service container (~1 day)

Edit `.github/workflows/pr.yml`'s `e2e-cross-platform` job. Apply the same `services: postgres` block as the `migrations` job (lines 522-540ish). Modify the test setup to use a `DATABASE_URL` pointing at the container instead of embedded-postgres. The Playwright `webServer` config needs the env var set.

#### Option 3 — Non-admin user (heaviest)

Add a CI step: `New-LocalUser -Name aoa-runner -NoPassword`, set up its profile, run the WebServer as that user via `runas`. Complex; not recommended.

- [ ] **Step 3: Smoke-test on Linux first**

Whatever option you pick, verify Linux e2e still passes.

- [ ] **Step 4: Commit + push + open PR + verify base + watch CI + merge + close Issue #114**

---

## Phase 4: Manual UI Verification of Issue #96 (Item 16)

**Goal:** Close the loop on the original Issue #96 mission — manually verify `signalRunningProcess` works end-to-end via UI cancel button.

**This task is USER-MANUAL.** The procedure is fully documented in `docs/superpowers/plans/2026-05-05-quality-closeout-and-issue-96-verification.md` under "Phase 2B Verification Scenario". The plan's prerequisites (PR #115 merged) are now met (today's session merged it).

**Halt criteria (for the user, executing manually):**

- 🛑 `pnpm dev` doesn't boot — STOP. Either main hasn't been pulled, or there's a new dev environment issue.
- 🛑 The agent doesn't accept the bash command (e.g., bash not in PATH on Windows) — switch to a PowerShell-equivalent command per the documented scenario.
- 🛑 Cancel button doesn't fire the cancel call — STOP, that's a real UI bug.
- 🛑 PIDs survive cancel on POSIX — STOP, Issue #96 has regressed (would be very surprising).
- ⚠️ PIDs survive cancel on Windows — EXPECTED limitation (Windows tree-kill is POSIX-only). Document but don't treat as failure.

### Task 4.1: Run the verification scenario

**Steps for the maintainer:**

1. Pull latest `main` (or `Porting1.1` post-PR-#118-merge):
```bash
git checkout main && git pull origin main
```

2. Boot dev:
```bash
pnpm dev
```

Wait for "Server listening on 127.0.0.1:3100".

3. Open the UI: http://127.0.0.1:3100

4. Run `pnpm aoa onboard` in a separate terminal to bootstrap the CEO/auth.

5. Sign in via the UI.

6. Navigate to **Settings → Agents → New Agent** and create:
   - Name: `tree-kill-tester`
   - Adapter: `process`
   - Command: `bash`
   - Args: `-c "echo grandchild_pid=$$ && sleep 120 & wait"`
   - (On Windows native without Git Bash: substitute with `powershell -Command "Start-Sleep -Seconds 120"` per the documented procedure.)

7. From the agent detail page, click **"Wake on demand"**. Heartbeat run starts.

8. In a separate terminal, capture pre-cancel PIDs:
```bash
# POSIX:
ps -ef --forest | grep -E "tree-kill-tester|sleep 120|bash -c"
# Windows:
Get-WmiObject Win32_Process -Filter "Name='bash.exe' OR Name='sleep.exe'"
```

9. Click **"Cancel"** in the UI.

10. Within 5 seconds, observe server logs for:
```
[INFO] heartbeat.cancel: signaling SIGTERM { runId, agentId, pid, processGroupId, reason: "cancelRun" }
```

11. Re-run the PID query from Step 8. Both parent and grandchild should be GONE on POSIX (parent gone on Windows; grandchild may persist due to documented Windows limitation).

### Task 4.2: Document the result on Issue #96

If verification PASSES (POSIX), reopen + comment + close:

```bash
gh issue reopen 96
gh issue comment 96 --body "$(cat <<'EOF'
## ✅ Issue #96 — UI verification complete (Phase 4 of the post-merge follow-ups plan, 2026-05-05)

[paste evidence per the documented Phase 2B template]
EOF
)"
gh issue close 96
```

If verification FAILS, file a NEW issue (don't reopen #96 with regression — that's a different scope) and escalate.

---

## Self-Review Checklist

- [x] **Spec coverage:** 12 actionable items (4-9, 11-16) all mapped to tasks. Items 5-6 are USER-ONLY documented in Phase 1. Items 10 (already exists) and codex comment (already resolved by PR #119) are noted as no-op. Items 17-19 are deferred (see below).
- [x] **No placeholders:** Each task has explicit code blocks, exact commands, exact file paths. The "investigate then fix" tasks (2.2, 2.3, 2.4, 3.1, 3.2) flag investigation steps that produce concrete data the implementation step uses.
- [x] **Halt criteria present:** Every task has explicit 🛑 triggers. Phase 3 has the most because cross-platform fixes have the most surprise potential.
- [x] **Controller-vs-subagent boundaries clear:** Task 3.3 (Issue #114 fix) explicitly requires controller to pick an option BEFORE subagent dispatch. User-only tasks (1.1, 1.2, 1.3, 4.1, 4.2) explicitly excluded from subagent execution.
- [x] **PR-base verification (Incident 1 lesson):** Every task that opens a PR includes `gh pr view <PR> --json baseRefName --jq '.baseRefName'` post-creation verification. Halt if base ≠ Porting1.1.
- [x] **Type/identifier consistency:** `Porting1.1` always referenced as base branch. `gh api`, `gh pr`, `gh run` used consistently. Issue numbers (#96, #112, #113, #114, #115, #116, #118, #119) referenced consistently with their actual PR/issue identities.
- [x] **Each task = its own PR:** Phase 1 task 1.4, all of Phase 2 (4 PRs), all of Phase 3 (3 PRs). Total: 8 code PRs from this plan.

---

## Deferred / Out of Scope

These items appeared in the original "16-item" list but are NOT executable tasks within this plan:

| Item | Reason for deferral |
|---|---|
| **#10 (local_trusted host-binding guard)** | Already exists at `server/src/index.ts:413-417`. Reviewer recommendation is satisfied; no work needed. |
| **Codex bot's P2 comment** | Resolved by PR #119 (`ec00d36`). The bash-style env prefix on root `dev:watch` is gone. |
| **#17 (Restrict Docker workflow to tag pushes only)** | Controller decided against this earlier in the session. Trade-off: removes continuous main-branch Docker build coverage, which is worse than the $4/mo Pro upgrade cost. Use Pro upgrade instead. |
| **#18 (Self-hosted runner for Windows / macOS)** | Hardware decision, not a code task. If you want to take this on later, file as a separate proposal. |
| **#19 (Continue V2.5 / V3 features per CLAUDE.md roadmap)** | Entire product roadmap. Not a tactical follow-up; tracked in `docs/aoa/specs/v2_spec.md`, `v2_5_changelog.md`, `v3_spec.md`. Schedule per your product plan. |

---

## Risks & Open Questions

1. **Phase 2 Task 2.3 (secrets handler audit) is open-ended.** May produce follow-up PRs we can't pre-scope. Time-box: 2 hours of investigation; if the architecture is unclear after that, halt + report.

2. **Phase 3 Task 3.3 (Issue #114) requires controller decision.** Don't dispatch the subagent until you've picked Option 1 / 2 / 3. Default recommendation: **Option 1 (skip on Windows)** until cross-platform parity becomes a real product requirement.

3. **Phase 3 Tasks may interact.** Task 3.1's `fs.realpathSync` fix may also resolve Task 3.2's sub-fix #3. Dispatch them sequentially; the second subagent's prompt should note "if path normalization is already correct from Task 3.1, skip sub-fix #3 of Task 3.2."

4. **Phase 4 (manual verification) requires the maintainer.** A subagent cannot click UI buttons. The plan documents the procedure; the maintainer executes when ready.

5. **CI minute consumption.** Each PR triggers a full CI matrix (~15 min Linux + ~25 min cross-platform advisory + ~25 min Docker on push to main = ~65 minutes per PR). 8 code PRs = ~8 hours of CI time. Mitigated by:
   - Public repo (free CI) — confirmed by user this session
   - OR GitHub Pro upgrade — the user is buying this per their earlier statement

6. **PR #119 already addressed Codex's P2 comment.** No work needed. The comment will resolve as `outdated` once #118 lands (because the bug PR #119 fixed is on the post-#119 HEAD that #118 includes).

7. **Phase 1's user-only tasks (1.1, 1.2, 1.3) cannot be executed by a subagent.** The plan documents them; the maintainer clicks through GitHub Settings.

---
