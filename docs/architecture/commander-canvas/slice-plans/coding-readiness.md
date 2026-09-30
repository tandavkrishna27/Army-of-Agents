# Coding readiness for every Universe increment

**Current scheduling overlay:** [The complete execution sequence](../execution-sequence.md) distinguishes early contracts from later consumer qualification and maps all 69 increments. [Author review](../execution-sequence-review.md) and [dependency gates](../execution-dependency-gates.md) govern readiness ordering without waiving this document's coding requirements.

These individual plans define the work now, before implementation. They deliberately distinguish **specified**, **bound for coding**, **implemented** and **verified**. Only verified work counts toward release completion.

**September 12 authority correction:** the original slice outlines are supplemented by detailed coding plans and the independent-review reconciliation. Follow the [planning reset](../planning-reset.md). Detailed plans must be independently reviewed, findings resolved, and the user must explicitly approve beginning implementation. Technical readiness or a reviewer verdict alone does not authorize coding. The isolated premature draft is not accepted delivery; preserving it untouched/excluded is accepted, and later cleanup or reuse needs its own decision.

## Binding required before coding

Each slice's coding addendum must contain:

1. Accepted repository/replatform revision and verified existing behavior; actual file paths and exported symbols. Resolve source collisions before creating a module.
2. Exact inputs, outputs, validators, authorization owner, route/event registration and failure responses. Logical boundaries in preparation plans are not invented SDK APIs.
3. Concrete test code using the repository's actual fixtures, a command that runs that file, and evidence that its failure demonstrates the missing behavior rather than an environment failure.
4. Small implementation steps with actual code/signatures, then focused verification. Where schema changes are needed, include generation/export/backfill compatibility and rollback review.
5. Qualified limits: payloads, geometry, timings, throughput, retries, resource use and retention as applicable. Separate proposed defaults from measurements and user-facing guarantees.
6. Consumer changes for settings, motion, accessibility, status/error recovery and documentation, together with integration and feature-disable behavior.

**Why some details cannot be final now:** the next execution-time replatform refresh, distributed Commander contract, Browser Use transport containment and real speech/tool-host qualification remain open. A guessed route or provider signature would make a detailed-looking plan unsafe to execute. The first deliverable of those increments is a binding/qualification record. This is an engineering prerequisite, not a request for the user to design internals.

## Shared sequencing without circular gates

- E0.1 accepts a base and records unresolved dependencies; it does not require all downstream capabilities already implemented.
- E1.0 completes the UI state contract before affected UI coding; implementation tests remain with their slices.
- E8.1 first publishes the preferences contract. Each consumer then implements its own fields and behavior. Do not wait for all E8.1 consumer tests before starting those same consumers.
- E1.1 establishes panel/viewport data; E1.3/1 publishes draft snapshots; E2.1/1 establishes context projection using them without waiting for E1.6; E1.6 consumes the viewport and context contracts for integrated Commander navigation. The shared projection contract can be specified before full animation implementation.
- E1.3 local draft handling is independent of geometry. Submission recovery closes with E2.2; it cannot be called complete while outcome lookup is missing.
- Manual task replies, uploads, presentation and visual attention do not depend on distributed Commander. Their execution-dependent increments retain CMD separately.
- E6.0 qualifies cloud and local separately; E6.4 saved-profile work also requires PROFILE. Signed-out browser success cannot close saved-profile scope.
- E8.2 runs after all V1 slices and relevant upstream gates, including the consumer completion of E8.1. Reuse its checks for subsequent releases.

## Evidence record

Each increment records: owner, source revision, requirement/decision references, exact contract, fixtures/protocol, observed results, limits, dependency evidence, rollback result and reviewer disposition. Keep unchecked work visible. No owner, result, test or capability is inferred from the existence of this plan.

## User acceptance testing (UAT)

[The numbered UAT plan](../user-acceptance-plan.md#per-slice-acceptance-register) is required alongside unit, integration and end-to-end tests. Each slice records its applicable script IDs, actual host/build/tester, expected/observed result, defect references, pass/fail/blocked/not-run status and product acceptance decision. Backend-only slices use linked consuming journeys plus technical evidence review; they do not invent a screen. E0.1 is documentary acceptance. E8.2 aggregates all V1 records and integrated real-provider/worker journeys. U01–U10, master §11, the intermittent task-route defect and restored settings have explicit coverage. No automated test or mock preview can fill the human acceptance field.

## Runtime verification

Run relevant focused tests during the increment. Before runtime handoff:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Use actual provider/worker environments for gated integration, with measured local/cloud results. A plan-only change uses document coverage/link validation and explicitly reports that runtime verification was not run.
