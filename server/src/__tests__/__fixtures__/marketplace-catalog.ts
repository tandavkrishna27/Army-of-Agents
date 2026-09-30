import type { CatalogItem } from "@armyofagents/shared";

export const SLACK_PLUGIN: CatalogItem = {
  id: "plugin:aoa-curated/aoa-plugin-slack",
  type: "plugin",
  name: "Slack",
  description: "Slack integration",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "https://...", locator: "plugins/aoa-plugin-slack", commitSha: "abc123" },
  npm: { packageName: "aoa-plugin-slack", version: "1.0.0" },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  capabilities: [],
  category: "integrations",
  tags: [],
};

export const REQUIRED_PLUGIN: CatalogItem = {
  id: "plugin:aoa-curated/aoa-plugin-github-issues",
  type: "plugin",
  name: "GitHub Issues",
  description: "GitHub issues integration",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "https://...", locator: "plugins/aoa-plugin-github-issues", commitSha: "abc123" },
  npm: { packageName: "aoa-plugin-github-issues", version: "1.0.0" },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  capabilities: [],
  category: "integrations",
  tags: [],
};

export const REQUIRED_SKILL: CatalogItem = {
  id: "skill:aoa-curated/code-review",
  type: "skill",
  name: "Code Review",
  description: "Code review skill",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "https://...", locator: "content/skills/code-review", commitSha: "abc123" },
  resourceUrl: "https://raw.githubusercontent.com/.../abc123/content/skills/code-review/SKILL.md",
  content: { inline: "# Code Review" },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

export const REQUIRED_AGENT: CatalogItem = {
  id: "agent:aoa-curated/engineer",
  type: "agent",
  name: "Engineer",
  description: "Senior engineer agent",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "https://...", locator: "content/agents/engineer", commitSha: "abc123" },
  resourceUrl: "https://raw.githubusercontent.com/.../abc123/content/agents/engineer/agent.json",
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

export const ENGINEER_TEAM: CatalogItem = {
  id: "team:aoa-curated/engineering",
  type: "team",
  name: "Engineering Team",
  description: "Standard engineering team template",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "https://...", locator: "content/teams/engineering", commitSha: "abc123" },
  resourceUrl: "https://raw.githubusercontent.com/.../abc123/content/teams/engineering/team.json",
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
  requires: [
    { type: "agent", id: REQUIRED_AGENT.id },
    { type: "skill", id: REQUIRED_SKILL.id },
    { type: "plugin", id: REQUIRED_PLUGIN.id },
  ],
};

export const FULL_CATALOG = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-04-30T00:00:00Z",
  itemCount: 5,
  items: [SLACK_PLUGIN, ENGINEER_TEAM, REQUIRED_AGENT, REQUIRED_SKILL, REQUIRED_PLUGIN],
};

// Common DB mock helpers
export const mockEmptyDb = () => ({
  select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
});

export const mockDbWithRow = (row: Record<string, unknown>) => ({
  select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }) }),
});
