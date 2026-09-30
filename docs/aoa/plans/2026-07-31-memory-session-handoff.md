# Session Handoff — Enterprise Memory + Agent-Delivery (2026-07-31)

> **2026-08-02 status update (supersedes stale branch/blocker details below):**
> The branch is rebased onto current `origin/main`; the migration collision was
> resolved by regenerating replay-safe `0188_clammy_lightspeed`. Full monorepo
> typecheck and production build pass, as do the targeted regression suites and
> 10/10 embedded-Postgres memory RBAC gates. Formal review fixes are applied for
> Memory Settings authorization/auditing, atomic upsert and department deletion,
> identity edit/clear reconciliation, MCP founder-escalation prevention, Crew
> fail-closed retrieval, and managed-only Claude MCP permission. The monolithic
> Windows test command remains non-authoritative: parallel execution hit resource
> contention and a serial run exceeded 15 minutes in optional/live suites. Linux
> PR CI is the remaining merge gate. The pre-rebase tip is preserved locally as
> `backup/memory-enterprise-build-pre-rebase-20260802`.

Hand-off for a fresh agent picking up the enterprise "company brain" memory work.

## 0. TL;DR

- **Branch:** `claude/memory-enterprise-build` @ `a2523a7f2` — clean tree, **25 commits, UNPUSHED, not merged**.
- **Worktree (the code):** `C:\Users\TK\.aoa\wt\mem` (a short-path worktree — NOT the session's `.claude/worktrees/*` worktree, which is the design branch with no code).
- **What shipped:** enterprise memory model (P0–P1: risk-tiered autonomy, RBAC-in-SQL, always-on core, identity backfill, Settings) **+ proof that company memory now reaches all three agent types** (Org, Commander, Crew) via live testing.
- **Headline:** the **ORG** memory-delivery path needed a real **5-layer fix** (all committed); **Crew + Commander work as-is** once those fixes existed.
- **Not done:** rebase onto `main` (migration collision + divergence), full typecheck + full test suite, push → Linux CI, formal code review.

## 1. Worktree & branch topology — READ FIRST (this trips everyone up)

| Path | Branch | Role |
|---|---|---|
| `C:\Users\TK\.aoa\wt\mem` | `claude/memory-enterprise-build` | **THE CODE** — work here |
| `<repo>/.claude/worktrees/adoring-gates-*` (session cwd) | `claude/memory-feature-architecture-9a4f2b` | design branch — plan docs only, **no code** |
| `<repo>` (main worktree) | `main` @ `0ebe2ba5d` | up-to-date main |

- **Why the short-path worktree:** the deep OneDrive path can't run `drizzle-kit`/`pnpm db:generate` (pnpm-isolated worktree can't resolve drizzle-orm; also MAX_PATH). Fresh `pnpm install` in `.aoa/wt/mem` works. Before typechecking the server, run `pnpm -C C:/Users/TK/.aoa/wt/mem --filter "@armyofagents/plugin-sdk..." build` first (unbuilt plugin-sdk otherwise fails `server typecheck` — unrelated to memory).
- **Branch base:** cut from the design branch @ `4fbe62aaf` (plan docs). `main` has since merged home-widget #315 (`0187_daily_liz_osborn`) and marketplace #313 — so this branch is **behind main** and a rebase is a real (not trivial) operation.

## 2. What was built (P0–P1) — all committed

- **P0:** additive schema (10 nullable cols on `memory_items`: ownerType/ownerId/tier/confidence/provenance/trust/effectiveFrom/To/invalidatedAt), tier-policy engine (`memory-tier-policy.ts`), pure RBAC access filter (`memory-access.ts`).
- **P1:** actor resolvers (`memory-access-sql.ts`), RBAC-in-SQL gate `memoryAccessConditions` (goal→project via `project_goals` junction, task→project via `issues.projectId`), ORG-heartbeat + CREW retrieval gated & audited, MCP-read path RBAC, always-on core block (`memory-core-block.ts`), vision/mission/values → identity-memory backfill (`identity-backfill.ts`, wired into boot), `memory_settings` table + Settings→Memory UI.
- **Tests:** 10 cross-scope RBAC leakage tests green on **real embedded-Postgres** (`memory-rbac-leakage.integration` + `mcp-memory-read-rbac.integration`). They **skip on Windows CI** by default; run locally with `AOA_RUN_WIN_INTEGRATION=1`.

## 3. Headline result — memory reaches all 3 agent types (PROVEN live)

| Agent | How proven | Result |
|---|---|---|
| **ORG** | live agent run | agent called `query_memory` → reported the seeded vision |
| **COMMANDER** | live chat turn | asked the vision → answered from the live record |
| **CREW** | live bundle check (`loadScopedMemoryLines` + RBAC gate, real crew agent, live DB) | Vision/Mission/Values rendered into `## Context` |

Seeded record (company AcmeMem): vision = **"Be the memory layer every founder trusts"**.
Note: Crew was verified at the **delivery** level (the memory is provably in the crew's context bundle), not a full thread-orchestrated LLM run. Org + Commander were full end-to-end LLM runs.

## 4. The 5-layer ORG fix — the key technical story (each layer masked the next)

1. **Wrong registry** — agents use the **internal-agent** registry (`createToolRegistry` → **`query_memory`**), NOT the external MCP-server registry (`memory.search`). *(commit `5264729b3`)*
2. **Allowlist** — `query_memory` was missing from `ORG_HEARTBEAT_TOOL_ALLOWLIST` (`heartbeat-mcp.ts`). *(`5264729b3`)*
3. **Bridge activation** — confirmed the W5b runtime-decision bridge *does* activate with `AOA_RUNTIME_DECISION_ROUTING=1` + agent `runtimeConfig.runtimeDecisionRoutingEnabled=true` (an earlier "not activating" reading was wrong).
4. **MCP permission** — **the W5b PreToolUse hook matches only BUILT-IN tools** (`PERMISSION_REQUIRING_TOOLS = Bash/Write/Edit/MultiEdit/NotebookEdit/WebFetch`), never MCP tools. Pass **`--allowedTools mcp__aoa`** for claude_local runs (bounded by the bridge's allowlist-scoped exposure). *(`5f1dc75b9`, `claude-local/execute.ts`)*
5. **Identity visibility** — `canSeeDurableMemory` hid identity memory from anyone below team-lead, so an org agent (team_member) couldn't read the company vision. Made it **actor-aware**: agents get identity, human Commander policy unchanged. *(`3eb7635a9`, `memory-policy.ts` + `memory-tools.ts`; 56 memory-policy/commander tests still green)*
6. **(sandbox only)** `AOA_STRIP_CC_ENV=1` startup scrub — strips inherited `CLAUDE_CODE_*`/staging-OAuth env so a claude spawn under a Claude Code session uses the machine's own login. No-op in a normal terminal. *(`628cb0f20`, `index.ts`)*

**Crew + Commander need none of #1–#5:** Crew delivers via prompt-injection through the RBAC gate (identity visible to all actors), never touching the MCP-permission/policy layers; Commander bypasses tool permission (`--dangerously-skip-permissions`, default-on) and already sees identity as founder.

## 5. Commit map (25 commits, oldest→newest)

- **Plan docs:** `4fbe62aaf`
- **P0:** `3198ff97c` (schema) · `35dc0824c` (tier policy) · `64f23782f` (RBAC filter)
- **P1:** `180c2196f` (actor resolver) · `3dd54fbbe` · `9f75f0fbb` (RBAC-in-SQL) · `e67048030` (ORG) · `e2efba360` (CREW) · `ac3ff31ae` (leakage tests) · `b7e34779a` (core block) · `982f4bd5e` (MCP RBAC) · `35b32c4fe` (identity backfill) · `498ebe5d5` (memory_settings + UI)
- **Agent-delivery fixes:** `9aa0385e1` (pgvector-safe backfill, found live) · `a5061d656` (backfill test) · `ff1d17646` (superseded) · `628cb0f20` (env-scrub) · `5264729b3` (query_memory expose) · `5f1dc75b9` (--allowedTools) · `3eb7635a9` (actor-aware identity)
- **Docs:** `003737aa8` · `59e23aaa5` · `3ca77a2fc` · `a2523a7f2` · (+ this handoff)

## 6. Review status & comments

- **No external code review yet** (branch is unpushed/local).
- In-session reviews already done: **P0 code-review = PASS** (spec-compliant, 14/14 tests); **plan-eng-review** (6 findings folded into the plan suite); P1 carry-forward findings (scope-narrowing, founder-private, actor userId) — addressed.
- **⚠️ Flag for the eventual reviewer:**
  - `--allowedTools mcp__aoa` permits the *whole* aoa MCP server (bounded by exposure). Reviewer may prefer scoping to the explicit allowlist tool names.
  - Actor-aware identity visibility — sanity-check the policy call (agents read identity; human team_members still can't via Commander — intentional but worth confirming).
  - The opt-in env-scrub (`AOA_STRIP_CC_ENV`) — a dev/sandbox affordance; confirm it's acceptable on the feature branch.
  - **The findings doc's top half (the "dotted tool names" theory) is WRONG** and superseded by the "## CORRECTION" section + the "## RESOLVED"/"## ALL THREE" sections. Do NOT execute its top-half fix plan.

## 7. Merge-blockers (do these before merge)

1. **Rebase onto `main`** (`0ebe2ba5d`). Migration collision confirmed: mine are `0187_cheerful_loki` + `0188_wandering_klaw`; main already has `0187_daily_liz_osborn`. Plan: rebase, delete my two migration SQLs + their `meta/*_snapshot.json`, re-run `pnpm db:generate` to renumber onto main's chain. Expect other conflicts from main's advancement.
2. **Full server typecheck + full test suite** — only *targeted* suites ran this session (memory-policy, heartbeat-mcp, identity-backfill, core-block — all green). Run the whole thing.
3. **Push → Linux CI** — branch is Windows-local; the RBAC integration tests ran via `AOA_RUN_WIN_INTEGRATION=1`, not CI. This branch class needs Linux CI (`push`) to catch stale tests / cross-platform issues.
4. **Formal code review** (see §6).

## 8. Known follow-ups (documented, not blocking)

- **Verify-probe false-negative** — the claude_local adapter's Settings `testEnvironment` probe reports `needs_auth` even when real D9-isolated runs authenticate fine (probe uses default `~/.claude` + hooks). Founders would see a misleading "not signed in." Worth fixing (make the probe mirror the D9-isolated run path).
- **`query_memory` in Commander** — Commander reported it "got an error because it was deferred" and fell back to `query_company`. Minor; investigate the Commander→query_memory path.
- **Crew full end-to-end LLM run** — only bundle-level verified.
- **Enterprise-memory phases P2–P5** — Map/manifest, Run-Miner, Memory Guardian, autonomy/trust dials — designed in the plan suite, **not built**. Procedural self-improvement is a separate session.

## 9. Reproduction & cleanup

**Live instance was STOPPED** (`:3130`/`:54340` free). To bring it back (from a NORMAL terminal, not inside Claude Code, with `claude` logged in):

```
AOA_STRIP_CC_ENV=1 AOA_RUNTIME_DECISION_ROUTING=1 AOA_HOME=C:\Users\TK\.aoa\mem-inst PORT=3130 \
  AOA_EMBEDDED_POSTGRES_PORT=54340 AOA_DEV_LOCAL_IDENTITY=1 \
  pnpm -C C:/Users/TK/.aoa/wt/mem --filter @armyofagents/server dev
```

- **Sandbox prereqs:** `AOA_STRIP_CC_ENV=1` + `AOA_RUNTIME_DECISION_ROUTING=1` + the agent's `runtimeConfig.runtimeDecisionRoutingEnabled=true`. Embedded-pg DB URL: `postgres://paperclip:paperclip@127.0.0.1:54340/paperclip`.
- **AUTH GOTCHA:** the user's standalone `claude` login expires / gets revoked when the desktop app rotates the shared Max token → AoA `claude_local` silently 401s. If auth fails, re-login (`claude` → `/login`). **Never diagnose CLI auth from inside a Claude Code subprocess** — it inherits a revoked child-session token (documented false-negative).
- **Test data** (in `mem-inst`, company AcmeMem `febba560-8625-4aa1-b61b-2207f76faef5`): agents `MemProbe` `fe83831b…` (org), `MemProbe2` `d41083b1…` (org, bridge opt-in), `MemCrew` `3d0795bb…` (crew). Seeded identity memory. Org run recipe: create a todo task assigned to the agent → `POST /api/agents/:id/wakeup {"source":"assignment"}` → `GET /api/heartbeat-runs/:runId/log` (the `system/init` line is the tool-exposure canary).
- **Live crew bundle check** (deterministic, no LLM): a tiny `tsx` script calling `loadScopedMemoryLines(db, companyId, "vision", {}, actor, memoryAccessConditions(db,actor), {agentId})` with `actor = actorForAgentRun(db, companyId, crewAgentId)` — prints the `## Context` lines. (Used to prove crew this session.)

## 10. Key files & reference docs

- **Fixes:** `server/src/services/heartbeat-mcp.ts` · `packages/adapters/claude-local/src/server/execute.ts` · `server/src/services/internal-agent/memory-policy.ts` + `.../tools/memory-tools.ts` · `server/src/index.ts` · `server/src/services/memory-core-block.ts`
- **RBAC core:** `server/src/services/memory-access.ts` · `memory-access-sql.ts` · `internal-agent/aoa-agents/crew-context-bundle.ts` (`loadScopedMemoryLines`)
- **Findings (READ — but top half superseded):** `docs/aoa/plans/2026-07-31-memory-agent-delivery-findings.md`
- **Plan suite:** `docs/aoa/plans/2026-07-30-memory-enterprise-{overview,p0-foundation,p1-retrieval-correctness,p2-map-and-files,p3-run-miner,p4-guardian-lifecycle,p5-autonomy-trust,real-run-acceptance}.md`
- **As-built design record:** the auto-memory topic note `memory-feature-architecture-asbuilt.md` (full decisions + gap list + competitive scan).
