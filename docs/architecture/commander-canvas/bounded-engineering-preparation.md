# Bounded BASE/DESIGN engineering preparation proposal

**Latest readiness (September 13):** [Base integration and adoption](base-integration-results.md) are complete with full local qualification, required PR CI and exact source comparison. The existing Universe branch now contains the verified replatform landing. TK's requested discussion and explicit batch approval remain before feature implementation. Earlier dated preparation results below are historical.

**Historical pre-adoption preparation (September 13):** [Exact base proposal and first-batch visual checks](pre-implementation-discussion.md) are complete for TK's requested pre-implementation conversation. The merge simulation is conflict-free; the combined source is not yet runtime-qualified or adopted. Eight first-batch states have 32 rendered checks. No Universe coding starts before that conversation and explicit batch approval.

**Historical local qualification (September 13):** The [F5 repair and full baseline verification](f5-repair-results.md) passed at local source `fcab5a112`: repository typecheck, all four test shards (24,276 passed, 76 unchanged ordinary skips) and build. An interrupted shard-3 attempt is preserved separately and excluded from totals. No source drift or new skipped cases. Correction publication/landing, exact Universe base adoption and feature implementation remain unapproved. The remote replatform delta requires its own integration checks; no general epic replanning. Older dated records below are historical.

**Prepared September 12, 2026; bounded execution subsequently authorized.** After publication at 3431c66f2e3a262c9a7f1119acaa0aaecfdbdc2a, TK said “lets do it” with this preparation proposal open. That authorizes only the BASE/DESIGN preparation below. The earlier proposal was documentation-only; the accepted responsibility model alone did not authorize execution. Source-base adoption and Universe implementation still require separate explicit approval. Actual outcomes are recorded in [BASE results](baseline-preparation-results.md) and [DESIGN coverage](design-state-coverage.md).

## Outcome and scope

Produce an attributed source-baseline report and a design-state coverage report before requesting E1.1 coding approval. This batch does not implement Universe, add React Flow, modify schema, adopt the premature draft or close VOICE/CMD/HOST. Those integrations retain their own qualification plans. [Static inventory](voice-media-qualification-inventory.md) records the completed source pass and remaining runtime obligations.

### Revision decision

| Role | Exact revision / meaning |
|---|---|
| Reviewed plan input | 47b50fd942bc7272fe9bc758fc4419196fe54e49 plus this published preparation addendum |
| Existing source baseline | 183e46a9c65fc3105c7e3d125629276814df7dbb; still the Universe branch's source pin |
| Newly observed replatform candidate | 9200a66c42633019349de937a8b97979acac0f7a; fetched/read only, not merged |
| Main observed | e097d2f9332a2715bdbaf2058a4b751481107713 |

Recommendation: qualify both the old pin and this exact new candidate in separate disposable directories. The candidate is one descendant commit changing worker-admission audit/control paths and tests; it does not add a budget reservation primitive or Universe UI. Its relevant org-concurrency signatures have changed. Compare results before recommending a source-base update. Do not silently replace the candidate if upstream moves again; record the new revision and scope its delta. Merge/rebase remains a separately presented action after evidence; this packet does not do it.

## Accepted responsibility record

TK selected this model during preparation:
- Codex: implementation/evidence author after each explicit batch approval, including the canonical Budget foundation, secret guard, source inventories and baseline report.
- TK: product and execution-scope acceptance owner; final decision on source-base adoption and implementation batches.
- TK-managed Claude review: independent technical review of material plans and evidence. Codex checks its findings against source; neither model self-certifies professional security approval.
- Upstream replatform work: no maintainer is invented or assigned by this record. Actual upstream accepted changes and test evidence are inputs; unresolved CMD and other dependencies remain gated.

This resolves the Universe author/reviewer assignment question, including BUDGET-VOICE-MEDIA coordination. It does not replace evidence for permissions, spend or tenant/role correctness. A specialist assessment, if needed for a deployment's actual requirements, must be separately scoped rather than assumed to exist.

## Proposed isolated environment

Read-only host checks found Windows, Docker and WSL executables; WSL lists only docker-desktop. At proposal time no general-purpose Linux distro or running Docker engine was certified. Do not run tests in Docker Desktop's internal distribution or mount the user's live AoA home/database.

Recommended execution target: disposable Linux container on this machine, Node 24 / Debian Bookworm, pnpm 9.15.4 to match source manifest and CI major. Before starting it, inspect Docker engine availability and resolve the node:24-bookworm image to an immutable digest, record it with OS/Node/pnpm versions, and use that digest. Image resolution/pull, dependency installation and build scripts are within the subsequently approved bounded batch. If Docker is unavailable, stop and propose a concrete replacement; do not install WSL or change the host automatically.

Use separate source snapshots rooted at /workspace/base and /workspace/candidate inside a task-owned temporary volume. Populate exact Git objects, with no host repository write mount, Docker socket mount, SSH agent, browser profile, .env, CLI login or user-secret directory. Run as a non-root user with fresh HOME and temporary application/cache directories. Container environment is allowlisted; DATABASE_URL and provider/cloud credentials are absent. No application server against real data. Package download network access is allowed only in the proposed setup phase; disable outbound network for verification. Preserve logs outside the disposable runtime using a designated report directory. Do not print environment values.

Time bounds: setup at most 45 minutes; checks at most 150 minutes per revision. Record a timeout as incomplete, not passed. No paid compute or provider calls. Failure permits diagnosis and reporting, not source/dependency fixes, wider commands or unlimited retries. No cleanup of user directories; only verified task-owned disposable resources may be removed after logs are retained.

## Commands requested for each exact source snapshot

This is the approved command allowlist; the results report distinguishes executed commands from blocked or unrun stages. Checkout/snapshot creation and dependency setup are scoped to the disposable environment above. Verify the tree matches its SHA before and after; no tracked files may change.

```sh
node --version
corepack pnpm --version
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @armyofagents/worker-protocol build
corepack pnpm --filter @armyofagents/sandbox-fake-provider build
corepack pnpm --filter @armyofagents/worker-daemon build
corepack pnpm --filter @armyofagents/sandbox-provider-contract build
corepack pnpm --filter @armyofagents/sandbox-e2b-provider build
corepack pnpm -r typecheck
corepack pnpm exec vitest run --shard=1/4
corepack pnpm exec vitest run --shard=2/4
corepack pnpm exec vitest run --shard=3/4
corepack pnpm exec vitest run --shard=4/4
corepack pnpm build
```

The five dist-only prebuilds and Node 24 come from the pinned .github/workflows/pr.yml; pnpm 9.15.4 comes from package.json. Corepack may download that exact package manager in the setup phase. If the selected image lacks Corepack, stop and propose its exact installation rather than installing an unpinned replacement. Do not regenerate pnpm-lock.yaml, change manifests, bypass prebuild checks or fetch live bundled catalogs. Vitest's direct shard form matches CI; running all four gives the full root suite without pnpm's extra separator ambiguity. Tests with external-service/DB requirements may skip or fail in this intentionally credential-free environment; record those explicitly. An offline failure is not permission to enable external network or use real keys.

Logs must record command, working directory, source SHA, exit status, runtime version, actual test/pass/fail/skip counts and elapsed time. Do not infer success from process launch or zero tests. Run stages in their dependency order; if setup/prebuild fails, mark downstream checks blocked. For independent test failures, retain all executed results; do not run build on a broken prerequisite merely to produce a green-looking partial report.

## What this batch cannot prove

- Root tests/build are baseline evidence, not new Universe UI or provider acceptance.
- No real PostgreSQL migration, tenant-role suite, external DB, browser E2E or provider trial is requested here. A later narrowly scoped batch must provision a disposable DB and name its migration/role cases.
- The Windows Playwright default can select only a skip test without external DB or its force flag. Neither that skip nor a mock-only component suite closes DESIGN or host behavior.
- React Flow is not installed in the accepted source. Its real pan/zoom/resize/iframe behavior requires an explicitly approved E1.1 implementation or separately scoped experimental harness; this preparation does neither.
- Existing CommanderTaskFocusPane tests can support source understanding, not certify the mock's intermittent task-panel defect as fixed.

## DESIGN review in this batch

Use the already accepted [UI decisions](ui-review-decisions.md), [remaining state designs](ui-state-review.md), [motion rules](motion-and-interaction.md) and [UAT plan](user-acceptance-plan.md). Build an evidence matrix for loading, empty, unavailable/revoked, error/retry, reconnect, narrow viewport, keyboard/focus, reduced motion, compact/maximized/tucked chat and panel lifecycle. Classify each as user-reviewed baseline, specified but not shown, shown but untested, or runtime-tested with evidence.

Inspect only an already available mock/artifact whose revision and entry route are known. Do not silently use the excluded premature implementation or create a new UI. If a state has never been rendered, mark it pending; a written description is not visual acceptance. Bring TK only material differences in experience, with a concrete recommendation. Routine consistency observations belong in the report. No claim that this pass completes every DESIGN gate.

## Pass, failure attribution and handoff

For each revision, report separately: dependency/prebuild status, typecheck, four shard outcomes and build; distinguish inherited failures, candidate-only failures, environment limitations and skipped evidence. Shared failures remain unresolved source baseline issues, not silently accepted. A candidate-only failure blocks recommending that revision until its owner supplies a disposition. Baseline failures need exact impact on the first slice before any coding approval.

Required outputs, written only after the approved checks actually run: baseline-preparation-results.md and design-state-coverage.md in this documentation directory. Record exact image digest and SHA, commands and sanitized logs, observed results and exclusions. Do not create a passing result stub now.

Then TK receives: recommended execution base with evidence, proposed source integration action, remaining gates that affect E1.1, and its exact implementation batch. Acceptance of this preparation proposal never authorizes that later coding batch. Current status: bounded preparation authorized; consult the attributed results for execution status. Merge/rebase, source changes and implementation authorization remain absent.

## Authorized retry outcome

After the first attempt at 4c9b71e75, TK explicitly approved the proposed container-only pnpm shim and one offline retry. The [retry report](baseline-retry-results.md) records both passing typechecks, all eight shards, matching unresolved failures and unchanged source snapshots. Build was blocked by failed tests. The [findings](baseline-retry-findings.md) require a separately scoped corrective plan; this authorization does not extend to source changes or further retries. The container is stopped, logs retained, and source-base adoption and implementation remain unapproved.

## Corrective plan scope

The [F1/F2/F3 corrective plan](baseline-correction-plan.md) is the separately prepared next scope. TK authorized authoring/reviewing that plan; source changes, Git-backed environment setup and further targeted/full runs still require explicit execution approval after review. The earlier environment-only retry authorization is exhausted. No base adoption or Universe implementation is included.

## Approved correction execution outcome

TK explicitly approved the isolated correction batch after the reviewed plan. [Results](baseline-correction-results.md) record local correction commit `b5cc42643223c433a8263564c7142761472a13d9`, passing typecheck and all 247 targeted cases, plus all four full shards. F1/F2/F3 are corrected in that isolated tree; full qualification remains failed due to a confirmed blocked-task fixture port collision and a separate backup setup timeout. Totals: 24,242 passed, 4 failed, 78 skipped; two failed suites, no unhandled-error summary. Build was blocked. No additional fixes/retries followed.

The runtime is stopped. Correction commits are local only; Universe remains on its original replatform pin. Prior “execution approval pending” statements describe the pre-approval stage and are superseded for this bounded batch only. New fixture corrections, source publication, base integration and Universe implementation remain separate decisions. See the report’s next-decision section.

## F4/F5 fixture planning checkpoint

TK authorized preparing and reviewing the [fixture investigation and repair plan](fixture-repair-plan.md). Read-only inspection of the installed dependency from the stopped qualified container explains F4's lost setup failure and stale exit-listener cleanup path; [static evidence](fixture-static-evidence.json) records identities. F5's failing stage is not yet known. The proposed next executable scope is Stage A: one instrumented backup fixture, one isolated run and one existing shard-4 diagnostic run, followed by a stop and repair review. No timeout increase, source repair, full qualification, source publication, base adoption or Universe implementation is authorized by this planning checkpoint. No new runtime execution occurred. [Claude prompt](claude-review-handoff.md#focused-review-of-f4f5-fixture-plan).

## Stage-A diagnostic execution outcome

TK approved Stage A after [Claude's plan review](fixture-plan-review-report.md) and Codex verification. [Results](fixture-diagnostic-results.md) record two completed diagnostic invocations on exact correction source plus the single-file timing patch. Backup passed twice; setup was 2.299 s isolated and 5.971 s in shard 4. The latter failed seven suites at collection because the five-prebuild proposal omitted the plugin SDK normally generated during full typecheck. This is an acknowledged setup-plan omission and limits workload equivalence. No timeout/repair conclusion follows from non-reproduction.

Runtime stopped; host source branches unchanged. The report proposes a separately approved SDK build/export check and one corrected shard-4 diagnostic. No extra build or retry occurred. Stage B repair, Stage C full qualification, remote source publication, base adoption and Universe implementation remain separate gates. Prior Stage-A approval-pending statements are historical and superseded only for the two recorded invocations.

## SDK follow-up disposition

TK approved the bounded SDK build/export-check/shard proposal. [Results and execution deviation](fixture-sdk-followup-results.md): SDK build passed; plain-Node import failed resolving a workspace TypeScript export. Codex then incorrectly launched the dependent shard before inspecting that failure and stopped the container on discovery. Its partial output is invalid; no final shard result or post-abort source manifest is claimed. No additional execution followed. The report proposes a TypeScript-aware loader plus a machine-enforced prerequisite gate, requiring a new bounded approval. F4/F5 repair, full qualification, source publication and base adoption remain open.

## Gated loader-aware diagnostic outcome

TK approved the corrected export check and one success-gated shard invocation. [Results](fixture-loader-check-results.md): both commands passed; shard 4 ran 6,031 passing tests with 3 existing skips, including all seven previously uncollected suites and both backup cases. Source/patch identity and all 7,664 tracked entries matched before/after; runtime stopped. The prior aborted run remains invalid historical evidence. SDK preparation/loading is now resolved for this environment; F5 did not reproduce (setup 6.233 seconds) and is not declared repaired. No additional backup-only rerun or speculative timeout change is recommended. Next is reviewing the exact F4 fixture repair and fault regressions, then separately approved source authoring/full qualification. No base adoption or Universe implementation.
