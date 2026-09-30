# Voice/media qualification inventory and review closure

**September 12, 2026 — static source review only.** The [correction review](voice-media-corrections-review-report.md) of 47b50fd942bc7272fe9bc758fc4419196fe54e49 supports closing M1/M2/L1 at the design-consistency level. [Correction contract](voice-media-review-corrections.md) remains authoritative. The medium/low residuals are tracked qualification requirements, not evidence of runtime readiness or a reason to repeat an unchanged Claude review.

## Source identity and coverage boundary

Inventory source is 183e46a9c65fc3105c7e3d125629276814df7dbb. Universe's server/packages/ui still match that pin. Remote replatform now points to 9200a66c42633019349de937a8b97979acac0f7a; main remains e097d2f9332a2715bdbaf2058a4b751481107713. The new replatform commit is a descendant and changes 16 files, including org-concurrency, job submission/admission, service reconciliation and denial auditing. No merge/rebase or execution-base adoption happened.

The appended reproducible symbol/raw-name census searches tracked server, packages, scripts and CLI source at the pin. Named call paths below were read, not inferred from names alone. This completes a bounded static inventory pass, not proof that dynamically selected SQL, aliases, external operators or future code cannot introduce another path. Implementation qualification must close each unresolved row with tests and a writer/role trace at its actual execution revision.

## Budget admission and accounting paths

| Path / owner | Observed behavior | Required producer integration |
|---|---|---|
| services/budgets.ts:345 getInvocationBlock | Agent/company/department policy checks read observed cost; no capacity reservation | Shared transactional admission before spend; cannot simply lock cost reporting afterward |
| services/org-concurrency.ts:148–190 budget bridge; job-submission.ts / job-admission-bridge.ts | Agent and agent-less preflight feed distributed capacity admission | Add monetary authority without confusing concurrency slots with money; include current replatform denial-audit changes in lock/call signatures |
| internal-agent/aoa-agents/dispatcher.ts:985 | Calls canonical agent budget preflight | Must participate in reserve/admit before delegated paid execution |
| services/crew-budget.ts:121 and callers in approvals, crew-task-service, thread-orchestration, thread-agent-actions | Separate crew preflight reads company policy/observed cost and has user-facing side effects | Preserve side effects while consuming common admission; review every listed caller |
| services/one-shot-cli-budget.ts:66; one-shot-sandbox-cli.ts:180 | Separate company-scope preflight for extraction/compaction/readiness one-shot work | Reserve before sandbox spend, with failure and cleanup accounting; no implicit provider-readiness spend exemption |
| services/costs.ts:45–122; routes/costs.ts:25; aoa-agents/runner.ts:1590 | Agent-required writer inserts event and rollups; default evaluation is fire-and-forget | Settle same hold/charge identity transactionally; existing non-voice paths sharing a cap must participate or have accounted bounds |
| services/heartbeat.ts:2654 | Direct costEvents insert, followed by agent rollup and alert handling | Explicit writer integration; not automatically covered by changing costService |
| services/one-shot-cli-budget.ts:169 | Agent-less event path separate from costService | Shared settlement and company-cap attribution; preserve nullable-agent meaning |
| services/job-budget-cost-bridge.ts:240–306 | Tenant transaction locks job fence, deduplicates cost receipt, charges through existing writers, evaluates synchronously and requests canonical cancellation | Preserve existing authoritative receipt/cancellation; add reservation settlement without duplicate events or reversing fence/company lock ordering |
| services/budgets.ts policy upsert/delete/incident resolution; routes/costs.ts legacy budget setters | Changes policy and/or legacy company/agent limit fields | Cap reduction, deletion and incident approval must serialize with holds; reconcile legacy fields and authoritative policy |
| services/agents.ts config update/revision rollback; services/companies.ts; approvals/hiring and portability | Budget fields can change through more than Budget UI | Trace actual setter calls and lifecycle initialization; creation is not necessarily spend but cannot bypass cap changes |
| services/company-portability.ts:3085/3104/3203 | Imports policy and cost-event rows outside normal writers | Import under paused admission or reviewed common mutation boundary; distinguish historical data from new usage and avoid replayed hold settlement |
| services/companies.ts:609 deletion; DB cascades; backups/restores; seed/maintenance scripts | Cost rows and policies can disappear or be reconstructed | Reconcile/stop active owners before destructive lifecycle operations; raw restore requires controlled maintenance and revalidation, not normal admission |
| server/src/index.ts:1643 and heartbeat cancellation methods | Process-local budget listener triggers runtime cancellation | Durable stop intent/recovery belongs to canonical producer/consumer; event delivery alone is not sufficient |

Read-only/derived matches were separated: org-spend, dashboard/cockpit and projects aggregate costs; hub-items reconciles an attention item; suggestions detects recommendations; finance.ts writes finance_events and merely checks a referenced cost event. These are not extra cost_events writers. packages/db/src/schema and shared validators are structural contracts; job-control-legacy-grants.ts is a role/grant surface requiring review, not an admission API. Seed and marketplace construction paths initialize fields and need lifecycle review, rather than being counted as independent usage charges.

The prefix services/ above means server/src/services/; aoa-agents lives under services/internal-agent/. No new budget-authority API or lock is claimed to exist. Complete admission coverage, not just table-write coverage, remains essential. Changes in agent/company budget fields, refunds/corrections, period rollover, import/restore and late authoritative usage must be included in the common authority's final transaction matrix.

## Secret resolution, mutation and export paths

| Path | Observed behavior | Required treatment |
|---|---|---|
| services/secrets.ts:458 | Common resolver checks status/company, MCP ownership, conditional binding, then provider.resolveVersion | New restricted scope guard goes before legacy exemptions/vendor release; do not change unrelated general secrets |
| services/secrets.ts:1161/1209/1255 | resolveEnvBindings, company provider fallback and adapter runtime config converge on common resolution | Test restricted denial through each public entry; plain environment values are a different input, not proof of reference protection |
| services/heartbeat.ts:3444–3503; internal-agent/aoa-agents/runner.ts:563/602 | Environment and runtime setup consume the above helpers | Verify all source layers and fallback branches, including failures; ordinary CLI behavior remains unchanged |
| services/provider-resolution-deps.ts:86; provider-resolution.ts; one-shot-provider-credential.ts | Selected provider connection secretRef uses common resolver; subscription paths have separate authority | Voice classification cannot accidentally route into subscription or generic fallback; preserve sharing/company owner boundary |
| services/execution-secret-brokers.ts:69; secret-broker.ts; runtime-provider-keys.ts:162/184 | Distributed handle/runtime-key resolution reaches common resolver for company/provider secrets | Verify handle mint and resolve separately; stale handle cannot authorize restricted material through another consumer label |
| services/plugin-secrets-handler.ts:329; routines.ts:618; github-pr.ts:60; routes/workspace-git.ts:208 | Other internal consumers call common resolver, some with legacy exemptions | Restricted material denied even where those general consumers are intentionally exempt |
| routes/agents.ts, routes/providers.ts, services/commander-verify.ts, company-skills.ts | Readiness/configuration paths call adapter runtime resolution | Coverage must include checks, not just actual task execution; no silent capture/spend in new settings |
| services/e2b-credential-authority-wiring.ts:20–50 | Direct companySecretVersions query selects version metadata, not material; actual runtime resolution has another path | Do not label this metadata read a plaintext bypass; still qualify pointer/version revocation |
| services/secrets.ts create/update/rotate/import/delete/binding sync; routes/secrets.ts and provider connection/key setters | Version/material, metadata, bindings and references have multiple mutation paths | Immutable restricted classification; atomic create/bind; deletion cannot downgrade; cover bulk sync and general update/import validators |
| secrets/local-encrypted-provider.ts:92/143; aws-secrets-manager-provider.ts:263; provider-registry.ts | Provider implementation can decrypt/fetch material; scanned production resolveVersion invocation is in common resolver | Restrict access to module/material and trace alternate calls; a grep result is not a sandbox boundary |
| services/company-portability.ts:672 and requiredSecrets flow | Secret references are represented as required environment inputs in inspected export logic | Check nested/config/plugin payload redaction in full export/import qualification; do not certify entire portability format from this excerpt |
| scripts/backup-db.sh → CLI backup → packages/db/src/backup-lib.ts | pg_dump or JS table-copy path exports stored DB rows without secretService; JS path uses SELECT * | Privileged backup is outside application resolver enforcement. Stored encrypted material is still sensitive; prove authorization, storage protection and restore preserving restricted classification. No backup/decryption was run |

A database administrator with ciphertext and the corresponding decryption authority is outside the claim that ordinary application callers cannot resolve restricted secrets. Backups are not automatically a plaintext leak, but must not be described as guarded by resolveSecretValue. Restoring an older schema or classifying restored restricted keys as general is explicitly unsafe; restore validation/maintenance controls are part of qualification.

## Qualification closure checklist

- Budget implementer/evidence author is Codex, acceptance owner is TK, and independent technical review is TK-managed Claude (accepted during this preparation); complete admission, charge, cap-change, import and lifecycle matrix at execution SHA.
- Secret resolution/export and mutation matrix with each direct/indirect entry tested or documented as privileged maintenance, including raw backup/restore.
- Tenant/role, actor types, shared scopes and generated migration acceptance for each new schema; no raw handwritten table/index DDL.
- Real concurrency, crash, late-charge, missed-stop and revoke tests for the implemented producer and consumers.
- Provider active-stop/exposure/account evidence and accepted amendment/relay design before paid enablement; privacy choice is already accepted.

No row closes simply because a role name, test filename or a proposed mechanism exists. No new unchanged Claude review is requested. Material changes discovered while binding these writers receive targeted review.

## Reproducible tracked-source census

Generated from git grep on the exact source pin; entries are candidate references, not independent consumers or a certification of complete runtime coverage. Tests, generated build output and generated migration files are excluded from this call-path census; migrations/roles remain a separate qualification surface. Each entry lists all matching line numbers, allowing another reviewer to repeat and inspect it. Dynamic aliases and operator access still require explicit review.

### Budget policy, accounting and admission references

Search expression: `costEvents|budgetPolicies|budgetIncidents|cost_events|budget_policies|getInvocationBlock|evaluateCostEvent|preflightOneShotCliSpend|preflightCrewDispatch|recordOneShotCliCost|budgetMonthlyCents|spentMonthlyCents`. Matched 67 tracked files after exclusions.

| Source file | Matching lines |
|---|---|
| cli/src/commands/client/agent.ts | 47, 48 |
| cli/src/commands/client/company.ts | 235, 236 |
| packages/db/src/repositories/tenant/job-control.ts | 1394 |
| packages/db/src/schema/agents.ts | 35, 40 |
| packages/db/src/schema/budget_incidents.ts | 4, 7, 12 |
| packages/db/src/schema/budget_policies.ts | 5, 6, 25, 28 |
| packages/db/src/schema/companies.ts | 29, 30 |
| packages/db/src/schema/cost_events.ts | 10, 11, 47, 48, 53, 58, 63, 69 |
| packages/db/src/schema/finance_events.ts | 8, 20 |
| packages/db/src/schema/index.ts | 150, 217, 218 |
| packages/db/src/schema/internal_agent.ts | 113, 114 |
| packages/db/src/seed.ts | 23, 38, 55 |
| packages/shared/src/types/agent.ts | 28, 29 |
| packages/shared/src/types/company-portability.ts | 22, 23, 61, 285, 306, 307, 328, 329 |
| packages/shared/src/types/company.ts | 11, 12 |
| packages/shared/src/validators/agent.ts | 141, 166 |
| packages/shared/src/validators/budget.ts | 5, 6 |
| packages/shared/src/validators/company-portability.ts | 25, 26, 65, 286, 312, 313, 344, 346, 348, 350 |
| packages/shared/src/validators/company.ts | 11, 42 |
| packages/shared/src/validators/cost.ts | 20 |
| packages/shared/src/validators/internal-agent.ts | 24 |
| scripts/finding-ownership.json | 64 |
| scripts/gate-clause-wiring.json | 70 |
| server/src/db/job-control-legacy-grants.ts | 84, 86, 594, 597, 734, 737 |
| server/src/dev/seed-commander-review.ts | 6, 196, 200, 201, 202 |
| server/src/routes/access.ts | 2674, 2675 |
| server/src/routes/agents.ts | 1247, 1289, 1290, 1291, 1292, 1394 |
| server/src/routes/companies.ts | 216, 271 |
| server/src/routes/costs.ts | 96, 105, 120, 150, 159, 174 |
| server/src/routes/internal-agent.ts | 85 |
| server/src/routes/projects.ts | 3, 617, 620, 622, 623, 625, 626, 629, 630, 631, 632, 635, 636, 646, 656 |
| server/src/services/agents.ts | 76, 139, 174, 175, 191 |
| server/src/services/approvals.ts | 7, 319, 411, 412, 418 |
| server/src/services/budgets.ts | 3, 30, 31, 32, 36, 38, 40, 41, 46, 48, 56, 61, 66, 69, 70, 71, 72, 85, 134, 136, 174, 177, 178, 179, 180, 181, 190, 198, 205, 226, 229, 230, 295, 298, 299, 302, 310, 313, 314, 339, 345, 356, 359, 360, 361, 362, 363, 380, 383, 384, 385, 386, 387, 402, 405, 406, 407, 408, 409, 423, 431, 443, 446, 447, 517, 520, 521, 540, 542, 547, 549, 575, 577 |
| server/src/services/cheap-fallback.ts | 3, 15, 19, 22, 39, 41, 55, 56, 59, 60, 65 |
| server/src/services/cockpit.ts | 37, 39, 350, 359, 360, 363, 364, 365, 370, 373, 374 |
| server/src/services/companies.ts | 36, 195, 609 |
| server/src/services/company-portability.ts | 6, 8, 72, 73, 105, 175, 176, 242, 382, 383, 396, 426, 427, 1146, 1148, 1274, 1282, 1322, 1501, 1504, 1505, 1522, 1526, 1527, 1528, 1529, 1530, 1534, 1547, 1625, 1626, 2332, 3026, 3043, 3045, 3066, 3067, 3085, 3098, 3104, 3124, 3125, 3129, 3203, 3205 |
| server/src/services/costs.ts | 3, 21, 38, 39, 47, 69, 82, 90, 103, 104, 120, 137, 138, 139, 143, 145, 150, 151, 157, 163, 164, 165, 169, 172, 173, 174, 176, 177, 179, 180, 189, 272, 273, 274, 276, 280, 282, 283, 284, 287, 289, 294, 295, 296, 298, 302, 304, 305, 306, 309, 311, 319, 320, 321, 323, 328, 329, 330, 331, 334, 351, 352, 353, 354, 356, 359, 360 |
| server/src/services/crew-budget.ts | 4, 32, 40, 41, 48, 121, 134, 186, 189, 190, 191, 192, 193, 194, 195, 210, 212, 215, 216, 217 |
| server/src/services/crew-task-service.ts | 36, 126, 153, 173, 188 |
| server/src/services/dashboard.ts | 3, 85, 87, 90, 91, 97, 98, 112 |
| server/src/services/extraction.ts | 19, 801 |
| server/src/services/feedback-bundles.ts | 146 |
| server/src/services/finance.ts | 3, 57 |
| server/src/services/heartbeat.ts | 13, 2654, 2670, 2676, 2686, 2691, 2692, 2695, 2696, 2701, 4792, 4797 |
| server/src/services/hub-items.ts | 19, 1649, 1652, 1663, 1670, 1677, 1678, 1679, 1681, 1687 |
| server/src/services/hub-legacy-alerts.ts | 3, 47, 56, 60, 61, 62, 64, 72 |
| server/src/services/internal-agent/aoa-agents/dispatcher.ts | 835, 985 |
| server/src/services/internal-agent/cli-summarizer.ts | 162 |
| server/src/services/internal-agent/proactive.ts | 201, 210, 211, 216 |
| server/src/services/job-authoritative-rate.ts | 12, 40, 63 |
| server/src/services/job-budget-cost-bridge.ts | 13, 16, 17, 18, 27, 31, 50, 70, 206, 247, 277, 287 |
| server/src/services/job-distributed-drain.ts | 29 |
| server/src/services/job-shadow-comparator.ts | 14 |
| server/src/services/marketplace-install/agent-create.ts | 169 |
| server/src/services/marketplace-install/agent-runtime.ts | 132, 276, 334 |
| server/src/services/marketplace-install/types.ts | 125, 157 |
| server/src/services/one-shot-cli-budget.ts | 3, 7, 9, 11, 12, 16, 17, 20, 22, 24, 27, 58, 60, 66, 76, 79, 80, 81, 82, 83, 84, 85, 92, 100, 102, 105, 106, 107, 142, 161, 162, 169, 172, 182, 206 |
| server/src/services/one-shot-sandbox-cli.ts | 61, 62, 103, 104, 115, 116, 146, 180, 349, 358 |
| server/src/services/org-concurrency.ts | 5, 164, 171, 180 |
| server/src/services/org-spend.ts | 3, 27, 39, 40, 41 |
| server/src/services/platform-execution-limit.ts | 17 |
| server/src/services/sandbox-readiness-probe.ts | 116 |
| server/src/services/suggestions.ts | 688, 689, 698, 699, 709, 715, 728, 734, 748, 754 |
| server/src/services/thread-agent-actions.ts | 33, 879 |
| server/src/services/thread-orchestration.ts | 47, 470, 481 |

### Secret resolution, version/material and mutation references

Search expression: `companySecrets|companySecretVersions|companySecretBindings|company_secret_versions|company_secret_bindings|resolveSecretValue|resolveEnvBindings|resolveAdapterConfigForRuntime|resolveCompanyProviderKeys|applyCompanyKeyFallbackForRuntime|resolveVersion\(|decryptValue|runDatabaseBackup|runDatabaseRestore`. Matched 50 tracked files after exclusions.

| Source file | Matching lines |
|---|---|
| cli/src/commands/db-backup.ts | 4, 61 |
| packages/db/src/backup-lib.ts | 586, 1056 |
| packages/db/src/backup.ts | 4, 102 |
| packages/db/src/index.ts | 36 |
| packages/db/src/schema/company_secret_bindings.ts | 3, 5, 6, 10, 21, 22, 23, 28 |
| packages/db/src/schema/company_secret_versions.ts | 3, 5, 6, 9, 23, 24, 25 |
| packages/db/src/schema/company_secrets.ts | 7 |
| packages/db/src/schema/index.ts | 154, 156, 157 |
| packages/db/src/schema/job_secret_handles.ts | 58 |
| packages/db/src/schema/mcp_connector_oauth_refresh_leases.ts | 3, 19 |
| packages/db/src/schema/provider_connections.ts | 14, 51 |
| packages/db/src/schema/routines.ts | 14, 68 |
| packages/db/src/schema/runtime_provider_keys.ts | 4, 13 |
| packages/db/src/schema/secret_access_events.ts | 3, 13 |
| scripts/finding-ownership.json | 35, 36, 293 |
| scripts/force-mcp-oauth-expiry.ts | 104 |
| scripts/rollback-mcp-oauth-v2.ts | 4, 21, 83, 227, 228, 238, 242, 243, 244, 245, 246, 247, 248, 251 |
| server/src/db/security-definer-manifest.ts | 132, 141 |
| server/src/index.ts | 18, 2318 |
| server/src/routes/agents.ts | 417, 642, 2107 |
| server/src/routes/commander-key.ts | 147, 161 |
| server/src/routes/providers.ts | 153, 478, 532, 540, 712, 713, 716, 717, 718, 800 |
| server/src/routes/workspace-git.ts | 208 |
| server/src/secrets/aws-secrets-manager-provider.ts | 263 |
| server/src/secrets/external-stub-providers.ts | 25 |
| server/src/secrets/local-encrypted-provider.ts | 92, 143, 145 |
| server/src/secrets/types.ts | 53 |
| server/src/services/canary-preflight-evidence.ts | 4 |
| server/src/services/canary-preflight-store.ts | 14, 22, 104 |
| server/src/services/commander-key.ts | 6 |
| server/src/services/commander-verify.ts | 67 |
| server/src/services/companies.ts | 41, 619, 621, 627 |
| server/src/services/company-skills.ts | 1559 |
| server/src/services/e2b-credential-authority-wiring.ts | 3, 16, 35, 36, 39, 40, 43 |
| server/src/services/e2b-credential-authority.ts | 13, 37 |
| server/src/services/execution-secret-brokers.ts | 28, 40, 42, 69 |
| server/src/services/github-pr.ts | 60 |
| server/src/services/heartbeat.ts | 3444, 3451, 3457, 3467, 3468, 3503 |
| server/src/services/internal-agent/aoa-agents/runner.ts | 550, 563, 602, 776 |
| server/src/services/legacy-resource-reconciliation-store.ts | 28 |
| server/src/services/mcp-connectors-loader.ts | 68 |
| server/src/services/one-shot-provider-credential.ts | 89 |
| server/src/services/plugin-secrets-handler.ts | 38, 321, 322, 329 |
| server/src/services/provider-connections-backfill.ts | 6, 152, 153, 154, 156, 157, 160, 161, 162 |
| server/src/services/provider-resolution-deps.ts | 22, 24, 86, 88 |
| server/src/services/provider-resolution.ts | 206, 210, 389 |
| server/src/services/routines.ts | 6, 614, 615, 618 |
| server/src/services/runtime-provider-keys.ts | 3, 30, 31, 122, 162, 184 |
| server/src/services/secret-broker.ts | 147 |
| server/src/services/secrets.ts | 5, 7, 8, 129, 286, 323, 329, 330, 337, 338, 367, 409, 433, 439, 442, 443, 444, 445, 446, 458, 464, 488, 494, 547, 548, 549, 562, 571, 572, 573, 574, 590, 604, 605, 608, 609, 610, 616, 789, 808, 849, 850, 862, 871, 892, 901, 922, 924, 934, 970, 989, 1009, 1019, 1020, 1029, 1031, 1032, 1059, 1072, 1073, 1074, 1075, 1092, 1126, 1127, 1128, 1129, 1132, 1134, 1161, 1173, 1192, 1197, 1203, 1209, 1224, 1226, 1236, 1244, 1255, 1262, 1263, 1285 |
