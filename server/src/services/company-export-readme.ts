import type { CompanyPortabilityManifest } from "@armyofagents/shared";

// Current 3-tier enum (AGENT_ROLES in @armyofagents/shared) takes precedence.
// Legacy entries (ceo/cto/cmo/cfo/engineer/...) remain for backward
// compatibility with bundles exported before the role-enum cleanup.
const ROLE_LABELS: Record<string, string> = {
  cxo: "Executive",
  lead: "Lead",
  general: "General",
  ceo: "CEO",
  cto: "CTO",
  cmo: "CMO",
  cfo: "CFO",
  engineer: "Engineer",
  designer: "Designer",
  pm: "PM",
  qa: "QA",
  devops: "DevOps",
  researcher: "Researcher",
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

function renderOrgTree(agents: CompanyPortabilityManifest["agents"]): string {
  const bySlug = new Map(agents.map((a) => [a.slug, a] as const));
  const childrenOf = new Map<string | null, typeof agents>();
  for (const agent of agents) {
    const parent = agent.reportsToSlug && bySlug.has(agent.reportsToSlug) ? agent.reportsToSlug : null;
    const bucket = childrenOf.get(parent) ?? [];
    bucket.push(agent);
    childrenOf.set(parent, bucket);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    const kids = [...(childrenOf.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const kid of kids) {
      const indent = "  ".repeat(depth);
      lines.push(`${indent}- **${kid.name}** (${roleLabel(kid.role)})`);
      walk(kid.slug, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}

function countByRole(agents: CompanyPortabilityManifest["agents"]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    counts.set(agent.role, (counts.get(agent.role) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([role, n]) => [roleLabel(role), n] as [string, number])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function skillSourceLabel(skill: NonNullable<CompanyPortabilityManifest["skills"]>[number]): string {
  if (skill.sourceLocator) {
    if (skill.sourceType === "github" || skill.sourceType === "url") {
      return `[${skill.sourceType}](${skill.sourceLocator})`;
    }
    return skill.sourceLocator;
  }
  return skill.sourceType ?? "\u2014";
}

function collectSecretKeys(manifest: CompanyPortabilityManifest): Array<{ key: string; agentSlug: string | null; description: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; agentSlug: string | null; description: string | null }> = [];
  for (const req of manifest.requiredSecrets ?? []) {
    if (seen.has(req.key)) continue;
    seen.add(req.key);
    out.push({ key: req.key, agentSlug: req.agentSlug, description: req.description });
  }
  for (const env of manifest.envInputs ?? []) {
    if (env.kind !== "secret") continue;
    if (seen.has(env.key)) continue;
    seen.add(env.key);
    out.push({ key: env.key, agentSlug: env.agentSlug, description: env.description });
  }
  return out;
}

export interface GenerateReadmeOptions {
  companyName?: string;
  companyDescription?: string | null;
}

export function generateReadme(
  manifest: CompanyPortabilityManifest,
  options: GenerateReadmeOptions = {},
): string {
  const companyName =
    options.companyName ??
    manifest.company?.name ??
    manifest.source?.companyName ??
    "Company";
  const companyDescription = options.companyDescription ?? manifest.company?.description ?? null;
  const generatedDate = manifest.generatedAt.split("T")[0] ?? manifest.generatedAt;

  const agents = manifest.agents;
  const projects = manifest.projects ?? [];
  const issues = manifest.issues ?? [];
  const skills = manifest.skills ?? [];
  const routines = manifest.routines ?? [];
  const envInputs = manifest.envInputs ?? [];
  const secrets = collectSecretKeys(manifest);

  const lines: string[] = [];

  lines.push(`# ${companyName} Export Bundle`);
  lines.push("");
  lines.push(`_Generated ${generatedDate}_`);
  lines.push("");

  if (companyDescription) {
    lines.push(`> ${companyDescription}`);
    lines.push("");
  }

  const counts: Array<[string, number]> = [];
  if (agents.length > 0) counts.push(["Agents", agents.length]);
  if (projects.length > 0) counts.push(["Projects", projects.length]);
  if (issues.length > 0) counts.push(["Tasks", issues.length]);
  if (skills.length > 0) counts.push(["Skills", skills.length]);
  if (routines.length > 0) counts.push(["Routines", routines.length]);
  if (envInputs.length > 0) counts.push(["Env Inputs", envInputs.length]);

  if (counts.length > 0) {
    lines.push("## What's Inside");
    lines.push("");
    lines.push("| Content | Count |");
    lines.push("|---------|-------|");
    for (const [label, count] of counts) {
      lines.push(`| ${label} | ${count} |`);
    }
    lines.push("");
  }

  if (agents.length > 0) {
    const roleRollup = countByRole(agents);
    lines.push("### Agents");
    lines.push("");
    lines.push("| Role | Count |");
    lines.push("|------|-------|");
    for (const [label, count] of roleRollup) {
      lines.push(`| ${label} | ${count} |`);
    }
    lines.push("");
    lines.push("| Agent | Role | Reports To |");
    lines.push("|-------|------|------------|");
    for (const agent of agents) {
      const reportsTo = agent.reportsToSlug ?? "\u2014";
      lines.push(`| ${agent.name} | ${roleLabel(agent.role)} | ${reportsTo} |`);
    }
    lines.push("");

    const orgTree = renderOrgTree(agents);
    if (orgTree.length > 0) {
      lines.push("## Org Tree");
      lines.push("");
      lines.push(orgTree);
      lines.push("");
    }
  }

  if (projects.length > 0) {
    lines.push("### Projects");
    lines.push("");
    for (const project of projects) {
      const kind = project.type === "department" ? "department" : "project";
      const desc = project.description ? ` \u2014 ${project.description}` : "";
      lines.push(`- **${project.name}** _(${kind})_${desc}`);
    }
    lines.push("");
  }

  if (skills.length > 0) {
    lines.push("### Skills");
    lines.push("");
    lines.push("| Skill | Description | Source |");
    lines.push("|-------|-------------|--------|");
    for (const skill of skills) {
      const desc = skill.description ?? "\u2014";
      lines.push(`| ${skill.name} | ${desc} | ${skillSourceLabel(skill)} |`);
    }
    lines.push("");
  }

  if (routines.length > 0) {
    lines.push("### Routines");
    lines.push("");
    for (const routine of routines) {
      const desc = routine.description ? ` \u2014 ${routine.description}` : "";
      lines.push(`- **${routine.title}** _(${routine.status})_${desc}`);
    }
    lines.push("");
  }

  if (secrets.length > 0) {
    lines.push("## Required Secrets");
    lines.push("");
    lines.push("These secret values must be provided at import time; they are not included in the bundle.");
    lines.push("");
    lines.push("| Key | Agent | Description |");
    lines.push("|-----|-------|-------------|");
    for (const secret of secrets) {
      const agent = secret.agentSlug ?? "\u2014";
      const desc = secret.description ?? "\u2014";
      lines.push(`| ${secret.key} | ${agent} | ${desc} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`Bundle format: schemaVersion ${manifest.schemaVersion} \u00b7 Generated ${generatedDate}`);
  lines.push("");

  return lines.join("\n");
}
