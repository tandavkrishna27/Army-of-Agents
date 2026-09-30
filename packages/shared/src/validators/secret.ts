import { z } from "zod";
import {
  SECRET_BINDING_TARGET_TYPES,
  SECRET_MANAGED_MODES,
  SECRET_PROVIDER_CONFIG_STATUSES,
  SECRET_PROVIDERS,
  RUNTIME_PROVIDER_KEY_PROVIDERS,
  RUNTIME_PROVIDER_KEY_STATUSES,
} from "../constants.js";

export const envBindingPlainSchema = z.object({
  type: z.literal("plain"),
  value: z.string(),
});

export const envBindingSecretRefSchema = z.object({
  type: z.literal("secret_ref"),
  secretId: z.string().uuid(),
  version: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
});

// Backward-compatible union that accepts legacy inline values.
export const envBindingSchema = z.union([
  z.string(),
  envBindingPlainSchema,
  envBindingSecretRefSchema,
]);

export const envConfigSchema = z.record(envBindingSchema);

/**
 * Extract the effective value of an env binding for PRESENCE / auth-mode detection.
 * Adapter env entries are normalized to binding objects on save, so a raw-string
 * check alone misses a key the founder configured through the UI. Handles the three
 * persisted shapes (matching {@link envBindingSchema}); returns null when blank/absent.
 *   - legacy raw string               → the string (if non-blank)
 *   - { type: "plain", value }        → value (if non-blank)
 *   - { type: "secret_ref", secretId} → secretId (a presence marker — the real value
 *                                       is resolved later, but the api-key INTENT is
 *                                       already signaled by a bound secret)
 * Used by codex auth-mode detection (provider-status) and the crew backfill guard so
 * the binding-awareness lives in ONE place.
 */
export function readEnvBindingValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim().length > 0 ? value : null;
  if (typeof value === "object" && value !== null) {
    const b = value as { type?: unknown; value?: unknown; secretId?: unknown };
    if (b.type === "plain" && typeof b.value === "string" && b.value.trim().length > 0) return b.value;
    if (b.type === "secret_ref" && typeof b.secretId === "string" && b.secretId.length > 0) return b.secretId;
  }
  return null;
}

export const createSecretSchema = z.object({
  name: z.string().min(1),
  key: z.string().min(1).optional().nullable(),
  provider: z.enum(SECRET_PROVIDERS).optional(),
  providerConfigId: z.string().uuid().optional().nullable(),
  managedMode: z.enum(SECRET_MANAGED_MODES).optional(),
  value: z.string().min(1).optional().nullable(),
  description: z.string().optional().nullable(),
  externalRef: z.string().optional().nullable(),
  providerVersionRef: z.string().optional().nullable(),
});

export type CreateSecret = z.infer<typeof createSecretSchema>;

export const rotateSecretSchema = z.object({
  value: z.string().min(1),
  externalRef: z.string().optional().nullable(),
  providerConfigId: z.string().uuid().optional().nullable(),
  providerVersionRef: z.string().optional().nullable(),
});

export type RotateSecret = z.infer<typeof rotateSecretSchema>;

export const updateSecretSchema = z.object({
  name: z.string().min(1).optional(),
  key: z.string().min(1).optional().nullable(),
  description: z.string().optional().nullable(),
  externalRef: z.string().optional().nullable(),
  status: z.enum(["active", "disabled", "archived"]).optional(),
});

export type UpdateSecret = z.infer<typeof updateSecretSchema>;

const awsProviderConfigSchema = z.object({
  region: z.string().min(1),
  namespace: z.string().min(1).optional().nullable(),
  secretNamePrefix: z.string().min(1).optional().nullable(),
  kmsKeyId: z.string().min(1).optional().nullable(),
  ownerTag: z.string().min(1).optional().nullable(),
  environmentTag: z.string().min(1).optional().nullable(),
});

const comingSoonProviderConfigSchema = z.record(z.unknown()).optional().default({});

export const secretProviderConfigPayloadSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("local_encrypted"),
    config: z.record(z.unknown()).optional().default({}),
  }),
  z.object({
    provider: z.literal("aws_secrets_manager"),
    config: awsProviderConfigSchema,
  }),
  z.object({
    provider: z.literal("gcp_secret_manager"),
    config: comingSoonProviderConfigSchema,
  }),
  z.object({
    provider: z.literal("vault"),
    config: comingSoonProviderConfigSchema,
  }),
]);

const secretProviderConfigBaseSchema = z.object({
  provider: z.enum(SECRET_PROVIDERS),
  displayName: z.string().min(1),
  status: z.enum(SECRET_PROVIDER_CONFIG_STATUSES).optional(),
  isDefault: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

export const createSecretProviderConfigSchema = secretProviderConfigBaseSchema.superRefine((value, ctx) => {
  const parsed = secretProviderConfigPayloadSchema.safeParse({
    provider: value.provider,
    config: value.config ?? {},
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue(issue);
  }
});

export type CreateSecretProviderConfig = z.infer<typeof createSecretProviderConfigSchema>;

export const updateSecretProviderConfigSchema = secretProviderConfigBaseSchema
  .partial()
  .omit({ provider: true })
  .superRefine((value, ctx) => {
    if (value.config === undefined) return;
    // Updates are validated against the persisted provider in the service.
    if (typeof value.config !== "object" || value.config === null || Array.isArray(value.config)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "config must be an object" });
    }
  });

export type UpdateSecretProviderConfig = z.infer<typeof updateSecretProviderConfigSchema>;

export const createSecretBindingSchema = z.object({
  secretId: z.string().uuid(),
  targetType: z.enum(SECRET_BINDING_TARGET_TYPES),
  targetId: z.string().min(1),
  configPath: z.string().min(1),
  versionSelector: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
  required: z.boolean().optional(),
  label: z.string().optional().nullable(),
});

export type CreateSecretBinding = z.infer<typeof createSecretBindingSchema>;

export const remoteSecretImportPreviewSchema = z.object({
  providerConfigId: z.string().uuid(),
  query: z.string().optional().nullable(),
  nextToken: z.string().optional().nullable(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

export type RemoteSecretImportPreview = z.infer<typeof remoteSecretImportPreviewSchema>;

export const remoteSecretImportCommitSchema = z.object({
  providerConfigId: z.string().uuid(),
  secrets: z.array(z.object({
    externalRef: z.string().min(1),
    name: z.string().optional().nullable(),
    key: z.string().optional().nullable(),
    providerVersionRef: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
  })).min(1),
});

export type RemoteSecretImportCommit = z.infer<typeof remoteSecretImportCommitSchema>;

export const createRuntimeProviderKeySchema = z.object({
  provider: z.enum(RUNTIME_PROVIDER_KEY_PROVIDERS),
  displayName: z.string().min(1).max(120),
  secretId: z.string().uuid(),
  isDefault: z.boolean().optional().default(false),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export type CreateRuntimeProviderKey = z.infer<typeof createRuntimeProviderKeySchema>;

export const updateRuntimeProviderKeySchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  secretId: z.string().uuid().optional(),
  status: z.enum(RUNTIME_PROVIDER_KEY_STATUSES).optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export type UpdateRuntimeProviderKey = z.infer<typeof updateRuntimeProviderKeySchema>;
