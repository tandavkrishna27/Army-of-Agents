# Universe standalone-shell correction - 2026-09-19

## Approved correction

The user rejected the first real-data screenshot because it mounted Universe
inside the board layout. That screenshot proved the persistence connection but
contradicted the agreed dedicated workspace. Passing those behavioral tests did
not establish visual acceptance.

Universe is entered from either Commander or the Universe icon on a lobby company
card. Both open the same company-scoped standalone route, outside the sidebar
layout and inside the existing access gate. Commander entry preserves the active
conversation. The route resolves accessible company membership before rendering;
unknown/revoked companies do not fall back to a different company.

## Implementation

- `UniverseRoute` owns company selection synchronization and the Commander state
  provider without rendering board navigation.
- `Universe` composes the existing centered AoA icon tray, persisted canvas, blob
  and compact Commander chat. Task and conversation libraries live in tray menus;
  the temporary selector rows are removed. Open panels uses the existing overview.
- `UniverseCommanderChat` adapts the canonical `AgentPanelContent` rather than
  copying send logic or displaying a demo composer. Compact/expanded/maximized/
  tucked views retain the same mounted composer. Existing Commander behavior is
  unchanged unless the explicit Universe presentation prop is supplied.
- Layout recovery remains available; ordinary save status is unobtrusive and the
  keyboard recovery controls remain reachable. Panel persistence and canonical
  task replies remain the existing implementation.
- The lobby icon is a sibling button, not an interactive element nested inside
  the existing company-card button. Its action does not open the ordinary home.

## Verification record

The previous engineering-selector test was demonstrated failing for the agreed
floating tray. The new focused shell/route/card/adapter checks pass; exact final
repository and browser results are appended after completion.

The first real browser run through the corrected shell passed the full existing
lifecycle, two-tab conflict/rebase, committed response loss and logout journey,
plus entry from both Commander and the lobby. Screenshot inspection confirmed no
application sidebar and the centered tray/blob/compact-chat composition. A final
browser run adds actual Commander draft continuity across presentation changes.

## Limits and next boundary

This correction repairs the surrounding UI and entry flow. It does not declare
the entire approved mock implemented: voice remains unavailable until its owning
integration is ready, and artifact/browser/attention/settings capabilities retain
their planned scope. Full E1.2 connected acceptance and product UAT remain tracked
in the acceptance audit. The user will review the corrected visual before the next
implementation increment; automated checks are not product acceptance.

### Final shell evidence

The final authenticated browser journey passed (34.9 seconds for the test, 46.3
seconds total). It covers both entry points, absence of board navigation,
Commander draft continuity through expanded/compact/tucked views, and the real
HTTP/Postgres task lifecycle, reload, conflict/rebase, response-loss and logout
checks. No uncaught page errors were reported. Voice/provider execution was not
part of this browser test.

The arrival and task-panel screenshots were inspected against the saved approved
HTML reference. The warm AoA red palette and layered breathing blob were restored;
the generic interim blob screenshot is superseded. This is still subject to the
user's visual acceptance.

A final regression test demonstrated that refreshing/reordering the recent
conversation list could change the active workspace. The initial conversation is
now pinned in the route. The test failed before the fix and all nine Universe
page tests passed afterward. Switching conversations remains an explicit action.

The final browser/container source comparison checked 6,549 normalized source
files with zero differences. An earlier whole-repository run was deliberately
interrupted to include this last fix; it is not counted as a passing run.
Evidence is retained locally in `.tmp/universe-shell-browser-qualified.log`,
`.tmp/universe-shell-browser-report.json`, the corrected arrival/task screenshots,
and the conversation-stability red/green logs. Repository qualification results
follow below when the replacement run completes.

### Repository qualification completed

The replacement run completed successfully: recursive typecheck, repository tests
and full build all exited zero. Tests: **24,882 passed, zero failed, 76 skipped**;
2,649 passing test files and ten skipped files; 700.67 seconds. Full log:
`.tmp/universe-shell-qualified.log`. The final browser test also exited zero.
`git diff --check` passed. These results qualify this bounded correction, not all
Universe release requirements. No production deployment, remote push or change to
the ongoing replatform checkout is included.
