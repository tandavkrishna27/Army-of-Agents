# E1.2 acceptance audit - 2026-09-19

Status: incomplete. This audit preserves the full slice scope; it does not convert
fixture evidence or deferred consuming joins into acceptance.

## Authoritative inputs

- `slice-plans/e1-2.md`: both increments, connected acceptance, UAT and recovery.
- `coding-plans/e1-2.md`: transaction, checkpoint, ordinal and client requirements.
- `execution-sequence.md`: B03/B04 producers and B10/B15/B16/B20 consuming joins.
- Qualified/adopted base at `7bcf81596`; production-entry work continues from `749bd82be`.
- Isolated combined candidate and exact source hashes: `evidence/reconciliation-2026-09-19/combined-candidate-checks.json`.

## Requirement-to-evidence map

Paths below are repository-relative. Passing counts are recorded runs, not a claim
that every requirement is covered by a single test or that the production UI exists.

| Requirement | Current evidence | Remaining acceptance |
|---|---|---|
| Owner/company/conversation authorization; no UUID-only receipt authorization | `universe-layout-ownership.test.ts`, `universe-layout-references.test.ts`, route tests and PostgreSQL ownership/revocation cases | Repeat through actual UI entry and its session |
| Strict bounded operations, schema and finite geometry | Shared validator and server reducer tests; route malformed-body rejection | Real-entry failure presentation |
| Atomic layout CAS, replayed complete receipt, changed-payload rejection | PostgreSQL integration concurrent first write, receipt replay and incarnation cases | Final adopted-source qualification |
| Transactional audit rollback without partial document or receipt | Real PostgreSQL injected audit failure and invalid final presentation cases | No additional producer gap identified in inspected evidence |
| Stable server ordinals, retry allocation, close/reopen and exhaustion | Real PostgreSQL ordinal retry/receipt/exhaustion; client generation reconciliation | Actual-entry lifecycle journey |
| Full viewport/order/selected/maximized snapshot, preserved restore rectangles | PostgreSQL coupled-presentation case; reducer/adapter and browser fixture tests | Production maximize/reload/restore journey |
| Owner/version checkpoint CAS and retention on panel close | Real PostgreSQL first-write race, version isolation, foreign reference and close-retention cases | Registered renderer consumers in E5.1/E5.2 |
| Checkpoint payload schema, exact 32KiB and failed audit rollback | Real PostgreSQL boundary/validation/first-write and update rollback; PATCH route tests | Renderer-specific restore/revocation and lost-ack consumer behavior |
| Generated migration and final source compatibility | Candidate fresh and upstream-0282 upgrade proofs, repeat no-op, Drizzle no drift | Qualified generated lineage adopted at 7bcf81596; base gate cleared |
| Layout/receipt/checkpoint deletion cascade | Extended real PostgreSQL company removal test seeds a checkpoint, proves it exists, removes through companyService, then proves all three stores empty; 18/18 suite passed | Included in final passing combined qualification |
| Write-ahead bounded tab journal and safe overflow | `layout-journal.test.ts`, `useUniverseState.test.tsx`, connected workspace storage-failure tests | Actual-entry reload/storage-failure experience |
| Receipt-first uncertainty reconciliation, no speculative replay | Hook tests and fixture; real PATCH response dropped after commit, reload recovered without revision increase | Remaining renderer-specific uncertainty paths |
| Independent property rebase; explicit same-property conflict | Reducer/hook fixtures and real two-tab different-panel pin edits; same-property conflict retained until explicit saved choice | Wider real-entry geometry/camera and UAT matrix |
| Owner switch/logout cancellation and recovery clearing | Isolation/hook tests; real sign-out returned 401 for layout and unmounted the workspace after reload | Live account-switch and source-revocation UI matrix |
| Hydrate without PATCH, preserve in-progress gesture, content and Undo | `PersistedUniverseWorkspace.test.tsx`, browser fixture saved-drag journey | Actual page entry |
| Smaller-screen/reduced-motion/keyboard behavior | Browser fixture narrow-screen journey | UAT in target host |
| Production mounting | Company-scoped `/universe` route mounts `PersistedUniverseWorkspace`; task content reuses `WorkspaceTimeline` through an owner/company authorization boundary | Bounded consuming entry exists; complete E1.0 shell rollout and other E2.4 launch paths remain separate |
| Full repository verification | Adopted candidate: 24,847 pass/0 fail/76 skip with typecheck/build. Current entry: 24,865 pass/0 fail/76 skip with recursive typecheck and build pass; see production-entry work record for the retained port-collision diagnostic | Base qualification does not substitute for verification of the entry increment |
| Product acceptance and rollback | Formal UAT register remains authoritative; feature rollback preserves data by contract | Tester acceptance and actual consuming disable/recovery proof remain required |

## Decision and next work

The user approved conditional upstream adoption for exact revision `75350f1`.
Qualification passed and adoption completed at `7bcf81596`. No live replatform
work was changed. The earlier conditional decision and failed runs remain in the
takeover record; they are not current blockers.

Continue the mapped E1.0 consuming entry and E2.4 shared-content boundary as
recorded in `e1-2-production-entry-work.md`. This is not a separate task backend
or a substitute for the full planned shell. Whole E1.2 remains open until its
connected acceptance and UAT joins are proved.

## Connected-entry dependency revalidation

`TaskConversationPanel.tsx` and `TaskConversationContent.tsx` now exist and the
company route consumes them. The real-entry browser test is isolated under
`tests/universe-production/` instead of the generic fixture-only canvas suite.
It uses real Better Auth sessions, canonical APIs and disposable PostgreSQL;
it does not qualify Google OAuth, provider execution, all task launch paths,
or product acceptance. See the production-entry work record for current runs.

Remaining joins include renderer-specific checkpoint consumers, the complete
real-entry recovery/accessibility matrix and the formal UAT register. The
existing harness remains sample-content evidence, not the production route.

## 2026-09-20 actual-entry extension

The dedicated shell was accepted at the overall-layout level. Further actual-entry
checks and the restored-panel narrow-screen correction are recorded in
[e1-2-actual-entry-acceptance.md](e1-2-actual-entry-acceptance.md). That record
supersedes the older fixture-only status only for the scenarios it explicitly
verifies. Whole E1.2 remains open: renderer checkpoint consumers, remaining host
matrix/rollback evidence and formal interactive UAT are not implied by these runs.
