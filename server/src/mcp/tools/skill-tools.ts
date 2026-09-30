import { z } from "zod";
import { companySkills } from "@armyofagents/db";
import { and, eq } from "drizzle-orm";
import {
  type ToolContext,
  type ToolHandler,
  type ToolResult,
  notFoundResult,
  ok,
} from "./types.js";

async function handleUseSkill(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ key: z.string().min(1) }).parse(args);

  const [skill] = await ctx.db
    .select({
      key: companySkills.key,
      name: companySkills.name,
      description: companySkills.description,
      markdown: companySkills.markdown,
    })
    .from(companySkills)
    .where(
      and(
        eq(companySkills.companyId, ctx.companyId),
        eq(companySkills.key, parsed.key),
      ),
    )
    .limit(1);

  if (!skill) {
    return notFoundResult(
      `Skill '${parsed.key}' not found for this company. Use list_skills to see available skills.`,
    );
  }

  return ok({
    key: skill.key,
    name: skill.name,
    description: skill.description ?? null,
    content: skill.markdown ?? `Skill '${parsed.key}' has no markdown content.`,
  });
}

export const skillToolHandlers: Record<string, ToolHandler> = {
  "use_skill": handleUseSkill,
};
