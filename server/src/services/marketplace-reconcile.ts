import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  activityLog,
  companies,
  companySkills,
  marketplaceInstallOperations,
  marketplaceCompanySettings,
  marketplaceReconciliationOperations,
  teamMembers,
  type MarketplaceReconciliationOperationState,
} from "@armyofagents/db";
import {
  MARKETPLACE_RECOVERY,
  MarketplaceReconciliationInspectionSchema,
  MarketplaceReconcileResponseSchema,
  MARKETPLACE_SETTINGS_DEFAULTS,
  type CatalogItem,
  type CatalogSyncStatus,
  type MarketplaceCatalogFile,
  type MarketplaceMaintenanceStage as SharedMarketplaceMaintenanceStage,
  type MarketplaceReconcileDiagnostic,
  type MarketplaceReconcileDiagnosticCode,
  type MarketplaceReconcileFailure,
  type MarketplaceReconcileFailureCode,
  type MarketplaceReconcileSkip,
  type MarketplaceReconciliationInspection,
  type MarketplaceReconcileResponse,
  type MarketplaceSettings,
} from "@armyofagents/shared";
import { logger } from "../middleware/logger.js";
import { agentInstructionsService } from "./agent-instructions.js";
import type { AgentInstructionsServiceLike } from "./marketplace-install/agent-create.js";
import { checkCrewUpdates } from "./marketplace-install/crew-updater.js";
import {
  reconcileTeamMembers,
  type ReconcileTeamMembersResult,
} from "./marketplace-install/team-reconcile.js";
import {
  diagnoseCrewProvisioning,
  runCrewRepairPass,
  type CrewRepairDiagnosis,
  type CrewRepairPassResult,
  type CrewRepairPassSkip,
} from "./crew-repair.js";
import {
  runLegacyStewardReconcilePass,
  type LegacyStewardReconcilePassResult,
} from "./marketplace-install/legacy-steward-reconcile.js";
import type { MarketplaceCatalogService } from "./aoa-marketplace.js";
import { sha256Digest } from "./feedback-redaction.js";
import { runUpdateCheck } from "./marketplace-update-checker.js";
import { withMarketplaceUpdateLock } from "./marketplace-update-coordinator.js";
import { serializeSafeError } from "./safe-error.js";

export type MarketplaceMaintenanceStage = SharedMarketplaceMaintenanceStage;
export type MarketplaceMaintenanceFailure = MarketplaceReconcileFailure;

export interface MarketplaceMaintenanceResult {
  companiesExamined: number;
  crewRepair: CrewRepairPassResult;
  legacySteward: LegacyStewardReconcilePassResult;
  crewUpdates: {
    succeeded: number;
    failed: number;
  };
  teamReconcile: ReconcileTeamMembersResult;
  failures: MarketplaceMaintenanceFailure[];
}

export type MarketplaceReconcileResult = Omit<
  MarketplaceReconcileResponse,
  "ok" | "replayed" | "executionDisposition"
>;

export interface MarketplaceMaintenanceDeps {
  listCompanyIds: (db: Db) => Promise<readonly string[]>;
  loadSettings: (db: Db, companyId: string) => Promise<MarketplaceSettings>;
  runCrewRepair: typeof runCrewRepairPass;
  runLegacyStewardReconcile: typeof runLegacyStewardReconcilePass;
  checkCrewUpdates: typeof checkCrewUpdates;
  reconcileTeamMembers: typeof reconcileTeamMembers;
}

export interface RunMarketplaceMaintenanceOptions {
  db: Db;
  catalogItems: CatalogItem[];
  /**
   * A manual caller may snapshot the fleet before writing its start audit and
   * pass that exact target set here. Scheduled callers continue to discover
   * companies inside the serialized maintenance pass.
   */
  companyIds?: readonly string[];
  instructionsService?: AgentInstructionsServiceLike;
  /**
   * Manual recovery processes the whole fleet and uses the guarded force path.
   * Boot/interval callers retain the existing bounded pass and cooldown.
   */
  mode?: "scheduled" | "manual";
  deps?: Partial<MarketplaceMaintenanceDeps>;
}

const EMPTY_CREW_REPAIR: CrewRepairPassResult = {
  catalogReady: false,
  inspected: 0,
  repaired: 0,
  skippedFailClosed: 0,
  skippedCooldown: 0,
  skippedOverBudget: 0,
  failed: 0,
  skips: [],
};

const EMPTY_STEWARD_RECONCILE: LegacyStewardReconcilePassResult = {
  disabled: false,
  catalogReady: false,
  inspected: 0,
  adopted: 0,
  skippedOverBudget: 0,
  failed: 0,
};

const FAILURE_CODE_BY_STAGE: Record<
  MarketplaceMaintenanceStage,
  MarketplaceReconcileFailureCode
> = {
  marketplace_update: "marketplace_update_failed",
  crew_repair: "crew_repair_failed",
  legacy_steward: "legacy_steward_failed",
  crew_update: "crew_update_failed",
  team_reconcile: "team_reconcile_failed",
};

function publicFailure(
  companyId: string,
  stage: MarketplaceMaintenanceStage,
): MarketplaceMaintenanceFailure {
  const code = FAILURE_CODE_BY_STAGE[stage];
  const recovery = MARKETPLACE_RECOVERY[code];
  return {
    companyId,
    stage,
    code,
    message: recovery.message,
    retry: recovery.retry,
  };
}

async function listCompanyIds(db: Db): Promise<readonly string[]> {
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .orderBy(companies.id);
  return rows.map((row) => row.id);
}

async function loadSettings(
  db: Db,
  companyId: string,
): Promise<MarketplaceSettings> {
  const rows = await db
    .select({ settings: marketplaceCompanySettings.settings })
    .from(marketplaceCompanySettings)
    .where(eq(marketplaceCompanySettings.companyId, companyId))
    .limit(1);
  return {
    ...MARKETPLACE_SETTINGS_DEFAULTS,
    ...((rows[0]?.settings as Partial<MarketplaceSettings> | undefined) ?? {}),
  };
}

const DEFAULT_DEPS: MarketplaceMaintenanceDeps = {
  listCompanyIds,
  loadSettings,
  runCrewRepair: runCrewRepairPass,
  runLegacyStewardReconcile: runLegacyStewardReconcilePass,
  checkCrewUpdates,
  reconcileTeamMembers,
};

let maintenanceTail: Promise<void> = Promise.resolve();

async function withMaintenanceLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = maintenanceTail;
  let release!: () => void;
  maintenanceTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

/**
 * Reusable catalog-driven crew sequence. This is shared by the boot/24-hour
 * loop and the instance-admin recovery operation so they cannot drift.
 */
export async function runMarketplaceCrewMaintenance(
  options: RunMarketplaceMaintenanceOptions,
): Promise<MarketplaceMaintenanceResult> {
  return withMaintenanceLock(() =>
    runMarketplaceCrewMaintenanceUnlocked(options),
  );
}

async function runMarketplaceCrewMaintenanceUnlocked(
  options: RunMarketplaceMaintenanceOptions,
): Promise<MarketplaceMaintenanceResult> {
  const deps = { ...DEFAULT_DEPS, ...options.deps };
  const discoveredCompanyIds =
    options.companyIds ?? (await deps.listCompanyIds(options.db));
  const companyIds = [...new Set(discoveredCompanyIds)].sort();
  const failures: MarketplaceMaintenanceFailure[] = [];
  const failuresByCompanyStage = new Map<
    string,
    MarketplaceMaintenanceFailure
  >();
  const manual = options.mode === "manual";
  const maxPerPass = manual ? companyIds.length : undefined;
  const instructionsService =
    options.instructionsService ?? agentInstructionsService();
  const recordFailure = (
    companyId: string,
    stage: MarketplaceMaintenanceStage,
    error: unknown,
  ) => {
    const key = `${companyId}\0${stage}`;
    const existing = failuresByCompanyStage.get(key);
    if (existing) {
      existing.occurrences = (existing.occurrences ?? 1) + 1;
      return;
    }
    const failure = publicFailure(companyId, stage);
    failuresByCompanyStage.set(key, failure);
    failures.push(failure);
    logger.warn(
      {
        companyId,
        stage,
        error: serializeSafeError(error),
      },
      "marketplace maintenance stage failed",
    );
  };

  let crewRepair = { ...EMPTY_CREW_REPAIR };
  try {
    crewRepair = await deps.runCrewRepair({
      db: options.db,
      companyIds,
      catalogItems: options.catalogItems,
      maxPerPass,
      force: manual,
      onFailure: ({ companyId, error }) => {
        recordFailure(companyId, "crew_repair", error);
      },
    });
  } catch (error) {
    crewRepair = { ...EMPTY_CREW_REPAIR, failed: companyIds.length };
    for (const companyId of companyIds) {
      recordFailure(companyId, "crew_repair", error);
    }
  }

  let legacySteward = { ...EMPTY_STEWARD_RECONCILE };
  try {
    legacySteward = await deps.runLegacyStewardReconcile({
      db: options.db,
      companyIds,
      catalogItems: options.catalogItems,
      maxPerPass,
      onFailure: ({ companyId, error }) => {
        recordFailure(companyId, "legacy_steward", error);
      },
    });
  } catch (error) {
    legacySteward = {
      ...EMPTY_STEWARD_RECONCILE,
      failed: companyIds.length,
    };
    for (const companyId of companyIds) {
      recordFailure(companyId, "legacy_steward", error);
    }
  }

  const crewUpdateResult = { succeeded: 0, failed: 0 };
  const teamResult: ReconcileTeamMembersResult = {
    teamsReconciled: 0,
    membersAdded: 0,
  };

  for (const companyId of companyIds) {
    let crewUpdateFailed = false;
    try {
      const settings = await deps.loadSettings(options.db, companyId);
      await deps.checkCrewUpdates({
        db: options.db,
        companyId,
        catalogItems: options.catalogItems,
        settings,
        instructionsService,
        onFailure: ({ error }) => {
          crewUpdateFailed = true;
          recordFailure(companyId, "crew_update", error);
        },
      });
      if (crewUpdateFailed) {
        crewUpdateResult.failed += 1;
      } else {
        crewUpdateResult.succeeded += 1;
      }
    } catch (error) {
      crewUpdateResult.failed += 1;
      recordFailure(companyId, "crew_update", error);
    }

    try {
      const result = await deps.reconcileTeamMembers({
        db: options.db,
        companyId,
        catalogItems: options.catalogItems,
        instructionsService,
        onFailure: ({ error }) => {
          recordFailure(companyId, "team_reconcile", error);
        },
      });
      teamResult.teamsReconciled += result.teamsReconciled;
      teamResult.membersAdded += result.membersAdded;
    } catch (error) {
      recordFailure(companyId, "team_reconcile", error);
    }
  }

  return {
    companiesExamined: companyIds.length,
    crewRepair,
    legacySteward,
    crewUpdates: crewUpdateResult,
    teamReconcile: teamResult,
    failures,
  };
}

export function digestMarketplaceCatalog(
  catalog: MarketplaceCatalogFile,
): string {
  return sha256Digest(catalog);
}

export interface MarketplaceReconciliationActor {
  actorType: "user";
  actorId: string;
}

export interface MarketplaceReconciliationAuditInput {
  db: Db;
  phase: "started" | "completed" | "failed_before_mutation";
  operationId: string;
  actor: MarketplaceReconciliationActor;
  companyIds: readonly string[];
  catalog: MarketplaceReconcileResult["catalog"] | null;
  result?: MarketplaceReconcileResult;
  terminalCode?: "catalog_temporarily_unavailable" | "catalog_refresh_failed";
}

export type MarketplaceReconciliationAuditWriter = (
  input: MarketplaceReconciliationAuditInput,
) => Promise<void>;

export async function writeMarketplaceReconciliationAudit(
  input: MarketplaceReconciliationAuditInput,
): Promise<void> {
  if (input.companyIds.length === 0) return;

  const action =
    input.phase === "started"
      ? "marketplace.reconciliation_started"
      : input.phase === "completed"
        ? "marketplace.reconciliation_completed"
        : "marketplace.reconciliation_failed_before_mutation";
  const skipsByCompany = new Map<string, MarketplaceReconcileSkip[]>();
  const failuresByCompany = new Map<string, MarketplaceReconcileFailure[]>();
  for (const skip of input.result?.skips ?? []) {
    const bucket = skipsByCompany.get(skip.companyId) ?? [];
    bucket.push(skip);
    skipsByCompany.set(skip.companyId, bucket);
  }
  for (const failure of input.result?.failures ?? []) {
    const bucket = failuresByCompany.get(failure.companyId) ?? [];
    bucket.push(failure);
    failuresByCompany.set(failure.companyId, bucket);
  }
  const deploymentSha =
    process.env.AOA_DEPLOY_SHA?.trim() ||
    process.env.AOA_IMAGE_REVISION?.trim() ||
    "unknown";
  const inserted = await input.db
    .insert(activityLog)
    .values(
      input.companyIds.map((companyId) => ({
        companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        action,
        entityType: "marketplace_reconciliation",
        entityId: input.operationId,
        details: {
          operationId: input.operationId,
          phase: input.phase,
          catalog: input.catalog,
          deploymentSha,
          targetCount: input.companyIds.length,
          ...(input.result
            ? {
                status: input.result.status,
                fleetRepairs: input.result.repairs,
                companySkips: skipsByCompany.get(companyId) ?? [],
                companyFailures: failuresByCompany.get(companyId) ?? [],
                diagnostics: input.result.diagnostics,
              }
            : input.phase === "started"
              ? {
                stages: [
                  "marketplace_update",
                  "crew_repair",
                  "legacy_steward",
                  "crew_update",
                  "team_reconcile",
                ],
              }
              : {
                  terminalCode:
                    input.terminalCode ?? "catalog_refresh_failed",
                }),
        },
      })),
    )
    .returning({ id: activityLog.id });

  if (inserted.length !== input.companyIds.length) {
    throw new Error(
      `Marketplace reconciliation audit persisted ${inserted.length} of ${input.companyIds.length} company records`,
    );
  }
}

export class MarketplaceCatalogRefreshError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly catalogStatus: CatalogSyncStatus | null,
    public readonly catalogOutcome:
      | "cdn_success"
      | "fallback_success"
      | "failure",
    public readonly catalogError: string | null,
  ) {
    super("Marketplace catalog refresh failed; no reconciliation was run");
  }
}

export class MarketplaceReconcileExecutionError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly outcome:
      | "outcome_unknown_after_mutation"
      | "internal_error" = "internal_error",
  ) {
    super("Marketplace reconciliation failed");
  }
}

export class MarketplaceReconciliationAlreadyExistsError extends Error {
  constructor(public readonly operationId: string) {
    super("Marketplace reconciliation operation ID has already been used");
  }
}

export class MarketplaceReconciliationInFlightError extends Error {
  constructor(public readonly activeOperationId: string) {
    super("Another marketplace reconciliation operation is already active");
  }
}

export class MarketplaceReconciliationRetryRequiredError extends Error {
  constructor(public readonly requiredOperationId: string) {
    super("An outcome-unknown reconciliation must be inspected before retry");
  }
}

export class MarketplaceReconciliationRetryReferenceInvalidError extends Error {
  constructor(public readonly retryOfOperationId: string) {
    super("The referenced reconciliation is not the current retry barrier");
  }
}

export class MarketplaceReconciliationRetryUnsafeError extends Error {
  constructor(public readonly retryOfOperationId: string) {
    super("The referenced reconciliation is not currently safe to retry");
  }
}

export class MarketplaceReconciliationLeaseLostError extends Error {
  constructor(public readonly operationId: string) {
    super("Marketplace reconciliation operation lease was lost");
  }
}

export interface MarketplaceReconciliationOperationRecord {
  operationId: string;
  state: MarketplaceReconciliationOperationState;
  deploymentSha: string;
  targetCount: number;
  targetCompanyIds: string[];
  catalog: MarketplaceReconcileResult["catalog"] | null;
  leaseActive: boolean;
  startedAt: Date;
  completedAt: Date | null;
}

export type MarketplaceReconciliationClaimResult =
  | { status: "claimed" }
  | { status: "already_exists" }
  | { status: "operation_in_flight"; activeOperationId: string }
  | { status: "retry_required"; requiredOperationId: string }
  | { status: "retry_reference_invalid"; retryOfOperationId: string };

export interface MarketplaceReconciliationOperationStore {
  claim(input: {
    db: Db;
    operationId: string;
    actor: MarketplaceReconciliationActor;
    deploymentSha: string;
    leaseOwnerId: string;
    retryOfOperationId?: string | null;
  }): Promise<MarketplaceReconciliationClaimResult>;
  heartbeat(input: {
    db: Db;
    operationId: string;
    leaseOwnerId: string;
  }): Promise<void>;
  markRunning(input: {
    db: Db;
    operationId: string;
    leaseOwnerId: string;
    companyIds: readonly string[];
  }): Promise<void>;
  finish(input: {
    db: Db;
    operationId: string;
    leaseOwnerId: string;
    state: Extract<
      MarketplaceReconciliationOperationState,
      | "success"
      | "partial"
      | "failed_before_mutation"
      | "outcome_unknown_after_mutation"
    >;
    catalog: MarketplaceReconcileResult["catalog"] | null;
  }): Promise<void>;
  load(db: Db, operationId: string): Promise<MarketplaceReconciliationOperationRecord | null>;
}

const RECONCILIATION_LEASE_SQL = sql`now() + interval '15 minutes'`;
const RECONCILIATION_HEARTBEAT_MS = 30_000;

function reconciliationDeploymentSha(): string {
  const candidate =
    process.env.AOA_DEPLOY_SHA?.trim() ||
    process.env.AOA_IMAGE_REVISION?.trim() ||
    "";
  return /^[0-9a-f]{40}$/.test(candidate) ? candidate : "unknown";
}

export const marketplaceReconciliationOperationStore: MarketplaceReconciliationOperationStore =
  {
    async claim(input) {
      return input.db.transaction(async (transaction) => {
        const db = transaction as unknown as Db;
        await db
          .update(marketplaceReconciliationOperations)
          .set({
            state: "outcome_unknown_after_mutation",
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
            leaseOwnerId: null,
            leaseExpiresAt: null,
          })
          .where(
            and(
              inArray(marketplaceReconciliationOperations.state, [
                "claimed",
                "running",
              ]),
              sql`${marketplaceReconciliationOperations.leaseExpiresAt} <= now()`,
            ),
          );

        const insertClaim = async () =>
          db
            .insert(marketplaceReconciliationOperations)
            .values({
              operationId: input.operationId,
              actorType: input.actor.actorType,
              actorId: input.actor.actorId,
              deploymentSha: input.deploymentSha,
              state: "claimed",
              leaseOwnerId: input.leaseOwnerId,
              leaseExpiresAt: RECONCILIATION_LEASE_SQL,
            })
            // This must be targetless: either the operation-ID primary key or
            // the partial singleton-active index may be the conflict source.
            .onConflictDoNothing()
            .returning({
              operationId: marketplaceReconciliationOperations.operationId,
            });

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const inserted = await insertClaim();
          if (inserted.length === 1) {
            // Ignore failed-before-mutation rows: they cannot resolve an older
            // uncertain mutation. The newest success/partial result resolves
            // all earlier uncertainty because this gate only permits it after
            // a safe inspection of the newest outcome-unknown predecessor.
            const [latestMutationOutcome] = await db
              .select({
                operationId:
                  marketplaceReconciliationOperations.operationId,
                state: marketplaceReconciliationOperations.state,
              })
              .from(marketplaceReconciliationOperations)
              .where(
                and(
                  ne(
                    marketplaceReconciliationOperations.operationId,
                    input.operationId,
                  ),
                  inArray(marketplaceReconciliationOperations.state, [
                    "success",
                    "partial",
                    "outcome_unknown_after_mutation",
                  ]),
                ),
              )
              .orderBy(
                desc(marketplaceReconciliationOperations.startedAt),
                desc(marketplaceReconciliationOperations.updatedAt),
              )
              .limit(1);
            const requiredOperationId =
              latestMutationOutcome?.state ===
              "outcome_unknown_after_mutation"
                ? latestMutationOutcome.operationId
                : null;
            const retryOfOperationId =
              input.retryOfOperationId ?? null;

            if (requiredOperationId !== retryOfOperationId) {
              // The row is not visible outside this transaction. Delete it so
              // a rejected precondition does not consume an operation UUID.
              await db
                .delete(marketplaceReconciliationOperations)
                .where(
                  and(
                    eq(
                      marketplaceReconciliationOperations.operationId,
                      input.operationId,
                    ),
                    eq(
                      marketplaceReconciliationOperations.leaseOwnerId,
                      input.leaseOwnerId,
                    ),
                  ),
                );
              if (requiredOperationId) {
                return {
                  status: "retry_required" as const,
                  requiredOperationId,
                };
              }
              return {
                status: "retry_reference_invalid" as const,
                retryOfOperationId: retryOfOperationId!,
              };
            }
            return { status: "claimed" as const };
          }

          const existing = await db
            .select({ operationId: marketplaceReconciliationOperations.operationId })
            .from(marketplaceReconciliationOperations)
            .where(
              eq(
                marketplaceReconciliationOperations.operationId,
                input.operationId,
              ),
            )
            .limit(1);
          if (existing.length > 0) {
            return { status: "already_exists" as const };
          }

          const active = await db
            .select({ operationId: marketplaceReconciliationOperations.operationId })
            .from(marketplaceReconciliationOperations)
            .where(
              and(
                inArray(marketplaceReconciliationOperations.state, [
                  "claimed",
                  "running",
                ]),
                sql`${marketplaceReconciliationOperations.leaseExpiresAt} > now()`,
              ),
            )
            .limit(1);
          if (active[0]) {
            return {
              status: "operation_in_flight" as const,
              activeOperationId: active[0].operationId,
            };
          }
          // The conflicting operation may have completed between the insert
          // and lookup. Retry once while still inside the claim transaction.
        }
        throw new Error(
          "Marketplace reconciliation operation claim could not be classified",
        );
      });
    },
    async heartbeat(input) {
      const updated = await input.db
        .update(marketplaceReconciliationOperations)
        .set({
          leaseExpiresAt: RECONCILIATION_LEASE_SQL,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(
              marketplaceReconciliationOperations.operationId,
              input.operationId,
            ),
            eq(
              marketplaceReconciliationOperations.leaseOwnerId,
              input.leaseOwnerId,
            ),
            inArray(marketplaceReconciliationOperations.state, [
              "claimed",
              "running",
            ]),
            sql`${marketplaceReconciliationOperations.leaseExpiresAt} > now()`,
          ),
        )
        .returning({
          operationId: marketplaceReconciliationOperations.operationId,
        });
      if (updated.length !== 1) {
        throw new MarketplaceReconciliationLeaseLostError(input.operationId);
      }
    },
    async markRunning(input) {
      const updated = await input.db
        .update(marketplaceReconciliationOperations)
        .set({
          state: "running",
          targetCount: input.companyIds.length,
          targetCompanyIds: [...input.companyIds],
          leaseExpiresAt: RECONCILIATION_LEASE_SQL,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(
              marketplaceReconciliationOperations.operationId,
              input.operationId,
            ),
            eq(
              marketplaceReconciliationOperations.leaseOwnerId,
              input.leaseOwnerId,
            ),
            inArray(marketplaceReconciliationOperations.state, [
              "claimed",
              "running",
            ]),
            sql`${marketplaceReconciliationOperations.leaseExpiresAt} > now()`,
          ),
        )
        .returning({
          operationId: marketplaceReconciliationOperations.operationId,
        });
      if (updated.length !== 1) {
        throw new MarketplaceReconciliationLeaseLostError(input.operationId);
      }
    },
    async finish(input) {
      const updated = await input.db
        .update(marketplaceReconciliationOperations)
        .set({
          state: input.state,
          catalog: input.catalog,
          completedAt: sql`now()`,
          updatedAt: sql`now()`,
          leaseOwnerId: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(
              marketplaceReconciliationOperations.operationId,
              input.operationId,
            ),
            eq(
              marketplaceReconciliationOperations.leaseOwnerId,
              input.leaseOwnerId,
            ),
            inArray(marketplaceReconciliationOperations.state, [
              "claimed",
              "running",
            ]),
            sql`${marketplaceReconciliationOperations.leaseExpiresAt} > now()`,
          ),
        )
        .returning({
          operationId: marketplaceReconciliationOperations.operationId,
        });
      if (updated.length !== 1) {
        throw new MarketplaceReconciliationLeaseLostError(input.operationId);
      }
    },
    async load(db, operationId) {
      const rows = await db
        .select({
          operationId: marketplaceReconciliationOperations.operationId,
          state: marketplaceReconciliationOperations.state,
          deploymentSha: marketplaceReconciliationOperations.deploymentSha,
          targetCount: marketplaceReconciliationOperations.targetCount,
          targetCompanyIds:
            marketplaceReconciliationOperations.targetCompanyIds,
          catalog: marketplaceReconciliationOperations.catalog,
          leaseActive: sql<boolean>`(
            ${marketplaceReconciliationOperations.state} in ('claimed', 'running')
            and ${marketplaceReconciliationOperations.leaseExpiresAt} > now()
          )`,
          startedAt: marketplaceReconciliationOperations.startedAt,
          completedAt: marketplaceReconciliationOperations.completedAt,
        })
        .from(marketplaceReconciliationOperations)
        .where(
          eq(marketplaceReconciliationOperations.operationId, operationId),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        ...row,
        catalog:
          (row.catalog as MarketplaceReconcileResult["catalog"] | null) ??
          null,
      };
    },
  };

export interface RunMarketplaceReconciliationOptions {
  db: Db;
  catalogService: Pick<MarketplaceCatalogService, "refresh">;
  actor: MarketplaceReconciliationActor;
  operationId: string;
  retryOfOperationId?: string | null;
  inspectRetry?: (
    db: Db,
    operationId: string,
  ) => Promise<MarketplaceReconciliationInspection>;
  maintenance?: typeof runMarketplaceCrewMaintenance;
  listCompanyIds?: MarketplaceMaintenanceDeps["listCompanyIds"];
  audit?: MarketplaceReconciliationAuditWriter;
  updateCheck?: typeof runUpdateCheck;
  operationStore?: MarketplaceReconciliationOperationStore;
}

export async function runMarketplaceReconciliation(
  options: RunMarketplaceReconciliationOptions,
): Promise<MarketplaceReconcileResult> {
  const operationId = options.operationId;
  const leaseOwnerId = randomUUID();
  const operationStore =
    options.operationStore ?? marketplaceReconciliationOperationStore;
  const claim = await operationStore.claim({
    db: options.db,
    operationId,
    actor: options.actor,
    deploymentSha: reconciliationDeploymentSha(),
    leaseOwnerId,
    retryOfOperationId: options.retryOfOperationId,
  });
  if (claim.status === "already_exists") {
    throw new MarketplaceReconciliationAlreadyExistsError(operationId);
  }
  if (claim.status === "operation_in_flight") {
    throw new MarketplaceReconciliationInFlightError(
      claim.activeOperationId,
    );
  }
  if (claim.status === "retry_required") {
    throw new MarketplaceReconciliationRetryRequiredError(
      claim.requiredOperationId,
    );
  }
  if (claim.status === "retry_reference_invalid") {
    throw new MarketplaceReconciliationRetryReferenceInvalidError(
      claim.retryOfOperationId,
    );
  }

  let heartbeatFailure: unknown = null;
  let heartbeatPromise: Promise<void> | null = null;
  const heartbeat = () => {
    if (heartbeatPromise) return;
    heartbeatPromise = operationStore
      .heartbeat({
        db: options.db,
        operationId,
        leaseOwnerId,
      })
      .catch((error) => {
        heartbeatFailure = error;
        logger.error(
          { operationId, error: serializeSafeError(error) },
          "marketplace reconciliation lease heartbeat failed",
        );
      })
      .finally(() => {
        heartbeatPromise = null;
      });
  };
  const heartbeatTimer = setInterval(
    heartbeat,
    RECONCILIATION_HEARTBEAT_MS,
  );
  heartbeatTimer.unref();
  const stopHeartbeat = async () => {
    clearInterval(heartbeatTimer);
    await heartbeatPromise;
  };
  const assertLease = () => {
    if (heartbeatFailure) {
      throw new MarketplaceReconcileExecutionError(
        operationId,
        "outcome_unknown_after_mutation",
      );
    }
  };

  try {
    if (options.retryOfOperationId) {
      const inspectRetry =
        options.inspectRetry ??
        ((db: Db, operationId: string) =>
          inspectMarketplaceReconciliation({
            db,
            operationId,
            isActive: false,
          }));
      let inspection: MarketplaceReconciliationInspection;
      try {
        inspection = await inspectRetry(
          options.db,
          options.retryOfOperationId,
        );
      } catch {
        throw new MarketplaceReconciliationRetryUnsafeError(
          options.retryOfOperationId,
        );
      }
      if (
        inspection.operationId !== options.retryOfOperationId ||
        inspection.state !== "outcome_unknown_after_mutation" ||
        !inspection.safeToRetry
      ) {
        throw new MarketplaceReconciliationRetryUnsafeError(
          options.retryOfOperationId,
        );
      }
    }
    const result = await withMarketplaceUpdateLock(() =>
      withMaintenanceLock(() =>
        runMarketplaceReconciliationLocked(
          options,
          operationId,
          operationStore,
          leaseOwnerId,
          assertLease,
        ),
      ),
    );
    await stopHeartbeat();
    assertLease();
    try {
      await operationStore.finish({
        db: options.db,
        operationId,
        leaseOwnerId,
        state: result.status,
        catalog: result.catalog,
      });
    } catch (error) {
      logger.error(
        { operationId, error: serializeSafeError(error) },
        "marketplace reconciliation terminal ledger update failed",
      );
      throw new MarketplaceReconcileExecutionError(
        operationId,
        "outcome_unknown_after_mutation",
      );
    }
    return result;
  } catch (error) {
    await stopHeartbeat();
    const state =
      error instanceof MarketplaceCatalogRefreshError ||
      error instanceof MarketplaceReconciliationRetryUnsafeError ||
      (error instanceof MarketplaceReconcileExecutionError &&
        error.outcome === "internal_error")
        ? "failed_before_mutation"
        : "outcome_unknown_after_mutation";
    try {
      await operationStore.finish({
        db: options.db,
        operationId,
        leaseOwnerId,
        state,
        catalog: null,
      });
    } catch (ledgerError) {
      logger.error(
        {
          operationId,
          error: serializeSafeError(ledgerError),
        },
        "marketplace reconciliation failure state could not be recorded",
      );
    }
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

function mapCrewSkip(skip: CrewRepairPassSkip): MarketplaceReconcileSkip {
  const reason: MarketplaceReconcileDiagnosticCode =
    skip.reason === "cooldown"
      ? "repair_cooldown"
      : skip.reason === "repair-budget-exhausted"
        ? "repair_budget_exhausted"
        : skip.reason === "install-in-flight"
          ? "install_in_flight"
          : skip.reason === "team-item-not-in-catalog"
            ? "team_item_not_in_catalog"
            : skip.reason === "team-template-unavailable"
              ? "team_template_unavailable"
              : skip.reason === "empty-roster"
                ? "empty_roster"
                : skip.reason === "unadoptable-roster-member"
                  ? "unadoptable_roster_member"
                  : skip.reason === "unaccounted-crew-rows"
                    ? "unaccounted_crew_rows"
                    : skip.skillFailure?.code ===
                        "resource-temporarily-unavailable"
                      ? "skill_resource_temporarily_unavailable"
                      : skip.skillFailure?.code === "resource-fetch-failed"
                        ? "skill_resource_fetch_failed"
                        : skip.skillFailure?.code === "resource-invalid"
                          ? "skill_resource_invalid"
                          : skip.skillFailure?.code ===
                              "bundle-materialization-failed"
                            ? "skill_bundle_materialization_failed"
                            : skip.skillFailure?.code === "bundle-missing"
                              ? "skill_bundle_missing"
                              : skip.skillFailure?.code ===
                                  "filesystem-permission-denied"
                                ? "skill_filesystem_permission_denied"
                                : "unknown_fail_closed";
  const recovery = MARKETPLACE_RECOVERY[reason];
  const retry =
    recovery.retry.kind === "after" && skip.notBefore
      ? { ...recovery.retry, notBefore: skip.notBefore }
      : recovery.retry;
  const context = skip.skillFailure
    ? {
        ...(skip.skillFailure.catalogItemId !== "unknown"
          ? { catalogItemId: skip.skillFailure.catalogItemId }
          : {}),
        ...(skip.skillFailure.httpStatus !== undefined
          ? { httpStatus: skip.skillFailure.httpStatus }
          : {}),
        ...(skip.skillFailure.filesystemOperation
          ? { filesystemOperation: skip.skillFailure.filesystemOperation }
          : {}),
      }
    : undefined;
  return {
    companyId: skip.companyId,
    stage: "crew_repair",
    category: skip.category,
    reason,
    message: recovery.message,
    retry,
    ...(context && Object.keys(context).length > 0 ? { context } : {}),
  };
}

function operationDiagnostics(
  result: MarketplaceMaintenanceResult,
): MarketplaceReconcileDiagnostic[] {
  const diagnostics: MarketplaceReconcileDiagnostic[] = [];
  const add = (
    stage: MarketplaceMaintenanceStage,
    code:
      | "crew_catalog_not_ready"
      | "legacy_steward_disabled"
      | "legacy_steward_catalog_not_ready",
  ) => {
    const recovery = MARKETPLACE_RECOVERY[code];
    diagnostics.push({
      scope: "operation",
      stage,
      code,
      message: recovery.message,
      retry: recovery.retry,
    });
  };
  if (!result.crewRepair.catalogReady) {
    add("crew_repair", "crew_catalog_not_ready");
  }
  if (result.legacySteward.disabled) {
    add("legacy_steward", "legacy_steward_disabled");
  } else if (!result.legacySteward.catalogReady) {
    add("legacy_steward", "legacy_steward_catalog_not_ready");
  }
  return diagnostics;
}

function ensureFailureAccounting(
  failures: MarketplaceMaintenanceFailure[],
  companyIds: readonly string[],
  stage: MarketplaceMaintenanceStage,
  expectedCount: number,
): void {
  const accounted = failures
    .filter((failure) => failure.stage === stage)
    .reduce((total, failure) => total + (failure.occurrences ?? 1), 0);
  let missing = Math.max(0, expectedCount - accounted);
  for (let index = 0; missing > 0 && companyIds.length > 0; index += 1) {
    const companyId = companyIds[index % companyIds.length]!;
    const existing = failures.find(
      (failure) =>
        failure.companyId === companyId && failure.stage === stage,
    );
    if (existing) {
      existing.occurrences = (existing.occurrences ?? 1) + 1;
    } else {
      failures.push(publicFailure(companyId, stage));
    }
    missing -= 1;
  }
}

function ensureCrewSkipAccounting(
  crewRepair: CrewRepairPassResult,
  companyIds: readonly string[],
): MarketplaceReconcileSkip[] {
  const skips = (crewRepair.skips ?? []).map(mapCrewSkip);
  const expected = [
    {
      category: "fail_closed" as const,
      count: crewRepair.skippedFailClosed,
      reason: "unknown_fail_closed" as const,
    },
    {
      category: "cooldown" as const,
      count: crewRepair.skippedCooldown,
      reason: "repair_cooldown" as const,
    },
    {
      category: "over_budget" as const,
      count: crewRepair.skippedOverBudget,
      reason: "repair_budget_exhausted" as const,
    },
  ];
  for (const item of expected) {
    const actual = skips.filter(
      (skip) => skip.category === item.category,
    ).length;
    if (actual > item.count) {
      throw new Error(
        `crew repair ${item.category} skip entries exceed their counter`,
      );
    }
    for (let index = actual; index < item.count; index += 1) {
      const companyId = companyIds[index % companyIds.length];
      if (!companyId) {
        throw new Error(
          `crew repair ${item.category} skip has no target company`,
        );
      }
      const recovery = MARKETPLACE_RECOVERY[item.reason];
      skips.push({
        companyId,
        stage: "crew_repair",
        category: item.category,
        reason: item.reason,
        message: recovery.message,
        retry:
          recovery.retry.kind === "after"
            ? { ...recovery.retry, notBefore: new Date().toISOString() }
            : recovery.retry,
      });
    }
  }
  return skips;
}

async function runMarketplaceReconciliationLocked(
  options: RunMarketplaceReconciliationOptions,
  operationId: string,
  operationStore: MarketplaceReconciliationOperationStore,
  leaseOwnerId: string,
  assertLease: () => void,
): Promise<MarketplaceReconcileResult> {
  assertLease();
  logger.info({ operationId }, "marketplace reconciliation started");
  const listTargets = options.listCompanyIds ?? listCompanyIds;
  const companyIds = [...new Set(await listTargets(options.db))].sort();
  await operationStore.markRunning({
    db: options.db,
    operationId,
    leaseOwnerId,
    companyIds,
  });
  assertLease();
  const audit = options.audit ?? writeMarketplaceReconciliationAudit;
  let mutationMayHaveStarted = false;
  let catalogIdentity: MarketplaceReconcileResult["catalog"] | null = null;

  try {
    await audit({
      db: options.db,
      phase: "started",
      operationId,
      actor: options.actor,
      companyIds,
      catalog: null,
    });

    let refreshResult: Awaited<
      ReturnType<RunMarketplaceReconciliationOptions["catalogService"]["refresh"]>
    >;
    try {
      refreshResult = await options.catalogService.refresh();
    } catch (error) {
      logger.warn(
        { operationId, error: serializeSafeError(error) },
        "marketplace reconciliation catalog refresh threw",
      );
      await audit({
        db: options.db,
        phase: "failed_before_mutation",
        operationId,
        actor: options.actor,
        companyIds,
        catalog: null,
        terminalCode: "catalog_temporarily_unavailable",
      });
      throw new MarketplaceCatalogRefreshError(
        operationId,
        null,
        "failure",
        null,
      );
    }
    const {
      catalog,
      status: catalogStatus,
      outcome: catalogOutcome,
      error: catalogError,
    } = refreshResult;
    if (
      !catalog ||
      catalogOutcome !== "cdn_success" ||
      catalogStatus?.lastSyncStatus !== "success"
    ) {
      logger.warn(
        {
          operationId,
          catalogStatus: catalogStatus
            ? {
                lastSyncedAt: catalogStatus.lastSyncedAt,
                lastSyncStatus: catalogStatus.lastSyncStatus,
                source: catalogStatus.source,
                schemaVersion: catalogStatus.schemaVersion,
                itemCount: catalogStatus.itemCount,
              }
            : null,
          catalogOutcome,
          error: catalogError
            ? serializeSafeError(new Error(catalogError))
            : undefined,
        },
        "marketplace reconciliation stopped because catalog refresh failed",
      );
      await audit({
        db: options.db,
        phase: "failed_before_mutation",
        operationId,
        actor: options.actor,
        companyIds,
        catalog: null,
        terminalCode:
          catalogOutcome === "failure"
            ? "catalog_temporarily_unavailable"
            : "catalog_refresh_failed",
      });
      throw new MarketplaceCatalogRefreshError(
        operationId,
        catalogStatus,
        catalogOutcome,
        catalogError,
      );
    }

    catalogIdentity = {
      generatedAt: catalog.generatedAt,
      canonicalDigestSha256: digestMarketplaceCatalog(catalog),
      schemaVersion: catalog.schemaVersion,
      itemCount: catalog.itemCount,
      source: catalogStatus.source,
    };
    assertLease();
    const updateCheck = options.updateCheck ?? runUpdateCheck;
    mutationMayHaveStarted = true;
    const updateCheckResult = await updateCheck(options.db, catalog.items, {
      companyIds,
    });
    assertLease();
    const updateFailures: MarketplaceMaintenanceFailure[] =
      updateCheckResult.failures.map((failure) => {
        logger.warn(
          {
            operationId,
            companyId: failure.companyId,
            stage: "marketplace_update",
            catalogItemId: failure.catalogItemId ?? undefined,
            error: serializeSafeError(new Error(failure.message)),
          },
          "marketplace update check failed during reconciliation",
        );
        return publicFailure(failure.companyId, "marketplace_update");
      });

    // The reconciliation already owns the maintenance lock from before its
    // start audit. Calling the public wrapper here would try to acquire the
    // same non-reentrant lock again, so the production path invokes the shared
    // unlocked implementation. Injected test/alternate maintenance runs inside
    // the same outer lock.
    const maintenanceOptions: RunMarketplaceMaintenanceOptions = {
      db: options.db,
      catalogItems: catalog.items,
      companyIds,
      mode: "manual",
    };
    const result =
      options.maintenance &&
      options.maintenance !== runMarketplaceCrewMaintenance
        ? await options.maintenance(maintenanceOptions)
        : await runMarketplaceCrewMaintenanceUnlocked(maintenanceOptions);
    assertLease();
    const failures = [...updateFailures, ...result.failures];
    ensureFailureAccounting(
      failures,
      companyIds,
      "crew_repair",
      result.crewRepair.failed,
    );
    ensureFailureAccounting(
      failures,
      companyIds,
      "legacy_steward",
      result.legacySteward.failed,
    );
    ensureFailureAccounting(
      failures,
      companyIds,
      "crew_update",
      result.crewUpdates.failed,
    );
    const skips = ensureCrewSkipAccounting(result.crewRepair, companyIds);
    const diagnostics = operationDiagnostics(result);
    const incomplete =
      failures.length > 0 ||
      skips.length > 0 ||
      diagnostics.length > 0;
    const wireResponse = MarketplaceReconcileResponseSchema.parse({
      ok: true,
      operationId,
      executionDisposition: "started",
      replayed: false,
      status: incomplete ? "partial" : "success",
      repairs: {
        crewCompaniesRepaired: result.crewRepair.repaired,
        legacyStewardsAdopted: result.legacySteward.adopted,
        teamsReconciled: result.teamReconcile.teamsReconciled,
        teamMembersAdded: result.teamReconcile.membersAdded,
      },
      catalog: catalogIdentity,
      companiesExamined: result.companiesExamined,
      crewRepair: {
        catalogReady: result.crewRepair.catalogReady,
        inspected: result.crewRepair.inspected,
        repaired: result.crewRepair.repaired,
        skippedFailClosed: result.crewRepair.skippedFailClosed,
        skippedCooldown: result.crewRepair.skippedCooldown,
        skippedOverBudget: result.crewRepair.skippedOverBudget,
        failed: result.crewRepair.failed,
      },
      legacySteward: result.legacySteward,
      crewUpdates: result.crewUpdates,
      teamReconcile: result.teamReconcile,
      skips,
      diagnostics,
      failures,
    });
    const {
      ok: _ok,
      executionDisposition: _executionDisposition,
      replayed: _replayed,
      ...response
    } = wireResponse;

    assertLease();
    await audit({
      db: options.db,
      phase: "completed",
      operationId,
      actor: options.actor,
      companyIds,
      catalog: catalogIdentity,
      result: response,
    });

    logger.info(
      {
        operationId,
        status: response.status,
        catalog: response.catalog,
        companiesExamined: response.companiesExamined,
        crewRepair: response.crewRepair,
        legacySteward: response.legacySteward,
        crewUpdates: response.crewUpdates,
        teamReconcile: response.teamReconcile,
        failureCount: response.failures.reduce(
          (total, failure) => total + (failure.occurrences ?? 1),
          0,
        ),
        skipCount: response.skips.length,
        diagnosticCount: response.diagnostics.length,
      },
      "marketplace reconciliation completed",
    );
    return response;
  } catch (error) {
    if (
      error instanceof MarketplaceCatalogRefreshError ||
      error instanceof MarketplaceReconcileExecutionError
    ) {
      throw error;
    }
    logger.error(
      {
        error: serializeSafeError(error),
        operationId,
        mutationMayHaveStarted,
        catalog: catalogIdentity,
      },
      "marketplace reconciliation failed",
    );
    throw new MarketplaceReconcileExecutionError(
      operationId,
      mutationMayHaveStarted
        ? "outcome_unknown_after_mutation"
        : "internal_error",
    );
  }
}

export class MarketplaceReconciliationNotFoundError extends Error {
  constructor(public readonly operationId: string) {
    super("Marketplace reconciliation operation was not found");
  }
}

export interface MarketplaceInspectionOptions {
  db: Db;
  operationId: string;
  isActive: boolean;
  diagnose?: typeof diagnoseCrewProvisioning;
  hasCustomizedRows?: (db: Db, companyId: string) => Promise<boolean>;
  hasActiveWriter?: (db: Db, companyId: string) => Promise<boolean>;
  hasUnaccountedCrewRows?: (
    db: Db,
    diagnosis: CrewRepairDiagnosis,
  ) => Promise<boolean>;
  loadOperation?: (
    db: Db,
    operationId: string,
  ) => Promise<MarketplaceReconciliationOperationRecord | null>;
}

async function hasCustomizedMarketplaceRows(
  db: Db,
  companyId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: companySkills.id })
    .from(companySkills)
    .where(
      and(
        eq(companySkills.companyId, companyId),
        eq(companySkills.customized, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function hasActiveMarketplaceWriter(
  db: Db,
  companyId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: marketplaceInstallOperations.id })
    .from(marketplaceInstallOperations)
    .where(
      and(
        eq(marketplaceInstallOperations.companyId, companyId),
        inArray(marketplaceInstallOperations.status, [
          "pending",
          "requested",
          "running",
        ]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

const COMMANDER_LEGACY_ORIGIN =
  "aoa-curated/standard-crew/commander@legacy";

function isCommanderInfrastructureRow(
  row: CrewRepairDiagnosis["unmanagedCrew"][number],
): boolean {
  return (
    row.templateOrigin === COMMANDER_LEGACY_ORIGIN ||
    (row.templateOrigin === null && row.name === "Commander")
  );
}

/**
 * Proves that the cheap crew diagnosis has no rows outside the installed
 * default-team witness. Commander is the sole exception: it is application
 * infrastructure, is not published in the crew roster, and therefore is not a
 * team member. Steward is deliberately not exempt because it is now catalog
 * managed and belongs to the default crew.
 */
export function crewRowsAccountedForDefaultTeam(
  diagnosis: Pick<
    CrewRepairDiagnosis,
    "teamId" | "managedCrew" | "unmanagedCrew"
  >,
  teamMemberIds: readonly string[],
): boolean {
  if (diagnosis.teamId === null) return false;

  const managedIds = new Set(diagnosis.managedCrew.map((row) => row.id));
  const managedOrigins = new Set(
    diagnosis.managedCrew.map((row) => row.templateOrigin),
  );
  const memberIds = new Set(teamMemberIds);

  if (
    diagnosis.managedCrew.length === 0 ||
    managedIds.size !== diagnosis.managedCrew.length ||
    managedOrigins.size !== diagnosis.managedCrew.length ||
    diagnosis.managedCrew.some(
      (row) =>
        row.templateOrigin === null ||
        row.templateOrigin.length === 0 ||
        row.templateOrigin.endsWith("@legacy"),
    ) ||
    memberIds.size !== teamMemberIds.length ||
    diagnosis.unmanagedCrew.some((row) => !isCommanderInfrastructureRow(row))
  ) {
    return false;
  }

  return (
    memberIds.size === managedIds.size &&
    [...managedIds].every((id) => memberIds.has(id))
  );
}

async function hasUnaccountedMarketplaceCrewRows(
  db: Db,
  diagnosis: CrewRepairDiagnosis,
): Promise<boolean> {
  if (diagnosis.teamId === null) return true;
  const rows = await db
    .select({ agentId: teamMembers.agentId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, diagnosis.teamId));
  return !crewRowsAccountedForDefaultTeam(
    diagnosis,
    rows.map((row) => row.agentId),
  );
}

/**
 * Read-only durable inspection over reconciliation activity rows. It never
 * invokes a repair path and treats every ambiguity as unsafe.
 */
export async function inspectMarketplaceReconciliation(
  options: MarketplaceInspectionOptions,
): Promise<MarketplaceReconciliationInspection> {
  const loadOperation =
    options.loadOperation ?? marketplaceReconciliationOperationStore.load;
  const operation = await loadOperation(options.db, options.operationId);
  if (!operation) {
    throw new MarketplaceReconciliationNotFoundError(options.operationId);
  }
  const rows = await options.db
    .select({
      companyId: activityLog.companyId,
      action: activityLog.action,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.entityType, "marketplace_reconciliation"),
        eq(activityLog.entityId, options.operationId),
      ),
    )
    .orderBy(asc(activityLog.createdAt));

  const started = rows.filter(
    (row) => row.action === "marketplace.reconciliation_started",
  );
  const terminal = rows.filter(
    (row) =>
      row.action === "marketplace.reconciliation_completed" ||
      row.action === "marketplace.reconciliation_failed_before_mutation",
  );
  const auditedTargetCompanyIds = [
    ...new Set(started.map((row) => row.companyId)),
  ].sort();
  const targetCompanyIds = [...new Set(operation.targetCompanyIds)].sort();
  const declaredTargetCount = operation.targetCount;
  const ledgerTargetSetValid =
    Number.isInteger(operation.targetCount) &&
    operation.targetCount >= 0 &&
    operation.targetCompanyIds.length === operation.targetCount &&
    targetCompanyIds.length === operation.targetCount;
  const startedRowsValid = started.every(
    (row) =>
      row.details?.operationId === options.operationId &&
      row.details?.phase === "started" &&
      row.details?.targetCount === declaredTargetCount &&
      row.details?.deploymentSha === operation.deploymentSha,
  );
  const startedTargetSetValid =
    ledgerTargetSetValid &&
    Number.isInteger(declaredTargetCount) &&
    declaredTargetCount >= 0 &&
    (declaredTargetCount === 0
      ? started.length === 0
      : started.length === declaredTargetCount &&
        auditedTargetCompanyIds.length === declaredTargetCount &&
        auditedTargetCompanyIds.every((id) =>
          targetCompanyIds.includes(id),
        ) &&
        startedRowsValid);
  const deploymentSha =
    operation.deploymentSha;
  const terminalCompanyIds = new Set(terminal.map((row) => row.companyId));
  const terminalRowsValid = terminal.every(
    (row) =>
      row.details?.operationId === options.operationId &&
      ((row.action === "marketplace.reconciliation_completed" &&
        row.details?.phase === "completed" &&
        (row.details?.status === "success" ||
          row.details?.status === "partial")) ||
        (row.action ===
          "marketplace.reconciliation_failed_before_mutation" &&
          row.details?.phase === "failed_before_mutation")) &&
      row.details?.targetCount === declaredTargetCount &&
      row.details?.deploymentSha === operation.deploymentSha,
  );
  const terminalLedgerConsistent =
    operation.state === "success" || operation.state === "partial"
      ? terminal.every(
          (row) =>
            row.action === "marketplace.reconciliation_completed" &&
            row.details?.status === operation.state,
        )
      : operation.state === "failed_before_mutation"
        ? terminal.every(
            (row) =>
              row.action ===
              "marketplace.reconciliation_failed_before_mutation",
          )
        : true;
  const terminalAuditExpected =
    declaredTargetCount > 0 &&
    (operation.state === "success" ||
      operation.state === "partial" ||
      operation.state === "failed_before_mutation");
  const terminalTargetSetValid =
    (terminal.length === 0 && !terminalAuditExpected) ||
    (startedTargetSetValid &&
      terminal.length === declaredTargetCount &&
      terminalCompanyIds.size === declaredTargetCount &&
      [...terminalCompanyIds].every((id) => targetCompanyIds.includes(id)) &&
      terminalRowsValid &&
      terminalLedgerConsistent);
  const auditSetValid = startedTargetSetValid && terminalTargetSetValid;

  let state: MarketplaceReconciliationInspection["state"];
  if (operation.leaseActive || options.isActive) {
    state = "running";
  } else if (!auditSetValid) {
    state = "outcome_unknown_after_mutation";
  } else if (
    operation.state === "success" ||
    operation.state === "partial" ||
    operation.state === "failed_before_mutation" ||
    operation.state === "outcome_unknown_after_mutation"
  ) {
    state = operation.state;
  } else {
    state = "outcome_unknown_after_mutation";
  }

  const targets: MarketplaceReconciliationInspection["targets"] = [];
  let safeToRetry = false;
  if (state === "outcome_unknown_after_mutation" && auditSetValid) {
    safeToRetry = true;
    const diagnose = options.diagnose ?? diagnoseCrewProvisioning;
    const customized =
      options.hasCustomizedRows ?? hasCustomizedMarketplaceRows;
    const activeWriter =
      options.hasActiveWriter ?? hasActiveMarketplaceWriter;
    const hasUnaccountedCrewRows =
      options.hasUnaccountedCrewRows ?? hasUnaccountedMarketplaceCrewRows;
    for (const companyId of targetCompanyIds) {
      try {
        const [diagnosis, hasCustomizedRows, hasActiveWriter] =
          await Promise.all([
          diagnose(options.db, companyId),
          customized(options.db, companyId),
          activeWriter(options.db, companyId),
        ]);
        if (hasActiveWriter) {
          safeToRetry = false;
          targets.push({
            companyId,
            crewState: "blocked",
            diagnosticCode: "install_in_flight",
          });
        } else if (hasCustomizedRows) {
          safeToRetry = false;
          targets.push({
            companyId,
            crewState: "blocked",
            diagnosticCode: "unknown_fail_closed",
          });
        } else if (
          diagnosis.verdict === "healthy" ||
          diagnosis.verdict === "operation-row-stale"
        ) {
          if (await hasUnaccountedCrewRows(options.db, diagnosis)) {
            safeToRetry = false;
            targets.push({
              companyId,
              crewState: "blocked",
              diagnosticCode: "unaccounted_crew_rows",
            });
          } else {
            targets.push({
              companyId,
              crewState:
                diagnosis.verdict === "healthy"
                  ? "healthy"
                  : "repairable",
              diagnosticCode: null,
            });
          }
        } else if (
          (diagnosis.teamId === null &&
            diagnosis.managedCrew.length === 0 &&
            diagnosis.unmanagedCrew.length === 0)
        ) {
          targets.push({
            companyId,
            crewState: "repairable",
            diagnosticCode: null,
          });
        } else {
          safeToRetry = false;
          targets.push({
            companyId,
            crewState: "blocked",
            diagnosticCode:
              diagnosis.unmanagedCrew.length > 0
                ? "unaccounted_crew_rows"
                : "unknown_fail_closed",
          });
        }
      } catch (error) {
        safeToRetry = false;
        targets.push({
          companyId,
          crewState: "unknown",
          diagnosticCode: "unknown_fail_closed",
        });
        logger.warn(
          {
            operationId: options.operationId,
            companyId,
            error: serializeSafeError(error),
          },
          "marketplace reconciliation inspection failed closed",
        );
      }
    }
  } else {
    for (const companyId of targetCompanyIds) {
      targets.push({
        companyId,
        crewState: "unknown",
        diagnosticCode: null,
      });
    }
  }

  const retry =
    state === "outcome_unknown_after_mutation"
      ? safeToRetry
        ? MARKETPLACE_RECOVERY.repair_budget_exhausted.retry
        : MARKETPLACE_RECOVERY.outcome_unknown_after_mutation.retry
      : state === "failed_before_mutation"
        ? MARKETPLACE_RECOVERY.catalog_refresh_failed.retry
      : state === "running" || state === "partial"
          ? MARKETPLACE_RECOVERY.outcome_unknown_after_mutation.retry
          : {
              kind: "never" as const,
              recoveryCode: "do_not_retry" as const,
              message:
                "This operation completed; use a new operation ID only for a new recovery decision.",
            };

  return MarketplaceReconciliationInspectionSchema.parse({
    operationId: options.operationId,
    state,
    startedAt: new Date(
      operation.startedAt,
    ).toISOString(),
    completedAt:
      operation.completedAt
        ? new Date(operation.completedAt).toISOString()
        : terminal.length > 0
        ? new Date(terminal[terminal.length - 1]!.createdAt).toISOString()
        : null,
    deploymentSha,
    targetCount: targetCompanyIds.length,
    targets,
    safeToRetry,
    retry,
  });
}
