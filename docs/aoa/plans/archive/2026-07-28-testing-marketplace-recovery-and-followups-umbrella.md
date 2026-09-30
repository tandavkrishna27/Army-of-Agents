<!-- /autoplan restore point: C:\Users\TK\.gstack\projects\AoA-main\codex-testing-marketplace-recovery-autoplan-restore-20260728-172030.md -->
<!-- /autoplan restore point: C:\Users\TK\.gstack\projects\MeteoriteLabs-AoA\codex-testing-marketplace-recovery-autoplan-restore-20260728-022915.md -->

# Archived Umbrella: Testing Marketplace Recovery and Follow-up Execution Plan

**Date:** 2026-07-28
**Repos:** `MeteoriteLabs/AoA`, `MeteoriteLabs/aoa-marketplace`, `MeteoriteLabs/aoa-marketplace-cdn`
**Starting AoA commit:** `3aa78b77539706957f28105c3656e4562a267ecc`
**Target environment:** `https://testing.armyofagents.org`

## Outcome

Restore the missing testing surfaces, publish a real connector catalog, finish the
team-template update lifecycle, and remove the embedded PostgreSQL port collision
flake. Each change is independently reviewable, reversible, and gated by its own
CI result.

## Verified Starting State

1. Gate A0 shipped in PR `#311`; `main` is
   `32983b769a6fe4741b4e8144d42797048c095b53`.
2. Testing is healthy and reports that exact revision. Its loaded catalog
   identity and counts match the current public `catalog.json`.
3. The public `catalog.json` contains 504 skills, 4 plugins, 12 agents, and 1
   team. The separate public `connectors.json` still returns 404.
4. Manual reconciliation operation
   `9e9ebe10-92a5-4b4d-afa5-319e01925f07` completed with
   `status: "partial"`: 2 companies examined, 0 repaired,
   `skippedFailClosed: 2`, and no thrown `failures`.
5. The public response and per-company completion audit expose the counters but
   not the fail-closed reason or detail, so the operator cannot distinguish a
   missing catalog resource, bundle materialization failure, filesystem
   failure, or another guarded skip without container-log access.
6. Both testing companies still have 10 AoA agents. Reviewer is absent,
   Steward and Chronicler retain NULL marketplace origins, no crew team row is
   present, and all 17 required crew skill bundles are absent.
7. The ordinary Agents page intentionally lists only organization agents. The
   current account also resumes unfinished onboarding at step 5, so `/`
   intentionally shows the full-screen onboarding route instead of normal
   navigation.
8. Authentication succeeded with an instance-admin board key only after adding
   a browser-origin header. `board-mutation-guard.ts` currently applies the
   session CSRF-origin rule to `source: "board_key"` despite the key being an
   explicit bearer credential.
9. `managedMarketplaceSkillsRoot()` currently resolves below
   `process.cwd()` (`/app/.aoa/marketplace-skills` in the image), while Docker
   persists `/aoa`. This is a confirmed durability risk across redeploys, but
   it is not yet proven to be the cause of the live fail-closed skips.

## Premises

1. The missing marketplace categories should be fixed by deploying current
   `main` and refreshing the existing cache, not by adding duplicate UI routes.
2. Built-in crew should remain separate from founder-created organization agents.
3. Curated connectors should continue to use a separate `connectors.json`
   contract rather than becoming ordinary `catalog.json` items.
4. Team updates must preserve founder changes by default. Unknown provenance is
   treated as customized or conflicting, never safe to overwrite.
5. The embedded PostgreSQL sweep is test-only and must be isolated from production
   behavior changes.
6. Live CDN publication is a separate approval gate because it affects every AoA
   instance using the default URL.
7. Explicit board API keys are non-browser credentials. Only
   `source: "board_key"` bypasses the Origin/Referer mutation check; authenticated
   browser sessions keep the existing CSRF protection unchanged.
8. A partial fleet operation is not operable unless every guarded skip has a
   safe, structured company-scoped explanation in both the response and audit.
   Raw exception text, secrets, and unbounded filesystem paths are not public
   diagnostics.
9. The first recovery follow-up fixes authentication and observability only.
   The skill-install cause and managed-bundle durability change are a second PR,
   selected from evidence produced by a deployed diagnostic rerun.

The user approved this direction after the live investigation on 2026-07-28.

## Delivery Boundaries

This program has one operational recovery and seven serialized code PR tracks:

| Gate | Deliverable | Repository | Production behavior |
|---|---|---|---|
| A0 | Exact-SHA deploy input and deterministic catalog/crew maintenance | AoA | Operations control |
| A | Deploy current `main`, refresh catalog, verify crew | AoA testing | Testing only |
| A1 | Board-key mutation semantics and structured reconcile skips | AoA | Operations control and diagnostics |
| A2 | Evidence-selected skill materialization/durability repair | AoA | Marketplace skill storage |
| B0 | Amend stale connector architecture decision | AoA | Documentation only |
| B1 | Connector aggregation, content, validation, publication | aoa-marketplace | New curated catalog |
| C1 | Marketplace-team schema, baseline persistence, detection | AoA | Detection only |
| C2 | Team-template diff, merge, and apply API | AoA | Marketplace update behavior |
| C3 | Team-template update UI | AoA | User-facing update workflow |
| D | Embedded PostgreSQL allocator sweep | AoA | Test-only |

Do not combine A1, A2, B, C1, C2, C3, and D in one PR. A1 is a small
security/operability prerequisite; A2 is intentionally evidence-selected after
deployment. Their rollback units, reviewers, and verification surfaces are
different. Keep one-click team apply disabled until C2 has proved the baseline
and transaction invariants.

## Gate A - Recover Testing First

### A0 - Make the Operation Deterministic

The current testing workflow accepts no input, permits only `main`, and always
deploys `github.sha`. The marketplace sync endpoint does not rerun crew repair or
team reconciliation. Before the recovery deploy, ship one small operations PR:

1. Add required `deploy_sha` to `.github/workflows/deploy-testing.yml`.
2. Validate that the SHA exists, is an ancestor of `origin/main`, and has the
   required CI success before building.
3. Check out and label the image with that exact SHA. Print it in the deployment
   summary and health evidence.
4. Extract the boot-only catalog/crew sequence into a reusable service.
5. Add `POST /api/admin/marketplace/reconcile`, restricted to instance admins.
   It synchronously:
   - refreshes the marketplace catalog from the CDN; cache/bundled fallback
     remains available to normal reads but never authorizes fleet mutation
   - records the actor-attributed fleet start audit, then runs the catalog
     skill/plugin update check; catalog refresh itself does not mutate
     installed-item update state, periodic checks serialize behind the audited
     operation, the update checker uses the exact audited company snapshot, and
     any per-company/item failures make the result `partial` under the
     `marketplace_update` failure stage
   - runs crew repair
   - runs legacy Steward reconciliation
   - reconciles team members
6. Return the catalog `generatedAt` and digest, companies examined, repaired
   agents/members, and per-company failures. Log one structured operation ID.
7. Add route authorization, partial-failure, replay, and exact-SHA workflow
   contract tests.

Deploy:

```sh
gh workflow run deploy-testing.yml --ref main -f deploy_sha=<reviewed-sha>
```

Reconcile after health is green:

```sh
curl -X POST \
  -H "Authorization: Bearer <instance-admin-token>" \
  https://testing.armyofagents.org/api/admin/marketplace/reconcile
```

The response is the deployment handoff artifact. `canonicalDigestSha256` is the
SHA-256 of the catalog after recursive JSON key sorting, so compare it with the
public catalog using the same canonicalization rather than hashing transport
whitespace. `status: "partial"` means at least one company failed or a guarded
repair was skipped; use `failures` and the aggregate skip counters before
retrying.

```json
{
  "operationId": "f44ac1b9-...",
  "replayed": false,
  "status": "success",
  "catalog": {
    "generatedAt": "2026-07-28T00:00:00.000Z",
    "canonicalDigestSha256": "<64 lowercase hex>",
    "schemaVersion": "1.0.0",
    "itemCount": 521,
    "source": "cdn"
  },
  "companiesExamined": 2,
  "repairs": {
    "crewCompaniesRepaired": 1,
    "legacyStewardsAdopted": 1,
    "teamsReconciled": 1,
    "teamMembersAdded": 1
  },
  "failures": []
}
```

Rollback uses the same workflow with a recorded prior SHA only when that image
implements the OCI-label and `/api/health` revision contract. The trusted driver
fails closed when either proof is missing for a candidate or contract-aware
rollback. During automatic rollback only, it may accept the already-selected
previous image when its OCI label and both health payloads uniformly predate the
revision contract; the deployment workflow remains failed and the log explicitly
states that availability was restored without certified revision evidence. Any
partial or conflicting revision evidence still fails. The first successful A0
deployment therefore becomes the first certified rollback anchor.

### Procedure

1. Confirm `origin/main` is CI-green at `3aa78b77539706957f28105c3656e4562a267ecc`.
2. Dispatch the manual testing deployment workflow with that exact SHA.
3. Verify the deployment log names the exact image SHA and reports a healthy
   server.
4. Verify `/api/health`.
5. Trigger or verify a marketplace catalog refresh after the new server is
   running.
6. At dispatch time, record the public catalog's `generatedAt`, response digest,
   and category counts. Confirm testing loads that exact artifact. Record three
   separate views of the data:
   - raw artifact counts by type
   - community shelf counts
   - AoA shelf counts
   The UI deliberately partitions AoA and community items, so no single shelf is
   expected to equal the raw total. The observed 2026-07-28 raw counts are 504
   skills, 4 plugins, 12 agents, and 1 team, but the captured artifact identity
   is authoritative if the catalog changes legitimately during deployment.
7. Run or verify the crew repair and reconciliation pass after the refreshed
   catalog is available.
8. Confirm Team -> AoA Team contains Steward and Reviewer with no duplicate
   crew identities.
9. Confirm the ordinary Agents page still excludes AoA crew.
10. Confirm onboarding step 5 remains the only reason `/` redirects away from
    the lobby.
11. Capture desktop and mobile evidence for this route/session matrix, using the
    authenticated company route prefix where required:

| Route | Expected result |
|---|---|
| `/marketplace` | Community marketplace categories and captured counts |
| `/marketplace?view=aoa` | AoA marketplace categories and captured counts |
| `/<prefix>/team?tab=aoa&aoaTab=roster` | Steward and Reviewer exactly once |
| `/<prefix>/agents/all` | Organization agents only |
| `/` | Onboarding step 5 for the current testing account |

Verify the deep links first and `/` last so the intentional onboarding redirect
cannot be misdiagnosed as missing navigation.

### Rollback

Redeploy the most recent recorded **contract-aware** SHA if a later image fails
its health check or introduces a verified regression. The pre-A0
`f8891a958dd0b91f3e26c58b58fbae8fc1bcef32` image may be restored automatically
or manually for emergency availability during the first rollout, but it cannot
satisfy exact revision evidence and is not an eligible certified deployment
target. The legacy automatic-rollback compatibility path reports availability
recovery only; it never certifies the SHA.
Do not roll back merely because the founder's onboarding state still resumes at
step 5.

### Exit Criteria

- Deployment SHA is exact.
- Health is green.
- Catalog counts are current.
- Steward and Reviewer exist exactly once.
- No UI route or navigation regression is observed.

### A1 - Make Reconciliation Operable

A1 is the next PR. It fixes two verified control-plane gaps without changing any
crew repair decision:

1. In `board-mutation-guard.ts`, allow a mutation without Origin/Referer only
   when authentication has already produced
   `req.actor.type === "board" && req.actor.source === "board_key"`.
   Preserve the current behavior for `session`, `local_implicit`, agent, MCP,
   safe-method, trusted-Origin, and trusted-Referer requests.
2. Add a public, bounded `MarketplaceReconcileSkip` contract:

   ```ts
   interface MarketplaceReconcileSkip {
     companyId: string;
     stage: "crew_repair";
     category: "fail_closed" | "cooldown" | "over_budget";
     reason: CrewRepairSkipReason | "repair-budget-exhausted";
     message: string;
     retryable: boolean;
     recovery: string;
   }
   ```

   The public type must not import a server-private type; either promote the
   stable reason enum to `packages/shared` or map server reasons to a shared
   wire enum at the service boundary.
3. Collect exactly one structured entry for each counted skip. The invariant is:

   ```text
   skips where category=fail_closed == crewRepair.skippedFailClosed
   skips where category=cooldown    == crewRepair.skippedCooldown
   skips where category=over_budget == crewRepair.skippedOverBudget
   ```

4. Use reason-specific, operator-actionable messages. Do not return raw
   `Error.message`. Diagnostics must be allowlisted, capped in length, free of
   bearer tokens/URLs with credentials, and must not expose unrestricted local
   paths. The full underlying error remains in structured server logs keyed by
   `operationId` and `companyId`.
5. Include the company-filtered safe skip entries in
   `marketplace.reconciliation_completed` audit details. The fleet response may
   contain all company entries because the route is instance-admin-only; each
   company audit row contains only that company's entries.
6. Correct `docs/api/marketplace-and-plugins.md` and the recovery runbook so the
   canonical bearer-key example does not require a fabricated browser Origin,
   documents `skips[]`, and tells an operator when retry is safe.

Tests:

- `board-mutation-guard.test.ts`: board key without Origin succeeds; session
  without Origin remains 403; session with trusted Origin/Referer succeeds;
  non-board behavior is unchanged.
- `crew-repair` pass tests: each skip category produces one entry and preserves
  its aggregate count; two companies keep distinct details; budget skips name
  the skipped company.
- `marketplace-reconcile.test.ts`: `skips[]` propagates to the response, makes
  status partial, is filtered into each completion audit, and does not affect
  thrown `failures[]`.
- Route contract test: a board-key instance admin can call the endpoint without
  Origin, a session request still needs the guard, and a non-admin remains
  forbidden.
- Redaction tests: token-like text, credential-bearing URLs, long strings, and
  absolute paths never cross the public/audit boundary.

Deploy A1 by exact SHA, then rerun reconciliation once with a new operation ID.
Capture the response and completion audit before making any A2 change.

#### A1 Exit Criteria

- Board-key curl works without Origin/Referer.
- Browser-session CSRF behavior is byte-for-byte unchanged.
- Every aggregate skip counter reconciles with a safe `skips[]` entry.
- The operation ID is sufficient to join response, audit, and server logs.
- A new testing rerun identifies the exact fail-closed reason for each company.

### A2 - Fix the Proven Skill-install Cause

A2 is blocked on the A1 diagnostic rerun. Its first commit records the observed
reason and maps it to one of these branches:

| Evidence | Fix direction | Required proof |
|---|---|---|
| Catalog resource fetch/parse failure | Repair the catalog resource or bounded fetch/parser path | exact resource fixture plus live HTTP smoke |
| Installed DB row but missing bundle directory | Add re-materialization instead of returning `alreadyInstalled` | missing-directory integration test and byte-exact restored inventory |
| Bundle root lost on redeploy | Move managed bundles under an `AOA_HOME`-backed persistent root, with guarded legacy-path migration | Docker restart persistence test, containment/jail regression, rollback copy |
| Filesystem ownership/permission failure | Fix entrypoint ownership and preflight the managed root | production-user container test with read/write/rename |
| Other guarded reason | Implement the smallest reason-specific repair | regression test that reproduces the captured detail |

The `/app/.aoa` versus `/aoa` mismatch is already a durability finding, so A2
must resolve or explicitly disprove it even if the immediate skip has another
cause. A root move must keep the marketplace-skills jail, case-sensitivity
probe, staged rename, byte-derived `customized` invariant, and founder-data
protection intact. Never "fix" reconciliation by marking an absent bundle
installed or by clearing a customized flag.

After A2 deploys, force one reconciliation pass and verify both companies:
Reviewer exists exactly once, the default crew team exists once, Steward is
adopted as specified, all 17 required skills have materialized inventories, and
a second forced pass is an idempotent success with zero repairs.

#### A2 Exit Criteria

- The captured A1 failure is reproduced by an automated test.
- The selected fix passes locally and in Linux CI.
- Managed skill bytes survive a container restart when persistence is required.
- Both testing companies reconcile successfully.
- A repeated forced reconciliation is a no-op and produces no duplicates.

## Gate B - Publish the Curated Connector Catalog

Gate B follows
`docs/aoa/plans/2026-07-25-plan3b-connector-catalog-publishing.md`.

### What Already Exists

AoA commit `19fba089` already shipped the build-time snapshot fetcher, bundled
snapshot, server fallback, and fallback/live-cache precedence tests. Gate B must
verify those paths, not rebuild them.

### B0 - Reconcile the Architecture Contract

Amend Decision #116 in `docs/architecture/decisions.md` before publication:

1. Replace the stale "fifth marketplace item type" wording with the shipped
   separate `connectors.json` contract.
2. Record the fleet-freeze reason: older `catalog.json` parsers reject an unknown
   item-type enum and retain stale cache.
3. Point to `packages/shared/src/mcp-connector-catalog.ts` and
   `connector-catalog-isolation.test.ts` as the enforced boundary.
4. Correct the older Plan 3b note that says AoA still needs a snapshot fallback.
5. Export a versioned contract bundle under
   `docs/contracts/mcp-connectors/v1/`: generated JSON Schema, raw-input
   conformance cases with accepted/dropped expectations, and SHA256 manifest.
   The cases cover reserved names, value-bearing aliases, duplicate IDs,
   defaults, transport coherence, and additive unknown fields.

This is a small documentation PR and must merge before B1 publishes bytes that
depend on the corrected contract.

### B1 - Marketplace Builder and Content

1. Add `content/connectors/<slug>/connector.json`.
2. Implement `aggregateConnectors()` with the same schema AoA enforces.
3. Emit `{ schemaVersion, entries }` to `connectors.json`.
4. Derive trust from `trusted-sources.json`; never trust entry self-assertion.
5. Reject invalid server names, incoherent transports, secret values, malformed
   auth requirements, duplicate IDs, and duplicate server names.
6. Extend validation and CI to build and inspect `connectors.json`.
7. Extend publication so `connectors.json` is committed alongside `catalog.json`
   in `aoa-marketplace-cdn`.
8. Do not add that copy step to the existing push-to-main publisher. Add a
   `publish-connectors.yml` `workflow_dispatch` using a protected environment,
   fixed inputs `source_sha`, `artifact_sha256`, and `dry_run`, and a reviewed
   `connectors.json`-only CDN diff. The environment owner approves publication;
   rollback reverts the resulting CDN commit.
9. Add `docs/marketplace/standards/connectors.md`, a connector section in
   `agent-workflows.md`, a valid example, and an ownership/credential-review
   sidecar. Include the exact local AoA seam:
   `AOA_E2E_CONNECTOR_CATALOG_PATH=<absolute connectors.json path>`.

### Initial Launch Set and Value Target

The first publication targets the founder workflow "give a crew agent access to
project files, web retrieval, source control, or product knowledge without
hand-authoring MCP configuration."

The named launch candidates are:

| Connector | Transport | Availability gate | Founder value |
|---|---|---|---|
| Fetch | stdio, no secret | Primary-source package check plus live request | Web retrieval |
| Notion local | stdio, `NOTION_TOKEN` | Already live-proven; re-run list query | Product knowledge |
| Notion hosted | HTTP, OAuth | Visible but explicitly unavailable | Shows the future hosted path honestly |
| GitHub hosted | HTTP, token | Publish only after primary-source auth check and live tool call | Repository/issues workflow |

Filesystem is deliberately excluded from the first catalog publish. The current
catalog installer cannot bind a founder-selected, workspace-contained path, so a
static fleet-wide argv would be either useless or unsafe. It remains available
through the existing BYO path until typed install parameters exist.

Every candidate must have its package or URL, transport, authentication model,
maintenance owner, and test credential owner recorded in its content review.
If GitHub hosted does not pass the token-auth live test, exclude it from the
first publish rather than relabeling it optimistically. OAuth-only entries are
visible but non-installable until OAuth installation exists.

### End-to-end Verification

1. Pin an AoA contract-bundle commit and SHA256. Validate generated entries
   against its JSON Schema and run the entire conformance corpus through the
   marketplace validator.
2. Aggregation is all-or-nothing: any rejected/dropped connector exits nonzero
   and does not write `dist/connectors.json`. Diagnostics include source file,
   JSON pointer, stable error code, cause, and fix.
3. Point a local AoA server at it.
4. Verify shelf rendering, details, install, consent, secret binding, and one
   actual tool call for each supported transport class.
5. Verify an OAuth-only entry cannot be installed.
6. Verify malformed and untrusted entries fail the producer build; verify AoA
   still drop-and-warns a deliberately bad remote fixture defensively.

### Publication Gate

Publishing is outward-facing. Before publication:

- Both PRs are merged and CI-green.
- Generated bytes are reviewed.
- The CDN diff contains only the expected connector artifact and catalog refresh.
- A rollback commit is prepared.

After publication:

- `connectors.json` returns 200 with the expected content type.
- Testing refreshes and shows the curated shelf.
- At least one connector completes browse -> install -> bind -> invoke.

## Gate C - Phase 4b-prime Team-template Updates

### Current Gap

`marketplace-update-checker.ts` does not scan installed teams. The narrow
`reconcileTeamMembers()` pass only adds missing catalog members. It does not
create pending updates, compare team metadata, detect removals or role changes,
or preserve founder modifications. `POST /updates/:id/apply` returns 501 for
teams, while the suggested `/merge` endpoint rejects team updates.

### C1 - Contract, Baseline, and Detection-only Rollout

1. Add a versioned `MarketplaceTeamTemplateSchema`; do not reuse
   `TeamManifestSchema`, whose inline/ref agent and routing model is a different
   export contract.
2. Use the new schema in install, reconcile, and detection paths. Define how
   existing v1 `team.json` inputs are normalized and rejected.
3. Normalize each member to an explicit role and an allowlisted override shape.
   Legacy v1 inputs normalize the first member to `lead`; all remaining members
   receive their schema-defined default role. Reject unknown override keys.
4. Add `marketplace_team_baselines`, keyed by `team_id`, containing:
   - normalized applied team body, including catalog `requires`
   - schema version and applied catalog version
   - canonical body digest
   - provenance (`known` or `unknown`)
   - monotonically increasing baseline revision
5. Write the baseline atomically on install and successful apply. Existing teams
   migrate to `provenance=unknown`; never synthesize "last applied" bytes from
   today's catalog.
6. Add `targetTeamId` to team pending updates. Replace the current broad
   `(companyId, catalogItemId)` identity with explicit team and non-team partial
   unique indexes, plus checks for valid `itemType`, status, and team-target
   presence.
7. Key members by stable `templateOrigin`, never display name.
8. Treat missing or unprovable provenance as customized.
9. Scan company-scoped installed teams with `templateOrigin` and
   `templateVersion`.
10. Match the current catalog team by origin and compare versions using the
   existing marketplace version policy.
11. Replace `upsertPendingUpdate` with a compare-and-set state machine using
    `UPDATE ... RETURNING`: never reopen a dismissal for the same target version,
    reopen only for a proven newer target, and handle `conflict` explicitly.
12. Fetch and normalize each target team once per detection pass, memoized by
    catalog item ID, version, and resource digest. Company loops perform DB
    comparisons against that result.
13. Make `reconcileTeamMembers()` repair only against the stored applied
    baseline. It must never import a newer catalog version behind the update
    workflow.
14. Roll out detection only. Team pending rows and notifications remain hidden
    until C2 exposes an actionable read-only diff endpoint. The update remains
    non-applicable until C2 lands.

### C2 - Structured Diff and Transactional Apply/Merge API

The diff must cover:

- name
- slug
- description
- manifest
- member additions
- member removals
- role changes
- agent override changes
- missing catalog dependencies
- founder-created or shared member conflicts

Each field or member decision is classified as:

- unchanged
- upstream-only
- local-only
- conflict

C2 owns the stable UI contract. Return a typed team-diff DTO with:

- `snapshotToken`
- `changeId`
- `group` (`metadata`, `member`, `dependency`)
- `classification`
- typed old and new values
- default decision and allowed decisions
- blocking reason
- affected member/dependency IDs

Do not encode team changes as free-form markdown sections. C3 may reuse the
existing dialog shell, but not the skill-oriented string-section decision model.

1. Allow one-click apply only when the stored baseline proves no local
   divergence.
2. Otherwise require reviewed merge decisions.
3. Default every conflict to preserve local founder state.
4. Acquire one shared per-team advisory lock for every team metadata, manifest,
   membership add/remove/role, reconcile, and marketplace apply mutation. This
   prevents update-vs-founder-write races, not only apply-vs-apply races.
5. Define `snapshotToken` as a digest of the baseline revision, relevant team
   fields, sorted memberships and roles, relevant agent revisions, and target
   catalog digest.
6. Update the team row, memberships, template version, baseline, pending update,
   and audit log in one transaction.
7. Add `team_update_applications`, keyed by client idempotency key, storing the
   target team, snapshot token, response, and before/after state. Use it for
   response-loss replay and explicit post-commit rollback.
8. Never delete founder-created agents.
9. Never delete shared agents merely because one team template removed them.
10. Make stale snapshots, retries, and response-loss replays safe.
11. Require founder authority for apply/merge. Team leads receive read-only diff
    access and a stable `founder_approval_required` 403 problem code.
12. Return problem, cause, and recovery instructions for every rejected update.
13. Define exact shared Zod contracts in `packages/shared/src/marketplace.ts`:
    - apply: `{ snapshotToken, idempotencyKey }`
    - merge: `{ snapshotToken, idempotencyKey, decisionsByChangeId }`
    - success response with application ID, applied version, replay flag, and
      structured outcome summary
    - problem response:
      `{ code, message, cause, recovery, retryable, details }`
14. Require the client to generate one idempotency key when the review opens and
    retain it across timeout, connection-loss, and other ambiguous retries.
15. Implement and document this HTTP/code matrix:

| Condition | HTTP | Code | Retryable |
|---|---:|---|---|
| pending update missing/dismissed | 404 | `team_update_not_found` | false |
| caller cannot mutate | 403 | `founder_approval_required` | false |
| local/target digest changed | 409 | `stale_snapshot` | true after refresh |
| required decision absent | 422 | `unresolved_conflict` | false |
| catalog agent/dependency absent | 422 | `missing_dependency` | true after resolution |
| key reused for different payload | 409 | `idempotency_key_reused` | false |
| catalog resource unavailable | 503 | `upstream_unavailable` | true |

16. Update `docs/api/marketplace-and-plugins.md`, narrow unknown API errors in the
    UI client through the shared problem schema, and add route contract tests for
    every matrix row.

### C3 - UI

1. Add a dedicated `TeamUpdateReviewDialog`, reusing the existing `Dialog`
   shell and marketplace visual vocabulary.
2. Link update notifications to
   `/<prefix>/marketplace-updates?update=<pending-update-id>`. Auto-open and
   focus the matching update; if it is stale or dismissed, show the updates
   list with a clear explanation.
   C3 also enables replay-safe notification emission using a unique source key
   containing pending-update ID and target version; notification creation and
   pending-update visibility use the same transaction/executor boundary.
3. Show team pending updates with accurate type labels and one primary action
   per state:

| State | Primary action |
|---|---|
| untouched and safely applicable | Update team |
| local/upstream conflict | Review changes |
| missing dependency | Resolve dependencies |
| stale snapshot | Refresh |
| unauthorized actor | Read-only detail and Ask founder |
| success | View team |

4. Render structured metadata and roster changes. Label comparisons "Current
   team" and "Marketplace version", not "Mine" and "Upstream".
5. Default conflicts to "Keep current team - recommended" and explain "Keeps
   your changes". Remove bulk upstream replacement or require an explicit
   destructive confirmation.
6. Show explicit list-error and diff-error states with `role="alert"`, Retry,
   and no false "all up to date" empty state. Disable apply until a valid,
   current snapshot is loaded.
7. Cover loading, empty, conflict, stale, partial dependency, unauthorized,
   success, and failure states. Success copy summarizes the outcome, for
   example "2 members added; 1 local role kept unchanged."
8. At widths below `sm`, stack update cards and diff choices, use a full-height
   review layout with a sticky action footer, and keep all targets at least
   44px.
9. Use semantic radio groups, visible focus, focus return to the originating
   card, and announced stale/error/success changes.

### Tests by PR

**C1**

- valid and invalid versioned `team.json`
- legacy input normalization
- unknown-provenance migration never claims today's catalog as a baseline
- installed-team detection
- dismissed same-version update stays dismissed; newer target reopens it
- concurrent detection and compare-and-set behavior
- company boundary enforcement
- target fetch memoization
- reconciliation uses the applied baseline, not the latest catalog

**C2**

- untouched team detection and one-click apply
- founder-edited metadata preserved
- upstream member addition
- upstream member removal without deleting the agent
- role and override changes
- founder-created same-name member
- shared member protection
- missing catalog dependency
- concurrent apply
- apply concurrent with founder metadata, membership, and role edits
- response-loss replay
- stale snapshot/version race
- transaction rollback
- post-commit rollback from a durable application record
- audit log and company boundary enforcement
- founder/team-lead authorization matrix and stable problem codes

**C3**

- structured metadata and roster diff
- preserve-local default rendering
- notification deep-link, auto-open, and stale fallback
- transactional notification deduplication by pending ID and target version
- keyboard and focus management
- mobile stacked/full-height layout and 44px targets
- list-error and diff-error states do not masquerade as empty/loading
- loading, empty, conflict, stale, partial dependency, success, and failure
  states

### Rollout

Keep `reconcileTeamMembers()` as a narrow repair safety net until the new update
path proves stable. Do not silently broaden it into a destructive synchronizer.
C1 may create hidden pending updates but cannot notify or apply them. C2 enables
the read-only diff and server-side application only after its concurrency and
rollback tests pass. C3 makes pending rows visible, emits notifications, and
exposes the reviewed user flow.

## Gate D - Phase 5 Embedded PostgreSQL Port Sweep

The roadmap count is stale. Current `origin/main` contains 45 integration suites
with module-level random embedded PostgreSQL port allocation. One additional
suite already uses `allocateEmbeddedPgPort()` but still contains unrelated random
test identifiers.

### Implementation

1. Replace the probe-only allocator with
   `startEmbeddedPostgresWithAllocatedPort(options)`. It allocates, initializes,
   and starts the server as one helper operation and performs bounded
   reallocation on a verified bind collision. A closed probe socket alone does
   not eliminate the TOCTOU race.
   The helper returns `{ postgres, port, stop }`, attempts at most five ports,
   treats only verified bind collisions as retryable, and exposes an idempotent
   `stop()` that the owning suite calls from `afterAll`.
2. Add
   `server/src/__tests__/embedded-pg-port-helper.test.ts` and
   `server/src/__tests__/embedded-pg-port-hygiene.test.ts`. The first starts
   multiple clusters in parallel and proves unique bound ports plus cleanup on
   partial failure; the second rejects fixed random ports in integration suites.
3. Use the start helper in all 45 affected suites.
4. Delete module-level fixed random port constants.
5. Return the selected port from the helper. Ten suites need it after startup:
   the eight `hub-*` suites plus the two MCP connector end-to-end suites.
   Prefer UUIDs for unrelated run/test identifiers in the MCP suites; otherwise
   use a module-level `let port = 0`.
6. Remove obsolete offset comments.
7. Add a hygiene meta-test that rejects fixed random embedded PostgreSQL ports in
   future integration suites.

### Verification

1. On Windows, run:
   `pnpm exec vitest run --config server/vitest.config.ts server/src/__tests__/embedded-pg-port-helper.test.ts server/src/__tests__/embedded-pg-port-hygiene.test.ts`.
2. Run typecheck and all cross-platform unit tests locally.
3. Treat Linux CI as the load-bearing proof because Windows skips embedded
   PostgreSQL integration suites.
4. In Linux CI, run the helper stress test 20 times plus the full integration
   shard. Any verified bind collision after helper retries fails the PR and must
   be diagnosed; it is not cleared by an unspecified rerun.

### Exit Criteria

- No affected suite declares a fixed random PostgreSQL port.
- All affected suites start through the retrying helper.
- The parallel allocator stress test is green.
- The hygiene test is green.
- Linux integration CI is green.
- No production file is changed.

## Cross-cutting Failure Modes

| Failure | User impact | Prevention | Recovery |
|---|---|---|---|
| Deploy wrong SHA | Testing does not contain reviewed fixes | Verify image SHA in workflow log | Redeploy exact prior SHA |
| Catalog refresh races boot | Old category counts remain | Refresh after server is healthy | Manual refresh, then rerun repair |
| Connector schema drift | Published entries disappear | Shared schema or drift test | Revert CDN artifact |
| Wrong auth classification | Connector card cannot install | Per-entry primary-source verification | Mark unavailable or remove entry |
| Team false-negative customization | Founder edits overwritten | Baseline proof and preserve default | Use the durable application record to restore prior state |
| Team member removal deletes agent | Founder loses reusable agent | Remove membership only | Restore membership from audit/baseline |
| Duplicate pending update | Repeated notifications and races | Unique key plus transaction/lock | Seal duplicate operation |
| Committed bad team update | Founder state remains wrong after transaction succeeds | Durable before/after application record | Execute audited rollback under the same team lock |
| Random database port collision | Intermittent CI failure | Start-and-retry allocator, stress test, hygiene test | Inspect bind diagnostics before rerun |

## Required Verification Before Each Handoff

For every AoA code PR:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Run targeted tests before the full gate. Report every skipped test and why.

For marketplace code:

- run aggregate
- run validate
- run catalog tests
- inspect generated artifacts
- run the publication workflow in dry-run or non-publishing mode

## Contributor Pickup Table

Repository bases must be rechecked immediately before branching; these are the
verified 2026-07-28 starting points.

| Work | Repository/base | Branch | Owned modules | Prerequisite | Primary verification | Handoff artifact |
|---|---|---|---|---|---|---|
| A0 | AoA `3aa78b77539706957f28105c3656e4562a267ecc` | `codex/testing-deploy-reconcile` | deploy workflow, marketplace/crew maintenance route/service, tests/docs | none | targeted contracts + full AoA gate | exact-SHA runbook and response example |
| D | AoA same base, rebased after A0 | `codex/embedded-pg-port-sweep` | integration tests and test helper only | A0 merged | helper/hygiene tests + Linux integration shard | affected-suite inventory |
| B0 | AoA after A0 | `codex/connector-contract-amendment` | architecture decisions and connector contract bundle | none | contract generation + conformance test | contract SHA256 manifest |
| B1 | aoa-marketplace `3b312e7dbb6869ae7895d29b2ac4763eec70d29b` | `codex/connectors-catalog` | connector content, aggregate/validate, docs, publish workflow | B0 contract bundle | aggregate, validate, tests, dry-run publisher | `connectors.json` SHA256 |
| Publication | aoa-marketplace-cdn `926381037c30041474339f68aaf0e767433ee312` | workflow-created reviewed commit | `connectors.json` only | B0+B1 merged | CDN diff + HTTP smoke | CDN commit and rollback SHA |
| C1 | AoA after A0 | `codex/team-update-baseline-detection` | shared schema, DB migration, detection/reconcile, tests | none | migration + detection/concurrency tests + full gate | schema/baseline contract |
| C2 | AoA after C1 | `codex/team-update-apply-api` | shared API, team mutation service/routes, audit/rollback, docs/tests | C1 merged | route/state/race/replay tests + full gate | HTTP/error matrix |
| C3 | AoA after C2 | `codex/team-update-review-ui` | marketplace update UI/client/tests | C2 merged | UI unit/a11y/responsive tests + full gate | route/state evidence |

## Not in Scope

- Long-tail external connector registry search
- OAuth connector installation
- Combining AoA crew with organization agents in one UI list
- Bypassing unfinished onboarding state
- Phase 6 viewer polish
- Phase 7 workspace reference ingress or TTL lifecycle
- Phase 3c package-imported skill ownership decision
- General marketplace redesign

## Execution Order

1. Gate A0 operations PR.
2. Gate A exact-SHA recovery deployment and verification.
3. Gate D immediately after Gate A so later PRs receive a cleaner CI signal.
4. Gate B0, then Gate B1 marketplace content and builder.
5. Gate B publication after B0 and B1 merge.
6. Gate C1 -> C2 -> C3 as serialized AoA PRs.
7. Re-evaluate Chronicler legacy origin, catalog-contract hardening, Phase 6, and
   Phase 7 after these gates are banked.

## What Already Exists

| Capability | Existing implementation | Plan treatment |
|---|---|---|
| Connector snapshot and fallback | `scripts/fetch-bundled-connectors.ts`; `createConnectorCatalogService` snapshot precedence | Verify, do not rebuild |
| Connector trust/parser safety | `McpConnectorCatalogEntrySchema`, raw alias checks, reserved names, duplicate-ID drop | Export a versioned conformance bundle |
| Marketplace update rows | `marketplace_pending_updates` plus current skill/plugin checker | Replace the unsafe upsert state machine and add team target identity |
| Team install/reconcile | `team-installer.ts`; narrow `reconcileTeamMembers()` | Validate with the new schema; make reconcile baseline-only |
| Skill merge UI | `SnapshotUpdateModal`, `MergeDiffPane`, `Dialog` | Reuse dialog shell only; team diff is a typed flow |
| Embedded PostgreSQL helper | `allocateEmbeddedPgPort()` | Replace probe-only behavior with start-and-retry ownership |
| Testing deploy | Manual `deploy-testing.yml` | Add exact-SHA input and rollback symmetry |

## Dream State Delta

After these gates, testing is reproducibly deployable, the curated connector
shelf has an owned publication contract, team updates cannot overwrite founder
changes without proof and review, and integration suites no longer rely on a
probabilistic port convention. The remaining 12-month delta is OAuth connector
installation, parameterized Filesystem installs, long-tail connector discovery,
automatic connector revocation/demotion handling, and broader marketplace
update UX consolidation.

## Architecture Review

### System Architecture

```text
GitHub Actions A0/A
  deploy_sha -> ancestry + CI proof -> exact image -> testing health
                                      |
                                      v
                    instance-admin reconcile operation
                    catalog sync -> crew repair -> Steward pass -> team repair

AoA connector contract bundle --pinned SHA/digest--> aoa-marketplace validator
                                                        |
                                                        v
                                             immutable connectors.json
                                                        |
                                      protected workflow / reviewed CDN commit
                                                        |
                                                        v
AoA bundled snapshot <- fallback <- remote connector catalog <- testing shelf

catalog team.json -> C1 schema/baseline/detection -> hidden pending update
                                                -> C2 typed diff/apply/rollback API
                                                -> C3 review dialog + notification
```

### Data Flow and Shadow Paths

```text
TEAM TARGET
  -> fetch once
     | missing/timeout -> upstream_unavailable, no state mutation
     v
  -> MarketplaceTeamTemplateSchema
     | invalid/empty -> reject target, actionable validation log
     v
  -> compare baseline + locked live team + target
     | baseline unknown -> all risky fields conflict/preserve
     | no changes -> no pending row
     v
  -> CAS pending state
     | same dismissed version -> remain dismissed
     | concurrent winner -> return winner row
     v
  -> typed diff -> founder decisions -> locked transaction
     | stale snapshot -> 409, refresh
     | dependency missing -> 422, preserve live state
     | response lost -> replay stored application response
     v
  -> team + membership + baseline + audit committed
     | bad committed result -> audited rollback from before-state
```

### Team Update State Machine

```text
                 newer target
  absent/dismissed -----------> detected_hidden
        ^                           |
        | same target dismissed     | C2 read API ready
        |                           v
     dismissed <------------- reviewable
                                |   |
                  conflict      |   | baseline proves untouched
                                v   v
                           needs_review -----> safely_applicable
                                |                    |
                                +------ apply -------+
                                           |
                                           v
                                        applied

Invalid transitions:
- detected_hidden -> apply: blocked until C2 and valid snapshot
- stale snapshot -> applied: blocked by digest check
- non-founder -> mutation: blocked with founder_approval_required
- same idempotency key + different payload: blocked with 409
```

### Deployment and Rollback

```text
A0 merge -> required CI green -> dispatch reviewed SHA -> protected testing job
-> image reports SHA -> health -> admin reconcile -> route matrix evidence
-> keep deployment

Any verified regression
-> dispatch recorded prior SHA through the same workflow
-> health -> reconcile only if catalog state requires it
-> attach failed/new and restored/prior evidence to the incident/PR
```

## Error and Rescue Registry

| Codepath | Failure | Rescue/action | User/operator sees |
|---|---|---|---|
| deploy SHA validation | SHA missing, not on main, or CI red | fail before build | failed workflow with exact reason |
| admin reconcile | one company repair fails | continue other companies; return per-company failure | partial result, operation ID, retry guidance |
| connector aggregate | invalid entry or contract drift | fail nonzero; write no artifact | file, JSON pointer, code, cause, fix |
| connector publish | digest mismatch | fail before CDN mutation | expected/actual digest |
| connector runtime fetch | timeout/malformed remote | serve valid cache/snapshot and log staleness | stale badge or empty-state recovery |
| team target fetch | unavailable | no pending/apply mutation | `upstream_unavailable`, retry |
| team diff | baseline unknown | classify risky changes as conflicts | preserve-local defaults |
| team apply | snapshot stale | abort before mutation | `stale_snapshot`, Refresh |
| team apply | missing dependency | abort before mutation | dependency list and recovery |
| team apply | response lost | replay durable response by key | same application result |
| team apply | bad committed result | lock and restore before-state | audited rollback result |
| embedded PostgreSQL start | bind collision | clean partial attempt; retry up to five | final diagnostic if exhausted |

No planned row is both silent, untested, and unrescued.

## Test Coverage Diagram

```text
Gate A0/A
  [contract] deploy_sha required / ancestry / CI / exact image
  [route] instance-admin only / partial company failure / replay
  [live] health / artifact partitions / roster / org agents / onboarding

Gate B
  [unit] schema + conformance corpus + trust + duplicates + aliases
  [integration] all-or-nothing aggregate; no artifact on rejection
  [E2E] local shelf -> install -> bind -> invoke
  [workflow] dry_run digest -> protected publish -> CDN smoke -> rollback

Gate C1
  [migration] unknown provenance / partial uniqueness / DB checks
  [unit] v1 normalization / role + override allowlist
  [integration] detection CAS / dismissal / memoized fetch / baseline repair

Gate C2
  [unit] classifications / DTO / snapshot digest / problems
  [integration] apply vs apply / apply vs founder write / rollback / replay
  [route] founder + team-lead matrix / every HTTP error code

Gate C3
  [component] action matrix / explicit errors / preserve defaults
  [a11y] radio semantics / focus / alerts / 44px targets
  [responsive] stacked cards / full-height review / sticky footer
  [E2E] notification deep-link -> review -> retry/replay -> View team

Gate D
  [unit] collision retry / cleanup / stop idempotency
  [stress] parallel cluster starts x20 on Linux
  [meta] no fixed random ports
  [integration] full Linux shard
```

The hostile tests are apply-vs-founder-write, idempotency-key reuse with a
different payload, a producer entry containing a secret-bearing alias, and a
forced bind collision during parallel cluster startup. The chaos tests are a
catalog timeout during detection, process response loss after team commit, and
partial cluster startup failure.

## Design Review

### Scores

| Pass | Before | After | Resolution |
|---|---:|---:|---|
| Information architecture | 6 | 9 | dedicated team review dialog and direct notification route |
| Interaction states | 5 | 9 | explicit action/error/stale/auth/success matrix |
| User journey | 4 | 9 | pending ID deep-link, focus, fallback, and View team |
| AI-slop risk | 8 | 9 | existing calm app shell; team-specific utility copy |
| Design system fit | 7 | 9 | reuse Dialog and marketplace vocabulary, not skill diff internals |
| Responsive/accessibility | 4 | 9 | mobile stack, 44px targets, semantic choices, focus/alerts |
| Unresolved decisions | 5 | 10 | DTO, copy, actions, destructive confirmation all specified |

Litmus: product is clear, each view has one primary job, cards are used only for
update records, motion is not required for comprehension, and the review remains
useful without decorative shadows. The post-implementation gate is a live
`/design-review` of C3.

## Developer Experience Review

### Target Persona

**Who:** an AoA maintainer or new contributor shipping a cross-repo marketplace
or operations change.
**Context:** they pick up one PR lane from this plan and must prove it locally and
in CI without access to the prior conversation.
**Tolerance:** ten minutes to identify the owned files, first command, expected
output, and rollback unit.
**Expects:** pinned bases, exact commands, stable error codes, a dry-run path,
and a handoff artifact.

### Developer Perspective

I open the plan because testing is missing marketplace surfaces. The original
version tells me to deploy an exact SHA, but the workflow has no SHA input, so my
first “safe” command cannot do what the runbook claims. It also tells me to
refresh and repair, but those operations live in different startup paths. I
would either trust timing or start reading `server/src/index.ts`. The reviewed
plan fixes that first: A0 gives me one exact deploy command and one authorized
reconcile call with an operation ID. For connector work, I no longer have to
guess which of two schema-sharing ideas won. I pin one contract bundle, run its
conformance corpus, and aggregation writes nothing if any entry fails. For team
updates, every retry uses one retained idempotency key and every rejection has a
stable code and recovery. For the port sweep, the helper owns startup, cleanup,
and retry, and the plan names the Windows and Linux proof. I can now tell what
worked, what failed, and what to do next without reconstructing the prior session.

### Benchmark and Target

| Reference | Useful pattern | Plan adoption |
|---|---|---|
| GitHub Actions environments | required reviewers/protection before deploy | protected connector publication and testing deploy |
| Stripe idempotent requests | client key enables safe ambiguous retry | durable team-application replay |
| RFC 9457 problem details | machine-readable problem plus recovery context | typed team update problem envelope |
| Current AoA plan before review | first safe proof required code archaeology | estimated 20+ minutes |
| Reviewed target | pinned pickup to first valid check | under 10 minutes |

The developer "magical moment" is deterministic proof: the first dry run prints
the exact source SHA, artifact digest, validation result, and next command.

### Journey Map

| Stage | Contributor does | Friction removed |
|---|---|---|
| Discover | selects one row in the pickup table | no cross-repo scope ambiguity |
| Install | uses existing pnpm 9.15.4 workspace | package-manager guard remains authoritative |
| First proof | runs the named targeted command | expected artifact/error contract is specified |
| Real use | opens PR with handoff artifact | reviewer sees digest, route matrix, or test inventory |
| Debug | follows stable code/cause/recovery | no unknown response parsing or silent partial output |
| Upgrade/rollback | uses pinned SHA and recorded prior artifact | same workflow handles forward and reverse |

### First-time Confusion Report

```text
T+0:00  Pick a lane from the contributor table.
T+1:00  Confirm base SHA and prerequisite PR.
T+3:00  Run targeted contract/helper test.
T+6:00  Inspect generated digest or typed error.
T+9:00  Know whether to proceed, retry, or stop; attach handoff artifact.
```

### DX Scorecard

| Dimension | Before | After |
|---|---:|---:|
| Getting started | 4 | 8 |
| API/workflow design | 5 | 9 |
| Error messages/debugging | 3 | 9 |
| Documentation/learning | 4 | 8 |
| Upgrade/rollback path | 5 | 9 |
| Developer environment/tooling | 5 | 8 |
| Community/contribution pickup | 5 | 8 |
| Measurement/feedback | 4 | 8 |

Target time to first valid proof: under 10 minutes. After implementation, run
`/devex-review` on the A0 and connector authoring flows.

### DX Implementation Checklist

- [ ] Exact source SHA and artifact digest appear in every deploy/publish run.
- [ ] Dry-run makes no external mutation.
- [ ] Invalid connector content writes no output artifact.
- [ ] Every team update error provides code, cause, recovery, and retryability.
- [ ] Ambiguous team retries reuse the same idempotency key.
- [ ] API and connector authoring docs contain copy-paste commands.
- [ ] Windows shows deterministic unit/hygiene proof; Linux owns integration proof.
- [ ] Every PR hands off the artifact named in the contributor table.

## Cross-phase Themes

1. **Determinism over timing:** CEO, engineering, and DX reviews all found flows
   that relied on mutable counts, boot order, auto-publish, or random ports.
2. **Explicit contracts across boundaries:** design, engineering, and DX reviews
   all required typed DTOs, stable problems, pinned connector conformance, and
   exact artifact identity.
3. **Founder-state preservation:** CEO, design, and engineering reviews all
   rejected any team update path that cannot prove its baseline or defaults to
   upstream replacement.
4. **Independent rollback units:** all phases converged on A0, D, B0/B1, and
   C1/C2/C3 as separate PRs.

## Implementation Tasks

- [ ] **T1 (P1)** - A0 - add exact-SHA testing deployment and authorized reconcile operation.
- [ ] **T2 (P1)** - D - replace probe-only port allocation and sweep integration suites.
- [ ] **T3 (P1)** - B0 - amend Decision #116 and export the connector contract bundle.
- [ ] **T4 (P1)** - B1 - build, validate, document, and dry-run publish the named connector set.
- [ ] **T5 (P1)** - C1 - add marketplace team schema, baselines, pending identity, and hidden detection.
- [ ] **T6 (P1)** - C2 - add locked diff/apply/replay/rollback API and problem contracts.
- [ ] **T7 (P1)** - C3 - add the accessible team update review journey and notification links.
- [ ] **T8 (P2)** - post-ship - run design and DX boomerang reviews on rendered/operational behavior.

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | Intake | Split operational recovery and three code tracks | Mechanical | Independent rollback | Each track has a different blast radius and verification surface | One giant PR |
| 2 | Connectors | Keep separate connector artifact | Mechanical | Preserve contract | AoA already consumes a fail-closed connector-specific schema | Fold into catalog items |
| 3 | Team updates | Preserve founder changes by default | Mechanical | Prevent data loss | Unknown or customized state is not safe to overwrite | Upstream wins |
| 4 | Test infrastructure | Keep Phase 5 production-free | Mechanical | Minimize blast radius | Port allocation is only a CI concern | Mix with runtime changes |
| 5 | CEO review | Delete connector read-side implementation from scope | Mechanical | Reuse shipped code | Snapshot fetch and fallback shipped in `19fba089` | Rebuild B1 |
| 6 | CEO review | Split team updates into C1/C2/C3 | Product-shaped | Limit blast radius | Persistence/detection, mutation, and UI have independent rollback and proof | One large team-update PR |
| 7 | CEO review | Run Phase 5 before feature PRs | Mechanical | Improve signal | Removing port collisions strengthens every later Linux CI result | Leave it last |
| 8 | CEO review | Pin Gate A to catalog artifact identity | Mechanical | Avoid mutable assertions | Counts can change legitimately during deploy | Treat observed counts as immutable |
| 9 | Design review | Make C2 own a typed team-diff DTO | Mechanical | Stable UI contract | The existing skill string-section model cannot represent roster/dependency decisions safely | Teach C3 to parse free-form sections |
| 10 | Design review | Deep-link notifications by pending update ID | Mechanical | Coherent journey | A generic marketplace route loses the update the notification refers to | Generic `/marketplace` link |
| 11 | Design review | Use a dedicated team review dialog | Product-shaped | Make preservation legible | Team roster/role decisions need team language, action states, and mobile behavior | Reuse the skill merge pane unchanged |
| 12 | Eng review | Persist explicit per-team baselines | Mechanical | Prove customization | Live team state and today's catalog cannot reconstruct the last applied upstream | Infer baseline during detection |
| 13 | Eng review | Share one lock across every team mutation | Mechanical | Prevent lost updates | A transaction in apply cannot exclude concurrent founder writes | Lock apply only |
| 14 | Eng review | Hide detection until an actionable read surface exists | Product-shaped | Avoid dead UI | Current UI offers actions whose team routes return 501/404 | Emit C1 notifications immediately |
| 15 | Eng review | Make connector publication manual and artifact-pinned | Mechanical | Preserve approval gate | The current marketplace workflow publishes on merge to `main` | Extend automatic publisher |
| 16 | Eng review | Remove Filesystem from launch content | Mechanical | Avoid unsafe static paths | Catalog install cannot bind a founder-approved contained workspace path | Publish a fleet-wide hard-coded path |
| 17 | Eng review | Start embedded PostgreSQL with bind-collision retry | Mechanical | Eliminate the actual flake | Probe-then-close retains a TOCTOU race | Sweep callers around the existing probe only |
| 18 | DX review | Add A0 exact-SHA deploy and maintenance controls | Mechanical | Executable runbook | The current workflow cannot select/rollback a SHA and sync does not rerun repair | Depend on boot timing and `github.sha` |
| 19 | DX review | Version a cross-repo connector contract bundle | Mechanical | Fight uncertainty | Schema-only duplication misses parser prechecks and drifts silently | Copied happy-path fixture |
| 20 | DX review | Standardize team update problem responses | Mechanical | Actionable errors | Stable codes and recovery text let the UI distinguish refresh, conflict, dependency, and auth failures | Parse unknown response bodies ad hoc |
| 21 | DX review | Pin every repo and handoff artifact | Mechanical | Reproducible pickup | Cross-repo work otherwise depends on unstated base commits and commands | Pin AoA only |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---:|---|---|
| CEO Review | `/autoplan` | Scope and sequencing | 1 | CLEAR | 7 findings folded; deleted redundant connector work and split team delivery |
| Codex Review | Codex CLI outside voice | Independent model | 1 attempted | UNAVAILABLE | Authenticated, but account quota exhausted until 2026-08-03 |
| Eng Review | `/autoplan` | Architecture, data safety, tests | 1 | CLEAR | 10 findings folded; explicit baseline, shared lock, publication gate, port retry |
| Design Review | `/autoplan` | Team-update UX | 1 | CLEAR | 8 findings folded; 6/10 to 9/10 overall |
| DX Review | `/autoplan` | Operator and contributor experience | 1 | CLEAR | 8 findings folded; 4/10 to 8/10 overall |

**CROSS-MODEL:** Independent review agents converged on deterministic operations,
explicit cross-boundary contracts, founder-state preservation, and smaller rollback
units. Codex CLI produced no verdict because its quota was exhausted.

**VERDICT:** CEO + DESIGN + ENG + DX CLEARED. Founder approved all recommendations
on 2026-07-28; implementation may begin with A0.

NO UNRESOLVED DECISIONS
