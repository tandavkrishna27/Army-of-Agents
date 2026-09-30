# Whole-PR Re-Review Fix Batch 4 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remediate the five reachable/hardening findings from the dual re-review on HEAD `276ac202` (branch `claude/multitenant-cloud`, worktree `C:/Users/TK/.aoa/wt/mt-cloud`, PR #316): the WS membership-revocation gap (bot P1), the normalizer-500 completion, the Commander-compaction operator-login sink, the stale security docs, and the migrator advisory lock. Deferred (NOT in this batch): tenant Docker-limit clamp (#1, gVisor follow-up), 0188 drop-default (#2, needs a fail-closed audit), crew `org_default` (#9, needs the deferred assign-API). Bot's "replace hand-edited migrations" (#8) is infeasible and dismissed on the PR.

**Architecture:** Five independent, mostly file-disjoint changes. #3/#7 are app-layer correctness/isolation; #5 is a cloud-gated CLI-sink guard; #6 is doc-only; #4 is a DB-migrator concurrency guard. No schema change, no new migration. Deployment-mode discipline: #5 is gated on `tenantIsolationEnforced()` (a strict no-op self-hosted); #7's sweep is scoped to cloud_auth/authenticated; #3/#4/#6 are mode-agnostic and safe.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM, `postgres` (postgres.js), vitest. Server test cmd (server has NO `test` script): from the worktree root run `pnpm test:run <pattern>`. Typecheck: `pnpm -r typecheck`. `packages/db` has its own suite.

---

## Findings → Task map

| # | Finding | Severity | Task |
|---|---------|----------|------|
| 3 | Missing identifier → 500 on artifacts/output-detection/task-outputs/dependencies (my `getById` guard only covered feedback) | P2 (my incomplete fix) | Task 1 |
| 5 | Commander compaction spawns ambient `claude`/`codex` under the operator login on cloud | P2 | Task 2 |
| 6 | Stale security docs (`execution-targets.ts` worker-token comment; Decision #117 §4 "tracked as D1") + #2 tracking note | P3 docs | Task 3 |
| 4 | Concurrent replicas race the auto-migrator (no advisory lock) | P2 | Task 4 |
| 7 | Cloud WS never re-checks membership after handshake → revoked member keeps receiving events (bot P1) | P1 (bounded) | Task 5 |

---

## File Structure

- `server/src/routes/issue-param-normalizer.ts` (`normalizeIssueParam` ~:22-34; `ISSUE_IDENTIFIER_RE` :6) — Task 1.
- `server/src/services/internal-agent/cli-summarizer.ts` (`summarizeViaCli` :19; spawn :44-48) — Task 2.
- `server/src/services/execution-targets.ts` (:81-83, :90 comments) + `docs/architecture/decisions.md` (§117 point 4, ~:1791) + `packages/db/src/schema/companies.ts` (:15, the #2 tracking note) — Task 3.
- `packages/db/src/client.ts` (`applyPendingMigrations` :649-683) + `docs/deploy/*` (topology note) — Task 4.
- `server/src/realtime/live-events-ws.ts` (handshake `authorizeUpgrade` cloud_auth block ~:181-228; connection handler :458-497; presence sweep pattern :439-456) — Task 5. **This file is git-BINARY (pre-existing NUL byte) — read it directly, don't trust git diff.**

---

### Task 1: Normalizer returns 404 on an identifier-shaped miss (close the 4 remaining 500s)

**Root cause:** `normalizeIssueParam` (`issue-param-normalizer.ts:22-34`) returns the RAW identifier string on a resolution miss. My `getById` `isUuidLike` guard (`fda43a6f`) only saved `feedback.ts` (the one route that resolves via `getById`); `artifacts`, `output-detection`, `task-outputs`, `dependencies` feed the raw `"ACM-999"` into UUID columns → Postgres `22P02` → un-statused → 500. Fix at the shared normalizer: when the param is identifier-shaped (`ISSUE_IDENTIFIER_RE`) but resolution misses, `throw notFound(...)` — closing all four at once before any handler runs. A real UUID cannot match `ISSUE_IDENTIFIER_RE` (`/^[A-Z]+-\d+$/i`), so a genuine-but-absent UUID still flows through to the handler's own 404.

**Files:**
- Modify: `server/src/routes/issue-param-normalizer.ts`
- Test: `server/src/__tests__/issue-param-normalizer.test.ts` (new) OR extend an existing normalizer test

- [ ] **Step 1: Write the failing unit test**

Read `issue-param-normalizer.ts` fully first. `createIssueParamNormalizer(db)` (or the exported factory) resolves via `issues.getByIdentifier`/`getByIdentifierInCompany`. Write a unit test with a mock issues service (or a mock db) asserting:
- identifier-shaped miss (`getByIdentifier` returns null for `"ACM-999"`) → the normalizer THROWS an `HttpError` with `status: 404` (not returns the raw string).
- a genuine UUID that doesn't match `ISSUE_IDENTIFIER_RE` → passes through unchanged (returned as-is, so the handler can 404 it itself).
- an identifier that RESOLVES → returns the resolved `issue.id`.
Match the file's real resolve path + how it gets the issues service. If a mock-db harness is awkward, mock the `issueService` methods the normalizer calls.

- [ ] **Step 2: Run — verify FAIL** (`pnpm test:run issue-param-normalizer`) — the identifier-shaped-miss case currently returns the raw string, not a 404 throw.

- [ ] **Step 3: Implement**

In `normalizeIssueParam`, at the identifier-shaped branch, replace the fall-through `return rawId` (on a resolution miss) with a `throw notFound(...)` — but ONLY when `ISSUE_IDENTIFIER_RE.test(rawId)` matched (so non-identifier / UUID inputs still `return rawId`). Roughly:
```ts
  if (ISSUE_IDENTIFIER_RE.test(rawId)) {
    const issue = companyId
      ? await issues.getByIdentifierInCompany(companyId, rawId)
      : await issues.getByIdentifier(rawId, accessibleCompanyIds);
    if (issue) return issue.id;
    throw notFound(`Task ${rawId} not found`);   // was: fell through to `return rawId`
  }
  return rawId;   // non-identifier-shaped (UUID / other) → handler's own lookup/404
```
Add `import { notFound } from "../errors.js";` (`notFound` → `HttpError(404)`, `errors.ts:24`; already imported by sibling route files). The 409-ambiguous `conflict` throw lives INSIDE `issueService.getByIdentifier` (not the normalizer) and simply propagates — don't touch it; keep the `getByIdentifierInCompany`/`accessibleCompanyIds` threading exactly as-is (read the file for the current signature). Leave `issueService.getById`'s `isUuidLike` guard in place as defense-in-depth.

- [ ] **Step 4: Run — verify PASS** (`pnpm test:run issue-param-normalizer`), then `pnpm test:run "artifacts|task-outputs|output-detection|dependencies|feedback"` to confirm no route-test regression (some mock the normalizer to a no-op + pass UUIDs — those stay green).

- [ ] **Step 5: Commit**
```bash
git add server/src/routes/issue-param-normalizer.ts server/src/__tests__/issue-param-normalizer.test.ts
git commit -m "fix(routes): normalizer returns 404 on identifier-shaped miss (close 22P02->500 on 4 bare routes)"
```

---

### Task 2: Fail closed on Commander compaction under cloud_auth + tmpdir cwd

**Root cause:** `summarizeViaCli` (`cli-summarizer.ts:19`) spawns ambient `claude`/`codex` with NO `env` override and NO tenant guard (spawn at :44-48), so on cloud_auth it summarizes tenant transcripts under the OPERATOR's host login — the same class as the extraction fail-open already fixed (`extractViaCli`). The single production caller (`agent-loop.ts:611`) already wraps it in try/catch (best-effort), so skipping compaction degrades gracefully. It also omits `cwd`, so `claude` can walk up and read the project `CLAUDE.md` (the internal-detail leak the chat + extraction paths both guard with `cwd: tmpdir()`).

**Files:**
- Modify: `server/src/services/internal-agent/cli-summarizer.ts`
- Test: `server/src/__tests__/cli-summarizer.test.ts` (new) OR extend if one exists

- [ ] **Step 1: Write the failing test**

Import `setDeploymentMode` from `../config/deployment-mode.js` (path from the test dir). Reset in `afterEach`. Add:
```ts
describe("summarizeViaCli — cloud_auth fail-closed", () => {
  afterEach(() => setDeploymentMode("local_trusted"));
  it("refuses on cloud_auth without spawning a CLI", async () => {
    setDeploymentMode("cloud_auth");
    await expect(summarizeViaCli({ cliTool: "claude", transcript: "hello" }))
      .rejects.toThrow(/AoA Cloud|cloud_auth/i);
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`pnpm test:run cli-summarizer`) — currently it tries to spawn.

- [ ] **Step 3: Implement**

In `cli-summarizer.ts`: add `import { tenantIsolationEnforced } from "../../config/deployment-mode.js";` and `import { tmpdir } from "node:os";` (the file already imports `platform` from `node:os` — combine). At the very top of `summarizeViaCli` (before `const isWin = …`):
```ts
  // Fail closed on AoA Cloud (cloud_auth): compaction must not summarize tenant
  // transcripts through the shared host's operator login (the same class as the
  // extraction fail-closed guard). The single caller (agent-loop.ts) treats any
  // throw as "skip compaction this turn", so context simply isn't compacted on
  // cloud until a per-tenant isolated summarization path exists.
  if (tenantIsolationEnforced()) {
    throw new Error(
      "Compaction is unavailable on AoA Cloud (cloud_auth): no per-tenant isolated summarization path yet.",
    );
  }
```
Then add `cwd: tmpdir()` to the `spawn(bin, argv, { … })` options (alongside `stdio`/`shell`) so the summarizer can't read the project `CLAUDE.md`.

- [ ] **Step 4: Run — verify PASS** (`pnpm test:run cli-summarizer`). Confirm the guard is a no-op self-hosted (default `local_trusted` → `tenantIsolationEnforced()` false → proceeds to spawn as before).

- [ ] **Step 5: Commit**
```bash
git add server/src/services/internal-agent/cli-summarizer.ts server/src/__tests__/cli-summarizer.test.ts
git commit -m "fix(commander): fail closed on cloud compaction + tmpdir cwd (no operator-login transcript processing)"
```

---

### Task 3: Correct stale security docs + add the 0188 default tracking note

**Root cause:** (a) `execution-targets.ts:81-83` + `:90` docstrings still say the row's primary-key UUID "doubles as the worker bearer token" — contradicting the shipped `worker_token_hash` reality (same file :6-8, schema :32-34, route :22-27). The security *conclusion* (don't leak system rows to tenant admins) is still valid; only the rationale is stale. (b) Decision #117 point 4 (`decisions.md:~1791`) still says the shared-infra `company_api_key` local fallback is "tracked as D1" and "silently falls back" — but the D1 guard now EXISTS in this branch and fails closed. (c) Add a one-line tracking note that 0188's persisting sentinel `organization_id` DEFAULT (`schema/companies.ts:15`) is an intentional single-org belt-and-suspenders that must be dropped (fail-closed) before multi-org write paths go live (deferred #2).

**Files (doc/comment only — NO behavior change):**
- Modify: `server/src/services/execution-targets.ts` (:81-83, :90)
- Modify: `docs/architecture/decisions.md` (§117 point 4, ~:1791)
- Modify: `packages/db/src/schema/companies.ts` (:15 — add the #2 tracking comment)

- [ ] **Step 1: Fix the worker-token comments (`execution-targets.ts`)**

Read :78-92. Rewrite the two stale spots (:81-83 "primary-key UUID doubles as the worker bearer token"; :90 "its id doubles as the worker bearer token") to reflect reality: the row id is NO LONGER a credential — worker auth is by SHA-256 `worker_token_hash` (`resolveWorkerTargetId`, `routes/execution-targets.ts:22-27`). Keep the security conclusion (a system row must not be returned to / mutated by a tenant admin — a tenant admin could still offline an operator target by id via `registerWorkerHeartbeat`). Fix the cross-ref if it points at a now-wrong line.

- [ ] **Step 2: Fix Decision #117 point 4 (`decisions.md:~1791`)**

Change the "tracked as D1" / "silently falls back to the local driver on shared infra" wording to state the D1 guard (`assertUnsandboxedMultitenantAllowed`) now EXISTS in this branch and FAILS CLOSED on cloud_auth (refuses the local + non-`runsc` fallback unless `AOA_ALLOW_UNSANDBOXED_MULTITENANT=1`) — no longer merely tracked or silent. Keep the rest of point 4 intact.

- [ ] **Step 3: Add the 0188 default tracking note (`schema/companies.ts:15`)**

At the `organization_id` column (`.notNull().default("00000000-0000-0000-0000-000000000001")`), add a comment: the sentinel DEFAULT is an intentional single-org belt-and-suspenders; it is fail-OPEN (an insert omitting `organization_id` buckets into the sentinel org rather than erroring) and MUST be dropped (so NULL fails the NOT NULL constraint = fail closed) before multi-org write paths go live — tracked as a follow-up (do NOT drop it in #316; that needs every insert path audited to set `organization_id` first).

- [ ] **Step 4: Verify + commit**

Run `git diff server/src/services/execution-targets.ts docs/architecture/decisions.md packages/db/src/schema/companies.ts` — comment/doc text only, no code/logic change. Run `pnpm --filter @armyofagents/db build` (or `db:generate`) to confirm the schema comment doesn't cause drift (it won't — comments aren't DDL).
```bash
git add server/src/services/execution-targets.ts docs/architecture/decisions.md packages/db/src/schema/companies.ts
git commit -m "docs: correct stale worker-token + Decision #117 D1 comments; note 0188 sentinel default is deferred fail-closed work"
```

---

### Task 4: Serialize the auto-migrator with a Postgres advisory lock

**Root cause:** `applyPendingMigrations` (`client.ts:649-683`) does inspect → migrate → reconcile → apply with NO advisory lock. Cloud replicas auto-apply on boot (non-TTY → auto-apply, `index.ts:157`), so two replicas booting together can both see the same pending set and race non-idempotent DDL (0188's `ADD COLUMN`/`ADD CONSTRAINT` have no `IF NOT EXISTS`). Per-file transactions prevent half-apply (worst case today = a self-healing boot crash of the loser), but a session-level advisory lock makes it clean. Precedent: `first-user-bootstrap.ts:40` uses `pg_advisory_xact_lock(hashtext('aoa:first-admin-bootstrap'))`.

**Files:**
- Modify: `packages/db/src/client.ts` (`applyPendingMigrations`)
- Doc: `docs/deploy/` (topology note — "migrate as a single job")
- Test: `packages/db`'s test suite (a focused test that the lock/unlock wrap the apply)

- [ ] **Step 1: Write the failing test**

`packages/db` has NO postgres-mock harness (its tests are schema-contract tests + real-DB embedded-PG integration tests, e.g. `migration-idempotency.test.ts`, `revert-0188.integration.test.ts`) — do NOT build a `postgres` mock. Two realistic options: (a) a **source-structural** assertion (read `client.ts` and assert `applyPendingMigrations` contains `pg_advisory_lock(` before the migrate and `pg_advisory_unlock(` in a `finally`, and a re-inspect under the lock) — mirrors how the repo pins hard-to-harness code; or (b) a **real-DB integration** test (embedded-PG) that runs `applyPendingMigrations(url)` twice concurrently against the same DB and asserts both resolve without error (one waits on the lock). Prefer (b) if the embedded-PG harness is readily reusable; otherwise (a) is acceptable given the real-DB nature.

- [ ] **Step 2: Run — verify FAIL** (the lock isn't present yet).

- [ ] **Step 3: Implement**

Wrap the body of `applyPendingMigrations` in a session-level advisory lock held on a dedicated `max:1` connection across the WHOLE inspect+apply, re-inspecting under the lock (TOCTOU: another replica may have migrated while we waited):
```ts
export async function applyPendingMigrations(url: string): Promise<void> {
  const initialState = await inspectMigrations(url);
  if (initialState.status === "upToDate") return;

  // Finding #4: serialize concurrent-replica migrations. Cloud replicas
  // auto-apply on boot; hold a session-level advisory lock across inspect+apply
  // so two replicas don't both run non-idempotent DDL (e.g. 0188 ADD COLUMN).
  const lockSql = postgres(url, { max: 1 });
  try {
    await lockSql`SELECT pg_advisory_lock(hashtext('aoa:migrations'))`;
    // Re-inspect under the lock — a peer may have migrated while we waited.
    const stateUnderLock = await inspectMigrations(url);
    if (stateUnderLock.status === "upToDate") return;

    const sql = postgres(url, { max: 1 });
    try {
      const db = drizzlePg(sql);
      await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await sql.end();
    }

    let state = await inspectMigrations(url);
    if (state.status === "upToDate") return;
    const repair = await reconcilePendingMigrationHistory(url);
    if (repair.repairedMigrations.length > 0) {
      state = await inspectMigrations(url);
      if (state.status === "upToDate") return;
    }
    if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
      throw new Error("Migrations are still pending after attempted apply; run inspectMigrations for details.");
    }
    await applyPendingMigrationsManually(url, state.pendingMigrations);
    const finalState = await inspectMigrations(url);
    if (finalState.status !== "upToDate") {
      throw new Error(`Failed to apply pending migrations: ${finalState.pendingMigrations.join(", ")}`);
    }
  } finally {
    // Best-effort unlock, then close the lock connection (ending the session
    // also releases the advisory lock, so failure here is non-fatal).
    try { await lockSql`SELECT pg_advisory_unlock(hashtext('aoa:migrations'))`; } catch { /* session end releases it */ }
    await lockSql.end();
  }
}
```
Confirm `postgres` (the postgres.js factory) is already imported in `client.ts` (it is — `inspectMigrations`/`migratePostgresIfEmpty` use it). Keep behavior identical except for the lock + the under-lock re-inspect early-return.

- [ ] **Step 4: Document the topology**

In the relevant `docs/deploy/` file (database/deployment guide — grep for the migration/boot section), add a short note: for multi-replica cloud deployments, run migrations as a single init-job/container rather than relying on every replica's boot-time auto-apply; the advisory lock is defense-in-depth, not a substitute for a single migration job.

- [ ] **Step 5: Run tests + verify no regression**

`pnpm --filter @armyofagents/db test` (or the repo's db test entry) — the migration/real-DB tests must still pass (the lock must not deadlock a single migrator or break the chain). `pnpm --filter @armyofagents/db build` + `db:generate` no-drift.

- [ ] **Step 6: Commit**
```bash
git add packages/db/src/client.ts docs/deploy/
git commit -m "fix(db): serialize auto-migrator with a pg advisory lock (concurrent-replica safety) + topology note"
```

---

### Task 5: Re-validate cloud WS membership after handshake (close the revocation gap)

**Root cause:** In cloud_auth, `authorizeUpgrade` (`live-events-ws.ts` cloud_auth block ~:181-228) checks active org+company membership ONLY at the WebSocket handshake. The per-event fan-out (connection handler :458-497) never rechecks membership: the non-thread/non-hub branch (:480-482) sends every company-bus event unconditionally, and the thread/hub paths recompute only a ROLE (`resolveBoardRole`, which defaults to `team_member` on zero rows — doesn't fail closed). So a member whose membership is revoked mid-session (the wired founder `removeMember` route deletes the membership but never closes the socket) keeps receiving events until they disconnect. Fix: a bounded-staleness re-validation sweep — periodically re-run the handshake membership predicate per open cloud board socket and close (1008) those that fail. Don't rely on role downgrade as the safety net; key off actual membership rows and cover the widest (:480-482) channel by closing the socket.

**Files:**
- Modify: `server/src/realtime/live-events-ws.ts` (**git-BINARY — read directly, verify by reading not git diff**)
- Test: `server/src/__tests__/upgrade-auth.test.ts` (already imports this module + has an `agents`/membership-aware mock DB) OR a new `hasActiveCloudMembership.test.ts`

- [ ] **Step 1: Extract + unit-test `hasActiveCloudMembership` (RED first)**

Read `authorizeUpgrade`'s cloud_auth block (~:181-228) — the `Promise.all([organizationMemberships lookup, companyMemberships lookup])` + `if (!orgMembership || !companyMembership) return null`. Extract it into an exported helper:
```ts
export async function hasActiveCloudMembership(
  db: Db,
  companyId: string,
  userId: string,
): Promise<boolean> {
  // company must belong to an org; user must have an ACTIVE org membership for
  // that org AND an ACTIVE company membership. Mirrors the handshake gate so the
  // revalidation sweep and the handshake agree.
  const companyRow = await db.select({ organizationId: companies.organizationId })
    .from(companies).where(eq(companies.id, companyId)).then((r) => r[0] ?? null);
  const organizationId = companyRow?.organizationId ?? null;
  if (!organizationId) return false;
  const [orgMembership, companyMembership] = await Promise.all([ /* … active org membership … */, /* … active company membership … */ ]);
  return Boolean(orgMembership && companyMembership);
}
```
(Copy the EXACT existing queries from `authorizeUpgrade` so behavior is identical; then have `authorizeUpgrade`'s cloud_auth block call this helper.) Write a unit test (in `upgrade-auth.test.ts`, reusing `makeUpgradeAuthDb`, or a new file) asserting: active org+company → true; missing org membership → false; missing company membership → false; company with no organizationId → false.

- [ ] **Step 2: Run — verify FAIL** (`pnpm test:run upgrade-auth` or the new test) — helper doesn't exist yet.

- [ ] **Step 3: Implement the helper + refactor the handshake to use it**

Add `hasActiveCloudMembership` (exported). Refactor the cloud_auth branch of `authorizeUpgrade` to `if (!(await hasActiveCloudMembership(db, companyId, userId))) return null;` (preserving the exact same behavior — verify by reading the binary file). Confirm `companies`, `organizationMemberships`, `companyMemberships`, `eq`, `and` are imported (they are).

- [ ] **Step 4: Add the membership re-validation sweep**

In `setupLiveEventsWebSocketServer`, following the existing `presenceSweepInterval` (:439-456) + `aliveByClient`/`cleanupByClient` maps pattern:
- Add a `contextByClient = new Map<WsSocket, UpgradeContext>()`; populate it in the `connection` handler (`context` is already in scope at :459) and delete on socket close (wherever `cleanupByClient`/`aliveByClient` are cleared).
- Add a `membershipSweepInterval = setInterval(async () => { … }, <interval>)` (e.g. reuse/parallel the ping cadence — ~30s). For each `[socket, ctx]` in `contextByClient` where `ctx.actorType === "board"` AND `opts.deploymentMode === "cloud_auth"`: if `!(await hasActiveCloudMembership(db, ctx.companyId, ctx.actorId))`, call **`socket.close(1008, "membership revoked")` ONLY** — do NOT manually delete the maps here (the socket's existing `close` handler owns full teardown: it calls the stored `unsubscribe()` from `cleanupByClient` then deletes the map entries; manually deleting here would skip `unsubscribe()` and LEAK the company-bus subscription). Agent sockets are covered by the existing terminated/pending checks — skip them. Wrap per-socket checks in try/catch so one failure doesn't abort the sweep (Map tolerates concurrent deletion across `await`; `close()` on an already-closing socket is a no-op).
- Add `contextByClient.delete(socket)` inside the existing `socket.on("close", …)` cleanup (alongside the `cleanupByClient`/`aliveByClient` deletes) so the map doesn't grow unbounded.
- Ensure the new interval is cleared in the existing `wss.on("close", …)` teardown alongside `presenceSweepInterval` (grep for where `clearInterval(presenceSweepInterval)` / the ping interval is cleared).

> **MUST scope the sweep to `cloud_auth` ONLY.** `hasActiveCloudMembership` enforces the CLOUD invariant (active **org** membership AND company membership). The `authenticated` handshake admits users via **instance_admin OR company membership with NO org-membership requirement**, so running this helper against `authenticated`/`local_trusted` sockets would falsely evict instance_admins (no org row) and ordinary authenticated members (no `organizationMemberships` rows) — a mass-disconnect regression. The sweep must be a strict no-op outside `cloud_auth`. Per-sweep cost is bounded (N cloud board sockets × 2 indexed queries per interval), far cheaper than per-event.

- [ ] **Step 5: Run tests + verify**

`pnpm test:run upgrade-auth` (helper + handshake green) and `pnpm test:run "live-events|hub-items-live-events|thread-event"` (no WS regression), then `pnpm -r typecheck`. Verify the `live-events-ws.ts` change by READING the file (binary).

- [ ] **Step 6: Commit**
```bash
git add server/src/realtime/live-events-ws.ts server/src/__tests__/upgrade-auth.test.ts
git commit -m "fix(realtime): re-validate cloud WS membership on a sweep; close sockets on revocation (bounded staleness)"
```

---

## Post-batch verification (controller)

- [ ] Full suite with REAL exit capture (NOT piped through tail): `pnpm test:run > /tmp/mt-suite4.log 2>&1; echo "VITEST_EXIT=$?" >> /tmp/mt-suite4.log`. Read the tail; classify any reds — expect only the known Windows parallel-starvation flakes (opencode `execute-*`, factory-import contract tests), which pass in isolation. Any test touching a changed file that fails in ISOLATION is real — fix it (watch for stale call-arg assertions from the normalizer/summarizer signature).
- [ ] `pnpm -r typecheck` (exit 0)
- [ ] `node scripts/check-forbidden-tokens.mjs` (no new AOA_* env)
- [ ] `pnpm db:generate` → `git status` shows no new migration
- [ ] Confirm `live-events-ws.ts` change by READING the file (binary)
- [ ] Final holistic cross-cutting review over the whole batch diff
- [ ] Push; PR comment (summary + reply to the bot's #8 citing Decision #19/C14 + note #1/#2/#9 deferred to the gVisor/org-runtime follow-up); tell the user to run their own review

## Deferred (tracked — follow-up branch, NOT this batch)

- **#1** tenant Docker-limit clamp (`execution-target.ts:147`) — only bites once the gVisor pool ships; belongs with the gVisor execution-isolation initiative.
- **#2** drop the 0188 sentinel default (fail-closed) — needs every company-insert path audited first; too risky for a QA PR (Task 3 adds only the tracking note).
- **#9** crew `org_default` org resolution — latent until the deferred provider create/assign API exists; must be done uniformly across all three callers then.
- **#8** "replace hand-edited migrations" — infeasible (drizzle-kit can't emit backfills/idempotency guards); dismissed on the PR with a Decision #19 / C14 pointer.
