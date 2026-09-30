# Commander Canvas master-scope review — resolved follow-up

Updated September 10, 2026. The review has been incorporated into the [canonical master scope](commander-canvas/master-scope.md), supported by the [code/dependency evidence](commander-canvas/code-evidence.md). Use those documents for implementation planning.

## Disposition

| Original review concern | Follow-up |
|---|---|
| Stale pipeline-first and automatic-takeover requirements | Removed from the canonical baseline. Realtime first; all three voice modes eventual; manual pause/take-control sufficient. Old discussion records are explicitly historical. |
| Ignored plans were the only handoff | Canonical scope and companion contracts moved under docs/architecture/commander-canvas, outside the ignore rule. Old entry points redirect. Files remain uncommitted. |
| Shallow history prevented choosing a base | Deepened the relevant remote history. Remote main is the merge base and ancestor of remote replatform. Recommend an isolated feature worktree at the accepted integration revision, without resetting the user's divergent local main. |
| Main and replatform findings were conflated | Code-evidence document records local main, remote main, local replatform and remote replatform revisions separately. |
| Hosted-key rule appeared absolute | Replatform Decision 104 already narrows the older rule for cloud sandbox CLI credentials. Speech/media still needs a scoped implementation policy; the user's external-speech direction is already accepted. No direct-API extraction fallback or global policy amendment was introduced. |
| Commander migration treated as available substrate | Current replatform source and E10-F001 show shadow evaluation and unresolved routing/credential/result dependencies. Canvas must not invent a second cutover. |
| Browser delivery interpreted as complete control | JOB-015 transport exists, but its result documents missing browser governance application. Source returns unacknowledged when the result handler is absent. End-to-end control remains an explicit dependency. |
| File lifecycle and route gaps | Generic Office rendering route traced; resumable processing remains new work. Assets, artifact versions and derivatives must map to existing storage contracts. Original survives derivative failure. |
| Unmeasured production promises | Added required per-contract limits and connected acceptance journeys; no invented latency or universal-format guarantee. |
| Retention and language uncertainty | User confirmed transcript default, raw audio opt-in. Multilingual provider capability stays in scope; English/Hindi-English are recommended test fixtures, not a restriction. |

## Verification

82 focused existing tests passed: 43 server Office/cron checks, 13 UI registry/state checks, and 26 broker checks in the older replatform worktree (the broker source/test is unchanged at the inspected remote tip). These do not certify new canvas contracts or full replatform integration. Exact commands, revisions and limits are in the code-evidence document.

This update changes documentation only. Full typecheck, full test suite and build were not run; live providers, browser takeover, full authenticated multi-replica delivery and new migrations were not tested. No branch, merge, commit or deployment was performed.

## Next

Prepare concrete implementation plans from the dependency map: shared contracts and state first, then provider/panel/artifact consumers and governed runtime integrations. Preserve existing replatform ownership and test each consumer against its required gate. Assign epics/version slices after that review. No additional user answer blocks the current scope consolidation.
