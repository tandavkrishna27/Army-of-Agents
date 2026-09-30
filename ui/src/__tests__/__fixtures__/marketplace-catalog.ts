import type { CatalogItem, MarketplaceCatalogFile } from "@armyofagents/shared";

export const SLACK_PLUGIN: CatalogItem = {
  id: "plugin:aoa-curated/aoa-plugin-slack",
  type: "plugin",
  name: "Slack",
  description: "Slack notifications and bidirectional integration",
  version: "1.0.0",
  source: {
    adapter: "aoa-curated",
    url: "https://github.com/MeteoriteLabs/aoa-marketplace/tree/abc123/plugins/aoa-plugin-slack",
    locator: "plugins/aoa-plugin-slack",
    commitSha: "abc123",
  },
  npm: {
    packageName: "aoa-plugin-slack",
    version: "1.0.0",
    tarballUrl: "https://github.com/MeteoriteLabs/aoa-marketplace/releases/download/v1.0.0/aoa-plugin-slack-1.0.0.tgz",
  },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  capabilities: [
    { id: "companies.read", description: "Read company data" },
    { id: "issues.read", description: "Read tasks for notifications" },
  ],
  category: "integrations",
  tags: ["official", "solo-friendly"],
};

export const CODE_REVIEW_SKILL: CatalogItem = {
  id: "skill:aoa-curated/code-review",
  type: "skill",
  name: "Code Review",
  description: "Systematic code review skill",
  version: "1.0.0",
  source: {
    adapter: "aoa-curated",
    url: "https://...",
    locator: "content/skills/code-review",
    commitSha: "abc123",
  },
  resourceUrl:
    "https://raw.githubusercontent.com/MeteoriteLabs/aoa-marketplace/abc123/content/skills/code-review/SKILL.md",
  content: { inline: "# Code Review\n\nSystematic skill for reviewing code." },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-29T00:00:00Z",
  category: "engineering",
  tags: ["official"],
};

export const ENGINEER_AGENT: CatalogItem = {
  id: "agent:aoa-curated/engineer",
  type: "agent",
  name: "Engineer",
  description: "Senior engineer agent template",
  version: "1.0.0",
  source: {
    adapter: "aoa-curated",
    url: "https://...",
    locator: "content/agents/engineer",
    commitSha: "abc123",
  },
  resourceUrl:
    "https://raw.githubusercontent.com/.../abc123/content/agents/engineer/agent.json",
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-28T00:00:00Z",
  category: "engineering",
  tags: ["official"],
  requires: [{ type: "skill", id: "skill:aoa-curated/code-review" }],
};

export const ENGINEERING_TEAM: CatalogItem = {
  id: "team:aoa-curated/engineering",
  type: "team",
  name: "Engineering Team",
  description: "Standard engineering team template",
  version: "1.0.0",
  source: {
    adapter: "aoa-curated",
    url: "https://...",
    locator: "content/teams/engineering",
    commitSha: "abc123",
  },
  resourceUrl:
    "https://raw.githubusercontent.com/.../abc123/content/teams/engineering/team.json",
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-27T00:00:00Z",
  category: "engineering",
  tags: ["official", "featured"],
  featured: true,
  requires: [
    { type: "agent", id: "agent:aoa-curated/engineer" },
    { type: "skill", id: "skill:aoa-curated/code-review" },
  ],
};

export const COMMUNITY_SKILL: CatalogItem = {
  id: "skill:community/example-author/quick-tip",
  type: "skill",
  name: "Quick Tip",
  description: "A community-contributed skill",
  version: "0.1.0",
  source: {
    adapter: "community",
    url: "https://...",
    locator: "...",
    commitSha: "def456",
  },
  resourceUrl: "https://...",
  trust: { tier: "community", source: "community" },
  status: "active",
  addedAt: "2026-04-26T00:00:00Z",
  category: "productivity",
  tags: ["new"],
};

export const FULL_CATALOG: MarketplaceCatalogFile = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-04-30T00:00:00Z",
  itemCount: 5,
  items: [
    SLACK_PLUGIN,
    CODE_REVIEW_SKILL,
    ENGINEER_AGENT,
    ENGINEERING_TEAM,
    COMMUNITY_SKILL,
  ],
};

export const GSTACK_BROWSE_SKILL: CatalogItem = {
  id: "skill:github-skills/garrytan/gstack/browse",
  type: "skill",
  name: "browse",
  description: "Canonical web browsing skill for gstack",
  version: "1.0.0",
  source: {
    adapter: "github-skills",
    url: "https://github.com/garrytan/gstack",
    locator: "browse",
    commitSha: "abc123",
  },
  resourceUrl:
    "https://raw.githubusercontent.com/garrytan/gstack/abc123/browse/SKILL.md",
  trust: { tier: "verified", source: "github-skills" },
  status: "active",
  addedAt: "2026-05-07T00:00:00Z",
  category: "productivity",
  tags: ["requires-cli-tooling"],
  runtimeRequires: ["gstack-bin", "gstack-browse-daemon"],
};

export const EMPTY_CATALOG: MarketplaceCatalogFile = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-04-30T00:00:00Z",
  itemCount: 0,
  items: [],
};
