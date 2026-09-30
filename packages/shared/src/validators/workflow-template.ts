import { z } from "zod";
import { AGENT_COMPLETION_POLICIES } from "../constants.js";

export const workflowStepSchema = z.object({
  order: z.number().int().nonnegative(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  role: z.string().optional().nullable(),
  suggestedAssigneeType: z.string().optional().nullable(),
  suggestedDepartmentId: z.string().uuid().optional().nullable(),
  estimatedDurationHours: z.number().nonnegative().optional().nullable(),
  priority: z.string().optional().nullable(),
});

export const workflowDependencySchema = z
  .object({
    fromStep: z.number().int().nonnegative(),
    toStep: z.number().int().nonnegative(),
  })
  .refine((d) => d.fromStep !== d.toStep, {
    message: "A step cannot depend on itself",
  });

export const createWorkflowTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  workspaceMode: z.enum(["department_default", "shared", "isolated"]).optional(),
  steps: z.array(workflowStepSchema).min(1),
  dependencies: z.array(workflowDependencySchema).optional(),
  agentCompletionPolicyOverride: z.enum(AGENT_COMPLETION_POLICIES).nullable().optional(),
});

export type CreateWorkflowTemplate = z.infer<typeof createWorkflowTemplateSchema>;

export const updateWorkflowTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  workspaceMode: z.enum(["department_default", "shared", "isolated"]).optional(),
  steps: z.array(workflowStepSchema).min(1).optional(),
  dependencies: z.array(workflowDependencySchema).optional(),
  agentCompletionPolicyOverride: z.enum(AGENT_COMPLETION_POLICIES).nullable().optional(),
});

export type UpdateWorkflowTemplate = z.infer<typeof updateWorkflowTemplateSchema>;
