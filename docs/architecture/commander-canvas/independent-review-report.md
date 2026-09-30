# External review evidence

The report below was supplied by TK. It records the reviewer's claims and recommendations, not repository instructions, accepted scope changes or implementation authorization. Author dispositions are in [the review response](independent-review-response.md). In particular, the report's statement that every documentation correction needs TK's per-finding approval is not in the agreed handoff: verified planning corrections are allowed; material scope/policy decisions and implementation remain separately gated.

---

# Universe planning packet — independent review report

**Reviewed branch:** `codex/universe-interface`
**Reviewed commit (branch head):** `f63b84461341fc93f65417103fc8e57357a93939` — a single documentation-only commit ("docs(universe): plan all epics and slices with reviewed source bindings"), local == `origin`.
**Pinned source base:** `183e46a9c65fc3105c7e3d125629276814df7dbb` (verified: the exact base named throughout the packet; it is the merge-base of head and base, and the branch adds 119 docs files and nothing else).
**Reviewer:** Claude (Opus 4.8), independent review per `claude-review-handoff.md`. Review-only: no files changed, no implementation, no installs/providers, no branch changes, no commits. The premature implementation draft was treated as excluded (and I confirmed the branch is docs-only, so the draft *code* is not present).
**Method:** read the full packet (all 119 docs); independently verified the packet's factual claims **against the real code at the pinned base** via `git show`/`grep` on the actual source files (not on the packet's word); ran eight adversarial per-epic deep audits against the actual codebase and re-verified their load-bearing findings myself.

> **For the packet author (codex):** this report is written so you can act on it directly — each finding names the file/section, the source evidence, why it's a problem, and a concrete correction. Applying corrections is still gated on TK's per-finding acceptance and explicit implementation approval (per `claude-review-handoff.md`); a reviewer's report does not by itself authorize edits or coding. The **v2** of this report adds an explicit real-code confirmation (§2) and a **test-type coverage** analysis incl. UAT (§4b, finding M13) that were not in the first pass.

---

## Contents

1. Readiness verdict
2. What I independently verified (the factual backbone) — incl. explicit real-code confirmation
3. HIGH findings (H1–H2)
4. MEDIUM findings (M1–M13, incl. M13 test-type/UAT)
4b. Test-type coverage matrix (unit / integration / e2e / UAT)
5. LOW findings (L1–L7)
6. Root-cause synthesis
7. Missing decisions to surface
8. Scope integrity
9. Review limits
- Appendix A — Real-code verification evidence
- Appendix B — Per-epic audit summaries

**Summary count:** 2 HIGH · 13 MEDIUM · 7 LOW. Verdict: strong planning artifact, not coding-ready; accept as reviewed baseline after H1/H2 + M1–M5 fixes and re-review; scope (30 V1 / E3.4 V2 / 69 increments) intact.

---

## 1. Readiness verdict

**Publish/planning stage: PASS.** This is an unusually rigorous and honest planning packet. Its central, verifiable claims are accurate; it consistently separates *specified / bound / implemented / verified*; and it never claims coding readiness (it repeatedly and correctly says it does not).

**Coding readiness: NOT READY — as the packet itself states.** Beyond the packet's own open gates, I found **two HIGH producer-completeness gaps** (§3) that must be fixed before E5/E1.4 can be built as written, plus a cluster of **cross-document inconsistencies** (§4) that undercut the packet's core promise of precise, single-owner, acyclic bindings. None is a source-accuracy error or a scope reduction; the recurring root cause is **incomplete propagation from the authoritative `implementation-bindings.md` back into the per-slice/coding plans** (§6).

**Recommended disposition:** Accept as the reviewed planning baseline **after** the two HIGH gaps and the MEDIUM cross-doc reconciliations are applied and re-reviewed. Keep implementation gated on (a) TK's explicit go, (b) BASE refresh + reviewer assignment, (c) the named producer qualifications, and (d) the still-open premature-draft disposition. Scope integrity (30 V1 / E3.4 V2 / 69 increments) is intact — do not let the fixes reduce it.

---

## 2. What I independently verified (the factual backbone — strong)

Every one of these I checked myself against base `183e46a9c`:

- **Anchor inventory is exact.** "82 anchors = 70 exist at base + 12 bundled planning docs" — confirmed by count *and* by existence-checking all 70 runtime anchors (100% present). All 92 "proposed output" files are genuinely absent at base (zero undeclared collisions); `ui/src/components/universe/` does not exist at base.
- **Count integrity is clean** — the failure class that has repeatedly bitten this program. Both the coding-plans and slice-plans contain exactly **69 increments**, matching the index per-slice; **31 slices; V1 = 30, V2 = E3.4** (table sums correctly).
- **Every named symbol / line / signature / behavior I sampled is accurate**, including: `rls-tenant.ts` 8 frozen tables + CAV-005 legacy exclusion; `runInTenant`/`runInTenantReadOnly`; `contextAssemblyService(db).assembleContext(companyId, options)` (exact signature); `getMessageByClientSubmissionId` + `claimTurn` (the real replay hazard E2.2 addresses); `internal_agent` `runId`/`clientSubmissionId`/`outputRefs`; `routines.ts:1538–1603` advancing `nextRunAt` before dispatch with no occurrence key; `insertActivityLog`/`publishActivityLogged`; Decision #122 at `decisions.md:1971` (+ 2026-09-01 amendment); `App.tsx` `:companyPrefix`/`home`/`commander`; `chatMessageSchema` (10000/5000/200/5); `CommanderTaskFocusPane` props; `proactive.ts` denial-namespace exclusion; `lease-renewal.ts:682` `if (!handlers?.result) return false`; xlsx caps (12/1000/50); office render 15 MiB; `aoa_app` SELECT-only on `assets`/`artifacts`; JOB-015-result exists.
- **Ancestor-revision citations are not stale.** Several companion docs pin *ancestor* revisions (`053f90fc8`, `72479410b`, `f09230f3e`, local main `06320643a`) rather than the base; all are ancestors of `183e46a9c`, and **zero** anchor files changed between them and the base — so the load-bearing line claims still hold. (See L1.)
- **Premature draft correctly quarantined.** The two premature branches (`codex/universe-integration`, `codex/universe-e1-1` + `.worktrees/universe-e1-1`) exist and are separate; the review branch is docs-only; disposition (delete/preserve/reuse) is explicitly left open on the agenda.
- **Contracts are professional-grade.** `request-contract`, `state-contract`, and `panel-contract` handle idempotency-vs-exactly-once honestly ("internal dedup cannot promise exactly-once external actions"), and the capability bridge is careful in exactly the ways this program has been burned before ("a panel declaration requests capability; it does not grant it"; "channel delivery is not action completion"; opaque origin not trusted as `null`; host-controlled identity is authority).

Bottom line: this packet is the *opposite* of the "records disagreeing with code" pattern — the source binding is real. The weaknesses below are about intra-packet contract synchronization, not truthfulness.

**Real-code confirmation (explicit):** every source claim I reported was read from the actual file in the base tree, not accepted from the packet text. Examples re-read in-source: `server/src/db/rls-tenant.ts` (8-table freeze + CAV-005), `server/src/db/job-control-legacy-grants.ts` (`aoa_app` = `["SELECT"]` on `assets`/`artifacts`/`artifact_versions`, lines 43–45), `server/src/services/routines.ts:1538–1603`, `packages/worker-daemon/src/lease/lease-renewal.ts:682`, `server/src/services/internal-agent/{agent-loop,context-assembly,conversation}.ts`, `packages/db/src/schema/internal_agent.ts`, `packages/shared/src/validators/internal-agent.ts`, `packages/browser-runtime/src/launch-guard.ts`, `ui/src/App.tsx`, `ui/src/context/ThemeContext.tsx`, `docs/architecture/decisions.md:1971`. The two HIGH gaps (H1/H2) were confirmed by grepping the E1.2 plan itself (`checkpoint` = 0 hits, `ordinal` = 0 hits) against what the bindings + E1.4/E5 require.

---

## 3. HIGH findings (fix before coding)

### H1 — E1.2's checkpoint producer is assigned by the bindings but absent from E1.2's own plan
- **Where:** `implementation-bindings.md` §"Block and executable-tool checkpoint producer" vs `coding-plans/e1-2.md` + `slice-plans/e1-2.md`.
- **Evidence (verified):** bindings state E1.2 defines the `universe_panel_checkpoints` table (`packages/db/src/schema/universe.ts`), adds `getCheckpoint(scope,key,sourceVersionId)`/`saveCheckpoint(scope,key,input)` to `universeStateService`, and adds `universe-checkpoints.integration.test.ts`. But `checkpoint` appears **0 times** in either E1.2 plan; E1.2 defines only `universe_layouts`/`universe_layout_operations` and `get/apply/getReceipt`. The bindings doc itself admits "This shared producer closes a planning omission; it has not been implemented." **Consumers are V1:** E5.1 and E5.2 (block/tool checkpoints), and the checkpoint contract is referenced by e1-6/e2-1/e4-1/e7-3/e8-2.
- **Why it matters:** as written, E5.1/E5.2 have no producer for their checkpoint CAS store; building E1.2 to plan would leave E5 blocked.
- **Correction:** fold the checkpoint table + `getCheckpoint`/`saveCheckpoint` + route (`…/panels/:panelKey/checkpoint`) + integration test into E1.2's increments and its `universeStateService` contract (or assign to a named new increment), and cross-link from E5.1/E5.2.

### H2 — `openedOrdinal` has no producer
- **Where:** `coding-plans/e1-4.md` §E1.4/2 + `implementation-bindings.md` "Geometry versus overview order (E1.2 → E1.4)" vs `coding-plans/e1-2.md`.
- **Evidence (verified):** E1.4/2 requires "Persist an immutable `openedOrdinal` on creation … Allocate the next ordinal atomically with the layout open operation," and bindings assign that persistence to the E1.2→E1.4 edge. But `ordinal` appears **0 times** in E1.2's plan (its `open` op, `universe_layouts` document, and `LayoutAck` neither allocate nor return an ordinal), and the E1.1 reference `Panel`/`State` has no ordinal field/counter. (`openingRect(…, ordinal)` in the E1.1 reference is only a placement-cascade offset, not a persisted key.)
- **Why it matters:** E1.4's atomic ordinal allocation is unimplementable as written; overview order has no stable source.
- **Correction:** add a monotonic `openedOrdinal` counter to E1.1 `State` + persist/allocate/return it in E1.2's open op and ack — or explicitly reuse the existing `generation` (which already has "new on reopen / kept on minimize-restore" semantics) and document the reuse.

> Both HIGH items are **planning-completeness** defects (a V1 consumer references an E1.2 producer that E1.2's plan omits), not code-correctness bugs and not scope reductions. They are cheap to fix by editing E1.2/E1.1.

---

## 4. MEDIUM findings

### M1 — Cross-document propagation drift: output paths & filenames diverge between `implementation-bindings.md` and the coding plans
The authoritative inventory and the coding addenda disagree on file identity for the same logical outputs (verified instances):
- **E2.1:** coding-plan creates `packages/shared/src/validators/universe-context.ts` + `server/src/services/universe-context.ts`; bindings (and slice) reserve `packages/shared/src/types/universe-context.ts` + `server/src/services/internal-agent/universe-context.ts` (the latter is also the pattern-correct home, next to `context-assembly.ts`/`agent-loop.ts`).
- **E1.4:** coding `OpenPanelOverview.tsx`/`PanelPreview.tsx` vs bindings `OpenPanelsOverview.tsx`/`PanelPreviewRail.tsx`.
- **E1.6:** coding `viewport-policy.ts`/`motion-policy.ts` vs bindings `viewport-controller.ts`/`motion-tokens.ts` (this one also contradicts E1.6's own slice-plan).
- **E1.3:** unit test `draft-state.test.ts` vs slice `draft-recovery.test.ts`; **E1.5:** E2E `universe-commander.spec.ts` vs `universe-commander-surfaces.spec.ts`; **E5.1:** `registry.tsx`/`registry.test.tsx` vs `registry.ts`/`registry.test.ts` (a `.ts` file cannot hold inline JSX).
- **Correction:** reconcile each output to a single canonical path/name across bindings + slice + coding; treat `implementation-bindings.md` as the source of truth and re-sync the addenda. (Mitigated but not eliminated by the "confirm collisions at BASE" step, since all files are new.)

### M2 — E2.1 ↔ E1.6 viewport-producer contradiction (apparent cycle)
`coding-plans/e2-1.md:25` says E2.1 builds its payload "from E1.1 registry/**E1.6** viewport," but `slice-plans/coding-readiness.md:25` says **E1.1** establishes viewport data and **E1.6 consumes**, while `coding-plans/e1-6.md:25` says E1.6 **emits** the E2.1 context *and* lists "E2.1 context binding" as a start condition. Taken literally this is a cycle. It is resolvable only by the (correct, but unstated at the coding-plan level) split of E2.1 into an early contract/type definition + later optional consumption. **Correction:** make E2.1 source viewport *data* from E1.1 per the sequencing contract; state the E2.1 contract-vs-consumption split explicitly so E1.6↔E2.1 is unambiguously acyclic.

### M3 — Dependency declarations disagree across the register / slice / coding docs
Sibling slices are inconsistent about their own start conditions:
- **E2.1:** register says "E0.1; existing Commander context"; slice says "BASE; E1.1"; the addendum actually needs E1.1 **+ E1.3 + E1.6**.
- **E5.1:** start-condition line omits E1.1/E1.2(checkpoint)/E1.3/E2.2 that the addendum requires.
- **E7.3:** start conditions say "BASE; E3 only for speech" but the addendum needs **E8.1/1** (preference foundation) for `attentionPreviews`/`soundEffects`/`spokenAnnouncements`.
- **Correction:** make each slice's start-condition line list the producers its own addendum consumes. (E2.4 does this correctly — use it as the template.)

### M4 — E1.3 answer-draft destinations are ordered-but-undesigned; bindings vs plan disagree on arity *(independently flagged by both the E1 and E7 reviewers)*
`coding-plans/e1-3.md:14` declares a **five-kind** `Destination` union (`commander|task|question|runtime_decision|approval`) but with a **text-only** `Draft={revision,text,attachmentAssetIds}` and a text-only `afterAcknowledgement`. `implementation-bindings.md` still calls E1.3 a "two-kind illustrative text-draft union" that must be extended (with per-source answer schemas — "never this text shape") **before E7.3 consumes it**. Real answer payloads are structured, not text (`AnswerWorkQuestionInput` = `{expectedVersion, idempotencyKey}`; runtime decision uses `expectedSourceRevision`; approval is a selection). So the ordering rule is satisfied on paper but the structured answer-draft payload is *named, not designed*, and the two docs disagree on E1.3's kind count.
- **Correction:** before E7.3 consumes it, have E1.3 concretely model a bounded per-kind answer-draft payload (carrying source-specific `expectedVersion`/`sourceRevision` + attempt/`clientSubmissionId`), separate from the text `Draft`; reconcile bindings to say E1.3 owns all five kinds. Until then, ship only `commander`/`task`.

### M5 — Voice V1/V2 allocation still reads "open" in the authority docs (latent scope-drift surface)
Five sites state the allocation is "open/unresolved/not fixed," contradicting the accepted **V1 = 30 / V2 = E3.4**: `master-scope.md` §9 L154 ("Version allocation remains open"), L29 ("no V1/V2 allocation is fixed"), L43 ("does not assign features to version one or two"); `readiness-review.md` L58; `ui-review-decisions.md` U08 L109. The review prompt says to *start with* the master scope, so a reader hits "allocation open" first. `release-plans/README.md` records the allocation as accepted and superseding, but these authority-doc phrasings carry no supersession pointer. This is not an actual reduction — but it is exactly the drift surface this review is charged to close.
- **Correction:** at each of the five sites, replace "allocation open/unresolved" with the accepted allocation or add an explicit "superseded by `release-plans/README.md`" pointer.

### M6 — E4.1 finalize presents a cross-role single transaction that conflicts with verified grants
`coding-plans/e4-1.md:75` (E4.1/1) says finalize will "create asset and published ledger pointer in one transaction. Existing `assetService(tx).create` can participate in that transaction." The intake ledger is proposed **organization-owned** (`organization_id`, `runInTenant`), but the non-owner `aoa_app` role holds only `["SELECT"]` on `assets`/`artifacts`/`artifact_versions` (`job-control-legacy-grants.ts`, verified) and `assets` is a CAV-005 legacy table excluded from tenant RLS. A single transaction cannot span the owner and non-owner connections, so the "one transaction" either fails (no INSERT grant) or forces widening `aoa_app`'s write surface over a CAV-005 table. The plan *does* hedge this at L28/L55 ("merely calling `runInTenant` does not secure those legacy rows"; data class deferred to a BASE security gate), so this is **MEDIUM, not HIGH** — but the increment step prejudges cross-role atomicity while the data class is still open.
- **Correction:** commit the intake ledger to the **company-scoped owner pool** (app-layer `assertCompanyAccess`, exactly like `assets`/`artifacts` under CAV-005) so the asset+ledger write is one ordinary same-role transaction; or, if organization-owned, state explicitly that finalize is cross-role and requires an `aoa_app`→`assets` INSERT grant decision with its CAV-005 consequences — do not present it as a plain shared transaction.

### M7 — E4.3 media generation sits inside the E4.3 V1 completion bar vs Decision #104
E4.3 is V1, and the release rule is "a blocked subpart keeps the slice incomplete." E4.3/2 binds "media image/audio/video generation adapters." A hosted media-generation provider is a new hosted-API-key path that **Decision #104** ("only runtime hosted key is embeddings") forbids without an explicit amendment. The plan is **#104-aware** (it says any new paid hosted generation path "require[s] an explicit reviewed exception" and that media adapters "qualify separately"), so this is a scope-clarity issue, not a policy violation. But as written, E4.3 *V1 completion* is contingent on a policy amendment that does not exist.
- **Correction:** explicitly carve provider-based generative media out of the E4.3 **V1 completion bar** (keep only deterministic DOCX/PPTX/XLSX/PDF/chart writers, which don't hit #104), and state that in the release plan so "30 V1 slices" does not silently depend on a #104 exception.

### M8 — E2.3 has an undeclared forward dependency on E7.3
E2.3's catch-up snapshot "includes … attention projections" and reuses "E7.3 attention projection," but E2.3's declared deps are only "E2.2; canonical state and event recovery" — E7.3 is a later V1 slice and `universe-attention-projection.ts` does not exist at base. **Correction:** declare the E7.3 dependency (and reorder), or mark the attention component of E2.3's snapshot as deferred/optional.

### M9 — E8.1 commits `soundEffects`/`spokenAnnouncements` before E7.3 defines how the shared policy consumes them (latent "third notification policy")
The locked constraint is "must NOT add a third independent notification delivery policy." The plan correctly frames these as reduce-only dampeners, but the two delivery-adjacent fields are pinned into the separate `universe_preferences` store in E8.1/1 while the shared-policy consumption is deferred to E7.3 — the "reduce-only / no independent authority" invariant currently lives only in prose. **Correction:** state in E8.1/1 that these are personal inputs *to* the Inbox/Commander-owned shared policy, assert the monotonic reduce-only invariant in the E7.3 producer contract, and add a test that a `universe_preferences` value can never *expand* delivery eligibility.

### M10 — E7.2 terminal-owner map is a large, chokepoint-less architectural gate under-surfaced at slice level
Making issue-sourced follow-ups durable requires appending a transactional terminal marker inside every authoritative issue-terminal transaction — but issue terminal status is written across ~18 files with no single chokepoint, and `syncRunStatusForIssue` is invoked fire-and-forget (`routes/issues.ts:1611`, verified). The coding plan correctly *blocks* on this, but the slice plan reduces it to "canonical event/intent binding," hiding the effort/risk and the unresolved per-writer-vs-outbox decision. **Correction:** elevate the terminal-writer surface + the per-writer-vs-outbox choice into the E7.2 slice and the readiness register as an explicit architectural gate; recommend routine-run-sourced follow-ups land first, issue-sourced only after a proven chokepoint/outbox exists (the plan already allows partial-kind gating).

### M11 — The "30 V1 slices" completion bar is materially contingent on unassigned upstreams (disclosed, but worth surfacing)
V1 completion for several slices transitively depends on gates the packet marks **open and owner-unassigned**: CMD (E2.2 distributed, and E5.1 closure via E2.2), HOST (E5.2 isolated tool host — the plan itself notes commodity iframes may not provide CPU/egress guarantees), BROWSER/CLOUD/PROFILE/APPROVAL (all of E6), and an unbuilt+unowned converter/derivative pipeline (E4.2). This is disclosed honestly and is not a defect — but the *ship-now* V1 core is meaningfully narrower than "30 slices." **Action:** TK should see the true near-term-buildable core (E0.1, E1.x, E2.1/E2.4, manual E4.1, E5.1, E8.1) vs the gate-blocked remainder, and confirm the owners for the 8 gates before counting those slices toward V1.

### M12 — E4.1 `indexing` stage: memory/RAG visibility scoping unspecified (private-canvas leak risk)
`ProcessingStage` includes `indexing`, but no increment specifies what it writes, to which store, or how a *private-canvas* asset's indexed content is access-scoped. E4.1/2's access tests cover raw bytes/meta/render/derivative but not search-index visibility. Gating raw bytes does not gate a company-wide RAG index built from them (master-scope §8 + memory RBAC Decisions #118/#119). **Correction:** drop `indexing` from V1, or add an explicit increment (+ fixture) requiring any indexed derivative of a private-destination asset to inherit that destination's visibility and never enter company-scoped memory/RAG.

### M13 — Test-type coverage: unit/integration/e2e are thorough; UAT exists in substance but is not named or formalized
- **Where:** whole packet; `master-scope.md` §11, `slice-plans/coding-readiness.md`, `release-plans/v1.md` exit criteria, `coding-plans/e8-2.md`, and every slice's acceptance block.
- **Evidence (verified — see §4b matrix):** unit tests are specified in ~all code slices (reducer/validator/component `*.test.ts`); integration tests in ~20/31 (real PostgreSQL `*.integration.test.ts`, `second-identity` cross-tenant, DB crash/restart for durability slices); Playwright e2e `*.spec.ts` in ~27/31 (absent only where architecturally N/A). "acceptance" appears **340×**; master-scope §11 enumerates the connected user-acceptance journeys ("Unit checks alone cannot certify these journeys"); E8.2 is an integrated release-acceptance gate; v1.md's final exit criterion is "Product review records V1 acceptance." **But** the terms **UAT / user acceptance test / sign-off / test plan appear nowhere**, there is **no formal UAT artifact** (numbered acceptance scripts, tester role, pass/fail sign-off record), acceptance is not traced from the accepted UX decisions **U01–U10 → specific acceptance runs**, and the accepted-mock/host-UX acceptance (incl. the still-open "intermittent task controls" defect) is treated as visual/DESIGN review rather than a formal user-acceptance pass.
- **Why it matters:** the four test *types* are effectively all present, but UAT is implicit and back-loaded onto E8.2. Without a named, per-slice user-acceptance layer with sign-off and U01–U10 traceability, "acceptance" risks being satisfied by developer-run e2e rather than TK/operator confirmation against the accepted product — exactly the "a passing check that proves the wrong thing" risk the packet elsewhere guards against.
- **Correction:** (1) name it — add a UAT layer to `coding-readiness.md` alongside unit/integration/e2e; (2) per slice, add explicit user-acceptance criteria with a tester/owner and a pass/fail sign-off record; (3) trace U01–U10 (and the master §11 journeys) to specific acceptance runs; (4) make E8.2 the *integrated* UAT gate that aggregates per-slice sign-offs, not the only place UAT lives; (5) fold the accepted-mock/host-UX review and the open "intermittent task controls" defect into that UAT layer.

---

## 4b. Test-type coverage matrix (unit / integration / e2e / UAT)

Per-slice, derived from the coding-plans at the reviewed commit (Y = that test type is specified; "acc" = connected acceptance/UAT-grade journey present in substance):

| Slice | Unit | Integration | E2E | UAT/acceptance | Note |
|---|---|---|---|---|---|
| E0.1 | – | – | – | acc | contract/binding slice — no runtime tests by design; "acceptance" = binding records |
| E1.0 | – | Y | Y | acc | UI design/state slice; host-review heavy |
| E1.1 | Y | – | Y | acc | reducer unit + panel host E2E |
| E1.2 | Y | Y | Y | acc* | two-tab/reload conflict journeys (acc in slice-plan) |
| E1.3 | Y | Y | Y | acc | draft-recovery two-tab/reload |
| E1.4 | Y | – | Y | acc* | overview/restore navigation journeys |
| E1.5 | Y | – | Y | acc* | commander-surfaces host E2E |
| E1.6 | Y | – | Y | acc | motion/viewport + reduced-motion/keyboard |
| E2.1 | Y | – | Y | acc | context capture-at-submit E2E |
| E2.2 | Y | Y | –† | acc | backend outcome lookup; journey e2e lives in consumers |
| E2.3 | Y | – | Y | acc* | catch-up convergence |
| E2.4 | Y | – | Y | acc | 5 real task-entry routes, revoked/late/double-Send |
| E3.1 | Y | – | Y | acc | scoped-credential + real-provider qualification |
| E3.2 | Y | Y | Y | acc | interrupt/mute/reconnect real-transport |
| E3.3 | Y | Y | Y | acc | Gemini/ElevenLabs conformance |
| E3.4 (V2) | Y | Y | Y | acc | later speech modes qualification |
| E4.1 | Y | Y | Y | acc | crash/restart intake atomicity |
| E4.2 | Y | Y | Y | acc | damaged/locked/oversized/unsupported fixtures |
| E4.3 | Y | Y | Y | acc | version/generation, real-PG concurrency |
| E5.1 | Y | Y | Y | acc | block registry + connected host |
| E5.2 | Y | – | Y | acc | isolated-tool two-origin E2E (gated on HOST) |
| E6.0 | Y | Y | Y | acc | compat qualification, local+cloud |
| E6.1 | Y | – | Y | acc | governed automation |
| E6.2 | Y | Y | Y | acc | cloud takeover, two-device |
| E6.3 | Y | Y | Y | acc | local remote, reconnect identity |
| E6.4 | Y | Y | Y | acc | lifecycle/files/profile encryption+TTL+purge |
| E7.1 | Y | Y | –† | acc | scheduler durability = DB crash integration |
| E7.2 | Y | Y | –† | acc | follow-up durability; full user journey at L114 |
| E7.3 | Y | Y | Y | acc | attention migration + delivery |
| E8.1 | Y | Y | Y | acc | preferences CAS + scope isolation |
| E8.2 | Y | Y | Y | acc | integrated release/rollback acceptance |

`*` = acceptance present in the slice-plan/connected checklist though my keyword scan first flagged it absent (false-negative). `†` = e2e legitimately absent — backend-only durability/lookup slices verify via DB-crash **integration** and are exercised end-to-end through consuming slices. **Verdict:** all four test *types* are represented across the packet; unit + integration + e2e are well-specified and correctly matched to each slice's nature; the only genuine gap is that **UAT is not formalized as its own layer** (see M13).

---

## 5. LOW findings (documentation hygiene)

- **L1 — Revision heterogeneity.** `code-evidence.md` pins replatform citations to `053f90fc8` and local main `06320643a`; `engineering-gates.md` to `72479410b`; `readiness-review.md` to `f09230f3e`. All are ancestors of the base and **0 anchor files changed** between them and `183e46a9c`, so nothing is stale — but re-pin these citations to `183e46a9c` (or mark them ancestor-dated) so a future implementer doesn't chase a line at the wrong revision. Already covered by the BASE-refresh gate.
- **L2 — Line-number anchors point at doc-comments / near declarations.** Verified-accurate behaviors, drifting lines: `rls-tenant.ts:84` (comment; array ~89), `home-board-layout.ts:14` (inside `readRow`; save is ~38), `launch-guard.ts:141` (end of clause; decl :128), `browser-job-config.ts:123` (docstring; decl :125), `e2-4.md` "CommanderTaskFocusPane.tsx:19" (param line; mount ~30). Also the E6.0 anchor points at a `run-session.ts:41–55` region whose *in-source* "commandKind appears zero times" aside is stale post-JOB-015. Re-pin at HEAD.
- **L3 — E1.2 coordinate bound mismatch.** The E1.1 reference reducer accepts `|x| ≤ 1e7` but E1.2 persistence bounds coordinates to `±1,000,000`; a valid dragged layout would be rejected on save (spurious conflict). Unify the bound.
- **L4 — E8 registration/distribution seams imprecise.** Bindings cite `routes/index.ts` for API registration, but per-company routers mount directly on the `api` Router in `app.ts` (e.g. `notificationPreferenceRoutes`); and the distribution note names only `pr.yml` though `docker.yml`/`release.yml` also exist at base as the app-image/npm seams to extend.
- **L5 — E2.2 canonical-outcome consumer path implicit.** `SubmissionOutcome` stops at `replyMessageId`/`runId`; consumers need the second read `replyMessageId → internal_agent_messages.output_refs → {artifactId, versionId}` to reach exact version. State it. (The "missing identity blocks publication" honesty is correct — `outputRefs.versionId` is nullable.) The E2.2 payload fingerprint also omits `pageContext` (defensible as ambient; make it explicit).
- **L6 — E7.1 nits.** `nextCronTickInTimeZone` is module-private at base — make exporting it an explicit step; and the 750 ms `tickScheduledTriggers` loop has no in-flight guard (correct via locks, but note the bounded-per-pass + `void ….catch()` wiring).
- **L7 — E1.1 undo/redo (`panel-history.ts`, max 50)** appears only in the addendum, absent from the reference module/contract/slice increments and its interaction with generation fencing is prose-only. Give it a spec + tests or defer explicitly.

---

## 6. Root-cause synthesis

Across E1/E2/E3/E4/E5/E7, the confirmed findings are overwhelmingly **not** source-inaccuracy or scope reduction — they are **incomplete propagation between the authoritative `implementation-bindings.md` and the per-slice/coding addenda**. The shared-bindings pass evidently caught omissions and recorded the fixes *centrally* (the bindings doc even says so for the checkpoint producer), but those fixes were not fully synced back into the individual slice plans. Symptoms: the two E1.2 producer gaps (H1/H2), diverging output paths/filenames (M1), the E2.1↔E1.6 producer contradiction (M2), inconsistent start-condition lines (M3), the E1.3 arity mismatch (M4), and the allocation-drift phrasings (M5).

**A single reconciliation pass** — treat `implementation-bindings.md` (+ `release-plans` for allocation) as the source of truth, then bring every slice/coding addendum into exact agreement on producers, file identities, dependency lines, and V1/V2 wording — would clear H1, H2, and M1–M5 together. E6 (which shows zero such drift) is the model.

---

## 7. Missing decisions to surface (before coding)

1. **Premature-draft disposition** (delete / preserve / reuse) — explicitly open; keep on the agenda. The draft is real, tested code (per `implementation-results/e1-1.md`), so the decision is consequential.
2. **BASE refresh + reviewer assignment** — revalidate the pinned base and changed producer contracts; assign the currently-unassigned reviewers/owners.
3. **Tenant ledger data class** for E4 (intake/derivatives) and E5 (capability ledger) — company-scoped vs organization-owned; drives M6.
4. **Owners for the 8 open gates** (BASE/CMD/BROWSER/CLOUD/PROFILE/APPROVAL/VOICE/HOST) — several are "unassigned upstream," yet block V1 slice completion (M11).
5. **Decision #104 stance on media generation** — carve out of E4.3 V1 (recommended) or pursue an amendment (M7).

---

## 8. Scope integrity (preserved)

Confirmed no quiet reduction: V1 = 30 slices (E0.1 + E1.0–E1.6 + E2.1–E2.4 + E3.1–E3.3 + E4.1–E4.3 + E5.1–E5.2 + E6.0–E6.4 + E7.1–E7.3 + E8.1–E8.2), V2 = E3.4 only, 69 increments, multi-screen deferred outside the count. The only scope-adjacent risks are *surfaces* for future drift, not reductions: the "allocation open" phrasings (M5) and the several V1 completion bars that are contingent on unbuilt/unowned upstreams (M11) — both should be made explicit rather than left implicit.

---

## 9. Review limits

Documentation review only, against a pinned base; no runtime, tests, providers, or builds were run (consistent with the packet's own status). No unit/integration/e2e/UAT was executed — all coverage claims are about what the plans *specify*, verified against real source. Findings are code-grounded where a base symbol exists; qualification-dependent claims (voice/browser/host/converter) are inherently unverifiable until their gates run and are correctly labeled as such by the packet. The HIGH findings and the load-bearing MEDIUMs were re-verified directly.

---

## Appendix A — Real-code verification evidence

Each row was read from the actual file at base `183e46a9c` (not from the packet text).

| Packet claim | Verified in real source | Result |
|---|---|---|
| 8 frozen RLS tables + CAV-005 legacy exclusion | `server/src/db/rls-tenant.ts` `TENANT_RLS_TABLES` (~L80–95) | 8 tables (jobs, job_attempts, leases, workers, services, service_instances, job_artifacts, job_secret_handles); legacy excluded — **CONFIRMED** |
| `aoa_app` grants on assets/artifacts | `server/src/db/job-control-legacy-grants.ts` L43–45 | `artifacts`/`artifact_versions`/`assets` = `["SELECT"]` — **CONFIRMED** (basis for M6) |
| Non-owner tenant boundary | `server/src/db/tenant-context.ts` L46/L70 | `runInTenant`/`runInTenantReadOnly` exported — **CONFIRMED** |
| Context seam signature | `server/src/services/internal-agent/context-assembly.ts` L84–95 | `contextAssemblyService(db).assembleContext(companyId, options{…})` — **CONFIRMED** |
| Replay hazard (E2.2 rationale) | `agent-loop.ts` (`getMessageByClientSubmissionId`, reuse before claim) + `conversation.ts` `claimTurn` | failed/unfinished turn is re-claimable and re-runs the CLI — **CONFIRMED** |
| Output vs submission identity | `packages/db/src/schema/internal_agent.ts` L250/259/266 | `outputRefs`/`runId`/`clientSubmissionId` separate; `outputRefs.versionId` nullable — **CONFIRMED** |
| Scheduler hazard (E7.1 rationale) | `server/src/services/routines.ts` L1538–1603 | `nextRunAt` CAS committed before `dispatchRoutineRun`; no occurrence key — **CONFIRMED** |
| Audit insert/publish split | `server/src/services/activity-log.ts` L38/L66/L134–135 | `insertActivityLog(db,input)` + `publishActivityLogged(persisted)` — **CONFIRMED** |
| Browser control applier absent | `packages/worker-daemon/src/lease/lease-renewal.ts` L682–683 | `if (!handlers?.result) return false` (approval/runtime_decision has producer, no applier) — **CONFIRMED** |
| Chat limits | `packages/shared/src/validators/internal-agent.ts` L70/71/75/80 | message 10000 / pageContext 5000 / clientSubmissionId 200 / attachments 5 — **CONFIRMED** |
| Reuse component props | `ui/src/components/commander/CommanderTaskFocusPane.tsx` L5–7 | `issueId` / `anchorId?` / `onClose` — **CONFIRMED** |
| Denial-audit RAG exclusion | `server/src/services/internal-agent/proactive.ts` L16, L485–486 | `notDenialNamespace`; `security.denied.*` excluded from digest — **CONFIRMED** |
| XLSX output caps | `server/src/services/xlsx-render.ts` L37–39 | maxSheets 12 / maxRows 1000 / maxColumns 50 — **CONFIRMED** |
| Office render input cap | `server/src/services/office-render-limits.ts` L30 | 15 MiB default — **CONFIRMED** |
| Migration policy | `docs/architecture/decisions.md` ~L1970 | Decision #122 present + 2026-09-01 amendment — **CONFIRMED** |
| App route seam | `ui/src/App.tsx` L424/124/128 | `:companyPrefix` `<Layout>` with `home`/`commander` children — **CONFIRMED** |
| Theme store | `ui/src/context/ThemeContext.tsx` L12/L30 | `light`/`dark`/`system`; default `dark` — **CONFIRMED** |
| Browser launch guard | `packages/browser-runtime/src/launch-guard.ts` | rejects remote-debugging ports/endpoints (pipe-only) — **CONFIRMED** |
| Anchor inventory | 82 anchors | 70 runtime exist at base (100%); 12 bundled docs; 92 proposed outputs absent (0 collisions) — **CONFIRMED** |
| Counts | index vs plans | 69 increments in **both** coding+slice plan sets; 31 slices; V1=30 / V2=E3.4 — **CONFIRMED** |
| H1/H2 gaps | `coding-plans/e1-2.md` + `slice-plans/e1-2.md` | `checkpoint` = 0 hits; `ordinal` = 0 hits — **CONFIRMED** |
| Revision heterogeneity | diff `f09230f3e`/`053f90fc8` → base over anchor set | 0 anchor files changed → citations not stale — **CONFIRMED** |

---

## Appendix B — Per-epic audit summaries

Eight adversarial per-epic audits ran against the codebase; I re-verified their load-bearing findings.

- **E0 + E8 (baseline / settings / release):** zero false source claims (~30 symbols verified). Preferences contract (30 fields → 8/14/7/1 sections) consistent; revision-0-insert CAS sound; E8.1 producer/consumer cycle broken correctly; E8.2 honestly "not certified." LOW: `routes/index.ts` vs direct `app.ts` mount; distribution names only `pr.yml`. MEDIUM concern: M9 (sound/spoken fields before E7.3 shared-policy).
- **E1 (canvas):** source accurate; reducer math hand-verified. **HIGH H1 (checkpoint), H2 (openedOrdinal).** MEDIUM: coord-bound mismatch, E1.3 destination over-declares text kinds, filename drift. LOW: undo/redo unspecified, line anchors.
- **E2 (context/outcomes/task chat):** source accurate; replay/observation hazard handled correctly (GET read-only, cannot re-execute). MEDIUM: E2.1↔E1.6 cycle, E2.1 dep-decl disagreement (3 docs), E2.3→E7.3 undeclared dep, E2.1 output-path divergence. LOW: outcome→version read path implicit; fingerprint omits pageContext.
- **E3 (voice):** source accurate; "CLI login ≠ voice readiness" strong; credentials kept distinct. Main flag = M5 (allocation "open" in authority docs). LOW: sessionId/voiceSessionId drift, `generation` overloading, E3.2/E3.4 dep-line gaps.
- **E4 (artifacts):** source accurate; immutable-version/`task_outputs`/no-fictitious-transaction rules respected. **M6** finalize cross-role transaction, **M7** #104 media in V1 bar, **M12** indexing leak. Concern: `addVersion` semantics change to a shared writer.
- **E5 (blocks/tools):** source accurate; contract mappings correct, no unsafe casts; qualification honesty strong (E5.2 HOST-gated). MEDIUM: E5.1 start-condition omits E1.1/E1.2/E1.3/E2.2; registry `.tsx`/`.ts` drift.
- **E6 (browser):** **zero confirmed defects** — source near-perfect (~25 anchors incl. launch-guard, TTLs, grant/size ceilings, orphan sweep); ownership/epoch model complete; profile enc/TTL/purge as separate clauses. 4 LOW nits (stale in-source aside, over-broad CLOUD gating, line drift, revision heterogeneity).
- **E7 (routines/attention):** source accurate; `routines.ts:1538` hazard real and correctly fixed; `tasks:assign` route-layer-only auth gap correctly identified. MEDIUM: E7.3 start-conditions omit E8.1/1; **M4** answer-draft (consumer side); **M10** terminal-owner map (large, chokepoint-less). LOW: `nextCronTickInTimeZone` export, tick overlap.

---

*End of report. Reviewed commit `f63b84461341fc93f65417103fc8e57357a93939`; base `183e46a9c65fc3105c7e3d125629276814df7dbb`.*
