import { test, expect, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import {
  clearFakeClaudeInvocations,
  readFakeClaudeInvocations,
  writeFakeClaudeExtractionControl,
} from "./helpers/fake-claude";

/**
 * E2E — Keyless extraction happy path.
 *
 * The keyless feature (Task 5/6) routes discussion extraction through the
 * one-shot CLI extractor (server/src/services/extraction-cli.ts) when the
 * fake `claude` binary is on PATH (as it always is in the e2e webServer env,
 * via the playwright.config.ts PATH prepend).
 *
 * This spec proves:
 *   1. A company with NO hosted OpenAI key still extracts successfully.
 *   2. The CLI extractor spawns `claude --print --system-prompt-file <f>
 *      --output-format text` and delivers the entry content over stdin —
 *      NOT as an argv positional (W1 Windows fix).
 *   3. The extracted item appears in the discussion detail (entry status
 *      "completed", extracted item of type "task").
 *   4. Approving the item via API creates a Task (issue row).
 *
 * No pgvector is required — extraction writes discussion_extracted_items rows,
 * not vectors. The fake embedder (always active in e2e) handles any incidental
 * embedding enqueue without blocking.
 *
 * All assertions are against the API or the DiscussionDetail page — no
 * MemoryIndexBadge or vector-dependent assertions here.
 */

const EXTRACTION_ITEM = [
  {
    type: "task",
    title: "Implement the keyless extraction happy path",
    description: "Prove that CLI-mode extraction creates a real task item.",
    priority: "medium",
  },
];

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
 * "pending" and fires the keyless CLI extraction pipeline — the deliberate
 * founder-driven path this spec exercises.
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

/** Poll the discussion until every entry reaches a terminal extraction status. */
async function waitForExtraction(
  request: APIRequestContext,
  companyId: string,
  discussionId: string,
  entryId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ extractionStatus: string; extractedItems: Array<{ id: string; type: string; title: string; status: string }> }> {
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
      entries: Array<{
        id: string;
        extractionStatus: string;
        extractedItems: Array<{ id: string; type: string; title: string; status: string }>;
      }>;
    };
    const entry = discussion.entries.find((e) => e.id === entryId);
    if (
      entry &&
      entry.extractionStatus !== "pending" &&
      entry.extractionStatus !== "processing"
    ) {
      return { extractionStatus: entry.extractionStatus, extractedItems: entry.extractedItems };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Timed out waiting for extraction on entry ${entryId} in discussion ${discussionId}`,
  );
}

test.describe("keyless extraction — happy path", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Keyless-/);
    clearFakeClaudeInvocations();
    // Prime the control file for extraction mode: a JSON array with one task item.
    writeFakeClaudeExtractionControl({
      extractionText: JSON.stringify(EXTRACTION_ITEM),
    });
  });

  test(
    "CLI extractor runs without a hosted key, entry completes, extracted task item appears",
    async ({ request }) => {
      const company = await seedCompany(request, `E2E-Keyless-${Date.now()}`);

      // The e2e webServer runs with NO embeddings key (OPENAI_API_KEY="") and the
      // company has no per-company OpenAI secret — so resolveSemanticAvailable()
      // returns false. Extraction is keyless regardless: the engine resolves to
      // "cli" (fake-claude on PATH).

      const discussion = await createDiscussion(
        request,
        company.id,
        `Keyless extraction test ${Date.now()}`,
      );

      const entry = await createEntry(
        request,
        company.id,
        discussion.id,
        "We need to implement the keyless extraction feature and make sure it creates proper task items.",
      );

      // Clear invocations just before the triggering action (reprocess fires the
      // CLI spawn) so the invocation assertion is scoped to this extraction only.
      // New entries are created "skipped" and are NOT auto-extracted, so
      // reprocess is the deliberate path that runs the keyless CLI extractor.
      clearFakeClaudeInvocations();
      await reprocessEntry(request, company.id, discussion.id, entry.id);

      // Poll until extraction completes (or fails — we assert "completed" below).
      const result = await waitForExtraction(
        request,
        company.id,
        discussion.id,
        entry.id,
      );

      // The entry must have completed, not skipped (keyless = still runs the CLI).
      expect(result.extractionStatus).toBe("completed");

      // At least one extracted item of type "task" from our scripted payload.
      // NOTE: discussion_extracted_items uses `type` (not `kind`), and the
      // parser (extraction-parser.ts) reads `obj.type` — the scripted payload
      // and this assertion must both use `type`.
      const taskItem = result.extractedItems.find((i) => i.type === "task");
      expect(taskItem).toBeTruthy();
      expect(taskItem!.title).toBe(EXTRACTION_ITEM[0].title);

      // --- Invocation contract assertions ---
      // The fake-claude shim records every spawn: we prove the CLI was actually
      // invoked in extraction mode (--output-format text), content was on stdin
      // (not in argv positionals), and no raw entry content leaked into argv.
      const invocations = readFakeClaudeInvocations();
      // At least one spawn happened for this extraction.
      expect(invocations.length).toBeGreaterThanOrEqual(1);

      const lastInvocation = invocations[invocations.length - 1];
      // Extraction mode: --output-format text (NOT stream-json).
      expect(lastInvocation.argv).toContain("--output-format");
      expect(lastInvocation.argv).toContain("text");
      expect(lastInvocation.argv).not.toContain("stream-json");
      // The --print flag is always present.
      expect(lastInvocation.argv).toContain("--print");
      // Content was NOT in argv (stdin delivery, W1 Windows fix).
      // The raw entry text must NOT appear anywhere in the argv array.
      const argvJoined = lastInvocation.argv.join(" ");
      expect(argvJoined).not.toContain("keyless extraction feature");
      // Content must have arrived on stdin.
      expect(lastInvocation.stdin).toContain("keyless extraction feature");

      // --- Approve the item and assert a Task is created ---
      // POST /companies/:cid/discussions/:did/approve
      // Body: { items: [{ itemId, action: "approved" }] }
      // Returns: { approved, rejected, tasksCreated: string[], memoryItemsCreated: string[] }
      const approveRes = await request.post(
        `/api/companies/${company.id}/discussions/${discussion.id}/approve`,
        {
          data: {
            items: [{ itemId: taskItem!.id, action: "approved" }],
          },
        },
      );
      expect(approveRes.ok()).toBe(true);
      const approveBody = (await approveRes.json()) as {
        approved: number;
        rejected: number;
        tasksCreated: string[];
        memoryItemsCreated: string[];
      };
      expect(approveBody.tasksCreated.length).toBeGreaterThan(0);
      const taskId = approveBody.tasksCreated[0];
      expect(taskId).toBeTruthy();

      // Confirm the issue exists. The single-issue GET is mounted at
      // /api/issues/:id (NOT company-prefixed — only issue sub-resources like
      // context-package/memory-retrievals carry the /companies/:cid prefix).
      const issueRes = await request.get(`/api/issues/${taskId}`);
      expect(issueRes.ok()).toBe(true);
      const issue = (await issueRes.json()) as { id: string; title: string };
      expect(issue.id).toBe(taskId);
    },
  );
});

/**
 * E2E — Settings → Memory section (the keyless rename) + MemoryExplorer banner.
 *
 * After the keyless refactor (Phase C): the Settings "LLM providers" section was
 * renamed to "Memory" (canonical id "memory"; the old `?tab=llm` value is
 * accepted as an alias and normalizes to the Memory section), the extraction
 * engine-status banner (testid "settings-extraction-engine-status") was DELETED,
 * and the MemoryExplorer page shows a "no-llm-key-banner" when no embeddings key
 * is configured (semanticAvailable === false), deep-linking to Settings → Memory.
 *
 * These are the CI-feasible UI scenarios — they require NO logged-in CLI and no
 * pgvector. Real-CLI extraction is covered by the happy-path describe above (via
 * the fake-claude shim) and by the live verification matrix (Task 13).
 */
test.describe("keyless — Settings → Memory section + MemoryExplorer banner", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-KeylessUI-/);
  });

  test(
    "Settings nav shows 'Memory' (not 'LLM providers') and no extraction engine-status banner",
    async ({ page, request }) => {
      const company = await seedCompany(request, `E2E-KeylessUI-${Date.now()}`);

      await page.goto(`/${company.issuePrefix}/settings?tab=memory`);

      // (a) The Memory section heading renders ("Memory." with a brand period).
      await expect(
        page.getByRole("heading", { level: 2, name: /^Memory\.$/ }),
      ).toBeVisible({ timeout: 10_000 });

      // (a) The settings nav has a "Memory" item and NOT "LLM providers".
      // The "Memory" nav button renders in both the desktop secondary sidebar
      // and the (CSS-hidden) mobile sub-nav — both from SETTINGS_SECTIONS — so
      // scope to the first match to stay strict-mode-safe across viewports.
      await expect(
        page.getByRole("button", { name: "Memory" }).first(),
      ).toBeVisible();
      await expect(page.getByText("LLM providers")).toHaveCount(0);

      // (b) The extraction engine-status banner testid is GONE everywhere in
      // Settings — it was deleted with the api-extraction engine.
      await expect(
        page.getByTestId("settings-extraction-engine-status"),
      ).toHaveCount(0);
    },
  );

  test(
    "?tab=llm alias lands on the Memory section (old bookmark survives)",
    async ({ page, request }) => {
      const company = await seedCompany(request, `E2E-KeylessUI-${Date.now()}`);

      // (c) The legacy ?tab=llm value normalizes to the Memory section rather
      // than silently falling back to General.
      await page.goto(`/${company.issuePrefix}/settings?tab=llm`);

      await expect(
        page.getByRole("heading", { level: 2, name: /^Memory\.$/ }),
      ).toBeVisible({ timeout: 10_000 });
    },
  );

  test(
    "MemoryExplorer shows the no-llm-key-banner when no embeddings key is configured",
    async ({ page, request }) => {
      const company = await seedCompany(request, `E2E-KeylessUI-${Date.now()}`);

      // (d) A freshly seeded company has no per-company OpenAI secret, so
      // resolveSemanticAvailable() → false and the MemoryExplorer banner shows.
      await page.goto(`/${company.issuePrefix}/memory/explore`);

      const banner = page.getByTestId("no-llm-key-banner");
      await expect(banner).toBeVisible({ timeout: 10_000 });
      await expect(banner).toContainText(/Semantic search is off/i);
      await expect(banner).toContainText(/Settings\s*→\s*Memory/);
      // The banner deep-links to the Memory settings tab.
      await expect(
        banner.getByRole("link", { name: /Settings\s*→\s*Memory/ }),
      ).toHaveAttribute("href", /tab=memory/);
    },
  );
});
