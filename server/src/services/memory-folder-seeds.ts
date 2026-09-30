/**
 * Phase 6: maps a department's functionType to a default set of folders that
 * get seeded into memory_folders on creation. This is a static lookup with no
 * DB access, so it can be used by the service layer and UI previews.
 *
 * Virtual folders (Pending Review, Active Goals, Pinned, Working) are NOT in
 * this list; they are computed at query time, not stored.
 */

export interface FolderSeed {
  path: string;          // path segment relative to dept root (e.g. "Decisions")
  displayName: string;
  seedKey: string;       // stable identifier for idempotent creation
  icon?: string;
}

const FILES_ICON = "📁";

const UNIVERSAL_DEPARTMENT_FOLDER_NAMES = [
  "Overview",
  "Plans & Priorities",
  "Decisions",
  "Playbooks",
  "Processes",
  "Policies",
  "References",
  "Metrics",
  "People & Responsibilities",
  "Tools & Systems",
  "Files",
];

function seedKeySegment(path: string): string {
  return path
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function folderSeed(path: string, prefix: string): FolderSeed {
  return {
    path,
    displayName: path,
    seedKey: `${prefix}.${seedKeySegment(path)}`,
    ...(path === "Files" ? { icon: FILES_ICON } : {}),
  };
}

function departmentSeeds(prefix: string, extras: string[] = []): FolderSeed[] {
  return [...UNIVERSAL_DEPARTMENT_FOLDER_NAMES, ...extras].map((path) =>
    folderSeed(path, prefix),
  );
}

const ENGINEERING_SEEDS: FolderSeed[] = departmentSeeds("software_development", [
  "Architecture",
  "Codebase",
  "Releases",
  "Incidents",
  "QA & Testing",
]);

const MARKETING_SEEDS: FolderSeed[] = departmentSeeds("marketing", [
  "Brand",
  "Campaigns",
  "Channels",
  "Audience",
  "Launches",
]);

const FINANCE_SEEDS: FolderSeed[] = departmentSeeds("finance", [
  "Budget",
  "Runway",
  "Reports",
  "Vendors",
  "Compliance",
]);

const SUPPORT_SEEDS: FolderSeed[] = departmentSeeds("customer_support", [
  "Macros",
  "Escalations",
  "Customer Issues",
  "FAQs",
]);

const HR_SEEDS: FolderSeed[] = departmentSeeds("people_ops", [
  "Hiring",
  "Onboarding",
  "Performance",
]);

const LEGAL_SEEDS: FolderSeed[] = departmentSeeds("legal", [
  "Contracts",
  "Compliance",
  "Risk",
  "IP",
]);

const RESEARCH_SEEDS: FolderSeed[] = departmentSeeds("data_analytics", [
  "Findings",
  "Experiments",
  "Sources",
  "Reports",
]);

const OPERATIONS_SEEDS: FolderSeed[] = departmentSeeds("operations", [
  "SOPs",
  "Vendors",
  "Logistics",
]);

const GENERIC_SEEDS: FolderSeed[] = departmentSeeds("generic");

const SEEDS_BY_FUNCTION_TYPE: Record<string, FolderSeed[]> = {
  software_development: ENGINEERING_SEEDS,
  product_management: ENGINEERING_SEEDS,
  marketing: MARKETING_SEEDS,
  sales: MARKETING_SEEDS,
  design: MARKETING_SEEDS,
  finance: FINANCE_SEEDS,
  support: SUPPORT_SEEDS,
  customer_support: SUPPORT_SEEDS,
  hr: HR_SEEDS,
  people_ops: HR_SEEDS,
  legal: LEGAL_SEEDS,
  research: RESEARCH_SEEDS,
  data_analytics: RESEARCH_SEEDS,
  operations: OPERATIONS_SEEDS,
  general: GENERIC_SEEDS,
  custom: GENERIC_SEEDS,
};

export function getSeedFoldersForFunctionType(
  functionType: string | null | undefined,
): FolderSeed[] {
  if (!functionType) return GENERIC_SEEDS;
  return SEEDS_BY_FUNCTION_TYPE[functionType] ?? GENERIC_SEEDS;
}

function companySeed(path: string, icon?: string): FolderSeed {
  const displayName = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  const seedKey = path === "Company"
    ? "company.root"
    : `company.${seedKeySegment(path.slice("Company/".length)).replace(/\//g, "-")}`;
  return { path, displayName, seedKey, ...(icon ? { icon } : {}) };
}

export const COMPANY_SEED_FOLDERS: FolderSeed[] = [
  companySeed("Company", "🏛️"),
  companySeed("Company/Profile"),
  companySeed("Company/Mission & Vision"),
  companySeed("Company/Strategy"),
  companySeed("Company/Operating Principles"),
  companySeed("Company/Brand & Voice"),
  companySeed("Company/Policies"),
  companySeed("Company/People"),
  companySeed("Company/People/Humans"),
  companySeed("Company/People/Teams"),
  companySeed("Company/People/Roles"),
  companySeed("Company/Agents"),
  companySeed("Company/Agents/Directory"),
  companySeed("Company/Agents/Responsibilities"),
  companySeed("Company/Agents/Agent Teams"),
  companySeed("Company/Decisions"),
  companySeed("Company/Processes"),
  companySeed("Company/References"),
  companySeed("Company/Files", FILES_ICON),
];
