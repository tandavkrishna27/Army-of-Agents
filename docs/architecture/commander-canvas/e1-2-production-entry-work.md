# E1.2 production-entry acceptance work

> The initial board-layout screenshot below was rejected as a visual implementation. The [standalone-shell correction](universe-shell-correction.md) supersedes its surrounding UI; the persistence evidence remains technical evidence only.

Continuation of the approved E1.2/E2.4 integration plan after qualified base adoption.
This work supplies the consuming entry needed to prove persistence. It does not
mark all E2.4 routes, artifact renderers or V1 accepted.

1. Extract the existing WorkspaceTimeline mount into TaskConversationContent.
   TaskDetail keeps its existing header and behavior; Universe owns its own frame.
   Reuse canonical reply/question APIs and composer rather than copy them.
2. Add TaskConversationPanel with an authenticated-owner and selected-company
   authorization gate before mounting any task content. Denied, revoked and late
   cross-scope results must not reveal cached content. Test these boundaries.
3. Mount the persisted workspace through the company-scoped Universe route,
   using canonical conversations and task references. No fixture IDs or simulated
   transport in that route; no provider execution merely from opening a panel.
4. Exercise persistence through that route with the real server/database, then
   run applicable integrated checks and present the journey for product acceptance.

The main mock remains the design baseline. New entry code must preserve existing
Commander/TaskDetail behavior and the single panel controller. Actual entry and
product acceptance remain open until their evidence exists.

## Implemented boundary and qualification

- `/universe` is a company-scoped, authenticated consuming route. It retains
  existing Commander navigation and behavior. The initial task/conversation
  selectors are a bounded integration surface, not the final tray design or
  acceptance of the complete E1.0 shell.
- Conversation options are restricted to the canonical owner. Task options use
  canonical company task APIs. Failed authorization refreshes hide cached options.
- TaskDetail and Universe share WorkspaceTimeline content and its canonical
  composer. Deactivation/minimize preserves mounted composer state; the host owns
  lifecycle controls. Session/company changes still unmount private content.
- Restored references resolve through the task authorization boundary. A read-only
  registry observation includes hydration without becoming a persistence write.
- Review found and corrected deactivation data loss, a noncanonical task-list
  invalidation key and retained titles after denied list refresh. Each correction
  has a regression test demonstrated failing before its fix. A further review identified transient-read composer loss; the correction is recorded below.
- Focused baseline: 206 tests passed before the last two revocation regressions;
  both additional regressions then passed in the five-test route suite. UI
  typecheck passed. Repository-wide checks are being recorded separately.
- Real authenticated browser lifecycle and recovery passed (47.0s test, 69.2s complete run):
  open, pin, two-tab same-property conflict/explicit saved choice, reload,
  minimize/restore with retained draft, exactly one canonical task comment,
  maximize/restore and close/reload; lost PATCH response followed by receipt-led
  reload with unchanged committed revision; independent pin edits to different
  panels from two tabs; logout followed by API 401 and no mounted workspace.
  Log: `.tmp/e12-production-browser-recovery-final.log`.
  The earlier extended attempt hit a covered background-panel control; the test
  now foregrounds it through Open panels before acting. No force-click bypass.
  Source comparison covered 6,541 files with no differences between this worktree
  and the isolated runtime tree (normalized LF for textual files).

The test configuration uses the existing guarded test-support session mint on a
private loopback server, with a fresh database/home. OAuth provider placeholders
only permit test startup; no Google login or provider execution is claimed.
The earlier email/password harness assumption was obsolete and was not restored
in production. Browser-only system dependencies live in task-owned containers.

Whole-slice E1.2 and all E2.4 acceptance remain open. The next evidence joins are
real-entry recovery/access transitions, renderer-specific checkpoint bindings
and formal product UAT. The qualified base is already adopted; it is not an
outstanding permission or replatform decision.

## Final recovery correction and verification (2026-09-19)

A transient background read could previously unmount the task composer or the
entire selected workspace. Transport errors and HTTP 5xx now preserve an already
authorized subtree while hiding it and offering Retry. Successful retry restores
the same subtree and pending attachment. Definitive denial, unknown errors,
reference mismatch, and owner/company changes still remove protected content.
Three regressions were demonstrated failing before the correction; the final
focused run passed 156 tests in 14 files. A separate read-only review found no
blocking defect in the correction.

The final real authenticated browser run passed: one comprehensive journey,
45.0 seconds test / 55.5 seconds total. It covers the lifecycle, canonical reply,
two-tab conflicts/rebase, committed-but-lost response recovery and logout described
above. Log: `.tmp/e12-production-browser-final.log`. The final runtime source
comparison checked 6,542 files with no differences.

The first repository-wide entry run did **not** pass: 24,849 passed, 13 failed,
76 skipped. All failures came from `patch-apply.integration.test.ts` setup after
Postgres reported an occupied IPv4 port, followed by connection refusal. Its
isolated diagnostic rerun passed all 13 tests. The original failure is retained
in `.tmp/e12-entry-full-tests.log`; the diagnostic is in
`.tmp/e12-patch-apply-diagnostic.log`. No upstream fixture was changed to hide it.
Final recursive typecheck passed. The complete rerun passed **24,865 tests,
zero failures, 76 skipped** across 2,646 passing files and ten skipped files
(706.59 seconds). The full chained build passed, with final command exit 0.
Combined log: `.tmp/e12-entry-final-verification.log`.
## Remaining acceptance work, in order

1. Extend the actual-entry journey to source revocation and live owner/company
   transitions, and storage failure/corrupt-journal recovery. Existing component
   tests are useful evidence but do not replace the actual-host journey.
2. Complete the real-entry geometry/camera and narrow-screen keyboard/motion
   checks against the saved preferred layout.
3. Join renderer checkpoint consumers in their owning E5.1/E5.2 slices; the
   checkpoint producer's passing tests do not establish consumer acceptance.
4. Run the recorded E1.2 product UAT and preserve the tester's acceptance result.
   This cannot be inferred from automated technical checks.