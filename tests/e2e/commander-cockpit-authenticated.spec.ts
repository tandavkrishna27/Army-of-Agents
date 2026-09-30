import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import {
  agents,
  authUsers,
  companyMemberships,
  createDb,
  hubItems,
  instanceUserRoles,
  issues,
  projects,
  userRoles,
  workQuestions,
  type Db,
} from "../../packages/db/src/index.ts";

interface AuthenticatedActor {
  context: BrowserContext;
  userId: string;
}

interface TaskIds {
  leadOwn: string;
  memberOwn: string;
  memberManaged: string;
  productReview: string;
  operationsOnly: string;
}

let db: Db;
let companyId: string;
let issuePrefix: string;
let founder: AuthenticatedActor;
let productLead: AuthenticatedActor;
let member: AuthenticatedActor;
let operationsLead: AuthenticatedActor;
let taskIds: TaskIds;
let takeoverQuestionId: string;
let restrictedQuestionId: string;
let failedQuestionId: string;

async function signUp(browser: Browser, label: string): Promise<AuthenticatedActor> {
  const baseURL = process.env.AOA_AUTH_E2E_BASE_URL;
  if (!baseURL) throw new Error("AOA_AUTH_E2E_BASE_URL is required");
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL },
  });
  const emailLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const email = `${emailLabel}-${randomUUID()}@commander-auth.test`;
  const response = await context.request.post("/api/auth/sign-up/email", {
    data: { name: label, email, password: "Commander-E2E-Password-2026" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const sessionResponse = await context.request.get("/api/auth/get-session");
  expect(sessionResponse.ok(), await sessionResponse.text()).toBe(true);
  const session = await sessionResponse.json() as { user: { id: string } };
  return { context, userId: session.user.id };
}

async function addMember(
  actor: AuthenticatedActor,
  input: { name: string; email: string; role: "team_lead" | "team_member"; projectId: string; parentId: string },
) {
  const response = await actor.context.request.post(`/api/companies/${companyId}/team/members`, {
    data: {
      ...input,
      parentType: "user",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function actorEmail(userId: string) {
  const users = await db.select({ id: authUsers.id, email: authUsers.email }).from(authUsers);
  const exact = users.find((candidate) => candidate.id === userId);
  if (!exact) throw new Error(`Missing authenticated user ${userId}`);
  return exact.email;
}

async function taskBucket(actor: AuthenticatedActor, bucket: "mine" | "managed" | "awaiting_review") {
  const response = await actor.context.request.get(
    `/api/companies/${companyId}/cockpit/tasks?bucket=${bucket}&limit=100`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ items: Array<{ id: string; title: string }>; total: number }>;
}

test.beforeAll(async ({ browser }) => {
  const databaseUrl = process.env.AOA_AUTH_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("AOA_AUTH_E2E_DATABASE_URL is required");
  db = createDb(databaseUrl);

  founder = await signUp(browser, "Founder");
  productLead = await signUp(browser, "Product Lead");
  member = await signUp(browser, "Product Member");
  operationsLead = await signUp(browser, "Operations Lead");

  await db.insert(instanceUserRoles).values({
    userId: founder.userId,
    role: "instance_admin",
  }).onConflictDoNothing();

  const companyResponse = await founder.context.request.post("/api/companies", {
    data: { name: `Commander Auth ${randomUUID().slice(0, 8)}`, budgetMonthlyCents: 0 },
  });
  expect(companyResponse.ok(), await companyResponse.text()).toBe(true);
  const company = await companyResponse.json() as { id: string; issuePrefix: string };
  companyId = company.id;
  issuePrefix = company.issuePrefix;

  const [productDepartment, operationsDepartment] = await db.insert(projects).values([
    { companyId, name: "Product", type: "department", status: "in_progress" },
    { companyId, name: "Operations", type: "department", status: "in_progress" },
  ]).returning();

  await addMember(founder, {
    name: "Product Lead",
    email: await actorEmail(productLead.userId),
    role: "team_lead",
    projectId: productDepartment.id,
    parentId: founder.userId,
  });
  await addMember(founder, {
    name: "Product Member",
    email: await actorEmail(member.userId),
    role: "team_member",
    projectId: productDepartment.id,
    parentId: productLead.userId,
  });
  await addMember(founder, {
    name: "Operations Lead",
    email: await actorEmail(operationsLead.userId),
    role: "team_lead",
    projectId: operationsDepartment.id,
    parentId: founder.userId,
  });

  const [productAgent] = await db.insert(agents).values({
    companyId,
    name: "Product Research Agent",
    role: "research",
    kind: "org",
    status: "idle",
    adapterType: "codex_local",
    parentType: "user",
    parentId: productLead.userId,
  }).returning();

  const rows = await db.insert(issues).values([
    {
      companyId,
      projectId: productDepartment.id,
      title: "Lead planning task",
      identifier: `${issuePrefix}-101`,
      status: "todo",
      assigneeUserId: productLead.userId,
      responsibleUserId: productLead.userId,
    },
    {
      companyId,
      projectId: productDepartment.id,
      title: "Member interview preparation",
      identifier: `${issuePrefix}-102`,
      status: "todo",
      assigneeUserId: member.userId,
      responsibleUserId: member.userId,
    },
    {
      companyId,
      projectId: productDepartment.id,
      title: "Managed agent research",
      identifier: `${issuePrefix}-103`,
      status: "in_progress",
      assigneeAgentId: productAgent.id,
      responsibleUserId: null,
    },
    {
      companyId,
      projectId: productDepartment.id,
      title: "Product evidence review",
      identifier: `${issuePrefix}-104`,
      status: "in_review",
      assigneeUserId: member.userId,
      responsibleUserId: productLead.userId,
      reviewerUserId: productLead.userId,
    },
    {
      companyId,
      projectId: operationsDepartment.id,
      title: "Private operations rollout",
      identifier: `${issuePrefix}-105`,
      status: "in_progress",
      assigneeUserId: operationsLead.userId,
      responsibleUserId: operationsLead.userId,
    },
  ]).returning();
  taskIds = {
    leadOwn: rows[0].id,
    memberOwn: rows[1].id,
    memberManaged: rows[2].id,
    productReview: rows[3].id,
    operationsOnly: rows[4].id,
  };

  const questions = await db.insert(workQuestions).values([
    {
      companyId,
      issueId: taskIds.productReview,
      issueIdentifierSnapshot: `${issuePrefix}-104`,
      issueTitleSnapshot: "Product evidence review",
      primaryRecipientUserId: member.userId,
      currentRecipientUserId: member.userId,
      title: "Choose the launch evidence",
      question: "Should the review use interview depth or survey breadth?",
      status: "open",
    },
    {
      companyId,
      issueId: taskIds.leadOwn,
      issueIdentifierSnapshot: `${issuePrefix}-101`,
      issueTitleSnapshot: "Lead planning task",
      primaryRecipientUserId: productLead.userId,
      currentRecipientUserId: productLead.userId,
      title: "Restricted planning decision",
      question: "Which planning constraint should the lead choose?",
      status: "open",
    },
    {
      companyId,
      issueId: taskIds.leadOwn,
      issueIdentifierSnapshot: `${issuePrefix}-101`,
      issueTitleSnapshot: "Lead planning task",
      primaryRecipientUserId: productLead.userId,
      currentRecipientUserId: productLead.userId,
      title: "Failed continuation decision",
      question: "Retry this continuation?",
      status: "answered",
      answer: { text: "Proceed" },
      continuationStatus: "failed",
      continuationError: "Synthetic transport failure for authorization coverage",
    },
  ]).returning();
  takeoverQuestionId = questions[0].id;
  restrictedQuestionId = questions[1].id;
  failedQuestionId = questions[2].id;

  await db.insert(hubItems).values({
    companyId,
    userId: member.userId,
    type: "work_question",
    title: questions[0].title,
    message: questions[0].question,
    semanticType: "work_question",
    sourceType: "work_question",
    sourceId: questions[0].id,
    sourceUniqueKey: `${companyId}:work_question:${questions[0].id}:work_question:`,
    relatedEntityType: "task",
    relatedEntityId: taskIds.productReview,
    ownerUserId: member.userId,
    status: "open",
  });
});

test.afterAll(async () => {
  if (companyId) await founder.context.request.delete(`/api/companies/${companyId}`).catch(() => null);
  await Promise.all([founder, productLead, member, operationsLead]
    .filter(Boolean)
    .map((actor) => actor.context.close()));
});

test("[A01] founder sees company-wide managed responsibility", async () => {
  const managed = await taskBucket(founder, "managed");
  expect(managed.items.map((item) => item.id)).toEqual(expect.arrayContaining([
    taskIds.leadOwn,
    taskIds.memberOwn,
    taskIds.memberManaged,
    taskIds.operationsOnly,
  ]));
  const page = await founder.context.newPage();
  await page.goto(`/${issuePrefix}/commander`);
  await expect(
    page.getByTestId("commander-cockpit-panel").or(page.getByTestId("commander-cockpit-rail")),
  ).toBeVisible();
});

test("[A02] product lead sees own and reporting-subtree work only", async () => {
  const [mine, managed, review] = await Promise.all([
    taskBucket(productLead, "mine"),
    taskBucket(productLead, "managed"),
    taskBucket(productLead, "awaiting_review"),
  ]);
  expect(mine.items.map((item) => item.id)).toContain(taskIds.leadOwn);
  expect(managed.items.map((item) => item.id)).toContain(taskIds.memberManaged);
  expect(review.items.map((item) => item.id)).toContain(taskIds.productReview);
  expect([...mine.items, ...managed.items, ...review.items].map((item) => item.id)).not.toContain(taskIds.operationsOnly);
});

test("[A03] team member sees personal work without managed-company leakage", async () => {
  const [mine, managed] = await Promise.all([
    taskBucket(member, "mine"),
    taskBucket(member, "managed"),
  ]);
  expect(mine.items.map((item) => item.id)).toContain(taskIds.memberOwn);
  expect(managed.items).toHaveLength(0);
  expect(mine.items.map((item) => item.id)).not.toContain(taskIds.operationsOnly);
});

test("[A04] lead outside a department cannot see its task rows or counts", async () => {
  const [mine, managed, review] = await Promise.all([
    taskBucket(productLead, "mine"),
    taskBucket(productLead, "managed"),
    taskBucket(productLead, "awaiting_review"),
  ]);
  const visibleIds = [...mine.items, ...managed.items, ...review.items].map((item) => item.id);
  expect(visibleIds).not.toContain(taskIds.operationsOnly);
});

test("[A05] founder takeover and answer update the durable question and mirror", async () => {
  const takeover = await founder.context.request.post(
    `/api/companies/${companyId}/work-questions/${takeoverQuestionId}/take-over`,
    { data: { expectedVersion: 0 } },
  );
  expect(takeover.ok(), await takeover.text()).toBe(true);
  const answer = await founder.context.request.post(
    `/api/companies/${companyId}/work-questions/${takeoverQuestionId}/answer`,
    {
      data: {
        answer: { text: "Use five deep interviews." },
        expectedVersion: 1,
        idempotencyKey: `authenticated-a05-${takeoverQuestionId}`,
      },
    },
  );
  expect(answer.ok(), await answer.text()).toBe(true);

  const [question, mirror] = await Promise.all([
    db.select().from(workQuestions).then((rows) => rows.find((row) => row.id === takeoverQuestionId)),
    db.select().from(hubItems).then((rows) => rows.find((row) => (
      row.sourceType === "work_question" && row.sourceId === takeoverQuestionId
    ))),
  ]);
  expect(question).toMatchObject({
    status: "answered",
    currentRecipientUserId: founder.userId,
    answeredByUserId: founder.userId,
  });
  expect(mirror?.status).toBe("archived");
});

test("[A06] unauthorized member cannot mutate another recipient's questions", async () => {
  const attempts = await Promise.all([
    member.context.request.post(`/api/companies/${companyId}/work-questions/${restrictedQuestionId}/answer`, {
      data: { answer: { text: "Unauthorized" }, expectedVersion: 0, idempotencyKey: "a06-answer" },
    }),
    member.context.request.post(`/api/companies/${companyId}/work-questions/${restrictedQuestionId}/reassign`, {
      data: { userId: member.userId, expectedVersion: 0 },
    }),
    member.context.request.post(`/api/companies/${companyId}/work-questions/${restrictedQuestionId}/take-over`, {
      data: { expectedVersion: 0 },
    }),
    member.context.request.post(`/api/companies/${companyId}/work-questions/${failedQuestionId}/retry-continuation`, {
      data: { expectedVersion: 0 },
    }),
  ]);
  expect(attempts.map((response) => response.status())).toEqual([403, 403, 403, 403]);
});

test("[A07] awaiting-review task opens in Commander focus, not a slide-over", async () => {
  const page = await productLead.context.newPage();
  await page.goto(`/${issuePrefix}/commander`);

  const expandCockpit = page.getByRole("button", { name: "Expand cockpit" });
  if (await expandCockpit.isVisible()) await expandCockpit.click();

  const reviewTask = page.getByRole("button").filter({ hasText: "Product evidence review" });
  await expect(reviewTask).toHaveCount(1);
  await reviewTask.click();

  const taskFocus = page.getByTestId("commander-task-focus-pane");
  await expect(taskFocus).toBeVisible();
  await expect(taskFocus).toHaveAttribute("data-issue-id", taskIds.productReview);
  await expect(page).toHaveURL(new RegExp(`/${issuePrefix}/commander$`));
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Close workspace view" }).click();
  await expect(taskFocus).toHaveCount(0);
  await page.close();
});
