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
 * stale-token ref).
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
