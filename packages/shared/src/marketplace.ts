import { z } from "zod";

// Mirror of catalog repo's CatalogItem schema. Keep in sync.
// Schema version bumps require coordinated update.

export const CATALOG_SCHEMA_VERSION_MIN = "1.0.0";
export const CATALOG_SCHEMA_VERSION_MAX = "1.0.0"; // bump as compat changes

export const MarketplaceCategorySchema = z.enum([
  "engineering",
  "marketing",
  "support",
  "sales",
  "operations",
  "design",
  "data",
  "productivity",
  "integrations",
  "workflows",
  "commander", // Commander personal AI skills — must stay separate from workflows/design
]);
export type MarketplaceCategory = z.infer<typeof MarketplaceCategorySchema>;

export const MarketplaceTagSchema = z.enum([
  "new",
  "featured",
  "enterprise",
  "solo-friendly",
  "requires-api-key",
  "official",
  "partner",
  "requires-cli-tooling",
]);
export type MarketplaceTag = z.infer<typeof MarketplaceTagSchema>;

export const MarketplaceTrustTierSchema = z.enum([
  "verified",
  "community",
  "unverified",
]);
export type MarketplaceTrustTier = z.infer<typeof MarketplaceTrustTierSchema>;

export const MarketplaceItemTypeSchema = z.enum([
  "skill",
  "plugin",
  "agent",
  "team",
]);
export type MarketplaceItemType = z.infer<typeof MarketplaceItemTypeSchema>;

export const MarketplaceProviderRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  homepageUrl: z.string().url().optional(),
  logoUrl: z.string().url().optional(),
  fallbackInitials: z.string(),
});
export type MarketplaceProviderRef = z.infer<typeof MarketplaceProviderRefSchema>;

const GITHUB_REPO_OWNER_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?";
const GITHUB_REPO_NAME_PATTERN = "[A-Za-z0-9._-]+";
const GITHUB_OWNER_REPO_REGEX = new RegExp(
  `^${GITHUB_REPO_OWNER_PATTERN}/${GITHUB_REPO_NAME_PATTERN}$`,
);
const MARKETPLACE_GITHUB_REPO_MESSAGE =
  "Skill bundle repo must be a GitHub owner/repo or HTTPS github.com owner/repo URL";
const MARKETPLACE_COMMIT_SHA_MESSAGE =
  "Skill bundle commitSha must be a full 40-character hex commit SHA";
const MARKETPLACE_COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/i;

export function isMarketplaceGitHubRepo(repo: string): boolean {
  if (!repo || repo.trim() !== repo) return false;

  if (GITHUB_OWNER_REPO_REGEX.test(repo)) return true;

  let parsed: URL;
  try {
    parsed = new URL(repo);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return false;
  const [owner, nameWithSuffix] = segments;
  const repoName = nameWithSuffix.endsWith(".git")
    ? nameWithSuffix.slice(0, -".git".length)
    : nameWithSuffix;

  return GITHUB_OWNER_REPO_REGEX.test(`${owner}/${repoName}`);
}

export const MarketplaceSkillBundleSchema = z.object({
  type: z.literal("github-directory"),
  repo: z.string().refine(isMarketplaceGitHubRepo, MARKETPLACE_GITHUB_REPO_MESSAGE),
  commitSha: z.string().regex(MARKETPLACE_COMMIT_SHA_REGEX, MARKETPLACE_COMMIT_SHA_MESSAGE),
  path: z.string(),
  treeUrl: z.string().url(),
});
export type MarketplaceSkillBundle = z.infer<typeof MarketplaceSkillBundleSchema>;

export const MarketplaceSkillFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string()).optional(),
  allowedTools: z.string().optional(),
  userInvocable: z.boolean().optional(),
  disableModelInvocation: z.boolean().optional(),
  raw: z.record(z.unknown()).default({}),
});
export type MarketplaceSkillFrontmatter = z.infer<typeof MarketplaceSkillFrontmatterSchema>;

export const MarketplaceSkillMetadataSchema = z.object({
  bundle: MarketplaceSkillBundleSchema,
  frontmatter: MarketplaceSkillFrontmatterSchema,
});
export type MarketplaceSkillMetadata = z.infer<typeof MarketplaceSkillMetadataSchema>;

export const MarketplaceCatalogItemSchema = z.object({
  id: z.string(),
  type: MarketplaceItemTypeSchema,
  name: z.string(),
  description: z.string(),
  version: z.string(),
  source: z.object({
    adapter: z.string(),
    url: z.string(),
    locator: z.string(),
    commitSha: z.string().optional(), // git SHA at aggregation time
  }),
  // Only present on plugin items, mirrors plugin.npm.{packageName,version}
  npm: z
    .object({
      packageName: z.string(),
      version: z.string(),
      tarballUrl: z.string().url().optional(),
      // Subresource Integrity (SRI) hash matching npm registry metadata format.
      // When present, plugin install verifies the resolved package's integrity
      // (read from package-lock.json after `npm install`) against this value
      // and fail-closes on mismatch. Catalog items omitting this field install
      // unverified for backward compatibility.
      // Format: `<algorithm>-<base64>`, e.g. `sha512-...==` or `sha256-...`.
      integrity: z
        .string()
        .regex(
          /^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/,
          "integrity must be `sha(256|384|512)-<base64>` (npm SRI format)",
        )
        .optional(),
    })
    .optional(),
  // Only present on snapshot items (skill/agent/team), commit-pinned URL to fetchable file
  resourceUrl: z.string().optional(),
  provider: MarketplaceProviderRefSchema.optional(),
  trust: z.object({
    tier: MarketplaceTrustTierSchema,
    source: z.string(),
    reviewer: z.string().optional(),
    reviewedAt: z.string().optional(),
    reviewedVersion: z.string().optional(),
  }),
  status: z.enum(["active", "deprecated", "quarantined"]),
  addedAt: z.string(),
  capabilities: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
  requires: z
    .array(
      z.object({
        type: z.string(),
        id: z.string(),
        versionRange: z.string().optional(),
      }),
    )
    .optional(),
  content: z
    .object({
      inline: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  packageId: z.string().optional(),
  category: MarketplaceCategorySchema,
  tags: z.array(MarketplaceTagSchema),
  featured: z.boolean().optional(),
  runtimeRequires: z.array(z.string()).optional(),
  skill: MarketplaceSkillMetadataSchema.optional(),
});
export type MarketplaceCatalogItem = z.infer<typeof MarketplaceCatalogItemSchema>;

// Alias for ergonomic imports throughout marketplace-install services
export type CatalogItem = MarketplaceCatalogItem;

export const MarketplaceCatalogFileSchema = z.object({
  schemaVersion: z.string(),
  generatedAt: z.string(),
  itemCount: z.number(),
  items: z.array(MarketplaceCatalogItemSchema),
});
export type MarketplaceCatalogFile = z.infer<typeof MarketplaceCatalogFileSchema>;

/**
 * Per-item, drop-and-warn parser for catalog.json — the forward-compat property
 * `MarketplaceCatalogFileSchema.parse()` lacks.
 *
 * WHY (FU-14): `MarketplaceCatalogItemSchema.type` is a hard enum. A whole-array
 * `.parse()` rejects the ENTIRE file the moment ONE item carries an unknown `type`
 * (e.g. a future `"connector"`/`"workflow"` kind) or any other unparseable shape.
 * The sync failure path preserves the previous cache, so a single new item type
 * would silently freeze the catalog FOREVER on every older self-hosted instance.
 * This parser mirrors `parseMcpConnectorCatalog` (mcp-connector-catalog.ts): it
 * validates the ENVELOPE, then `safeParse`s each item independently, dropping the
 * bad ones by id instead of failing the file. Items that DO parse are validated at
 * full strength (a known-`type` item with a bad shape is still dropped, never
 * accepted malformed) — the category/tag enums are per-item fields, so a bad
 * category or tag drops only that item.
 *
 * Return shape mirrors the connector parser's `malformed` concept:
 * - `malformed: true` ⇔ the envelope itself is unintelligible: `input` is not a
 *   non-null object, or `items` is absent / not an array. `catalog` is `null` and
 *   `dropped` is `[]`. Callers should treat this like a fetch failure and KEEP the
 *   last known-good cache.
 * - `malformed: false` ⇔ we read an `items` array (even a legitimately empty one).
 *   `catalog` is a `MarketplaceCatalogFile` whose `items` are the survivors and
 *   whose `itemCount` is recomputed to `items.length` (honest count of what is
 *   actually served). `dropped` lists the ids (or `"<unidentified>"`) of items
 *   that failed per-item validation. Never throws, for any input.
 *
 * NOTE: this parser does NOT gate on `schemaVersion` — that stays the caller's
 * decision via `isSchemaVersionSupported`, exactly as before.
 */
export function parseMarketplaceCatalog(input: unknown): {
  catalog: MarketplaceCatalogFile | null;
  dropped: string[];
  malformed: boolean;
} {
  if (typeof input !== "object" || input === null) {
    return { catalog: null, dropped: [], malformed: true };
  }
  const envelope = input as {
    schemaVersion?: unknown;
    generatedAt?: unknown;
    itemCount?: unknown;
    items?: unknown;
  };
  if (!Array.isArray(envelope.items)) {
    return { catalog: null, dropped: [], malformed: true };
  }

  const items: MarketplaceCatalogItem[] = [];
  const dropped: string[] = [];
  for (const raw of envelope.items) {
    const parsed = MarketplaceCatalogItemSchema.safeParse(raw);
    if (parsed.success) {
      items.push(parsed.data);
    } else {
      const id =
        typeof raw === "object" && raw !== null
          ? (raw as { id?: unknown }).id
          : undefined;
      dropped.push(typeof id === "string" ? id : "<unidentified>");
    }
  }

  // The envelope metadata is best-effort: a future schema that reshapes or omits
  // these must not blank the shelf. A non-string schemaVersion degrades to "" —
  // `isSchemaVersionSupported("")` is false, so the caller keeps its cache rather
  // than serving an unversioned file. `itemCount` is recomputed from survivors.
  const schemaVersion =
    typeof envelope.schemaVersion === "string" ? envelope.schemaVersion : "";
  const generatedAt =
    typeof envelope.generatedAt === "string"
      ? envelope.generatedAt
      : new Date(0).toISOString();

  return {
    catalog: { schemaVersion, generatedAt, itemCount: items.length, items },
    dropped,
    malformed: false,
  };
}

/**
 * A "package" is a synthetic grouping of catalog items that share a GitHub
 * source repo (or an explicit `packageId`). Synthesis rule: items grouped by
 * `owner/repo` extracted from `source.url`, with threshold ≥ 2 items.
 *
 * Synthesized packages don't have a description; UI shows "N skills" instead.
 * If the upstream catalog repo later wants curated names/descriptions, items
 * can carry an explicit `packageId` whose metadata can be looked up elsewhere.
 */
export const MarketplacePackageSchema = z.object({
  /** Stable identifier — `owner/repo` for synthesized, the literal `packageId` for explicit. */
  id: z.string(),
  /** Display name — repo name for synthesized (`gstack`), literal `packageId` for explicit. */
  name: z.string(),
  /** Canonical GitHub URL (e.g. `https://github.com/garrytan/gstack`). */
  sourceUrl: z.string(),
  /** Catalog item IDs that belong to this package, sorted ascending. */
  memberItemIds: z.array(z.string()),
  /** Number of member items. Always equal to `memberItemIds.length`. */
  count: z.number().int().nonnegative(),
  /** True iff every member item has `trust.tier === "verified"`. */
  verified: z.boolean(),
  /** Whether this package was created via an explicit `packageId` override. False = synthesized. */
  explicit: z.boolean(),
  /** Provider identity/logo chosen deterministically from package members. */
  provider: MarketplaceProviderRefSchema.optional(),
});
export type MarketplacePackage = z.infer<typeof MarketplacePackageSchema>;

export interface CatalogSyncStatus {
  lastSyncedAt: string;
  lastSyncStatus: "success" | "failure";
  lastSyncError?: string | null;
  source: "cdn" | "bundled";
  schemaVersion: string;
  itemCount: number;
}

export type MarketplaceMaintenanceStage =
  | "marketplace_update"
  | "crew_repair"
  | "legacy_steward"
  | "crew_update"
  | "team_reconcile";

const PUBLIC_ID_MAX = 160;
const PUBLIC_MESSAGE_MAX = 500;
const PUBLIC_URL_MAX = 500;
const CountSchema = z.number().int().nonnegative();

export const MarketplaceMaintenanceStageSchema = z.enum([
  "marketplace_update",
  "crew_repair",
  "legacy_steward",
  "crew_update",
  "team_reconcile",
]);

export const MarketplaceReconciliationOperationIdSchema = z.string().uuid();

export const MarketplaceReconcileRequestSchema = z
  .object({
    scope: z.literal("fleet"),
    mode: z.literal("repair"),
    operationId: MarketplaceReconciliationOperationIdSchema,
    retryOfOperationId:
      MarketplaceReconciliationOperationIdSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.retryOfOperationId === value.operationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retryOfOperationId"],
        message: "retryOfOperationId must name a predecessor operation",
      });
    }
  });
export type MarketplaceReconcileRequest = z.infer<
  typeof MarketplaceReconcileRequestSchema
>;

export const MarketplaceReconcileSkipCategorySchema = z.enum([
  "fail_closed",
  "cooldown",
  "over_budget",
]);
export type MarketplaceReconcileSkipCategory = z.infer<
  typeof MarketplaceReconcileSkipCategorySchema
>;

export const MarketplaceReconcileDiagnosticCodeSchema = z.enum([
  "install_in_flight",
  "team_item_not_in_catalog",
  "team_template_unavailable",
  "empty_roster",
  "unadoptable_roster_member",
  "unaccounted_crew_rows",
  "skill_resource_temporarily_unavailable",
  "skill_resource_fetch_failed",
  "skill_resource_invalid",
  "skill_bundle_materialization_failed",
  "skill_bundle_missing",
  "skill_filesystem_permission_denied",
  "repair_cooldown",
  "repair_budget_exhausted",
  "unknown_fail_closed",
]);
export type MarketplaceReconcileDiagnosticCode = z.infer<
  typeof MarketplaceReconcileDiagnosticCodeSchema
>;

export const MarketplaceOperationDiagnosticCodeSchema = z.enum([
  "crew_catalog_not_ready",
  "legacy_steward_disabled",
  "legacy_steward_catalog_not_ready",
]);
export type MarketplaceOperationDiagnosticCode = z.infer<
  typeof MarketplaceOperationDiagnosticCodeSchema
>;

export const MarketplaceReconcileFailureCodeSchema = z.enum([
  "marketplace_update_failed",
  "crew_repair_failed",
  "legacy_steward_failed",
  "crew_update_failed",
  "team_reconcile_failed",
  "unknown_internal_failure",
]);
export type MarketplaceReconcileFailureCode = z.infer<
  typeof MarketplaceReconcileFailureCodeSchema
>;

export const MarketplaceReconcileErrorCodeSchema = z.enum([
  "invalid_request",
  "authentication_required",
  "instance_admin_required",
  "operation_not_found",
  "operation_in_flight",
  "catalog_temporarily_unavailable",
  "catalog_refresh_failed",
  "outcome_unknown_after_mutation",
  "internal_error",
]);
export type MarketplaceReconcileErrorCode = z.infer<
  typeof MarketplaceReconcileErrorCodeSchema
>;

export const MarketplaceRecoveryCodeSchema = z.enum([
  "retry_now",
  "wait_then_retry",
  "inspect_operation",
  "authenticate",
  "use_instance_admin",
  "use_new_operation_id",
  "restore_catalog",
  "restore_resource",
  "correct_resource",
  "repair_bundle_storage",
  "repair_filesystem_permissions",
  "review_crew_state",
  "do_not_retry",
]);
export type MarketplaceRecoveryCode = z.infer<
  typeof MarketplaceRecoveryCodeSchema
>;

const RetryBaseSchema = z.object({
  recoveryCode: MarketplaceRecoveryCodeSchema,
  message: z.string().min(1).max(PUBLIC_MESSAGE_MAX),
});

export const MarketplaceRetryInstructionSchema = z.discriminatedUnion("kind", [
  RetryBaseSchema.extend({ kind: z.literal("immediate") }).strict(),
  RetryBaseSchema.extend({
    kind: z.literal("after"),
    notBefore: z.string().datetime(),
  }).strict(),
  RetryBaseSchema.extend({ kind: z.literal("after_correction") }).strict(),
  RetryBaseSchema.extend({ kind: z.literal("inspect_first") }).strict(),
  RetryBaseSchema.extend({ kind: z.literal("never") }).strict(),
]);
export type MarketplaceRetryInstruction = z.infer<
  typeof MarketplaceRetryInstructionSchema
>;

const ReconcileContextSchema = z
  .object({
    catalogItemId: z.string().min(1).max(PUBLIC_ID_MAX).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    filesystemOperation: z
      .enum(["read", "write", "rename", "mkdir"])
      .optional(),
  })
  .strict();

export const MarketplaceReconcileSkipSchema = z
  .object({
    companyId: z.string().min(1).max(PUBLIC_ID_MAX),
    stage: z.literal("crew_repair"),
    category: MarketplaceReconcileSkipCategorySchema,
    reason: MarketplaceReconcileDiagnosticCodeSchema,
    message: z.string().min(1).max(PUBLIC_MESSAGE_MAX),
    retry: MarketplaceRetryInstructionSchema,
    context: ReconcileContextSchema.optional(),
  })
  .strict();
export type MarketplaceReconcileSkip = z.infer<
  typeof MarketplaceReconcileSkipSchema
>;

export const MarketplaceReconcileFailureSchema = z
  .object({
    companyId: z.string().min(1).max(PUBLIC_ID_MAX),
    stage: MarketplaceMaintenanceStageSchema,
    code: MarketplaceReconcileFailureCodeSchema,
    message: z.string().min(1).max(PUBLIC_MESSAGE_MAX),
    retry: MarketplaceRetryInstructionSchema,
    occurrences: z.number().int().positive().optional(),
  })
  .strict();
export type MarketplaceReconcileFailure = z.infer<
  typeof MarketplaceReconcileFailureSchema
>;

export const MarketplaceReconcileDiagnosticSchema = z
  .object({
    scope: z.literal("operation"),
    stage: MarketplaceMaintenanceStageSchema,
    code: MarketplaceOperationDiagnosticCodeSchema,
    message: z.string().min(1).max(PUBLIC_MESSAGE_MAX),
    retry: MarketplaceRetryInstructionSchema,
  })
  .strict();
export type MarketplaceReconcileDiagnostic = z.infer<
  typeof MarketplaceReconcileDiagnosticSchema
>;

const CatalogIdentitySchema = z
  .object({
    generatedAt: z.string().datetime(),
    canonicalDigestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    schemaVersion: z.string().min(1).max(40),
    itemCount: CountSchema,
    source: z.enum(["cdn", "bundled"]),
  })
  .strict();

const CrewRepairCountersSchema = z
  .object({
    catalogReady: z.boolean(),
    inspected: CountSchema,
    repaired: CountSchema,
    skippedFailClosed: CountSchema,
    skippedCooldown: CountSchema,
    skippedOverBudget: CountSchema,
    failed: CountSchema,
  })
  .strict();

const LegacyStewardCountersSchema = z
  .object({
    disabled: z.boolean(),
    catalogReady: z.boolean(),
    inspected: CountSchema,
    adopted: CountSchema,
    skippedOverBudget: CountSchema,
    failed: CountSchema,
  })
  .strict();

/** Strict public wire contract for POST /api/admin/marketplace/reconcile. */
export const MarketplaceReconcileResponseSchema = z
  .object({
    ok: z.literal(true),
    operationId: z.string().uuid(),
    executionDisposition: z.enum(["started", "joined_in_flight"]),
    /** @deprecated Use executionDisposition. Kept for one compatibility release. */
    replayed: z.boolean(),
    status: z.enum(["success", "partial"]),
    repairs: z
      .object({
        crewCompaniesRepaired: CountSchema,
        legacyStewardsAdopted: CountSchema,
        teamsReconciled: CountSchema,
        teamMembersAdded: CountSchema,
      })
      .strict(),
    catalog: CatalogIdentitySchema,
    companiesExamined: CountSchema,
    crewRepair: CrewRepairCountersSchema,
    legacySteward: LegacyStewardCountersSchema,
    crewUpdates: z
      .object({ succeeded: CountSchema, failed: CountSchema })
      .strict(),
    teamReconcile: z
      .object({
        teamsReconciled: CountSchema,
        membersAdded: CountSchema,
      })
      .strict(),
    skips: z.array(MarketplaceReconcileSkipSchema),
    diagnostics: z.array(MarketplaceReconcileDiagnosticSchema),
    failures: z.array(MarketplaceReconcileFailureSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const replayed = value.executionDisposition === "joined_in_flight";
    if (value.replayed !== replayed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replayed"],
        message: "replayed must match executionDisposition",
      });
    }
  });
export type MarketplaceReconcileResponse = z.infer<
  typeof MarketplaceReconcileResponseSchema
>;

export const MarketplaceReconcileErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: MarketplaceReconcileErrorCodeSchema,
        message: z.string().min(1).max(PUBLIC_MESSAGE_MAX),
      })
      .strict(),
    operationId: z.string().uuid().nullable(),
    retry: MarketplaceRetryInstructionSchema,
    docUrl: z.string().min(1).max(PUBLIC_URL_MAX),
  })
  .strict();
export type MarketplaceReconcileErrorResponse = z.infer<
  typeof MarketplaceReconcileErrorResponseSchema
>;

export const MarketplaceReconciliationInspectionSchema = z
  .object({
    operationId: z.string().uuid(),
    state: z.enum([
      "running",
      "success",
      "partial",
      "failed_before_mutation",
      "outcome_unknown_after_mutation",
    ]),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    deploymentSha: z.string().min(1).max(PUBLIC_ID_MAX),
    targetCount: CountSchema,
    targets: z.array(
      z
        .object({
          companyId: z.string().min(1).max(PUBLIC_ID_MAX),
          crewState: z.enum(["healthy", "repairable", "blocked", "unknown"]),
          diagnosticCode:
            MarketplaceReconcileDiagnosticCodeSchema.nullable(),
        })
        .strict(),
    ),
    safeToRetry: z.boolean(),
    retry: MarketplaceRetryInstructionSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.targetCount !== value.targets.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetCount"],
        message: "targetCount must match targets.length",
      });
    }
  });
export type MarketplaceReconciliationInspection = z.infer<
  typeof MarketplaceReconciliationInspectionSchema
>;

export const MARKETPLACE_RECOVERY_DOC_URL =
  "/docs/guides/board-operator/marketplace-recovery";

type PublicRecovery =
  | MarketplaceReconcileDiagnosticCode
  | MarketplaceOperationDiagnosticCode
  | MarketplaceReconcileFailureCode
  | MarketplaceReconcileErrorCode;

/** Exhaustive, checked-in public message and recovery policy. */
export const MARKETPLACE_RECOVERY: Record<
  PublicRecovery,
  { message: string; retry: MarketplaceRetryInstruction }
> = {
  install_in_flight: { message: "A crew installation is already in progress.", retry: { kind: "after", recoveryCode: "wait_then_retry", message: "Wait for the active installation to finish, then inspect again.", notBefore: new Date(0).toISOString() } },
  team_item_not_in_catalog: { message: "The standard crew team is absent from the catalog.", retry: { kind: "after_correction", recoveryCode: "restore_catalog", message: "Restore the standard crew catalog entry before retrying." } },
  team_template_unavailable: { message: "The standard crew team template could not be loaded.", retry: { kind: "after_correction", recoveryCode: "restore_resource", message: "Restore the pinned team resource before retrying." } },
  empty_roster: { message: "The standard crew template has an empty roster.", retry: { kind: "after_correction", recoveryCode: "correct_resource", message: "Publish a valid non-empty team template before retrying." } },
  unadoptable_roster_member: { message: "An existing crew row cannot be safely matched to the catalog roster.", retry: { kind: "after_correction", recoveryCode: "review_crew_state", message: "Review the company crew mapping before retrying." } },
  unaccounted_crew_rows: { message: "Crew rows exist that are not accounted for by the catalog roster.", retry: { kind: "after_correction", recoveryCode: "review_crew_state", message: "Review the unaccounted crew rows before retrying." } },
  skill_resource_temporarily_unavailable: { message: "A required skill resource is temporarily unavailable.", retry: { kind: "after", recoveryCode: "wait_then_retry", message: "Wait until the resource retry deadline, then inspect again.", notBefore: new Date(0).toISOString() } },
  skill_resource_fetch_failed: { message: "A required skill resource could not be fetched.", retry: { kind: "after_correction", recoveryCode: "restore_resource", message: "Restore the pinned skill resource before retrying." } },
  skill_resource_invalid: { message: "A required skill resource is invalid.", retry: { kind: "after_correction", recoveryCode: "correct_resource", message: "Correct and republish the pinned skill resource before retrying." } },
  skill_bundle_materialization_failed: { message: "A skill bundle could not be materialized.", retry: { kind: "after_correction", recoveryCode: "repair_bundle_storage", message: "Repair bundle storage before retrying." } },
  skill_bundle_missing: { message: "A required managed skill bundle is missing.", retry: { kind: "after_correction", recoveryCode: "repair_bundle_storage", message: "Restore or re-materialize the managed bundle before retrying." } },
  skill_filesystem_permission_denied: { message: "The managed skill root is not writable.", retry: { kind: "after_correction", recoveryCode: "repair_filesystem_permissions", message: "Correct managed-root ownership and permissions before retrying." } },
  repair_cooldown: { message: "Crew repair is within its cooldown window.", retry: { kind: "after", recoveryCode: "wait_then_retry", message: "Wait until the repair cooldown expires, then inspect again.", notBefore: new Date(0).toISOString() } },
  repair_budget_exhausted: { message: "The crew repair budget was exhausted before this company.", retry: { kind: "immediate", recoveryCode: "retry_now", message: "Start a new bounded reconciliation after this operation completes." } },
  unknown_fail_closed: { message: "Crew repair stopped at an unclassified safety boundary.", retry: { kind: "after_correction", recoveryCode: "review_crew_state", message: "Inspect the company and server logs before retrying." } },
  crew_catalog_not_ready: { message: "The catalog is missing the standard crew prerequisite.", retry: { kind: "after_correction", recoveryCode: "restore_catalog", message: "Restore the standard crew catalog entry before retrying." } },
  legacy_steward_disabled: { message: "Legacy Steward reconciliation is disabled.", retry: { kind: "after_correction", recoveryCode: "review_crew_state", message: "Confirm the Steward migration policy before retrying." } },
  legacy_steward_catalog_not_ready: { message: "The Steward catalog prerequisite is unavailable.", retry: { kind: "after_correction", recoveryCode: "restore_catalog", message: "Restore the Steward catalog entry before retrying." } },
  marketplace_update_failed: { message: "A marketplace update check failed for this company.", retry: { kind: "after_correction", recoveryCode: "review_crew_state", message: "Inspect the company update state before retrying." } },
  crew_repair_failed: { message: "Crew repair failed for this company.", retry: { kind: "after_correction", recoveryCode: "review_crew_state", message: "Inspect the company crew state before retrying." } },
  legacy_steward_failed: { message: "Legacy Steward reconciliation failed for this company.", retry: { kind: "after_correction", recoveryCode: "review_crew_state", message: "Inspect the Steward state before retrying." } },
  crew_update_failed: { message: "A crew agent update failed for this company.", retry: { kind: "after_correction", recoveryCode: "review_crew_state", message: "Inspect the affected crew update before retrying." } },
  team_reconcile_failed: { message: "Team membership reconciliation failed for this company.", retry: { kind: "after_correction", recoveryCode: "review_crew_state", message: "Inspect the company team state before retrying." } },
  unknown_internal_failure: { message: "Marketplace reconciliation encountered an internal failure.", retry: { kind: "inspect_first", recoveryCode: "inspect_operation", message: "Inspect the operation before any retry." } },
  invalid_request: { message: "The marketplace reconciliation request is invalid.", retry: { kind: "never", recoveryCode: "do_not_retry", message: "Correct the request and use a new operation ID." } },
  authentication_required: { message: "Board authentication is required.", retry: { kind: "after_correction", recoveryCode: "authenticate", message: "Authenticate with a board credential before retrying." } },
  instance_admin_required: { message: "Instance-admin access is required.", retry: { kind: "after_correction", recoveryCode: "use_instance_admin", message: "Authenticate as an instance admin before retrying." } },
  operation_not_found: { message: "The reconciliation operation was not found.", retry: { kind: "never", recoveryCode: "do_not_retry", message: "Verify the operation ID; do not infer that it is safe to retry." } },
  operation_in_flight: { message: "Another marketplace reconciliation is already running.", retry: { kind: "inspect_first", recoveryCode: "inspect_operation", message: "Inspect the active operation before starting another." } },
  catalog_temporarily_unavailable: { message: "The marketplace catalog is temporarily unavailable.", retry: { kind: "after", recoveryCode: "wait_then_retry", message: "Wait for catalog availability, then inspect the operation.", notBefore: new Date(0).toISOString() } },
  catalog_refresh_failed: { message: "The marketplace catalog refresh failed before mutation.", retry: { kind: "after_correction", recoveryCode: "restore_catalog", message: "Restore catalog availability before using a new operation ID." } },
  outcome_unknown_after_mutation: { message: "Reconciliation may have committed changes, but completion could not be recorded.", retry: { kind: "inspect_first", recoveryCode: "inspect_operation", message: "Inspect the operation and retry only when safeToRetry is true." } },
  internal_error: { message: "Marketplace reconciliation failed internally.", retry: { kind: "inspect_first", recoveryCode: "inspect_operation", message: "Inspect the operation before any retry." } },
};

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a CDN catalog's `schemaVersion` is one this client can serve.
 *
 * INTENT (unchanged): reject a version we cannot understand — a major bump signals
 * breaking, non-backward-compatible changes and must still be refused (the sync
 * path then keeps the last known-good cache).
 *
 * FU-14 loosening: the previous strict equality (`=== "1.0.0"`) made ANY bump —
 * including an additive, backward-compatible minor/patch — freeze the catalog on
 * every older instance, the envelope-level twin of the per-item freeze this file
 * fixes. Now that `parseMarketplaceCatalog` drops unknown items rather than the
 * whole file, an additive minor bump is safe to accept: unknown item shapes fall
 * out per-item, known items keep working. So we accept any version in the SAME
 * MAJOR band as the supported range and at or above the MIN floor. `2.0.0` (major
 * bump = breaking) is still rejected; `1.1.0` (additive) is now accepted; `0.9.0`
 * (below the floor) is rejected.
 */
export function isSchemaVersionSupported(version: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const min = parseSemver(CATALOG_SCHEMA_VERSION_MIN);
  const max = parseSemver(CATALOG_SCHEMA_VERSION_MAX);
  if (!min || !max) return false;
  // Same major as the supported band (breaking major bumps rejected)...
  if (parsed[0] !== max[0]) return false;
  // ...and not below the MIN floor.
  return compareSemver(parsed, min) >= 0;
}

export interface MarketplaceSettings {
  // Section 1: Updates
  pluginUpdatePolicy: "auto_patch" | "auto_minor" | "notify_all";
  skillUpdatePolicy: "notify";
  agentUpdatePolicy: "auto" | "notify";
  teamUpdatePolicy: "auto" | "notify";
  // Section 2: Access
  showTrustBadges: boolean;
  showSourceInfo: boolean;
  allowTeamLeadPlugins: boolean;
  teamMemberCanRequestInstall: boolean;
  requireFounderApproval: boolean;
  // Section 3: Catalog refresh
  catalogRefreshHours: 6 | 12 | 24;
  updateCheckHours: 6 | 12 | 24;
  updateWindow: "anytime" | "off_hours" | "weekends";
}

export const MARKETPLACE_SETTINGS_DEFAULTS: MarketplaceSettings = {
  pluginUpdatePolicy: "notify_all",
  skillUpdatePolicy: "notify",
  agentUpdatePolicy: "notify",
  teamUpdatePolicy: "notify",
  showTrustBadges: true,
  showSourceInfo: true,
  allowTeamLeadPlugins: false,
  teamMemberCanRequestInstall: false,
  requireFounderApproval: false,
  catalogRefreshHours: 6,
  updateCheckHours: 24,
  updateWindow: "anytime",
};

export type PendingUpdateStatus = "pending" | "dismissed" | "applied" | "conflict";
export type PendingUpdateType = "skill" | "agent" | "team" | "plugin";

export interface PendingUpdate {
  id: string;
  companyId: string;
  catalogItemId: string;
  catalogItemName: string;
  itemType: PendingUpdateType;
  currentVersion: string;
  latestVersion: string;
  status: PendingUpdateStatus;
  detectedAt: string;
  updatedAt: string;
}
