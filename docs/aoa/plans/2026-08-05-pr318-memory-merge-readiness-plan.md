# PR #318 Enterprise Memory Merge-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land PR #318 (the enterprise "company brain" memory foundation) onto `main` — integrated past #316, conflicts resolved with no semantic drops, migration regenerated, gated by an adversarial security review + full typecheck + full test suite — then follow with a small stacked verify-probe PR.

**Architecture:** My branch adds NEW memory service/schema/route files (no conflict) plus small additive call-site edits in 7 files that #316 heavily rewrote. Because #318 squash-merges, we integrate main via a single `git merge origin/main` (resolve the 9-file conflict set once, with full both-sides context) rather than replaying 27 commits. Each conflict resolves as "take #316's file, re-apply my additive block." A grep + `git diff origin/main` battery proves both sides survived; the migration is deleted and regenerated as `0202` on top of main's chain.

**Tech Stack:** pnpm workspaces, TypeScript, Express 5, Drizzle ORM + drizzle-kit, PostgreSQL (embedded pgvector for local), vitest, Playwright (Linux CI only), GitHub Actions (`ci-required` aggregator gate).

> **⚠ Spec-wording deviation (approve or veto in review):** the design spec §4 says "rebase." This plan uses **`git merge origin/main`** instead — same goal (mergeable, semantics preserved), lower risk for a squash-merged PR because each of the 7 source conflicts (notably `heartbeat.ts`: my +68 into #316's +502 rewrite) is resolved exactly once with both sides fully visible. If you want true linear history, swap Phase 1 for `git rebase origin/main` with `git rerere` enabled — the per-file resolution code blocks below are identical either way.

**Grounded facts (2026-08-05):** branch `claude/memory-enterprise-build` @ `5d23895a3`; merge-base `0ebe2ba5d` (#313); `origin/main` @ `c1fe2e733` (#316); main's highest migration `0201_messy_titanium_man` → regen target **`0202`**; worktree `C:\Users\TK\.aoa\wt\mem`; existing backup `backup/memory-enterprise-build-pre-rebase-20260802`.

---

## File map

**Conflict-candidate files (both sides touched — the work):**

Merge outcome verified by `git merge-tree --write-tree origin/main HEAD` (2026-08-05): only **4 files actually conflict**; the other **5 auto-merge** and must be **verified, not skipped** — including the two security-relevant ones. The task column points at the resolve/verify task for each file.

| File | My change | #316 change | Merge outcome (task) |
|------|-----------|-------------|---------------|
| `server/src/routes/companies.ts` | +9 (identity-mirror hook) | +278/-90 | **CONFLICT** → resolve (Task 1.3) |
| `server/src/index.ts` | +33 (env-scrub + backfill boot) | +185 | **CONFLICT** → resolve (Task 1.4) |
| `packages/db/src/migrations/meta/_journal.json` | 0188 entry | 0188–0201 entries | **CONFLICT** → take main's + regen (Task 1.7) |
| `packages/db/src/migrations/meta/0188_snapshot.json` | my snapshot | their snapshot | **CONFLICT** → take main's, **keep it** (Task 1.7) |
| `server/src/mcp/server.ts` | +17/-7 (actor RBAC gate) | +17 | auto-merge → **VERIFY, security** (Task 1.5) |
| `server/src/services/heartbeat.ts` | +64/-4 (scope+actor gate, core) | +502 | auto-merge → **VERIFY, security** (Task 1.6) |
| `packages/db/src/schema/index.ts` | +1 export | +6 exports | auto-merge → verify (Task 1.2) |
| `server/src/app.ts` | +2 (route import+mount) | +253 | auto-merge → verify (Task 1.2) |
| `server/src/services/internal-agent/aoa-agents/runner.ts` | +5 (bundle params) | +117 | auto-merge → verify (Task 1.2) |

> The code blocks in Tasks 1.2, 1.5, 1.6 double as **"what the auto-merged file must contain"** — for an auto-merged file you *verify* the block is present (and no #316 line was dropped); you only hand-edit if the merge actually conflicted or dropped something. `mcp/server.ts` + `heartbeat.ts` get a **mandated full human diff read** (Task 1.5 Step 4 / Task 1.6 Step 5) regardless — grep is insufficient for the security gate.

**New files my branch adds (no conflict — #316 did not touch them; referenced by the call-site edits):**
`server/src/services/memory-access-sql.ts` (`actorForAgentRun`, `actorForMcp`, `memoryAccessConditions`), `server/src/services/memory-access.ts` (`filterMemoryForActor`), `server/src/services/memory-run-scope.ts` (`resolveRunMemoryScope`), `server/src/services/memory-core-block.ts` (`buildAlwaysOnCore`), `server/src/services/identity-backfill.ts` (`backfillIdentityMemory`, `backfillAllCompaniesIdentityMemory`), `server/src/routes/memory-settings.ts` (`memorySettingsRoutes`), `packages/db/src/schema/memory_settings.ts` (`memorySettings`).

---

## Phase 0 — Pre-flight & safety

### Task 0: Confirm state and take a fresh safety point

**Files:** none (git only)

- [ ] **Step 1: Confirm a clean worktree on the right branch**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" status --short
git -C "C:/Users/TK/.aoa/wt/mem" rev-parse --abbrev-ref HEAD
git -C "C:/Users/TK/.aoa/wt/mem" log --oneline -1
```
Expected: empty status; branch `claude/memory-enterprise-build`; HEAD = the latest `docs(memory):` commit atop `5d23895a3` (the review-hardening). The exact hash bumps with each doc edit — match the pattern (a docs commit on top of `5d23895a3`), not a literal SHA.

- [ ] **Step 2: Fetch and re-confirm main's tip + migration ceiling (guards against main moving again)**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" fetch origin
git -C "C:/Users/TK/.aoa/wt/mem" log --oneline -1 origin/main
git -C "C:/Users/TK/.aoa/wt/mem" ls-tree -r --name-only origin/main packages/db/src/migrations | grep -E '/[0-9]{4}_.*\.sql$' | sort | tail -1
```
Expected: `origin/main` at `c1fe2e733` (or newer). Note the highest migration — if it is **not** `0201`, the regen target in Phase 2 is `(highest+1)`, not `0202`. Record the number.

- [ ] **Step 3: Take a fresh dated safety tag at the current tip**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" tag pre-merge-316-20260805 HEAD
git -C "C:/Users/TK/.aoa/wt/mem" tag --list 'pre-*'
```
Expected: the new tag listed alongside the existing backup. This is the exact rollback point for Phase 1.

- [ ] **Step 4: Enable rerere (records conflict resolutions; harmless, helps if you re-run)**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" config rerere.enabled true
```
Expected: no output. No commit for this phase.

---

## Phase 1 — Integrate main via merge

### Task 1.1: Start the merge and enumerate conflicts

**Files:** none yet (git merge)

- [ ] **Step 1: Begin the merge without auto-committing**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" merge --no-commit --no-ff origin/main
```
Expected: `Automatic merge failed; fix conflicts and then commit the result.` (Some of the 7 files may auto-merge; that is fine — they still get verified in Task 1.8.)

- [ ] **Step 2: List the actually-conflicted files**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" diff --name-only --diff-filter=U
```
Expected (per the merge-tree preview): **exactly these 4 conflicts** — `server/src/routes/companies.ts`, `server/src/index.ts`, `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/migrations/meta/0188_snapshot.json`. Resolve them in Tasks 1.3 (companies), 1.4 (index), 1.7 (migration-meta). **The other 5 files auto-merge — do NOT skip them:** Task 1.2 verifies the 3 trivial ones, and Tasks 1.5 / 1.6 verify the two security-relevant ones (`mcp/server.ts`, `heartbeat.ts`) with a mandated human diff read. If reality differs from this preview (a file conflicts that shouldn't, or vice-versa), apply the matching reference block either way. No commit yet.

### Task 1.2: Verify the 3 trivial auto-merges

**Files (all auto-merge per the preview — verify each; hand-edit only if a line is missing):**
- Verify: `packages/db/src/schema/index.ts`
- Verify: `server/src/app.ts`
- Verify: `server/src/services/internal-agent/aoa-agents/runner.ts`

- [ ] **Step 1: `schema/index.ts` — confirm BOTH export blocks merged; my line is present**

The barrel must contain, alongside #316's new exports, immediately after the `memoryItems` export:
```ts
export { memoryItems } from "./memory_items.js";
export { memorySettings } from "./memory_settings.js";
export { memoryAssets } from "./memory_assets.js";
```
Remove any `<<<<<<<`/`=======`/`>>>>>>>` markers, keeping every export from both sides.

- [ ] **Step 2: `server/src/app.ts` — re-apply the memory-settings route import + mount**

Ensure the import block contains (near the other route imports, after `memoryRoutes`):
```ts
import { memoryRoutes } from "./routes/memory.js";
import { memorySettingsRoutes } from "./routes/memory-settings.js";
```
and the mount block contains (immediately after `api.use(memoryRoutes(db));`):
```ts
  api.use(memoryRoutes(db));
  api.use(memorySettingsRoutes(db));
```
Keep all of #316's added routers.

- [ ] **Step 3: `runner.ts` — re-apply the crew bundle params**

In the `buildCrewContextBundle(...)` call inside `runAoaAgent`, the argument object must include my two lines alongside `issueId` / `agentId`:
```ts
          issueId: bundleIssueId,
          agentId,
          // P1-T4: thread the run id so CREW memory retrieval is audited (O4).
          runId,
          // P1-T6: role label for the always-on core (goal title omitted on the
          // crew path — the bundle does not load the goal).
          agentRole: agent.role ?? agent.name ?? null,
```

- [ ] **Step 4: Stage the three files**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" add packages/db/src/schema/index.ts server/src/app.ts server/src/services/internal-agent/aoa-agents/runner.ts
```
Expected: no output.

### Task 1.3: Resolve `routes/companies.ts` (identity-mirror hook)

**Files:** Modify: `server/src/routes/companies.ts`

- [ ] **Step 1: Re-apply the import**

Ensure this import is present with the other service imports:
```ts
import { backfillIdentityMemory } from "../services/identity-backfill.js";
```

- [ ] **Step 2: Re-apply the mirror hook in the company UPDATE handler**

In #316's update handler — `router.patch("/:companyId", validate(updateCompanySchema), …)` (~line 399), which runs `svc.update(companyId, req.body)` then `logActivity(db, { action: "company.updated", … })` — insert this **immediately after `svc.update(...)` and before that `company.updated` `logActivity`** (NOT the `company.imported` ~L274, `enable-teams`, or `archive` `logActivity` calls). The local var is `companyId` (verified unchanged in #316):
```ts
    // P1-T9 — mirror edited vision/mission/values into layer='identity' memory
    // (the single home for company identity). Idempotent + best-effort; the
    // startup backfill is the safety net for any path that bypasses this route.
    if ("vision" in req.body || "mission" in req.body || "values" in req.body) {
      await backfillIdentityMemory(db, companyId).catch((err: unknown) =>
        logger.warn({ err, companyId }, "company identity memory mirror failed (non-fatal)"),
      );
    }
```
If #316 renamed the local company-id variable, use its name instead of `companyId`. Keep all of #316's handler logic.

- [ ] **Step 3: Stage**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" add server/src/routes/companies.ts
```

### Task 1.4: Resolve `server/index.ts` (env-scrub + identity backfill boot)

**Files:** Modify: `server/src/index.ts`

- [ ] **Step 1: Re-apply the backfill import**

Ensure this import sits with the other backfill imports near the top:
```ts
import { backfillAllCompaniesIdentityMemory } from "./services/identity-backfill.js";
```

- [ ] **Step 2: Re-apply the AOA_STRIP_CC_ENV block immediately after `const config = loadConfig();`**

```ts
const config = loadConfig();

// Dev/sandbox affordance (opt-in via AOA_STRIP_CC_ENV=1): when AoA is launched
// from inside a Claude Code session — especially a staging session — the inherited
// CLAUDE_CODE_* / OAuth-routing vars + ANTHROPIC_BASE_URL point every spawned CLI
// (Commander, extraction, crew/org runs, the auth probe) at the HOST session's
// endpoint. A normal `claude login` (production) then reads as "revoked" there, so
// the CLI reports needs_auth even though the machine is signed in. Stripping these
// here — after loadConfig()'s .env load, before any adapter spawns — lets the child
// CLIs fall back to the machine's own login. No-op in a normal terminal (vars absent).
if (process.env.AOA_STRIP_CC_ENV === "1") {
  const stripped = Object.keys(process.env).filter((k) =>
    /^(CLAUDE_CODE_|CLAUDECODE$|USE_STAGING_OAUTH$|USE_LOCAL_OAUTH$|ANTHROPIC_BASE_URL$|AI_AGENT$)/i.test(k),
  );
  for (const k of stripped) delete process.env[k];
  console.log(
    `[aoa] AOA_STRIP_CC_ENV: removed ${stripped.length} Claude Code session var(s)` +
      (stripped.length ? `: ${stripped.join(", ")}` : ""),
  );
}
```
The scrub must run AFTER `loadConfig()` (so `.env` is loaded) and BEFORE the `AOA_SECRETS_PROVIDER` defaulting / any adapter spawn. If #316 moved `loadConfig()`, place the block right after it wherever it now lives.

- [ ] **Step 3: Re-apply the identity-backfill boot call next to the other `void backfill…` calls**

Alongside the existing startup backfills (e.g. after `void backfillCrewTemplateOrigin(...)`), insert:
```ts
// P1-T9 — idempotent backfill: mirror each company's vision/mission/values into
// layer='identity' memory items (the single home for company identity; the
// `companies` columns stay as a temporary mirror). Runs every boot; second run
// inserts 0 rows. Best-effort — never blocks startup.
void backfillAllCompaniesIdentityMemory(db as any)
  .then((res) => {
    if (res.items > 0) {
      logger.info(res, "company identity memory backfill complete");
    }
  })
  .catch((err: unknown) => logger.warn({ err }, "company identity memory backfill failed"));
```

- [ ] **Step 4: Stage**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" add server/src/index.ts
```

### Task 1.5: Verify the `mcp/server.ts` auto-merge (security-critical actor RBAC gate)

**Files:** Verify: `server/src/mcp/server.ts` — auto-merges per the preview; verify, don't hand-edit unless it dropped something.

Security-critical: a wrong merge here could open or close a memory-access hole. The change replaces the scope-only `filterMemoryForScope` with the converged actor gate in the MCP `memory` resource handler. Confirm the merged file contains the two blocks below, then do the **mandated full diff read (Step 4)**.

- [ ] **Step 1: Confirm the import swap merged correctly (present in the merged file)**

Remove `filterMemoryForScope` from the `./tools/scope.js` import (keep the other names #316 still uses — `filterArtifactsForScope`, `filterGoalsForScope`, `resolveScopedAgentIdsDefault`, `resolveUserRole`, `resolveUserScope`), and add the two actor-gate imports:
```ts
import {
  filterArtifactsForScope,
  filterGoalsForScope,
  resolveScopedAgentIdsDefault,
  resolveUserRole,
  resolveUserScope,
} from "./tools/scope.js";
import { actorForMcp, memoryAccessConditions } from "../services/memory-access-sql.js";
import { filterMemoryForActor } from "../services/memory-access.js";
```

- [ ] **Step 2: Re-apply the actor gate inside the `if (resource.collection === "memory")` block**

```ts
        if (resource.collection === "memory") {
          // Converged enterprise-memory RBAC gate (P1-T5): resolve the caller's
          // actor once, build the in-SQL access conditions, apply them to the
          // fetch (so goal/task scope resolves in-SQL), then filterMemoryForActor
          // as the post-fetch net. Replaces the goal/task-leaking filterMemoryForScope.
          const memoryActor = await actorForMcp(db, companyId, {
            source: protocolActor.source,
            userId: protocolActor.userId,
            agentId: protocolActor.agentId,
          }, scope);
          const memoryAccess = memoryAccessConditions(db, memoryActor);
          if (!resource.id) {
            const rows = filterMemoryForActor(
              await memorySvc.list(companyId, { status: "approved", accessConditions: memoryAccess }),
              memoryActor,
            );
            res.json(jsonRpcResult(requestBody.id ?? null, asJsonContent(params.uri, rows)));
            return;
          }
          const row = await memorySvc.getById(companyId, resource.id, memoryAccess);
          const filtered = row && row.status === "approved" ? filterMemoryForActor([row], memoryActor) : [];
          if (filtered.length === 0) {
            res.status(404).json(jsonRpcError(requestBody.id ?? null, -32004, "Memory item not found"));
```

- [ ] **Step 3: Verify #316 did not add another `filterMemoryForScope` caller in this file**

Run:
```bash
grep -n 'filterMemoryForScope' "C:/Users/TK/.aoa/wt/mem/server/src/mcp/server.ts"
```
Expected: **no matches.** If any remain (a #316 caller), do NOT remove the import — instead keep `filterMemoryForScope` imported AND apply the actor gate only in the `memory` resource block. Confirm `protocolActor` (source/userId/agentId) and `scope` are the same identifiers #316 uses at that point.

- [ ] **Step 4: MANDATED full human diff read (the security gate — grep is not enough)**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" diff --no-color origin/main -- server/src/mcp/server.ts
```
Read the ENTIRE diff. Confirm: (a) the ONLY removed (`-`) lines are the intended `filterMemoryForScope` import **plus the two old calls it replaced** — `getById(companyId, resource.id)` → 3-arg with `memoryAccess`, and `list(companyId, { status: "approved" })` → `{ status, accessConditions }`; (b) `actorForMcp`, `memoryAccessConditions`, `filterMemoryForActor` are present in the `memory` resource block; (c) `protocolActor` + `scope` are the identifiers #316 uses there; (d) NO other #316 line was dropped. **If a #316 line was genuinely dropped:** hand-restore that exact line, or `git merge --abort` and restart the merge (rerere replays your prior resolutions) — do not stage over a drop.

- [ ] **Step 5: Stage**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" add server/src/mcp/server.ts
```

### Task 1.6: Verify the `services/heartbeat.ts` auto-merge (scope + actor gate + always-on core)

**Files:** Verify: `server/src/services/heartbeat.ts` — auto-merges per the preview; verify, don't hand-edit unless it dropped something.

The largest overlap: my +64/-4 lands in the ORG memory-retrieval path inside #316's +502 rewrite, yet it auto-merges. Confirm the merged file contains the four blocks below (they replace the old plain retrieval), then do the **mandated full diff read (Step 5)**.

- [ ] **Step 1: Confirm the imports merged (present in the merged file)**

Add `goals` to the schema import (next to `issues` / `memoryItems`) and add the four memory-service imports near the existing `./memory*` imports:
```ts
import { actorForAgentRun, memoryAccessConditions } from "./memory-access-sql.js";
import { filterMemoryForActor } from "./memory-access.js";
import { resolveRunMemoryScope } from "./memory-run-scope.js";
import { buildAlwaysOnCore } from "./memory-core-block.js";
```

- [ ] **Step 2: Re-apply the scope-resolving issue select**

Find the block that resolves task text for retrieval (the `let issueText` region). Replace the plain title/description select with the scope-joined version:
```ts
    let issueText: string | null = null;
    let issueScope: {
      projectId: string | null;
      projectType: string | null;
      goalId: string | null;
    } | null = null;
    let goalTitle: string | null = null;
    if (issueId) {
      const issueRow = await db
        .select({
          title: issues.title,
          description: issues.description,
          projectId: issues.projectId,
          goalId: issues.goalId,
          projectType: projects.type,
          goalTitle: goals.title,
        })
        .from(issues)
        .leftJoin(projects, eq(projects.id, issues.projectId))
        .leftJoin(goals, eq(goals.id, issues.goalId))
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (issueRow) {
        issueText = [issueRow.title, issueRow.description].filter(Boolean).join("\n");
        issueScope = {
          projectId: issueRow.projectId,
          projectType: issueRow.projectType ?? null,
          goalId: issueRow.goalId,
        };
        goalTitle = issueRow.goalTitle ?? null;
      }
    }
```
If #316's select already left-joins `projects`, keep its join and ADD the `goals` join + the `goalId`/`projectType`/`goalTitle` selected columns.

- [ ] **Step 3: Re-apply the actor+scope gate and the filtered search call**

Immediately before the `memoryService(db)` retrieval, insert the actor/scope resolution, and route the search through it with the post-fetch safety net:
```ts
    // RBAC + scope gate (enterprise memory model, P1-T3): resolve the running
    // agent's actor and derive the task's department + goal scope so the ORG path
    // fetches only memory this agent is entitled to and relevant to. agentId can be
    // absent on some wake types — then skip the actor gate (retain prior behavior).
    const actor = auditContext?.agentId
      ? await actorForAgentRun(db, companyId, auditContext.agentId)
      : null;
    const scope = resolveRunMemoryScope(issueScope);

    const memorySvc = memoryService(db);
    const rawItems: MultiPathSearchResult[] = await memorySvc
      .searchMultiPath(companyId, issueText ?? "", {
        limit: itemLimit,
        ...scope,
        ...(actor ? { accessConditions: memoryAccessConditions(db, actor) } : {}),
      })
      .catch((err) => {
        logger.warn(/* keep #316's existing warn args here */);
        return [] as MultiPathSearchResult[];
      });
    // Safety net: even with in-SQL conditions, never hand an actor a row it can't
    // see (post-fetch filter mirrors the SQL gate — P0 memory-access.ts).
    const items = actor ? filterMemoryForActor(rawItems, actor) : rawItems;
```
Preserve #316's exact `logger.warn(...)` arguments from the original `.catch`.

- [ ] **Step 4: Re-apply `goalTitle` on the returned retrieval object and the always-on core**

Where the retrieval helper returns its object (the `return { … items … }`), add the `goalTitle` field. Then, in the run-context assembly where `context.memory` is set, add the unconditional core block:
```ts
        context.memory_core = buildAlwaysOnCore({
          agentRole: agent.role ?? agent.name ?? null,
          goalTitle: memoryContext.goalTitle,
        });
```
Set `context.memory_core` unconditionally (not gated on retrieval results), mirroring the sibling `context.memory` assignment.

- [ ] **Step 5: MANDATED full human diff read (the security gate — grep is not enough)**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" diff --no-color origin/main -- server/src/services/heartbeat.ts
```
Read the ENTIRE diff. Confirm: (a) the only removed (`-`) lines are the OLD plain retrieval this legitimately replaces — the `.select({ title: issues.title, description: issues.description })` and the unscoped `.searchMultiPath(companyId, issueText ?? "", { limit: itemLimit })` (+ its one-line comment); (b) my four blocks are present (the 4 imports, the scope-joined select, the actor/scope gate + `rawItems`→`items` filter, and `goalTitle` on the return + `context.memory_core = buildAlwaysOnCore(...)`); (c) `and`/`eq`/`projects`/`goals` resolve (imported); (d) NO other #316 line was dropped. **If a #316 line was genuinely dropped** (e.g. its retrieval logic clobbered): hand-restore that exact line, or `git merge --abort` and restart (rerere replays prior resolutions) — do not stage over a drop.

- [ ] **Step 6: Stage**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" add server/src/services/heartbeat.ts
```

### Task 1.7: Resolve migration meta (take main's chain; drop my 0188 sql only)

**Files:**
- Take main's: `packages/db/src/migrations/meta/_journal.json` + all `meta/*_snapshot.json`
- Delete (mine only): `packages/db/src/migrations/0188_clammy_lightspeed.sql`

- [ ] **Step 1: Take main's version of the journal and all meta snapshots**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" checkout origin/main -- packages/db/src/migrations/meta/
```
Expected: no output. This makes the meta directory exactly main's (journal ends at `0201`, includes `0188_organizations` … `0201` snapshots). My `0202` is regenerated in Phase 2.

- [ ] **Step 2: Remove ONLY my superseded migration SQL (keep main's meta intact)**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" rm -f packages/db/src/migrations/0188_clammy_lightspeed.sql
git -C "C:/Users/TK/.aoa/wt/mem" add packages/db/src/migrations/
```
**Do NOT delete `meta/0188_snapshot.json`.** After Step 1 that file is **main's `0188_organizations` snapshot**, not mine — deleting it punches a hole in main's chain that neither `db:generate` (reads only the latest snapshot) nor `db:migrate` (reads sql-by-tag) would catch, silently shipping a broken migration set. Expected: only `0188_clammy_lightspeed.sql` deleted; the full `0188`–`0201` meta from main staged. (My memory schema DDL regenerates as `0202` in Phase 2 — it is NOT lost; it lives in the schema TS files.)

### Task 1.8: Verify both sides survived (the semantic-drop battery)

**Files:** none (verification)

- [ ] **Step 1: Confirm no conflict markers remain anywhere**

Run:
```bash
grep -rn '^<<<<<<<\|^=======\|^>>>>>>>' "C:/Users/TK/.aoa/wt/mem/server/src" "C:/Users/TK/.aoa/wt/mem/packages/db/src" || echo "CLEAN"
```
Expected: `CLEAN`.

- [ ] **Step 2: Assert every one of my memory edits is present (exact counts, not ≥1)**

Run:
```bash
cd "C:/Users/TK/.aoa/wt/mem"
ok=1
chk(){ c=$(grep -c "$1" "$2"); [ "$c" -ge "$3" ] || { echo "MISS: '$1' in $2 (got $c, need >=$3)"; ok=0; }; }
chk "memorySettings" packages/db/src/schema/index.ts 1
chk "memorySettingsRoutes" server/src/app.ts 2
chk "backfillIdentityMemory" server/src/routes/companies.ts 2
chk "agentRole: agent.role" server/src/services/internal-agent/aoa-agents/runner.ts 1
chk "AOA_STRIP_CC_ENV" server/src/index.ts 1
chk "backfillAllCompaniesIdentityMemory" server/src/index.ts 1
chk "actorForMcp" server/src/mcp/server.ts 1
chk "filterMemoryForActor" server/src/mcp/server.ts 1
chk "buildAlwaysOnCore" server/src/services/heartbeat.ts 1
chk "resolveRunMemoryScope" server/src/services/heartbeat.ts 1
[ "$ok" = 1 ] && echo "ALL MEMORY EDITS PRESENT"
```
Expected: `ALL MEMORY EDITS PRESENT` and no `MISS:` line. The `>=2` checks on `memorySettingsRoutes` (import+mount) and `backfillIdentityMemory` (import+call) catch a half-applied edit that a plain `grep -q`/`grep -c` would pass. Any `MISS:` ⇒ re-open that file's task.

- [ ] **Step 3: Assert #316 was not silently dropped — the 5 PURELY-ADDITIVE files diff as add-only**

The two security files (`mcp/server.ts`, `heartbeat.ts`) legitimately REPLACE lines, so they are NOT add-only — they were already gated line-by-line by the mandated human diff reads in **Task 1.5 Step 4** and **Task 1.6 Step 5**. This step covers only the 5 purely-additive files:
```bash
cd "C:/Users/TK/.aoa/wt/mem"
for f in packages/db/src/schema/index.ts server/src/app.ts server/src/routes/companies.ts \
  server/src/index.ts server/src/services/internal-agent/aoa-agents/runner.ts; do
  dels=$(git diff --no-color origin/main -- "$f" | grep '^-' | grep -v '^---')
  if [ -z "$dels" ]; then echo "  $f: add-only ✓"; else echo "  $f: UNEXPECTED DELETIONS ↓"; echo "$dels"; fi
done
```
Expected: all 5 print `add-only ✓`. Any `UNEXPECTED DELETIONS` = a #316 line dropped during resolution — fix before committing. (`mcp/server.ts` + `heartbeat.ts` are intentionally excluded here; their replacement deletions were verified in Tasks 1.5/1.6.)

- [ ] **Step 4: Sync deps + build, THEN typecheck the merged tree**

#316 changed `pnpm-lock.yaml` + `server/package.json` and rewrote db/server sources, so after the merge `node_modules` is out of sync and the workspace `dist/` that `server` typecheck resolves `@armyofagents/*` against (via `.d.ts` — there is no tsconfig `paths` mapping) is pre-#316-stale. Install + build BEFORE typechecking, or you get spurious `no exported member` errors or, worse, silently mask a real #316 type break. (`pnpm db:generate` is exempt — it self-compiles the schema.)

Run:
```bash
cd "C:/Users/TK/.aoa/wt/mem" && pnpm install && pnpm build && pnpm typecheck
```
Expected: PASS (0 errors). A type error that survives a clean build means a call-site drifted from a #316 signature — fix in the offending file, re-stage, re-run.

### Task 1.9: Commit the merge

**Files:** none (commit)

- [ ] **Step 1: Commit with an explicit resolution note**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" commit --no-edit || git -C "C:/Users/TK/.aoa/wt/mem" commit -m "merge origin/main (#316) into memory-enterprise-build

Re-applied the 7 additive memory call-site edits onto #316's rewrites;
took main's migration chain (0188-0201); my schema delta regenerates as 0202.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected: a merge commit is created.

- [ ] **Step 2: Confirm the tree is clean**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" status --short
```
Expected: empty.

---

## Phase 2 — Regenerate the migration as 0202

### Task 2.1: Generate the memory schema delta on top of main's chain

**Files:**
- Create: `packages/db/src/migrations/0202_*.sql` (+ `meta/0202_snapshot.json`, `_journal.json` entry) — via drizzle-kit

- [ ] **Step 1: Generate**

Run:
```bash
cd "C:/Users/TK/.aoa/wt/mem" && pnpm db:generate
```
Expected: drizzle-kit emits a new `0202_<name>.sql` (name auto-chosen) plus `meta/0202_snapshot.json`, and appends a `0202` entry to `_journal.json`. If Phase 0 Step 2 found main's ceiling ≠ 0201, the number will differ — use whatever drizzle emits.

- [ ] **Step 2: Confirm exactly one new migration appeared and it is numbered above main's ceiling**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" status --short packages/db/src/migrations
git -C "C:/Users/TK/.aoa/wt/mem" ls-files --others --exclude-standard packages/db/src/migrations | grep -E '\.sql$'
```
Expected: one new `0202_*.sql` (untracked) + modified `_journal.json` + new `0202_snapshot.json`. No stray edits to `0188`–`0201`.

### Task 2.2: Verify the regenerated SQL is exactly my memory delta

**Files:** Review: `packages/db/src/migrations/0202_*.sql`

- [ ] **Step 1: Read the generated SQL and confirm it contains ONLY memory-domain DDL**

Run:
```bash
cat "C:/Users/TK/.aoa/wt/mem/packages/db/src/migrations/"0202_*.sql
```
Expected: `CREATE TABLE`/`ALTER TABLE` statements for the memory additions only (e.g. `memory_settings`, memory-item column additions). It must **not** create `organizations` or other #316 tables (those are already in main's snapshot) and must **not** DROP anything from #316. If it references a #316 table, the merge left a schema inconsistency — stop and reconcile the schema TS before proceeding.

- [ ] **Step 2: Cross-check against the old delta (nothing intended was lost)**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" show pre-merge-316-20260805:packages/db/src/migrations/0188_clammy_lightspeed.sql | grep -iE 'create table|alter table|add column' | sort > /tmp/old-delta.txt
grep -iE 'create table|alter table|add column' "C:/Users/TK/.aoa/wt/mem/packages/db/src/migrations/"0202_*.sql | sort > /tmp/new-delta.txt
diff /tmp/old-delta.txt /tmp/new-delta.txt && echo "DELTA MATCHES" || echo "REVIEW DIFF ABOVE"
```
Expected: `DELTA MATCHES`, or a diff you can explain (e.g. an object #316 already added that dropped out of my delta legitimately). Unexplained losses ⇒ fix schema TS, re-run Task 2.1.

### Task 2.3: Apply-smoke, typecheck, commit

**Files:** none new

- [ ] **Step 1: Typecheck (db package compiles the new snapshot)**

Run:
```bash
cd "C:/Users/TK/.aoa/wt/mem" && pnpm typecheck
```
Expected: PASS.

- [ ] **Step 2: Prove the migration applies — via the Linux `migrations` CI lane (authoritative), not a bare local `pnpm db:migrate`**

`pnpm db:migrate` (`packages/db/src/migrate.ts`) **throws immediately without `DATABASE_URL`** and needs a running Postgres already migrated to `0201` — the plan seeds neither, so a bare local run is a misleading FAIL, not a real check. Two valid options:
- **(A, recommended)** Skip the local apply here and rely on the required Linux **`migrations`** CI job (Phase 4), which provisions a fresh DB and applies the whole chain including `0202`. `pnpm db:generate` (Task 2.1, offline-safe) already proved the SQL is well-formed.
- **(B, optional local smoke)** Start a scratch Postgres, migrate it to `0201`, then:
```bash
export DATABASE_URL="postgres://<user>:<pass>@localhost:5432/<scratch_db>"
cd "C:/Users/TK/.aoa/wt/mem" && pnpm db:migrate
```
Expected (B): migrations apply through `0202` with no error. Do NOT treat a `DATABASE_URL is required` throw as a migration failure — that is the missing-env guard, not a migration problem.

- [ ] **Step 3: Commit the regenerated migration**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" add packages/db/src/migrations
git -C "C:/Users/TK/.aoa/wt/mem" commit -m "fix(db): regenerate memory migration as 0202 on main's chain

Supersedes 0188_clammy_lightspeed (collided with #316's 0188-0201).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected: commit created.

---

## Phase 3 — Evidence gate (adversarial review + full suite + crew run)

### Task 3.1: Full typecheck + full test suite

**Files:** none (validation)

- [ ] **Step 1: (Re)sync deps + build, then typecheck the whole workspace**

Run (install+build are idempotent — fast if Task 1.8 Step 4 already ran them; re-run because Phase 2 committed a new migration/snapshot):
```bash
cd "C:/Users/TK/.aoa/wt/mem" && pnpm install && pnpm build && pnpm typecheck
```
Expected: PASS.

- [ ] **Step 2: Run the full unit/contract suite (non-watch)**

Run:
```bash
cd "C:/Users/TK/.aoa/wt/mem" && pnpm test:run
```
Expected: PASS — especially the memory suites (`memory-qa`, `identity-backfill`, `memory-insert-no-pgvector`, tier-policy / access-conditions / run-scope / core-block, and the RBAC/actor gate unit tests). A failure in a memory suite is a real finding — fix and re-run.

- [ ] **Step 2b: Run the two RBAC INTEGRATION tests (they skip by default on Windows — the highest-rigor gate must not)**

`memory-rbac-leakage.integration.test.ts` (run-path cross-scope leakage proof) and `mcp-memory-read-rbac.integration.test.ts` (MCP-path) are guarded by `describe.skipIf(win32 && AOA_RUN_WIN_INTEGRATION !== "1")`, so a plain `pnpm test:run` on Windows **skips** them — omitting the actual leakage proof from the gate. Run them explicitly against embedded-pg:
```bash
cd "C:/Users/TK/.aoa/wt/mem" && AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/server exec vitest run src/__tests__/memory-rbac-leakage.integration.test.ts src/__tests__/mcp-memory-read-rbac.integration.test.ts
```
Expected: both GREEN (10 tests, zero cross-scope leak). The retrieval e2e (pgvector) is NOT locally runnable — it is the Phase 4 `e2e-pgvector` CI lane (Task 4.3). **Do not declare the gate passed until that lane is green** (gate-back in Task 4.4).

- [ ] **Step 3: Generated-artifact drift checks (cheap, catches tool/skill manifest drift)**

Run:
```bash
cd "C:/Users/TK/.aoa/wt/mem" && pnpm gen:tools:check && pnpm gen:tools:md:check && pnpm gen:skills:check
```
Expected: PASS (no drift). `gen:skills:check` matters because the memory work touches skill seeding (`memory-skill-sync`). If drift, run the non-`:check` generators, review, and fold into the migration commit.

### Task 3.2: Adversarial security review of the memory diff

**Files:** none (review) — produces findings to fix

- [ ] **Step 1: Dispatch a skeptical code-review subagent with the exact mandate**

Use the `superpowers:code-reviewer` agent (or `/code-review`). Give it the diff `git diff origin/main...HEAD` and this mandate — instruct it to try to REFUTE safety, defaulting to "flag if uncertain":

1. `--allowedTools mcp__aoa` **breadth** (`packages/adapters/claude-local/src/server/execute.ts`) — it is a **server-wide** grant, so "memory-only?" is the WRONG trip-wire (the ORG `ORG_HEARTBEAT_TOOL_ALLOWLIST` in `heartbeat-mcp.ts` legitimately includes mutation tools — `set_task_status`, `post_task_comment`, `ask_human`). Ask instead: (a) is it unreachable without `--strict-mcp-config`/`--mcp-config`, so exposure is bounded to what `buildMcpConfig` writes (verified true today)? (b) enumerate the *actual* auto-approved set per run-type (ORG/Commander/crew) and confirm the server-wide grant stays bounded by the per-run `toolAllowlist → buildMcpConfig` coupling; (c) **did #318 WIDEN the auto-approved set vs pre-#318 behavior?** (d) how does it compose with `--dangerously-skip-permissions`?
2. **Actor-aware identity visibility** (`memory-policy.ts` `canSeeDurableMemory`, `memory-access.ts` `filterMemoryForActor`) — agents get identity; confirm NO path leaks non-identity layers cross-scope, and humans below team-lead are unchanged.
3. **MCP actor gate** (`mcp/server.ts` post-merge) — no new unauth'd path to memory in `authenticated`/`cloud_auth`; `actorForMcp` resolves the same protocol actor #316 intends; `local_trusted` still behaves.
4. **Crew fail-closed** on missing identity (D7/D8) holds post-rebase.
5. **The 7 merged files** — no dropped #316 semantics (independent read of Task 1.8 Step 3's diffs).

- [ ] **Step 2: Triage findings**

For each finding: fix in the relevant file, re-stage, re-run Task 3.1 Step 1–2, and record the resolution. Re-dispatch the reviewer on the fixed diff if any P1/P2 was material. Only proceed when no unresolved correctness/security finding remains.

### Task 3.3: Crew full end-to-end LLM run (lifts crew to full-LLM parity — must be NON-VACUOUS)

**Files:** none (live verification in the `mem-inst` sandbox)

Crew delivers memory by **prompt injection** into the run's `## Context` (not a `query_memory` tool call), so "the output mentions the vision" is near-trivial — the LLM just read its own prompt, and `AcmeMem`'s real vision is guessable/leakable via the task text. This task only means something if it (a) uses a non-guessable nonce, (b) asserts on the RENDERED run prompt, and (c) has a negative control.

- [ ] **Step 1: Boot the instance with the memory prereqs**

Start `mem-inst` (:3130 per handoff) with `AOA_STRIP_CC_ENV=1 AOA_RUNTIME_DECISION_ROUTING=1` + the instance's `AOA_HOME`/`PORT`/`PG` envs. Company `AcmeMem` `febba560-8625-4aa1-b61b-2207f76faef5`; crew agent `MemCrew` `3d0795bb`; confirm `runtimeConfig.runtimeDecisionRoutingEnabled=true`. **Retrieval note:** the always-on core (Vision/Mission/Values) is injected WITHOUT a vector, so the core-block assertion works with no embedder. To also exercise `searchMultiPath` (vector) retrieval, set `AOA_E2E_FAKE_EMBEDDER=1` (hash embedder) or a real `OPENAI_API_KEY`; otherwise retrieval degrades to keyword and this task proves the CORE path only — call that out in the evidence.

- [ ] **Step 2: Seed a NON-GUESSABLE nonce into memory**

Add an approved company memory item carrying a token the LLM cannot confabulate — e.g. `POST /api/companies/:cid/memory` (then approve) an identity/value item whose content includes `codeword: TANGERINE-7F` (pick a fresh token per run). This is what makes the test non-vacuous.

- [ ] **Step 3: Dispatch a real crew task whose acceptance requires the nonce**

Create a task assigned to `MemCrew` — e.g. "Report our company's stored codeword exactly." Dispatch it (thread autonomy Drive, or approve the `crew_dispatch`). Watch the run.

- [ ] **Step 4: PRIMARY assertion — the dispatched run's RENDERED prompt contained the memory**

Fetch the rendered prompt/context for THIS run and confirm its `## Context` block actually contained the seeded lines (incl. the nonce). This is the meaningful integration proof: thread-orchestration → crew dispatch wired the RBAC-gated bundle into the prompt (not that the LLM parroted it). SECONDARY: the run OUTPUT emits `TANGERINE-7F`. Capture run id + the `## Context` excerpt + output for the PR evidence comment.

- [ ] **Step 5: NEGATIVE CONTROL — a memory-absent run must NOT emit the nonce**

Dispatch the same ask to a crew agent scoped where that item is out of scope (different department, or item archived/unapproved). Expected: the nonce is ABSENT from both the rendered `## Context` and the output. If it appears without being in scope, the RBAC gate or bundle is leaking — a real finding. A miss in Step 4 or a leak in Step 5 blocks the crew-parity claim; investigate before landing.

---

## Phase 4 — Land PR #318

### Task 4.1: Push the integrated branch

- [ ] **Step 1: Freshness re-check — did `main` move during Phases 1–3?**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" fetch origin
git -C "C:/Users/TK/.aoa/wt/mem" log --oneline -1 origin/main
git -C "C:/Users/TK/.aoa/wt/mem" ls-tree -r --name-only origin/main packages/db/src/migrations | grep -E '/[0-9]{4}_.*\.sql$' | sort | tail -1
```
Expected: `origin/main` still `c1fe2e733` and the migration ceiling still `0201`. **If `main` advanced:** with a merge (not a rebase) you must `git merge origin/main` AGAIN and re-resolve; if the new head added a migration, redo Task 1.7 + Phase 2 for the new ceiling (e.g. `0203`) and re-run the Phase 3 gate. Do not push a stale merge.

- [ ] **Step 2: Push with lease (backup + tag already exist)**

Run:
```bash
git -C "C:/Users/TK/.aoa/wt/mem" push --force-with-lease origin claude/memory-enterprise-build
```
Expected: branch updated on origin; PR #318 recomputes and shows **no conflicts**.

- [ ] **Step 3: Confirm GitHub shows mergeable**

Run:
```bash
gh pr view 318 --repo MeteoriteLabs/AoA --json mergeable,mergeStateStatus,isDraft
```
Expected: `mergeable: MERGEABLE` (may be `UNKNOWN` briefly while GitHub computes — re-run). Still `isDraft: true`.

### Task 4.2: Un-draft to trigger the first real CI

- [ ] **Step 1: Mark ready for review**

Run:
```bash
gh pr ready 318 --repo MeteoriteLabs/AoA
```
Expected: PR flips to Ready; `pr.yml` jobs start (`verify`, `e2e`, **`e2e-pgvector`**, `migrations`, `policy`, `brand-check`) across Linux (required lane) / macOS / Windows, plus the `ci-required` aggregator. **`e2e-pgvector` is the memory feature's key lane** — it runs the embedding WRITE + RETRIEVAL e2e against a pgvector DB (the validation the local gate can't do) and feeds `ci-required`.

### Task 4.3: Drive CI green

- [ ] **Step 1: Watch the checks**

Run:
```bash
gh pr checks 318 --repo MeteoriteLabs/AoA --watch
```
Expected: the Linux jobs pass ⇒ `ci-required` goes green. **Watch `e2e-pgvector` specifically** — it is the authoritative memory write/retrieval proof the local gate couldn't run (Task 3.1 Step 2b covered only the RBAC integration tests). macOS advisory-green; Windows advisory (4 skips / e2e skipped) — non-blocking.

- [ ] **Step 2: Triage any red Linux job**

For a genuine failure: read the log (`gh run view --log-failed`), fix in source, commit, push, re-watch. For the known infra flakes: the Linux `e2e` job has the Google-CFT fallback; a Playwright-CDN stall is re-run-able.

- [ ] **Step 3: Confirm `llm-eval` is advisory, not required**

Run:
```bash
gh pr view 318 --repo MeteoriteLabs/AoA --json statusCheckRollup | \
  tr ',' '\n' | grep -iA2 'llm-eval'
gh api repos/MeteoriteLabs/AoA/branches/main/protection/required_status_checks 2>/dev/null | grep -i llm-eval || echo "llm-eval NOT in required checks (advisory ✓)"
```
Expected: `llm-eval NOT in required checks (advisory ✓)`. If it IS required, treat its failure as real and investigate before hand-off. (Open question from spec §9 — resolve here.)

### Task 4.4: Assemble evidence and hand to the founder

- [ ] **Step 1: Gate-back — confirm the CI-only proofs are green before declaring the gate passed**

The Phase 3 local gate could NOT run `e2e-pgvector` (retrieval). Before hand-off, confirm on the green run:
```bash
gh pr checks 318 --repo MeteoriteLabs/AoA | grep -E 'e2e-pgvector|migrations|verify|e2e'
```
Expected: `e2e-pgvector` + `migrations` + `verify` + `e2e` all pass — these close the memory-retrieval + RBAC + migration proofs the local gate deferred. A red here **reopens** the evidence gate.

- [ ] **Step 2: Write the migration regen recipe into the PR DESCRIPTION (survives the next main-merge re-collision)**

Run:
```bash
gh pr edit 318 --repo MeteoriteLabs/AoA --body-file <pr-body.md>
```
The body must include the recurring-collision recipe (delete my migration `.sql`, take main's meta, `pnpm db:generate` → next number) so whoever rebases after the next `main` merge doesn't rediscover it. (Design §4 mandates this in the description, not just a comment.)

- [ ] **Step 3: Post the evidence summary as a PR comment**

Include: typecheck + full-suite result (incl. the `AOA_RUN_WIN_INTEGRATION=1` RBAC run), the adversarial-review findings + resolutions, the `e2e-pgvector` result, and the crew full-LLM run id + the `## Context` excerpt + nonce output (Task 3.3). Run:
```bash
gh pr comment 318 --repo MeteoriteLabs/AoA --body-file <evidence.md>
```

- [ ] **Step 4: Hand off — do NOT merge**

Report to the founder: `ci-required` green (incl. `e2e-pgvector`), mergeable, evidence posted. **Merging is the founder's click** (this plan stops at "green + reviewed + ready"). Do not run `gh pr merge`.

---

## Phase 5 — Stacked verify-probe PR (separate plan)

**Scope check:** the verify-probe fix is an independent subsystem (`claude_local` adapter, not memory) and lands AFTER #318 merges. Per the writing-plans scope rule it gets its **own** spec → plan cycle rather than being force-fit here. This section is the scoping stub for that follow-up.

- [ ] **Step 1: After #318 lands, branch off updated main**

```bash
git -C "C:/Users/TK/.aoa/wt/mem" fetch origin && git -C "C:/Users/TK/.aoa/wt/mem" switch -c fix/claude-local-verify-probe origin/main
```

- [ ] **Step 2: Write the fix's spec + plan (own cycle)**

Problem: the `claude_local` `testEnvironment` probe reports `needs_auth` on a healthy, logged-in agent because it does NOT copy-and-isolate the config the way a real (D9) run does. **Entry points (verify before designing):** `testEnvironment` lives in `packages/adapters/claude-local/src/server/test.ts`; the auth probe in `auth-status.ts`; the copy-isolate machinery a real run uses (`provisionClaudeConfigHome` / `createIsolatedClaudeConfigDir`, copying only `.credentials.json`) is in `execute.ts` (~L456–530). **Reconcile with existing intent:** `test.ts` currently *documents* that it deliberately does not copy-isolate — it keeps `CLAUDE_CONFIG_DIR` and strips only the ambient auth key so the probe reads the very file T3 would copy. So the fix is a deliberate trade-off (make the probe copy-isolate like the run), NOT an oversight to paper over; the new spec must decide it explicitly and must not regress the ambient-strip logic. TDD: failing test asserting the probe reflects a healthy isolated-config agent → fix → pass. Gate: typecheck + adapter tests + a manual Settings-probe check against a known-good agent. Founder merges.

---

## Self-review notes (author)

- **Spec coverage:** §2 correction (no Commander fix) ⇒ no Commander task, crew handled as verification (Task 3.3) ✓. §3 Hybrid ⇒ #318 (Phases 0-4) + stacked probe (Phase 5) ✓. §4 conflicts+migration ⇒ Phase 1-2 ✓. §5 gate ⇒ Phase 3 ✓. §6 landing ⇒ Phase 4 ✓. §7 probe ⇒ Phase 5 ✓.
- **Deviation flagged:** merge-vs-rebase callout at top for user veto.
- **No placeholders:** every code block is the real diff content; every command is a real script name.
- **Open questions (spec §9):** `llm-eval` advisory status resolved in Task 4.3 Step 3; crew full-LLM gap resolved in Task 3.3 Step 3.

## Adversarial review pass (2026-08-05)

An independent subagent reviewed this plan against the live branch (via `git merge-tree` simulation). Eight findings, all fixed inline:

1. **[MAJOR, fixed]** Task 1.7 Step 2 deleted *main's* `0188_organizations` snapshot after checking out main's meta → silent hole in the chain. Now deletes only my orphan `.sql`; keeps main's snapshot.
2. **[MAJOR, fixed]** The conflict surface was inverted — `git merge-tree` shows only **4 files conflict** (`companies.ts`, `index.ts`, 2 meta); the two "careful" security files (`mcp/server.ts`, `heartbeat.ts`) **auto-merge**, and Task 1.1 said "skip auto-merged." Reframed: File-map + Task 1.1 relabelled (4 conflict / 5 auto-merge); Tasks 1.2/1.5/1.6 are now verification; the two security files get a **mandated full human diff read** (Task 1.5 Step 4, Task 1.6 Step 5). The auto-merges were verified semantically correct.
3. **[MAJOR, fixed]** Task 1.8 Step 3's add-only battery false-alarmed on `heartbeat.ts` (legit replacement deletions). Now excludes the 2 security files (covered by their diff reads) and checks only the 5 purely-additive files.
4. **[MAJOR, fixed]** Task 2.3 Step 2 `pnpm db:migrate` throws without `DATABASE_URL` (custom runner, no embedded PG). Now defers to the Linux `migrations` CI lane, with an explicit optional local path.
5. **[MINOR, fixed]** Task 1.3 anchor named the exact `router.patch("/:companyId", validate(updateCompanySchema))` handler + `company.updated` `logActivity` (#316 has 5 `logActivity` calls).
6. **[MINOR, fixed]** Task 3.1 Step 3 added `pnpm gen:skills:check`.
7. **[NIT, fixed]** Design §5(b) `pnpm test` → `pnpm test:run` (watch-mode hang).
8. **[NIT, fixed]** Task 1.8 Step 2 now asserts exact grep counts (≥2 for import+mount / import+call) instead of `grep -c` passing on ≥1.

Verified SOUND by the reviewer: both-sides set is exactly 9 files; `0202` is the correct target; `drizzle.config.ts` globs `dist/schema/*.js` (not the barrel) so a botched `schema/index.ts` merge cannot emit `DROP TABLE`; the auto-merges are semantically correct (`protocolActor`/`scope` wired; heartbeat imports resolve); ordering/safety (tag before merge, force-with-lease with backup) is fine.

## Second review round — engineering plan review, 2 independent outside voices (2026-08-05)

A `superpowers:code-reviewer` agent (eng-soundness lens on Phases 3-5 + design decisions) and a second `general-purpose` reviewer (completeness / risk / consistency, verifying the 8 first-round fixes). No BLOCKER; both confirmed the merge mechanics + merge-vs-rebase call are sound (the verification battery survives a merge commit; `e2e-pgvector`/`llm-eval` reasoning validated). The gaps were in the **evidence gate not meeting its own "highest rigor" bar** + one consistency bug from the first-round edits. All fixed inline:

1. **[MAJOR, fixed]** Task 3.3 crew run was **vacuous** — crew delivers memory via prompt-injection, and `AcmeMem`'s vision is guessable, so "output mentions vision" proved nothing. Rewrote to seed a **non-guessable nonce**, assert on the **rendered run `## Context`**, add a **memory-absent negative control**, and note the embedder prereq for the retrieval (vs core) path.
2. **[MAJOR, fixed]** Phase 3 skipped the two **RBAC integration tests** on Windows (`skipIf(win32 && !AOA_RUN_WIN_INTEGRATION)`). Added Task 3.1 **Step 2b** to run them via `AOA_RUN_WIN_INTEGRATION=1` + embedded-pg.
3. **[MAJOR, fixed]** Phase 4 never named **`e2e-pgvector`** (the memory write/retrieval required lane in `ci-required.needs`). Added it to the job list (Task 4.2/4.3) + a **gate-back** (Task 4.4 Step 1) making it + integration green mandatory before hand-off.
4. **[MAJOR, fixed]** No **`pnpm install && pnpm build`** before the local typecheck — after merging #316's lockfile+source changes the gate would run on stale `dist`/`node_modules`. Added to Task 1.8 Step 4 + Task 3.1 Step 1.
5. **[MAJOR, fixed]** Task 3.2's `--allowedTools` review mandate used a wrong baseline ("memory-only?"). Reframed to "did #318 widen the auto-approved set?" + acknowledge the ORG allowlist's mutation tools + the `--strict-mcp-config` bound.
6. **[MINOR, fixed]** Consistency bug from round 1: File-map note said the security diff reads were "(Step 3)" — corrected to Task 1.5 Step 4 / Task 1.6 Step 5.
7. **[MINOR, fixed]** Phase 5 pointed at the wrong file (`execute.ts`) for the probe — corrected to `test.ts` + `auth-status.ts`, and flagged that the probe's non-isolation is *deliberate* (the fix is a conscious trade-off, not an oversight).
8. **[MINOR, fixed]** Added a pre-un-draft **freshness re-check** (Task 4.1 Step 1) for `main` moving mid-execution; the **regen recipe into the PR description** (Task 4.4 Step 2); an explicit **`git merge --abort`/restore** recovery path in the two security diff reads.
9. **[NIT, fixed]** Stale expected-HEAD → `d7d285d88`; `chk "agentRole"` tightened to `"agentRole: agent.role"` (it appeared 4× independently); `logActivity` miscount 4 → 5.
