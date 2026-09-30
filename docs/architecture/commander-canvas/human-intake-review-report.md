# Universe — focused re-review: E4.1 human intake (selected A)

**Reviewed SHA:** `abbfc3c7eea05932fb53d9c07b93b5ba1c2941d8` ("docs(universe): select human asset intake and clarify remaining decisions"), local == `origin/codex/universe-interface`.
**Compared against baseline:** `51e5b36daf8680749ddb3918857a14a699c1c060`. **Source base:** unchanged `183e46a9c65fc3105c7e3d125629276814df7dbb` (still ancestor).
**Change:** one docs-only commit, 21 files, +105/−45; whole branch still 0 non-docs files, 0 new files.
**Context:** TK accepted **alternative A** (company-scoped application authority) for human original intake — the resolution of prior finding M6.
**Scope of this review:** the E4.1 intake authority consistency, the requested traces, and the E4.2/E4.3/E5 separation + scope/propagation regression. Planning text only; no test/qualification is executed.

## Verdict

**PASS — no material findings.** The selection of A is applied consistently across E4.1 schema, service, finalize, audit, cancellation, cleanup and tests; `organization_id` is explicitly demoted to storage-routing metadata (never authorization); no intake tenant-repository extension or non-owner grant is assumed. E4.2/E4.3/E5 distributed choices remain explicitly and separately reviewed. Human upload does not wait for distributed execution. Nothing is claimed implemented/qualified/approved — the doc is emphatic that acceptance authorizes planning edits only, not code. Release scope and counts are unchanged. Two low/observational notes below; neither blocks.

Implementation still requires TK's explicit approval and the still-open security/owner qualifications.

---

## Requirement-by-requirement verification (exact evidence)

### 1. E4.1 consistently uses company-scoped application authority with actor/destination checks — CONFIRMED
- **Constraints** (`coding-plans/e4-1.md` §Constraints): "TK accepted alternative A for human original intake: company/actor/destination-scoped application records using canonical asset publication authority… distributed ledger ownership is a separate decision."
- **Security gate** (e4-1.md:28–36): A row reads "selected for human intake"; "B/C are not alternate implementation paths inside E4.1/1"; "User acceptance of this architecture does not appoint a reviewer, prove isolation or authorize code."
- **Schema** (e4-1.md:61): "These are application-scoped tables under selected A. `organization_id` is derived from the authorized company for existing storage routing/integrity, **never an authorization substitute or a client-supplied scope**. No intake table is added to the frozen distributed RLS registry. Part reads/writes validate the authenticated intake owner and matching company through the parent; foreign part IDs cannot bypass that predicate."
- **Service** (e4-1.md:63): "**Selected A binding:** …authenticated company/actor/destination context on each entry and parent-scoped part access. Use the same authorized application transaction for the intake pointer, canonical `assetService(tx).create` and audit. **Do not create a `tenantRepositories` intake accessor, register a new organization-RLS table, pass an owner connection to `runInTenant`, or widen aoa_app grants.**"
- **Finalize** (e4-1.md finalize step): "Under A, lock/recheck the intake and destination, then asset + published pointer + audit commit in the same authorized application transaction… Do not claim that existing `assetService(tx).create` can write under today's `aoa_app` grants. The worker's separate publication protocol is not invoked for an ordinary human upload."
- **Audit** (e4-1.md): "Record `asset.created` once with the asset/receipt in the canonical writer transaction… The selected same-role transaction rolls back both pointer and audit if publication fails."
- **Cancellation** (e4-1.md finalize step): "Concurrent finalize/cancel serialize on that row; cancellation that commits first prevents publication, while a committed publication remains downloadable."
- **Cleanup** (e4-1.md): reservation-addressable sweep; "never delete a final object referenced by a published asset or unresolved canonical publication receipt."
- **Tests** (e4-1.md integration recipe + commands): denial via authenticated config + `second-identity`; "**Test two companies in one organization as well as different organizations**, another user in the same company, raw asset metadata/content/render URLs and part/status endpoints… private-conversation canary… Revoke destination access during upload and before finalize… Check pooled-connection reuse **without relying on nonexistent intake RLS**." Commands: "Real PostgreSQL on Linux with the selected A application role… is authoritative… separately exercise non-owner callers to prove they cannot bypass this authority."
  - The **two-companies-one-organization → denied** test is the decisive proof that `organization_id` is not treated as authorization.

### 2. Traces — CONFIRMED
- **Private originals + raw serving routes:** `server/src/services/universe-asset-access.ts:assertUniverseAssetAccess` invoked from `assetRoutes` metadata/content/render "after company authorization and before storage/metadata output"; resolves the ledger by assetId and enforces live destination visibility via existing conversation/discussion authorization "not creator ID or company membership alone"; "Any new asset binding/runtime delivery route must call the same check so a caller cannot sidestep private-destination access through a raw content URL" (e4-1.md:65).
- **Shared derived outputs:** derivative access recurses to source, denies missing/cyclic lineage (depth 4); test "A separate explicit publication of a derived output must not broaden access to its private original." `artifact-contract.md` (new §): "Sharing a derived presentation does not automatically share the private PDF used to create it."
- **Retries:** idempotent parts ("Repeated part requests may repeat identical storage bytes but cannot mutate a different part or publish twice"); "After response loss, GET/same finalize reconciles to the same asset."
- **Task attachment boundary:** unchanged and intact — "`IntakeDestination` intentionally covers only asset-ledger intake; 'Attach to Task' invokes the existing task adapter… Extending task submission to accept resumable asset references requires a separately reviewed canonical task-route change." Uses `issuesApi.addCommentWithAttachments`. `artifact-contract.md`: "The existing task-comment attachment adapter remains canonical where resumable asset references are not yet supported."

### 3. E4.2/E4.3/E5 separate; human upload independent; nothing claimed complete — CONFIRMED
- **E4.2** (e4-2.md:21): "human intake/parts now use selected A… **That does not select the data class or publication protocol for `universe_derivatives` or `universe_asset_index`: classify those separately, with A/B/C still under review** for these distributed consumers."
- **E4.3** (e4-3.md:23): "E4.1 has selected A for human intake only. **Separately bind this distributed publication's A/B/C decision.**"
- **E5:** e4-1.md:28 "do not automatically apply the human-intake choice to E4.2/E4.3 or E5"; E5 coding-plans untouched and make no A claim.
- **implementation-bindings.md:105:** "E4.1 uses selected A… E4.2/E4.3 and E5 distributed stores/publication remain separately classified; A/B/C are still alternatives for those consumers only. Human intake never supplies an owner fallback for distributed execution."
- **Human upload does not wait for distributed execution:** slice-plans/e4-1.md:65 "manual upload does not wait for distributed execution"; e4-1.md:156 "Manual protocol can proceed independently of CMD; generated intake cannot"; "The worker's separate publication protocol is not invoked for an ordinary human upload."
- **Nothing claimed complete/qualified/approved:** `final-planning-decisions.md` — "This request authorizes planning edits and author review. It does not authorize code, runtime qualifications, provider sessions, secret access, migrations or tests of the premature implementation." D2: "The selected application data class is reflected in E4.1, but its exact migration/role trace and runtime implementation remain unapproved. No grant expansion is approved." An over-claim scan across the packet returned only disclaimer lines. Accountable security/intake/storage reviewers remain unassigned.

### 4. Packet propagation + release scope — CONFIRMED
- **Propagation consistent:** the "selected A" statement is echoed coherently in e4-1, slice e4-1, e4-2/e4-3 (as "separate"), implementation-bindings, e4-artifacts.md ("Accepted human-upload architecture"), artifact-contract.md, and final-planning-decisions.md (D2). The prior "reviewed head" pointer was updated to `51e5b36d`. No residual "unselected A/B/C" attached to E4.1 human intake; the only `tenantRepositories`/`runInTenant` mentions in e4-1 either explain the rejected path or explicitly forbid it for intake. No dangling `repositories/tenant/universe-intakes.ts` proposed file remains.
- **Scope unchanged:** `release-plans/v1.md` "Includes 30 existing slices; excludes only E3.4." Increments **69/69** in both plan sets; anchors **82 = 70 runtime (all exist at base) + 12 bundled**; 31 slices. No drift.

---

## Findings (severity-ranked)

**No Critical/High/Medium findings.** The change is a clean, internally consistent selection of A.

- **[LOW / observation — pre-existing, by design]** The `implementation-bindings.md` "Source and output inventory" E4.1 proposed-outputs cell (row unchanged by this commit) lists a representative subset (`universe-intake.ts`, its integration test, `ArtifactIntakePanel.tsx`) and omits several files the coding addendum creates (`packages/db/src/schema/universe_intakes.ts`, `server/src/routes/universe-intake.ts`, `server/src/services/universe-asset-access.ts`, `ui/src/api/universe-intake.ts`). This matches the inventory's own stated convention ("Additional exact modifications and outputs are specified in each linked coding addendum"), is consistent across all rows, and is not introduced by this commit — so it is not a defect. Optional: for the reader's convenience, the E4.1 row could name `universe-asset-access.ts` since it is the private-serving-route guard central to the traces above.
- **[LOW / observation]** `universe_intakes`/`universe_intake_parts` retain an `organization_id` column on an explicitly application-scoped table. This is intentional (storage-routing/integrity metadata) and is directly guarded by the "two companies in one organization → denied" test. Recommendation for the eventual security review: keep that "organization_id is never an access predicate" assertion as a hard, non-removable test gate.

---

## Standing caveats (unchanged; not defects)
- Everything above is planning text with proposed, unrun tests; no runtime, migration, provider or secret work executed.
- Open **decisions/gates** remain: the accountable security decision-maker for A's exact role/transaction/migration trace; the separate E4.2/E4.3/E5 distributed data-class decisions; voice/media permitted-path amendment; the nine runtime gate owners; premature-draft cleanup timing.
- **Implementation still requires TK's explicit approval.** This re-review confirms contract consistency for the accepted A direction only; it does not authorize coding, grants, migrations, or qualification runs.

*Reviewed `abbfc3c7eea05932fb53d9c07b93b5ba1c2941d8`; baseline `51e5b36daf8680749ddb3918857a14a699c1c060`; source base `183e46a9c65fc3105c7e3d125629276814df7dbb`.*
