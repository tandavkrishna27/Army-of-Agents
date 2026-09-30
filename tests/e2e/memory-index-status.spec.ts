import { test, expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { clearFakeEmbedderControl, writeFakeEmbedderControl } from "./helpers/fake-embedder";

/**
 * E2E — Memory index status badge + no-LLM-key banner.
 *
 * Tests two surfaces:
 *
 * (a) NO key configured → Memory page shows `data-testid="no-llm-key-banner"`
 *     (amber banner: "Semantic search is off — add an embeddings key in Settings →
 *     Memory") and memory items show the "not indexed" badge
 *     (`data-testid="memory-index-status"`).
 *
 *     The e2e webServer runs with NO embeddings key (OPENAI_API_KEY=""), and a
 *     freshly seeded company has no per-company secret either. resolveSemanticAvailable()
 *     needs pgvector AND a resolvable key (per-company secret or env), so it returns
 *     false → banner is shown.
 *
 *     This runs on standard embedded-pg (no pgvector needed).
 *
 * (b) GATED behind pgvector (`AOA_E2E_PGVECTOR=1`):
 *     With `AOA_E2E_FAKE_EMBEDDER=1` (already active in e2e env) + a company-level
 *     key configured, create a memory item → poll until the badge shows "Indexed".
 *     Also verifies the key-add-backfill path (key creation triggers reindex sweep).
 *
 * The `memory-index-status` badge testid lives in `ui/src/pages/Memory.tsx`
 * (the legacy /memory/legacy route), which renders the items list with a
 * MemoryIndexBadge per item.
 *
 * The `no-llm-key-banner` (amber "Semantic search is off — add an embeddings
 * key in Settings → Memory") now appears on BOTH surfaces: the legacy
 * `ui/src/pages/Memory.tsx` AND the primary `ui/src/pages/MemoryExplorer.tsx`
 * (the /memory/explore route). Both deep-link to Settings → Memory
 * (`?tab=memory`). This spec asserts the banner on each surface.
 */

const PGVECTOR_AVAILABLE = process.env.AOA_E2E_PGVECTOR === "1";

async function createMemoryItem(
  request: APIRequestContext,
  companyId: string,
  opts: { title: string; content: string; layer?: string },
): Promise<{ id: string; title: string; indexStatus?: string }> {
  const res = await request.post(`/api/companies/${companyId}/memory`, {
    data: {
      title: opts.title,
      content: opts.content,
      layer: opts.layer ?? "domain",
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
): Promise<{ items: Array<{ id: string; title: string; indexStatus?: string }>; semanticAvailable: boolean }> {
  const res = await request.get(`/api/companies/${companyId}/memory`);
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`listMemoryItems failed: ${res.status()} ${body}`);
  }
  return res.json() as Promise<{ items: Array<{ id: string; title: string; indexStatus?: string }>; semanticAvailable: boolean }>;
}

function e2eCompanyName(base: string, testInfo: TestInfo): string {
  return `${base}-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
}

async function waitForIndexStatus(
  request: APIRequestContext,
  companyId: string,
  itemId: string,
  targetStatus: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  // 80s default: a stopgap for the intermittent pgvector case where the embed +
  // vector-write lands slowly under CI load. NOTE: this only helps *slow-arrival*
  // — if the row is never enqueued (e.g. the boot-cached pgvector-capability probe
  // races enqueueMemoryEmbedding's Guard 1) the item stays permanently not_indexed
  // and no timeout helps. Pinning that path is tracked as Tier 1.5 in
  // docs/aoa/plans/2026-07-01-e2e-flake-stabilization-plan.md.
  const { timeoutMs = 80_000, pollMs = 500 } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "item not found";
  let lastItems = "";

  while (Date.now() < deadline) {
    const list = await listMemoryItems(request, companyId);
    lastItems = list.items.map((item) => `${item.title}:${item.indexStatus ?? "missing-status"}`).join(", ");
    const found = list.items.find((i) => i.id === itemId);
    lastStatus = found?.indexStatus ?? "item not found";
    if (found?.indexStatus === targetStatus) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(
    `Timed out waiting for indexStatus="${targetStatus}" on item ${itemId}; current: ${lastStatus}; items: ${lastItems}`,
  );
}

/** Navigate to /memory/legacy (the Memory page that renders the no-llm-key-banner). */
async function openMemoryPage(page: Page, issuePrefix: string): Promise<void> {
  await page.goto(`/${issuePrefix}/memory/legacy`);
  // The Memory page renders a heading.
  await expect(page.getByRole("heading", { name: /memory/i }).first()).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("memory index status — no-key path (no pgvector needed)", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-MemIdx-/);
    clearFakeEmbedderControl();
  });

  test(
    "fresh company with no per-company key: Memory page shows no-llm-key-banner and not-indexed badge",
    async ({ page, request }, testInfo) => {
      const company = await seedCompany(request, e2eCompanyName("E2E-MemIdx", testInfo));

      // Create a domain memory item. The freshly seeded company has no per-company
      // OpenAI secret, so resolveSemanticAvailable() → false, and
      // deriveIndexStatus({hasVector: false, queueStatus: null}) → "not_indexed".
      await createMemoryItem(request, company.id, {
        title: "E2E: Keyless memory index status test",
        content: "Processes for testing the no-key memory path in e2e.",
      });

      // Verify via API that semanticAvailable is false.
      const listResult = await listMemoryItems(request, company.id);
      expect(listResult.semanticAvailable).toBe(false);
      // indexStatus depends on pgvector: WITHOUT pgvector no queue row is created
      // → "not_indexed". WITH pgvector the item is enqueued but cannot embed (no
      // key resolves) → it sits "pending". Either way it is NOT "indexed" and the
      // no-llm-key banner shows (semanticAvailable=false).
      const item = listResult.items.find((i) => i.title === "E2E: Keyless memory index status test");
      expect(item).toBeTruthy();
      expect(["not_indexed", "pending"]).toContain(item!.indexStatus);

      // Navigate to the Memory page.
      await openMemoryPage(page, company.issuePrefix);

      // The no-llm-key-banner must be visible to the founder.
      await expect(page.getByTestId("no-llm-key-banner")).toBeVisible({
        timeout: 10_000,
      });

      // The item must show an un-indexed badge. WITHOUT pgvector that is
      // "Not indexed" (no queue row). WITH pgvector the item is enqueued but
      // can't embed (no key) so it reads "Indexing…" (pending). Either is a
      // valid "not searchable yet" state; the no-llm-key banner is the
      // authoritative no-key signal asserted above.
      await expect(page.getByTestId("memory-index-status").first()).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.getByTestId("memory-index-status").first()).toContainText(
        /not indexed|indexing/i,
      );

      // The PRIMARY surface (MemoryExplorer, /memory/explore) must ALSO show the
      // no-llm-key-banner, deep-linking to Settings → Memory.
      await page.goto(`/${company.issuePrefix}/memory/explore`);
      const explorerBanner = page.getByTestId("no-llm-key-banner");
      await expect(explorerBanner).toBeVisible({ timeout: 10_000 });
      await expect(explorerBanner).toContainText(/Settings\s*→\s*Memory/);
      // The banner links to the Memory settings tab (?tab=memory).
      await expect(
        explorerBanner.getByRole("link", { name: /Settings\s*→\s*Memory/ }),
      ).toHaveAttribute("href", /tab=memory/);
    },
  );
});

test.describe("memory index status — pgvector-gated (AOA_E2E_PGVECTOR=1 required)", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-MemIdxPG-/);
    clearFakeEmbedderControl();
  });

  test(
    "with pgvector + fake embedder: memory item badge flips to 'indexed' after embedding completes",
    async ({ page, request }, testInfo) => {
      test.skip(
        !PGVECTOR_AVAILABLE,
        "Requires pgvector extension (set AOA_E2E_PGVECTOR=1 to enable)",
      );
      test.setTimeout(120_000); // 80s poll (see waitForIndexStatus) + setup/assert headroom

      // The fake embedder is always active in e2e (AOA_E2E_FAKE_EMBEDDER=1).
      // Ensure no forced error is set so embeds succeed.
      clearFakeEmbedderControl();

      const company = await seedCompany(request, e2eCompanyName("E2E-MemIdxPG", testInfo));

      // The company needs a per-company OpenAI key for resolveSemanticAvailable()
      // to return true and for the embedding worker to process the queue row.
      // In the e2e env, the company_secrets table is backed by a fake AWS Secrets
      // Manager (AOA_E2E_FAKE_AWS_SECRETS_MANAGER=1), so this POST goes through.
      const secretRes = await request.post(
        `/api/companies/${company.id}/secrets`,
        {
          data: { name: "llm:openai", value: "e2e-fake-pgvector-key" },
        },
      );
      expect(secretRes.ok()).toBe(true);

      // Create a memory item — this enqueues an embedding row.
      const item = await createMemoryItem(request, company.id, {
        title: "E2E: pgvector indexed memory test",
        content: "This item should be indexed by the fake embedder in pgvector mode.",
      });
      expect(item.id).toBeTruthy();

      // Poll the API until indexStatus flips to "indexed" (fake embedder ran).
      await waitForIndexStatus(request, company.id, item.id, "indexed");

      // Navigate to the Memory page and assert the badge shows "Indexed".
      await openMemoryPage(page, company.issuePrefix);

      // The no-llm-key-banner must NOT be visible (key is present → semantic available).
      await expect(page.getByTestId("no-llm-key-banner")).toHaveCount(0);

      // The item's badge must show "Indexed".
      const badges = page.getByTestId("memory-index-status");
      // At least one badge should say "Indexed".
      await expect(badges.filter({ hasText: /^indexed$/i }).first()).toBeVisible({
        timeout: 5_000,
      });
    },
  );

  test(
    "with pgvector: adding a company key triggers backfill — existing items become indexed",
    async ({ page, request }, testInfo) => {
      test.skip(
        !PGVECTOR_AVAILABLE,
        "Requires pgvector extension (set AOA_E2E_PGVECTOR=1 to enable)",
      );
      test.setTimeout(120_000); // 80s poll (see waitForIndexStatus) + setup/assert headroom

      clearFakeEmbedderControl();

      const company = await seedCompany(request, e2eCompanyName("E2E-MemIdxPG", testInfo));

      // Create a memory item BEFORE adding a key — it will have no queue row
      // (keyless path: no key → no enqueue when semanticAvailable=false... or
      // the status-agnostic enqueue still fires; the route checks company key
      // resolves before embedding). Either way, after key add, the reindex sweep
      // fires and the item should eventually become indexed.
      const item = await createMemoryItem(request, company.id, {
        title: "E2E: pre-key memory item for backfill test",
        content: "Created before the OpenAI key was added, to test backfill sweep.",
      });
      expect(item.id).toBeTruthy();

      // Now add the company key (this triggers reindexCompany() fire-and-forget
      // in the secrets route handler).
      const secretRes = await request.post(
        `/api/companies/${company.id}/secrets`,
        {
          data: { name: "llm:openai", value: "e2e-fake-backfill-key" },
        },
      );
      expect(secretRes.ok()).toBe(true);

      // Poll until the item is indexed (backfill sweep processed the queue).
      await waitForIndexStatus(request, company.id, item.id, "indexed");

      // The Memory page should no longer show the no-llm-key-banner.
      await openMemoryPage(page, company.issuePrefix);
      await expect(page.getByTestId("no-llm-key-banner")).toHaveCount(0);
    },
  );
});
