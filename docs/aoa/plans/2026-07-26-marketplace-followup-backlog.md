# Marketplace / Test-Infra / Viewer Follow-Up Backlog — Sequenced Plan

> **For agentic workers:** This is the **roadmap of record** for the remaining
> post-#298/#300 follow-ups. Each phase below is a self-contained unit that
> produces working, testable software on its own. When you pick up a phase,
> write its **own** detailed task-by-task plan (superpowers:writing-plans) from
> that phase's spec before implementing. Phase 1 already carries full TDD steps
> because it is the recommended first unit and is S-sized.

**Goal:** Close the deferred marketplace merge-correctness, non-catalog install
guards, the Steward reconcile-migration (a viewer-upgrade pre-ship remainder
that shipped open in #298), the embedded-pg CI-flake sweep, a pnpm-pin guard,
and the small viewer-polish items — in a dependency-ordered sequence.

**Architecture:** Each phase lands as its **own PR + Codex review + Linux-CI
gate**, exactly the way #298 and #300 landed. There are **no hard blocking
dependencies** between items (every investigated item reported `dependsOn: []`);
the ordering below is driven by *coherence*, *correctness-of-consumed-data*, and
*file-coupling*, not by hard blocks. The load-bearing risk that recurs across
phases is the **`customized`-flag direction asymmetry** (a wrong
`customized=false` silently re-opens a founder-edited row to overwrite) — every
phase that *writes* the flag must err conservative.

**Tech stack:** Express 5 + Drizzle (server), Postgres (embedded-postgres for
integration tests), Vitest, React + Vite (ui), Playwright (e2e). Drizzle ORM
only for any DB change (Critical Rule #1 — never a hand-authored `*.sql`).

**Provenance:** Current state was verified against source on 2026-07-26 at HEAD
`e0029c7e0` by a 7-agent research workflow, then this plan was hardened by a
4-critic adversarial review (completeness / sequencing / findings-accuracy /
risk) + synthesizer — verdict **sound-with-edits**, all applied below. File:line
references are from those passes — re-confirm before editing, code is truth.

---

## Status at a glance

| Phase | Item(s) | Size | Still open? | Gates / notes |
|-------|---------|------|-------------|---------------|
| 0 | T2.8c skill-bundle invariants (+ case-insensitive jail fix) | — | Built, **uncommitted** | Land first (own PR + Codex), branch `fix/t2.8c-skill-bundle-invariants` |
| 1 | #42 pnpm-pin guard | S | Yes | Zero deps; protects every later `pnpm` run |
| 2 | #31 T2.8b, #30 T2.7b | M+M | Yes | Both edit `marketplace-merge.ts`; serialize (scheduling, not correctness) |
| 3a | T2.9 **b + d** | M | Yes | Ship immediately — no product gate |
| 3c | T2.9 **c** | S | Yes | **Held behind product sign-off**; serializes after 3a (shared file) |
| 4A | #32 Steward **adopt** (standalone reconcile) | M | **Yes — shipped open in #298** | Recommended; independently shippable |
| 4B | #32 move `ensureSteward` to gated path | S | Yes | Fast-follow; must **not** precede 4A |
| 4b′ | Team-template update path (detect/apply) | ? | Yes — **unbuilt** | Sibling of #32; surface + scope decision |
| 5 | embedded-pg port sweep (42 files) | M | Yes | Test-only; Linux-CI-only proof |
| 6 | Viewer polish (a,f,d,b,c-freshness) | M | Yes | Serialize `SharedContentViewer.tsx` |
| 7 | Viewer (e) Workspace ref-ingress, (c) TTL | L+L | Yes | **Promoted out of "polish"** — own scoped phases |

**Recommended first unit after Phase 0:** **Phase 1 (#42)** — smallest, zero
dependencies, continues the test/ci-integrity track. Note it is a **passive
guard** (fires only if someone runs `pnpm add`) — it *protects* every subsequent
session but **unblocks nothing downstream**. The only item that **shipped open
into production** (real correctness debt, per #298) is **#32 (Phase 4)** —
intentionally scheduled ahead of the parallelizable 5/6 lanes, not to be
deferred as "just cleanup."

**Land order:** 0 → 1 → 2 (#31 then #30, rebase-order only) → 3a → 3c → 4A → 4B
→ 5 ‖ 6 → 7. (5 and 6 edit disjoint files — verified — and may run in parallel
worktrees.)

---

## Phase 0 — Land T2.8c skill-bundle invariants (FIXED, pre-decided)

**Item:** T2.8c(a) auto-apply stale-bundle-columns + T2.8c(b) jailed
marketplace-skills root, **plus** the case-insensitive-filesystem hardening of
that jail (surfaced by the plan review — see below). Implemented, **145+ tests
green, typecheck clean** on `fix/t2.8c-skill-bundle-invariants` (off main
`e0029c7e0`), **uncommitted**.

**Case-insensitive jail fix (folded into T2.8c, not deferred):** the original
`isInsideManagedMarketplaceSkillsRoot` compared `path.resolve` output with a
**case-sensitive** string equality + `path.relative`. On win32/darwin (the
primary platform is Windows) `.AOA\Marketplace-Skills\…` names the **same**
directory the OS opens but failed the compare → the jail was bypassable via the
two chains it exists to close. Fixed by lower-casing both compared paths on
case-insensitive filesystems (`managed-skills-root.ts`), with a case-variant
containment test. **Residual (accepted, consistent with the codebase's other
`path.resolve` jails):** symlinks, 8.3 short names (`MARKET~1`), and UNC/`\\?\`
prefixes are not resolved — threat model is an authenticated founder holding an
invariant, not an anonymous escape.

**Action:** commit → own PR → Codex review → CI-green → squash-merge (the
#298/#300 pattern). The roadmap doc rides along in this PR (per the founder's
choice). Nothing else starts until this is on main.

**Exit criterion:** both invariants + the case-insensitive fix live on main; PR
merged.

---

## Phase 1 — pnpm-pin guard (#42) — **recommended first unit**

**Size:** S · **Depends on:** nothing.

**Goal:** Mechanize the human rule "never run `pnpm add`/`install` under pnpm
10/11 here" into a structural guard that fails a required CI gate when the root
`package.json` loses its `pnpm` field.

**Why it exists:** pnpm 10/11 migrates `pnpm.overrides` + `pnpm.patchedDependencies`
out of `package.json` into `pnpm-workspace.yaml` and drops them from the manifest.
Losing that block silently reverts ~22 security-pin overrides (dompurify, undici,
form-data, path-to-regexp, qs, postcss, the `sqlite3: "-"` native-build
exclusions) and un-applies the `embedded-postgres@18.1.0-beta.16` patch the test
DB depends on. An archived plan already recorded a nested shell resolving pnpm to
11.7.0 against the pinned 9.15.4 — the risk is live.

**Current state (verified):** `package.json:71` pins `"packageManager":
"pnpm@9.15.4"`; `pnpm.patchedDependencies` at `:73-75`; `pnpm.overrides` at
`:76-98`. CI is already safe from self-mangling (every workflow pins
`pnpm/action-setup@…v6.0.9` `version: 9.15.4`), but **no test or CI step asserts
the `pnpm` field survived** a commit. Root `vitest.config.ts` uses `projects:` so
a contract test must live inside a workspace (e.g. `server/src/__tests__/`), not
repo root.

**Approach (recommended):** a Vitest **contract test** (matches the CLAUDE.md
"Contract tests" convention and runs in the required `verify` gate **and**
locally via `pnpm test:run`). Assert **structure only** — never exact override
values, so legitimate override bumps don't churn it.

**Files:** create `server/src/__tests__/pnpm-manifest-guard.test.ts`; no
production change.

### TDD steps

- [ ] **Step 1 — Write the failing test.** Create
  `server/src/__tests__/pnpm-manifest-guard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Repo root relative to server/src/__tests__/  ->  ../../../
const ROOT = path.resolve(__dirname, "..", "..", "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

describe("pnpm manifest guard (#42) — pnpm 10/11 must not have dropped the pnpm field", () => {
  it("pins packageManager to pnpm 9.x", () => {
    expect(pkg.packageManager).toMatch(/^pnpm@9\./);
  });

  it("keeps a non-empty pnpm.overrides block (the security pins)", () => {
    expect(pkg.pnpm?.overrides).toBeTypeOf("object");
    expect(Object.keys(pkg.pnpm.overrides).length).toBeGreaterThan(10);
  });

  it("keeps the embedded-postgres patchedDependencies entry and its patch file", () => {
    const patched = pkg.pnpm?.patchedDependencies ?? {};
    const key = Object.keys(patched).find((k) => k.startsWith("embedded-postgres@"));
    expect(key, "embedded-postgres patchedDependencies entry missing").toBeTruthy();
    expect(existsSync(path.join(ROOT, patched[key!])), `patch file ${patched[key!]} missing`).toBe(true);
  });
});
```

- [ ] **Step 2 — Prove it is a real guard.** Copy `package.json` to the
  scratchpad, delete its `pnpm` key, point a throwaway run at the copy and
  confirm all three assertions fail. Discard the spike.
- [ ] **Step 3 — Run green against the intact manifest.**
  Run: `pnpm --filter @armyofagents/server test:run src/__tests__/pnpm-manifest-guard.test.ts` → 3 passed.
- [ ] **Step 4 — Confirm it runs in the required gate.** `pr.yml`'s `verify` job
  runs `pnpm test:run` — no workflow edit needed. (The `verify` job carries the
  draft-skip `if`, so it does not run on draft PRs — acceptable; drafts can't
  merge and jobs re-run on `ready_for_review`.)

**Open decisions:** (1) also ship the optional `preinstall`
`scripts/enforce-pnpm-major.mjs` (throws if pnpm major ≠ 9; `--ignore-scripts`-bypassable,
so it complements not replaces the CI detection). (2) Also assert
`pnpm-workspace.yaml` did **not** gain migrated `overrides`/`patchedDependencies`
keys.

**Exit criterion:** the guard is green on HEAD and provably red when
`packageManager` / `pnpm.overrides` / the embedded-postgres `patchedDependencies`
entry is removed; merged.

---

## Phase 2 — Marketplace merge primitives, byte-level correctness (#31 then #30)

**Size:** M + M · **Depends on:** nothing hard. Both edit
`server/src/services/marketplace-merge.ts`, so **serialize (one committer)**.
The `#31-then-#30` order is **scheduling (merge-conflict avoidance), not
correctness** — verified: both directions are correctness-independent, so either
may land first after a rebase. If #30 threads the detected EOL by **re-deriving
it internally** (no `applyMergeDecisions` signature change), the two become
independent enough for parallel worktrees in either order.

All Phase-2 tests are **pure unit tests (no pg) — cross-platform**, so they
verify on Windows and Linux alike.

### 2a — #31 / T2.8b: byte-derive the skill `customized` flag

**Goal:** Stop `mergeSkillUpdate` from marking **every** reviewed skill merge
`customized=true`. Derive it from result bytes — `false` iff the merged skill is
byte-identical to the upstream document the founder reviewed against, else
`true`, never null — mirroring the **already-shipped agent side**
(`mergeAgentUpdate` sets `instructionsCustomized = !pureUpstream`,
`agent-update-merge.ts:417`, `pureUpstream` a pure byte test in
`marketplace-agent-merge.ts:319-329`).

**Current state (verified):** `mergeSkillUpdate` hard-codes `customized: true`
**unconditionally** (`skill-update-merge.ts:218`) alongside `markdown: merged`
(`:213`, `merged = applyMergeDecisions(diff, decisions)` `:181`).
**Consumers of the flag (corrected):** `mergeSkillUpdate` itself does **not**
read it, but it *is* read as an overwrite-refusal / auto-apply gate by
`skill-auto-updater.ts:104` (throws) + `:135` (optimistic lock),
`company-skills.ts:2294` (`installUpdate`), `:2113` (`scanProjectWorkspaces`),
and `:2557` (`upsertImportedSkills`). All of those err **conservative** (refuse
/ skip), so the downstream conclusion holds — flipping the flag correctly only
*loosens* over-refusal; it never introduces data loss on its own — but the plan
must not claim "only consumer is the auto-apply gate."

**The non-obvious trap (T2.8b Step 4):** a naive `merged === upstreamContent`
compare will **not** work — `applyMergeDecisions` reassembles with `\n\n`,
`.trim()`s, and `splitSections` is fence-unaware + line-ending-normalizing, so
even an all-accept-upstream merge does not reproduce upstream bytes. Use the
agent side's **verbatim shortcut**: when the merge resolves to pure-upstream,
write `markdown: upstreamContent` **verbatim** and `customized: false`; else
`markdown: merged`, `customized: true`. The unchanged-section test must be
**byte-equal** (`mine === theirs`), **not** trim-equal
(`marketplace-agent-merge.ts:178-196`).

**Approach:** extract a pure helper beside `applyMergeDecisions` —
`mergeSkillDocument(diff, decisions, upstreamContent) -> { content, pureUpstream }`
— unit-testable without db/network mocks. pureUpstream iff every section resolves
to `theirs` **or** is `unchanged` with byte-equal `mine===theirs`; every `added`
section accepted; no `removed` section kept as `mine`. In `mergeSkillUpdate`
replace `:213`/`:218` with the helper's `content`/`!pureUpstream`. Leave
`sourceRef`, `resolveBundleColumns(...)`, and the pending-update write unchanged.
(Writing `upstreamContent` verbatim does **not** violate the skill docblock's
"never overwrite markdown with the bundle's SKILL.md" — that rule is about
`materialized.markdown`, a different source than `upstreamContent`.)

**Files:** `skill-update-merge.ts`, `marketplace-merge.ts`,
`marketplace-company-customized.test.ts` (rewrite `:155-172` — it asserts
`customized===true` for an all-theirs merge; under the fix it must be `false`),
`routes/marketplace-company.ts` (route test).

**Tests (unit, cross-platform):** all-accept-upstream → `customized=false` +
markdown byte-equals `upstreamContent` + the row re-enters auto-apply (assert
`applySkillUpdate` no longer throws for it); mixed merge keeping any `mine`
section → `customized=true`; whitespace-only `unchanged` section kept as `mine`
→ `customized=true` (locks byte-based, not trim-based).

**Risk (load-bearing):** a **false** `customized=false` re-opens founder edits to
silent overwrite on the next catalog bump. Byte-exact derivation is mandatory;
erring conservative (wrongly `customized=true`) only forfeits one-click
auto-apply. Governance-visible behavior change (a frozen row becomes eligible
again); the existing test asserts the old behavior and breaks **by design**.

**Companion — a HARD RULE, not a recommendation:** the direct file-edit path
(`company-skills.ts updateFile:1693/:1702`) is byte-blind the same way, but its
fix **must be filed as its own item in the Phase 3 lane, NEVER folded into 2a.**
`company-skills.ts` belongs to Phase 3; a Phase-2 edit there puts the file in
both phases and breaks the phase-disjoint invariant that keeps 2 and 3
collision-free.

### 2b — #30 / T2.7b: fence-aware + line-ending-safe section splitting

**Goal:** `splitSections` must not treat a `## heading` **inside a fenced code
block** as a boundary, and `applyMergeDecisions` must preserve the document's
dominant line ending instead of hardcoding `\n\n`/`\n`.

**Current state (verified):** `splitSections` (`marketplace-merge.ts:25-45`)
does `markdown.split("\n")` and treats every `line.startsWith("## ")` (`:32`) as
a boundary with no fence state → a `## Foo` inside ``` splits, carrying the
closing ``` into a separate section → a mixed merge leaves an **unbalanced
fence**. (Only exact `## ` matches.) `split("\n")` retains trailing `\r` on CRLF
docs, and `applyMergeDecisions` (`:134-152`) reassembles with `parts.join("\n\n")`
(`:151`) + `.trim()+"\n"`.

**Approach:** (A) add an `inFence` state machine (`:31-40`): detect a fence line
by trimming indent + matching a run of ≥3 backticks/tildes; track marker char +
run length (a ``` block closes only on a ≥-length same-char fence line; opening
lines may carry ` ```md `); apply the `## ` boundary test only when `!inFence`.
(B) split on `/\r?\n/`; detect the dominant EOL once; join with `eol+eol` and
terminate with `eol`. Keep LF-only output **byte-identical** to today.

**Scope guard (critical):** only the **mixed-decision** reassembly path is in
scope. The all-mine / all-upstream **wholesale** paths
(`marketplace-agent-merge.ts:293-299`) bypass `applyMergeDecisions` and
reconstruct from whole-file maps — the byte-exact guarantee (441 doc pairs +
4,000-iteration sweep, `:216-250`) must not regress.

**Files:** `marketplace-merge.ts`, `marketplace-merge.test.ts`, and — **in
lockstep if the `SectionDiff` shape or `applyMergeDecisions` signature changes**
— `skill-update-merge.ts:181`, `agent-update-merge.ts`,
`marketplace-agent-merge.ts:313`, `ui/.../MergeDiffPane.tsx`. Confirm the shipped
skill/agent merge test suites did not encode the broken `\n\n`/fence behavior;
fix any that did **with a note**.

**Tests (unit, cross-platform):** (1) fenced `## ` stays in its parent section +
fence balances after a mixed merge; (2) a CRLF doc survives a mixed merge with
CRLF intact; (3) an LF mixed merge is **byte-unchanged** from today.

**Open decisions:** how to thread the EOL into `applyMergeDecisions` (second arg
vs re-derive vs `SectionDiff` field); fence-detection strictness.

**Optional parity (surfaced):** the skill `GET /updates/:id/diff` branch
(`marketplace-company.ts:545-546`) lacks the `identical` flag the agent branch
has (`:499`) — small UX gap, not required.

**Exit criterion (Phase 2):** `customized` is byte-derived; `splitSections` is
fence-aware and `applyMergeDecisions` preserves the dominant EOL; the wholesale
byte-exact guarantee is unregressed and LF-only mixed-merge output is
byte-identical to today; all marketplace merge suites green.

---

## Phase 3 — Non-catalog customized-skill overwrite guards (T2.9 b/c/d)

**Size:** M · **Depends on:** #31 **soft** (guards read the flag; without #31
they over-refuse on byte-identical merges — conservative, no data loss).
**Split so the product-gated 3c does not stall the independent fixes:**

- **Phase 3a = T2.9 b + d** — no product dependency, ship immediately.
- **Phase 3c = T2.9 c** — held behind product sign-off; serializes **after** 3a
  (shared `company-skills.ts`).

**Framing correction:** "bulk re-sync" only fits **d**. **e** (project scan) is
**already shipped/closed** (`company-skills.ts:2113-2140`, pre-read +
`customized=false` predicate). Baseline shipped by T2.9: the guard on
`upsertImportedSkills` (`:2489-2593`) with a `CustomizedSkillWritePolicy` arg.

### Phase 3a

- **T2.9b — `createLocalSkill` (`:1729-1776`)** uses `caller_is_authoritative`
  (`:1773`) with **no collision pre-check** → a create colliding with a
  **customized** key silently overwrites + clears it. **Fix:** refuse the
  collision with a **409 name-taken** (a *new* code, not `SKILL_CUSTOMIZED`).
  **Concurrency (must):** a plain read-then-upsert is **TOCTOU** — two concurrent
  creates both read "absent" and the second clobbers via
  `caller_is_authoritative`. Enforce via a **DB unique index** on the skill key
  (`company/<cid>/<slug>`) + catch-and-map-to-409, **or** route
  `createLocalSkill` through the same **per-slug advisory lock**
  `importPackageFiles` uses. Add a concurrent-create assertion to the guard test.
- **T2.9d — company-bundle import (`company-portability.ts`)**
  `caller_is_authoritative` (`:2619-2623`) with three gaps: (1) **customized
  overwrite** — the planner reads `skills.listFull` (`:1800`) which **drops**
  `customized`; **fix:** read a customized-aware list, surface the collision, and
  **default the collision to PRESERVE** (the customized skill is skipped /
  unchecked by default; overwrite requires an explicit **per-item founder
  opt-in**). *Surfacing a plan line ≠ preventing overwrite* — the exit criterion
  must pin the preserve default, or a bulk import silently clears founder edits.
  (2) **Positional pairing** `upserted[i]` (`:2624-2636`) is a latent bug — a
  concurrently-deleted row shifts every later id; **fix:** pair by **key**.
  (3) **Attacker-controlled `sourceType`** — validator is `z.string().min(1)`
  (`validators/company-portability.ts:81`); **fix:** constrain to the known enum.

**Phase 3a tests:** L2 service+mock (harness `company-skills-install-guard.test.ts`,
**cross-platform**). b: colliding customized key → 409 (row+flag untouched) +
concurrent-create assertion; fresh slug → succeeds. d: customized surfaced AND
**defaults to preserve**; pair-by-key regression. **Assert pair-by-key fully at
the L2 mock layer** (so Windows verifies it) or explicitly gate the optional L4
real-Postgres variant behind Linux CI — do not leave the id-mispairing
data-integrity bug covered only by a Windows-blind `skipIf(win32)` assertion.

### Phase 3c (product-gated)

- **T2.9c — `importPackageFiles` (`:1794-1894`)** `caller_is_authoritative`
  (`:1884`) with **no customized check**, and it `fs.rm -rf` + rewrites the dir
  (`:1843`) **before** the upsert. **Fix:** check at `doWork` step 1 (`:1816`,
  before `fs.rm`); if customized, throw `skillCustomizedConflict` and return
  early (no disk mutation, no torn state). ~3 lines.
- **⚠ Product decision (blocks 3c):** *who owns a package-imported skill after
  the founder edits it in the UI?* Protecting founder edits makes an agent's
  package upload start FAILING for a reason callers must handle. **Needs
  product-owner sign-off before 3c lands.**

**Phase 3a exit criterion:** b returns 409 on a customized collision **and is
concurrency-safe** (unique index or lock); d surfaces customized as a planned
collision that **defaults to preserve** (overwrite = explicit per-item opt-in),
pairs by key, and rejects a bogus `sourceType`; guard tests green.
**Phase 3c exit criterion:** c refuses **before** `fs.rm` (founder's on-disk file
survives), once signed off; guard test green.

---

## Phase 4 — Steward reconcile-migration (#32) — viewer-upgrade pre-ship remainder

**Size:** M · **Depends on:** nothing external. **Split into 4A (adopt) + 4B
(move `ensureSteward`).** Touches the most-reviewed crew machinery — **do with
review.**

**Status: STILL OPEN (confirmed by two critics).** Shipped open in #298. Zero
steward migrations in `packages/db` (the only `steward` hit is the unrelated
`schema/notifications.ts`; latest migration `0183`). `ensureSteward` sits in the
**unconditional** `ensureInfrastructureAgents` (`crew-seeding.ts:129`), "⚠️
TEMPORARY PLACEMENT" docblock intact. `CREW_NAMES` excludes Steward + Chronicler
(`backfill-template-origin.ts:39-49`) → legacy Steward rows keep `templateOrigin
= NULL`. A T2.3-era managed company reads **`healthy`** (`crew-repair.ts:254-261`)
→ `repairCompanyCrew` returns `{action:"none"}` (`:344`) → its null-origin
Steward is **never adopted** and is **force-re-seeded every boot** by
`ensureInfrastructureAgents`.

### 4A — Adopt the legacy Steward (recommended: **standalone reconcile pass**)

**The must-fix correction:** do **NOT** implement this by reclassifying `healthy`
in `diagnoseCrewProvisioning`. That function is contractually **no-network**
(`crew-repair.ts:199-203`) and its docblock (`:152-158`) explicitly refuses to
encode roster knowledge ("would guess wrong exactly when the roster changes e.g.
when T2.4 moves Steward into the crew"). Reclassifying hardcodes `name=="Steward"`
into that layer **and**, because `healthy` short-circuits **before**
cooldown/network (`:344`), flips **every** T2.3-era managed company into the
network-bearing `repairDegradedCrew` **simultaneously** on the first boot after
deploy.

**Instead:** a **surgical standalone `reconcileLegacyStewardOrigin` pass**, run
from `runCrewUpdateCheck` (`index.ts:895`), that reuses crew-repair's advisory
lock + all-or-nothing transaction + the existing pointer-only adoption
(`crew-repair.ts:457` name-match, `:594-601` sets `templateOrigin` +
`templateVersion = ADOPTED_TEMPLATE_VERSION`, leaves
instructions/skillKeys/triggers/adapter → `instructions_customized` stays NULL),
and writes the `team_members` link. All via Drizzle
`db.update(agents).set(...)` / `db.insert(teamMembers)` — **never raw SQL**. It
adopts the leftover Steward **without perturbing the shared `healthy`
classification** every other managed-company path depends on.

**Runtime off-switch + backout (must):** the pass runs at boot **and on a 24h
interval** (`index.ts:975-979`) — it is **not** a recorded migration, so a bad
predicate re-fires every pass and a code rollback does **not** undo the
persistent `templateOrigin`/`templateVersion` writes. And
`ADOPTED_TEMPLATE_VERSION` (`'0.0.0-legacy'`) is a sentinel **shared with every
other crew-repair adoption** (`crew-repair.ts:106-108`), so a blanket revert
keyed on it would un-adopt legitimately-repaired non-Steward crews. Therefore:
(a) add an **env kill-switch** that disables **only** the Steward-reconcile
branch without a code rollback; (b) document a **manual backout query** filtered
to `name='Steward'` **AND** companies never marketplace-installed (the sentinel
alone is unsafe). Both go in the exit criterion.

### 4B — Move `ensureSteward` to the gated `ensureCrewAgents`

Move the `ensureSteward` line from `ensureInfrastructureAgents` into
`ensureCrewAgents` (`crew-seeding.ts:148`) and update the TEMPORARY-PLACEMENT
docblock, so a managed company stops force-re-seeding the legacy Steward each
boot.

**Ordering (corrected — the review refuted the original "lose entirely"
claim):** `ensureSteward → seedCrewAgent` is **create-if-missing and never
deletes**, and `team-reconcile.ts:122-154` (normal path, not degraded-gated)
already refuses a duplicate Steward when an unmanaged row holds the name. So
**B-alone leaves Steward *frozen*, not lost** — near-inert, not destructive.
`crew-seeding.ts:103-116` documents the (now-mitigated) *duplication* hazard, not
loss. The real rule: **4A is independently shippable and may land as its own PR
first; only 4B-before-4A is (weakly) wrong.** Do not cite `:103-116` as "loses
Steward."

**Force-seed premise (corrected):** force-seed does **NOT** clobber founder
instructions — `seedRoleInstructionBundle` is idempotent / "never clobbers
founder edits" (`seed-crew-agent.ts:237-239`); it *does* rewrite
`runtimeConfig.aoa.toolAllowlist` + adapter on drift (`:188-235`), not
instruction content. Any 4B rationale that depends on force-seed clobbering
instructions is wrong.

**Files:** `crew-repair.ts`, `crew-seeding.ts`, `ensure-steward.ts`,
`backfill-template-origin.ts`, `team-reconcile.ts`, `index.ts`,
`crew-repair.integration.test.ts`.

**Tests (embedded-pg integration, Linux-CI-gated; Windows via
`initdbFlags ["--encoding=UTF8","--locale=C"]`; fixture =
`__fixtures__/published-catalog/` 10-member team):** set up a marketplace-managed
crew **plus** a legacy null-origin Steward. Assert: (1) the **same** Steward
`agentId` now has `templateOrigin='agent:aoa-curated/aoa-steward'` (adopted in
place, still owns its steward sweep trigger); (2) exactly one Steward + one
trigger + one `team_members` link; (3) crew-updater now **considers** the row;
(4) idempotency (2nd run adopts 0); (5) **already-adopted healthy company reads
`healthy` + does ZERO network per pass** (the regression guard); (6)
**catalog-miss fail-closed** — a managed company whose loaded catalog snapshot
LACKS `aoa-steward` hits the all-or-nothing skip (`crew-repair.ts:472-482`) yet
**does not lose curation** (leftover null-origin Steward row + sweep trigger
persist); (7) the kill-switch disables the branch; (8) 4B ablation — a re-seed
boot leaves exactly one Steward, origin unreverted. **Note** `CREW_REPAIR_MAX_PER_PASS=5`
(`crew-repair.ts:1055`) bounds fleet convergence to 5 companies/24h — safe
(leftover rows persist) but slow on multi-company instances.

**Stamping hazard (sufficiency confirmed):** never set a non-@legacy origin on a
NULL-origin row **outside** the true published origin (flips
`isCrewMarketplaceManaged`, suppresses the crew seed). Pointer-only adoption **is
sufficient** precisely because it is confined to **already-managed** companies
(`isCrewMarketplaceManaged` already true → stamping the true origin is a no-op)
inside one all-or-nothing transaction — no partial stamp can flip a not-yet-managed
company mid-repair.

**Open decisions:** fold **Chronicler**'s identical NULL-origin gap into the same
reconcile (it is on the gated crew side → lower risk) or file separately;
optionally add Steward/Chronicler to `CREW_NAMES` (with `@legacy` suffix) for
slug-matching (complementary, not a substitute for adoption).

**Exit criterion:** assertions (1)–(8) above; the env kill-switch and the
documented backout query exist; embedded-pg integration green on Linux CI.

### 4b′ — Team-template update path (surfaced by review; scope decision)

The **third** catalog item type — **team** — has **no update path at all**, and
Phase 2's own exit criterion was "an upstream agent OR skill change flows through
detect→notify→diff→merge." Three live artifacts prove it open + known:
`crew-updater.ts:455` `TODO: Add agent + team template checks` (a `team.json`
change is never even **detected** for an installed company); `POST /updates/:id/apply`
returns **501** "Direct apply not supported for team updates"
(`marketplace-company.ts:447-448`); `team-reconcile.ts:11-18` (WS6) is "inert,
not broken" until a companion catalog PR lands. It is the direct sibling of #32.
**Decision needed:** build it as a Phase-4 sibling (wire `checkCompany`'s TODO +
replace the `/apply` 501 with real handling), or an explicit **scope-boundary
deferral** — but not a silent omission, since this doc is the roadmap of record.

---

## Phase 5 — Embedded-pg port-allocator sweep (test-infra)

**Size:** M · **Depends on:** nothing. Test-only, zero production code. **Own PR.**

**Goal:** migrate the **42** remaining `*.integration.test.ts` suites off a
module-level fixed random port onto `allocateEmbeddedPgPort()`
(`server/src/__tests__/helpers/embedded-pg-port.ts`), killing the parallel-boot
EADDRINUSE flake.

**Current state (verified exact):** of 50 integration files, 43 boot a cluster;
only `work-questions.integration.test.ts` uses the allocator — **42 remain** on
`const PORT = <base> + Math.floor(Math.random()*<range>)`. No `vitest.config.ts`
pool override → parallel forks pool → overlapping fixed ranges collide.

**Approach (template = `work-questions`):** per file — import the allocator
(relative `./helpers/embedded-pg-port.js`, correct for all 42 flat files); delete
`const PORT`; `const port = await allocateEmbeddedPgPort();` in `beforeAll`;
`port: PORT` → `port,`; `${PORT}` → `${port}`.
- **34 files** = clean 3-reference case.
- **8 hub-\* files** also use `${PORT}` as a seed-email **uniqueness salt** in
  `it`-scoped helpers → hoist to a module-level `let port = 0;` assigned in
  `beforeAll` (mixing a beforeAll-local for these is the likely bug).
- Delete obsolete "Offset by +N" comments (`w1b:53`, `w1c:55`, `w2:71`,
  `w3a:72`). No suite intentionally shares a port; no file sets
  `process.env.DATABASE_URL`.

**Files:** the 42 listed suites (research report `pg-port-sweep.affectedFiles`).

**Tests:** the migrated suites **are** the surface. **Only truly verifies on
Linux CI** (all are `skipIf(win32)`; the flake only manifests under the CI forks
pool). Land behind a CI-green gate.

**Durability follow-up (recommended):** add a hygiene meta-test asserting no
`*.integration.test.ts` declares a module-level
`const PORT = <n> + Math.floor(Math.random()...)`.

**Exit criterion:** all 42 import the allocator, drop the fixed const, allocate
in `beforeAll` (module-level `let port` for hub-\*), obsolete offset comments
pruned; Linux CI integration lane green; hygiene meta-test green.

---

## Phase 6 — Viewer polish, small internal wins

**Size:** M · **Depends on:** nothing. **Serialize the `SharedContentViewer.tsx`
touchers** (a's test, b's fetch, d's convert path). Verified disjoint from Phase
5, so 5 ‖ 6 is safe.

- **(a) mermaid render test** — S, test-only. Add success (svg → iframe `srcDoc`)
  + error-fallback tests to `SharedContentViewer.test.tsx` (`vi.mock("mermaid")`).
- **(f) messageId backfill** — S-M, internal. **Zero current UI consumer** — ship
  only if paired with a downstream correlation/dedup feature; else leave null.
  Recommend defer.
- **(d) office server-side render cache** — M. Rate-limit + 413 + browser
  `Cache-Control` already landed (#43); add a bounded LRU keyed on the immutable
  `companyId:assetId`, caching the **sanitized** HTML (preserve the sanitization
  guarantee through the cache). Decide if worth it given browser cache +
  immutable assets.
- **(b) viewport-gated previews** — M, perf. Gate the `useQuery enabled` flag
  behind an `IntersectionObserver` (reuse `ui/src/onboarding/motion/useInView.ts`;
  test setup stubs IO).
- **(c-freshness) auto-open gate** — S-M. `shouldAutoOpen`/`pickAutoOpenRef`
  (`commanderViewerModel.ts:216-235`) ignore replay, so an SSE-replayed old
  `created` ref re-opens a tab. Safer signal = **tag refs reattached on the
  idempotent SSE replay path**, not a wall-clock `emittedAt` threshold. Flip the
  baseline `commanderViewerModel.test.ts:203` to `toBeNull()`.

**Exit criterion:** (a) mermaid success + error render tests; (b) text/json
previews fetch only in-view; (c) replayed/stale created ref rejected, baseline
flipped; (d) bounded server-side cache preserves sanitization; (f) shipped only
with a consumer; suites green.

---

## Phase 7 — Deferred viewer workstreams (promote OUT of "polish")

**Size:** L + L · Each is its own scoped phase, gated on product prioritization.

- **(e) Workspace ref-ingress** — L. `showRefToWorkspaceTab` adapter + 4-5 new
  tab bodies (reuse `refBodies.tsx`) + wire `heartbeat.run.outputs_detected` /
  `task.output.created` in `LiveUpdatesProvider` to invalidate
  `taskOutputs.byIssue`. Mirrors Thread Phase-7B.
- **(c-TTL) TTL-ephemeral artifact lifecycle** — L. Archive-not-delete +
  shared-asset refcount + list-exclusion. Product owner **repeatedly deferred**.

**Exit criterion:** scoped separately, only after product prioritization. **Not
required for the marketplace/CI backlog to close.**

---

## Cross-cutting risks

1. **`marketplace-merge.ts` is shared** with the shipped skill + agent merges —
   #30/#31 change shipped behavior. The byte-exact wholesale guarantee (441 pairs
   + 4,000-iter sweep) must not regress (mitigated: wholesale paths bypass
   `applyMergeDecisions`); add an explicit **LF-only mixed-merge byte-identity
   regression test**.
2. **`customized`-flag direction asymmetry** (load-bearing across **#31 and
   T2.9** — *not* #32): a false `customized=false` silently re-opens a
   founder-edited row to overwrite. Derivation must be **byte-exact**; err
   conservative. (#32 is **not** here — see risk 3.)
3. **#32 origin-stamping hazard:** never set a non-@legacy origin on a NULL-origin
   row outside the true published origin (flips `isCrewMarketplaceManaged`,
   suppresses the crew seed). **Pointer-only adoption is sufficient because it is
   confined to already-`installed` companies (stamping the true origin is a no-op
   there) inside one all-or-nothing transaction** — no partial stamp flips a
   not-yet-managed company mid-repair. #32 leaves `instructions_customized` NULL
   (the safe NOTIFY direction) and never writes the `customized` flag.
4. **`SharedContentViewer.tsx` contention** (Phase 6): serialize its touchers,
   one committer per worktree.
5. **Windows-blind verification is systemic:** integration tests + all e2e skip
   on Windows (Issue #114). Phase 4's crew-repair test, Phase 5's sweep, and any
   L4 real-Postgres guard (e.g. T2.9d pair-by-key) **only truly validate on Linux
   CI** — land each behind a CI-green gate. Phase 2's merge tests and Phase 3a's
   L2 mock tests are pure/cross-platform and verify on Windows. A green local
   Windows run proves nothing for the pg-integration items.
6. **Draft-PR skip:** required gate jobs carry the draft-skip `if` — do not
   mistake a draft's skipped guard for a pass.

---

## Newly surfaced items & product decisions (not in the original backlog)

1. **Direct file-edit `customized` byte-blindness** (`updateFile:1693/:1702`) —
   companion to #31; **its own Phase-3-lane item, never folded into 2a** (hard
   rule — see Phase 2a).
2. **T2.9c product decision** — ownership of a package-imported skill after a
   founder edit; blocks Phase 3c.
3. **Chronicler NULL-origin gap** — identical to Steward's, on the gated crew
   side (lower risk); decide in Phase 4A whether to fold in.
4. **Team-template update path** — Phase 4b′; build or explicit scope-boundary
   deferral, not silent omission.
5. **Phase 5 hygiene meta-test** — make the port sweep permanent.
6. **Viewer (e)/(c-TTL) mislabeled as "polish"** — Phase 7, own scoped
   initiatives with product prioritization.
7. **Catalog-contract hardening (T2.3d F3/F4/F5)** — F3: `install.defaultRole:
   'engineering'` is out of `AGENT_ROLES` → silent fall-back to `general`; F4:
   `adapterCompatibility.requiresInstructionsBundle`/`.requiresSkillInjection`
   are parsed but **never read** (dead contract); **F5 (most substantive):**
   `team.json` has **no runtime validation** (`team-installer.ts:172-174`,
   unchecked `JSON.parse … as TeamTemplateBody`) — add a Zod schema mirroring the
   agent side. Nice-to-have; filed here so the roadmap owns them.
8. **`installTeam` duplicate-install semantics** (T2.3b filed decision) —
   hard-fail via a unique index on `teams(companyId, templateOrigin)` vs the
   current `pg_advisory_xact_lock` + operation-row sealing. Product decision
   adjacent to Phase 4 (shares the lock/sealing invariant #32 relies on).
9. **Skill-merge `identical` flag parity** (Phase 2b optional) — small UX gap.
10. **messageId backfill (viewer f)** — speculative; ship only with a consumer.

---

## Execution order & handoff

**Land order:** 0 → 1 → 2 (#31 then #30, rebase-order only) → 3a → 3c (on product
sign-off) → 4A → 4B → 5 ‖ 6 → 7 (on product prioritization).

**Each phase = its own PR + Codex review + Linux-CI gate**, matching #298/#300.
**Execute the two Phase-4 must-fixes (standalone reconcile approach; kill-switch
+ backout) before Phase 4 lands.**

**Per-phase handoff:** when a phase starts, write its own detailed task-by-task
plan (superpowers:writing-plans) from that phase's spec above — this roadmap
stops at per-phase specs for the M/L phases and only Phase 1 carries full TDD
steps.
