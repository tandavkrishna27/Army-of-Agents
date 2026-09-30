/**
 * E2E: Crew Board shows a task that was assigned to a crew agent via a scope draft.
 *
 * Proves the user-visible outcome of W1a — "controller scope draft + apply →
 * assigned task appears on the Crew Board" — without any LLM calls.
 *
 * Seed approach (mirrors team-aoa-tasks-crew-board.spec.ts):
 *   1. seedCompany() → company + issuePrefix
 *   2. GET /api/companies/:id/agents?kind=aoa → find the seeded Engineer
 *   3. POST /api/companies/:id/discussions → create a discussion
 *   4. POST .../scope-versions/draft → create a scope draft (mode=generate produces
 *      a placeholder task_proposal via the compiler's legacy path — that's fine,
 *      we immediately PATCH the item to set assigneeAgentId before creating the task)
 *   5. GET .../scope-versions/:vid → find the task_proposal item
 *   6. PATCH .../scope-versions/:vid/items/:iid → set title + payload.assigneeAgentId
 *   7. POST .../scope-versions/:vid/items/:iid/create → materialise the assigned task
 *   8. Navigate to /${prefix}/team?tab=aoa&aoaTab=tasks → assert card + Engineer name
 *
 * Windows + embedded-postgres: skipped at playwright-config level (Issue #114).
 * Linux CI is the gate. No extra guard needed here.
 *
 * AOA_E2E_FAKE_EMBEDDER=1 is set globally in playwright.config.ts — no LLM key needed.
 */

import { expect, test } from "@playwright/test";
import { jsonOrThrow } from "./helpers/real-crew";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

type ScopeVersionDetail = {
  id: string;
  items: Array<{
    id: string;
    kind: string;
    payload?: Record<string, unknown>;
  }>;
};

test.describe("Team AoA Tasks — crew assignment via scope draft", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-W1a-Assign-/);
  });

  test(
    "crew task from an applied scope draft appears ASSIGNED on the Crew Board",
    async ({ page, request }) => {
      // ── 1. Create company (AoA crew auto-seeded by onboard) ────────────────
      const company = await seedCompany(request, `E2E-W1a-Assign-${Date.now()}`);

      // ── 2. Find the seeded Engineer crew agent ──────────────────────────────
      const agents = await jsonOrThrow<Array<{ id: string; name: string }>>(
        await request.get(`/api/companies/${company.id}/agents?kind=aoa`),
        "list AoA agents",
      );
      const engineer = agents.find((a) => /engineer/i.test(a.name));
      expect(engineer, "seeded AoA Engineer").toBeTruthy();

      // ── 3. Create a discussion ──────────────────────────────────────────────
      const discussion = await jsonOrThrow<{ id: string }>(
        await request.post(`/api/companies/${company.id}/discussions`, {
          data: {
            title: "W1a crew assignment source",
            entry: {
              inputType: "write",
              rawContent: "Implement the token endpoint for the auth rewrite.",
            },
          },
        }),
        "create source discussion",
      );

      // ── 4. Create a scope draft (compiler produces a placeholder task_proposal) ─
      const draft = await jsonOrThrow<{ version?: { id: string } }>(
        await request.post(
          `/api/companies/${company.id}/discussions/${discussion.id}/scope-versions/draft`,
          {
            data: {
              mode: "generate",
              summary: "Build token endpoint and add refresh rotation.",
            },
          },
        ),
        "create scope draft",
      );
      expect(draft.version?.id, "scope draft version").toBeTruthy();

      // ── 5. Get the draft detail + find the task_proposal item ──────────────
      const scope = await jsonOrThrow<ScopeVersionDetail>(
        await request.get(
          `/api/companies/${company.id}/discussions/${discussion.id}/scope-versions/${draft.version!.id}`,
        ),
        "get scope draft",
      );
      const taskItem = scope.items.find((item) => item.kind === "task_proposal");
      expect(taskItem, "scope draft task proposal").toBeTruthy();

      // ── 6. PATCH the item: set title + assign to Engineer ──────────────────
      const taskTitle = "Build token endpoint — W1a E2E";
      const patchResponse = await request.patch(
        `/api/companies/${company.id}/discussions/${discussion.id}/scope-versions/${scope.id}/items/${taskItem!.id}`,
        {
          data: {
            title: taskTitle,
            description: "Token endpoint implementation assigned to the crew Engineer.",
            payload: {
              ...(taskItem!.payload ?? {}),
              priority: "medium",
              assigneeAgentId: engineer!.id,
            },
          },
        },
      );
      expect(patchResponse.ok(), await patchResponse.text()).toBe(true);

      // ── 7. Create the task from the scope item (per-item endpoint) ──────────
      const created = await jsonOrThrow<{
        createdTask?: {
          id: string;
          assigneeAgentId?: string | null;
          sourceDiscussionId?: string | null;
        };
      }>(
        await request.post(
          `/api/companies/${company.id}/discussions/${discussion.id}/scope-versions/${scope.id}/items/${taskItem!.id}/create`,
        ),
        "create task from scope item",
      );
      expect(created.createdTask?.assigneeAgentId).toBe(engineer!.id);
      expect(created.createdTask?.sourceDiscussionId).toBe(discussion.id);

      // Sanity: task appears in the crew-scoped issue list
      const crewIssues = await jsonOrThrow<Array<{ id: string; assigneeAgentId?: string | null }>>(
        await request.get(`/api/companies/${company.id}/issues?taskScope=crew`),
        "list crew-scoped issues",
      );
      expect(
        crewIssues.some(
          (issue) => issue.id === created.createdTask!.id && issue.assigneeAgentId === engineer!.id,
        ),
      ).toBe(true);

      // ── 8. Navigate to Crew Board and assert the card + Engineer name ───────
      await page.goto(`/${company.issuePrefix}/team?tab=aoa&aoaTab=tasks`);
      await expect(page.getByTestId("aoa-header-subtab-tasks")).toHaveAttribute(
        "data-active",
        "true",
      );
      await expect(page.getByTestId("crew-board")).toBeVisible({ timeout: 15_000 });

      // The task card must be visible on the board
      await expect(page.getByText(taskTitle)).toBeVisible({ timeout: 15_000 });

      // The assigned crew agent's name must appear on the card. CardMetaRow renders
      // ownerAgentName in a dedicated span (testid kanban-card-owner-name); assert on
      // that specifically — a bare getByText("Engineer") is a strict-mode violation
      // because the card also carries the name via the avatar title and the standard
      // footer's Identity label.
      const card = page.getByTestId(`kanban-card-${created.createdTask!.id}`);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.getByTestId("kanban-card-owner-name")).toHaveText(engineer!.name, {
        timeout: 15_000,
      });
    },
  );
});
