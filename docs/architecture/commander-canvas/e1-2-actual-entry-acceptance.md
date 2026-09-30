# E1.2 actual-entry acceptance extension — 2026-09-20

Status: verification in progress; this is not whole-slice acceptance.

## Scope

The user accepted the overall standalone shell and authorized the remaining E1.2
checks. This increment exercises the real authenticated company route, canonical
HTTP APIs and disposable PostgreSQL. It does not change the main/replatform
checkout, deployment, provider configuration or user data.

## Coverage added

`tests/universe-production/acceptance.spec.ts` adds a second real-entry journey:

- keyboard move and resize, pointer header drag, maximize/reload/restore;
- denied session-storage write with no server revision advance, followed by an
  explicit retry that saves the retained edit;
- malformed tab recovery, export before explicit discard, with the saved server
  document and revision unchanged;
- restored desktop panel on a 390px viewport, reduced-motion preference and
  keyboard focus through panel controls;
- SPA company switching through the real lobby, no previous-company panel,
  and rejection of a cross-company conversation parameter;
- replacement authenticated account, conversation/layout ownership denial and
  clearing the previous session's tab recovery record;
- canonical task deletion followed by an unavailable layout with no stale task
  title/content rendered.

The original production-entry journey continues to cover two-tab conflict/rebase,
receipt-led lost-response recovery, task comments, panel lifecycle and logout.

## Defect found and corrected

The first added journey failed: a saved 530px-wide panel rendered at 530px on a
390px viewport. New openings fitted the viewport, but `displayRect` returned the
preferred geometry unchanged for every non-maximized restored panel.

Restored panels now receive a display-only fit using the saved camera scale.
The registry and persistence snapshot retain preferred geometry. Current pan/zoom
still transforms that display normally; widening the viewport restores the
preferred size. Explicit resizing replaces the preferred dimensions rather than
persisting a measurement merely because the viewport changed. Normal new panels
and maximized projection retain their existing behavior. A focused unit check
covers unchanged preferred geometry, widening, and subsequent camera transforms.

## Evidence and caveats

- Initial failing browser log: `.tmp/universe-acceptance-first.log`.
- Focused geometry unit check: 51 passed, `.tmp/universe-narrow-unit.log`.
- Recovery/geometry/company journey passed in the intermediate run (30.5s test,
  40.7s total): `.tmp/universe-acceptance-third.log`.
- The second attempt was interrupted after test setup created a second company
  after the page's company list had loaded. Setup now creates both companies
  before navigation; it does not bypass or mock the company's authorization.
- The first extended owner/revocation run passed the owner checks but the last
  assertion used five seconds while the existing layout read retry cycle takes
  longer. The final assertion allows fifteen seconds; no failure is converted
  into a synthetic success. The retained log is
  `.tmp/universe-acceptance-final-browser.log`.
- The replacement full browser and repository qualification results are recorded
  below after completion. Runtime source comparison checks the actual files.

## Remaining boundaries

This does not establish continuous background revocation without an authorized
refresh, all membership-role combinations, the full multi-zoom/multi-screen reader
matrix, screen-reader UAT, renderer-specific checkpoint consumers, or feature
rollback/disable behavior. Source deletion currently makes that saved layout
unavailable rather than silently discarding its reference; restoring/recovering
that layout is a separate UX gap to resolve. Formal user acceptance is not
inferred from automated tests or the user's acceptance of the shell screenshot.

## Browser qualification

The complete authenticated browser suite passed both journeys (2.3 minutes total),
including the owner/revocation checks after correcting the assertion's wait for
read retries. A final targeted run then added and passed actual pointer-corner
resize and a computed-style assertion that reduced motion disables blob animation
(1.3 minutes test, 1.7 minutes total). No production code changed between those
runs. Logs: `.tmp/universe-acceptance-browser-qualified.log` and
`.tmp/universe-acceptance-pointer-motion.log`; JSON reports and the inspected
narrow-screen screenshot are retained beside them. The final source manifest
matches 6,550 normalized source files with zero differences.

## Final repository qualification

Recursive typecheck, repository tests and full build all passed with final exit
zero. Tests: **24,883 passed, zero failed, 76 skipped** across 2,649 passing files
and ten skipped files (750.96 seconds). Full log:
`.tmp/universe-acceptance-qualification.log`. `git diff --check` passed. Only the
isolated Universe worktree changed; no remote push or deployment is included.
The earlier failure and interrupted diagnostic remain recorded above rather than
being reported as passing runs.

Next technical priority is explicit recovery when a saved panel's source has been
deleted, followed by the remaining real-host interaction matrix and hands-on UAT.
Renderer checkpoints remain joined to their owning later slices. This increment
is verified; E1.2 as a whole is still not accepted.
