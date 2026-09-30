import type { AgentRole, AgentStatus, CatalogItem } from "@armyofagents/shared";
import type { CascadeStepResult } from "@armyofagents/db";

/**
 * Request shape for POST /api/marketplace/install.
 * Permanent — see decision M2.D11 (no overrides field).
 */
export interface InstallRequest {
  catalogItemId: string;
  targetDepartmentId?: string;     // required for snapshot installs, ignored for plugins
  idempotencyKey?: string;         // optional retry-safety token (24h app-enforced window)
  role?: AgentRole;                // optional agent install override
  adapterType?: string;            // optional agent install override
}

export interface PackageInstallRequest {
  packageId: string;
  catalogItemIds: string[];
  idempotencyKey?: string;
}

export type MarketplaceInstallRequest = InstallRequest | PackageInstallRequest;

export interface AgentInstallOverrides {
  role?: AgentRole;
  adapterType?: string;
}

/**
 * Result of resolving a catalog item to its install plan.
 * Returned by GET /api/marketplace/resolve/:catalogItemId for UI confirmation.
 */
export interface InstallPlan {
  rootItem: CatalogItem;
  steps: InstallPlanStep[];
  conflicts: ConflictWarning[];
  agentInstall?: AgentInstallPreview;
}

export interface AgentInstallPreview {
  suggestedRole: AgentRole;
  supportedRoles: AgentRole[];
  suggestedAdapterType: string;
  supportedAdapterTypes: string[];
  availableAdapterTypes: string[];
  setupRequired: boolean;
  setupRequirements: AgentSetupRequirement[];
  warnings: string[];
}

export interface InstallPlanStep {
  catalogItemId: string;
  itemType: "plugin" | "skill" | "agent" | "team";
  name: string;
  version: string;
  action:
    | "install-new"             // not yet present, will be installed
    | "skip-already-installed"  // already present at same version, no-op
    | "fail-version-mismatch";  // present at different version, V1 fails-fast
  reason?: string;              // human-readable explanation
}

export interface ConflictWarning {
  catalogItemId: string;
  kind: "name-collision" | "adapter-mismatch" | "model-unavailable";
  detail: string;
  resolution: "auto-suffix" | "fail-fast" | "warn-and-proceed";
}

export interface InstallContext {
  companyId: string;
  targetDepartmentId?: string;
  requestedByUserId: string;
  idempotencyKey?: string;
}

/** AoA-specific trigger binding in agent.json. Seeded into aoa_agent_triggers at install. */
export interface AgentAoaTrigger {
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** AoA hints section inside agent.json. All fields optional. */
export interface AgentAoaHints {
  adapterType?: string;
  runtimeConfig?: Record<string, unknown>;
  adapterConfig?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  skillKeys?: string[];
  /** Agent kind stored in agents.kind at install time. "aoa" for crew agents. */
  kind?: string;
  /** Triggers seeded into aoa_agent_triggers within the Phase 3 txn. */
  triggers?: AgentAoaTrigger[];
}

/**
 * Wire format the catalog aggregator produces for agent.json (agent.v1 schema).
 * Mirrored here as a local source-of-truth for the AoA install pipeline.
 * The `aoa` section carries AoA-specific install hints; legacy flat fields
 * remain for backward compat with pre-aoa-section agent templates.
 */
export interface AgentTemplateBody {
  schemaVersion?: string;
  id?: string;
  name?: string;
  description?: string;
  instructions?: { type: "inline"; content: string } | { type: "file"; path: string };
  dependencies?: {
    skills?: Record<string, string>;
    plugins?: Record<string, string>;
  };
  /** AoA-specific install hints. Takes precedence over legacy flat fields. */
  aoa?: AgentAoaHints;
  // Legacy flat fields — used when `aoa` section is absent (pre-v1.1 templates).
  role?: string;
  title?: string;
  icon?: string;
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  skillKeys?: string[];
  capabilities?: string;
  budgetMonthlyCents?: number;
}

export interface AgentSetupRequirement {
  kind: "secret" | "plugin_config";
  key: string;
  label?: string;
  required: boolean;
  reason: string;
  usedBy?: string;
}

export interface NormalizedMarketplaceAgentTemplate {
  name: string;
  role: AgentRole | string;
  /** "org" = heartbeat-driven (default). "aoa" = trigger-driven crew agent. */
  kind: "org" | "aoa";
  /**
   * Trigger rows to materialise in aoa_agent_triggers on install.
   * `enabled` mirrors the catalog's `aoa.triggers[].enabled` (default `true`
   * when the template omits it) and is written straight to the column — a
   * trigger the catalog disabled must not install, or update, as enabled.
   */
  triggers: Array<{ kind: string; enabled: boolean; config: Record<string, unknown> }>;
  title?: string | null;
  icon?: string | null;
  status: AgentStatus;
  capabilities?: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  permissions: Record<string, unknown>;
  budgetMonthlyCents: number;
  skillKeys: string[];
  instructions:
    | { type: "inline"; files: Record<string, string>; entryFile: string }
    | { type: "file"; path: string; entryFile: string }
    | { type: "bundle"; files: string[]; entryFile: string };
  setupRequirements: AgentSetupRequirement[];
  setupRequired: boolean;
  metadata: Record<string, unknown>;
  warnings: string[];
}

export type { CascadeStepResult };
