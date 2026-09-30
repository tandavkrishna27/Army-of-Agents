/**
 * @fileoverview Server-side install defaults for CREW agents (`kind: "aoa"`) — T2.3e.
 *
 * **Why this is not in the catalog.** Two facts a published `agent.v1` artifact
 * cannot carry:
 *
 * 1. **Status.** `agent.v1`'s `install.defaultStatus` enum is
 *    `active | paused | terminated` — it cannot express `idle` at all, which is
 *    what the legacy seeder writes (`seed-crew-agent.ts:103`) and what every
 *    crew execution path expects. With no `install` block the normalizer
 *    returned `"paused"`, and `dispatcher.ts:594`
 *    (`notInArray(agents.status, ["paused","terminated"])`), `triggers.ts:74`
 *    and all four sweeps exclude paused — so the install succeeded, the UI
 *    showed a crew, and nothing ever ran.
 * 2. **Adapter.** Which CLI a crew agent runs on is *per-company runtime state*
 *    (`internal_agent_config.provider` → {@link resolveCrewAdapterForCompany}).
 *    No published artifact can know it. The published bodies declare
 *    `adapterType: "process"` with no `adapterConfig`, and a `process` row
 *    without a `command` throws "Process adapter missing command" at dispatch
 *    (`adapters/process/execute.ts:16`).
 *
 * T2.5's rationale already establishes the shape of this answer: whether an
 * agent is essential to AoA is "an AoA fact, not catalog metadata". How a crew
 * agent must be configured in order to run is the same kind of fact.
 *
 * **Scope.** Applied ONLY to `kind === "aoa"`. Catalog `install` hints and
 * catalog adapters are still honoured verbatim for `kind: "org"` agents.
 */

import type { AgentStatus } from "@armyofagents/shared";
import type { NormalizedMarketplaceAgentTemplate } from "./types.js";
import {
  mergeCrewAdapterConfig,
  type CrewAdapter,
} from "../internal-agent/aoa-agents/resolve-crew-adapter.js";

/**
 * The status a freshly installed crew agent gets — identical to what
 * `seedCrewAgent` writes, so a marketplace-installed company and a
 * legacy-seeded (later adopted) one converge on the same runnable state.
 */
export const CREW_INSTALL_STATUS: AgentStatus = "idle";

/** Is this normalized template an AoA crew agent? */
export function isCrewTemplate(template: NormalizedMarketplaceAgentTemplate): boolean {
  return (template.kind ?? "org") === "aoa";
}

/**
 * Overlay the crew install defaults onto a normalized template.
 *
 * - **status** → {@link CREW_INSTALL_STATUS}, *unless* the template declares an
 *   unmet required setup requirement. That case keeps the normalizer's
 *   `"paused"`: an agent that provably cannot run yet must not be installed
 *   dispatchable. (No published crew agent declares one today.)
 * - **adapter** → the company's resolved crew adapter. Merged through
 *   {@link mergeCrewAdapterConfig}, so the catalog's own provider-specific keys
 *   cannot leak into a different CLI while provider-neutral ones (`cwd`, `env`,
 *   `instructions*`) survive — the same rule the seeder's backfill applies.
 *
 * Pure: takes an already-resolved adapter rather than reaching for the db, so
 * the caller owns the single `internal_agent_config` read.
 */
export function applyCrewInstallDefaults(
  template: NormalizedMarketplaceAgentTemplate,
  crewAdapter: CrewAdapter,
): NormalizedMarketplaceAgentTemplate {
  return {
    ...template,
    status: template.setupRequired ? template.status : CREW_INSTALL_STATUS,
    adapterType: crewAdapter.adapterType,
    adapterConfig: mergeCrewAdapterConfig(
      template.adapterConfig,
      crewAdapter.adapterConfig,
      template.adapterType,
      crewAdapter.adapterType,
    ),
  };
}
