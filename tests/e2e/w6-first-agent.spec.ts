import { test, expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import {
  cleanupTestCompanies,
  seedConfiguredCompany,
} from "./helpers/seed-company";

/**
 * w6-first-agent.spec.ts  (W6 org-reporting — Task 8a, e2e)
 *
 * Human-at-top invariant, browser-level: when a founder hires the FIRST agent in
 * a fresh company, the New Agent dialog's reports-to picker must be ENABLED (not
 * disabled) and default to the human founder — and the created agent must report
 * to that founder (parent is the human, NOT rootless / NOT a non-user principal).
 *
 * Lower layers (locally green / Linux-CI green):
 *   - Component (mock):  ui/src/components/__tests__/NewAgentDialog.firstagent.test.tsx
 *   - Caller-level integration: server/src/__tests__/w6-org-reporting.integration.test.ts
 *
 * This Playwright layer drives the real New Agent dialog + the real /org and
 * /agents endpoints. On CI Linux this is a required e2e gate; on Windows the
 * playwright config skips ALL specs (embedded-postgres can't boot on the
 * runner), so locally this only confirms the suite COLLECTS.
 *
 * Company-creation mirrors provider-switching.spec.ts / onboarding-thread-
 * pipeline.spec.ts (drives the wizard through Step 4, the step that actually
 * POSTs /companies). In local_trusted mode the synthetic local-board actor is
 * auto-authorised by the API, so no Bearer token is needed; the company's real
 * human founder is the server-seeded operator (accessService.ensureRealOperator).
 *
 * NOTE on filename: the e2e config's testMatch is `**\/*.spec.ts`, so this file
 * is named `.spec.ts` (NOT `.e2e.ts`) so Playwright actually collects + runs it
 * on Linux CI.
 */

/** The /org node shape this spec reads (subset of the UnifiedOrgNode contract). */
interface OrgNode {
  id: string;
  name: string;
  nodeType: "agent" | "user";
  userRole?: "founder" | "team_lead" | "team_member";
  children: OrgNode[];
}

function flattenOrg(nodes: OrgNode[]): OrgNode[] {
  const out: OrgNode[] = [];
  const walk = (list: OrgNode[]) => {
    for (const node of list) {
      out.push(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Resolve the company's real human founder via the /org endpoint. The org forest
 * tops out at the server-seeded operator (a `nodeType: "user"` node with
 * `userRole: "founder"`), which is exactly the human the first agent must report
 * to.
 */
async function getFounder(
  request: APIRequestContext,
  companyId: string,
): Promise<{ id: string; name: string }> {
  const res = await request.get(`/api/companies/${companyId}/org`);
  expect(res.ok()).toBe(true);
  const tree = (await res.json()) as OrgNode[];
  const humans = flattenOrg(tree).filter((n) => n.nodeType === "user");
  const founder = humans.find((n) => n.userRole === "founder") ?? humans[0];
  expect(founder, "company must have a real human founder in its org tree").toBeTruthy();
  return { id: founder!.id, name: founder!.name };
}

/** The /agents list row shape this spec reads (board actor → unredacted). */
interface AgentRow {
  id: string;
  name: string;
  parentType: "user" | "agent" | null;
  parentId: string | null;
}

async function listAgents(
  request: APIRequestContext,
  companyId: string,
): Promise<AgentRow[]> {
  const res = await request.get(`/api/companies/${companyId}/agents`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as AgentRow[] | { agents: AgentRow[] };
  return Array.isArray(body) ? body : body.agents;
}

test.describe("W6 first-agent reports-to (human-at-top)", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-W6-/);
  });

  test("first agent's reports-to picker is enabled, defaults to the founder, and the created agent reports to the founder", async ({
    page,
    request,
  }) => {
    const { companyId, issuePrefix } = await seedConfiguredCompany(request, {
      companyName: `E2E-W6-${Date.now()}`,
    });

    // The real human founder this fresh company tops out at.
    const founder = await getFounder(request, companyId);

    // Land on the Agents page and open the New Agent dialog. A fresh company has
    // zero org agents → the empty state's "Create your first agent" CTA opens the
    // same dialog as the header "New Agent" button (both call openNewAgent).
    await page.goto(`/${issuePrefix}/agents`);
    await page
      .getByRole("button", { name: /create your first agent|new agent/i })
      .first()
      .click();

    // The New Agent dialog is open. For the FIRST hire the dialog auto-fills the
    // apex name ("Director") and defaults the reports-to picker to the founder.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText("This will be the Director")).toBeVisible({
      timeout: 10_000,
    });

    // ── Reports-to picker: ENABLED + shows the founder ──
    // ReportsToSelect renders a Radix Select trigger (role=combobox). It is the
    // combobox whose displayed value resolves to the founder's name once the org
    // tree loads. We assert it is NOT disabled (the whole point of W6: the first
    // agent CAN report to the human) and that it shows the founder.
    const reportsToTrigger = dialog
      .getByRole("combobox")
      .filter({ hasText: founder.name });
    await expect(reportsToTrigger).toBeVisible({ timeout: 10_000 });
    await expect(reportsToTrigger).toBeEnabled();

    // ── Create the agent ──
    await dialog.getByRole("button", { name: /create agent/i }).click();

    // The dialog closes + navigates to the new agent on success.
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // ── Assert the created agent reports to the human founder ──
    // Poll the /agents list (board actor → unredacted parentType/parentId). The
    // first org agent must parent to the founder USER — not be rootless (null) and
    // not parent to a non-user principal.
    await expect
      .poll(
        async () => {
          const agents = await listAgents(request, companyId);
          // The first org hire is named "Director" (auto-filled apex name).
          const director = agents.find((a) => a.name === "Director");
          if (!director) return null;
          return { parentType: director.parentType, parentId: director.parentId };
        },
        { timeout: 15_000 },
      )
      .toEqual({ parentType: "user", parentId: founder.id });
  });
});
