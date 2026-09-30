# QA - D0 - E1 frozen-consumer checker correction - `4fa9df3f0845` - a3

## Record identity

| Field | Value |
|---|---|
| Date (UTC) | `2026-08-10` |
| Scope | Prerequisite P2: frozen-consumer checker correction only |
| Attempt | `3` |
| Supersedes | `2026-08-09-d0-e1-completion-b03262692882-a2.md` only if a distinct reviewer accepts this correction |
| Start SHA | `baf903bc982c7580b6955b69c624fb6dcab570ae` |
| Candidate code revision | `4fa9df3f08452509f24c94681df73a8909451684` |
| Environment | `operator-directed windows-local`; Git object database available |
| Formal authority | Linux CI under DEC-03 |
| Gate owner | `TBD - distinct reviewer` |
| Result | **`awaiting_review`** |

This is implementer-observed corrective evidence, not an independent gate decision. The a1/a2 records remain immutable. This candidate does not mark E1/P2 complete or authorize JOB-001.

## Candidate observations

| Requirement | Observation | Candidate result |
|---|---|---|
| Later consumer compatibility | A committed later server manifest/root-lock importer and deliberately drifted installed Zod/esbuild versions do not invalidate the frozen source snapshot. | `observed_green` |
| Immutable Git bytes | Package/lock hashes and Zod/esbuild versions come from `git cat-file` blobs at `b7a842...`, not checkout bytes. | `observed_green` |
| CRLF independence | CRLF working-tree package/lock bytes leave the Git-blob result green. | `observed_green` |
| Missing object behavior | Missing commit and missing lock blob each fail closed with commit/path plus fetch/retry guidance. | `observed_green` |
| Mutation enforcement | Existing bundle/schema/fixture/source-SHA/bundler corpus remains green; new Zod, esbuild, package-integrity, and lock-integrity mutations fail. | `observed_green` |
| Clean clone determinism | A no-local clean clone with no `node_modules` produces byte-identical status/stdout/stderr across two runs. | `observed_green` |
| Immutable artifact boundary | Frozen fixture tree `e62b3b...` and worker-protocol tree `73aeaa...` equal the start revision. | `observed_green` |
| Focused checker | Mutation corpus `21/21`; actual source-SHA checker, boundary `50/50`, package smoke, and manifest check pass. | `observed_green` |
| Typecheck/build | Worker-protocol and repository recursive typecheck/build exit `0`. | `observed_green` |
| Repository tests | Package lane passes `16` files / `490` tests before the sole known Windows `cross-version.test.ts:12` collection failure. Full `pnpm test:run` exits `1` on that same sole suite; Linux CI remains formal authority. | `observed_with_baseline` |

## Review decision placeholder

**Reviewer identity:** `TBD`

**Reviewed revision:** `TBD`

**Decision:** `awaiting_review`

**Concerns / residuals:** The checker requires the recorded Git commit and blobs to be present by design and fails closed if they are unavailable. The hand-written targeted pnpm importer reader is deliberately narrow to the two E1 dependency inputs; a future lockfile-format change must be reviewed rather than silently tolerated. The Windows Vitest collection baseline is not represented as a pass.
