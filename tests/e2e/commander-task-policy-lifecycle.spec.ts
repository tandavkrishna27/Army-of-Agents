import { expect, test, type APIRequestContext } from "@playwright/test";
import { jsonOrThrow } from "./helpers/real-crew";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

const PREFIX = /^E2E-CommanderLifecycle-/;

type Issue = {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  responsibleUserId: string | null;
  reviewerUserId: string | null;
  reviewerSource: string | null;
  acceptanceCriteria: string[];
  agentCompletionPolicy: "review_required" | "agent_can_complete";
  agentCompletionPolicyOverride: "review_required" | "agent_can_complete" | null;
  agentCompletionPolicySource: string;
  agentCompletionPolicySourceId: string | null;
};

async function patchAsAgent(
  request: APIRequestContext,
  issueId: string,
  token: string,
  data: Record<string, unknown>,
) {
  return request.patch(`/api/issues/${issueId}`, {
    headers: { authorization: `Bearer ${token}` },
    data,
  });
}

test.describe("Commander task completion policy lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("aoa:commander:cockpit-collapsed", "false");
      localStorage.setItem("aoa:commander:viewer-collapsed", "true");
    });
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestCompanies(request, PREFIX);
  });

  test("drives authenticated agent review and completion outcomes into Commander", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-CommanderLifecycle-${Date.now()}`);
    const team = await jsonOrThrow<{ currentUser: { userId: string } }>(
      await request.get(`/api/companies/${company.id}/team`),
      "get Commander company team",
    );
    const founderId = team.currentUser.userId;

    await jsonOrThrow(
      await request.patch(`/api/companies/${company.id}`, {
        data: {
          agentCompletionPolicyDefault: "review_required",
          agentCompletionReviewGuardrail: false,
        },
      }),
      "set review-required company policy",
    );

    const agent = await jsonOrThrow<{ id: string }>(
      await request.post(`/api/companies/${company.id}/agents`, {
        data: {
          name: "Atlas Lifecycle Agent",
          parentType: "user",
          parentId: founderId,
        },
      }),
      "create lifecycle agent",
    );
    const key = await jsonOrThrow<{ token: string }>(
      await request.post(`/api/agents/${agent.id}/keys`, {
        data: { name: "Commander lifecycle e2e" },
      }),
      "issue lifecycle agent key",
    );

    const reviewTask = await jsonOrThrow<Issue>(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "Review Atlas launch readiness evidence",
          description: "Atlas must submit this evidence to the responsible founder for review.",
          // Keep the policy-route acceptance deterministic. `todo` dispatches
          // the agent immediately and correctly moves authorization to the
          // heartbeat run's checkout token, which is a separate lifecycle.
          status: "backlog",
          priority: "high",
          assigneeAgentId: agent.id,
          responsibleUserId: founderId,
          acceptanceCriteria: [
            "Launch checklist is attached",
            "Every critical finding has an owner",
          ],
        },
      }),
      "create review-required task",
    );
    expect(reviewTask.agentCompletionPolicy).toBe("review_required");
    expect(reviewTask.agentCompletionPolicySource).toBe("company");
    expect(reviewTask.agentCompletionPolicySourceId).toBe(company.id);

    const forbiddenCompletion = await patchAsAgent(request, reviewTask.id, key.token, {
      status: "done",
    });
    expect(forbiddenCompletion.status()).toBe(422);
    await expect(forbiddenCompletion.json()).resolves.toMatchObject({
      error: expect.stringContaining("requires human review"),
    });

    const approval = await jsonOrThrow<{ id: string }>(
      await request.post(`/api/companies/${company.id}/approvals`, {
        data: {
          type: "approve_ceo_strategy",
          payload: {
            title: "Review Atlas launch readiness evidence",
            summary: "Human review path for the agent submission.",
          },
          issueIds: [reviewTask.id],
        },
      }),
      "create review path",
    );
    expect(approval.id).toBeTruthy();

    const submitted = await jsonOrThrow<Issue>(
      await patchAsAgent(request, reviewTask.id, key.token, { status: "in_review" }),
      "submit task for review as assigned agent",
    );
    expect(submitted.status).toBe("in_review");
    expect(submitted.reviewerUserId).toBe(founderId);
    expect(submitted.reviewerSource).toBe("responsible");

    const autonomousTask = await jsonOrThrow<Issue>(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "Publish verified launch inventory",
          description: "This bounded task may be completed by its assigned agent.",
          status: "backlog",
          priority: "medium",
          assigneeAgentId: agent.id,
          responsibleUserId: founderId,
          acceptanceCriteria: ["Inventory is published and linked from the launch workspace"],
          agentCompletionPolicyOverride: "agent_can_complete",
        },
      }),
      "create autonomous task",
    );
    expect(autonomousTask.agentCompletionPolicy).toBe("agent_can_complete");
    expect(autonomousTask.agentCompletionPolicySource).toBe("task");
    expect(autonomousTask.agentCompletionPolicySourceId).toBe(autonomousTask.id);

    const completed = await jsonOrThrow<Issue>(
      await patchAsAgent(request, autonomousTask.id, key.token, { status: "done" }),
      "complete autonomous task as assigned agent",
    );
    expect(completed.status).toBe("done");

    const noCriteriaTask = await jsonOrThrow<Issue>(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "Attempt unbounded autonomous completion",
          status: "backlog",
          assigneeAgentId: agent.id,
          responsibleUserId: founderId,
          agentCompletionPolicyOverride: "agent_can_complete",
        },
      }),
      "create autonomous task without criteria",
    );
    const noCriteriaCompletion = await patchAsAgent(request, noCriteriaTask.id, key.token, {
      status: "done",
    });
    expect(noCriteriaCompletion.status()).toBe(422);
    await expect(noCriteriaCompletion.json()).resolves.toMatchObject({
      error: expect.stringContaining("acceptance criterion"),
    });

    await page.goto(`/${company.issuePrefix}/commander`);
    const expandCockpit = page.getByRole("button", { name: "Expand cockpit" });
    if ((await expandCockpit.count()) === 1) await expandCockpit.click();

    const reviewCard = page.getByTestId("cockpit-card-review");
    const reviewRow = reviewCard.getByRole("button", {
      name: /Review Atlas launch readiness evidence/,
    });
    await expect(reviewRow).toBeVisible({ timeout: 15_000 });
    await expect(reviewCard.getByText("Your review")).toBeVisible();
    await reviewRow.click();

    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/commander$`));
    const taskFocus = page.getByTestId("commander-task-focus-pane");
    await expect(taskFocus).toBeVisible({ timeout: 15_000 });
    await expect(taskFocus.getByText(reviewTask.title, { exact: true })).toBeVisible();
    await expect(taskFocus.getByText("Atlas must submit this evidence")).toBeVisible();
    await expect(page.getByTestId("commander-viewer-panel")).toHaveCount(0);
  });
});
