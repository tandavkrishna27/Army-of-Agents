# BRW-hostspawn-gate — result

**Epic:** E8 (Browser Automation) · **Sprint:** 7 unit 1 · **Type:** GATE (guard-only)
**Design (Start SHA):** `eed9fdd35` (`BRW-hostspawn-gate-design.md`)
**Outcome:** SHIPPED — an anti-orphan guard makes the E8 "no host-side browser spawn reachable from
a boot root" clause **catchable and regression-proof**, in trackable-strict owned-deferral form,
**green at rest** while the spawn legitimately still exists. It does **not** close the spawn (BRW-008
proper owns that, gated on the governed browser-runtime path).

---

## What landed

Purely additive — **no runtime code, no `program-design.md`, no migration, no `AOA_*`**, and
`packages/worker-protocol` (FROZEN) untouched.

| File | Role |
|---|---|
| `scripts/check-boot-roots-browser-spawn-free.mjs` | Driver: `discoverHostSpawnSites` + `countSignatureOccurrences`, guarded `main()`, `SCAN_ROOTS`, `SIGNATURES`. |
| `scripts/lib/boot-roots-browser-spawn-free.mjs` | Pure evaluator `evaluateBrowserSpawnFree`, arms A0–A6. |
| `scripts/browser-spawn-expectation.json` | Deferral manifest: declares `cli-mode.ts`, owner `BRW-008`, `signatureOccurrences: 3`. |
| `scripts/lib/__tests__/boot-roots-browser-spawn-free.test.mjs` | `node --test` suite (17 tests). |
| `.github/workflows/pr.yml` | One new `policy`-job step "Browser-spawn boot-root guard (BRW-hostspawn-gate)". |
| `scripts/guard-inventory.json` · `scripts/test-execution-census.json` · `scripts/test-inventory.json` | The three same-commit register entries. |

**The guard, in one line:** it walks the control-plane source (`server/src`) and the full package
library surface (`packages/`, minus the governed `browser-runtime`) for non-test `.ts` files carrying
the host-browser-spawn signature (`@playwright/mcp` / `PLAYWRIGHT_MCP_PACKAGE`), and reds unless every
signature-bearing file is declared in the manifest with its **exact** occurrence count (owned by
BRW-008). A new undeclared spawn, a **second** signature occurrence in the declared file, a
removed-but-still-declared spawn, a malformed declaration, an unreadable source, an absent manifest,
or a vacuous scan all fail closed.

---

## Mutation line

**12 mutants deleted by DELETION, 12 killed, 0 survivors, 0 equivalents** (positive control FIRST;
each anchor verified matched before mutating — the CRLF/indent false-verdict guard):

`M-A0→T8 · M-A1→T9 · M-A2→T7 · M-A3→T0+T2 · M-A4→T3 · M-A5a→T4+T6 · M-A5b→T5 · M-A5c→T-occ ·
M-A6→T-count · M-SIG→T10 · M-SCOPE-WIDE (un-exclude browser-runtime)→T11 · M-SCOPE-NARROW (drop the
packages root)→T12+T13.`

T0 (the positive control — an undeclared found site over an empty manifest must red, A3) was written
and **watched RED before the evaluator existed** (`ERR_MODULE_NOT_FOUND`), so no green was trusted
before the harness was proven.

---

## The count arm, at rest and under attack

`cli-mode.ts` carries **exactly 3** signature occurrences at rest (`PLAYWRIGHT_MCP_PACKAGE` at the
const def + the `@playwright/mcp` literal in that same def + `PLAYWRIGHT_MCP_PACKAGE` at the injection
use — **one spawn, three occurrences**). The manifest pins `signatureOccurrences: 3`; the driver
scans 1535 in-scope files and finds `cli-mode.ts` as the single declared site with `occurrences: 3` →
**zero violations, exit 0** (C2, green at rest for the right reason — the two behaviour-lock hits in
`__tests__` are excluded twice over).

**Live C4 proof (spawn-granular, the v2 fix):** injecting a second signature occurrence into
`cli-mode.ts` raised the count to 4 → `A6 spawn-count mismatch` red, exit 1; the file was restored to
exact bytes (clean diff). This is the exact defect a v1 file-keyed set-op would have missed (the file
was already a declared key). **Live C8 proof:** removing the manifest reds fail-closed (A0 + A3), exit 1.

---

## The two closed evasions (and how)

1. **A second spawn injected into the already-declared `cli-mode.ts`** — CLOSED by the occurrence-count
   arm (A6). Any new textual occurrence (a fresh `@playwright/mcp` literal at any version, or a new
   `PLAYWRIGHT_MCP_PACKAGE` reference) raises the count above 3 → red. Proven live (above) and by T-count.

2. **A spawn relocated into a sibling package the first scan missed** — CLOSED by widening the scope.
   This was a **real gap the adversarial skeptic found** (see below): `cli-mode.ts` already imports the
   shared `McpServerSpec` / `mergeExternalMcpServers` constructor from `packages/adapter-utils`, a
   **sibling of `packages/adapters`** that a `server/src` + `packages/adapters`-only scan never entered.
   A host `@playwright/mcp` spec relocated there would have kept the guard green while all four boot
   roots still spawned on the host. Fixed by scanning the **whole `packages/` surface** (minus the
   governed `browser-runtime`), which closes the entire sibling-package class in one move and is green
   at rest (nothing under `packages/` carries the signature today). T13 pins `packages/adapter-utils`
   inclusion; T12 pins `packages/adapters`; T11 pins the `browser-runtime` exclusion.

---

## Residual — named, not hidden (never "enforced")

The guarantee is **scoped to the `@playwright/mcp` signature and to occurrence-count changes**. It is
**not** a claim that no host browser spawn of any kind can ever be added. Honest residuals:

- **Non-`@playwright/mcp` mechanisms** (raw `chromium.launch()` / `puppeteer`, or a different MCP
  browser package) carry none of the signatures and are uncaught. **Documented non-goal, owner BRW-008**
  (extending `signatures` is a one-line reviewed diff). The bare words `playwright`/`chromium` are
  deliberately excluded to avoid false positives on governed config and reserved-name validation.
- **Textual-proxy limit of the count arm (skeptic V1-loop).** The occurrence count is a *textual*
  proxy for *spawn* count. A `for`-loop inside the declared injection block that registers N servers
  from a **single** textual `PLAYWRIGHT_MCP_PACKAGE` reference keeps the count at 3 and stays green.
  Bounded: it requires editing the single BRW-008-owned injection block (the most-reviewed region),
  reuses the same already-deferred package, admits no new package/file, and dies when BRW-008 removes
  the injection. So "a second signature **occurrence** reds" is the precise claim, not "a second spawn
  of any construction reds."
- **Calibration rests on human review (skeptic V4/V5).** A2/A5 verify *shape*: `reason` must be
  non-empty but is **not** checked for consistency with a bumped count, and `owner` is shape-checked
  (`/^[A-Z]{2,5}-\d+$/`) but **not** existence-checked (deliberate — BRW-008 is unbuilt backlog, so a
  "ticket file exists" check would fail closed against a legitimately-planned owner). So a launderer
  who adds a real second spawn *and* bumps `signatureOccurrences` in the same diff, or declares a new
  spawn under a well-formed-but-bogus owner, stays green — but only via a **visible, attributable
  manifest diff** that default-deny forces into review. Bounded by review, not machine-verified.
- **`EXCLUDED_DIRS` matches build-output basenames anywhere** (`dist`/`build`/`out`/`coverage`/
  `node_modules`/`__tests__`) — the intended boot-roots-shaped recall/precision tradeoff (skip
  generated/vendored trees); no source lives under those names today.

---

## Adversarial review (on the IMPLEMENTATION, 3 independent read-only subagents)

- **Correctness reviewer:** 0 confirmed bugs; green-at-rest holds for the right reason; all 7 arms
  fire per design; discovery exclusions/counting/guarded-main sound. Two non-blocking observations —
  (1) `.spec.ts` was not excluded (an asymmetry with the repo's `isTestFile`), **acted on**: `.spec.ts`
  is now excluded (matches the convention, zero coverage loss — a spec is a test, never boot-reachable),
  materially relevant once the scan widened to all of `packages/` (there is a `plugins` example
  `*.spec.ts`); (2) `EXCLUDED_DIRS` basename matching — kept as the documented tradeoff above.
- **Evasion skeptic:** found **one real gap** — V3-adapter-utils (the sibling-package class), **fixed**
  by the scope widening above. V2 (new file under a scanned tree) genuinely closed by A3; V1-loop,
  V4-launder, V5-bogus-owner, V6-non-signature all confirmed as bounded/documented/owned residuals
  (above). No live signature hides outside the scan roots today — every gap was a *future*-injection path.
- **Completeness critic:** all six bookkeeping items PASS, zero inconsistencies; every mutation-table
  arm backed by a killing test asserting the exact emitted string; graph-inertness confirmed.

The design doc's `§enumeration` F3 claim ("`SCAN_ROOTS` covers every host config-writer surface") was
**under-scoped** — it named only `buildMcpConfig` + the codex/opencode writers and missed the shared
`packages/adapter-utils` MCP-spec library. The implementation widened the scope to correct it; the
design doc carries a forward-pointer note to this result.

---

## Register bookkeeping (all green at rest; graph-inert by design)

- `guard-inventory.json`: +1 (`check-boot-roots-browser-spawn-free.mjs`, `status:"ci"`) → 40 scripts, OK.
- `test-execution-census.json`: +1 (`…test.mjs`, `runs`, step names the file) → 53 on disk / 49 running, OK.
- `test-inventory.json`: `scripts` pin 48 → **49** (delta exactly +1 — only the new `.test.mjs` counts), OK.
- `check-gate-clause-wiring`: **no new entry** — the register is positive-symbol-only and cannot host a
  negative "no host spawn" clause; the dedicated guard **is** the coverage. `E8-1` (`runBrowserSession`,
  `unwired`) untouched.
- `check-ticket-graph-coverage` / `check-dependency-graph`: **INERT** — `BRW-hostspawn-gate-design.md`
  does not expand to any `BRW-\d{3}` id (`expandTicketIdsFromFilename(...) === []`), so no node is
  forced and no `BRW-008 → BRW-007` edge dangles. No `program-design.md` change made or required.

**`README.md:7` left UNCHANGED (F4).** It is a legitimate not-yet-met E8 exit condition (E8 backlog)
and a compound clause far wider than this guard. Rewriting it to "enforced" would re-create the
false-green the guard exists to remove; the guarantee is scoped to the `@playwright/mcp` signature and
the spawn is still a live, declared, BRW-008-owned deferral.

**Coexistence:** the guard declares the spawn as a tracked exception; it does **not** forbid it, so it
coexists with `build-mcp-config.test.ts` (which asserts the spawn EXISTS). Both pass in the same
`policy` run.

---

## CI

`code=true` PR (touches `scripts/*.mjs` + `finding-ownership`-adjacent register JSON + `pr.yml`) →
`ci-required` rides the **full heavy suite**. The guard itself is a pure fs scan needing no browser,
DB, or network, and touches no runtime code; it is **green at rest by construction** and runs in the
always-on `policy` job (transitively required via `ci-required`).
