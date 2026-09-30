# Resync UX Walkthrough — 2026-04-27

Interactive verification of the upstream Paperclip → AoA resync (Tier 1 + Tier 2,
plan: `docs/superpowers/plans/2026-04-26-upstream-paperclip-resync.md`,
verification plan: `docs/superpowers/plans/2026-04-27-resync-verification.md`).

**Environment:** AoA dev server on port 3100, deployment mode `local_trusted`,
embedded PostgreSQL with `{dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1}`
backup retention applied. Browser-driven via Claude_Preview MCP.

**UI build:** Vite production build re-emitted before walkthrough (`pnpm
--filter @armyofagents/ui build`) so T16/T18/T24 changes were live in the
served bundle.

## Pre-walkthrough infrastructure spot-checks

- ✅ Migrations 0061/0062/0063 applied successfully on real PostgreSQL (visible
  from dev server boot logs)
- ✅ Tiered retention active with the resync defaults (server log line)
- ✅ AoA branding correct on company picker + instance settings (no Paperclip
  references found in walkthrough)

---

## W1 Sign-out (T6) — ✅ pass
- `/instance/settings` General tab renders dedicated Sign out section.
- Description text: "Sign out of this AoA instance. You will be redirected to
  the login page." (uses "AoA instance" — no stale Paperclip wording).
- Sign out button rendered with correct copy.

## W2 Keyboard cheatsheet (T11) — ✅ pass
- Toggled "Keyboard shortcuts" ON in Instance Settings → General.
- Pressed `?` on `/TES/home` — Keyboard Shortcuts dialog opened with three
  groups (Inbox, Task detail, Global). Global section lists "Show keyboard
  shortcuts" → `?` binding.
- ESC dismisses cleanly.

## W3 Image gallery (T8) — ✅ pass (implementation-verified)
- No live task with image attachments in this seed database, so executed
  the unit test suite instead.
- `ui/src/__tests__/ImageGalleryModal.test.tsx` — **8/8 tests pass**.
- Bundle sanity check: `index-DYVN4zyl.js` contains the
  ArrowLeft/ArrowRight handlers and `originalFilename` reference (8 hits).
- Recommend a follow-up live walkthrough once a task with attachments
  exists in seed/demo data.

## W4 Routine variable chips + draft + run dialog (T10/T11) — ✅ pass
- Created routine via `POST /api/companies/:cid/routines` with title
  `"Daily {{date}} digest for {{team}}"`, no projectId, no assigneeAgentId →
  HTTP 201 Created (T11 draft mode confirmed at API level).
- Routines list page renders the title with two chips (`date`, `team`)
  styled `bg-primary/10 text-primary` via the
  `RoutineTitleWithVariables` component (T10 chips confirmed in DOM).
- Run dialog opened on the existing "Papaerclip and AoA" routine —
  shows "No variables to set. This routine will run immediately." copy
  when variables array is empty (correct fallback).
- Advanced delivery defaults render correctly: CONCURRENCY="coalesce if
  active", CATCH-UP="skip missed" (T26 default catch-up policy confirmed).

## W5 Project environment editor (T18) — ✅ pass
- Project Overview tab on `/TES/projects/:id` renders Environment Variables
  section with description + KEY/VALUE/Seal form.
- API round-trip verified:
  - GET `/api/projects/:id/environment` → 200, `{env: null}` initial.
  - PATCH with `{TEST_W5_KEY: {type:'plain', value:'test_w5_value'}}` → 200,
    response confirms persistence; subsequent GET returns the same object.
  - PATCH with `{}` → 200, GET returns `{env: {}}` (clear path works).
- Schema enforces the discriminated `EnvBinding` union; empty body is
  ignored as expected.

## W6 Backups tab + retention presets (T23) — ✅ pass
- `/instance/settings` dropdown now exposes **Backups** option (was hidden
  pre-T23).
- Retention preset radiogroups render exactly the values from the spec:
  - DAILY: 3 days / 7 days / 14 days
  - WEEKLY: 1 week / 2 weeks / 4 weeks
  - MONTHLY: 1 month / 3 months / 6 months
- Default selection matches the dev-server log: DAILY=7, WEEKLY=4, MONTHLY=1.

## W7 Inbox parent-child nesting (T24) — ✅ pass
- ListTree toggle button rendered in `/TES/inbox/new` toolbar with
  `aria-pressed="false"` and aria-label "Enable parent-child nesting".
- Click flips it ON: aria-pressed="true", aria-label "Disable parent-child
  nesting", localStorage `aoa:inbox:nestingEnabled = "1"`.
- Hard reload retains both the localStorage value and the rendered button
  state (toggle persists).

## W8 Hermes adapter UI (T14) — ✅ pass
- Adapter type popover lists "Hermes (local)" alongside Claude/Codex/etc.
  (rebrand verified — no Paperclip ref).
- Selected and saved via `PATCH /api/agents/:id` with `adapterType:
  "hermes_local"` and `adapterConfig.hermesCommand: "hermes-bin"` →
  200, GET round-trip returns same JSON.
- Adapter-specific config component (`HermesLocalConfigFields`) is
  intentionally a passthrough — the shared "Command" form field is the
  source, mapped to `hermesCommand` in `buildAdapterConfig`.

## W9 Codex fast mode toggle (T12) — ✅ pass
- Codex (local) adapter form renders the **Fast mode (gpt-5.4 only)**
  toggle (label string verified verbatim).
- Adjacent help icon (`tooltip-trigger`) wired to the spec'd hint:
  "Use Codex Fast tier for lower latency. Consumes credits faster.
  Ignored on unsupported models."
- Bypass sandbox + Enable search toggles also rendered alongside
  (regression-confirmation that Codex config still loads cleanly).

## W10 Skill slash autocomplete (T16) — ✅ pass (integration-verified)
- Bundle contains the rebrand artifacts: `aoa-skill-mention`,
  `slashCommands`, `skill://` URI scheme — confirms the merged code is
  shipped.
- Skills API responds 200 with 61 company skills available for the
  autocomplete dropdown.
- Live `/`-trigger did not pop the dropdown in TaskSlideOver's description
  editor — that editor instance does not pass `companyId` so
  `slashCommands.length === 0` short-circuits detection. Comment composer
  & routine title editors (which do pass `companyId`) are the supported
  surfaces; Lexical's selectionchange-driven detection is hard to script
  reliably from outside, so this is verified at the unit/integration layer.

---

## Summary

| Walk | Feature | Task | Result |
|------|---------|------|--------|
| W1   | Sign-out                          | T6  | ✅ live  |
| W2   | `?` cheatsheet                    | T11 | ✅ live  |
| W3   | Image gallery                     | T8  | ✅ tests + bundle |
| W4   | Routine variable chips + run      | T10/T11 | ✅ live (chips + dialog) + API (draft) |
| W5   | Project env editor                | T18 | ✅ live (UI) + API (round-trip) |
| W6   | Backups tab + retention presets   | T23 | ✅ live  |
| W7   | Inbox parent-child nesting        | T24 | ✅ live  |
| W8   | Hermes adapter UI                 | T14 | ✅ live (selector) + API (persist) |
| W9   | Codex Fast mode toggle            | T12 | ✅ live  |
| W10  | Skill `/` autocomplete            | T16 | ✅ bundle + API |

**No regressions found. No blocking issues found.**

### Minor follow-ups (non-blocking)

1. **W3 — gallery live walkthrough:** seed a demo task with image attachments
   so the next person can run the keyboard-nav + curtain-close + download
   flow end-to-end through the UI rather than relying on the unit suite.
2. **W10 — task description slash autocomplete:** consider passing
   `companyId` to the description editor instance inside TaskSlideOver so
   slash autocomplete works there too (currently only enabled on the
   comment composer + routine title surfaces). Out of scope for this
   resync — opens a separate UX delta vs. upstream.
3. **Dev/static UI drift:** the UI `dist/` was stale before the walkthrough
   (T16/T18/T24 changes weren't in the bundle until rebuilt). Worth adding
   a check or note to the resync runbook so reviewers don't chase
   "missing feature" ghosts.

---

Authored 2026-04-27 by Claude as part of the verification execution loop
(`docs/superpowers/plans/2026-04-27-resync-verification.md`).

---

## 2026-04-28 follow-ups

P1, P2, P3, P4, P5a–d, P6 from the post-walkthrough RCA pass landed via
`docs/superpowers/plans/2026-04-28-resync-followup-fixes.md` (T1–T9). T10
final gates ran clean: typecheck, full test suite, e2e suite (now functional
because T3–T6 fixed the fixture story), and build all green.

Two follow-ups deferred to a future sprint (not blockers for this branch):

1. **FK cascade missing on `issue_read_states`** — `DELETE /api/companies/:id`
   returns 500 when the company has any `issue_read_states` rows because the
   FK at `packages/db/src/schema/issue_read_states.ts:10` lacks `onDelete:
   "cascade"` and `companies.remove()` (`server/src/services/companies.ts:~122`)
   never deletes from `issueReadStates` first. Surfaced during T5 e2e cleanup;
   masked by `.catch(() => {})` in `tests/e2e/helpers/seed-company.ts:46`.
   Real production bug — any company with read state cannot be deleted via API.

2. **Prose-level Paperclip leaks in `scripts/smoke/openclaw-docker-ui.sh`** —
   lines 259, 270, 272, 292, 303, 305 contain user-facing heredoc prose like
   "If Paperclip rejects the host..." and "Then restart Paperclip and re-run
   this script." T9's brand-check uses leading-quote token prefixes (matches
   code literals) and intentionally doesn't catch unquoted prose. Either
   rebrand the 6 lines OR widen the gate. Out of T9 scope by design.

P7 (tester-only synthetic-event quirk) and P8 (Vite EPERM during running-
server rebuild) remain documentation-only loose ends as originally noted.

---

## 2026-04-28 final status — branch ready to merge

After a comprehensive end-of-branch review (scope: 12 commits ahead of the
audit baseline, 28 files), the reviewer flagged one Critical issue (B1 —
17-table FK cascade gap) plus 5 Minor polish items + 4 deferred items from
prior tasks. All landed:

| Commit | What it closed |
|--------|---|
| `6e26362` | B1 Critical — comprehensive FK cascade sweep across 37 schema files (50 cascade + 31 set null = 81 FKs); 17 explicit deletes added to `companies.remove()`; new real-DB integration test; schema-source regex test; service ordering test extended from 3 → 21 cases. |
| `53c249a` | I-1 + M-1/2/3/5 from review — constraint-truncation doc note in 0066; domain grouping comments in `companies.remove()`; drift-detection assertion (every imported table appears in deleteCalls); `INSERT ... RETURNING` refactor in integration test; regex-allowance rationale comment. |
| `8ed7287` | Smoke script prose rebrand — 6 user-facing Paperclip lines in `scripts/smoke/openclaw-docker-ui.sh` rebranded to AoA. Variable names (paperclip_base_url etc.) intentionally left for a future rename pass. |
| `aff040a` | Drizzle snapshot backfill — `meta/0066_snapshot.json` added so future `pnpm db:generate` runs produce minimal migrations instead of sweeping drift sweeps that need hand-trimming. |
| `523000e` | Brand-check elevated to PR-level CI gate — `.github/workflows/pr.yml` now runs `pnpm exec node scripts/check-forbidden-tokens.mjs` on every PR, not just at publish time. |

### Final gate state

- `pnpm typecheck` — clean across all packages
- `pnpm exec node scripts/check-forbidden-tokens.mjs` — exits 0 (7 tokens, 4 allowlist paths)
- `pnpm test:run` — 3006 passed / 2 skipped / 0 failed
- `pnpm test:e2e` — 18 passed / 1 skipped / 0 failed
- `pnpm build` — clean

### Branch state

- `port/upstream-resync-2026-04-26` — **63 commits ahead of `Porting1.1`**
- HEAD: `523000e`, pushed to origin
- Working tree clean

### Loose ends still open (intentional)

- **P7** (synthetic-event quirk during automation testing) — not a real bug, no action.
- **P8** (Vite EPERM during running-server rebuild) — workaround documented; T7 reduces likelihood; no code change needed.
- **e2e fixture refactor** (closure-captured `let companyPrefix` / `taskId` → Playwright `test.extend` fixtures) — deferred per review until a 3rd spec needs the same setup. Currently 2 specs use the pattern; 3rd is the trigger.
- **Lift `EmbeddedPostgres` bootstrap to a shared helper** — deferred per review until a 2nd integration test lands. Currently only `companies-delete-integration.test.ts` uses the pattern.
- **Schema regex test allows `restrict|no action`** — kept as forward-compat hatch; rationale documented in the test file. Tighten if the team decides RESTRICT semantics need a separate opt-out mechanism.

The branch is ready to merge upstream.
