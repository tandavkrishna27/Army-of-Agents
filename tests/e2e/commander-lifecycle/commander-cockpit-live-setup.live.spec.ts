import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  actorStoragePath,
  campaignId,
  campaignRoot,
  loadState,
  jsonOrThrow,
  saveState,
  signUpActor,
  writeCheckpoint,
  type CampaignState,
  statePath,
} from "./campaign.js";

test("@commander-lifecycle creates the authenticated causal company through public product APIs", async ({ browser }) => {
  const baseUrl = process.env.AOA_COMMANDER_LIFECYCLE_BASE_URL;
  const bootstrapToken = process.env.AOA_COMMANDER_LIFECYCLE_BOOTSTRAP_TOKEN;
  if (!baseUrl || !bootstrapToken) throw new Error("Lifecycle base URL and bootstrap token are required");

  if (await readFile(statePath(), "utf8").then(() => true).catch(() => false)) {
    const existing = await loadState();
    const context = await browser.newContext({
      baseURL: existing.baseUrl,
      storageState: existing.actors.founder.storageStatePath,
      extraHTTPHeaders: { Origin: existing.baseUrl },
    });
    try {
      const response = await context.request.get(`/api/companies/${existing.company.id}`);
      expect(response.ok(), await response.text()).toBe(true);
      return;
    } finally {
      await context.close();
    }
  }

  const founder = await signUpActor(browser, baseUrl, "Lifecycle Founder");
  const lead = await signUpActor(browser, baseUrl, "Lifecycle Product Lead");
  const member = await signUpActor(browser, baseUrl, "Lifecycle Research Member");
  try {
    const accepted = await jsonOrThrow<{ bootstrapAccepted: boolean }>(
      await founder.context.request.post(`/api/invites/${bootstrapToken}/accept`, {
        data: { requestType: "human" },
      }),
      "accept bootstrap CEO invite",
    );
    expect(accepted.bootstrapAccepted).toBe(true);

    const company = await jsonOrThrow<{ id: string; name: string; issuePrefix: string }>(
      await founder.context.request.post("/api/companies", {
        data: {
          name: `Commander Lifecycle ${campaignId()}`,
          description: "Fresh causal company for R01-R14 and Q1-Q5 release qualification.",
          budgetMonthlyCents: 0,
        },
      }),
      "create lifecycle company",
    );
    await jsonOrThrow(
      await founder.context.request.patch(`/api/companies/${company.id}`, {
        data: {
          agentCompletionPolicyDefault: "review_required",
          agentCompletionReviewGuardrail: false,
          humanQuestionSlaHours: 24,
        },
      }),
      "set lifecycle company policy",
    );

    const productDepartment = await jsonOrThrow<{ id: string }>(
      await founder.context.request.post(`/api/companies/${company.id}/projects`, {
        data: { name: "Product", type: "department", status: "in_progress", functionType: "product" },
      }),
      "create Product department",
    );
    const engineeringDepartment = await jsonOrThrow<{ id: string }>(
      await founder.context.request.post(`/api/companies/${company.id}/projects`, {
        data: { name: "Engineering", type: "department", status: "in_progress", functionType: "software_development" },
      }),
      "create Engineering department",
    );

    await jsonOrThrow(
      await founder.context.request.post(`/api/companies/${company.id}/team/members`, {
        data: {
          name: "Lifecycle Product Lead",
          email: lead.email,
          role: "team_lead",
          projectId: productDepartment.id,
          parentType: "user",
          parentId: founder.userId,
        },
      }),
      "add Product lead",
    );
    await jsonOrThrow(
      await founder.context.request.post(`/api/companies/${company.id}/team/members`, {
        data: {
          name: "Lifecycle Research Member",
          email: member.email,
          role: "team_member",
          projectId: productDepartment.id,
          parentType: "user",
          parentId: lead.userId,
        },
      }),
      "add Research member",
    );

    const workspaceRoot = resolve(campaignRoot(), "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(resolve(workspaceRoot, "README.md"), "# Commander lifecycle evidence workspace\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: workspaceRoot, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "commander-lifecycle@aoa.test"], { cwd: workspaceRoot });
    execFileSync("git", ["config", "user.name", "Commander Lifecycle"], { cwd: workspaceRoot });
    execFileSync("git", ["add", "README.md"], { cwd: workspaceRoot });
    execFileSync("git", ["commit", "-m", "initialize lifecycle workspace"], { cwd: workspaceRoot, stdio: "pipe" });

    const customerValidation = await jsonOrThrow<{ id: string }>(
      await founder.context.request.post(`/api/companies/${company.id}/projects`, {
        data: {
          name: "Customer Validation",
          type: "project",
          status: "in_progress",
          functionType: "product",
          agentCompletionPolicyDefault: "review_required",
          humanQuestionSlaHours: 24,
          executionWorkspacePolicy: {
            enabled: true,
            defaultMode: "shared_workspace",
            allowIssueOverride: true,
            workspaceStrategy: { type: "project_primary" },
          },
          workspace: {
            name: "Lifecycle evidence workspace",
            cwd: workspaceRoot,
            repoRef: "main",
            isPrimary: true,
          },
        },
      }),
      "create Customer Validation project",
    );

    const goal = await jsonOrThrow<{ id: string }>(
      await founder.context.request.post(`/api/companies/${company.id}/goals`, {
        data: {
          title: "Validate founder workflow demand",
          description: "Generate answer-specific customer validation evidence.",
          level: "team",
          status: "active",
          projectIds: [customerValidation.id],
        },
      }),
      "create customer-validation objective",
    );
    const discussion = await jsonOrThrow<{ id: string }>(
      await founder.context.request.post(`/api/companies/${company.id}/discussions`, {
        data: {
          title: "Boutique agency customer validation",
          scopeType: "project",
          scopeId: customerValidation.id,
          tags: ["commander-lifecycle", "customer-validation"],
          entry: {
            inputType: "write",
            rawContent: "Plan a focused boutique-agency validation campaign. Every recommendation must preserve its source task, human decision, and evidence artifact.",
            projectId: customerValidation.id,
            goalId: goal.id,
          },
        },
      }),
      "create source Discussion",
    );

    const claude = await jsonOrThrow<{ id: string; name: string }>(
      await founder.context.request.post(`/api/companies/${company.id}/agents`, {
        data: {
          name: "Claude Product Analyst",
          role: "general",
          title: "Product Analyst",
          parentType: "user",
          parentId: lead.userId,
          adapterType: "claude_local",
          adapterConfig: { model: "claude-sonnet-4-5-20250929", dangerouslySkipPermissions: true },
          runtimeConfig: { injectCompanyContext: true, contextMode: "standard", autoRunSummary: true },
        },
      }),
      "create Claude Product Analyst",
    );
    const codex = await jsonOrThrow<{ id: string; name: string }>(
      await founder.context.request.post(`/api/companies/${company.id}/agents`, {
        data: {
          name: "Codex Launch Engineer",
          role: "general",
          title: "Launch Engineer",
          parentType: "user",
          parentId: lead.userId,
          adapterType: "codex_local",
          adapterConfig: { model: "gpt-5.5", dangerouslyBypassApprovalsAndSandbox: true },
          runtimeConfig: { injectCompanyContext: true, contextMode: "standard", autoRunSummary: true },
        },
      }),
      "create Codex Launch Engineer",
    );

    await Promise.all([
      founder.context.request.post(`/api/projects/${customerValidation.id}/agents?companyId=${company.id}`, { data: { agentId: claude.id } }),
      founder.context.request.post(`/api/projects/${customerValidation.id}/agents?companyId=${company.id}`, { data: { agentId: codex.id } }),
    ]).then(async (responses) => {
      for (const [index, response] of responses.entries()) {
        await jsonOrThrow(response, `assign ${index === 0 ? "Claude" : "Codex"} to project`);
      }
    });

    await mkdir(resolve(campaignRoot(), "auth"), { recursive: true });
    await founder.context.storageState({ path: actorStoragePath("founder") });
    await lead.context.storageState({ path: actorStoragePath("lead") });
    await member.context.storageState({ path: actorStoragePath("member") });

    const state: CampaignState = {
      version: 1,
      campaignId: campaignId(),
      baseUrl,
      startedAt: new Date().toISOString(),
      company,
      actors: {
        founder: { userId: founder.userId, email: founder.email, storageStatePath: actorStoragePath("founder") },
        lead: { userId: lead.userId, email: lead.email, storageStatePath: actorStoragePath("lead") },
        member: { userId: member.userId, email: member.email, storageStatePath: actorStoragePath("member") },
      },
      projects: {
        productDepartmentId: productDepartment.id,
        engineeringDepartmentId: engineeringDepartment.id,
        customerValidationProjectId: customerValidation.id,
      },
      goalId: goal.id,
      discussionId: discussion.id,
      agents: { claude: { id: claude.id, name: claude.name }, codex: { id: codex.id, name: codex.name } },
      tasks: {},
      scenarios: {},
    };
    await saveState(state);
    await writeCheckpoint("lifecycle-setup", {
      companyId: company.id,
      issuePrefix: company.issuePrefix,
      discussionId: discussion.id,
      claudeAgentId: claude.id,
      codexAgentId: codex.id,
    });
  } finally {
    await Promise.all([founder.context.close(), lead.context.close(), member.context.close()]);
  }
});
