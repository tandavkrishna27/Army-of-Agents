import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agents,
  artifacts,
  artifactVersions,
  companies,
  goals,
  issues,
  memoryItems,
  projects,
  taskDependencies,
} from "@armyofagents/db";
import { isContextBundleItemIncluded, listIssueContextBundlesForIssue } from "./issue-context-bundles.js";

type ScopeHandoffBundleForRender = {
  brief?: string | null;
  sourceKind?: string | null;
  items?: Array<{
    itemType: string;
    label?: string | null;
    metadata?: Record<string, unknown> | null;
  }>;
};

function metadataText(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function renderScopeHandoffSection(bundles: ScopeHandoffBundleForRender[]): string | null {
  const scopeBundles = bundles.filter((bundle) => bundle.sourceKind === "discussion_scope");
  if (scopeBundles.length === 0) return null;

  const lines: string[] = ["## Scope Handoff"];
  for (const bundle of scopeBundles) {
    if (bundle.brief && bundle.brief.trim().length > 0) {
      lines.push(bundle.brief.trim());
    }
    for (const item of bundle.items ?? []) {
      if (!isContextBundleItemIncluded(item)) continue;
      const label = item.label?.trim() || item.itemType;
      const bits = [
        metadataText(item.metadata, "artifactType"),
        metadataText(item.metadata, "contentType"),
        metadataText(item.metadata, "url"),
      ].filter((value): value is string => Boolean(value));
      const suffix = bits.length > 0 ? ` (${bits.join(" · ")})` : "";
      const excerpt = metadataText(item.metadata, "excerpt") ?? metadataText(item.metadata, "body");
      lines.push(`- **${label}**${suffix}${excerpt ? `: ${excerpt}` : ""}`);
    }
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

/**
 * Assembles a full context package for a task, formatted as markdown
 * ready for LLM consumption via "Open in [LLM]" button.
 *
 * Uses the same data sources as heartbeat's fetchMemoryContext but
 * assembles a richer, structured document with section headers.
 */
export function contextPackagingService(db: Db) {
  return {
    assembleContext,
  };

  async function assembleContext(
    companyId: string,
    issueId: string,
  ): Promise<{ markdown: string; tokenEstimate: number }> {
    // Fetch the task first
    const issue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!issue) {
      throw new Error("Task not found");
    }

    // Resolve contextMode and injectCompanyContext from assigned agent (if any)
    let contextMode = "standard";
    let injectCompanyContext = true;
    if (issue.assigneeAgentId) {
      const assignedAgent = await db
        .select({ runtimeConfig: agents.runtimeConfig })
        .from(agents)
        .where(eq(agents.id, issue.assigneeAgentId))
        .then((rows) => rows[0] ?? null);
      if (assignedAgent) {
        const rc = (assignedAgent.runtimeConfig as Record<string, unknown>) ?? {};
        contextMode = (rc.contextMode as string) ?? "standard";
        injectCompanyContext = rc.injectCompanyContext !== false;
      }
    }

    const sectionLimits = {
      minimal: { memory: 2, dependencies: 3, preferences: 1 },
      standard: { memory: 5, dependencies: 10, preferences: 5 },
      full: { memory: 10, dependencies: 20, preferences: 10 },
    }[contextMode] ?? { memory: 5, dependencies: 10, preferences: 5 };

    const sections: string[] = [];

    // 1. Company Identity
    const company = await db
      .select({
        name: companies.name,
        description: companies.description,
        vision: companies.vision,
        mission: companies.mission,
        values: companies.values,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);

    if (company) {
      const identityParts: string[] = [`# Company: ${company.name}`];
      if (company.description) identityParts.push(company.description);

      // Vision/Mission/Values and identity memory only when agent opts in
      if (injectCompanyContext) {
        if (company.vision) identityParts.push(`**Vision:** ${company.vision}`);
        if (company.mission) identityParts.push(`**Mission:** ${company.mission}`);
        if (company.values) identityParts.push(`**Values:** ${company.values}`);

        // Fetch identity-layer memory items
        const identityMemory = await db
          .select({ title: memoryItems.title, content: memoryItems.content })
          .from(memoryItems)
          .where(
            and(
              eq(memoryItems.companyId, companyId),
              eq(memoryItems.status, "approved"),
              eq(memoryItems.layer, "identity"),
            ),
          )
          .orderBy(desc(memoryItems.priority), desc(memoryItems.updatedAt))
          .limit(sectionLimits.memory);

        if (identityMemory.length > 0) {
          identityParts.push("");
          identityParts.push("**Key Knowledge:**");
          for (const item of identityMemory) {
            identityParts.push(`- **${item.title}:** ${item.content}`);
          }
        }
      }

      sections.push(identityParts.join("\n"));
    }

    // 2. Department (project with type='department')
    if (issue.projectId) {
      const project = await db
        .select({
          name: projects.name,
          description: projects.description,
          type: projects.type,
        })
        .from(projects)
        .where(eq(projects.id, issue.projectId))
        .then((rows) => rows[0] ?? null);

      if (project) {
        const label = project.type === "department" ? "Department" : "Project";
        const projectParts: string[] = [`## ${label}: ${project.name}`];
        if (project.description) projectParts.push(project.description);

        // Fetch domain-layer memory items scoped to this department/project
        const domainMemory = await db
          .select({ title: memoryItems.title, content: memoryItems.content })
          .from(memoryItems)
          .where(
            and(
              eq(memoryItems.companyId, companyId),
              eq(memoryItems.status, "approved"),
              eq(memoryItems.layer, "domain"),
              or(
                eq(memoryItems.departmentId, issue.projectId),
                eq(memoryItems.projectId, issue.projectId),
              ),
            ),
          )
          .orderBy(desc(memoryItems.priority), desc(memoryItems.updatedAt))
          .limit(sectionLimits.memory);

        if (domainMemory.length > 0) {
          projectParts.push("");
          projectParts.push("**Domain Knowledge:**");
          for (const item of domainMemory) {
            projectParts.push(`- **${item.title}:** ${item.content}`);
          }
        }

        sections.push(projectParts.join("\n"));
      }
    }

    // 3. Goal
    if (issue.goalId) {
      const goal = await db
        .select({
          title: goals.title,
          description: goals.description,
          status: goals.status,
        })
        .from(goals)
        .where(eq(goals.id, issue.goalId))
        .then((rows) => rows[0] ?? null);

      if (goal) {
        const goalParts: string[] = [`## Goal: ${goal.title}`];
        if (goal.description) goalParts.push(goal.description);
        goalParts.push(`**Status:** ${goal.status}`);

        // Fetch active_context memory items scoped to this goal
        const activeContextMemory = await db
          .select({ title: memoryItems.title, content: memoryItems.content })
          .from(memoryItems)
          .where(
            and(
              eq(memoryItems.companyId, companyId),
              eq(memoryItems.status, "approved"),
              eq(memoryItems.layer, "active_context"),
              eq(memoryItems.goalId, issue.goalId),
            ),
          )
          .orderBy(desc(memoryItems.priority), desc(memoryItems.updatedAt))
          .limit(sectionLimits.memory);

        if (activeContextMemory.length > 0) {
          goalParts.push("");
          goalParts.push("**Active Context:**");
          for (const item of activeContextMemory) {
            goalParts.push(`- **${item.title}:** ${item.content}`);
          }
        }

        sections.push(goalParts.join("\n"));
      }
    }

    // 4. Previous Tasks (completed upstream dependencies — working memory)
    const deps = await db
      .select({
        dependencyIssueId: taskDependencies.dependencyIssueId,
        title: issues.title,
        description: issues.description,
        status: issues.status,
      })
      .from(taskDependencies)
      .innerJoin(issues, eq(issues.id, taskDependencies.dependencyIssueId))
      .where(
        and(
          eq(taskDependencies.companyId, companyId),
          eq(taskDependencies.dependentIssueId, issueId),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(sectionLimits.dependencies);

    if (deps.length > 0) {
      const depParts: string[] = ["## Previous Tasks (Dependencies)"];
      for (const dep of deps) {
        const statusLabel = dep.status === "done" ? "completed" : dep.status;
        depParts.push(`### ${dep.title} [${statusLabel}]`);
        if (dep.description) depParts.push(dep.description);
      }
      sections.push(depParts.join("\n"));
    }

    const contextBundles = await listIssueContextBundlesForIssue(db, companyId, issueId);
    const scopeHandoffSection = renderScopeHandoffSection(contextBundles);
    if (scopeHandoffSection) {
      sections.push(scopeHandoffSection);
    }

    // 5. Task Details
    const taskParts: string[] = [
      `## Task: ${issue.title}`,
      `**Identifier:** ${issue.identifier ?? issue.id.slice(0, 8)}`,
      `**Status:** ${issue.status}`,
      `**Priority:** ${issue.priority}`,
    ];
    if (issue.description) {
      taskParts.push("");
      taskParts.push(issue.description);
    }
    sections.push(taskParts.join("\n"));

    // 6. Artifacts (from this task and dependency tasks)
    const artifactIds: string[] = [];
    if (issue.artifactId) artifactIds.push(issue.artifactId);

    // Also fetch artifacts from completed dependency tasks
    const depArtifactRows = deps
      .map((d) => d.dependencyIssueId)
      .filter(Boolean);

    if (depArtifactRows.length > 0) {
      const depIssuesWithArtifacts = await db
        .select({ artifactId: issues.artifactId })
        .from(issues)
        .where(
          and(
            inArray(issues.id, depArtifactRows),
            sql`${issues.artifactId} IS NOT NULL`,
          ),
        );
      for (const row of depIssuesWithArtifacts) {
        if (row.artifactId && !artifactIds.includes(row.artifactId)) {
          artifactIds.push(row.artifactId);
        }
      }
    }

    if (artifactIds.length > 0) {
      const artifactRows = await db
        .select({
          id: artifacts.id,
          title: artifacts.title,
          description: artifacts.description,
          type: artifacts.type,
          currentVersionId: artifacts.currentVersionId,
        })
        .from(artifacts)
        .where(inArray(artifacts.id, artifactIds));

      if (artifactRows.length > 0) {
        const artifactParts: string[] = ["## Artifacts"];
        for (const art of artifactRows) {
          artifactParts.push(`### ${art.title} (${art.type})`);
          if (art.description) artifactParts.push(art.description);

          // Fetch current version content if available
          if (art.currentVersionId) {
            const version = await db
              .select({
                versionNumber: artifactVersions.versionNumber,
                changelog: artifactVersions.changelog,
                content: artifactVersions.content,
              })
              .from(artifactVersions)
              .where(eq(artifactVersions.id, art.currentVersionId))
              .then((rows) => rows[0] ?? null);

            if (version) {
              artifactParts.push(`**Version:** ${version.versionNumber}`);
              if (version.changelog) artifactParts.push(`**Changelog:** ${version.changelog}`);
              if (version.content) {
                // Truncate very large content
                const maxContentLen = 2000;
                const content = version.content.length > maxContentLen
                  ? version.content.slice(0, maxContentLen) + "\n\n[... truncated]"
                  : version.content;
                artifactParts.push("");
                artifactParts.push(content);
              }
            }
          }
        }
        sections.push(artifactParts.join("\n"));
      }
    }

    // 7. Agent Configuration (if task has an assigned agent)
    if (issue.assigneeAgentId) {
      const agent = await db
        .select({
          name: agents.name,
          role: agents.role,
          adapterType: agents.adapterType,
          runtimeConfig: agents.runtimeConfig,
          capabilities: agents.capabilities,
        })
        .from(agents)
        .where(eq(agents.id, issue.assigneeAgentId))
        .then((rows) => rows[0] ?? null);

      if (agent) {
        const agentParts: string[] = [
          `## Agent: ${agent.name}`,
          `**Role:** ${agent.role}`,
          `**Adapter:** ${agent.adapterType}`,
        ];
        const contextMode = (agent.runtimeConfig as Record<string, unknown>)?.contextMode ?? "standard";
        agentParts.push(`**Context Mode:** ${contextMode}`);
        if (agent.capabilities) agentParts.push(`**Capabilities:** ${agent.capabilities}`);
        sections.push(agentParts.join("\n"));
      }
    }

    // 8. Company-wide preferences (memory items)
    const preferences = await db
      .select({ title: memoryItems.title, content: memoryItems.content })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.companyId, companyId),
          eq(memoryItems.status, "approved"),
          eq(memoryItems.category, "preference"),
        ),
      )
      .orderBy(desc(memoryItems.updatedAt))
      .limit(sectionLimits.preferences);

    if (preferences.length > 0) {
      const prefParts: string[] = ["## Preferences"];
      for (const pref of preferences) {
        prefParts.push(`- **${pref.title}:** ${pref.content}`);
      }
      sections.push(prefParts.join("\n"));
    }

    // 9. Plugin tools (if available)
    try {
      const dispatcher: import("./plugin-tool-dispatcher.js").PluginToolDispatcher | undefined =
        (globalThis as any).__paperclipPluginToolDispatcher;
      if (dispatcher) {
        const tools = dispatcher.listToolsForAgent({ companyId });
        if (tools.length > 0) {
          const toolParts: string[] = ["## Available Plugin Tools"];
          for (const tool of tools) {
            toolParts.push(`- **${tool.name}:** ${tool.description}`);
          }
          sections.push(toolParts.join("\n"));
        }
      }
    } catch {
      // Plugin tools are optional — silently skip if unavailable
    }

    const markdown = sections.join("\n\n---\n\n");

    // Rough token estimate: ~4 chars per token for English text
    const tokenEstimate = Math.ceil(markdown.length / 4);

    return { markdown, tokenEstimate };
  }
}
