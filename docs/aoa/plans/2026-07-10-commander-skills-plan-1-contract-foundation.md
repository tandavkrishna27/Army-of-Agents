# WS-0: Contract & Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Eliminate the `create_memory` phantom on every surface, make the Commander/MCP tool contract a GENERATED projection of the live registry so it can never invert again, and make the product's live Commander skill catalog (`AOA_NATIVE_SKILLS`) a GENERATED projection of the canonical AoA-Skills repo so the seeder can never drift from the source skills.
**Architecture:** The product emits one machine-readable `tools.json` from `createToolRegistry()` + MCP `TOOL_DEFINITIONS`; that manifest becomes the single source the Commander `TOOLS.md` cheat-sheet is rendered from, the drift CI gate checks, and the AoA-Skills `validate.ts` allowlist imports. In parallel, the product generates its runtime skill catalog (`AOA_NATIVE_SKILLS`, today 4 hand-written entries) from the canonical AoA-Skills `skills/*.md` — one generated source that supersedes both Plan-2's eval snapshot and Plan-3's hand-edited seeder entries. Instruction persona files stay hand-authored in the product's `onboarding-assets/commander/*` and are synced (product → skills) at publish; the phantom fix lands by hand first, then the generators supersede `TOOLS.md` and the seeder.
**Tech Stack:** Node/Bun, TypeScript; product = AoA (this worktree); skills = AoA-Skills repo. Product scripts run via `tsx` (precedent: `scripts/migrate-inline-env-secrets.ts`, `fetch-bundled-catalog.ts`). Skills-repo scripts run via `bun` (precedent: `validate.ts`).
**Repos touched:** [product] AoA-2.5 (this worktree, `C:\Users\TK\.aoa\wt\commander-skills-overhaul`) · [skills-repo] AoA-Skills (`github.com/MeteoriteLabs/AoA-Skills`; read-only reference clone at `…/scratchpad/aoa-skills`)

---

## Key facts verified against code (2026-07-10)

- `AgentTool` (`server/src/services/internal-agent/types.ts:86-95`) carries `{ name, description, parameters, category, requiredRole?, requiresConfirmation, execute }`. `ToolCategory` = `discussion|query|action|memory|workflow|file|coordination|analysis` (`types.ts:30-38`).
- `createToolRegistry()` (`server/src/services/internal-agent/tool-registry.ts:90-179`) returns the full Commander registry array. This is the code source of truth. (Scope reports 75 tools; the plan derives the count at runtime — no magic number.)
- MCP `TOOL_DEFINITIONS` is a flat array of `{ name, description, inputSchema }` and **is exported** (`server/src/mcp/tools/index.ts:66-582`) — this is the authoritative list the manifest builds from. Family membership for the derived category is available via the **exported** handler maps `readToolHandlers | writeToolHandlers | documentToolHandlers | approvalToolHandlers | skillToolHandlers` (`index.ts:10-16`). Note `askFounderToolHandlers` is imported into `index.ts` and folded into the internal `toolHandlers` map but is **NOT** re-exported (verified `index.ts:7,10-16,25`) — so the manifest builder must not import it; the single `ask_founder` tool is categorized by name instead. MCP defs carry NO `category`/`requiredRole` — those are derived (family) or left `null` (reserved, per scope §5 WS-0).
- The real memory tool is `suggest_memory` (`server/src/services/internal-agent/tools/memory-tools.ts:263`, `requiredRole: "team_lead"`, `requiresConfirmation: true`). `create_memory` exists on NO surface. MCP equivalent is `memory.write` / `suggest-memory` (`index.ts:170,220`).
- Persona canonical source: `assembleAgentPersona` (`commander-context.ts:17-30`) concatenates `AGENTS.md → SOUL.md → TOOLS.md → HEARTBEAT.md`; the files are seeded from `loadDefaultAgentInstructionsBundle(role)` which reads `server/src/onboarding-assets/commander/*` (`seed-commander-bundle.ts:106`). So `onboarding-assets/commander/*` IS the product canonical (scope §7.5).
- `@armyofagents/shared` `exports` map to `./src/*.ts` (source) → `tsx`/`vitest` can import the registry graph without a prior build.
- Phantom/count anchors (exact, verified):
  - Product `onboarding-assets/commander/AGENTS.md:53` (confirm-gate list), `:81` (memory-governance bullet).
  - Product `onboarding-assets/commander/SOUL.md:27` (memory-draft prose), `:42` ("The 35 tools … complete set").
  - Product `onboarding-assets/commander/TOOLS.md:3` ("You have **35 tools**"), `:45` (table row `create_memory`), `:111` ("The 35 tools above are your complete set"), `:114` (memory-governance rule).
  - Product `onboarding-assets/memory_keeper/SOUL.md:8` (prose "never call `create_memory` or `update_memory`").
  - Product `server/src/services/internal-agent/aoa-agents/ensure-command-staff.ts:191-192` (prose "never call create_memory or update_memory directly").
  - Skills-repo phantom refs (15 `create_memory` across 9 files; grep is the gate, not the count): `commander/AGENTS.md:53,81`, `commander/SOUL.md:27`, `commander/TOOLS.md:42,111`, `model-overlays/claude.md:11`, `model-overlays/codex.md:9`, `model-overlays/gemini.md:11,19`, `model-overlays/opencode.md:11`, `skills/identity-setup.md:10,69,81`, `skills/office-hours.md:10,70`. The 3 overlays (`codex.md:9`, `gemini.md:11`, `opencode.md:11`) state the INVERSION as a rule ("`suggest_memory` does not exist — use `create_memory`").
- CI gate: branch protection requires only `ci-required`, which requires `verify` (runs `pnpm test:run` + `pnpm build`) when `changes.outputs.code == 'true'` (`.github/workflows/pr.yml:359-390,831-875`). Nested `*.md` (runtime assets) count as code (`pr.yml:64-70`), so onboarding-asset + generated-doc edits trigger the full gate.

---

## Cross-repo delivery decision (the one wrinkle — read before Task 6/10)

The product repo is private; the AoA-Skills repo is public. A public CI job cannot fetch a private repo's raw file without a token, so **automated cross-repo freshness is not feasible**. Delivery model (locked for WS-0):

1. **Product is the single writer of `tools.json`.** Committed at `packages/shared/src/generated/tools.json`. A product vitest test guarantees it matches the live registry (drift gate #1). Because `buildToolManifest()` maps over the **live** `createToolRegistry()` + `TOOL_DEFINITIONS` at generation time, any tool newly registered in the registry — e.g. Plan-3's ported Approval-family + `get_heartbeat_context` commander-surface tools — appears in `tools.json` automatically the next time `pnpm gen:tools` runs (no hand-editing), and the skills-repo `validate.ts` allowlist picks the new names up via the vendored manifest on the next `pnpm sync:skills`. This is why Plan 3 registers its ports and then reruns `pnpm gen:tools` + `pnpm sync:skills` rather than hand-adding rows here. `mcpAlias` stays `null` for every entry in R1 (reserved; scope §5 WS-0).
2. **Vendoring, not sharing.** `scripts/sync-commander-to-skills.ts` (product) copies, into a caller-supplied skills-repo path: the hand-authored persona files (`AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`), the generated `TOOLS.md`, and `tools.json` → `generated/tools.json`. The sync is the ONLY thing that writes those files in the skills repo (publish-time step, like the existing `scripts/sync-to-marketplace.sh` which takes a path arg).
3. **Skills-repo CI verifies INTERNAL consistency only:** (a) `validate.ts` (allowlist from vendored `tools.json`) finds no phantom names in ANY `.md`; (b) `gen-tools-md.ts --check` re-renders `commander/TOOLS.md` (commander flavor) AND `commander/TOOLS.mcp.md` (mcp flavor) from the vendored `tools.json` and `git diff --exit-code`s them — catching both a stale generated doc AND a stale/hand-edited synced `TOOLS.md`.
4. **Accepted gap (surface to reviewer):** if a publisher forgets to run the sync, the skills repo can be internally consistent yet lag the product registry. Closing that needs a published shared package or a token-gated cross-repo fetch — **explicitly deferred** (R2). The render rules are duplicated across the repo boundary (product `renderCommanderToolsMd` vs skills `gen-tools-md.ts`) for the same reason; kept tiny and documented.

---

## File Structure

### [product] AoA-2.5

| Path | Create/Modify | Responsibility |
|---|---|---|
| `server/src/onboarding-assets/commander/AGENTS.md` | Modify | Phantom fix: `create_memory`→`suggest_memory` (L53, L81). Hand-authored persona; stays canonical. |
| `server/src/onboarding-assets/commander/SOUL.md` | Modify | Phantom fix (L27) + count-claim fix (L42). Hand-authored; canonical. |
| `server/src/onboarding-assets/commander/TOOLS.md` | Modify → then **Generated** | Interim hand-fix (L3,45,111,114); Task 4 makes it a generated artifact rendered from `tools.json`. |
| `server/src/onboarding-assets/memory_keeper/SOUL.md` | Modify | Name-accuracy: `create_memory`→`suggest_memory` in negative-reference prose (L8). |
| `server/src/services/internal-agent/aoa-agents/ensure-command-staff.ts` | Modify | Name-accuracy in Memory-Keeper role prose (L191-192). |
| `server/src/services/internal-agent/tool-manifest.ts` | Create | `buildToolManifest()` (pure, testable) + `serializeToolManifest()` + `renderCommanderToolsMd()`. Sole product-side generator logic. |
| `scripts/generate-tools-manifest.ts` | Create | Writes `packages/shared/src/generated/tools.json`; `--check` fails on drift vs committed. |
| `scripts/generate-tools-md.ts` | Create | Renders `onboarding-assets/commander/TOOLS.md` from `tools.json`; `--check` fails on drift. |
| `scripts/sync-commander-to-skills.ts` | Create | Vendors persona + `TOOLS.md` + `tools.json` into a supplied skills-repo path. |
| `packages/shared/src/generated/tools.json` | Create | Committed machine-readable manifest (the contract). |
| `server/src/__tests__/tool-manifest.test.ts` | Create | Contract test (manifest ↔ registry) + drift test (committed `tools.json`/`TOOLS.md` == freshly rendered) — the guaranteed CI drift gate via `pnpm test:run`. |
| `scripts/generate-aoa-skills-seeder.ts` | Create | Reads a supplied AoA-Skills repo's `skills/*.md` frontmatter+body, applies the `skill:aoa-curated/aoa-<name>` → `skill:aoa/<name>` key mapping, and writes the committed catalog; `--check` fails on drift vs committed (Task 7). |
| `server/src/services/internal-agent/generated/aoa-native-skills.json` | Create | Committed generated Commander skill catalog. The single source `aoa-skills-seeder.ts` imports (replaces the 4 hand-written entries). |
| `server/src/services/internal-agent/aoa-skills-seeder.ts` | Modify | Import `AOA_NATIVE_SKILLS` from the generated `aoa-native-skills.json` instead of hardcoding 4 entries. |
| `server/src/__tests__/aoa-skills-seeder.test.ts` | Modify | Drop the hardcoded "exactly 4" assertion; assert the generated catalog's invariants (count matches JSON, all keys `skill:aoa/<name>`, no `create_memory`, required fields). |
| `server/src/__tests__/aoa-skills-seeder-drift.test.ts` | Create | Freshness test: committed catalog's internal invariants hold (shape, key namespace, phantom-free). Byte-for-byte regen vs the live skills repo is a `--check` step run when the repo is present (cross-repo, like the sync). |
| `package.json` (root) | Modify | Add `gen:tools`, `gen:tools:check`, `gen:tools:md`, `gen:tools:md:check`, `sync:skills`, `gen:skills`, `gen:skills:check` scripts. |
| `.github/workflows/pr.yml` | Modify | Add explicit `gen:tools:check` + `gen:tools:md:check` step to the `verify` job (defense-in-depth over the vitest drift test). |

### [skills-repo] AoA-Skills

| Path | Create/Modify | Responsibility |
|---|---|---|
| `validate.ts` | Modify | Load `VALID_TOOLS` from vendored `generated/tools.json` (surface==commander); DELETE inverted `suggest_memory→create_memory` ban; ADD `create_memory→suggest_memory` ban. |
| `generated/tools.json` | Create | Vendored manifest (written by product sync). Consumed by `validate.ts` + `gen-tools-md.ts`. |
| `scripts/gen-tools-md.ts` | Create | Renders `commander/TOOLS.mcp.md` (MCP flavor); `--check` re-renders both flavors and diffs committed files (fail-closed on unknown placeholders / missing `tools.json`). |
| `commander/TOOLS.mcp.md` | Create | Generated MCP-flavor cheat-sheet for the open-source/MCP distribution. |
| `commander/TOOLS.md` | Modify | Synced from product (generated commander flavor). |
| `commander/AGENTS.md`, `commander/SOUL.md` | Modify | Synced from product (phantom-fixed). |
| `model-overlays/claude.md`, `codex.md`, `gemini.md`, `opencode.md` | Modify | Phantom fix + de-hardcode the "34 tools" count. |
| `skills/identity-setup.md`, `skills/office-hours.md` | Modify | Phantom fix `create_memory`→`suggest_memory`. |
| `.github/workflows/validate.yml` | Modify | Add `bun scripts/gen-tools-md.ts --check` + `git diff --exit-code` freshness gate. |
| `package.json` | Modify | Add `gen:tools-md` + `gen:tools-md:check` scripts. |

---

## Task 1 — [product][VERIFICATION] Hand-fix phantom refs + stale counts in product canonical files

Lands the LIVE bug fix immediately, independent of the generator. Persona files (`AGENTS.md`, `SOUL.md`) stay hand-authored; `TOOLS.md` is hand-fixed now and superseded by the generator in Task 4.

**Files:**
- Modify `server/src/onboarding-assets/commander/AGENTS.md` (L53, L81)
- Modify `server/src/onboarding-assets/commander/SOUL.md` (L27, L42)
- Modify `server/src/onboarding-assets/commander/TOOLS.md` (L3, L45, L111, L114)
- Modify `server/src/onboarding-assets/memory_keeper/SOUL.md` (L8)
- Modify `server/src/services/internal-agent/aoa-agents/ensure-command-staff.ts` (L191-192)

Steps:

- [ ] In `AGENTS.md` L53, replace the confirm-gate write-tool list token `create_memory` with `suggest_memory`. New line reads:
  `Before calling a write tool (\`create_task\`, \`create_agent\`, \`update_task\`, \`suggest_memory\`, \`update_company_identity\`, \`create_department\`, \`create_goal\`, \`create_workflow_template\`, \`instantiate_workflow\`, \`assign_task\`, \`wakeup_agent\`, \`add_task_dependency\`):`
- [ ] In `AGENTS.md` L81, replace `\`create_memory\` creates a **PENDING** item` with `\`suggest_memory\` creates a **PENDING** item`.
- [ ] In `SOUL.md` L27, replace leading `\`create_memory\` creates a draft.` with `\`suggest_memory\` creates a draft.`
- [ ] In `SOUL.md` L42, replace `The 35 tools in TOOLS.md are your complete set.` with `The tools in TOOLS.md are your complete set — that file is generated from the live tool registry, so trust it over any count stated elsewhere.` (removes the drift-prone hard number; Task 4's generated `TOOLS.md` owns the count).
- [ ] In `TOOLS.md` L3, replace `You have **35 tools** across 9 categories. Only call tools in this list. No other tool names exist.` with `The tools below are your complete set — this file is generated from the live tool registry (\`packages/shared/src/generated/tools.json\`). Only call tools in this list; no other tool names exist.`
- [ ] In `TOOLS.md` L45, replace the memory table row `| \`create_memory\` | Create a PENDING memory item (not saved until founder approves) |` with `| \`suggest_memory\` | Propose a PENDING memory item (not saved until founder approves) |`.
- [ ] In `TOOLS.md` L111, replace `The 35 tools above are your complete set.` with `The tools above are your complete set.`
- [ ] In `TOOLS.md` L114, replace `\`create_memory\` → PENDING.` with `\`suggest_memory\` → PENDING.`
- [ ] In `memory_keeper/SOUL.md` L8, replace `You never call \`create_memory\` or \`update_memory\`.` with `You never call \`suggest_memory\` to self-approve — proposals are \`pending\` only, and you never call \`update_memory\`.` (Preserves the governance meaning while naming the real tool.)
- [ ] In `ensure-command-staff.ts` L191-192, replace the prose `"create_memory or update_memory directly. Decisions #15/#16/#52.",` with `"suggest_memory (to self-approve) or update_memory directly. Decisions #15/#16/#52.",`. Do NOT change the surrounding tool list (`extract_memory_candidates`, `find_similar_memory_hnsw`, etc. are real registry names).
- [ ] **VERIFY** no phantom remains in product:
  ```bash
  cd "C:/Users/TK/.aoa/wt/commander-skills-overhaul"
  git grep -n "create_memory" -- server/src/onboarding-assets server/src/services/internal-agent
  ```
  Expected output: empty (exit 1 from grep = no matches). If any line prints, fix it.
- [ ] **VERIFY** typecheck still passes for the edited TS file:
  ```bash
  pnpm --filter @armyofagents/server typecheck
  ```
  Expected: exits 0 (`ensure-command-staff.ts` change is a string literal only).
- [ ] Commit: `git add -A && git commit -m "fix(commander): replace create_memory phantom with suggest_memory in product canonical files"`

---

## Task 2 — [product][TDD] `buildToolManifest()` + contract test

Pure, testable manifest builder. Write the failing contract test first.

**Files:**
- Create `server/src/services/internal-agent/tool-manifest.ts`
- Create `server/src/__tests__/tool-manifest.test.ts`

Steps:

- [ ] **RED.** Create `server/src/__tests__/tool-manifest.test.ts` with the contract assertions (no drift assertions yet — those come in Tasks 3-4):
  ```ts
  import { describe, it, expect } from "vitest";
  import { createToolRegistry } from "../services/internal-agent/tool-registry.js";
  import { buildToolManifest } from "../services/internal-agent/tool-manifest.js";

  describe("tool manifest — contract vs live registry", () => {
    const manifest = buildToolManifest();
    const commander = manifest.filter((t) => t.surface === "commander");
    const mcp = manifest.filter((t) => t.surface === "mcp");

    it("has one commander entry per registry tool (count + names)", () => {
      const registry = createToolRegistry();
      expect(commander.length).toBe(registry.length);
      expect(commander.map((t) => t.name).sort()).toEqual(
        registry.map((t) => t.name).sort(),
      );
    });

    it("never emits the create_memory phantom and always emits suggest_memory", () => {
      const names = new Set(manifest.map((t) => t.name));
      expect(names.has("create_memory")).toBe(false);
      expect(names.has("suggest_memory")).toBe(true);
    });

    it("emits at least one mcp entry and marks memory.write as a write tool", () => {
      expect(mcp.length).toBeGreaterThan(0);
      const memWrite = mcp.find((t) => t.name === "memory.write");
      expect(memWrite?.readWrite).toBe("write");
    });

    it("every entry has the agreed shape", () => {
      for (const t of manifest) {
        expect(t).toMatchObject({
          name: expect.any(String),
          surface: expect.stringMatching(/^(commander|mcp)$/),
          category: expect.any(String),
          readWrite: expect.stringMatching(/^(read|write)$/),
          description: expect.any(String),
        });
        expect(["founder", "team_lead", "team_member", null]).toContain(t.requiredRole);
        expect(typeof t.mcpAlias === "string" || t.mcpAlias === null).toBe(true);
      }
    });
  });
  ```
- [ ] Run it — expect failure (module missing):
  ```bash
  pnpm --filter @armyofagents/server exec vitest run src/__tests__/tool-manifest.test.ts
  ```
  Expected: `Cannot find module '../services/internal-agent/tool-manifest.js'`.
- [ ] **GREEN.** Create `server/src/services/internal-agent/tool-manifest.ts`:
  ```ts
  import { createToolRegistry } from "./tool-registry.js";
  import type { AgentTool, ToolCategory } from "./types.js";
  // Build MCP-surface entries from the EXPORTED TOOL_DEFINITIONS (the authoritative
  // schema list). Category is derived from the EXPORTED family handler maps.
  // NOTE: askFounderToolHandlers is NOT re-exported from mcp/tools/index.ts — do not
  // import it (it won't compile). The single ask_founder tool is categorized by name.
  import {
    TOOL_DEFINITIONS,
    readToolHandlers,
    writeToolHandlers,
    documentToolHandlers,
    approvalToolHandlers,
    skillToolHandlers,
  } from "../../mcp/tools/index.js";

  export type ToolSurface = "commander" | "mcp";
  export type ReadWrite = "read" | "write";

  export interface ToolManifestEntry {
    name: string;
    surface: ToolSurface;
    category: string;
    readWrite: ReadWrite;
    requiredRole: "founder" | "team_lead" | "team_member" | null;
    description: string;
    /** Reserved for cross-surface mapping (scope §5 WS-0). Always null in R1. */
    mcpAlias: string | null;
  }

  // Commander write-signal rule (deterministic from registry fields):
  //   write iff category ∈ {action, workflow, discussion} OR requiresConfirmation.
  //   else read. Advisory metadata for the cheat-sheet — real gating lives in
  //   authorize-tool.ts, so an approximate-but-deterministic rule is acceptable.
  const COMMANDER_WRITE_CATEGORIES: ReadonlySet<ToolCategory> = new Set([
    "action",
    "workflow",
    "discussion",
  ]);

  function commanderReadWrite(tool: AgentTool): ReadWrite {
    if (COMMANDER_WRITE_CATEGORIES.has(tool.category)) return "write";
    return tool.requiresConfirmation ? "write" : "read";
  }

  function mcpCategory(name: string): string {
    if (name in readToolHandlers) return "read";
    if (name in writeToolHandlers) return "write";
    if (name in documentToolHandlers) return "document";
    if (name in approvalToolHandlers) return "approval";
    if (name in skillToolHandlers) return "skill";
    if (name === "ask_founder") return "ask"; // askFounderToolHandlers is not exported
    return "other";
  }

  // MCP write-signal heuristic (advisory; scope §5 WS-0 marks MCP fields
  // "reserved"). read iff family=read OR name is a getter/list; else write.
  function mcpReadWrite(name: string, category: string): ReadWrite {
    if (category === "read") return "read";
    if (/^(list-|get-)/.test(name) || name === "me") return "read";
    return "write";
  }

  export function buildToolManifest(): ToolManifestEntry[] {
    const commander: ToolManifestEntry[] = createToolRegistry().map((tool) => ({
      name: tool.name,
      surface: "commander",
      category: tool.category,
      readWrite: commanderReadWrite(tool),
      requiredRole: tool.requiredRole ?? null,
      description: tool.description,
      mcpAlias: null,
    }));

    const mcp: ToolManifestEntry[] = TOOL_DEFINITIONS.map((def) => {
      const category = mcpCategory(def.name);
      return {
        name: def.name,
        surface: "mcp",
        category,
        readWrite: mcpReadWrite(def.name, category),
        requiredRole: null,
        description: def.description,
        mcpAlias: null,
      };
    });

    // Stable ordering so serialization is deterministic (drift gate depends on it).
    return [...commander, ...mcp].sort((a, b) =>
      a.surface === b.surface
        ? a.name.localeCompare(b.name)
        : a.surface.localeCompare(b.surface),
    );
  }

  export function serializeToolManifest(entries: ToolManifestEntry[]): string {
    return (
      JSON.stringify(
        {
          $generated:
            "DO NOT EDIT — run `pnpm gen:tools`. Source: createToolRegistry() + mcp TOOL_DEFINITIONS.",
          version: 1,
          tools: entries,
        },
        null,
        2,
      ) + "\n"
    );
  }
  ```
- [ ] Re-run the test — expect all 4 cases green:
  ```bash
  pnpm --filter @armyofagents/server exec vitest run src/__tests__/tool-manifest.test.ts
  ```
  Expected: `4 passed`.
- [ ] Commit: `git add -A && git commit -m "feat(commander): buildToolManifest() derived from live registry + MCP defs"`

---

## Task 3 — [product][TDD] Emitter script + committed `tools.json` + drift test

**Files:**
- Create `scripts/generate-tools-manifest.ts`
- Create `packages/shared/src/generated/tools.json` (generated output)
- Modify `server/src/__tests__/tool-manifest.test.ts` (add drift assertion)
- Modify `package.json` (root) — add `gen:tools`, `gen:tools:check`

Steps:

- [ ] Create `scripts/generate-tools-manifest.ts`:
  ```ts
  #!/usr/bin/env tsx
  import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
  import { dirname, resolve } from "node:path";
  import { fileURLToPath } from "node:url";
  import {
    buildToolManifest,
    serializeToolManifest,
  } from "../server/src/services/internal-agent/tool-manifest.js";

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const OUT = resolve(repoRoot, "packages/shared/src/generated/tools.json");

  const next = serializeToolManifest(buildToolManifest());
  const check = process.argv.includes("--check");

  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== next) {
      console.error(
        "ERROR: packages/shared/src/generated/tools.json is stale. Run `pnpm gen:tools` and commit.",
      );
      process.exit(1);
    }
    console.log("tools.json is fresh.");
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, next, "utf8");
    console.log(`Wrote ${OUT}`);
  }
  ```
  Note: `tsx` erases the type-only `import type` graph and resolves `@armyofagents/shared` from `./src/*.ts` (verified). The `.js` extension in the import specifier is correct for NodeNext ESM even though the file is `.ts`.
- [ ] Add root `package.json` scripts (in the `"scripts"` object, after `"check:tokens"`):
  ```json
  "gen:tools": "tsx scripts/generate-tools-manifest.ts",
  "gen:tools:check": "tsx scripts/generate-tools-manifest.ts --check",
  ```
- [ ] Generate the committed artifact:
  ```bash
  cd "C:/Users/TK/.aoa/wt/commander-skills-overhaul" && pnpm gen:tools
  ```
  Expected: `Wrote …/packages/shared/src/generated/tools.json`. Inspect it: `tools` array present, contains `{"name":"suggest_memory","surface":"commander",…}`, no `"create_memory"`.
- [ ] Confirm the `--check` gate is a no-op immediately after generating:
  ```bash
  pnpm gen:tools:check
  ```
  Expected: `tools.json is fresh.` (exit 0).
- [ ] **RED→GREEN drift test.** Append to `server/src/__tests__/tool-manifest.test.ts`:
  ```ts
  import { readFileSync } from "node:fs";
  import { resolve } from "node:path";
  import { serializeToolManifest } from "../services/internal-agent/tool-manifest.js";

  describe("tool manifest — committed artifact is fresh", () => {
    it("packages/shared/src/generated/tools.json equals the freshly-built manifest", () => {
      const committed = readFileSync(
        resolve(__dirname, "../../../../packages/shared/src/generated/tools.json"),
        "utf8",
      );
      expect(committed).toBe(serializeToolManifest(buildToolManifest()));
    });
  });
  ```
  Verify the relative path resolves from `server/src/__tests__/` to repo root `packages/…`; adjust the `../` depth if the run reports ENOENT (print `resolve(__dirname, …)` once to confirm). This test is the GUARANTEED CI drift gate (runs inside `verify`'s `pnpm test:run`).
- [ ] Run the full file — expect green:
  ```bash
  pnpm --filter @armyofagents/server exec vitest run src/__tests__/tool-manifest.test.ts
  ```
  Expected: `5 passed`.
- [ ] Commit: `git add -A && git commit -m "feat(commander): emit committed tools.json manifest + drift test"`

---

## Task 4 — [product][TDD] Render `onboarding-assets/commander/TOOLS.md` from `tools.json`

Supersedes the Task 1 interim `TOOLS.md` with a generated commander-flavor cheat-sheet. `AGENTS.md`, `SOUL.md`, `HEARTBEAT.md` remain hand-authored.

**Files:**
- Modify `server/src/services/internal-agent/tool-manifest.ts` (add `renderCommanderToolsMd`)
- Create `scripts/generate-tools-md.ts`
- Modify `server/src/onboarding-assets/commander/TOOLS.md` (becomes generated)
- Modify `server/src/__tests__/tool-manifest.test.ts` (add TOOLS.md drift assertion)
- Modify `package.json` (root) — add `gen:tools:md`, `gen:tools:md:check`

Steps:

- [ ] **RED.** Add to `tool-manifest.test.ts`:
  ```ts
  import { renderCommanderToolsMd } from "../services/internal-agent/tool-manifest.js";

  describe("TOOLS.md — generated commander cheat-sheet is fresh", () => {
    it("onboarding-assets/commander/TOOLS.md equals the rendered output", () => {
      const committed = readFileSync(
        resolve(__dirname, "../onboarding-assets/commander/TOOLS.md"),
        "utf8",
      );
      expect(committed).toBe(renderCommanderToolsMd(buildToolManifest()));
    });

    it("rendered TOOLS.md contains suggest_memory and never create_memory", () => {
      const md = renderCommanderToolsMd(buildToolManifest());
      expect(md).toContain("`suggest_memory`");
      expect(md).not.toContain("create_memory");
    });
  });
  ```
- [ ] **GREEN — renderer.** Add `renderCommanderToolsMd` to `tool-manifest.ts`. It groups the commander-surface entries by `category` in a fixed order and emits a deterministic markdown table. Fail-closed: throw if any entry has an empty name/description.
  ```ts
  const CATEGORY_ORDER: readonly string[] = [
    "query",
    "action",
    "memory",
    "discussion",
    "workflow",
    "file",
    "coordination",
    "analysis",
  ];

  const CATEGORY_HEADING: Record<string, string> = {
    query: "Query Tools (read-only, call freely)",
    action: "Action Tools (confirm before calling)",
    memory: "Memory Tools",
    discussion: "Discussion Tools",
    workflow: "Workflow Tools",
    file: "File Tools",
    coordination: "Coordination Tools",
    analysis: "Analysis Tools",
  };

  export function renderCommanderToolsMd(entries: ToolManifestEntry[]): string {
    const commander = entries.filter((t) => t.surface === "commander");
    for (const t of commander) {
      if (!t.name.trim() || !t.description.trim()) {
        throw new Error(`renderCommanderToolsMd: empty name/description for ${t.name}`);
      }
    }
    const byCat = new Map<string, ToolManifestEntry[]>();
    for (const t of commander) {
      (byCat.get(t.category) ?? byCat.set(t.category, []).get(t.category)!).push(t);
    }
    // Any category not in CATEGORY_ORDER is appended (alpha) so a new category
    // can never be silently dropped.
    const cats = [
      ...CATEGORY_ORDER.filter((c) => byCat.has(c)),
      ...[...byCat.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort(),
    ];

    const lines: string[] = [];
    lines.push("# Commander — Tool Reference");
    lines.push("");
    lines.push(
      "<!-- GENERATED — DO NOT EDIT. Run `pnpm gen:tools:md`. Source: packages/shared/src/generated/tools.json -->",
    );
    lines.push("");
    lines.push(
      `The ${commander.length} tools below are your complete set, generated from the live tool registry. Only call tools in this list; no other tool names exist.`,
    );
    lines.push("");
    lines.push(
      "**Tool naming convention.** Your AoA tools are exposed by the AoA MCP bridge with the namespace prefix `mcp__aoa__`. Inside this file the tools are written without the prefix for readability (e.g. `query_tasks`); when you invoke a tool call the prefixed form (`mcp__aoa__query_tasks`).",
    );
    lines.push("");
    for (const cat of cats) {
      lines.push(`## ${CATEGORY_HEADING[cat] ?? cat}`);
      lines.push("");
      lines.push("| Tool | R/W | Min role | What it does |");
      lines.push("|------|-----|----------|--------------|");
      for (const t of byCat.get(cat)!.sort((a, b) => a.name.localeCompare(b.name))) {
        const role = t.requiredRole ?? "any";
        const desc = t.description.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
        lines.push(`| \`${t.name}\` | ${t.readWrite} | ${role} | ${desc} |`);
      }
      lines.push("");
    }
    lines.push("## Usage Rules");
    lines.push("");
    lines.push(
      "1. **Never guess a tool name.** The tools above are your complete set. If a skill references a tool not on this list, flag it — don't attempt the call.",
    );
    lines.push("2. **Query before action.** Call read tools to gather current state before any write.");
    lines.push(
      "3. **Confirm before write.** All write tools require confirmation via ⚡OPTIONS⚡ unless a loaded skill grants auto-execute for the step.",
    );
    lines.push(
      "4. **Memory governance.** `suggest_memory` → PENDING. Use `detect_conflicts` before proposing memory that might contradict existing items.",
    );
    lines.push("");
    return lines.join("\n");
  }
  ```
- [ ] Create `scripts/generate-tools-md.ts` (mirrors the manifest emitter, `--check` for drift):
  ```ts
  #!/usr/bin/env tsx
  import { writeFileSync, readFileSync, existsSync } from "node:fs";
  import { dirname, resolve } from "node:path";
  import { fileURLToPath } from "node:url";
  import {
    buildToolManifest,
    renderCommanderToolsMd,
  } from "../server/src/services/internal-agent/tool-manifest.js";

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const OUT = resolve(repoRoot, "server/src/onboarding-assets/commander/TOOLS.md");

  const next = renderCommanderToolsMd(buildToolManifest());
  const check = process.argv.includes("--check");

  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== next) {
      console.error("ERROR: commander/TOOLS.md is stale. Run `pnpm gen:tools:md` and commit.");
      process.exit(1);
    }
    console.log("commander/TOOLS.md is fresh.");
  } else {
    writeFileSync(OUT, next, "utf8");
    console.log(`Wrote ${OUT}`);
  }
  ```
- [ ] Add root `package.json` scripts:
  ```json
  "gen:tools:md": "tsx scripts/generate-tools-md.ts",
  "gen:tools:md:check": "tsx scripts/generate-tools-md.ts --check",
  ```
- [ ] Generate and overwrite the interim hand-fixed `TOOLS.md`:
  ```bash
  pnpm gen:tools:md
  ```
  Expected: `Wrote …/commander/TOOLS.md`. Open it: the memory section now lists `suggest_memory` (and the other real registry memory tools `remember_working_context`, `update_working_context`, `forget_working_context`, `update_memory`, `find_similar_memory`, `detect_conflicts`), NOT `create_memory`.
- [ ] **VERIFY** no phantom in the generated doc + drift gate is clean:
  ```bash
  git grep -n "create_memory" -- server/src/onboarding-assets/commander/TOOLS.md   # expect empty
  pnpm gen:tools:md:check                                                            # expect "fresh"
  ```
- [ ] Run the test file — expect green:
  ```bash
  pnpm --filter @armyofagents/server exec vitest run src/__tests__/tool-manifest.test.ts
  ```
  Expected: `7 passed`.
- [ ] Commit: `git add -A && git commit -m "feat(commander): generate TOOLS.md from tools.json (supersedes hand-maintained list)"`

---

## Task 5 — [product][VERIFICATION] Wire drift checks into `pr.yml` `verify`

The vitest drift tests already gate via `pnpm test:run`; add explicit CLI steps for a fast, legible signal.

**Files:**
- Modify `.github/workflows/pr.yml` (the `verify` job, `:359-390`)

Steps:

- [ ] In `pr.yml`, in the `verify` job, add a step AFTER `Build` (packages are built so `tsx` resolves everything, though source resolution already suffices):
  ```yaml
      - name: Tool contract freshness
        run: |
          pnpm gen:tools:check
          pnpm gen:tools:md:check
  ```
  Rationale for placement: `verify` is the required gate (`ci-required` needs it on code changes). Do NOT add to `policy` — that job does not `pnpm install` the workspace, so `tsx`/registry imports would fail. Do NOT add a new top-level job (would need to be added to `ci-required.needs` and branch protection).
- [ ] **VERIFY** the YAML is well-formed and the step exists:
  ```bash
  git grep -n "Tool contract freshness" -- .github/workflows/pr.yml
  ```
  Expected: one match under `verify`.
- [ ] **VERIFY** the two commands pass locally (proxy for CI):
  ```bash
  pnpm gen:tools:check && pnpm gen:tools:md:check
  ```
  Expected: both print "fresh", exit 0.
- [ ] Commit: `git add -A && git commit -m "ci(commander): add tool-contract freshness step to verify lane"`

---

## Task 6 — [product][TDD] Product → skills sync script

**Files:**
- Create `scripts/sync-commander-to-skills.ts`
- Create `server/src/__tests__/sync-commander-to-skills.test.ts`
- Modify `package.json` (root) — add `sync:skills`

Steps:

- [ ] **RED.** Create `server/src/__tests__/sync-commander-to-skills.test.ts`. Refactor the copy logic into a pure exported function `syncCommanderToSkills({ productRoot, skillsRoot })` so it is testable against temp dirs (avoid embedding fs paths in the CLI entrypoint):
  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { syncCommanderToSkills } from "../../../scripts/sync-commander-to-skills.js";

  describe("syncCommanderToSkills", () => {
    let productRoot: string;
    let skillsRoot: string;
    beforeEach(() => {
      productRoot = mkdtempSync(join(tmpdir(), "prod-"));
      skillsRoot = mkdtempSync(join(tmpdir(), "skills-"));
      mkdirSync(join(productRoot, "server/src/onboarding-assets/commander"), { recursive: true });
      mkdirSync(join(productRoot, "packages/shared/src/generated"), { recursive: true });
      mkdirSync(join(skillsRoot, "commander"), { recursive: true });
      mkdirSync(join(skillsRoot, "generated"), { recursive: true });
      for (const f of ["AGENTS.md", "SOUL.md", "HEARTBEAT.md", "TOOLS.md"]) {
        writeFileSync(join(productRoot, "server/src/onboarding-assets/commander", f), `# ${f}\nsuggest_memory\n`);
      }
      writeFileSync(join(productRoot, "packages/shared/src/generated/tools.json"), `{"tools":[]}\n`);
    });
    afterEach(() => {
      rmSync(productRoot, { recursive: true, force: true });
      rmSync(skillsRoot, { recursive: true, force: true });
    });

    it("vendors persona + TOOLS.md + tools.json into the skills repo", () => {
      const written = syncCommanderToSkills({ productRoot, skillsRoot });
      for (const f of ["AGENTS.md", "SOUL.md", "HEARTBEAT.md", "TOOLS.md"]) {
        expect(readFileSync(join(skillsRoot, "commander", f), "utf8")).toContain(f);
      }
      expect(readFileSync(join(skillsRoot, "generated/tools.json"), "utf8")).toBe(`{"tools":[]}\n`);
      expect(written).toContain(join(skillsRoot, "generated/tools.json"));
    });

    it("throws when the skills root is missing the commander/ dir", () => {
      rmSync(join(skillsRoot, "commander"), { recursive: true, force: true });
      expect(() => syncCommanderToSkills({ productRoot, skillsRoot })).toThrow();
    });
  });
  ```
- [ ] Run — expect module-not-found failure.
- [ ] **GREEN.** Create `scripts/sync-commander-to-skills.ts`:
  ```ts
  #!/usr/bin/env tsx
  import { copyFileSync, existsSync } from "node:fs";
  import { dirname, resolve } from "node:path";
  import { fileURLToPath } from "node:url";

  const PERSONA = ["AGENTS.md", "SOUL.md", "HEARTBEAT.md", "TOOLS.md"] as const;

  export function syncCommanderToSkills(opts: {
    productRoot: string;
    skillsRoot: string;
  }): string[] {
    const { productRoot, skillsRoot } = opts;
    const srcCommander = resolve(productRoot, "server/src/onboarding-assets/commander");
    const dstCommander = resolve(skillsRoot, "commander");
    const srcTools = resolve(productRoot, "packages/shared/src/generated/tools.json");
    const dstTools = resolve(skillsRoot, "generated/tools.json");

    if (!existsSync(dstCommander)) {
      throw new Error(`skills repo missing commander/ dir: ${dstCommander}`);
    }
    if (!existsSync(resolve(skillsRoot, "generated"))) {
      throw new Error(`skills repo missing generated/ dir: ${resolve(skillsRoot, "generated")}`);
    }
    if (!existsSync(srcTools)) {
      throw new Error(`tools.json not found — run \`pnpm gen:tools\` first: ${srcTools}`);
    }

    const written: string[] = [];
    for (const f of PERSONA) {
      const src = resolve(srcCommander, f);
      if (!existsSync(src)) throw new Error(`missing product persona file: ${src}`);
      const dst = resolve(dstCommander, f);
      copyFileSync(src, dst);
      written.push(dst);
    }
    copyFileSync(srcTools, dstTools);
    written.push(dstTools);
    return written;
  }

  // CLI: `pnpm sync:skills -- <path-to-skills-repo>`
  if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("sync-commander-to-skills.ts")) {
    const skillsRoot = process.argv[2];
    if (!skillsRoot) {
      console.error("Usage: pnpm sync:skills -- <path-to-AoA-Skills-repo>");
      process.exit(1);
    }
    const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const written = syncCommanderToSkills({ productRoot, skillsRoot });
    console.log(`Vendored ${written.length} files into ${skillsRoot}:`);
    for (const w of written) console.log(`  ${w}`);
  }
  ```
  (Verify the `import.meta.url` entrypoint guard fires under `tsx`; if not, fall back to a top-level `main()` call gated on `process.argv[1]` basename.)
- [ ] Add root `package.json` script:
  ```json
  "sync:skills": "tsx scripts/sync-commander-to-skills.ts",
  ```
- [ ] Run the test — expect green:
  ```bash
  pnpm --filter @armyofagents/server exec vitest run src/__tests__/sync-commander-to-skills.test.ts
  ```
  Expected: `2 passed`.
- [ ] Commit: `git add -A && git commit -m "feat(commander): product→skills sync (vendors persona + TOOLS.md + tools.json)"`

---

## Task 7 — [product][TDD] Generate the Commander skill catalog (`AOA_NATIVE_SKILLS`) from the AoA-Skills repo

Same philosophy as Task 6's instruction-file de-dup: the live Commander seed catalog stops being a hand-maintained copy and becomes a GENERATED projection of the canonical source. Today `aoa-skills-seeder.ts` hard-codes **4** `AOA_NATIVE_SKILLS` entries (`brainstorm`, `identity-setup`, `sprint-planning`, `team-design`) — verified against `AOA_NATIVE_SKILLS` (`server/src/services/internal-agent/aoa-skills-seeder.ts:12`) and its test's `expect(AOA_NATIVE_SKILLS).toHaveLength(4)` (`server/src/__tests__/aoa-skills-seeder.test.ts:5-6`). The generator reads the AoA-Skills repo's `skills/*.md` and emits a committed catalog the seeder imports, so the seeder can never drift from the source skills.

**This collapses two other hand-maintained copies into this one generated source:** Plan-2's `commander-skill-triggering/skills-snapshot.json` eval snapshot and Plan-3's hand-edited `AOA_NATIVE_SKILLS` seeder entries (its per-skill "add the Commander-flavored twin to `AOA_NATIVE_SKILLS`" steps) both become outputs of this generator instead of hand copies — reconcile at integration (Plan-3 Self-Review already flags this as its known-risk #2).

### Canonical key namespace mapping (scope §7.4 / cross-plan B2)

- **Repo is the single source.** Each `skills/*.md` frontmatter carries `key: skill:aoa-curated/aoa-<name>` (e.g. `skill:aoa-curated/aoa-brainstorm`). This is the source-of-truth key and stays as-is in the repo.
- **The generator applies a DETERMINISTIC mapping to the runtime seeder key** `skill:aoa/<name>` (strip the `aoa-curated/aoa-` prefix → `aoa/`; e.g. `skill:aoa-curated/aoa-brainstorm` → `skill:aoa/brainstorm`). This preserves today's live seeder keys (`skill:aoa/brainstorm`, `skill:aoa/identity-setup`, … verified at `aoa-skills-seeder.ts:14,52` and the test at `:20-23`) — so **no install migration** is needed and existing enablement rows keep matching.
- Eval assets assert the RUNTIME seeder keys `skill:aoa/<name>` (Plan 2's snapshot + Plan 3's `expectSkillKey` cases fire against what live Commander loads = the seeder). The repo frontmatter `skill:aoa-curated/aoa-<name>` is source-only, mapped here.
- Commander flavor: skills are surface-agnostic (scope Decision #2 — intent in prose; the generated `TOOLS.md` cheat-sheet resolves real names), so the generator carries the body/description/triggerPhrases and applies only the key mapping (+ any Commander-only front-matter the seeder shape needs) — it does not rewrite prose per-tool.

**Files:**
- Create `scripts/generate-aoa-skills-seeder.ts`
- Create `server/src/services/internal-agent/generated/aoa-native-skills.json` (generated output)
- Modify `server/src/services/internal-agent/aoa-skills-seeder.ts` (import the generated catalog)
- Modify `server/src/__tests__/aoa-skills-seeder.test.ts` (drop the "exactly 4" assertion)
- Create `server/src/__tests__/aoa-skills-seeder-drift.test.ts`
- Modify `package.json` (root) — add `gen:skills`, `gen:skills:check`

Steps:

- [ ] Create `scripts/generate-aoa-skills-seeder.ts`. It reads `<skills-repo>/skills/*.md`, parses each file's frontmatter (`name`, `key`, `description`, optional `triggerPhrases`) + markdown body, maps the key, and writes the committed catalog. `--check` fails on drift vs the committed file. Takes the skills-repo path as an argv (cross-repo, like `sync:skills`); defaults to the reference clone when omitted.
  ```ts
  #!/usr/bin/env tsx
  import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
  import { dirname, join, resolve, basename } from "node:path";
  import { fileURLToPath } from "node:url";

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const OUT = resolve(
    repoRoot,
    "server/src/services/internal-agent/generated/aoa-native-skills.json",
  );

  /** skill:aoa-curated/aoa-<name>  →  skill:aoa/<name>  (deterministic; preserves live keys). */
  function mapRepoKeyToSeederKey(repoKey: string): string {
    const m = /^skill:aoa-curated\/aoa-(.+)$/.exec(repoKey.trim());
    if (!m) throw new Error(`unexpected repo skill key (want skill:aoa-curated/aoa-<name>): ${repoKey}`);
    return `skill:aoa/${m[1]}`;
  }

  function parseFrontmatter(src: string): { fm: Record<string, string>; body: string } {
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
    if (!match) throw new Error("missing frontmatter");
    const fm: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { fm, body: match[2] };
  }

  function buildCatalog(skillsRoot: string) {
    const dir = resolve(skillsRoot, "skills");
    if (!existsSync(dir)) throw new Error(`skills dir not found: ${dir}`);
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    const skills = files.map((f) => {
      const { fm, body } = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
      if (!fm.key || !fm.name || !fm.description) throw new Error(`missing key/name/description in ${f}`);
      const key = mapRepoKeyToSeederKey(fm.key);
      const markdown = body.trim() + "\n";
      if (markdown.includes("create_memory")) {
        throw new Error(`phantom create_memory present in ${f} — fix the source skill (WS-0 Task 8)`);
      }
      const triggerPhrases = fm.triggerPhrases
        ? JSON.parse(fm.triggerPhrases) as string[]
        : [];
      return { key, name: fm.name, description: fm.description, triggerPhrases, markdown };
    });
    return { $generated: "DO NOT EDIT — run `pnpm gen:skills`. Source: AoA-Skills skills/*.md.", version: 1, skills };
  }

  const skillsRoot =
    process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ??
    resolve(repoRoot, "../../scratchpad/aoa-skills");
  const next = JSON.stringify(buildCatalog(skillsRoot), null, 2) + "\n";
  const check = process.argv.includes("--check");

  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== next) {
      console.error("ERROR: aoa-native-skills.json is stale. Run `pnpm gen:skills -- <skills-repo>` and commit.");
      process.exit(1);
    }
    console.log("aoa-native-skills.json is fresh.");
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, next, "utf8");
    console.log(`Wrote ${OUT}`);
  }
  ```
- [ ] Add root `package.json` scripts (after `sync:skills`):
  ```json
  "gen:skills": "tsx scripts/generate-aoa-skills-seeder.ts",
  "gen:skills:check": "tsx scripts/generate-aoa-skills-seeder.ts --check",
  ```
- [ ] Generate the committed catalog (requires the reference skills clone with the Task-8 phantom fixes applied):
  ```bash
  cd "C:/Users/TK/.aoa/wt/commander-skills-overhaul"
  pnpm gen:skills -- "…/scratchpad/aoa-skills"
  ```
  Expected: `Wrote …/generated/aoa-native-skills.json`. Inspect it: `skills` array present, every `key` is `skill:aoa/<name>` (none `skill:aoa-curated/…`), no `create_memory`.
- [ ] Modify `aoa-skills-seeder.ts` to import the generated catalog instead of the hardcoded array:
  ```ts
  import catalog from "./generated/aoa-native-skills.json" with { type: "json" };
  export const AOA_NATIVE_SKILLS: AoaSkillDefinition[] = catalog.skills;
  ```
  (Keep the `AoaSkillDefinition` interface + `seedAoaNativeSkills` seeding logic unchanged — only the source of the array changes.)
- [ ] Update `server/src/__tests__/aoa-skills-seeder.test.ts`: remove `expect(AOA_NATIVE_SKILLS).toHaveLength(4)` and the fixed 4-key list; replace with generated-catalog invariants:
  ```ts
  import catalog from "../services/internal-agent/generated/aoa-native-skills.json" with { type: "json" };

  it("matches the generated catalog (no hand-drift)", () => {
    expect(AOA_NATIVE_SKILLS.length).toBe(catalog.skills.length);
    expect(AOA_NATIVE_SKILLS.length).toBeGreaterThanOrEqual(4);
  });
  it("every native key is a runtime seeder key (skill:aoa/<name>), never the repo source key", () => {
    for (const s of AOA_NATIVE_SKILLS) {
      expect(s.key).toMatch(/^skill:aoa\/[a-z-]+$/);
      expect(s.key.startsWith("skill:aoa-curated/")).toBe(false);
    }
  });
  it("carries no create_memory phantom in any body", () => {
    for (const s of AOA_NATIVE_SKILLS) expect(s.markdown).not.toContain("create_memory");
  });
  ```
  (Keep the `calls db insert for each skill` test, but assert `insertSpy` was called `AOA_NATIVE_SKILLS.length` times rather than the literal `4`.)
- [ ] Create `server/src/__tests__/aoa-skills-seeder-drift.test.ts` — internal-invariant freshness (runs in product CI without the skills repo present):
  ```ts
  import { describe, it, expect } from "vitest";
  import catalog from "../services/internal-agent/generated/aoa-native-skills.json" with { type: "json" };

  describe("aoa-native-skills.json — generated catalog invariants", () => {
    it("has a $generated banner + version + non-empty skills", () => {
      expect((catalog as any).$generated).toContain("gen:skills");
      expect(Array.isArray(catalog.skills)).toBe(true);
      expect(catalog.skills.length).toBeGreaterThanOrEqual(4);
    });
    it("every entry has the seeder shape and a mapped key", () => {
      for (const s of catalog.skills) {
        expect(s.key).toMatch(/^skill:aoa\/[a-z-]+$/);
        expect(typeof s.name).toBe("string");
        expect(typeof s.description).toBe("string");
        expect(Array.isArray(s.triggerPhrases)).toBe(true);
        expect(typeof s.markdown).toBe("string");
        expect(s.markdown).not.toContain("create_memory");
      }
    });
  });
  ```
  Note: byte-for-byte regeneration against the live AoA-Skills repo is the `pnpm gen:skills:check` step, run at publish/sync time when the skills clone is present (cross-repo; same accepted gap as the sync — see the delivery-decision section). Product CI cannot fetch the private-vs-public repo pair, so the vitest test guards internal invariants only.
- [ ] Run both test files — expect green:
  ```bash
  pnpm --filter @armyofagents/server exec vitest run src/__tests__/aoa-skills-seeder.test.ts src/__tests__/aoa-skills-seeder-drift.test.ts
  ```
- [ ] Commit: `git add -A && git commit -m "feat(commander): generate AOA_NATIVE_SKILLS catalog from AoA-Skills repo (supersedes hand-written seeder)"`

---

## Task 8 — [skills-repo][VERIFICATION] Fix phantom refs + de-hardcode counts in skills-native files

Operate in the AoA-Skills repo working copy. `commander/AGENTS.md`, `commander/SOUL.md`, `commander/TOOLS.md` are NOW synced from product (Task 6/10) — do NOT hand-edit those here; this task fixes only the skills-native files (`model-overlays/*`, `skills/*`).

**Files:**
- Modify `model-overlays/claude.md` (L11), `model-overlays/codex.md` (L9), `model-overlays/gemini.md` (L11, L19), `model-overlays/opencode.md` (L11)
- Modify `skills/identity-setup.md` (L10, L69, L81), `skills/office-hours.md` (L10, L70)

Steps:

- [ ] `model-overlays/codex.md` L9 — invert the rule back to truth: replace
  `` `suggest_memory` does not exist — use `create_memory`. `` with
  `` `create_memory` does not exist — use `suggest_memory`. `` and change `The 34 tools in TOOLS.md are your complete set.` → `The tools in TOOLS.md are your complete set.`
- [ ] `model-overlays/gemini.md` L11 — same inversion + de-count: `` `create_memory` does not exist — use `suggest_memory`. `` and `The 34 tools in TOOLS.md` → `The tools in TOOLS.md`.
- [ ] `model-overlays/gemini.md` L19 — replace `\`create_memory\` creates a PENDING suggestion.` → `\`suggest_memory\` creates a PENDING suggestion.`
- [ ] `model-overlays/opencode.md` L11 — same inversion: `` `create_memory` does not exist — use `suggest_memory`. ``
- [ ] `model-overlays/claude.md` L11 — replace `\`create_memory\` creates a PENDING item.` → `\`suggest_memory\` creates a PENDING item.`
- [ ] `skills/identity-setup.md` — L10 `Tools used in this skill: … \`create_memory\`` → `\`suggest_memory\``; L69 `call \`create_memory\` with:` → `call \`suggest_memory\` with:`; L81 `\`create_memory\` creates a PENDING item` → `\`suggest_memory\` creates a PENDING item`.
- [ ] `skills/office-hours.md` — L10 `… \`create_memory\`` → `\`suggest_memory\``; L70 `call \`create_memory\` with \`layer: "active_context"\`` → `call \`suggest_memory\` with \`layer: "active_context"\``.
- [ ] **VERIFY** zero phantoms remain across the skills-native files:
  ```bash
  cd "…/scratchpad/aoa-skills"
  grep -rn "create_memory" model-overlays skills
  ```
  Expected: empty (exit 1). Any surviving `create_memory` (except an intentional `create_memory does not exist` ban-doc line) is a bug.
- [ ] Commit (in the skills repo): `git add -A && git commit -m "fix: replace create_memory phantom + de-invert overlays; drop hardcoded tool counts"`

---

## Task 9 — [skills-repo][TDD] Rewrite `validate.ts` to consume vendored `tools.json`

**Files:**
- Modify `validate.ts` (`VALID_TOOLS` source + `BANNED_TOOLS`)
- Create `generated/tools.json` (temporary fixture for local dev; overwritten by the real sync in Task 10)

Steps:

- [ ] Create a minimal `generated/tools.json` fixture so `validate.ts` runs before the first product sync (the real vendored file lands via `pnpm sync:skills`). Include at least the commander memory tools so the allowlist is realistic:
  ```json
  {
    "version": 1,
    "tools": [
      { "name": "suggest_memory", "surface": "commander", "category": "memory", "readWrite": "write", "requiredRole": "team_lead", "description": "", "mcpAlias": null },
      { "name": "query_memory", "surface": "commander", "category": "memory", "readWrite": "read", "requiredRole": "team_member", "description": "", "mcpAlias": null }
    ]
  }
  ```
  (This is a bootstrap stub; Task 10's sync replaces it with the full manifest. Note in the commit that it is provisional.)
- [ ] **RED (manual harness).** Add a temporary assertion block at the bottom of `validate.ts` guarded by `--selftest` that exercises the allowlist load, OR (preferred, no test runner in this repo) drive the check with a throwaway fixture file and assert exit codes via shell. Concretely, prove the CURRENT behavior is wrong first:
  ```bash
  cd "…/scratchpad/aoa-skills"
  printf '# t\n`suggest_memory`\n' > /tmp/aoa-selftest.md
  mkdir -p /tmp/aoa-st && cp /tmp/aoa-selftest.md /tmp/aoa-st/x.md
  bun run validate.ts /tmp/aoa-st        # BEFORE fix: fails, flags suggest_memory as BANNED
  ```
  Expected BEFORE: exit 1, "`suggest_memory` ← BANNED (use `create_memory`)". This is the inversion bug.
- [ ] **GREEN.** Edit `validate.ts`:
  - Replace the hardcoded `VALID_TOOLS` Set (`validate.ts:26-70`) with a load from the vendored manifest:
    ```ts
    import { readFileSync, existsSync } from "fs";
    import { join } from "path";

    const MANIFEST_PATH = join(import.meta.dir ?? process.cwd(), "generated/tools.json");
    if (!existsSync(MANIFEST_PATH)) {
      console.error(
        `FATAL: generated/tools.json not found at ${MANIFEST_PATH}. ` +
          "Run the product sync (`pnpm sync:skills`) before validating.",
      );
      process.exit(2);
    }
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as {
      tools: Array<{ name: string; surface: string }>;
    };
    // Commander-surface names are the authored/validated flavor (scope §2 decision 2).
    const VALID_TOOLS = new Set(
      manifest.tools.filter((t) => t.surface === "commander").map((t) => t.name),
    );
    ```
    (`import.meta.dir` is a Bun global pointing at the script's dir; keep the `process.cwd()` fallback.)
  - Replace the `BANNED_TOOLS` map (`validate.ts:76-89`): DELETE the inverted `["suggest_memory", "create_memory"]` entry; ADD `["create_memory", "suggest_memory"]`. Keep the other genuinely-wrong names:
    ```ts
    const BANNED_TOOLS = new Map<string, string>([
      ["create_memory", "suggest_memory"],          // phantom — never existed on any surface
      ["save_memory", "suggest_memory"],
      ["approve_memory", "update_memory"],
      ["search_tasks", "query_tasks"],
      ["search_agents", "query_agents"],
      ["search_goals", "query_goals"],
      ["list_tasks", "query_tasks"],
      ["list_agents", "query_agents"],
      ["get_company", "query_company"],
      ["create_workflow", "create_workflow_template"],
      ["run_workflow", "instantiate_workflow"],
      ["add_dependency", "add_task_dependency"],
    ]);
    ```
  - Update the ban-documentation heuristic (`validate.ts:163-172`): change the `lowerLine.includes("use create_memory")` clause to `lowerLine.includes("use suggest_memory")` (and add `lowerLine.includes("use \`suggest_memory\`")` tolerance) so the corrected overlay lines ("`create_memory` does not exist — use `suggest_memory`") are still recognized as ban-docs and not re-flagged.
  - Update the header comment (`validate.ts:22-25`) and the "34-tool" strings (`validate.ts:250,254`) to reference the generated manifest instead of a hardcoded 34-list.
- [ ] **VERIFY (was RED, now GREEN):**
  ```bash
  bun run validate.ts /tmp/aoa-st        # suggest_memory now VALID → exit 0
  printf '# t\n`create_memory`\n' > /tmp/aoa-st/x.md
  bun run validate.ts /tmp/aoa-st        # create_memory now BANNED → exit 1
  ```
  Expected: first exit 0; second exit 1 with "`create_memory` ← BANNED (use `suggest_memory`)".
- [ ] **VERIFY** the whole repo passes the corrected linter (after Task 8 fixes + with the bootstrap manifest; full pass requires Task 10's real manifest so all 75 commander names are valid):
  ```bash
  bun run validate.ts
  ```
  Expected: any remaining failures are ONLY "NOT in tool list" for real registry names absent from the bootstrap stub — resolved once Task 10 vendors the full `tools.json`.
- [ ] Commit (skills repo): `git add -A && git commit -m "fix(validate): source allowlist from generated tools.json; de-invert create_memory ban"`

---

## Task 10 — [skills-repo][TDD] MCP-flavor generator + real vendored manifest + synced commander/*

**Files:**
- Create `scripts/gen-tools-md.ts`
- Create `commander/TOOLS.mcp.md` (generated)
- Overwrite `generated/tools.json`, `commander/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md` via the product sync
- Modify `package.json` (skills repo) — add `gen:tools-md`, `gen:tools-md:check`

Steps:

- [ ] Run the product sync to vendor the REAL manifest + synced persona/TOOLS.md into the skills repo (requires Tasks 3-4-6 landed in product):
  ```bash
  cd "C:/Users/TK/.aoa/wt/commander-skills-overhaul"
  pnpm sync:skills -- "…/scratchpad/aoa-skills"
  ```
  Expected: "Vendored 5 files …" (AGENTS, SOUL, HEARTBEAT, TOOLS.md, generated/tools.json). The bootstrap stub `generated/tools.json` from Task 9 is replaced by the full manifest.
- [ ] Create `scripts/gen-tools-md.ts` (Bun). It renders `commander/TOOLS.mcp.md` from the vendored manifest and, in `--check` mode, re-renders BOTH the commander flavor (must equal the synced `commander/TOOLS.md`) and the mcp flavor (must equal `commander/TOOLS.mcp.md`), fail-closed on mismatch or missing manifest. The commander-flavor render logic is duplicated from product `renderCommanderToolsMd` (documented cross-repo duplication — keep byte-identical):
  ```ts
  #!/usr/bin/env bun
  import { readFileSync, writeFileSync, existsSync } from "fs";
  import { join } from "path";

  const ROOT = import.meta.dir ? join(import.meta.dir, "..") : process.cwd();
  const MANIFEST = join(ROOT, "generated/tools.json");
  if (!existsSync(MANIFEST)) {
    console.error(`FATAL: generated/tools.json missing — run \`pnpm sync:skills\` from the product repo.`);
    process.exit(2);
  }
  type Entry = { name: string; surface: string; category: string; readWrite: string; requiredRole: string | null; description: string };
  const tools: Entry[] = JSON.parse(readFileSync(MANIFEST, "utf8")).tools;

  // --- commander flavor: MUST match product renderCommanderToolsMd byte-for-byte ---
  function renderCommander(entries: Entry[]): string { /* port of product renderCommanderToolsMd */ }
  // --- mcp flavor: kebab/dotted names, family grouping, RBAC note ---
  function renderMcp(entries: Entry[]): string {
    const mcp = entries.filter((t) => t.surface === "mcp");
    for (const t of mcp) if (!t.name.trim() || !t.description.trim()) throw new Error(`empty field: ${t.name}`);
    const lines = [
      "# AoA MCP — Tool Reference (external agents over the MCP server)",
      "",
      "<!-- GENERATED — DO NOT EDIT. Run `bun scripts/gen-tools-md.ts`. Source: generated/tools.json -->",
      "",
      `${mcp.length} tools exposed over the authenticated MCP endpoint, RBAC-scoped.`,
      "",
      "| Tool | R/W | Family | What it does |",
      "|------|-----|--------|--------------|",
    ];
    for (const t of [...mcp].sort((a, b) => a.name.localeCompare(b.name))) {
      const desc = t.description.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
      lines.push(`| \`${t.name}\` | ${t.readWrite} | ${t.category} | ${desc} |`);
    }
    lines.push("");
    return lines.join("\n");
  }

  const check = process.argv.includes("--check");
  const mcpOut = join(ROOT, "commander/TOOLS.mcp.md");
  const cmdOut = join(ROOT, "commander/TOOLS.md");
  const mcpNext = renderMcp(tools);
  const cmdNext = renderCommander(tools);

  if (check) {
    let stale = false;
    for (const [path, next] of [[mcpOut, mcpNext], [cmdOut, cmdNext]] as const) {
      const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (cur !== next) { console.error(`ERROR: ${path} is stale.`); stale = true; }
    }
    process.exit(stale ? 1 : 0);
  } else {
    writeFileSync(mcpOut, mcpNext, "utf8");
    console.log(`Wrote ${mcpOut}`);
  }
  ```
  Port `renderCommander` from product `renderCommanderToolsMd` exactly (same headings, same column layout) so `--check` on the synced `commander/TOOLS.md` passes. If a byte mismatch is unavoidable across runtimes, prefer to NOT re-check the commander flavor here and rely on the product drift gate + sync — decide during implementation and document.
- [ ] Add skills-repo `package.json` scripts:
  ```json
  "gen:tools-md": "bun scripts/gen-tools-md.ts",
  "gen:tools-md:check": "bun scripts/gen-tools-md.ts --check"
  ```
- [ ] Generate the MCP flavor:
  ```bash
  cd "…/scratchpad/aoa-skills" && bun run gen:tools-md
  ```
  Expected: `Wrote …/commander/TOOLS.mcp.md`. Open it: rows use MCP names (`memory.write`, `list-approvals`, `debrief-push`), grouped by family.
- [ ] **VERIFY** full validate now passes (real manifest → all 75 commander names valid, no phantoms):
  ```bash
  bun run validate.ts
  ```
  Expected: `✅ Validated N files — 0 tool name errors found.`
- [ ] **VERIFY** freshness check is clean right after generating:
  ```bash
  bun run gen:tools-md:check
  ```
  Expected: exit 0.
- [ ] Commit (skills repo): `git add -A && git commit -m "feat: generate TOOLS.mcp.md + vendor full tools.json; sync commander persona from product"`

---

## Task 11 — [skills-repo][VERIFICATION] Freshness gate in `validate.yml`

**Files:**
- Modify `.github/workflows/validate.yml`

Steps:

- [ ] Add steps to the `validate` job AFTER the existing `Run validate.ts` step:
  ```yaml
      - name: Tool docs freshness (regen must be a no-op)
        run: bun scripts/gen-tools-md.ts --check

      - name: No hand-edited generated docs
        run: |
          bun scripts/gen-tools-md.ts
          git diff --exit-code commander/TOOLS.mcp.md commander/TOOLS.md
  ```
  The `--check` step fails fast with a clear message; the `git diff --exit-code` step is the belt-and-suspenders gate ("generated docs can never be hand-edited stale"). Note: `validate.yml` triggers on `paths: [commander/**, model-overlays/**, skills/**, validate.ts]` — add `generated/**` and `scripts/**` to BOTH the `push` and `pull_request` `paths` lists so a manifest/script change re-runs the gate:
  ```yaml
        - 'generated/**'
        - 'scripts/**'
  ```
- [ ] **VERIFY** the workflow references the new script and paths:
  ```bash
  cd "…/scratchpad/aoa-skills"
  grep -n "gen-tools-md\|generated/\*\*" .github/workflows/validate.yml
  ```
  Expected: matches for the freshness steps and the added paths.
- [ ] **VERIFY** locally that the gate is green on a clean tree and red on a hand-edit:
  ```bash
  bun scripts/gen-tools-md.ts --check && git diff --exit-code commander/TOOLS.mcp.md   # exit 0
  printf '\nHAND EDIT\n' >> commander/TOOLS.mcp.md
  bun scripts/gen-tools-md.ts --check; echo "exit=$?"                                   # exit 1
  git checkout commander/TOOLS.mcp.md
  ```
- [ ] Commit (skills repo): `git add -A && git commit -m "ci: freshness gate for generated tool docs"`

---

## Self-Review

### Spec-coverage vs scope §5 WS-0

| WS-0 bullet | Covered by |
|---|---|
| Fix every `create_memory`→`suggest_memory` (skills **and** `onboarding-assets/commander/*`) | Task 1 (product canonical + negative refs) · Task 8 (skills-native overlays/skills) · Task 4/10 (generated TOOLS.md carries only real names) |
| De-invert `validate.ts`; regenerate allowlist from `tools.json` | Task 9 |
| Product emits `tools.json` from the registry (Commander names now; MCP names + mapping reserved) | Task 2 (builder) · Task 3 (emitter + committed artifact). MCP entries emitted with `surface:"mcp"`; `mcpAlias`/`requiredRole` reserved `null` (documented) |
| Generate the product's live Commander skill catalog (`AOA_NATIVE_SKILLS`) from the canonical AoA-Skills repo (one source; collapse the hand-edited seeder + Plan-2 snapshot) | Task 7 (seeder generator + committed catalog + drift test; `skill:aoa-curated/aoa-<name>` → `skill:aoa/<name>` deterministic key mapping preserves live keys) |
| Skills-repo generator: `tools.json` → `TOOLS.md` + validate allowlist; CI freshness gate (`--check` + `git diff --exit-code`) | Task 10 (generator, MCP flavor + commander re-check) · Task 9 (allowlist) · Task 11 (CI) |
| De-duplicate Commander instruction files across the two repos (one source; generate/sync the other) | Task 6 (product→skills sync) · §7.5 direction honored: product canonical, skills synced |
| Correct stale tool-count claims ("34/35 … complete set") | Task 1 (product SOUL/TOOLS) · Task 8 (overlays); generated docs state count from manifest |
| Task-type discipline: TDD for code, VERIFICATION for docs | Code tasks 2,3,4,6,7,9,10 use failing-test-first; doc tasks 1,5,8,11 use grep/exit-code verification |

### Placeholder scan
No "TBD" / "similar to Task N" / "add error handling" left. Two implementation-time decisions are explicitly flagged in-line (not left vague): (a) exact `../` depth of the test's `resolve()` to `packages/` — verify at RED; (b) whether the skills-repo `gen-tools-md.ts` re-checks the commander flavor byte-for-byte or defers to the product gate — decide during Task 10 with the documented fallback.

### Type/name consistency
- `ToolManifestEntry` shape matches scope §7.4 exactly: `{ name, surface, category, readWrite, requiredRole, description, mcpAlias }`.
- Registry field names used (`category`, `requiredRole`, `requiresConfirmation`, `description`, `name`) all verified against `AgentTool` (`types.ts:86-95`).
- MCP handler-map names used for category derivation (`readToolHandlers`, `writeToolHandlers`, `documentToolHandlers`, `approvalToolHandlers`, `skillToolHandlers`) verified **exported** from `mcp/tools/index.ts:10-16`. `askFounderToolHandlers` is intentionally NOT imported by the manifest builder (it is not re-exported); the single `ask_founder` tool is categorized by name. `TOOL_DEFINITIONS` (the entry source) is exported from `index.ts:66`.
- Output path `packages/shared/src/generated/tools.json` is consistent across emitter, drift test, sync, and skills vendoring (`generated/tools.json`).
- Script commands (`gen:tools`, `gen:tools:check`, `gen:tools:md`, `gen:tools:md:check`, `sync:skills`, `gen:skills`, `gen:skills:check` in product; `gen:tools-md`, `gen:tools-md:check` in skills) are used consistently in their tasks and the CI steps.
- Seeder-generation names are consistent: script `scripts/generate-aoa-skills-seeder.ts`, committed catalog `server/src/services/internal-agent/generated/aoa-native-skills.json`, key mapping `skill:aoa-curated/aoa-<name>` → `skill:aoa/<name>` — used identically in Task 7, the File Structure, and Plan-2/Plan-3's `skill:aoa/<name>` eval + seeder keys.

### Open questions / wrinkles surfaced
1. **Cross-repo freshness gap (documented, accepted):** the skills repo can be internally consistent yet lag the product registry if a publisher skips `pnpm sync:skills`. No token-free automated close is possible (product private, skills public). Deferred to R2 (published shared package or token-gated fetch).
2. **Render-logic duplication across the repo boundary:** product `renderCommanderToolsMd` (TS/tsx) vs skills `gen-tools-md.ts` (Bun) must stay byte-identical for the commander flavor. Kept tiny; a fallback (skills does not re-check the commander flavor, relies on product gate + sync) is documented in Task 10.
3. **`readWrite` is advisory, deterministic-but-approximate** (e.g. `remember_working_context` classifies `read`). Real gating stays in `authorize-tool.ts`. Refinement is R2; the contract test asserts the RULE, not semantic perfection.
4. **`TOOLS.md` is hand-fixed in Task 1 then regenerated in Task 4** — intentional: lands the live bug fix independently so it ships even if the generator work slips; the generator supersedes it and the drift test locks it.
</content>
</invoke>
