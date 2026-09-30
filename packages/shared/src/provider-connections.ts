import { z } from "zod";

// SCOPE (beta): bedrock + vertex are NOT modeled first-class here. They remain on
// the existing ambient-env passthrough (adapterConfig.env survives the ambient
// strip via CLAUDE_OVERLAY_AUTH_KEY_SHAPES, ambient-config.ts:415-424) and fold
// into the connection model post-beta.
export const AUTH_METHODS = [
  "api_key",
  "personal_subscription",
  "enterprise_gateway",
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** org/company defaults may only route these; personal_subscription is owner-only. */
export const SHAREABLE_AUTH_METHODS = [
  "api_key",
  "enterprise_gateway",
] as const satisfies readonly AuthMethod[];

export const SHARING_POLICIES = ["owner_only", "company_agents", "org_agents"] as const;
export type SharingPolicy = (typeof SHARING_POLICIES)[number];

/**
 * Env vars an enterprise_gateway token may bind (config.tokenEnvVar). MUST stay a
 * subset of the claude adapter's overlay-auth allowlist
 * (CLAUDE_OVERLAY_AUTH_KEY_SHAPES, ambient-config.ts:415-424) or the ambient strip
 * deletes the key at spawn. SINGLE source of truth — the resolver's
 * materializeEnvPatch imports this; do not re-declare it server-side.
 */
export const GATEWAY_TOKEN_ENV_ALLOWLIST = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);
export const DEFAULT_GATEWAY_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";

export const CONNECTION_STATES = ["pending", "verified", "revoked", "suspended"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const ASSIGNMENT_SCOPE_TYPES = [
  "org_default",
  "company_default",
  "agent_override",
  "personal_execution_default",
] as const;
export type AssignmentScopeType = (typeof ASSIGNMENT_SCOPE_TYPES)[number];

export function isShareableAuthMethod(method: AuthMethod): boolean {
  return (SHAREABLE_AUTH_METHODS as readonly AuthMethod[]).includes(method);
}

export const providerConnectionCreateSchema = z
  .object({
    provider: z.string().min(1),
    authMethod: z.enum(AUTH_METHODS),
    ownerUserId: z.string().min(1).optional(),
    executionTargetId: z.string().min(1).optional(),
    secretRef: z.string().min(1).optional(),
    sharingPolicy: z.enum(SHARING_POLICIES).optional(),
    maxConcurrency: z.number().int().nonnegative().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.authMethod === "personal_subscription") {
      if (!v.ownerUserId || !v.executionTargetId) {
        ctx.addIssue({ code: "custom", message: "personal_subscription requires ownerUserId + executionTargetId" });
      }
      if (v.secretRef) {
        ctx.addIssue({ code: "custom", message: "personal_subscription must not carry a secretRef" });
      }
    }
    if (v.authMethod === "api_key" && !v.secretRef) {
      ctx.addIssue({ code: "custom", message: "api_key requires a secretRef" });
    }
    if (v.authMethod === "enterprise_gateway") {
      const cfg = v.config as Record<string, unknown> | undefined;
      const baseUrl = cfg?.baseUrl;
      if (typeof baseUrl !== "string" || baseUrl.length === 0) {
        ctx.addIssue({ code: "custom", message: "enterprise_gateway requires config.baseUrl" });
      }
      const tokenEnvVar = cfg?.tokenEnvVar;
      if (tokenEnvVar !== undefined && (typeof tokenEnvVar !== "string" || !GATEWAY_TOKEN_ENV_ALLOWLIST.has(tokenEnvVar))) {
        ctx.addIssue({
          code: "custom",
          message: `config.tokenEnvVar must be one of: ${[...GATEWAY_TOKEN_ENV_ALLOWLIST].join(", ")}`,
        });
      }
    }
  });

export const providerAssignmentUpsertSchema = z
  .object({
    connectionId: z.string().min(1),
    scopeType: z.enum(ASSIGNMENT_SCOPE_TYPES),
    scopeId: z.string().min(1).nullable().optional(),
    priority: z.number().int().optional(),
  })
  .superRefine((v, ctx) => {
    const needsId = v.scopeType === "agent_override" || v.scopeType === "personal_execution_default";
    if (needsId && !v.scopeId) ctx.addIssue({ code: "custom", message: `${v.scopeType} requires scopeId` });
    if (!needsId && v.scopeId) ctx.addIssue({ code: "custom", message: `${v.scopeType} must not carry scopeId` });
  });
