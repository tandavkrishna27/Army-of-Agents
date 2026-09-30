import { z } from "zod";
/**
 * V1 resource limits. These bounds are BYTE-EQUAL to the PRT-003 job-envelope
 * limits; `job.ts` imports this schema so there is a single source of truth.
 * Zero, negative, and above-ceiling values are rejected on every field.
 */
export declare const resourceLimitsSchema: z.ZodObject<{
    cpuMillis: z.ZodNumber;
    memoryMiB: z.ZodNumber;
    pids: z.ZodNumber;
    diskMiB: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    cpuMillis: number;
    memoryMiB: number;
    pids: number;
    diskMiB: number;
}, {
    cpuMillis: number;
    memoryMiB: number;
    pids: number;
    diskMiB: number;
}>;
export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;
/** A single egress allow rule: HTTPS + lowercase DNS host + valid port only. */
export declare const networkAllowRuleSchema: z.ZodEffects<z.ZodObject<{
    scheme: z.ZodLiteral<"https">;
    host: z.ZodEffects<z.ZodString, string, string>;
    port: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    scheme: "https";
    host: string;
    port: number;
}, {
    scheme: "https";
    host: string;
    port: number;
}>, {
    scheme: "https";
    host: string;
    port: number;
}, {
    scheme: "https";
    host: string;
    port: number;
}>;
export type NetworkAllowRule = z.infer<typeof networkAllowRuleSchema>;
/** The strict V1 network policy: default-deny, all deny classes pinned true. */
export declare const networkPolicyV1Schema: z.ZodEffects<z.ZodObject<{
    policyId: z.ZodString;
    version: z.ZodNumber;
    digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
    defaultAction: z.ZodLiteral<"deny">;
    allow: z.ZodArray<z.ZodEffects<z.ZodObject<{
        scheme: z.ZodLiteral<"https">;
        host: z.ZodEffects<z.ZodString, string, string>;
        port: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        scheme: "https";
        host: string;
        port: number;
    }, {
        scheme: "https";
        host: string;
        port: number;
    }>, {
        scheme: "https";
        host: string;
        port: number;
    }, {
        scheme: "https";
        host: string;
        port: number;
    }>, "many">;
    denyPrivateNetworks: z.ZodLiteral<true>;
    denyMetadata: z.ZodLiteral<true>;
    denyControlPlane: z.ZodLiteral<true>;
}, "strict", z.ZodTypeAny, {
    policyId: string;
    version: number;
    digest: string & z.BRAND<"Sha256Digest">;
    defaultAction: "deny";
    allow: {
        scheme: "https";
        host: string;
        port: number;
    }[];
    denyPrivateNetworks: true;
    denyMetadata: true;
    denyControlPlane: true;
}, {
    policyId: string;
    version: number;
    digest: string;
    defaultAction: "deny";
    allow: {
        scheme: "https";
        host: string;
        port: number;
    }[];
    denyPrivateNetworks: true;
    denyMetadata: true;
    denyControlPlane: true;
}>, {
    policyId: string;
    version: number;
    digest: string & z.BRAND<"Sha256Digest">;
    defaultAction: "deny";
    allow: {
        scheme: "https";
        host: string;
        port: number;
    }[];
    denyPrivateNetworks: true;
    denyMetadata: true;
    denyControlPlane: true;
}, {
    policyId: string;
    version: number;
    digest: string;
    defaultAction: "deny";
    allow: {
        scheme: "https";
        host: string;
        port: number;
    }[];
    denyPrivateNetworks: true;
    denyMetadata: true;
    denyControlPlane: true;
}>;
export type NetworkPolicyV1 = z.infer<typeof networkPolicyV1Schema>;
/** A `{ policyId, version, digest }` reference to a stored network policy. */
export declare const networkPolicyRefSchema: z.ZodEffects<z.ZodObject<{
    policyId: z.ZodString;
    version: z.ZodNumber;
    digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
}, "strict", z.ZodTypeAny, {
    policyId: string;
    version: number;
    digest: string & z.BRAND<"Sha256Digest">;
}, {
    policyId: string;
    version: number;
    digest: string;
}>, {
    policyId: string;
    version: number;
    digest: string & z.BRAND<"Sha256Digest">;
}, {
    policyId: string;
    version: number;
    digest: string;
}>;
export type NetworkPolicyRef = z.infer<typeof networkPolicyRefSchema>;
/** The locked secret-materialization vocabulary (the delivery method). */
export declare const SECRET_MATERIALIZATION_KINDS: readonly ["proxy", "env", "file"];
/**
 * How the opaque secret capability is delivered into the sandbox. A discriminated
 * union so `proxy` (no target), `env` (env-var name), and `file` (sandbox path)
 * are each `.strict()` — proxy therefore cannot carry a target, and the wire has
 * no field for a raw secret value.
 */
export declare const secretMaterializationSchema: z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
    kind: z.ZodLiteral<"proxy">;
}, "strict", z.ZodTypeAny, {
    kind: "proxy";
}, {
    kind: "proxy";
}>, z.ZodObject<{
    kind: z.ZodLiteral<"env">;
    target: z.ZodString;
}, "strict", z.ZodTypeAny, {
    kind: "env";
    target: string;
}, {
    kind: "env";
    target: string;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"file">;
    target: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    kind: "file";
    target: string;
}, {
    kind: "file";
    target: string;
}>]>;
export type SecretMaterialization = z.infer<typeof secretMaterializationSchema>;
/** The locked secret use-policy vocabulary. */
export declare const SECRET_USE_POLICIES: readonly ["fence_proxy", "remote_server_fenced", "sandbox_local_only"];
export declare const secretUsePolicySchema: z.ZodEnum<["fence_proxy", "remote_server_fenced", "sandbox_local_only"]>;
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
export declare const secretHandleRefSchema: z.ZodEffects<z.ZodObject<{
    handleId: z.ZodBranded<z.ZodString, "SecretHandleId">;
    materialization: z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"proxy">;
    }, "strict", z.ZodTypeAny, {
        kind: "proxy";
    }, {
        kind: "proxy";
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"env">;
        target: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        kind: "env";
        target: string;
    }, {
        kind: "env";
        target: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"file">;
        target: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        kind: "file";
        target: string;
    }, {
        kind: "file";
        target: string;
    }>]>;
    usePolicy: z.ZodEnum<["fence_proxy", "remote_server_fenced", "sandbox_local_only"]>;
}, "strict", z.ZodTypeAny, {
    handleId: string & z.BRAND<"SecretHandleId">;
    materialization: {
        kind: "proxy";
    } | {
        kind: "env";
        target: string;
    } | {
        kind: "file";
        target: string;
    };
    usePolicy: "fence_proxy" | "remote_server_fenced" | "sandbox_local_only";
}, {
    handleId: string;
    materialization: {
        kind: "proxy";
    } | {
        kind: "env";
        target: string;
    } | {
        kind: "file";
        target: string;
    };
    usePolicy: "fence_proxy" | "remote_server_fenced" | "sandbox_local_only";
}>, {
    handleId: string & z.BRAND<"SecretHandleId">;
    materialization: {
        kind: "proxy";
    } | {
        kind: "env";
        target: string;
    } | {
        kind: "file";
        target: string;
    };
    usePolicy: "fence_proxy" | "remote_server_fenced" | "sandbox_local_only";
}, {
    handleId: string;
    materialization: {
        kind: "proxy";
    } | {
        kind: "env";
        target: string;
    } | {
        kind: "file";
        target: string;
    };
    usePolicy: "fence_proxy" | "remote_server_fenced" | "sandbox_local_only";
}>;
export type SecretHandleRef = z.infer<typeof secretHandleRefSchema>;
/** The locked artifact retention-class vocabulary. */
export declare const ARTIFACT_RETENTION_CLASSES: readonly ["ephemeral", "run", "audit", "checkpoint"];
export declare const artifactRetentionClassSchema: z.ZodEnum<["ephemeral", "run", "audit", "checkpoint"]>;
export type ArtifactRetentionClass = (typeof ARTIFACT_RETENTION_CLASSES)[number];
/** The locked offline-policy vocabulary (moved here from PRT-003; job imports it). */
export declare const OFFLINE_POLICIES: readonly ["cancel", "finish_without_remote_effects", "continue_until_lease_expiry"];
export declare const offlinePolicySchema: z.ZodEnum<["cancel", "finish_without_remote_effects", "continue_until_lease_expiry"]>;
export type OfflinePolicy = (typeof OFFLINE_POLICIES)[number];
