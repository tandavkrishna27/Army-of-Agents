# Commander Canvas — code evidence and implementation dependencies

**Historical evidence note (independent review):** source revisions below identify the investigation when recorded. The current reviewed source pin is `183e46a9c65fc3105c7e3d125629276814df7dbb`; use symbols plus that base for implementation binding, and refresh changed files before coding. Historical checks are not new qualification runs. See [current bindings](implementation-bindings.md) and [review response](independent-review-response.md).

Checked September 10, 2026. Companion to [master scope](master-scope.md). This is a bounded source/reachability review plus the targeted test runs below, not a complete security audit or production certification.

## Revision and branch evidence

| Reference | Inspected value | Meaning |
|---|---|---|
| Local main/workspace | `06320643a` | Documentation changes in this task occur here; existing runtime tests below use this checkout |
| Remote main | `e097d2f9332a2715bdbaf2058a4b751481107713` | Read from origin and fetched |
| Remote replatform | `053f90fc8991b32b8fb291ef29ada7e81081deb2` | `origin/docs/replatform-program`; latest remote tip at inspection |
| Local replatform worktree | `C:/e3`, `088de1084` | Older than remote; no tracked changes at inspection; used only for the specifically labelled broker test |

Initial shallow-history merge-base failure was a limitation, not evidence of unrelated histories. Fetching/deepening the two relevant branches resolved it: `git merge-base origin/main origin/docs/replatform-program` returns remote main; `--is-ancestor` succeeds; left/right count is `0 1124`. The old replatform worktree is also an ancestor of the remote tip. The local main branch differs from remote main by two local documentation commits versus eleven remote commits, with common base `1768cdf8658c7bcec3932ffa6b93c8a864bcf2d8`.

Do not reset local main or merge a large program merely to update scope. Prefer a separate feature worktree from the current accepted replatform integration revision for runtime-dependent implementation, or accepted main after replatform lands. Recheck remote tip and dependency gates at branch creation. No branch, reset, checkout, commit or merge was performed here; fetching changed Git objects/remote tracking only.

## Evidence matrix

Paths below are relative to the repository. Remote source citations use immutable GitHub blob links where helpful; local evidence is identified by revision above.

| Area | Verified evidence | Reuse and remaining work |
|---|---|---|
| Commander request deduplication | Local `server/src/services/internal-agent/conversation.ts:110` uses conversation/client-submission conflict protection; `claimTurn` at 186 uses an ownership token and stale-claim handling. | Reuse message identity/claim mechanics. Argument-fingerprint conflict checks and the full canvas action/result contract are requirements, not claims already supplied by this code. |
| Commander distributed execution | Replatform [`cli-mode.ts:1005`](https://github.com/MeteoriteLabs/AoA/blob/053f90fc8991b32b8fb291ef29ada7e81081deb2/server/src/services/internal-agent/cli-mode.ts#L1005) calls the shadow builder/recorder; [`distributed-shadow-port.ts:135`](https://github.com/MeteoriteLabs/AoA/blob/053f90fc8991b32b8fb291ef29ada7e81081deb2/server/src/services/distributed-shadow-port.ts#L135) only records shadow rollout. `E10/findings.md` E10-F001 remains open with per-user credential, routing and interactive result gaps. | Keep one Commander conversation bridge. Shadow evaluation is not distributed execution. Do not add an independent canvas cutover or use company credentials as an unexamined substitute for Commander user credentials. |
| Current viewer state | Local `ui/src/components/commander/viewer/useCommanderViewer.ts:39` explicitly retains a page-lifetime Map and loses it on hard reload. | New durable canvas/draft persistence is needed. Existing in-page navigation is reusable but not autosave proof. |
| Presentation references | `packages/shared/src/viewer-show-ref.ts`; existing task/artifact/approval viewer implementations. | Canonical refs and provenance first; validate instance isolation and actor access, then extend registry. Do not turn stored UI references into grants. |
| Main realtime | Local `server/src/services/live-events.ts:21` onward uses EventEmitter and a process-local counter. | Invalidation is not durable replay. Canvas needs canonical snapshot reconciliation and the replatform cursor contract. |
| Replatform realtime | [`live-events.ts`](https://github.com/MeteoriteLabs/AoA/blob/053f90fc8991b32b8fb291ef29ada7e81081deb2/server/src/services/live-events.ts) always emits locally, with best-effort asynchronous log append. MIG-003 result records replay, RBAC, backpressure, retention and SQL/two-process substrate checks. | Reuse the broker. Critical automation requires durable intent/reconciliation if append is lost. The result explicitly leaves authenticated cross-container WebSocket receive unexecuted; no claim that our local test closes it. |
| Routine execution | Replatform `server/src/index.ts:1621` ticks the service. `routines.ts:654` dispatches; 673/697 locks scoped routine/trigger rows; 1538 implements scheduled tick. Local schema/routes/tests exist. | Reuse, with defined overlap/retry policy. Scoped search in `internal-agent/tools` found no routine/reminder registration; trace the final tool manifest/API exposure before adding one. Absence in this search is not proof no other path exists. |
| Proactivity | Prior source review of `internal-agent/proactive.ts` found recent-activity digest/reminder behavior. | Requires actor visibility, durable since-last-visit checkpoint and event-rule reachability audit. Not re-certified as an automatic personalized briefing in this pass. |
| Browser runtime | Replatform [`run-session.ts:32`](https://github.com/MeteoriteLabs/AoA/blob/053f90fc8991b32b8fb291ef29ada7e81081deb2/packages/browser-runtime/src/run-session.ts#L32) step type is navigate; driver lifecycle/artifacts and approval gate exist. `launch-guard.ts` rejects remote control endpoints/ports. | Live view/input and manual pause/resume remain additional integration. Do not infer arbitrary interactive Browser Use support from navigate and recordings. A remote provider requires a governed adapter, not weakened guards. |
| Browser control delivery | Replatform [`JOB-015 result`](https://github.com/MeteoriteLabs/AoA/blob/053f90fc8991b32b8fb291ef29ada7e81081deb2/docs/replatform/epics/E3-job-control/tickets/JOB-015-result.md) states general channel built, but approval/runtime decisions have producer and no applier. `lease-renewal.ts:682` returns false when `handlers.result` is absent. | Correct earlier shorthand: delivery infrastructure exists, but browser governance is not proven end to end. BRW-004's older “no delivery” statement also cannot describe the newer general transport. Check producer→projection→consumer→browser handler→ACK as one journey. Cancellation's pre-existing boolean path is distinct from these general-channel gaps. |
| File intake | Local `server/src/routes/assets.ts:178` multipart route buffers bytes, validates metadata, writes storage then asset record. Composer namespaces add allowlist, size and byte sniffing. | Existing intake is not resumable upload or a stage ledger. Preserve composer provenance. Design missing upload-session/publication reconciliation instead of assuming all asset routes implement the new contract. |
| Office rendering | Local assets route at 446 resolves asset and checks company access at 454 before shared DOCX/XLSX rendering. Memory route additionally resolves its own scope. Mammoth and ExcelJS helpers sanitize output. | This closes the previous “route untraced” research gap by source inspection; auth behavior still needs integration acceptance. Reuse helpers. Asset-level company authorization is not proof of every future private-content access policy. |
| Office limits | `office-render-limits.ts` defaults input to 15 MiB, overrideable; XLSX preview caps output (12 sheets, 1,000 rows, 50 columns). | Output bounds do not bound ZIP expansion fully. New converter workers need independent memory/CPU/expansion limits; original download differs from preview limits. |
| Format coverage | `viewer-registry.ts` plus native media/PDF/HTML/SVG/Mermaid/Office paths; focused tests below. | Native playback depends on codec. PPTX and broad specialist conversion need adapters; no universal editing/export. Existing canvas viewer kind is not proof of the proposed capability bridge. |
| Access and providers | Secrets and existing approvals provide foundations; replatform Decision 104 explicitly amends cloud CLI credential handling. | Full human/agent account IAM is separate. External speech is approved product direction; record a narrow implementation policy without restoring direct-API extraction. Provider retention/regions/billing remain procurement checks. |

## Dependency-led plan

| Work package (not release assignment) | Can be designed/built against fixtures now | Integration prerequisite and acceptance gate |
|---|---|---|
| Scope/schema alignment | Typed references, operation/result schemas, private draft ownership | Map actual db/shared/server/ui contracts before migrations; no parallel canonical task/artifact model |
| Canvas shell and state | Dock, captions, panel registry, autosave conflicts and accessibility | Authenticated per-user/company storage, schema migration, two-tab/reload/revocation tests |
| Commander/voice | Provider adapter capabilities, shared-context/action bridge and output state | Existing Commander request path plus verified credential/turn lifecycle; distributed execution claims additionally wait for E10-F001 and consumer results |
| Realtime/attention | Canonical projection, snapshot fallback, cursor semantics | MIG-003 integration; append loss, replay truncation, actor revocation and authenticated cross-replica socket delivery |
| Artifacts/tools | Existing viewer reuse, format fixtures, bounded state/action bridge | Canonical upload/version commit mapping; derivative workers, isolated code, safe action authorization and source access propagation |
| Browser | Manual-control UX and adapter contract, capability failures | E8 runtime/D3, JOB-015 consumer binding, admitted agent/Commander browser request path; actual pause/resume/live-input/reconnect proof |
| Routines/briefing | Conversation tool contract and visibility-filtered briefing design | Reachable governed tool, durable trigger/run dedup, missed-event reconciliation and user checkpoint |
| Operations | Telemetry schema, resource budgets, retention and test harness | Evidence for quota exhaustion, provider failure, migration/restore, long sessions, account revocation and rollout/rollback |

Replatform owns its findings and gates. Do not turn unresolved E8/E10 work into a duplicate canvas implementation. This map intentionally does not declare all epics complete from README status or individual test reports.

## Tests run in this update

| Location | Command | Result and limit |
|---|---|---|
| Local main workspace | `pnpm exec vitest run server/src/__tests__/docx-render.test.ts server/src/__tests__/xlsx-render.test.ts server/src/__tests__/office-render-limits.test.ts server/src/__tests__/routines-cron.test.ts` | 4 files, **43 passed**. Existing rendering and cron behavior, not new canvas ingestion/scheduler integration. |
| Local UI directory | `pnpm exec vitest run src/components/viewers/__tests__/viewer-registry.test.ts src/components/commander/viewer/useCommanderViewer.test.tsx` | 2 files, **13 passed**. Registry and current viewer state, not durable canvas storage. |
| Older replatform worktree `C:/e3` | `pnpm exec vitest run server/src/__tests__/live-events-broker.test.ts` | 1 file, **26 passed**. Broker source/test unchanged between that checkout and inspected remote tip; other realtime paths changed, so this is not a test of the entire remote tip or a live multi-replica test. |

Total: **82 targeted tests passed**. No application code was edited. Full typecheck, full test suite and build were not run for this documentation update. Live voice, paid providers, browser takeover, real multi-replica recovery, migrations and the new contracts remain untested here. Documentation links and scope reconciliation are checked separately at handoff.

## Remaining user decisions

Transcript default/raw-audio opt-in is confirmed. Multilingual capability stays in scope; English/Hindi-English are representative recommended fixtures, not a requested restriction. No product answer blocks this scope update. If provider costs/processing regions or retention duration introduce a material business choice during implementation planning, present the concrete options then rather than asking for speculative approval now.
