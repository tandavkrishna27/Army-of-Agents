# Crew Execution + Marketplace Provisioning + Viewer Completion — Master Plan

> **Status:** Decisions locked with the product owner 2026-07-19, extended and **corrected against source 2026-07-23**. This is the single scope document for all three phases.
>
> **Executable detail:** Phase 1 has a task-level TDD plan in `2026-07-19-crew-execution-phase1-foundation.md` (v2). Phases 2 and 3 are specified here at task level and get their own TDD plans when reached.
>
> **Branch:** everything lands on `feat/viewer-upgrade`, one worktree (D24).

**Context.** The Viewer Upgrade (Phases 0–7B) shipped and is rebased on main. Live testing proved the viewer works on Commander, but the Discussions and Workspace halves could not be verified end-to-end because **crew agent execution is broken in several stacked ways**. This plan fixes that, delivers the marketplace-driven provisioning model, and finishes the viewer.

---

## Correction notice (2026-07-23)

The first version of this document was written from a partial reading and **got the marketplace badly wrong**. Every claim below has now been verified against source and the live catalog. The single largest error:

> **P9 said "the catalog content doesn't exist yet." That is false.**
> `MeteoriteLabs/aoa-marketplace` has `content/agents/` (11 agents), `content/teams/default-crew/`, and `content/skills/`. The CDN publishes **514 items — 498 skills, 11 agents, 4 plugins, 1 team** (regenerated 2026-07-23T04:06Z). All **42 declared agent→skill dependencies resolve** against the published catalog, zero missing. The bundled fallback `ui/src/aoa-marketplace-snapshot.json` is a byte-identical copy (1,544,503 bytes) containing the team and all agents, so offline bootstrap already works.

Phase 2 is therefore **wiring, not authoring**. The update machinery is likewise already built and running — see P8 below for the single line that disables all of it.

---

## Locked decisions

### Original (2026-07-19)

| # | Decision |
|---|---|
| D1 | **Priority: crew-execution hardening first**, then marketplace provisioning, then viewer completion. |
| D2 | **Viewer is view-only.** In-place editing is out of scope. |
| D3 | **Build Office rendering** (docx/xlsx/pptx). Google Docs/Sheets deferred. |
| D4 | **Marketplace = first-install provisioning.** Company creation installs the crew FROM the marketplace; the company then owns its copy and can modify it. |
| D5 | **Agents ship as complete packages** — agent + skills + instruction files together. |
| D6 | **The agent template is the source of truth** for an agent's skills (`agent.json` → `skillKeys`). To change them, edit the marketplace repo + bump the catalog. |
| D7 | **The company skill library is OPEN** — any GitHub/URL source plus the AoA marketplace. No curation gate at the library level. |
| D8 | **Curation is at the crew-agent level.** Only meaningful if per-agent `skillKeys` is ENFORCED (P4). |
| D9 | **Isolation:** crew agents see only AoA-provisioned skills scoped to that agent — nothing from the host machine's `~/.claude`. |
| D10 | **Update conflicts:** notify + explicit choice/merge. Uncustomized items may auto-update. |
| D11 | **CDN failure:** bundled snapshot fallback — company creation never blocks on network. ✅ *verified working*. |
| D12 | **Default crew = today's crew** ported to marketplace packages (behaviour parity). |
| D13 | **Greenfield** — no existing users. No migration burden, but must land enterprise-grade. |
| D14 | **Catalog authoring is ours.** ✅ *write access confirmed to both `aoa-marketplace` and `aoa-marketplace-cdn`.* |

### Added 2026-07-23

| # | Decision |
|---|---|
| **D15** | **Isolation ships crew-only first.** The non-hermetic bug affects org agents too, but the fix opts in for crew and expands to org only behind an explicit gate (Phase 1 T11). Org agents work today; do not break them chasing a crew bug. |
| **D16** | **Instruction isolation is two-tier.** The operator's global `~/.claude` (hooks, plugins, user skills) is **blocked**. The workspace repo's `CLAUDE.md` is **allowed** — it is legitimate engineering context. AoA's own instructions ride `--append-system-prompt-file`, so they outrank `CLAUDE.md` on conflict by construction. |
| **D17** | **Crew skills are purpose-built per agent — NOT Commander's set.** Commander's skills (brainstorm, sprint-planning, team-design, office-hours) are Commander's job. Each crew agent gets its own declared set, drawn from public skills or authored by us. |
| **D18** | **All crew roles get skills.** Chronicler, Memory Keeper and Navigator currently declare zero and need authoring. |
| **D19** | **D2 stands — viewer is view-only.** Editing is a follow-up initiative, not part of Phase 3. |
| **D20** | **All crew provisioned via the marketplace.** Steward is packaged. **Scribe is NOT** — it is being retired (`companies.ts:118-127`: extraction moved to Memory Keeper + Adjutant tool calls; `ensureExtractionAgent` retained only for env-gated rollback). **Commander stays locally seeded** — it is the internal agent, provisioned inside `svc.create()` before skills exist, with `internalAgentConfig.agentId` pointing at it. |
| **D21** | **The crew team is decoupled from departments.** `teams.parentProjectId` becomes nullable for company-wide teams and `installTeam`'s precondition is relaxed. AoA crew are company-wide singletons; parenting them to a department is semantically wrong and cascade-deletes them with it. |
| **D22** | **Agent instruction edits are treated like skills** — `customized` flag + notify/diff/merge. **This reverses the current design** (`crew-updater.ts:24-31`: *"instruction files are app code, not user config"*, full replacement, no preservation). Rationale: D4 says the company owns its copy, and the product ships an agent-instructions editor — silently discarding a founder's edit on the next catalog bump is not acceptable. **Cost:** P10 becomes *build* the agent diff/merge path, not merely unblock it. |
| **D23** | **Protected origins.** A server-side set of template origins that uninstall refuses (Steward, Commander). Whether an agent is essential to AoA is an AoA fact, not catalog metadata — no schema bump, enforced where it matters. |
| **D24** | **One branch, one worktree** — `feat/viewer-upgrade` carries all three phases. |

---

## Verified problem inventory

Every row below was re-checked against source on 2026-07-23. Anchors are exact.

### Group A — Crew execution *(blocks Discussions + Workspace end-to-end)*

| ID | Problem | Verified at |
|---|---|---|
| **P1** | **Crew runs discard ALL logs.** `onLog`/`onMeta` are literal no-ops, so crew failures are undiagnosable. Org/heartbeat runs DO persist transcripts. | `aoa-agents/runner.ts:569` |
| **P2** | **Crew runs are not hermetic.** The operator's global `~/.claude` (SessionStart hooks, gstack/superpowers skills, plugins) leaks in and hijacks the agent. Managed HOME is docker-only; on Windows claude resolves config via `USERPROFILE`/`CLAUDE_CONFIG_DIR`, neither set; env is full `process.env`. **Affects org agents too.** | `execution-target.ts:816-820`, `execute.ts:177,251,402-404`, `login.ts:15` |
| **P3** | **Crew agents receive NO skills at runtime.** The crew runner never sets `context.skills`. `listRuntimeSkillEntries` has exactly one caller (heartbeat/org), and crew is barred from the heartbeat. | `runner.ts:560-571`, `heartbeat.ts:4003-4013,5265-5275` |
| **P4** | **`skillKeys` scoping is UNENFORCED for crew.** `use_skill` gates on `skillKeys` only when `actorType === "commander"`; the crew bridge presents `"board"`. Combined with D7's open library, a crew agent can invoke a skill installed from an arbitrary GitHub repo. **This is the security boundary of the whole design.** | `skill-tools.ts:90-112`, `mcp-bridge.ts:291`, `runner.ts:337-354` |
| **P4b** | **The bridge applies Commander policy to every actor.** `createToolCallHandler` calls `resolveCommanderToolPolicy` unconditionally, while tool *listing* correctly gates it — so crew tools get advertised then rejected. | `mcp-bridge.ts:143` vs `tool-registry.ts:199` |
| **P5** | **Crew runs fail to complete** — the agent finishes without calling `set_task_status`; the run is marked failed and a failure card posted. A clean config alone did not fix it. **Undiagnosable until P1 lands.** | `runner.ts:644` |
| **P6** | Dispatch/re-run is fragile — crew wakeups enqueue only on specific transitions; re-running a failed task required unassign→reassign. | `dispatcher.ts:277` |
| **P7** | **The crew Skills tab is a no-op.** The UI says *"Skills injected into this agent's context on every run"*, but nothing is delivered (P3) and nothing is enforced (P4). | `AgentSkillsTab.tsx:273-275` |
| **P7b** | **Crew agents have no workspace.** The crew runner never sets `context.paperclipWorkspace`; heartbeat resolves it. A scratch cwd also breaks Claude session resume, which requires an identical cwd. | `heartbeat.ts:1549→3628`, `execute.ts:450` |
| **P7c** | **`skillKeys` defaults `[]` and crew seeding never sets it** — so P3's delivery *and* P4's enforcement are both dead on arrival. `listRuntimeSkillEntries` early-returns on empty. | `agents.ts:43`, `seed-crew-agent.ts` (no mention), `company-skills.ts:2213` |

### Group B — Marketplace provisioning

| ID | Problem | Verified at |
|---|---|---|
| **P8** | **Company creation never installs the marketplace crew** — it runs the legacy seeders, which stamp `templateOrigin` `…@legacy`. **The updater then skips those rows forever:** `if (!agent.templateOrigin \|\| agent.templateOrigin.endsWith("@legacy")) continue;`. **This one line disables the entire improvement pipeline** — detection, notification, auto-apply, diff and merge are all built and idle. | `companies.ts:170-183`, `backfill-template-origin.ts:55`, `crew-updater.ts:151` |
| **P8b** | **`installTeam` hard-requires a department that does not exist.** Validated at install; used as `teams.parentProjectId`, which is `notNull()` with `onDelete: cascade`. Nothing creates a department at company create or during onboarding. → D21. | `team-installer.ts:81-84,276`, `teams.ts:12` |
| **P8c** | **The marketplace gate can never fire at create time.** It checks for a non-`@legacy` agent *before* any install could have run, so it always falls through to the legacy seeders. | `companies.ts:135-147` |
| **P8d** | **`ensureAllCrewAgents` is all-or-nothing.** Every caller skips the *entire* function when marketplace-managed — and Steward **and Commander** are inside it. Flipping to marketplace install silently stops seeding both. | `ensure-all-crew.ts:52-67`, `index.ts:796-800`, `internal-agent.ts:139-140` |
| ~~P9~~ | ~~Catalog content doesn't exist~~ — **FALSE, withdrawn.** See the correction notice. | — |
| **P10** | **Agent-template updates are a closed loop.** `/apply` returns 501 *"use POST /updates/:id/merge"*; `/merge` returns 404 *"not a skill"*; `/diff` returns 400 *"section diff only supported for skill updates"*. The Review button leads nowhere. Under D22 this becomes **build the agent diff/merge path**. | `marketplace-company.ts:281,386,~300` |
| **P11** | **`conflict` status is dead.** Read in three places; **written nowhere** in marketplace code. | reads: `marketplace-company.ts:154`, `UpdateCard.tsx:37`, `MarketplaceUpdatesPanel.tsx:40` |
| **P12** | **Merge does not re-materialize bundled skill files.** `marketplace-company.ts` never calls the materializer; only `skill-installer` and `skill-auto-updater` do. A reviewed merge rewrites markdown and leaves bundled files stale. | `skill-bundle-materializer.ts:40` callers |
| **P13** | **The non-catalog (github/url) install path blind-overwrites a customized skill.** The catalog path guards `customized` with an optimistic lock; the installer has no such check. | `skill-auto-updater.ts:100-133` vs `skill-installer.ts` |
| **P13b** | **Three crew agents declare zero skills** — Chronicler, Memory Keeper, Navigator. Plus Steward once packaged. → D18. | catalog `requires` audit |

### Group C — Viewer completion

| ID | Problem |
|---|---|
| **P14** | **Office formats (docx/xlsx/pptx) don't render** — they fall through to the "Preview unavailable → Open" download fallback. (D3.) |
| **P15** | Code viewer has **no syntax highlighting** (plain `<pre>`). |
| **P16** | CSV parser is a **naive comma-split** — breaks on quoted and embedded-comma fields. |
| **P17** | **Inline-preview coverage is inconsistent** — Discussions rich (inline + expand), Workspace image-only, Commander chip-only. |
| **P18** | Google Docs/Sheets unsupported — **deferred** (D3). |
| **P19** | Discussion entry attachments require composer-validated uploads, blocking programmatic attach (minor). |

### Group D — Verified NOT problems
- **Crew Board is correctly wired** to real data (`taskScope:"crew"` + live pills + slide-over). It renders empty only because no crew task completes (Group A).
- **The update pipeline exists and runs** — `checkCrewUpdates` at boot + every 24h (`index.ts:888`), auto-apply within window or notify-with-dedupe. It is disabled solely by P8.
- **Offline bootstrap works** — the bundled snapshot is current and complete (D11).
- **Trigger kinds are free-text and materialized verbatim**, so Steward's sweep trigger packages cleanly (`agent-create.ts:100-106`).
- Server-reaping during testing was environmental (sandbox), not product.

### Roster reconciliation

Local `ensureAllCrewAgents` seeds: Commander, Navigator (key `router`), Planner, Memory Keeper, Adjutant, Scout, Engineer, Chronicler, Steward, Librarian. Scribe is seeded lazily by the dispatcher, outside the gate.

Marketplace `default-crew` installs 9: Adjutant, Scout, Engineer, Navigator, Planner, Memory Keeper, Chronicler, **Reviewer**, Librarian.

| Agent | Resolution |
|---|---|
| **Reviewer** | Marketplace-only today. Critique-only, mention-triggered, advises but never approves or mutates. **Adopt** — additive, declares `gstack/review` + `coderabbitai/code-review`. |
| **Steward** | Local-only. Inbox Hub curation, two tools, sweep-triggered. **Package it** (D20). |
| **Scribe** | Local-only, being retired. **Do not package** (D20). |
| **Commander** | **Stays locally seeded** (D20). |

---

## Phase 1 — Crew execution foundation

Fixes P1, P2, P3, P4, P4b, P5, P7b, P7c; makes P7 honest. **Executable task-level plan: `2026-07-19-crew-execution-phase1-foundation.md` (v2).**

Eleven tasks in order: crew run transcripts (redacted) → ambient Claude-config isolation → per-run config home provisioning → instruction-isolation policy (D16) → crew workspace resolution → skill delivery → skill assignment/backfill → actor identity + bridge policy → `skillKeys` enforcement → completion diagnosis → completion gate + docs.

**Exit criteria:** a crew agent runs; its transcript persists; it sees no operator hooks or skills; it sees only skills attached to it; it completes a task and moves it; and it delivers refs into its originating thread.

**Note on T7 under D17.** Phase 1 assigns **no default skills** — that is not a regression (crew agents get zero today) and it *does* close P4's hole. What Phase 1 must deliver is the **founder-assigned path working end-to-end**: a skill attached in the Skills tab is delivered and enforced. Real per-agent defaults arrive in Phase 2 from the agent templates, per D6.

---

## Phase 2 — Marketplace provisioning

Fixes P8, P8b, P8c, P8d, P10, P11, P12, P13, P13b.

### T2.1 — Decouple the crew team from departments (D21)
Make `teams.parentProjectId` nullable via Drizzle (`pnpm db:generate` — never raw SQL). Relax `installTeam`'s precondition so a company-wide team installs with no `targetDepartmentId`; keep the department path working for genuine department-scoped team installs. Preserve the route-level 400 for *user-initiated* team installs that omit a department — only the bootstrap path may omit it.
**Test:** installTeam succeeds with `targetDepartmentId: null` and writes a `teams` row with null parent; department-scoped install still parents correctly; deleting a department does not cascade the company-wide crew away.

### T2.2 — Narrow the crew-seeding gate (P8d)
Split `ensureAllCrewAgents` into crew seeders and infrastructure seeders (Commander, Steward until T2.4). `isCrewMarketplaceManaged` suppresses only the crew half. **This must land before T2.3** or flipping provisioning silently drops Commander and hub curation.
**Test:** with a marketplace-managed company, crew seeders are skipped and infrastructure seeders still run.

### T2.3 — Install the crew at company creation (P8, P8c)
Call `installTeam("team:aoa-curated/default-crew")` from company create, using the live catalog with the bundled snapshot as fallback (D11). Never block or fail creation on network. Remove the now-unreachable pre-install gate check.
**Test:** a new company has 9 crew agents with real `agent:aoa-curated/…` origins, non-null `templateVersion`, and populated `skillKeys`; with the network stubbed out, the snapshot path produces the same roster.

### T2.4 — Author + publish the missing packages (P13b, D18, D20)
In `aoa-marketplace`: author the **Steward** agent package (instructions from `ensure-steward.ts:4` + `onboarding-assets/steward/`, sweep trigger, tool allowlist). Declare skills for **Chronicler, Memory Keeper, Navigator** and Steward. Regenerate `catalog.json`, publish to `aoa-marketplace-cdn`, and refresh `ui/src/aoa-marketplace-snapshot.json` via `pnpm fetch-catalog`. Add Steward to `default-crew`'s roster and `installOrder`. **PRs in both repos.**
**Test:** every agent's declared skills resolve against the published catalog (the 42→N dependency audit, re-run as a check).

### T2.5 — Protected origins (D23)
A server-side set of template origins that agent- and team-uninstall refuse. Covers Commander and Steward.
**Test:** uninstalling a protected agent returns a clear refusal; uninstalling any other marketplace agent still works.

### T2.6 — Agent-instruction customization tracking (D22)
Set `customized` when a founder edits a marketplace-managed agent's instructions through the editor. Reverse `crew-updater`'s full-replacement for customized agents: uncustomized still auto-applies; customized routes to notify. **Record the reversal in `docs/architecture/decisions.md`** — this supersedes the "instructions are app code" decision at `crew-updater.ts:24-31`.
**Test:** an edited agent is not silently overwritten by a catalog bump; an untouched agent still auto-updates.

### T2.7 — Build the agent diff/merge path (P10, P11)
Extend `/updates/:id/diff` and `/updates/:id/merge` to `itemType: "agent"` with section-level diffing over instruction files. **Write the `conflict` status** that the UI already reads in three places, so divergence surfaces before the founder opens Review.
**Test:** an agent update with a customized local copy produces a section diff, accepts keep-mine/accept-upstream per section, and lands a `conflict` badge on the card.

### T2.8 — Bundle re-materialization on merge (P12)
Call the materializer from the merge path so bundled skill files are refreshed alongside markdown.
**Test:** after a merge, bundled files on disk match the upstream commit.

### T2.9 — Guard the non-catalog install path (P13)
Apply the same `customized` check + optimistic lock that `skill-auto-updater` uses to the github/url install/reinstall path.
**Test:** reinstalling over a customized skill notifies instead of overwriting; an uncustomized skill still updates.

**Exit criteria:** creating a company installs the crew from the marketplace (snapshot fallback proven by stubbing the network); each agent carries its declared skills; an upstream agent or skill change flows down through detect → notify → diff → merge without discarding founder edits; protected agents cannot be uninstalled.

---

## Phase 3 — Viewer completion

Fixes P14, P15, P16, P17. Editing (D19) and Google (D3) explicitly deferred.

### T3.1 — Office rendering (P14, D3)
Render docx, xlsx and pptx in `SharedContentViewer` rather than falling through to download. Choose renderers that work **fully offline and bundle-inlined** — no CDN fetch, consistent with the artifact CSP posture. Keep the download affordance.
**Test:** each format renders; a corrupt file degrades to the existing fallback rather than throwing.

### T3.2 — Syntax highlighting (P15)
Replace the plain `<pre>` code path with highlighting, language inferred from extension, with a graceful unknown-language fallback.

### T3.3 — Correct CSV parsing (P16)
Replace the naive comma-split with a real parser: quoted fields, embedded commas, embedded newlines, escaped quotes, CRLF.
**Test:** a fixture covering all five cases.

### T3.4 — Consistent inline previews (P17)
Bring Workspace (image-only) and Commander (chip-only) up to the Discussions standard — inline preview plus pop-to-viewer — through the shared hybrid card, so the three surfaces behave identically.

### T3.5 — Full multi-surface live verification
Execute `2026-07-19-viewer-upgrade-live-test-plan.md` end-to-end on an isolated instance, now unblocked by Phase 1. Every file type, all three surfaces, both halves (in-place card and opened viewer).

**Exit criteria:** every supported file type renders correctly on Commander, Discussions and Workspace, including Office documents, verified live rather than by unit test alone.

---

## Sequencing rationale

**P1 first is non-negotiable** — P5 cannot be diagnosed without transcripts, and no isolation or scoping change is verifiable while the agent's behaviour is invisible. P2 before P3/P4 because a leaking environment invalidates any skill-scoping test.

**Phase 2 after Phase 1, not during.** The provisioning switch changes which agents exist, where their instructions come from, and what skills they carry — simultaneously. Flipping it while crew runs still fail and discard their logs means every failure has two candidate causes that cannot be distinguished. With Phase 1's transcripts in hand, the switch becomes verifiable.

**Within Phase 2, T2.1 and T2.2 gate T2.3.** Without T2.1 there is no department to install into; without T2.2 the install silently drops Commander and Steward.

**Phase 3 is independent** of both and could run in parallel given capacity — except T3.5, which needs Phase 1 to complete a crew run.

---

## Known unknowns, stated plainly

- **P5's root cause is unknown** until a transcript exists. Phase 1 T10 diagnoses and classifies before changing anything; no speculative fix.
- **The `CLAUDE_CODE_DISABLE_*` flags were assumed, not verified.** D16 allows repo `CLAUDE.md`, so they are no longer load-bearing — but if any instruction-blocking is ever needed, the flag names must be confirmed against the installed binary first.
- **Credential storage is file-based on Windows** (live-verified: a config dir containing only `.credentials.json` authenticated and loaded no operator hooks or skills). This must be re-checked per platform before isolation ships beyond Windows.
- **D22 reverses a shipped design decision.** If the agent diff/merge path proves disproportionately expensive, the fallback is D22's option 3 — still replace, but snapshot the prior version and notify — which preserves the founder's work without building a full differ.
