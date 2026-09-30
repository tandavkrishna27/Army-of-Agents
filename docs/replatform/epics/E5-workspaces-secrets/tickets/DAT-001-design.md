# DAT-001 Design — Immutable workspace snapshot format

**Status:** `design` (reviewable artifact; implementation follows via per-slice fail-first TDD + distinct adversarial review)
**Epic:** `E5-workspaces-secrets` (the FIRST E5 ticket; deps satisfied → the E5 entry point)
**Authoritative source:** `docs/replatform/program-design.md:624-629`.
**Depends on (both complete):** PRT-005 (E1 — the frozen workspace manifest/base/entry schemas + `canonicalizeJsonV1`), TEN-004 (E2 — composite tenant integrity on `job_artifacts`; **consumed only conceptually by DAT-002, not DAT-001**). Frozen worker-protocol v1 source SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`.
**Grounded by:** the DAT-001 terrain-map (5 readers + synthesis); every load-bearing claim below **re-verified against source in `C:\e3` by the orchestrator** (not merely by the readers). One reader claim was **refuted on re-verification** — see §2 D2.

---

## 1. Scope + the one finding that reshapes the ticket

**Outcome (program-design.md:627):** create canonical manifests for either a Git-commit base or a content-manifest base, recording algorithm/revision, dirty state, tracked/untracked inclusion, ignore & case policy, provenance, normalized paths, sizes, hashes, executable bits, and object references.

**The reshaping fact (verified, load-bearing):** the frozen worker-protocol v1 **already defines the entire manifest CONTRACT** — `workspaceManifestV1Schema` + `workspaceBaseV1Schema` + `workspaceEntrySchema` + `snapshotProvenanceSchema` (`packages/worker-protocol/src/artifacts.ts:96-208`). Every field the ticket enumerates is already there (`base.kind` git_commit|content_manifest, `algorithm` git_sha1|git_sha256|sha256, `revision`, `dirty`, `caseMode`, `ignorePolicy{kind,digest}`, `inclusion{tracked:true,untracked:include|exclude,ignored:false}`, and per-entry `path/kind/provenance/sizeBytes/sha256/executable`). **DAT-001 is therefore a PRODUCER ticket, not a schema ticket.** worker-protocol is FROZEN v1 (E4-D02); it must **not** be extended, and `pnpm check:frozen-worker-protocol-v1` fails closed if touched.

**What DAT-001 builds:** a deterministic filesystem/Git snapshot **producer** — a pure library — that walks a granted folder and emits a `WorkspaceManifestV1` (plus its canonical hash), self-validating fail-closed against the frozen schema. **No DB, no migration, no server route, no persistence** (that is DAT-002). It is worker-daemon-only, hermetically tested, and **inert-until-wired** (nothing calls it in a live loop yet — execution dispatch is deliberately unwired per WRK-007/E4-D12).

---

## 2. Placement + self-validation (the two genuine decisions)

### D1 — The producer lives in `packages/worker-daemon/src/snapshot/` (worker-daemon, not server, not a new leaf pkg)

Verified boundary (`scripts/lib/worker-daemon-boundary.mjs:53,67-87`): worker-daemon runtime source may import **only** `@armyofagents/worker-protocol` + `pino` + Node builtins, **except** the CommonJS-escape bridge `module`/`node:module`. Consequences (all verified):
- `node:child_process` (spawn git), `node:fs`/`node:fs/promises`, `node:crypto` (`createHash`), `node:path` are all plain `node:` builtins → **allowed**.
- `canonicalizeJsonV1` is dependency-free — the header at `canonical-json.ts:4-6` states "dependency-free — no zod, no `node:*` imports, and no forbidden runtime global (NEVER `Buffer`)" (verified: zero import lines in the file) → **runtime-importable from worker-daemon**.

**Rejected alternatives:** (A) server-only — rejected: the isolated worker must be able to snapshot its own granted folder; a server-only producer cannot run inside the worker. (C) a new `worker-protocol+zod` leaf pkg (like `sandbox-provider-contract`) — rejected: worker-daemon cannot add any third runtime dep, so it could not consume such a pkg. **B is the only placement consistent with the boundary and "the worker captures its own workspace."**

### D2 — The producer SELF-VALIDATES with the frozen zod schema **inside worker-daemon** (refutes a terrain-map claim)

The terrain-map brief asserted "the zod-backed `workspaceManifestV1Schema` is NOT importable as a runtime value; zod validation runs server-side." **This is WRONG, and I refuted it by re-verification.** worker-protocol declares its own `zod: 3.24.2` (`packages/worker-protocol/package.json:25`) and is an allowed bare import, so importing a **schema value** from worker-protocol carries zod transitively — and worker-daemon **already does this pervasively** at runtime:
- `enrollment/enroll.ts:186` `enrollmentResponseV1Schema.safeParse(...)`
- `lease/lease-renewal.ts:106` `leaseRenewOperationRequestV1Schema.parse(...)`
- `lease/quarantine.ts:156` `quarantineGrantOperationRequestV1Schema.parse(...)`
- `events/event-upload.ts:66` `eventUploadOperationRequestV1Schema.parse(...)`
- `poll/capacity.ts:100` `workerCapacitySchema.parse(...)`

**Therefore the DAT-001 producer imports `workspaceManifestV1Schema` (the runtime value) and calls `.parse()` on its own output as the final fail-closed gate before returning** — exactly the established `.parse()`-before-emit pattern. This makes the fail-closed guarantee **local** (the worker rejects a malformed snapshot itself) rather than deferring it to DAT-002. The inferred **type** `WorkspaceManifestV1` is also imported (for the build), but validation is a real runtime `.parse()`, not a type assertion.

**Division of fail-closed enforcement:**
- **Schema (`.parse()`) enforces** — path traversal / absolute / backslash / drive-colon / control-NUL (`isSafeWorkspacePath` artifacts.ts:50-66), symlink-unrepresentable (`WORKSPACE_ENTRY_KINDS = ["file","directory"]` artifacts.ts:125), case-collision + duplicate (`addPathCollisionIssues` artifacts.ts:176-190), directory invariants (sha256===null, sizeBytes===0, executable===false), base algorithm↔revision-format (40-hex vs 64-hex), `.strict()` unknown-key rejection, entries ≤ 1,000,000.
- **Producer MUST enforce BEFORE building an entry** (the schema cannot express these) — device/special-file rejection, per-file & total size ceilings (fail the whole snapshot, never silent-skip), ignored-file leakage (never emit an ignored entry), and declared-algorithm-vs-actual-repo-format mismatch. These are net-new (verified: zero `isFIFO|isBlockDevice|isCharacterDevice|isSocket` usages in the tree; no `ignore` npm lib anywhere).

---

## 3. Reuse vs net-new (verified)

**Reuse (import or copy-the-shape):**
- `canonicalizeJsonV1` (`packages/worker-protocol/src/index.ts:309-314`) — **import**; the sole deterministic serializer for the manifest/base hashes. RFC-8785 subset: sorts object keys by UTF-16 code units, **preserves array order** (⇒ the producer MUST sort `entries` itself), rejects floats/unsafe-ints/lone-surrogates (throws `CanonicalJsonError`).
- `sha256Hex` injected-provider pattern (`packages/worker-daemon/src/identity/device-proof.ts:101-103`, twin `packages/sandbox-fake-provider/src/hash.ts:14-18`) — **copy the shape**: `createHash('sha256')` over `Uint8Array|utf8`, lowercase hex, used to drive both per-file content hashing and the canonical digest helpers.
- Git-invocation safety shape (`server/src/services/sandbox-file-movement.ts:149-157` `-c core.hooksPath=`) — **copy the shape** (server module, cannot be imported across the boundary): re-implement via `node:child_process` `execFile` with hardening flags (§4 D7).
- Frozen-vectors + independent `.mjs` reference-checker CI template (`scripts/check-device-proof-vectors.mjs` + `tests/fixtures/device-proof/v1/vectors.json`, wired at `.github/workflows/pr.yml:162-163`) — **clone** for DAT-001's repeatable-hash proof.

**Net-new (no reusable engine):** the fs/git walker; device-file rejection (lstat-based); executable-bit derivation; content-base revision digest; non-git ignore evaluation; deterministic entry sort; algorithm-probe. `server/src/services/output-detection.ts` is a **diff/output-capture** pipeline (post-run detected files, Decision #67), **not** a canonical snapshot — reference only, do not conflate (it silent-skips oversize files; DAT-001 must fail closed).

---

## 4. The algorithm

```
buildWorkspaceManifest(input: {
  root: string,                         // absolute path to the granted folder
  base: "git_commit" | "content_manifest",
  organizationId, companyId, artifactId, sourceTargetId,
  folderGrantId: string | null,
  captureToolVersion: string,
  capturedAt: string,                   // RFC3339; INJECTED (determinism — never Date.now() internally)
  untracked: "include" | "exclude",
  ignore: IgnorePolicyInput,            // see D4
  limits: SnapshotLimits,               // see D6
  sha256: Sha256Fn,                     // INJECTED provider (test seam)
  runGit: GitRunner,                    // INJECTED (test seam; default = node:child_process execFile)
}) => { manifest: WorkspaceManifestV1, manifestHash: string, contentRevision: string }
```

### Base capture
- **`git_commit`:** `resolveGitRoot` via `git rev-parse --show-toplevel`; probe object format (`git rev-parse --show-object-format`) → `algorithm = git_sha1 | git_sha256`; `revision = git rev-parse HEAD`; `dirty` = `git status --porcelain=v1 --untracked-files=all -z` non-empty. Enumerate `git ls-files -z` (tracked, provenance=`tracked`) + (if `untracked==="include"`) `git ls-files -z --others --exclude-standard` (untracked, provenance=`untracked`). Ignored files are excluded by `--exclude-standard` (git is the ignore engine here). Executable bit from `git ls-files --stage` mode `100755`.
- **`content_manifest`:** `algorithm = "sha256"`; walk the tree with `node:fs` (`readdir withFileTypes` + `lstat`); every entry provenance=`untracked` (there is no git tracked/untracked distinction); apply the explicit ignore policy (D4); `dirty = false` (there is no base to diverge from — the content IS the base); `revision = contentRevision` (D3).

### Per entry
Normalized forward-slash relative path (`path.relative(root, abs).split(path.sep).join("/")`); `kind` file|directory; `provenance` as above; `sizeBytes` (0 for dir); `sha256 = sha256Hex(fileBytes)` for files, `null` for dirs; `executable` (D5).

### Fail-closed checks — evaluated in this ORDER, each rejects the whole snapshot
1. **`lstat` every node → reject symlink / FIFO / socket / block / char device** (net-new; the schema cannot express these). A symlink is rejected here (not silently followed), closing symlink-escape at the source; the schema's kind-enum is the second line of defense.
2. **Path-safety pre-check** (`isSafeWorkspacePath` semantics) on the normalized relative path — belt-and-suspenders; the schema re-enforces on `.parse()`.
3. **Size ceilings** (per-file, total-bytes, entry-count) → **reject**, never skip (D6).
4. **Ignored-file leakage** → the producer must never emit an entry it resolved as ignored (schema hard-codes `ignored:false`; enforcement is the producer's).
5. **Declared-algorithm vs actual-repo-object-format mismatch** → reject (the frozen `revision` regex only checks 40-vs-64-hex; it cannot detect a git_sha256 repo mislabeled git_sha1 with a coincidental 64-hex — the producer probes the real object format and asserts equality).
6. **Case-collision / duplicate** → detected early for a clean error; the schema `.parse()` re-enforces.

### D3 — Determinism & the two hashes (the "repeatable content-base hash" crux)
The manifest has **no** top-level hash field. Two distinct digests, precisely defined so vectors can pin them:

- **`contentRevision`** (= `base.revision` when `content_manifest`): the **content identity**, independent of capture-time metadata so the same folder yields the same value on every capture.
  ```
  contentRevision = sha256Hex(canonicalizeJsonV1({
    v: 1, caseMode, ignorePolicy, inclusion, entries: sortedEntries
  }))
  ```
  Excludes `snapshotProvenance` (capturedAt/artifactId/targetId) and `dirty` → **repeatable**. No cycle: `revision` is not among the hashed inputs. For `git_commit`, `base.revision` is the git HEAD sha instead (git is the content-identity authority there).
- **`manifestHash`** = `sha256Hex(canonicalizeJsonV1(manifest))` over the fully-built manifest. This is the value `job.ts workspaceV1Schema.manifestHash` (`job.ts:274`) references and DAT-002 commits. It **includes** `capturedAt`/`artifactId`, so it identifies THIS capture (not repeatable across captures — by design). DAT-001 defines + returns it for canonical consistency; it does not persist it.

**Entry sort (pinned):** ascending by the **UTF-8 byte sequence** of the normalized path. Paths are unique post-collision-check, so the order is total and deterministic. `canonicalizeJsonV1` preserves array order, so this sort is the sole ordering authority — pinned in the design + the vectors.

### D4 — Ignore policy, scoped to stay fail-closed and tractable
- **`git_commit` → `ignorePolicy.kind = "gitignore_plus_aoa"`.** Git applies ignores during enumeration (`--exclude-standard`); the producer does **not** re-implement gitignore semantics. `digest = sha256Hex(canonicalizeJsonV1({ kind, sources }))` where `sources` = the ordered (by path) list of `{path, contentSha256}` for each `.gitignore` present in the tree, plus the constant AOA built-in rule set — so the digest attributes the **actual** rules that were in force.
- **`content_manifest` → `ignorePolicy.kind = "explicit"`.** The caller supplies an **explicit ordered rule list** (possibly empty). The producer applies a **pinned minimal matcher** — each rule is one of: an exact relative path, a `dir/` path-prefix, or a `*.ext` suffix — **not** full gitignore semantics. `digest = sha256Hex(canonicalizeJsonV1({ kind, rules }))`. Ignored files are dropped before entry-building (leakage fail-closed). Empty rules = include-all-non-special. **Richer non-git gitignore semantics are a documented residual (§8), not DAT-001 scope.**

### D5 — Executable bit (cross-platform)
- `git_commit`: from git tree mode `100755` (git normalizes the exec bit → **cross-platform-stable**). This is the reliable source; the design notes git base as the portable one.
- `content_manifest` on POSIX: `lstat` `mode & 0o111 ? true : false`.
- `content_manifest` on Windows: `false` (documented — `stat.mode` is unreliable on win32; cf. `cli/src/__tests__/board-auth.test.ts:117` which bails on win32 for exactly this). Consequence: a `content_manifest` `contentRevision` of the same tree can legitimately differ Windows-vs-POSIX by the exec bit — this is a genuine filesystem difference, documented, not a determinism bug. **Same-platform repeatability is the guarantee; git base is the cross-platform-stable path.**

### D6 — Size ceilings (fail-closed constants, tunable)
DAT-owned `SnapshotLimits` (not the schema maxes, which are outer bounds): default `maxFileBytes` (proposed 100 MiB), `maxTotalBytes` (proposed 2 GiB), `maxEntries` (≤ the schema's 1,000,000). Exceeding **any** → throw `WorkspaceSnapshotError` (reject the whole snapshot). Constants live in one module; the implementer proposes final values with the design defaults as the starting point.

### D7 — Git invocation hardening (every git call)
`execFile` (never a shell) with `-c core.hooksPath=` (no committed hook executes — SECURITY), `-c core.quotepath=false` (raw UTF-8 paths, not octal-escaped), and `-z` NUL-delimited output (paths with spaces/newlines are parsed safely). File **content** is read via `node:fs` and hashed directly (never through git), so `core.autocrlf`/filters cannot perturb content hashes.

---

## 5. Slice plan (fail-first TDD, for the implementer subagent)

1. **content_manifest over a plain temp folder.** Walk + hash + sort + `canonicalizeJsonV1`. Tests: two builds of an identical tree (with identical injected `capturedAt`/`artifactId`) ⇒ identical `contentRevision` AND identical `manifestHash`; `workspaceManifestV1Schema.parse()` accepts. Fail-first: assert `contentRevision` equality before the sorter exists (watch it fail on unsorted entries).
2. **Fail-closed rejections** (temp dirs, per-OS skips — these CANNOT be committed fixtures): symlink escape, FIFO/socket/device, oversize file (per-file + total), `..`/absolute/backslash/`:`/NUL path, case-collision. Each must **throw**, not skip.
3. **git_commit base.** Init a temp repo, commit: assert `algorithm`/`revision`(=HEAD)/`dirty=false`, tracked provenance, exec bit from `100755`. Dirty the tree → `dirty=true` + untracked handling per `untracked`. Plant a git hook that writes a sentinel → assert it **never** runs (`-c core.hooksPath=`).
4. **Algorithm probe + ignore policy.** git_sha1 vs git_sha256 repo detection + declared-vs-actual mismatch rejection; `gitignore_plus_aoa` digest determinism; `content_manifest` `explicit` matcher (exact/`dir/`/`*.ext`) + ignored-leakage rejection + digest determinism.
5. **Self-validation gate.** Force an internally-malformed manifest (e.g., inject a `..` path or a directory entry with a hash) and assert the producer's own `.parse()` throws — proving D2's local fail-closed gate.
6. **Frozen vectors + independent reference checker.** `tests/fixtures/workspace-snapshot/v1/vectors.json` (fully-specified manifest inputs → expected `contentRevision`/`manifestHash`, plus reject inputs) + `scripts/check-workspace-snapshot-vectors.mjs` (a **from-scratch** third canonical re-derivation, mirroring `check-device-proof-vectors.mjs`) + its `node --test` corpus. Wire both into the `policy` job at `.github/workflows/pr.yml` alongside line 162-163.
7. **Cross-platform determinism.** Same logical tree on Windows + POSIX ⇒ identical git-base manifest bytes/hash (exec-bit normalized by git; path-normalization; content read raw). Document the content_manifest exec-bit caveat (D5).

---

## 6. Gate + verification profile (E4-style hermetic — NOT E5 server/DB)

**No DB, no migration, no `db:generate`, no C14/Decision-#122 machinery.** The `migrations` job is a no-op for this ticket.

Local gates before commit (all must be green):
- `pnpm --filter @armyofagents/worker-daemon exec vitest run` (colocated `src/snapshot/__tests__`).
- `pnpm --filter @armyofagents/worker-daemon typecheck` + `pnpm --filter @armyofagents/worker-daemon build`, then `npx tsc -p packages/worker-daemon/tsconfig.json --listFilesOnly` shows **0** files under `src/__tests__` (dist ships no test doubles).
- `pnpm check:worker-daemon-boundary` (+ its `.test.mjs`) — **must stay green: only worker-protocol+pino runtime imports; `node:*` builtins OK; NO zod/db as a worker-daemon dep** (zod arrives transitively via worker-protocol, which is legal).
- `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870ce7509d8baa75409e0ab19da375c88a` — **must stay green: zero worker-protocol edits.**
- `node scripts/check-workspace-snapshot-vectors.mjs` + `node --test scripts/check-workspace-snapshot-vectors.test.mjs` (new).
- `pnpm check:distributed-foundation`, `pnpm install --frozen-lockfile`, root `pnpm -r typecheck && pnpm test:run && pnpm build`.

CI required verdict = the single aggregator `ci-required` (`pr.yml:922`, `needs: [changes, policy, brand-check, worker-protocol-contract-bytes, verify, lint, e2e, e2e-pgvector, migrations, distributed-contract]`). Push after WRK-007 CI is already green (it is), so FF-push is unblocked.

**Fixtures:** committed golden **hash vectors** under `tests/fixtures/workspace-snapshot/v1/`; **attack scenarios** (symlink/device/case-collision) are built at test time in temp dirs with per-OS skips (Windows can't make FIFOs / unprivileged symlinks) — never committed. worker-daemon leaf tests need no embedded-PG and no `AOA_RUN_WIN_INTEGRATION`.

---

## 7. Non-goals (explicitly deferred)

- **Persistence / object storage / MinIO / scoped grants / control-plane commit / `job_artifacts` write / `execution_workspaces` column** → **DAT-002** (`program-design.md:634-636`). DAT-001 returns the manifest object + hash; it stores nothing.
- **Patch manifests (base→result diffs)** → DAT-003; DAT-001 only produces the base a patch later references (`artifacts.ts:229-254`).
- **Wiring the producer into a live execute/lease loop** (`workspaceV1.manifestArtifactId`/`manifestHash`) → downstream (DAT-002 / E4-D12 live-wiring). DAT-001 is inert-until-wired.
- **Extending worker-protocol** — forbidden (frozen). Any "missing field" is out of scope by definition.
- **Full gitignore semantics for the non-git `content_manifest` base** → residual (§8); DAT-001 ships the pinned minimal `explicit` matcher.

---

## 8. Residual risks

- **Non-git ignore fidelity.** The `explicit` matcher is intentionally minimal (exact / `dir/` / `*.ext`). A folder needing full gitignore semantics without a git base is not fully served; documented, deferred. Mitigation: real non-git coding folders are rare in E5; git base covers the common path with git's own ignore engine.
- **Windows exec bit on content_manifest.** Forced `false` (D5) ⇒ a same-tree content_manifest `contentRevision` differs Windows-vs-POSIX. Documented; git base is the cross-platform-stable snapshot.
- **Size-ceiling defaults.** Proposed (100 MiB / 2 GiB / 1e6) are starting points; final values are a policy call surfaced at review.
- **Inert until wired.** Like WRK-005..007, the producer has no live caller; a wiring bug can only surface at DAT-002 / E4-D12. Bounded: the self-validating `.parse()` gate + vectors make the library itself trustworthy in isolation.

---

## 9. Doc drift to surface (not self-fixed)

`docs/replatform/epics/README.md:25` lists the E5 ticket range as **DAT-001–DAT-006**, but `program-design.md:624-671` defines **DAT-001–DAT-007** (DAT-007 = the brokered internal tool surface). This is the Integration Gate Owner's call to reconcile (per the epics-README completion rule); flagged, not changed here.

---

## 10. Decisions ledger

| ID | Decision |
|----|----------|
| **DAT-001-D1** | Producer lives in `packages/worker-daemon/src/snapshot/` (boundary-verified: only placement consistent with the worker capturing its own workspace). |
| **DAT-001-D2** | Producer **self-validates** its output with the frozen `workspaceManifestV1Schema.parse()` inside worker-daemon (refutes the terrain-map "server-side only" claim; worker-daemon already runs worker-protocol zod schemas at runtime). |
| **DAT-001-D3** | Two pinned hashes: repeatable `contentRevision` (excludes capture metadata + dirty) and per-capture `manifestHash` (over the whole manifest). Entry sort = UTF-8 byte order of the normalized path. |
| **DAT-001-D4** | Ignore policy: git base → `gitignore_plus_aoa` (git is the engine; digest over the real `.gitignore` sources); content base → `explicit` minimal matcher (exact/`dir/`/`*.ext`). |
| **DAT-001-D5** | Exec bit: git mode `100755` (cross-platform-stable) for git base; POSIX `mode & 0o111` for content base; `false` on Windows content base (documented). |
| **DAT-001-D6** | DAT-owned size ceilings fail the whole snapshot (never silent-skip), distinct from the schema maxes. |
| **DAT-001-D7** | Every git call: `execFile` (no shell) + `-c core.hooksPath=` + `-c core.quotepath=false` + `-z`; content hashed via `node:fs`, never through git. |
| **DAT-001-D8** | No DB/migration; hermetic worker-daemon verification profile (E4-style), not the E5 server/DB profile the handoff assumed. |
