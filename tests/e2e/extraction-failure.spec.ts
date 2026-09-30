import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { writeFakeClaudeExtractionControl } from "./helpers/fake-claude";

/**
 * E2E — Extraction failure UX.
 *
 * When the one-shot CLI extractor (extraction-cli.ts) fails — either because
 * the CLI exits nonzero or returns unparseable output — the server marks the
 * discussion entry as `extractionStatus: "failed"` (surfaced, never silently
 * lost). The threads viewer (EntryRow → ChipRow) then renders a red
 * "Extraction failed" chip on the entry.
 *
 * Two failure modes are exercised:
 *   1. Nonzero exit (fake-claude control: `{ fail: "exit" }`) → CliExtractionError
 *      with kind "nonzero_exit".
 *   2. Unparseable output (`extractionText: "not json"`) → CliExtractionError
 *      with kind "unparseable".
 *
 * Both assert the same contract: the API marks the entry "failed" AND the UI
 * shows the "Extraction failed" chip. New entries are created "skipped" (no
 * auto-extraction), so each test fires the keyless CLI pipeline via the
 * reprocess endpoint — the deliberate founder-driven path.
 *
 * No pgvector required — this test exercises the discussion extraction pipeline,
 * not the embedding pipeline.
 */

type DiscussionEntry = {
  id: string;
  extractionStatus: string;
  extractedItems: Array<{ id: string; kind: string; title: string; status: string }>;
};

async function createDiscussion(
  request: APIRequestContext,
  companyId: string,
  title: string,
): Promise<{ id: string }> {
  const res = await request.post(`/api/companies/${companyId}/discussions`, {
    data: { title },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`createDiscussion failed: ${res.status()} ${body}`);
  }
  return res.json() as Promise<{ id: string }>;
}

async function createEntry(
  request: APIRequestContext,
  companyId: string,
  discussionId: string,
  content: string,
): Promise<{ id: string }> {
  const res = await request.post(
    `/api/companies/${companyId}/discussions/${discussionId}/entries`,
    { data: { rawContent: content, inputType: "write" } },
  );
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`createEntry failed: ${res.status()} ${body}`);
  }
  return res.json() as Promise<{ id: string }>;
}

/**
 * Trigger extraction for an entry. New entries are created with
 * extractionStatus="skipped" (discuss-phase entries are NOT auto-extracted —
 * see discussions.ts addEntry). The reprocess endpoint resets the entry to
 * "pending" and fires the (keyless CLI) extraction pipeline, which is exactly
 * the deliberate path the founder uses to run extraction.
 */
async function reprocessEntry(
  request: APIRequestContext,
  companyId: string,
  discussionId: string,
  entryId: string,
): Promise<void> {
  const res = await request.post(
    `/api/companies/${companyId}/discussions/${discussionId}/entries/${entryId}/reprocess`,
  );
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`reprocessEntry failed: ${res.status()} ${body}`);
  }
}

/** Poll discussion until the given entry reaches a terminal extraction status. */
async function waitForExtractionTerminal(
  request: APIRequestContext,
  companyId: string,
  discussionId: string,
  entryId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<DiscussionEntry> {
  const { timeoutMs = 30_000, pollMs = 500 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request.get(
      `/api/companies/${companyId}/discussions/${discussionId}`,
    );
    if (!res.ok()) {
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    const discussion = (await res.json()) as {
      entries: DiscussionEntry[];
    };
    const entry = discussion.entries.find((e) => e.id === entryId);
    if (
      entry &&
      entry.extractionStatus !== "pending" &&
      entry.extractionStatus !== "processing"
    ) {
      return entry;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Timed out waiting for terminal extraction status on entry ${entryId}`,
  );
}

/** Navigate to the discussion detail page and wait for the center header. */
async function openDiscussion(
  page: Page,
  issuePrefix: string,
  discussionId: string,
): Promise<void> {
  await page.goto(`/${issuePrefix}/discussions/${discussionId}`);
  // ThreadsWorkspace renders the discussion detail; wait for the center header.
  await expect(page.getByTestId("thread-center-header")).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("extraction failure UX", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-ExtFail-/);
  });

  test(
    "nonzero-exit CLI failure: entry is marked failed and the thread shows an 'Extraction failed' chip",
    async ({ page, request }) => {
      // Prime fake-claude to exit with code 1 (nonzero_exit branch).
      writeFakeClaudeExtractionControl({ fail: "exit" });

      const company = await seedCompany(request, `E2E-ExtFail-${Date.now()}`);
      const discussion = await createDiscussion(
        request,
        company.id,
        `Failure test nonzero ${Date.now()}`,
      );
      const entry = await createEntry(
        request,
        company.id,
        discussion.id,
        "This entry triggers a CLI failure to test the failure UX.",
      );

      // New entries are created "skipped"; reprocess fires the keyless CLI
      // extraction pipeline (which the primed fake-claude makes fail).
      await reprocessEntry(request, company.id, discussion.id, entry.id);

      // Wait for the server to mark the entry as failed (API level).
      const result = await waitForExtractionTerminal(
        request,
        company.id,
        discussion.id,
        entry.id,
      );
      expect(result.extractionStatus).toBe("failed");

      // Navigate to the thread and assert the failure is surfaced in the UI.
      // The threads viewer (EntryRow → ChipRow) renders a red "Extraction
      // failed" chip on the entry when extractionStatus === "failed".
      await openDiscussion(page, company.issuePrefix, discussion.id);
      await expect(page.getByText(/extraction failed/i).first()).toBeVisible({
        timeout: 10_000,
      });
    },
  );

  test(
    "unparseable CLI output: entry is marked failed and the thread shows an 'Extraction failed' chip",
    async ({ page, request }) => {
      // Prime fake-claude to emit non-JSON output so parseExtractedItems throws
      // → CliExtractionError kind "unparseable" → entry status "failed".
      writeFakeClaudeExtractionControl({
        extractionText: "this is not a JSON array at all",
      });

      const company = await seedCompany(request, `E2E-ExtFail-${Date.now()}`);
      const discussion = await createDiscussion(
        request,
        company.id,
        `Failure test unparseable ${Date.now()}`,
      );
      const entry = await createEntry(
        request,
        company.id,
        discussion.id,
        "This entry triggers an unparseable response to test the failure UX.",
      );

      // New entries are created "skipped"; reprocess fires the keyless CLI
      // extraction pipeline (which the primed fake-claude makes return
      // unparseable output).
      await reprocessEntry(request, company.id, discussion.id, entry.id);

      // Wait for the server to mark the entry as failed.
      const result = await waitForExtractionTerminal(
        request,
        company.id,
        discussion.id,
        entry.id,
      );
      expect(result.extractionStatus).toBe("failed");

      // Navigate and assert the failure is surfaced in the threads viewer
      // (the red "Extraction failed" chip rendered by EntryRow → ChipRow).
      await openDiscussion(page, company.issuePrefix, discussion.id);
      await expect(page.getByText(/extraction failed/i).first()).toBeVisible({
        timeout: 10_000,
      });
    },
  );
});
