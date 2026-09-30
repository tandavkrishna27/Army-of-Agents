# Universe — review: voice/media M1/M2/L1 corrections (credential, budget, session ownership)

**Reviewed SHA:** `47b50fd942bc7272fe9bc758fc4419196fe54e49` ("tighten voice credential budget and ownership plans"), local == `origin/codex/universe-interface`.
**Compared against baseline:** `9da889601d3a5799daad4fcc328b58b1296cd37d`. **Pinned source base:** `183e46a9c65fc3105c7e3d125629276814df7dbb` (unchanged, still ancestor).
**Change:** docs-only, 19 files, +219/−12; 0 non-docs; 2 new files (`voice-media-review-corrections.md` = M1/M2/L1 fixes; `voice-media-review-report.md` = my prior report preserved).
**Scope:** the M1/M2/L1 reconciliation (E3.1/E8.1 + policy). Human intake A untouched (E4.1 unchanged); privacy baseline **preserved, not reopened** (verified). Planning text only; no runtime/credentials/providers/spend.

## Verdict

**M1, M2 and L1 are substantively and correctly resolved**, and every specific sub-challenge is handled coherently and honestly. The old per-user/device and post-issuance single-session wording is reconciled to a DB-enforced single-owner model. Source anchors verify at base — and the key one strengthens the fix: the primary alternate resolver funnels through the guarded common resolver. **No Critical/High.** One MEDIUM (the shared budget-capacity primitive is a new, cross-cutting, owner-unassigned prerequisite whose cost-writer inventory is the load-bearing residual) and two LOW, plus the carried vendor-currency limitation. The remaining items are the plan's own named enablement gates; it does not claim runtime readiness.

---

## Source-claim verification (accurate at base)

| Claim | Verified | Result |
|---|---|---|
| `shouldEnforceSecretBinding` exempts no-path/system/system-routine/plugin; `assertBinding` early-returns when exempt | `secrets.ts:210-223`, `:433` (`if(!shouldEnforceSecretBinding) return`) | **CONFIRMED** |
| **`resolveCompanyProviderKeys` supplies `system` context AND routes through `resolveSecretValue`** | `secrets.ts:1197-1215` — calls `resolveSecretValue(companyId, secret.id, "latest", {consumerType:"system", configPath:"provider.<name>"})`; comment: mirrors "heartbeat's adapter-secret resolver, the LLM provider key" | **CONFIRMED** — a guard at `resolveSecretValue` covers this primary alternate path |
| `deleteBinding` deletes binding rows (last-binding deletion is real) | `secrets.ts:1089-1092`, bulk deletes at `:1132/:1134` | **CONFIRMED** |
| `assertMcpOAuthResolutionAllowed` exists and is distinct (must not be repurposed) | `secrets.ts:128`, called at `:477` | **CONFIRMED** |
| `resolutionScope` is a NEW column (not existing) | absent from `company_secrets.ts` | **CONFIRMED** (proposed, not claimed to exist) |
| `getInvocationBlock` reads observed cost without reserving; `budget-hooks.ts` process-local | `budgets.ts:345`; `budget-hooks.ts` `EventEmitter` | **CONFIRMED** |
| repo uses `uniqueIndex(...).where(sql\`...\`)` partial-unique pattern (L1 basis) | `job_artifacts.ts:94/103/114` committed/quarantined/granted partial uniques | **CONFIRMED** |

---

## Requirement-by-requirement

### M1 — restricted-secret protection at the common resolver — RESOLVED (well-placed), completeness-gated
- **Placement is sound.** The `resolutionScope` (voice_media) classification is checked in `resolveSecretValue` *before* legacy exemptions/vendor resolution; requires provider_connection consumer type + exact capability path + server-derived actor/company/connection + active secret/connection + accepted terms + matching binding + connection.secretRef == this secret. "Generic system/plugin/routine contexts cannot resolve these secrets even if they omit configPath." Since `resolveCompanyProviderKeys` (the system-context sibling) **funnels through `resolveSecretValue`** (verified), the guard genuinely covers it.
- **Survives last-binding deletion / rotation / generic update/import.** Classification lives on the *secret* (not the binding), immutable through create/update/rotate/import after restricted creation; "Deleting the last binding or unlinking/deleting a connection leaves the restricted secret restricted and unresolved. No fallback to general resolution." "Rotation preserves classification." Tests: deleted-final-binding still denied; rotation/import/update cannot remove classification.
- **Preserves unrelated legacy consumers.** "Existing general secrets retain their current legacy behavior"; "No global removal of legacy exemptions"; selecting an existing general secret is *refused*, not auto-converted; "Converting an existing shared credential would require an explicit consumer inventory and separately reviewed migration; it is not part of the initial path." No repurposing of `assertMcpOAuthResolutionAllowed`.
- **Authority/mutation races.** "Binding/connection/secret mutation and resolution must share a documented authority boundary … serialize the grant check and credential handoff against revocation"; test "concurrent resolve/revoke has a defined authorization order."
- **Alternate resolution coverage → LOW-1.** The main alternate (`resolveCompanyProviderKeys`) is verified-covered; the plan makes "prove there is no alternate application resolution/export route for restricted secrets" and "Complete alternate-entry-point inventory is an enablement gate." Residual: confirm no `companySecretVersions` direct-read / export / backup path decrypts restricted material outside `resolveSecretValue`.

### M2 — shared budget producer — RESOLVED (design), scheduled → MEDIUM-1 on ownership/completeness
- **Canonical Budget ownership, no voice-local authority.** "Owner: the canonical Budget service … E8 owns delivery coordination, not a second policy authority or a budget editor." New `budget_capacity_reservations.ts` + `budget-capacity.ts` + integration test; "Existing budgets.ts … remain the policy/accounting authority."
- **Shared-cap concurrent admission.** "serialize admissions and relevant policy/charge updates on a stable company budget authority row … check each applicable cap and persist the hold … An in-memory mutex or a check followed by a separate insert is insufficient"; test "two simultaneous admissions against insufficient shared remaining balance."
- **Reservation vs actual-charge.** "A reservation is a hold, not a second cost event … without treating the same held amount as several actual charges … Usage events settle idempotently against their canonical charge IDs … without counting the same amount twice."
- **Durable stops.** "persist a stop request in the owning durable session/operation record in the authoritative transaction … Local EventEmitter notification is only a wake-up optimization. Multi-server owner restart must observe the persisted stop before resuming."
- **Unknown exposure.** "reserve a finite maximum billable exposure … If a provider cannot establish a bound, that transport stays unavailable … crash, timeout, lease expiry or missing final invoice cannot [release a hold] … A stopped session may retain a budget hold until final billing reconciles."
- **Acyclic scheduling.** "Never require completed voice UI or completed live qualification to build their budget producer"; order BASE+security/schema → E8.1/1 foundations → E3.1/2 + E4.3/2 → E8.1/2 UI (verified in e3-1/e8-1 slice start-conditions).

### L1 — DB-enforced single voice ownership — RESOLVED
- **Partial uniqueness.** Two indexes: `(companyId,userId,startRequestId)` + `(companyId,userId) WHERE terminalAt IS NULL` (repo pattern verified). "Required identifiers are non-null; no nullable user key can bypass uniqueness."
- **State/terminal consistency.** Constrained state enum + DB check "making terminalAt non-null exactly when state is ended or rejected. Unknown never counts as terminal."
- **Start-before-network ordering.** "reserves budget and inserts the reserved session atomically … Only a fenced owner may claim reserved → starting and perform the external start after commit. Record that transition before the call."
- **Lease fencing.** "lease owner plus monotonic generation … Lease expiry allows recovery of the same session record, not a second active session or repeat network start … a database fence alone cannot stop an old external connection."
- **Takeover under unknown external outcomes.** "mark the existing session ending and persist its stop request, then perform provider shutdown outside the transaction. Keep its ownership slot while outcome is uncertain. Only confirmed termination (ended), or definitive proof no provider session was created (rejected), sets terminalAt … Do not hold database locks while waiting on a vendor."
- **Old wording reconciled.** e3-1/2's earlier "one active voice session per user/device … implementation default to review" is replaced with "Enforce one nonterminal session per company/user across devices/tabs with the partial unique index and state constraint … this is application policy, not a provider limit." (No stale per-device wording remains — grep clean.)

---

## Propagation & regression (clean)
- e3-1.md source-evidence line self-corrected: `resolveSecretValue` "enforce[s] company, active status and auditing, with **conditional** consumer binding and the documented legacy exemptions" (was overstated as unconditional).
- e8-1.md schedules the M1 resolver restriction + BUDGET-VOICE-MEDIA producer before paid consumers, with budget-capacity files added to the inventory and Budget-service ownership clarified.
- e3-1/e8-1 slice start-conditions updated to the acyclic order; voice-media-policy.md adds the M1 classification note.
- Counts **69/69**; anchors **82 = 70 runtime + 12 bundled**; V1 scope (3 voice providers + video; E3.4 V2) unchanged; **E4.1 human-intake A untouched**; privacy baseline preserved (not reopened); over-claim scan on both new files clean.

---

## Findings (severity-ranked)

**No Critical/High.**

- **[MEDIUM-1 — plan's own gate, priority prerequisite] The shared budget-capacity reservation is a new, cross-cutting, owner-unassigned canonical-Budget deliverable whose cost-writer inventory is the load-bearing residual.** It does not exist at base (verified: `getInvocationBlock` no reservation; `budget-hooks` in-process) and must bind *every* canonical cost writer/cap atomically for a shared hard cap to hold; the plan states "pin their complete writer inventory … If that inventory cannot establish participation for spend sharing a hard cap, report the gap and keep admission unavailable" and "The actual accountable implementer/reviewer is still unassigned and must be recorded before execution." Fail-closed and honestly gated, but this is the priority prerequisite for *any* paid voice/media path, and (like the prior M3 revocation-writer gate) its guarantee rests on exhaustive writer discovery. **Recommendation:** assign the Budget-service owner and treat "complete cost-writer/admission inventory + concurrent-cap + durable-stop proof" as a hard enablement gate before any paid enablement. *Evidence:* voice-media-review-corrections.md §M2; `budgets.ts:345`, `budget-hooks.ts`.

- **[LOW-1 — named enablement gate] M1 restricted-secret protection is well-placed but completeness depends on the alternate-resolution/export inventory.** The guard at `resolveSecretValue` covers the verified primary sibling (`resolveCompanyProviderKeys` → `resolveSecretValue`), and the plan makes exhaustive alternate-entry coverage an enablement gate. **Confirm at qualification** that no `companySecretVersions` direct-read, export, or backup path can decrypt/emit a restricted secret outside the classification guard, and that heartbeat's adapter-secret resolver / LLM provider-key resolver also funnel through it. *Evidence:* voice-media-review-corrections.md §M1; `secrets.ts:1197-1215`, `:1089`.

- **[LOW-2 — standard planning caveat] The new schema/role bindings are proposed and unrun.** `resolutionScope` on `company_secrets`, `budget_capacity_reservations`, `universe_voice_sessions` (+ its partial-unique/check-constraint) and their exact tenant/role bindings are proposals; the plan says "Confirm company/actor types and composite tenant access before coding" and marks all tests unrun. No source claim treats them as implemented. Standard caveat; ensure the Drizzle-generated migration + tenant/role review land with each.

- **[LIMITATION — carryover, not a plan defect] Vendor-API currency remains unverified by this review.** The corrections file states the author reopened the Sora, GPT-Live-delegation, Gemini-tool and ElevenLabs-retention pages and those four cited claims "remain supported," with "Revalidation before qualification remains required." My January-2026 training cutoff still prevents me certifying any Sept-2026 vendor fact, and per the review constraints I opened no provider docs/sessions. The plan's posture (documentary + spot-recheck + full revalidation gate) is honest; **TK should still require live re-verification of every vendor deprecation/supported-operation/retention/price claim at qualification.**

---

## Standing caveats (unchanged; not defects)
- Planning text with proposed, unrun tests; the resolutionScope guard, budget-capacity primitive and voice-session schema are **proposals awaiting security acceptance and qualification**, not shipped APIs.
- Open enablement gates (named): complete secret resolution/export + mutation writer inventory (M1); complete budget cost-writer inventory + concurrent-cap/durable-stop proof + named Budget owner (M2); provider-specific active-stop/exposure evidence; exact tenant/role/schema bindings; the amendment/relay design acceptance; CMD for distributed runs.
- **Privacy baseline and its Providers location remain accepted and were not reopened. Human intake A and release scope unchanged. No implementation, credentials, provider sessions, dependencies, migrations, commits or spend are authorized.** This review confirms internal consistency and decidability for security review — not runtime readiness or vendor-term approval.

*Reviewed `47b50fd942bc7272fe9bc758fc4419196fe54e49`; baseline `9da889601d3a5799daad4fcc328b58b1296cd37d`; source base `183e46a9c65fc3105c7e3d125629276814df7dbb`.*
