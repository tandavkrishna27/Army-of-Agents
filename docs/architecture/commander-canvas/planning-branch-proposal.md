# Universe — shared planning and implementation branch

September 12, 2026. **User clarified that one Universe branch should carry planning now and implementation later, based on replatform as recommended. Implementation remains unapproved.** The branch has now been created after the full planning/self-review pass; see the [publication record](planning-publication.md) for the final provenance and verification.

## Recommendation

Create a fresh Universe branch, proposed name `codex/universe-interface`, from the verified replatform snapshot. Use this same branch for planning and, after explicit implementation approval, for the integrated implementation. This is separate from both premature Universe branches. During planning, only Universe planning documents will be added and pushed; the inherited replatform source provides the context for exact file/interface bindings and Claude's review. No premature runtime code, dependencies, tests, local pitch files or unrelated strategy files are included in the planning diff.

The user requested a dedicated branch and publication of all relevant plans, then clarified that it should come from replatform and later carry implementation too. This settles the direction; record the exact source revision when creating it. This instruction does not authorize product implementation.

## Verified candidate

Read-only remote-head lookup on September 12 confirmed that the remote refs still match the locally available objects:

| Role | Reference | Exact revision |
|---|---|---|
| Candidate planning base | `origin/docs/replatform-program` | `183e46a9c65fc3105c7e3d125629276814df7dbb` |
| Current remote main | `origin/main` | `e097d2f9332a2715bdbaf2058a4b751481107713` |
| Main/replatform merge base | main revision above | `e097d2f9332a2715bdbaf2058a4b751481107713` |

This verifies ancestry and head identity, not runtime correctness or closure of upstream findings. Recheck the remote candidate at branch creation; if it moved, record and review the changed contract surface instead of silently changing the approved planning baseline.

## Why this base

Universe's credential, tenant, routing and result-delivery plans must match the source replatform is introducing. A planning branch based on current main would give Claude an older execution architecture as its default context. Basing the documentation branch on the replatform snapshot keeps source and planning evidence together while unresolved replatform capabilities remain explicit dependencies.

The alternative is to wait for replatform to land and bind against main then. It reduces moving-base review work but delays final source bindings. The recommendation is to plan now against the pinned snapshot, with change invalidation and re-review for affected contracts.

## Publication and review procedure

1. Finish all detailed epic/slice/increment packets and self-review in the current documentation checkout. Record existing source, proposed changes, interfaces, tests, dependencies, qualification protocols, rollback and unresolved bindings distinctly. The user's latest instruction requires this before branch creation.
2. Recheck remote replatform/main heads and create the fresh Universe branch from the recorded, verified snapshot; use a fresh checkout without changing the original main checkout or premature worktree. Preserve the same branch for the later integrated implementation. This is a pinned review baseline, not a claim that upstream runtime gates passed.
3. Copy only the canonical Universe planning scope and required linked review records. Validate every relative reference in the new tree. Audit the diff against the pinned base to ensure it contains documentation only and no unrelated files.
4. Commit/push the completed planning packet to the dedicated branch. Provide TK a short Claude review prompt, exact planning commit and source-base commit; request review without implementation. This is publication for review, not merge approval.
5. TK returns Claude's findings. Verify each finding independently, record its disposition, resolve valid issues and re-review material changes.
6. Present the revised full plan, upstream changes since the pinned snapshot, proposed implementation base/merge order and the separate premature-draft disposition decision. Production work requires explicit user approval afterward.

The same Universe branch continues into implementation after explicit approval. Replatform may advance or land during review: incorporate reviewed upstream changes, revalidate affected bindings and tests, and record the resulting revision before implementation begins. After replatform lands, reconcile Universe with actual main before its eventual merge. Keeping one branch does not make the pinned base permanently valid or grant coding approval. Smaller slice branches may later feed this integration branch under the reviewed methodology; they are not separate product deliveries.
