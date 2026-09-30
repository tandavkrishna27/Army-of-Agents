<!-- /autoplan restore point: C:\Users\TK\.gstack\projects\AoA-main\codex-testing-marketplace-recovery-autoplan-restore-20260728-172030.md -->

# Testing Marketplace Recovery Incident Plan

**Date:** 2026-07-28
**Repository:** `MeteoriteLabs/AoA`
**Environment:** `https://testing.armyofagents.org`
**Reviewed base:** `32983b769a6fe4741b4e8144d42797048c095b53`
**Scope:** A1 operability, evidence capture, A2 root-cause repair

## Outcome

Restore both testing companies to a complete, marketplace-managed default crew
without duplicate agents, teams, or skills. The repair must survive a container
restart and a second forced reconciliation must be a no-op.

This document is an incident plan, not a roadmap. Connector publication,
team-template product work, and embedded PostgreSQL test hygiene are split into:

- `docs/aoa/plans/2026-07-28-connector-catalog-product-gate.md`
- `docs/aoa/plans/2026-07-28-team-template-update-discovery.md`
- `docs/aoa/plans/2026-07-28-embedded-pg-port-sweep.md`

The prior umbrella is retained only as historical context under
`docs/aoa/plans/archive/2026-07-28-testing-marketplace-recovery-and-followups-umbrella.md`.

## Live Incident Evidence

1. PR `#311` is merged. Testing is healthy on exact revision
   `32983b769a6fe4741b4e8144d42797048c095b53`.
2. Testing's loaded catalog identity and counts match the public
   `catalog.json`.
3. Reconciliation operation
   `9e9ebe10-92a5-4b4d-afa5-319e01925f07` returned:
   - `status: "partial"`
   - 2 companies examined
   - 0 repaired
   - `skippedFailClosed: 2`
   - no thrown `failures`
4. Both companies still have 10 AoA agents. Reviewer is absent, no default crew
   team is present, Steward and Chronicler retain NULL origins, and all 17 crew
   skills are absent.
5. The response and completion audits expose skip counters but not the guarded
   reason or diagnostic cause.
6. An instance-admin board key works only when the caller fabricates a browser
   Origin header because `board-mutation-guard.ts` treats `board_key` like a
   cookie-backed browser session.
7. `managedMarketplaceSkillsRoot()` resolves below `process.cwd()`
   (`/app/.aoa/marketplace-skills` in Docker), while the image persists `/aoa`.
   Managed bundles therefore have a confirmed restart-durability defect even if
   it is not the immediate cause of the two skips.

## Confirmed Premises

1. Only an authenticated board actor with `source === "board_key"` bypasses the
   Origin/Referer check. Browser sessions keep the existing CSRF protection.
2. Every aggregate reconciliation skip must have one safe, structured,
   company-scoped diagnostic in the response and matching completion audit.
3. Raw exception strings are server-log material. Public/audit diagnostics use
   allowlisted codes and context only.
4. A1 changes authentication semantics and observability, not repair decisions.
5. A2 is selected from the A1 rerun evidence. The persistent-root defect is
   fixed in A2 regardless of whether it is the immediate skip cause.
6. Founder bytes are never silently overwritten. No recovery shortcut may
   clear a customized flag, invent an installed inventory, or bypass the
   marketplace-skills containment jail.
7. The operator must not extract, paste, print, or otherwise handle a stored
   board token after login. The CLI is the supported recovery client.
8. From an already-authenticated CLI, time to a typed recovery verdict is at
   most five minutes. A timeout is not a verdict; it must leave an operation ID
   that can be inspected safely.

## Delivery Boundary

| PR | Purpose | May change repair behavior? | Deploy gate |
|---|---|---:|---|
| A1 | Board-key/CLI operability, durable inspection, and structured diagnostics | No | security tests, diagnostic invariants, full verify |
| A2 | Reproduce and fix the observed cause; persist managed bundles | Yes, reason-specific only | Linux CI, Docker restart proof, live forced reconcile |

A1 and A2 remain separate. A1 must deploy before A2's cause-specific repair is
finalized because its diagnostic output selects that branch.

## CEO Review - Strategy and Scope

### Premise Challenge

| Premise | Verdict | Evidence |
|---|---|---|
| This is an incident, not a marketplace roadmap | confirmed | 2/2 companies remain degraded after the deployed recovery operation |
| Operability precedes behavior changes | confirmed | current response loses the reason behind both fail-closed skips |
| A1 and A2 must be separate | confirmed | A2's correct branch is unknowable until A1 returns typed evidence |
| Persistent storage is incident scope | confirmed | Docker persists `/aoa`, while managed bundles resolve below `/app` |
| Fully offline first-party packaging is incident scope | rejected for now | valuable architecture direction, but broader than the proven restart and repair failure |

### What Already Exists

| Need | Existing leverage | Treatment |
|---|---|---|
| Credential-source identity | `actorMiddleware` emits `source: "board_key"` after DB validation | reuse as the exact guard boundary |
| Browser mutation protection | `boardMutationGuard` already handles safe methods, local implicit actors, Origin, and Referer | add one source-specific branch; preserve the rest |
| Guarded repair reasons | `CrewRepairResult` carries `reason` and `detail` | retain internally; replace string-only skill-install cause with typed diagnostics |
| Fleet aggregation | `runCrewRepairPass` owns counters and company loop | collect skips at the counter increment sites |
| Public operation contract | `MarketplaceReconcileResponse` and per-company activity audit | extend POST and add one read-only inspection endpoint over the same operation |
| Operation correlation | reconciliation already emits a stable `operationId` | propagate into full-error structured logs |
| Managed-path jail | `managed-skills-root.ts` centralizes containment and case probing | move the resolver once; keep callers on the shared boundary |
| Atomic bundle replacement | marketplace materialization already stages and renames | preserve while relocating to persistent storage |

### Implementation Alternatives

| Approach | Effort | Incident value | Risk | Decision |
|---|---:|---:|---:|---|
| Guess the likely filesystem cause and patch it immediately | low | uncertain | high: hides another cause and repeats blind operation | rejected |
| A1 typed diagnostics, then A2 evidence-selected repair plus persistence | medium | high | bounded and reversible | selected |
| Bundle every first-party crew resource into the image and remove CDN dependency | high | potentially high | broad packaging/versioning change during incident | defer to architecture follow-up |
| Return raw error text to the admin endpoint | low | high short-term | durable secret/path disclosure risk | rejected |

### Temporal Interrogation

```text
DAY 1      A1 contracts, guard, durable inspection, and CLI
DAY 2      A1 fetch/root hardening, scripts, docs, and full verification
DAY 3      A1 CI/review, exact-SHA deploy, diagnostic run, evidence capture
DAY 4      A2 exact reproduction and evidence-selected repair
DAY 5+     A2 persistence, fencing, Linux chaos gate, and review
DEPLOY 2   restart/recreation proof and two-pass incident closure
```

The stop condition is explicit: if A1 cannot classify both live skips without
raw details, A2 does not start. If A2 cannot reproduce the observed code, it
does not mutate repair behavior.

### Dream State Delta

This incident leaves AoA with a bearer-key-operable fleet recovery endpoint,
auditable company-level diagnostics, and restart-durable managed bundles. The
12-month ideal additionally makes first-party crew provisioning independently
available from a signed, content-addressed release artifact, uses the public CDN
only as an update channel, validates required inventory at boot, and alerts
before a founder discovers a degraded crew. That broader packaging platform is
not smuggled into A2.

### CEO Dual-voice Consensus

| Dimension | Independent reviewer | Codex reviewer | Consensus |
|---|---|---|---|
| Umbrella plan was over-broad | split incident from B/C/D | split into four programs | confirmed and applied |
| Recovery is the immediate problem | A1/A2 first | A1/A2 first | confirmed |
| Product metrics belong in connector/team plans | required | required | confirmed; moved out |
| General offline crew packaging belongs in incident | required | not raised as incident blocker | disagreement; deferred as explicit architecture follow-up |
| Exact-SHA deployment is the long-term ideal | not challenged | prefer immutable image promotion | long-term follow-up; A0 is already shipped |

### CEO Completion Summary

Mode: selective expansion. The original umbrella was rejected because incident
recovery, connector product validation, team-template product discovery, and
test-infrastructure hygiene have different evidence and exit criteria. The user
accepted the split. A1/A2 keep only the work required to produce a trustworthy
diagnosis, repair the evidence-selected cause, and prove storage durability.

The review added no UI/product surface and did not broaden crew policy. General
offline first-party packaging and immutable image promotion remain explicit
post-incident architecture choices. CEO review exits with zero unresolved
incident-scope decisions.

## Architecture

```text
INSTANCE-ADMIN CALLER
  |
  | Authorization: Bearer <board key>
  v
actorMiddleware
  |-- invalid/revoked key ----------------------------> 401/403
  `-- board + source=board_key
         |
         v
boardMutationGuard
  |-- board_key --------------------------------------> allow without Origin
  |-- session + trusted Origin/Referer ---------------> allow
  `-- session + missing/untrusted Origin/Referer -----> 403
         |
         v
POST /api/admin/marketplace/reconcile
  |
  v
runMarketplaceReconciliation
  |-- snapshot fleet + durable start audit
  |-- fresh guarded CDN catalog
  |-- crew repair pass
  |     |-- repaired
  |     |-- skipped -> typed internal diagnostic
  |     `-- thrown  -> failures[]
  |-- legacy Steward / update / team reconciliation
  `-- completed audit + public response
            |
            `-- skips[] contains only safe mapped diagnostics
```

After A2:

```text
catalog resource
  -> stage bundle under persisted AOA_HOME
  -> validate inventory and containment
  -> atomic rename
  -> persist DB row/inventory
  -> reconcile crew transaction
  -> restart container
  -> validate materialized inventory
  -> forced second pass = no-op
```

## A1 - Make Reconciliation Operable

### A1.1 Board-key Mutation Semantics

Change `server/src/middleware/board-mutation-guard.ts` only after authentication:

```ts
if (
  req.actor.type === "board" &&
  (req.actor.source === "local_implicit" ||
   req.actor.source === "board_key")
) {
  next();
  return;
}
```

Do not exempt all bearer requests, all board actors, or instance admins. The
credential source is the boundary: a board key is explicitly attached by the
caller and is not ambient browser authority; a session cookie is ambient and
still requires same-origin proof.

### A1.2 Strict Shared Wire Contract

Add strict Zod schemas plus inferred public types in
`packages/shared/src/marketplace.ts`. TypeScript interfaces alone are not a
serialization boundary:

```ts
const MarketplaceReconcileRequestSchema = z.object({
  scope: z.literal("fleet"),
  mode: z.literal("repair"),
  operationId: z.string().uuid(),
  retryOfOperationId: z.string().uuid().optional(),
}).strict();

type MarketplaceReconcileSkipCategory =
  | "fail_closed"
  | "cooldown"
  | "over_budget";

type MarketplaceReconcileDiagnosticCode =
  | "install_in_flight"
  | "team_item_not_in_catalog"
  | "team_template_unavailable"
  | "empty_roster"
  | "unadoptable_roster_member"
  | "unaccounted_crew_rows"
  | "skill_resource_temporarily_unavailable"
  | "skill_resource_fetch_failed"
  | "skill_resource_invalid"
  | "skill_bundle_materialization_failed"
  | "skill_bundle_missing"
  | "skill_filesystem_permission_denied"
  | "repair_cooldown"
  | "repair_budget_exhausted"
  | "unknown_fail_closed";

type MarketplaceReconcileFailureCode =
  | "marketplace_update_failed"
  | "crew_repair_failed"
  | "legacy_steward_failed"
  | "crew_update_failed"
  | "team_reconcile_failed"
  | "unknown_internal_failure";

type MarketplaceReconcileErrorCode =
  | "invalid_request"
  | "authentication_required"
  | "instance_admin_required"
  | "operation_not_found"
  | "operation_in_flight"
  | "catalog_temporarily_unavailable"
  | "catalog_refresh_failed"
  | "outcome_unknown_after_mutation"
  | "internal_error";

interface MarketplaceReconcileSkip {
  companyId: string;
  stage: "crew_repair";
  category: MarketplaceReconcileSkipCategory;
  reason: MarketplaceReconcileDiagnosticCode;
  message: string;
  retry: MarketplaceRetryInstruction;
  context?: {
    catalogItemId?: string;
    httpStatus?: number;
    filesystemOperation?: "read" | "write" | "rename" | "mkdir";
  };
}

interface MarketplaceReconcileFailure {
  companyId: string;
  stage: MarketplaceMaintenanceStage;
  code: MarketplaceReconcileFailureCode;
  message: string;
  retry: MarketplaceRetryInstruction;
  occurrences?: number;
}

interface MarketplaceReconcileDiagnostic {
  scope: "operation";
  stage: MarketplaceMaintenanceStage;
  code:
    | "crew_catalog_not_ready"
    | "legacy_steward_disabled"
    | "legacy_steward_catalog_not_ready";
  message: string;
  retry: MarketplaceRetryInstruction;
}

interface MarketplaceReconcileErrorResponse {
  ok: false;
  error: {
    code: MarketplaceReconcileErrorCode;
    message: string;
  };
  operationId: string | null;
  retry: MarketplaceRetryInstruction;
  docUrl: string;
}
```

`MarketplaceRetryInstruction` is a discriminated union with
`kind: "immediate" | "after" | "after_correction" | "inspect_first" |
"never"`, an allowlisted `recoveryCode`, and `notBefore` only for `after`.
There is one checked-in mapping table from every public diagnostic/error code
to message and retry instruction. A boolean `retryable` is rejected because it
cannot distinguish "wait", "fix first", and "inspect committed state first".

The POST body is mandatory. Empty or unknown input is `400`; the explicit
`scope: "fleet"` prevents an accidental full-fleet mutation. The CLI generates
the operation UUID before POSTing, prints it first, and the server rejects a
previously used ID rather than rerunning it. A retry with the same ID inspects
or joins the matching in-process promise; a different ID while a pass is active
returns typed `409 operation_in_flight` with the active operation ID. The
optional `retryOfOperationId` becomes mandatory whenever the durable ledger's
latest mutation-capable outcome is `outcome_unknown_after_mutation`. The server
atomically rejects an omitted or mismatched predecessor, re-inspects the
referenced operation, and starts the new operation only when `safeToRetry` is
still true. A `failed_before_mutation` retry attempt does not clear that
durable barrier. The response replaces ambiguous `replayed` semantics with
`executionDisposition: "started" | "joined_in_flight"`. Keep `replayed` as a
deprecated compatibility field for one release and test the equivalence.

The server may keep its more detailed internal `CrewRepairSkipReason`. Map it to
this wire contract at the reconciliation boundary. Unknown internal errors map
to `unknown_fail_closed`; they never leak `Error.message`.

Every string has a schema maximum and every object is strict. Construct the
public response explicitly and parse it through
`MarketplaceReconcileResponseSchema` before passing it to either the audit
writer or Express. Do not spread internal maintenance results into the wire
object. `crewRepair` stays counter-only and there is exactly one top-level
`skips[]`.

The strict boundary covers every endpoint result, including 400, 401, 403, 404,
409, 500, and 502. Route/auth middleware must map to
`MarketplaceReconcileErrorResponseSchema`; raw `catalogError`, middleware
strings, and exception text never cross the boundary. `operationId` is null
only when no operation was accepted.

### A1.3 Typed Diagnostic Capture

Replace the current string-only `skill-install-failed` catch with a typed,
server-private diagnostic carrying:

- an allowlisted cause code
- safe catalog item ID, when known
- HTTP status, when known
- filesystem operation, never the unrestricted absolute path
- original error as a logged cause, never as wire data

Use a deterministic message and recovery table keyed by public diagnostic code.
Cap every public string even though it is currently constant-generated. Reject
or drop any optional context outside its schema.

Apply the same boundary to existing `failures[]`. Today unrestricted exception
text reaches the HTTP response and company-readable completion audits. Replace
it with allowlisted failure codes, deterministic messages, and structured retry
instructions.

Add a dedicated internal error serializer for logs. It may preserve error
class/code, stack, safe hostname, HTTP status, operation, and cause class; it
strips URL userinfo/query/fragment, bearer/token-like values, and unnecessary
absolute paths. Test the Pino sink itself.

`CrewRepairPassResult` gains `skips: CrewRepairPassSkip[]`. Add one entry at
the same branch that increments each skip counter, including budget exhaustion.
Enforce:

```text
count(skips.category == fail_closed) == skippedFailClosed
count(skips.category == cooldown)    == skippedCooldown
count(skips.category == over_budget) == skippedOverBudget
```

### A1.4 Response, Audit, and Logs

- `MarketplaceReconcileResponse` returns fleet-level `skips`.
- Operation-level `diagnostics[]` represents prerequisite/disabled-stage
  conditions that also make a result partial.
- Each `marketplace.reconciliation_completed` activity row receives only the
  entries matching that row's company ID.
- `failures[]` remains reserved for thrown/per-company failures but is typed
  and sanitized.
- Structured logs include `operationId`, `companyId`, internal reason, and the
  sanitized internal error serialization.
- `status` remains `partial` when any skip counter is non-zero.
- Every predicate that can set `status: "partial"` has a corresponding entry
  in `skips[]`, `failures[]`, or `diagnostics[]`.

Index skips and failures by company ID once before building activity rows.

Completion-audit failure after maintenance is explicitly
`outcome_unknown_after_mutation`, not "fail closed": mutations may already have
committed. Return 500 with the operation ID and safe outcome code, log a safe
completion summary, retain the start audit, and require state inspection before
an idempotent retry.

### A1.5 Durable Operation Inspection

Add instance-admin-only
`GET /api/admin/marketplace/reconciliations/:operationId`. It derives durable
state from `activity_log` rows keyed by the already-indexed
`entityType = "marketplace_reconciliation"` and `entityId = operationId`, plus
the current process's in-flight operation ID:

```ts
interface MarketplaceReconciliationInspection {
  operationId: string;
  state:
    | "running"
    | "success"
    | "partial"
    | "failed_before_mutation"
    | "outcome_unknown_after_mutation";
  startedAt: string;
  completedAt: string | null;
  deploymentSha: string;
  targetCount: number;
  targets: Array<{
    companyId: string;
    crewState: "healthy" | "repairable" | "blocked" | "unknown";
    diagnosticCode: MarketplaceReconcileDiagnosticCode | null;
  }>;
  safeToRetry: boolean;
  retry: MarketplaceRetryInstruction;
}
```

Discover and start-audit the sorted fleet before catalog refresh so even a
catalog failure is inspectable; the strict started-audit shape allows
`catalog: null` until refresh succeeds. Write one allowlisted terminal audit
for pre-mutation failures. All target rows are inserted in one statement;
partial target audit sets are invalid. A zero-company fleet returns synchronous
success without starting maintenance. A started operation with no terminal
audit is `running` only while the matching process-local promise exists;
otherwise it is `outcome_unknown_after_mutation`.

For outcome-unknown operations, run the existing read-only crew diagnosis for
each recorded company. `safeToRetry` is true only when every target is
`healthy` or an explicitly idempotent `repairable` state, no active
reconciliation/install writer exists, and there are no unaccounted/customized
rows. A2 extends the same check with its durable crew lease. Any query failure,
unaccounted row, customization ambiguity, or active writer returns
`crewState: "unknown" | "blocked"` and `safeToRetry: false`. The GET route never
repairs or writes domain state.

Test the exact hard case: maintenance commits, completion audit throws, POST
returns the typed 500, GET reports the target state, and only a safe inspection
plus a matching `retryOfOperationId` permits a duplicate-free retry. The claim
path enforces the predecessor reference as a durable cross-replica
precondition; CLI guidance alone is not an authorization boundary.

### A1.6 CLI Golden Path

The CLI currently stores the board credential produced by
`aoa auth login`, but `resolveCommandContext()` does not consume it. Fix the
credential precedence to:

1. explicit `--api-key`
2. `AOA_API_KEY`
3. selected profile's key environment variable
4. stored board credential for the resolved API base

Rename the option help from "agent-authenticated calls" to "Bearer token
override"; never print the selected token. This makes `auth whoami` and other
board commands use the credential that login already stored.

Add:

```sh
pnpm aoa marketplace reconcile \
  --api-base https://testing.armyofagents.org \
  --confirm-fleet \
  --timeout-ms 300000 \
  --json

pnpm aoa marketplace inspect <operation-id> \
  --api-base https://testing.armyofagents.org \
  --json
```

`reconcile` generates and prints a UUID, then sends the strict
`{scope:"fleet", mode:"repair", operationId, retryOfOperationId?}` body only when
`--confirm-fleet` is present. It prints the operation ID first, uses the stored
board credential, validates all success and error bodies with the shared Zod
schemas, renders the recovery instruction, and on timeout directs the operator
to `inspect` instead of retrying. A safe retry supplies
`--retry-of <inspected-operation-id>`; the server validates that reference
again. JSON mode is deterministic and contains no credential. `inspect` calls
the read-only GET endpoint.

The measured golden path for an already-valid credential is exactly:

```sh
pnpm aoa auth whoami --api-base https://testing.armyofagents.org
pnpm aoa marketplace reconcile --api-base https://testing.armyofagents.org --confirm-fleet --timeout-ms 300000 --json
pnpm aoa marketplace inspect <operation-id> --api-base https://testing.armyofagents.org --json
```

A fresh operator runs
`pnpm aoa auth login --api-base https://testing.armyofagents.org
--instance-admin` once before this path. No manual token extraction or fabricated
Origin header appears in the supported workflow.

### A1.7 Outbound Resource Boundary

Before deliberately rerunning fleet repair, route catalog resource fetches
through the existing `outbound-url-guard` and pinned request executor:

- HTTPS only and no URL userinfo
- public, non-reserved resolved addresses only
- manual redirects with every hop revalidated
- expected marketplace CDN host/path or commit-pinned GitHub resource form
- no loopback, link-local, RFC1918, cloud-metadata, or DNS-rebinding target

This is security hardening for the existing privileged reconciliation path, not
an A2 repair guess.

### A1.8 Root Compatibility Substrate

A1 must remain a safe rollback target for A2. Add one managed-root resolver
with two always-known, always-jailed roots:

- legacy: `path.join(process.cwd(), ".aoa", "marketplace-skills")`
- persistent:
  `path.join(resolveAoaInstanceRoot(), "marketplace-skills")`

Selection is independent:
`AOA_MARKETPLACE_SKILLS_WRITE_ROOT=legacy|persistent`, defaulting to `legacy`
in A1. Do not accept an arbitrary path override. Reads and containment checks
cover both roots regardless of the write selector. A2 changes the testing
deployment selector to `persistent`; rollback changes only the selector while
remaining on dual-root-aware code.

Wire the selector through `docker-compose.yml` and
`scripts/deploy/write-compose-env.mjs`; document it in the environment-variable
reference so the brand/env guard enforces freshness. Deployment preflight fails
unless the effective selector, resolved persistent root, `/aoa` mount, image
revision, and instance ID equal the release manifest.

### A1.9 Operator Documentation

Create `docs/guides/board-operator/marketplace-recovery.md` and link it from
Authentication, Marketplace API, Activity Log, Docker, Upgrade Guide, CLI
Overview, and `docs/docs.json`. It contains:

- the CLI-first login/reconcile/inspect/logout golden path
- an advanced board-key curl example without Origin/Referer, explicitly not the
  normal workflow
- response example containing `skips[]`
- difference between `skips[]` and `failures[]`
- the complete public diagnostic/error-to-retry mapping table
- how to join response, audit, and logs by `operationId`
- explicit warning not to retry until the typed recovery action is complete
- the `outcome_unknown_after_mutation` inspection/retry procedure
- an authoritative storage table: host/Compose path `/aoa`, instance path,
  legacy root, persistent root, write selector, and rollback behavior

Reconcile the current `/paperclip` prose in `docs/deploy/docker.md` and
`docs/deploy/upgrade-guide.md` with the actual `/aoa` Compose mount and the
intentional compatibility symlink. No deployment guide may describe
`/paperclip` as the authoritative persistent mount.

### A1 Test Matrix

| Layer | Required case |
|---|---|
| Guard unit | board key without Origin succeeds |
| Guard regression | session without Origin remains 403 |
| Guard regression | trusted Origin and Referer still succeed |
| Full auth/route | valid, expired, revoked, malformed, and non-admin board keys |
| Full auth/route | agent and MCP bearer keys remain unauthorized |
| Full auth/route | invalid bearer plus valid session does not fall back to session authority |
| Request boundary | empty/unknown body is 400; fleet/mode/UUID is accepted; reused/concurrent IDs are safe |
| Error boundary | 400/401/403/404/409/500/502 all parse as the strict error schema |
| Pass unit | each skip branch produces one entry and one counter |
| Pass unit | two companies keep distinct diagnostics |
| Pass boundary | over-budget skip names the correct company |
| Mapping unit | every internal reason maps to a public code |
| Retry mapping | every diagnostic/error has one exhaustive retry instruction |
| Strict schema | unknown context is rejected/stripped and strings are bounded |
| Redaction | secrets, credential URLs, long messages, and paths do not cross skips or failures |
| Log sink | original/cause errors cannot persist secrets or signed URLs |
| Service | every partial predicate produces a skip, failure, or operation diagnostic |
| Audit | each company gets only its own skips and failures |
| Audit failure | maintenance commits, completion audit throws, outcome is unknown, retry is duplicate-free |
| Inspection | running/completed/pre-mutation-failed/outcome-unknown are distinguished durably |
| Inspection | query ambiguity or active writer forces `safeToRetry: false` |
| CLI auth | stored board credential is the last fallback and never printed |
| CLI reconcile | `--confirm-fleet` required; success/error/timeout/inspect paths are schema-checked |
| SSRF | private/reserved targets and unsafe redirect hops are rejected |
| Root compatibility | both fixed roots are jailed regardless of write selector |
| Compose contract | selector is passed through and deploy env records the expected value |

Run the focused tests, then the repository handoff gate:

```sh
pnpm exec vitest run \
  server/src/__tests__/board-mutation-guard.test.ts \
  server/src/__tests__/admin-marketplace-routes.test.ts \
  server/src/__tests__/marketplace-reconcile.test.ts \
  server/src/__tests__/crew-repair.integration.test.ts \
  cli/src/__tests__/board-auth.test.ts \
  cli/src/__tests__/marketplace-recovery.test.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

The `pnpm exec vitest run ...` invocation is the verified repository-root
runner. Do not use `pnpm --filter @armyofagents/server test`; that package has
no `test` script.

### A1 Deployment and Exit

1. Merge only after CI and review are clean.
2. Deploy the exact reviewed SHA to testing.
3. Run a checked-in, read-only
   `scripts/verify-marketplace-recovery-preflight.mjs` that emits JSON and fails
   closed unless health, deployment SHA, one server replica, `/aoa` volume,
   write selector `legacy`, catalog identity, and instance-admin identity match.
4. Use the stored short-lived credential via the CLI golden path; capture the
   reconcile and inspect JSON without printing the token.
5. Read both company completion audits and verify skip-counter equality.
6. Save a restricted incident envelope containing sanitized live response,
   audits, deployment SHA, operation ID, and catalog/resource identities. Never
   commit production/test data or credentials.
7. Separately commit a minimal non-secret fixture with equivalent catalog
   entries, pinned bytes/SHAs, manifest, and canonical digest. One offline test
   command must reproduce every observed diagnostic from that fixture.
8. Run
   `pnpm aoa auth logout --api-base https://testing.armyofagents.org`, then
   verify the revoked credential returns the strict 401 envelope.
9. Record the safe diagnostic codes that select A2.

A1 exits when an operator can identify each company's exact safe failure class
from CLI output and inspection without shell access, every partial condition is
accounted for, the non-secret fixture reproduces offline, and the measured
already-authenticated golden path returns a verdict in at most five minutes.

## A2 - Repair the Proven Cause and Persist Bundles

### A2.1 Evidence-selected Branch

The first A2 commit records the A1 operation ID, observed diagnostic codes, and
the automated reproduction. Select only the matching branch:

| Diagnostic | Repair |
|---|---|
| `skill_resource_temporarily_unavailable` | preserve state, honor server retry deadline, and reproduce bounded recovery |
| `skill_resource_fetch_failed` | repair bounded fetch/resource availability; add exact resource fixture |
| `skill_resource_invalid` | repair publisher/parser contract; add invalid-resource regression |
| `skill_bundle_materialization_failed` | repair staging/rename/inventory path |
| `skill_bundle_missing` | re-materialize when a DB row exists but its declared bundle is absent |
| `skill_filesystem_permission_denied` | repair entrypoint ownership and add production-user container test |
| another code | smallest cause-specific repair with captured regression |

No broad catch-and-retry loop is allowed. A2 must reproduce the captured cause
before changing behavior.

### A2.2 Managed-bundle Health Classifier

The current installer returns `alreadyInstalled` from DB provenance alone, and
crew repair computes "missing skills" from DB keys alone. Add a dedicated
`classifyManagedCatalogBundle` check before either shortcut:

- expected persistent path derived from DB provenance
- path is a real directory below an approved managed root
- `SKILL.md` exists
- catalog bundle metadata carries the pinned repo/commit/path
- canonical tree digest matches
- no unexpected symlink/junction or extra/missing file

`healthy` reuses the row. `missing` or `corrupt` on an uncustomized catalog row
routes to explicit re-materialization. A customized row fails closed for
operator review; it is never replaced because its bundle disappeared.
Do not overload initial `installSkill()` semantics with an ambiguous boolean.

### A2.3 Persistent Managed Root

Move managed marketplace bundles from `process.cwd()/.aoa/marketplace-skills`
to `path.join(resolveAoaInstanceRoot(), "marketplace-skills")`, activated by
`AOA_MARKETPLACE_SKILLS_WRITE_ROOT=persistent`. Use the same dual-root resolver
for materialization, reads, and containment.

Requirements:

- use collision-resistant company/item/version segments (readable prefix plus
  digest), not lossy character replacement
- preserve case-sensitive/case-insensitive containment behavior
- `lstat` ancestors, reject symlink/junction roots, and compare `realpath` for
  existing paths; new paths are created only below a trusted real ancestor
- never delete the last known-good bundle before replacement validates
- detect an installed row whose bundle/inventory is absent and re-materialize
- never copy legacy bytes: re-fetch the row's pinned
  `catalogSkillBundle.commitSha`, materialize into the new root, and compare the
  resulting markdown/customization contract before a conditional DB update
- keep legacy cleanup rollback-safe until the new root survives restart
- never follow a founder-controlled path into the managed root

Existing `fileInventory` records only path and kind, so it cannot prove byte
integrity. Store
`{ algorithm: "sha256", formatVersion: 1, digest: "<lowercase hex>" }` in the
catalog bundle JSONB metadata and require it for persistent-root health.

The v1 digest byte stream is exact and cross-platform:

```text
"aoa-marketplace-tree\0v1\0"
for each regular file sorted by normalized relative-path UTF-8 bytes:
  u32be(pathByteLength) || pathUtf8 || u64be(fileByteLength) || fileBytes
```

Normalize separators to `/` and each path component to Unicode NFC. Include
empty files. Reject absolute paths, `.`/`..`, duplicate normalized paths,
case-fold collisions on case-insensitive filesystems, symlinks/junctions, and
non-regular entries. Directory entries and host permission bits are excluded so
the same pinned tree hashes identically on Linux and Windows. Golden fixtures
cover empty files, non-ASCII/hostile names, separator variants, path-order
ambiguity, and same-length byte tampering.

Existing rows without the digest re-fetch from their pinned source rather than
authenticating legacy bytes.

### A2.4 Atomic Materialization and Crash Protocol

Treat the filesystem as a reconstructible cache whose authority comes from DB
provenance plus the pinned catalog commit:

1. Always build in a unique sibling staging directory, including when the
   destination does not exist.
2. Validate `SKILL.md`, containment, inventory, byte count, and tree digest in
   staging.
3. Rename staging into the deterministic destination on the same device.
4. If another writer won the destination race, validate and reuse the winner;
   never overwrite it blindly.
5. Conditionally update/insert DB provenance and digest.
6. Defer old-root cleanup until the DB points at the new valid tree and the
   rollout passes restart proof.
7. At startup/reconcile, remove or recover orphan incoming/outgoing trees by
   comparing them with DB provenance.

The current repair advisory lock begins after skill materialization. Add a
`marketplace_crew_claims` table with:

- `company_id uuid`
- `template_origin text`
- `owner_operation_id uuid`
- `fencing_token bigint`
- `lease_expires_at timestamptz`
- `created_at` / `updated_at`
- primary key `(company_id, template_origin)`

Acquire before any crew skill work through an INSERT-or-compare-and-set using
the database clock. A live owner returns the typed `install_in_flight` skip.
An expired lease may be taken over only while atomically incrementing the
fencing token. Use a 120-second lease and renew every 30 seconds during bounded
network/materialization work. Release is conditional on owner operation ID and
fencing token.

Bootstrap, repair, and public team installation must carry the token into their
final transaction and re-check that the lease is current, unexpired, and still
owned before committing crew/team provenance. A stale writer can leave a
validated reconstructible bundle but cannot commit crew state. Expired rows are
reusable tombstones; no correctness path depends on deleting them.

Skill installation still relies on its unique DB key plus
always-stage/destination-race validation; a losing identical pinned install
reuses the winner. Generate and check in the Drizzle migration and schema
export. A1 rollback ignores the additive claim table safely.

Do not add the broader partial unique index on
`(company_id, template_origin)` in this incident. It changes semantics for all
marketplace teams and requires fleet duplicate remediation. The shared claim
closes the incident race; the database invariant remains a separately reviewed
follow-up.

### A2 Test Matrix

| Layer | Required case |
|---|---|
| Reproduction | exact A1 diagnostic is triggered before the fix |
| Resolver unit | Docker/default and custom `AOA_HOME` resolve inside persistent instance storage |
| Jail regression | inside, ancestor, sibling, case-variant, different-root, symlink, junction, and swap paths |
| Encoding | distinct hostile IDs/versions never collide at one directory |
| Health classifier | absent, non-directory, missing SKILL.md, digest mismatch, extra file, customized row |
| Materialization integration | DB row + missing directory re-materializes atomically |
| Atomicity | a reader never observes partial bytes for a new or replacement destination |
| Fault injection | ENOSPC, EROFS, inode exhaustion, EXDEV, EBUSY, and rename failure |
| Kill points | before rename, after rename, before DB update, and after DB update |
| Integrity | same-path tampering, truncation, extra/missing files, path normalization, and cross-platform golden digest |
| Founder safety | customized bytes and flags remain untouched |
| Migration | every legacy row re-fetches its pinned commit; legacy bytes are never trusted/copied |
| Docker | non-root production user materializes, restarts, recreates container, and reads the same bytes |
| Concurrency | separate DB sessions/processes: repair/repair, repair/bootstrap, repair/public install |
| Claim recovery | dead owner lease expires; one successor takes over |
| Fencing | stale owner cannot commit after lease takeover |
| Destination race | losing writer validates and reuses the winning pinned tree |
| Rollback | selector set to legacy under A1; both roots remain protected and mutations stay consistent |
| Idempotency | second forced reconciliation performs zero repairs |

Add a named `marketplace-persistence-chaos` job to
`.github/workflows/pr.yml`. It runs on Linux for every non-draft code PR (a
fast no-op is allowed only when a checked path filter proves no marketplace,
crew, DB schema, Docker, or deploy file changed) and is added to branch
protection before A2 merges. For A2 it must:

1. build the production image and run as its non-root user
2. use a real Postgres service and named `aoa-data` volume
3. run the separate-process lease/fencing suite
4. inject the filesystem/DB kill points
5. restart and force-recreate the server with the same volume
6. execute the A2-to-A1 selector rollback pair
7. upload redacted preflight, mount, digest, claim, and reconciliation JSON

Linux CI is authoritative for container, filesystem, and integration coverage;
Windows skips are not closure evidence.

### A2 Deployment and Incident Exit

1. On A1, run the checked-in preflight and require exactly one server replica,
   the expected named volume mounted at `/aoa`, correct UID/GID ownership,
   sufficient free bytes/inodes, staging/destination on one device, the exact
   A1 image revision, effective selector `legacy`, and a generated A2 env
   preview selecting `persistent`.
2. Deploy the exact A2 SHA with
   `AOA_MARKETPLACE_SKILLS_WRITE_ROOT=persistent` emitted by
   `scripts/deploy/write-compose-env.mjs` and passed by `docker-compose.yml`.
3. Re-run preflight and require the exact A2 revision and effective selector
   `persistent`.
4. Run the CLI reconcile and inspect commands; capture response/audits.
5. Verify both companies have:
   - one default crew team
   - one Reviewer
   - Steward adopted according to the locked rules
   - all required roster agents exactly once
   - all 17 required skills with materialized, matching tree digests
6. Restart, then forcibly recreate the container from the same named volume.
7. Verify every managed bundle still exists and matches its tree digest.
8. Force reconciliation again.
9. Require `status: "success"`, zero repairs, zero skips, and no duplicate rows.
10. Run a checked-in
   `scripts/verify-marketplace-recovery-closure.mjs --operation-id <id>` that
   emits the redacted closure JSON and fails unless all company, bundle,
   digest, volume, audit, and no-op invariants hold.

Rollback:

- A1 is a normal code revert; browser-session protection must remain intact.
- A2 rolls back by changing the selector to `legacy` while retaining A1's
  dual-root reads and jail. Do not redeploy code unaware of the persistent root.
- On this single-server testing environment, the operational freeze is an
  explicit short outage: `docker compose stop server`, then fail unless
  `docker compose ps -q --status running server` returns no container. Change
  the selector in the generated runtime env, force-recreate the A1-compatible
  server, and require its health/revision/root preflight before unfreezing.
- Do not invent a partial maintenance mode in the incident PR. Production
  multi-replica maintenance semantics require a separate design.
- If persistent-root reads fail, keep both roots, operation IDs, and audit
  evidence. Never clear DB provenance or customization state.

The incident closes only after the restart and second-pass proof succeeds.

## Design Review Applicability

Skipped: A1/A2 add no UI surface, visual workflow, or interaction component.
The operator interface is CLI/API documentation and is covered by the DX
review. Any future recovery UI requires its own design review.

## Engineering and Security Review

### Engineering Scope Challenge

The smallest safe A1 is larger than a guard tweak. Inspection of
`board-mutation-guard.ts`, `admin-marketplace.ts`,
`marketplace-reconcile.ts`, `commands/client/common.ts`,
`managed-skills-root.ts`, `docker-compose.yml`, and the deploy env writer shows
that the same privileged path also has raw error leakage, no durable uncertain-
outcome inspection, an unused stored credential, unguarded resource fetches,
and no deploy wiring for root selection. These are direct importers or release
surfaces in the changed path, so the plan accepts them under the blast-radius
rule.

The smallest safe A2 must cover the health shortcut, filesystem/DB crash
boundary, and all default-crew writers; fixing only a path string would leave
corrupt bundles treated as installed and permit stale concurrent commits. The
plan rejects expansion into the marketplace-wide unique team-origin invariant,
general offline packaging, production multi-replica maintenance, connector
publication, or team-update product work.

### Verified Findings and Decisions

| Finding | Severity/confidence | Decision |
|---|---|---|
| Existing `failures[]` exposes unrestricted exception messages | P1, 10/10 | sanitize through the same strict boundary as skips |
| Resource errors embed full URLs and logger has no arbitrary-message redaction | P1, 9/10 | add/test a dedicated redacting error serializer |
| Resource fetch bypasses the shared outbound URL guard | P1, 9/10 | close before the deliberate A1 rerun |
| Internal results are spread into the response | P2, 9/10 | construct and strict-parse one explicit wire shape |
| Some `partial` predicates have no diagnostic | P2, 10/10 | require one skip/failure/operation diagnostic per predicate |
| Completion audit can fail after committed mutations | P1, 10/10 | report `outcome_unknown_after_mutation`; test inspection/retry |
| Stored login credential is not consumed by normal CLI commands | P1, 10/10 | add credential fallback plus reconcile/inspect commands |
| Non-2xx auth/catalog/route bodies have no strict common contract | P1, 10/10 | strict-parse 400/401/403/404/409/500/502 |
| Root override was not deploy-wired and made the rollback root unknowable | P1, 10/10 | fixed dual roots plus `legacy|persistent` write selector |
| New destinations copy directly into the live path | P1, 10/10 | always stage, validate, then rename |
| DB rows are treated as installed without bundle health | P1, 10/10 | add a dedicated managed-bundle health classifier |
| Existing inventory records paths/kinds, not bytes | P1, 10/10 | persist a canonical tree digest; re-fetch unverifiable legacy rows |
| Lexical jail does not cover symlinks/junctions | P1, 10/10 | use lstat/realpath trusted-ancestor rules for the new dual-root flow |
| Repair coordination starts after skill materialization | P1, 10/10 | acquire a cross-process DB lease before crew skill work |
| Lease semantics were underspecified | P1, 10/10 | define table, DB-clock CAS, renewal, release, and fencing |
| Filesystem rename and DB provenance can diverge on crash | P1, 9/10 | reconstructible-cache protocol plus orphan reconciliation |
| Lossy path sanitization permits ID/version collisions | P2, 9/10 | prefix-plus-digest encoding and collision tests |
| Reverting to code unaware of the new root is unsafe | P1, 10/10 | A1 dual-root compatibility and selector rollback |
| Restart does not prove volume survival across recreation | P2, 10/10 | mount/replica preflight plus forced container recreation |
| No named Linux gate proves persistence/chaos behavior | P1, 10/10 | required `marketplace-persistence-chaos` PR job |
| Per-company audit filtering is quadratic | P3, 9/10 | index diagnostics by company once |

### Materialization State Machine

```text
ABSENT / UNHEALTHY
    |
    | claim owner + fetch pinned source
    v
STAGING
    |-- validation/fetch/disk error ------> CLEAN STAGING -> SAFE SKIP
    |-- process death --------------------> ORPHAN (reconciled at startup)
    `-- validated tree digest
            |
            v
RENAMED DESTINATION
    |-- destination race ----------------> VALIDATE/REUSE WINNER
    |-- DB CAS success ------------------> HEALTHY
    `-- process death / DB failure ------> ORPHAN VALID TREE
                                               |
                                               `-> reconcile with DB provenance

HEALTHY + customized=true + missing/corrupt bytes -> FAIL CLOSED, NEVER REPLACE
HEALTHY + customized=false + missing/corrupt bytes -> RE-MATERIALIZE PINNED SOURCE
```

### Root Rollout State Machine

```text
LEGACY
  -> deploy A1: protect/read both roots, selector=legacy
  -> deploy A2 + selector=persistent: re-fetch pinned legacy rows
  -> restart + recreate proof: persistent active, legacy retained
  -> later cleanup PR: remove legacy bytes only after fleet evidence

ROLLBACK from A2
  -> stop the sole testing server and prove zero replicas
  -> selector=legacy under A1-compatible code
  -> read/protect both roots, write legacy, recreate server
  -> investigate and roll forward

INVALID: deploy code that does not recognize the persistent root after DB paths
point there. The rollout prevents this transition.
```

### Test Coverage Diagram

```text
A1
  actorMiddleware -> boardMutationGuard -> admin route
    [TEST] valid/expired/revoked/malformed/non-admin board key
    [TEST] session Origin/Referer regression
    [TEST] agent/MCP and invalid-bearer-no-session-fallback
  internal result -> safe mapper -> strict Zod -> audit/HTTP
    [TEST] every skip/failure/partial predicate
    [TEST] every non-2xx response and retry instruction
    [TEST] redaction at response, audit, and logger sink
    [TEST] completion-audit failure after committed mutation
  stored auth -> CLI reconcile/inspect -> strict response parsing
    [TEST] credential precedence, no secret output, confirm-fleet, timeout
  resource URL -> DNS/IP validation -> pinned request
    [TEST] protocol/userinfo/private IP/rebind/redirect
  root resolver
    [TEST] legacy default, persistent selector, invalid selector, dual jail

A2
  captured fixture -> exact reproduction -> selected fix
    [TEST] fixture digest and pinned resource identities
  health classifier -> re-materialize or fail closed
    [TEST] missing/corrupt/customized/unverifiable states
  stage -> validate digest -> rename -> DB CAS -> cleanup
    [TEST] race, crash, disk, rename, DB conflict, orphan recovery
  crew writer lease
    [TEST] separate-process repair/repair, repair/bootstrap, repair/public, stale fencing
  deployment
    [TEST] non-root container restart, recreation, selector rollback, no-op pass
```

The 2 a.m. Friday test is container recreation from the named volume followed
by a successful no-op forced reconciliation. The hostile test kills the process
at every filesystem/DB boundary while a second process competes for the same
crew. The chaos test combines an expired owner lease, a stranded staging tree,
and a completion-audit failure, then proves one duplicate-free recovery.

### Performance

- A1 keeps audit projection O(companies + diagnostics) by pre-indexing per
  company.
- A2 retains bounded crew fetch concurrency; it does not hold a database
  transaction across network fetches.
- The durable lease is one claim/renew/release sequence per company crew, not
  one database connection pinned for the full network interval.
- Tree hashing is linear in bundle bytes and occurs in staging before exposure.
- Startup orphan cleanup is bounded to managed roots and ignores unrelated
  filesystem trees.

### Parallelization

| Lane | Work | Dependency |
|---|---|---|
| A1-A | board-key guard and full auth-route tests | none |
| A1-B | strict request/response/error schemas, mapping, audit, logger | none |
| A1-C | durable inspection plus CLI credential/reconcile/inspect commands | A1-B contract |
| A1-D | outbound fetch guard and fixed dual-root selector/deploy wiring | none |
| A1-E | scripts, docs, integration, full verification | A1-A + A1-B + A1-C + A1-D |
| A2-A | captured-cause reproduction | deployed A1 evidence |
| A2-B | health classifier, digest, always-stage protocol | A2-A |
| A2-C | persistent resolver, lease, migration/re-fetch | A2-B |
| A2-D | Docker/chaos/rollout proof | A2-C |

A1-A/B/D may start in separate worktrees but all touch `server/`, so merge them
one at a time before A1-C/E. A2 is intentionally sequential because the same
installer/materializer invariants carry through every step.

### Engineering Dual-voice Consensus

| Dimension | Independent reviewer | Codex reviewer | Consensus |
|---|---|---|---|
| Auth boundary | source-specific exemption is correct | source-specific exemption is correct | confirmed |
| Wire safety | skips alone are insufficient | skips and failures need strict schemas | confirmed |
| Concurrency | current locks start too late | current locks are process-local/late | confirmed |
| Integrity | inventory cannot prove bytes | inventory cannot prove bytes | confirmed |
| Rollback | prior image reintroduces ephemeral writes | prior image creates split-brain/jail gap | confirmed |
| Test/deploy | multi-process and recreation proof missing | full auth, chaos, and real-image rollback missing | confirmed |

### Engineering Completion Summary

Full review found and resolved in-plan the wire-leak, SSRF, outcome-unknown,
ephemeral-root, byte-integrity, atomicity, path-jail, concurrency/fencing,
rollback, and Linux-proof gaps. The design keeps network work outside database
transactions, makes the filesystem reconstructible from pinned provenance, and
uses the database only for the minimum durable coordination state.

The executable test plan artifact is:
`C:\Users\TK\.gstack\projects\AoA-main\testing-marketplace-recovery-eng-test-plan-20260728.md`.
Engineering review exits with zero unresolved critical gaps; implementation
must still pass the named A1 and A2 gates before either PR merges.

## Operator and Developer Experience Review

### Developer Persona Card

| Attribute | Definition |
|---|---|
| Primary user | AoA maintainer acting as testing instance administrator during an incident |
| Goal | establish whether recovery ran, why each company skipped, and what safe action comes next |
| Environment | authenticated remote Docker deployment, one testing server, no assumed shell access |
| Existing knowledge | understands SHA/CI/PRs; should not need internal service or database knowledge |
| Risk tolerance | zero founder-data loss, zero duplicate crew rows, short testing-only downtime acceptable for rollback |
| Success | one terminal session, no token extraction, typed verdict within five minutes |

### Developer Empathy Narrative

> I know the deployment is healthy and the operation says "partial", but that
> does not tell me whether it changed anything or why both companies were
> skipped. I do not want to fabricate a browser header, copy a privileged token,
> grep production logs, or guess whether retrying will duplicate the crew. Give
> me one authenticated command, show me the operation ID immediately, classify
> every company, and tell me whether I can retry. If the network drops, I want
> the same answer from an inspect command.

### Competitive DX Benchmark and Magical Moment

| Experience | Steps | Time | Verdict |
|---|---:|---:|---|
| Current testing recovery | manual key/curl/header/audit correlation | 20+ min | red flag |
| Planned authenticated path | whoami, reconcile, inspect | <= 5 min | competitive |
| Target after incident | preflight + one reconcile command with automatic terminal inspection | < 2 min | champion follow-up |

The magical moment is the CLI printing a known operation ID before network work,
then returning one safe company-level reason and prescribed action without
exposing a token or requiring server access. The delivery vehicle is
`aoa marketplace reconcile`; `aoa marketplace inspect` preserves the moment
through timeouts, restarts, and uncertain completion audits.

### Developer Journey Map

| Stage | Current friction | Planned resolution |
|---|---|---|
| Discover | recovery route buried in API knowledge | board-operator runbook linked from API, CLI, auth, activity, and deploy docs |
| Evaluate | no declared blast radius or retry semantics | preflight and explicit fleet confirmation |
| Install | no published CLI artifact in this repo flow | use repository `pnpm aoa`; publishing remains outside incident |
| Hello world | stored login credential is ignored | `auth whoami` consumes the stored credential |
| Integrate | operator hand-builds curl and Origin | first-class reconcile command and strict request schema |
| Debug | `partial` loses per-company cause | typed diagnostics, exhaustive recovery map, durable inspect |
| Upgrade | root/mount docs contradict deployment | authoritative storage table and dual-root upgrade/rollback procedure |
| Scale | in-memory locks do not span processes | A2 DB lease/fencing; general multi-replica maintenance remains deferred |
| Migrate | arbitrary override makes rollback ambiguous | fixed legacy/persistent roots with one write selector |

### First-time Confusion Report

| Confusion | Status in plan |
|---|---|
| "Did login actually give the next command a credential?" | fixed by shared CLI credential precedence and tests |
| "Does an empty POST really mutate every company?" | fixed by mandatory fleet/mode/operation ID body and confirmation flag |
| "Does retryable mean now, later, or after a fix?" | fixed by discriminated retry instructions |
| "Did the timed-out operation commit?" | fixed by client-known ID and read-only inspect |
| "Which Docker path is persistent?" | fixed by `/aoa` storage table and deploy-script validation |
| "Which focused test command actually runs?" | fixed by verified repository-root Vitest command |

### Operator Contract

The primary persona is the testing instance administrator with an already-valid
CLI credential and no server shell. The supported path must provide:

- preflight answer in 30 seconds or less
- client-generated correlation ID immediately, followed by server acceptance
- typed terminal verdict in five minutes or less
- read-only inspection after timeout, disconnect, restart, or audit failure
- one prescribed next action per public code
- a redacted JSON artifact suitable for attaching to the incident

The unsupported path is token extraction plus hand-written curl. It remains
documented only for API debugging.

### Exhaustive Recovery Mapping

The checked-in table and the docs use these exact defaults:

| Public code | Retry kind | Recovery code |
|---|---|---|
| `install_in_flight` | `after` | `wait_for_active_install` |
| `team_item_not_in_catalog` | `after_correction` | `restore_team_catalog_item` |
| `team_template_unavailable` | `after_correction` | `restore_team_template` |
| `empty_roster` | `after_correction` | `repair_team_manifest` |
| `unadoptable_roster_member` | `after_correction` | `resolve_roster_origin` |
| `unaccounted_crew_rows` | `inspect_first` | `review_unaccounted_rows` |
| `skill_resource_temporarily_unavailable` | `after` | `wait_for_resource_retry` |
| `skill_resource_fetch_failed` | `after_correction` | `restore_pinned_resource` |
| `skill_resource_invalid` | `after_correction` | `repair_resource_contract` |
| `skill_bundle_materialization_failed` | `after_correction` | `repair_bundle_storage` |
| `skill_bundle_missing` | `after_correction` | `restore_managed_bundle` |
| `skill_filesystem_permission_denied` | `after_correction` | `repair_storage_permissions` |
| `repair_cooldown` | `after` | `wait_for_cooldown` |
| `repair_budget_exhausted` | `after` | `wait_for_next_repair_window` |
| `unknown_fail_closed` | `inspect_first` | `inspect_operation` |
| `crew_catalog_not_ready` | `after_correction` | `restore_crew_catalog` |
| `legacy_steward_disabled` | `never` | `enable_steward_reconcile_if_desired` |
| `legacy_steward_catalog_not_ready` | `after_correction` | `restore_steward_catalog` |
| `marketplace_update_failed` | `inspect_first` | `inspect_operation` |
| `crew_repair_failed` | `inspect_first` | `inspect_operation` |
| `legacy_steward_failed` | `inspect_first` | `inspect_operation` |
| `crew_update_failed` | `inspect_first` | `inspect_operation` |
| `team_reconcile_failed` | `inspect_first` | `inspect_operation` |
| `unknown_internal_failure` | `inspect_first` | `inspect_operation` |
| `invalid_request` | `after_correction` | `correct_request` |
| `authentication_required` | `after_correction` | `login_instance_admin` |
| `instance_admin_required` | `never` | `request_instance_admin_access` |
| `operation_not_found` | `never` | `verify_operation_id` |
| `operation_in_flight` | `after` | `wait_for_active_operation` |
| `catalog_temporarily_unavailable` | `after` | `wait_for_catalog_retry` |
| `catalog_refresh_failed` | `after_correction` | `restore_catalog_availability` |
| `outcome_unknown_after_mutation` | `inspect_first` | `inspect_operation` |
| `internal_error` | `inspect_first` | `inspect_operation` |

`notBefore` comes from the actual lease, cooldown, or server-side resource retry
deadline for `after`; it is never guessed by the client. A response fails
schema validation if a public code has no table entry.

### Docs and Command Verification

The runbook includes copy/paste commands for login, whoami, preflight,
reconcile, inspect, closure, and logout. Each command is exercised in CLI tests
or the Linux recovery job. Examples use placeholders only for operation IDs;
they do not require company IDs, board-token environment variables, or an
Origin header.

The authoritative storage table and deploy scripts remove the current
`/paperclip` versus `/aoa` contradiction. The restricted live evidence envelope
is never a CI dependency; the committed non-secret fixture is the offline
contract.

### DX Dual-voice Consensus

| Dimension | Independent reviewer | Codex reviewer | Consensus |
|---|---|---|---|
| Existing curl/key workflow meets operator target | no | no | add first-class CLI commands |
| Stored login credential is usable by commands | no | no | fix shared credential resolution |
| Outcome-unknown has a conclusive inspection path | no | no | add durable read-only GET/CLI inspect |
| Retry boolean is sufficient | no | no | use discriminated retry instructions |
| Existing focused test commands are valid | no | no | use verified root Vitest invocation |
| Docker/root docs and env wiring agree | no | no | reconcile docs and wire selector |
| Linux proof is currently a named gate | no | no | add required chaos/persistence job |
| Community/ecosystem work belongs in incident | no gap found | no gap found | no additional incident scope |

### What Already Exists for DX

- `aoa auth login --instance-admin`, a per-API-base credential store, and
  `aoa auth whoami`
- shared Commander client option/context helpers and JSON output
- operation IDs and activity-log entity indexing
- API/authentication, marketplace, activity, Docker, upgrade, CLI, and
  environment-variable documentation surfaces
- full repository `typecheck`, `test:run`, and `build` gates

### DX-specific Not in Scope

- publishing the CLI to npm; the current docs explicitly say it is unpublished
- a recovery UI; the incident is deliberately CLI/API-first
- a generalized maintenance-mode framework for multi-replica production
- community programs, SDK-language expansion, playgrounds, or free-tier design

### DX Scorecard

| Dimension | Before | Plan after review | Gap to 10 |
|---|---:|---:|---|
| Getting Started | 3/10 | 8/10 | published binary and one-command preflight/reconcile |
| API/CLI/SDK | 4/10 | 9/10 | remove deprecated `replayed` after compatibility window |
| Error Messages | 3/10 | 9/10 | validate messages against real incident codes |
| Documentation | 4/10 | 8/10 | versioned command-output snapshots |
| Upgrade Path | 3/10 | 8/10 | production multi-replica migration design |
| Dev Environment | 5/10 | 8/10 | cross-platform container chaos parity |
| Community | 6/10 | 6/10 | intentionally not incident scope |
| DX Measurement | 2/10 | 8/10 | automate longitudinal TTHW tracking |
| **Overall** | **4/10** | **8/10** | ship and measure the plan |

TTHW moves from more than 20 minutes to at most five minutes for an
already-authenticated operator, reaching the competitive tier. Zero Friction,
Fight Uncertainty, Opinionated Defaults with Escape Hatches, Code in Context,
and the Magical Moment are covered. Learn by Doing is covered by the runnable
runbook and fixture; broader community desirability is intentionally deferred.

### DX Implementation Checklist

- [ ] Already-authenticated recovery verdict is <= 5 minutes
- [ ] Client operation ID is printed before the network request and accepted ID is confirmed
- [ ] `auth whoami`, reconcile, inspect, and logout work with the stored key
- [ ] No supported command prints or requires copying the bearer token
- [ ] Every error has problem, stable code, fix/retry instruction, and docs URL
- [ ] CLI naming is guessable and fleet mutation requires explicit confirmation
- [ ] Runbook commands are copy/paste tested
- [ ] Examples show success, partial, pre-mutation failure, timeout, and outcome-unknown
- [ ] A1-to-A2 upgrade and selector rollback are documented and exercised
- [ ] CI uses the verified root Vitest command and the named Linux chaos job
- [ ] Restricted live evidence is separate from the committed offline fixture
- [ ] TTHW and operation stage durations are captured in closure evidence

### DX Completion Summary

Mode: DX polish for a platform/API operational workflow. Both voices found the
same blocking usability gap: the only proven route required secret handling and
manual HTTP knowledge, while outcome-unknown had no conclusive inspection path.
The revised plan closes those gaps without adding a UI or broad product surface.
DX review exits at 8/10 with zero unresolved incident-scope decisions.

## Cross-phase Themes

- **Scope isolation** — CEO and engineering reviews independently required
  separating incident recovery from connector, team-update, and port-sweep work.
- **Operator certainty** — CEO, engineering, and DX reviews all rejected a
  response that says `partial` or `500` without a safe company-level next step.
- **Knowable rollback** — engineering and DX both flagged the ephemeral root,
  undocumented Compose wiring, and ambiguous override as one combined rollout
  risk.
- **Security at the serialization boundary** — engineering and DX both required
  strict error schemas, redacted logs/audits, no token extraction, and guarded
  outbound fetches.

## Failure Modes Registry

| Codepath | Failure | Rescued? | Test | Operator sees |
|---|---|---:|---:|---|
| Board-key auth | invalid/revoked key | yes | route integration | 401/403 |
| Session mutation | missing/untrusted origin | yes | guard regression | 403 |
| CLI request | timeout/disconnect after acceptance | yes | CLI/route integration | known operation ID + inspect action |
| Catalog refresh | CDN unavailable/fallback only | yes | existing service tests | 502 + operation ID |
| Skill install | resource fetch/parse failure | yes | A1 mapping + A2 reproduction | safe skip code |
| Skill fetch | catalog URL targets private/reserved network | yes | SSRF tests | safe failure code |
| Skill install | filesystem permission/staging failure | yes | A1 mapping + Docker test | safe skip code |
| Crew pass | repair budget exhausted | yes | pass unit | over-budget skip |
| Completion audit | audit write fails after mutations | outcome unknown | service/retry test | 500 + operation ID + inspection action |
| Re-materialization | DB row exists, directory absent | A2 | integration | repaired or safe skip |
| Root migration | legacy bytes partial/tampered | A2 | pinned re-fetch test | legacy bytes ignored |
| Materialization | process dies between filesystem and DB steps | reconciled on next pass | kill-point tests | recovered or safe skip |
| Concurrent repair | two processes claim default crew | DB lease | multi-process test | one owner |
| Destination race | two writers finish one pinned skill | validate/reuse winner | race test | one valid tree |
| Restart/recreate | bundle path or volume was ephemeral | rollout blocked/repaired | Docker tests | persistent bytes |
| Rollback | old code does not protect new root | prevented by A1 compatibility | downgrade test | selector rollback |

## Error and Rescue Registry

| Method/codepath | Error class | Rescue/action | Public/audit output |
|---|---|---|---|
| `actorMiddleware` board-key lookup | invalid, expired, revoked, DB error | reject credential or safe-map middleware error | strict 401/403/500 |
| `boardMutationGuard` session mutation | missing/untrusted Origin/Referer | reject before route | strict 403 |
| reconcile request parser | empty, malformed, reused ID, concurrent ID | reject or join matching operation | strict 400/409 |
| catalog refresh | network, timeout, fallback-only, malformed catalog | terminal pre-mutation audit | strict 502 + operation ID |
| guarded resource fetch | unsafe URL, DNS/private IP, redirect, HTTP failure | reject or typed fetch failure | typed failure/skip |
| `repairCompanyCrew` | typed guarded decline | return internal skip | mapped `skips[]` |
| repair pass | unexpected company exception | continue other companies; safe-map failure | typed `failures[]` |
| completion audit | DB error after maintenance | mark outcome unknown; preserve start audit | 500 + operation ID |
| operation inspection | missing/ambiguous audit or diagnosis query failure | fail closed, never mutate | strict 404 or `safeToRetry: false` |
| materializer staging | disk/read/write/rename failure | retain last good; clean/reconcile staging | typed skip |
| bundle health classifier | missing/corrupt/unverifiable bytes | re-fetch only when uncustomized | repair or typed skip |
| crew claim | live owner, expired owner, DB failure | skip/lease takeover/fail | safe skip/failure |
| DB provenance CAS | conflict after valid destination | validate winner, re-read row | reuse or safe failure |

Catch-all conversion is allowed only at the outer company isolation boundary,
where it maps to a safe failure code and logs through the redacting serializer.
No inner catch may swallow an unknown error and continue as success.

## Not in Scope

- Connector catalog publication or marketplace connector taxonomy
- Team-template merge/apply UI or generalized team update platform
- Embedded PostgreSQL port migration
- Combining AoA crew and organization agents in one list
- Changing onboarding state
- Chronicler product-policy changes beyond what the proven repair requires
- General offline-first packaging of every first-party resource; file a separate
  architecture plan after the incident if restart persistence is insufficient

## Implementation Tasks

- [ ] **A1-T1 (P1)** — Correct board-key mutation-guard semantics and regress session protection.
- [ ] **A1-T2 (P1)** — Add strict fleet request, success, diagnostic, failure, inspection, and all-error schemas.
- [ ] **A1-T3 (P1)** — Propagate typed skips through counters, response, per-company audit, redacted logs, and exhaustive retry mapping.
- [ ] **A1-T4 (P1)** — Persist inspectable start/terminal audits and add the read-only operation inspection route.
- [ ] **A1-T5 (P1)** — Make stored board credentials usable and add confirmed fleet reconcile/inspect CLI commands.
- [ ] **A1-T6 (P1)** — Guard outbound resources and add fixed dual-root selection in code, Compose, deploy env, and env docs.
- [ ] **A1-T7 (P1)** — Add verified preflight, fixture, runbook, focused/full tests, and documentation links.
- [ ] **A1-T8 (P1)** — Deploy, rerun, inspect, revoke credentials, measure time-to-verdict, and record A2 evidence.
- [ ] **A2-T1 (P1)** — Reproduce the captured diagnostic in an automated test.
- [ ] **A2-T2 (P1)** — Implement the smallest evidence-selected repair.
- [ ] **A2-T3 (P1)** — Implement versioned canonical tree digests, bundle health, and always-stage crash recovery.
- [ ] **A2-T4 (P1)** — Add the fenced DB crew claim and wire every crew writer.
- [ ] **A2-T5 (P1)** — Select persistent writes, re-fetch legacy rows, and preserve founder state.
- [ ] **A2-T6 (P1)** — Add the required Linux persistence/chaos job and rollback-pair proof.
- [ ] **A2-T7 (P1)** — Deploy and close with restart, recreation, closure script, and successful no-op second pass.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected/deferred alternative |
|---:|---|---|---|---|---|---|
| 1 | CEO | Split the umbrella into incident, connector, team-update, and port-sweep plans | User Challenge, accepted by user | Choose completeness | each program has a different owner, metric, and exit gate | one multi-phase PR/plan |
| 2 | CEO | Keep A1 and A2 as separate PRs | Mechanical | Explicit over clever | deployed A1 evidence selects the only allowed A2 repair branch | speculative combined PR |
| 3 | Eng | Exempt only authenticated `board_key` from Origin/Referer | Mechanical | Pragmatic | explicit bearer authority is non-ambient; browser sessions remain CSRF-protected | exempt every board/admin actor |
| 4 | Eng | Strict-parse request, success, inspection, and all error responses | Mechanical | Choose completeness | durable API/audit surfaces cannot expose internal shapes | TypeScript-only interfaces |
| 5 | Eng | Sanitize failures and the logger sink, not only new skips | Mechanical | Boil lakes | existing failures/URLs are in the same disclosure blast radius | sanitize only the new field |
| 6 | Eng | Add durable read-only operation inspection | Mechanical | Choose completeness | timeout/audit failure otherwise leaves mutation outcome unknowable | tell operator to retry |
| 7 | DX | Make CLI the supported recovery client and consume stored board credentials | Mechanical | DRY | login and credential storage already exist | manual token extraction/curl |
| 8 | DX | Require explicit fleet/mode/client operation UUID | Mechanical | Explicit over clever | prevents accidental fleet mutation and preserves correlation through timeout | empty POST/full fleet |
| 9 | DX | Use discriminated retry instructions | Mechanical | Explicit over clever | "retryable" cannot express wait, correct, inspect, or never | retry boolean |
| 10 | Eng | Guard all privileged resource fetches before rerun | Mechanical | Boil lakes | the existing reconcile path can fetch catalog-provided URLs | defer SSRF closure |
| 11 | Eng | Use two fixed roots plus `legacy|persistent` selector | Mechanical | Explicit over clever | read scope and rollback remain knowable independent of environment | arbitrary path override |
| 12 | CEO | Fix persistent storage in A2 even if another code caused the skip | Mechanical | Choose completeness | `/app/.aoa` outside `/aoa` is independently proven defective | cause-only repair |
| 13 | Eng | Version and specify the canonical byte-tree digest | Mechanical | Explicit over clever | path/kind inventory cannot authenticate content | trust legacy inventory |
| 14 | Eng | Add DB-clock lease renewal and fencing across every crew writer | Mechanical | Choose completeness | process-local/late locks permit duplicate final commits | repair-only lock |
| 15 | DX | Stop the sole testing server during selector rollback | Mechanical | Pragmatic | an explicit short outage is safer than an incident-only maintenance framework | build generalized maintenance mode |
| 16 | Eng | Split restricted live evidence from committed offline fixture | Mechanical | Pragmatic | CI must be reproducible without exposing environment data | use live fixture in CI |
| 17 | Eng | Defer broad unique `(company_id, template_origin)` invariant | Mechanical | Bias toward action | it requires fleet remediation and marketplace-wide semantics outside incident | add index during A2 |
| 18 | CEO | Defer general offline first-party packaging | Taste | Pragmatic | valuable resilience platform, but broader than the proven incident root/fetch defect | bundle every first-party resource now |
| 19 | CEO | Defer immutable image promotion | Taste | Bias toward action | A0 exact-SHA deployment is already shipped; promotion design is a separate release concern | expand this incident into release architecture |

## GSTACK REVIEW REPORT

**Status:** APPROVED for implementation on 2026-07-28

| Phase | Result | Dual voices | Unresolved |
|---|---|---|---:|
| CEO | 9/10; incident split and scope locked | Codex + independent reviewer; 3 confirmed, 2 taste disagreements | 0 |
| Design | skipped; no UI scope | not applicable | 0 |
| Engineering/Security | 9/10; 21 findings resolved in plan | Codex + independent reviewer; 6/6 consensus dimensions | 0 |
| Developer Experience | 8/10; TTHW >20 min -> <=5 min target | Codex + independent reviewer; 8/8 consensus dimensions | 0 |

The review made 19 decisions: 16 mechanical auto-decisions, two taste
recommendations, and one user challenge that the user accepted. The two taste
recommendations are to defer general offline first-party packaging and immutable
image promotion until after the incident.

Cross-phase high-confidence themes were scope isolation, conclusive operator
state, knowable storage rollback, and strict/redacted security boundaries.
The plan contains the complete implementation checklist, failure registry,
error/rescue registry, architecture and test diagrams, operator journey,
exhaustive retry map, and decision audit.

Artifacts:

- engineering test plan:
  `C:\Users\TK\.gstack\projects\AoA-main\testing-marketplace-recovery-eng-test-plan-20260728.md`
- CEO tasks: 2 valid JSONL records
- engineering tasks: 6 valid JSONL records
- DX tasks: 4 valid JSONL records
- restore point:
  `C:\Users\TK\.gstack\projects\AoA-main\codex-testing-marketplace-recovery-autoplan-restore-20260728-172030.md`

The user approved the plan and authorized A1 implementation. A2 remains gated
on deployed A1 diagnostic evidence, not on a missing technical or product
decision.

NO UNRESOLVED DECISIONS
