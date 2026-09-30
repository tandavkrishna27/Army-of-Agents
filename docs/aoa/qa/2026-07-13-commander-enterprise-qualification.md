# Commander Cockpit Enterprise Qualification

Date: 2026-07-13

## Verdict

The Commander cockpit branch is ready for user acceptance in its isolated worktree. The implemented information architecture, focus-pane behavior, durable Ask Human lifecycle, elapsed-time SLA controls, bounded run permissions, and runtime accounting have passed focused contracts, authenticated browser E2E, the full repository suite, and a production build.

This is branch qualification, not formal release qualification. The broader Wave F matrix (`R01-R14` and `Q1-Q5`) has not been executed because this branch does not yet contain a live runner for that named matrix.

## Qualified Environment

- Branch: `codex/commander-cockpit`
- Worktree: `.worktrees/commander-cockpit`
- User-acceptance URL: `http://127.0.0.1:3204/REA/commander`
- Live company: `Real Lifecycle Product Lab` (`REA`)
- Live application mode: `local_trusted/private`
- Changes remain uncommitted in the isolated branch worktree.

## Qualified Product Behavior

- Commander stays the stable shell. Opening a cockpit item does not navigate away from `/REA/commander`.
- Discussions open their native thread experience in the central focus pane, including thread navigation and the discussion's nested viewer behavior.
- Tasks in My Work and Awaiting Review open the central Task Workspace focus pane. They do not open the legacy task slide-over.
- The cockpit remains independently collapsible and resizable while the central focus pane owns the active work context.
- Structured Ask Human questions share one server-side identity across Commander triage, Inbox, task/workspace timeline, execution workspace thread, and source Discussion when applicable. An answer updates the shared object and dispatches at most one continuation.
- Task-bound org agents and Crew agents may Ask Human. Un-tasked background conversations cannot create blocking work questions.
- Questions default to a visible 24 elapsed-hour company SLA, with a project override in Settings. Business calendars remain deferred.
- Late answers automatically start a continuation. Task completion, cancellation, deletion, or reassignment cancels pending and processing continuations and terminates tracked provider processes.
- `Allow equivalent actions for this run` is limited to filesystem actions inside the current Workspace, exact run, and matching action class. It never grants shell, network, secret, or out-of-Workspace access and is revoked at run termination.
- Runtime detail separates active execution, human-question wait, runtime-permission wait, and total wall time.

## Real Lifecycle Evidence

The REA company was created through product APIs with a real project, source Discussion, multiple humans, and real Claude/Codex agent adapters.

- `REA-10` completed the durable Ask Human lifecycle: task-bound agent question, shared attention item, human answer, and continuation.
- `REA-11` exercised a real Codex task run and runtime permission flow. A one-time shell permission did not become reusable. A filesystem `Allow equivalent actions for this run` grant authorized only the matching in-Workspace class; a later shell action prompted separately. The task reached `in_review`.
- `REA-11` accounting displayed approximately 1m 15s active execution, 6m 46s permission wait, and 8m total wall time in the Task Workspace focus pane.
- Manual browser QA confirmed Discussion and Task focus panes, unchanged Commander URL, Settings SLA controls, cockpit resizing, and a clean Commander console after reload.

## Automated Evidence

Targeted campaign `commander-enterprise-20260713-targeted-r3`:

- 5/5 manifest entries PASS.
- Shared, UI, and DB typechecks PASS.
- 66 focused contract/unit tests PASS.

Authenticated campaign `commander-enterprise-20260713-authenticated-r2`:

- 7/7 manifest entries PASS (`A01-A07`).
- Founder, team-lead, and member visibility boundaries PASS.
- Cross-company isolation and synchronized viewer state PASS.
- Discussion central focus and task workspace focus-without-slide-over PASS.
- Each scenario used a fresh authenticated/private deployment and unique embedded-Postgres port.

Repository qualification:

- `pnpm -r typecheck`: PASS.
- `pnpm test:run`: PASS, 1,413 files and 11,991 tests; 46 files and 257 tests skipped by existing environment gates.
- Real-Postgres work-question integration: PASS, 13/13.
- `pnpm build`: PASS.
- `git diff --check`: PASS.

## Independent Review

The completed independent review found four valid issues. All were fixed and covered by regressions:

1. Processing Crew continuations survived terminal task transitions. Task lifecycle cleanup now cancels the internal run, wakeup lease, continuation request, and tracked provider process.
2. The standalone question viewer stopped polling at `dispatched`. It now polls until the continuation reaches a terminal state, exposing completion or retry.
3. An SLA version increment cleared an answer being typed. Draft reset is now tied to question identity, not every server revision.
4. A run-scoped permission inherited the five-minute prompt deadline. Its lifetime is now the owning run, with existing terminal cleanup performing audited revocation.

The same pass also exposed an untyped `timestamptz` comparison in the hub upsert predicate. The value now uses the Postgres ISO wire form; all 13 real-Postgres work-question tests pass. A second independent CLI review could not start because the local Codex review quota was exhausted; no claim is made that it completed.

## Residual Risk

- The formal `R01-R14` and `Q1-Q5` release matrix still needs a dedicated executable live-run campaign before release sign-off.
- The build retains existing large-chunk warnings, and the test suite retains existing React `act`, dialog-description, and markup warnings. They did not fail qualification and are not introduced by the Commander lifecycle fixes.
- The branch must still be intentionally committed, pushed, and reviewed before integration.
