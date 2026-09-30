# Army Universe Adoption Status

Last updated: 2026-09-30

## Repository

- Army repo: `C:\Users\TK\OneDrive\Desktop\Army-of-Agents-export`
- Army adoption worktree: `C:\Users\TK\OneDrive\Desktop\Army-of-Agents-worktrees\universe-interface`
- Army branch: `codex/universe-interface`
- Army base commit: `66e6bd6` (`docs: expand Mintlify public docs`)
- Army remote: `https://github.com/tandavkrishna27/Army-of-Agents.git`

## Adoption Mode

Army is a fresh/exported repository with a short commit graph. Its sampled application files match MeteoriteLabs AoA `origin/main` byte-for-byte, but it does not share the MeteoriteLabs Universe branch ancestry.

Universe adoption therefore uses content-level porting into the Army branch rather than cherry-picking or merging by Git ancestry.

## Current State Before Code Port

- `docs/architecture/commander-canvas/**` has been imported as the planning packet.
- Universe runtime files are not yet ported in this Army branch.
- Army main does not currently include the distributed execution bridge files required by B12, including `server/src/services/job-admission-bridge.ts` and `server/src/services/job-output-bridge.ts`.
- B12 and dependent browser/distributed-execution slices remain blocked until those gates are present and verified in Army.

## Verification Policy

Every adoption wave must run focused tests first. Before the branch is presented as implementation-ready, run:

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

If any command cannot run or fails, record the exact failure and whether it is pre-existing, port-caused, or blocked by replatform prerequisites.
