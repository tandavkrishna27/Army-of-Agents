import { z } from "zod";
import { secretHandleIdSchema, sha256DigestSchema } from "./ids.js";
import { addForbiddenWireKeyIssues } from "./wire-safety.js";

// -----------------------------------------------------------------------------
// V1 resource / network / secret / retention / offline policy contracts.
//
// This module is the SINGLE source of truth for the resource-limit, network-
// policy-reference, offline-policy, and secret-handle-reference schemas that the
// job envelope (PRT-003, `job.ts`) also carries — `job.ts` imports them from here
// (Step 6), so there is exactly one definition of each on the wire.
//
// Security posture (fail-closed, provider-neutral):
//   * Network default action is `deny`; the private/metadata/control-plane deny
//     classes are all pinned `true` in v1; allow rules are HTTPS-host-only with
//     lowercase DNS names and NO IP literals.
//   * A secret reference carries only an opaque handle ID, a delivery
//     materialization METHOD (proxy | env | file), and a use policy. It never
//     carries secret bytes: raw direct-provider credential materialization is
//     unrepresentable, and connector OAuth access/refresh tokens + broker bundles
//     are rejected recursively by wire-safety. Remote governed use is admitted
//     only through a per-request fence proxy (`fence_proxy`) or a remote
//     capability whose server validates the live fence (`remote_server_fenced`);
//     `sandbox_local_only` cannot authorize a network destination.
//
// Runtime source imports only `zod` + relative modules and touches no Node API.
// -----------------------------------------------------------------------------

/** A lowercase kebab policy identifier (same grammar as the PRT-003 slug). */
const policyIdSchema = z.string().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// --- Resource limits ---------------------------------------------------------

/**
 * V1 resource limits. These bounds are BYTE-EQUAL to the PRT-003 job-envelope
 * limits; `job.ts` imports this schema so there is a single source of truth.
 * Zero, negative, and above-ceiling values are rejected on every field.
 */
export const resourceLimitsSchema = z
  .object({
    cpuMillis: z.number().int().min(100).max(128_000),
    memoryMiB: z.number().int().min(128).max(1_048_576),
    pids: z.number().int().min(16).max(100_000),
    diskMiB: z.number().int().min(128).max(10_485_760),
  })
  .strict();
export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;

// --- Network policy ----------------------------------------------------------

/** Reject IPv4 dotted-quad literals (metadata/private endpoints are IP literals). */
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** A single lowercase DNS label: `[a-z0-9]`, internal hyphens only, ≤63 chars. */
const DNS_HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** True iff `host` is a lowercase DNS name and NOT an IP literal. */
function isLowercaseDnsHost(host: string): boolean {
  if (host.length < 1 || host.length > 253) return false;
  if (host.includes(":")) return false; // IPv6 / bracketed / port smuggling
  if (IPV4_LITERAL.test(host)) return false; // IPv4 literal
  return DNS_HOST.test(host);
}

/** A single egress allow rule: HTTPS + lowercase DNS host + valid port only. */
export const networkAllowRuleSchema = z
  .object({
    scheme: z.literal("https"),
    host: z.string().superRefine((value, ctx) => {
      if (!isLowercaseDnsHost(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must be a lowercase DNS name with no IP literal" });
      }
    }),
    port: z.number().int().min(1).max(65535),
  })
  .strict()
  .superRefine((rule, ctx) => addForbiddenWireKeyIssues(rule, ctx));
export type NetworkAllowRule = z.infer<typeof networkAllowRuleSchema>;

/** The strict V1 network policy: default-deny, all deny classes pinned true. */
export const networkPolicyV1Schema = z
  .object({
    policyId: policyIdSchema,
    version: z.number().int().positive(),
    digest: sha256DigestSchema,
    defaultAction: z.literal("deny"),
    allow: z.array(networkAllowRuleSchema).max(256),
    denyPrivateNetworks: z.literal(true),
    denyMetadata: z.literal(true),
    denyControlPlane: z.literal(true),
  })
  .strict()
  .superRefine((policy, ctx) => addForbiddenWireKeyIssues(policy, ctx));
export type NetworkPolicyV1 = z.infer<typeof networkPolicyV1Schema>;

/** A `{ policyId, version, digest }` reference to a stored network policy. */
export const networkPolicyRefSchema = z
  .object({ policyId: policyIdSchema, version: z.number().int().positive(), digest: sha256DigestSchema })
  .strict()
  .superRefine((ref, ctx) => addForbiddenWireKeyIssues(ref, ctx));
export type NetworkPolicyRef = z.infer<typeof networkPolicyRefSchema>;

// --- Secret handle reference -------------------------------------------------

/** The locked secret-materialization vocabulary (the delivery method). */
export const SECRET_MATERIALIZATION_KINDS = ["proxy", "env", "file"] as const;

/** An env-var NAME (not a value): POSIX shell variable grammar. */
const envTargetSchema = z.string().min(1).max(256).regex(/^[A-Z_][A-Z0-9_]*$/);

/** The sandbox-local secrets root. A `file` materialization target must be an
 * absolute path under this directory with no `..` traversal. */
const SANDBOX_SECRET_ROOT = "/run/aoa-secrets/";

/** True iff `target` is an absolute sandbox path under the secrets root with no
 * `..`/`.` segment, no backslash, and a non-empty filename. */
function isSandboxSecretFilePath(target: string): boolean {
  if (target.length < SANDBOX_SECRET_ROOT.length + 1 || target.length > 1024) return false;
  if (!target.startsWith(SANDBOX_SECRET_ROOT)) return false;
  if (target.includes("\\")) return false;
  for (let i = 0; i < target.length; i += 1) {
    const c = target.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false; // control / NUL / DEL
  }
  const segments = target.slice(1).split("/"); // drop the leading "/"
  for (const seg of segments) {
    if (seg.length === 0) return false; // "//" or trailing "/"
    if (seg === "." || seg === "..") return false;
  }
  return true;
}

const fileTargetSchema = z.string().superRefine((value, ctx) => {
  if (!isSandboxSecretFilePath(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `file target must be an absolute path under ${SANDBOX_SECRET_ROOT} with no ..` });
  }
});

/**
 * How the opaque secret capability is delivered into the sandbox. A discriminated
 * union so `proxy` (no target), `env` (env-var name), and `file` (sandbox path)
 * are each `.strict()` — proxy therefore cannot carry a target, and the wire has
 * no field for a raw secret value.
 */
export const secretMaterializationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proxy") }).strict(),
  z.object({ kind: z.literal("env"), target: envTargetSchema }).strict(),
  z.object({ kind: z.literal("file"), target: fileTargetSchema }).strict(),
]);
export type SecretMaterialization = z.infer<typeof secretMaterializationSchema>;

/** The locked secret use-policy vocabulary. */
export const SECRET_USE_POLICIES = ["fence_proxy", "remote_server_fenced", "sandbox_local_only"] as const;
export const secretUsePolicySchema = z.enum(SECRET_USE_POLICIES);
export type SecretUsePolicy = (typeof SECRET_USE_POLICIES)[number];

/**
 * A provider-neutral reference to a control-plane secret handle. Carries an
 * opaque UUID handle, a materialization method, and a use policy — never secret
 * bytes.
 *
 * Cross-field invariants (fail-closed):
 *   * `proxy` materialization is the per-request fence proxy → only `fence_proxy`.
 *   * `env`/`file` (sandbox-delivered capability) → `remote_server_fenced` or
 *     `sandbox_local_only`, never the per-request fence proxy.
 *   * Consequently `sandbox_local_only` can never pair with the proxy (network)
 *     mechanism, so it cannot authorize a network destination.
 *   * Recursive wire-safety rejects any connector OAuth access/refresh token or
 *     broker token bundle nested anywhere in the reference.
 */
export const secretHandleRefSchema = z
  .object({
    handleId: secretHandleIdSchema,
    materialization: secretMaterializationSchema,
    usePolicy: secretUsePolicySchema,
  })
  .strict()
  .superRefine((ref, ctx) => {
    addForbiddenWireKeyIssues(ref, ctx);
    const kind = ref.materialization.kind;
    if (kind === "proxy" && ref.usePolicy !== "fence_proxy") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["usePolicy"],
        message: "proxy materialization is the per-request fence proxy and requires usePolicy 'fence_proxy'",
      });
    }
    if ((kind === "env" || kind === "file") && ref.usePolicy === "fence_proxy") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["usePolicy"],
        message: "env/file materialization cannot claim the per-request fence proxy policy",
      });
    }
  });
export type SecretHandleRef = z.infer<typeof secretHandleRefSchema>;

// --- Retention + offline policies --------------------------------------------

/** The locked artifact retention-class vocabulary. */
export const ARTIFACT_RETENTION_CLASSES = ["ephemeral", "run", "audit", "checkpoint"] as const;
export const artifactRetentionClassSchema = z.enum(ARTIFACT_RETENTION_CLASSES);
export type ArtifactRetentionClass = (typeof ARTIFACT_RETENTION_CLASSES)[number];

/** The locked offline-policy vocabulary (moved here from PRT-003; job imports it). */
export const OFFLINE_POLICIES = ["cancel", "finish_without_remote_effects", "continue_until_lease_expiry"] as const;
export const offlinePolicySchema = z.enum(OFFLINE_POLICIES);
export type OfflinePolicy = (typeof OFFLINE_POLICIES)[number];
