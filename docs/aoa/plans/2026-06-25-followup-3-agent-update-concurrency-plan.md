# Agent-Update Optimistic Concurrency (Follow-up #3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OPTIONAL optimistic concurrency to agent updates so two concurrent editors can't silently clobber each other. The token is the existing `updatedAt` (no DB migration). When the client sends `expectedUpdatedAt` and the row changed underneath, the write returns HTTP **409** (with the current `updatedAt` in the body so the client can refetch). When `expectedUpdatedAt` is absent, behavior is unchanged last-write-wins (full back-compat). Scope is the whole `agents` row.

**Architecture:** Token = `agents.updatedAt` (`timestamptz`, stamped on every write — no version column, no migration). The check is a **race-free atomic guarded UPDATE**, but the equality must be **millisecond-precision-safe** (see below): `where(and(eq(agents.id, id), sql\`date_trunc('milliseconds', ${agents.updatedAt}) = ${new Date(expected)}\`))`. Zero rows returned *while the row still exists* → throw `conflict()` (the existing 409 `HttpError`, with `details: { currentUpdatedAt }`); zero rows with no row → 404 (unchanged `null` return). A pre-read compare is explicitly rejected — that is TOCTOU; the guard lives in the WHERE clause. This follows the locked precedent in `server/src/services/issues.ts` `checkout` (atomic conditional UPDATE → re-read → conflict). The token rides in the PATCH body (`expectedUpdatedAt`, optional ISO datetime) through the shared zod validator; the route's existing error propagation maps the thrown 409 automatically via `middleware/error-handler.ts`. UI opts in first in Skills + Config: each caller captures `agent.updatedAt` from the query cache, sends it, and on 409 invalidates/refetches + toasts "changed elsewhere".

**⚠️ Timestamp precision is the load-bearing correctness detail (do NOT use a naked `eq`).** The token does **not** "round-trip losslessly." `agents.updatedAt` is `timestamptz` with **microsecond** resolution in PostgreSQL — and `agentService.create` (~line 436) inserts the row **without setting `updatedAt`**, so the column takes `defaultNow()` = a full-microsecond value (e.g. `…:00.123456Z`). The client token, however, is a JS `Date` serialized via `toISOString()`, which has only **millisecond** resolution (e.g. `…:00.123Z`). A naked `eq(agents.updatedAt, new Date(expected))` compares millisecond-truncated `…123.000µs` against the stored `…123.456µs` and **never matches** → a spurious **409 on the very first edit of a never-updated (freshly-created) agent**. Worse, the client retries by resending the *same* truncated token, so it **loops** (409 → refetch → re-send truncated token → 409). The fix is to truncate **both sides to milliseconds** in the WHERE clause: `date_trunc('milliseconds', agents.updatedAt) = <ms-precision token>`. This keeps `updatedAt` as the token (no version column, no migration) while making the comparison robust against the microsecond/millisecond mismatch. Because this is a real-DB precision behavior, the **mock-style unit tests cannot exercise it** (the drizzle operators are no-ops under the Proxy mock, so the WHERE clause that *is* the guard is never evaluated) — it is proven by a Linux-gated / Windows-skipped real-DB integration test (Task 2b).

**Tech Stack:** TypeScript, Drizzle ORM (PostgreSQL), Express 5, zod (shared validators), React + @tanstack/react-query, Vitest. Drizzle ORM only — no raw SQL. AoA is not open source — no OSS headers. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

Files touched (exact paths):

```
packages/shared/src/validators/agent.ts                       # add expectedUpdatedAt to updateAgentSchema
packages/shared/src/__tests__/agent-validators.test.ts        # NEW — validator contract test (or extend if present)
server/src/services/agents.ts                                 # thread expectedUpdatedAt → ms-precision guarded UPDATE → conflict() (add `sql` to drizzle-orm import)
server/src/__tests__/agents-update-concurrency.test.ts        # NEW — service guarded-update + 409/404/back-compat (mock-style)
server/src/__tests__/agents-update-concurrency.integration.test.ts  # NEW — real-DB ms-precision proof (Linux-gated / Windows-skipped)
server/src/routes/agents.ts                                   # destructure expectedUpdatedAt OUT of patchData; forward only via svc.update options
server/src/__tests__/agents-update-concurrency-route.test.ts  # NEW — route maps thrown 409 / passes token through
ui/src/api/agents.ts                                          # (no signature change — body passthrough; documented)
ui/src/components/agent-detail/AgentSkillsTab.tsx             # optional expectedUpdatedAt prop + 409 branch in catch
ui/src/components/agent-detail/__tests__/AgentSkillsTab.test.tsx  # update payload assertions + add 409 test
ui/src/pages/AgentDetail.tsx                                  # pass agent.updatedAt to AgentSkillsTab; 409 onError on config save
ui/src/pages/AoaAgentDetail.tsx                               # pass agent.updatedAt to AgentSkillsTab; 409 onError on config save
ui/src/components/AgentConfigForm.tsx                          # inject expectedUpdatedAt: agent.updatedAt into save patch
ui/src/components/__tests__/AgentConfigForm.concurrency.test.tsx  # NEW — patch carries expectedUpdatedAt
tests/e2e/agent-skill-toggle-persist.spec.ts                  # NEW — Playwright happy-path round-trip (toggle ON/OFF → reload → persisted)
docs/architecture/decisions.md                                # NEW Decision #104 (locked pattern)
```

**Test commands (verified against repo):**
- Server suite (single file): `pnpm --filter @armyofagents/server exec vitest run src/__tests__/agents-update-concurrency.test.ts`
- Server integration (single file, Linux-gated / Windows self-skips): `pnpm --filter @armyofagents/server exec vitest run src/__tests__/agents-update-concurrency.integration.test.ts`
- Server suite (all): `pnpm --filter @armyofagents/server exec vitest run`
- Shared suite (single file): `pnpm --filter @armyofagents/shared exec vitest run src/__tests__/agent-validators.test.ts`
- UI suite (single file): `pnpm --filter @armyofagents/ui exec vitest run src/components/agent-detail/__tests__/AgentSkillsTab.test.tsx`
- UI suite (all): `pnpm --filter @armyofagents/ui exec vitest run`
- **E2E (single spec, Linux-gated / Windows self-skips):** `pnpm test:e2e agent-skill-toggle-persist` (the root `test:e2e` script = `playwright test --config=tests/e2e/playwright.config.ts`; a trailing path/substring filters to one spec). Boots a throwaway `local_trusted` instance on :3199.
- E2E (full suite): `pnpm test:e2e`
- Typecheck (whole workspace): `pnpm typecheck`

> Note: `server/package.json` has **no** `test` script — tests are driven by `vitest` at the root or per-package via `pnpm --filter <pkg> exec vitest run`. Use the per-package `exec vitest` form above. (Verified: root `package.json` defines `"test": "vitest"` / `"test:run": "vitest run"`; the per-package configs are `server/vitest.config.ts`, `packages/shared/vitest.config.ts`, `ui/vitest.config.ts`.)

---

## Task 0 — Branch off main

**Files:** none (git only).

- [ ] From the worktree `C:/Users/TK/.aoa/wt/agent-page-followups` (== main), create the working branch: `git checkout -b feat/agent-update-optimistic-concurrency`
- [ ] Confirm clean base: `git status` shows only the (already-present) plan/design docs as untracked; no source changes.

---

## Task 1 — Shared validator: optional `expectedUpdatedAt`

**Files:**
- `packages/shared/src/validators/agent.ts` — `updateAgentSchema` is at lines **55-64** (built from `createAgentSchema.omit({permissions}).partial().extend({...})`).
- `packages/shared/src/__tests__/agent-validators.test.ts` — NEW (no existing agent-validators test file; create one). Follow the contract-test style used in `packages/shared/src/__tests__/environment-validators.test.ts`.

TDD steps:

- [ ] **Write failing test.** Create `packages/shared/src/__tests__/agent-validators.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { updateAgentSchema } from "../validators/agent.js";

  describe("updateAgentSchema — expectedUpdatedAt (optimistic concurrency token)", () => {
    it("accepts an absent token (back-compat: last-write-wins path)", () => {
      const parsed = updateAgentSchema.parse({ title: "New title" });
      expect(parsed).not.toHaveProperty("expectedUpdatedAt");
    });

    it("accepts a valid ISO datetime token", () => {
      const iso = new Date("2026-06-25T12:00:00.000Z").toISOString();
      const parsed = updateAgentSchema.parse({ title: "x", expectedUpdatedAt: iso });
      expect(parsed.expectedUpdatedAt).toBe(iso);
    });

    it("rejects a non-datetime token", () => {
      const res = updateAgentSchema.safeParse({ expectedUpdatedAt: "not-a-date" });
      expect(res.success).toBe(false);
    });
  });
  ```
- [ ] **Run, expect FAIL:** `pnpm --filter @armyofagents/shared exec vitest run src/__tests__/agent-validators.test.ts` → both new cases fail today because `updateAgentSchema` is a Zod object that **strips** the unknown `expectedUpdatedAt` key (Zod's default — there is no `.passthrough()`): the "preserves a valid token" case fails because the key is stripped from the parsed result, and the "rejects a non-datetime token" case fails because `safeParse` *succeeds* (the bad value is stripped, so validation passes) while the test asserts `success === false`. Adding the field fixes both.
- [ ] **Implement REAL code.** In `packages/shared/src/validators/agent.ts`, extend `updateAgentSchema` (lines 55-64). The field is an **optional ISO datetime string**:
  ```ts
  export const updateAgentSchema = createAgentSchema
    .omit({ permissions: true })
    .partial()
    .extend({
      permissions: z.never().optional(),
      status: z.enum(AGENT_STATUSES).optional(),
      spentMonthlyCents: z.number().int().nonnegative().optional(),
      skillKeys: z.array(z.string()).optional(),
      defaultEnvironmentId: z.string().uuid().optional().nullable(),
      // Optimistic-concurrency token. OPTIONAL: when present, the update is
      // guarded against `agents.updatedAt` (atomic conditional UPDATE → 409 on
      // mismatch). When absent, the write is last-write-wins (full back-compat).
      // Token = the agent row's `updatedAt` as a millisecond-precision ISO string.
      // The server compares it at ms precision (date_trunc) because the stored
      // column is microsecond-precision — see Decision #104.
      expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
    });
  ```
  > `z.string().datetime({ offset: true })` accepts the `Z`-suffixed and `+00:00` forms that `Date.prototype.toISOString()` and JSON-serialized `Date` columns produce. Do NOT make it `.nullable()` — absent (`undefined`) is the back-compat signal; `null` adds no value.
- [ ] **Run, expect PASS:** same command → green.
- [ ] **Typecheck:** `pnpm --filter @armyofagents/shared exec tsc --noEmit` (or `pnpm typecheck`) → clean.
- [ ] **Commit:** `feat(agents): add optional expectedUpdatedAt token to updateAgentSchema` (with the Co-Authored-By trailer).

---

## Task 2 — Service: thread the token into the guarded UPDATE → 409

**Files:**
- `server/src/services/agents.ts`:
  - `UpdateAgentOptions` interface at lines **90-92** (currently `{ recordRevision?: RevisionMetadata }`).
  - `updateAgent(id, data, options?)` at lines **275-370**. The current guarded write is lines **343-348**:
    ```ts
    const updated = await db
      .update(agents)
      .set({ ...normalizedPatch, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    ```
  - `getById` at lines **229-236** (the re-read source).
  - `and`, `eq` are already imported (line 2: `import { and, desc, eq, inArray, isNull, isNotNull, ne } from "drizzle-orm";`).
  - `conflict` is already imported (line 20: `import { conflict, notFound, unprocessable } from "../errors.js";`).

TDD steps:

- [ ] **Write failing test (mock-style — branch coverage, NOT precision).** Create `server/src/__tests__/agents-update-concurrency.test.ts`. Use the existing `createAgentDb` sequence-DB helper (`./helpers/mock-db.js`) + the table/operator mocks (`./helpers/drizzle-mock.js`), matching the pattern in `agents-lifecycle-routes.test.ts`. The service's `updateAgent` issues, in order: (1) a `select` for `getById(id)` → existing row; (2) the guarded `update`; on zero-row results when a token was supplied, (3) a second `select` for the re-read. Sequence the mock results to drive each branch.
  > **Scope note:** under the Proxy mock, `drizzle-orm` operators (`and`/`eq`/`sql`) are no-ops, so the WHERE clause — including the `date_trunc('milliseconds', …)` guard — is **never evaluated**. These mock tests therefore prove the *branching* (no-token → success, supplied-token-then-zero-rows → 409 vs 404, return-shape, no-revision-on-clobber) but **cannot** prove the millisecond-precision fix. That regression (a freshly-`defaultNow()` row's token succeeding on first guarded update) is proven by the real-DB integration test in **Task 2b**. The mock here simulates conflict by returning zero rows from the `update` (`updates: [[]]`), independent of the actual comparison.
  ```ts
  import { describe, it, expect, beforeEach, vi } from "vitest";
  import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";
  import { createAgentDb } from "./helpers/mock-db.js";

  vi.mock("drizzle-orm", () => drizzleOperatorStubs());
  vi.mock("@armyofagents/db", () => ({
    agents: makeTableProxy("agents"),
    agentConfigRevisions: makeTableProxy("agent_config_revisions"),
  }));

  // org-hierarchy is constructed inside agentService(); stub it so the parent
  // branches in updateAgent are inert for these patches (we patch `title` only).
  vi.mock("../services/org-hierarchy.js", () => ({
    orgHierarchyService: () => ({
      ensureParent: vi.fn(),
      assertNoCycle: vi.fn(),
    }),
  }));

  import { agentService } from "../services/agents.js";

  const T0 = new Date("2026-06-25T12:00:00.000Z"); // stored updatedAt
  const T1 = new Date("2026-06-25T12:05:00.000Z"); // changed-underneath updatedAt
  const existing = {
    id: "a1", companyId: "c1", name: "Atlas", role: "general", kind: "org",
    status: "idle", reportsTo: null, parentType: null, parentId: null,
    adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    budgetMonthlyCents: 0, spentMonthlyCents: 0, permissions: {},
    skillKeys: [], metadata: null, createdAt: T0, updatedAt: T0,
  };

  beforeEach(() => vi.clearAllMocks());

  it("no token → last-write-wins update succeeds (back-compat)", async () => {
    const db = createAgentDb({
      selects: [[existing]],                         // getById
      updates: [[{ ...existing, title: "X", updatedAt: T1 }]], // guarded update hits 1 row
    });
    const svc = agentService(db as never);
    const res = await svc.update("a1", { title: "X" });
    expect(res?.title).toBe("X");
  });

  it("matching token → update succeeds", async () => {
    const db = createAgentDb({
      selects: [[existing]],
      updates: [[{ ...existing, title: "X", updatedAt: T1 }]],
    });
    const svc = agentService(db as never);
    const res = await svc.update("a1", { title: "X" }, { expectedUpdatedAt: T0.toISOString() });
    expect(res?.title).toBe("X");
  });

  it("stale token (row changed) → throws 409 conflict with current updatedAt", async () => {
    const db = createAgentDb({
      selects: [[existing], [{ ...existing, updatedAt: T1 }]], // getById, then re-read shows it still exists
      updates: [[]],                                            // guarded update matched 0 rows
    });
    const svc = agentService(db as never);
    await expect(
      svc.update("a1", { title: "X" }, { expectedUpdatedAt: T0.toISOString() }),
    ).rejects.toMatchObject({
      status: 409,
      details: { currentUpdatedAt: T1.toISOString() },
    });
  });

  it("token for a vanished row → returns null (route maps to 404, not 409)", async () => {
    const db = createAgentDb({
      selects: [[existing], []], // getById finds it, but the re-read finds nothing (deleted concurrently)
      updates: [[]],             // guarded update matched 0 rows
    });
    const svc = agentService(db as never);
    const res = await svc.update("a1", { title: "X" }, { expectedUpdatedAt: T0.toISOString() });
    expect(res).toBeNull();
  });
  ```
  > If `createAgentDb` ordering proves awkward for the dual-select sequence (initial `getById` + post-conflict re-read), declare a small local sequence-DB inline (the repo sanctions per-test local DBs — see the note in `helpers/drizzle-mock.ts`). Keep the assertions identical.
- [ ] **Run, expect FAIL:** `pnpm --filter @armyofagents/server exec vitest run src/__tests__/agents-update-concurrency.test.ts` → the **stale-token** test fails (today the service ignores the token and the WHERE is id-only, so the update succeeds and returns the row instead of null/409). The **no-token back-compat** test already **passes** against the current service — that's expected: it's a guard test documenting that token-less updates keep working, not a red one.
- [ ] **Implement REAL code — step A: extend options.** Lines 90-92:
  ```ts
  interface UpdateAgentOptions {
    recordRevision?: RevisionMetadata;
    /**
     * Optimistic-concurrency token (the agent row's `updatedAt`, as an ISO
     * string). When present, the write is an atomic conditional UPDATE guarded
     * against `agents.updatedAt`; a mismatch (row changed underneath, while it
     * still exists) throws `conflict()` (409). When absent, last-write-wins.
     */
    expectedUpdatedAt?: string;
  }
  ```
- [ ] **Implement REAL code — step B0: import `sql`.** `agents.ts` line 2 imports `import { and, desc, eq, inArray, isNull, isNotNull, ne } from "drizzle-orm";` — it does **not** include `sql`. Add it: `import { and, desc, eq, inArray, isNull, isNotNull, ne, sql } from "drizzle-orm";`. (`agents.ts` does not currently use `sql` anywhere else; this is a new import.)
- [ ] **Implement REAL code — step B: ms-precision guarded UPDATE + conflict.** Replace the write at lines 343-348. The guard compares `date_trunc('milliseconds', agents.updatedAt)` against the **millisecond-precision** token — `new Date(expected)` is already ms-precision, and `date_trunc` strips the stored value's sub-millisecond microseconds so a freshly-created `defaultNow()` row matches its own ISO token (see the precision note in **Architecture**):
  ```ts
  const expectedAt =
    options?.expectedUpdatedAt != null ? new Date(options.expectedUpdatedAt) : null;
  const guard =
    expectedAt != null
      ? and(
          eq(agents.id, id),
          // Millisecond-precision compare. `agents.updatedAt` is stored at
          // Postgres microsecond resolution (defaultNow() on never-updated rows);
          // the client token is a ms-precision ISO string. A naked
          // `eq(agents.updatedAt, expectedAt)` would never match a freshly-created
          // row → spurious 409 + retry loop. date_trunc both sides to ms.
          sql`date_trunc('milliseconds', ${agents.updatedAt}) = ${expectedAt}`,
        )
      : eq(agents.id, id);

  const updated = await db
    .update(agents)
    .set({ ...normalizedPatch, updatedAt: new Date() })
    .where(guard)
    .returning()
    .then((rows) => rows[0] ?? null);

  // Optimistic-concurrency: a token was supplied but the guarded write matched
  // no row. Distinguish "row changed underneath" (409) from "row gone" (404):
  // re-read by id. A pre-read compare would be TOCTOU — the guard above is the
  // atomic check; this re-read only classifies the miss. (Precedent: issues.ts
  // `checkout`.)
  if (!updated && expectedAt != null) {
    const current = await getById(id);
    if (current) {
      throw conflict(
        "This agent was changed by someone else. Reload and re-apply your change.",
        { currentUpdatedAt: current.updatedAt.toISOString() },
      );
    }
    return null; // row vanished concurrently → caller/route maps to 404
  }
  ```
  > **Throw the ISO string, not the `Date`.** `current.updatedAt` is a JS `Date`, but `errorHandler` only stringifies dates at the HTTP JSON boundary (`middleware/error-handler.ts` line 34 spreads `err.details` verbatim — no recursive `Date`→ISO coercion inside the raw `HttpError`). A **service-level** test that inspects the thrown error sees `details.currentUpdatedAt` exactly as passed. To make the service test, the route test, and the live JSON all agree, pass `current.updatedAt.toISOString()` (a `string`) — then `details.currentUpdatedAt === T1.toISOString()` holds at every layer.
  >
  > Leave the existing `recordRevision` block (lines 350-367) untouched — it already keys off `normalizedUpdated`, which is `null` on a conflict-miss return, so no revision is recorded for a clobbered write. Good.
- [ ] **Run, expect PASS:** same command → all four cases green.
- [ ] **Typecheck:** `pnpm --filter @armyofagents/server exec tsc --noEmit` → clean.
- [ ] **Commit:** `feat(agents): guard agent update with optional expectedUpdatedAt token (409 on conflict)`.

---

## Task 2b — Real-DB integration proof: ms-precision token vs `defaultNow()` microseconds

**Why this task exists:** The mock-style tests in Task 2 cannot exercise the WHERE clause (drizzle operators are no-ops under the Proxy mock), so the millisecond-precision fix — the regression Codex flagged — is **unproven** by them. This task adds a real-DB integration test against an embedded Postgres that genuinely stamps `agents.updatedAt` at microsecond resolution via `defaultNow()`, then proves a ms-precision client token still matches on the first guarded update (and that a stale token 409s). It is **Linux-gated / Windows-skipped** per the locked repo convention (embedded-postgres can't start on the CI Windows runner — see CLAUDE.md § CI Platform Status and `checkout-race.integration.test.ts`).

**Files:**
- `server/src/__tests__/agents-update-concurrency.integration.test.ts` — NEW. Model the embedded-postgres scaffold **verbatim** on `server/src/__tests__/checkout-race.integration.test.ts` (lines 1-135): `EmbeddedPostgres` boot in `beforeAll` with `if (process.platform === "win32") return;`, `applyPendingMigrations`, `createDb`, `setupError` capture, `afterAll` teardown, and a top-level `describe.skipIf(process.platform === "win32")(...)`. Seed a company, then create an agent through `agentService(db).create(...)` so the row's `updatedAt` is a genuine `defaultNow()` microsecond value (do NOT insert `updatedAt` by hand — the whole point is to reproduce the sub-millisecond stored value).

TDD steps:

- [ ] **Write failing test.** Inside the `describe.skipIf(...)`:
  ```ts
  import { and, eq, sql } from "drizzle-orm";
  import { agents } from "@armyofagents/db";
  import { agentService } from "../services/agents.js";

  it("freshly-created (defaultNow) agent: a ms-precision token succeeds on the FIRST guarded update", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    const svc = agentService(db);
    const created = await svc.create(companyId, { name: "Fresh Agent", role: "general" });

    // Sanity: the stored value really does carry sub-millisecond microseconds at
    // least some of the time. We assert the GUARD works regardless — the token is
    // the ms-precision ISO string the UI would send.
    const token = new Date(created!.updatedAt).toISOString(); // ms precision

    const updated = await svc.update(created!.id, { role: "specialist" }, { expectedUpdatedAt: token });
    expect(updated).not.toBeNull();        // first edit of a never-updated row must NOT 409
    expect(updated!.role).toBe("specialist");
  });

  it("a naked-eq comparison would have failed here (documents the bug the date_trunc guard fixes)", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    const svc = agentService(db);
    const created = await svc.create(companyId, { name: "Naked Eq Agent", role: "general" });
    const token = new Date(created!.updatedAt).toISOString();

    // Demonstrate the precision mismatch directly against the DB: a naked
    // `updatedAt = <ms token>` matches 0 rows when the stored value has microseconds,
    // whereas the date_trunc('milliseconds', …) guard the service uses matches 1.
    const nakedMatch = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, created!.id), eq(agents.updatedAt, new Date(token))));
    const truncMatch = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, created!.id), sql`date_trunc('milliseconds', ${agents.updatedAt}) = ${new Date(token)}`));
    // The date_trunc guard ALWAYS matches; the naked eq matches only when the
    // stored microseconds happen to be .000 (flaky), so we only assert the guard.
    expect(truncMatch.length).toBe(1);
    // Document the bug without flaking on the rare .000-microsecond case:
    expect(nakedMatch.length).toBeLessThanOrEqual(1);
  });

  it("stale token → 409 conflict (real DB)", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    const svc = agentService(db);
    const created = await svc.create(companyId, { name: "Stale Token Agent", role: "general" });
    const staleToken = new Date(created!.updatedAt).toISOString();

    // First edit advances updatedAt.
    await svc.update(created!.id, { role: "specialist" }, { expectedUpdatedAt: staleToken });
    // Second edit re-sends the ORIGINAL (now stale) token → must 409.
    await expect(
      svc.update(created!.id, { role: "lead" }, { expectedUpdatedAt: staleToken }),
    ).rejects.toMatchObject({ status: 409 });
  });
  ```
  > The second test is intentionally conservative: it asserts the `date_trunc` guard always matches (the real proof) and only documents — without flaking — that the naked `eq` can miss. The first and third tests are the load-bearing regression + conflict proofs.
- [ ] **Run, expect PASS (Linux) / SKIP (Windows):** `pnpm --filter @armyofagents/server exec vitest run src/__tests__/agents-update-concurrency.integration.test.ts`. No new implementation is needed here — Task 2 step B's `date_trunc` guard is what makes these pass, so this task is purely additive coverage. On Linux they pass; on Windows the suite self-skips (collects 0 run). The regression they encode is conceptual: a naked `eq(agents.updatedAt, …)` guard would 409 the first edit of a freshly-created (`defaultNow()` microsecond-precision) row — to see the failure, temporarily swap the guard back to `eq`, watch the first test fail, then restore `date_trunc`. (On Windows, note in the commit that Linux CI is the gating run — matches the repo's existing integration-test posture.)
- [ ] **Commit:** `test(agents): real-DB integration proof for ms-precision optimistic-concurrency token`.

---

## Task 3 — Route: forward the token; confirm 409/404 mapping

**Files:**
- `server/src/routes/agents.ts` — the PATCH handler at lines **1269-1365**. Key spots:
  - `existing = await svc.getById(id)` (1271); 404 if missing (1272-1274).
  - `const patchData = { ...(req.body as Record<string, unknown>) };` (1283).
  - `const agent = await svc.update(id, patchData, { recordRevision: {...} });` (1333-1339).
  - post-update `if (!agent) { res.status(404)... }` (1347-1350).

TDD steps:

- [ ] **Write failing test.** Create `server/src/__tests__/agents-update-concurrency-route.test.ts`, modeled on `agents-lifecycle-routes.test.ts` (mount `agentRoutes` on an express app with an injected board actor + `errorHandler`, mock `agentService` via `vi.mock("../services/index.js", ...)`). Assert:
  1. **Token forwarded via OPTIONS only (Codex P1 #1):** when the body carries `expectedUpdatedAt`, the mocked `svc.update` is called with that value in its **third** (options) arg AND its **second** (patch) arg does **not** contain `expectedUpdatedAt` — the route must destructure it out of `patchData` so it never reaches Drizzle `.set()`.
  2. **409 propagation:** when `svc.update` rejects with `conflict("…", { currentUpdatedAt })` where `currentUpdatedAt` is an **ISO string** (matching what the service throws), the response is `409` and the JSON body is `{ error, details: { currentUpdatedAt } }`.
  3. **404 on vanished row:** when `svc.update` resolves `null` (token-miss on a deleted row), the response is `404` (existing branch).
  4. **Back-compat:** a PATCH with no token still 200s and calls `svc.update` with options that have no `expectedUpdatedAt`.
  ```ts
  // ... (mock scaffolding mirrors agents-lifecycle-routes.test.ts) ...
  import { conflict } from "../errors.js";

  it("forwards expectedUpdatedAt ONLY via the options object — never in the patch", async () => {
    mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: "company-A" });
    mockAgentService.update.mockResolvedValue({ id: AGENT_ID, companyId: "company-A", title: "X" });
    const iso = new Date("2026-06-25T12:00:00.000Z").toISOString();
    const res = await request(makeApp(companyAActor))
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ title: "X", expectedUpdatedAt: iso });
    expect(res.status).toBe(200);
    // The token must ride in the THIRD arg (options), not the SECOND (patch) —
    // otherwise it flows into `.set({ ...normalizedPatch, updatedAt })` in the
    // service and Drizzle attempts to write a non-column field.
    expect(mockAgentService.update).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ title: "X" }),
      expect.objectContaining({ expectedUpdatedAt: iso }),
    );
    const [, patchArg, optionsArg] = mockAgentService.update.mock.calls.at(-1)!;
    // CRITICAL (Codex P1 #1): the patch object passed to svc.update must NOT carry
    // the transport-only token, or it would reach `.set()` as a phantom column.
    expect(patchArg).not.toHaveProperty("expectedUpdatedAt");
    expect(optionsArg).toHaveProperty("expectedUpdatedAt", iso);
  });

  it("maps a service conflict to 409 with currentUpdatedAt (ISO string)", async () => {
    mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: "company-A" });
    // The service throws `currentUpdatedAt` as an ISO STRING (it calls
    // `current.updatedAt.toISOString()` — errorHandler does NOT coerce Dates inside
    // the raw HttpError). Mirror that exact shape here so the mock matches reality.
    const t1Iso = new Date("2026-06-25T12:05:00.000Z").toISOString();
    mockAgentService.update.mockRejectedValue(
      conflict("This agent was changed by someone else. Reload and re-apply your change.", {
        currentUpdatedAt: t1Iso,
      }),
    );
    const res = await request(makeApp(companyAActor))
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ title: "X", expectedUpdatedAt: "2026-06-25T12:00:00.000Z" });
    expect(res.status).toBe(409);
    expect(res.body.details.currentUpdatedAt).toBe(t1Iso);
  });

  it("back-compat: no token still updates (200, no token in options)", async () => {
    mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: "company-A" });
    mockAgentService.update.mockResolvedValue({ id: AGENT_ID, companyId: "company-A", title: "X" });
    const res = await request(makeApp(companyAActor)).patch(`/api/agents/${AGENT_ID}`).send({ title: "X" });
    expect(res.status).toBe(200);
    const opts = mockAgentService.update.mock.calls.at(-1)![2];
    expect(opts).not.toHaveProperty("expectedUpdatedAt");
  });
  ```
  > The route's mocked-service tests need the same `vi.mock` shims that `agents-lifecycle-routes.test.ts` uses (services/index, adapters/index, the four adapter packages, `@armyofagents/db`, `drizzle-orm`). Copy that block verbatim; add `update` results per case. Use the **board** actor (`companyAActor`) so authz passes.
- [ ] **Run, expect FAIL:** `pnpm --filter @armyofagents/server exec vitest run src/__tests__/agents-update-concurrency-route.test.ts` → the "forwards expectedUpdatedAt" case fails (the route doesn't pass the token yet).
- [ ] **Implement REAL code.** In `server/src/routes/agents.ts`:
  - The validator already strips unknown keys via `validate(updateAgentSchema)`, so `req.body.expectedUpdatedAt` is present only when valid. Pull it out **before** building `patchData`, and do not let it leak into the column patch:
    ```ts
    const { expectedUpdatedAt, ...bodyRest } = req.body as Record<string, unknown>;
    const patchData = { ...bodyRest };
    ```
    (Replace the current line 1283 `const patchData = { ...(req.body as Record<string, unknown>) };`. Everything downstream that reads `patchData.adapterConfig`/`patchData.skillKeys`/etc. is unaffected — those keys are still in `bodyRest`.)
  - Thread the token into the `svc.update` options (lines 1333-1339):
    ```ts
    const agent = await svc.update(id, patchData, {
      recordRevision: {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        source: "patch",
      },
      ...(typeof expectedUpdatedAt === "string" ? { expectedUpdatedAt } : {}),
    });
    ```
  - **No new 409 mapping is needed.** A thrown `conflict()` is an `HttpError(409, …, details)`; the route has no try/catch around `svc.update`, so it propagates to `middleware/error-handler.ts`, which emits `{ error, details }` at status 409 (verified: error-handler lines 21-36). The existing `if (!agent) { res.status(404) }` branch (1347-1350) already covers the vanished-row null return. The `summarizeAgentUpdateDetails(patchData)` activity-log call is unaffected (token was never in `patchData`).
- [ ] **Run, expect PASS:** same command → all route cases green.
- [ ] **Run the existing agent route suites** to prove no regression: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/agents-lifecycle-routes.test.ts src/__tests__/agents-adapter-validation.contract.test.ts` → green.
- [ ] **Typecheck:** `pnpm --filter @armyofagents/server exec tsc --noEmit` → clean.
- [ ] **Commit:** `feat(agents): forward expectedUpdatedAt from PATCH /agents/:id to the guarded service update`.

---

## Task 4 — UI: Skills tab opts in (token + 409 handling) + payload-test reconciliation

**Background (verified):** `AgentSkillsTab` (`ui/src/components/agent-detail/AgentSkillsTab.tsx`) today takes only `{ agentId, companyId, skillKeys, skillsRoute }` — it does **not** receive `updatedAt`. Both parents render the shared component with the full `agent` object available: `AgentDetail.tsx:677-681` and `AoaAgentDetail.tsx:321-325` (the local `AoaSkillsTab` at `AoaAgentDetail.tsx:520` is **dead code** — not rendered). The existing test `ui/src/components/agent-detail/__tests__/AgentSkillsTab.test.tsx` asserts the **exact** payload `agentsApi.update("a1", { skillKeys: [...] })` (no token) in three cases (lines 50, 121, 160, 177).

**Payload-test reconciliation decision (RESOLVED):** Make the token **conditional on having a cached `updatedAt`**, threaded via a new **optional** prop `expectedUpdatedAt?: string`.
- When the prop is **absent** (the prop's default in the existing tests, which render `<AgentSkillsTab ... />` with no `expectedUpdatedAt`), the payload stays exactly `{ skillKeys: [...] }` — so the three existing payload assertions **pass unchanged**.
- When the prop is **present** (production: parents pass `agent.updatedAt`), the payload becomes `{ skillKeys: [...], expectedUpdatedAt }`.
- **New** tests render with the prop and assert: (a) the token is included; (b) the 409 branch rolls back + toasts; (c) two sequential toggles send the **fresh** token on the second call (Codex P1 #4 — the stale-token ref). This keeps the public-payload contract test stable while exercising the opt-in path. (Chosen over "always send the token" because that would force rewriting 3 stable assertions for no behavioral gain — and the prop-absent default is exactly what those tests render.)

**Files:**
- `ui/src/components/agent-detail/AgentSkillsTab.tsx` — props (17-28), the `latestSkillKeys` ref + resync effect (37-50, mirror for the new `latestExpectedUpdatedAt` ref), `handleToggle` (58-93), the `catch` (84-92).
- `ui/src/components/agent-detail/__tests__/AgentSkillsTab.test.tsx`.
- `ui/src/lib/toast.ts` — `toast.error(title, { description })` (verified signature).
- `ui/src/api/client.ts` — `ApiError` has `.status` (line 10) and `.body` (line 11); a 409 is `error instanceof ApiError && error.status === 409`.

TDD steps:

- [ ] **Write failing test.** Add to `AgentSkillsTab.test.tsx`:
  ```ts
  import { ApiError } from "../../../api/client";
  import { toast } from "../../../lib/toast";
  vi.mock("../../../lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

  it("includes expectedUpdatedAt in the payload when the prop is provided", async () => {
    vi.mocked(agentsApi.update).mockResolvedValue({} as never);
    renderWithProviders(
      <AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} expectedUpdatedAt="2026-06-25T12:00:00.000Z" />,
    );
    await screen.findByText("Skill A");
    fireEvent.click(row("Skill A"));
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(1));
    expect(agentsApi.update).toHaveBeenCalledWith("a1", {
      skillKeys: ["skill-a"],
      expectedUpdatedAt: "2026-06-25T12:00:00.000Z",
    });
  });

  it("on a 409, rolls back and toasts 'changed elsewhere'", async () => {
    vi.mocked(agentsApi.update).mockRejectedValue(
      new ApiError("changed", 409, { error: "changed", details: { currentUpdatedAt: "…" } }),
    );
    renderWithProviders(
      <AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} expectedUpdatedAt="2026-06-25T12:00:00.000Z" />,
    );
    await screen.findByText("Skill A");
    fireEvent.click(row("Skill A"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // optimistic toggle rolled back
    expect(row("Skill A")).toHaveAttribute("aria-pressed", "false");
  });

  it("back-compat: no expectedUpdatedAt prop → payload omits the token", async () => {
    vi.mocked(agentsApi.update).mockResolvedValue({} as never);
    renderWithProviders(<AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} />);
    await screen.findByText("Skill A");
    fireEvent.click(row("Skill A"));
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledWith("a1", { skillKeys: ["skill-a"] }));
  });

  it("two sequential toggles before any refetch send the FRESH token on the second call (no self-409)", async () => {
    // First update returns an ADVANCED updatedAt; the component must send THAT on
    // the next toggle, not the stale prop, so it can't 409 against its own write.
    vi.mocked(agentsApi.update)
      .mockResolvedValueOnce({ updatedAt: "2026-06-25T12:00:01.000Z" } as never)
      .mockResolvedValueOnce({ updatedAt: "2026-06-25T12:00:02.000Z" } as never);
    renderWithProviders(
      <AgentSkillsTab agentId="a1" companyId="c1" skillKeys={[]} expectedUpdatedAt="2026-06-25T12:00:00.000Z" />,
    );
    await screen.findByText("Skill A");
    await screen.findByText("Skill B");

    // First toggle: sends the prop token.
    fireEvent.click(row("Skill A"));
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(1));
    expect(agentsApi.update).toHaveBeenNthCalledWith(1, "a1", {
      skillKeys: ["skill-a"],
      expectedUpdatedAt: "2026-06-25T12:00:00.000Z",
    });

    // Second toggle (the prop has NOT been refreshed yet — no refetch landed):
    // must send the token advanced from the first response, not the stale prop.
    fireEvent.click(row("Skill B"));
    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(2));
    expect(agentsApi.update).toHaveBeenNthCalledWith(2, "a1", {
      skillKeys: ["skill-a", "skill-b"],
      expectedUpdatedAt: "2026-06-25T12:00:01.000Z",
    });
  });
  ```
  > The two-toggle test renders with **two** library skills (`Skill A`, `Skill B`) — the existing fixture for this suite already provides them (it asserts both `Skill A` and `Skill B` rows elsewhere). The second `expectedUpdatedAt` (`…01.000Z`) is the `updatedAt` from the **first** mocked response, proving the ref advanced from the server response rather than re-sending the stale prop (`…00.000Z`).
- [ ] **Run, expect FAIL:** `pnpm --filter @armyofagents/ui exec vitest run src/components/agent-detail/__tests__/AgentSkillsTab.test.tsx` → the four new tests fail (prop unknown / token not sent / no 409 branch / second toggle sends the stale prop token instead of the advanced one).
- [ ] **Implement REAL code.** In `AgentSkillsTab.tsx`:
  - Add the optional prop to the signature (17-28):
    ```ts
    export function AgentSkillsTab({
      agentId,
      companyId,
      skillKeys: initialSkillKeys,
      skillsRoute = "/skills",
      expectedUpdatedAt,
    }: {
      agentId: string;
      companyId: string;
      skillKeys: string[];
      skillsRoute?: string;
      /**
       * Optimistic-concurrency token (the agent row's `updatedAt`, ISO string).
       * When provided, each skill PATCH is guarded against concurrent edits and
       * a 409 surfaces a "changed elsewhere" toast. When omitted, the save is
       * last-write-wins (back-compat — and the payload omits the token).
       */
      expectedUpdatedAt?: string;
    }) {
    ```
  - Import the 409 detector + toast at the top:
    ```ts
    import { ApiError } from "../../api/client";
    import { toast } from "../../lib/toast";
    ```
  - **Add a `latestExpectedUpdatedAt` ref (Codex P1 #4 — defeat the stale-token self-409).** The post-success `invalidateQueries` refetch is async; a user who toggles twice in quick succession would, on the second toggle, re-send the **prop's** now-stale `expectedUpdatedAt` (the refetch that would bump the prop hasn't landed) → a self-inflicted 409 against their *own* prior write. Track the freshest token the same way `latestSkillKeys` already tracks the freshest attached set: seed it from the prop, advance it from each **successful** `agentsApi.update` response's `updatedAt`. Add this next to the existing `latestSkillKeys` ref (lines 37-40):
    ```ts
    // Freshest optimistic-concurrency token. Like `latestSkillKeys`, this is
    // advanced from the SUCCESSFUL update response so a second toggle fired before
    // the post-success refetch lands sends the up-to-date token (not the stale prop)
    // and doesn't self-409 against this component's own prior write. (Decision #104)
    const latestExpectedUpdatedAt = useRef(expectedUpdatedAt);
    useEffect(() => {
      latestExpectedUpdatedAt.current = expectedUpdatedAt;
    }, [expectedUpdatedAt]);
    ```
  - In `handleToggle`, send the **ref** value (not the raw prop), capture the returned agent to advance the ref, and add the 409 branch inside the existing `catch` (84-92):
    ```ts
    try {
      const payload: Record<string, unknown> = { skillKeys: next };
      // Send the FRESHEST token (ref), not the prop — guards against a second
      // toggle that fires before the post-success refetch updates the prop.
      const tokenToSend = latestExpectedUpdatedAt.current;
      if (tokenToSend) payload.expectedUpdatedAt = tokenToSend;
      const updatedAgent = await agentsApi.update(agentId, payload as never);
      latestSkillKeys.current = next;
      // Advance the token from the server's response so the NEXT toggle (which may
      // fire before the invalidate refetch lands) guards against the value we just
      // wrote — not the stale prop. `updatedAt` arrives as a Date or ISO string;
      // normalize to ISO. Only advance when the prop-driven token feature is active.
      if (latestExpectedUpdatedAt.current && (updatedAgent as { updatedAt?: string | Date } | undefined)?.updatedAt) {
        latestExpectedUpdatedAt.current = new Date(
          (updatedAgent as { updatedAt: string | Date }).updatedAt,
        ).toISOString();
      }
      void queryClient.invalidateQueries({ queryKey: ["agents", "detail"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) });
    } catch (e) {
      // Roll back the optimistic change to the freshest server-known set.
      setLocalKeys(latestSkillKeys.current);
      if (e instanceof ApiError && e.status === 409) {
        // Concurrent edit: the agent changed under us. Refetch + tell the user
        // to redo their toggle against the reloaded state (Decision #104).
        void queryClient.invalidateQueries({ queryKey: ["agents", "detail"] });
        toast.error("This agent changed elsewhere", {
          description: "Reloaded the latest version — please redo your change.",
        });
      } else {
        setError(e instanceof Error ? e.message : "Failed to update skills");
      }
    } finally {
      setPendingKey(null);
    }
    ```
    > The prop-absent branch keeps `payload === { skillKeys: next }` (a plain object literal, not a superset — `latestExpectedUpdatedAt.current` is `undefined`, so the key is never added) so the three existing `toHaveBeenCalledWith("a1", { skillKeys: [...] })` assertions still match exactly. `agentsApi.update` already returns the updated agent (its result was previously ignored — verified at `AgentSkillsTab.tsx:75`); capturing it here is the only behavioral change to the success path.
- [ ] **Run, expect PASS:** same command → all AgentSkillsTab tests green (the three original payload assertions + the four new ones).
- [ ] **Wire the parents to pass the token.** No new tests required for these one-line prop additions (covered by the component test + the page smoke tests), but make the edits:
  - `ui/src/pages/AgentDetail.tsx:677-681`:
    ```tsx
    <AgentSkillsTab
      agentId={agent.id}
      companyId={resolvedCompanyId}
      skillKeys={(agent as any).skillKeys ?? []}
      expectedUpdatedAt={agent.updatedAt ? new Date(agent.updatedAt).toISOString() : undefined}
    />
    ```
  - `ui/src/pages/AoaAgentDetail.tsx:321-325`: same `expectedUpdatedAt` prop addition.
  > `agent.updatedAt` is typed `Date` on the `Agent` shared type but arrives over JSON as a string; `new Date(agent.updatedAt).toISOString()` normalizes either form to the exact ISO the server stored (ms precision preserved). Guard with the ternary so a (theoretically) absent value sends no token rather than `"Invalid Date"`.
- [ ] **Typecheck:** `pnpm --filter @armyofagents/ui exec tsc --noEmit` → clean.
- [ ] **Commit:** `feat(agents-ui): opt Skills tab into optimistic concurrency (token + 409 toast)`.

---

## Task 5 — UI: Config save opts in (token + 409 handling)

**Background (verified):** Both config-save paths use the same shape — a `useMutation` wrapping `agentsApi.update(agent.id, data, companyId)` with `onSuccess` invalidation, feeding `<AgentConfigForm onSave={(patch) => updateAgent.mutate(patch)} agent={agent} ... />`:
- Worker page: `ui/src/pages/AgentDetail.tsx:1355-1382`.
- AoA page: `ui/src/pages/AoaAgentDetail.tsx:486-513`.
`AgentConfigForm.handleSave` (`ui/src/components/AgentConfigForm.tsx:292-333`) builds `patch` from the dirty overlay and calls `props.onSave(patch)`; `props.agent` (with `agent.updatedAt`) is in scope.

**Approach:** Inject the token in `AgentConfigForm.handleSave` (it owns the patch + has `props.agent`), then add a 409 `onError` to **both** `updateAgent` mutations (they own the toast/refetch + react-query error surface).

**Files:**
- `ui/src/components/AgentConfigForm.tsx` — `handleSave` (292-333), specifically the final `props.onSave(patch)` (332).
- `ui/src/pages/AgentDetail.tsx` — `updateAgent` mutation (1355-1362).
- `ui/src/pages/AoaAgentDetail.tsx` — `updateAgent` mutation (486-494).
- NEW: `ui/src/components/__tests__/AgentConfigForm.concurrency.test.tsx`.

TDD steps:

- [ ] **Write failing test.** Create `ui/src/components/__tests__/AgentConfigForm.concurrency.test.tsx`. Render `AgentConfigForm` in `mode="edit"` with a stub `agent` (include `updatedAt`), make a field dirty (e.g. change `title`), invoke the exposed save action, and assert the `onSave` patch includes `expectedUpdatedAt` equal to `new Date(agent.updatedAt).toISOString()`. Mirror the render/provider setup of any existing `AgentConfigForm` test if one exists; otherwise use `renderWithProviders` from `ui/src/__tests__/test-utils` and drive the save via the `onSaveActionChange` callback (the form registers its save fn through it — see lines 338-341).
  ```ts
  it("includes expectedUpdatedAt in the save patch", async () => {
    const onSave = vi.fn();
    let save: (() => void) | null = null;
    const agent = { id: "a1", /* …minimal Agent… */, title: "Old", updatedAt: "2026-06-25T12:00:00.000Z" } as never;
    renderWithProviders(
      <AgentConfigForm
        mode="edit" agent={agent} onSave={onSave} isSaving={false}
        onSaveActionChange={(fn) => { save = fn; }}
        onDirtyChange={() => {}} onCancelActionChange={() => {}}
      />,
    );
    // make `title` dirty via the identity input, then:
    save?.();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUpdatedAt: "2026-06-25T12:00:00.000Z" }),
    ));
  });
  ```
  > Driving the dirty state requires interacting with the identity field; reuse the field selectors from an existing AgentConfigForm test if present (search `ui/src/components/__tests__/` for `AgentConfigForm`). If none exists, set the dirty field via the rendered input by label/placeholder. Keep the assertion on the `expectedUpdatedAt` key.
- [ ] **Run, expect FAIL:** `pnpm --filter @armyofagents/ui exec vitest run src/components/__tests__/AgentConfigForm.concurrency.test.tsx` → fails (patch has no token yet).
- [ ] **Implement REAL code — form.** In `AgentConfigForm.tsx` `handleSave`, just before `props.onSave(patch)` (line 332):
  ```ts
  // Optimistic-concurrency token: guard this whole-row save against a concurrent
  // edit. `agent.updatedAt` is the row version the user was editing. (Decision #104)
  if (agent.updatedAt) {
    patch.expectedUpdatedAt = new Date(agent.updatedAt).toISOString();
  }

  props.onSave(patch);
  ```
  > Only set it when a save actually fires (the early `if (isCreate || !isDirty) return;` at line 293 already gates create/no-op). Create mode never sends a token (no row to guard).
- [ ] **Implement REAL code — mutation 409 handlers.** Add an `onError` to **both** `updateAgent` mutations. They both already have `useQueryClient` and import paths for toast/ApiError are available in the page modules (add imports if absent: `import { toast } from "@/lib/toast";` and `import { ApiError } from "@/api/client";` — verify the page's existing alias style; both pages already import from `@/...` or `../`).
  - `ui/src/pages/AoaAgentDetail.tsx:486-494`:
    ```ts
    const updateAgent = useMutation({
      mutationFn: (data: Record<string, unknown>) => agentsApi.update(agent.id, data, companyId),
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
        if (agent.urlKey) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
        }
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
          if (agent.urlKey) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
          }
          toast.error("This agent changed elsewhere", {
            description: "Reloaded the latest version — please redo your change.",
          });
        }
      },
    });
    ```
  - `ui/src/pages/AgentDetail.tsx:1355-1362`: same `onError` (it also invalidates `configRevisions(agent.id)` in `onSuccess` — keep that; mirror the detail invalidations in `onError`).
- [ ] **Run, expect PASS:** `pnpm --filter @armyofagents/ui exec vitest run src/components/__tests__/AgentConfigForm.concurrency.test.tsx` → green.
- [ ] **Run the broader UI agent suites** for regression: `pnpm --filter @armyofagents/ui exec vitest run src/pages/__tests__/AoaAgentDetail.test.tsx src/components/agent-detail/__tests__/AgentSkillsTab.test.tsx` (and any `AgentDetail` page test) → green. If a page test asserts an exact config-save payload without a token, update it to `expect.objectContaining(...)` or add `expectedUpdatedAt` (same reconciliation rule as Task 4 — be explicit and consistent).
- [ ] **Typecheck:** `pnpm --filter @armyofagents/ui exec tsc --noEmit` → clean.
- [ ] **Commit:** `feat(agents-ui): opt Config save into optimistic concurrency (token + 409 toast)`.

---

## Task 6 — E2E smoke: happy-path optimistic-concurrency round-trip (single client)

**Why this task exists:** Tasks 2/2b/3/4/5 prove every server + UI branch in isolation (mock + real-DB + component), but nothing proves the *whole stack* — UI sends `agent.updatedAt` → route forwards it via options → service ms-precision guard matches → write persists → reload re-renders the persisted state. A single Playwright spend covers that real round-trip end to end against a live `local_trusted` instance: toggle a skill ON, **reload**, assert it's still attached (the token matched and the write persisted); toggle OFF, reload, assert detached. This is the happy-path proof that the opt-in token never spuriously 409s a normal single-user edit (the precision regression, observable through the UI).

**Feasibility — verified against the real harness (no invented helper APIs):**
- `seedCompany(request, name)` (`tests/e2e/helpers/seed-company.ts`) → company with `id` + `issuePrefix`. In `local_trusted` mode the synthetic local-board actor is auto-authorised by every `/api/...` route, so **no Bearer token** is needed for any seed call.
- **Company skill seeding IS supported** via the existing REST route — `POST /api/companies/:companyId/skills` (`server/src/routes/company-skills.ts:99`), body validated by `companySkillCreateSchema` (`packages/shared/src/validators/company-skill.ts:112`): only `name` is required (`slug`/`description`/`markdown` optional). The 201 response is a `CompanySkill` carrying the server-derived `key` and `name`. There is **no** dedicated e2e helper wrapping this, but the spec calls the route directly via `request.post(...)` exactly as `marketplace-install-flow.spec.ts` does for `request-install` — no new helper file is required. (Honest note: the spec doesn't need the returned `key`; it locates the toggle row by the visible skill **name** and reads `aria-pressed`.)
- **Worker agent seeding IS supported** via `POST /api/companies/:companyId/agents` (`server/src/routes/agents.ts:1058`, `createAgentSchema`): only `name` is required (kind defaults `org`, adapterType `process`, status `idle` in `local_trusted` because `requireBoardApprovalForNewAgents=false` — Divergence D6). The 201 response carries the agent `id`.
- **Navigation:** the Skills tab is a real URL — `/{issuePrefix}/agents/{agentId}/skills` (route `:companyPrefix/agents/:agentId/:tab`, `ui/src/App.tsx:156`; `companyPrefix` = `company.issuePrefix`, same shape `planning-mode.spec.ts` uses). The agent route id accepts the raw `agent.id` (the GET resolves by id or urlKey).
- **Assertion surface:** skill rows render as `role="button"` with `aria-pressed={isAttached}` and show `skill.name` (`AgentSkillsTab.tsx:143-145`). Toggling clicks the row; the `pushToast`/optimistic update + invalidate is the production path. After **reload**, `aria-pressed` reflects the persisted `skillKeys` from the agent detail refetch — the load-bearing persistence assertion.

**What this task does NOT cover, and WHY (stated honestly, with the source evidence):**
- **Two pages CAN be opened in one browser context** (`const a = await context.newPage(); const b = await context.newPage();`), each holding a divergent stale `updatedAt` token — so a two-client conflict is *mechanically* openable. **But a real two-client 409 e2e would be non-deterministic/flaky, because an agent PATCH broadcasts a live event that makes the OTHER page refetch a fresh token before its own toggle.** Concretely, the chain is:
  1. Page A's toggle hits `PATCH /api/agents/:id`, whose handler calls `logActivity(...)` with `action: "agent.updated", entityType: "agent", entityId: agent.id` (`server/src/routes/agents.ts:1352-1362`).
  2. `logActivity` emits a **company-broadcast** live event: `publishLiveEvent({ companyId, type: "activity.logged", payload: { entityType: "agent", entityId } })` (`server/src/services/activity-log.ts:32-45`), dispatched to **every** connected client of the company via `emitter.emit(input.companyId, event)` (`server/src/services/live-events.ts:42`; subscribed per-client by `subscribeCompanyLiveEvents`, `live-events.ts:46-48`).
  3. Page B's `LiveUpdatesProvider` receives it and, for `entityType === "agent"`, invalidates the agent detail query: `queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(entityId) })` = `["agents", "detail", agentId]` (`ui/src/context/LiveUpdatesProvider.tsx:477-485`, dispatched from the `activity.logged` branch at `:595-602`).
  4. That key is a **prefix** of Page B's agent detail query key `["agents", "detail", routeAgentRef, companyId]` (`ui/src/pages/AgentDetail.tsx:225-226`), and react-query invalidation is prefix-matching by default — so **when Page B navigated by the raw agent id** (`routeAgentRef === agentId`), Page B refetches a fresh `agent`, whose `updatedAt` is now the value Page A just wrote.
  5. The token Page B sends is `agent.updatedAt` from that very query (Task 4 wires `expectedUpdatedAt={agent.updatedAt}` into `AgentSkillsTab`, which resyncs its `latestExpectedUpdatedAt` ref from the prop on change). So after the broadcast lands, Page B's next toggle sends the **fresh** token and **does NOT 409** — the conflict the test wants to prove has been silently healed by live updates.

  This is a genuine race between the broadcast-driven invalidation refetch and Page B's click, and the realistic/steady-state ordering is "broadcast wins" — so a two-client 409 spec would pass or fail depending on timing. We deliberately do **not** add it: a flaky e2e is worse than none. (It would only fire reliably if Page B were navigated by a *different* ref than Page A's raw id — e.g. by urlKey/shortname so the invalidation prefix misses — but engineering a key mismatch to force the 409 would be testing an artificial topology, not the real conflict.)
- **The authoritative conflict proof lives where it is deterministic, and is already in this plan:** the server-side 409 (stale token while the row exists) is proven by the mock-style service test (**Task 2**) and the real-DB integration test (**Task 2b**, which advances `updatedAt` with a first edit and re-sends the original stale token → 409); the **UI** 409 branch (rollback + refetch + toast) and the stale-token-ref defence are proven by the component tests (**Task 4**). This e2e is scoped to the single-client happy path it *can* prove honestly.
- **Do not fake a conflict.** Do not mutate the agent via `request` between Page A and Page B toggles to manufacture a 409 — that both races the optimistic UI and is itself defeated by the same `activity.logged` → `agents.detail` invalidation; it would be flaky theatre, not real conflict proof. Multi-client conflict coverage that the e2e layer genuinely can't reach (e.g. authenticated multi-user mode — no harness yet, tracked for 1.1) stays the province of Tasks 2/2b/4.

**CI reality (matches the repo posture):** Linux e2e is the **required gate**; the Windows e2e lane **self-skips** at the Playwright-config level (`WINDOWS_WITH_EMBEDDED_POSTGRES` → `testMatch` becomes only `windows-embedded-postgres-skip.spec.ts`; Issue #114). So this spec is gated on Linux and never runs on the Windows runner — same as every other spec in `tests/e2e/`. Running it locally on Windows (no `DATABASE_URL`) self-skips; rely on CI Linux for the gating run.

**Files:**
- `tests/e2e/agent-skill-toggle-persist.spec.ts` — NEW. Import `{ test, expect }` from `@playwright/test` and `{ seedCompany, cleanupTestCompanies }` from `./helpers/seed-company`. Mirror the structure of `planning-mode.spec.ts` (afterEach cleanup by name prefix) and the direct-`request` calls of `marketplace-install-flow.spec.ts`.

Steps (no TDD red/green — e2e is additive coverage of already-implemented behavior from Tasks 2-5; it must pass once those land):

- [ ] **Write the spec.** Seed via API, drive the UI, reload, assert persistence:
  ```ts
  import { test, expect, type APIRequestContext } from "@playwright/test";
  import { seedCompany, cleanupTestCompanies } from "./helpers/seed-company";

  /**
   * E2E: optimistic-concurrency happy-path round-trip (single client).
   *
   * Proves the WHOLE stack: the Skills tab sends `agent.updatedAt` as the
   * `expectedUpdatedAt` token → the route forwards it via options → the service
   * ms-precision (`date_trunc`) guard MATCHES (no spurious 409 on a normal edit)
   * → the write persists → a page reload re-renders the persisted attached set.
   *
   * Two pages CAN be opened in one context, but a two-client 409 e2e would be
   * flaky: an agent PATCH broadcasts `activity.logged` (entityType "agent"), which
   * invalidates the OTHER page's `agents.detail` query (LiveUpdatesProvider.tsx
   * :477-485) → it refetches a fresh updatedAt token before its own toggle → no
   * 409. So the deterministic conflict proof stays in the server tests (Task 2 mock
   * + Task 2b real-DB) and the UI component test (Task 4: 409 rollback/toast +
   * stale-token ref). See "What this task does NOT cover" above for the full chain.
   *
   * Linux e2e is the required gate; the Windows lane self-skips at the Playwright
   * config level (embedded-postgres can't start on the CI Windows runner).
   */
  const PREFIX = /^E2E-SkillToggle-/;

  async function seedCompanyWithSkillAndAgent(request: APIRequestContext) {
    const company = await seedCompany(request, `E2E-SkillToggle-${Date.now()}`);

    // Company skill — POST /api/companies/:cid/skills (companySkillCreateSchema:
    // only `name` required). 201 → CompanySkill { key, name, ... }.
    const skillRes = await request.post(`/api/companies/${company.id}/skills`, {
      data: { name: "Persisted Skill", description: "E2E concurrency round-trip skill" },
    });
    expect(skillRes.status(), await skillRes.text()).toBe(201);
    const skill = (await skillRes.json()) as { key: string; name: string };

    // Worker agent — POST /api/companies/:cid/agents (createAgentSchema: only
    // `name` required; defaults kind=org, adapterType=process, status=idle in
    // local_trusted). 201 → { id }.
    const agentRes = await request.post(`/api/companies/${company.id}/agents`, {
      data: { name: "Skill Toggle Agent" },
    });
    expect(agentRes.status(), await agentRes.text()).toBe(201);
    const agent = (await agentRes.json()) as { id: string };

    return { company, skill, agent };
  }

  test.describe("agent skill toggle persists (optimistic concurrency round-trip)", () => {
    test.afterEach(async ({ request }) => {
      await cleanupTestCompanies(request, PREFIX);
    });

    test("toggle ON persists across reload, then toggle OFF persists across reload", async ({
      page,
      request,
    }) => {
      const { company, skill, agent } = await seedCompanyWithSkillAndAgent(request);

      // Open the agent's Skills tab directly by URL.
      await page.goto(`/${company.issuePrefix}/agents/${agent.id}/skills`);

      // The skill starts UNATTACHED → its row is a role=button with aria-pressed=false.
      const row = page.getByRole("button", { name: new RegExp(skill.name, "i") });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row).toHaveAttribute("aria-pressed", "false");

      // Toggle ON. The PATCH carries expectedUpdatedAt = agent.updatedAt; the
      // ms-precision guard must MATCH (no spurious 409) and persist skillKeys.
      const attachResponse = page.waitForResponse(
        (r) =>
          r.request().method() === "PATCH" &&
          new URL(r.url()).pathname === `/api/agents/${agent.id}`,
      );
      await row.click();
      expect((await attachResponse).status(), "attach PATCH must succeed (no spurious 409)").toBe(200);

      // RELOAD — the attached set must come back from the server, not optimism.
      await page.reload();
      const rowAfterAttach = page.getByRole("button", { name: new RegExp(skill.name, "i") });
      await expect(rowAfterAttach).toBeVisible({ timeout: 15_000 });
      await expect(rowAfterAttach, "skill must still be attached after reload").toHaveAttribute(
        "aria-pressed",
        "true",
      );

      // Toggle OFF — the SECOND edit re-sends the token advanced from the first
      // response (the stale-token ref), so it also must not self-409.
      const detachResponse = page.waitForResponse(
        (r) =>
          r.request().method() === "PATCH" &&
          new URL(r.url()).pathname === `/api/agents/${agent.id}`,
      );
      await rowAfterAttach.click();
      expect((await detachResponse).status(), "detach PATCH must succeed").toBe(200);

      // RELOAD — must come back detached.
      await page.reload();
      const rowAfterDetach = page.getByRole("button", { name: new RegExp(skill.name, "i") });
      await expect(rowAfterDetach).toBeVisible({ timeout: 15_000 });
      await expect(rowAfterDetach, "skill must be detached after reload").toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });
  ```
  > **Locator robustness:** if `getByRole("button", { name: skill.name })` proves ambiguous (the row's accessible name concatenates name + trust/source labels + key), narrow with `.filter({ hasText: skill.name })` over `page.locator('[role="button"][aria-pressed]')`, or anchor on the unique `skill.key` (rendered in the `font-mono` line) — both are real DOM in `AgentSkillsTab.tsx`. Do **not** introduce a new `data-testid` in source (this task only edits the plan/spec); pick a locator that works against the component as-built.
  > **No fake conflict.** The spec must not mutate the agent via `request` between toggles to manufacture a 409 — that races the optimistic UI and is flaky. Conflict coverage is Task 2/2b/4, as stated above.
- [ ] **Run, expect PASS (Linux) / SKIP (Windows):** `pnpm test:e2e agent-skill-toggle-persist`. On Windows without `DATABASE_URL` the whole suite self-skips (collects only the windows-skip spec); locally verify by running on Linux/CI, or set `DATABASE_URL` to an external Postgres on Windows. The spec exercises only behavior implemented in Tasks 2-5, so it is green once those are committed.
- [ ] **Commit:** `test(agents-e2e): skill toggle persists across reload (optimistic-concurrency round-trip)`.

---

## Task 7 — Governance: record the locked decision

**Files:**
- `docs/architecture/decisions.md` — append a new section. The latest decision is **#103** (file ends at line 798 with the `[#197]`/`[#198]`/`[#203]` link-reference footer). The next number is **#104**. Recent decisions use the `## Decision #NNN — Title (date)` prose format (see #92–#103).

Steps (no test — docs):

- [ ] **Append the decision.** Insert a new `## Decision #104` section **before** the trailing link-reference footer block (the three `[#NNN]:` lines at the end), so the link refs stay last:
  ```md
  ## Decision #104 — Optimistic concurrency for agent updates: optional `updatedAt` token → 409 (2026-06-25)

  Agent updates (`PATCH /api/agents/:id` → `agentService.update`) were pure
  last-write-wins (guarded by `id` only). Two concurrent human editors of the same
  agent (two tabs / two board members) silently clobbered each other. This is
  hardening, not a live fire — no MCP/automated path writes agents today — but the
  fix is cheap and aligns with **Decision #45** ("founder picks winner — surface
  conflicts, no auto-merge").

  **Locked pattern:**
  - **Token = the existing `agents.updatedAt`** (stamped on every write). No version
    column, **no DB migration**.
  - **Optional / opt-in.** `updateAgentSchema` gains `expectedUpdatedAt?` (ISO
    datetime). Absent → last-write-wins (full back-compat; no caller breaks).
    Present → enforced.
  - **Millisecond-precision guard (load-bearing).** `agents.updatedAt` is stored at
    Postgres **microsecond** resolution (`defaultNow()` on never-updated rows), while
    the client token is a **millisecond**-precision ISO string. A naked
    `eq(agents.updatedAt, expected)` would spuriously 409 (then loop) on the FIRST
    edit of a freshly-created agent. The guard therefore truncates **both sides to
    milliseconds**:
    `where(and(eq(agents.id, id), sql\`date_trunc('milliseconds', ${agents.updatedAt}) = ${new Date(expected)}\`))`.
    The token does **not** round-trip losslessly — this `date_trunc` is what makes it safe.
  - **Race-free atomic guard.** The check lives in the WHERE clause of the UPDATE —
    never a pre-read compare (that is TOCTOU). Zero rows matched **while the row still
    exists** → `conflict()` (HTTP **409**) with `details.currentUpdatedAt` (an **ISO
    string** — the service calls `.toISOString()`, since `errorHandler` doesn't coerce
    raw-`HttpError` `Date`s) so the client can refetch. Zero rows + row gone → `null` →
    404. Precedent: the atomic conditional UPDATE in `issues.ts` `checkout`. Proven
    against a real embedded Postgres (Linux-gated / Windows-skipped) because the
    mock-style unit tests can't evaluate the WHERE clause.
  - **Scope = whole row.** The token guards the entire `agents` row (Skills vs
    Config conflicts included). False-positive 409s on non-overlapping fields are
    acceptable — a refetch resolves them. Field-level reconciliation via
    `agent_config_revisions.changedKeys` is a possible v2, not now.
  - **UI opt-in (first wave):** Skills tab + Config save send `agent.updatedAt`
    from the query cache; on 409 they invalidate/refetch and toast "changed
    elsewhere — reloaded, please redo." The Skills tab advances a
    `latestExpectedUpdatedAt` ref from each successful update response (mirroring its
    `latestSkillKeys` ref) so back-to-back toggles before the refetch lands don't
    self-409 on a stale token. The transport-only token is destructured out on the
    route so it never reaches Drizzle `.set()`. Other editors can opt in later by
    passing the token.

  Refs: `packages/shared/src/validators/agent.ts`, `server/src/services/agents.ts`,
  `server/src/routes/agents.ts`, `ui/src/components/agent-detail/AgentSkillsTab.tsx`,
  `ui/src/components/AgentConfigForm.tsx`;
  `docs/aoa/plans/2026-06-25-followup-3-agent-update-concurrency-plan.md`.
  ```
- [ ] **Verify placement:** the three `[#197]:` / `[#198]:` / `[#203]:` reference lines remain the last lines of the file; the new `## Decision #104` section sits immediately above them.
- [ ] **Commit:** `docs(decisions): record Decision #104 — optimistic concurrency for agent updates`.

---

## Task 8 — Full-suite verification + finish

**Files:** none (verification + git).

- [ ] **Server suite (all):** `pnpm --filter @armyofagents/server exec vitest run` → green.
- [ ] **Shared suite (all):** `pnpm --filter @armyofagents/shared exec vitest run` → green.
- [ ] **UI suite (all):** `pnpm --filter @armyofagents/ui exec vitest run` → green.
- [ ] **E2E smoke (Linux gate; Windows self-skips):** `pnpm test:e2e agent-skill-toggle-persist` → green on Linux/CI (or with an external `DATABASE_URL` on Windows). On the Windows runner the suite self-skips by design — do not treat the skip as a failure.
- [ ] **Workspace typecheck:** `pnpm typecheck` → clean.
- [ ] **Self-review the diff:** `git diff main...HEAD` — confirm: **no raw SQL migration files** and no schema changes (the parameterized `sql\`date_trunc('milliseconds', …) = ${…}\`` fragment in the guarded UPDATE is a Drizzle `sql` template with bound params, not a raw-SQL file — the same construct `issues.ts` already uses; this is allowed and is **not** a migration), no OSS headers, every commit has the Co-Authored-By trailer, the token is optional everywhere (no caller is forced to send it), the transport-only `expectedUpdatedAt` never reaches Drizzle `.set()` (destructured out on the route), and the three original `AgentSkillsTab` payload assertions are untouched.
- [ ] **Use superpowers:finishing-a-development-branch** to open the PR off `main` (own branch `feat/agent-update-optimistic-concurrency`). PR body ends with the `🤖 Generated with [Claude Code]` line; verify `ci-required` is green.

---

## Definition of done

- [ ] `updateAgentSchema` accepts an optional ISO `expectedUpdatedAt`; an invalid value is rejected; an absent value parses (back-compat). (Task 1)
- [ ] `agentService.update`: no token → last-write-wins; matching token → succeeds; stale token (row exists) → throws 409 `conflict()` carrying `currentUpdatedAt` **as an ISO string**; token + vanished row → returns `null` (404). The guard is the atomic, **millisecond-precision** WHERE (`date_trunc('milliseconds', …)`), not a naked `eq` and not a pre-read compare. (Task 2)
- [ ] **Real-DB integration proof:** a freshly-created (`defaultNow()`) agent's ms-precision token succeeds on its FIRST guarded update (the precision regression), and a stale token 409s — Linux-gated / Windows-skipped. (Task 2b)
- [ ] `PATCH /api/agents/:id` forwards `expectedUpdatedAt` **only via the options object** (destructured out of `patchData` so it never reaches Drizzle `.set()` — asserted by test); a thrown conflict surfaces as HTTP 409 with `{ details: { currentUpdatedAt } }` (ISO string) via the existing error middleware; the vanished-row null still 404s; no-token PATCH still 200s. (Task 3)
- [ ] Skills tab sends the token only when the `expectedUpdatedAt` prop is provided, advances a `latestExpectedUpdatedAt` ref from each successful update response so back-to-back toggles don't self-409 (asserted by test), handles 409 (rollback + refetch + toast), and the three pre-existing exact-payload assertions still pass unchanged. (Task 4)
- [ ] Config save injects the token from `agent.updatedAt`; both worker + AoA `updateAgent` mutations handle 409 (refetch + toast). (Task 5)
- [ ] **E2E happy-path round-trip:** a real `local_trusted` instance — seed company + company skill + worker agent via REST, open the Skills tab, toggle a skill ON → reload → still attached (no spurious 409), toggle OFF → reload → detached. Linux-gated / Windows self-skips. The two-client 409 is explicitly out of scope for e2e — not because two pages can't be opened, but because the `activity.logged` → `agents.detail` invalidation (`LiveUpdatesProvider.tsx:477-485`) makes the other page refetch a fresh token before its toggle, so the conflict would be non-deterministic; deterministic conflict coverage is Tasks 2/2b/4. (Task 6)
- [ ] **Decision #104** recorded in `docs/architecture/decisions.md`. (Task 7)
- [ ] Server + shared + UI suites green; the e2e smoke green on Linux/CI; `pnpm typecheck` clean; back-compat (no-token) path tested at every layer. (Task 8)

---

## Self-review

- **Race-safety + precision (Codex P1 #2 — the load-bearing fix):** the only correctness-critical line is the guarded WHERE, which is `and(eq(agents.id, id), sql\`date_trunc('milliseconds', ${agents.updatedAt}) = ${new Date(expected)}\`)` — **not** a naked `eq(agents.updatedAt, expected)`. `agents.updatedAt` is stored at Postgres microsecond resolution (`defaultNow()` on never-updated rows from `create()`, which doesn't set `updatedAt`), while the client token is ms-precision ISO; a naked `eq` would spuriously 409 the FIRST edit and loop. `agents.ts` line 2 must add `sql` to its `drizzle-orm` import. `conflict()` already yields a 409 `HttpError` whose `details` the error middleware serializes — so no route try/catch and no new error plumbing is required (existing `conflict(...)` calls propagate the same way). The re-read after a zero-row miss only *classifies* 409-vs-404; it is not the concurrency check.
- **Mock tests can't prove precision → real-DB integration test (Task 2b):** under the Proxy mock the drizzle operators are no-ops, so the `date_trunc` WHERE is never evaluated. The precision regression (freshly-created agent's ms token succeeding on the first guarded update) is proven only by a Linux-gated / Windows-skipped embedded-postgres integration test that creates the agent through `agentService.create` (genuine `defaultNow()` microseconds).
- **Date vs ISO consistency (Codex P1 #3):** the service throws `conflict("…", { currentUpdatedAt: current.updatedAt.toISOString() })` — a **string**, because `errorHandler` spreads `err.details` verbatim and does NOT coerce a raw-`HttpError` `Date` to ISO (it only stringifies at the JSON boundary for objects that reach `res.json`). Both the service test and the route test assert the ISO string; the route test's mock rejects with the ISO-string shape to match reality.
- **Transport token never reaches `.set()` (Codex P1 #1):** the route destructures `const { expectedUpdatedAt, ...bodyRest } = req.body` and builds `patchData` from `bodyRest`, forwarding the token **only** in the `svc.update` options object (alongside `recordRevision`). A route test asserts the patch (arg 2) does NOT contain `expectedUpdatedAt` while the options (arg 3) does — otherwise it would flow into `.set({ ...normalizedPatch, updatedAt })` as a phantom column.
- **Stale-token self-409 defeated in the UI (Codex P1 #4):** `AgentSkillsTab` advances a `latestExpectedUpdatedAt` ref from each **successful** `agentsApi.update` response's `updatedAt` (mirroring the existing `latestSkillKeys` ref) and sends the ref — not the prop. A test fires two sequential toggles before any refetch and asserts the second call carries the token advanced from the first response (no self-409). `agentsApi.update` already returns the `Agent` (verified `ui/src/api/agents.ts:109-110`), so capturing it is the only success-path change.
- **Back-compat is load-bearing and tested at all four layers** (validator absent-token, service no-token, route no-token-in-options, UI prop-absent payload). The `AgentSkillsTab` payload-test question is resolved by an **optional prop** whose absent default is exactly what the three existing tests render — so they stay byte-identical; new prop-present tests cover the opt-in. The ref starts as `undefined` when the prop is absent, so the prop-absent payload is still exactly `{ skillKeys: [...] }`.
- **E2E proves the full round-trip the unit/integration tests can't (Task 6):** mock tests prove branches, the real-DB test proves the precision guard, the component test proves the UI 409 branch — but only the Playwright spec proves UI→route→service→DB→**reload re-render** as one flow. It is scoped honestly to the single-client happy path (toggle ON/OFF → reload → persisted). The **two-client conflict is deliberately NOT added as an e2e — not because it's unopenable, but because it would be flaky.** Two pages *can* be opened in one context (`context.newPage()` ×2), each with a stale token; but an agent PATCH calls `logActivity(action: "agent.updated", entityType: "agent")` (`routes/agents.ts:1352-1362`) → `publishLiveEvent("activity.logged")` company-broadcast (`services/activity-log.ts:32-45`, `services/live-events.ts:42`) → the OTHER page's `LiveUpdatesProvider` invalidates `agents.detail` (`context/LiveUpdatesProvider.tsx:477-485`), a prefix of its query key `["agents","detail",ref,companyId]` (`pages/AgentDetail.tsx:225-226`) → that page refetches a FRESH `updatedAt`, which is the very token Task 4 sends → no 409. It's a race the broadcast usually wins, so the spec would be non-deterministic. Real conflict coverage = Task 2 (mock 409), Task 2b (real-DB 409: edit advances `updatedAt`, re-sent stale token → 409), Task 4 (UI 409 rollback/toast + stale-token ref). Genuinely-uncoverable multi-client paths (authenticated multi-user) need a harness that doesn't exist yet — tracked for 1.1.

- **Maximal-coverage matrix (every required scenario has a home — audit before merge):**

  | Layer | Scenario | Where |
  |-------|----------|-------|
  | Validator | absent token parses (back-compat) | Task 1 |
  | Validator | valid ISO token accepted | Task 1 |
  | Validator | non-datetime token rejected | Task 1 |
  | Service | no token → last-write-wins succeeds | Task 2 |
  | Service | matching token → succeeds | Task 2 |
  | Service | stale token (row exists) → 409 w/ ISO `currentUpdatedAt` | Task 2 |
  | Service | token + vanished row → `null` (route → 404, NOT 409) | Task 2 |
  | Service | freshly-created `defaultNow()` row → ms token succeeds FIRST time | Task 2b (real DB) |
  | Service | stale token re-sent after an edit → 409 | Task 2b (real DB) |
  | Route | token forwarded ONLY via options; absent from patch arg | Task 3 |
  | Route | thrown conflict → HTTP 409 w/ `{ details: { currentUpdatedAt } }` | Task 3 |
  | Route | vanished-row null → 404 | Task 3 |
  | Route | no-token PATCH → 200, options omit token | Task 3 |
  | UI (Skills) | token included when prop present | Task 4 |
  | UI (Skills) | token ABSENT when prop absent (3 stable payload tests) | Task 4 |
  | UI (Skills) | 409 → rollback + refetch + toast | Task 4 |
  | UI (Skills) | two sequential toggles send the FRESH (advanced) token | Task 4 |
  | UI (Config) | save patch carries `expectedUpdatedAt` from `agent.updatedAt` | Task 5 |
  | UI (Config) | both worker + AoA mutations handle 409 (refetch + toast) | Task 5 |
  | E2E | happy-path round-trip: toggle ON/OFF → reload → persisted (single client) | Task 6 |
- **Things to double-check during execution:** (1) `createAgentDb`'s FIFO `selects` ordering for the dual-select sequence (initial `getById` + post-conflict re-read) — if it fights the helper, drop to a small inline sequence-DB (sanctioned by the repo). (2) Whether a page-level test for `AgentDetail`/`AoaAgentDetail` asserts an exact config-save payload — if so it needs the same `expect.objectContaining` relaxation (grep before Task 5's broad run). (3) The `@/lib/toast` vs `../../lib/toast` import alias must match each file's existing convention (Skills tab uses relative `../..`; pages may use `@/`). (4) `z.string().datetime({ offset: true })` must accept the exact form `new Date().toISOString()` emits — confirm in the validator test (it does: `…Z` is offset-compatible). (5) The embedded-postgres integration test only runs on Linux; running it locally on Windows self-skips — rely on CI for the gating run, per the repo's posture.
