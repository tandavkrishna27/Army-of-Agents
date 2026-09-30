import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agentProjects, agents, memoryItems } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import type { RuntimeSkillEntry } from "./company-skills.js";

const log = logger.child({ service: "memory-skill-sync" });

/**
 * Synthesize a `company-knowledge` skill from founder-pinned
 * memory items, materialized into the agent's skill bundle alongside the
 * existing aoa + para-memory-files + team-coordinations skills.
 *
 * This is the "Tier 1 push" path of the agent memory architecture: a small,
 * curated set of always-on knowledge eagerly delivered to the agent on every
 * run. Tier 2 (semantic search via memory.search MCP) handles the long tail.
 *
 * Resolution algorithm (per the memoryProfile.pinnedSkillItems shape locked
 * in Phase 0 — packages/shared/src/validators/memory.ts):
 *
 *   if profile.inheritFromDepartment (default true):
 *     baseline = memory_items where:
 *       - companyId = caller
 *       - status = 'approved'
 *       - pinnedToSkill = true
 *       - departmentId IN agent's projects  OR  departmentId IS NULL
 *         (NULL = company-level pin, reaches all agents)
 *   else:
 *     baseline = []
 *
 *   additions[] — agent-specific items added on top (must still be approved)
 *   removals[] — agent-specific suppressions
 *
 *   final = (baseline ∪ additions) \ removals
 *
 * The skill is one synthesized markdown file with sections grouped by
 * category, prefixed with YAML frontmatter so the CLI's skill-discovery
 * mechanism registers it correctly. Founder-edited content does NOT need
 * frontmatter — we synthesize it.
 *
 * Failure mode: returns [] on any error. Heartbeat hook is wrapped in
 * try/catch, so a sync failure never breaks the agent run.
 */
export async function buildPinnedMemorySkillEntries(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<RuntimeSkillEntry[]> {
  // 1. Read agent's memoryProfile.pinnedSkillItems config from runtimeConfig.
  //    The shape is reserved in Phase 0 (memoryProfileSchema); missing or
  //    partial config falls back to defaults (inherit + no additions/removals).
  const agentRow = await db
    .select({ runtimeConfig: agents.runtimeConfig })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);

  if (!agentRow) return [];

  const profile = readPinnedSkillProfile(agentRow.runtimeConfig);

  // 2. Build baseline from department-pinned items (when inheriting).
  let baseline: PinnedMemoryRow[] = [];
  if (profile.inheritFromDepartment) {
    const projectRows = await db
      .select({ projectId: agentProjects.projectId })
      .from(agentProjects)
      .where(eq(agentProjects.agentId, agentId));
    const projectIds = projectRows.map((row) => row.projectId);

    // departmentId IS NULL acts as a company-wide pin (reaches every agent).
    // departmentId IN agent's projects reaches department-scoped agents only.
    const scopeClause =
      projectIds.length > 0
        ? or(isNull(memoryItems.departmentId), inArray(memoryItems.departmentId, projectIds))
        : isNull(memoryItems.departmentId);

    baseline = await db
      .select({
        id: memoryItems.id,
        title: memoryItems.title,
        content: memoryItems.content,
        category: memoryItems.category,
        layer: memoryItems.layer,
        departmentId: memoryItems.departmentId,
      })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.companyId, companyId),
          eq(memoryItems.status, "approved"),
          eq(memoryItems.pinnedToSkill, true),
          // A-M5: never pin expired active_context into the agent skill bundle.
          // Only active_context sets expiresAt; isNull keeps all other layers.
          or(isNull(memoryItems.expiresAt), gt(memoryItems.expiresAt, sql`now()`))!,
          scopeClause!,
        ),
      );
  }

  // 3. Apply additions — fetch additional items by id (must still be approved
  //    and belong to this company; cross-company additions silently dropped).
  let additions: PinnedMemoryRow[] = [];
  if (profile.additions.length > 0) {
    additions = await db
      .select({
        id: memoryItems.id,
        title: memoryItems.title,
        content: memoryItems.content,
        category: memoryItems.category,
        layer: memoryItems.layer,
        departmentId: memoryItems.departmentId,
      })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.companyId, companyId),
          eq(memoryItems.status, "approved"),
          // A-M5: an expired active_context item added by id must not leak either.
          or(isNull(memoryItems.expiresAt), gt(memoryItems.expiresAt, sql`now()`))!,
          inArray(memoryItems.id, profile.additions),
        ),
      );
  }

  // 4. Merge baseline + additions, dedup by id, then subtract removals.
  const merged = new Map<string, PinnedMemoryRow>();
  for (const row of baseline) merged.set(row.id, row);
  for (const row of additions) merged.set(row.id, row);
  for (const id of profile.removals) merged.delete(id);

  if (merged.size === 0) return [];

  // 5. Render markdown grouped by category, with stable ordering (alpha within
  //    each category). Stability matters for skill-content hashing: identical
  //    inputs → identical markdown → CLI's skill-cache stays valid.
  const items = [...merged.values()];
  const markdown = renderPinnedSkillMarkdown(items);

  log.info(
    { companyId, agentId, itemCount: items.length },
    "Synthesized company-knowledge skill from pinned memory items",
  );

  return [
    {
      key: "company-knowledge",
      name: "Company Knowledge",
      markdown,
      trustLevel: "trusted",
    },
  ];
}

// ── Internal helpers ────────────────────────────────────────────────────

interface PinnedMemoryRow {
  id: string;
  title: string;
  content: string;
  category: string;
  layer: string | null;
  departmentId: string | null;
}

interface PinnedSkillProfile {
  inheritFromDepartment: boolean;
  additions: string[];
  removals: string[];
}

const DEFAULT_PROFILE: PinnedSkillProfile = {
  inheritFromDepartment: true,
  additions: [],
  removals: [],
};

/**
 * Extract the pinnedSkillItems config from agent.runtimeConfig.
 * Tolerates missing fields — every property has a safe default.
 */
function readPinnedSkillProfile(runtimeConfig: unknown): PinnedSkillProfile {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return DEFAULT_PROFILE;
  const memoryProfile = (runtimeConfig as Record<string, unknown>).memoryProfile;
  if (!memoryProfile || typeof memoryProfile !== "object") return DEFAULT_PROFILE;
  const pinnedSkillItems = (memoryProfile as Record<string, unknown>).pinnedSkillItems;
  if (!pinnedSkillItems || typeof pinnedSkillItems !== "object") return DEFAULT_PROFILE;

  const obj = pinnedSkillItems as Record<string, unknown>;
  const inherit =
    typeof obj.inheritFromDepartment === "boolean"
      ? obj.inheritFromDepartment
      : DEFAULT_PROFILE.inheritFromDepartment;
  const additions = Array.isArray(obj.additions)
    ? (obj.additions as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const removals = Array.isArray(obj.removals)
    ? (obj.removals as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  return { inheritFromDepartment: inherit, additions, removals };
}

const FRONTMATTER = [
  "---",
  "name: company-knowledge",
  "description: >",
  "  Pinned company knowledge for this agent — vision, brand voice, conventions,",
  "  procedures, and other long-lived knowledge the founder has marked as",
  "  always-on. Read this whenever you need to align with company standards.",
  "  For dynamic lookups beyond pinned items, use the AoA memory MCP tools",
  "  (memory.search, memory.get, memory.retain).",
  "---",
  "",
].join("\n");

/**
 * Render the pinned items as a single markdown skill body.
 *
 * Grouping: by category (decision / preference / procedure / policy /
 * reference / context / insight). Within a group, sort alphabetically by
 * title for stable output.
 *
 * Format: H2 per category, H3 per item, body verbatim.
 */
export function renderPinnedSkillMarkdown(items: PinnedMemoryRow[]): string {
  if (items.length === 0) return FRONTMATTER + "# Company Knowledge\n\n(no pinned items)\n";

  const byCategory = new Map<string, PinnedMemoryRow[]>();
  for (const item of items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  // Stable category ordering — preferred first, then alpha. Categories
  // without a known position fall through to the alpha tail.
  const categoryOrder = [
    "policy",
    "decision",
    "preference",
    "procedure",
    "reference",
    "context",
    "insight",
  ];
  const sortedCategories = [...byCategory.keys()].sort((a, b) => {
    const ai = categoryOrder.indexOf(a);
    const bi = categoryOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const parts: string[] = [FRONTMATTER, "# Company Knowledge", ""];

  for (const category of sortedCategories) {
    parts.push(`## ${capitalize(category)}`, "");
    const categoryItems = byCategory.get(category)!.slice().sort((a, b) =>
      a.title.localeCompare(b.title),
    );
    for (const item of categoryItems) {
      parts.push(`### ${item.title}`, "");
      parts.push(item.content.trim(), "");
    }
  }

  return parts.join("\n");
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
