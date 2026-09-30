import { eq, and } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { plugins, agents, companySkills, teams } from "@armyofagents/db";
import { AGENT_ROLES } from "@armyofagents/shared";
import type {
  CatalogItem,
  MarketplaceCatalogFile,
} from "@armyofagents/shared";
import type { AgentInstallPreview, InstallPlan, InstallPlanStep, ConflictWarning } from "./types.js";
import { fetchCatalogResource } from "./fetch-resource.js";
import { ADOPTED_TEMPLATE_VERSION } from "./crew-constants.js";
import {
  normalizeMarketplaceAgentTemplate,
  parseMarketplaceAgentTemplate,
} from "./agent-runtime.js";

interface ResolveOpts {
  catalogItemId: string;
  catalog: MarketplaceCatalogFile;
  db: Db;
  companyId: string;
  availableAdapterTypes?: string[];
}

/**
 * Resolve a catalog item to its full install plan including cascade dependencies.
 *
 * Pure function (modulo DB reads for "already installed?" detection).
 * Does NOT mutate state.
 *
 * @throws Error if catalogItemId is not in the catalog or a required dependency is missing.
 */
export async function resolveInstallPlan(opts: ResolveOpts): Promise<InstallPlan> {
  const { catalogItemId, catalog, db, companyId } = opts;

  const itemsById = new Map(catalog.items.map((i) => [i.id, i]));
  const root = itemsById.get(catalogItemId);
  if (!root) {
    throw new Error(`Catalog item not found: ${catalogItemId}`);
  }

  // BFS through requires graph
  const visited = new Set<string>();
  const orderedItems: CatalogItem[] = [];
  const queue: CatalogItem[] = [root];

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    orderedItems.push(item);

    if (item.requires) {
      for (const req of item.requires) {
        const required = itemsById.get(req.id);
        if (!required) {
          throw new Error(`Required catalog item not found: ${req.id} (required by ${item.id})`);
        }
        if (!visited.has(required.id)) queue.push(required);
      }
    }
  }

  // Reverse so dependencies come first, root last
  orderedItems.reverse();

  // For each item, query DB to determine action (install-new / skip / fail)
  const steps: InstallPlanStep[] = [];
  for (const item of orderedItems) {
    const action = await classifyAction({ item, db, companyId });
    steps.push({
      catalogItemId: item.id,
      itemType: item.type,
      name: item.name,
      version: item.version,
      action: action.action,
      reason: action.reason,
    });
  }

  // Conflicts are computed inline by classifyAction; aggregate any warnings here
  const conflicts: ConflictWarning[] = [];
  // (V1: name-collision conflicts surface during install via auto-suffix; resolver doesn't pre-check names)

  const agentInstall = root.type === "agent"
    ? await resolveAgentInstallPreview({
      root,
      availableAdapterTypes: opts.availableAdapterTypes ?? [],
    })
    : undefined;

  if (agentInstall) {
    return { rootItem: root, steps, conflicts, agentInstall };
  }
  return { rootItem: root, steps, conflicts };
}

async function resolveAgentInstallPreview(opts: {
  root: CatalogItem;
  availableAdapterTypes: string[];
}): Promise<AgentInstallPreview> {
  const bodyText = await fetchCatalogResource(opts.root, "agent template");
  const parsed = parseMarketplaceAgentTemplate(bodyText, opts.root);
  const normalized = normalizeMarketplaceAgentTemplate({
    parsed,
    catalogItem: opts.root,
    availableAdapterTypes: opts.availableAdapterTypes,
  });

  const runtime = parsed.kind === "agent.v1" ? parsed.runtime : undefined;
  const supportedAdapterTypes =
    runtime?.aoa?.adapterCompatibility?.supported ??
    (normalized.adapterType ? [normalized.adapterType] : []);

  return {
    suggestedRole:
      normalized.role === "cxo" || normalized.role === "lead" || normalized.role === "general"
        ? normalized.role
        : "general",
    supportedRoles: [...AGENT_ROLES],
    suggestedAdapterType: normalized.adapterType,
    supportedAdapterTypes,
    availableAdapterTypes: opts.availableAdapterTypes,
    setupRequired: normalized.setupRequired,
    setupRequirements: normalized.setupRequirements,
    warnings: normalized.warnings,
  };
}

interface ClassifyResult {
  action: InstallPlanStep["action"];
  reason?: string;
}

export async function classifyAction(opts: {
  item: CatalogItem;
  db: Db;
  companyId: string;
}): Promise<ClassifyResult> {
  const { item, db, companyId } = opts;

  if (item.type === "plugin") {
    if (!item.npm) {
      throw new Error(`Catalog defect: plugin item ${item.id} missing required 'npm' field`);
    }
    // Plugins are instance-scoped (no companyId column) — see packages/db/src/schema/plugins.ts.
    // Idempotency check is global: is this packageName installed anywhere in the instance?
    const existing = await db
      .select()
      .from(plugins)
      .where(
        and(
          eq(plugins.companyId, companyId),
          eq(plugins.packageName, item.npm.packageName),
        ),
      )
      .limit(1);
    if (existing.length === 0) return { action: "install-new" };
    if (existing[0].version === item.npm.version) {
      return { action: "skip-already-installed", reason: `Already installed at ${item.npm.version}` };
    }
    return {
      action: "fail-version-mismatch",
      reason: `Installed version ${existing[0].version} differs from catalog ${item.npm.version}; M.4 will add update flow`,
    };
  }

  if (item.type === "skill") {
    const existing = await db
      .select()
      .from(companySkills)
      .where(
        and(
          eq(companySkills.companyId, companyId),
          eq(companySkills.sourceType, "catalog"),
          eq(companySkills.sourceLocator, item.id),
        ),
      )
      .limit(1);
    if (existing.length === 0) return { action: "install-new" };
    if (existing[0].sourceRef === item.version) {
      return { action: "skip-already-installed", reason: `Already installed at ${item.version}` };
    }
    return {
      action: "fail-version-mismatch",
      reason: `Installed version ${existing[0].sourceRef} differs from catalog ${item.version}`,
    };
  }

  if (item.type === "agent") {
    const existing = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.templateOrigin, item.id)))
      .limit(1);
    if (existing.length === 0) return { action: "install-new" };
    if (existing[0].templateVersion === item.version) {
      return { action: "skip-already-installed", reason: `Already installed at ${item.version}` };
    }
    // T2.3b: an ADOPTED row carries the `0.0.0-legacy` sentinel — it is
    // marketplace-managed but still holds pre-catalog content. Refusing the
    // install is correct (a second row would duplicate the agent), but the
    // generic "version differs" copy reads like a bug rather than the expected
    // state it is, so it gets its own sentence.
    if (existing[0].templateVersion === ADOPTED_TEMPLATE_VERSION) {
      return {
        action: "fail-version-mismatch",
        reason:
          `This company already has ${item.id}: an existing agent was reconnected to the ` +
          "marketplace and is waiting for its first catalog update. Apply that update instead " +
          "of installing a second copy.",
      };
    }
    return {
      action: "fail-version-mismatch",
      reason: `Installed version ${existing[0].templateVersion} differs from catalog ${item.version}`,
    };
  }

  if (item.type === "team") {
    const existing = await db
      .select()
      .from(teams)
      .where(and(eq(teams.companyId, companyId), eq(teams.templateOrigin, item.id)))
      .limit(1);
    if (existing.length === 0) return { action: "install-new" };
    if (existing[0].templateVersion === item.version) {
      return { action: "skip-already-installed", reason: `Already installed at ${item.version}` };
    }
    return {
      action: "fail-version-mismatch",
      reason: `Installed version ${existing[0].templateVersion} differs from catalog ${item.version}`,
    };
  }

  // Should be unreachable if catalog schema is enforced
  throw new Error(`Unknown item type: ${(item as { type: string }).type} (item id: ${item.id})`);
}
