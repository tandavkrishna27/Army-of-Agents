# V1 Upgrade Branch Promotion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to execute this task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely promote all still-relevant local and remote work into `v1-upgrade` through reviewed, tested PRs without losing local changes or merging stale work blindly.

**Architecture:** `origin/v1-upgrade` stays the protected integration base. Each workstream is inspected, rebased or cherry-picked onto the latest `v1-upgrade`, verified with targeted tests plus `pnpm typecheck`, pushed as a PR, reviewed by Codex/GitHub, fixed if needed, then merged before the next workstream starts.

**Tech Stack:** Git worktrees, GitHub PRs, pnpm, Vitest, TypeScript project references, Playwright/browser verification for UI flows.

---

## Baseline

- `v1-upgrade` and `origin/v1-upgrade` are both at `7967407e fix: address secrets and codex review feedback (#178)`.
- Active worktrees checked during planning were clean.
- `codex/marketplace-v1-agent-integration` is the current combined marketplace/agent branch and has already passed the targeted marketplace test suite plus `pnpm typecheck`.
- `VQA-2-daily-qa-review` and `VQA-3-daily-qa-review` are prunable/missing worktree refs.
- Many old branches are already merged into `v1-upgrade` and should be cleanup candidates, not merge candidates.

---

## Promotion Policy

- Do not merge directly into `v1-upgrade` from a dirty worktree.
- Do not delete any local branch until its useful commits are merged into `v1-upgrade` or explicitly marked obsolete.
- Prefer one PR per feature bucket. Use a mega-branch only for compatibility testing, not as the default PR.
- After each PR merges, fetch and update local `v1-upgrade` before preparing the next bucket.
- Every PR needs changed-file review, targeted tests, `pnpm typecheck`, browser verification for UI-heavy changes, and a green Codex/GitHub review signal before merge.

---

## Bucket Order

1. **Marketplace and Agents**
   - Branch: `codex/marketplace-v1-agent-integration`
   - Scope: marketplace package installs, agent runtime parsing, instruction bundles, dependency cascade, install settings, marketplace updates in settings, plugin update safety.
   - Status: integrated locally and verified.

2. **Execution Target and Environments**
   - Branches: `feat/v1-execution-target`, `feat/v1-environments-target-aware`
   - Scope: execution target primitives, target runner, adapter/runtime behavior, environment target awareness.
   - Risk: runtime and adapter behavior; review carefully.

3. **Lobby Work**
   - Branches: `feat/lobby-stats-approvals-notifications`, `feat/lobby-redesign-structural`, `feat/lobby-redesign-polish`
   - Scope: company stats, lobby layout, empty state, marketplace back navigation, polish/motion.
   - Risk: UI route and responsive layout regressions.

4. **Workspace Work**
   - Branch: `feature/workspace`
   - Scope: chatbar, context donut, todo extraction/progress, sidebars, plugin runtime services/webhook raw body.
   - Risk: large branch with 68 commits; likely separate PR.

5. **Small One-Off Fixes**
   - Branches: `claude/hungry-kare-7b0884`, `claude/loving-taussig-d53441`
   - Scope: transcript cleanup and env compatibility tests.
   - Risk: low, but may be obsolete.

6. **Remote-Only Audit**
   - Candidates: `origin/feat/marketplace-runtime-requires`, `origin/feat/marketplace-v1`, `origin/fix/e2e-marketplace-strict-mode-locator`, `origin/fix/security-marketplace-plugin-integrity`, active security/dependabot branches.
   - Rule: do not merge whole stale remote branches. Cherry-pick only missing useful commits after comparison.

---

## Standard PR Gate

- [ ] Fetch remotes:

```powershell
git fetch --all --prune
```

- [ ] Confirm base is current:

```powershell
git checkout v1-upgrade
git pull --ff-only origin v1-upgrade
```

- [ ] Confirm candidate branch/worktree is clean:

```powershell
git status --short --branch
```

- [ ] Inspect unique commits:

```powershell
git log --oneline origin/v1-upgrade..HEAD
```

- [ ] Inspect changed files:

```powershell
git diff --stat origin/v1-upgrade...HEAD
git diff --name-only origin/v1-upgrade...HEAD
```

- [ ] Run targeted tests for the bucket.

- [ ] Run typecheck:

```powershell
pnpm typecheck
```

- [ ] Browser-verify UI flows when UI is touched.

- [ ] Push branch:

```powershell
git push -u origin <branch>
```

- [ ] Create PR into `v1-upgrade`.

- [ ] Wait for checks and Codex/GitHub review:

```powershell
gh pr checks --watch
gh pr view --comments
```

- [ ] For each review issue:
  - reproduce if it is a bug
  - add or update a focused test
  - patch code
  - rerun targeted tests and `pnpm typecheck`
  - push the fix commit

- [ ] Merge only after green review:

```powershell
gh pr merge --merge --delete-branch
git checkout v1-upgrade
git pull --ff-only origin v1-upgrade
```

---

## Task 1: Marketplace And Agents PR

- [ ] Re-run final changed-file review on `codex/marketplace-v1-agent-integration`.
- [ ] Re-run targeted marketplace tests.
- [ ] Re-run `pnpm typecheck`.
- [ ] Push `codex/marketplace-v1-agent-integration`.
- [ ] Create PR into `v1-upgrade`.
- [ ] Wait for Codex/GitHub review.
- [ ] Fix review comments with tests.
- [ ] Merge after green signal.
- [ ] Pull latest `v1-upgrade`.

Targeted marketplace verification command:

```powershell
pnpm test:run server/src/__tests__/marketplace-company-customized.test.ts server/src/__tests__/marketplace-install-package.test.ts server/src/__tests__/skill-bundle-materializer.test.ts server/src/__tests__/marketplace-agent-runtime.test.ts server/src/__tests__/marketplace-install-orchestrator.test.ts server/src/__tests__/marketplace-install-resolver.test.ts server/src/__tests__/marketplace-installs-request.test.ts ui/src/components/settings/sections/__tests__/MarketplacePrefsSection.test.tsx ui/src/components/settings/sections/__tests__/MarketplaceUpdatesPanel.test.tsx ui/src/pages/__tests__/MarketplaceUpdates.test.tsx ui/src/components/settings/__tests__/PluginsSection.test.tsx ui/src/__tests__/SettingsPage-redesign.test.tsx ui/src/api/__tests__/marketplace-api.test.ts ui/src/components/marketplace/install/__tests__/SnapshotInstallModal.test.tsx ui/src/components/marketplace/install/__tests__/PackageInstallModal.test.tsx ui/src/components/marketplace/__tests__/PackageCard.test.tsx ui/src/components/marketplace/__tests__/CatalogCard.test.tsx ui/src/components/marketplace/__tests__/TypeChip.test.tsx packages/shared/src/__tests__/marketplace-schema.test.ts ui/src/lib/__tests__/skillProviderMeta.test.ts
```

---

## Task 2: Execution Target And Environments

- [ ] Inspect `feat/v1-execution-target` commits and changed files.
- [ ] Inspect `feat/v1-environments-target-aware` commits and changed files.
- [ ] Decide whether they are one PR or two.
- [ ] Create fresh worktree branch from latest `v1-upgrade`.
- [ ] Cherry-pick reviewed commits one at a time with `-x`.
- [ ] Resolve conflicts by preserving current `v1-upgrade` behavior and intended execution-target behavior.
- [ ] Run targeted adapter/server tests discovered during review.
- [ ] Run `pnpm typecheck`.
- [ ] PR, wait for review, fix, retest, merge.

---

## Task 3: Lobby Work

- [ ] Inspect stats, structural, and polish branches in order.
- [ ] Decide whether lobby should be one PR or a small stack.
- [ ] Create fresh worktree branch from latest `v1-upgrade`.
- [ ] Cherry-pick in dependency order.
- [ ] Run targeted lobby/company stats tests.
- [ ] Run `pnpm typecheck`.
- [ ] Browser-verify lobby/home, company switching, empty state, marketplace back navigation, and responsive layout.
- [ ] PR, wait for review, fix, retest, merge.

---

## Task 4: Workspace Work

- [ ] Inspect `feature/workspace` commits and changed files.
- [ ] Decide promote or defer.
- [ ] If promoting, create fresh worktree branch from latest `v1-upgrade`.
- [ ] Integrate in logical groups, not all 68 commits blindly.
- [ ] Run workspace/plugin/UI tests discovered during review.
- [ ] Run `pnpm typecheck`.
- [ ] Browser-verify workspace page, chatbar, context donut, todo controls, and plugin webhook behavior if touched.
- [ ] PR, wait for review, fix, retest, merge.

---

## Task 5: Small One-Off Fixes

- [ ] Inspect:

```powershell
git show --stat claude/hungry-kare-7b0884
git show --stat claude/loving-taussig-d53441
```

- [ ] Cherry-pick if still useful, skip if obsolete.
- [ ] Run focused tests and `pnpm typecheck`.
- [ ] PR, review, fix, merge if needed.

---

## Task 6: Remote-Only Branch Audit

- [ ] Compare each remote-only candidate against latest `v1-upgrade`:

```powershell
git log --oneline origin/v1-upgrade..origin/<branch>
git diff --stat origin/v1-upgrade...origin/<branch>
git cherry origin/v1-upgrade origin/<branch>
```

- [ ] Mark each commit as already covered, obsolete, or useful.
- [ ] Cherry-pick only useful missing commits into the relevant bucket or a small follow-up PR.

---

## Task 7: Cleanup

- [ ] Run:

```powershell
git worktree prune
git branch --merged origin/v1-upgrade
```

- [ ] Delete only branches confirmed obsolete:

```powershell
git branch -d <branch>
```

- [ ] Remove old clean worktrees:

```powershell
git worktree remove "<path>"
```

- [ ] Delete remote branches only if merged, obsolete, and owned by us:

```powershell
git push origin --delete <branch>
```

---

## Stop Conditions

Stop and discuss before proceeding if:
- a branch touches unrelated high-risk systems
- a cherry-pick creates broad conflicts
- tests reveal behavior changes outside the bucket
- branch purpose is unclear
- Codex/GitHub review requests a product decision
- a PR becomes too large to review safely

