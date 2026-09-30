import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import { agentProjects, agents, costEvents } from "@armyofagents/db";
import { and, eq, gte, lte, sql, desc } from "drizzle-orm";
import {
  createProjectSchema,
  createProjectWorkspaceSchema,
  envConfigSchema,
  isUuidLike,
  updateProjectSchema,
  updateProjectWorkspaceSchema,
} from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { assertRole } from "../middleware/rbac.js";
import { accessService, projectService, logActivity, instanceSettingsService, secretService } from "../services/index.js";
import { badRequest, conflict, forbidden, HttpError } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { gateProjectExecutionWorkspacePolicy, parseProjectExecutionWorkspacePolicy } from "../services/execution-workspace-policy.js";
import { assertCanControlWorkspace } from "../services/workspace-authz.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { assertUnsandboxedMultitenantAllowed } from "../services/unsandboxed-multitenant-guard.js";

/**
 * Detects whether a request body's executionWorkspacePolicy carries any of the
 * shell-command fields (provisionCommand / teardownCommand / cleanupCommand)
 * that are eventually passed to `sh -c` by `runWorkspaceCommand`. Used as the
 * gate trigger for the founder-only role check on POST/PATCH /projects routes
 * to mitigate finding C1 (RCE via executionWorkspacePolicy.provisionCommand).
 */
export function sniffsShellCommandFields(policy: unknown): boolean {
  if (!policy || typeof policy !== "object") return false;
  const p = policy as Record<string, unknown>;
  const ws = (p.workspaceStrategy ?? {}) as Record<string, unknown>;
  const workspaceRuntime = (p.workspaceRuntime ?? {}) as Record<string, unknown>;
  const services = Array.isArray(workspaceRuntime.services) ? workspaceRuntime.services : [];
  const hasRuntimeServiceCommand = services.some(
    (service) => typeof service === "object" && service !== null && typeof (service as Record<string, unknown>).command === "string",
  );
  return typeof ws.provisionCommand === "string"
      || typeof ws.teardownCommand === "string"
      || typeof ws.cleanupCommand === "string"
      || hasRuntimeServiceCommand;
}

export function assertCloudWorkspaceCommandConfigurationAllowed(): void {
  try {
    assertUnsandboxedMultitenantAllowed(
      { type: "local" },
      { tenantIsolationEnforced: tenantIsolationEnforced(), sink: "workspace command configuration" },
    );
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : String(error));
  }
}

export function projectRoutes(db: Db) {
  const router = Router();
  const svc = projectService(db);
  const secretsSvc = secretService(db);

  async function assertCanSetScopePolicy(req: Request, companyId: string) {
    if (req.actor.type !== "board") {
      throw forbidden("Only human operators may set project scope policy");
    }
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await accessService(db).canUser(companyId, req.actor.userId, "tasks:assign");
    if (!allowed) throw forbidden("Missing permission: tasks:assign");
  }

  async function resolveCompanyIdForProjectReference(req: Request) {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      await assertCompanyAccess(db, req, requestedCompanyId);
      return requestedCompanyId;
    }
    if (req.actor.type === "agent" && req.actor.companyId) {
      return req.actor.companyId;
    }
    return null;
  }

  async function normalizeProjectReference(req: Request, rawId: string) {
    if (isUuidLike(rawId)) return rawId;
    const companyId = await resolveCompanyIdForProjectReference(req);
    if (!companyId) return rawId;
    const resolved = await svc.resolveByReference(companyId, rawId);
    if (resolved.ambiguous) {
      throw conflict("Project shortname is ambiguous in this company. Use the project ID.");
    }
    return resolved.project?.id ?? rawId;
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeProjectReference(req, rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/projects", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const result = await svc.list(companyId, { type });
    res.json(result);
  });

  router.get("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCompanyAccess(db, req, project.companyId);
    res.json({
      ...project,
      executionWorkspacePolicy: gateProjectExecutionWorkspacePolicy(
        parseProjectExecutionWorkspacePolicy(project.executionWorkspacePolicy),
        (await instanceSettingsService(db).getExperimental()).enableIsolatedWorkspaces,
      ),
    });
  });

  router.post("/companies/:companyId/projects", validate(createProjectSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    if (
      "agentCompletionPolicyDefault" in req.body ||
      "humanQuestionSlaHours" in req.body
    ) {
      await assertCanSetScopePolicy(req, companyId);
    }

    // Security finding C1: see PATCH handler comment. Same gate on creation
    // path so an attacker can't seed a brand-new project with a poisoned
    // executionWorkspacePolicy and trigger the heartbeat command shell.
    if (sniffsShellCommandFields(req.body.executionWorkspacePolicy)) {
      if (req.actor.type === "agent" || req.actor.type === "mcp") {
        res.status(403).json({ error: "Agents and MCP keys cannot configure workspace commands" });
        return;
      }
      await assertRole(db, req, companyId, "founder");
      assertCloudWorkspaceCommandConfigurationAllowed();
    } else if (req.body.executionWorkspacePolicy !== undefined) {
      await assertCanControlWorkspace(db, req, { companyId, projectId: null });
    }

    type CreateProjectPayload = Parameters<typeof svc.create>[1] & {
      workspace?: Parameters<typeof svc.createWorkspace>[1];
    };

    const { workspace, ...projectData } = req.body as CreateProjectPayload;

    // Auto-configure executionWorkspacePolicy for departments and projects with a functionType
    if (!projectData.executionWorkspacePolicy && projectData.functionType) {
      const functionType = projectData.functionType as string | undefined;
      if (functionType === "software_development") {
        projectData.executionWorkspacePolicy = {
          enabled: true,
          defaultMode: "isolated_workspace",
          allowIssueOverride: true,
          workspaceStrategy: { type: "git_worktree", baseRef: "main" },
        };
      } else {
        projectData.executionWorkspacePolicy = {
          enabled: true,
          defaultMode: "isolated_workspace",
          allowIssueOverride: true,
        };
      }
    }

    const project = await svc.create(companyId, projectData);
    let createdWorkspaceId: string | null = null;
    if (workspace) {
      const createdWorkspace = await svc.createWorkspace(project.id, workspace);
      if (!createdWorkspace) {
        await svc.remove(project.id);
        res.status(422).json({ error: "Invalid project workspace payload" });
        return;
      }
      createdWorkspaceId = createdWorkspace.id;
    }
    const hydratedProject = workspace ? await svc.getById(project.id) : project;

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "project.created",
      entityType: "project",
      entityId: project.id,
      details: {
        name: project.name,
        workspaceId: createdWorkspaceId,
      },
    });
    res.status(201).json(hydratedProject ?? project);
  });

  router.patch("/projects/:id", validate(updateProjectSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    if (
      "agentCompletionPolicyDefault" in req.body ||
      "humanQuestionSlaHours" in req.body
    ) {
      await assertCanSetScopePolicy(req, existing.companyId);
    }

    // Security finding C1: shell-command fields on executionWorkspacePolicy are
    // executed via `sh -c` by the workspace runtime. Restrict the route surface
    // to founders only and reject agent/MCP actors entirely so a compromised
    // agent key or low-trust teammate cannot pivot to RCE on the host.
    if (sniffsShellCommandFields(req.body.executionWorkspacePolicy)) {
      if (req.actor.type === "agent" || req.actor.type === "mcp") {
        res.status(403).json({ error: "Agents and MCP keys cannot configure workspace commands" });
        return;
      }
      await assertRole(db, req, existing.companyId, "founder");
      assertCloudWorkspaceCommandConfigurationAllowed();
    } else if (req.body.executionWorkspacePolicy !== undefined) {
      await assertCanControlWorkspace(db, req, { companyId: existing.companyId, projectId: existing.id });
    }

    const project = await svc.update(id, req.body);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "project.updated",
      entityType: "project",
      entityId: project.id,
      details: req.body,
    });

    res.json({
      ...project,
      executionWorkspacePolicy: gateProjectExecutionWorkspacePolicy(
        parseProjectExecutionWorkspacePolicy(project.executionWorkspacePolicy),
        (await instanceSettingsService(db).getExperimental()).enableIsolatedWorkspaces,
      ),
    });
  });

  router.get("/projects/:id/workspaces", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    const workspaces = await svc.listWorkspaces(id);
    res.json(workspaces);
  });

  router.post("/projects/:id/workspaces", validate(createProjectWorkspaceSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    const workspace = await svc.createWorkspace(id, req.body);
    if (!workspace) {
      res.status(422).json({ error: "Invalid project workspace payload" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "project.workspace_created",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        name: workspace.name,
        cwd: workspace.cwd,
        isPrimary: workspace.isPrimary,
      },
    });

    res.status(201).json(workspace);
  });

  router.patch(
    "/projects/:id/workspaces/:workspaceId",
    validate(updateProjectWorkspaceSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const workspaceId = req.params.workspaceId as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      await assertCompanyAccess(db, req, existing.companyId);
      const workspaceExists = (await svc.listWorkspaces(id)).some((workspace) => workspace.id === workspaceId);
      if (!workspaceExists) {
        res.status(404).json({ error: "Project workspace not found" });
        return;
      }
      const workspace = await svc.updateWorkspace(id, workspaceId, req.body);
      if (!workspace) {
        res.status(422).json({ error: "Invalid project workspace payload" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "project.workspace_updated",
        entityType: "project",
        entityId: id,
        details: {
          workspaceId: workspace.id,
          changedKeys: Object.keys(req.body).sort(),
        },
      });

      res.json(workspace);
    },
  );

  router.delete("/projects/:id/workspaces/:workspaceId", async (req, res) => {
    const id = req.params.id as string;
    const workspaceId = req.params.workspaceId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    const workspace = await svc.removeWorkspace(id, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Project workspace not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "project.workspace_deleted",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        name: workspace.name,
      },
    });

    res.json(workspace);
  });

  /* ── Project environment variables ── */

  router.get("/projects/:id/environment", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCompanyAccess(db, req, project.companyId);
    res.json({ env: project.env ?? null });
  });

  router.patch("/projects/:id/environment", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCompanyAccess(db, req, project.companyId);
    const bodyEnv = req.body?.env ?? null;
    if (bodyEnv !== null) {
      const parsed = envConfigSchema.safeParse(bodyEnv);
      if (!parsed.success) {
        res.status(422).json({ error: "validation", issues: parsed.error.issues });
        return;
      }
    }
    const updated = await svc.updateEnvironment(id, bodyEnv);
    if (!updated) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await secretsSvc.syncEnvBindingsForTarget(project.companyId, {
      targetType: "project",
      targetId: project.id,
      pathPrefix: "env",
    }, updated.env ?? {});
    res.json({ env: updated.env ?? null });
  });

  router.delete("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);

    let project;
    try {
      project = await svc.remove(id);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "project.deleted",
      entityType: "project",
      entityId: project.id,
    });

    res.json(project);
  });

  /* ── Agent-Project assignment ── */

  router.get("/projects/:id/agents", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCompanyAccess(db, req, project.companyId);

    const rows = await db
      .select({
        agentId: agentProjects.agentId,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        icon: agents.icon,
        status: agents.status,
        createdAt: agentProjects.createdAt,
      })
      .from(agentProjects)
      .innerJoin(agents, eq(agentProjects.agentId, agents.id))
      .where(eq(agentProjects.projectId, id));

    res.json(rows);
  });

  router.post("/projects/:id/agents", async (req, res) => {
    const id = req.params.id as string;
    const { agentId } = req.body as { agentId?: string };
    if (!agentId) {
      res.status(422).json({ error: "agentId is required" });
      return;
    }

    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCompanyAccess(db, req, project.companyId);

    // Verify agent exists and belongs to same company
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, project.companyId)))
      .then((rows) => rows[0] ?? null);

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Upsert (ignore if already assigned)
    await db
      .insert(agentProjects)
      .values({ agentId, projectId: id, companyId: project.companyId })
      .onConflictDoNothing();

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "project.agent_assigned",
      entityType: "project",
      entityId: id,
      details: { assignedAgentId: agentId },
    });

    res.status(201).json({ ok: true });
  });

  router.delete("/projects/:id/agents/:agentId", async (req, res) => {
    const id = req.params.id as string;
    const agentId = req.params.agentId as string;

    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCompanyAccess(db, req, project.companyId);

    const deleted = await db
      .delete(agentProjects)
      .where(and(eq(agentProjects.projectId, id), eq(agentProjects.agentId, agentId)))
      .returning();

    if (deleted.length === 0) {
      res.status(404).json({ error: "Agent not assigned to this project" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "project.agent_unassigned",
      entityType: "project",
      entityId: id,
      details: { unassignedAgentId: agentId },
    });

    res.json({ ok: true });
  });

  /* ── Project budget ── */

  router.get("/projects/:id/budget", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCompanyAccess(db, req, project.companyId);

    // Current month boundaries
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Get assigned agent IDs
    const assignedAgentRows = await db
      .select({ agentId: agentProjects.agentId })
      .from(agentProjects)
      .where(eq(agentProjects.projectId, id));

    const agentIds = assignedAgentRows.map((r) => r.agentId);

    if (agentIds.length === 0) {
      res.json({ totalSpendCents: 0, agents: [] });
      return;
    }

    // Get spending per agent this month (from cost_events linked to this project or to assigned agents)
    const agentSpend = await db
      .select({
        agentId: costEvents.agentId,
        agentName: agents.name,
        budgetMonthlyCents: agents.budgetMonthlyCents,
        spendCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      })
      .from(costEvents)
      .innerJoin(agents, eq(costEvents.agentId, agents.id))
      .where(
        and(
          eq(costEvents.companyId, project.companyId),
          sql`${costEvents.agentId} = ANY(${agentIds})`,
          gte(costEvents.occurredAt, monthStart),
          lte(costEvents.occurredAt, monthEnd),
        ),
      )
      .groupBy(costEvents.agentId, agents.name, agents.budgetMonthlyCents)
      .orderBy(desc(sql`coalesce(sum(${costEvents.costCents}), 0)::int`));

    const totalSpendCents = agentSpend.reduce((sum, row) => sum + Number(row.spendCents), 0);

    // Include agents with zero spend
    const spendMap = new Map(agentSpend.map((r) => [r.agentId, r]));
    const allAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        budgetMonthlyCents: agents.budgetMonthlyCents,
      })
      .from(agents)
      .where(sql`${agents.id} = ANY(${agentIds})`);

    const agentBreakdown = allAgents.map((a) => {
      const spend = spendMap.get(a.id);
      return {
        agentId: a.id,
        agentName: a.name,
        budgetMonthlyCents: a.budgetMonthlyCents,
        spendCents: spend ? Number(spend.spendCents) : 0,
      };
    });

    // Sort by spend descending
    agentBreakdown.sort((a, b) => b.spendCents - a.spendCents);

    res.json({ totalSpendCents, agents: agentBreakdown });
  });

  return router;
}
