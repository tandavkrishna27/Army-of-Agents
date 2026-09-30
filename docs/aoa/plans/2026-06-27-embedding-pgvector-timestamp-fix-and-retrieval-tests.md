# Embedding pgvector Timestamp Fix + Retrieval Verification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the production bug that breaks all embedding writes when pgvector is present, prove embedding **write** AND **retrieval** end-to-end against real pgvector, and add a CI lane so the pgvector path can never silently rot again.

**Architecture:** The embedding worker claims queue rows via `db.execute(sql.raw(...))`. With the postgres.js driver, raw SQL returns `timestamp`/`timestamptz` columns as **strings**, not `Date`. The worker casts `row.createdAt as Date` (a lie) and feeds it to Drizzle `gt()` on a timestamp column, which calls `.toISOString()` → throws `"v.toISOString is not a function"` on every embed. Fix = coerce the raw row's timestamp fields to `Date` immediately after the claim, via a tiny pure, unit-tested helper. Then fix the never-run pgvector e2e tests (wrong field name + a global env key that masks the no-key path), add a retrieval ranking test, and wire a pgvector CI lane.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM (postgres.js driver), PostgreSQL + pgvector, Vitest, Playwright, Docker (pgvector/pgvector:pg16), GitHub Actions.

**Branch:** `fix/embedding-pgvector-timestamp-and-retrieval` (off `main` @ `ba4ef5228`), worktree `C:/Users/TK/.aoa/wt/qa-keyless-e2e`.

**Local pgvector for running pgvector-gated e2e:** container `aoa-keyless-e2e-pgvector` (postgres+pgvector, host port 55433, db `aoa`, user/pass postgres/postgres). Run pgvector e2e with:
`DATABASE_URL=postgres://postgres:postgres@localhost:55433/aoa AOA_E2E_PGVECTOR=1 AOA_E2E_PORT=3288 pnpm exec playwright test --config=tests/e2e/playwright.config.ts <spec...> --reporter=list`

---

## Root-cause evidence (proven)

Probe against the live pgvector DB via `drizzle-orm/postgres-js` + `db.execute(sql.raw('SELECT now() AS "createdAt"'))`:
```
now() [timestamptz]: typeof=string | isDate=false | hasToISOString=undefined
mapToDriverValue(timestamptz) THREW: v.toISOString is not a function
```
Bug site: `server/src/services/embeddings.ts`
- line ~786: raw CTE claim, `RETURNING ... created_at AS "createdAt", next_retry_at AS "nextRetryAt", updated_at AS "updatedAt"`
- line ~823: `pending = rawRows as Array<typeof embeddingQueue.$inferSelect>` (cast only — no Date coercion)
- line ~1011: `gt(embeddingQueue.createdAt, item.createdAt as Date)` → throws
- line ~1031: `updateVectorColumn(..., item.createdAt as Date)` → binds string into a `sql` template (works, but type-unsafe)

Audit verdict: only ONE high-risk site (`embeddings.ts`). `memory-projection.ts:152` returns timestamps but downstream (`enqueueMemoryEmbedding`) only reads `id/title/content` — type-unsafe, not a live bug (Task 2 hardens it). All retrieval paths (`searchSemantic`, `searchMultiPath`, `findSimilarItems`, thread/memory HNSW tools) use the Drizzle query builder → timestamps typed correctly → NOT exposed. But retrieval has **no real-pgvector test** (all mocked) — Task 5 adds one.

---

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `server/src/services/embeddings-row-utils.ts` | Pure helper: coerce raw-SQL queue-row timestamp strings → `Date` | **Create** |
| `server/src/__tests__/embeddings-row-utils.test.ts` | Unit test for the helper (string→Date, null-safe, idempotent on Date) | **Create** |
| `server/src/services/embeddings.ts` | Use helper at the claim site; drop the lying `as Date` casts | **Modify** (~815–823, 1011, 1031) |
| `server/src/services/memory-projection.ts` | Apply the same coercion to its raw INSERT RETURNING rows (type honesty) | **Modify** (~152) |
| `tests/e2e/embedding-reindex.spec.ts` | Fix `secretType`→`name`; self-provision a per-company key | **Modify** |
| `tests/e2e/memory-index-status.spec.ts` | Fix `secretType`→`name` (×2); add retrieval ranking test | **Modify** |
| `tests/e2e/playwright.config.ts` | Remove the global `OPENAI_API_KEY` placeholder | **Modify** |
| `tests/e2e/semantic-retrieval.spec.ts` | NEW pgvector-gated e2e: index items → semantic search → assert ranked results | **Create** |
| `.github/workflows/pr.yml` | Add a pgvector e2e lane (pgvector service + `AOA_E2E_PGVECTOR=1`) | **Modify** |
| `docs/architecture/decisions.md` | Note the raw-SQL-timestamp coercion rule + pgvector CI lane | **Modify** |

---

### Task 1: Fix the worker timestamp bug (the P1)

**Files:**
- Create: `server/src/services/embeddings-row-utils.ts`
- Test: `server/src/__tests__/embeddings-row-utils.test.ts`
- Modify: `server/src/services/embeddings.ts` (~815–823, 1011, 1031)

- [ ] **Step 1: Write the failing unit test**

```ts
// server/src/__tests__/embeddings-row-utils.test.ts
import { describe, it, expect } from "vitest";
import { coerceQueueRowTimestamps } from "../services/embeddings-row-utils.js";

describe("coerceQueueRowTimestamps", () => {
  it("converts postgres.js string timestamps to Date", () => {
    const row = {
      id: "q1",
      createdAt: "2026-06-27 14:12:18.187703+00",
      updatedAt: "2026-06-27 14:12:18.187703+00",
      nextRetryAt: "2026-06-27 15:00:00+00",
    };
    const out = coerceQueueRowTimestamps(row);
    expect(out.createdAt).toBeInstanceOf(Date);
    expect(out.updatedAt).toBeInstanceOf(Date);
    expect(out.nextRetryAt).toBeInstanceOf(Date);
    // Critical: a Date HAS toISOString (the thing Drizzle gt() calls).
    expect(typeof (out.createdAt as Date).toISOString).toBe("function");
  });

  it("leaves null/undefined timestamps untouched", () => {
    const out = coerceQueueRowTimestamps({ id: "q2", createdAt: "2026-06-27 00:00:00+00", updatedAt: null, nextRetryAt: undefined });
    expect(out.nextRetryAt ?? null).toBeNull();
    expect(out.updatedAt ?? null).toBeNull();
  });

  it("is idempotent when the field is already a Date", () => {
    const d = new Date("2026-06-27T00:00:00.000Z");
    const out = coerceQueueRowTimestamps({ id: "q3", createdAt: d, updatedAt: d, nextRetryAt: d });
    expect((out.createdAt as Date).getTime()).toBe(d.getTime());
  });

  it("preserves non-timestamp fields verbatim", () => {
    const out = coerceQueueRowTimestamps({ id: "q4", companyId: "c1", inputText: "hello", attempts: 2, createdAt: "2026-06-27 00:00:00+00", updatedAt: null, nextRetryAt: null });
    expect(out.id).toBe("q4");
    expect(out.companyId).toBe("c1");
    expect(out.inputText).toBe("hello");
    expect(out.attempts).toBe(2);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `pnpm test:run embeddings-row-utils`
Expected: FAIL — cannot resolve `../services/embeddings-row-utils.js`.

- [ ] **Step 3: Implement the helper**

```ts
// server/src/services/embeddings-row-utils.ts
/**
 * Coerce timestamp columns returned from a RAW SQL query into Date objects.
 *
 * Why: with the postgres.js driver, `db.execute(sql.raw(...))` (and raw `sql`
 * templates) bypass Drizzle's column type-mapping, so `timestamp`/`timestamptz`
 * columns come back as STRINGS, not Date. Downstream Drizzle comparisons on a
 * timestamp column (e.g. `gt(table.createdAt, value)`) call `value.toISOString()`
 * and throw "v.toISOString is not a function" when handed a string. Run raw
 * queue rows through this before using their timestamps as Dates.
 */
function toDate(v: unknown): Date | null | undefined {
  if (v == null) return v as null | undefined;
  if (v instanceof Date) return v;
  return new Date(v as string);
}

export function coerceQueueRowTimestamps<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    ...(("createdAt" in row) ? { createdAt: toDate(row.createdAt) } : {}),
    ...(("updatedAt" in row) ? { updatedAt: toDate(row.updatedAt) } : {}),
    ...(("nextRetryAt" in row) ? { nextRetryAt: toDate(row.nextRetryAt) } : {}),
  } as T;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `pnpm test:run embeddings-row-utils`
Expected: PASS (4 tests).

- [ ] **Step 5: Use the helper in the worker claim path**

In `server/src/services/embeddings.ts`, add the import near the top:
```ts
import { coerceQueueRowTimestamps } from "./embeddings-row-utils.js";
```
Replace the bare cast (~line 823):
```ts
// BEFORE:
pending = rawRows as Array<typeof embeddingQueue.$inferSelect>;
// AFTER:
pending = rawRows.map((r) =>
  coerceQueueRowTimestamps(r as Record<string, unknown>),
) as Array<typeof embeddingQueue.$inferSelect>;
```
Then remove the now-redundant lies at the two use sites (keep them defensive but honest):
- line ~1011: `gt(embeddingQueue.createdAt, item.createdAt as Date)` — leave as `item.createdAt` is now a real Date; the `as Date` cast is harmless but keep it for the type-checker since `$inferSelect` already types it Date. (No code change needed once the row is coerced; verify it compiles.)
- line ~1031: `updateVectorColumn(..., item.createdAt as Date)` — same.

- [ ] **Step 6: Typecheck**

Run: `pnpm -r typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/embeddings-row-utils.ts server/src/__tests__/embeddings-row-utils.test.ts server/src/services/embeddings.ts
git commit -m "fix(embeddings): coerce raw-SQL queue-row timestamps to Date (pgvector write path)"
```

---

### Task 2: Harden `memory-projection.ts` raw RETURNING (type honesty)

**Files:** Modify `server/src/services/memory-projection.ts` (~152, where the raw INSERT result is cast to `$inferSelect`).

- [ ] **Step 1: Apply the same coercion**

Add import:
```ts
import { coerceQueueRowTimestamps } from "./embeddings-row-utils.js";
```
At the result-normalization site (~line 152), wrap each returned row so its `createdAt/updatedAt`-style fields are real Dates before the `as $inferSelect` cast. If the helper's field set doesn't cover a memory-specific timestamp used downstream, this is still a no-op for current callers (they read only id/title/content) — but it makes the `$inferSelect` cast honest. (If a reviewer prefers, instead add a one-line comment documenting that callers must not consume timestamp fields from this raw path. Coercion is preferred.)

- [ ] **Step 2: Typecheck + existing memory-projection tests**

Run: `pnpm test:run memory-projection` and `pnpm -r typecheck`
Expected: PASS / 0 errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/memory-projection.ts
git commit -m "fix(memory): coerce raw INSERT RETURNING timestamps to Date (type honesty)"
```

---

### Task 3: Fix the 3 stale e2e tests (`secretType` → `name`)

The secrets API (`createSecretSchema`) requires `name` (e.g. `"llm:openai"`), not `secretType`. The 3 pgvector tests POST `{secretType:...}` → 400 → never set up a key.

**Files:** Modify `tests/e2e/memory-index-status.spec.ts` (lines 168, 237) and `tests/e2e/embedding-reindex.spec.ts` (line ~213, added in Task 4).

- [ ] **Step 1: Replace `secretType` with `name` in `memory-index-status.spec.ts`**

Line 168:
```ts
data: { name: "llm:openai", value: "e2e-fake-pgvector-key" },
```
Line 237:
```ts
data: { name: "llm:openai", value: "e2e-fake-backfill-key" },
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/memory-index-status.spec.ts
git commit -m "test(e2e): POST /secrets uses name not secretType (matches createSecretSchema)"
```

---

### Task 4: Decouple e2e from the global env key (fixes the no-key tests #8/#9)

`playwright.config.ts` injects `OPENAI_API_KEY=e2e-fake-openai-key-placeholder`. `resolveSemanticAvailable` → `hasProviderKey(db, companyId, "openai")` consults the env var as a fallback, so under pgvector EVERY company reports `semanticAvailable=true` → the no-key banner never shows (the test's own comment wrongly assumes env is ignored). Remove the global key; have key-needing tests self-provision a per-company key.

**Files:** Modify `tests/e2e/playwright.config.ts`, `tests/e2e/embedding-reindex.spec.ts`.

- [ ] **Step 1: Remove the placeholder from `playwright.config.ts`**

Delete the line in `webServer.env`:
```ts
OPENAI_API_KEY: "e2e-fake-openai-key-placeholder",
```
(The fake embedder is armed by `AOA_E2E_FAKE_EMBEDDER=1`; embeds don't need a real key. Companies that need `semanticAvailable=true` now add a per-company secret.)

- [ ] **Step 2: `embedding-reindex.spec.ts` — add a per-company key + fix field name**

In BOTH tests, immediately after `const company = await seedCompany(...)`, add:
```ts
const keyRes = await request.post(`/api/companies/${company.id}/secrets`, {
  data: { name: "llm:openai", value: "e2e-fake-reindex-key" },
});
expect(keyRes.ok()).toBe(true);
```
And in the second test (pgvector-gated "flips to indexed", ~line 210), change its existing secret POST to use `name` (not `secretType`).

- [ ] **Step 3: Run the no-key + reindex specs WITHOUT pgvector (standard lane) — expect PASS**

Run (no DATABASE_URL, no pgvector):
`pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/memory-index-status.spec.ts tests/e2e/keyless-extraction.spec.ts --reporter=list`
Expected: no-key/banner/alias tests PASS; pgvector-gated tests SKIP. (On Windows this needs `DATABASE_URL` set to a non-pgvector Postgres — use the existing plain `postgres:16` container on port 55432, WITHOUT `AOA_E2E_PGVECTOR`.)

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/playwright.config.ts tests/e2e/embedding-reindex.spec.ts
git commit -m "test(e2e): drop global OPENAI_API_KEY placeholder; key-needing tests self-provision"
```

---

### Task 5: Add the RETRIEVAL e2e test (semantic search ranking)

Proves the vector-read path end-to-end: index items, then `GET /memory/search?q=` returns the right item ranked first. Memory embedding text = `title + "\n" + content` (`memory-write.ts:62`); the fake embedder is deterministic by text, so a query equal to an item's `title\ncontent` ranks that item first (distance ~0).

**Files:** Create `tests/e2e/semantic-retrieval.spec.ts`.

- [ ] **Step 1: Write the test**

```ts
// tests/e2e/semantic-retrieval.spec.ts
import { test, expect, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { clearFakeEmbedderControl } from "./helpers/fake-embedder";

/**
 * E2E — semantic RETRIEVAL from pgvector (the read path).
 * pgvector-gated: cosine-distance search requires the vector column + index.
 * The fake embedder (AOA_E2E_FAKE_EMBEDDER=1) is deterministic by text, so a
 * query equal to an item's embedded text (title\ncontent) ranks it first.
 */
const PGVECTOR_AVAILABLE = process.env.AOA_E2E_PGVECTOR === "1";

async function addKey(request: APIRequestContext, companyId: string) {
  const res = await request.post(`/api/companies/${companyId}/secrets`, {
    data: { name: "llm:openai", value: "e2e-fake-retrieval-key" },
  });
  expect(res.ok()).toBe(true);
}

async function createItem(request: APIRequestContext, companyId: string, title: string, content: string) {
  const res = await request.post(`/api/companies/${companyId}/memory`, {
    data: { title, content, layer: "domain", category: "procedure", source: "founder", status: "approved" },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: string };
}

async function waitIndexed(request: APIRequestContext, companyId: string, id: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await request.get(`/api/companies/${companyId}/memory`);
    const body = (await res.json()) as { items: Array<{ id: string; indexStatus?: string }> };
    if (body.items.find((i) => i.id === id)?.indexStatus === "indexed") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`item ${id} never indexed`);
}

test.describe("semantic retrieval — pgvector cosine ranking", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Retr-/);
    clearFakeEmbedderControl();
  });

  test("indexed items are returned ranked by similarity to the query", async ({ request }) => {
    test.skip(!PGVECTOR_AVAILABLE, "Requires pgvector (set AOA_E2E_PGVECTOR=1)");

    const company = await seedCompany(request, `E2E-Retr-${Date.now()}`);
    await addKey(request, company.id);

    const billingTitle = "Billing refund policy";
    const billingContent = "Refunds are processed within thirty days via Stripe for all paid plans.";
    const wifiTitle = "Office wifi";
    const wifiContent = "The guest wifi password rotates on the first Monday of every month.";

    const billing = await createItem(request, company.id, billingTitle, billingContent);
    const wifi = await createItem(request, company.id, wifiTitle, wifiContent);
    await waitIndexed(request, company.id, billing.id);
    await waitIndexed(request, company.id, wifi.id);

    // Query with the EXACT embedded text of the billing item (title\ncontent) so
    // the deterministic fake embedder ranks it first (distance ~0).
    const q = `${billingTitle}\n${billingContent}`;
    const res = await request.get(
      `/api/companies/${company.id}/memory/search?q=${encodeURIComponent(q)}`,
    );
    expect(res.ok()).toBe(true);
    const results = (await res.json()) as Array<{ id: string }> | { items: Array<{ id: string }> };
    const items = Array.isArray(results) ? results : results.items;

    expect(items.length).toBeGreaterThan(0);
    expect(items[0].id).toBe(billing.id); // billing ranks first
    expect(items.some((i) => i.id === wifi.id)).toBe(true); // wifi also retrievable
  });
});
```

- [ ] **Step 2: Confirm the `/memory/search` response shape**

Read `server/src/routes/memory.ts` around line 69–82 to confirm whether the route returns a bare array or `{ items }`. Adjust the `items` destructure in Step 1 to match the real shape (the test already handles both; lock it to the real one).

- [ ] **Step 3: Run it with pgvector — expect PASS**

Run: `DATABASE_URL=postgres://postgres:postgres@localhost:55433/aoa AOA_E2E_PGVECTOR=1 AOA_E2E_PORT=3288 pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/semantic-retrieval.spec.ts --reporter=list`
Expected: PASS (1 test). This is the FIRST real cosine-distance retrieval assertion in the suite.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/semantic-retrieval.spec.ts
git commit -m "test(e2e): add pgvector semantic-retrieval ranking test (read path)"
```

---

### Task 6: Add a pgvector CI lane

No workflow sets `AOA_E2E_PGVECTOR` — the entire indexing+retrieval half of the feature has never run in CI. Add a lane.

**Files:** Modify `.github/workflows/pr.yml`.

- [ ] **Step 1: Add a job `e2e-pgvector`** (model it on the existing `e2e` job) with:
  - a `services.postgres` using image `pgvector/pgvector:pg16`, env `POSTGRES_USER/PASSWORD/DB=aoa`, health-check, port 5432:5432;
  - env on the playwright step: `DATABASE_URL: postgres://postgres:postgres@localhost:5432/aoa` and `AOA_E2E_PGVECTOR: "1"`;
  - run only the pgvector-relevant specs to keep it fast:
    `pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/embedding-reindex.spec.ts tests/e2e/memory-index-status.spec.ts tests/e2e/semantic-retrieval.spec.ts`
  - mark advisory (`continue-on-error: true`) for the first PR if the team wants it non-blocking, OR fold into `ci-required` — **decide in /plan-eng-review**. Default: make it a required check (it guards a real correctness path).

- [ ] **Step 2: Validate YAML locally**

Run: `pnpm exec js-yaml .github/workflows/pr.yml >/dev/null` (or any YAML linter available) — expect no parse error. If no linter, eyeball indentation against the sibling `e2e` job.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pr.yml
git commit -m "ci: add pgvector e2e lane (AOA_E2E_PGVECTOR) for embedding write+retrieval"
```

---

### Task 7: Full verification

- [ ] **Step 1: pgvector e2e — all green** (the 5 previously-red + the new retrieval test)

Run: `DATABASE_URL=postgres://postgres:postgres@localhost:55433/aoa AOA_E2E_PGVECTOR=1 AOA_E2E_PORT=3288 pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/keyless-extraction.spec.ts tests/e2e/extraction-failure.spec.ts tests/e2e/embedding-reindex.spec.ts tests/e2e/memory-index-status.spec.ts tests/e2e/semantic-retrieval.spec.ts --reporter=list`
Expected: ALL pass (0 failed). Specifically the indexed-badge, backfill, and retrieval tests now pass (proving the worker fix).

- [ ] **Step 2: Standard lane (no pgvector) — no regression** from removing the global key

Run the same specs WITHOUT `AOA_E2E_PGVECTOR` (and on Windows with `DATABASE_URL` → the plain `postgres:16` container on 55432). Expected: keyless + no-key + alias PASS; pgvector-gated SKIP. Then run a couple of unrelated specs (e.g. a commander spec) to confirm dropping `OPENAI_API_KEY` broke nothing.

- [ ] **Step 3: Unit suite + typecheck**

Run: `pnpm -r typecheck` then `pnpm test:run embeddings` (worker/backfill/circuit/row-utils).
Expected: 0 type errors; all embedding unit tests pass.

- [ ] **Step 4: Commit any fixups, then update docs**

---

### Task 8: Docs + PR

- [ ] **Step 1: Decision note** — append to `docs/architecture/decisions.md`: raw-SQL queries via postgres.js return timestamps as strings; always coerce before using as Date / in Drizzle timestamp comparisons; pgvector e2e lane now guards the embedding write+retrieval path.

- [ ] **Step 2: Open PR off `main`**

```bash
git push -u origin fix/embedding-pgvector-timestamp-and-retrieval
gh pr create --base main --title "fix(embeddings): pgvector write-path timestamp bug + retrieval e2e + CI lane" --body "<summary of root cause, fix, and the new write+retrieval+CI coverage>"
```

- [ ] **Step 3: Wait for CI (incl. the new pgvector lane) to go green before requesting merge.**

---

## Self-Review checklist (run before implementing)

1. **Spec coverage:** worker bug fix (T1) ✓, sibling raw-SQL site hardened (T2) ✓, stale tests fixed (T3) ✓, no-key tests decoupled (T4) ✓, retrieval proven (T5) ✓, CI lane (T6) ✓, full verify (T7) ✓, docs+PR (T8) ✓.
2. **Placeholder scan:** every code step has real code; the only deliberate "confirm shape" step (T5 S2) reads a specific file/line range.
3. **Type consistency:** helper named `coerceQueueRowTimestamps` everywhere; secret field `name` everywhere; route `GET /companies/:cid/memory/search?q=`.

---

## Outcome (2026-06-27)

Implemented + **fully green**. Running the real pgvector e2e (the half CI never exercised) surfaced **three** latent embedding-write bugs, not one — each only reachable once the prior was fixed:

1. `createdAt` string→Date (`toISOString` crash) — coercion helper (Task 1).
2. Stale-write guard matched the row against itself (ms-vs-µs precision) — exclude by `id` (`ne`).
3. Vector write mis-bound: dynamic `.set({[col]: number[]})` bypassed the pgvector customType; a raw `db.execute` template then threw on the `Date` param. Final form: `.set({[col]: sql\`${lit}::vector\`})` + query-builder typed WHERE.

**Verification:** `pnpm -r typecheck` clean; embedding/memory unit suite 896 passed; **pgvector e2e 12/12 passed** (keyless extraction, failure UX, Settings/banner/alias, failed→reindex→indexed, indexed-flip, key-add backfill, and the new **semantic-retrieval cosine-ranking** test — the first real vector-READ assertion). Embeddings now persist and are retrievable when pgvector is present; the no-key path degrades correctly. CI `e2e-pgvector` lane gates this going forward.
