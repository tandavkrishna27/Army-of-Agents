# PR #318 — Enterprise Memory Merge-Readiness Design

**Date:** 2026-08-05
**Branch:** `claude/memory-enterprise-build` (worktree `C:\Users\TK\.aoa\wt\mem`)
**PR:** [#318](https://github.com/MeteoriteLabs/AoA/pull/318) — base `main`, currently **DRAFT + CONFLICTING**, 0 reviews, CI unvalidated
**HEAD:** `5d23895a3` (`fix(memory): harden enterprise memory for review`)
**Backup:** `backup/memory-enterprise-build-pre-rebase-20260802`

**Decisions locked (this session):**
1. **Outcome:** Land #318 *and* fold in the known follow-ups.
2. **Quality gate:** Adversarial security review of the memory diff **+** full typecheck **+** full test suite (highest rigor).
3. **Structure:** **Hybrid** — memory-domain work lands in #318; the unrelated adapter fix is a small stacked PR.

---

## 1. Goal & current state

Land the enterprise "company brain" memory foundation (#318) onto `main`, cleanly rebased past the multi-tenant control-plane merge (#316, `c1fe2e733`), with the highest-rigor review gate, then follow with one small stacked adapter fix.

**Branch facts (grounded 2026-08-05):**
- merge-base with `origin/main` = `0ebe2ba5d` (#313 marketplace merge).
- `origin/main` advanced by **exactly one** merge since: `c1fe2e733` (#316 multi-tenant control plane, P1–P5).
- My branch = **27 commits**, `61 files changed, +44266 / -91` — the insertions are dominated by one Drizzle schema **snapshot JSON**; the real source delta is small.
- The proven memory work is **intact at HEAD**: `heartbeat-mcp.ts` (`query_memory` in `ORG_HEARTBEAT_TOOL_ALLOWLIST` ×3), `memory-policy.ts` (actor-aware identity visibility), `execute.ts` (`--allowedTools mcp__aoa`), `memory-access-sql.ts`, plus the 2026-08-02 hardening (`5d23895a3`).

**PR/CI state:** DRAFT ⇒ every gate job is `skipped`; `ci-required` is red purely as the draft signal; the advisory `llm-eval` fail (~51s) is the known pre-existing flake. **CI has validated nothing yet** — un-drafting is what produces the first real signal.

---

## 2. Corrected follow-up inventory

The authoritative RESOLVED section of `docs/aoa/plans/2026-07-31-memory-agent-delivery-findings.md` (and handoff §8) supersedes my earlier framing. **Memory reaches all three agent types; only ORG needed code fixes (already committed).**

| Agent | Proven | Needs code? |
|-------|--------|-------------|
| **ORG** | Full end-to-end LLM run — agent called `query_memory`, returned the seeded vision. Required the 5-layer fix (registry name, allowlist, bridge activation, `--allowedTools mcp__aoa` for MCP tools, actor-aware identity). | ✅ Done (`5264729b3`, `5f1dc75b9`, `3eb7635a9`). |
| **COMMANDER** | Full end-to-end LLM run — live chat answered the company vision from memory. Works as-is (bypasses tool permissions via `--dangerously-skip-permissions`; as founder already sees identity). | ❌ **None.** (My earlier "needs an `--allowedTools` equivalent" was a hypothesis the live run disproved.) |
| **CREW** | **Bundle-level only** — `loadScopedMemoryLines` + `memoryAccessConditions` + `actorForAgentRun` against the running DB rendered Vision/Mission/Values into the prompt `## Context`. Works as-is (prompt injection through the RBAC gate; never touches MCP-permission/policy layers). | ❌ None. |

**Therefore only two real follow-ups exist — and neither is a Commander fix:**
1. **Verify-probe false-negative** *(code, adapter)* — the `claude_local` Settings `testEnvironment` probe reports `needs_auth` even when real D9-isolated runs authenticate fine (the probe uses the default `~/.claude` config + hooks, not the D9-isolated run path). Founders see a misleading "not signed in." → **stacked PR.**
2. **Crew full end-to-end LLM run** *(verification, not code)* — lift crew from bundle-level to a real thread-orchestrated dispatched run, matching ORG/Commander parity. → **#318's evidence gate.**

The "`query_memory`-Commander fix" is a **phantom** and is explicitly out of scope.

---

## 3. Structure & sequencing (Hybrid)

**PR #318 — the memory foundation (merge target):**
- Proven 5-layer ORG delivery fix + 2026-08-02 hardening.
- Rebased past #316; conflicts resolved; migration renumbered `0188 → 0202`.
- Evidence gate (§5) passes, including the crew full-LLM run.
- Un-draft → green Linux CI → land.

**Stacked follow-up PR (off updated `main`, after #318 lands):**
- Verify-probe false-negative fix only. Small, self-contained, own review + gate.

**Dependency order:**
1. Rebase + resolve conflicts + regen migration (§4).
2. Evidence gate — adversarial review + full typecheck + full test suite + crew full-LLM run (§5); fix what it surfaces.
3. Un-draft #318 → first real Linux CI → drive green (§6).
4. **Founder merges #318** — I stop at "green + reviewed + ready" and hand over the merge (merging is the founder's call).
5. Branch the stacked verify-probe PR off updated `main` → its own gate → green → founder merges (§7).

---

## 4. Rebase, conflict resolution & migration regeneration

> **Superseded by the plan's integration decision:** the implementation plan uses `git merge origin/main` instead of a rebase (lower-risk for a squash-merged PR — each conflict resolved once with both sides visible; the `git diff origin/main` verification battery is identical either way). The per-file resolutions and migration regen below are unchanged; read "rebase"/"replay 27 commits"/"pre-rebase" in this section as the equivalent one-shot merge. See the plan header for the rationale.

**Integrate main:** bring `origin/main` (`c1fe2e733`) into the branch (plan: one `git merge`; this section's per-file resolutions apply either way). Preserve the existing backup; take a fresh safety tag immediately before starting.

**Conflict-candidate set (files touched by BOTH sides — the real risk surface):**

| File | Nature | Resolution |
|------|--------|-----------|
| `packages/db/src/migrations/meta/0188_snapshot.json` | migration meta collision | Regenerate (below) |
| `packages/db/src/migrations/meta/_journal.json` | migration journal collision | Regenerate (below) |
| `packages/db/src/schema/index.ts` | both appended schema exports | Additive — keep both sets of exports |
| `server/src/app.ts` | both touched Express wiring | Re-apply my mounts onto #316's app |
| `server/src/index.ts` | my env-scrub + identity-backfill boot vs #316's multi-tenant boot | Re-place my two self-contained blocks in #316's boot order |
| `server/src/mcp/server.ts` | both touched actor/tool exposure | **Security-critical** — preserve #316's actor sources AND my memory-tool exposure |
| `server/src/routes/companies.ts` | my identity-backfill hook (+9) vs #316's rewrite (+278/-90) | Re-place my backfill hook in #316's create handler |
| `server/src/services/heartbeat.ts` | both touched | Merge both semantics; re-verify the memory-context path |
| `server/src/services/internal-agent/aoa-agents/runner.ts` | crew memory bundle vs #316 | Merge both; re-verify `## Context` still renders memory |

**The #1 rebase risk is a silent semantic drop** — resolving a conflict in a way that keeps one side's code but quietly discards the other's behavior. The adversarial review (§5) treats these 7 source files as its primary target: each must preserve **both** #316's multi-tenant semantics **and** the memory semantics.

**Migration regeneration (deterministic):**
1. Delete my `packages/db/src/migrations/0188_clammy_lightspeed.sql` + its `meta/0188_snapshot.json`, and remove its `_journal.json` entry (take #316's journal as the base).
2. Run `pnpm db:generate` on top of rebased `main`. Drizzle auto-assigns the next number — **currently `0202`** (main's highest is `0201_messy_titanium_man`).
3. Diff the regenerated `0202` SQL against the old `0188_clammy_lightspeed` to confirm the *intended* memory schema delta is preserved (no dropped/extra columns from the rebased base).
4. `pnpm typecheck` + a migration apply smoke check.

*Recurring-collision note:* every future `main` merge carrying a migration re-collides this file. There's no durable fix beyond "rebase + regen when landing" — accept it as a known cost and keep the regen recipe in the PR description.

---

## 5. Evidence gate (before un-draft)

All three must pass; fix anything surfaced, then re-run.

**(a) Adversarial security review** of the memory diff — a dedicated skeptical pass (subagent code-reviewer / `/code-review`), prompted to *refute* correctness, focused on:
- `--allowedTools mcp__aoa` **breadth** — does it expose more than `mcp__aoa__*` read/query memory tools? Any write/escalation surface? Does it interact badly with `--dangerously-skip-permissions`?
- **Actor-aware identity visibility** (`canSeeDurableMemory`) — agents get identity; confirm no path leaks *non-identity* layers cross-scope, and humans below team-lead are unchanged.
- **MCP-escalation prevention** + the `mcp/server.ts` actor sources after the merge — no new unauth'd path to memory in `authenticated`/`cloud_auth` mode.
- **Crew fail-closed** on missing identity (D7/D8) still holds post-rebase.
- The 7 merged conflict files — **no dropped semantics** from either side.

**(b) Full typecheck + full test suite** — `pnpm typecheck` + `pnpm test:run` (the memory QA suites: `memory-qa`, plus `identity-backfill`, `memory-insert-no-pgvector`, RBAC gate tests). Green required. (Note the platform reality: Windows local skips integration+e2e; Linux PR CI is the authoritative run — see §6.)

**(c) Crew full end-to-end LLM run** — dispatch a real crew task in `mem-inst` (company `AcmeMem` `febba560`, agent `MemCrew` `3d0795bb`) and confirm the run output reflects retrieved company memory, not just a rendered bundle. Prereqs: `AOA_STRIP_CC_ENV=1` + `AOA_RUNTIME_DECISION_ROUTING=1` + agent `runtimeConfig.runtimeDecisionRoutingEnabled=true`. This is verification only — no code expected; if it fails it becomes a real finding.

---

## 6. Landing sequence

1. Push the rebased branch (force-with-lease; backup already exists).
2. **Un-draft #318** → triggers the real `pr.yml` jobs (`verify`, `e2e`, `migrations`, `policy`, `brand-check`) which run on Linux (required-gate lane), macOS (advisory-green), and Windows (advisory, 4 skips / e2e skipped). **The single branch-protection required check is the `ci-required` aggregator** — it computes pass/fail from the Linux job results; the individual jobs are not themselves required.
3. Drive the Linux jobs green so `ci-required` goes green. Expect the migration lane to exercise `0202`.
4. **Confirm `llm-eval` is advisory** — verify it's not a required check and its failure is the known pre-existing flake (re-run once; if it flips green or is config-marked advisory, proceed). If it turns out to gate, treat as a real finding.
5. Post the adversarial-review summary + evidence (test output, crew-run transcript) as a PR comment for the record.
6. Hand to founder for merge. **I do not click merge.**

---

## 7. Stacked verify-probe PR (after #318 lands)

- Branch off updated `main`.
- Fix: make the `claude_local` `testEnvironment` probe mirror the **D9-isolated run path** (same `CLAUDE_CONFIG_DIR` construction the real run uses) so a healthy, logged-in agent stops reporting `needs_auth`. Scope strictly to the probe; no change to real-run auth.
- Gate: same rigor, scaled down — typecheck + relevant adapter tests + a manual Settings probe check against a known-good agent. Adversarial review is lighter (single subsystem, no RBAC surface).
- Founder merges.

---

## 8. Risks & rollback

- **Silent semantic drop during conflict resolution** (highest) — mitigated by the §5(a) review targeting the 7 merged files + full test suite.
- **Migration re-collision on any new `main` merge** — mitigated by the deterministic regen recipe; re-run if `main` moves again before landing.
- **`--allowedTools` over-exposure** — explicitly audited in §5(a); this is the one change that widened an agent's tool reach.
- **CI infra flake** (Playwright CDN stalls, `llm-eval`) — the Linux `e2e` job has the Google-CFT fallback; `llm-eval` handled in §6(4).
- **Rollback:** the branch is force-pushed only after the backup exists; `backup/memory-enterprise-build-pre-rebase-20260802` + a fresh pre-rebase tag preserve the exact pre-rebase tip. #318 is not merged until green + reviewed, so `main` is never at risk.

---

## 9. Decisions locked / open questions

**Locked:** land #318 + follow-ups · adversarial + full-typecheck + full-suite gate · Hybrid structure · Commander/crew need no code · verify-probe stacked · founder owns the merge click.

**Open (surface during execution, not blocking the plan):**
- Is `llm-eval` genuinely advisory in branch protection? (Confirm in §6(4).)
- Does the crew full-LLM run reveal any gap the bundle-level check masked? (§5(c).)
- Exact regenerated migration number if `main` moves again before landing (recompute at rebase time; `0202` today).
