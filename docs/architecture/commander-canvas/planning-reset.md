# Universe — planning-only recovery and review checkpoint

September 12, 2026. **Planning only. No production implementation is authorized.** This record supersedes earlier statements that the branch choice, coding start or implementation readiness were accepted. TK explicitly corrected that interpretation and asked to return to detailed planning and review.

## Current authority

The prohibitions and branch alternatives below record the initial reset. Subsequent explicit user instructions authorized the fresh codex/universe-interface branch and documentation commits/pushes; that branch now exists at the verified remote replatform pin. The [focused contract re-review](focused-review-report.md) has been checked and the two residual planning gaps are closed. Current remaining decisions are in [the final planning packet](final-planning-decisions.md). Implementation, qualification execution, provider spend and draft deletion/reuse remain unapproved. TK subsequently accepted the recommendation to preserve the draft untouched/excluded; historical undecided language below is superseded for preservation, not for later cleanup/reuse.

## Preserved decisions and open decisions (initial reset; later decisions below control)

- Preserve the reviewed Universe experience, settings ownership, animation rules and V1/V2 allocation: 30 slices in V1, E3.4 in V2; multi-screen deferred after desktop-app planning. Do not reopen these merely because the planning process was incomplete.
- Branch strategy and exact source base remain proposals for review. A general discussion of slice branches did not authorize creating them or writing production code.
- Completing documentation, code investigation and an independent plan review is authorized. Code, dependency, migration, branch, commit, merge, deployment and provider-execution changes are not.
- The prematurely written controller is an **unapproved isolated draft**, excluded from accepted delivery and readiness. Its test results may identify investigation topics; they do not approve the design, branch strategy or implementation.
- **Current disposition:** TK subsequently accepted preserving the draft untouched and excluded; see final-planning-decisions.md. Deletion or individually reviewed reuse remains a later explicit decision. Do not delete, merge, cherry-pick, resume or silently reuse it.

## Exact provenance of the isolated work

Read-only check of local references on September 12; these are the last fetched remote-tracking references, not a fresh remote release certification.

| Reference | Observed revision / state |
|---|---|
| Original main checkout | `06320643a72d8ef31904322a862abf09e3dc2168` |
| Remote-tracking main | `e097d2f9332a2715bdbaf2058a4b751481107713` |
| Remote-tracking replatform | `origin/docs/replatform-program` at `183e46a9c65fc3105c7e3d125629276814df7dbb` |
| Main/replatform merge base | `e097d2f9332a2715bdbaf2058a4b751481107713` |
| Premature integration branch | `codex/universe-integration`, created at that replatform revision; no Universe commit |
| Premature slice branch/worktree | `codex/universe-e1-1`, `.worktrees/universe-e1-1`, same commit; uncommitted runtime/dependency/test files |

The uncommitted draft contains root/UI package manifests, generated lockfile, `ui/src/components/universe/`, `ui/dev-harness/universe.*`, and `tests/universe/`. No implementation commit, push or merge was performed. The main application's runtime files are unchanged. The separate [result record](implementation-results/e1-1.md) is historical evidence, not an accepted delivery result. The implementation worktree is not the source of truth for planning status.

## Historical branch alternatives (direction now agreed)

| Option | Planning consequence | Implementation consequence, only after explicit approval |
|---|---|---|
| A — Plan against a pinned replatform snapshot now | Investigate real new tenant, execution and credential contracts. Each binding records revision and gate. Revalidate changed contracts before final approval. | Create a fresh approved integration branch at a then-verified replatform revision; reviewed slice branches merge into it. Reconcile regularly with the upstream program and finally with actual main after replatform lands. |
| B — Wait for replatform to land, then use main | Continue requirements/design and identify gaps now; defer final runtime bindings until the landed revision is available. | Branch from the verified main containing replatform; fewer simultaneous branch-base changes, later start. |

Subsequent user decision: use the same fresh Universe branch from verified replatform for plans now and implementation only after approval. Create/push after complete detailed planning and self-review. The alternatives below are retained as historical reasoning. Original recommendation: **A for planning**, because Universe depends on replatform's actual contracts. This does not select an execution branch, certify the candidate revision, authorize using the premature branches, or authorize implementation. B remains reasonable if avoiding a moving integration base matters more than earlier binding work. Building the complete Universe against the old main now is not recommended: it risks designing around execution contracts replatform replaces.

The base decision package must contain: source ancestry; changed contracts and source collisions; owner for bringing upstream changes in; planned sync/check cadence; conflict and generated-migration handling; Linux/full-suite baseline policy; final merge order; rollback/feature-disable strategy. Each sync invalidates affected binding/review evidence until rechecked. Missing upstream work blocks its consumer increments, not unrelated V1 planning. No V2 implementation substitutes for a blocked V1 increment.

## Detailed planning deliverables

The [slice planning audit](planning-audit.md) inventories all 31 slices and 69 existing increments. Those outlines are not a completed implementation plan. A detailed E1.1 reference exists, but is not an approved plan and must be reviewed without assuming the premature code is the desired solution.

For **every slice and increment**, the coding plan must include:

1. Requirement and UI-decision references; V1/V2 allocation; exact user-observable result and exclusions.
2. Existing behavior at a named source revision, distinguishing source evidence, tests and assumptions. Map each change to reuse, modify or new code.
3. Exact files/exported interfaces, schema/API/event contracts and the canonical authorization owner. New types must be defined before consumers use them. Avoid guessed provider SDK calls or cloned task/approval authority.
4. Ordered implementation steps, concrete representative code and regression test code using actual repository fixtures; expected failure and success commands. State what each test proves and does not prove.
5. Loading, error, denied/revoked, offline, reconnect, conflict, empty and narrow-screen behavior; focus, keyboard, reduced motion, panel/voice lifetime and recovery transitions; consuming settings in the same increment.
6. Numerical limits, defaults and rationale; distinguish proposed limits from measured capacity. Include schema generation, migration/backfill compatibility, logs, rollback and feature-disable behavior where relevant.
7. Explicit dependency producer/consumer, upstream finding or contract, accountable reviewer/owner (unassigned remains unassigned), closure evidence, and what independent work can proceed.
8. Verification environment, including the documented Windows full-suite limitations and authoritative Linux checks. Green fixture tests cannot substitute for real task routes, browser streams, voice providers or profile revocation.
9. Review findings with disposition and plan revision; re-review after material changes. No open important finding may be silently converted into an implementation assumption.

Where an upstream contract is not yet available, provide a complete investigation/qualification plan with inputs, method, expected evidence, owning reviewer and affected consumers. Mark that coding binding blocked. Do not fabricate a finished recipe. Qualification that executes code, installs dependencies or starts paid/provider sessions requires its own explicit authorization; a planning instruction alone does not grant it.

## Review and approval order

1. **Planning reset and audit:** correct authority/status records and inventory omissions. Preserve the unapproved code without further changes.
2. **Base/branch decision review:** present A/B recommendation with provenance and dependency impact. User acceptance here is only a planning/base decision.
3. **Detailed plans and self-review:** complete each epic's slice/increment packet in dependency order. Establish shared settings, identity, revision, authorization and result contracts before their consumers; make deferred bindings visible. Self-review the full packet for requirement coverage, contract consistency, concrete steps, tests and dependency closure. Publish the documentation changes to the dedicated planning branch after its base is agreed; exclude the premature implementation and unrelated local files.
4. **User-managed independent review:** after the full detailed packet and self-review are complete, provide TK a short review prompt and the exact branch/commit. TK will give the packet to Claude and return its findings. This supersedes the attempted CLI review; Claude CLI authentication is no longer a blocker. The review covers architecture, dependencies, accepted UI, tests, recovery, migrations and release completeness. Request review only, not implementation. A process-only review does not count as reviewing the completed technical plans.
5. **Resolve and re-review:** record each important finding, evidence and resolution; issue a revised packet. Preserve uncertainty where runtime qualification is still required.
6. **User review:** present the complete reviewed plan, remaining material choices, exact branching proposal and separate disposition decision for the premature draft.
7. **Explicit implementation approval:** only a clear user instruction to begin implementation of that reviewed plan permits production work. Neither reviewer approval, “continue planning”, scope agreement nor existing code authorizes coding.

## Present status

The reset, gap inventory and detailed per-increment coding plans are written, with [full-packet self-review](planning-self-review.md). The subsequent focused Claude review of ac7b9a494 has been received and verified for the two residual contract areas; final decisions and runtime approval remain open. TK will handle Claude review after the full plans and self-review, so the failed CLI attempt is historical, not a current blocker; see [review status](planning-review-status.md). TK clarified that the [same Universe branch](planning-branch-proposal.md) should come from replatform, contain plans now and integrated implementation only after explicit approval. This supersedes treating the planning and later integration branches as necessarily separate. No implementation readiness or 100% confidence is claimed. The premature work is now preserved untouched/excluded by accepted direction; later cleanup or reuse stays deferred for its own explicit decision.
