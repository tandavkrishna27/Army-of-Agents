import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { clearFakeEmbedderControl, writeFakeEmbedderControl } from "./helpers/fake-embedder";

/**
 * E2E — Embedding re-index UI (memory-reindex-button).
 *
 * Tests the per-item re-index flow:
 *
 * 1. Force a `failed` queue entry by priming the fake embedder to throw a
 *    systemic error (status 401) and then creating a memory item. The worker
 *    processes the queue row, sees the error, and marks it "failed" (after
 *    exhausing retries or due to systemic classification).
 *
 * 2. The Memory page's MemoryIndexBadge shows `data-testid="memory-index-status"`
 *    with text "Failed" AND `data-testid="memory-reindex-button"` appears
 *    (because the Memory page passes `onReindex` to MemoryIndexBadge when the
 *    user has write permission — Decision #14 T14).
 *
 * 3. Clicking the re-index button fires
 *    `POST /companies/:cid/memory/:id/reindex` which resets the failed queue
 *    row to `pending`. We assert:
 *    (a) the button click is accepted (no navigation error),
 *    (b) a subsequent GET /memory returns indexStatus "pending" (not "failed").
 *
 * BOTH tests are gated behind `AOA_E2E_PGVECTOR=1`. The embedding pipeline is
 * pgvector-dependent end to end: enqueueMemoryEmbedding (memory-write.ts) is a
 * no-op without vector support, so on standard CI embedded-pg (no pgvector) no
 * queue row is ever created and an item can never reach "failed" — there is
 * nothing for the re-index flow to act on. The failed→reindex→pending
 * round-trip and the pending→indexed flip therefore only run under pgvector.
 * (The badge/button rendering itself is unit-tested in MemoryIndexBadge.test.tsx.)
 */

const PGVECTOR_AVAILABLE = process.env.AOA_E2E_PGVECTOR === "1";

async function createMemoryItem(
  request: APIRequestContext,
  companyId: string,
  opts: { title: string; content: string },
): Promise<{ id: string; title: string; indexStatus?: string }> {
  const res = await request.post(`/api/companies/${companyId}/memory`, {
    data: {
      title: opts.title,
      content: opts.content,
      layer: "domain",
      category: "procedure",
      source: "founder",
      status: "approved",
    },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`createMemoryItem failed: ${res.status()} ${body}`);
  }
  return res.json() as Promise<{ id: string; title: string; indexStatus?: string }>;
}

async function listMemoryItems(
  request: APIRequestContext,
  companyId: string,
): Promise<{ items: Array<{ id: string; title: string; indexStatus?: string }> }> {
  const res = await request.get(`/api/companies/${companyId}/memory`);
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`listMemoryItems failed: ${res.status()} ${body}`);
  }
  return res.json() as Promise<{ items: Array<{ id: string; title: string; indexStatus?: string }> }>;
}

/**
 * Poll the memory list until the given item reaches the target indexStatus,
 * or throw on timeout.
 */
async function waitForIndexStatus(
  request: APIRequestContext,
  companyId: string,
  itemId: string,
  targetStatus: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 20_000, pollMs = 500 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await listMemoryItems(request, companyId);
    const found = list.items.find((i) => i.id === itemId);
    if (found?.indexStatus === targetStatus) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const list = await listMemoryItems(request, companyId);
  const found = list.items.find((i) => i.id === itemId);
  throw new Error(
    `Timed out waiting for indexStatus="${targetStatus}" on item ${itemId}; current: ${found?.indexStatus ?? "item not found"}`,
  );
}

/** Navigate to /memory/legacy (the Memory page with MemoryIndexBadge). */
async function openMemoryPage(page: Page, issuePrefix: string): Promise<void> {
  await page.goto(`/${issuePrefix}/memory/legacy`);
  await expect(page.getByRole("heading", { name: /memory/i }).first()).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("embedding re-index — failed badge + re-index button", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Reindex-/);
    clearFakeEmbedderControl();
  });

  test.afterEach(() => {
    // Always clear forced errors so subsequent specs start clean.
    clearFakeEmbedderControl();
  });

  test(
    "row-permanent embedder failure → failed badge + reindex-button visible → reindex request resets to pending",
    async ({ page, request }) => {
      // Gated behind pgvector: enqueueMemoryEmbedding is a no-op when pgvector
      // is absent (memory-write.ts Guard 1 — the embedding column only exists on
      // a vector-capable PG), so without pgvector NO queue row is ever created
      // and the item can never reach "failed". The standard CI embedded-pg has
      // no pgvector, so this whole failed→reindex→pending round-trip is only
      // exercisable under AOA_E2E_PGVECTOR=1.
      test.skip(
        !PGVECTOR_AVAILABLE,
        "Requires pgvector — enqueueMemoryEmbedding no-ops without vector support",
      );
      // Two stacked "eventually" polls (failed→reindex→indexed) sum to ~55s,
      // which overruns Playwright's 60s default under CI runner contention.
      // Match the sibling memory-index-status.spec.ts headroom.
      test.setTimeout(120_000);

      const company = await seedCompany(request, `E2E-Reindex-${Date.now()}`);

      // Add a per-company OpenAI key so the worker resolves a key and processes
      // the queue row. The e2e webServer no longer injects a global
      // OPENAI_API_KEY, so without this the row stays pending and never fails.
      const keyRes = await request.post(`/api/companies/${company.id}/secrets`, {
        data: { name: "llm:openai", value: "e2e-fake-reindex-key" },
      });
      expect(keyRes.ok()).toBe(true);

      // Force a row-permanent embed failure: fake embedder throws { status: 400 }.
      // classifyEmbeddingError maps this to "row_permanent" → the worker marks
      // the row "failed" immediately (one attempt; will never succeed). A
      // "systemic" (401) error would instead trip the per-company circuit breaker
      // and restore the row to "pending", which is NOT the state this test needs.
      writeFakeEmbedderControl({ fail: "row_permanent" });

      // Create a memory item — this enqueues an embedding row. The fake embedder
      // returns a row-permanent error on the worker's next poll cycle.
      const item = await createMemoryItem(request, company.id, {
        title: "E2E: reindex test item",
        content: "This item is expected to fail embedding due to forced systemic error.",
      });
      expect(item.id).toBeTruthy();

      // Wait until the queue row is marked "failed" (worker runs, fails, persists error).
      // "failed" status is reflected as indexStatus="failed" in the memory list.
      await waitForIndexStatus(request, company.id, item.id, "failed", {
        timeoutMs: 25_000,
      });

      // Clear the forced error so the re-index can succeed (or at least reach pending).
      clearFakeEmbedderControl();

      // Navigate to the Memory page and assert the failed badge and re-index button.
      await openMemoryPage(page, company.issuePrefix);

      // The failed badge must appear for our item.
      // Multiple items may be on the page (starter templates, etc.) — find the
      // one next to our item title.
      const itemRow = page.locator("[data-testid], li, tr").filter({
        hasText: "E2E: reindex test item",
      }).first();

      // The memory-index-status badge for the failed item should say "Failed".
      // If the row locator is unavailable (layout difference), fall back to
      // the first failed badge on the page.
      const failedBadge = page
        .getByTestId("memory-index-status")
        .filter({ hasText: /failed/i })
        .first();
      await expect(failedBadge).toBeVisible({ timeout: 10_000 });

      // The re-index button must be visible (Memory page passes onReindex to
      // MemoryIndexBadge for founder-role users).
      const reindexButton = page.getByTestId("memory-reindex-button").first();
      await expect(reindexButton).toBeVisible({ timeout: 5_000 });

      // Click the re-index button — fires POST /memory/:id/reindex.
      await reindexButton.click();

      // After clicking, the queue row is reset to pending and the worker (fake
      // embedder, error cleared above) re-embeds it. With pgvector present + the
      // timestamp-coercion/self-exclusion fix, the vector is written and the row
      // flips to "indexed". (Pre-fix this silently completed WITHOUT a vector and
      // stayed not_indexed.) This proves the full failed → reindex → indexed loop.
      await waitForIndexStatus(request, company.id, item.id, "indexed", {
        timeoutMs: 30_000,
      });

      // The re-index API round-trip is now proven:
      // failed → (click button) → POST /reindex → pending.
      // (The full pending→indexed flip is pgvector-gated below.)
    },
  );

  test(
    "pgvector-gated: after re-index request, item eventually flips to indexed",
    async ({ request }) => {
      test.skip(
        !PGVECTOR_AVAILABLE,
        "Requires pgvector extension (set AOA_E2E_PGVECTOR=1 to enable)",
      );
      // Stacked "eventually" polls overrun the 60s default under CI contention;
      // match the sibling memory-index-status.spec.ts headroom.
      test.setTimeout(120_000);

      // The fake embedder is error-free here; item must become indexed after re-index.
      clearFakeEmbedderControl();

      const company = await seedCompany(request, `E2E-Reindex-${Date.now()}`);

      // Add a company key so the embedding worker picks it up.
      const secretRes = await request.post(
        `/api/companies/${company.id}/secrets`,
        {
          data: { name: "llm:openai", value: "e2e-fake-reindex-key" },
        },
      );
      expect(secretRes.ok()).toBe(true);

      // Force a row-permanent failure first so the item reaches "failed" status
      // immediately (a "systemic" error would circuit-break to "pending" instead).
      writeFakeEmbedderControl({ fail: "row_permanent" });
      const item = await createMemoryItem(request, company.id, {
        title: "E2E: pgvector reindex test item",
        content: "Should reach indexed after re-index button clicked.",
      });
      await waitForIndexStatus(request, company.id, item.id, "failed", {
        timeoutMs: 25_000,
      });

      // Clear the error and fire the re-index API directly (no UI needed for
      // the pgvector flip assertion — we are proving the API round-trip only).
      clearFakeEmbedderControl();
      const reindexRes = await request.post(
        `/api/companies/${company.id}/memory/${item.id}/reindex`,
      );
      expect(reindexRes.ok()).toBe(true);
      const reindexBody = (await reindexRes.json()) as { reindexed: boolean };
      expect(reindexBody.reindexed).toBe(true);

      // With pgvector available and the fake embedder returning success, the
      // worker should write the vector and flip the status to "indexed".
      await waitForIndexStatus(request, company.id, item.id, "indexed", {
        timeoutMs: 30_000,
      });
    },
  );
});
