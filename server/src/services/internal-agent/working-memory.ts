import { badRequest, forbidden, notFound } from "../../errors.js";
import type { NormalizedCommanderContextScope } from "./context-scope.js";

export type CommanderUserRole = "founder" | "team_lead" | "team_member" | string | null | undefined;

export interface CommanderWorkingMemoryInput {
  companyId: string;
  userId: string;
  userRole?: CommanderUserRole;
  scope: Partial<NormalizedCommanderContextScope>;
}

export interface RememberWorkingMemoryInput extends CommanderWorkingMemoryInput {
  title: string;
  content: string;
}

export interface UpdateWorkingMemoryInput extends CommanderWorkingMemoryInput {
  memoryId: string;
  title?: string;
  content?: string;
}

export interface ForgetWorkingMemoryInput extends CommanderWorkingMemoryInput {
  memoryId: string;
}

export interface CommanderWorkingMemoryStore {
  create: (companyId: string, data: any) => Promise<any>;
  getById: (companyId: string, id: string) => Promise<any | null>;
  update: (companyId: string, id: string, data: any) => Promise<any | null>;
}

function isFounder(userRole: CommanderUserRole): boolean {
  return userRole === "founder";
}

function isTeamLead(userRole: CommanderUserRole): boolean {
  return userRole === "team_lead";
}

function hasSpecificScope(scope: Partial<NormalizedCommanderContextScope>): boolean {
  return Boolean(scope.projectId || scope.goalId || scope.taskId || scope.conversationId);
}

function scopeMatchesItem(
  item: {
    departmentId?: string | null;
    projectId?: string | null;
    goalId?: string | null;
    taskId?: string | null;
    conversationId?: string | null;
  },
  scope: Partial<NormalizedCommanderContextScope>,
): boolean {
  if (item.conversationId) return item.conversationId === scope.conversationId;
  if (item.taskId) return item.taskId === scope.taskId;
  if (item.goalId) return item.goalId === scope.goalId;
  if (item.projectId) return item.projectId === scope.projectId;
  if (item.departmentId) return item.departmentId === scope.departmentId;
  return false;
}

function ensureScopedForRole(input: CommanderWorkingMemoryInput): void {
  if (!isFounder(input.userRole) && !hasSpecificScope(input.scope)) {
    throw badRequest("Working memory requires project, goal, task, or conversation scope");
  }
}

export function defaultWorkingMemoryExpiry(
  scope: Partial<NormalizedCommanderContextScope>,
  now = new Date(),
): Date {
  const days = scope.taskId ? 7 : scope.goalId || scope.projectId ? 30 : scope.conversationId ? 14 : 7;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

function canMutateWorkingMemory(
  item: { createdBy?: string | null } & Parameters<typeof scopeMatchesItem>[0],
  input: CommanderWorkingMemoryInput,
): boolean {
  if (isFounder(input.userRole)) return true;
  if (isTeamLead(input.userRole)) return scopeMatchesItem(item, input.scope);
  return item.createdBy === input.userId && scopeMatchesItem(item, input.scope);
}

export function commanderWorkingMemoryService(memory: CommanderWorkingMemoryStore) {
  return {
    async remember(input: RememberWorkingMemoryInput) {
      ensureScopedForRole(input);
      const title = input.title.trim();
      const content = input.content.trim();
      if (!title) throw badRequest("Working memory title is required");
      if (!content) throw badRequest("Working memory content is required");

      return memory.create(input.companyId, {
        title,
        content,
        category: "context",
        source: "commander",
        status: "approved",
        layer: "working",
        visibility: "scoped",
        createdBy: input.userId,
        expiresAt: defaultWorkingMemoryExpiry(input.scope),
        departmentId: input.scope.departmentId ?? null,
        projectId: input.scope.projectId ?? null,
        goalId: input.scope.goalId ?? null,
        taskId: input.scope.taskId ?? null,
        conversationId: input.scope.conversationId ?? null,
        folderPath: "Commander/Working",
        sourceContext: `Commander working memory created by ${input.userId}`,
      });
    },

    async update(input: UpdateWorkingMemoryInput) {
      ensureScopedForRole(input);
      const item = await memory.getById(input.companyId, input.memoryId);
      if (!item) throw notFound("Working memory not found");
      if (item.layer !== "working" || item.source !== "commander") {
        throw badRequest("Only Commander working memory can be updated by this tool");
      }
      if (!canMutateWorkingMemory(item, input)) {
        throw forbidden("Not allowed to update this working memory");
      }

      const updates: Record<string, unknown> = {
        expiresAt: defaultWorkingMemoryExpiry(input.scope),
      };
      if (input.title !== undefined) updates.title = input.title.trim();
      if (input.content !== undefined) updates.content = input.content.trim();

      return memory.update(input.companyId, input.memoryId, updates);
    },

    async forget(input: ForgetWorkingMemoryInput) {
      ensureScopedForRole(input);
      const item = await memory.getById(input.companyId, input.memoryId);
      if (!item) throw notFound("Working memory not found");
      if (item.layer !== "working" || item.source !== "commander") {
        throw badRequest("Only Commander working memory can be forgotten by this tool");
      }
      if (!canMutateWorkingMemory(item, input)) {
        throw forbidden("Not allowed to forget this working memory");
      }

      return memory.update(input.companyId, input.memoryId, { status: "archived" });
    },
  };
}
