# BRW-hostspawn-gate — anti-orphan guard for the host-side browser spawn (design)

**Epic:** E8 (Browser Automation) · **Sprint:** 7 · **Type:** GATE (session-buildable, guard-only)
**Owner-of-removal:** BRW-008 (this ticket does NOT close the spawn)
**Depends on:** nothing buildable — it is deliberately the FIRST E8 unit that lands, because it
makes a live, uncovered security debt catchable and regression-proof *before* the governed path
(BRW-002..007) exists.
**Branch/tip this design was verified against:** `docs/replatform-program` @ `dab65f289`.

> **Read `§0` first, then re-verify every path:line at execution start.** Line numbers rot. Every
> claim below is anchored to a `path:line` or a `§/id` read at `dab65f289`; the *identifiers*
> (`PLAYWRIGHT_MCP_PACKAGE`, `buildMcpConfig`, `@playwright/mcp`, `renderMcpBlock`,
> `writeCodexMcpConfigToml`, `toOpenCodeEntry`) are stable, the *lines* are not.

> **A note on this file's own name (important — this is the v2 fix that unblocks the whole doc).**
> This ticket is deliberately named **`BRW-hostspawn-gate`**, NOT `BRW-008-GATE`. The rename is
> not cosmetic: `expandTicketIdsFromFilename` (`scripts/lib/ticket-graph-coverage.mjs:41-48`) matches
> `^([A-Z]{2,5})-(\d{3})…`, so `BRW-008-GATE-design.md` expands to the id **`BRW-008`** (the regex
> takes the `008` and stops at `-GATE`). That would (a) wrongly mark `BRW-008` as *file-backed* while
> its retirement outcome is unbuilt, (b) force a `#### BRW-008` node into `program-design.md` via
> `check-ticket-graph-coverage`, and (c) that node's `**Depends on:** BRW-007` would then dangle in
> `check-dependency-graph.mjs` (`danglingDependencies`, `lib/dependency-graph.mjs:92-103`, `!graph.has(dep)`),
> cascading into more forced nodes. `BRW-hostspawn-gate-design.md` cannot match the regex (`BRW-`
> is followed by `hostspawn`, not three digits → `expandTicketIdsFromFilename` returns `[]`), so it
> is **invisible to `check-ticket-graph-coverage` AND `check-dependency-graph`** — exactly as
> `REL-FOUNDATION-GATE` is invisible (no digit triplet). **Consequence stated up front: this
> design/guard needs NO `program-design.md` node and NO graph edits of any kind.** There is no
> ticket-graph companion section in this document because none is required — see
> `§ Register interactions`.

---

## What this ticket is, in one paragraph

Commander/crew/org agent runs spawn `@playwright/mcp` (`npx --headless`) as a **host-side** stdio
MCP server on the control-plane host whenever `browser_use` is enabled. The E8 exit gate already
*promises* "no host-side browser spawn reachable from a boot root" (`README.md:7`), but that promise
is **false in fact today** (E8 is backlog) and **uncovered** by any check. The governed
`packages/browser-runtime` (BRW-002) that is supposed to displace the host spawn has **zero
importers**, so nothing has moved. This ticket adds an **anti-orphan guard** — the sibling of
`check-boot-roots-provider-free.mjs`, in the trackable-strict **owned-deferral** form of
`REL-FOUNDATION-GATE` — that:

- makes the current host spawn a **single declared exception** (owner `BRW-008`), so the guard is
  **GREEN at rest** while the spawn legitimately still exists; and
- turns **RED** the moment a *second* host spawn is added (a new undeclared spawn site **or** a
  second signature-bearing spawn injected into the already-declared `cli-mode.ts` — the
  spawn-granular arm), the moment the declared spawn is removed without retiring its deferral, on a
  malformed declaration, or on an unreadable source (fail-closed).

It does **not** close the spawn. Closing is BRW-008 proper, gated on the governed path being proven
(scope-addendum "Decision on the host-side path"). This gate is exactly the mechanism BRW-008's own
acceptance names: *"Removal is proven by an anti-orphan check that fails if a host-side browser spawn
is reachable from a boot root … a deleted line is not a proof of removal"* (scope-addendum
`§ BRW-008`, lines 77-79).

---

## §0 — Verified state at tip (`dab65f289`)

Every row was read at tip. Re-verify at execution start; the *lines* will have moved.

### 0.1 The host spawn exists and is reachable from four boot roots

| Fact | Evidence at tip |
|---|---|
| The host-browser-spawn constant | `server/src/services/internal-agent/cli-mode.ts:235` — `export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@0.0.75";` |
| The injection point (single function) | `cli-mode.ts:347-353` — inside `buildMcpConfig` (def `:330`), when `params.enabledCapabilities?.includes("browser_use")`: `reserved.playwright = { command: "npx", args: [PLAYWRIGHT_MCP_PACKAGE, "--headless"], env: {} }` (the `args` use is `:350`). |
| **Signature occurs TWICE for ONE spawn** | The signature set (`@playwright/mcp` ∪ `PLAYWRIGHT_MCP_PACKAGE`) matches **3 times** in `cli-mode.ts`: `PLAYWRIGHT_MCP_PACKAGE` on `:235` (const def), `@playwright/mcp` inside the `:235` literal, and `PLAYWRIGHT_MCP_PACKAGE` on `:350` (use). Measured: `grep -oE "@playwright/mcp|PLAYWRIGHT_MCP_PACKAGE" … \| wc -l` → **3**. This is the "2-for-1" the spawn-granular arm below is designed for: one spawn, three signature occurrences. |
| Boot root 1 — **org heartbeat** | `server/src/services/heartbeat-mcp.ts:165` calls `buildMcpConfig({ ...input.params, extraMcpServers })` |
| Boot root 2 — **crew** (`kind='aoa'`) | `server/src/services/internal-agent/aoa-agents/runner.ts:795` calls `buildMcpConfig({ ...mcpParams, extraMcpServers })` |
| Boot root 3 — **Commander (non-brokered)** | `server/src/services/internal-agent/cli-mode.ts:607` calls `buildMcpConfig(params)` in the `claude_cli` branch |
| Boot root 4 — **Commander (sandbox writer)** | `server/src/services/internal-agent/commander-sandbox.ts:444` calls `buildMcpConfig(input.mcpParams)` |
| The governed runtime does NOT displace it | `packages/browser-runtime/` exists (BRW-002) but a tree scan for `runBrowserSession` / `from "…browser-runtime"` outside the package itself returns **zero importers**. `E2bSandboxProvider` is `unwired` in every shipped boot (gate-clause `E7-1`, `scripts/gate-clause-wiring.json:69-75`). So the CLI runs on the host and Chromium spawns on the host. |
| The exit gate already promises this away | `docs/replatform/epics/E8-browser-automation/README.md:7`: the compound exit-gate sentence ends *"…Commander runs on the governed path with **no host-side browser spawn reachable from a boot root**."* E8 `Status: backlog` (`README.md:3`); no result doc asserts the clause. **The promise is false-in-fact today.** |
| The decision that grounds the *deferral* | scope-addendum "Decision on the host-side path" (`scope-addendum-agent-and-commander.md:36-42`): *"**Retire it once the governed path is proven**, not before."* Gap 2 (lines 25-30) locates the spawn at `cli-mode.ts:347-350`. |

Verification commands used at tip (deterministic; re-run at execution start):

```
grep -rn "PLAYWRIGHT_MCP_PACKAGE\|@playwright/mcp" server/src --include=*.ts | grep -v -i test
  → cli-mode.ts:235 (def, carries BOTH signatures), cli-mode.ts:350 (use)
    [tests, excluded: build-mcp-config.test.ts:2,89; commander-browser-use.test.ts:2,28]
grep -oE "@playwright/mcp|PLAYWRIGHT_MCP_PACKAGE" server/src/services/internal-agent/cli-mode.ts | wc -l
  → 3   (the exact at-rest occurrence count baked into the manifest below)
grep -rn "buildMcpConfig(" server/src --include=*.ts | grep -v -i test
  → heartbeat-mcp.ts:165 · runner.ts:795 · cli-mode.ts:607 · commander-sandbox.ts:444   (+ def cli-mode.ts:330)
grep -rniE "@playwright/mcp|PLAYWRIGHT_MCP_PACKAGE" packages/adapters --include=*.ts | grep -v -i test
  → (empty)   — NO adapter config-writer carries the signature at tip (§ enumeration, F3)
grep -rniE "@playwright/mcp|PLAYWRIGHT_MCP_PACKAGE" packages/browser-runtime
  → (empty)   — the governed runtime uses RAW playwright (createPlaywrightDriver/runBrowserSession/chromium), never the MCP package
```

### 0.2 It is uncovered — three registers structurally cannot catch it

| Register | Why it can't catch "no host spawn" |
|---|---|
| `scripts/gate-clause-wiring.json` (`check-gate-clause-wiring.mjs`) | **Positive-symbol-only by contract.** `evaluateGateClauseWiring` (`scripts/lib/gate-clause-wiring.mjs:52-118`) reads each clause's `symbol` and counts *production callers*: `wired` requires `>0`, `unwired` requires `count ≤ expectedReferences`. Its only E8 entry is the **positive** `runBrowserSession` (`E8-1-sandbox-local-browser`, `gate-clause-wiring.json:76-82`, `unwired`, `expectedReferences:1`). There is **no way to express a NEGATIVE clause** ("*absence* of a host spawn, declared-but-deferred") — a symbol that *should not* have callers but currently *does*, as an accepted exception. The register would have to call the current spawn a violation, which it must not. |
| `scripts/check-browser-suite-executed.mjs` | Proves the **positive** browser suite actually ran. Says nothing about a *host* spawn. |
| `server/src/services/internal-agent/__tests__/build-mcp-config.test.ts:87-91` (+ `server/src/__tests__/commander-browser-use.test.ts:28`) | **Asserts the spawn EXISTS** (`config.mcpServers.playwright` `.toEqual({ command:"npx", args:[PLAYWRIGHT_MCP_PACKAGE,"--headless"], env:{} })`). These **lock current behaviour**. The new guard must **coexist** with them, not contradict them — it declares the spawn as a tracked exception, it does not forbid it. (Both are `.test.ts` → excluded from the scan by construction.) |

**Conclusion:** the negative clause needs a **dedicated guard**. This ticket builds it.

---

## The model this guard mirrors

Four living templates, read fully at tip:

1. **Boot-roots trio** — `scripts/check-boot-roots-provider-free.mjs` + `scripts/lib/boot-roots-provider-free.mjs` (`evaluateBootRoots`) + `scripts/boot-roots-expectation.json` (`{$comment, roots}`). Enumerates boot roots by **scanning bin dirs for an identifier** (`content.includes(BOOTSTRAP_IDENTIFIER)`, `check-…mjs:44`; test-exclusion `:41`), asserts a **declared property per root**, and FAILS on: an **undeclared** root (`lib:22-26`), a **stale** declaration (`lib:28-33`), a resolver that does not default to none, or an **unreadable** source (**fail closed**, `check-…mjs:57-62`; `lib:38-41`). *The declaration is a human's; the machine verifies the cheap direction* (`lib:8-11`). *"A new root outside these would also need a new scan directory here — itself a reviewable, attributable change"* (`check-…mjs:22-27`). This guard is the browser-spawn **sibling** of that one.

2. **Trackable-strict owned-deferral** — `REL-FOUNDATION-GATE` in `scripts/check-distributed-execution-foundation.mjs` + `docs/architecture/distributed-execution-release-tests.json`. A Critical/High crossing's release test is **admissible iff** the named ticket is **written on disk OR declared deferred with a non-empty `reason`** (`checkCrossingReleaseTest`, `:779-802`). The deferral manifest is loaded **fail-closed** (`loadReleaseTestManifest`, `:836-858`: absent manifest → `{}` → every named-unwritten ticket reds). Deferral **hygiene** guards (`validateReleaseTestDeferrals`, `:868-892`) mirror finding-ownership named-for-named: **malformed** (no reason, `:871-880`), **stale** (the design doc now exists → *remove the deferral*, self-cleaning, `:881-884`), **unreferenced** (`:886-889`).

3. **Finding-ownership `unowned`-with-reason** — `scripts/lib/finding-ownership.mjs`. *Default-deny*: an undeclared open finding fails the first time CI runs (`lib:85-91`). A declaration is `owned|unowned|accepted` and must carry a `reason` (`lib:92-95`). *A false claim of ownership is worse than no claim* (`lib:24-25`). Our declaration is the direct analogue: each declared host spawn is an **owned deferral** (owner `BRW-008` + reason), and an undeclared spawn is default-deny.

4. **Pinned-count contract** — `scripts/lib/test-inventory.mjs` (`evaluateInventory`). A `pinned` tree's `count` is *"an exact contract in BOTH directions"* (`:13-14`): `pinned_mismatch` fires when `actual !== expected` (`:125-126`), red whether a file is added or lost. This is the direct mirror for the **spawn-granular occurrence-count arm (A6)** below — a per-file expected signature-occurrence count, red on any deviation up or down.

---

## The design — a boot-root browser-spawn guard, in trackable-strict owned-deferral form

A new **trio** + one unit suite, named to sit beside the boot-roots one:

| File | Role | Mirrors |
|---|---|---|
| `scripts/check-boot-roots-browser-spawn-free.mjs` | Driver: **owns the fs discovery** — walk the scan roots, for each in-scope non-test `.ts` count the signature occurrences, read the manifest, delegate the verdict to the pure evaluator, fail-closed on IO, exit non-zero on any violation. Exports `discoverHostSpawnSites(root, {scanRoots, signatures})` → `{foundSites:[{path,occurrences}], unreadableSources, scannedFileCount}` and `countSignatureOccurrences(text, signatures)`, and **guards `main()`** behind the entrypoint check so the unit suite can import the discovery layer. | `check-boot-roots-provider-free.mjs` (discovery in the driver); `check-test-inventory.mjs` (exported `countTestFiles` + guarded `main()`, `:60,:169`) |
| `scripts/lib/boot-roots-browser-spawn-free.mjs` | **Pure** evaluator `evaluateBrowserSpawnFree({ foundSites, expectation, unreadableSources, scannedFileCount, signatures })`. No fs. | `lib/boot-roots-provider-free.mjs` |
| `scripts/browser-spawn-expectation.json` | The **deferral manifest**: `{$comment, deferredHostSpawns: { "<path>": { owner, reason, signatureOccurrences } } }`. | `boot-roots-expectation.json` (`roots`) blended with `distributed-execution-release-tests.json` (`deferred`) and `test-inventory.json` (per-tree pinned `count`) |
| `scripts/lib/__tests__/boot-roots-browser-spawn-free.test.mjs` | **One** `node --test` suite covering BOTH the pure evaluator (arms) AND the discovery layer (imported from the driver, exercised against temp fixture dirs). One file → the `scripts` test-pin moves by exactly **+1** (F5). | `scripts/lib/__tests__/boot-roots-provider-free.test.mjs` |

> **Why one test file, not two.** The discovery layer is exported from the driver and the evaluator
> lives in the lib; a single suite imports both and tests both (evaluator with fixture inputs;
> discovery against `mkdtemp` fixture trees, the `check-test-inventory.test.mjs` idiom). Keeping it
> to one `*.test.mjs` is deliberate: it makes the `scripts` pinned test-count delta exactly `+1`
> (48 → 49), which is the same-commit bookkeeping F5 requires (below). The `check-*.mjs` driver and
> the `lib/*.mjs` evaluator are **not** test files (`isTestFile`, `scripts/lib/test-inventory.mjs:65-72`:
> a `.test.`/`.spec.` infix or a `__tests__/` segment), so they add nothing to the count.

### The enumeration decision — how the scan finds every host-spawn site, why it cannot silently miss one, AND why a second spawn in the *declared* file still reds

**Unit of enumeration = a host-spawn *site* = a non-test source file under a scan root whose text
carries the host-browser-spawn *signature*, PLUS a per-site count of how many times it carries it.**
(Boot-roots enumerates *files obtaining an identifier*; this enumerates *files carrying a spawn
signature, and how many* — the same declaration-based shape, made spawn-granular.)

**`SCAN_ROOTS = ["server/src", "packages/adapters"]`. `signatures = ["@playwright/mcp", "PLAYWRIGHT_MCP_PACKAGE"]`.**
A site is any `*.ts` file under a scan root, excluding `*.test.ts` / `*.d.ts` / `__tests__/`, whose
content (read from disk) contains **any** signature substring; its `occurrences` is the total count
of non-overlapping signature matches (`countSignatureOccurrences`).

> **★ Execution correction (see `BRW-hostspawn-gate-result.md`).** The `SCAN_ROOTS` above and the F3
> "covers every host config-writer surface" claim below were **under-scoped**: they missed
> `packages/adapter-utils`, the shared `McpServerSpec` / `mergeExternalMcpServers` library that
> `cli-mode.ts` itself imports — a sibling of `packages/adapters` a two-root scan never enters, so a
> host `@playwright/mcp` spec relocated there would escape (an adversarial-skeptic finding on the
> implementation). The shipped guard widens the scope to `SCAN_ROOTS = ["server/src", "packages"]` with
> `packages/browser-runtime` excluded via `EXCLUDED_SUBTREES`, closing the whole sibling-package class;
> and it also excludes `*.spec.ts` (the repo's `isTestFile` convention). Green at rest in both scopes —
> nothing under `packages/` carries the signature today. T13 pins the `adapter-utils` inclusion.

**Why FILE-path enumeration alone is insufficient — the F2 defect this arm fixes.** A manifest keyed
only on file path, with a set-difference evaluator, is GREEN the moment a **second** host spawn is
injected into the **already-declared** `cli-mode.ts` (a second
`reserved.<x> = { command:"npx", args:[<pkg>,"--headless"] }`): the file is already a declared key,
so no *new* path appears, so nothing reds. That directly contradicts the promise "turns RED the
moment a second host spawn is added." **The fix is the occurrence-count arm (A6):** the manifest
declares, per site, the exact number of signature occurrences expected (`signatureOccurrences`), and
the evaluator reds on **any** deviation — up (a second spawn adds ≥1 occurrence) or down (the spawn
is removed but the const/declaration is kept).

**The exact at-rest value, and the green-at-rest proof.** `cli-mode.ts` carries **3** signature
occurrences at tip (`§0.1`: two on `:235` — the identifier and the `@playwright/mcp` literal — and
one on `:350`). The manifest declares `signatureOccurrences: 3` for `cli-mode.ts`. So at rest:
`foundSites = [{ path: "server/src/services/internal-agent/cli-mode.ts", occurrences: 3 }]`, the
manifest declares exactly that key with `owner:"BRW-008"`, a non-empty reason, and
`signatureOccurrences: 3`, `unreadableSources = []`, `scannedFileCount > 0` → **zero violations**.

Why the occurrence-count is the robust choice (and why the alternatives were rejected):

- **It is format-agnostic pure-substring counting**, the same tool class as boot-roots
  (`content.includes(...)`). It needs no JS structural parse, so it is not brittle to line breaks,
  quote style, or a multi-line `args` array.
- **It catches BOTH forms of a second spawn.** A new host spawn a future commit adds must name the
  package to spawn it — by importing the const (`PLAYWRIGHT_MCP_PACKAGE`, +1 occurrence) or by
  writing a fresh literal (`@playwright/mcp…`, +1 occurrence, version suffix irrelevant since it is a
  substring). Either → `occurrences` rises above 3 → **RED** (A6). A structural-idiom regex keyed on
  `PLAYWRIGHT_MCP_PACKAGE` would MISS the fresh-literal form; a raw *path* set-op misses both. The
  occurrence-count catches all of them.
- **It self-cleans on removal.** When BRW-008 removes the spawn, the occurrence count drops below 3.
  If the whole signature is gone (both `:235` and `:350` removed), the file leaves `foundSites` and
  the **stale arm (A4)** fires (declared but not found). If only the injection `:350` is removed but
  the const `:235` kept, `occurrences` falls to 1 and the **count arm (A6)** fires. Either way the
  landing commit is forced to retire the deferral in the same change — the trackable-strict
  self-cleaning property.
- **The residual is a documented, boot-roots-shaped calibration.** A *benign* new textual mention of
  the signature in `cli-mode.ts` (e.g. a comment) also moves the count and reds the guard until the
  pin is bumped. That is intended, not a bug: it is precisely the boot-roots philosophy — *the
  declaration is a human's; the machine verifies the cheap direction* — and any new occurrence of
  `@playwright/mcp`/`PLAYWRIGHT_MCP_PACKAGE` in a boot-reachable file is exactly what deserves a
  reviewer's glance. Bumping `signatureOccurrences` is a one-line, attributable diff, the same cost
  as bumping a `test-inventory` pin.

Why the scan cannot silently miss a new host spawn, and why the scope is what it is:

- **It is a literal substring scan, not an import-graph walk.** Import-graph inference "has been
  wrong here before" — the audit note repeated across `gate-clause-wiring`, `finding-ownership`
  (`lib:16-22`), and `execution-census`. A substring scan over read bytes is the same tool boot-roots
  uses.
- **The scope covers every host config-writer surface (F3), not just `server/src`.** The
  control-plane host writes stdio-MCP `command`/`args` from more than one place. Besides
  `buildMcpConfig` in `server/src`, the codex and opencode adapters materialize host MCP config
  **onto the host filesystem**: `renderMcpBlock` (`packages/adapters/codex-local/src/server/codex-config-toml.ts:127`)
  via `writeCodexMcpConfigToml` (`:639`, invoked from `execute.ts:378`, which *"wrote config.toml
  into the HOST"* per the `:396` comment), and `toOpenCodeEntry`
  (`packages/adapters/opencode-local/src/server/opencode-config-json.ts:127`, stdio `command`/`args`
  at `:153`). A future host `@playwright/mcp` block hardcoded in one of those config-writers would
  **escape a `server/src`-only scan**. So `SCAN_ROOTS` includes `packages/adapters`. **Verified at
  tip: no file under `packages/adapters` (indeed none under `packages/`) carries the signature**
  (`§0.1` command output is empty), so widening the scope stays **green at rest** — it adds future
  coverage without adding a current site.
- **The governed `packages/browser-runtime` is excluded by construction — twice over.** BRW-002's
  runtime legitimately uses **raw** Playwright (`createPlaywrightDriver`, `runBrowserSession`,
  chromium) and **must not be flagged**. First, it lives at `packages/browser-runtime`, which is
  **not** under either scan root (`server/src`, `packages/adapters`), so it is structurally invisible.
  Second, even if it were scanned it carries **no** `@playwright/mcp`/`PLAYWRIGHT_MCP_PACKAGE`
  substring (`§0.1`), because raw Playwright is a different specifier from the MCP package. T11 pins
  the exclusion.
- **The signature deliberately EXCLUDES the bare words `playwright` / `chromium`.** They appear in
  governed config and in connector reserved-name *validation* — none of which is a host spawn.
  Matching them would false-positive, "which is how a guard earns its own deletion." Precision over
  recall on this axis is a measured choice, and its residual is named in the non-goals.
- **The scan directory list and the signature set are the review surface.** Exactly as boot-roots
  documents for its `BIN_DIRS`, `SCAN_ROOTS` and `signatures` are small, named constants: extending
  the mechanism (a new spawn package, a new source tree) is a one-line, attributable diff, not a
  silent gap. To prove the `packages/adapters` widening is *live* rather than vacuous (this
  programme's signature failure class — *a check that scans nothing is not a check*), **T12** asserts
  a signature-bearing fixture under `packages/adapters/…` **is** discovered.

**Boot roots vs. injection sites — why guarding sites is necessary *and* sufficient.** The
`server/src` injection lives in a **single function**, `buildMcpConfig` (`cli-mode.ts:330-353`); the
four boot roots (`§0.1`) are merely its callers. A boot root **cannot** spawn a browser except
*through* a signature-carrying injection. Therefore guarding the injection **sites** (across the
config-writer scope) covers "no host spawn reachable from a boot root" for the mechanism the
signature describes — a new boot root that calls the *existing* declared `buildMcpConfig` adds no new
spawn and no new occurrence, and a new *spawn* (the thing the gate forbids) necessarily adds a
signature occurrence to some in-scope file. The guard does not attempt to re-enumerate the four
callers (that is the gate-clause register's job); it pins the thing that actually spawns.

### The deferral manifest shape

`scripts/browser-spawn-expectation.json`:

```json
{
  "$comment": [
    "BRW-hostspawn-gate — host-side browser-spawn sites and their owned deferral.",
    "A site is a non-test file under a SCAN_ROOT (server/src, packages/adapters) whose text carries",
    "a host-browser-spawn signature (@playwright/mcp or PLAYWRIGHT_MCP_PACKAGE). A site the scan",
    "finds that is not declared here FAILS (default-deny, the important direction). Each declared",
    "site is an OWNED DEFERRAL: the host spawn is retired only once the governed browser-runtime",
    "path is proven (scope-addendum 'Decision on the host-side path'), owned by BRW-008.",
    "signatureOccurrences is an EXACT pin (both directions): the total signature-substring matches",
    "expected in the file today. A SECOND spawn injected into a declared file raises the count and",
    "REDS; removing the spawn lowers it (or empties the file, tripping the stale arm) and REDS.",
    "A declared site that no longer carries a signature is STALE and MUST be removed in the same",
    "commit that removes the spawn (self-cleaning)."
  ],
  "deferredHostSpawns": {
    "server/src/services/internal-agent/cli-mode.ts": {
      "owner": "BRW-008",
      "signatureOccurrences": 3,
      "reason": "buildMcpConfig injects the reserved `playwright` stdio MCP server (npx @playwright/mcp --headless) on the control-plane host when browser_use is enabled; reachable from the org-heartbeat, crew, and Commander boot roots. The 3 occurrences are PLAYWRIGHT_MCP_PACKAGE at :235 (def) + the @playwright/mcp literal at :235 + PLAYWRIGHT_MCP_PACKAGE at :350 (use) — ONE spawn. Retire once BRW-007's governed tool surface + a proven sandboxed session let BRW-008 route Commander onto the governed path — not before (scope-addendum lines 36-42). Declared so the guard is GREEN at rest while the spawn legitimately still exists and is behaviour-locked by build-mcp-config.test.ts:87-91."
    }
  }
}
```

### The evaluator and its arms (the hygiene guards)

`evaluateBrowserSpawnFree({ foundSites, expectation, unreadableSources, scannedFileCount, signatures })
→ string[] violations` (empty = property holds). `foundSites` is now `Array<{path, occurrences}>`.
Each arm names the guard it mirrors:

| # | Arm | Fires when | Mirrors |
|---|---|---|---|
| A0 | **manifest fail-closed** | `expectation` is null / not an object / has no object `deferredHostSpawns`. Driver passes a null/empty sentinel when the file is absent/unreadable → every found site then reds via A3. | `loadReleaseTestManifest` fail-closed (`check-distributed-execution-foundation.mjs:836-858`) |
| A1 | **vacuous scan** | `scannedFileCount === 0` — the discovery layer found nothing to scan (a broken glob / moved tree). A guard that evaluated nothing must never read green. | `execution-census` `vacuous` (`lib:70-73`); boot-roots `BIN_DIRS` existence (`check-…:33-39`) |
| A2 | **unreadable source (fail closed)** | `unreadableSources` non-empty — an in-scope `.ts` file could not be read during the scan. One violation each. | boot-roots resolver-unreadable (`lib:38-41`); `readOrError` (`…foundation.mjs`) |
| A3 | **undeclared host spawn** (the important direction) | a `foundSites[].path` is not a key of `deferredHostSpawns`. Default-deny: a *new* spawn (in a new file) announces itself the first CI run after it lands. | boot-roots `undeclared boot root` (`lib:22-26`); finding-ownership `undeclared_finding` (`lib:85-91`) |
| A4 | **stale declaration** | a declared path is **not** among `foundSites[].path` (its signature is entirely gone — the spawn was removed but the deferral remains). Forces the eventual closer (BRW-008) to *retire the deferral in the same commit* — self-cleaning. | boot-roots `stale declaration` (`lib:28-33`); release-tests `stale` (`…foundation.mjs:881-884`); finding-ownership `stale_declaration` (`lib:132-136`) |
| A5 | **malformed declaration** | a declared entry is not an object, or `owner` is missing / not a ticket-id shape (`/^[A-Z]{2,5}-\d+$/`), or `reason` is missing / blank, or **`signatureOccurrences` is missing / not a positive integer**. | finding-ownership `malformed_declaration` (`lib:92-99`); gate-clause `malformed_declaration`; release-tests deferral malformed (`…foundation.mjs:871-880`) |
| **A6** | **spawn-count mismatch** (the spawn-granular arm — F2) | a declared path **present** in `foundSites` whose actual `occurrences` **!==** its declared `signatureOccurrences`. A second spawn injected into a declared file raises the count → RED; removing the injection while keeping the const lowers it → RED. Exact pin, both directions. | `test-inventory` `pinned_mismatch` — *"an exact contract in BOTH directions"* (`lib/test-inventory.mjs:13-14,125-126`) |

**Deliberate divergence from finding-ownership, documented (calibration).** Finding-ownership *also*
checks that an `owned` finding names a ticket whose **file exists on disk** (`lib:102-105`). This guard
does **not** require the owner's design doc to exist, because **`BRW-008` is unbuilt backlog** — there
is no `BRW-008-design.md` at tip (and, per the rename, this file is `BRW-hostspawn-gate-design.md`,
which does not expand to any `BRW-\d{3}` id). A "ticket file exists" check would fail-closed against a
legitimately-planned owner. So A5 verifies only the *shape* of `owner` (a ticket-id token) + a
non-empty `reason` + a positive-integer `signatureOccurrences` — the owner is a human-written
accountability tag, not a filesystem assertion. This is the same class of calibration
finding-ownership itself makes with `ownerStillOpen` (`lib:111-118`): tighten only to what can be
honestly enforced.

**Green at rest** (the real tree at tip): `foundSites = [{ path: "server/src/services/internal-agent/cli-mode.ts", occurrences: 3 }]`,
`deferredHostSpawns` declares exactly that key with `owner:"BRW-008"`, a non-empty reason, and
`signatureOccurrences: 3`; `unreadableSources = []`, `scannedFileCount > 0` → **zero violations**.
This is an acceptance clause (C2) and must be proven by running the checker against the real tree.

---

## Fail-first TDD (RED for the written reason — POSITIVE CONTROL FIRST)

Suite: `scripts/lib/__tests__/boot-roots-browser-spawn-free.test.mjs` (`node --test`, dependency-free,
mirrors `boot-roots-provider-free.test.mjs`). The evaluator is pure; its inputs are fixtures. The
**discovery layer** (imported from the driver, `main()` guarded) is exercised against temp fixture
dirs (`mkdtemp`), the `check-test-inventory.test.mjs` idiom.

**Order — positive control first (the programme's standing lesson: never trust a green you did not
first watch turn red for the written reason):**

1. **T0 — positive control.** Feed the evaluator one **undeclared** `foundSite` and an empty
   `deferredHostSpawns`; assert the returned violations array is **non-empty** and names the site
   (A3). Written and watched RED **before the evaluator exists** (import throws / function undefined).
   This proves the harness runs and the assertion is real, before any green is trusted.
2. **T1 — green at rest.** `foundSites:[{path:cli-mode.ts, occurrences:3}]`, declared with
   owner+reason+`signatureOccurrences:3`, no unreadable, `scannedFileCount:1` → **zero** violations.
   (Watched: RED before A3's declared-branch is written, GREEN after.)
3. **T2 — undeclared (A3).** Two found sites, one declared → exactly one violation for the undeclared.
4. **T3 — stale (A4).** Declared path absent from `foundSites` → stale violation.
5. **T4 — malformed: missing owner (A5).** Declared entry `{reason:"x", signatureOccurrences:3}` → violation.
6. **T5 — malformed: missing/blank reason (A5).** `{owner:"BRW-008", signatureOccurrences:3}` and `{owner:"BRW-008", reason:" ", signatureOccurrences:3}` → violation.
7. **T6 — malformed: owner not a ticket shape (A5).** `{owner:"someone", reason:"x", signatureOccurrences:3}` → violation.
8. **T7 — unreadable source (A2).** `unreadableSources:["server/src/…/x.ts"]` → fail-closed violation.
9. **T8 — manifest fail-closed (A0).** `expectation:null` (driver's absent-manifest sentinel) with a
   found site → violation (structural) **and** the found site reds (A3 over the empty set).
10. **T9 — vacuous scan (A1).** `scannedFileCount:0` → violation, even if `foundSites` is empty and
    the manifest is empty (a broken discovery layer must not read green).
11. **T-occ — malformed: bad `signatureOccurrences` (A5).** Declared entry
    `{owner:"BRW-008", reason:"x"}` (missing count), and `{…, signatureOccurrences:0}` and
    `{…, signatureOccurrences:"3"}` → violation each. The count field is mandatory and must be a
    positive integer.
12. **T-count — spawn-count mismatch (A6, the F2 arm).** Declared `signatureOccurrences:3`. Feed
    `foundSites:[{path:cli-mode.ts, occurrences:4}]` (a second spawn injected) → **violation**;
    feed `occurrences:1` (spawn removed, const kept) → **violation**; feed `occurrences:3` →
    **no** violation. This is the arm that makes "a second spawn in the *declared* file reds" true.
13. **T10 — signature completeness (discovery).** Against a fixture tree: a file whose only marker is
    the **identifier** `PLAYWRIGHT_MCP_PACKAGE` (no literal) is discovered as a site; and a file whose
    only marker is the **literal** `@playwright/mcp@9.9.9` (a bumped version) is discovered. Proves
    both signature forms are live and a version bump does not blind the scan; also asserts the file's
    `occurrences` is counted correctly.
14. **T11 — scope EXCLUSION (discovery).** Against a fixture tree: a file carrying the signature under
    `packages/browser-runtime/…` and a `*.test.ts` (and a `__tests__/` file) under a scan root are
    **not** discovered (SCAN_ROOTS band + test-exclusion), so the governed runtime and the
    behaviour-lock tests never trip the guard.
15. **T12 — scope INCLUSION (discovery, anti-vacuity for F3).** Against a fixture tree: a file
    carrying the signature under `packages/adapters/…` **is** discovered. Proves the
    `packages/adapters` widening actually scans (guards against a silently-narrowed `SCAN_ROOTS`
    that would let a future host spawn in a codex/opencode config-writer escape).

### Mutation table — delete each guard arm, name the killing test

| Mutation (delete/neuter the arm) | Killing test | Kind |
|---|---|---|
| M-A0: driver treats an absent/unreadable manifest as a satisfiable object, silently | T8 | vacuous-green |
| M-A1: remove the `scannedFileCount === 0` check | T9 | vacuous-green |
| M-A2: swallow `unreadableSources` (skip unreadable files silently) | T7 | fail-open |
| M-A3: remove the undeclared-site loop | **T0 (positive control)** + T2 | the core arm |
| M-A4: remove the stale-declaration loop | T3 | rot |
| M-A5a: drop the `owner`-shape check | T4, T6 | malformed-admitted |
| M-A5b: drop the `reason` non-empty check | T5 | malformed-admitted |
| M-A5c: drop the `signatureOccurrences` positive-integer check | T-occ | malformed-admitted |
| **M-A6: remove the occurrence-count comparison** | **T-count** | second-spawn-in-declared-file escapes |
| M-SIG: drop the `PLAYWRIGHT_MCP_PACKAGE` signature (keep only the literal) | T10 | identifier-only spawn escapes |
| M-SCOPE-WIDE: widen SCAN_ROOTS past `packages/adapters` to bare `packages` (or add `packages/browser-runtime`) | T11 | governed path false-positive |
| M-SCOPE-NARROW: drop `packages/adapters` from SCAN_ROOTS (back to `server/src` only) | T12 | adapter config-writer surface unscanned |

Every arm has a test that turns RED when the arm is deleted → no vacuous arm.

---

## Acceptance table — every clause → a test that turns RED

| # | Clause | Test that turns RED if unmet |
|---|---|---|
| C1 | The current host spawn IS enumerated (scan finds `cli-mode.ts` via the signature, count 3). | Driver acceptance run against the real tree lists `cli-mode.ts` as a found site with `occurrences:3`; T10 proves both signature forms + counting. |
| C2 | GREEN at rest — the single declared spawn (occurrences 3, declared 3) yields zero violations. | T1 + a driver acceptance run against the real tree exiting 0. |
| C3 | A NEW undeclared host spawn (new file) REDS. | T0 (positive control), T2. |
| C4 | A SECOND spawn injection in the ALREADY-DECLARED `cli-mode.ts` REDS (occurrence-count deviation up). | **T-count** (F2). A real-tree run after adding a second `reserved.<x>` injection would raise `occurrences` above 3 and fail A6. |
| C5 | A STALE declaration (spawn removed, deferral kept) REDS — whether the signature is fully gone (A4) or only the injection is removed (A6, count falls below 3). | T3 (A4) + T-count `occurrences:1` case (A6). |
| C6 | A MALFORMED declaration (no owner / bad owner / no reason / no valid `signatureOccurrences`) REDS. | T4, T5, T6, T-occ. |
| C7 | An UNREADABLE source REDS (fail closed). | T7. |
| C8 | An ABSENT/UNREADABLE manifest REDS (fail closed). | T8. |
| C9 | A VACUOUS scan (zero files) REDS. | T9. |
| C10 | The signature catches an identifier-only new spawn and survives a version bump. | T10. |
| C11 | The codex/opencode adapter config-writer surface IS scanned (a host `@playwright/mcp` block hardcoded there would RED). | T12 (F3). |
| C12 | The governed `packages/browser-runtime` and the behaviour-lock tests are NOT flagged. | T11. |
| C13 | The guard COEXISTS with `build-mcp-config.test.ts:87-91` — it declares the spawn, it does not forbid it. | No change to that test; C2 green while that test stays green. Regression: the guard suite + the behaviour-lock suite both pass in the same `policy` run. |

---

## CI wiring — COUNT THE CALLERS (the guard must actually run)

A guard in no job is this programme's signature vacuity. **The guard runs in the always-on `policy`
job** of `.github/workflows/pr.yml` (job at `:124`; it already carries every sibling: boot-roots at
the "Dispatch-composition declaration guards (WRK-008 slice 2b)" step, `:326`/`:334-335`;
gate-clause-wiring `:278`/`:285-286`; finding-ownership `:288`/`:297-298`; guard-inventory
`:300`/`:302-303`; test-inventory `:311`/`:313-315`; execution-census `:317`/`:323-324`;
ticket-graph `:265`/`:266-267`). Add **one new step**, self-test + checker in the **same** `run`
block (the sibling steps' own idiom — two steps are two chances to run only the one that passed):

```yaml
      - name: Browser-spawn boot-root guard (BRW-hostspawn-gate)
        run: |
          # No host-side browser spawn may be reachable from a boot root except the single
          # declared, BRW-008-owned deferral (the current cli-mode.ts @playwright/mcp spawn,
          # signatureOccurrences 3). A new undeclared spawn, a SECOND spawn injected into the
          # declared file (count deviation), a stale deferral, a malformed entry, or an
          # unreadable source fails this step. Self-test + checker in ONE step.
          node --test scripts/lib/__tests__/boot-roots-browser-spawn-free.test.mjs
          node scripts/check-boot-roots-browser-spawn-free.mjs
```

`policy` is required transitively via the `ci-required` aggregator (`pr.yml` `needs:` list includes
`policy`), and it is **not** in the docs-only skip set (it runs on every non-draft PR). It needs no
browser, no DB, no network — it is a pure fs scan. **GREEN at rest** by construction (the one spawn
is declared with its exact count).

### Same-commit register bookkeeping (THREE entries — or the `policy` job reds on the guard itself)

All three are mandatory and land **in the guard's own commit** — omitting any one turns `policy` red:

1. **New `scripts/check-boot-roots-browser-spawn-free.mjs` → `scripts/guard-inventory.json` entry.**
   `check-guard-inventory.mjs` enumerates every `scripts/check-*.mjs` (`findGuardScripts`, `:35`) and
   fails `undeclared_script` (`:95`) on a new one. Add, mirroring the boot-roots entry
   (`guard-inventory.json:7-9`):
   ```json
   "scripts/check-boot-roots-browser-spawn-free.mjs": { "status": "ci", "reason": "invoked by a workflow" }
   ```
   `status:"ci"` requires the basename to appear in a workflow (`not_in_workflows`,
   `check-guard-inventory.mjs:99`) — satisfied by the `pr.yml` step above.

2. **New `scripts/lib/__tests__/boot-roots-browser-spawn-free.test.mjs` → `scripts/test-execution-census.json` entry.**
   `check-execution-census.mjs` finds every `*.test.mjs` under `scripts/` and fails `undeclared`
   (`execution-census.mjs:77`) on a new one. Add, mirroring the boot-roots test entry
   (`test-execution-census.json:182-186`):
   ```json
   "scripts/lib/__tests__/boot-roots-browser-spawn-free.test.mjs": {
     "status": "runs", "workflow": "pr.yml", "step": "Browser-spawn boot-root guard (BRW-hostspawn-gate)"
   }
   ```
   The evaluator additionally checks the named step's `run:` block **names the file path** (comments
   stripped, `execution-census.mjs:110-111`) — satisfied because the `node --test …` line above names
   it verbatim. The `step` string must match the `- name:` exactly.

3. **New `scripts/lib/__tests__/boot-roots-browser-spawn-free.test.mjs` → bump `scripts/test-inventory.json` `scripts.count` 48 → 49 (F5).**
   `check-test-inventory.mjs` counts test files per tree and pins `scripts` at an exact `count`
   (`mode:"pinned"`). The new `.test.mjs` is a test file (`isTestFile`: `.test.` infix **and** a
   `__tests__/` segment, `scripts/lib/test-inventory.mjs:65-72`) and maps to the `scripts` tree
   (`treeForPath`, `:79-84`), so the tree's actual count becomes 49 while the pin says 48 →
   `pinned_mismatch` ("test file(s) added — bump the pin", `check-test-inventory.mjs:109-112`,
   `evaluateInventory:125-126`). The delta is **exactly +1**: the `check-*.mjs` driver and the
   `lib/*.mjs` evaluator are not test files (no `.test.`/`.spec.` infix, not under `__tests__/`), and
   the `.json` manifest is not a code file. Set `scripts.count` to 49 in the same commit (do NOT
   `--write`-launder any unrelated decrease; this is a single deliberate +1).

---

## Register interactions — verify no surprise reds

| Register | Effect of this ticket | Verdict |
|---|---|---|
| `check-guard-inventory.mjs` | New `check-*.mjs` → needs the `guard-inventory.json` entry above (same commit). | GREEN once wired. |
| `check-execution-census.mjs` | New `*.test.mjs` → needs the `test-execution-census.json` entry above (same commit), and the step must name the file. | GREEN once wired. |
| `check-test-inventory.mjs` | New `*.test.mjs` under `scripts/` → the `scripts` pinned count must move 48 → 49 (F5, same commit). | GREEN once the pin is bumped. |
| `check-gate-clause-wiring.mjs` | **No new entry.** The register is positive-symbol-only (`§0.2`) and cannot host a negative "no host spawn" clause; the dedicated guard **is** the coverage. The existing `E8-1` (`runBrowserSession`, `unwired`, `expectedReferences:1`) is untouched — this ticket adds no caller to `runBrowserSession`. Its scanner scans `SOURCE_ROOTS = ["server/src","packages","cli"]` (`check-gate-clause-wiring.mjs:22`), which **excludes `scripts/`**, so the signature strings in the new scanner/manifest/test are **not** counted. | GREEN, unchanged. |
| `check-ticket-graph-coverage.mjs` | **INERT — no interaction (the F1 rename).** The driver scans every `epics/<epic>/tickets/*.md` basename (`check-ticket-graph-coverage.mjs:25-33`), so this file IS read, but `expandTicketIdsFromFilename("BRW-hostspawn-gate-design.md")` returns `[]` (the regex `^([A-Z]{2,5})-(\d{3})` needs three digits after `BRW-`; it gets `hostspawn`). So this file contributes **no** file-id → forces **no** `#### …` node → `BRW-008` is not marked file-backed by it. Same inertness as `REL-FOUNDATION-GATE`. | GREEN, no companion edit. |
| `check-dependency-graph.mjs` | **INERT — no interaction.** It reasons only over `#### <ID>` nodes parsed from `program-design.md` (`lib/dependency-graph.mjs:31,40-70`); the inert slug forces no node, so there is no `BRW-008` node and therefore no `BRW-008 → BRW-007` dangling edge (`danglingDependencies:92-103`). **No `program-design.md` edit is made or required.** | GREEN, no companion edit. |
| `check-guard-inventory` / `execution-census` **self-tests** | The new step also runs the new `node --test`; both register self-tests are unaffected. | GREEN. |

> **Why there is no "resolving the ticket-graph red" section here (contrast with v1).** An earlier
> draft named this ticket `BRW-008-GATE`, which *does* expand to the id `BRW-008`, forcing a
> `#### BRW-008` node and a cascade of dependency-graph reds — and it proposed editing
> `program-design.md` to absorb them. The v2 rename to the graph-inert slug `BRW-hostspawn-gate`
> removes the interaction entirely: **no node, no edge, no `program-design.md` change.** The removal
> owner is still `BRW-008` (kept in the header and the manifest `owner`), filed here under an honest
> name that does not falsely claim `BRW-008` is file-backed.

---

## Non-goals (with owners), risks, rollback

### Non-goals

- **Closing the host spawn.** Explicitly out of scope. **Owner: BRW-008 proper**, gated on BRW-007's
  governed tool surface + a proven sandboxed session (scope-addendum lines 36-42, 67-82). This gate
  exists precisely so removal can be *proven* later; removing the spawn now, before the governed path
  works, is the "retire before proven" move the decision rejected.
- **Building the governed path** (BRW-002 runtime wiring, BRW-004 approvals/secrets, BRW-006 evidence,
  BRW-007 agent request tool). Owners: the respective BRW tickets.
- **BRW-008's own Test clauses, itemized and left with BRW-008 (so none is silently dropped):**
  BRW-008's `**Test:**` line names four (`scope-addendum:80-82`). **(1)** *"Config-shape tests
  proving no host spawn under any capability combination"* — handled when the behaviour-lock tests
  (`build-mcp-config.test.ts:87-91`, `commander-browser-use.test.ts:28`) flip from *asserting the
  spawn* to *asserting its removal*, under BRW-008, not here. **(2)** *"an end-to-end Commander
  browser journey through the governed path"* — owned by BRW-008 (needs BRW-002..007). **(3)** *"a
  disabled-capability denial covering both paths"* — **explicitly owned-and-deferred to BRW-008
  proper** (F6): with `browser_use` disabled a Company must reach no browser by *either* the host or
  the governed path; that is a runtime-behaviour test BRW-008 writes when both paths exist, and is
  **not** what this static-scan guard asserts. **(4)** *"the boundary check that no host-side spawn
  has a caller"* — **this guard is that mechanism** (in its spawn-granular, boot-root-reachable form).
- **Modifying the behaviour-lock tests** (`build-mcp-config.test.ts:87-91`, `commander-browser-use.test.ts:28`).
  The guard coexists with them; they flip to *asserting removal* under BRW-008, not here.
- **Rewriting `README.md:7` (F4).** The exit-gate sentence is left **UNCHANGED**. It is a legitimate
  not-yet-met E8 exit condition (E8 is backlog), and it is a *compound* clause covering sandbox-local
  browser, evidence, approvals, network/secret policy, cancellation, cleanup, and D3 reconnect — far
  more than this guard verifies. Rewriting it to "enforced by the guard" would overclaim twice over:
  the guard is GREEN while the spawn is still live-and-declared, and its guarantee is narrowed to the
  `@playwright/mcp` signature. If a note is ever wanted, the honest one to **append** (not substitute)
  is: *"the boot-root browser-spawn guard fails CI on any **new, undeclared** `@playwright/mcp` host
  spawn; the existing `cli-mode.ts` spawn **remains a declared, BRW-008-owned deferral until** BRW-008
  removes it; the guarantee is **scoped to the `@playwright/mcp` signature**, not every possible host
  browser spawn."* Even that is optional and out of scope for this ticket.
- **Detecting a host browser spawn via a non-`@playwright/mcp` mechanism** (a raw `puppeteer`/`chromium`
  launch, or a different MCP browser package). Out of the current signature. **Owner: BRW-008** — the
  ticket that will actually route Commander is the natural owner of "is the signature list still
  complete?"; extending `signatures` is a one-line, reviewed diff.

### Risks

- **Signature incompleteness** (the non-goal above). *Mitigation:* `signatures` is a small named
  constant; the residual is documented here and in the manifest `$comment`; a bare-word broadening was
  rejected to avoid false positives on governed config / reserved-name validation (`§ enumeration`).
- **False positive on the governed runtime.** *Mitigation:* `SCAN_ROOTS = ["server/src", "packages/adapters"]`
  excludes `packages/browser-runtime` structurally, and browser-runtime carries no MCP signature
  anyway; T11 pins it.
- **Count-arm noise on a benign signature mention** in a declared file. *Mitigation:* accepted, and
  documented as the boot-roots-shaped calibration — a new occurrence of the signature in a
  boot-reachable file is worth a reviewer's glance, and bumping `signatureOccurrences` is a one-line
  diff (`§ enumeration`).
- **Package version drift** (`@playwright/mcp@0.0.75` → newer). *Mitigation:* the signature is the
  substring `@playwright/mcp`, version-suffix-agnostic; T10 pins it. (A version bump edits the
  literal in place, so the *occurrence count* stays 3 and A6 does not false-fire.)

### Rollback

Purely additive and touches **no runtime code and no `program-design.md`**. Rollback = delete the trio
+ the test, remove the `pr.yml` step, and revert the three register entries (`guard-inventory.json`,
`test-execution-census.json`, and the `test-inventory.json` `scripts` pin 49 → 48). CI returns
byte-for-byte to prior behaviour. There is no data migration, no wire-protocol change, and
`packages/worker-protocol` (FROZEN) is untouched.

---

## Appendix — file/line anchors read at `dab65f289` (re-verify at execution start)

- Host spawn: `server/src/services/internal-agent/cli-mode.ts:235` (const, carries BOTH signatures), `:347-353` (`buildMcpConfig` injection), `:350` (`args` use), `:330` (fn def). At-rest signature-occurrence count in this file: **3**.
- Boot roots: `heartbeat-mcp.ts:165` · `aoa-agents/runner.ts:795` · `cli-mode.ts:607` · `commander-sandbox.ts:444`.
- Host config-writer surface (F3 widened scope): `packages/adapters/codex-local/src/server/codex-config-toml.ts:127` (`renderMcpBlock`), `:639` (`writeCodexMcpConfigToml`), `execute.ts:378` + `:396` ("wrote config.toml into the HOST"); `packages/adapters/opencode-local/src/server/opencode-config-json.ts:127` (`toOpenCodeEntry`), `:153` (stdio `command`/`args`). None carries the signature at tip.
- Governed runtime (excluded): `packages/browser-runtime/src/index.ts:44` (`createPlaywrightDriver`), raw Playwright throughout; no `@playwright/mcp` signature.
- Behaviour locks: `internal-agent/__tests__/build-mcp-config.test.ts:87-91` (`:89` args) · `server/src/__tests__/commander-browser-use.test.ts:28`.
- Exit gate: `docs/replatform/epics/E8-browser-automation/README.md:7` (compound sentence — left UNCHANGED, F4), `:3` (Status backlog). Decision: `scope-addendum-agent-and-commander.md:25-30` (Gap 2), `:36-42` (Decision), `:67-82` (BRW-008), `:77-79` (anti-orphan requirement), `:80-82` (BRW-008 Test clauses 1-4).
- Templates: `scripts/check-boot-roots-provider-free.mjs` (`:22-27`, `:41`, `:44`, `:57-62`) + `scripts/lib/boot-roots-provider-free.mjs` (`:8-11`, `:22-26`, `:28-33`, `:38-41`) + `scripts/boot-roots-expectation.json`; `scripts/check-distributed-execution-foundation.mjs:779-802,836-858,868-892` + `docs/architecture/distributed-execution-release-tests.json`; `scripts/lib/finding-ownership.mjs:24-25,85-99,102-105,111-118,132-136`; `scripts/lib/test-inventory.mjs:13-14,65-72,79-84,125-126` + `scripts/check-test-inventory.mjs:60,109-112,169`.
- Registers: `scripts/lib/gate-clause-wiring.mjs:52-118` + `scripts/gate-clause-wiring.json:69-75,76-82` + `check-gate-clause-wiring.mjs:22` (SOURCE_ROOTS excludes `scripts/`); `scripts/check-guard-inventory.mjs:35,95,99` + `scripts/guard-inventory.json:7-9`; `scripts/check-execution-census.mjs` + `scripts/lib/execution-census.mjs:70-73,77,110-111` + `scripts/test-execution-census.json:182-186`; `scripts/lib/ticket-graph-coverage.mjs:41-48,65-72` + `check-ticket-graph-coverage.mjs:25-33` (INERT for this slug); `scripts/lib/dependency-graph.mjs:31,40-70,92-103` + `check-dependency-graph.mjs` (INERT — no node forced); `scripts/test-inventory.json` (`scripts` tree, `count:48` → 49).
- CI: `.github/workflows/pr.yml` `policy` job `:124` — sibling steps: boot-roots `:326`/`:334-335`, ticket-graph `:265-267`, gate-clause `:278`/`:285-286`, finding-ownership `:288`/`:297-298`, guard-inventory `:300`/`:302-303`, test-inventory `:311`/`:313-315`, execution-census `:317`/`:323-324`, distributed-execution-foundation `:160-161`.
