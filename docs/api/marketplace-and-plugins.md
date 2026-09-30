---
title: Marketplace and Plugins
summary: Catalog, installs, company plugin settings, skill imports, plugin jobs, webhooks, and bridge routes
---

Marketplace routes install AoA catalog items. Plugin routes manage installed plugin manifests, settings, jobs, UI contributions, bridge calls, and version history.

The guarded fleet endpoint and its read-only inspection contract are documented
in [Marketplace recovery](/guides/board-operator/marketplace-recovery).

## Marketplace

```
GET /api/marketplace/catalog
POST /api/marketplace/catalog/sync
GET /api/marketplace/catalog/status
GET /api/marketplace/packages
POST /api/admin/marketplace/reconcile
GET /api/admin/marketplace/reconciliations/{operationId}
GET /api/companies/{companyId}/marketplace/settings
PATCH /api/companies/{companyId}/marketplace/settings
GET /api/companies/{companyId}/marketplace/updates
POST /api/companies/{companyId}/marketplace/updates/{id}/dismiss
POST /api/companies/{companyId}/marketplace/updates/{id}/apply
GET /api/companies/{companyId}/marketplace/updates/{id}/diff
POST /api/companies/{companyId}/marketplace/updates/{id}/merge
POST /api/companies/{companyId}/marketplace/request-install
POST /api/companies/{companyId}/marketplace/crew/repair
GET /api/companies/{companyId}/marketplace/resolve/{catalogItemId}
POST /api/companies/{companyId}/marketplace/install
GET /api/companies/{companyId}/marketplace/install/{operationId}
DELETE /api/companies/{companyId}/marketplace/teams/{teamId}
```

Marketplace catalog data comes from the configured AoA marketplace CDN with a build-time snapshot fallback. Company routes apply company policy and installation state.

`GET .../updates/{id}/diff` and `POST .../updates/{id}/merge` accept skill and
agent updates. `/diff` returns a section-level diff (a skill's unit is a `## `
section of its SKILL.md; an agent's is `<file>::<## section>` across its whole
instruction bundle); `/merge` takes a `decisions` map of section → `"mine"` |
`"theirs"`. Skill diffs also return an opaque `snapshotToken`; the client must
send it with the merge so the server can reject a stale review if the local
skill, upstream bytes, or catalog version changed. `/apply` is the unreviewed
one-click landing and refuses team updates.

Both verbs require the update to still be open: like `/apply`, `/merge` answers
409 when the update is not `pending` or `conflict`, so a merge cannot be
replayed against one already applied or dismissed.

Merging a **skill** whose catalog item carries a bundle also re-materializes the
bundle's `references/`, `scripts/` and `assets/` from the upstream commit, into
a new version-scoped directory that the row's
`metadata.catalogBundleInstallPath` is repointed at in the same transaction —
so a file the upstream commit deleted is not delivered to agents afterwards. If
the catalog item has stopped carrying a bundle altogether, the pointer and file
inventory are cleared instead and the row returns to `markdown_only`. The
founder's merged markdown is what lands in `company_skills.markdown`; the
bundle's own SKILL.md is never written over it. The checkout runs before the
transaction, so a failed fetch leaves the pending update untouched and
retryable, and replacing an existing bundle directory is staged and renamed into
place rather than deleted up front — a failed fetch never leaves a skill with no
bundle. The response reports `bundleMaterialized` and, when a bundle was
written, `bundleFileCount`.

`POST .../marketplace/crew/repair` is founder-only. It diagnoses whether the
company's AoA crew is inside the marketplace update pipeline and repairs it if
not — adopting `…@legacy`/unstamped crew agents in place, re-provisioning a
company that has no crew at all, or correcting an install-operation row that
reports failure over a committed crew. It returns `{ diagnosis, result }` and is
a no-op on a healthy company.

Adoption is **pointer-only**: it rewrites `templateOrigin` and `templateVersion`
(to the `0.0.0-legacy` sentinel) and installs the crew team's `company_skills`,
and touches nothing else — instructions, `skillKeys`, `runtimeConfig`, triggers,
adapter and name all stay as the founder has them. The follow-on content update
then arrives through the company's `agentUpdatePolicy` (auto-apply, or a
founder-visible pending update), so repair never discards founder edits. It is
all-or-nothing: if any roster member with a local agent row cannot be adopted,
nothing is written and the company stays repairable.

The same repair runs unattended as part of the boot/24h crew update pass, capped
per pass; the route exists for an operator who already knows a specific company
is stuck. Both share a 6-hour per-company cooldown — send `{"force": true}` to
override it after fixing the underlying cause.

`POST /api/admin/marketplace/reconcile` is an instance-admin recovery operation
with the mandatory strict body
`{"scope":"fleet","mode":"repair","operationId":"<uuid>"}`. It first performs a
fresh, deduplicated CDN catalog sync; a cache or bundled-snapshot fallback never
authorizes fleet mutation. Only a successful CDN attempt may drive the
full-fleet crew repair, legacy Steward adoption, crew update, and team-member
reconciliation sequence.

A 200 response has `status: "success" | "partial"`, the caller-provided
`operationId`, `executionDisposition: "started" | "joined_in_flight"`, catalog
identity, aggregate counters, typed `skips[]`, operation `diagnostics[]`, and
sanitized per-company `failures[]`. The deprecated `replayed` field remains for
one compatibility release and is true exactly when `executionDisposition` is
`joined_in_flight`. A matching concurrent request joins the same promise; a
different ID receives typed `409 operation_in_flight`, and a completed ID is
never executed again.

Operation identity and state are stored in the instance-scoped
`marketplace_reconciliation_operations` ledger before the fleet is discovered.
A database-enforced singleton lease prevents different app replicas from
running overlapping fleet operations. The ledger remains authoritative across
restarts and for a zero-company fleet; company `activity_log` rows provide
per-company audit detail and cannot be created through the generic activity or
plugin logging APIs under the reserved reconciliation namespace.

Before catalog refresh or fleet mutation, the service records the sorted target
set with `catalog: null`. A successful completion audit records final catalog
identity and gives each company only its own skips and failures. A terminal
pre-mutation catalog failure remains inspectable. If mutation may have committed
but the completion audit fails, the POST returns
`outcome_unknown_after_mutation`; operators must inspect before deciding whether
another operation is safe.

Catalog refresh is side-effect-free with respect to installed marketplace
items. Reconciliation snapshots its target companies and persists the start
audit before running the catalog skill/plugin update check, so pending-update
rows and notifications cannot precede the audit boundary. A shared mutation
lock queues periodic/manual catalog update checks behind an in-flight audited
reconciliation, and the reconciliation update check receives the exact audited
company-ID snapshot owned by the ledger rather than rediscovering the fleet.

Every 400, 401, 403, 404, 409, 500, and 502 response uses the strict envelope
`{ok:false,error:{code,message},operationId,retry,docUrl}`. Raw catalog or
exception text is never returned. `GET
/api/admin/marketplace/reconciliations/{operationId}` returns durable
`running`, `success`, `partial`, `failed_before_mutation`, or
`outcome_unknown_after_mutation` state plus `safeToRetry` and a typed recovery
instruction. Callers should retain the operation ID and follow that instruction;
do not infer retry safety from an HTTP timeout.

Pending-update persistence and notification errors from the crew-update pass
are included as sanitized `crew_update` failures rather than being reduced to
application-log-only warnings. The full operator workflow and code-to-recovery
table are in [Marketplace recovery](/guides/board-operator/marketplace-recovery).

`DELETE .../marketplace/teams/{teamId}` is founder-only and permanently deletes
every agent on the team — **except protected AoA agents** (Commander, Steward),
which are **detached rather than destroyed**: the agent row and its triggers
survive, and only its team membership goes away with the team. The response
reports both sides, so retention is never silent:

```json
{ "success": true,
  "deletedAgentIds": ["…"],
  "retainedAgentIds": ["…"],
  "retainedAgents": [{ "id": "…", "name": "Steward", "role": "steward", "why": "…" }] }
```

Protection is decided server-side from the agent's identity, not from catalog
metadata. It is not a refusal because there would be no way back from one: the
AoA crew team is company-wide (`parentProjectId` is null), and roster edits —
both `addMember` and `removeMember` — are refused on a team with no parent
department, so a founder could neither detach the agent nor remove the team.

`DELETE /api/companies/{companyId}/agents/{agentId}` does refuse outright, with
**409**: deleting a single agent has an obvious alternative (pause it), so there
is no dead end.

## Company Plugins

Mounted under `/api/companies/{companyId}/plugins`:

```
GET /
GET /{pluginId}/config
POST /{pluginId}/config
POST /{pluginId}/upgrade
POST /{pluginId}/upgrade/approve
POST /{pluginId}/upgrade/rollback
PATCH /{pluginId}/settings
```

These routes are company-scoped views over installed plugins and pending upgrades.

## Instance Plugin Routes

```
GET /api/plugins
GET /api/plugins/examples
GET /api/plugins/ui-contributions
GET /api/plugins/tools
POST /api/plugins/tools/execute
POST /api/plugins/install
GET /api/plugins/{pluginId}
DELETE /api/plugins/{pluginId}
POST /api/plugins/{pluginId}/enable
POST /api/plugins/{pluginId}/disable
GET /api/plugins/{pluginId}/health
GET /api/plugins/{pluginId}/logs
POST /api/plugins/{pluginId}/upgrade
GET /api/plugins/{pluginId}/config
POST /api/plugins/{pluginId}/config
POST /api/plugins/{pluginId}/config/test
GET /api/plugins/{pluginId}/jobs
GET /api/plugins/{pluginId}/jobs/{jobId}/runs
POST /api/plugins/{pluginId}/jobs/{jobId}/trigger
POST /api/plugins/{pluginId}/webhooks/{endpointKey}
GET /api/plugins/{pluginId}/dashboard
GET /api/plugins/{pluginId}/version-history
POST /api/plugins/{pluginId}/rollback
```

For the public webhook route, `{pluginId}` must be the tenant-specific
`plugins.id` UUID. Manifest IDs/keys are deliberately rejected because the
same key can be installed by multiple companies. Plugin UI code can read the
UUID from `PluginHostContext.pluginInstallationId`.

Compatibility note (2026-08-02): integrations that previously stored a
manifest-key webhook URL must replace that segment with the installed plugin
UUID. There is no key fallback, because resolving a shared key would make an
unauthenticated webhook ambiguous across tenants. Existing UUID webhook URLs
continue to work unchanged.

Bridge routes under `/api/plugins/{pluginId}/bridge/*` and `/api/plugins/{pluginId}/data/*` are for plugin runtime/UI communication and enforce plugin capability and host checks.

## Skills

```
GET /api/companies/{companyId}/skills
GET /api/companies/{companyId}/skills/{skillId}
GET /api/companies/{companyId}/skills/{skillId}/update-status
GET /api/companies/{companyId}/skills/{skillId}/files
POST /api/companies/{companyId}/skills
PATCH /api/companies/{companyId}/skills/{skillId}/files
POST /api/companies/{companyId}/skills/import-package
POST /api/companies/{companyId}/skills/import
POST /api/companies/{companyId}/skills/scan-projects
DELETE /api/companies/{companyId}/skills/{skillId}
POST /api/companies/{companyId}/skills/{skillId}/install-update
```

Skills are company-scoped and may be installed directly, imported from packages, or updated from marketplace sources.

**Founder edits are never silently overwritten.** Once a skill has been edited through
`PATCH .../skills/{skillId}/files`, `company_skills.customized` is `true` and the
source-re-read paths refuse rather than replace it:

- `POST .../skills/{skillId}/install-update` → **409** with `code = "SKILL_CUSTOMIZED"` at
  the top level (matching the catalog apply path) and the same value plus `skillId` under
  `details`. Nothing in the database or on disk is changed.
- `POST .../skills/import` → **201** with the affected skills listed in
  `refusedCustomized` (and a matching entry in `warnings`); they are absent from
  `imported`. Un-edited skills in the same import still update.
- `POST .../skills/scan-projects` → **200** with the affected skills listed in
  `conflicts` (reason names the local edits); they are absent from `updated`. One edited
  skill never aborts the sweep.

`POST .../skills` only creates a fresh canonical key. A name/slug collision returns
**409** with top-level `code = "SKILL_NAME_TAKEN"` and the same value plus `slug` and
`key` under `details`; the existing row and directory are untouched.

`POST .../skills/import-package` remains an authoritative authoring surface and clears
`customized` after replacing the bytes. Company bundle import is conservative instead:
an `existing_company` preview surfaces `existingCustomized: true` and skips that skill
by default. Replacing founder edits requires the exact manifest key in
`overwriteCustomizedSkillKeys` on both the preview and import requests.

A source-re-read refusal also raises a founder hub item. To take the upstream version,
delete the skill and re-import it. This mirrors the catalog apply path, which answers
409 `SKILL_CUSTOMIZED` and routes the founder to the diff/merge review instead.
