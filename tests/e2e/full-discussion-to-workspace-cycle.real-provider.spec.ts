import { expect, test, type APIRequestContext, type APIResponse, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

type Company = { id: string; name: string; issuePrefix: string };
type AgentConfig = {
  id: string;
  name: string;
  kind?: string | null;
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
  runtimeConfig?: Record<string, unknown> | null;
};
type DiscussionDetail = {
  id: string;
  title: string;
  phase?: string | null;
  autonomyLevel?: number | null;
  summaryText?: string | null;
  summaryNext?: string | null;
  entries?: Array<{
    id: string;
    type?: string | null;
    inputType?: string | null;
    rawContent?: string | null;
    content?: string | null;
    authorAgentId?: string | null;
    authorName?: string | null;
    agentName?: string | null;
  }>;
};
type ScopeVersionDetail = {
  id: string;
  versionNumber: number;
  status: string;
  summary: string;
  items: Array<{
    id: string;
    kind: string;
    title: string;
    description?: string | null;
    status?: string | null;
    payload?: Record<string, unknown>;
  }>;
};

const RUN_REAL_PROVIDER = process.env.AOA_E2E_REAL_PROVIDER === "1";
const REAL_PROVIDER = process.env.AOA_E2E_REAL_CREW_PROVIDER ?? "openai";
const REAL_ADAPTER_TYPE =
  REAL_PROVIDER === "anthropic" ? "claude_local" : REAL_PROVIDER === "openai" ? "codex_local" : "gemini_local";
const REAL_BINARY = REAL_PROVIDER === "anthropic" ? "claude" : REAL_PROVIDER === "openai" ? "codex" : "gemini";
const REAL_MODEL =
  process.env.AOA_E2E_REAL_CREW_MODEL ??
  (REAL_PROVIDER === "anthropic" ? "claude-sonnet-4-5-20250929" : REAL_PROVIDER === "openai" ? "gpt-5.5" : "gemini-2.5-pro");
const REAL_TIMEOUT_MS = Number(process.env.AOA_E2E_REAL_CREW_TIMEOUT_MS ?? 300_000);
const TERMINAL_RUN_STATUSES = new Set(["completed", "succeeded", "failed", "cancelled", "timed_out"]);
const SUCCESS_RUN_STATUSES = new Set(["completed", "succeeded"]);

test.describe("full discussion real-provider soak", () => {
  test.setTimeout(REAL_TIMEOUT_MS + 180_000);

  test.skip(
    !RUN_REAL_PROVIDER,
    "Set AOA_E2E_REAL_PROVIDER=1 with configured Codex/Claude CLI credentials to run this watched soak.",
  );

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Real-Crew-/);
  });

  test("drives a fresh discussion through real crew summary, autonomy, and scope", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(!cliAvailable(REAL_BINARY), `${REAL_BINARY} CLI not found on PATH`);
    expect(process.env.AOA_E2E_FAKE_CREW_LLM, "real-provider soak must not run with fake crew LLM").not.toBe("1");

    const diagnostics: Record<string, unknown> = {
      provider: REAL_PROVIDER,
      adapterType: REAL_ADAPTER_TYPE,
      model: REAL_MODEL,
      startedAt: new Date().toISOString(),
    };
    let company: Company | null = null;
    let threadId: string | null = null;

    try {
      company = await seedCompany(request, `E2E-Real-Crew-${REAL_PROVIDER}-${Date.now()}`);
      diagnostics.company = company;
      await configureCompanyProvider(request, company.id, 0);
      const crew = await ensureCrewAdapterConfig(request, company.id);
      const crewByName = new Map(crew.map((agent) => [agent.name.toLowerCase(), agent]));
      diagnostics.crew = crew.map((agent) => ({
        id: agent.id,
        name: agent.name,
        adapterType: agent.adapterType,
      }));

      await page.goto(`/${company.issuePrefix}/discussions`);
      await expect(page.getByRole("heading", { name: /Discussions/i }).first()).toBeVisible({ timeout: 15_000 });

      const threadTitle = `Real crew scope ${Date.now()}`;
      await createThreadFromUi(
        page,
        threadTitle,
        "We are planning a small founder workflow: collect messy discussion, produce one implementation task, and save one durable memory about the decision rule.",
      );
      threadId = page.url().match(/\/discussions\/([^/?#]+)/)?.[1] ?? null;
      expect(threadId).toBeTruthy();
      diagnostics.threadUrl = `/${company.issuePrefix}/discussions/${threadId}`;

      await patchThreadAutonomy(request, company.id, threadId!, 0);
      await sendThreadMessage(
        page,
        "@Adjutant please reply briefly with what you think should happen next. Do not create tasks yet.",
      );
      await waitForAnyAgentEvidence(
        page,
        request,
        company.id,
        threadId!,
        [requiredCrewId(crewByName, "adjutant")],
        "Adjutant",
        "manual Adjutant response",
      );
      await assertNoIssuesCreated(request, company.id);
      await assertNoDuplicateAgentMessages(request, company.id, threadId!);

      await patchThreadAutonomy(request, company.id, threadId!, 1);
      await sendThreadMessage(
        page,
        "@Scout validate the user need, constraints, and evidence from the whole conversation before we scope it.",
      );
      await waitForAnyAgentEvidence(
        page,
        request,
        company.id,
        threadId!,
        [requiredCrewId(crewByName, "scout")],
        "Scout",
        "assist Scout response",
      );
      await assertNoIssuesCreated(request, company.id);
      await assertNoDuplicateAgentMessages(request, company.id, threadId!);

      await waitForSummaryOrFail(request, page, company.id, threadId!, testInfo);

      await sendThreadMessage(
        page,
        "Now please scope this discussion into exactly one task proposal and one memory candidate. Use all messages above, not just this latest line.",
      );
      const scopeSignalOrRun = await waitForScopeSignalOrAdjutantRun(request, company.id, threadId!);
      diagnostics.scopeSignalOrRun = scopeSignalOrRun;

      await page.getByTestId("center-tab-scope").click();
      await page.getByRole("button", { name: /^create scope draft$/i }).click();
      await expect(page.getByTestId("scope-version-package")).toBeVisible({ timeout: 30_000 });

      const scope = await latestScopeVersionDetail(request, company.id, threadId!);
      diagnostics.scope = {
        id: scope.id,
        versionNumber: scope.versionNumber,
        status: scope.status,
        summary: scope.summary,
        items: scope.items.map((item) => ({ kind: item.kind, title: item.title, status: item.status })),
      };

      expect(scope.summary).toMatch(/founder|workflow|discussion|decision|memory|task/i);
      expect(scope.items.some((item) => item.kind === "task_proposal")).toBe(true);
      expect(scope.items.some((item) => item.kind === "memory_candidate")).toBe(true);
      expect(scope.items.length).toBeGreaterThanOrEqual(2);
      await assertNoDuplicateAgentMessages(request, company.id, threadId!);
    } finally {
      if (company && threadId) {
        await attachDiagnostics(testInfo, request, company.id, threadId, diagnostics);
        await page.screenshot({
          path: testInfo.outputPath("real-provider-thread-final.png"),
          fullPage: true,
        }).catch(() => undefined);
      }
    }
  });
});

async function configureCompanyProvider(request: APIRequestContext, companyId: string, autonomyLevel: number) {
  await jsonOrThrow(
    await request.patch(`/api/companies/${companyId}/internal-agent/config`, {
      data: {
        provider: REAL_PROVIDER,
        model: REAL_MODEL,
        // D18: the crew dial, not Commander's.
        crewAutonomyLevel: autonomyLevel,
        crewPaused: false,
      },
    }),
    "configure real provider",
  );
}

async function ensureCrewAdapterConfig(request: APIRequestContext, companyId: string): Promise<AgentConfig[]> {
  const targetNames = ["Adjutant", "Chronicler", "Scout", "Engineer", "Reviewer", "Planner"];
  const crew = await waitForCrewAgents(request, companyId, targetNames);
  for (const agent of crew) {
    const existing = agent.adapterConfig ?? {};
    const nextConfig: Record<string, unknown> = {
      model: REAL_MODEL,
      ...(REAL_PROVIDER === "anthropic"
        ? { dangerouslySkipPermissions: true }
        : REAL_PROVIDER === "openai"
          ? { dangerouslyBypassApprovalsAndSandbox: true }
          : {}),
      ...(typeof existing.instructionsFilePath === "string" ? { instructionsFilePath: existing.instructionsFilePath } : {}),
      ...(typeof existing.instructionsRootPath === "string" ? { instructionsRootPath: existing.instructionsRootPath } : {}),
      ...(typeof existing.instructionsEntryFile === "string" ? { instructionsEntryFile: existing.instructionsEntryFile } : {}),
      ...(typeof existing.instructionsBundleMode === "string" ? { instructionsBundleMode: existing.instructionsBundleMode } : {}),
    };
    if (agent.adapterType !== REAL_ADAPTER_TYPE || JSON.stringify(agent.adapterConfig ?? {}) !== JSON.stringify(nextConfig)) {
      await jsonOrThrow(
        await request.patch(`/api/agents/${agent.id}`, {
          data: {
            adapterType: REAL_ADAPTER_TYPE,
            adapterConfig: nextConfig,
          },
        }),
        `patch ${agent.name} real provider adapter`,
      );
    }
  }
  return waitForCrewAgents(request, companyId, targetNames);
}

async function waitForCrewAgents(
  request: APIRequestContext,
  companyId: string,
  targetNames: string[],
): Promise<AgentConfig[]> {
  return poll(
    async () => {
      const agents = await jsonOrThrow<AgentConfig[]>(
        await request.get(`/api/companies/${companyId}/agents?kind=aoa`),
        "list AoA agents",
      );
      const matched = agents.filter((agent) =>
        targetNames.some((name) => agent.name.toLowerCase().includes(name.toLowerCase())),
      );
      return matched.length >= 3 ? matched : null;
    },
    (agents): agents is AgentConfig[] => Array.isArray(agents) && agents.length >= 3,
    "seeded AoA crew agents",
    30_000,
  );
}

async function createThreadFromUi(page: Page, title: string, firstMessage: string) {
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
}

async function sendThreadMessage(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId("entry-composer-textarea");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill(text);
  await page.getByTestId("entry-composer-submit").click();
  await expect(page.locator('[data-testid^="entry-row-"]').filter({ hasText: text }).first()).toBeVisible({
    timeout: 15_000,
  });
}

async function patchThreadAutonomy(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  autonomyLevel: number,
) {
  await configureCompanyProvider(request, companyId, autonomyLevel);
  await jsonOrThrow(
    await request.patch(`/api/companies/${companyId}/discussions/${threadId}`, {
      data: { autonomyLevel },
    }),
    "set thread autonomy",
  );
}

async function waitForAnyAgentEvidence(
  page: Page,
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  agentIds: string[],
  agentName: string,
  label: string,
) {
  const targetIds = new Set(agentIds);
  return poll(
    async () => {
      const detail = await getDiscussion(request, companyId, threadId);
      const entry = (detail.entries ?? []).find((candidate) => {
        return Boolean(candidate.authorAgentId && targetIds.has(candidate.authorAgentId));
      });
      if (entry) {
        const body = entry.rawContent ?? entry.content ?? "";
        expect(body.trim().length, `${label} should have real content`).toBeGreaterThan(20);
        const row = page.locator(`[data-testid="entry-row-${entry.id}"]`);
        await expect(row).toBeVisible({ timeout: 15_000 });
        await expect(row).toHaveAttribute("data-entry-type", "agent");
        await expect(row).toContainText(agentName);
        return { type: "entry", entry };
      }
      const runs = await listRuns(request, companyId);
      const terminalRun = runs.find((candidate) => {
        const serialized = JSON.stringify(candidate);
        return (
          typeof candidate.agentId === "string" &&
          targetIds.has(candidate.agentId) &&
          serialized.includes(threadId) &&
          TERMINAL_RUN_STATUSES.has(String(candidate.status))
        );
      });
      if (terminalRun) {
        throw new Error(
          `${label} reached terminal run state without a visible agent entry. status=${String(
            terminalRun.status,
          )} error=${String(terminalRun.errorMessage ?? "")}: ${JSON.stringify(terminalRun, null, 2)}`,
        );
      }
      return null;
    },
    (value) => Boolean(value),
    label,
    REAL_TIMEOUT_MS,
  );
}

function requiredCrewId(crewByName: Map<string, AgentConfig>, name: string): string {
  const agent = crewByName.get(name);
  if (!agent) throw new Error(`Missing required AoA crew agent: ${name}`);
  return agent.id;
}

async function waitForSummaryOrFail(
  request: APIRequestContext,
  page: Page,
  companyId: string,
  threadId: string,
  testInfo: TestInfo,
) {
  const summary = await poll(
    async () => {
      const detail = await getDiscussion(request, companyId, threadId);
      if (detail.summaryText?.trim()) return detail.summaryText;
      return null;
    },
    (value): value is string => typeof value === "string" && value.trim().length > 0,
    "Chronicler conversation summary",
    REAL_TIMEOUT_MS,
  ).catch(async (err) => {
    const runs = await listRuns(request, companyId);
    const chroniclerRuns = runs.filter((run) => JSON.stringify(run).toLowerCase().includes("chronicler"));
    await testInfo.attach("real-provider-summary-failure.json", {
      body: JSON.stringify({ error: String(err), chroniclerRuns }, null, 2),
      contentType: "application/json",
    });
    throw err;
  });
  expect(summary).toBeTruthy();
  expect(summary.trim().length, "summary should be substantive").toBeGreaterThan(80);
  expect(summary).toMatch(/decision|task|memory|workflow|founder|scope/i);
}

async function waitForScopeSignalOrAdjutantRun(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
) {
  return poll(
    async () => {
      const runs = await listRuns(request, companyId);
      const adjutant = runs.find((run) => {
        const haystack = JSON.stringify(run).toLowerCase();
        return haystack.includes("adjutant") && haystack.includes(threadId) && TERMINAL_RUN_STATUSES.has(String(run.status));
      });
      if (adjutant) {
        if (!SUCCESS_RUN_STATUSES.has(String(adjutant.status))) {
          throw new Error(
            `Adjutant reached failed terminal state before a scope signal existed. status=${String(
              adjutant.status,
            )} error=${String(adjutant.errorMessage ?? "")}: ${JSON.stringify(adjutant, null, 2)}`,
          );
        }
        const scope = await listScopeVersions(request, companyId, threadId).catch(() => ({ versions: [] }));
        if (scope.versions.length > 0) return { type: "scope_version", scope };
        return { type: "adjutant_run", run: adjutant };
      }
      return null;
    },
    (value) => Boolean(value),
    "scope proposal or Adjutant run",
    REAL_TIMEOUT_MS,
  );
}

async function latestScopeVersionDetail(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
): Promise<ScopeVersionDetail> {
  const versions = await listScopeVersions(request, companyId, threadId);
  const latest = versions.versions[0];
  expect(latest).toBeTruthy();
  return jsonOrThrow(
    await request.get(`/api/companies/${companyId}/discussions/${threadId}/scope-versions/${latest.id}`),
    "get latest scope version",
  );
}

async function listScopeVersions(request: APIRequestContext, companyId: string, threadId: string) {
  return jsonOrThrow<{ versions: Array<{ id: string; versionNumber: number; status: string }> }>(
    await request.get(`/api/companies/${companyId}/discussions/${threadId}/scope-versions`),
    "list scope versions",
  );
}

async function assertNoIssuesCreated(request: APIRequestContext, companyId: string) {
  const issues = await jsonOrThrow<unknown[]>(
    await request.get(`/api/companies/${companyId}/issues`),
    "list issues",
  );
  expect(issues.length).toBe(0);
}

async function assertNoDuplicateAgentMessages(request: APIRequestContext, companyId: string, threadId: string) {
  const detail = await getDiscussion(request, companyId, threadId);
  const agentMessages = (detail.entries ?? [])
    .filter((entry) => entry.authorAgentId && entry.content)
    .map((entry) => normalizeText(entry.content!));
  const counts = new Map<string, number>();
  for (const message of agentMessages) counts.set(message, (counts.get(message) ?? 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  expect(duplicates, `duplicate agent messages: ${JSON.stringify(duplicates)}`).toHaveLength(0);
}

async function attachDiagnostics(
  testInfo: TestInfo,
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  diagnostics: Record<string, unknown>,
) {
  const [discussion, scopeVersions, runs, agents, issues] = await Promise.all([
    getDiscussion(request, companyId, threadId).catch((error) => ({ error: String(error) })),
    listScopeVersions(request, companyId, threadId).catch((error) => ({ error: String(error) })),
    listRuns(request, companyId).catch((error) => ({ error: String(error) })),
    jsonOrThrow<AgentConfig[]>(
      await request.get(`/api/companies/${companyId}/agents?kind=aoa`),
      "list diagnostics AoA agents",
    ).catch((error) => [{ id: "error", name: String(error) } as AgentConfig]),
    jsonOrThrow<unknown[]>(await request.get(`/api/companies/${companyId}/issues`), "list diagnostics issues").catch(
      (error) => [{ error: String(error) }],
    ),
  ]);
  await testInfo.attach("real-provider-diagnostics.json", {
    body: JSON.stringify(
      {
        ...diagnostics,
        finishedAt: new Date().toISOString(),
        discussion,
        scopeVersions,
        runs,
        agents,
        issues,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
}

async function getDiscussion(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
): Promise<DiscussionDetail> {
  return jsonOrThrow(
    await request.get(`/api/companies/${companyId}/discussions/${threadId}`),
    "get discussion",
  );
}

async function listRuns(request: APIRequestContext, companyId: string) {
  const body = await jsonOrThrow<{ runs: Array<Record<string, unknown>> }>(
    await request.get(`/api/companies/${companyId}/internal-agent/runs?limit=100`),
    "list internal agent runs",
  );
  return body.runs;
}

function cliAvailable(binary: string): boolean {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(locator, [binary], { encoding: "utf8", timeout: 5_000 }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function jsonOrThrow<T = unknown>(res: APIResponse, label: string): Promise<T> {
  if (!res.ok()) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`${label} failed: ${res.status()} ${text}`);
  }
  return (await res.json()) as T;
}

async function poll<T, S extends T>(
  fn: () => Promise<T>,
  predicate: (value: T) => value is S,
  label: string,
  timeoutMs: number,
): Promise<S>;
async function poll<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs: number,
): Promise<T>;
async function poll<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  let lastValue: T | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await fn();
    if (predicate(lastValue)) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}
