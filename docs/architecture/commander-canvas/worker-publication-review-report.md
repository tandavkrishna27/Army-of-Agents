# Universe — focused review: worker output publication proposal

**Reviewed SHA:** `0d8876cdf333ba433c792127e8b4b264fb3a5d22` ("define worker publication authority and recovery proposal"), local == `origin/codex/universe-interface`.
**Compared against baseline:** `8b1dab34095af58fea17bc75c16b3d6809ce44b8`. **Pinned source base:** `183e46a9c65fc3105c7e3d125629276814df7dbb` (unchanged, still ancestor).
**Change:** one docs-only commit, 18 files, +229/−16; 0 non-docs; 1 new file (`worker-publication-plan.md`, 166 lines).
**Scope:** the distributed publication path (E4.2/E4.3/E5.2 + artifact-contract + shared bindings), which the accepted human-intake **A** review deliberately held separate. Human intake A is unchanged (E4.1 files untouched, verified). Planning text only; no runtime/qualification executed.

## Verdict

**The proposal is internally consistent and decidable enough for security review to act on — without claiming runtime readiness.** It presents a concrete per-store data classification, a concrete 7-step publication protocol, and an explicit list of the gates a security owner must still close. All load-bearing source claims verify accurate at the pinned base. No Critical/High findings, and **no undisclosed inconsistency**. The items below are (a) prioritization of the plan's *own* named gates that are load-bearing for security acceptance, (b) one tightening recommendation, and (c) one minor source-claim wording fix.

**Answer to the security-acceptance question:** the *data classification* (application-owned derivative/index/publication/tool-grant records; non-owner job/output unchanged) and the *copy-then-receipt protocol* are consistent and acceptable to reason about now. Acceptance of the **generated** publication path specifically must remain contingent on two of the plan's own gates — accepted-output binding (M1) and revocation serialization (M3) — which the plan correctly leaves open.

---

## Source-claim verification (all accurate at base)

| Claim (worker-publication-plan.md) | Verified in real source | Result |
|---|---|---|
| `one_shot` kinds are only extraction/compaction/readiness_probe; no generic conversion/generation kind | `packages/worker-protocol/src/source.ts:46` `ONE_SHOT_OPERATION_KINDS = ["extraction","compaction","readiness_probe"]`; source union has no conversion kind | **CONFIRMED** |
| commit response `artifactId` is the worker's row identifier, not `assets.id`/`artifacts.id`; commit does not publish an app artifact | `server/src/services/artifact-commit.ts:6` (returns `{artifactId,versionNumber,committedAt}`), `:213` `artifactId: manifest.artifactId`; commits via `runInTenant` only | **CONFIRMED** |
| `versionNumber` best-effort, not uniquely constrained across attempts | `job_artifacts.ts:43` `versionNumber: integer(...)` nullable; committed partial-unique is `(org,job,attempt,identifier) WHERE status='committed'` (`:94-96`) — excludes versionNumber | **CONFIRMED** |
| rich `job_artifacts` fields nullable for thin callers; committed/quarantined disjoint uniqueness; orphan can't collide-update committed | `job_artifacts.ts:27` "ALL columns are nullable"; `:60-66`, `:94/:98` partial uniques | **CONFIRMED** |
| `aoa_app` SELECT-only on assets/artifacts/artifact_versions | `job-control-legacy-grants.ts` (verified prior review, L43-45) | **CONFIRMED** |
| forbidden credential kinds; retention decided by control plane and *recorded, not enforced* | `browser-artifact-retention.ts:40-41,59-60` (cookie/storage = ephemeral, fail-safe ephemeral); `artifact-retention-authority.ts:26` "This does NOT enforce retention. Nothing reads the stored column to act." | **CONFIRMED** (plan correctly treats retention as a gate) |
| Commander admission bridge inert | `job-admission-bridge.ts:26,143,209` ("inert for Commander", `commander_conversation_inert`, "disabled while distributed execution is off") | **CONFIRMED** |
| "the job FK cascades" (source-evidence table) | `job_artifacts.ts`: org FK is `onDelete:"restrict"` (`:20`); the `job_id` FK's onDelete is **not evident** in the schema I read | **UNCONFIRMED** → see LOW-1 |

---

## Design-challenge assessment (all coherent)

- **Per-store application authority vs non-owner job/output — coherent.** Jobs/attempts/leases/job_artifacts stay organization-owned/non-owner; proposed `universe_derivatives`/`universe_asset_index`/`universe_publications`/`universe_tool_grants` are application-owned with company/actor/destination predicates; workers never touch app tables. Publication is *two* transactions (read committed output via `runInTenantReadOnly`; publish via a separate application transaction) — explicitly "not a distributed atomic commit," coordinator "never nests one connection's transaction inside another." Respects M6; no aoa_app grant expansion, no owner fallback.
- **Committed identity vs wire artifactId/versionNumber — correct.** `CommittedOutputRef` keys on `jobArtifactId` (committed row id) + `sha256` + `byteSize`, explicitly "not wire artifactId"; "No worker-version number becomes a user artifact version number." Matches verified source.
- **First-artifact idempotency — correct mechanism, gated key (see M1).** Unique `(companyId, canonicalActionIdentity, outputSlot)` on `universe_publications`; "Unique publication receipt protects first artifact creation as well as later versions; artifact_id/publicationKey alone does not protect duplicate creation of two artifacts."
- **Durable copy / retention / forbidden kinds — coherent, gated.** Copy verified bytes into canonical storage ("never a pointer into an expiring worker object"); allowlist-primary promotion ("Copy only output kinds allowed by the server's admitted processor/output contract") plus explicit denial of credential/session/log/trace/checkpoint kinds; "expired credentials or forbidden retention cannot be bypassed by a copy." Retention enforcement is honestly a gate (source is recorded-not-enforced).
- **Cancellation / revocation / cleanup races — coherent; revocation gated (M3).** Publication row is the serialization point; `cancelPublication` locks, marks cancelled pre-publish, invalidates epoch, records `cancellationRequestedAt`, requests canonical cancel; a reconciler repairs a crash between local decision and remote stop; post-publish cancellation is not deletion. Cleanup needs expired lease + no receipt/reference + locked tombstone, deletes reserved objects only. Revocation-final-commit serialization is explicitly named as an open gate ("A preflight check alone is insufficient").
- **Index receipt visibility — coherent.** Staged chunks invisible until the same-DB transaction publishes the generation receipt + active-generation pointer; reads require the receipt; "Earlier staged batches never establish readiness."
- **Result projection recovery — coherent.** Receipt is the durable result; projections idempotent; a failed projection leaves `published` with `resultProjectedAt=null` for reconciliation; reuse an existing authorized `outputRefs` version rather than mint a second; "A latest-version lookup is never a substitute for missing provenance."
- **Acyclic ownership — coherent.** E4.2/2 owns the common producer (`universe-publication.ts`), buildable/testable with asset results without E4.3; E4.3/1 consumes it and registers "a statically registered trusted artifact/version transaction callback at the composition root … never a model- or worker-selected callback"; E2.2 consumes results; "No reverse dependency requires E4.2's common producer to wait for artifact UI." No build cycle.
- **Frozen source-kind + missing accepted-output binding — honest.** `one_shot` kinds verified frozen; "Arbitrary conversion/generation cannot be disguised as readiness_probe." The accepted-output→committed-attempt mapping is explicitly **missing and gated**: "Until that contract is bound, generated publication remains blocked" (gate "Accepted generated output" → E2.2 + E4.3/1).
- **Concrete protocol vs unqualified gates — cleanly separated.** 7-step protocol is concrete; the "Qualification bindings still required" table names six gates (application authority, processor admission, accepted generated output, revocation serialization, retention/promotion, isolated host) with "Do not report these as resolved by the design."
- **Human intake A unchanged; no grant/protocol expansion — confirmed.** E4.1 files untouched; "No new queue, provider SDK, worker wire shape or broad legacy DML grant is selected"; "No job schema, frozen worker protocol, legacy grant manifest or tenant repository surface changes."

## Propagation & regression (clean)
The recommendation propagated consistently: e4-2.md **removed** the `tenant/universe-derivatives.ts` repo ("no new tenant derivative repository is planned"); e5-2.md removed the tenant grant-repo extension; e4-3.md consumes the receipt and adds the versionNumber/first-artifact clarifications; e2-2.md binds the accepted-output obligation to CMD and keeps GET read-only; implementation-bindings adds the acyclic "Worker publication producer binding." Counts **69/69**, anchors **82 = 70 runtime (all exist) + 12 bundled**, V1 scope (30 / E3.4) unchanged. Over-claim scan on the new file: clean.

---

## Findings (severity-ranked)

**No Critical/High. No undisclosed inconsistency.**

- **[MEDIUM-1 — plan's own gate, load-bearing for acceptance] First-artifact idempotency depends on the still-gated accepted-output / `canonicalActionIdentity` binding.** The "one artifact, no duplicate creation" guarantee rests on `(companyId, canonicalActionIdentity, outputSlot)` uniqueness, but `canonicalActionIdentity` for a generated output is defined by the E2.2/CMD accepted-output mapping that the plan itself leaves open (step 2; line 74; gate table). Correctly gated (generated publication is blocked until bound) — but security acceptance of the *generated* path must not precede a concrete, collision-free, replay-safe accepted-output→canonicalActionIdentity binding, since it is the linchpin of both idempotency and "wrong/superseded attempt denied." *Evidence:* worker-publication-plan.md steps 2/5, line 74, gate "Accepted generated output"; e2-2.md "Worker-publication result binding."
- **[MEDIUM-2 — tightening recommendation] The `other` output kind is the one permissive promotion path; make promotion a strict allowlist.** Step 4 permits `other` "only when the server's exact processor slot/type/hash policy permits it." Promotion is already allowlist-primary, but it is expressed alongside a denylist of forbidden kinds. Recommend the retention/promotion gate express promotion as a strict allowlist of `(processor, output-slot, type, hash-policy)` tuples — kind alone never promotes — and add a regression that an `other`-kinded credential/log/trace payload cannot be promoted. *Evidence:* worker-publication-plan.md step 4 (line 95), gate "Retention/promotion" (line 123).
- **[MEDIUM-3 — plan's own gate, highest confidentiality priority] Revocation-vs-final-commit serialization must be bound and tested before generated/derivative/index publication acceptance.** The plan correctly states "A preflight check alone is insufficient" and names the actual-permission-writer + lock/revision protocol as a gate, but a revoke-during-copy/commit or cached-read race is the sharpest confidentiality risk in the design. Flagging it as the priority gate for security sign-off (not a hidden defect). *Evidence:* worker-publication-plan.md revocation section (line 109), gate "Revocation serialization."
- **[LOW-1 — source-claim wording] "The job FK cascades" is not independently confirmed.** The org FK is `onDelete:"restrict"`; the `job_id` FK's onDelete was not evident in `job_artifacts.ts`. Immaterial to correctness — the design copies provenance into the receipt so a published result survives job deletion regardless — but the source-evidence line should say "receipt lifetime is independent of the job row" rather than assert cascade unless cascade is confirmed at BASE. *Evidence:* worker-publication-plan.md source table (line 21) vs `job_artifacts.ts:20,25`.
- **[LOW-2 — verification note] Confirm the E4.3 publication callback is static at implementation.** Acyclicity relies on E4.3's version-writer being "a statically registered trusted … callback at the composition root … never a model- or worker-selected callback." The plan says so; implementation review should verify the registration is build-time and not an injection surface.

---

## Standing caveats (unchanged; not defects)
- Planning text with proposed, unrun tests; no runtime, migration, provider, grant or secret work executed or authorized.
- Open gates (all named by the plan): application authority (roles/predicates/schema), processor admission (real source kind + result adapter), accepted generated output, revocation serialization, retention/promotion, isolated-host grants — plus the accountable security owner (unassigned).
- **No grant or protocol expansion is authorized; human intake A is unchanged; implementation still requires TK's explicit approval.** This review confirms internal consistency and decidability for security review — not runtime readiness.

*Reviewed `0d8876cdf333ba433c792127e8b4b264fb3a5d22`; baseline `8b1dab34095af58fea17bc75c16b3d6809ce44b8`; source base `183e46a9c65fc3105c7e3d125629276814df7dbb`.*
