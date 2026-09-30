import { eq, and } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companies, memoryItems, projects } from "@armyofagents/db";
import { memoryItemsSelection } from "../memory-projection.js";

const SYSTEM_INSTRUCTIONS = `You are the internal AI assistant for this company. Your role is to help the founder manage their team of AI agents and human collaborators.

Capabilities:
- Query and manage tasks, goals, agents, departments, and projects
- Access and suggest updates to company memory/knowledge base
- Process debriefs and discussion content
- Analyze workload and suggest improvements
- Manage task dependencies and coordination

Rules:
- Always be concise and actionable
- When taking write actions, explain what you're about to do before doing it
- Respect the user's role and permissions
- If unsure, ask for clarification rather than guessing
- Reference specific tasks, goals, or agents by name when possible`;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  // Slice to fit within budget; subtract 3 for "..." suffix, then floor to ensure
  // ceil(result.length / 4) <= maxTokens
  const sliceLen = maxChars - 3;
  if (sliceLen <= 0) return "";
  return text.slice(0, sliceLen) + "...";
}

function formatMemoryItemsForPrompt(
  items: Array<{
    title?: string;
    content?: string;
    layer?: string | null;
    visibility?: string | null;
    status?: string | null;
    expiresAt?: Date | string | null;
    departmentId?: string | null;
    projectId?: string | null;
    goalId?: string | null;
    taskId?: string | null;
    conversationId?: string | null;
  }>,
): string {
  const now = new Date();
  return items
    .filter((m) => (m.status ?? "approved") === "approved")
    .filter((m) => {
      if (!m.expiresAt) return true;
      const expiresAt = m.expiresAt instanceof Date ? m.expiresAt : new Date(m.expiresAt);
      return !Number.isFinite(expiresAt.getTime()) || expiresAt > now;
    })
    .map((m) => {
      const title = (m.title ?? "Memory").slice(0, 160);
      const content = (m.content ?? "").slice(0, 1200);
      const layer = m.layer ?? "memory";
      const visibility = m.visibility ?? "scoped";
      const status = m.status ?? "approved";
      const scope =
        m.taskId ? "task" :
        m.goalId ? "goal" :
        m.projectId ? "project" :
        m.conversationId ? "conversation" :
        m.departmentId ? "department" :
        "company";
      const expiry = m.expiresAt
        ? `/expires ${(m.expiresAt instanceof Date ? m.expiresAt : new Date(m.expiresAt)).toISOString().slice(0, 10)}`
        : "";
      return `- [${layer}/${visibility}/${status}${expiry}/${scope}] ${title}: ${content}`;
    })
    .join("\n");
}

function isCommanderPromptMemoryLayer(layer: string | null | undefined): boolean {
  return layer === "identity" || layer === "domain" || layer === "active_context" || layer === "working";
}

export function contextAssemblyService(db: Db) {
  return {
    async assembleContext(
      companyId: string,
      options: {
        pageContext?: string;
        departmentContext?: string;
        conversationSummary?: string | null;
        contextTokenBudget?: number;
        systemInstructions?: string;
        relevanceQuery?: string;
        memorySearch?: (query: string) => Promise<Array<{ title?: string; content?: string; layer?: string }>>;
        memoryItems?: Array<{
          title?: string;
          content?: string;
          layer?: string | null;
          visibility?: string | null;
          status?: string | null;
          expiresAt?: Date | string | null;
          departmentId?: string | null;
          projectId?: string | null;
          goalId?: string | null;
          taskId?: string | null;
          conversationId?: string | null;
        }>;
      } = {},
    ): Promise<{ systemPrompt: string; estimatedTokens: number }> {
      const budget = options.contextTokenBudget ?? 8000;
      const sections: string[] = [];
      let usedTokens = 0;

      const addSection = (label: string, content: string) => {
        if (!content.trim()) return;
        const section = `## ${label}\n${content}`;
        const sectionTokens = estimateTokens(section);
        const remaining = budget - usedTokens;
        if (remaining <= 0) return;
        if (sectionTokens <= remaining) {
          sections.push(section);
          usedTokens += sectionTokens;
        } else {
          sections.push(truncateToTokenBudget(section, remaining));
          usedTokens = budget;
        }
      };

      // 1. System instructions (always included, highest priority)
      const persona = options.systemInstructions && options.systemInstructions.trim().length > 0
        ? options.systemInstructions
        : SYSTEM_INSTRUCTIONS;
      addSection("Instructions", persona);

      // 2. Company identity
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows: any[]) => rows[0] ?? null);

      if (company) {
        const parts: string[] = [];
        if (company.name) parts.push(`Name: ${company.name}`);
        if (company.vision) parts.push(`Vision: ${company.vision}`);
        if (company.mission) parts.push(`Mission: ${company.mission}`);

        if (parts.length > 0) {
          addSection("Company Identity", parts.join("\n"));
        }
      }

      // Relevance-ranked approved memory (identity + department domain).
      // Falls back to nothing on error — never hard-fail (DI hides the
      // pgvector-or-keyword decision; memory.ts handles the no-API-key case).
      if (options.memoryItems && options.memoryItems.length > 0) {
        const promptMemoryItems = options.memoryItems.filter((item) =>
          isCommanderPromptMemoryLayer(item.layer),
        );
        if (promptMemoryItems.length > 0) {
          addSection(
            "Relevant Company Memory",
            formatMemoryItemsForPrompt(promptMemoryItems),
          );
        }
      } else if (options.memorySearch && options.relevanceQuery) {
        try {
          const items = await options.memorySearch(options.relevanceQuery);
          const scoped = items.filter((m) => isCommanderPromptMemoryLayer(m.layer));
          if (scoped.length > 0) {
            addSection(
              "Relevant Company Memory",
              formatMemoryItemsForPrompt(scoped),
            );
          }
        } catch {
          // omit the section; the rest of the prompt is unaffected
        }
      } else {
        // Legacy path retained for non-Commander callers (byte-identical):
        // company identity memory items + department domain items.
        if (company) {
          const identityItems = await db
            .select(memoryItemsSelection())
            .from(memoryItems)
            .where(
              and(
                eq(memoryItems.companyId, companyId),
                eq(memoryItems.layer, "identity"),
                eq(memoryItems.status, "approved"),
              ),
            );

          if (identityItems.length > 0) {
            const parts: string[] = [];
            for (const item of identityItems) {
              parts.push(`${item.title}: ${item.content}`);
            }
            addSection("Company Identity Memory", parts.join("\n"));
          }
        }

        if (options.departmentContext) {
          const dept = await db
            .select()
            .from(projects)
            .where(eq(projects.id, options.departmentContext))
            .then((rows: any[]) => rows[0] ?? null);

          if (dept) {
            const parts: string[] = [`Department: ${dept.name}`];
            if (dept.description) parts.push(dept.description);

            const domainItems = await db
              .select(memoryItemsSelection())
              .from(memoryItems)
              .where(
                and(
                  eq(memoryItems.companyId, companyId),
                  eq(memoryItems.layer, "domain"),
                  eq(memoryItems.departmentId, options.departmentContext),
                  eq(memoryItems.status, "approved"),
                ),
              );

            for (const item of domainItems) {
              parts.push(`${item.title}: ${item.content}`);
            }

            addSection("Department Context", parts.join("\n"));
          }
        }
      }

      // 3. Department context header (when using relevance path, no legacy DB queries)
      if ((options.memorySearch || options.memoryItems) && options.relevanceQuery && options.departmentContext) {
        const dept = await db
          .select()
          .from(projects)
          .where(eq(projects.id, options.departmentContext))
          .then((rows: any[]) => rows[0] ?? null);

        if (dept) {
          const parts: string[] = [`Department: ${dept.name}`];
          if (dept.description) parts.push(dept.description);
          addSection("Department Context", parts.join("\n"));
        }
      }

      // 4. Conversation summary
      if (options.conversationSummary) {
        addSection("Conversation Summary", options.conversationSummary);
      }

      // 5. Page context
      if (options.pageContext) {
        addSection("Current Context", options.pageContext);
      }

      const separator = "\n\n";
      const systemPrompt = sections.join(separator);

      // If over budget (due to join separators), truncate the final output
      let finalPrompt = systemPrompt;
      if (estimateTokens(finalPrompt) > budget) {
        finalPrompt = truncateToTokenBudget(finalPrompt, budget);
      }

      return {
        systemPrompt: finalPrompt,
        estimatedTokens: estimateTokens(finalPrompt),
      };
    },
  };
}
