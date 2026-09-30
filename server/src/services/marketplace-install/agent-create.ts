import { and, eq, or } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, aoaAgentTriggers } from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";
import { deriveSiblingResourceUrl } from "./agent-runtime.js";
import { fetchCatalogResourceUrl } from "./fetch-resource.js";
import { applyCrewInstallDefaults, isCrewTemplate } from "./crew-install-defaults.js";
import {
  acquireCrewRepairAdvisoryLock,
  adoptLegacyCrewAgentPointer,
} from "./crew-adoption.js";
import { STEWARD_CATALOG_ITEM_ID } from "./crew-constants.js";
import { resolveCrewAdapterForCompany } from "../internal-agent/aoa-agents/resolve-crew-adapter.js";
import type { NormalizedMarketplaceAgentTemplate } from "./types.js";

export interface AgentInstructionsServiceLike {
  materializeManagedBundle(
    agent: {
      id: string;
      companyId: string;
      name: string;
      role: string;
      adapterType: string;
      adapterConfig: unknown;
    },
    files: Record<string, string>,
    options?: {
      clearLegacyPromptTemplate?: boolean;
      replaceExisting?: boolean;
      entryFile?: string;
    },
  ): Promise<{ adapterConfig: Record<string, unknown> }>;
}

export async function loadMarketplaceInstructionFiles(
  catalogItem: CatalogItem,
  template: NormalizedMarketplaceAgentTemplate,
): Promise<{ files: Record<string, string>; entryFile: string } | null> {
  if (template.instructions.type === "inline") {
    return { files: template.instructions.files, entryFile: template.instructions.entryFile };
  }

  if (template.instructions.type === "file") {
    const url = deriveSiblingResourceUrl(catalogItem, template.instructions.path);
    return {
      files: {
        [template.instructions.entryFile]: await fetchCatalogResourceUrl(url, "agent instructions"),
      },
      entryFile: template.instructions.entryFile,
    };
  }

  const entries = await Promise.all(
    template.instructions.files.map(async (file) => {
      const url = deriveSiblingResourceUrl(catalogItem, file);
      return [file, await fetchCatalogResourceUrl(url, `agent instruction file ${file}`)] as const;
    }),
  );
  return { files: Object.fromEntries(entries), entryFile: template.instructions.entryFile };
}

export async function createMarketplaceAgent(opts: {
  catalogItem: CatalogItem;
  companyId: string;
  db: Db;
  desiredName: string;
  template: NormalizedMarketplaceAgentTemplate;
  instructionsService?: AgentInstructionsServiceLike;
  /** Team installation may adopt the pre-catalog built-in Steward in place. */
  adoptLegacySteward?: boolean;
}): Promise<{ agentId: string }> {
  const { catalogItem, companyId, db, desiredName, instructionsService } = opts;

  // T2.3e — the single chokepoint where a marketplace agent row is born, and
  // therefore the one place the crew defaults can be applied without a caller
  // being able to forget them. `installTeam`, `installAgent` and
  // `reconcileTeamMembers` all route through here.
  //
  // Crew status + adapter are AoA facts the catalog cannot express; see
  // `crew-install-defaults.ts`. Non-crew (`kind: "org"`) templates are passed
  // through untouched, so catalog `install` hints still apply to them.
  const template = isCrewTemplate(opts.template)
    ? applyCrewInstallDefaults(opts.template, await resolveCrewAdapterForCompany(db, companyId))
    : opts.template;

  const instructions = instructionsService
    ? await loadMarketplaceInstructionFiles(catalogItem, template)
    : null;

  return db.transaction(async (tx) => {
    if (catalogItem.id === STEWARD_CATALOG_ITEM_ID) {
      if (template.kind !== "aoa") {
        throw new Error("Catalog Steward must normalize to kind='aoa'");
      }
      const lockedDb = tx as unknown as Db;
      await acquireCrewRepairAdvisoryLock(lockedDb, companyId);
      const existingStewardRows = await tx
        .select({
          id: agents.id,
          kind: agents.kind,
          name: agents.name,
          templateOrigin: agents.templateOrigin,
        })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            or(
              eq(agents.templateOrigin, STEWARD_CATALOG_ITEM_ID),
              and(eq(agents.kind, "aoa"), eq(agents.name, "Steward")),
            ),
          ),
        )
        .limit(2);
      if (existingStewardRows.length > 0) {
        const existing = existingStewardRows[0];
        if (
          opts.adoptLegacySteward === true &&
          existingStewardRows.length === 1 &&
          existing.kind === "aoa" &&
          existing.templateOrigin === STEWARD_CATALOG_ITEM_ID
        ) {
          return { agentId: existing.id };
        }
        if (
          opts.adoptLegacySteward === true &&
          existingStewardRows.length === 1 &&
          existing.kind === "aoa" &&
          existing.name === "Steward" &&
          existing.templateOrigin === null
        ) {
          const adopted = await adoptLegacyCrewAgentPointer(lockedDb, {
            companyId,
            agentId: existing.id,
            expectedName: existing.name,
            expectedTemplateOrigin: null,
            templateOrigin: STEWARD_CATALOG_ITEM_ID,
          });
          if (!adopted) {
            throw new Error(
              "Steward changed before team installation could adopt it; retry the install",
            );
          }
          return { agentId: existing.id };
        }
        throw new Error(
          "Steward already exists for this company; reconcile or update the existing protected agent",
        );
      }
    }

    const inserted = await tx
      .insert(agents)
      .values({
        companyId,
        name: desiredName,
        // D1 (T3.2): propagate kind from template so crew agents land as kind='aoa'.
        // Defaults to 'org' for all legacy/org-kind templates.
        kind: template.kind ?? "org",
        role: template.role,
        title: template.title,
        icon: template.icon,
        status: template.status,
        capabilities: template.capabilities,
        adapterType: template.adapterType,
        adapterConfig: template.adapterConfig,
        runtimeConfig: template.runtimeConfig,
        permissions: template.permissions,
        budgetMonthlyCents: template.budgetMonthlyCents,
        skillKeys: template.skillKeys,
        templateOrigin: catalogItem.id,
        templateVersion: catalogItem.version,
        // D22: a row this function just minted has, by construction, never been
        // edited — everything in it came from the catalog template. This is the
        // one place that can honestly assert `false`, and asserting it here is
        // what keeps freshly-installed agents inside the auto-update path.
        // (Rows NOT written by this function stay NULL = unknown = fail closed.)
        instructionsCustomized: false,
        metadata: template.metadata,
      })
      .returning();

    const agent = inserted[0];

    // Materialise any aoa_agent_triggers rows declared in the template.
    // `enabled` comes from the catalog (T2.3d) — the normalizer defaults it to
    // `true` when the template omits it, so a trigger the catalog explicitly
    // disabled is never installed as enabled.
    // Only executed when there are triggers to insert (org-kind agents have []).
    for (const trigger of template.triggers ?? []) {
      await tx.insert(aoaAgentTriggers).values({
        companyId,
        agentId: agent.id,
        kind: trigger.kind,
        enabled: trigger.enabled,
        config: trigger.config,
      });
    }

    if (instructions && instructionsService) {
      const materialized = await instructionsService.materializeManagedBundle(
        agent,
        instructions.files,
        {
          entryFile: instructions.entryFile,
          replaceExisting: true,
          clearLegacyPromptTemplate: true,
        },
      );

      await tx
        .update(agents)
        .set({ adapterConfig: materialized.adapterConfig, updatedAt: new Date() })
        .where(eq(agents.id, agent.id));
    }

    return { agentId: agent.id };
  });
}
