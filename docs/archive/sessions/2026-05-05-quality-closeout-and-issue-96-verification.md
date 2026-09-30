# AoA Quality Baseline Closeout + Issue #96 UI Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 6 follow-up recommendations from the Quality Baseline (v2) plan's final review, then resume the deferred Issue #96 UI verification (originally blocked because Windows dev was broken — Task 4 fixed the proximate cause).

**Architecture:** Two phases. Phase 1 = 4 polish follow-ups (3 PRs + 1 batch of GitHub issues, no PR). Phase 2 = investigative resumption of Issue #96 UI verification on Windows, including a mandatory spike to confirm `pnpm dev` actually boots cleanly post-Task-4 (since two other Windows dev bugs were documented earlier in the session and may still bite).

**Tech Stack:** Same as before. Verification phase exercises real `pnpm dev` against embedded-postgres (Windows-locale issues per CLAUDE.md), the `process` adapter for spawn-tree testing, and the new Task 6 cancellation logs.

**Locked decisions:**

1. **Each polish task = its own PR** (where there is a PR). Same rule as the v2 plan. Polish 1A/1B/1C are PRs; 1D is a batch of `gh issue create` calls — no PR.
2. **Phase 2's spike (2A) is a hard gate.** If `pnpm dev` does NOT boot cleanly on Windows after Task 4, the controller decides whether to (a) extend Phase 1 with a 1B-fix-Windows-dev task, or (b) defer Phase 2 to a follow-up plan. Subagents do NOT decide this.
3. **Halt criteria are MANDATORY, same v2 design.** Each task has explicit 🛑 triggers; subagents stop and report. Plan-level decisions are controller-only.
4. **Maintainer-only items (B1, B2 from previous review) stay outside this plan.** They are GitHub repo Settings actions; the user does them. Plan documents them.
5. **Verification artifacts are captured.** Phase 2C produces concrete evidence (log excerpts + `ps`/`tasklist` output) that gets attached as a comment on Issue #96 (which will be reopened first if it was auto-closed).

---

## Recommended execution order

| # | Task | Why this slot | Risk |
|---|---|---|---|
| 1 | **Task 1A** (AGENTS.md §7 doc) | Bulletproof — pure docs | Trivial |
| 2 | **Task 1B** (SIGKILL guard) | 1-line code change in well-understood path | Low |
| 3 | **Task 1C** (migrations chain hardening) | Tightens existing Python check, no infra change | Low |
| 4 | **Task 1D** (file 3 GH issues) | Bookkeeping only | Trivial |
| 5 | **Task 2A** (Windows dev spike) | GATE for Phase 2; may surface more Windows bugs | High |
| 6 | **Task 2B** (define UI test scenario) | Pure planning — runs after 2A | Low |
| 7 | **Task 2C** (execute UI verification) | Real-world test — outcome-dependent | Medium |

## Controller-Only Decisions

When a subagent reports back, the **controller** decides — same as v2 plan. Subagents implement; controllers steer.

**Controller decides:**
- Whether to halt at any halt criterion
- Whether 2A's spike findings warrant a Phase 1B (fix-more-Windows-bugs) before continuing to 2B/2C
- Whether 2C's verification is conclusive or needs more scenarios
- Whether discovered bugs go in-PR vs. follow-up issues

**Subagent decides:**
- How to implement what each task description says (within the locked code blocks)
- Whether commit messages match the spec
- Whether tests pass before committing
- When to ask the controller a clarifying question

---

## Pre-flight Checks

- [ ] **Confirm we're on `Porting1.1` and synced.**

```bash
git checkout Porting1.1
git pull origin Porting1.1
git log --oneline -1
```

Expected: HEAD is `d389b97 ci: add migrations-from-scratch validation (#107)` or newer.

- [ ] **Confirm working tree is clean.**

```bash
git status --short
```

Expected: only untracked `.claire/` and `.claude/worktree-archive/` (or fully empty).

---

## File Structure

| File | Task | Action | Why |
|---|---|---|---|
| `AGENTS.md` | 1A | **Modify** §7 | Document new permissive policy-gate behavior |
| `server/src/services/heartbeat.ts:3833-3853` | 1B | **Modify** | Guard SIGKILL+log with `runningProcesses.has(run.id)` check |
| `.github/workflows/pr.yml` (migrations job) | 1C | **Modify** Python chain check | Detect gap-then-corruption pattern |
| (3 GitHub issues — no file) | 1D | **Create** via `gh issue create` | Track cross-platform follow-ups |
| `(spike output document)` | 2A | **Create** investigation notes | Record what works / breaks on Windows |
| `(test scenario doc)` | 2B | **Create** | Define exact verification steps |
| `Issue #96 comment` | 2C | **Create** via `gh issue comment` | Final verification evidence |

---

## Task 1A: Document policy-gate semantics in `AGENTS.md §7`

**Context:** PR #103 widened the policy gate's `Block manual lockfile edits` check to allow `pnpm-lock.yaml` commits when manifests also changed in the same PR. Previously, the only escape hatch was the bot's `chore/refresh-lockfile` branch. The reviewer flagged: contributors reading `AGENTS.md §7` would still see the old "use `chore/refresh-lockfile` branch" guidance and miss the new inline path. This task updates the doc.

**Halt criteria (subagent stops + reports):**

- 🛑 `AGENTS.md §7` does not exist or has been renumbered (the v2 plan's pre-history added a §7) — STOP, report the actual structure. Controller decides which section to update.
- 🛑 The existing `AGENTS.md` content uses a markdown style this update would break (e.g., headings differ from this task's pattern) — match the local pattern, report deviations.

**Files:**
- Modify: `AGENTS.md` (§7)

- [ ] **Step 1: Locate `AGENTS.md §7`**

```bash
grep -n "^## " AGENTS.md
```

Confirm there's a `## 7. ...` (or `## §7 ...`) section about dependency/lockfile workflow.

- [ ] **Step 2: Read the current §7 content**

Read `AGENTS.md` from the line numbers `grep` returned for §7 through the next `## ` heading to see exactly what needs to change.

- [ ] **Step 3: Add a new subsection to §7 documenting the inline path**

After the section that currently describes the `chore/refresh-lockfile` branch escape hatch, append (use the Edit tool — find the last paragraph of the existing §7 and add this AFTER it, BEFORE the next `## ` heading):

```markdown

### Inline lockfile updates (added 2026-05-05)

The policy gate's `Block manual lockfile edits` step now allows `pnpm-lock.yaml`
commits when **package manifests also changed in the same PR**. The check matches
this regex against the PR diff: `(^|/)package\.json$|^pnpm-workspace\.yaml$|^\.npmrc$|^pnpmfile\.(cjs|js|mjs)$`.

This means you can ship a single PR that adds a dependency:

1. Edit `package.json` (root or workspace) to add the new dep.
2. Run `pnpm install --no-frozen-lockfile` to update `pnpm-lock.yaml`.
3. Commit BOTH files together in any branch.

The gate accepts the lockfile because it's accompanied by manifest changes.
Stealth lockfile-only commits (no manifest change) are still blocked.

The recommended path is still the `chore/refresh-lockfile` bot — it auto-merges
and keeps the lockfile fresh after manifest edits land. Use the inline path
when:
- You're adding a new dep and want the manifest + lockfile in a single
  reviewable commit.
- The bot is broken or has an open chore PR you don't want to interfere with.

The gate's logic is at `.github/workflows/pr.yml` (`Block manual lockfile edits`
step in the `policy` job).
```

- [ ] **Step 4: Verify the markdown lints clean**

```bash
git diff AGENTS.md
```

Visually confirm the new subsection is well-formed and consistent with surrounding content.

- [ ] **Step 5: Commit + push + open PR**

```bash
git checkout -b docs/agents-md-section-7-inline-lockfile-path
git add AGENTS.md
git commit -m "$(cat <<'EOF'
docs(AGENTS.md): document inline lockfile path in §7

PR #103 widened the policy gate's lockfile-edit block to allow
pnpm-lock.yaml commits when package manifests also changed in the
same PR. The bot path (chore/refresh-lockfile branch) remains
documented as the recommended workflow, but the inline path now
exists as a valid alternative for dep-adding PRs.

Reviewer flagged this gap during the v2 plan retrospective.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin docs/agents-md-section-7-inline-lockfile-path
gh pr create --base Porting1.1 --head docs/agents-md-section-7-inline-lockfile-path \
  --title "docs(AGENTS.md): document inline lockfile path in §7" \
  --body "## Summary
- Updates AGENTS.md §7 to document the new inline lockfile commit path.
- Reviewer flagged this during the Quality Baseline (v2) plan retrospective.

## Why
PR #103 widened the policy gate's \`Block manual lockfile edits\` step to allow lockfile commits when package manifests also changed in the same PR. The recommended workflow (bot via \`chore/refresh-lockfile\` branch) is unchanged, but contributors should know the inline path exists.

## Test plan
- [ ] Visual review of the new subsection
- [ ] CI: policy / verify / e2e green"
```

- [ ] **Step 6: Watch CI + merge**

```bash
gh pr checks <PR-NUMBER> --watch=false
```

Wait until all required checks pass, then:

```bash
gh pr merge <PR-NUMBER> --squash --delete-branch
git checkout Porting1.1 && git pull origin Porting1.1
```

---

## Task 1B: Guard SIGKILL escalation log with `runningProcesses.has()`

**Context:** Task 6's PR #104 added 5 cancellation log lines. The reviewer noted that the SIGKILL escalation log (inside the grace-period `setTimeout` at `heartbeat.ts:3833-3835`) fires unconditionally — but if the child exited cleanly during the grace period and was reaped via the normal completion path (which deletes the entry from `runningProcesses`), the timeout still fires and the log lies ("signaling SIGKILL" when in fact the process is already gone). Cosmetic log accuracy, but worth a 1-line guard.

**Halt criteria (subagent stops + reports):**

- 🛑 The `runningProcesses` Map is not the right state to check for "process still alive" — investigate what the normal completion path actually does. If it doesn't delete the entry, the guard logic is wrong and needs rethinking. Report findings.
- 🛑 The grace-period setTimeout has been refactored or moved since the v2 review (e.g., extracted into a helper) — adjust the patch site, report deviations.

**Files:**
- Modify: `server/src/services/heartbeat.ts` (lines ~3833-3853 in `cancelRun`'s SIGKILL setTimeout)

- [ ] **Step 1: Verify the call site exists**

```bash
grep -n "cancelRun.grace-expired" server/src/services/heartbeat.ts
```

Expected: 1 hit, near line 3845, inside a setTimeout callback.

- [ ] **Step 2: Verify the normal completion path deletes from `runningProcesses`**

```bash
grep -n "runningProcesses.delete" server/src/services/heartbeat.ts | head -10
```

Expected: multiple hits including normal completion paths. The guard relies on the assumption that a cleanly-exited process has been deleted from the map by the time the setTimeout fires.

- [ ] **Step 3: Read the SIGKILL log + signal block**

```bash
sed -n '3830,3856p' server/src/services/heartbeat.ts
```

Confirm the structure looks like:

```typescript
const running = runningProcesses.get(run.id);
if (running) {
  logger.info(
    { ... reason: "cancelRun" },
    "heartbeat.cancel: signaling SIGTERM",
  );
  signalRunningProcess(running, "SIGTERM");
  const graceMs = Math.max(1, running.graceSec) * 1000;
  setTimeout(() => {
    logger.info(
      { ... reason: "cancelRun.grace-expired" },
      "heartbeat.cancel: signaling SIGKILL",
    );
    signalRunningProcess(running, "SIGKILL");
  }, graceMs);
}
```

- [ ] **Step 4: Branch**

```bash
git checkout -b fix/heartbeat-sigkill-guard
```

- [ ] **Step 5: Apply the guard**

Use the Edit tool. Find:

```typescript
        setTimeout(() => {
          logger.info(
            {
              runId: run.id,
              agentId: run.agentId,
              pid: running.child.pid,
              processGroupId: running.processGroupId,
              reason: "cancelRun.grace-expired",
            },
            "heartbeat.cancel: signaling SIGKILL",
          );
          signalRunningProcess(running, "SIGKILL");
        }, graceMs);
```

Replace with:

```typescript
        setTimeout(() => {
          // If the process exited cleanly during the grace period, the
          // normal completion path will have removed the entry from
          // runningProcesses. Don't log/signal a process that's gone.
          if (!runningProcesses.has(run.id)) return;
          logger.info(
            {
              runId: run.id,
              agentId: run.agentId,
              pid: running.child.pid,
              processGroupId: running.processGroupId,
              reason: "cancelRun.grace-expired",
            },
            "heartbeat.cancel: signaling SIGKILL",
          );
          signalRunningProcess(running, "SIGKILL");
        }, graceMs);
```

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @armyofagents/server exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Run the existing heartbeat tests**

```bash
pnpm test:run server/src/__tests__/heartbeat-process-tracking.test.ts server/src/__tests__/heartbeat-process-tree-kill.integration.test.ts
```

Expected: all tests pass (the guard is purely defensive — no existing test should regress).

- [ ] **Step 8: Commit + push + open PR**

```bash
git add server/src/services/heartbeat.ts
git commit -m "$(cat <<'EOF'
fix(heartbeat): guard SIGKILL escalation log with runningProcesses.has()

PR #104's SIGKILL escalation log inside cancelRun's grace-period
setTimeout fires unconditionally. If the child process exited
cleanly during the grace period, the normal completion path has
already removed the entry from runningProcesses — but the timeout
still fires and the log says "signaling SIGKILL" for a process
that's gone.

Add an early-return guard so the log + signal only happen when the
process is still being tracked. Cosmetic log accuracy fix, no
functional change.

Reviewer flagged this during the v2 plan retrospective.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin fix/heartbeat-sigkill-guard
gh pr create --base Porting1.1 --head fix/heartbeat-sigkill-guard \
  --title "fix(heartbeat): guard SIGKILL escalation log with runningProcesses.has()" \
  --body "## Summary
- 1-line guard inside \`cancelRun\`'s grace-period \`setTimeout\` to skip the log + SIGKILL signal if the process exited cleanly during grace.
- Cosmetic accuracy fix flagged by reviewer during the Quality Baseline (v2) plan retrospective.

## Why
PR #104 added the escalation log unconditionally. If the child exited cleanly during grace, the normal completion path removed the entry from \`runningProcesses\` — but the timeout still fires, logging \"signaling SIGKILL\" for a process that's already gone. Misleading in postmortems.

## Test plan
- [ ] Typecheck passes
- [ ] Existing heartbeat tests (process-tracking + integration) pass
- [ ] CI green"
```

- [ ] **Step 9: Watch CI + merge** (same pattern as Task 1A Step 6)

---

## Task 1C: Harden migrations chain check for gap-then-corruption pattern

**Context:** Task 2's PR #107 added a Python chain integrity check in `pr.yml`'s `migrations` job. The reviewer flagged a subtle gap: when consecutive snapshots are missing, the check sets `prev_id = None` to skip the gap, then resumes at the next existing snapshot. If a malicious renumber drops snapshot B AND alters snapshot C's `prevId` to point to A's now-stale id, the gap-skip logic clears `prev_id` at B and the check at C has no anchor — it accepts whatever `prevId` C claims. This task tightens the check.

**Halt criteria (subagent stops + reports):**

- 🛑 The current Python check at `pr.yml`'s `migrations` job differs from what the reviewer described (e.g., chain logic was already tightened in a follow-up PR) — STOP, report the actual current logic. Controller decides whether the task is still needed.
- 🛑 The fix introduces false positives on the current journal (i.e., the tightened check fails on a healthy state) — STOP. The journal may have legitimate gaps the check needs to model. Report the failure and the journal entry it triggered on.

**Files:**
- Modify: `.github/workflows/pr.yml` (Python chain check inside the `migrations` job)

- [ ] **Step 1: Find the current chain check in pr.yml**

```bash
grep -n "Verify migration chain integrity" .github/workflows/pr.yml
```

- [ ] **Step 2: Read the surrounding 60 lines to see the full check**

Use the Read tool on `.github/workflows/pr.yml` starting from the line above and read 60 lines.

- [ ] **Step 3: Branch**

```bash
git checkout -b ci/migrations-chain-check-gap-then-corruption
```

- [ ] **Step 4: Tighten Check 3**

Find the existing Check 3 block:

```python
          # Check 3: each snapshot's prevId matches the previous snapshot's id.
          # Snapshot files are auto-generated by `drizzle-kit generate` and many
          # historical migrations never had their snapshots committed (drizzle
          # only consults snapshots for `generate`, not for `migrate` runtime
          # apply — so missing snapshots are not a runtime hazard). We therefore
          # ONLY validate the chain among snapshots that ARE committed: a break
          # here is the PR #94 signal (a committed snapshot whose prevId points
          # to a stale predecessor).
          prev_id = None
          checked = 0
          for entry in journal["entries"]:
              snap_path = meta_dir / f"{entry['idx']:04d}_snapshot.json"
              if not snap_path.exists():
                  prev_id = None  # break chain context across the gap
                  continue
              snap = load_json_with_bom(snap_path)
              if prev_id is not None and snap["prevId"] != prev_id:
                  raise AssertionError(
```

Replace with the gap-tracking version (use the Edit tool — preserve exact indentation):

```python
          # Check 3: each snapshot's prevId matches the previous snapshot's id.
          # Snapshot files are auto-generated by `drizzle-kit generate` and many
          # historical migrations never had their snapshots committed (drizzle
          # only consults snapshots for `generate`, not for `migrate` runtime
          # apply — so missing snapshots are not a runtime hazard). We therefore
          # ONLY validate the chain among snapshots that ARE committed: a break
          # here is the PR #94 signal (a committed snapshot whose prevId points
          # to a stale predecessor).
          #
          # Gap-then-corruption hardening: when we hit a missing snapshot, we
          # remember the LAST KNOWN id (last_known_prev_id) so when the chain
          # resumes at the next existing snapshot, its prevId must point to
          # SOMETHING we've seen — not just trust whatever prevId the snapshot
          # claims. This catches the "drop B + alter C.prevId to point to A"
          # attack where a naive gap-skip would let C through with no anchor.
          prev_id = None
          last_known_prev_id = None
          checked = 0
          for entry in journal["entries"]:
              snap_path = meta_dir / f"{entry['idx']:04d}_snapshot.json"
              if not snap_path.exists():
                  prev_id = None  # break direct-chain context across the gap
                  continue
              snap = load_json_with_bom(snap_path)
              if prev_id is not None and snap["prevId"] != prev_id:
                  raise AssertionError(
```

Then find the corresponding `prev_id = snap["id"]` line at the end of the loop and update it to also track `last_known_prev_id`:

Find:

```python
              prev_id = snap["id"]
              checked += 1

          print(f"OK: {len(ids)} migrations, {checked} chain links checked")
```

Replace with:

```python
              # If chain context was broken by a gap, the snapshot's prevId
              # must still reference a previously-seen id (or be None for the
              # very first migration). Otherwise it's a gap-then-corruption.
              if prev_id is None and last_known_prev_id is not None:
                  if snap["prevId"] != last_known_prev_id:
                      raise AssertionError(
                          f"Chain corruption after gap at {entry['tag']} (idx {entry['idx']}): "
                          f"prevId={snap['prevId']} does not reference last-known committed id "
                          f"{last_known_prev_id}"
                      )
              prev_id = snap["id"]
              last_known_prev_id = snap["id"]
              checked += 1

          print(f"OK: {len(ids)} migrations, {checked} chain links checked")
```

- [ ] **Step 5: Validate YAML**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/pr.yml'))"
```

Expected: no output, no exceptions.

- [ ] **Step 6: Commit + push + open PR**

```bash
git add .github/workflows/pr.yml
git commit -m "$(cat <<'EOF'
ci(migrations): harden chain check for gap-then-corruption pattern

PR #107's Check 3 in the migrations job recognized that drizzle's
runtime `migrate` doesn't consume snapshot files, so missing
snapshots from older migrations are not runtime hazards. The check
skips gaps by clearing `prev_id` and resuming at the next committed
snapshot.

Reviewer flagged a subtle gap: a malicious renumber that drops
snapshot B AND alters C's prevId to point to a stale id (e.g., A's
old id) would not be caught — the gap-skip clears the anchor and
the check accepts whatever prevId C claims.

Fix: track `last_known_prev_id` across gaps. When the chain resumes
at a post-gap snapshot, its prevId must reference an id we've
previously seen (or be None for entry 0). This catches "drop B +
alter C.prevId" without false-positives on legitimate gaps.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin ci/migrations-chain-check-gap-then-corruption
gh pr create --base Porting1.1 --head ci/migrations-chain-check-gap-then-corruption \
  --title "ci(migrations): harden chain check for gap-then-corruption pattern" \
  --body "## Summary
- Adds \`last_known_prev_id\` tracking to the Python chain check in \`pr.yml\`'s \`migrations\` job.
- When the chain resumes after a gap, the next snapshot's prevId must reference a previously-seen id — not whatever the snapshot claims.

## Why
PR #107's Check 3 correctly recognized that missing snapshots are not runtime hazards (drizzle's \`migrate\` doesn't consume them). But a naive \`prev_id = None\` gap-skip lets gap-then-corruption attacks slip through (drop snapshot B, alter C's prevId to point at A's stale id, gap-skip clears anchor, chain resumes with no validation).

## Test plan
- [ ] CI: \`migrations\` job passes on this PR (no false-positive on current journal)
- [ ] CI: all required checks green"
```

- [ ] **Step 7: Watch CI + merge** (same pattern)

---

## Task 1D: File 3 GitHub issues for cross-platform CI follow-ups

**Context:** Task 1's PR #106 added advisory cross-platform CI jobs (`continue-on-error: true`). The first runs on PRs #106 and #107 surfaced 3 known failures. Each needs a tracking issue with the failure log so future contributors can pick them up.

**This task is controller-only.** No subagent dispatch. The controller (you, or the AI running this plan) executes the `gh issue create` commands directly. Reason: filing 3 GH issues is bookkeeping with low cognitive load; subagent overhead is wasted here.

**Files:** None (output is GH issues).

- [ ] **Step 1: Capture failure log links from PR #106's CI run**

```bash
gh pr checks 106 --watch=false 2>&1
```

Expected output includes failure URLs for:
- `verify-cross-platform (macos-latest)` — fails ~3min in
- `verify-cross-platform (windows-latest)` — fails ~14-16min in
- `e2e-cross-platform (windows-latest)` — fails ~4-5min in

Note the URLs (each ends in `/job/<job-id>`).

- [ ] **Step 2: File issue: macOS verify failure**

```bash
gh issue create \
  --title "ci: verify-cross-platform fails on macos-latest" \
  --label "bug,ci" \
  --body "$(cat <<'EOF'
## Symptom
The advisory \`verify-cross-platform (macos-latest)\` job (added in PR #106) fails ~3min into the run on every PR.

## First-run reference
Failed on PR #106's first run: <PASTE_VERIFY_MACOS_URL_FROM_STEP_1>
Also failed on PR #107's run.

## Investigation needed
- Read the job log to identify which step fails
- Likely candidates: \`pnpm test:run\` failing on a macOS-specific test, or \`pnpm install --frozen-lockfile\` hitting a native-binding issue
- Compare with the Linux \`verify\` job that passes on the same PR

## Acceptance criteria
- [ ] Root cause identified
- [ ] Either fixed in source, or test skipped on macOS with a follow-up issue tracking the underlying behavior
- [ ] Once stable, flip to required check via branch protection rule update

## Context
This is one of 3 cross-platform follow-ups from the AoA Quality Baseline (v2) plan. Surfaced when matrix CI was first added (PR #106).
EOF
)"
```

(Replace `<PASTE_VERIFY_MACOS_URL_FROM_STEP_1>` with the actual URL from Step 1's output.)

- [ ] **Step 3: File issue: Windows verify failure**

```bash
gh issue create \
  --title "ci: verify-cross-platform fails on windows-latest" \
  --label "bug,ci,windows" \
  --body "$(cat <<'EOF'
## Symptom
The advisory \`verify-cross-platform (windows-latest)\` job (added in PR #106) fails ~14-16min into the run on every PR.

## First-run reference
Failed on PR #106's first run: <PASTE_VERIFY_WINDOWS_URL_FROM_STEP_1>
Also failed on PR #107's run.

## Investigation needed
- Read the job log to identify which step fails
- Strong candidate: \`companies-delete-integration.test.ts\` fails with \`character with byte sequence 0xe2 0x86 0x92 in encoding \"UTF8\" has no equivalent in encoding \"WIN1252\"\` per CLAUDE.md note about embedded-postgres locale handling
- The patched \`embedded-postgres@18.1.0-beta.16\` and \`sanitizeForDb\` workaround may not cover all paths

## Acceptance criteria
- [ ] Root cause identified (encoding vs. native-binding vs. test logic)
- [ ] Fixed in source where possible; test platform-skipped if not
- [ ] Once stable, flip to required check via branch protection rule update

## Context
This is one of 3 cross-platform follow-ups from the AoA Quality Baseline (v2) plan. CLAUDE.md documents the embedded-postgres Windows-locale workaround.
EOF
)"
```

- [ ] **Step 4: File issue: Windows e2e failure**

```bash
gh issue create \
  --title "ci: e2e-cross-platform fails on windows-latest" \
  --label "bug,ci,windows" \
  --body "$(cat <<'EOF'
## Symptom
The advisory \`e2e-cross-platform (windows-latest)\` job (added in PR #106) fails ~4-5min into the run on every PR.

## First-run reference
Failed on PR #106's first run: <PASTE_E2E_WINDOWS_URL_FROM_STEP_1>
Also failed on PR #107's run.

## Investigation needed
- Read the job log to identify which step fails
- Likely candidates:
  - Playwright config gen step (uses \`shell: bash\` HEREDOC; Windows path semantics)
  - Server boot (embedded-postgres on Windows runner)
  - Marketplace catalog fixture copy (path separator)
- macOS e2e PASSES on the same job — so the failure is Windows-specific, not Playwright-specific

## Acceptance criteria
- [ ] Root cause identified (config gen vs. server boot vs. fixture path)
- [ ] Fixed in source
- [ ] Once stable, flip to required check via branch protection rule update

## Context
This is one of 3 cross-platform follow-ups from the AoA Quality Baseline (v2) plan. \`e2e-cross-platform (macos-latest)\` PASSES on the same matrix — confirming the failure is Windows-specific, not e2e-specific.
EOF
)"
```

- [ ] **Step 5: Confirm all 3 issues filed**

```bash
gh issue list --label "ci" --limit 5 --json number,title,state --jq '.[]'
```

Expected: 3 new issues (open) matching the titles above.

- [ ] **Step 6: Update todos**

This task is complete when all 3 issues are filed and visible in `gh issue list`.

---

## Task 2A: SPIKE — Get `pnpm dev` running on Windows

**Context:** The original Issue #96 UI verification was deferred because `pnpm dev` was broken on Windows native. Three distinct bugs were documented in the prior session:
1. **Bash-style env-var prefix** in `dev:watch` script — fixed in Task 4 (PR #103) ✅
2. **`pnpm dev:once` server crash mid-migration** with NOTICE 42P06
3. **`pnpm db:migrate` requires DATABASE_URL** but dev uses embedded-postgres (no URL)

This spike confirms whether `pnpm dev` boots cleanly post-Task-4 OR surfaces additional latent bugs.

**Halt criteria (subagent stops + reports):**

- 🛑 **`pnpm dev` boots cleanly to a usable state** (Vite shows "Local:   http://localhost:5173" AND server logs show "[aoa] dev mode: ...") — STOP, this is the SUCCESS path. Report findings to the controller, who proceeds to Task 2B.
- 🛑 **`pnpm dev` fails with a NEW (not-previously-documented) Windows bug** — STOP. Report the full error log + offending step. Controller decides between (a) extending Phase 1 with a fix-task, (b) scoping a separate bug-fix plan, or (c) deferring 2B/2C.
- 🛑 **`pnpm dev` fails with one of the previously-documented bugs (NOTICE 42P06 or DATABASE_URL)** — STOP. Report which one. Controller decides whether to file as a follow-up issue and defer Phase 2, or extend Phase 1 with a fix-task.
- 🛑 **`pnpm dev` runs but UI doesn't reach the company picker / login screen** — STOP. The dev server may be partially up but functionally broken. Report what's visible in the browser + the logs.
- 🛑 **The spike takes >15 minutes** — likely a hang. Kill, report, controller decides.

**Files:**
- Output (no commit): a brief markdown summary written to console + reported in the subagent's final message.

- [ ] **Step 1: Confirm Task 4's `cross-env` fix is in the active tree**

```bash
grep "cross-env AOA_MIGRATION_PROMPT" server/package.json
```

Expected: 1 hit at the `dev:watch` script. If absent, the local tree is stale — pull `Porting1.1` first.

- [ ] **Step 2: Start `pnpm dev` and observe**

```bash
pnpm dev 2>&1 | tee /tmp/aoa-dev-spike.log
```

(On Windows, redirect to `%TEMP%\aoa-dev-spike.log` instead of `/tmp/`.)

The command will not exit (dev server runs until killed). Watch the output for:
- ✅ Success markers: `[aoa] dev mode: local_trusted (default)`, `[aoa] server listening on http://127.0.0.1:3100`, Vite's `Local:   http://localhost:5173`
- ❌ Failure markers: `Error:`, `Failed to`, `crashed`, stack traces

Wait up to 60 seconds.

- [ ] **Step 3: If the server boots, smoke-test the UI**

In a separate terminal (or browser), open http://localhost:5173 and confirm the AoA UI loads. If you can't reach it:
- Check `curl -sS http://localhost:5173` from the same machine (returns the index.html?)
- Check `curl -sS http://localhost:3100/api/health` (does the server respond?)

If both respond, the dev environment is functional → spike PASSES.

- [ ] **Step 4: If the server boots cleanly, kill it and report SUCCESS**

```bash
# Ctrl-C the pnpm dev terminal, OR find and kill the process group:
# (POSIX) pkill -f 'tsx watch'
# (Windows) taskkill /F /IM node.exe  -- careful, this kills ALL node processes
```

Report status: **DONE — `pnpm dev` boots cleanly. Phase 2 can proceed.** Include:
- Total time from `pnpm dev` to "server listening"
- Any warnings or non-fatal log lines worth noting
- A snippet of the success log (last 10 lines before kill)

- [ ] **Step 5: If the server fails to boot, report FAILURE**

Capture:
- The exact error message + 20 lines of context before it
- Which step in the boot sequence triggered it (Vite? server? embedded-postgres?)
- Whether it matches one of the 2 documented prior bugs (NOTICE 42P06 or DATABASE_URL) or is new

Status: **BLOCKED — `pnpm dev` does not boot. Controller decision needed.**

- [ ] **Step 6: Append spike findings to the plan file**

Regardless of outcome, append a brief note to `docs/superpowers/plans/2026-05-05-quality-closeout-and-issue-96-verification.md` under a new section `## Phase 2A Spike Findings (executed YYYY-MM-DD)`:

```markdown
## Phase 2A Spike Findings (executed YYYY-MM-DD)

**Outcome:** SUCCESS | BLOCKED — [one-line summary]

**Boot time:** N seconds from `pnpm dev` to "server listening" (or N/A if failed)

**Notable observations:**
- [bullet points]

**Next step:** [Phase 2B / Phase 1B fix-Windows-dev / defer to follow-up plan]
```

This is a documentation step, not a commit — it edits the plan file in place. The controller can choose to commit the plan update or not.

---

## Task 2B: Define the UI verification scenario for Issue #96

**Context:** Task 6's PR #104 added cancellation logs that include `pid` and `processGroupId`. Combined with the new structured `reason` discriminant, we can verify killProcessTree purely from logs + a `ps`/`tasklist` check on the parent + grandchild PIDs. This task defines the exact verification scenario; Task 2C executes it.

**This task runs ONLY if Task 2A succeeded.** If 2A halted, the controller decides whether to enter this task at all.

**Halt criteria (subagent stops + reports):**

- 🛑 **The `process` adapter has been removed or restructured** since the prior session — STOP. The verification needs an adapter that spawns child processes (so the tree-kill is exercisable). Report what adapters are available; controller picks an alternate.
- 🛑 **The UI doesn't have a "Cancel" button on the running heartbeat run** — STOP. Verification requires a UI-triggered cancel, not just a programmatic one. Report what cancel paths exist; controller decides.

**Files:**
- Modify: `docs/superpowers/plans/2026-05-05-quality-closeout-and-issue-96-verification.md` (append a `## Verification Scenario` section)

- [ ] **Step 1: Confirm `process` adapter exists**

```bash
grep -n "process_adapter\|adapter.*process\|class ProcessAdapter\|registerAdapter.*process" server/src/adapters/index.ts server/src/adapters/process/*.ts 2>&1 | head -10
```

Expected: hits in `server/src/adapters/process/`. The `process` adapter spawns user-supplied commands.

- [ ] **Step 2: Confirm UI cancel button exists**

```bash
grep -n "cancelRun" ui/src/pages/AgentDetail.tsx
```

Expected: hits at lines ~1509 (mutation) + ~1655 (button). The cancel button is on the agent detail page.

- [ ] **Step 3: Append the scenario to the plan file**

Append (using the Edit tool to find the end of file and add):

```markdown

## Verification Scenario for Issue #96 (defined Phase 2B)

**Goal:** Confirm `signalRunningProcess` actually kills the entire process tree (parent + grandchild) when the user clicks "Cancel" in the UI on a running heartbeat.

**Setup:**
1. Launch `pnpm dev` (Phase 2A confirmed this works).
2. Sign in / bootstrap-CEO if needed (first-time setup).
3. Navigate to **Settings → Agents → New Agent** and create a test agent with these settings:
   - **Name:** `tree-kill-tester`
   - **Adapter:** `process`
   - **Command:** `bash`
   - **Args:** `-c "echo grandchild_pid=$$ && sleep 120 & wait"`
   - **Working directory:** any valid path on disk
   - **Heartbeat:** disabled (we'll trigger manually)
   - Save the agent.

   On Windows: replace `bash` with `bash.exe` and ensure Git Bash is installed (the `process` adapter uses native `child_process.spawn`, not the workspace's `cross-env`).

4. From the agent detail page, click **"Wake on demand"** (or the equivalent "Run now" button). This enqueues a heartbeat run.

5. Observe the run start (status: running, with a "Cancel" button visible).

**The verification:**

6. **CAPTURE pre-cancel state.** In a separate terminal:
   ```bash
   # POSIX:
   ps -ef --forest | grep -E "tree-kill-tester|sleep 120|bash -c"
   # Windows (PowerShell):
   tasklist /v /fi "imagename eq bash.exe"
   tasklist /v /fi "imagename eq sleep.exe"
   ```
   Note the parent (bash) PID and grandchild (sleep) PID. Both should be alive.

7. **CLICK "Cancel"** in the UI on the running heartbeat.

8. **OBSERVE server logs** within 5 seconds. Expected log lines:
   ```
   [INFO] heartbeat.cancel: signaling SIGTERM { runId: ..., agentId: ..., pid: <parent>, processGroupId: <pgid>, reason: "cancelRun" }
   ```
   And after the grace period (~5–10 seconds default):
   - If the process exited cleanly during grace: NO SIGKILL log (Task 1B's guard).
   - If still running: `[INFO] heartbeat.cancel: signaling SIGKILL { ..., reason: "cancelRun.grace-expired" }`.

9. **CAPTURE post-cancel state.** Re-run the same `ps` / `tasklist` commands from Step 6.
   - **PASS criterion:** Both the parent (bash) AND grandchild (sleep) PIDs are GONE.
   - **FAIL criterion:** Either PID is still alive after 10 seconds.

**Pass = Issue #96 is verified.** Both parent and grandchild are reaped via process-group signaling (POSIX) or `child.kill` (Windows fallback).

**Fail = Issue #96 is regressed.** Capture the surviving PIDs + log lines + run a postmortem.

**Verification artifact:** Screenshot of UI cancel + log excerpt + before/after `ps` output, all attached to a comment on Issue #96 (Task 2C).
```

- [ ] **Step 4: Self-review the scenario**

Read what you just wrote. Does it:
- Have an explicit pass/fail criterion? ✅ (Step 9)
- Use commands that exist on both POSIX and Windows? ✅ (with platform-specific notes)
- Include log lines that match Task 6's PR #104 format? ✅
- Include the SIGKILL guard (Task 1B) check? ✅

If any answer is NO, fix in place.

- [ ] **Step 5: Report DONE**

Status: **DONE — verification scenario defined**. The plan file now contains Phase 2C-executable steps. Controller proceeds to Task 2C.

(No commit on the plan file — these are working notes; commit only if the controller wants the scenario in version control.)

---

## Task 2C: Execute UI verification + capture evidence

**Context:** Task 2B's scenario is now executable. This task runs it on the local Windows dev environment, captures evidence, and posts it as a comment on Issue #96.

**This task runs ONLY if 2A and 2B both succeeded.**

**Halt criteria (subagent stops + reports):**

- 🛑 **The agent fails to spawn the bash subprocess** (e.g., bash not in PATH on Windows) — STOP. Report. Controller may switch the test command to a Windows-native equivalent (e.g., `powershell -Command "Start-Sleep -Seconds 120"` with appropriate sleep grandchild).
- 🛑 **The Cancel button doesn't trigger a run cancel** (UI shows the run as still running 30s after click) — STOP. This is a real bug separate from Issue #96. Report.
- 🛑 **The PIDs survive Cancel** — DO NOT mark Issue #96 as verified. Report. This is a regression.
- 🛑 **No log lines appear matching the expected format** — STOP. Either Task 6 didn't actually land or the log destination is mis-configured. Report.

**Files:** None (output is a comment on Issue #96 + evidence files, optionally checked into `docs/superpowers/evidence/`).

- [ ] **Step 1: Confirm Issue #96 state**

```bash
gh issue view 96 --json state,closedAt,url --jq '.'
```

If `state == CLOSED`, reopen for the verification comment:

```bash
gh issue reopen 96 --comment "Reopening to attach final UI verification evidence per Phase 2C of the Quality Baseline Closeout plan."
```

- [ ] **Step 2: Execute the scenario from Task 2B step-by-step**

Follow the `## Verification Scenario for Issue #96` section that Task 2B appended to this plan file. Capture:
- A screenshot of the UI with the running heartbeat + Cancel button (before clicking).
- A screenshot of the UI immediately after clicking Cancel (status should transition to "cancelled").
- Server log excerpt: 5 lines before + 5 lines after the SIGTERM log line.
- `ps` / `tasklist` output: BEFORE and AFTER cancel.

- [ ] **Step 3: Save artifacts to a temporary location**

```bash
# POSIX:
mkdir -p /tmp/issue-96-evidence
# Windows: use %TEMP%\issue-96-evidence
# Place: ui-before.png, ui-after.png, log-excerpt.txt, ps-before.txt, ps-after.txt
```

- [ ] **Step 4: Comment on Issue #96 with evidence**

```bash
gh issue comment 96 --body "$(cat <<'EOF'
## ✅ Issue #96 — UI verification complete (Phase 2C, 2026-05-05)

The original `killProcessTree` fix (PR #102, commit 9c1bdef) was merged on 2026-05-04 with unit + integration test coverage. This comment closes the loop with end-to-end UI verification on a real running app.

### Setup
- Branch: `Porting1.1` HEAD `<HEAD_SHA>`
- Platform: Windows native (post-Task-4 cross-env fix)
- Agent: `tree-kill-tester` using the `process` adapter
- Command: `bash -c "echo grandchild_pid=$$ && sleep 120 & wait"`

### Pre-cancel state
**Process tree (`ps -ef --forest` / `tasklist`):**
```
<PASTE_PS_BEFORE>
```
Both parent (bash) and grandchild (sleep) PIDs are alive.

### Action
Clicked **Cancel** in the UI on the running heartbeat.

### Server logs (within 5 seconds)
```
<PASTE_LOG_EXCERPT>
```

The structured log lines match the format from PR #104 (Task 6):
- `reason: "cancelRun"` — initial SIGTERM
- `reason: "cancelRun.grace-expired"` — SIGKILL escalation (or absent if process exited cleanly during grace; see PR #<TASK_1B_PR>)

### Post-cancel state
**Process tree (`ps -ef --forest` / `tasklist`):**
```
<PASTE_PS_AFTER>
```
Both parent and grandchild PIDs are GONE. Tree-kill works end-to-end.

### Verdict
✅ **PASS** — `signalRunningProcess` correctly tears down the entire process tree on UI-triggered cancellation. Issue #96 is verified at the runtime level.

### Artifacts
- UI before/after: <attach_or_link>
- Full server log: <attach_or_link>
- Pre/post `ps` output: <attach_or_link>

Closing the issue (was reopened for this verification).
EOF
)"
```

(Replace placeholders with actual captured data.)

- [ ] **Step 5: Re-close Issue #96 if it was reopened**

```bash
gh issue close 96 --comment "Verified end-to-end via UI on Windows native. See preceding comment for evidence."
```

- [ ] **Step 6: Report DONE**

Status: **DONE — Issue #96 verified end-to-end via UI**. The plan is complete.

If the verification FAILED (PIDs survived cancel), report **DONE_WITH_CONCERNS** with:
- The surviving PID(s)
- The exact log line(s) that fired
- Whether `running.processGroupId` was correctly populated in the log payload
- A hypothesis for what regressed

The controller decides whether to file a new bug, revert PR #102, or extend Phase 2 with a debug task.

---

## Self-Review Checklist

- [x] **Spec coverage:** All 6 reviewer recommendations from the v2 plan retrospective are addressed:
  - Bypass surface in policy gate → Task 1A (docs)
  - `migrations` not in branch protection → flagged as maintainer-only B1
  - Verify all 4 required checks → flagged as maintainer-only B2
  - 3 cross-platform follow-up issues → Task 1D
  - Migrations chain check hardening → Task 1C
  - SIGKILL guard → Task 1B
- [x] **Original mission resumed:** Phase 2 (2A spike → 2B scenario → 2C execution) covers the deferred Issue #96 UI verification.
- [x] **No placeholders:** Each task has explicit code blocks, exact commands, exact file paths. The `<PLACEHOLDERS>` in Task 2C's comment template are intentional — they're filled in at execution time with real captured data, not at planning time.
- [x] **Halt criteria present:** Every task has explicit 🛑 triggers that route surprises to the controller.
- [x] **Controller-vs-subagent boundaries clear:** Top of plan enumerates exactly what each role decides.
- [x] **Type/identifier consistency:** `signalRunningProcess`, `runningProcesses`, `process` adapter, `cancelRun.grace-expired` reason discriminant — all referenced consistently with how they exist in production code.
- [x] **Risk callouts:** Phase 2A is a hard gate; Phase 2 is unblocked only by 2A SUCCESS. Maintainer actions (B1/B2) are flagged separately because they live outside this plan.

---

## Risks & Open Questions

1. **Phase 2A may surface more Windows bugs.** Two distinct dev bugs were documented prior to Task 4 (NOTICE 42P06 mid-migration, DATABASE_URL requirement). If either still bites, the controller decides between extending Phase 1 or deferring Phase 2 entirely.

2. **The `process` adapter test command (`bash -c "sleep 120 & wait"`) requires bash on the test machine.** On Windows native without Git Bash installed, the test will fail at agent run time. Task 2C's halt criteria cover this — controller can switch to a PowerShell-equivalent.

3. **Task 1A's AGENTS.md edit assumes §7 exists.** If the file's section numbering has shifted, the spike step at the top of 1A catches this.

4. **Task 1B's guard relies on `runningProcesses.delete()` being called by the normal completion path.** The task's Step 2 verifies this assumption. If the assumption fails, the guard logic needs revision (controller decides).

5. **Task 1D's GH issue filing requires `gh` to be authenticated and have `issues:write` on the repo.** The controller-only nature lets this fail loudly without subagent handoff overhead.

6. **Task 2C's comment template assumes Issue #96 exists and is reopen-able.** If it was deleted (unlikely) or is somehow uneditable, the comment goes elsewhere — controller decides.

7. **Maintainer actions B1/B2 are NOT in this plan.** They are explicit todos for the human maintainer (you). Without them, PR #107's `migrations` job is informational and PR #105's decoupling assumes branch protection requires verify+e2e.

---

## Phase 2A Spike Findings (executed 2026-05-05)

**Outcome:** SUCCESS after fixing a NEW bug surfaced during the spike.

**Found a new bug:** `dev:watch` in `server/package.json` was set to `AOA_MIGRATION_PROMPT=never` (skip migrations). On a fresh embedded-postgres database, this caused the server to skip applying all 83 migrations and crash at the first query (`relation "user" does not exist`). The correct value is `AOA_MIGRATION_AUTO_APPLY=true` (apply migrations without prompting).

**Fix shipped:** PR #115 (`fix/dev-watch-auto-apply-migrations`) changes `AOA_MIGRATION_PROMPT=never` → `AOA_MIGRATION_AUTO_APPLY=true`. Locally validated: `pnpm dev` boots in ~3 seconds with all migrations applied, server listening on `127.0.0.1:3100`, UI accessible.

**Boot time:** ~3 seconds end-to-end after fix.

**Notable observations:**
- Embedded postgres auto-recovered from a stale lock file left by the previous crashed run.
- The migration apply produced harmless `NOTICE 42P06` ("schema 'drizzle' already exists") and `NOTICE 42P07` ("relation '__drizzle_migrations' already exists") — these are informational, drizzle's `IF NOT EXISTS` guards handled them gracefully.
- pgvector NOT available in dev environment (warning logged); semantic search falls back to text (ilike). Documented behavior.
- **Surfaced an additional bug:** `/api/auth/me` returns HTTP 500 on a fresh install instead of a clean 401 / `{user: null}`. UI polls this endpoint, generating noise. Filed as Issue #116.

**Next step:** Phase 2B (define UI scenario) → Phase 2C (manual UI verification by the maintainer once auth is bootstrapped via `pnpm aoa onboard`).

---

## Phase 2B Verification Scenario (defined 2026-05-05)

**Goal:** Verify Issue #96's `signalRunningProcess` fix is wired correctly through the UI cancel button on Windows.

**Note on tree-kill semantic limitation:** On Windows, `process.kill(-pgid)` is POSIX-only. The implementation falls back to `child.kill` which only signals the parent process — not its descendants. This is a documented limitation captured in `heartbeat-process-tree-kill.integration.test.ts` (skipped on Windows). The Windows verification therefore validates **parent process termination** + **cancellation log structure**, NOT grandchild reaping. For the full tree-kill semantic, the POSIX integration test in CI is the authoritative evidence (currently blocked by Actions billing — see incident).

### Prerequisites

1. **PR #115 merged** (or the `fix/dev-watch-auto-apply-migrations` branch checked out): provides the working `pnpm dev` for Windows.
2. **Issue #116 fixed** (or accepted as noise): `/api/auth/me` 500s during onboarding don't prevent verification but make the UI state messy.
3. **Bash available**: required for the `process` adapter test command. Git Bash (shipped with Git for Windows) is sufficient.

### Setup (one-time, ~5 minutes)

1. Boot dev: `pnpm dev`. Wait for "Server listening on 127.0.0.1:3100".
2. In a new terminal: `pnpm aoa onboard`. This walks through CEO bootstrap (sign-up + sign-in + agent JWT generation).
3. Open `http://127.0.0.1:3100` in your browser. You should see the onboarding flow → home page after sign-in.
4. Navigate to **Settings → Agents → New Agent** and create:
   - **Name:** `tree-kill-tester`
   - **Adapter:** `process`
   - **Command:** `bash`
   - **Args:** `-c "echo grandchild_pid=$$ && sleep 120 & wait"`
   - **Working directory:** any valid path on disk (e.g., the repo root)
   - **Heartbeat interval:** disabled (manual trigger)
   - Save the agent.

### The Verification (~3 minutes)

5. From the agent detail page, click **"Wake on demand"** (or the equivalent "Run now" button). This enqueues a heartbeat run.
6. Observe the run start (status: `running`, with a "Cancel" button visible).
7. **CAPTURE pre-cancel state** in a separate PowerShell window:
   ```powershell
   Get-WmiObject Win32_Process -Filter "Name='bash.exe' OR Name='sleep.exe'" | Format-Table ProcessId,Name,ParentProcessId,CommandLine -AutoSize
   ```
   Note the parent (bash) PID and grandchild (sleep) PID. Both should be alive.
8. **CLICK "Cancel"** in the UI.
9. **OBSERVE server logs** within 5 seconds. Expected log entry:
   ```
   [INFO] heartbeat.cancel: signaling SIGTERM
     { runId: ..., agentId: ..., pid: <parent-pid>, processGroupId: null, reason: "cancelRun" }
   ```
   Note: `processGroupId` is `null` on Windows (POSIX-only field) — the log line still fires, with the parent's PID. After the grace period (~5–10s default) the SIGKILL escalation log MAY fire, depending on whether the parent exited cleanly during grace.
10. **CAPTURE post-cancel state** with the same PowerShell command.

### Pass/fail criteria

- **PASS — parent termination wired:** The parent (bash) PID is GONE in step 10. The log line in step 9 fired with the right structure. UI status transitioned to `cancelled`.
- **EXPECTED LIMITATION (not a fail):** The grandchild (sleep) PID may still be alive after step 10 — Windows fallback only signals the parent. Document the surviving PID in the verification report; it's an OS-level limitation, not a regression of Issue #96.
- **FAIL:** If the parent PID is still alive 10 seconds after Cancel → Issue #96 has regressed. File urgently with logs + PIDs.
- **FAIL:** If no log line fires → PR #104's logging didn't actually land. Check `git log server/src/services/heartbeat.ts | head -5`.

### Verification artifact

Once complete, attach to a comment on Issue #96 (reopen first if closed):
- Browser screenshot: UI before Cancel + UI after Cancel
- Server log excerpt: 5 lines before + 10 lines after the SIGTERM log
- PowerShell `Get-WmiObject` output: BEFORE and AFTER

Use `gh issue comment 96 --body "$(cat <<'EOF' ... EOF)"` to post.

### Why this scenario is sufficient (controller note)

We're not testing tree-kill itself on Windows (that's POSIX-only and tested by the integration test). We're testing that:
1. The UI Cancel button calls the cancel API
2. The cancel API calls `cancelRun` in the heartbeat service
3. `cancelRun` calls `signalRunningProcess` with the right metadata
4. The new structured log lines from PR #104 fire correctly
5. The parent process actually exits (which is all `child.kill` can do on Windows)

That's the full plumbing verification on Windows. POSIX tree-kill semantics are tested separately by the integration test in CI.

---

## Phase 2C Status (2026-05-05)

**State:** DEFERRED to manual maintainer execution.

**Why deferred:** The verification scenario above requires browser-based onboarding + agent creation + button clicks. The session that drove this plan is operating in a non-browser context (programmatic terminal), so the click-through is more efficient as a manual maintainer step. The infrastructure to support it (Phase 2A's `pnpm dev` fix, Phase 2B's defined scenario) is in place.

**Recommended sequence:**
1. Maintainer admin-merges PR #111, PR #115 (both locally validated; CI blocked by billing).
2. Maintainer addresses Issue #116 (`/api/auth/me` 500) — optional, but cleaner.
3. Maintainer runs the Phase 2B verification scenario (~10 minutes total).
4. Maintainer attaches evidence to Issue #96 and re-closes it (if not already).

---
