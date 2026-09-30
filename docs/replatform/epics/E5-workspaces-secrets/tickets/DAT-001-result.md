# DAT-001 Result — Immutable workspace snapshot format

**Status:** `implemented` (per the committed design; adversarial-reviewed; all local gates green). Epic-completion remains the Integration Gate Owner's call.
**Epic:** `E5-workspaces-secrets` (first ticket).
**Design:** [`DAT-001-design.md`](DAT-001-design.md). **Authoritative source:** `program-design.md:624-629`.
**Process:** terrain-map Workflow → orchestrator re-verification → committed design → implementer subagent (fail-first TDD) → adversarial-review Workflow (5 finders → refute-by-default verifiers) → orchestrator re-verify all gates + read security-critical files + fix each confirmed defect fail-first → this doc.

---

## 1. Outcome

A deterministic workspace-snapshot **producer** — `packages/worker-daemon/src/snapshot/` — that walks a granted folder (Git-commit or content-manifest base) and emits a frozen `WorkspaceManifestV1` (worker-protocol) plus two pinned digests, self-validating fail-closed. **worker-daemon-only, hermetic, no DB/migration, inert-until-wired.** worker-protocol is untouched (frozen v1).

The reshaping fact (design §1): the frozen worker-protocol **already defines the manifest contract**, so DAT-001 is a producer, not a schema ticket — an E4-profile hermetic ticket, correcting the handoff's "E5 = server+DB" framing for this ticket.

### Files
- **New runtime** `packages/worker-daemon/src/snapshot/`: `errors.ts`, `limits.ts`, `hashing.ts`, `ignore.ts`, `git-runner.ts`, `git-base.ts`, `build-manifest.ts`, `index.ts`.
- **New tests** `src/snapshot/__tests__/`: `content-manifest`, `rejections`, `git-base`, `ignore-and-algorithm`, `self-validation`, `vectors`, `determinism` (implementer) + `review-git-base`, `review-content`, `review-oversize-read` (review-fix regressions).
- **New CI/fixtures**: `scripts/check-workspace-snapshot-vectors.mjs` (+`.test.mjs`) — a from-scratch third canonicalizer; `tests/fixtures/workspace-snapshot/v1/vectors.json` (2 positive + 6 reject); wired into the `policy` job (`.github/workflows/pr.yml`, one step, next to device-proof).
- **Modified**: `packages/worker-daemon/src/index.ts` (barrel export).

### Key decisions (design ledger, all held)
D1 producer in worker-daemon; **D2 self-validates with `workspaceManifestV1Schema.parse()` inside worker-daemon** (refuted the terrain-map "server-side only" claim — worker-daemon already runs worker-protocol zod schemas at runtime); D3 two hashes (repeatable `contentRevision` excl. capture metadata + per-capture `manifestHash`; entry sort = UTF-8 byte order); D4 ignore scoping (git→`gitignore_plus_aoa`, content→`explicit` minimal matcher); D5 cross-platform exec bit; D6 fail-closed size ceilings; D7 git hardening (`execFile` + `hooksPath=` + `quotepath=false` + `-z`); D8 no DB/migration.

---

## 2. Adversarial review + fixes

The review ran 5 dimension finders → refute-by-default verifiers (workflow `wf_29b8bde5-c25`; 9 findings; 7 verifier verdicts + 2 verifier retry-cap deaths adjudicated by the orchestrator). The orchestrator independently re-read `build-manifest.ts`, `git-base.ts`, `hashing.ts`, and the vectors checker, and reconciled every finding. **5 confirmed defects fixed fail-first** (revert→observe-fail→restore satisfied by writing each regression test against the unfixed code and observing the predicted failure before applying the fix), **1 refuted finding hardened anyway** (cheap defense-in-depth), **2 refuted/as-designed documented**.

| # | Finding | Sev | Verdict | Fix |
|---|---------|-----|---------|-----|
| A | Oversize file fully `readFileSync`'d **before** the per-file ceiling check (memory-amplification; a >2 GiB file threw a raw `RangeError`, not a clean reject) — both capture paths | HIGH | orchestrator-confirmed (verifier died) | Pre-check `stats.size` (already in hand from `lstat`) before reading, in `walkContentTree` + git `addFile`. |
| B | AOA built-in ignore rules (`.aoa/`, `.git/`) **attested** in the `gitignore_plus_aoa` digest but **never applied** → the `.aoa/` worker-keystore dir leaked into a git-base manifest with a false attestation | HIGH | CONFIRMED | Apply `isIgnoredByExplicit(_, AOA_BUILTIN_IGNORE_RULES)` in both git enumeration loops; corrected the `ignore.ts` doc. |
| C | Unresolved merge conflict → `git ls-files -z` emits a path once per index stage → budget corruption + misleading "duplicate path" error | MED | CONFIRMED (reproduced) | `assertNoUnmergedIndex` on `ls-files --stage -z` (stage≠0 ⇒ throw a clear reject) before enumeration. |
| D | Tracked-but-deleted-in-worktree file → raw `ENOENT`, violating the fail-closed `WorkspaceSnapshotError` contract | MED | CONFIRMED | try/catch around `lstat`/`read` in git `addFile` → `WorkspaceSnapshotError`. |
| E | No Unicode normalization → NFC vs NFD paths hash differently across filesystems (breaks the cross-platform repeatable-hash acceptance criterion) | HIGH | CONFIRMED | `.normalize("NFC")` at `normalizeRelPath` (content) + on the stored git entry path (raw path retained for fs/stage lookup). |
| F | Self-validation gate does not re-enforce entry sort order | MED | REFUTED (producer always sorts) | Hardened anyway: `assertEntriesSorted` in `finalizeManifest` (defense-in-depth) — trivial, closes the gap the review raised. |
| G | `contentRevision` folds caller-supplied `caseMode` | MED | as-designed (verifier died; orchestrator-adjudicated) | No fix: `caseMode` is a legitimate part of the base-policy identity; same tree + same policy = same revision (the correct repeatable guarantee); collision-folding is `caseMode`-independent so soundness is intact. |
| H | Vector checker uses a structural-subset validator | LOW | REFUTED | No fix: the code-gated `verify` lane runs the real `workspaceManifestV1Schema.parse()`; the `.mjs` is a determinism/reject checker, deliberately independent of zod. |

**Review earned its keep:** finding **B** (the `.aoa/` keystore leak + false digest attestation) was NOT caught in the orchestrator's own first read.

All 8 review-regression tests were observed **failing first** for the predicted reason (e.g. C threw `duplicate workspace path: f.txt` pre-fix; D threw raw `ENOENT`; E stored the raw NFD path; A had `readFileSync` called for the oversize file), then passing after the fix.

**Process-integrity note:** the review workflow's own summary reported "0 findings" due to a **post-processing bug in the orchestration script** (inconsistent stage-2 return shape dropped every dimension that had findings). The orchestrator caught this per the "read the journal before trusting an empty result" rule and recovered the real findings + verdicts from `journal.jsonl`. Lesson: in a `pipeline()` whose second stage sometimes returns a bare `parallel([...])` array and sometimes a `{verified:[]}` object, the flattener must handle both shapes.

---

## 3. Gate table (all GREEN, re-run by the orchestrator after fixes)

| Gate | Result |
|------|--------|
| `worker-daemon exec vitest run` | **89 files / 352 tests** pass (incl. 61 snapshot tests) |
| `worker-daemon typecheck` (`tsc --noEmit`) | clean |
| `worker-daemon build` + `tsc --listFilesOnly` | clean; **0** files under `__tests__`/`*.test.*` in dist |
| `check:worker-daemon-boundary` | PASS (only worker-protocol+pino; zod transitive-only) |
| `check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` | OK (zero worker-protocol edits) |
| `check-workspace-snapshot-vectors.mjs` | PASS (2 positive, 6 reject) |
| `check-workspace-snapshot-vectors.test.mjs` (`node --test`) | 11 pass / 0 fail |
| `check:distributed-foundation` | PASS |
| `pnpm install --frozen-lockfile` | Done (no dependency change) |

No DB/migration: the `migrations` job is a no-op for this ticket.

---

## 4. Non-goals (deferred, per design §7)

Persistence / object storage / MinIO / control-plane commit / `job_artifacts` write → DAT-002. Patch manifests → DAT-003. Live execute/lease wiring → DAT-002 / E4-D12. Extending worker-protocol → forbidden (frozen). Full non-git gitignore semantics → residual.

---

## 5. Residual risks

- **Non-git ignore fidelity** — the `explicit` matcher is intentionally minimal (exact / `dir/` / `*.ext`).
- **Windows content_manifest exec bit** — forced `false` (D5); git base is the cross-platform-stable path.
- **Size-ceiling defaults** — 100 MiB / 2 GiB / 1e6 are starting points, tunable.
- **Inert until wired** — no live caller yet; the self-validating `.parse()` gate + independent vectors make the library trustworthy in isolation.
- **Vector coverage** — 2 positive vectors seed the determinism proof; the independent re-derivation catches drift on those inputs. Richer Unicode/edge vectors can be added additively.

---

## 6. Doc drift to surface (not self-fixed)

`docs/replatform/epics/README.md:25` lists E5 as `DAT-001–DAT-006`; `program-design.md` defines `DAT-001–DAT-007`. Integration Gate Owner's reconciliation.
