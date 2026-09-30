# Universe — detailed implementation planning packet

September 12, 2026. **Planning and self-review candidate; implementation is not authorized.** This packet covers all nine epics, 31 slices and 69 original increments. V1 contains 30 slices; V2 contains E3.4 only. Complete and verify all V1 before starting V2 implementation. Multi-screen remains deferred until after the desktop app, outside this slice set.

Each addendum contains source evidence, proposed files/interfaces, ordered increment steps, tests or qualification protocols, failure/recovery, UI/settings, limits and rollback. Code is representative planning material, not a compiled patch. For missing upstream contracts, the complete deliverable here is a conditional qualification procedure; exact runtime binding remains blocked. Neither this index nor a self-review certifies implementation readiness.

Read [master scope](../master-scope.md), [accepted UI decisions](../ui-review-decisions.md), [settings](../settings-contract.md), [motion](../motion-and-interaction.md), [shared source/interface bindings](../implementation-bindings.md), then the relevant slice and addendum. Shared binding decisions override illustrative aliases in the older E1.1 reference. [Self-review](../planning-self-review.md) records corrections and remaining gates. [Branch procedure](../planning-branch-proposal.md) governs publication after self-review. TK supplied the independent Claude review of f63b844; the [finding-by-finding response](../independent-review-response.md) records this correction round, its qualifications and re-review requirements.

## Implementation order after approval

The [complete execution sequence](../execution-sequence.md) now replaces the earlier coarse ordering diagram. It maps all 69 original increments into 86 bounded delivery packages, with [explicit predecessor edges](../execution-increment-map.md), [external entry and completion evidence](../execution-dependency-gates.md), safe parallelism, review and integrated acceptance. Slot numbers are scheduling priorities, not all-previous-slot barriers or new releases.

The corrected order separates draft contracts from recovery, preference producers from consumer UI, original intake from index acceptance, output binding from publication/reply repair, and early provider/host/browser contracts from their later runtime qualification. Local and cloud view tracks can progress independently after shared authority contracts; both remain required for complete V1. See the [sequence self-review](../execution-sequence-review.md).

This index and the execution sequence do not override the numbered increment's original tests or locked contracts. Partial packages do not close a whole increment. Explicit implementation approval remains required; no feature code was added by the sequencing pass.

## Review and execution rules

1. Read the numbered increment in both its slice outline and coding addendum; use the source/interface manifest at the pinned revision. Refresh changed producer contracts before editing runtime files.
2. Confirm explicit implementation approval, assigned reviewer and applicable qualification/architecture decisions. No placeholder port is treated as a shipped API. The premature draft has no delivery credit and remains untouched pending its separate disposition decision.
3. After approval, add the specified failing regression or execute the authorized qualification protocol. Implement only that increment, update synchronized layers, run focused checks and inspect actual state. Proposed test modules cannot run until created.
4. Review producer and consumers together; preserve any failing or blocked evidence. Integrate on the same Universe branch, with smaller reviewed slice branches only under the agreed workflow. Update upstream in controlled batches, rerun affected checks and record new source revision.
5. At release, run repository typecheck/tests/build plus real provider/worker/security/UI qualification. Document Windows skips and authoritative Linux results separately. Close the complete V1 only after all accepted flows and rollback pass and the user accepts release readiness.

Numeric bounds in addenda are explicit proposals for qualification, not measured promises or quiet reductions in accepted scope. Changes that affect accepted experience, policy or cost return to TK. Routine engineering corrections can be proposed and reviewed in this packet; no correction authorizes coding.

[Formal UAT and per-slice acceptance records](../user-acceptance-plan.md#per-slice-acceptance-register) complement automated checks; all runs remain not_run. The accepted scope is unchanged by reconciliation.

## Slice navigation

| Epic / slice | Release | Original increments | Detailed plan |
|---|---|---|---|
| E0.1 | V1 | E0.1/1, E0.1/2 | [E0.1 — Bind the implementation base](e0-1.md) |
| E1.0 | V1 | E1.0/1, E1.0/2 | [E1.0 — Complete the design-state inventory](e1-0.md) |
| E1.1 | V1 | E1.1/1, E1.1/2, E1.1/3 | [E1.1 — Build one canvas and panel controller](e1-1.md) |
| E1.2 | V1 | E1.2/1, E1.2/2 | [E1.2 — Persist layout with revisions and recovery](e1-2.md) |
| E1.3 | V1 | E1.3/1, E1.3/2 | [E1.3 — Persist destination-specific drafts safely](e1-3.md) |
| E1.4 | V1 | E1.4/1, E1.4/2 | [E1.4 — Implement tray, overview and reference navigation](e1-4.md) |
| E1.5 | V1 | E1.5/1, E1.5/2, E1.5/3 | [E1.5 — Implement independent Commander surfaces](e1-5.md) |
| E1.6 | V1 | E1.6/1, E1.6/2, E1.6/3 | [E1.6 — Implement viewport-aware motion and accessibility](e1-6.md) |
| E2.1 | V1 | E2.1/1, E2.1/2 | [E2.1 — Bind selected references to the existing conversation](e2-1.md) |
| E2.2 | V1 | E2.2/1, E2.2/2 | [E2.2 — Add read-only outcome lookup and bind execution](e2-2.md) |
| E2.3 | V1 | E2.3/1, E2.3/2 | [E2.3 — Build truthful catch-up and snapshot reconciliation](e2-3.md) |
| E2.4 | V1 | E2.4/1, E2.4/2 | [E2.4 — Reuse task content in a reliable conversation panel](e2-4.md) |
| E3.1 | V1 | E3.1/1, E3.1/2 | [E3.1 — Qualify and integrate OpenAI realtime](e3-1.md) |
| E3.2 | V1 | E3.2/1, E3.2/2 | [E3.2 — Implement independent voice controls and recovery](e3-2.md) |
| E3.3 | V1 | E3.3/1, E3.3/2 | [E3.3 — Qualify Gemini and ElevenLabs independently](e3-3.md) |
| E3.4 | V2 | E3.4/1, E3.4/2, E3.4/3 | [E3.4 — Plan later speech pipelines and local speech](e3-4.md) |
| E4.1 | V1 | E4.1/1, E4.1/2 | [E4.1 — Make original intake durable](e4-1.md) |
| E4.2 | V1 | E4.2/1, E4.2/2 | [E4.2 — Qualify format processing independently](e4-2.md) |
| E4.3 | V1 | E4.3/1, E4.3/2 | [E4.3 — Preserve revisions and qualify generation](e4-3.md) |
| E5.1 | V1 | E5.1/1, E5.1/2 | [E5.1 — Build reviewed interactive block registry](e5-1.md) |
| E5.2 | V1 | E5.2/1, E5.2/2 | [E5.2 — Qualify isolated executable host](e5-2.md) |
| E6.0 | V1 | E6.0/1, E6.0/2, E6.0/3 | [E6.0 — Prove browser compatibility before selecting transport details](e6-0.md) |
| E6.1 | V1 | E6.1/1, E6.1/2 | [E6.1 — Integrate automation through governed worker path](e6-1.md) |
| E6.2 | V1 | E6.2/1, E6.2/2 | [E6.2 — Implement cloud live view and takeover](e6-2.md) |
| E6.3 | V1 | E6.3/1, E6.3/2 | [E6.3 — Implement remote access to local browser](e6-3.md) |
| E6.4 | V1 | E6.4/1, E6.4/2, E6.4/3 | [E6.4 — Implement lifecycle, transfer and gated profile reuse](e6-4.md) |
| E7.1 | V1 | E7.1/1, E7.1/2 | [E7.1 — Connect conversational routines to existing scheduler](e7-1.md) |
| E7.2 | V1 | E7.2/1, E7.2/2 | [E7.2 — Add durable authorized follow-up intent](e7-2.md) |
| E7.3 | V1 | E7.3/1, E7.3/2, E7.3/3 | [E7.3 — Upgrade shared attention delivery and add Universe presentation](e7-3.md) |
| E8.1 | V1 | E8.1/1, E8.1/2 | [E8.1 — Implement scoped settings with each consumer](e8-1.md) |
| E8.2 | V1 | E8.2/1, E8.2/2 | [E8.2 — Qualify integrated release and rollback](e8-2.md) |
