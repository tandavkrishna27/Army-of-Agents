import { createDb } from "./client.js";
import { companies, agents, goals, projects, issues, organizations } from "./schema/index.js";
import { DEFAULT_ORGANIZATION_ID, DEFAULT_ORGANIZATION_SLUG } from "@armyofagents/shared";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url);

console.log("Seeding database...");

await db
  .insert(organizations)
  .values({ id: DEFAULT_ORGANIZATION_ID, name: "Default Organization", slug: DEFAULT_ORGANIZATION_SLUG })
  .onConflictDoNothing({ target: organizations.id });

const [company] = await db
  .insert(companies)
  .values({
    name: "AoA Demo Co",
    description: "A demo autonomous company",
    status: "active",
    budgetMonthlyCents: 50000,
    organizationId: DEFAULT_ORGANIZATION_ID,
  })
  .returning();

const [chiefOfStaff] = await db
  .insert(agents)
  .values({
    companyId: company!.id,
    name: "Chief of Staff",
    role: "cxo",
    title: "Apex Executive",
    status: "idle",
    adapterType: "process",
    adapterConfig: { command: "echo", args: ["hello from chief of staff"] },
    budgetMonthlyCents: 15000,
  })
  .returning();

const [engineer] = await db
  .insert(agents)
  .values({
    companyId: company!.id,
    name: "Engineer Agent",
    role: "engineer",
    title: "Software Engineer",
    status: "idle",
    reportsTo: chiefOfStaff!.id,
    parentType: "agent",
    parentId: chiefOfStaff!.id,
    adapterType: "process",
    adapterConfig: { command: "echo", args: ["hello from engineer"] },
    budgetMonthlyCents: 10000,
  })
  .returning();

const [goal] = await db
  .insert(goals)
  .values({
    companyId: company!.id,
    title: "Ship first release",
    description: "Deliver first control plane release",
    level: "company",
    status: "active",
    ownerAgentId: chiefOfStaff!.id,
  })
  .returning();

const [project] = await db
  .insert(projects)
  .values({
    companyId: company!.id,
    goalId: goal!.id,
    name: "Control Plane MVP",
    description: "Implement core board + agent loop",
    status: "in_progress",
    leadAgentId: chiefOfStaff!.id,
  })
  .returning();

await db.insert(issues).values([
  {
    companyId: company!.id,
    projectId: project!.id,
    goalId: goal!.id,
    title: "Implement atomic task checkout",
    description: "Ensure in_progress claiming is conflict-safe",
    status: "todo",
    priority: "high",
    assigneeAgentId: engineer!.id,
    createdByAgentId: chiefOfStaff!.id,
  },
  {
    companyId: company!.id,
    projectId: project!.id,
    goalId: goal!.id,
    title: "Add budget auto-pause",
    description: "Pause agent at hard budget ceiling",
    status: "backlog",
    priority: "medium",
    createdByAgentId: chiefOfStaff!.id,
  },
]);

console.log("Seed complete");
process.exit(0);
