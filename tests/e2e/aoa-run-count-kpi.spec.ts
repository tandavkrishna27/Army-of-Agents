import { expect, test, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

/**
 * E2E smoke — Follow-up #4: AoA agent run-count KPI.
 *
 * Proves the full chain renders end-to-end against a real server + DB + the real
 * AgentHeroCard / AoaOverview components:
 *   - GET /aoa-runs returns { runs, total, limit } (not a bare array),
 *   - the hero KPI is labelled "Total runs" (not the old "Recent runs"/"50+") and
 *     renders a NUMERIC value via the real `hero-kpi-total-runs` testid,
 *   - the Overview "Total runs" stat shows the SAME number.
 *
 * LIMITATION (documented honestly): runs cannot be seeded via any public API —
 * internal_agent_runs is only written by internal service code paths (Commander /
 * crew runs), and no e2e helper seeds one. So a freshly-seeded company's AoA crew
 * agent has 0 runs and the asserted value is "0". This proves the response-shape
 * change + relabel render correctly; the "count beyond the page cap (50)"
 * correctness is proven by the server unit test (aoa-runs-total.test.ts), NOT here.
 *
 * Windows self-skips: playwright.config.ts restricts testMatch to the
 * windows-embedded-postgres-skip spec on the embedded-postgres Windows runner
 * (Issue #114). This runs on the required Linux gate + advisory macOS lane.
 */

async function firstAoaAgent(
  request: APIRequestContext,
  companyId: string,
): Promise<{ id: string; name: string }> {
  const res = await request.get(`/api/companies/${companyId}/agents?kind=aoa`);
  expect(res.ok(), await res.text()).toBe(true);
  const agents = (await res.json()) as Array<{ id: string; name: string }>;
  expect(agents.length, "company auto-provisions an AoA crew on create").toBeGreaterThan(0);
  return agents[0];
}

test.describe("AoA run-count KPI", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-RunCount-/);
  });

  test("hero KPI and Overview stat render a numeric 'Total runs' (not '50+')", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-RunCount-${Date.now()}`);
    const agent = await firstAoaAgent(request, company.id);

    await page.goto(`/${company.issuePrefix}/team/aoa/${agent.id}`);

    // Hero KPI: real AgentHeroCard testid is `hero-kpi-<key>`; after the relabel
    // the key is `total-runs`. Assert the label says "Total runs" and the value is
    // a number (a freshly-seeded crew agent has 0 runs) — NOT the literal "50+".
    const heroKpi = page.getByTestId("hero-kpi-total-runs");
    await expect(heroKpi).toBeVisible({ timeout: 15_000 });
    await expect(heroKpi).toContainText("Total runs");
    await expect(heroKpi).toContainText("0");
    await expect(heroKpi).not.toContainText("50+");
    // The old label must be gone (relabel proof).
    await expect(page.getByTestId("hero-kpi-recent-runs")).toHaveCount(0);

    // Overview "Total runs" stat — assert via a dedicated testid (added to the
    // stat value span in Task 4). The hero KPI ALSO says "Total runs" now, so a
    // label-text locator would match the hero, not Overview, and the assertion
    // would pass without proving Overview at all (Codex P1).
    const overviewStat = page.getByTestId("aoa-overview-total-runs");
    await expect(overviewStat).toBeVisible({ timeout: 10_000 });
    await expect(overviewStat).toHaveText("0");

    // Sanity: no crash / error boundary on the page.
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  });
});
