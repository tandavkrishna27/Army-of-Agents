import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { jsonOrThrow, listRuns, poll } from "./real-crew";

export type DiscussionDetail = {
  id: string;
  title: string;
  entrySeq?: number | null;
  autonomyLevel?: number | null;
  summaryText?: string | null;
  summaryUpdatedAt?: string | null;
  updatedAt?: string | null;
  entries?: Array<{
    id: string;
    inputType?: string | null;
    rawContent?: string | null;
    content?: string | null;
    authorAgentId?: string | null;
    authorAgentName?: string | null;
    authorName?: string | null;
    agentName?: string | null;
  }>;
  derivedStage?: {
    stage: string;
    label: string;
    versionNumber: number | null;
    hasNewEntries: boolean;
    newEntryCount: number;
  };
};

const TERMINAL_RUN_STATUSES = new Set(["completed", "succeeded", "failed", "cancelled", "timed_out"]);
const SUCCESS_RUN_STATUSES = new Set(["completed", "succeeded"]);

export async function expectVisibleAgentEntry(
  page: Page,
  entry: {
    id: string;
    inputType?: string | null;
    rawContent?: string | null;
    content?: string | null;
    authorAgentName?: string | null;
    agentName?: string | null;
  },
  agentName: string,
) {
  const body = entry.rawContent ?? entry.content ?? "";
  expect(body.trim().length, `${agentName} entry should have real content`).toBeGreaterThan(20);
  expect(entry.inputType ?? "agent", `${agentName} entry inputType`).toBe("agent");
  const row = page.locator(`[data-testid="entry-row-${entry.id}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute("data-entry-type", "agent");
  await expect(row).toContainText(agentName);
}

export async function createThreadFromUi(page: Page, title: string, firstMessage: string) {
  await page.getByRole("button", { name: /^new thread$/i }).first().click();
  const dialog = page.getByRole("dialog", { name: /^new thread$/i });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.locator("#thread-title").fill(title);
  await dialog.locator("#thread-description").fill(firstMessage);
  await dialog.getByRole("button", { name: /^create thread$/i }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 15_000 });
  await page.getByText(title).first().click();
  await expect(page.getByRole("heading", { name: title }).first()).toBeVisible({ timeout: 15_000 });
  const threadId = page.url().match(/\/discussions\/([^/?#]+)/)?.[1];
  if (!threadId) throw new Error(`Could not parse threadId from ${page.url()}`);
  return threadId;
}

export async function sendThreadMessage(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId("entry-composer-textarea");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill(text);
  const submit = page.getByTestId("entry-composer-submit").or(page.getByRole("button", { name: /^send$/i }));
  const entryResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      /\/api\/companies\/[^/]+\/discussions\/[^/]+\/entries$/.test(new URL(candidate.url()).pathname),
  );
  await submit.first().click();
  expect((await entryResponse).ok(), "send thread message response").toBe(true);
  await expect(page.locator('[data-testid^="entry-row-"]').filter({ hasText: text }).first()).toBeVisible({
    timeout: 15_000,
  });
}

export async function patchThreadAutonomy(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  autonomyLevel: number,
) {
  await jsonOrThrow(
    await request.patch(`/api/companies/${companyId}/internal-agent/config`, {
      // D18: crew flows read the crew/agent-work dial, not Commander's.
      data: { crewAutonomyLevel: autonomyLevel, crewPaused: false },
    }),
    "set company crew autonomy",
  );
  await jsonOrThrow(
    await request.patch(`/api/companies/${companyId}/discussions/${threadId}`, {
      data: { autonomyLevel },
    }),
    "set thread autonomy",
  );
}

export async function setCrewPaused(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  paused: boolean,
) {
  const route = paused ? "pause" : "resume";
  await jsonOrThrow(
    await request.post(`/api/companies/${companyId}/discussions/${threadId}/crew/${route}`),
    `${route} thread crew`,
  );
}

export async function getDiscussion(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
): Promise<DiscussionDetail> {
  return jsonOrThrow(
    await request.get(`/api/companies/${companyId}/discussions/${threadId}`),
    "get discussion",
  );
}

export async function waitForAgentEntry(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  agentId: string,
  label: string,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  let successfulTerminalRun: Record<string, unknown> | null = null;
  let lastEntryCount = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const detail = await getDiscussion(request, companyId, threadId);
    const entries = detail.entries ?? [];
    lastEntryCount = entries.length;
    const entry = entries.find((candidate) => candidate.authorAgentId === agentId);
    if (entry) return entry;

    const finalRun = (await listRuns(request, companyId)).find(
      (candidate) =>
        candidate.agentId === agentId &&
        JSON.stringify(candidate).includes(threadId) &&
        TERMINAL_RUN_STATUSES.has(String(candidate.status)),
    );
    if (finalRun) {
      if (!SUCCESS_RUN_STATUSES.has(String(finalRun.status))) {
        throw new Error(
          `${label} reached terminal run state without an agent entry. status=${String(
            finalRun.status,
          )} error=${String(finalRun.errorMessage ?? "")}: ${JSON.stringify(finalRun, null, 2)}`,
        );
      }
      successfulTerminalRun = finalRun;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  if (successfulTerminalRun) {
    throw new Error(
      `${label} reached successful terminal run state but no agent entry became visible before timeout. entryCount=${lastEntryCount}: ${JSON.stringify(
        successfulTerminalRun,
        null,
        2,
      )}`,
    );
  }

  throw new Error(`Timed out waiting for ${label}. entryCount=${lastEntryCount}`);
}

export async function waitForVisibleAgentEntry(
  page: Page,
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  agentId: string,
  agentName: string,
  label: string,
  timeoutMs: number,
) {
  const entry = await waitForAgentEntry(request, companyId, threadId, agentId, label, timeoutMs);
  await expectVisibleAgentEntry(page, entry, agentName);
  return entry;
}

export async function waitForAgentRunOrEntry(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  agentId: string,
  label: string,
  timeoutMs: number,
) {
  return poll(
    async () => {
      const detail = await getDiscussion(request, companyId, threadId);
      const entry = (detail.entries ?? []).find((candidate) => candidate.authorAgentId === agentId);
      if (entry) return { type: "entry", entry };
      const run = (await listRuns(request, companyId)).find(
        (candidate) =>
          candidate.agentId === agentId &&
          JSON.stringify(candidate).includes(threadId) &&
          SUCCESS_RUN_STATUSES.has(String(candidate.status)),
      );
      return run ? { type: "run", run } : null;
    },
    (value) => Boolean(value),
    label,
    timeoutMs,
  );
}

export async function assertNoAgentEntryFrom(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  agentId: string,
) {
  const detail = await getDiscussion(request, companyId, threadId);
  const entries = (detail.entries ?? []).filter((entry) => entry.authorAgentId === agentId);
  expect(entries, `unexpected entries from agent ${agentId}`).toHaveLength(0);
}

export async function assertNoIssuesCreated(request: APIRequestContext, companyId: string) {
  const issues = await jsonOrThrow<unknown[]>(
    await request.get(`/api/companies/${companyId}/issues`),
    "list issues",
  );
  expect(issues).toHaveLength(0);
}

export async function assertNoDuplicateAgentMessages(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
) {
  const detail = await getDiscussion(request, companyId, threadId);
  const messages = (detail.entries ?? [])
    .filter((entry) => entry.authorAgentId && (entry.content || entry.rawContent))
    .map((entry) => normalizeText(entry.content ?? entry.rawContent ?? ""));
  const counts = new Map<string, number>();
  for (const message of messages) counts.set(message, (counts.get(message) ?? 0) + 1);
  const duplicates = [...counts.entries()].filter(([message, count]) => message && count > 1);
  expect(duplicates, `duplicate agent messages: ${JSON.stringify(duplicates)}`).toHaveLength(0);
}

export async function assertNoAgentSelectionStartsRun(
  page: Page,
  request: APIRequestContext,
  companyPrefix: string,
  companyId: string,
) {
  const before = await listRuns(request, companyId);
  await page.goto(`/${companyPrefix}/agents/all`);
  await expect(page.getByRole("heading", { name: /Agents/i }).first()).toBeVisible({ timeout: 15_000 });
  const firstAgentLink = page.getByRole("link").filter({ hasText: /Adjutant|Scout|Planner|Engineer|Chronicler/i }).first();
  if ((await firstAgentLink.count()) === 0 || !(await firstAgentLink.isVisible())) {
    return;
  }
  await firstAgentLink.click();
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const after = await listRuns(request, companyId);
  expect(after.length, "selecting an agent should not start a run").toBe(before.length);
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
