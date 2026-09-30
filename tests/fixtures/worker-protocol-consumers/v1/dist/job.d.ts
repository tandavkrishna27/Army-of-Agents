import { z } from "zod";
/** RFC3339 timestamp accepting a `Z` or numeric UTC offset. */
export declare const timestampV1Schema: z.ZodString;
export declare const TARGET_CLASSES: readonly ["managed_cloud", "organization_dedicated", "owner_desktop"];
export declare const targetClassSchema: z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>;
export type TargetClass = (typeof TARGET_CLASSES)[number];
export declare const TARGET_SCOPES: readonly ["platform", "organization", "owner"];
export declare const targetScopeSchema: z.ZodEnum<["platform", "organization", "owner"]>;
export type TargetScope = (typeof TARGET_SCOPES)[number];
export declare const TRUST_CLASSES: readonly ["shared_isolated", "organization_isolated", "owner_local_trusted"];
export declare const trustClassSchema: z.ZodEnum<["shared_isolated", "organization_isolated", "owner_local_trusted"]>;
export type TrustClass = (typeof TRUST_CLASSES)[number];
export declare const CREDENTIAL_KINDS: readonly ["none", "platform_brokered", "organization_brokered", "owner_bound"];
export declare const credentialKindSchema: z.ZodEnum<["none", "platform_brokered", "organization_brokered", "owner_bound"]>;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export declare const DATA_LOCALITIES: readonly ["transfer_allowed", "organization_target_only", "owner_device_only"];
export declare const dataLocalitySchema: z.ZodEnum<["transfer_allowed", "organization_target_only", "owner_device_only"]>;
export type DataLocality = (typeof DATA_LOCALITIES)[number];
export declare const FALLBACK_MODES: readonly ["forbidden", "ordered_explicit"];
export declare const fallbackModeSchema: z.ZodEnum<["forbidden", "ordered_explicit"]>;
export type FallbackMode = (typeof FALLBACK_MODES)[number];
/**
 * The closed V1 placement matrix. Compatibility is decided by explicit row
 * membership, NEVER ordinal string comparison. Every unlisted combination fails
 * closed.
 */
export interface PlacementMatrixRow {
    readonly targetScope: TargetScope;
    readonly trustClass: TrustClass;
    readonly credentials: readonly CredentialKind[];
    readonly localities: readonly DataLocality[];
}
export declare const PLACEMENT_MATRIX: Readonly<Record<TargetClass, PlacementMatrixRow>>;
/** True iff `(targetClass, trustClass, credentialKind, dataLocality)` is an
 * explicit member of the placement matrix row for `targetClass`. */
export declare function isTargetPlacementAllowed(targetClass: TargetClass, trustClass: TrustClass, credentialKind: CredentialKind, dataLocality: DataLocality): boolean;
export declare const providerConstraintRefV1Schema: z.ZodObject<{
    profileId: z.ZodString;
    version: z.ZodNumber;
    digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
}, "strict", z.ZodTypeAny, {
    version: number;
    digest: string & z.BRAND<"Sha256Digest">;
    profileId: string;
}, {
    version: number;
    digest: string;
    profileId: string;
}>;
export type ProviderConstraintRefV1 = z.infer<typeof providerConstraintRefV1Schema>;
export declare const targetRequirementsV1Schema: z.ZodObject<{
    allowedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
    allowedTrustClasses: z.ZodArray<z.ZodEnum<["shared_isolated", "organization_isolated", "owner_local_trusted"]>, "many">;
    requiredOwnerPrincipalId: z.ZodNullable<z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">>;
    credentialKind: z.ZodEnum<["none", "platform_brokered", "organization_brokered", "owner_bound"]>;
    dataLocality: z.ZodEnum<["transfer_allowed", "organization_target_only", "owner_device_only"]>;
    fallback: z.ZodObject<{
        mode: z.ZodEnum<["forbidden", "ordered_explicit"]>;
        orderedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
    }, "strict", z.ZodTypeAny, {
        mode: "forbidden" | "ordered_explicit";
        orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
    }, {
        mode: "forbidden" | "ordered_explicit";
        orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
    }>;
    providerConstraints: z.ZodObject<{
        profileId: z.ZodString;
        version: z.ZodNumber;
        digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
    }, "strict", z.ZodTypeAny, {
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        profileId: string;
    }, {
        version: number;
        digest: string;
        profileId: string;
    }>;
}, "strict", z.ZodTypeAny, {
    allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
    allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
    requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
    credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
    dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
    fallback: {
        mode: "forbidden" | "ordered_explicit";
        orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
    };
    providerConstraints: {
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        profileId: string;
    };
}, {
    allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
    allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
    requiredOwnerPrincipalId: string | null;
    credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
    dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
    fallback: {
        mode: "forbidden" | "ordered_explicit";
        orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
    };
    providerConstraints: {
        version: number;
        digest: string;
        profileId: string;
    };
}>;
export type TargetRequirementsV1 = z.infer<typeof targetRequirementsV1Schema>;
export declare const placementV1Schema: z.ZodObject<{
    policyId: z.ZodString;
    version: z.ZodNumber;
    digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
    targetRequirements: z.ZodObject<{
        allowedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
        allowedTrustClasses: z.ZodArray<z.ZodEnum<["shared_isolated", "organization_isolated", "owner_local_trusted"]>, "many">;
        requiredOwnerPrincipalId: z.ZodNullable<z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">>;
        credentialKind: z.ZodEnum<["none", "platform_brokered", "organization_brokered", "owner_bound"]>;
        dataLocality: z.ZodEnum<["transfer_allowed", "organization_target_only", "owner_device_only"]>;
        fallback: z.ZodObject<{
            mode: z.ZodEnum<["forbidden", "ordered_explicit"]>;
            orderedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
        }, "strict", z.ZodTypeAny, {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        }, {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        }>;
        providerConstraints: z.ZodObject<{
            profileId: z.ZodString;
            version: z.ZodNumber;
            digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
        }, "strict", z.ZodTypeAny, {
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            profileId: string;
        }, {
            version: number;
            digest: string;
            profileId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
        requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
        credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
        dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
        fallback: {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        };
        providerConstraints: {
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            profileId: string;
        };
    }, {
        allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
        requiredOwnerPrincipalId: string | null;
        credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
        dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
        fallback: {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        };
        providerConstraints: {
            version: number;
            digest: string;
            profileId: string;
        };
    }>;
}, "strict", z.ZodTypeAny, {
    policyId: string;
    version: number;
    digest: string & z.BRAND<"Sha256Digest">;
    targetRequirements: {
        allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
        requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
        credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
        dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
        fallback: {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        };
        providerConstraints: {
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            profileId: string;
        };
    };
}, {
    policyId: string;
    version: number;
    digest: string;
    targetRequirements: {
        allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
        requiredOwnerPrincipalId: string | null;
        credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
        dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
        fallback: {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        };
        providerConstraints: {
            version: number;
            digest: string;
            profileId: string;
        };
    };
}>;
export type PlacementV1 = z.infer<typeof placementV1Schema>;
export declare const adapterRefV1Schema: z.ZodObject<{
    type: z.ZodString;
    version: z.ZodString;
    configArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
}, "strict", z.ZodTypeAny, {
    type: string;
    version: string;
    configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
}, {
    type: string;
    version: string;
    configArtifactId: string | null;
}>;
export type AdapterRefV1 = z.infer<typeof adapterRefV1Schema>;
export declare const workspaceV1Schema: z.ZodObject<{
    manifestArtifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
    base: z.ZodEffects<z.ZodObject<{
        kind: z.ZodEnum<["git_commit", "content_manifest"]>;
        algorithm: z.ZodEnum<["git_sha1", "git_sha256", "sha256"]>;
        revision: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
    }, {
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
    }>, {
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
    }, {
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
    }>;
    manifestHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
    mode: z.ZodEnum<["read_only", "read_write"]>;
}, "strict", z.ZodTypeAny, {
    mode: "read_only" | "read_write";
    manifestArtifactId: string & z.BRAND<"ArtifactId">;
    base: {
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
    };
    manifestHash: string & z.BRAND<"Sha256Digest">;
}, {
    mode: "read_only" | "read_write";
    manifestArtifactId: string;
    base: {
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
    };
    manifestHash: string;
}>;
export type WorkspaceV1 = z.infer<typeof workspaceV1Schema>;
export declare const batchWorkloadV1Schema: z.ZodObject<{
    command: z.ZodString;
    args: z.ZodArray<z.ZodString, "many">;
    stdinArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
    maxRuntimeSeconds: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    command: string;
    args: string[];
    stdinArtifactId: (string & z.BRAND<"ArtifactId">) | null;
    maxRuntimeSeconds: number;
}, {
    command: string;
    args: string[];
    stdinArtifactId: string | null;
    maxRuntimeSeconds: number;
}>;
export type BatchWorkloadV1 = z.infer<typeof batchWorkloadV1Schema>;
export declare const browserWorkloadV1Schema: z.ZodObject<{
    engine: z.ZodLiteral<"chromium">;
    viewport: z.ZodObject<{
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        width: number;
        height: number;
    }, {
        width: number;
        height: number;
    }>;
    locale: z.ZodString;
    timezone: z.ZodString;
    recordTrace: z.ZodBoolean;
    recordVideo: z.ZodBoolean;
    maxSessionSeconds: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    engine: "chromium";
    viewport: {
        width: number;
        height: number;
    };
    locale: string;
    timezone: string;
    recordTrace: boolean;
    recordVideo: boolean;
    maxSessionSeconds: number;
}, {
    engine: "chromium";
    viewport: {
        width: number;
        height: number;
    };
    locale: string;
    timezone: string;
    recordTrace: boolean;
    recordVideo: boolean;
    maxSessionSeconds: number;
}>;
export type BrowserWorkloadV1 = z.infer<typeof browserWorkloadV1Schema>;
export declare const serviceWorkloadV1Schema: z.ZodObject<{
    serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
    serviceInstanceId: z.ZodBranded<z.ZodString, "ServiceInstanceId">;
    generation: z.ZodNumber;
    command: z.ZodString;
    args: z.ZodArray<z.ZodString, "many">;
    checkpointArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
    gracefulStopSeconds: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    serviceId: string & z.BRAND<"ServiceId">;
    generation: number;
    command: string;
    args: string[];
    serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
    checkpointArtifactId: (string & z.BRAND<"ArtifactId">) | null;
    gracefulStopSeconds: number;
}, {
    serviceId: string;
    generation: number;
    command: string;
    args: string[];
    serviceInstanceId: string;
    checkpointArtifactId: string | null;
    gracefulStopSeconds: number;
}>;
export type ServiceWorkloadV1 = z.infer<typeof serviceWorkloadV1Schema>;
/** The strict V1 job envelope union, discriminated by `workloadType`, with all
 * cross-field security invariants applied. */
export declare const jobEnvelopeV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"workloadType", [z.ZodObject<z.objectUtil.extendShape<{
    protocolVersion: z.ZodLiteral<1>;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    source: z.ZodEffects<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"task_run">;
        runId: z.ZodBranded<z.ZodString, "RunId">;
        issueId: z.ZodBranded<z.ZodString, "IssueId">;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        assigneeAgentId: z.ZodBranded<z.ZodString, "AgentId">;
    }, "strict", z.ZodTypeAny, {
        kind: "task_run";
        runId: string & z.BRAND<"RunId">;
        issueId: string & z.BRAND<"IssueId">;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        assigneeAgentId: string & z.BRAND<"AgentId">;
    }, {
        kind: "task_run";
        runId: string;
        issueId: string;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        assigneeAgentId: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"commander_turn">;
        internalAgentRunId: z.ZodBranded<z.ZodString, "InternalAgentRunId">;
        conversationId: z.ZodBranded<z.ZodString, "ConversationId">;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
        conversationId: string & z.BRAND<"ConversationId">;
    }, {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        internalAgentRunId: string;
        conversationId: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"crew_run">;
        crewRunId: z.ZodBranded<z.ZodString, "CrewRunId">;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        crewRunId: string & z.BRAND<"CrewRunId">;
    }, {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        crewRunId: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"one_shot">;
        operationId: z.ZodBranded<z.ZodString, "OneShotOperationId">;
        operationKind: z.ZodEnum<["extraction", "compaction", "readiness_probe"]>;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        operationId: string & z.BRAND<"OneShotOperationId">;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    }, {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        operationId: string;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"browser_request">;
        browserRequestId: z.ZodBranded<z.ZodString, "BrowserRequestId">;
        parentJobId: z.ZodNullable<z.ZodBranded<z.ZodString, "JobId">>;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        browserRequestId: string & z.BRAND<"BrowserRequestId">;
        parentJobId: (string & z.BRAND<"JobId">) | null;
    }, {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        browserRequestId: string;
        parentJobId: string | null;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"service_reconcile">;
        serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
        generation: z.ZodNumber;
        reconciliationId: z.ZodBranded<z.ZodString, "ReconciliationId">;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        reconciliationId: string & z.BRAND<"ReconciliationId">;
    }, {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        serviceId: string;
        generation: number;
        reconciliationId: string;
    }>]>, {
        kind: "task_run";
        runId: string & z.BRAND<"RunId">;
        issueId: string & z.BRAND<"IssueId">;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        assigneeAgentId: string & z.BRAND<"AgentId">;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
        conversationId: string & z.BRAND<"ConversationId">;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        crewRunId: string & z.BRAND<"CrewRunId">;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        operationId: string & z.BRAND<"OneShotOperationId">;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        browserRequestId: string & z.BRAND<"BrowserRequestId">;
        parentJobId: (string & z.BRAND<"JobId">) | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        reconciliationId: string & z.BRAND<"ReconciliationId">;
    }, {
        kind: "task_run";
        runId: string;
        issueId: string;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        assigneeAgentId: string;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        internalAgentRunId: string;
        conversationId: string;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        crewRunId: string;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        operationId: string;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        browserRequestId: string;
        parentJobId: string | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        serviceId: string;
        generation: number;
        reconciliationId: string;
    }>;
    createdAt: z.ZodString;
    notBefore: z.ZodNullable<z.ZodString>;
    deadline: z.ZodString;
    inputHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
    policyHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
    placement: z.ZodObject<{
        policyId: z.ZodString;
        version: z.ZodNumber;
        digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
        targetRequirements: z.ZodObject<{
            allowedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
            allowedTrustClasses: z.ZodArray<z.ZodEnum<["shared_isolated", "organization_isolated", "owner_local_trusted"]>, "many">;
            requiredOwnerPrincipalId: z.ZodNullable<z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">>;
            credentialKind: z.ZodEnum<["none", "platform_brokered", "organization_brokered", "owner_bound"]>;
            dataLocality: z.ZodEnum<["transfer_allowed", "organization_target_only", "owner_device_only"]>;
            fallback: z.ZodObject<{
                mode: z.ZodEnum<["forbidden", "ordered_explicit"]>;
                orderedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
            }, "strict", z.ZodTypeAny, {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            }, {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            }>;
            providerConstraints: z.ZodObject<{
                profileId: z.ZodString;
                version: z.ZodNumber;
                digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            }, "strict", z.ZodTypeAny, {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            }, {
                version: number;
                digest: string;
                profileId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            };
        }, {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: string | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string;
                profileId: string;
            };
        }>;
    }, "strict", z.ZodTypeAny, {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            };
        };
    }, {
        policyId: string;
        version: number;
        digest: string;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: string | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string;
                profileId: string;
            };
        };
    }>;
    adapter: z.ZodObject<{
        type: z.ZodString;
        version: z.ZodString;
        configArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
    }, "strict", z.ZodTypeAny, {
        type: string;
        version: string;
        configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
    }, {
        type: string;
        version: string;
        configArtifactId: string | null;
    }>;
    requiredCapabilities: z.ZodArray<z.ZodString, "many">;
    workspace: z.ZodNullable<z.ZodObject<{
        manifestArtifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
        base: z.ZodEffects<z.ZodObject<{
            kind: z.ZodEnum<["git_commit", "content_manifest"]>;
            algorithm: z.ZodEnum<["git_sha1", "git_sha256", "sha256"]>;
            revision: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        }, {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        }>, {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        }, {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        }>;
        manifestHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
        mode: z.ZodEnum<["read_only", "read_write"]>;
    }, "strict", z.ZodTypeAny, {
        mode: "read_only" | "read_write";
        manifestArtifactId: string & z.BRAND<"ArtifactId">;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string & z.BRAND<"Sha256Digest">;
    }, {
        mode: "read_only" | "read_write";
        manifestArtifactId: string;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string;
    }>>;
    secretHandles: z.ZodArray<z.ZodEffects<z.ZodObject<{
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
    }>, "many">;
    resourceLimits: z.ZodObject<{
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
    networkPolicy: z.ZodEffects<z.ZodObject<{
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
    offlinePolicy: z.ZodEnum<["cancel", "finish_without_remote_effects", "continue_until_lease_expiry"]>;
    extensions: z.ZodArray<z.ZodObject<{
        namespace: z.ZodEffects<z.ZodString, string, string>;
        schemaVersion: z.ZodNumber;
        critical: z.ZodBoolean;
        value: z.ZodUnknown;
    }, "strict", z.ZodTypeAny, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }>, "many">;
}, {
    workloadType: z.ZodLiteral<"batch">;
    workload: z.ZodObject<{
        command: z.ZodString;
        args: z.ZodArray<z.ZodString, "many">;
        stdinArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
        maxRuntimeSeconds: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        command: string;
        args: string[];
        stdinArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        maxRuntimeSeconds: number;
    }, {
        command: string;
        args: string[];
        stdinArtifactId: string | null;
        maxRuntimeSeconds: number;
    }>;
}>, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    source: {
        kind: "task_run";
        runId: string & z.BRAND<"RunId">;
        issueId: string & z.BRAND<"IssueId">;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        assigneeAgentId: string & z.BRAND<"AgentId">;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
        conversationId: string & z.BRAND<"ConversationId">;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        crewRunId: string & z.BRAND<"CrewRunId">;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        operationId: string & z.BRAND<"OneShotOperationId">;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        browserRequestId: string & z.BRAND<"BrowserRequestId">;
        parentJobId: (string & z.BRAND<"JobId">) | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        reconciliationId: string & z.BRAND<"ReconciliationId">;
    };
    createdAt: string;
    notBefore: string | null;
    deadline: string;
    inputHash: string & z.BRAND<"Sha256Digest">;
    policyHash: string & z.BRAND<"Sha256Digest">;
    placement: {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            };
        };
    };
    adapter: {
        type: string;
        version: string;
        configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
    };
    requiredCapabilities: string[];
    workspace: {
        mode: "read_only" | "read_write";
        manifestArtifactId: string & z.BRAND<"ArtifactId">;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string & z.BRAND<"Sha256Digest">;
    } | null;
    secretHandles: {
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
    }[];
    resourceLimits: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    networkPolicy: {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
    };
    offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
    extensions: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[];
    workloadType: "batch";
    workload: {
        command: string;
        args: string[];
        stdinArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        maxRuntimeSeconds: number;
    };
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    source: {
        kind: "task_run";
        runId: string;
        issueId: string;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        assigneeAgentId: string;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        internalAgentRunId: string;
        conversationId: string;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        crewRunId: string;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        operationId: string;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        browserRequestId: string;
        parentJobId: string | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        serviceId: string;
        generation: number;
        reconciliationId: string;
    };
    createdAt: string;
    notBefore: string | null;
    deadline: string;
    inputHash: string;
    policyHash: string;
    placement: {
        policyId: string;
        version: number;
        digest: string;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: string | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string;
                profileId: string;
            };
        };
    };
    adapter: {
        type: string;
        version: string;
        configArtifactId: string | null;
    };
    requiredCapabilities: string[];
    workspace: {
        mode: "read_only" | "read_write";
        manifestArtifactId: string;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string;
    } | null;
    secretHandles: {
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
    }[];
    resourceLimits: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    networkPolicy: {
        policyId: string;
        version: number;
        digest: string;
    };
    offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
    extensions: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[];
    workloadType: "batch";
    workload: {
        command: string;
        args: string[];
        stdinArtifactId: string | null;
        maxRuntimeSeconds: number;
    };
}>, z.ZodObject<z.objectUtil.extendShape<{
    protocolVersion: z.ZodLiteral<1>;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    source: z.ZodEffects<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"task_run">;
        runId: z.ZodBranded<z.ZodString, "RunId">;
        issueId: z.ZodBranded<z.ZodString, "IssueId">;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        assigneeAgentId: z.ZodBranded<z.ZodString, "AgentId">;
    }, "strict", z.ZodTypeAny, {
        kind: "task_run";
        runId: string & z.BRAND<"RunId">;
        issueId: string & z.BRAND<"IssueId">;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        assigneeAgentId: string & z.BRAND<"AgentId">;
    }, {
        kind: "task_run";
        runId: string;
        issueId: string;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        assigneeAgentId: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"commander_turn">;
        internalAgentRunId: z.ZodBranded<z.ZodString, "InternalAgentRunId">;
        conversationId: z.ZodBranded<z.ZodString, "ConversationId">;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
        conversationId: string & z.BRAND<"ConversationId">;
    }, {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        internalAgentRunId: string;
        conversationId: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"crew_run">;
        crewRunId: z.ZodBranded<z.ZodString, "CrewRunId">;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        crewRunId: string & z.BRAND<"CrewRunId">;
    }, {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        crewRunId: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"one_shot">;
        operationId: z.ZodBranded<z.ZodString, "OneShotOperationId">;
        operationKind: z.ZodEnum<["extraction", "compaction", "readiness_probe"]>;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        operationId: string & z.BRAND<"OneShotOperationId">;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    }, {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        operationId: string;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"browser_request">;
        browserRequestId: z.ZodBranded<z.ZodString, "BrowserRequestId">;
        parentJobId: z.ZodNullable<z.ZodBranded<z.ZodString, "JobId">>;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        browserRequestId: string & z.BRAND<"BrowserRequestId">;
        parentJobId: (string & z.BRAND<"JobId">) | null;
    }, {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        browserRequestId: string;
        parentJobId: string | null;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"service_reconcile">;
        serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
        generation: z.ZodNumber;
        reconciliationId: z.ZodBranded<z.ZodString, "ReconciliationId">;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        reconciliationId: string & z.BRAND<"ReconciliationId">;
    }, {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        serviceId: string;
        generation: number;
        reconciliationId: string;
    }>]>, {
        kind: "task_run";
        runId: string & z.BRAND<"RunId">;
        issueId: string & z.BRAND<"IssueId">;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        assigneeAgentId: string & z.BRAND<"AgentId">;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
        conversationId: string & z.BRAND<"ConversationId">;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        crewRunId: string & z.BRAND<"CrewRunId">;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        operationId: string & z.BRAND<"OneShotOperationId">;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        browserRequestId: string & z.BRAND<"BrowserRequestId">;
        parentJobId: (string & z.BRAND<"JobId">) | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        reconciliationId: string & z.BRAND<"ReconciliationId">;
    }, {
        kind: "task_run";
        runId: string;
        issueId: string;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        assigneeAgentId: string;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        internalAgentRunId: string;
        conversationId: string;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        crewRunId: string;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        operationId: string;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        browserRequestId: string;
        parentJobId: string | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        serviceId: string;
        generation: number;
        reconciliationId: string;
    }>;
    createdAt: z.ZodString;
    notBefore: z.ZodNullable<z.ZodString>;
    deadline: z.ZodString;
    inputHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
    policyHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
    placement: z.ZodObject<{
        policyId: z.ZodString;
        version: z.ZodNumber;
        digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
        targetRequirements: z.ZodObject<{
            allowedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
            allowedTrustClasses: z.ZodArray<z.ZodEnum<["shared_isolated", "organization_isolated", "owner_local_trusted"]>, "many">;
            requiredOwnerPrincipalId: z.ZodNullable<z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">>;
            credentialKind: z.ZodEnum<["none", "platform_brokered", "organization_brokered", "owner_bound"]>;
            dataLocality: z.ZodEnum<["transfer_allowed", "organization_target_only", "owner_device_only"]>;
            fallback: z.ZodObject<{
                mode: z.ZodEnum<["forbidden", "ordered_explicit"]>;
                orderedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
            }, "strict", z.ZodTypeAny, {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            }, {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            }>;
            providerConstraints: z.ZodObject<{
                profileId: z.ZodString;
                version: z.ZodNumber;
                digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            }, "strict", z.ZodTypeAny, {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            }, {
                version: number;
                digest: string;
                profileId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            };
        }, {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: string | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string;
                profileId: string;
            };
        }>;
    }, "strict", z.ZodTypeAny, {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            };
        };
    }, {
        policyId: string;
        version: number;
        digest: string;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: string | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string;
                profileId: string;
            };
        };
    }>;
    adapter: z.ZodObject<{
        type: z.ZodString;
        version: z.ZodString;
        configArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
    }, "strict", z.ZodTypeAny, {
        type: string;
        version: string;
        configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
    }, {
        type: string;
        version: string;
        configArtifactId: string | null;
    }>;
    requiredCapabilities: z.ZodArray<z.ZodString, "many">;
    workspace: z.ZodNullable<z.ZodObject<{
        manifestArtifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
        base: z.ZodEffects<z.ZodObject<{
            kind: z.ZodEnum<["git_commit", "content_manifest"]>;
            algorithm: z.ZodEnum<["git_sha1", "git_sha256", "sha256"]>;
            revision: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        }, {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        }>, {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        }, {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        }>;
        manifestHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
        mode: z.ZodEnum<["read_only", "read_write"]>;
    }, "strict", z.ZodTypeAny, {
        mode: "read_only" | "read_write";
        manifestArtifactId: string & z.BRAND<"ArtifactId">;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string & z.BRAND<"Sha256Digest">;
    }, {
        mode: "read_only" | "read_write";
        manifestArtifactId: string;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string;
    }>>;
    secretHandles: z.ZodArray<z.ZodEffects<z.ZodObject<{
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
    }>, "many">;
    resourceLimits: z.ZodObject<{
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
    networkPolicy: z.ZodEffects<z.ZodObject<{
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
    offlinePolicy: z.ZodEnum<["cancel", "finish_without_remote_effects", "continue_until_lease_expiry"]>;
    extensions: z.ZodArray<z.ZodObject<{
        namespace: z.ZodEffects<z.ZodString, string, string>;
        schemaVersion: z.ZodNumber;
        critical: z.ZodBoolean;
        value: z.ZodUnknown;
    }, "strict", z.ZodTypeAny, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }>, "many">;
}, {
    workloadType: z.ZodLiteral<"browser_session">;
    workload: z.ZodObject<{
        engine: z.ZodLiteral<"chromium">;
        viewport: z.ZodObject<{
            width: z.ZodNumber;
            height: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            width: number;
            height: number;
        }, {
            width: number;
            height: number;
        }>;
        locale: z.ZodString;
        timezone: z.ZodString;
        recordTrace: z.ZodBoolean;
        recordVideo: z.ZodBoolean;
        maxSessionSeconds: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        engine: "chromium";
        viewport: {
            width: number;
            height: number;
        };
        locale: string;
        timezone: string;
        recordTrace: boolean;
        recordVideo: boolean;
        maxSessionSeconds: number;
    }, {
        engine: "chromium";
        viewport: {
            width: number;
            height: number;
        };
        locale: string;
        timezone: string;
        recordTrace: boolean;
        recordVideo: boolean;
        maxSessionSeconds: number;
    }>;
}>, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    source: {
        kind: "task_run";
        runId: string & z.BRAND<"RunId">;
        issueId: string & z.BRAND<"IssueId">;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        assigneeAgentId: string & z.BRAND<"AgentId">;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
        conversationId: string & z.BRAND<"ConversationId">;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        crewRunId: string & z.BRAND<"CrewRunId">;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        operationId: string & z.BRAND<"OneShotOperationId">;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        browserRequestId: string & z.BRAND<"BrowserRequestId">;
        parentJobId: (string & z.BRAND<"JobId">) | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        reconciliationId: string & z.BRAND<"ReconciliationId">;
    };
    createdAt: string;
    notBefore: string | null;
    deadline: string;
    inputHash: string & z.BRAND<"Sha256Digest">;
    policyHash: string & z.BRAND<"Sha256Digest">;
    placement: {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            };
        };
    };
    adapter: {
        type: string;
        version: string;
        configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
    };
    requiredCapabilities: string[];
    workspace: {
        mode: "read_only" | "read_write";
        manifestArtifactId: string & z.BRAND<"ArtifactId">;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string & z.BRAND<"Sha256Digest">;
    } | null;
    secretHandles: {
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
    }[];
    resourceLimits: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    networkPolicy: {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
    };
    offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
    extensions: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[];
    workloadType: "browser_session";
    workload: {
        engine: "chromium";
        viewport: {
            width: number;
            height: number;
        };
        locale: string;
        timezone: string;
        recordTrace: boolean;
        recordVideo: boolean;
        maxSessionSeconds: number;
    };
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    source: {
        kind: "task_run";
        runId: string;
        issueId: string;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        assigneeAgentId: string;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        internalAgentRunId: string;
        conversationId: string;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        crewRunId: string;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        operationId: string;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        browserRequestId: string;
        parentJobId: string | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        serviceId: string;
        generation: number;
        reconciliationId: string;
    };
    createdAt: string;
    notBefore: string | null;
    deadline: string;
    inputHash: string;
    policyHash: string;
    placement: {
        policyId: string;
        version: number;
        digest: string;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: string | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string;
                profileId: string;
            };
        };
    };
    adapter: {
        type: string;
        version: string;
        configArtifactId: string | null;
    };
    requiredCapabilities: string[];
    workspace: {
        mode: "read_only" | "read_write";
        manifestArtifactId: string;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string;
    } | null;
    secretHandles: {
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
    }[];
    resourceLimits: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    networkPolicy: {
        policyId: string;
        version: number;
        digest: string;
    };
    offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
    extensions: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[];
    workloadType: "browser_session";
    workload: {
        engine: "chromium";
        viewport: {
            width: number;
            height: number;
        };
        locale: string;
        timezone: string;
        recordTrace: boolean;
        recordVideo: boolean;
        maxSessionSeconds: number;
    };
}>, z.ZodObject<z.objectUtil.extendShape<{
    protocolVersion: z.ZodLiteral<1>;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    source: z.ZodEffects<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"task_run">;
        runId: z.ZodBranded<z.ZodString, "RunId">;
        issueId: z.ZodBranded<z.ZodString, "IssueId">;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        assigneeAgentId: z.ZodBranded<z.ZodString, "AgentId">;
    }, "strict", z.ZodTypeAny, {
        kind: "task_run";
        runId: string & z.BRAND<"RunId">;
        issueId: string & z.BRAND<"IssueId">;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        assigneeAgentId: string & z.BRAND<"AgentId">;
    }, {
        kind: "task_run";
        runId: string;
        issueId: string;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        assigneeAgentId: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"commander_turn">;
        internalAgentRunId: z.ZodBranded<z.ZodString, "InternalAgentRunId">;
        conversationId: z.ZodBranded<z.ZodString, "ConversationId">;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
        conversationId: string & z.BRAND<"ConversationId">;
    }, {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        internalAgentRunId: string;
        conversationId: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"crew_run">;
        crewRunId: z.ZodBranded<z.ZodString, "CrewRunId">;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        crewRunId: string & z.BRAND<"CrewRunId">;
    }, {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        crewRunId: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"one_shot">;
        operationId: z.ZodBranded<z.ZodString, "OneShotOperationId">;
        operationKind: z.ZodEnum<["extraction", "compaction", "readiness_probe"]>;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        operationId: string & z.BRAND<"OneShotOperationId">;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    }, {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        operationId: string;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"browser_request">;
        browserRequestId: z.ZodBranded<z.ZodString, "BrowserRequestId">;
        parentJobId: z.ZodNullable<z.ZodBranded<z.ZodString, "JobId">>;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        browserRequestId: string & z.BRAND<"BrowserRequestId">;
        parentJobId: (string & z.BRAND<"JobId">) | null;
    }, {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        browserRequestId: string;
        parentJobId: string | null;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"service_reconcile">;
        serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
        generation: z.ZodNumber;
        reconciliationId: z.ZodBranded<z.ZodString, "ReconciliationId">;
        requestedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        executionPrincipal: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        reconciliationId: string & z.BRAND<"ReconciliationId">;
    }, {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        serviceId: string;
        generation: number;
        reconciliationId: string;
    }>]>, {
        kind: "task_run";
        runId: string & z.BRAND<"RunId">;
        issueId: string & z.BRAND<"IssueId">;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        assigneeAgentId: string & z.BRAND<"AgentId">;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
        conversationId: string & z.BRAND<"ConversationId">;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        crewRunId: string & z.BRAND<"CrewRunId">;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        operationId: string & z.BRAND<"OneShotOperationId">;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        browserRequestId: string & z.BRAND<"BrowserRequestId">;
        parentJobId: (string & z.BRAND<"JobId">) | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        reconciliationId: string & z.BRAND<"ReconciliationId">;
    }, {
        kind: "task_run";
        runId: string;
        issueId: string;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        assigneeAgentId: string;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        internalAgentRunId: string;
        conversationId: string;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        crewRunId: string;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        operationId: string;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        browserRequestId: string;
        parentJobId: string | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        serviceId: string;
        generation: number;
        reconciliationId: string;
    }>;
    createdAt: z.ZodString;
    notBefore: z.ZodNullable<z.ZodString>;
    deadline: z.ZodString;
    inputHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
    policyHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
    placement: z.ZodObject<{
        policyId: z.ZodString;
        version: z.ZodNumber;
        digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
        targetRequirements: z.ZodObject<{
            allowedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
            allowedTrustClasses: z.ZodArray<z.ZodEnum<["shared_isolated", "organization_isolated", "owner_local_trusted"]>, "many">;
            requiredOwnerPrincipalId: z.ZodNullable<z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">>;
            credentialKind: z.ZodEnum<["none", "platform_brokered", "organization_brokered", "owner_bound"]>;
            dataLocality: z.ZodEnum<["transfer_allowed", "organization_target_only", "owner_device_only"]>;
            fallback: z.ZodObject<{
                mode: z.ZodEnum<["forbidden", "ordered_explicit"]>;
                orderedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
            }, "strict", z.ZodTypeAny, {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            }, {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            }>;
            providerConstraints: z.ZodObject<{
                profileId: z.ZodString;
                version: z.ZodNumber;
                digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            }, "strict", z.ZodTypeAny, {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            }, {
                version: number;
                digest: string;
                profileId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            };
        }, {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: string | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string;
                profileId: string;
            };
        }>;
    }, "strict", z.ZodTypeAny, {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            };
        };
    }, {
        policyId: string;
        version: number;
        digest: string;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: string | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string;
                profileId: string;
            };
        };
    }>;
    adapter: z.ZodObject<{
        type: z.ZodString;
        version: z.ZodString;
        configArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
    }, "strict", z.ZodTypeAny, {
        type: string;
        version: string;
        configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
    }, {
        type: string;
        version: string;
        configArtifactId: string | null;
    }>;
    requiredCapabilities: z.ZodArray<z.ZodString, "many">;
    workspace: z.ZodNullable<z.ZodObject<{
        manifestArtifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
        base: z.ZodEffects<z.ZodObject<{
            kind: z.ZodEnum<["git_commit", "content_manifest"]>;
            algorithm: z.ZodEnum<["git_sha1", "git_sha256", "sha256"]>;
            revision: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        }, {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        }>, {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        }, {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        }>;
        manifestHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
        mode: z.ZodEnum<["read_only", "read_write"]>;
    }, "strict", z.ZodTypeAny, {
        mode: "read_only" | "read_write";
        manifestArtifactId: string & z.BRAND<"ArtifactId">;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string & z.BRAND<"Sha256Digest">;
    }, {
        mode: "read_only" | "read_write";
        manifestArtifactId: string;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string;
    }>>;
    secretHandles: z.ZodArray<z.ZodEffects<z.ZodObject<{
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
    }>, "many">;
    resourceLimits: z.ZodObject<{
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
    networkPolicy: z.ZodEffects<z.ZodObject<{
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
    offlinePolicy: z.ZodEnum<["cancel", "finish_without_remote_effects", "continue_until_lease_expiry"]>;
    extensions: z.ZodArray<z.ZodObject<{
        namespace: z.ZodEffects<z.ZodString, string, string>;
        schemaVersion: z.ZodNumber;
        critical: z.ZodBoolean;
        value: z.ZodUnknown;
    }, "strict", z.ZodTypeAny, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }>, "many">;
}, {
    workloadType: z.ZodLiteral<"service">;
    workload: z.ZodObject<{
        serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
        serviceInstanceId: z.ZodBranded<z.ZodString, "ServiceInstanceId">;
        generation: z.ZodNumber;
        command: z.ZodString;
        args: z.ZodArray<z.ZodString, "many">;
        checkpointArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
        gracefulStopSeconds: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        command: string;
        args: string[];
        serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
        checkpointArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        gracefulStopSeconds: number;
    }, {
        serviceId: string;
        generation: number;
        command: string;
        args: string[];
        serviceInstanceId: string;
        checkpointArtifactId: string | null;
        gracefulStopSeconds: number;
    }>;
}>, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    source: {
        kind: "task_run";
        runId: string & z.BRAND<"RunId">;
        issueId: string & z.BRAND<"IssueId">;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        assigneeAgentId: string & z.BRAND<"AgentId">;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
        conversationId: string & z.BRAND<"ConversationId">;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        crewRunId: string & z.BRAND<"CrewRunId">;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        operationId: string & z.BRAND<"OneShotOperationId">;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        browserRequestId: string & z.BRAND<"BrowserRequestId">;
        parentJobId: (string & z.BRAND<"JobId">) | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        reconciliationId: string & z.BRAND<"ReconciliationId">;
    };
    createdAt: string;
    notBefore: string | null;
    deadline: string;
    inputHash: string & z.BRAND<"Sha256Digest">;
    policyHash: string & z.BRAND<"Sha256Digest">;
    placement: {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            };
        };
    };
    adapter: {
        type: string;
        version: string;
        configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
    };
    requiredCapabilities: string[];
    workspace: {
        mode: "read_only" | "read_write";
        manifestArtifactId: string & z.BRAND<"ArtifactId">;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string & z.BRAND<"Sha256Digest">;
    } | null;
    secretHandles: {
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
    }[];
    resourceLimits: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    networkPolicy: {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
    };
    offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
    extensions: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[];
    workloadType: "service";
    workload: {
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        command: string;
        args: string[];
        serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
        checkpointArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        gracefulStopSeconds: number;
    };
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    source: {
        kind: "task_run";
        runId: string;
        issueId: string;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        assigneeAgentId: string;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        internalAgentRunId: string;
        conversationId: string;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        crewRunId: string;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        operationId: string;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        browserRequestId: string;
        parentJobId: string | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        serviceId: string;
        generation: number;
        reconciliationId: string;
    };
    createdAt: string;
    notBefore: string | null;
    deadline: string;
    inputHash: string;
    policyHash: string;
    placement: {
        policyId: string;
        version: number;
        digest: string;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: string | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string;
                profileId: string;
            };
        };
    };
    adapter: {
        type: string;
        version: string;
        configArtifactId: string | null;
    };
    requiredCapabilities: string[];
    workspace: {
        mode: "read_only" | "read_write";
        manifestArtifactId: string;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string;
    } | null;
    secretHandles: {
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
    }[];
    resourceLimits: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    networkPolicy: {
        policyId: string;
        version: number;
        digest: string;
    };
    offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
    extensions: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[];
    workloadType: "service";
    workload: {
        serviceId: string;
        generation: number;
        command: string;
        args: string[];
        serviceInstanceId: string;
        checkpointArtifactId: string | null;
        gracefulStopSeconds: number;
    };
}>]>, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    source: {
        kind: "task_run";
        runId: string & z.BRAND<"RunId">;
        issueId: string & z.BRAND<"IssueId">;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        assigneeAgentId: string & z.BRAND<"AgentId">;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
        conversationId: string & z.BRAND<"ConversationId">;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        crewRunId: string & z.BRAND<"CrewRunId">;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        operationId: string & z.BRAND<"OneShotOperationId">;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        browserRequestId: string & z.BRAND<"BrowserRequestId">;
        parentJobId: (string & z.BRAND<"JobId">) | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        reconciliationId: string & z.BRAND<"ReconciliationId">;
    };
    createdAt: string;
    notBefore: string | null;
    deadline: string;
    inputHash: string & z.BRAND<"Sha256Digest">;
    policyHash: string & z.BRAND<"Sha256Digest">;
    placement: {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            };
        };
    };
    adapter: {
        type: string;
        version: string;
        configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
    };
    requiredCapabilities: string[];
    workspace: {
        mode: "read_only" | "read_write";
        manifestArtifactId: string & z.BRAND<"ArtifactId">;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string & z.BRAND<"Sha256Digest">;
    } | null;
    secretHandles: {
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
    }[];
    resourceLimits: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    networkPolicy: {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
    };
    offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
    extensions: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[];
    workloadType: "batch";
    workload: {
        command: string;
        args: string[];
        stdinArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        maxRuntimeSeconds: number;
    };
} | {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    source: {
        kind: "task_run";
        runId: string & z.BRAND<"RunId">;
        issueId: string & z.BRAND<"IssueId">;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        assigneeAgentId: string & z.BRAND<"AgentId">;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
        conversationId: string & z.BRAND<"ConversationId">;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        crewRunId: string & z.BRAND<"CrewRunId">;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        operationId: string & z.BRAND<"OneShotOperationId">;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        browserRequestId: string & z.BRAND<"BrowserRequestId">;
        parentJobId: (string & z.BRAND<"JobId">) | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        reconciliationId: string & z.BRAND<"ReconciliationId">;
    };
    createdAt: string;
    notBefore: string | null;
    deadline: string;
    inputHash: string & z.BRAND<"Sha256Digest">;
    policyHash: string & z.BRAND<"Sha256Digest">;
    placement: {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            };
        };
    };
    adapter: {
        type: string;
        version: string;
        configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
    };
    requiredCapabilities: string[];
    workspace: {
        mode: "read_only" | "read_write";
        manifestArtifactId: string & z.BRAND<"ArtifactId">;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string & z.BRAND<"Sha256Digest">;
    } | null;
    secretHandles: {
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
    }[];
    resourceLimits: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    networkPolicy: {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
    };
    offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
    extensions: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[];
    workloadType: "browser_session";
    workload: {
        engine: "chromium";
        viewport: {
            width: number;
            height: number;
        };
        locale: string;
        timezone: string;
        recordTrace: boolean;
        recordVideo: boolean;
        maxSessionSeconds: number;
    };
} | {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    source: {
        kind: "task_run";
        runId: string & z.BRAND<"RunId">;
        issueId: string & z.BRAND<"IssueId">;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        assigneeAgentId: string & z.BRAND<"AgentId">;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
        conversationId: string & z.BRAND<"ConversationId">;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        crewRunId: string & z.BRAND<"CrewRunId">;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        operationId: string & z.BRAND<"OneShotOperationId">;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        browserRequestId: string & z.BRAND<"BrowserRequestId">;
        parentJobId: (string & z.BRAND<"JobId">) | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        reconciliationId: string & z.BRAND<"ReconciliationId">;
    };
    createdAt: string;
    notBefore: string | null;
    deadline: string;
    inputHash: string & z.BRAND<"Sha256Digest">;
    policyHash: string & z.BRAND<"Sha256Digest">;
    placement: {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string & z.BRAND<"Sha256Digest">;
                profileId: string;
            };
        };
    };
    adapter: {
        type: string;
        version: string;
        configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
    };
    requiredCapabilities: string[];
    workspace: {
        mode: "read_only" | "read_write";
        manifestArtifactId: string & z.BRAND<"ArtifactId">;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string & z.BRAND<"Sha256Digest">;
    } | null;
    secretHandles: {
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
    }[];
    resourceLimits: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    networkPolicy: {
        policyId: string;
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
    };
    offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
    extensions: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[];
    workloadType: "service";
    workload: {
        serviceId: string & z.BRAND<"ServiceId">;
        generation: number;
        command: string;
        args: string[];
        serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
        checkpointArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        gracefulStopSeconds: number;
    };
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    source: {
        kind: "task_run";
        runId: string;
        issueId: string;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        assigneeAgentId: string;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        internalAgentRunId: string;
        conversationId: string;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        crewRunId: string;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        operationId: string;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        browserRequestId: string;
        parentJobId: string | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        serviceId: string;
        generation: number;
        reconciliationId: string;
    };
    createdAt: string;
    notBefore: string | null;
    deadline: string;
    inputHash: string;
    policyHash: string;
    placement: {
        policyId: string;
        version: number;
        digest: string;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: string | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string;
                profileId: string;
            };
        };
    };
    adapter: {
        type: string;
        version: string;
        configArtifactId: string | null;
    };
    requiredCapabilities: string[];
    workspace: {
        mode: "read_only" | "read_write";
        manifestArtifactId: string;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string;
    } | null;
    secretHandles: {
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
    }[];
    resourceLimits: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    networkPolicy: {
        policyId: string;
        version: number;
        digest: string;
    };
    offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
    extensions: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[];
    workloadType: "batch";
    workload: {
        command: string;
        args: string[];
        stdinArtifactId: string | null;
        maxRuntimeSeconds: number;
    };
} | {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    source: {
        kind: "task_run";
        runId: string;
        issueId: string;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        assigneeAgentId: string;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        internalAgentRunId: string;
        conversationId: string;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        crewRunId: string;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        operationId: string;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        browserRequestId: string;
        parentJobId: string | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        serviceId: string;
        generation: number;
        reconciliationId: string;
    };
    createdAt: string;
    notBefore: string | null;
    deadline: string;
    inputHash: string;
    policyHash: string;
    placement: {
        policyId: string;
        version: number;
        digest: string;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: string | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string;
                profileId: string;
            };
        };
    };
    adapter: {
        type: string;
        version: string;
        configArtifactId: string | null;
    };
    requiredCapabilities: string[];
    workspace: {
        mode: "read_only" | "read_write";
        manifestArtifactId: string;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string;
    } | null;
    secretHandles: {
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
    }[];
    resourceLimits: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    networkPolicy: {
        policyId: string;
        version: number;
        digest: string;
    };
    offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
    extensions: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[];
    workloadType: "browser_session";
    workload: {
        engine: "chromium";
        viewport: {
            width: number;
            height: number;
        };
        locale: string;
        timezone: string;
        recordTrace: boolean;
        recordVideo: boolean;
        maxSessionSeconds: number;
    };
} | {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    source: {
        kind: "task_run";
        runId: string;
        issueId: string;
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        assigneeAgentId: string;
    } | {
        kind: "commander_turn";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        internalAgentRunId: string;
        conversationId: string;
    } | {
        kind: "crew_run";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        crewRunId: string;
    } | {
        kind: "one_shot";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        operationId: string;
        operationKind: "extraction" | "compaction" | "readiness_probe";
    } | {
        kind: "browser_request";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        browserRequestId: string;
        parentJobId: string | null;
    } | {
        kind: "service_reconcile";
        requestedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        executionPrincipal: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        serviceId: string;
        generation: number;
        reconciliationId: string;
    };
    createdAt: string;
    notBefore: string | null;
    deadline: string;
    inputHash: string;
    policyHash: string;
    placement: {
        policyId: string;
        version: number;
        digest: string;
        targetRequirements: {
            allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
            requiredOwnerPrincipalId: string | null;
            credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
            dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
            fallback: {
                mode: "forbidden" | "ordered_explicit";
                orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
            };
            providerConstraints: {
                version: number;
                digest: string;
                profileId: string;
            };
        };
    };
    adapter: {
        type: string;
        version: string;
        configArtifactId: string | null;
    };
    requiredCapabilities: string[];
    workspace: {
        mode: "read_only" | "read_write";
        manifestArtifactId: string;
        base: {
            kind: "git_commit" | "content_manifest";
            algorithm: "git_sha1" | "git_sha256" | "sha256";
            revision: string;
        };
        manifestHash: string;
    } | null;
    secretHandles: {
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
    }[];
    resourceLimits: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    networkPolicy: {
        policyId: string;
        version: number;
        digest: string;
    };
    offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
    extensions: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[];
    workloadType: "service";
    workload: {
        serviceId: string;
        generation: number;
        command: string;
        args: string[];
        serviceInstanceId: string;
        checkpointArtifactId: string | null;
        gracefulStopSeconds: number;
    };
}>;
export type JobEnvelopeV1 = z.infer<typeof jobEnvelopeV1Schema>;
export declare const leaseOfferV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    ackDeadline: z.ZodString;
    expiresAt: z.ZodString;
    job: z.ZodEffects<z.ZodDiscriminatedUnion<"workloadType", [z.ZodObject<z.objectUtil.extendShape<{
        protocolVersion: z.ZodLiteral<1>;
        jobId: z.ZodBranded<z.ZodString, "JobId">;
        attempt: z.ZodNumber;
        organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
        companyId: z.ZodBranded<z.ZodString, "CompanyId">;
        source: z.ZodEffects<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
            kind: z.ZodLiteral<"task_run">;
            runId: z.ZodBranded<z.ZodString, "RunId">;
            issueId: z.ZodBranded<z.ZodString, "IssueId">;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            assigneeAgentId: z.ZodBranded<z.ZodString, "AgentId">;
        }, "strict", z.ZodTypeAny, {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        }, {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"commander_turn">;
            internalAgentRunId: z.ZodBranded<z.ZodString, "InternalAgentRunId">;
            conversationId: z.ZodBranded<z.ZodString, "ConversationId">;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        }, {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"crew_run">;
            crewRunId: z.ZodBranded<z.ZodString, "CrewRunId">;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        }, {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"one_shot">;
            operationId: z.ZodBranded<z.ZodString, "OneShotOperationId">;
            operationKind: z.ZodEnum<["extraction", "compaction", "readiness_probe"]>;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        }, {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"browser_request">;
            browserRequestId: z.ZodBranded<z.ZodString, "BrowserRequestId">;
            parentJobId: z.ZodNullable<z.ZodBranded<z.ZodString, "JobId">>;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        }, {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"service_reconcile">;
            serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
            generation: z.ZodNumber;
            reconciliationId: z.ZodBranded<z.ZodString, "ReconciliationId">;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        }, {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        }>]>, {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        }, {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        }>;
        createdAt: z.ZodString;
        notBefore: z.ZodNullable<z.ZodString>;
        deadline: z.ZodString;
        inputHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
        policyHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
        placement: z.ZodObject<{
            policyId: z.ZodString;
            version: z.ZodNumber;
            digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            targetRequirements: z.ZodObject<{
                allowedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
                allowedTrustClasses: z.ZodArray<z.ZodEnum<["shared_isolated", "organization_isolated", "owner_local_trusted"]>, "many">;
                requiredOwnerPrincipalId: z.ZodNullable<z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">>;
                credentialKind: z.ZodEnum<["none", "platform_brokered", "organization_brokered", "owner_bound"]>;
                dataLocality: z.ZodEnum<["transfer_allowed", "organization_target_only", "owner_device_only"]>;
                fallback: z.ZodObject<{
                    mode: z.ZodEnum<["forbidden", "ordered_explicit"]>;
                    orderedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
                }, "strict", z.ZodTypeAny, {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                }, {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                }>;
                providerConstraints: z.ZodObject<{
                    profileId: z.ZodString;
                    version: z.ZodNumber;
                    digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
                }, "strict", z.ZodTypeAny, {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                }, {
                    version: number;
                    digest: string;
                    profileId: string;
                }>;
            }, "strict", z.ZodTypeAny, {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            }, {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            }>;
        }, "strict", z.ZodTypeAny, {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        }, {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        }>;
        adapter: z.ZodObject<{
            type: z.ZodString;
            version: z.ZodString;
            configArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
        }, "strict", z.ZodTypeAny, {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        }, {
            type: string;
            version: string;
            configArtifactId: string | null;
        }>;
        requiredCapabilities: z.ZodArray<z.ZodString, "many">;
        workspace: z.ZodNullable<z.ZodObject<{
            manifestArtifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
            base: z.ZodEffects<z.ZodObject<{
                kind: z.ZodEnum<["git_commit", "content_manifest"]>;
                algorithm: z.ZodEnum<["git_sha1", "git_sha256", "sha256"]>;
                revision: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            }, {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            }>, {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            }, {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            }>;
            manifestHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
            mode: z.ZodEnum<["read_only", "read_write"]>;
        }, "strict", z.ZodTypeAny, {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        }, {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        }>>;
        secretHandles: z.ZodArray<z.ZodEffects<z.ZodObject<{
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
        }>, "many">;
        resourceLimits: z.ZodObject<{
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
        networkPolicy: z.ZodEffects<z.ZodObject<{
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
        offlinePolicy: z.ZodEnum<["cancel", "finish_without_remote_effects", "continue_until_lease_expiry"]>;
        extensions: z.ZodArray<z.ZodObject<{
            namespace: z.ZodEffects<z.ZodString, string, string>;
            schemaVersion: z.ZodNumber;
            critical: z.ZodBoolean;
            value: z.ZodUnknown;
        }, "strict", z.ZodTypeAny, {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }, {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }>, "many">;
    }, {
        workloadType: z.ZodLiteral<"batch">;
        workload: z.ZodObject<{
            command: z.ZodString;
            args: z.ZodArray<z.ZodString, "many">;
            stdinArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
            maxRuntimeSeconds: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            command: string;
            args: string[];
            stdinArtifactId: (string & z.BRAND<"ArtifactId">) | null;
            maxRuntimeSeconds: number;
        }, {
            command: string;
            args: string[];
            stdinArtifactId: string | null;
            maxRuntimeSeconds: number;
        }>;
    }>, "strict", z.ZodTypeAny, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        source: {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string & z.BRAND<"Sha256Digest">;
        policyHash: string & z.BRAND<"Sha256Digest">;
        placement: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "batch";
        workload: {
            command: string;
            args: string[];
            stdinArtifactId: (string & z.BRAND<"ArtifactId">) | null;
            maxRuntimeSeconds: number;
        };
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        source: {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string;
        policyHash: string;
        placement: {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: string | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "batch";
        workload: {
            command: string;
            args: string[];
            stdinArtifactId: string | null;
            maxRuntimeSeconds: number;
        };
    }>, z.ZodObject<z.objectUtil.extendShape<{
        protocolVersion: z.ZodLiteral<1>;
        jobId: z.ZodBranded<z.ZodString, "JobId">;
        attempt: z.ZodNumber;
        organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
        companyId: z.ZodBranded<z.ZodString, "CompanyId">;
        source: z.ZodEffects<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
            kind: z.ZodLiteral<"task_run">;
            runId: z.ZodBranded<z.ZodString, "RunId">;
            issueId: z.ZodBranded<z.ZodString, "IssueId">;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            assigneeAgentId: z.ZodBranded<z.ZodString, "AgentId">;
        }, "strict", z.ZodTypeAny, {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        }, {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"commander_turn">;
            internalAgentRunId: z.ZodBranded<z.ZodString, "InternalAgentRunId">;
            conversationId: z.ZodBranded<z.ZodString, "ConversationId">;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        }, {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"crew_run">;
            crewRunId: z.ZodBranded<z.ZodString, "CrewRunId">;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        }, {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"one_shot">;
            operationId: z.ZodBranded<z.ZodString, "OneShotOperationId">;
            operationKind: z.ZodEnum<["extraction", "compaction", "readiness_probe"]>;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        }, {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"browser_request">;
            browserRequestId: z.ZodBranded<z.ZodString, "BrowserRequestId">;
            parentJobId: z.ZodNullable<z.ZodBranded<z.ZodString, "JobId">>;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        }, {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"service_reconcile">;
            serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
            generation: z.ZodNumber;
            reconciliationId: z.ZodBranded<z.ZodString, "ReconciliationId">;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        }, {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        }>]>, {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        }, {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        }>;
        createdAt: z.ZodString;
        notBefore: z.ZodNullable<z.ZodString>;
        deadline: z.ZodString;
        inputHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
        policyHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
        placement: z.ZodObject<{
            policyId: z.ZodString;
            version: z.ZodNumber;
            digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            targetRequirements: z.ZodObject<{
                allowedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
                allowedTrustClasses: z.ZodArray<z.ZodEnum<["shared_isolated", "organization_isolated", "owner_local_trusted"]>, "many">;
                requiredOwnerPrincipalId: z.ZodNullable<z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">>;
                credentialKind: z.ZodEnum<["none", "platform_brokered", "organization_brokered", "owner_bound"]>;
                dataLocality: z.ZodEnum<["transfer_allowed", "organization_target_only", "owner_device_only"]>;
                fallback: z.ZodObject<{
                    mode: z.ZodEnum<["forbidden", "ordered_explicit"]>;
                    orderedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
                }, "strict", z.ZodTypeAny, {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                }, {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                }>;
                providerConstraints: z.ZodObject<{
                    profileId: z.ZodString;
                    version: z.ZodNumber;
                    digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
                }, "strict", z.ZodTypeAny, {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                }, {
                    version: number;
                    digest: string;
                    profileId: string;
                }>;
            }, "strict", z.ZodTypeAny, {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            }, {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            }>;
        }, "strict", z.ZodTypeAny, {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        }, {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        }>;
        adapter: z.ZodObject<{
            type: z.ZodString;
            version: z.ZodString;
            configArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
        }, "strict", z.ZodTypeAny, {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        }, {
            type: string;
            version: string;
            configArtifactId: string | null;
        }>;
        requiredCapabilities: z.ZodArray<z.ZodString, "many">;
        workspace: z.ZodNullable<z.ZodObject<{
            manifestArtifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
            base: z.ZodEffects<z.ZodObject<{
                kind: z.ZodEnum<["git_commit", "content_manifest"]>;
                algorithm: z.ZodEnum<["git_sha1", "git_sha256", "sha256"]>;
                revision: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            }, {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            }>, {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            }, {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            }>;
            manifestHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
            mode: z.ZodEnum<["read_only", "read_write"]>;
        }, "strict", z.ZodTypeAny, {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        }, {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        }>>;
        secretHandles: z.ZodArray<z.ZodEffects<z.ZodObject<{
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
        }>, "many">;
        resourceLimits: z.ZodObject<{
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
        networkPolicy: z.ZodEffects<z.ZodObject<{
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
        offlinePolicy: z.ZodEnum<["cancel", "finish_without_remote_effects", "continue_until_lease_expiry"]>;
        extensions: z.ZodArray<z.ZodObject<{
            namespace: z.ZodEffects<z.ZodString, string, string>;
            schemaVersion: z.ZodNumber;
            critical: z.ZodBoolean;
            value: z.ZodUnknown;
        }, "strict", z.ZodTypeAny, {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }, {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }>, "many">;
    }, {
        workloadType: z.ZodLiteral<"browser_session">;
        workload: z.ZodObject<{
            engine: z.ZodLiteral<"chromium">;
            viewport: z.ZodObject<{
                width: z.ZodNumber;
                height: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                width: number;
                height: number;
            }, {
                width: number;
                height: number;
            }>;
            locale: z.ZodString;
            timezone: z.ZodString;
            recordTrace: z.ZodBoolean;
            recordVideo: z.ZodBoolean;
            maxSessionSeconds: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            engine: "chromium";
            viewport: {
                width: number;
                height: number;
            };
            locale: string;
            timezone: string;
            recordTrace: boolean;
            recordVideo: boolean;
            maxSessionSeconds: number;
        }, {
            engine: "chromium";
            viewport: {
                width: number;
                height: number;
            };
            locale: string;
            timezone: string;
            recordTrace: boolean;
            recordVideo: boolean;
            maxSessionSeconds: number;
        }>;
    }>, "strict", z.ZodTypeAny, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        source: {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string & z.BRAND<"Sha256Digest">;
        policyHash: string & z.BRAND<"Sha256Digest">;
        placement: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "browser_session";
        workload: {
            engine: "chromium";
            viewport: {
                width: number;
                height: number;
            };
            locale: string;
            timezone: string;
            recordTrace: boolean;
            recordVideo: boolean;
            maxSessionSeconds: number;
        };
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        source: {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string;
        policyHash: string;
        placement: {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: string | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "browser_session";
        workload: {
            engine: "chromium";
            viewport: {
                width: number;
                height: number;
            };
            locale: string;
            timezone: string;
            recordTrace: boolean;
            recordVideo: boolean;
            maxSessionSeconds: number;
        };
    }>, z.ZodObject<z.objectUtil.extendShape<{
        protocolVersion: z.ZodLiteral<1>;
        jobId: z.ZodBranded<z.ZodString, "JobId">;
        attempt: z.ZodNumber;
        organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
        companyId: z.ZodBranded<z.ZodString, "CompanyId">;
        source: z.ZodEffects<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
            kind: z.ZodLiteral<"task_run">;
            runId: z.ZodBranded<z.ZodString, "RunId">;
            issueId: z.ZodBranded<z.ZodString, "IssueId">;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            assigneeAgentId: z.ZodBranded<z.ZodString, "AgentId">;
        }, "strict", z.ZodTypeAny, {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        }, {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"commander_turn">;
            internalAgentRunId: z.ZodBranded<z.ZodString, "InternalAgentRunId">;
            conversationId: z.ZodBranded<z.ZodString, "ConversationId">;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        }, {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"crew_run">;
            crewRunId: z.ZodBranded<z.ZodString, "CrewRunId">;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        }, {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"one_shot">;
            operationId: z.ZodBranded<z.ZodString, "OneShotOperationId">;
            operationKind: z.ZodEnum<["extraction", "compaction", "readiness_probe"]>;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        }, {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"browser_request">;
            browserRequestId: z.ZodBranded<z.ZodString, "BrowserRequestId">;
            parentJobId: z.ZodNullable<z.ZodBranded<z.ZodString, "JobId">>;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        }, {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"service_reconcile">;
            serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
            generation: z.ZodNumber;
            reconciliationId: z.ZodBranded<z.ZodString, "ReconciliationId">;
            requestedBy: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
            executionPrincipal: z.ZodObject<{
                principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
                principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
            }, "strict", z.ZodTypeAny, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            }, {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            }>;
        }, "strict", z.ZodTypeAny, {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        }, {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        }>]>, {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        }, {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        }>;
        createdAt: z.ZodString;
        notBefore: z.ZodNullable<z.ZodString>;
        deadline: z.ZodString;
        inputHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
        policyHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
        placement: z.ZodObject<{
            policyId: z.ZodString;
            version: z.ZodNumber;
            digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            targetRequirements: z.ZodObject<{
                allowedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
                allowedTrustClasses: z.ZodArray<z.ZodEnum<["shared_isolated", "organization_isolated", "owner_local_trusted"]>, "many">;
                requiredOwnerPrincipalId: z.ZodNullable<z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">>;
                credentialKind: z.ZodEnum<["none", "platform_brokered", "organization_brokered", "owner_bound"]>;
                dataLocality: z.ZodEnum<["transfer_allowed", "organization_target_only", "owner_device_only"]>;
                fallback: z.ZodObject<{
                    mode: z.ZodEnum<["forbidden", "ordered_explicit"]>;
                    orderedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
                }, "strict", z.ZodTypeAny, {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                }, {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                }>;
                providerConstraints: z.ZodObject<{
                    profileId: z.ZodString;
                    version: z.ZodNumber;
                    digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
                }, "strict", z.ZodTypeAny, {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                }, {
                    version: number;
                    digest: string;
                    profileId: string;
                }>;
            }, "strict", z.ZodTypeAny, {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            }, {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            }>;
        }, "strict", z.ZodTypeAny, {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        }, {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        }>;
        adapter: z.ZodObject<{
            type: z.ZodString;
            version: z.ZodString;
            configArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
        }, "strict", z.ZodTypeAny, {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        }, {
            type: string;
            version: string;
            configArtifactId: string | null;
        }>;
        requiredCapabilities: z.ZodArray<z.ZodString, "many">;
        workspace: z.ZodNullable<z.ZodObject<{
            manifestArtifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
            base: z.ZodEffects<z.ZodObject<{
                kind: z.ZodEnum<["git_commit", "content_manifest"]>;
                algorithm: z.ZodEnum<["git_sha1", "git_sha256", "sha256"]>;
                revision: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            }, {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            }>, {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            }, {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            }>;
            manifestHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
            mode: z.ZodEnum<["read_only", "read_write"]>;
        }, "strict", z.ZodTypeAny, {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        }, {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        }>>;
        secretHandles: z.ZodArray<z.ZodEffects<z.ZodObject<{
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
        }>, "many">;
        resourceLimits: z.ZodObject<{
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
        networkPolicy: z.ZodEffects<z.ZodObject<{
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
        offlinePolicy: z.ZodEnum<["cancel", "finish_without_remote_effects", "continue_until_lease_expiry"]>;
        extensions: z.ZodArray<z.ZodObject<{
            namespace: z.ZodEffects<z.ZodString, string, string>;
            schemaVersion: z.ZodNumber;
            critical: z.ZodBoolean;
            value: z.ZodUnknown;
        }, "strict", z.ZodTypeAny, {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }, {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }>, "many">;
    }, {
        workloadType: z.ZodLiteral<"service">;
        workload: z.ZodObject<{
            serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
            serviceInstanceId: z.ZodBranded<z.ZodString, "ServiceInstanceId">;
            generation: z.ZodNumber;
            command: z.ZodString;
            args: z.ZodArray<z.ZodString, "many">;
            checkpointArtifactId: z.ZodNullable<z.ZodBranded<z.ZodString, "ArtifactId">>;
            gracefulStopSeconds: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            command: string;
            args: string[];
            serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
            checkpointArtifactId: (string & z.BRAND<"ArtifactId">) | null;
            gracefulStopSeconds: number;
        }, {
            serviceId: string;
            generation: number;
            command: string;
            args: string[];
            serviceInstanceId: string;
            checkpointArtifactId: string | null;
            gracefulStopSeconds: number;
        }>;
    }>, "strict", z.ZodTypeAny, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        source: {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string & z.BRAND<"Sha256Digest">;
        policyHash: string & z.BRAND<"Sha256Digest">;
        placement: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "service";
        workload: {
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            command: string;
            args: string[];
            serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
            checkpointArtifactId: (string & z.BRAND<"ArtifactId">) | null;
            gracefulStopSeconds: number;
        };
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        source: {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string;
        policyHash: string;
        placement: {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: string | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "service";
        workload: {
            serviceId: string;
            generation: number;
            command: string;
            args: string[];
            serviceInstanceId: string;
            checkpointArtifactId: string | null;
            gracefulStopSeconds: number;
        };
    }>]>, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        source: {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string & z.BRAND<"Sha256Digest">;
        policyHash: string & z.BRAND<"Sha256Digest">;
        placement: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "batch";
        workload: {
            command: string;
            args: string[];
            stdinArtifactId: (string & z.BRAND<"ArtifactId">) | null;
            maxRuntimeSeconds: number;
        };
    } | {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        source: {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string & z.BRAND<"Sha256Digest">;
        policyHash: string & z.BRAND<"Sha256Digest">;
        placement: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "browser_session";
        workload: {
            engine: "chromium";
            viewport: {
                width: number;
                height: number;
            };
            locale: string;
            timezone: string;
            recordTrace: boolean;
            recordVideo: boolean;
            maxSessionSeconds: number;
        };
    } | {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        source: {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string & z.BRAND<"Sha256Digest">;
        policyHash: string & z.BRAND<"Sha256Digest">;
        placement: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "service";
        workload: {
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            command: string;
            args: string[];
            serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
            checkpointArtifactId: (string & z.BRAND<"ArtifactId">) | null;
            gracefulStopSeconds: number;
        };
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        source: {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string;
        policyHash: string;
        placement: {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: string | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "batch";
        workload: {
            command: string;
            args: string[];
            stdinArtifactId: string | null;
            maxRuntimeSeconds: number;
        };
    } | {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        source: {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string;
        policyHash: string;
        placement: {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: string | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "browser_session";
        workload: {
            engine: "chromium";
            viewport: {
                width: number;
                height: number;
            };
            locale: string;
            timezone: string;
            recordTrace: boolean;
            recordVideo: boolean;
            maxSessionSeconds: number;
        };
    } | {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        source: {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string;
        policyHash: string;
        placement: {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: string | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "service";
        workload: {
            serviceId: string;
            generation: number;
            command: string;
            args: string[];
            serviceInstanceId: string;
            checkpointArtifactId: string | null;
            gracefulStopSeconds: number;
        };
    }>;
    extensions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        namespace: z.ZodEffects<z.ZodString, string, string>;
        schemaVersion: z.ZodNumber;
        critical: z.ZodBoolean;
        value: z.ZodUnknown;
    }, "strict", z.ZodTypeAny, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }>, "many">>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    ackDeadline: string;
    expiresAt: string;
    job: {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        source: {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string & z.BRAND<"Sha256Digest">;
        policyHash: string & z.BRAND<"Sha256Digest">;
        placement: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "batch";
        workload: {
            command: string;
            args: string[];
            stdinArtifactId: (string & z.BRAND<"ArtifactId">) | null;
            maxRuntimeSeconds: number;
        };
    } | {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        source: {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string & z.BRAND<"Sha256Digest">;
        policyHash: string & z.BRAND<"Sha256Digest">;
        placement: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "browser_session";
        workload: {
            engine: "chromium";
            viewport: {
                width: number;
                height: number;
            };
            locale: string;
            timezone: string;
            recordTrace: boolean;
            recordVideo: boolean;
            maxSessionSeconds: number;
        };
    } | {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        source: {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string & z.BRAND<"Sha256Digest">;
        policyHash: string & z.BRAND<"Sha256Digest">;
        placement: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "service";
        workload: {
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            command: string;
            args: string[];
            serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
            checkpointArtifactId: (string & z.BRAND<"ArtifactId">) | null;
            gracefulStopSeconds: number;
        };
    };
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}, {
    protocolVersion: 1;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    ackDeadline: string;
    expiresAt: string;
    job: {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        source: {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string;
        policyHash: string;
        placement: {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: string | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "batch";
        workload: {
            command: string;
            args: string[];
            stdinArtifactId: string | null;
            maxRuntimeSeconds: number;
        };
    } | {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        source: {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string;
        policyHash: string;
        placement: {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: string | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "browser_session";
        workload: {
            engine: "chromium";
            viewport: {
                width: number;
                height: number;
            };
            locale: string;
            timezone: string;
            recordTrace: boolean;
            recordVideo: boolean;
            maxSessionSeconds: number;
        };
    } | {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        source: {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string;
        policyHash: string;
        placement: {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: string | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "service";
        workload: {
            serviceId: string;
            generation: number;
            command: string;
            args: string[];
            serviceInstanceId: string;
            checkpointArtifactId: string | null;
            gracefulStopSeconds: number;
        };
    };
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}>, {
    protocolVersion: 1;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    ackDeadline: string;
    expiresAt: string;
    job: {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        source: {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string & z.BRAND<"Sha256Digest">;
        policyHash: string & z.BRAND<"Sha256Digest">;
        placement: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "batch";
        workload: {
            command: string;
            args: string[];
            stdinArtifactId: (string & z.BRAND<"ArtifactId">) | null;
            maxRuntimeSeconds: number;
        };
    } | {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        source: {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string & z.BRAND<"Sha256Digest">;
        policyHash: string & z.BRAND<"Sha256Digest">;
        placement: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "browser_session";
        workload: {
            engine: "chromium";
            viewport: {
                width: number;
                height: number;
            };
            locale: string;
            timezone: string;
            recordTrace: boolean;
            recordVideo: boolean;
            maxSessionSeconds: number;
        };
    } | {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        source: {
            kind: "task_run";
            runId: string & z.BRAND<"RunId">;
            issueId: string & z.BRAND<"IssueId">;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            assigneeAgentId: string & z.BRAND<"AgentId">;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            internalAgentRunId: string & z.BRAND<"InternalAgentRunId">;
            conversationId: string & z.BRAND<"ConversationId">;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            crewRunId: string & z.BRAND<"CrewRunId">;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            operationId: string & z.BRAND<"OneShotOperationId">;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            browserRequestId: string & z.BRAND<"BrowserRequestId">;
            parentJobId: (string & z.BRAND<"JobId">) | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string & z.BRAND<"PrincipalId">;
            };
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            reconciliationId: string & z.BRAND<"ReconciliationId">;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string & z.BRAND<"Sha256Digest">;
        policyHash: string & z.BRAND<"Sha256Digest">;
        placement: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string & z.BRAND<"Sha256Digest">;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: (string & z.BRAND<"ArtifactId">) | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string & z.BRAND<"ArtifactId">;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string & z.BRAND<"Sha256Digest">;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "service";
        workload: {
            serviceId: string & z.BRAND<"ServiceId">;
            generation: number;
            command: string;
            args: string[];
            serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
            checkpointArtifactId: (string & z.BRAND<"ArtifactId">) | null;
            gracefulStopSeconds: number;
        };
    };
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}, {
    protocolVersion: 1;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    ackDeadline: string;
    expiresAt: string;
    job: {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        source: {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string;
        policyHash: string;
        placement: {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: string | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "batch";
        workload: {
            command: string;
            args: string[];
            stdinArtifactId: string | null;
            maxRuntimeSeconds: number;
        };
    } | {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        source: {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string;
        policyHash: string;
        placement: {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: string | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "browser_session";
        workload: {
            engine: "chromium";
            viewport: {
                width: number;
                height: number;
            };
            locale: string;
            timezone: string;
            recordTrace: boolean;
            recordVideo: boolean;
            maxSessionSeconds: number;
        };
    } | {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        source: {
            kind: "task_run";
            runId: string;
            issueId: string;
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            assigneeAgentId: string;
        } | {
            kind: "commander_turn";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            internalAgentRunId: string;
            conversationId: string;
        } | {
            kind: "crew_run";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            crewRunId: string;
        } | {
            kind: "one_shot";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            operationId: string;
            operationKind: "extraction" | "compaction" | "readiness_probe";
        } | {
            kind: "browser_request";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            browserRequestId: string;
            parentJobId: string | null;
        } | {
            kind: "service_reconcile";
            requestedBy: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            executionPrincipal: {
                principalType: "user" | "agent" | "service" | "system";
                principalId: string;
            };
            serviceId: string;
            generation: number;
            reconciliationId: string;
        };
        createdAt: string;
        notBefore: string | null;
        deadline: string;
        inputHash: string;
        policyHash: string;
        placement: {
            policyId: string;
            version: number;
            digest: string;
            targetRequirements: {
                allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
                requiredOwnerPrincipalId: string | null;
                credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
                dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
                fallback: {
                    mode: "forbidden" | "ordered_explicit";
                    orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
                };
                providerConstraints: {
                    version: number;
                    digest: string;
                    profileId: string;
                };
            };
        };
        adapter: {
            type: string;
            version: string;
            configArtifactId: string | null;
        };
        requiredCapabilities: string[];
        workspace: {
            mode: "read_only" | "read_write";
            manifestArtifactId: string;
            base: {
                kind: "git_commit" | "content_manifest";
                algorithm: "git_sha1" | "git_sha256" | "sha256";
                revision: string;
            };
            manifestHash: string;
        } | null;
        secretHandles: {
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
        }[];
        resourceLimits: {
            cpuMillis: number;
            memoryMiB: number;
            pids: number;
            diskMiB: number;
        };
        networkPolicy: {
            policyId: string;
            version: number;
            digest: string;
        };
        offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry";
        extensions: {
            namespace: string;
            schemaVersion: number;
            critical: boolean;
            value?: unknown;
        }[];
        workloadType: "service";
        workload: {
            serviceId: string;
            generation: number;
            command: string;
            args: string[];
            serviceInstanceId: string;
            checkpointArtifactId: string | null;
            gracefulStopSeconds: number;
        };
    };
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}>;
export type LeaseOfferV1 = z.infer<typeof leaseOfferV1Schema>;
export declare const leaseAckV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    ackedAt: z.ZodString;
    extensions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        namespace: z.ZodEffects<z.ZodString, string, string>;
        schemaVersion: z.ZodNumber;
        critical: z.ZodBoolean;
        value: z.ZodUnknown;
    }, "strict", z.ZodTypeAny, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }>, "many">>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    ackedAt: string;
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    ackedAt: string;
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}>, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    ackedAt: string;
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    ackedAt: string;
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}>;
export type LeaseAckV1 = z.infer<typeof leaseAckV1Schema>;
export declare const leaseRenewRequestV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    observedAt: z.ZodString;
    extensions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        namespace: z.ZodEffects<z.ZodString, string, string>;
        schemaVersion: z.ZodNumber;
        critical: z.ZodBoolean;
        value: z.ZodUnknown;
    }, "strict", z.ZodTypeAny, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }>, "many">>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    observedAt: string;
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    observedAt: string;
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}>, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    observedAt: string;
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    observedAt: string;
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}>;
export type LeaseRenewRequestV1 = z.infer<typeof leaseRenewRequestV1Schema>;
export declare const leaseRenewResponseV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    expiresAt: z.ZodString;
    cancelRequested: z.ZodBoolean;
    cancelReason: z.ZodNullable<z.ZodString>;
    extensions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        namespace: z.ZodEffects<z.ZodString, string, string>;
        schemaVersion: z.ZodNumber;
        critical: z.ZodBoolean;
        value: z.ZodUnknown;
    }, "strict", z.ZodTypeAny, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }, {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }>, "many">>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    expiresAt: string;
    cancelRequested: boolean;
    cancelReason: string | null;
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    expiresAt: string;
    cancelRequested: boolean;
    cancelReason: string | null;
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}>, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    expiresAt: string;
    cancelRequested: boolean;
    cancelReason: string | null;
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    expiresAt: string;
    cancelRequested: boolean;
    cancelReason: string | null;
    extensions?: {
        namespace: string;
        schemaVersion: number;
        critical: boolean;
        value?: unknown;
    }[] | undefined;
}>;
export type LeaseRenewResponseV1 = z.infer<typeof leaseRenewResponseV1Schema>;
