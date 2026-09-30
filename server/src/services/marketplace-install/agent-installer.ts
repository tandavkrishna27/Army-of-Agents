import type { Db } from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";
import {
  createMarketplaceAgent,
  type AgentInstructionsServiceLike,
} from "./agent-create.js";
import {
  normalizeMarketplaceAgentTemplate,
  parseMarketplaceAgentTemplate,
} from "./agent-runtime.js";
import { fetchCatalogResource } from "./fetch-resource.js";
import type { AgentInstallOverrides } from "./types.js";

export interface InstallAgentOpts {
  catalogItem: CatalogItem;
  companyId: string;
  db: Db;
  desiredName: string;
  overrides?: AgentInstallOverrides;
  availableAdapterTypes?: string[];
  instructionsService?: AgentInstructionsServiceLike;
}

export interface InstallAgentResult {
  agentId: string;
}

/**
 * Install an agent catalog item into a company's agents table.
 *
 * Supports both legacy flat agent templates and the marketplace `agent.v1`
 * runtime contract. `agent.v1` templates may materialize managed instruction
 * bundles when an instructions service is provided.
 *
 * Required dependencies are installed by the orchestrator before this function
 * creates the agent row.
 */
export async function installAgent(opts: InstallAgentOpts): Promise<InstallAgentResult> {
  const { catalogItem, companyId, db, desiredName } = opts;

  if (catalogItem.type !== "agent") {
    throw new Error(`installAgent called with non-agent item: ${catalogItem.id}`);
  }

  const bodyText = await fetchCatalogResource(catalogItem, "agent template");
  const parsed = parseMarketplaceAgentTemplate(bodyText, catalogItem);
  const template = normalizeMarketplaceAgentTemplate({
    parsed,
    catalogItem,
    availableAdapterTypes: opts.availableAdapterTypes ?? [],
    overrides: opts.overrides,
  });

  return createMarketplaceAgent({
    catalogItem,
    companyId,
    db,
    desiredName,
    template,
    instructionsService: opts.instructionsService,
  });
}
