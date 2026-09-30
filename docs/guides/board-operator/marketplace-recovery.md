---
title: "Marketplace recovery"
description: "Run and inspect a guarded fleet marketplace reconciliation"
---

Marketplace recovery is an instance-admin operation. It diagnoses every company,
applies only the existing idempotent repair paths, and returns safe diagnostic
codes. It does not guess at a new repair.

## CLI recovery flow

Authenticate once, then use the same API base for every command:

```bash
pnpm aoa auth login \
  --api-base https://testing.armyofagents.org \
  --instance-admin

pnpm aoa auth whoami \
  --api-base https://testing.armyofagents.org

pnpm aoa marketplace reconcile \
  --api-base https://testing.armyofagents.org \
  --confirm-fleet \
  --timeout-ms 300000 \
  --json

pnpm aoa marketplace inspect <operation-id> \
  --api-base https://testing.armyofagents.org \
  --json

pnpm aoa auth logout \
  --api-base https://testing.armyofagents.org
```

Before the POST on a Compose host, verify the exact reviewed release and
storage contract:

```bash
node scripts/verify-marketplace-recovery-preflight.mjs \
  --api-base https://testing.armyofagents.org \
  --expected-sha <reviewed-sha> \
  --instance-id default \
  --write-root legacy
```

The CLI prints the operation UUID to stderr before the POST, keeping `--json`
stdout as one parseable response document. If the local request times
out, do not retry. Inspect that UUID first. A second operation may be safe only
when inspection returns `safeToRetry: true`. Retry with a new UUID linked to
the inspected predecessor:

```bash
pnpm aoa marketplace reconcile \
  --api-base https://testing.armyofagents.org \
  --confirm-fleet \
  --retry-of <inspected-operation-id> \
  --timeout-ms 300000 \
  --json
```

The server re-runs the inspection and rejects an omitted, stale, mismatched, or
unsafe predecessor reference. A failed-before-mutation attempt does not clear
the retry barrier.

## Reading the result

`skips[]` means a safety gate deliberately left a company unchanged. Every
skip counter has exactly one matching entry. `failures[]` means a company stage
threw or could not persist its result. Both use fixed messages and recovery
instructions; raw exception text and paths are not returned.

```json
{
  "ok": true,
  "operationId": "11111111-1111-4111-8111-111111111111",
  "executionDisposition": "started",
  "replayed": false,
  "status": "partial",
  "skips": [
    {
      "companyId": "company-id",
      "stage": "crew_repair",
      "category": "fail_closed",
      "reason": "skill_resource_fetch_failed",
      "message": "A required skill resource could not be fetched.",
      "retry": {
        "kind": "after_correction",
        "recoveryCode": "restore_resource",
        "message": "Restore the pinned skill resource before retrying."
      }
    }
  ],
  "failures": []
}
```

Join the HTTP response, durable operation ledger, company activity rows, and
server logs using `operationId`. The instance-scoped
`marketplace_reconciliation_operations` row is authoritative for operation-ID
ownership, terminal state, and the cross-replica lease. Company activity rows
remain the per-company audit detail; each completion row contains only that
company's skips and failures. This also keeps a zero-company or pre-audit
operation inspectable after a restart.

## Diagnostic recovery table

| Code | Required action |
|---|---|
| `install_in_flight` | Wait for the active install, then inspect |
| `team_item_not_in_catalog` | Restore the standard crew catalog entry |
| `team_template_unavailable` | Restore the pinned team resource |
| `empty_roster` | Publish a valid non-empty team template |
| `unadoptable_roster_member` | Review the company crew mapping |
| `unaccounted_crew_rows` | Review unaccounted crew rows |
| `skill_resource_temporarily_unavailable` | Wait until `retry.notBefore`, then inspect |
| `skill_resource_fetch_failed` | Restore the pinned skill resource |
| `skill_resource_invalid` | Correct and republish the resource |
| `skill_bundle_materialization_failed` | Repair managed bundle storage |
| `skill_bundle_missing` | Restore or re-materialize the bundle |
| `skill_filesystem_permission_denied` | Correct managed-root ownership |
| `repair_cooldown` | Wait until `retry.notBefore`, then inspect |
| `repair_budget_exhausted` | Start a new bounded operation after completion |
| `unknown_fail_closed` | Inspect company state and sanitized server logs |
| `crew_catalog_not_ready` | Restore the crew catalog prerequisite |
| `legacy_steward_disabled` | Confirm the Steward migration policy |
| `legacy_steward_catalog_not_ready` | Restore the Steward catalog prerequisite |

Failure codes are
`marketplace_update_failed`, `crew_repair_failed`, `legacy_steward_failed`,
`crew_update_failed`, `team_reconcile_failed`, and
`unknown_internal_failure`. Correct or inspect the named company stage before
retrying.

## Endpoint error recovery table

| Code | Required action |
|---|---|
| `invalid_request` | Correct the request and use a new operation UUID |
| `authentication_required` | Log in with a board credential |
| `instance_admin_required` | Obtain instance-admin access |
| `operation_not_found` | Verify the UUID; do not infer retry safety |
| `operation_in_flight` | Inspect the returned active operation UUID |
| `catalog_temporarily_unavailable` | Restore catalog availability, then inspect |
| `catalog_refresh_failed` | Correct catalog publication before a new operation |
| `outcome_unknown_after_mutation` | Inspect; retry only if `safeToRetry` is true |
| `internal_error` | Inspect the operation before any retry |

## Outcome unknown after mutation

This state means domain writes may have committed but the completion audit did
not. The inspection endpoint re-runs read-only diagnosis and fails closed for
active writers, customized rows, unaccounted crew, or query ambiguity. Never
retry merely because the POST returned 500.

Only one fleet reconciliation lease can be active in the database. The lease
is heartbeated while the operation waits for local maintenance locks and while
it runs, so another app replica reports `operation_in_flight` rather than
starting overlapping writes. After a crashed worker's lease expires,
inspection reports `outcome_unknown_after_mutation`; a later POST atomically
fences that stale owner and requires the stale operation ID as
`retryOfOperationId` before it can claim a new operation. Follow the inspection
result and never bypass the ledger with manual activity rows.

## Advanced board-key request

The supported workflow is the CLI. For a controlled diagnostic, an explicitly
supplied board key is non-ambient authority and does not require a fabricated
`Origin` or `Referer`:

```bash
curl -sS -X POST https://testing.armyofagents.org/api/admin/marketplace/reconcile \
  -H "Authorization: Bearer $AOA_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"scope":"fleet","mode":"repair","operationId":"<uuid>"}'
```

For a verified-safe retry, add
`"retryOfOperationId":"<inspected-operation-id>"`. The referenced operation
must be the server's current outcome-unknown retry barrier and must still
inspect with `safeToRetry: true`.

Never place the key in the URL, command history, incident bundle, or committed
fixture.

## Managed bundle storage

| Item | Authoritative value |
|---|---|
| Compose volume | `aoa-data:/aoa` |
| Instance root | `/aoa/instances/<AOA_INSTANCE_ID>` |
| Legacy managed bundles | `/app/.aoa/marketplace-skills` |
| Persistent managed bundles | `/aoa/instances/<id>/marketplace-skills` |
| A1 write selector | `AOA_MARKETPLACE_SKILLS_WRITE_ROOT=legacy` |
| A2 write selector | `AOA_MARKETPLACE_SKILLS_WRITE_ROOT=persistent` |
| Rollback | Change only the selector; both fixed roots remain readable and jailed |

`/paperclip` is a compatibility symlink to `/aoa`, not the authoritative
persistent mount.
