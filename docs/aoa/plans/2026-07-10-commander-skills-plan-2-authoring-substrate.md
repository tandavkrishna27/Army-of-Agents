# WS-1: Authoring Substrate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the quality substrate every Commander skill needs — WHEN-only routing descriptions, a single shared Commander preamble injected in one place, written authoring conventions, and a lite skill-triggering eval that proves a naive prompt routes to the right skill.
**Architecture:** Two repos. In the **product**, one exported preamble constant is injected by `buildCompactSkillList` (always-on, every turn) and prepended to the `use_skill` tool return (point-of-load), removing the confirm-gate/persona/memory-PENDING boilerplate that today is restated ~6× per skill. In the **skills repo**, all 8 skill `description`s are rewritten to WHEN-only third-person prose (the one field that survives the marketplace pipeline), an `AUTHORING.md` codifies the conventions, and each skill self-labels rigid-vs-flexible + degrees-of-freedom and references peers by name. A lite triggering eval is added to the existing `server/src/eval` framework: a classifier-proxy suite (R1, runs under `eval:run`) plus an acceptance-gated live-runtime skeleton (Tier 2).
**Tech Stack:** Node/Bun, TypeScript; product = AoA (this worktree); skills = AoA-Skills repo.
**Depends on:** Plan 1 (WS-0) — `tools.json` manifest `{ name, surface, category, readWrite, requiredRole, description, mcpAlias }`, per-surface tool cheat-sheets, and the **de-inverted `validate.ts`** (real tools in `VALID_TOOLS`, phantom `create_memory` removed). This plan CONSUMES those; it does not build or re-fix them.
**Repos touched:** [product] AoA-2.5 (this worktree) · [skills-repo] AoA-Skills (`github.com/MeteoriteLabs/AoA-Skills`)

---

## Context the implementer must hold

Verified against the worktree on 2026-07-10:

- **Commander chat spawns a real CLI subprocess** (`claude`/`codex`) via `cliModeService.chat` (`server/src/services/internal-agent/cli-mode.ts`). The model's decision to call `use_skill` happens *inside* that subprocess — there is **no in-process model to mock** for a genuine triggering test. This is the single most important constraint on the eval design (Task 6).
- **The routing lever is `description`.** `buildCompactSkillList` (`server/src/services/internal-agent/commander-skills.ts:46`) renders each enabled skill as a row `| **Name** (\`key\`) | <description>[ — Triggers: …] |` into the `## Available Skills` table, which is appended to the system context every turn (`agent-loop.ts:265-268`). `triggerPhrases` is also rendered but **dies in the marketplace catalog pipeline** (per the delivery investigation) — so `description` is the durable routing signal.
- **`buildCompactSkillList` caps the rendered rows at `COMPACT_MAX_CHARS = 4000`** (`commander-skills.ts:33-35`, `58-61`). 8 richer descriptions must stay within this budget (see Task 4 constraint).
- **The persona already carries the governance rules.** `assembleAgentPersona` (`server/src/services/internal-agent/commander-context.ts:17`) concatenates `AGENTS.md → SOUL.md → TOOLS.md → HEARTBEAT.md` from `server/src/onboarding-assets/commander/` into the system prompt. SOUL.md §3/§4/§5 already state the confirm-gate + memory-PENDING. The WS-1 preamble does **not** replace SOUL.md — it puts a compact, skill-scoped restatement adjacent to the skill list/loaded skill so individual skill bodies can stop repeating it. (Trimming the skill bodies is Task 5.)
- **`use_skill` reaches the model as an MCP tool.** Claude names MCP tools `mcp__<server>__<tool>` (`parse-stream-json.ts:274`), so over the AoA MCP surface `use_skill` arrives as `mcp__aoa__use_skill`. The `tool_call` chunk carries `{ name, input }` where `input.key` is the skill key (`parse-stream-json.ts:191-199`). The agent loop persists only `{ name }` for tool_call to `internal_agent_messages.toolCalls` (`agent-loop.ts:313-315`) — the fired skill **key** is only recoverable from the in-process chunk `input.key` or the `tool_result` summary (`Loaded skill: <name>…`). Any eval that asserts *which* skill fired must read one of those, not the persisted `name`.
- **An eval framework already exists** at `server/src/eval/` (`types.ts`, `runner.ts`, `run-all.ts`, `fixture-loader.ts`, plus 3 suites). It deliberately runs **classifier-proxy** suites (a cheap LLM makes the same decision the agent prompt asks for) rather than invoking the real runtime, "because that touches the agent runner, MCP bridge, DB, and adapter subprocess — none of which give a useful signal for prompt regression" (`adjutant-scope-readiness/suite.ts:8-13`). Task 6 extends this framework the same way.

---

## File Structure

### [product] AoA-2.5 (this worktree)

| File | Change | Responsibility |
|------|--------|----------------|
| `server/src/services/internal-agent/commander-preamble.ts` | **new** | Single source of truth: exported `COMMANDER_SKILL_PREAMBLE` constant + `SKILL_PREAMBLE_VERSION`. No logic. |
| `server/src/services/internal-agent/commander-skills.ts` | modify | `buildCompactSkillList` prepends the preamble above the `## Available Skills` table. |
| `server/src/services/internal-agent/tools/skill-tools.ts` | modify | `useSkillTool.execute` prepends the preamble to the returned skill `content`. |
| `server/src/__tests__/commander-preamble.test.ts` | **new** | Pure unit tests for the constant's required content. |
| `server/src/__tests__/commander-skills-compact.test.ts` | modify | Add assertions that the preamble is present and precedes the table. |
| `server/src/__tests__/use-skill-tool.test.ts` | modify | Add assertion that the returned `content` is preamble-prefixed. |
| `server/src/eval/commander-skill-triggering/suite.ts` | **new** | Classifier-proxy triggering suite (Tier 1). |
| `server/src/eval/commander-skill-triggering/skills-snapshot.json` | **new** | Snapshot of the 8 skills' `{key,name,description,triggerPhrases}` (content synced from AoA-Skills; **`key` is the RUNTIME seeder key `skill:aoa/<name>`** — what live Commander loads — not the repo source key `skill:aoa-curated/aoa-<name>`). `triggerPhrases` is required (may be `[]`) because `buildCompactSkillList` reads `.length` on it (see Task 6 B3 fix). Mirrors the `ui/src/aoa-marketplace-snapshot.json` pattern. |
| `server/src/eval/commander-skill-triggering/fixtures/*.json` | **new** | Naive-prompt → expected-skill-key corpus (10 cases). |
| `server/src/eval/run-all.ts` | modify | Register `buildCommanderSkillTriggeringSuite` in the aggregator. |
| `server/src/__tests__/commander-skill-triggering-suite.test.ts` | **new** | Pure unit tests: fixture loading, snapshot-drift guard, grade() logic (mocked fetch — no live LLM). |
| `server/src/__tests__/commander-skill-triggering.acceptance.test.ts` | **new** | Tier 2 live-runtime skeleton, gated `skipIf(isWin32 || !AOA_ACCEPTANCE_CLI)`. |

### [skills-repo] AoA-Skills

| File | Change | Responsibility |
|------|--------|----------------|
| `skills/brainstorm.md` … `skills/team-design.md` (all 8) | modify | Rewrite frontmatter `description` (WHEN-only). Add a `<!-- authoring -->` self-label line (rigid/flexible + degrees-of-freedom). Trim redundant confirm-gate/persona/memory restatements now covered by the product preamble. Cross-reference peer skills by name. |
| `AUTHORING.md` | **new** | The authoring-conventions doc (surface-agnostic tool refs, rigid-vs-flexible, cross-skill-by-name, one-excellent-example, shared-preamble contract, description rules). |
| `README.md` | modify | Update the Skills table descriptions to match the rewrites; link `AUTHORING.md` from Contributing. |

---

## Task 1 — [product] Shared Commander preamble constant (TDD)

**Files:**
- `server/src/services/internal-agent/commander-preamble.ts` (new)
- `server/src/__tests__/commander-preamble.test.ts` (new)

The preamble is a single constant so both injection sites (Task 1b, Task 2) import one source. It restates, compactly, the four things skills currently repeat: **persona/remit**, the **confirm-gate protocol** (the `⚡OPTIONS⚡` marker), **memory-is-PENDING** (CLAUDE.md Rule #6 — agents suggest, only the founder approves), and **routing guidance** (load the skill before improvising; reference peers by name). It is intentionally short (~120–160 words) because it is injected every turn and again on load.

- [ ] Write the failing test `server/src/__tests__/commander-preamble.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { COMMANDER_SKILL_PREAMBLE, SKILL_PREAMBLE_VERSION } from "../services/internal-agent/commander-preamble.js";

describe("COMMANDER_SKILL_PREAMBLE", () => {
  it("is a non-trivial single string", () => {
    expect(typeof COMMANDER_SKILL_PREAMBLE).toBe("string");
    expect(COMMANDER_SKILL_PREAMBLE.length).toBeGreaterThan(200);
    expect(COMMANDER_SKILL_PREAMBLE.length).toBeLessThan(1200); // injected every turn — keep tight
  });
  it("states the confirm-gate protocol with the OPTIONS marker", () => {
    expect(COMMANDER_SKILL_PREAMBLE).toContain("⚡OPTIONS");
    expect(COMMANDER_SKILL_PREAMBLE.toLowerCase()).toContain("confirm");
  });
  it("states memory is PENDING / suggest-only (Rule #6)", () => {
    expect(COMMANDER_SKILL_PREAMBLE.toLowerCase()).toContain("pending");
    // must NOT reference the phantom tool (Plan 1 removed it everywhere)
    expect(COMMANDER_SKILL_PREAMBLE).not.toContain("create_memory");
  });
  it("tells the model to load a skill before improvising and to reference peers by name", () => {
    expect(COMMANDER_SKILL_PREAMBLE.toLowerCase()).toContain("use_skill");
  });
  it("does not hardcode a surface-specific tool spelling beyond the surface-neutral use_skill", () => {
    // memory.write (MCP) and suggest_memory (Commander) are surface-specific — the
    // preamble must stay surface-agnostic (Decision: skills are surface-agnostic).
    expect(COMMANDER_SKILL_PREAMBLE).not.toContain("memory.write");
    expect(COMMANDER_SKILL_PREAMBLE).not.toContain("suggest_memory");
  });
  it("exposes a version string for cache-busting/telemetry", () => {
    expect(typeof SKILL_PREAMBLE_VERSION).toBe("string");
    expect(SKILL_PREAMBLE_VERSION.length).toBeGreaterThan(0);
  });
});
```
- [ ] Run it — expect failure (module missing):
```
cd server && npx vitest run src/__tests__/commander-preamble.test.ts
# Expected: FAIL — Cannot find module '../services/internal-agent/commander-preamble.js'
```
- [ ] Create `server/src/services/internal-agent/commander-preamble.ts`:
```ts
/**
 * The single shared Commander skill preamble.
 *
 * Injected in exactly two places — buildCompactSkillList (every turn, above the
 * skills table) and the use_skill tool return (at point-of-load) — so individual
 * skill bodies never restate the confirm-gate / persona / memory-PENDING rules.
 * Keep it SURFACE-AGNOSTIC: name only `use_skill` (identical on Commander + MCP);
 * never hardcode a Commander-only (`suggest_memory`) or MCP-only (`memory.write`)
 * tool spelling — the per-surface cheat-sheet resolves real names.
 *
 * Governance rules mirror SOUL.md §3/§4/§5 and CLAUDE.md Rule #6; the preamble is
 * the compact, skill-scoped restatement, not the source of truth.
 */
export const SKILL_PREAMBLE_VERSION = "1";

export const COMMANDER_SKILL_PREAMBLE = [
  "You are Commander — the always-on operator who helps every employee plan, run, and review their AI team's work. Speak in one clear voice; no lectures, no repeated caveats.",
  "",
  "Working rules that apply to every skill below (do not restate them back to the user):",
  "- Load before improvising: when a skill fits the request, call `use_skill` with its key and follow that skill's process instead of inventing your own.",
  "- Confirm gate: read operations run immediately, but before any write (create/update/assign/wakeup) show exactly what you will do and emit the `⚡OPTIONS:{\"confirm\": true}⚡` marker — even if the user said \"just do it\".",
  "- Memory is PENDING: suggesting a memory item creates a draft for founder approval. Never say it is \"saved\"; say \"I've suggested that for memory — it will appear in the Memory panel for approval,\" and don't chase the approval.",
  "- Reference sibling skills by name (e.g. \"load Sprint Planning\") — do not paste their contents.",
].join("\n");
```
- [ ] Run the test — expect pass:
```
cd server && npx vitest run src/__tests__/commander-preamble.test.ts
# Expected: PASS (6 tests)
```
- [ ] Commit: `feat(commander): add shared skill preamble constant`

---

## Task 2 — [product] Inject the preamble in `buildCompactSkillList` (TDD)

**Files:**
- `server/src/services/internal-agent/commander-skills.ts:46-79` (the `buildCompactSkillList` function; header array at `:65-75`)
- `server/src/__tests__/commander-skills-compact.test.ts` (extend)

The preamble goes in the header array, **before** `## Available Skills`, so it is not subject to the 4000-char `rows` cap (which only bounds the table rows). It must appear only when there is at least one skill row (the function already early-returns `""` for empty/failed cases — keep that).

- [ ] Add failing assertions to `server/src/__tests__/commander-skills-compact.test.ts` (inside the existing `describe`):
```ts
import { COMMANDER_SKILL_PREAMBLE } from "../services/internal-agent/commander-preamble.js";

it("prepends the shared preamble before the Available Skills header", async () => {
  const resolve = vi.fn(async () => [makeEntry()]);
  const result = await buildCompactSkillList({ companyId: "c1", agentId: "a1", resolve });
  expect(result).toContain(COMMANDER_SKILL_PREAMBLE);
  // preamble must come before the table header
  expect(result.indexOf(COMMANDER_SKILL_PREAMBLE)).toBeLessThan(result.indexOf("## Available Skills"));
});

it("omits the preamble entirely when there are no skills (still returns empty string)", async () => {
  const resolve = vi.fn(async () => []);
  const result = await buildCompactSkillList({ companyId: "c1", agentId: "a1", resolve });
  expect(result).toBe("");
  expect(result).not.toContain(COMMANDER_SKILL_PREAMBLE);
});
```
- [ ] Run — expect the two new tests to FAIL, the existing 6 to PASS:
```
cd server && npx vitest run src/__tests__/commander-skills-compact.test.ts
# Expected: 2 failing (preamble not present), 6 passing
```
- [ ] Edit `commander-skills.ts`: import the constant at the top of the file:
```ts
import { COMMANDER_SKILL_PREAMBLE } from "./commander-preamble.js";
```
- [ ] In `buildCompactSkillList`, change the returned header array (currently `commander-skills.ts:65-75`) to lead with the preamble:
```ts
    if (!rows.trim()) return "";
    return [
      COMMANDER_SKILL_PREAMBLE,
      "",
      "## Available Skills",
      "Call `use_skill` with the skill key to load full instructions before applying a skill.",
      "",
      "| Skill | When to use |",
      "|-------|------------|",
      rows.trimEnd(),
      overflow ? "\n_(additional skills configured — query with use_skill)_" : "",
    ]
      .join("\n")
      .trim();
```
- [ ] Run — expect all 8 to PASS:
```
cd server && npx vitest run src/__tests__/commander-skills-compact.test.ts
# Expected: 8 passing
```
- [ ] Verify the integration test still passes (it asserts `## Available Skills` + `use_skill` appear in the assembled prompt — both still true; the preamble is additive). Note it is `skipIf(win32)` so on Windows it reports as skipped, which is expected:
```
cd server && npx vitest run src/__tests__/commander-chat-foundation.integration.test.ts
# Expected: PASS on Linux/mac; SKIPPED on Windows (Issue #114) — either is green
```
- [ ] Commit: `feat(commander): inject shared preamble above the skills table`

---

## Task 3 — [product] Prepend the preamble to the `use_skill` return (TDD)

**Files:**
- `server/src/services/internal-agent/tools/skill-tools.ts:97-101` (the success return `data.content`)
- `server/src/__tests__/use-skill-tool.test.ts` (extend)

Rationale: the skills table (with its preamble) is in the system context, but a skill loaded mid-conversation may have scrolled out of the model's freshest window. The `use_skill` result is the freshest context at the moment the model acts on the skill, so the contract must ride along with the loaded body. Both sites import the one constant — no textual duplication in code; the mild same-turn duplication is deliberate (belt-and-suspenders at point-of-action, and the preamble is deliberately short).

- [ ] Add a failing assertion to `server/src/__tests__/use-skill-tool.test.ts` (in the existing `describe`):
```ts
import { COMMANDER_SKILL_PREAMBLE } from "../services/internal-agent/commander-preamble.js";

it("prepends the shared preamble to the returned skill content", async () => {
  const skill = {
    key: "brainstorming", name: "Brainstorming",
    description: "x", markdown: "# Brainstorming\nBody text here.",
  };
  const ctx = makeCtx([skill]);
  const result = await useSkillTool.execute({ key: "brainstorming" }, ctx);
  expect(result.success).toBe(true);
  const content = (result.data as { content: string }).content;
  expect(content).toContain(COMMANDER_SKILL_PREAMBLE);
  expect(content).toContain("# Brainstorming"); // original body preserved
  // preamble precedes the body
  expect(content.indexOf(COMMANDER_SKILL_PREAMBLE)).toBeLessThan(content.indexOf("# Brainstorming"));
});
```
- [ ] Run — expect FAIL for the new test, others PASS:
```
cd server && npx vitest run src/__tests__/use-skill-tool.test.ts
# Expected: 1 failing, existing passing
```
- [ ] Edit `skill-tools.ts`: import the constant, then change the success return (currently `:97-101`) so `content` is preamble-prefixed:
```ts
import { COMMANDER_SKILL_PREAMBLE } from "../commander-preamble.js";
// …
      return {
        success: true,
        data: {
          key: skill.key,
          name: skill.name,
          content: `${COMMANDER_SKILL_PREAMBLE}\n\n---\n\n${skill.markdown}`,
        },
        summary: `Loaded skill: ${skill.name}. Follow the instructions in 'content' for the rest of this conversation.`,
      };
```
- [ ] Run — expect all PASS. Confirm the `summary` string is unchanged (the Tier-2 acceptance harness keys off `Loaded skill: <name>`):
```
cd server && npx vitest run src/__tests__/use-skill-tool.test.ts
# Expected: all passing; "summary includes the skill name" still green
```
- [ ] Commit: `feat(commander): prepend shared preamble to use_skill result`

---

## Task 4 — [skills-repo] Rewrite all 8 skill `description`s to WHEN-only

**Files (AoA-Skills repo):** all under `skills/`
- `brainstorm.md:3`, `discussion-facilitation.md:3`, `identity-setup.md:3`, `investigate.md:3`, `office-hours.md:3`, `spec.md:3`, `sprint-planning.md:3`, `team-design.md:3`

The superpowers rule: **a `description` states WHEN to use the skill, in third person, and never summarizes the workflow** — a summary makes the model think it already knows the process and skip the body. Each rewrite is: `Use when <situation/intent>. <disambiguation: when NOT to use / which sibling to pick instead>.` No verbs describing the skill's steps ("interrogates", "produces", "breaks into", "recommends").

**Budget constraint:** `buildCompactSkillList` caps rendered rows at `COMPACT_MAX_CHARS = 4000` (`commander-skills.ts:33-35`). 8 rows share that budget, plus per-row chrome (~`| **Name** (\`key\`) |  |` ≈ 40 chars) and the appended `triggerPhrases`. Keep each `description` **≤ 320 chars**. Verification step below measures the total.

- [ ] Rewrite each description. Reference set (WHEN-only, third-person, with disambiguation):

  - `aoa-brainstorm`: `Use when someone has a raw or half-formed idea and wants it pressure-tested before any building starts — surfacing hidden assumptions and deciding whether it is worth doing at all. Not for shaping an already-decided idea into a task (use Spec) or for a strategic side-bet on a product feature (use Office Hours).`
  - `aoa-office-hours`: `Use when someone is weighing whether to pursue a side project, a new product feature, or a strategic bet and needs demand, user reality, and the narrowest wedge exposed before committing. Not for a general idea interrogation (use Brainstorm) or turning a chosen idea into work (use Spec / Sprint Planning).`
  - `aoa-spec`: `Use when someone has a decided change — a feature, fix, or task — and wants it written up as one backlog-ready, unambiguous item an agent can pick up. Not for still-uncertain ideas (use Brainstorm) and not for work that spans several tasks with dependencies (use Sprint Planning).`
  - `aoa-sprint-planning`: `Use when a goal or larger effort needs to be broken into several tasks with dependencies and agent assignments before anyone starts. Not for a single self-contained task (use Spec) or for deciding whether the effort is worth doing (use Brainstorm / Office Hours).`
  - `aoa-team-design`: `Use when someone is deciding which agents a company or project should have — roles, adapter types, and concurrency — usually while setting up or scaling. Not for assigning existing agents to a specific task (that is routine assignment, no skill needed).`
  - `aoa-identity-setup`: `Use when a new or unshaped company needs its vision, mission, and identity established in AoA. Not for editing a single existing identity field and not for department or agent structure (use Team Design).`
  - `aoa-investigate`: `Use when an agent run failed, a task is stuck or blocked, or an output is wrong and the cause is not yet understood — root-cause first, no fixes before the cause is found. Not for routine "what's the status" questions (a plain query answers those).`
  - `aoa-discussion-facilitation`: `Use when a discussion thread has accumulated conversation and someone wants the decisions, tasks, insights, and context pulled out and organized. Not for authoring one new task from scratch (use Spec).`

- [ ] Apply each as a single-line `description:` in the skill's frontmatter (line 3 of each file). Preserve `name`, `requires`, `key`.
- [ ] **Verification — no description summarizes a workflow.** From the skills-repo root, grep the frontmatter descriptions for imperative/summary verb stems that betray a workflow summary:
```
cd <aoa-skills> && for f in skills/*.md; do d=$(sed -n 's/^description: //p' "$f"); echo "$f :: $d"; done
# Manually confirm every line starts with "Use when" and contains no step verbs
# (produces/creates/breaks into/interrogates/recommends/guides through/extracts and organizes).
grep -nE '^description: (?!Use when)' skills/*.md || echo "OK: all descriptions start with 'Use when'"
grep -niE '^description:.*(produces|creates|breaks (it )?into|interrogat|recommends|guides|surfaces (assumptions|decisions).*and)' skills/*.md \
  && echo "REVIEW: possible workflow-summary verbs above" || echo "OK: no obvious summary verbs"
```
- [ ] **Verification — length budget.** Confirm no description exceeds 320 chars and the 8 together stay well under the 4000-char row budget:
```
cd <aoa-skills> && total=0; for f in skills/*.md; do d=$(sed -n 's/^description: //p' "$f"); n=${#d}; total=$((total+n)); echo "$n  $f"; [ "$n" -gt 320 ] && echo "  ^ OVER 320"; done; echo "sum(descriptions)=$total (budget 4000, plus ~40/row chrome ×8)"
# Expected: every line ≤ 320; sum comfortably < 3600
```
- [ ] **Verification — the fixed linter passes.** (Plan 1 de-inverted `validate.ts`; do not modify it here — just run it.)
```
cd <aoa-skills> && bun run validate:skills
# Expected: ✅ Validated N files — 0 tool name errors found.
```
- [ ] Update `README.md`'s Skills table so the one-line descriptions there match the rewrites (they should read as WHEN triggers, not summaries).
- [ ] Commit (skills repo): `refactor(skills): rewrite all descriptions to WHEN-only routing prose`

---

## Task 5 — [skills-repo] Authoring conventions + per-skill self-labels + body trim

**Files (AoA-Skills repo):**
- `AUTHORING.md` (new)
- all 8 `skills/*.md` (add self-label line; trim now-redundant boilerplate; cross-reference peers by name)
- `README.md` (link `AUTHORING.md` from Contributing)

### 5a — Write `AUTHORING.md`

- [ ] Create `AUTHORING.md` covering exactly these sections (each a short, prescriptive rule with a one-line example):
  1. **Descriptions are WHEN-only.** State when to reach for the skill and when NOT to; never summarize the steps. (Cross-link Task 4's rule; note it is the field that survives the marketplace pipeline.)
  2. **Tool references are surface-agnostic.** Prose describes *intent* ("suggest a memory item," "create the task"); real tool names come from the generated per-surface cheat-sheet (Plan 1 `tools.json`) — never hardcode a Commander (`suggest_memory`) or MCP (`memory.write`) spelling in a skill body. The only tool name safe to write verbatim is `use_skill` (identical on both surfaces).
  3. **The shared preamble is assumed, not restated.** Persona, the confirm-gate (`⚡OPTIONS⚡`), and memory-is-PENDING are injected once by the product (`commander-preamble.ts`). Skill bodies must not re-teach them — only reference the confirm gate at the specific step where a write happens.
  4. **Self-label rigidity + degrees of freedom.** Every skill declares near the top whether its process is **rigid** (follow verbatim — governance/order matters) or **flexible** (adapt to context), and how much latitude the operator has. Format: an HTML-comment tag the linter/humans can grep (see 5b).
  5. **One excellent example beats three mediocre ones.** Prefer a single fully-worked example (like `spec.md`'s spec template) over many partial ones.
  6. **Reference sibling skills by name, never eager-load.** Write "load Sprint Planning" — do not `@`-include or paste another skill's content. (Matches the product preamble rule and superpowers' cross-reference convention.)
  7. **Single-file for R1.** Multi-file progressive disclosure (`references/`, `scripts/`) is deferred until the `use_skill` product change lands (scope Decision #3) — keep each skill one file.
  8. **Validation is required.** `bun run validate` must pass; descriptions must not summarize a workflow.

### 5b — Self-label + trim each skill (one pass per file, all 8)

Do this in a single edit pass per file so bodies aren't touched twice.

- [ ] Add a self-label line immediately under the H1 of each skill, e.g. for `spec.md` (after `# AoA Spec`):
```
<!-- authoring: rigidity=flexible; degrees-of-freedom=high (skip questions already answered; adapt template) -->
```
  Assign each skill a rigidity per its nature — reference assignments:
  - `identity-setup`, `investigate`: `rigidity=rigid` (order/governance matters).
  - `spec`, `brainstorm`, `office-hours`, `sprint-planning`, `team-design`, `discussion-facilitation`: `rigidity=flexible`.
- [ ] Trim boilerplate now owned by the preamble. In each skill, **remove or condense** lines that restate: the persona, the generic "confirm before writes" rule, and "memory creates a PENDING draft / never say saved." Keep the **step-specific** confirm gate (e.g. `spec.md:71-72` Step 4 "emit `⚡OPTIONS…⚡`") — that is instructional, not boilerplate. Concretely, `spec.md`'s Rules line 89 ("Do NOT create the task before the user confirms…") stays (step-specific); a generic persona/memory paragraph, if present, goes.
- [ ] Replace any hardcoded Commander-only tool spelling in prose that the surface-agnostic rule forbids **only if it is describing intent** — leave the `## Prerequisites` "Tools used" cheat-sheet line as-is for R1 (it is the per-skill tool list; Plan 1 governs its generation). Do not invent new tool names.
- [ ] Ensure every cross-skill mention uses the skill's **name** (e.g. "Sprint Planning", "Office Hours"), matching the descriptions from Task 4.
- [ ] **Verification:** every skill has exactly one self-label; linter still green:
```
cd <aoa-skills> && grep -L 'authoring: rigidity=' skills/*.md && echo "^ any file listed above is MISSING a self-label" || echo "OK: all 8 self-labeled"
bun run validate
# Expected: no files missing labels; ✅ 0 tool name errors
```
- [ ] Commit (skills repo): `docs(skills): add AUTHORING.md + per-skill self-labels; trim preamble-owned boilerplate`

---

## Task 6 — [product] Lite skill-triggering eval

**Feasibility note (read first):** Because Commander routes inside a real CLI subprocess (see Context), there is no in-process model to unit-test. Two tiers, matching how the existing `server/src/eval` framework already handles subjective agent decisions:

- **Tier 1 (R1 deliverable) — classifier-proxy suite.** Render the *real* compact skill list (via `buildCompactSkillList` + the preamble + the rewritten descriptions, sourced from a synced snapshot) and ask a cheap LLM, at temperature 0, "which skill key would you `use_skill` for this prompt, or `none`?" Grade exact-match against the expected key. This is the honest analog of the 3 existing suites (`adjutant-scope-readiness/suite.ts:8-13` explains why the framework does *not* drive the real runtime), runs under `pnpm eval:run` with only `OPENAI_API_KEY`, and — because it renders the actual descriptions — **regresses when a Task 4 description regresses.**
  - **Honest scope of the signal (do not oversell):** this suite needs `OPENAI_API_KEY` (a paid secret CI does **not** provide), so `runAllEvalSuites` prints `[skipped]` and returns `[]` in CI (`run-all.ts:69-75`). Its ≥80% pass is therefore a **manual/local acceptance signal** an author runs before shipping description changes — it is **not CI-enforced**. What runs in CI is only the 6c mocked-fetch unit test (fixture-loading, snapshot-drift guard, B3 non-empty-table guard, grade() logic), which does **not** exercise live routing. The end-to-end routing guarantee is the local Tier-1 run + the gated Tier-2 acceptance test, not a green CI check.
- **Tier 2 (skeleton only) — live-runtime acceptance.** A `skipIf(isWin32 || !AOA_ACCEPTANCE_CLI)` test that drives the real `agentLoopService.chat()` and asserts a `use_skill` tool_call fired for the right key by inspecting the in-process `tool_call` chunk (`name` ends with `use_skill`, `input.key === expected`). This is the §17-style hard bar; provide the skeleton and 1 case, defer broad coverage to R2.

**Files:**
- `server/src/eval/commander-skill-triggering/skills-snapshot.json` (new)
- `server/src/eval/commander-skill-triggering/fixtures/*.json` (new, 10 cases)
- `server/src/eval/commander-skill-triggering/suite.ts` (new)
- `server/src/eval/run-all.ts:26-31,83-87` (register the suite)
- `server/src/__tests__/commander-skill-triggering-suite.test.ts` (new, pure — mocked fetch)
- `server/src/__tests__/commander-skill-triggering.acceptance.test.ts` (new, gated skeleton)

### 6a — Snapshot + corpus fixtures

- [ ] Create `skills-snapshot.json` — the 8 skills' `{key,name,description,triggerPhrases}`. **Content** (name/description) is copied from the Task-4 rewrites, but the **`key` is the RUNTIME seeder key `skill:aoa/<name>`** (what live Commander loads via `AOA_NATIVE_SKILLS`), NOT the repo source key `skill:aoa-curated/aoa-<name>`. The eval fires against the seeder, so it must match on the seeder key (cross-plan B2; Plan-1 Task 7's generator applies the `skill:aoa-curated/aoa-<name>` → `skill:aoa/<name>` mapping). `triggerPhrases` is **required** (use `[]`) because `buildCompactSkillList` reads `.length` on it and throws otherwise — a missing field is swallowed by the catch at `commander-skills.ts:76` and renders an EMPTY table (see B3 guard in 6c). Header comment documents it is synced from AoA-Skills. Shape:
```json
{
  "_comment": "Content synced from AoA-Skills skills/*.md frontmatter; keys are the RUNTIME seeder keys (skill:aoa/<name>). Update when descriptions change. Drift-guarded by commander-skill-triggering-suite.test.ts.",
  "skills": [
    { "key": "skill:aoa/brainstorm", "name": "Brainstorm", "description": "Use when someone has a raw or half-formed idea…", "triggerPhrases": [] }
    // …all 8
  ]
}
```
- [ ] Create 10 fixtures in `fixtures/` (naive prompts that never name the skill). Each is an `EvalCase` (`eval/types.ts:21`). Example `fixtures/01-vague-idea.json`:
```json
{
  "id": "01-vague-idea",
  "input": { "prompt": "I keep thinking we should build a Slack bot but I'm honestly not sure it's worth it", "userRole": "founder" },
  "expected": { "type": "exact", "value": "skill:aoa/brainstorm" }
}
```
  Corpus (id → prompt gist → expected key — all keys are the RUNTIME seeder form `skill:aoa/<name>`):
  1. `01-vague-idea` — "not sure it's worth building" → `skill:aoa/brainstorm`
  2. `02-side-bet` — "should we spin up this side project? who'd even use it" → `skill:aoa/office-hours`
  3. `03-write-it-up` — "turn this into a ticket the engineer can pick up" → `skill:aoa/spec`
  4. `04-break-down-goal` — "break this quarter's goal into work with dependencies" → `skill:aoa/sprint-planning`
  5. `05-who-on-team` — "what agents should we set up for this project?" → `skill:aoa/team-design`
  6. `06-new-company` — "help us set our company vision and mission" → `skill:aoa/identity-setup`
  7. `07-run-failed` — "our agent's run failed and I can't tell why" → `skill:aoa/investigate`
  8. `08-pull-decisions` — "pull the decisions and action items out of this thread" → `skill:aoa/discussion-facilitation`
  9. `09-blocked-task` — "this task has been stuck for two days, what's going on" → `skill:aoa/investigate`
  10. `10-plain-status` (negative case) — "how many tasks are in progress right now?" → `expected.value: "none"` (a plain query, no skill should fire)

### 6b — Tier 1 suite

- [ ] Create `suite.ts` following the `adjutant-scope-readiness/suite.ts` template (same `EvalSuite` contract, same OpenAI fetch shape, `response_format: json_object`, `temperature: 0`). Key differences:
  - `runOne(input)`: build the routing prompt by calling the real `buildCompactSkillList` with a `resolve` that returns the snapshot skills mapped to the shape `buildCompactSkillList` requires — `{ key, name, description, triggerPhrases: s.triggerPhrases ?? [] }` (the `?? []` guards the B3 empty-table trap even if a snapshot row omits the field). The model then sees the exact production table + preamble. Send system = "You are Commander's router. Given the Available Skills table and a user message, reply JSON `{\"key\": <skill key or 'none'>}` for the single skill you would `use_skill`, or 'none' if a plain query answers it." + user = the table + the prompt. Return `{ key }`. **Before returning, assert the rendered table is non-empty** (`if (!table.includes("## Available Skills")) throw new Error("empty skill table — snapshot shape regressed")`) so a shape regression fails loudly instead of silently grading every case as `none`.
  - `grade(actual, expected)` for `type: "exact"`: `pass = actual.key === expected.value` (both the key string and the literal `"none"`).
  - `name: "commander-skill-triggering"`, `concurrency: 5`.
- [ ] Register in `run-all.ts`: import `buildCommanderSkillTriggeringSuite`, add it to the `Promise.all([...])` at `:83-87` and the aggregation loop. The 0.8 `PASS_THRESHOLD` applies unchanged (LLM routing is noisy; 8/10 is the bar for R1).
- [ ] Run the suite (requires `OPENAI_API_KEY`; without it the harness prints `[skipped]` and returns `[]` per `run-all.ts:69-75`):
```
cd server && OPENAI_API_KEY=$OPENAI_API_KEY npx tsx src/eval/run-all.ts
# Expected: "PASS  commander-skill-triggering: ≥8/10 (≥80.0%)"
```

### 6c — Tier 1 pure unit tests (CI-safe, no live LLM)

- [ ] Create `commander-skill-triggering-suite.test.ts`:
  - **Fixture loading:** `buildCommanderSkillTriggeringSuite({ apiKey: "x", fetchImpl })` loads 10 cases; every `expected.value` is either `"none"` or one of the 8 snapshot keys.
  - **Snapshot-drift guard:** the snapshot contains exactly the 8 canonical RUNTIME keys (hardcode the list: `skill:aoa/brainstorm`, `skill:aoa/office-hours`, `skill:aoa/spec`, `skill:aoa/sprint-planning`, `skill:aoa/team-design`, `skill:aoa/identity-setup`, `skill:aoa/investigate`, `skill:aoa/discussion-facilitation`) — fails loudly if a skill is added/removed without updating the snapshot.
  - **B3 non-empty-table guard (guards the false-green):** render `buildCompactSkillList` over the snapshot (via the same resolve the suite uses) and assert the result is non-empty, contains `## Available Skills`, and includes at least one snapshot skill row (e.g. `` `skill:aoa/brainstorm` ``). This fails if a snapshot entry drops `triggerPhrases` (the `.length` throw → swallowed catch → empty table that would otherwise grade every case as a silent `none`).
  - **grade() logic:** with a stubbed `fetchImpl` returning `{choices:[{message:{content:'{"key":"skill:aoa/spec"}'}}]}`, a case expecting `skill:aoa/spec` grades `pass:true`; a mismatch grades `pass:false`. (Mirrors `adjutant` grade tests — no network.)
- [ ] Run:
```
cd server && npx vitest run src/__tests__/commander-skill-triggering-suite.test.ts
# Expected: PASS
```

### 6d — Tier 2 acceptance skeleton (gated)

- [ ] Create `commander-skill-triggering.acceptance.test.ts` modeled on `aoa-realoutput.integration.test.ts:29-31,61`:
  - Guard: `describe.skipIf(process.platform === "win32" || !process.env.AOA_ACCEPTANCE_CLI)`.
  - Setup (`beforeAll`): `createDb(DATABASE_URL)`; create a company; `ensureCommanderAgent(db, companyId)`; insert the 8 `companySkills` rows (or the one under test) and set the Commander agent's `skillKeys` to include the target key (so `listCompactSkillEntries` and the `use_skill` enablement gate at `skill-tools.ts:73-95` both pass); configure the agent adapter `claude_local` (as `aoa-realoutput` does at `:116-127`).
  - The one case: drive `agentLoopService(db).chat({ companyId, userId, userRole:"founder", content:"turn this into a ticket the engineer can pick up", enabledCapabilities:[] })`, collect chunks, and assert:
```ts
const skillCalls = chunks.filter(
  (c) => c.type === "tool_call" && /(?:^|_)use_skill$/.test(c.name),
);
expect(skillCalls.length).toBeGreaterThan(0);
const keys = skillCalls.map((c) => (c.input as { key?: string })?.key);
expect(keys).toContain("skill:aoa/spec"); // RUNTIME seeder key — what the loaded skill fires as
```
  - Add a header comment: this is the §17-style hard bar (real CLI + real DB), non-deterministic, and asserts on the in-process `tool_call` chunk `input.key` (equivalently the `use_skill` `tool_result` summary `Loaded skill: <name>` at `tools/skill-tools.ts:100`) because the persisted `internal_agent_messages.toolCalls` stores only the tool `name`, not the skill key (`agent-loop.ts:313-315`) — never assert against the persisted `toolCalls`. Broad corpus coverage deferred to R2.
- [ ] Confirm it SKIPS cleanly without the env (this is the expected CI state):
```
cd server && npx vitest run src/__tests__/commander-skill-triggering.acceptance.test.ts
# Expected: SKIPPED (no AOA_ACCEPTANCE_CLI / Windows) — green
```
- [ ] Commit: `test(commander): lite skill-triggering eval (classifier-proxy suite + acceptance skeleton)`

---

## Self-Review

**Spec coverage vs scope §5 WS-1 (four bullets):**
1. *"Rewrite all skill `description`s to WHEN-only + embed routing/disambiguation prose"* → **Task 4** (all 8, ≤320 chars, disambiguation embedded, README synced, linter + no-summary greps as acceptance).
2. *"Shared Commander preamble injected in `buildCompactSkillList` / `use_skill` return (one place)"* → **Tasks 1–3** (one constant in `commander-preamble.ts`; injected at both sites; TDD).
3. *"Rigid/flexible + degrees-of-freedom labels; cross-skill reference convention"* → **Task 5** (`AUTHORING.md` codifies; per-skill `<!-- authoring: rigidity=… -->` self-label; cross-reference-by-name enforced).
4. *"Lite skill-triggering eval harness (naive prompt → assert `use_skill` fired for the right key)"* → **Task 6** (Tier 1 classifier-proxy suite in the existing framework + Tier 2 live-runtime acceptance skeleton).

**Cross-plan contract:** consumes Plan 1's `tools.json` + per-surface cheat-sheets + de-inverted `validate.ts` (Tasks 4/5 run the fixed linter; never re-fix it). Authoring rule #2 in `AUTHORING.md` is the surface-agnostic tool-reference rule the contract requires.

**Placeholder scan:** no `TODO`/`TBD`/`<placeholder>` in code steps. Every code block is complete; every command has an expected-output line. The one deliberately-abbreviated artifact is the 8-entry `skills-snapshot.json` / fixture corpus, fully specified by the id→prompt→key table (mechanical to type out).

**Name consistency:** `COMMANDER_SKILL_PREAMBLE` + `SKILL_PREAMBLE_VERSION` (`commander-preamble.ts`); suite name `commander-skill-triggering`; **the eval asserts on the RUNTIME seeder key `skill:aoa/<name>`** (what live Commander loads), not the repo source key `skill:aoa-curated/aoa-<name>` (source-only, mapped by Plan-1 Task 7's generator) — cross-plan B2; `use_skill` (surface-neutral) is the only hardcoded tool name; MCP-surfaced as `mcp__aoa__use_skill` (matched by regex in Tier 2). SOUL.md §-numbers and CLAUDE.md Rule #6 referenced consistently for the governance-rule provenance.

**Verification philosophy:** product tasks are TDD (failing test → implement → pass → commit); skills-repo tasks use verification steps (fixed `validate.ts`, no-summary grep, length-budget grep, self-label grep). The Tier-1 eval passing at ≥80% is a **local/manual** end-to-end acceptance signal for the description routing — it is CI-skipped (needs the paid `OPENAI_API_KEY`; `run-all.ts:69-75`), so it does **not** gate merges; the only CI-enforced coverage is the 6c mocked-fetch unit test (which does not exercise live routing). Don't read a green CI as proof the descriptions route.

**Known seams / risks flagged for the reviewer:**
- **`skills-snapshot.json` can drift** from the AoA-Skills descriptions (two repos). Mitigated by the drift-guard unit test (key set) + a `_comment`. Plan-1 Task 7's `AOA_NATIVE_SKILLS` generator is the real fix — once landed, this snapshot becomes an output of that generator (same source), not a hand copy; reconcile at integration.
- **4000-char row budget** — 8 richer descriptions could crowd `COMPACT_MAX_CHARS`; Task 4 caps each at 320 chars and measures the sum. If a future skill count grows, bump `COMPACT_SKILL_LIST_MAX_TOKENS` (`commander-skills.ts:33`) rather than truncating descriptions.
- **Preamble same-turn duplication** when a skill loads (present in both the table and the `use_skill` result) is intentional and cheap (~150 words); called out so a reviewer doesn't "fix" it into a single site.
