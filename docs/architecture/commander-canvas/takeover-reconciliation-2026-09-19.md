# Universe takeover reconciliation — 2026-09-19

## Evidence and boundary

Reviewed source: `a996d507bb54fa9d4623ffd6ca9a9c95d321d550`, on
`codex/universe-interface`. The branch was clean and matched its remote before
this correction. Work is limited to `.worktrees/universe-interface`.
No other checkout, database, upstream branch, or running application was changed.

This is a source-based reconciliation, not full V1 qualification. Earlier
qualification of the Canvas batch does not qualify the later persistence and
Commander commits automatically.

## Confirmed correction in this working tree

`ui/src/components/universe/useUniverseDraft.ts` now reads the unsaved editor
candidate when freezing Send, preserves newer typing when acknowledging an older
submission, clears attachment-only acknowledged drafts, and prevents an older
failed save from replacing newer queued input. Attachment arrays are copied.
After that exact candidate is saved, the acknowledged query cache becomes the
source again. Automatic debounce failures are handled through the existing save
status; explicit flush callers still receive failures.

Four new regression tests failed on the original hook for these respective
behaviors. A fifth regression caught stale local input masking a later server
refresh during self-review; the candidate now retires only when its own save
succeeds. These corrections do not implement the full pending-attempt protocol.

## Source-backed gaps found at takeover (progress updates below)

1. **Migration reconciliation.** Universe has `0281_wooden_captain_marvel`
   (layout/operations) and `0282_past_roland_deschain` (drafts). The inspected
   replatform head `408555f2316537b5475290175657213ec975085e` has
   `0281_provider_credential_broker` and
   `0282_internal_agent_runs_distributed_marker`, with different journal entries
   and snapshots. Universe still contains qualified base
   `b48132dac0f3435e017915e1e21ef1d66a39d0cd`. Do not simply merge the journals or
   renumber potentially applied migrations. First establish whether Universe has
   any database whose data must be preserved, then prepare and test the combined
   migration lineage in an isolated disposable database. No base adoption here.
2. **Layout contract.** `packages/shared/src/validators/universe-layout.ts` and
   `server/src/services/universe-layout.ts` lack the planned presentation operation
   and complete open-operation ordinal receipts. Checkpoint storage/routes are
   absent. Reconcile against `coding-plans/e1-2.md` before wiring persistence into
   the frame.
3. **Ownership and auditing.** Current layout/draft routes enforce authenticated
   board-user and company access. The inspected services do not implement the
   planned canonical conversation/reference/destination authorization and
   transactional activity logging. Personal row scoping is not a substitute for
   those checks; this finding is not a claim of a demonstrated cross-company leak.
4. **Recovery.** Both hooks still need serialized writes, scope-generation fencing,
   explicit conflict resolution and preservation of local candidates. Layout
   retries currently generate a new operation ID and do not query receipts first.
   Draft submission still lacks destination-bound durable pending-attempt metadata
   and full structured payloads for question, runtime-decision and approval drafts.
   The targeted fixes above must not be described as completing E1.3.
5. **Integration and UX.** Source search finds the persistence hooks defined but
   not consumed by the assembled workspace. Tray/Commander are harness surfaces.
   Real composer wiring, preferences, expanded-chat movement/resizing, overview
   pagination and the planned preview rails remain subject to their slice gates.

## Next execution order

- Preserve the current UI work and qualify this small draft correction.
- Resolve migration history with explicit knowledge of data to preserve; do not
  touch other worktrees or adopt upstream changes implicitly.
- Complete the layout/draft contract and recovery work with failing regression
  cases first, then wire the workspace using the authenticated owner context.
- Run the integrated journeys and the full repository qualification on that exact
  combined revision. Update aggregate completion claims only after that evidence.

## Verification scope

Fresh pre-correction focused UI run: 132 tests / 12 files passed.
After the initial four corrections: 136 tests / 12 files passed.
After the self-review correction: all 10 draft-hook tests passed.
Final focused run: **137 tests / 12 files passed**. Repository-wide
`pnpm -r typecheck` passed. UI typecheck and UI production
build passed. Vite reported large-chunk and mixed-import warnings; these were not
modified as part of this bounded correction. `git diff --check` passed.
No repository-wide test or build qualification is claimed: those need the owned,
isolated test environment and the reconciled base; no existing database/container
was used for this takeover.

## Migration follow-up — user confirmed no data to preserve

The user confirmed that no Universe database data needs to be retained. This
allows replacement of the unpublished Universe migration sequence when adopting
an agreed combined base; it does not require deleting any existing database.

A candidate was generated locally in the ignored, isolated directory
`.tmp/universe-migration-reconciliation/`:

- Upstream pinned and remotely confirmed at
  `408555f2316537b5475290175657213ec975085e`.
- Upstream migration history was exported byte-for-byte with `git archive`.
- Target schema used Universe's compiled schema, with `internal_agent.ts` taken
  exactly from that upstream revision and transpiled with TypeScript. The only
  upstream schema-source delta since the adopted base is the three distributed
  execution marker columns in that file. No tracked schema file was replaced.
- Drizzle generated `0283_universe_persistence.sql`, consolidating the two
  unpublished Universe migrations after upstream 0282. It creates only
  `universe_drafts`, `universe_layouts`, and `universe_layout_operations`, plus
  their indexes and foreign keys. No SQL was hand-authored.
- Snapshot comparison found changes only to those three table entries; all other
  schema objects match upstream 0282. The candidate snapshot links to upstream
  0282, and its journal timestamp is greater than upstream's final timestamp.
- Re-running Drizzle reported **No schema changes, nothing to migrate**.
- Generated SQL SHA-256:
  `8dbe5d06f8999080e16eee0d51c94718ef098bc32b0ca3517af02fadcd82680a`.

**Not applied or adopted.** Docker's Linux-engine named pipe is absent:
`dockerDesktopLinuxEngine`. Thus no fresh database migration run or combined-base
qualification was possible. No existing database was accessed, reset or deleted;
Docker and other applications were not started or stopped. The tracked migration
chain remains unchanged until the candidate and combined application are tested.

Next: with Docker available, create a uniquely owned disposable environment,
verify fresh migration and migration from the pinned upstream schema, then qualify
the combined application before adopting the new base/migration history. The
candidate is local scratch material, not a shipped migration or proof of runtime
readiness. The remaining persistence-contract and recovery gaps above still apply.

## Docker-enabled verification and persistence corrections

Docker became available after the user's follow-up. Task-owned containers only:
`universe-reconcile-20260919-1513` (pgvector PostgreSQL 18) and
`universe-migrate-runner-20260919-1515` (pinned Node image). The database had no
network access; the Node runner shared only that container's network namespace.
No host port, host database, existing volume or other worktree was mounted.
Both task-owned containers were stopped after verification; Docker itself and
other containers were left alone.

Migration checks passed:

- Execute the generated chain against an empty database.
- Execute upstream through 0282, then the generated Universe 0283.
- Repeat both paths using the installed Drizzle migrator, with **284 migration
  receipts**, all three Universe tables and upstream's three run-marker columns.
- Re-run Drizzle: no extra migration receipts.

See [measured migration checks](evidence/reconciliation-2026-09-19/migration-checks.json)
and adjacent SQL execution logs. This qualifies the candidate DDL and Drizzle
history paths only. It does **not** qualify AoA's `applyPendingMigrations` wrapper,
serving roles, ownership routes or the full combined replatform application.
Active migration files and the adopted base are still unchanged.

Source corrections now under focused verification:

- Layout presentation operation, safe integer counters/revisions and final
  order/selection/maximize/ordinal invariants.
- Maximize/restore preserves normal geometry. Hidden/maximized geometry edits are
  rejected. Reopening the same maximized panel keeps its maximize state.
- Layout queue owns pending work by company/conversation, serializes writes,
  preserves atomic caller groups and checks receipts before replaying an unknown
  outcome with the same operation identity.
- Queued edits retain their original revision. External changes cause explicit
  conflicts rather than silent rebases. Explicit resolution waits for the old
  request to settle; accepting one remote base does not authorize rebasing older
  pending groups. Receipt-lookup failures never authorize another write.

Independent review found maximize preservation and recovery/concurrency defects;
each reported defect was reproduced in a failing test and corrected. Final narrow
review found no additional blockers in those corrections. This is bounded review,
not certification of all persistence behavior.

Still open: authenticated-user/logout isolation, bounded durable journals and
reload recovery, automatic independent-property rebase, canonical reference and
conversation authorization, transactional audit, complete ordinal acknowledgments,
checkpoints, structured draft payloads and the actual workspace integration.

A design discrepancy was also found: the old E1.1/E1.2 plan chooses the next visible
panel after close/minimize, while Claude's newer controller deliberately clears
selection. This needs reconciliation before claiming identical server/controller
semantics. Pending the user’s preference, existing null-selection behavior is
preserved in both server and controller; no next-panel selection was introduced.

Latest focused run: **166 tests / 14 files passed**. Repository-wide typecheck
passed before the final hook refinements; final UI compile/build also passed. Full repository test/build qualification remains outstanding. Nothing
has been merged, pushed, or adopted into replatform/main.


### Canonical conversation ownership increment

The layout service now checks the canonical `internal_agent_conversations` row by
company, authenticated user and conversation ID before reads, receipt lookup and
writes. Missing/foreign ownership returns 404. Malformed UUID scope identifiers
are rejected before querying UUID columns. Writes hold a shared lock on that
conversation through the transaction, before inserting a layout or replaying a
receipt. Company administrator access does not bypass personal ownership.

Five service-boundary regressions were observed failing before the correction and
passing afterward. These use mocked query execution, not a real database security
proof. The real-Postgres suite now creates canonical conversation fixtures and
expects foreign-owner/company requests to fail; it also covers revocation after a
saved layout and receipt. That suite remains unexecuted on this Windows host.

Verification: 171 focused tests in 15 files passed, and server typecheck passed.
Full repository tests/build and real-Postgres qualification remain pending. This
increment closes the missing canonical-conversation guard in source only; panel
reference authorization, canonical keys/titles, audit and complete receipts are
still open. No workspace integration or base adoption is implied.


### Panel-reference authorization increment

Task and artifact opens now resolve company-scoped canonical records. Artifact
versions must belong to that artifact. Task versions and browser references fail
closed (no authoritative browser resolver exists on this base). Open keys must
match the canonical company/user/conversation/reference tuple. Every open is
checked even if later closed in the patch, and all retained references are checked
before saving. Reads re-resolve canonical titles, bounded to 1,024 display units.
A review-found long-title failure was reproduced and corrected.

Unavailable references currently return 404 for the snapshot without deleting the
saved layout. Closing a known unavailable panel remains possible. The final UI
needs explicit unavailable-reference recovery; this is not a completed workspace
experience. Receipt replay remains an acknowledgement of the original operation,
not a fresh execution or content authorization.

A bundled copy of the actual service and its actual schema ran against the
previously migrated disposable PostgreSQL database: **14 assertions passed** for
foreign ownership, company isolation, denied-write rollback, artifact-version
parentage, title resolution/length, deletion recovery and revoked receipt access.
See evidence `reference-authorization-check.mjs` and its result JSON. External
Drizzle/Postgres libraries were the installed versions already copied to the
isolated runner. This does not replace the full Vitest integration suite, route
checks, production migration-wrapper qualification or full repository checks.
Both task-owned containers were stopped afterward; no existing application data
or unrelated work was modified. Active migrations/base remain unchanged.

Final focused suite: **181 tests / 16 files passed**. Server typecheck and diff
whitespace checks passed. Full repository tests/build were not repeated for this
bounded increment and remain required before claiming E1.2 complete.


### Transactional layout audit increment

New layout operations now call `insertActivityLog` inside the layout/receipt
transaction. Receipt replay adds no audit entry. Live publication runs only after
commit; a synchronous notification error is reported without rejecting the
committed acknowledgement. Details contain revision and operation count, not
panel content, titles or draft text. The shared audit insert helper accepts the
minimal `Pick<Db,"insert">` interface so transaction use needs no unsafe cast.

The disposable PostgreSQL diagnostic passed **18 checks**, including one audit
for an operation plus replay, and an injected audit-insert failure rolling back
layout revision and pin state. It uses the real audit insert helper with the
live-event transport stubbed; unit tests verify post-commit publication and
publication-failure handling separately. Both task containers were stopped.
See `evidence/reconciliation-2026-09-19/audit-transaction-check.mjs` and result JSON.

Complete stored acknowledgement mappings/counter and checkpoints remain open;
their schema changes must be generated and rehearsed against the reconciled
migration candidate. No new base adoption or merge is implied by this increment.


### Complete receipts and checkpoint producer

Layout acknowledgements now include `nextOpenedOrdinal` and ordered
`{operationIndex,key,openedOrdinal}` entries captured during each open operation,
including multiple incarnations of a key within one patch. The entire original
acknowledgement is stored with its receipt and returned on replay. Legacy nullable
receipts return 409 requiring reconciliation; opening history is never fabricated
from today's layout. Revision exhaustion is rejected.

Checkpoint GET/PATCH methods, routes and UI API client now bind owner/company/
conversation/canonical panel key/exact artifact version. Version-1 inert block
payloads accept only inputs, selectedRows and filters, with count and 32 KiB UTF-8
limits. A sentinel plus row lock serializes first writes; conflicts preserve the
old row. Successful writes audit in the same transaction and publish afterward.
Close never deletes checkpoints. Executable-host state schemas are not registered.
The layout transport now enforces 64 KiB patches and 256 KiB snapshots.

Drizzle generated local 0283 receipt-column and 0284 checkpoint-table migrations.
Snapshot comparison changed only `universe_layout_operations` and
`universe_panel_checkpoints`. The separate reconciliation candidate's generated
0284 applies these after the upstream-compatible Universe 0283; both fresh and
upgrade disposable database paths passed. This does not adopt that candidate or
resolve the active branch's pre-existing upstream migration-number collision.

The real-service/database diagnostic passed **27 checks**, including checkpoint
first-write concurrency, close retention, exact-version access, complete receipt
lookup, old receipt reconciliation and audit rollback. Live transport is stubbed
in that diagnostic. Repository tests contain the corresponding persistence cases;
their normal Linux harness remains required. Independent review found no concrete
backend security/protocol defect. Renderer wiring, structured draft recovery,
owner cache isolation and durable client journals remain separate unfinished work.


### Verification and transport review follow-up

Review identified two transport edge cases and regression tests reproduced both:
atomic client groups could combine into a patch over 64 KiB, and canonical source
title growth could make a saved layout exceed the 256 KiB snapshot limit. The
client now validates each atomic group and batches within the byte limit without
splitting a group. The server budgets display-title bytes across the snapshot,
including JSON escaping and UTF-8, without changing canonical source titles.
Legacy receipt 409 responses now enter explicit conflict recovery rather than an
offline retry loop.

Windows Node 24.14.0 produced widespread Drizzle ESM require-cycle collection
failures. Running the unchanged route suite with bundled Node 24.19.0 passed;
that runtime also collected the repository-wide suite successfully. Its first
full run reported 22,873 passed, 4 failed, 1,729 skipped tests. It caught a title
regression while the fix was in progress, missing C14 migration guards, missing
`playwright-core/package.json` resolution in browser-runtime, and a debrief import
exceeding its 3-second assertion. This is not a passing full-suite claim.

C14 idempotency guards were added to the Drizzle-generated Universe migrations
0281–0284, preserving their schema and snapshots. This does not resolve or adopt
the separate upstream migration-number reconciliation. Focused final checks
passed 47 tests (4 skipped), covering migration policy, layout routes, reference
authorization and client queue regressions. A fresh full test/typecheck/build run
is underway; its results supersede earlier runs only when complete. Browser and
debrief source files have not been changed to make their tests pass.

Migration guard replay also passed against the existing disposable PostgreSQL
schema using all four guarded files with `ON_ERROR_STOP=1`. The task-owned
container was stopped afterward. This validates replay against matching objects,
not recovery from schema drift or the production migration wrapper.


### Final verification for this working-tree increment

- `pnpm -r typecheck`: passed.
- `pnpm build`: passed.
- Full Vitest suite under bundled Node 24.19.0: **22,875 passed, 2 failed,
  1,729 skipped** across 2,627 files (2,408 passed, 2 failed, 217 skipped).
  Duration 324.25 seconds. No claim is made that skipped integrations passed.
- Remaining failures: browser-runtime image parity directly imports undeclared
  `playwright-core/package.json`; debrief factory import takes 3,159.77 ms against
  a 3,000 ms assertion. Both source/test areas are unchanged by this work.
  The installed declared `playwright` dependency and its nested `playwright-core`
  both resolve to 1.59.1; direct core resolution from browser-runtime fails.
  No dependency links, manifests, or lockfiles were altered to mask that failure.
- The final full run includes the corrected title-budget, atomic batching,
  legacy-receipt conflict and migration-guard regressions. Earlier failed runs
  remain historical evidence and are not represented as passing.
- Guard replay on the disposable PostgreSQL schema passed. This is distinct
  from the production migration wrapper and normal Linux integration suite.
- Independent review found no further defect in the cap fixes or migration
  guards. `git diff --check` passed.

Current boundary: changes remain in the isolated Universe working tree,
uncommitted and unmerged. Backend progress does not finish E1.2: owner/session
cache isolation, bounded durable recovery, property rebase, controller/renderer
wiring and migration/base qualification remain. The next implementation work is
client recovery, preserving the dependency order rather than advancing the slice
status based only on backend tests.


### Client recovery continuation — 2026-09-19

User approved tab-only session storage for unsaved layout operations. No chat text,
file contents or draft text is persisted by this increment. Journals are keyed by
verified user/login identity, company and conversation. They are limited to 100
pending groups/receipts per scope and 1 MiB across this tab, with a 24-hour expiry.
A tab close may remove recovery; this storage is not described as secure or a
replacement for server persistence. Confirmed logout/account change clears foreign
journals and private query cache even after leaving Universe. Temporary session
lookup failures suspend access but preserve recovery until identity is verified.

Layout writes now journal the exact operation ID before transmission. Reload
checks its receipt before retrying; unknown outcomes and conflicts retain their
payload. The cache is not displayed before a fresh authorized read. Account and
scope changes abort requests and late continuations cannot dispatch new writes.
Storage denial/corruption or queue overflow produces `blocked`, never `saved`.
Recovery export retains the pending work and rejected edit; retry can drain the
accepted queue before enqueueing that rejected edit. Invalid stored envelopes
are not silently replayed or overwritten. Consumer UI for export/reset/retry is
not yet wired, so this is hook capability, not a completed recovery experience.

Draft caches now use the same authenticated owner/login boundary. Unsaved local
candidates remain separate across destinations in memory, including temporary
auth failures. Late responses cannot populate another owner's cache. Draft text
reload persistence and structured sent-attempt recovery remain separate work.
The shared HTTP client gained optional AbortSignal support for GET/PATCH only;
existing callers keep the same request behavior.

Review reproduced and corrected four edge cases: auth errors erasing journals,
stale retry callbacks dropping rejected edits, delayed journal hydration after
auth recovery, and same-owner draft loss when switching destinations offline.
Each has a failing-then-passing regression. The independent reviewer found no
further blocker in those corrections. Full validation results follow when the
current repository run completes; earlier backend results are not reused as
proof of this client increment.


### Client recovery verification result

- Repository-wide typecheck and production build passed.
- Node 24.19.0 full Vitest run: **22,893 passed, 2 failed, 1,730 skipped**;
  files: 2,409 passed, 3 failed, 217 skipped. The third failed file was an
  app-import setup timeout, not a failing assertion. Runtime 316.38 seconds.
- All final recovery tests passed within that run: layout hook 24, draft hook 11,
  owner isolation 7, journal 5. This includes the final review regressions.
- The app-import timeout (`cloud-plugin-process-composition`) passed separately:
  **7/7**, 13.58 seconds. The concurrent full run is still recorded as failed;
  the isolated pass does not turn it into a green repository run.
- The other failures remain the unchanged browser-runtime direct transitive
  dependency resolution and debrief's 3-second import-time assertion. No source
  or thresholds in those areas were modified.
- Diff whitespace verification passed. No commit, push, merge, migration
  adoption or unrelated worktree change was performed.

Next remaining E1.2 work: property-level rebase and actual canvas recovery UI/
controller integration. Explicit invalid-journal reset/export UI and unavailable
reference/revocation handling still need that integration. E1.3 structured draft
and sent-attempt recovery remains unfinished. Full Linux integration qualification
and final reconciled migration/base approval remain separate gates; do not infer
slice or release completion from these hook tests.

## Property-level preflight rebase checkpoint

Queued unsent layout batches now capture bounded property witnesses, retained in the approved tab-only journal. Independent properties can rebase onto a fresh revision; competing properties, panel reincarnations, lifecycle operations, and legacy journals without witnesses require explicit conflict handling. Camera/maximize changes are coupled. A persisted adoption barrier prevents subsequent unchecked batches from inheriting a rebased acknowledgement. Independent review found and verified fixes for both the later-batch overwrite and camera/maximize coupling cases.

Verification: 177 Universe UI tests pass across 15 files; full repository typecheck and build pass. Full Node 24.19 test run: 22,902 passed, 2 failed, 1,729 skipped. Failures remain the unchanged browser-runtime `playwright-core/package.json` resolution test and debrief import-duration threshold (4.53 seconds against 3 seconds). Logs are `.tmp/universe-rebase-all-ui.log` and `.tmp/universe-rebase-full-{tests,typecheck,build}.log`. Windows-skipped integration tests are not treated as qualified.

E1.2 remains in progress. Receipt-missing reconciliation, recovery controls, completed-edit controller wiring and final Linux/migration/base qualification remain outstanding. The existing frame callback reports intermediate drag samples; connecting it directly to saving would be incorrect. No production route integration, merge, push, or upstream adoption is claimed by this checkpoint.

## Connected layout persistence checkpoint — 2026-09-19

This section supersedes the earlier outstanding-client-work lists above. It does
not supersede the migration/base gate or production-entry acceptance.

Implemented in the isolated working tree:
- Lost-ack recovery checks receipt, then fresh authorized snapshot, then receipt
  again before deciding whether an old request may be replayed or rebased.
- `layout-adapter.ts` translates completed controller edits into bounded atomic
  operations, including manual/automatic placement, camera and coupled
  presentation. `PersistedUniverseWorkspace.tsx` connects that adapter to the
  authenticated owner-scoped queue and generation-scoped opening receipts.
- Background refresh never replaces an active gesture or pending/conflicting
  edits. Clean refresh preserves surviving panel instances and guarded Undo.
- `UniverseLayoutRecovery.tsx` exposes comparison, explicit resolution, retry,
  export, and export-before-discard for unreadable journals. No chat/file content
  enters layout recovery. A renewed remote revision requires another review.
- Rejected arrangements are validated before mutation; storage failure blocks
  further panel/camera edits. Rejected edits retain their original rendered base,
  property witnesses and opening context across Retry. A repeated failure keeps
  the original exportable candidate. An active pan is cancelled when blocked.
- Server selected-panel fallback matches the controller; geometry updates retain
  manual placement across save/reload, and explicit Arrange can release it.

Review findings were reproduced before their fixes: saved gestures losing Undo,
renderer remount clearing local input, oversized Arrange applying without recovery,
blocked recovery accepting later uncaptured changes, mid-pan blocked state leaving
interaction active, and rejected retries losing their original comparison base.
The final narrow independent review reported no further concrete blocker.

Current measured evidence:
- Normal Linux embedded PostgreSQL integration: **13/13 pass**, using the actual
  migration runner in an isolated copy. Covers concurrent initial layout writes,
  duplicate receipts, owner/source revocation, checkpoint version isolation and
  CAS, camera/presentation, and production company removal. The two initial test
  defects (wrong receipt column and bypassing the company removal service) were
  corrected; no production deletion semantics were changed.
- Browser fixture suite: **59/59 pass**. Five persistence scenarios also pass on
  the final placement/recovery changes. Includes two tabs, same-property conflict,
  independent-property rebase, lost-ack reload, zero hydration writes, preserved
  local input/Undo, revoked content removal, narrow viewport and keyboard controls
  under reduced motion. Transport is controlled; this is not live-route approval.
- Focused final placement/Universe/shared tests: **230 pass**. Repository-wide final
  checks are recorded separately after completion; preceding broad run retained
  two known unrelated failures, not an all-green claim.

Actual implementation bindings replace earlier proposed filenames:
`universe_layouts.ts`, `validators/universe-layout.ts`,
`services/universe-layout.ts`, `routes/universe-layout.ts`,
`api/universe-layout.ts`, `useUniverseState.ts`,
`universe-layout.integration.test.ts` (including checkpoint integration).
The connected fixture is `ui/src/dev/UniversePersistenceHarness.tsx` with
`tests/universe-canvas/persistence.spec.ts`; it is DEV-only.

**Still not closed:** adoption/qualification of the combined replatform migration
lineage; real authorized entry-point acceptance owned by the later route packages;
renderer checkpoint consumers in E5.1/E5.2; formal product acceptance. These are
explicit gates, not permission to represent this fixture as a shipped experience.
No main/replatform checkout was edited and no merge or base adoption was performed.

### Replatform checkpoint after connected verification

Read-only remote inspection on 2026-09-19 found `docs/replatform-program` at
`75350f1f634aec9b679d715aeefeb45287aa36e7`, ahead of the separately rehearsed
`408555f2316537b5475290175657213ec975085e`. That interval changes 31 files
(+1308/-65); migration/schema files are unchanged, but database-client RLS checks
and job fencing changed. Fetch used `--no-write-fetch-head` and did not advance
any branch or working tree. The active Universe branch remains at its existing
base. Qualifying that combined application is still required before adoption.

The final synchronous review additionally verified live queue admission: successive
commands in the same React turn cannot bypass a storage failure through stale
rendered props. Final Universe UI regressions:207/207. These include the rejected
retry witnesses, repeated quota failure, mid-pan cancellation and same-turn guard.

### Final verification record

Repository typecheck and build pass; the final UI guard delta also passes its own
UI build. Full Node24.19 Vitest: **22,933 passed, 2 failed, 1,731 skipped** across
2,413 passing files,2 failing files and217 skipped files (317.22 seconds).
Failures are unchanged `image-playwright-parity` direct transitive dependency
resolution and `debrief-redirect` import timing (5.16s versus3s). They were not
masked with dependency links or changed thresholds. The final guard delta has
207 passing Universe UI tests and5 passing browser persistence cases.

[Machine-readable evidence and source hashes](evidence/reconciliation-2026-09-19/connected-layout-checks.json)
records the exact uncommitted source scope. Logs remain in `.tmp/universe-e12-*`.
The three task-owned test containers were stopped. No other worktree, application
container or upstream branch was modified. E1.2 remains open at the explicit
migration/base, production-entry and acceptance gates described above.


## Additional E1.2 qualification — combined replatform candidate

The active Universe checkout remains at its adopted base. A separate detached
qualification checkout combines Universe `a996d507` and replatform `75350f1`, plus
the current uncommitted Universe implementation. The only merge conflicts were
migration metadata. The candidate preserves upstream 0281/0282 and follows them
with the Drizzle-generated combined Universe 0283/0284; C14 idempotency guards
are applied without changing the generated schema. Source review found no concrete
blocker and Drizzle generation reports no schema drift.

- Current-source PostgreSQL integration: **18 passed**, now including audit-failure
  rollback, source/version authorization, exact 32KiB checkpoint boundary,
  concurrent-open ordinal retry, ordinal exhaustion and atomic presentation rejection.
- Checkpoint/layout route boundary: **10 passed**.
- Combined candidate: build and recursive typecheck passed; **28 focused tests passed**.
- Fresh and upstream-through-0282 migration runs both reached **285 journal entries**
  and all four Universe tables. A second migration call applied nothing extra.
- Full combined Linux suite has completed; see final results below. Copied-source Git-index and executable
  mode omissions caused initial source-audit/CLI fixture failures; their focused
  reruns passed after fixing the qualification environment, with no product edit.

This is qualification evidence, **not base adoption or whole-slice acceptance**.
Actual production-entry/UAT joins remain tracked under their owning packages.
Machine evidence: [combined-candidate-checks.json](evidence/reconciliation-2026-09-19/combined-candidate-checks.json).

## Final qualification results

Second full Linux run: **24,842 passed, 1 failed, 76 skipped** (675.64s).
The sole failure occurred before the security assertion: PostgreSQL reported IPv4
port 58592 already in use, then the fixture received ECONNREFUSED. Its port probe
is released before initialization, leaving a binding race; the colliding process
is unidentified. No assertion or shared helper was changed. The unchanged full
security manifest suite subsequently passed **19/19** (79.07s). This is not an
all-green full run. Build, typecheck, 28 focused tests and migration proofs passed.
Base adoption and production-entry/UAT acceptance remain outstanding.

## Adopted qualified base — latest result

The user-approved replatform revision `75350f1f634aec9b679d715aeefeb45287aa36e7`
is now adopted locally by merge `7bcf81596ebf59c30dbb417aca411e84b6925de2`.
The prior Universe work is preserved in checkpoint `dd60d42b7` and its history.
The active source matches all 6,759 normalized candidate application/configuration
files, with no extra source files. The migration conflicts were exactly the three
rehearsed metadata conflicts; generated Universe 0283/0284 follow upstream 0281/0282.

Final combined qualification: **24,847 passed, zero failed, 76 skipped**, 2,643
passing test files and ten skipped files, 700.05 seconds. Recursive typecheck and
full build passed. Frozen dependency installation on the adopted Windows checkout
passed. All **five persistence browser fixture journeys passed again** there.
Earlier failed runs above remain historical evidence, not the current result.
Fresh/upgrade/repeated migration proofs remain applicable: migration bytes did not
change after those proofs. A real occupied-port regression and bounded unit tests
verify the fixture repair; the source review found no blocker.

This clears the base qualification/adoption gate, not whole E1.2 acceptance.
Production-entry integration and user acceptance remain outstanding; controlled
browser transport is not a substitute. The remote replatform branch advanced to
`77f4bf9` during qualification; it was deliberately not adopted or modified.
These commits are local; no deployment or remote push occurred in this step.
