import { eq, and, sql, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { workflowTemplates, issues, taskDependencies } from "@armyofagents/db";
import type { CreateWorkflowTemplate, UpdateWorkflowTemplate } from "@armyofagents/shared";
import { notFound, conflict } from "../errors.js";
import { executionWorkspaceService } from "./execution-workspaces.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowStep {
  order: number;
  title: string;
  description?: string;
  role?: string;
  suggestedAssigneeType?: string;
  suggestedDepartmentId?: string;
  estimatedDurationHours?: number;
  priority?: string;
}

export interface WorkflowDependency {
  fromStep: number; // order of the dependency (must complete first)
  toStep: number;   // order of the dependent (blocked until fromStep done)
}

export type CreateWorkflowInput = CreateWorkflowTemplate;

export type UpdateWorkflowInput = UpdateWorkflowTemplate;

export interface InstantiateResult {
  templateId: string;
  tasksCreated: { stepOrder: number; taskId: string; title: string }[];
  dependenciesCreated: number;
  sharedWorkspaceId?: string;
}

// ── Service ──────────────────────────────────────────────────────────────────

export function workflowTemplateService(db: Db) {
  return {
    list: async (companyId: string) => {
      return db
        .select()
        .from(workflowTemplates)
        .where(eq(workflowTemplates.companyId, companyId));
    },

    getById: async (companyId: string, id: string) => {
      return db
        .select()
        .from(workflowTemplates)
        .where(
          and(
            eq(workflowTemplates.id, id),
            eq(workflowTemplates.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
    },

    create: async (
      companyId: string,
      data: CreateWorkflowInput,
      actorId: string,
    ) => {
      const [row] = await db
        .insert(workflowTemplates)
        .values({
          companyId,
          name: data.name,
          description: data.description ?? null,
          workspaceMode: data.workspaceMode ?? "department_default",
          steps: data.steps,
          dependencies: data.dependencies ?? [],
          agentCompletionPolicyOverride: data.agentCompletionPolicyOverride ?? null,
          createdBy: actorId,
        })
        .returning();
      return row;
    },

    update: async (
      companyId: string,
      id: string,
      data: UpdateWorkflowInput,
    ) => {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) updates.name = data.name;
      if (data.description !== undefined) updates.description = data.description;
      if (data.workspaceMode !== undefined) updates.workspaceMode = data.workspaceMode;
      if (data.steps !== undefined) updates.steps = data.steps;
      if (data.dependencies !== undefined) updates.dependencies = data.dependencies;
      if (data.agentCompletionPolicyOverride !== undefined) {
        updates.agentCompletionPolicyOverride = data.agentCompletionPolicyOverride;
      }

      return db
        .update(workflowTemplates)
        .set(updates)
        .where(
          and(
            eq(workflowTemplates.id, id),
            eq(workflowTemplates.companyId, companyId),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    delete: async (companyId: string, id: string) => {
      // Block deletion if template has been instantiated
      const existing = await db
        .select()
        .from(workflowTemplates)
        .where(
          and(
            eq(workflowTemplates.id, id),
            eq(workflowTemplates.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;

      if (existing.instantiationCount > 0) {
        throw conflict(
          `Cannot delete template with ${existing.instantiationCount} active instance(s). Archive it instead.`,
        );
      }

      return db
        .delete(workflowTemplates)
        .where(
          and(
            eq(workflowTemplates.id, id),
            eq(workflowTemplates.companyId, companyId),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    instantiate: async (
      companyId: string,
      templateId: string,
      goalId: string,
      projectId: string,
    ): Promise<InstantiateResult> => {
      const txOutcome = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(
          sql`select id from companies where id = ${companyId} for no key update`,
        );
        await tx.execute(
          sql`select id from ${workflowTemplates} where ${workflowTemplates.id} = ${templateId} and ${workflowTemplates.companyId} = ${companyId} for update`,
        );
        const template = await txDb
          .select()
          .from(workflowTemplates)
          .where(
            and(
              eq(workflowTemplates.id, templateId),
              eq(workflowTemplates.companyId, companyId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!template) throw notFound("Workflow template not found");

        const steps = template.steps as WorkflowStep[];
        const deps = template.dependencies as WorkflowDependency[];
        const workspaceMode = (template.workspaceMode ?? "department_default") as string;
        // Map step order → created task id
        const stepTaskMap = new Map<number, string>();
        const tasksCreated: InstantiateResult["tasksCreated"] = [];
        const { resolveAgentCompletionPolicy } = await import("./agent-completion-policy.js");
        const completionPolicy = await resolveAgentCompletionPolicy(txDb, {
          companyId,
          projectId,
          creatorOverride: template.agentCompletionPolicyOverride as
            | "review_required"
            | "agent_can_complete"
            | null,
          creatorSource: "workflow_template",
          creatorSourceId: template.id,
          lockSources: true,
        });

        // Create a task for each step
        for (const step of steps) {
          const [task] = await tx
            .insert(issues)
            .values({
              companyId,
              goalId,
              projectId,
              title: step.title,
              description: step.description ?? null,
              priority: step.priority ?? "medium",
              status: "backlog",
              agentCompletionPolicy: completionPolicy.policy,
              agentCompletionPolicySource: completionPolicy.source,
              agentCompletionPolicySourceId: completionPolicy.sourceId,
              agentCompletionPolicyResolvedAt: completionPolicy.resolvedAt,
            } as typeof issues.$inferInsert)
            .returning();

          stepTaskMap.set(step.order, task.id);
          tasksCreated.push({
            stepOrder: step.order,
            taskId: task.id,
            title: task.title,
          });
        }

        // Create dependencies between tasks
        let dependenciesCreated = 0;
        for (const dep of deps) {
          const fromTaskId = stepTaskMap.get(dep.fromStep);
          const toTaskId = stepTaskMap.get(dep.toStep);
          if (fromTaskId && toTaskId) {
            await tx
              .insert(taskDependencies)
              .values({
                companyId,
                dependencyIssueId: fromTaskId,  // must complete first
                dependentIssueId: toTaskId,      // blocked until dependency done
              })
              .returning();
            dependenciesCreated++;
          }
        }

        // Increment instantiation count
        await tx
          .update(workflowTemplates)
          .set({
            instantiationCount: sql`${workflowTemplates.instantiationCount} + 1`,
            lastInstantiatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(workflowTemplates.id, templateId),
              eq(workflowTemplates.companyId, companyId),
            ),
          )
          .returning();

        return {
          result: {
            templateId,
            tasksCreated,
            dependenciesCreated,
          },
          templateName: template.name,
          workspaceMode,
        };
      });

      // Shared workspace: create one workspace and link all tasks
      if (txOutcome.workspaceMode === "shared" && txOutcome.result.tasksCreated.length > 0) {
        const ewSvc = executionWorkspaceService(db);
        const firstTaskId = txOutcome.result.tasksCreated[0]!.taskId;
        const workspace = await ewSvc.create({
          companyId,
          projectId,
          sourceIssueId: firstTaskId,
          mode: "shared_workspace",
          strategyType: "project_primary",
          status: "active",
          name: txOutcome.templateName,
        });
        if (!workspace) {
          throw new Error("Failed to create shared execution workspace for workflow instantiation");
        }
        const taskIds = txOutcome.result.tasksCreated.map((t) => t.taskId);
        await db
          .update(issues)
          .set({ executionWorkspaceId: workspace.id })
          .where(inArray(issues.id, taskIds));
        return { ...txOutcome.result, sharedWorkspaceId: workspace.id };
      }

      return txOutcome.result;
    },
  };
}
